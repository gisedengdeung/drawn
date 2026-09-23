"""Stage 7: score the frozen trim checkpoint once on family-held-out test data.

The validity threshold and residual intervals are chosen on validation only.
Regression is scored on actual valid target cells, never prediction-selected
cells. All R2 denominators use the raw TRAIN mean, matching evaluate.py.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path
import sys
import time

import numpy as np
import torch

from common import REPO_ROOT
from prepare_targets import SPLIT_SALT, assign_split

INTERVAL_LEVELS = (0.50, 0.80, 0.90)
MESH_NAMES = ['extent_x', 'extent_y', 'extent_z', 'span', 'scale', 'area']


def file_digest(path):
    path = Path(path).resolve()
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    return {'path': str(path), 'sha256': digest.hexdigest(), 'bytes': path.stat().st_size, 'partial': False}


def score(actual, predicted, train_mean):
    actual, predicted = np.asarray(actual, dtype=np.float64), np.asarray(predicted, dtype=np.float64)
    if not np.isfinite(actual).all() or not np.isfinite(predicted).all():
        raise ValueError('Scored values must be finite; do not silently remove failed predictions.')
    if not actual.size:
        return {'n': 0, 'r2': None, 'mae': None, 'rmse': None, 'median_abs_error': None}
    squared = (actual - predicted) ** 2
    denominator = float(np.square(actual - train_mean).sum())
    return {
        'n': int(actual.size),
        'r2': float(1 - squared.sum() / denominator) if denominator > 0 else None,
        'mae': float(np.abs(actual - predicted).mean()),
        'rmse': float(np.sqrt(squared.mean())),
        'median_abs_error': float(np.median(np.abs(actual - predicted))),
    }


def macro_scores(actual, predicted, mask, train_mean):
    rows = [score(a[m], p[m], train_mean) for a, p, m in zip(actual, predicted, mask) if m.any()]
    result = {'designs': len(rows), 'weighting': 'each design with valid targets has equal weight'}
    for key in ('r2', 'mae', 'rmse'):
        values = [row[key] for row in rows if row[key] is not None]
        result[key] = float(np.mean(values)) if values else None
        if key == 'r2':
            result['r2_defined_designs'] = len(values)
    return result


def valid_intervals(valid):
    """Inclusive integer-speed intervals, retaining gaps and empty support."""
    indices = np.flatnonzero(np.asarray(valid, dtype=bool))
    if not len(indices):
        return []
    groups = np.split(indices, np.flatnonzero(np.diff(indices) > 1) + 1)
    return [[int(group[0]), int(group[-1])] for group in groups]


def classification_score(actual, predicted, probability=None):
    actual, predicted = np.asarray(actual, dtype=bool), np.asarray(predicted, dtype=bool)
    tp = int((actual & predicted).sum())
    fp = int((~actual & predicted).sum())
    fn = int((actual & ~predicted).sum())
    tn = int((~actual & ~predicted).sum())
    divide = lambda numerator, denominator: float(numerator / denominator) if denominator else None
    recall, specificity = divide(tp, tp + fn), divide(tn, tn + fp)
    result = {
        'n': int(actual.size), 'tp': tp, 'fp': fp, 'fn': fn, 'tn': tn,
        'precision': divide(tp, tp + fp), 'recall': recall,
        'specificity': specificity, 'f1': divide(2 * tp, 2 * tp + fp + fn),
        'accuracy': divide(tp + tn, actual.size),
        'balanced_accuracy': (recall + specificity) / 2 if recall is not None and specificity is not None else None,
    }
    if probability is not None:
        result['brier_score'] = float(np.square(np.asarray(probability) - actual).mean())
    return result


def select_threshold(actual, probability):
    probability = np.asarray(probability)
    if probability.shape != np.asarray(actual).shape or not probability.size:
        raise ValueError('Threshold selection requires aligned nonempty validation labels and probabilities.')
    if not np.isfinite(probability).all():
        raise ValueError('Non-finite validation probabilities.')
    candidates = []
    for threshold in np.linspace(0.05, 0.95, 91):
        metrics = classification_score(actual, probability >= threshold)
        candidates.append((float(threshold), metrics))
    threshold, metrics = max(candidates, key=lambda item: (
        item[1]['f1'] or 0, item[1]['precision'] or 0, -abs(item[0] - 0.5), item[0],
    ))
    return {
        'threshold': threshold, 'selected_on': 'val',
        'method': 'maximum micro F1 on fixed 0.05..0.95 grid (step 0.01); ties: higher precision, closer to 0.5, higher threshold',
        'validation_metrics': metrics,
    }


def interval_comparison(actual, predicted, design_id):
    details, per_design = [], []
    endpoint_errors = []
    for design, truth, pred in zip(design_id, actual, predicted):
        truth, pred = np.asarray(truth, dtype=bool), np.asarray(pred, dtype=bool)
        union = int((truth | pred).sum())
        overlap = float((truth & pred).sum() / union) if union else 1.0
        metrics = classification_score(truth, pred)
        per_design.append(metrics)
        truth_ranges, pred_ranges = valid_intervals(truth), valid_intervals(pred)
        if truth.any() and pred.any():
            endpoint_errors.append([abs(truth_ranges[0][0] - pred_ranges[0][0]),
                                    abs(truth_ranges[-1][1] - pred_ranges[-1][1])])
        details.append({
            'design_id': int(design), 'actual_intervals': truth_ranges,
            'predicted_intervals': pred_ranges, 'actual_valid_speeds': int(truth.sum()),
            'predicted_valid_speeds': int(pred.sum()), 'iou': overlap,
            'exact_speed_set_match': bool(np.array_equal(truth, pred)),
        })
    macro = {}
    for key in ('precision', 'recall', 'f1', 'accuracy', 'specificity'):
        defined = [row[key] for row in per_design if row[key] is not None]
        macro[key] = float(np.mean(defined)) if defined else None
        macro[key + '_defined_designs'] = len(defined)
    summary = {
        'designs': len(details), 'macro_per_design': macro,
        'mean_iou': float(np.mean([row['iou'] for row in details])) if details else None,
        'exact_speed_set_match_fraction': float(np.mean([row['exact_speed_set_match'] for row in details])) if details else None,
        'actual_disconnected_designs': sum(len(row['actual_intervals']) > 1 for row in details),
        'predicted_disconnected_designs': sum(len(row['predicted_intervals']) > 1 for row in details),
        'actual_empty_designs': sum(not row['actual_intervals'] for row in details),
        'predicted_empty_designs': sum(not row['predicted_intervals'] for row in details),
        'endpoint_mae_when_both_nonempty': np.mean(endpoint_errors, axis=0).tolist() if endpoint_errors else None,
        'endpoint_comparison_designs': len(endpoint_errors),
        'interval_convention': 'inclusive integer m/s endpoints; gaps retained; both-empty IoU=1',
    }
    return summary, details


def calibrate_intervals(actual, predicted, target_name):
    actual, predicted = np.asarray(actual), np.asarray(predicted)
    if not actual.size:
        return {'method': 'unavailable', 'calibration_rows': 0, 'bands': {}}
    if not np.isfinite(actual).all() or not np.isfinite(predicted).all():
        raise ValueError('Non-finite interval calibration data.')
    multiplicative = target_name not in ('pitch', 'drag') and (actual > 0).all() and (predicted > 0).all()
    bands = {}
    for level in INTERVAL_LEVELS:
        tails = [(1 - level) / 2, (1 + level) / 2]
        low, high = np.quantile(actual - predicted, tails)
        band = {'nominal': level, 'additive_low': float(low), 'additive_high': float(high)}
        if multiplicative:
            low, high = np.quantile(actual / predicted, tails)
            band.update(low_multiplier=float(low), high_multiplier=float(high))
        bands[str(level)] = band
    return {
        'method': 'multiplicative' if multiplicative else 'additive',
        'calibration_rows': int(actual.size), 'calibrated_on': 'val', 'bands': bands,
        'reason': ('positive actual and predicted values; additive fallback for nonpositive test predictions'
                   if multiplicative else 'signed pitch, zero-capable drag, or nonpositive validation values require additive residuals'),
        'limitation': 'empirical marginal residual bands, not simultaneous or guaranteed coverage; validation also selected the model',
    }


def interval_bounds(calibration, predicted, level):
    predicted = np.asarray(predicted)
    band = calibration['bands'][str(level)]
    low, high = predicted + band['additive_low'], predicted + band['additive_high']
    used_multiplier = np.zeros(predicted.shape, dtype=bool)
    if calibration['method'] == 'multiplicative':
        used_multiplier = predicted > 0
        low = np.where(used_multiplier, predicted * band['low_multiplier'], low)
        high = np.where(used_multiplier, predicted * band['high_multiplier'], high)
    return low, high, used_multiplier


def interval_coverage(calibration, actual, predicted):
    result = {}
    if not np.asarray(actual).size:
        return result
    for level in calibration['bands']:
        low, high, multiplicative = interval_bounds(calibration, predicted, level)
        result[level] = {
            'n': int(actual.size), 'nominal': float(level),
            'empirical': float(((actual >= low) & (actual <= high)).mean()),
            'median_width': float(np.median(high - low)),
            'additive_rows': int((~multiplicative).sum()),
            'multiplicative_rows': int(multiplicative.sum()),
        }
    return result


def calibration_by_decile(actual, predicted):
    actual, predicted = np.asarray(actual), np.asarray(predicted)
    if not actual.size:
        return {'deciles': []}
    # Stable equal-count bins retain zero/signed values and never divide by zero.
    ordered = np.argsort(actual, kind='stable')
    deciles = []
    for number, indices in enumerate(np.array_split(ordered, 10), 1):
        if not len(indices):
            continue
        a, p = actual[indices], predicted[indices]
        am, pm = float(np.median(a)), float(np.median(p))
        deciles.append({
            'decile': number, 'n': len(indices), 'actual_range': [float(a.min()), float(a.max())],
            'actual_median': am, 'predicted_median': pm,
            'ratio': pm / am if abs(am) > 1e-12 else None,
            'median_signed_error': float(np.median(p - a)),
            'mae': float(np.abs(p - a).mean()),
        })
    return {
        'binning': 'equal-count bins sorted by actual target; equal values may cross adjacent bins',
        'ratio_caution': 'ratio is undefined near zero and not an accuracy measure for signed pitch',
        'deciles': deciles, 'actual_min': float(actual.min()), 'actual_max': float(actual.max()),
        'predicted_min': float(predicted.min()), 'predicted_max': float(predicted.max()),
        'actual_p01_p99': np.quantile(actual, [0.01, 0.99]).tolist(),
        'predicted_p01_p99': np.quantile(predicted, [0.01, 0.99]).tolist(),
        'bottom_decile_ratio': deciles[0]['ratio'], 'top_decile_ratio': deciles[-1]['ratio'],
    }


def assert_family_separation(families, splits):
    seen = {}
    for family, split in zip(families, splits):
        family, split = str(family), str(split)
        if not family or split not in ('train', 'val', 'test'):
            raise ValueError('Missing family or unknown split.')
        if family in seen and seen[family] != split:
            raise ValueError(f'Family crosses splits: {family}')
        if assign_split(family) != split:
            raise ValueError(f'Family split violates frozen hash rule: {family}')
        seen[family] = split
    return {'passed': True, 'families': len(seen), 'split_salt': SPLIT_SALT,
            'families_per_split': {key: sum(value == key for value in seen.values()) for key in ('train', 'val', 'test')}}


def mesh_matrix(mesh, feature_mean, feature_std):
    normalized = (np.asarray(mesh, dtype=np.float64) - feature_mean) / feature_std
    count = len(normalized)
    return np.concatenate([
        np.broadcast_to(normalized[:, None, :], (count, 51, 6)),
        np.broadcast_to(np.arange(51, dtype=float)[None, :, None] / 50, (count, 51, 1)),
        np.ones((count, 51, 1)),
    ], axis=-1)


def fit_baselines(mesh, raw, masks, splits):
    """Only train labels and train geometry can affect fitted parameters."""
    train = np.asarray(splits) == 'train'
    if not train.any() or not np.isfinite(mesh).all():
        raise ValueError('Baselines require training designs and finite mesh features.')
    geometry = np.asarray(mesh)[train]
    feature_mean, feature_std = geometry.mean(axis=0), geometry.std(axis=0)
    feature_std = np.where(feature_std > 0, feature_std, 1)
    matrix = mesh_matrix(geometry, feature_mean, feature_std)
    targets, usable = np.asarray(raw)[train], np.asarray(masks)[train]
    speed_mean = np.empty((51, targets.shape[-1]))
    weights, missing_speed = [], []
    for column in range(targets.shape[-1]):
        mask, values = usable[:, :, column], targets[:, :, column]
        if not mask.any():
            raise ValueError(f'No train observations for baseline target {column}')
        train_mean = values[mask].mean()
        # Reuse PyTorch's LAPACK runtime; NumPy MKL can load a conflicting OpenMP DLL on Windows.
        solution = torch.linalg.lstsq(torch.from_numpy(matrix[mask]), torch.from_numpy(values[mask]), driver='gelsd').solution
        weights.append(solution.numpy())
        missing = []
        for speed in range(51):
            cells = mask[:, speed]
            speed_mean[speed, column] = values[cells, speed].mean() if cells.any() else train_mean
            if not cells.any():
                missing.append(speed)
        missing_speed.append(missing)
    return {'speed_mean': speed_mean, 'weights': np.column_stack(weights),
            'feature_mean': feature_mean, 'feature_std': feature_std,
            'speeds_using_global_train_mean': missing_speed}


def baseline_predictions(fitted, mesh):
    matrix = mesh_matrix(mesh, fitted['feature_mean'], fitted['feature_std'])
    return {'speed_mean': np.broadcast_to(fitted['speed_mean'], (len(mesh), 51, fitted['speed_mean'].shape[1])),
            'mesh_plus_speed': np.einsum('nsi,it->nst', matrix, fitted['weights'], optimize=False)}


@torch.inference_mode()
def predict(model, bundle, split, batch_size, normalization):
    from dataset_trim import inverse_targets
    rows, predictions, probabilities = [], [], []
    model.eval()
    for index in bundle.sequential(split, batch_size):
        regression, logits = model(bundle.points[index], bundle.scale_feature[index])
        rows.append(index.cpu().numpy())
        predictions.append(inverse_targets(regression.float().cpu().numpy(), normalization))
        probabilities.append(torch.sigmoid(logits).float().cpu().numpy())
    if not rows:
        raise ValueError(f'Empty required evaluation split: {split}')
    result = np.concatenate(predictions)
    probability = np.concatenate(probabilities)
    if not np.isfinite(result).all() or not np.isfinite(probability).all():
        raise ValueError(f'Non-finite predictions in {split}; evaluation cannot drop failed rows.')
    return np.concatenate(rows), result, probability


def resampling_variance(model, bundle, rows, normalization, threshold, roots, count, seeds):
    """Optional diagnostic: choose IDs before inspecting labels, never tune on it."""
    if count <= 0:
        return {'status': 'not requested'}
    from dataset_trim import inverse_targets
    try:
        import trimesh
    except ImportError:
        return {'status': 'skipped', 'reason': 'trimesh unavailable'}
    selected = sorted(int(value) for value in bundle.design_id[rows])[:count]
    results = []
    for design_id in selected:
        matches = [root / f'design_{design_id}' / 'cadfile.stl' for root in roots]
        matches = [path for path in matches if path.is_file()]
        if not matches:
            results.append({'design_id': design_id, 'status': 'skipped', 'reason': 'local STL unavailable'})
            continue
        try:
            mesh = trimesh.load_mesh(matches[0], process=False, force='mesh')
            predictions, validity = [], []
            for seed in seeds:
                cloud, _ = trimesh.sample.sample_surface(mesh, bundle.points.shape[-1], seed=seed)
                centered = cloud - cloud.mean(axis=0)
                scale = float(np.abs(centered).max())
                if not np.isfinite(scale) or scale <= 0:
                    raise ValueError('Degenerate sampled scale')
                points = torch.tensor(centered / scale, dtype=torch.float32, device=bundle.points.device).T[None]
                scale_feature = torch.tensor([[(np.log(scale) - normalization['scale_log_mean']) / normalization['scale_log_std']]],
                                             dtype=torch.float32, device=bundle.points.device)
                with torch.inference_mode():
                    regression, logits = model(points, scale_feature)
                predictions.append(inverse_targets(regression.cpu().numpy(), normalization)[0])
                validity.append(torch.sigmoid(logits).cpu().numpy()[0] >= threshold)
            predictions, validity = np.asarray(predictions), np.asarray(validity)
            variability = predictions.std(axis=0)
            results.append({'design_id': design_id, 'status': 'complete', 'stl': str(matches[0]),
                            'median_std_across_speeds': np.median(variability, axis=0).tolist(),
                            'max_std_across_speeds': variability.max(axis=0).tolist(),
                            'validity_disagreement_speeds': int(np.any(validity != validity[:1], axis=0).sum())})
        except Exception as exc:
            results.append({'design_id': design_id, 'status': 'failed', 'reason': str(exc)})
    return {'status': 'diagnostic', 'selection': 'lowest test design IDs, independent of labels and model errors',
            'seeds': list(seeds), 'target_order': bundle.target_names, 'designs': results,
            'limitation': 'small local-STL diagnostic; not a population guarantee or model-selection input'}


def main(argv=None):
    from dataset_trim import DEFAULT_POINTS, DEFAULT_TRIMS, load_trim_bundle
    from model_trim import TrimPointNet
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkpoint', required=True, type=Path)
    parser.add_argument('--points', type=Path)
    parser.add_argument('--trims', type=Path)
    parser.add_argument('--report', type=Path, default=REPO_ROOT / 'ml/reports/stage7_trim_evaluation.json')
    parser.add_argument('--predictions-dir', type=Path)
    parser.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'cpu')
    parser.add_argument('--batch-size', type=int, default=64)
    parser.add_argument('--data-root', action='append', type=Path)
    parser.add_argument('--resample-designs', type=int, default=3)
    args = parser.parse_args(argv)
    if args.batch_size < 1:
        parser.error('batch-size must be positive')
    started = time.perf_counter()
    checkpoint = torch.load(args.checkpoint, map_location='cpu', weights_only=True)
    normalization = checkpoint['normalization']
    paths = checkpoint.get('data_paths', {})
    points_path = args.points or Path(paths.get('points', DEFAULT_POINTS))
    trims_path = args.trims or Path(paths.get('trims', DEFAULT_TRIMS))
    bundle = load_trim_bundle(points_path=points_path, trims_path=trims_path, device=args.device,
                              normalization=normalization,
                              target_transform=normalization.get('target_transform', 'raw'), include_test=True)
    if list(checkpoint['target_names']) != list(bundle.target_names):
        raise ValueError('Checkpoint target order differs from dataset.')
    separation = assert_family_separation(bundle.family, bundle.split)
    model = TrimPointNet(**checkpoint['model_config']).to(args.device)
    model.load_state_dict(checkpoint['state_dict'])
    model.eval()
    with np.load(points_path, allow_pickle=False) as source:
        lookup = {int(value): index for index, value in enumerate(source['design_id'])}
        order = np.asarray([lookup[int(value)] for value in bundle.design_id])
        mesh = np.column_stack([source['extents'], source['span'], source['scale'], source['area']])[order].astype(np.float64)
    masks = bundle.mask.cpu().numpy().astype(bool)
    actual_valid = bundle.valid.cpu().numpy().astype(bool)
    print('Fitting train-only speed mean and mesh+speed baselines.', flush=True)
    fitted = fit_baselines(mesh, bundle.raw_targets, masks, bundle.split)
    val_rows, val_predicted, val_probability = predict(model, bundle, 'val', args.batch_size, normalization)
    selection = select_threshold(actual_valid[val_rows], val_probability)
    threshold = selection['threshold']
    calibrations = {}
    for column, name in enumerate(bundle.target_names):
        usable = masks[val_rows, :, column]
        calibrations[name] = calibrate_intervals(bundle.raw_targets[val_rows, :, column][usable],
                                                 val_predicted[:, :, column][usable], name)
    print(f'Frozen val validity threshold: {threshold:.2f}. Scoring held-out test once.', flush=True)
    test_rows, test_predicted, test_probability = predict(model, bundle, 'test', args.batch_size, normalization)
    all_baselines = {name: baseline_predictions(fitted, mesh[rows])
                     for name, rows in [('val', val_rows), ('test', test_rows)]}
    targets = {}
    for column, name in enumerate(bundle.target_names):
        entry = {'train_mean_raw': float(bundle.raw_mean[column]), 'prediction_interval': calibrations[name]}
        for split_name, rows, predicted in [('val', val_rows, val_predicted), ('test', test_rows, test_predicted)]:
            actual = bundle.raw_targets[rows, :, column]
            split_scores = {}
            for selector in ('speed0_included', 'speed0_excluded'):
                mask = masks[rows, :, column].copy()
                if selector == 'speed0_excluded':
                    mask[:, 0] = False
                a, p = actual[mask], predicted[:, :, column][mask]
                split_scores[selector] = {
                    'model': score(a, p, bundle.raw_mean[column]),
                    'macro_per_design': macro_scores(actual, predicted[:, :, column], mask, bundle.raw_mean[column]),
                    'baselines': {key: score(a, baseline[:, :, column][mask], bundle.raw_mean[column])
                                  for key, baseline in all_baselines[split_name].items()},
                }
                if split_name == 'test':
                    split_scores[selector]['interval_coverage'] = interval_coverage(calibrations[name], a, p)
                    split_scores[selector]['calibration_by_decile'] = calibration_by_decile(a, p)
            entry[split_name] = split_scores
        targets[name] = entry
    validity = {'threshold_selection': selection}
    interval_rows = []
    train_valid_mean = actual_valid[bundle.split == 'train'].mean(axis=0)
    for split_name, rows, probability in [('val', val_rows, val_probability), ('test', test_rows, test_probability)]:
        truth, predictions = actual_valid[rows], probability >= threshold
        ranges, details = interval_comparison(truth, predictions, bundle.design_id[rows])
        validity[split_name] = {
            'micro': classification_score(truth, predictions, probability), 'interval_comparison': ranges,
            'baselines': {'always_valid': classification_score(truth, np.ones(truth.shape, dtype=bool)),
                          'train_speed_majority': classification_score(truth, np.broadcast_to(train_valid_mean >= 0.5, truth.shape))},
        }
        interval_rows.extend([{'split': split_name, **row} for row in details])
    output_dir = args.predictions_dir or REPO_ROOT / 'ml/runs' / (args.checkpoint.stem + '_evaluation')
    output_dir.mkdir(parents=True, exist_ok=True)
    ranges_path = output_dir / 'valid_speed_intervals.csv'
    with ranges_path.open('w', newline='', encoding='utf-8') as handle:
        writer = csv.DictWriter(handle, fieldnames=list(interval_rows[0]))
        writer.writeheader()
        for row in interval_rows:
            writer.writerow({key: json.dumps(value) if isinstance(value, list) else value for key, value in row.items()})
    prediction_path = output_dir / 'test_predictions.npz'
    np.savez_compressed(prediction_path, design_id=bundle.design_id[test_rows], speed=np.arange(51),
                        target_names=np.asarray(bundle.target_names), actual=bundle.raw_targets[test_rows],
                        actual_mask=masks[test_rows], actual_valid=actual_valid[test_rows],
                        predicted=test_predicted, valid_probability=test_probability,
                        predicted_valid=test_probability >= threshold, threshold=np.asarray(threshold))
    roots = args.data_root or sorted((REPO_ROOT / 'data/raw').glob('AircraftVerse_*'))
    sampling = resampling_variance(model, bundle, test_rows, normalization, threshold, roots,
                                   args.resample_designs, (17, 29, 43))
    report = {
        'model_version': {
            'evaluated_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
            'checkpoint': file_digest(args.checkpoint), 'points': file_digest(points_path), 'trims': file_digest(trims_path),
            'architecture': checkpoint['model_config'], 'best_epoch': checkpoint.get('best_epoch'),
            'normalization': normalization, 'split_validation': separation,
            'split_sizes': {name: int((bundle.split == name).sum()) for name in ('train', 'val', 'test')},
            'scoring_rule': 'raw-unit R2 = 1 - SSE/sum((actual - raw TRAIN mean)^2); actual-valid cells only; no prediction gating',
        },
        'targets': targets, 'validity': validity,
        'baselines': {'mesh_features': MESH_NAMES + ['speed/50'], 'fit_split': 'train',
                      'linear_model': 'ordinary least squares with intercept; mesh normalization fitted on train',
                      'speed_mean_missing_speed_fallbacks': dict(zip(bundle.target_names, fitted['speeds_using_global_train_mean']))},
        'resampling_variance': sampling,
        'artifacts': {'valid_speed_intervals_csv': str(ranges_path.resolve()), 'test_predictions_npz': str(prediction_path.resolve())},
        'elapsed_seconds': time.perf_counter() - started,
        'limitations': [
            'Test is evaluated after the checkpoint, threshold and interval calibration are frozen; do not tune from this report.',
            'Rows within a design are correlated; macro design scores supplement pooled row scores.',
            'Validation residual intervals are empirical marginal bands, not certified or simultaneous guarantees.',
            'Geometry lacks battery, motor and propeller specifications; power/current uncertainty is irreducible from these inputs alone.',
            'Regression outputs at predicted invalid speeds are diagnostic values and must not be displayed as feasible flight.',
        ],
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + '\n', encoding='utf-8')
    for name, entry in targets.items():
        metrics = entry['test']['speed0_excluded']['model']
        print(f'{name:12} test excluding speed0: R2={metrics["r2"]} MAE={metrics["mae"]}', flush=True)
    print(f'Report: {args.report}', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
