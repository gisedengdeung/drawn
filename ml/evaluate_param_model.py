"""Score the parameter model on test, with the diagnostics the repo expects.

Follows the shape of ml/reports/stage4_evaluation.json and
ml/reports/stage7_trim_evaluation.json: per-target R2 and MAE, baselines that
say how much the model actually adds, decile bias for shrinkage, prediction
intervals, and a comparison against the point cloud models on the identical
test split.

Two checks matter more than the headline R2:

  - Shrinkage. Both point cloud models under-predicted the top decile badly
    enough that ranking designs by their output was unsafe. A higher R2 does
    not by itself clear that.
  - Baselines. A target the training mean already explains is not evidence the
    features did any work.

    python ml/evaluate_param_model.py

Reads the boosters written by ml/train_param_model.py. Writes
ml/reports/param_model_evaluation.json. ASCII only.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from param_features import (  # noqa: E402
    FEATURE_NAMES,
    TARGETS,
    TARGET_KEYS,
    load_dataset,
    r2,
    trainable_mask,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
PER_TARGET_DIR = REPO_ROOT / "ml" / "runs" / "param_model_per_target"
SINGLE_PATH = REPO_ROOT / "backend" / "models" / "performance_model.json"
CONTRACT = REPO_ROOT / "ml" / "reports" / "param_model_contract.json"
DEFAULT_OUT = REPO_ROOT / "ml" / "reports" / "param_model_evaluation.json"

# Same test split, so these are directly comparable.
POINT_CLOUD_TEST_R2 = {"mass": 0.8792, "maxDistance": 0.6233}

MISSING = """\
No trained model found. Run the trainer first:

    python ml/train_param_model.py
"""


def decile_bias(actual: np.ndarray, predicted: np.ndarray) -> dict:
    """Bias per decile of the true value, as a percentage of the true IQR.

    A ratio would explode wherever the true value approaches zero, which is why
    the point cloud reports use this form too.
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
        "deciles_pct_of_iqr": out,
        "actual_max": round(float(actual.max()), 4),
        "predicted_max": round(float(predicted.max()), 4),
        "predicted_max_over_actual_max": round(float(predicted.max() / actual.max()), 4)
        if actual.max() != 0
        else None,
    }


def intervals(residual_ratio: np.ndarray, actual: np.ndarray, predicted: np.ndarray) -> dict:
    """Multiplicative bands from validation residuals, coverage checked on test.

    Absolute error scales with target size here, same as the point cloud
    models, so a multiplicative band is the honest form.
    """
    bands = {}
    for level in (0.5, 0.8, 0.9):
        lower = float(np.quantile(residual_ratio, (1 - level) / 2))
        upper = float(np.quantile(residual_ratio, 1 - (1 - level) / 2))
        covered = (actual >= predicted * lower) & (actual <= predicted * upper)
        bands[str(level)] = {
            "low_multiplier": round(lower, 4),
            "high_multiplier": round(upper, 4),
            "nominal": level,
            "empirical_on_test": round(float(covered.mean()), 4),
        }
    return bands


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args(argv)

    try:
        import xgboost as xgb
    except ImportError:
        print("xgboost is not installed:  pip install xgboost==2.1.1")
        return 2
    if not PER_TARGET_DIR.is_dir() or not SINGLE_PATH.is_file():
        print(MISSING)
        return 2

    features, targets, splits, design_ids = load_dataset()
    masks = {key: trainable_mask(key, targets[key]) for key in TARGET_KEYS}
    is_train, is_val, is_test = splits == "train", splits == "val", splits == "test"

    single = xgb.Booster()
    single.load_model(str(SINGLE_PATH))

    report_targets = {}
    for position, (key, field, unit) in enumerate(TARGETS):
        test_rows = masks[key] & is_test
        val_rows = masks[key] & is_val
        train_rows = masks[key] & is_train

        booster = xgb.Booster()
        booster.load_model(str(PER_TARGET_DIR / f"{key}.json"))

        dtest = xgb.DMatrix(features[test_rows], feature_names=list(FEATURE_NAMES))
        dval = xgb.DMatrix(features[val_rows], feature_names=list(FEATURE_NAMES))

        actual = targets[key][test_rows]
        predicted = booster.predict(dtest)
        val_actual = targets[key][val_rows]
        val_predicted = booster.predict(dval)

        error = actual - predicted
        train_mean = float(targets[key][train_rows].mean())

        safe = np.abs(val_predicted) > 1e-9
        ratio = val_actual[safe] / val_predicted[safe]

        entry = {
            "response_field": field,
            "unit": unit,
            "rows": {
                "train": int(train_rows.sum()),
                "val": int(val_rows.sum()),
                "test": int(test_rows.sum()),
            },
            "test": {
                "r2": round(r2(actual, predicted), 6),
                "mae": round(float(np.abs(error).mean()), 4),
                "rmse": round(float(np.sqrt((error**2).mean())), 4),
                "median_abs_error": round(float(np.median(np.abs(error))), 4),
                "median_relative_error": round(
                    float(np.median(np.abs(error) / np.maximum(np.abs(actual), 1e-9))), 4
                ),
            },
            "val_r2": round(r2(val_actual, val_predicted), 6),
            "baselines": {
                "train_mean_r2": round(r2(actual, np.full_like(actual, train_mean)), 6),
                "shape_a_multi_output_r2": round(
                    r2(actual, single.predict(dtest)[:, position]), 6
                ),
            },
            "calibration_test": decile_bias(actual, predicted),
            "prediction_interval": intervals(ratio, actual, predicted),
        }

        reference = POINT_CLOUD_TEST_R2.get(key)
        if reference is not None:
            entry["point_cloud_model"] = {
                "test_r2": reference,
                "delta": round(entry["test"]["r2"] - reference, 6),
                "note": "same test split, so directly comparable",
            }
        report_targets[key] = entry

    worst = {}
    for key, entry in report_targets.items():
        deciles = [d for d in entry["calibration_test"]["deciles_pct_of_iqr"] if d is not None]
        worst[key] = {
            "top_decile_bias_pct_of_iqr": deciles[-1] if deciles else None,
            "predicted_max_over_actual_max": entry["calibration_test"][
                "predicted_max_over_actual_max"
            ],
        }

    contract = json.loads(CONTRACT.read_text(encoding="utf-8")) if CONTRACT.is_file() else {}

    report = {
        "model": "param-performance-v1",
        "shape": "B_per_target",
        "evaluated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "note": (
            "Test split read once, after the shape choice and hyperparameters "
            "were fixed on validation."
        ),
        "scoring_rule": (
            "R2 in the raw unit over each target's valid test rows, referenced to "
            "the mean of those rows. A KPI of 0 is a failed analysis and is excluded."
        ),
        "split_rule": contract.get("split_rule"),
        "feature_names_alphabetical": list(FEATURE_NAMES),
        "targets": report_targets,
        "shrinkage_watch": {
            "why": (
                "Both point cloud models under-predicted the top decile enough "
                "that ranking designs by their output was unsafe. Check this "
                "before any Optimizer or search feature uses these numbers."
            ),
            "per_target": worst,
        },
        "known_issues": [],
        "data_sources": contract.get("data_sources"),
    }

    for key, entry in report_targets.items():
        if entry["test"]["r2"] < 0.5:
            report["known_issues"].append(
                {
                    "id": f"{key}_weak",
                    "severity": "reporting",
                    "detail": (
                        f"{key} reaches only R2 {entry['test']['r2']:.3f} on test. "
                        "Report it as a rough indication or leave it out of the UI."
                    ),
                }
            )
        top = worst[key]["top_decile_bias_pct_of_iqr"]
        if top is not None and top < -25:
            report["known_issues"].append(
                {
                    "id": f"{key}_top_decile_shrinkage",
                    "severity": "blocker_for_ranking",
                    "detail": (
                        f"{key} under-predicts its top decile by {abs(top):.0f}% of the "
                        "IQR, so it must not be used to rank or search designs."
                    ),
                }
            )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print(f"wrote {args.out.relative_to(REPO_ROOT)}")
    print()
    print(f"  {'target':>12} {'test rows':>10} {'test R2':>9} {'mean base':>10} "
          f"{'point cloud':>12} {'top decile':>11}")
    print("  " + "-" * 70)
    for key, entry in report_targets.items():
        reference = entry.get("point_cloud_model")
        top = worst[key]["top_decile_bias_pct_of_iqr"]
        against_point_cloud = f"{reference['delta']:+.3f}" if reference else "-"
        top_decile = f"{top:+.0f}%" if top is not None else "-"
        print(
            f"  {key:>12} {entry['rows']['test']:>10,} {entry['test']['r2']:>9.4f} "
            f"{entry['baselines']['train_mean_r2']:>10.3f} "
            f"{against_point_cloud:>12} {top_decile:>11}"
        )
    print()
    print(f"  {len(report['known_issues'])} known issues recorded")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
