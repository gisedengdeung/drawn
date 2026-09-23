"""One final held-out comparison after a recorded validation-only selection."""
import csv
import json
from pathlib import Path
import numpy as np
import torch
from dataset_trim import load_trim_bundle, inverse_targets
from model_trim import TrimPointNet
from model_validity_v2 import TrimValidityV2
from validity_metrics import validity_metrics
from evaluate_trim import valid_intervals
from train_validity_v2 import ROOT, OUT, RUNS, BASE, digest, load_masks, write_json


def regression_metrics(truth, pred, observed, names, train_mean):
    report = {}
    for col, name in enumerate(names):
        use = np.isfinite(truth[..., col]) & observed
        a,p = truth[..., col][use], pred[..., col][use]
        report[name] = {'n':int(use.sum()),'r2':float(1-np.square(a-p).sum()/np.square(a-train_mean[col]).sum()),
                        'mae':float(np.abs(a-p).mean()),'rmse':float(np.sqrt(np.square(a-p).mean()))}
    return report


def main():
    out = OUT/'evaluation'
    if (out/'comparison.json').exists(): raise FileExistsError('Final evaluation already recorded')
    torch.set_num_threads(4); torch.set_float32_matmul_precision('highest')
    selected = torch.load(RUNS/'selected.pt',map_location='cpu',weights_only=True)
    old = torch.load(BASE,map_location='cpu',weights_only=True)
    selection = json.loads((RUNS/'selection.json').read_text(encoding='utf-8'))
    assert digest(RUNS/'selected.pt') == selection['selected_checkpoint_sha256']
    assert selected['test_used_for_selection'] is False
    bundle = load_trim_bundle(ROOT/'ml/data/pointclouds.npz',ROOT/'ml/data/trims.npz',device='cuda',
                              normalization=old['normalization'],include_test=True)
    masks = load_masks(bundle.design_id)
    assert digest(OUT/'data/hover_supervision_masks.npz') == selected['supervised_mask_sha256']
    baseline = TrimPointNet(**old['model_config']).cuda().eval()
    baseline.load_state_dict(old['state_dict'])
    if selected['model_kind'] == 'trim_validity_dual':
        from model_validity_dual import TrimValidityDual
        model = TrimValidityDual(**selected['model_config']).cuda().eval()
    else:
        model = TrimValidityV2(**selected['model_config']).cuda().eval()
    model.load_state_dict(selected['state_dict'])
    if not selected['regression_refinement']:
        for key,value in old['state_dict'].items():
            if not key.startswith('validity.'):
                assert torch.equal(value, selected['state_dict'][key]), key
    threshold = float(selection['threshold'])
    baseline_policy_threshold = selection['baseline_same_selection_rule']['threshold']
    report = {'model_version':{'checkpoint':{'path':str(RUNS/'selected.pt'),'sha256':digest(RUNS/'selected.pt')},
                               'baseline_sha256':digest(BASE),'source_commit':'745f00c'},
              'validity':{'threshold_selection':{'threshold':threshold,'selected_on':'val',
                            'method':'frozen validation-only active-set/F0.5/upper-over objective with recall guard',
                            'validation_metrics':selection['validation']['metrics']}},
              'baseline_original_threshold':.79, 'baseline_same_policy_threshold':baseline_policy_threshold,
              'regression_refinement_accepted':selected['regression_refinement'],
              'test_used_for_selection':False,
              'limitations':['Existing test had already informed the request; it is not a never-inspected holdout.',
                              'Validity labels measure recorded solver success, not a flight safety certification.',
                              'Only integer speeds0..50 were supervised; fractional logits are interpolated.',
                              'Masked metrics ignore independently audited corrupt rows; legacy metrics retain them.',
                              'User-provided baseline interval figures differ from local artifact; paired local results are reported.']}
    out.mkdir(parents=True,exist_ok=True)
    for split in ['val','test']:
        all_indices = bundle.indices[split].cpu().numpy()
        regression, old_regression, probability, old_probability = [],[],[],[]
        with torch.inference_mode():
            for index in bundle.sequential(split,128):
                features = baseline.encode(bundle.points[index],bundle.scale_feature[index])
                speed = torch.arange(51,device='cuda',dtype=torch.float32)[None].expand(len(index),-1)
                new_features = model.encode(bundle.points[index],bundle.scale_feature[index]) if selected['model_kind']=='trim_validity_dual' else features
                r,p = model.decode(new_features,speed); br,bp = baseline.decode(features,speed)
                regression.append(r.cpu().numpy()); old_regression.append(br.cpu().numpy())
                probability.append(p.sigmoid().cpu().numpy()); old_probability.append(bp.sigmoid().cpu().numpy())
        regression = inverse_targets(np.concatenate(regression),old['normalization'])
        old_regression = inverse_targets(np.concatenate(old_regression),old['normalization'])
        probability,old_probability = np.concatenate(probability),np.concatenate(old_probability)
        truth = bundle.valid[bundle.indices[split]].cpu().numpy()
        raw = bundle.raw_targets[all_indices]
        observed = masks['supervised_mask'][all_indices]
        result = {'regression_max_absolute_change':float(np.max(np.abs(regression-old_regression)))}
        if not selected['regression_refinement']:
            assert result['regression_max_absolute_change'] == 0.
        for name,mask in [('legacy',np.ones_like(observed)),('cleaned',observed)]:
            result[name] = {
                'v1':validity_metrics(truth,old_probability,mask,.79),
                'v1_threshold_0_5':validity_metrics(truth,old_probability,mask,.5),
                'v1_same_selection_policy':validity_metrics(truth,old_probability,mask,baseline_policy_threshold),
                'v2':validity_metrics(truth,probability,mask,threshold),
                'regression_v1':regression_metrics(raw,old_regression,mask,bundle.target_names,old['train_mean']),
                'regression_v2':regression_metrics(raw,regression,mask,bundle.target_names,old['train_mean'])}
        report['validity'][split] = result
        ids = bundle.design_id[all_indices]
        np.savez_compressed(out/(split+'_predictions.npz'), design_id=ids,truth=truth,observed=observed,
                            v1_probability=old_probability,v2_probability=probability,
                            raw_targets=raw,v1_regression=old_regression,v2_regression=regression,
                            v1_threshold=.79,v2_threshold=threshold)
        with (out/(split+'_speed_sets.csv')).open('w',newline='',encoding='utf-8') as handle:
            writer = csv.writer(handle)
            writer.writerow(['design_id','observed_speeds','actual_intervals','v1_intervals','v2_intervals'])
            for i,did in enumerate(ids):
                writer.writerow([int(did),int(observed[i].sum()),json.dumps(valid_intervals(truth[i]&observed[i])),
                                 json.dumps(valid_intervals((old_probability[i]>=.79)&observed[i])),
                                 json.dumps(valid_intervals((probability[i]>=threshold)&observed[i]))])
        print(split,json.dumps({'v1':result['cleaned']['v1'],'v2':result['cleaned']['v2']}),flush=True)
    v1,v2 = report['validity']['test']['cleaned']['v1'],report['validity']['test']['cleaned']['v2']
    # These indicators describe results; the training selection remains frozen.
    report['outcome'] = {
        'f1_delta':v2['f1']-v1['f1'], 'precision_delta':v2['precision']-v1['precision'],
        'recall_delta':v2['recall']-v1['recall'], 'exact_active_delta':v2['exact_active']-v1['exact_active'],
        'upper_over_delta':v2['upper_over_fraction']-v1['upper_over_fraction'],
        'ui_readiness':'requires assessment of remaining speed-set errors',
        'ui_note':'Compare exact speed-set agreement and remaining false-valid speeds before UI integration.'}
    write_json(out/'comparison.json',report)
    print('FINAL',json.dumps(report['outcome']),flush=True)


if __name__=='__main__': main()
