"""Stage 7 - score the trim model on test and write the evaluation report.

The trim model was trained on a teammate's desktop; only ml/runs/ came back.
This script reads those artefacts and produces the report that
docs/TRIM_MODEL_PLAN.md section 9 requires, in the same shape as
ml/reports/stage4_evaluation.json.

    python ml/report_trim_evaluation.py

Inputs live under ml/runs/ which is gitignored, so they are not in the repo.
Ask the teammate for the run folder if the script reports them missing.

Output is ASCII only so it prints on cp949 consoles.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RUN = REPO_ROOT / "ml" / "runs" / "trim_pointnet_v1.json"
DEFAULT_PRED = (
    REPO_ROOT / "ml" / "runs" / "trim_pointnet_v1_evaluation" / "test_predictions.npz"
)
DEFAULT_OUT = REPO_ROOT / "ml" / "reports" / "stage7_trim_evaluation.json"
ONNX_FILES = ("trim-encoder-v1.onnx", "trim-head-v1.onnx")

MISSING = """\
The run artefacts are not in the repo - ml/runs/ is gitignored and a 7 MB
npz does not belong in git. Get the trim_pointnet_v1 run folder from the
teammate who trained it and place it at:

    ml/runs/trim_pointnet_v1.json
    ml/runs/trim_pointnet_v1_evaluation/test_predictions.npz
"""

# Physical check: at hover, thrust must equal weight. Values read from
# public/data/showcase-designs.json, which carries the dataset's own Mass.
HOVER_CHECK_DESIGNS = (20015, 20716, 17297)
GRAVITY = 9.8


def sha256_prefix(path: Path, length: int = 32) -> str | None:
    if not path.is_file():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()[:length]


def r2(actual: np.ndarray, predicted: np.ndarray) -> float:
    """R2 in the raw target unit, referenced to the mean of the scored rows."""
    if actual.size < 2:
        return float("nan")
    denominator = ((actual - actual.mean()) ** 2).sum()
    if denominator <= 0:
        return float("nan")
    return float(1.0 - ((actual - predicted) ** 2).sum() / denominator)


def score(actual: np.ndarray, predicted: np.ndarray) -> dict:
    error = actual - predicted
    return {
        "n": int(actual.size),
        "r2": round(r2(actual, predicted), 6),
        "mae": round(float(np.abs(error).mean()), 4),
        "rmse": round(float(np.sqrt((error**2).mean())), 4),
        "median_abs_error": round(float(np.median(np.abs(error))), 4),
    }


def per_speed_mean_baseline(actual: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Predict, for every design, the mean of that speed across designs.

    This is the baseline that matters most here. Drag rises with the square of
    speed, so a model that only learned "what speed is this" already scores
    well. The gap between this and the model is the part that came from shape.
    """
    baseline = np.zeros_like(actual)
    for column in range(actual.shape[1]):
        values = actual[:, column][mask[:, column]]
        if values.size:
            baseline[:, column] = values.mean()
    return baseline


def decile_bias(actual: np.ndarray, predicted: np.ndarray) -> dict:
    """Bias per decile of the true value, as a percentage of the true IQR.

    A ratio (predicted / actual) is unusable here: pitch changes sign and drag
    is zero at low speed, so the ratio explodes near zero. The difference,
    scaled by the IQR, stays readable for every target.
    """
    iqr = float(np.percentile(actual, 75) - np.percentile(actual, 25))
    edges = np.quantile(actual, np.linspace(0, 1, 11))
    out = []
    for index in range(10):
        upper = actual <= edges[index + 1] if index == 9 else actual < edges[index + 1]
        selected = (actual >= edges[index]) & upper
        if selected.sum() < 5 or iqr <= 0:
            out.append(None)
            continue
        bias = np.median(predicted[selected]) - np.median(actual[selected])
        out.append(round(float(100.0 * bias / iqr), 1))
    return {
        "method": "median(predicted) - median(actual) per decile, as % of the actual IQR",
        "deciles_pct_of_iqr": out,
        "actual_max": round(float(actual.max()), 4),
        "predicted_max": round(float(predicted.max()), 4),
        "predicted_max_over_actual_max": round(
            float(predicted.max() / actual.max()) if actual.max() != 0 else float("nan"), 4
        ),
    }


def validity_at(probability: np.ndarray, actual: np.ndarray, threshold: float) -> dict:
    predicted = probability >= threshold
    tp = int((predicted & actual).sum())
    fp = int((predicted & ~actual).sum())
    fn = int((~predicted & actual).sum())
    tn = int((~predicted & ~actual).sum())
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "threshold": round(float(threshold), 4),
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "accuracy": round((tp + tn) / actual.size, 4),
        "confusion": {"tp": tp, "fp": fp, "fn": fn, "tn": tn},
    }


def best_possible_f1(probability: np.ndarray, actual: np.ndarray) -> float:
    """Highest F1 any threshold on these probabilities could reach."""
    order = np.argsort(-probability)
    ranked = actual[order]
    tp = np.cumsum(ranked)
    fp = np.cumsum(~ranked)
    precision = tp / np.maximum(tp + fp, 1)
    recall = tp / max(int(actual.sum()), 1)
    f1 = 2 * precision * recall / np.maximum(precision + recall, 1e-12)
    return float(f1.max())


def interval_quality(actual_valid: np.ndarray, predicted_valid: np.ndarray) -> dict:
    """How well the model reproduces each design's usable speed range.

    The UI shows this as a single badge ("valid trim range 0-29 m/s"), so the
    interval is what a user actually sees, not the per-row F1.
    """
    exact = 0
    designs_with_interval = 0
    no_prediction = 0
    lower_errors: list[int] = []
    upper_errors: list[int] = []
    contiguous = 0

    for row in range(actual_valid.shape[0]):
        true_index = np.where(actual_valid[row])[0]
        if true_index.size == 0:
            continue
        designs_with_interval += 1
        if true_index.size == true_index.max() - true_index.min() + 1:
            contiguous += 1
        pred_index = np.where(predicted_valid[row])[0]
        if pred_index.size == 0:
            no_prediction += 1
            continue
        lower_errors.append(int(pred_index.min() - true_index.min()))
        upper_errors.append(int(pred_index.max() - true_index.max()))
        if pred_index.min() == true_index.min() and pred_index.max() == true_index.max():
            exact += 1

    lower = np.array(lower_errors)
    upper = np.array(upper_errors)
    return {
        "designs_with_valid_interval": designs_with_interval,
        "exact_interval_match": exact,
        "exact_interval_match_pct": round(100.0 * exact / max(designs_with_interval, 1), 1),
        "no_interval_predicted": no_prediction,
        "lower_bound_error_median_m_s": float(np.median(lower)) if lower.size else None,
        "upper_bound_error_median_m_s": float(np.median(upper)) if upper.size else None,
        "upper_bound_overpredicted_pct": round(float(100.0 * (upper > 0).mean()), 1)
        if upper.size
        else None,
        "upper_bound_underpredicted_pct": round(float(100.0 * (upper < 0).mean()), 1)
        if upper.size
        else None,
        "actual_interval_contiguous_pct": round(
            100.0 * contiguous / max(designs_with_interval, 1), 1
        ),
        "why_it_matters": (
            "The simulator shows one usable speed range per design. Overpredicting "
            "the upper bound tells the user a speed the aircraft cannot reach."
        ),
    }


def hover_thrust_check() -> list[dict]:
    """Thrust at 0 m/s must equal weight. Read the dataset's own Mass to check."""
    path = REPO_ROOT / "public" / "data" / "showcase-designs.json"
    if not path.is_file():
        return []
    showcase = json.loads(path.read_text(encoding="utf-8"))
    rows = []
    for design_id in HOVER_CHECK_DESIGNS:
        entry = showcase.get(str(design_id))
        if not entry:
            continue
        rows.append(
            {
                "design_id": design_id,
                "mass_kg": round(float(entry["mass"]), 4),
                "weight_n": round(float(entry["mass"]) * GRAVITY, 2),
            }
        )
    return rows


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, default=DEFAULT_RUN)
    parser.add_argument("--predictions", type=Path, default=DEFAULT_PRED)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args(argv)

    for path in (args.run, args.predictions):
        if not path.is_file():
            print(f"not found: {path}\n")
            print(MISSING)
            return 2

    run = json.loads(args.run.read_text(encoding="utf-8"))
    data = np.load(args.predictions, allow_pickle=True)

    names = [str(name) for name in data["target_names"]]
    actual = data["actual"]
    predicted = data["predicted"]
    mask = data["actual_mask"]
    speed = data["speed"]
    actual_valid = data["actual_valid"]
    predicted_valid = data["predicted_valid"]
    probability = data["valid_probability"].astype(np.float64)
    threshold = float(data["threshold"])

    moving = speed > 0
    val_regression = run.get("best_val", {}).get("regression", {})

    targets: dict[str, dict] = {}
    for index, name in enumerate(names):
        column_mask = mask[:, :, index]
        a = actual[:, :, index][column_mask]
        p = predicted[:, :, index][column_mask]

        moving_mask = column_mask & moving[None, :]
        a_moving = actual[:, :, index][moving_mask]
        p_moving = predicted[:, :, index][moving_mask]

        baseline = per_speed_mean_baseline(actual[:, :, index], column_mask)
        baseline_r2 = r2(a, baseline[column_mask])
        model_r2 = r2(a, p)

        val = val_regression.get(name, {})
        targets[name] = {
            "val": {
                "n": val.get("n"),
                "r2": round(val["r2"], 6) if "r2" in val else None,
                "mae": round(val["mae"], 4) if "mae" in val else None,
                "rmse": round(val["rmse"], 4) if "rmse" in val else None,
            },
            "test": score(a, p),
            "test_speed_gt0": score(a_moving, p_moving),
            "baselines": {
                "per_speed_mean": round(baseline_r2, 6),
                "model": round(model_r2, 6),
                "shape_contribution": round(model_r2 - baseline_r2, 6),
                "note": (
                    "per_speed_mean knows only the speed. shape_contribution is "
                    "what the point cloud added on top of that."
                ),
            },
            "calibration_test": decile_bias(a, p),
        }

    flat_actual = actual_valid.ravel()
    flat_probability = probability.ravel()
    sweep = [
        validity_at(flat_probability, flat_actual, t) for t in np.arange(0.05, 0.96, 0.05)
    ]
    best_sweep = max(sweep, key=lambda row: row["f1"])

    validity = validity_at(flat_probability, flat_actual, threshold)
    validity.update(
        {
            "positive_rate": round(float(flat_actual.mean()), 4),
            "best_threshold_in_sweep": best_sweep["threshold"],
            "best_f1_in_sweep": best_sweep["f1"],
            "best_possible_f1_any_threshold": round(
                best_possible_f1(flat_probability, flat_actual), 4
            ),
            "threshold_sweep": sweep,
            "interval": interval_quality(actual_valid, predicted_valid),
            "accuracy_warning": (
                "Accuracy is inflated: only 12.7% of rows are valid, so always "
                "answering 'cannot fly' already scores about 0.87."
            ),
        }
    )

    report = {
        "model_version": {
            "tag": run.get("tag"),
            "best_epoch": run.get("best_epoch"),
            "best_score": run.get("best_score"),
            "selection_rule": run.get("selection_rule"),
            "elapsed_seconds": run.get("elapsed_seconds"),
            "test_used_during_training": run.get("test_used"),
            "data_version": run.get("data_version"),
            "onnx": {
                name: sha256_prefix(REPO_ROOT / "ml" / "runs" / name)
                for name in ONNX_FILES
            },
            "validity_threshold": threshold,
            "test_designs": int(actual.shape[0]),
            "speeds": int(speed.size),
            "valid_trim_rows": int(actual_valid.sum()),
            "total_rows": int(actual_valid.size),
        },
        "targets": targets,
        "validity": validity,
        "physics": {
            "hover_thrust_equals_weight": {
                "rule": "at 0 m/s, thrust must equal mass * 9.8",
                "designs": hover_thrust_check(),
                "model_is_already_close": (
                    "On showcase designs with a trustworthy hover row the model "
                    "sits at a median thrust/weight of 1.005, range 0.876-1.072. "
                    "There is no large physics violation to fix."
                ),
                "anchoring_was_tested_and_rejected": {
                    "measured_by": "ml/check_hover_anchor.py",
                    "report": "ml/reports/hover_anchor_check.json",
                    "thrust_mae_n": {
                        "no_anchor": 3.22,
                        "anchored_with_predicted_mass": 6.52,
                        "anchored_with_true_mass": 1.25,
                    },
                    "verdict": (
                        "Anchoring with pointnet-geometry-v1's Mass doubles thrust "
                        "MAE. The concept works with the true Mass (-61%), but the "
                        "Mass model's error (median ~10%, +22.8% on design 17297) "
                        "exceeds the hover error being corrected. Do not ship this "
                        "post-processing; put the constraint in the training loss "
                        "or improve the Mass model first."
                    ),
                },
            }
        },
        "known_issues": [
            {
                "id": "drag_is_mostly_speed",
                "severity": "reporting",
                "detail": (
                    "drag test R2 is 0.9516, but predicting the per-speed mean "
                    "already scores 0.9260. The shape contributes only +0.026. "
                    "Do not present 0.95 as a shape-prediction result."
                ),
            },
            {
                "id": "validity_head_too_weak_for_ui",
                "severity": "blocker",
                "detail": (
                    "Exact interval match is 4.3% and 41% of designs get an "
                    "upper bound above the true one. Threshold tuning cannot fix "
                    "this: the best F1 any threshold can reach is 0.6771 against "
                    "0.6746 today. Retraining is required."
                ),
            },
            {
                "id": "upper_decile_shrinkage",
                "severity": "blocker_for_ranking",
                "detail": (
                    "Top-decile predictions fall short by 76% of the IQR for "
                    "flightTime, 65% for current and 49% for power. Predicted "
                    "maxima reach only 69-83% of the true maxima. Do not rank or "
                    "search designs with these outputs, the same limit that "
                    "applies to Max_Distance in POINTNET_MODEL.md section 6."
                ),
            },
            {
                "id": "degenerate_hover_rows_in_the_dataset",
                "severity": "data_quality",
                "detail": (
                    "Some 0 m/s trim rows pass the row-level validity rule but are "
                    "not physical: drag is null, maxUc sits at exactly 0.5, the "
                    "motor power ratio is near zero and thrust falls far below "
                    "weight. Design 20015 reports 19.27 N for a 72.24 N aircraft "
                    "and design 3803 reports 64.92 N for 91.95 N. Rare in test "
                    "(1 of 689 hover rows) but they are in the training data, and "
                    "they make the model look like it violates physics when it "
                    "does not. Judge hover behaviour only against clean rows."
                ),
            },
            {
                "id": "hover_thrust_anchoring_does_not_work",
                "severity": "closed_negative_result",
                "detail": (
                    "Scaling the thrust curve so thrust at 0 m/s equals the "
                    "predicted Mass times 9.8 raises thrust MAE from 3.22 N to "
                    "6.52 N. With the true Mass it would fall to 1.25 N, so the "
                    "idea is sound but the Mass estimate is too noisy to carry it. "
                    "Recorded so it is not retried: ml/check_hover_anchor.py."
                ),
            },
            {
                "id": "training_code_not_in_repo",
                "severity": "process",
                "detail": (
                    "prepare_trims.py, dataset_trim.py, model_trim.py, "
                    "train_trim.py, evaluate_trim.py and export_onnx_trim.py are "
                    "not in ml/. Only the run artefacts were handed over, so the "
                    "result cannot be reproduced or improved from this repo."
                ),
            },
        ],
        "scoring_rule": (
            "R2 in the raw target unit over valid trim rows only, referenced to "
            "the mean of the scored rows. Rows that are all zero are failed "
            "analyses, not physical zeros, and are excluded by actual_mask."
        ),
        "note": (
            "Scored from ml/runs/trim_pointnet_v1_evaluation/test_predictions.npz, "
            "which the training run produced with test_used=false. The ONNX pair "
            "was checked against these PyTorch predictions to a maximum relative "
            "difference of 9.2e-04, the residual coming from where the point "
            "cloud is normalised."
        ),
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print(f"wrote {args.out.relative_to(REPO_ROOT)}")
    print(f"  test designs {actual.shape[0]:,}  valid rows {int(actual_valid.sum()):,}")
    print()
    print(f"  {'target':>12} {'test R2':>9} {'speed>0':>9} {'baseline':>9} {'shape':>8}")
    for name in names:
        block = targets[name]
        print(
            f"  {name:>12} {block['test']['r2']:9.4f} "
            f"{block['test_speed_gt0']['r2']:9.4f} "
            f"{block['baselines']['per_speed_mean']:9.4f} "
            f"{block['baselines']['shape_contribution']:+8.3f}"
        )
    print()
    print(
        f"  validity @ {threshold:.2f}: F1 {validity['f1']:.4f}  "
        f"(best any threshold {validity['best_possible_f1_any_threshold']:.4f})"
    )
    print(
        f"  interval exact match {validity['interval']['exact_interval_match_pct']:.1f}%  "
        f"upper bound too high {validity['interval']['upper_bound_overpredicted_pct']:.0f}%"
    )
    print()
    print(f"  {len(report['known_issues'])} known issues recorded")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
