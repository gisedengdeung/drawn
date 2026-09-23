"""Validation-only experiments; test evaluation is a separate final command."""
from pathlib import Path
import copy
import hashlib
import json
import time
import numpy as np
import torch
from torch import nn
from dataset_trim import load_trim_bundle, inverse_targets
from model_trim import TrimPointNet
from model_validity_v2 import TrimValidityV2, SpeedSetHead
from train_trim import masked_regression_loss
from validity_metrics import validity_metrics, selection_score

ROOT = Path(__file__).resolve().parents[4]
OUT = Path(__file__).resolve().parents[2]
RUNS = OUT / 'runs'
BASE = ROOT / 'ml/runs/trim_pointnet_v1.pt'


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n', encoding='utf-8')


def digest(path):
    with Path(path).open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def load_masks(ids):
    with np.load(OUT / 'data/hover_supervision_masks.npz', allow_pickle=False) as d:
        lookup = {int(did): i for i, did in enumerate(d['design_id'])}
        order = np.asarray([lookup[int(did)] for did in ids])
        return {k: d[k][order] for k in ['supervised_mask', 'trusted_hover', 'mass_kg']}


def cls_loss(logits, truth, observed, positive_weight=1., set_weight=0., upper_weight=0.):
    values = nn.functional.binary_cross_entropy_with_logits(
        logits, truth, reduction='none', pos_weight=logits.new_tensor(positive_weight))
    bce = (values * observed).sum() / observed.sum().clamp_min(1)
    p = logits.sigmoid() * observed
    y = truth * observed
    tp = (p * y).sum(1)
    fp = (p * (1 - y)).sum(1)
    fn = ((1 - p) * y).sum(1)
    active = y.sum(1) > 0
    tversky = 1 - (tp + 1e-6) / (tp + .7 * fp + .3 * fn + 1e-6)
    set_loss = (tversky * active).sum() / active.sum().clamp_min(1)
    speeds = torch.arange(51, device=logits.device)
    last = torch.where(y.bool(), speeds, -1).amax(1)
    above = (speeds[None] > last[:, None]) & active[:, None] & observed.bool()
    upper_loss = (p * above).sum() / above.sum().clamp_min(1)
    return bce + set_weight * set_loss + upper_weight * upper_loss


def choose_threshold(truth, probability, observed, minimum_recall):
    entries = []
    for threshold in np.linspace(.10, .90, 17):
        m = validity_metrics(truth, probability, observed, threshold=float(threshold))
        s = selection_score(m, minimum_recall=minimum_recall, minimum_design_recall=.70)
        entries.append((s, float(threshold), m))
    return max(entries, key=lambda x: (x[0], (x[2]['precision'] or 0.0), -abs(x[1] - .5)))


@torch.inference_mode()
def probabilities(head, features):
    head.eval()
    return torch.cat([head(chunk).sigmoid() for chunk in features.split(512)]).cpu().numpy()


def regression_scores(predicted, bundle, index, observed):
    raw = inverse_targets(predicted, bundle)
    target = bundle.raw_targets[index]
    result = {}
    for col, name in enumerate(bundle.target_names):
        mask = np.isfinite(target[:, :, col]) & observed
        a, p = target[:, :, col][mask], raw[:, :, col][mask]
        result[name] = {'n': int(mask.sum()),
                        'r2': float(1 - np.square(a-p).sum() / np.square(a-bundle.raw_mean[col]).sum()),
                        'mae': float(np.abs(a-p).mean())}
    return result


@torch.inference_mode()
def predict_regression(net, features):
    net.eval()
    values = []
    for f in features.split(512):
        speed = torch.arange(51, device=f.device, dtype=f.dtype)[None].expand(len(f), -1)
        values.append(net.decode(f, speed)[0].cpu().numpy())
    return np.concatenate(values)


def refine_regression(base, features, bundle, masks, baseline_val):
    net = copy.deepcopy(base)
    for p in net.parameters(): p.requires_grad_(False)
    parameters = []
    for module in [net.first, net.hidden, net.regression]:
        for p in module.parameters(): p.requires_grad_(True); parameters.append(p)
    optimizer = torch.optim.AdamW(parameters, lr=1e-4, weight_decay=1e-4)
    observed = torch.as_tensor(masks['supervised_mask'], device='cuda')
    trusted = torch.as_tensor(masks['trusted_hover'], device='cuda')
    mass = torch.as_tensor(np.where(masks['trusted_hover'], masks['mass_kg'], 0.), device='cuda', dtype=torch.float32)
    val_idx = bundle.indices['val'].cpu().numpy()
    old_macro = float(np.mean([m['r2'] for m in baseline_val.values()]))
    best_macro, best_state, best_epoch = old_macro, None, 0
    history = []
    for epoch in range(1, 61):
        net.train(); net.encoder.eval()
        losses = []
        for index in bundle.batches('train', 256):
            speed = torch.arange(51, device='cuda', dtype=torch.float32)[None].expand(len(index), -1)
            predicted, _ = net.decode(features[index], speed)
            reg = masked_regression_loss(predicted, bundle.targets[index], bundle.mask[index] & observed[index, :, None])
            # True Mass is a TRAIN supervision term; never used to anchor predictions.
            t = trusted[index]
            standardized_weight = (mass[index] * 9.80665 - float(bundle.mean[2])) / float(bundle.std[2])
            physics = (((predicted[:, 0, 2] - standardized_weight).square()) * t).sum() / t.sum().clamp_min(1)
            loss = reg + .02 * physics
            optimizer.zero_grad(set_to_none=True); loss.backward()
            nn.utils.clip_grad_norm_(parameters, 5., error_if_nonfinite=True)
            optimizer.step(); losses.append(float(loss.detach()))
        if epoch == 1 or epoch % 5 == 0:
            pred = predict_regression(net, features[bundle.indices['val']])
            metrics = regression_scores(pred, bundle, val_idx, masks['supervised_mask'][val_idx])
            macro = float(np.mean([m['r2'] for m in metrics.values()]))
            eligible = all(metrics[k]['r2'] >= baseline_val[k]['r2'] - .005 for k in metrics)
            history.append({'epoch':epoch, 'train_loss':float(np.mean(losses)), 'val':metrics, 'eligible':eligible})
            if eligible and macro > best_macro + 1e-5:
                best_macro, best_epoch = macro, epoch
                best_state = {k:v.detach().cpu().clone() for k,v in net.state_dict().items()}
            print(f'REGRESSION epoch={epoch} macro_R2={macro:.5f} eligible={eligible} best={best_epoch}', flush=True)
        if epoch >= 30 and epoch - best_epoch >= 25: break
    report = {'accepted':best_state is not None, 'best_epoch':best_epoch, 'baseline_macro_r2':old_macro,
              'selected_macro_r2':best_macro, 'lambda_physics':.02, 'history':history,
              'rule':'Each validation R2 >= baseline-.005 and macro R2 strictly improves',
              'predicted_mass_anchoring':False, 'test_used':False}
    write_json(RUNS/'regression_refinement.json', report)
    return best_state, report


def main():
    started = time.perf_counter()
    RUNS.mkdir(parents=True, exist_ok=True)
    if (RUNS/'selected.pt').exists(): raise FileExistsError('A selected run already exists')
    torch.set_num_threads(4); torch.manual_seed(20260920); np.random.seed(20260920)
    torch.set_float32_matmul_precision('highest')
    torch.backends.cudnn.benchmark = True
    if not torch.cuda.is_available(): raise RuntimeError('CUDA required')
    checkpoint = torch.load(BASE, map_location='cpu', weights_only=True)
    assert checkpoint['normalization'].get('target_transform','raw') == 'raw'
    points_path, trims_path = ROOT/'ml/data/pointclouds.npz', ROOT/'ml/data/trims.npz'
    for name, p in [('points', points_path), ('trims', trims_path)]:
        assert digest(p) == checkpoint['data_version'][name+'_sha256']
    bundle = load_trim_bundle(points_path, trims_path, device='cuda',
                              normalization=checkpoint['normalization'], include_test=False)
    assert not len(bundle.indices['test'])
    masks = load_masks(bundle.design_id)
    observed = torch.as_tensor(masks['supervised_mask'], device='cuda', dtype=torch.float32)
    truth = bundle.valid.float()
    base = TrimPointNet(**checkpoint['model_config']).cuda().eval()
    base.load_state_dict(checkpoint['state_dict'])
    for p in base.parameters(): p.requires_grad_(False)
    features, old_logits, old_reg = [], [], []
    with torch.inference_mode():
        for start in range(0, len(bundle.points), 128):
            f = base.encode(bundle.points[start:start+128], bundle.scale_feature[start:start+128])
            speed = torch.arange(51, device='cuda', dtype=torch.float32)[None].expand(len(f), -1)
            r,l = base.decode(f,speed)
            features.append(f); old_logits.append(l); old_reg.append(r)
    features = torch.cat(features).detach().clone()
    old_probability = torch.cat(old_logits).sigmoid().cpu().numpy()
    old_reg = torch.cat(old_reg).cpu().numpy()
    train_index, val_index = bundle.indices['train'], bundle.indices['val']
    vi = val_index.cpu().numpy()
    val_truth = truth[val_index].cpu().numpy().astype(bool)
    val_observed = masks['supervised_mask'][vi]
    old_metrics = validity_metrics(val_truth, old_probability[vi], val_observed, threshold=.79)
    minimum_recall = max(.60, old_metrics['recall'] - .10)
    baseline_selection = choose_threshold(val_truth, old_probability[vi], val_observed, minimum_recall)
    baseline_regression = regression_scores(old_reg[vi], bundle, vi, val_observed)
    train_positive = float((truth[train_index]*observed[train_index]).sum())
    train_total = float(observed[train_index].sum())
    sqrt_weight = ((train_total-train_positive)/train_positive)**.5
    configs = [
        {'tag':'bce', 'positive_weight':1., 'set_weight':0., 'upper_weight':0.},
        {'tag':'bce_sqrt', 'positive_weight':sqrt_weight, 'set_weight':0., 'upper_weight':0.},
        {'tag':'set_fp', 'positive_weight':1., 'set_weight':.5, 'upper_weight':.25},
        {'tag':'set_fp_sqrt', 'positive_weight':sqrt_weight, 'set_weight':.5, 'upper_weight':.25},
    ]
    write_json(RUNS/'baseline_validation.json', {'at_original_threshold':old_metrics,
        'under_new_selection_rule':{'score':baseline_selection[0], 'threshold':baseline_selection[1], 'metrics':baseline_selection[2]},
        'regression':baseline_regression, 'minimum_recall':minimum_recall, 'test_used':False})
    print(f'GPU={torch.cuda.get_device_name(0)} train={len(train_index)} val={len(val_index)} '
          f'positive_rate={train_positive/train_total:.4f} recall_guard={minimum_recall:.4f}', flush=True)
    feature_mean = features[train_index].mean(0)
    feature_std = features[train_index].std(0).clamp_min(.01)
    results = []
    for config in configs:
        torch.manual_seed(20260920)
        head = SpeedSetHead(base.feature_dim).cuda()
        head.feature_mean.copy_(feature_mean); head.feature_std.copy_(feature_std)
        optimizer = torch.optim.AdamW(head.parameters(), lr=5e-4, weight_decay=1e-3)
        scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, mode='max', patience=10, factor=.5)
        best, best_epoch, history = -1e9, 0, []
        best_state = None
        for epoch in range(1, 181):
            head.train(); losses = []
            for index in bundle.batches('train', 256):
                logits = head(features[index])
                loss = cls_loss(logits, truth[index], observed[index], **{k:v for k,v in config.items() if k!='tag'})
                optimizer.zero_grad(set_to_none=True); loss.backward()
                nn.utils.clip_grad_norm_(head.parameters(), 5., error_if_nonfinite=True)
                optimizer.step(); losses.append(float(loss.detach()))
            probability = probabilities(head, features[val_index])
            score, threshold, metrics = choose_threshold(val_truth, probability, val_observed, minimum_recall)
            scheduler.step(score)
            entry = {'epoch':epoch,'train_loss':float(np.mean(losses)), 'score':score,
                     'threshold':threshold,'metrics':metrics}
            history.append(entry)
            if score > best + 1e-5:
                best, best_epoch, best_entry = score, epoch, entry
                best_state = {k:v.detach().cpu().clone() for k,v in head.state_dict().items()}
                torch.save({'state_dict':best_state,'config':config,'selection':best_entry}, RUNS/(config['tag']+'.pt'))
            if epoch == 1 or epoch % 10 == 0:
                print(f'{config["tag"]} epoch={epoch} score={score:.4f} f1={metrics["f1"]:.4f} '
                      f'recall={metrics["recall"]:.4f} exact={metrics["exact_active"]:.4f} '
                      f'upper={metrics["upper_over_fraction"]:.4f} best={best_epoch}', flush=True)
            if epoch % 10 == 0:
                write_json(RUNS/(config['tag']+'.json'), {'config':config,'best':best_entry,'history':history,'test_used':False})
            if epoch-best_epoch >= 35: break
        report = {'config':config,'best':best_entry,'history':history,'test_used':False}
        write_json(RUNS/(config['tag']+'.json'), report)
        results.append(report)
    winner = max(results, key=lambda r:r['best']['score'])
    # Independent regression experiment; validity encoder remains identical.
    regression_state, reg_report = refine_regression(base, features, bundle, masks, baseline_regression)
    model_config = {**checkpoint['model_config'], 'validity_widths':[256,128], 'validity_dropout':.15}
    net = TrimValidityV2(**model_config)
    net.load_state_dict(regression_state if regression_state else checkpoint['state_dict'], strict=False)
    cls_checkpoint = torch.load(RUNS/(winner['config']['tag']+'.pt'), weights_only=True)
    net.speed_set.load_state_dict(cls_checkpoint['state_dict'])
    final = dict(checkpoint)
    final.update(baseline_training_args=checkpoint.get('args'),
                 baseline_validation=checkpoint.get('val'),
                 args={'seed':20260920, 'batch_size':256, 'learning_rate':5e-4, 'encoder_frozen':True,
                       'classifier':winner['config'], 'regression_lambda_physics':.02},
                 best_score=winner['best']['score'], val=winner['best']['metrics'], epoch=winner['best']['epoch'],
                 state_dict=net.state_dict(), model_config=model_config, model_kind='trim_validity_v2',
                 baseline_checkpoint=str(BASE), baseline_sha256=digest(BASE),
                 threshold=winner['best']['threshold'], validity_selection=winner['best'],
                 validity_config=winner['config'], regression_refinement=reg_report['accepted'],
                 best_epoch=winner['best']['epoch'], test_used_for_selection=False,
                 supervised_mask_sha256=digest(OUT/'data/hover_supervision_masks.npz'))
    torch.save(final,RUNS/'selected.pt')
    selection = {'selected':winner['config']['tag'], 'threshold':winner['best']['threshold'],
                 'validation':winner['best'], 'baseline_original_threshold':old_metrics,
                 'baseline_same_selection_rule':{'score':baseline_selection[0],'threshold':baseline_selection[1],'metrics':baseline_selection[2]},
                 'validation_score_improved':winner['best']['score'] > baseline_selection[0],
                 'experiments':[{'config':r['config'],'best':r['best']} for r in results],
                 'regression_refinement_accepted':reg_report['accepted'],
                 'minimum_recall':minimum_recall,'test_used':False,
                 'selected_checkpoint_sha256':digest(RUNS/'selected.pt'),
                 'elapsed_seconds':time.perf_counter()-started}
    write_json(RUNS/'selection.json',selection)
    print('SELECTION',json.dumps({k:v for k,v in selection.items() if k not in ['experiments','validation','baseline_original_threshold','baseline_same_selection_rule']}),flush=True)


if __name__=='__main__': main()
