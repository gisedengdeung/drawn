"""Bounded validation-only fine tuning of an independent validity PointNet."""
import copy
import json
import shutil
import time
import numpy as np
import torch
from torch import nn
from dataset_trim import load_trim_bundle
from model_validity_dual import TrimValidityDual
from train_validity_v2 import ROOT, OUT, RUNS, BASE, digest, load_masks, write_json, cls_loss, choose_threshold


@torch.inference_mode()
def evaluate(net, bundle):
    net.eval()
    probabilities = []
    for index in bundle.sequential('val',128):
        f = torch.cat([net.validity_encoder(bundle.points[index]), bundle.scale_feature[index]],dim=1)
        probabilities.append(net.speed_set(f).sigmoid().cpu().numpy())
    return np.concatenate(probabilities)


def main():
    start = time.perf_counter()
    phase1 = json.loads((RUNS/'selection.json').read_text(encoding='utf-8'))
    if (RUNS/'phase1_selection.json').exists(): raise FileExistsError('Phase 2 already started')
    shutil.copy2(RUNS/'selection.json', RUNS/'phase1_selection.json')
    shutil.copy2(RUNS/'selected.pt', RUNS/'phase1_selected.pt')
    selected = torch.load(RUNS/'phase1_selected.pt',map_location='cpu',weights_only=True)
    torch.set_num_threads(4); torch.set_float32_matmul_precision('highest')
    torch.backends.cudnn.benchmark = True
    bundle = load_trim_bundle(ROOT/'ml/data/pointclouds.npz',ROOT/'ml/data/trims.npz',device='cuda',
                              normalization=selected['normalization'],include_test=False)
    assert not len(bundle.indices['test'])
    masks = load_masks(bundle.design_id)
    assert digest(OUT/'data/hover_supervision_masks.npz') == selected['supervised_mask_sha256']
    observed = torch.as_tensor(masks['supervised_mask'],dtype=torch.float32,device='cuda')
    val_i = bundle.indices['val'].cpu().numpy()
    val_truth = bundle.valid[bundle.indices['val']].cpu().numpy()
    val_observed = masks['supervised_mask'][val_i]
    config = selected['model_config']
    train_i = bundle.indices['train']
    positive = (bundle.valid[train_i]*observed[train_i]).sum().item()
    sqrt_weight = ((observed[train_i].sum().item()-positive)/positive)**.5
    experiments = [
        {'tag':'dual_set_fp','positive_weight':1.,'set_weight':.5,'upper_weight':.25},
        {'tag':'dual_set_fp_sqrt','positive_weight':sqrt_weight,'set_weight':.5,'upper_weight':.25},
    ]
    best_score = phase1['validation']['score']
    best_checkpoint = None
    reports = []
    for experiment in experiments:
        torch.manual_seed(20260920); np.random.seed(20260920)
        net = TrimValidityDual(**config).cuda()
        missing = net.load_state_dict(selected['state_dict'],strict=False)
        assert all(k.startswith('validity_encoder.') for k in missing.missing_keys)
        assert not missing.unexpected_keys
        net.validity_encoder.load_state_dict(net.encoder.state_dict())
        for p in net.parameters(): p.requires_grad_(False)
        for module in [net.validity_encoder, net.speed_set]:
            for p in module.parameters(): p.requires_grad_(True)
        parameters = [p for p in net.parameters() if p.requires_grad]
        optimizer = torch.optim.AdamW([
            {'params':net.validity_encoder.parameters(),'lr':2e-5},
            {'params':net.speed_set.parameters(),'lr':2e-4}], weight_decay=1e-3)
        scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer,mode='max',patience=4,factor=.5)
        best, best_epoch, best_entry = -1e9, 0, None
        history = []
        for epoch in range(1,61):
            epoch_start=time.perf_counter()
            net.eval(); net.validity_encoder.train(); net.speed_set.train()
            running=[]
            for index in bundle.batches('train',128):
                points = bundle.points[index] + torch.randn_like(bundle.points[index])*.003
                with torch.autocast('cuda',dtype=torch.bfloat16):
                    f = torch.cat([net.validity_encoder(points),bundle.scale_feature[index]],dim=1)
                    logits = net.speed_set(f)
                loss=cls_loss(logits.float(),bundle.valid[index].float(),observed[index],
                              **{k:v for k,v in experiment.items() if k!='tag'})
                optimizer.zero_grad(set_to_none=True); loss.backward()
                nn.utils.clip_grad_norm_(parameters,5.,error_if_nonfinite=True)
                optimizer.step(); running.append(float(loss.detach()))
            if epoch==1 or epoch%2==0:
                probability=evaluate(net,bundle)
                score,threshold,metrics=choose_threshold(val_truth,probability,val_observed,phase1['minimum_recall'])
                scheduler.step(score)
                entry={'epoch':epoch,'train_loss':float(np.mean(running)),'score':score,'threshold':threshold,'metrics':metrics}
                history.append(entry)
                if score>best+1e-5:
                    best,best_epoch,best_entry=score,epoch,entry
                    payload=dict(selected)
                    payload.update(state_dict={k:v.detach().cpu().clone() for k,v in net.state_dict().items()},
                                   model_kind='trim_validity_dual',model_config=config,
                                   threshold=threshold,validity_selection=entry,validity_config=experiment,
                                   best_score=score,best_epoch=epoch,epoch=epoch,val=metrics,
                                   args={'seed':20260920,'batch_size':128,'classifier_encoder_lr':2e-5,
                                         'classifier_head_lr':2e-4,'original_encoder_frozen':True,
                                         'original_regression_frozen':True,'classifier_loss':experiment,
                                         'jitter':.003,'amp':'bfloat16'},test_used_for_selection=False)
                    torch.save(payload,RUNS/(experiment['tag']+'.pt'))
                write_json(RUNS/(experiment['tag']+'.json'),{'config':experiment,'best':best_entry,'history':history,'test_used':False})
                print(f'{experiment["tag"]} epoch={epoch} score={score:.4f} F1={metrics["f1"]:.4f} '
                      f'recall={metrics["recall"]:.4f} exact={metrics["exact_active"]:.4f} '
                      f'upper={metrics["upper_over_fraction"]:.4f} best={best_epoch} '
                      f'sec={time.perf_counter()-epoch_start:.1f}',flush=True)
            if epoch-best_epoch>=18: break
        reports.append({'config':experiment,'best':best_entry})
        if best>best_score+1e-5:
            best_score,best_checkpoint=best,RUNS/(experiment['tag']+'.pt')
    selection=dict(phase1)
    selection['dual_experiments']=reports
    selection['phase2_test_used']=False
    selection['phase2_elapsed_seconds']=time.perf_counter()-start
    if best_checkpoint:
        shutil.copy2(best_checkpoint,RUNS/'selected.pt')
        final=torch.load(RUNS/'selected.pt',map_location='cpu',weights_only=True)
        selection.update(selected=final['validity_config']['tag'], threshold=final['threshold'],
                         validation=final['validity_selection'],model_kind=final['model_kind'],
                         validation_score_improved=best_score>phase1['baseline_same_selection_rule']['score'],
                         selected_checkpoint_sha256=digest(RUNS/'selected.pt'))
    else:
        selection['model_kind']=selected['model_kind']
    write_json(RUNS/'selection.json',selection)
    print('PHASE2_COMPLETE',selection['selected'],selection['validation']['score'],flush=True)


if __name__=='__main__': main()
