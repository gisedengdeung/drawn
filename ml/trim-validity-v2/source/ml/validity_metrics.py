"""NumPy-only validity metrics for possibly disconnected speed sets.

Metrics use observed labels. Activity can remain unknown under partial masks.
Upper-bound overestimation is a diagnostic, never a continuity assumption.
Checkpoint/threshold selection must receive validation data only.
"""
from __future__ import annotations

import numpy as np


def _ratio(numerator, denominator):
    return float(numerator / denominator) if denominator else None


def _confusion(actual, predicted):
    tp = int(np.count_nonzero(actual & predicted))
    fp = int(np.count_nonzero(~actual & predicted))
    fn = int(np.count_nonzero(actual & ~predicted))
    tn = int(np.count_nonzero(~actual & ~predicted))
    return {
        'tp': tp, 'fp': fp, 'fn': fn, 'tn': tn,
        'precision': _ratio(tp, tp + fp),
        'recall': _ratio(tp, tp + fn),
        'f1': _ratio(2 * tp, 2 * tp + fp + fn),
        'f0_5': _ratio(1.25 * tp, 1.25 * tp + fp + .25 * fn),
        'fpr': _ratio(fp, fp + tn),
    }


def validity_metrics(truth, probability, observed_mask=None, threshold=0.5):
    """Score ``(N, 51)`` labels/probabilities without filling invalid gaps.

    Unobserved cells do not influence classification, endpoints, activity,
    exact-set agreement, or counts. Endpoints are those of *observed* true
    positives, so endpoint diagnostics are not claims about unknown speeds.
    ``exact_all`` covers complete 51-speed labels only. ``observed_exact_all``
    covers agreement on observed cells for every design with an observation.
    ``exact_active`` and ``iou_active`` use observed cells of known-active
    designs; they do not establish full-set agreement where labels are masked.
    Activity is known if any observed speed is positive, or all 51 speeds are
    observed. Designs with no observed positives and missing speeds have unknown
    activity: exclude them from any-valid confusion and inactive design counts.
    Undefined rates are None (strict-JSON compatible).

    ``upper_over_fraction`` divides by every observed true-active design,
    including missing predictions. A missing prediction has upper bound -1,
    is counted as an underestimate, and is separately counted as missed.
    """
    actual = np.asarray(truth)
    probabilities = np.asarray(probability, dtype=np.float64)
    if actual.ndim != 2 or actual.shape[1] != 51:
        raise ValueError('truth must have shape (N, 51).')
    if probabilities.shape != actual.shape:
        raise ValueError('probability must have the same shape as truth.')
    observed = (np.ones(actual.shape, dtype=bool) if observed_mask is None
                else np.asarray(observed_mask, dtype=bool))
    if observed.shape != actual.shape:
        raise ValueError('observed_mask must have the same shape as truth.')
    if not np.isfinite(threshold) or not 0 <= threshold <= 1:
        raise ValueError('threshold must be finite and within [0, 1].')
    if not np.isin(actual[observed], [False, True]).all():
        raise ValueError('Observed truth values must be boolean or 0/1.')
    if (not np.isfinite(probabilities[observed]).all()
            or np.any((probabilities[observed] < 0) | (probabilities[observed] > 1))):
        raise ValueError('Observed probabilities must be finite and within [0, 1].')

    actual = actual.astype(bool) & observed
    predicted = (probabilities >= threshold) & observed
    eligible = observed.any(axis=1)
    active = actual.any(axis=1)
    complete = observed.all(axis=1)
    inactive = complete & ~active
    partial_unknown = ~complete & ~active
    activity_known = active | complete
    predicted_active = predicted.any(axis=1)
    n_eligible, n_active = int(eligible.sum()), int(active.sum())
    result = _confusion(actual[observed], predicted[observed])
    exact = (actual == predicted).all(axis=1)
    intersection = (actual & predicted).sum(axis=1)
    union = (actual | predicted).sum(axis=1)
    actual_count, predicted_count = actual.sum(axis=1), predicted.sum(axis=1)
    speeds = np.arange(51)[None, :]
    actual_upper = np.where(actual, speeds, -1).max(axis=1)
    predicted_upper = np.where(predicted, speeds, -1).max(axis=1)
    actual_lower = np.where(actual, speeds, 51).min(axis=1)
    over = active & (predicted_upper > actual_upper)
    under = active & (predicted_upper < actual_upper)
    false_positive = predicted & ~actual
    above = false_positive & active[:, None] & (speeds > actual_upper[:, None])
    holes = (false_positive & active[:, None]
             & (speeds > actual_lower[:, None]) & (speeds < actual_upper[:, None]))
    below = false_positive & active[:, None] & (speeds < actual_lower[:, None])
    any_valid = _confusion(active[activity_known], predicted_active[activity_known])
    result.update({
        'threshold': float(threshold),
        'designs': int(actual.shape[0]),
        'observed_designs': n_eligible,
        'unobserved_designs': int((~eligible).sum()),
        'complete_observed_designs': int(complete.sum()),
        'partial_unknown_designs': int(partial_unknown.sum()),
        'partially_observed_active_designs': int((active & ~complete).sum()),
        'any_valid_evaluable_designs': int(activity_known.sum()),
        'observed_cells': int(observed.sum()),
        'masked_cells': int((~observed).sum()),
        'active_designs': n_active,
        'inactive_designs': int(inactive.sum()),
        'predicted_active_designs': int(predicted_active.sum()),
        'missed_active_designs': int((active & ~predicted_active).sum()),
        'exact_all_count': int((exact & complete).sum()),
        'exact_all': _ratio(int((exact & complete).sum()), int(complete.sum())),
        'observed_exact_all_count': int((exact & eligible).sum()),
        'observed_exact_all': _ratio(int((exact & eligible).sum()), n_eligible),
        'exact_active_count': int((exact & active).sum()),
        'exact_active': _ratio(int((exact & active).sum()), n_active),
        'iou_active': float(np.mean(intersection[active] / union[active])) if n_active else None,
        'speed_hamming': _ratio(int(np.count_nonzero(actual != predicted)), int(observed.sum())),
        'mean_true_valid_count': float(actual_count[eligible].mean()) if n_eligible else None,
        'mean_pred_valid_count': float(predicted_count[eligible].mean()) if n_eligible else None,
        'mean_true_valid_count_active': float(actual_count[active].mean()) if n_active else None,
        'mean_pred_valid_count_active': float(predicted_count[active].mean()) if n_active else None,
        'upper_over_count': int(over.sum()),
        'upper_over_fraction': _ratio(int(over.sum()), n_active),
        'upper_under_count': int(under.sum()),
        'upper_under_fraction': _ratio(int(under.sum()), n_active),
        'upper_equal_count': int((active & (predicted_upper == actual_upper)).sum()),
        'upper_comparable_designs': int((active & predicted_active).sum()),
        'dangerous_above_max_cells': int(above.sum()),
        'dangerous_hole_cells': int(holes.sum()),
        'false_positive_below_min_cells': int(below.sum()),
        'false_positive_inactive_cells': int((false_positive & inactive[:, None]).sum()),
        'false_positive_unknown_activity_cells': int((false_positive & partial_unknown[:, None]).sum()),
        'exact_all_basis': 'full 51-speed agreement on completely observed designs only',
        'active_set_basis': 'agreement and IoU on observed cells of designs with observed positive labels',
        'activity_basis': 'positive if an observed positive exists; negative only if all 51 labels are observed',
        'endpoint_basis': 'observed true-positive speeds; disconnected sets retained',
    })
    result.update({'any_valid_' + key: value for key, value in any_valid.items()})
    return result


def selection_score(metrics, minimum_recall=0.45, minimum_design_recall=0.60):
    """Validation-only checkpoint objective; larger is better.

    A recall guard keeps an all-negative head from winning through easy empty
    designs. Above the guard: 0.35 F0.5 + 0.30 active IoU + 0.20 active exact
    agreement + 0.15 any-valid recall - 0.35 upper-overestimation fraction.
    Guard failures score below -1; guarded scores lie within [-0.35, 1].
    No observed positive labels yields -2 and cannot establish a useful head.
    This heuristic is for model selection, not a UI release criterion.
    """
    if not 0 < minimum_recall <= 1 or not 0 < minimum_design_recall <= 1:
        raise ValueError('Recall guards must be within (0, 1].')
    if not metrics['active_designs']:
        return -2.0
    recall = metrics['recall'] or 0.0
    design_recall = metrics['any_valid_recall'] or 0.0
    if recall < minimum_recall or design_recall < minimum_design_recall:
        return float(-1.0 - max(0.0, minimum_recall - recall)
                     - max(0.0, minimum_design_recall - design_recall))
    return float(.35 * (metrics['f0_5'] or 0.0)
                 + .30 * (metrics['iou_active'] or 0.0)
                 + .20 * (metrics['exact_active'] or 0.0)
                 + .15 * design_recall
                 - .35 * (metrics['upper_over_fraction'] or 0.0))
