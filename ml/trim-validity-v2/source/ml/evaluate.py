"""Stage 4 — final scoring on the held-out test split.

This is the first and only time the test split is read. Everything up to here
selected on val, so the val numbers are mildly optimistic; the val-to-test gap
printed below is the size of that optimism.

Produces the three things docs/MODEL_CARD.md asks to record:

  1. test R2 and MAE, against the mean, `mesh` and `mesh+cad` baselines
  2. prediction intervals, calibrated on val residuals and then checked for
     actual coverage on test — an interval nobody verified is decoration
  3. a model version block: checkpoint hash, data hash, split rule and
     hyperparameters, so a number can be traced back to what produced it

It also breaks error down by rotor count, wing presence and airframe size, to
say where the model is weak rather than only how weak it is overall.

Usage:
    ml\\.venv\\Scripts\\python.exe ml\\evaluate.py --checkpoint ml\\runs\\rung3_mass_distance.pt
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch

from common import REPO_ROOT, write_json
from dataset import DEFAULT_DATA, load_bundle
from model import PointNetRegressor

BASELINE_REPORT = REPO_ROOT / "ml" / "reports" / "geometry_baseline.json"

# Nominal coverage levels for the prediction intervals.
INTERVALS = (0.50, 0.80, 0.90)


def file_digest(path: Path, limit: int = 64 * 1024 * 1024) -> dict:
    """sha256 of a file. Large files are hashed over a capped prefix."""
    size = path.stat().st_size
    digest = hashlib.sha256()
    read = 0
    with open(path, "rb") as handle:
        while read < min(size, limit):
            block = handle.read(min(1024 * 1024, limit - read))
            if not block:
                break
            digest.update(block)
            read += len(block)
    return {
        "sha256": digest.hexdigest()[:32],
        "bytes": size,
        "hashed_prefix_bytes": read,
        "partial": read < size,
    }


def predict(model, bundle, split: str, batch_size: int = 256):
    model.eval()
    chunks, order = [], []
    with torch.no_grad():
        for index in bundle.sequential(split, batch_size):
            chunks.append(
                model(bundle.points[index], bundle.scale_feature[index]).float().cpu().numpy()
            )
            order.append(index.cpu().numpy())
    rows = np.concatenate(order)
    predicted = np.concatenate(chunks) * bundle.std + bundle.mean
    return rows, predicted


def score(actual: np.ndarray, predicted: np.ndarray, train_mean: float) -> dict:
    residual = ((actual - predicted) ** 2).sum()
    total = ((actual - train_mean) ** 2).sum()
    return {
        "n": int(actual.size),
        "r2": round(float(1 - residual / total), 4),
        "mae": round(float(np.abs(actual - predicted).mean()), 4),
        "rmse": round(float(np.sqrt(((actual - predicted) ** 2).mean())), 4),
        "median_abs_error": round(float(np.median(np.abs(actual - predicted))), 4),
    }


def calibrate_intervals(val_actual, val_predicted) -> dict:
    """Quantiles of the val *relative* residual, per nominal coverage.

    Absolute residuals scale with the target here (a 20 km flight is not wrong
    by the same metres as a 500 m one), so the interval is multiplicative.
    """
    ratio = val_predicted / np.clip(val_actual, 1e-9, None)
    bands = {}
    for level in INTERVALS:
        lower = float(np.quantile(ratio, (1 - level) / 2))
        upper = float(np.quantile(ratio, 1 - (1 - level) / 2))
        bands[f"{level:.2f}"] = {
            # actual = predicted / ratio, so the interval inverts
            "low_multiplier": round(1 / upper, 4),
            "high_multiplier": round(1 / lower, 4),
        }
    return bands


def check_coverage(bands: dict, actual, predicted) -> dict:
    out = {}
    for level, band in bands.items():
        low = predicted * band["low_multiplier"]
        high = predicted * band["high_multiplier"]
        inside = (actual >= low) & (actual <= high)
        width = np.median(high - low)
        out[level] = {
            "nominal": float(level),
            "empirical": round(float(inside.mean()), 4),
            "median_width": round(float(width), 4),
        }
    return out


def calibration_by_decile(actual, predicted) -> dict:
    """Predicted vs actual across the target's own range.

    A single R2 hides shrinkage. A model that explains part of the variance
    pulls its predictions toward the training mean, which shows up as
    over-prediction at the bottom of the range and under-prediction at the top.
    That matters here because the interesting designs are the extremes.
    """
    usable = np.isfinite(actual)
    actual, predicted = actual[usable], predicted[usable]
    edges = np.quantile(actual, np.linspace(0, 1, 11))

    deciles = []
    for i in range(10):
        selector = (
            (actual >= edges[i]) & (actual < edges[i + 1])
            if i < 9
            else (actual >= edges[i]) & (actual <= edges[i + 1])
        )
        if selector.sum() < 5:
            continue
        actual_median = float(np.median(actual[selector]))
        predicted_median = float(np.median(predicted[selector]))
        deciles.append({
            "decile": i + 1,
            "actual_range": [round(float(edges[i]), 2), round(float(edges[i + 1]), 2)],
            "n": int(selector.sum()),
            "actual_median": round(actual_median, 2),
            "predicted_median": round(predicted_median, 2),
            "ratio": round(predicted_median / actual_median, 3) if actual_median else None,
        })
    return {
        "deciles": deciles,
        "actual_max": round(float(actual.max()), 2),
        "predicted_max": round(float(predicted.max()), 2),
        "predicted_max_over_actual_max": round(float(predicted.max() / actual.max()), 3),
        "bottom_decile_ratio": deciles[0]["ratio"] if deciles else None,
        "top_decile_ratio": deciles[-1]["ratio"] if deciles else None,
    }


def breakdown(bundle, rows, actual, predicted, column: int, data) -> dict:
    """Where the error concentrates, not just how big it is."""
    design_ids = bundle.design_id[rows]
    lookup = {int(d): i for i, d in enumerate(data["design_id"])}
    source = np.array([lookup[int(d)] for d in design_ids])

    rotors = data["n_propeller"][source]
    wing = data["has_wing"][source]
    scale = data["scale"][source]

    usable = np.isfinite(actual)
    actual, predicted = actual[usable], predicted[usable]
    rotors, wing, scale = rotors[usable], wing[usable], scale[usable]
    error = np.abs(actual - predicted)
    relative = error / np.clip(np.abs(actual), 1e-9, None)

    def group(values, labels):
        out = {}
        for label, selector in labels:
            if selector.sum() >= 20:
                out[label] = {
                    "n": int(selector.sum()),
                    "mae": round(float(error[selector].mean()), 4),
                    "median_relative_error": round(float(np.median(relative[selector])), 4),
                }
        return out

    rotor_bins = [
        ("1-3", (rotors >= 1) & (rotors <= 3)),
        ("4", rotors == 4),
        ("5-6", (rotors >= 5) & (rotors <= 6)),
        ("7-8", (rotors >= 7) & (rotors <= 8)),
        ("9+", rotors >= 9),
    ]
    edges = np.quantile(scale, [0, 0.25, 0.5, 0.75, 1.0])
    size_bins = [
        (f"{edges[i]:.0f}-{edges[i + 1]:.0f}mm",
         (scale >= edges[i]) & (scale <= edges[i + 1] if i == 3 else scale < edges[i + 1]))
        for i in range(4)
    ]
    return {
        "by_rotor_count": group(rotors, rotor_bins),
        "by_wing": group(wing, [("no wing", wing == 0), ("wing", wing == 1)]),
        "by_airframe_size": group(scale, size_bins),
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Stage 4 test evaluation")
    parser.add_argument(
        "--checkpoint", type=Path, default=REPO_ROOT / "ml" / "runs" / "rung3_mass_distance.pt"
    )
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument(
        "--report", type=Path, default=REPO_ROOT / "ml" / "reports" / "stage4_evaluation.json"
    )
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = parser.parse_args(argv)

    if not args.checkpoint.is_file():
        raise SystemExit(f"checkpoint not found: {args.checkpoint}")

    checkpoint = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    target_names = list(checkpoint["target_names"])
    bundle = load_bundle(target_names, path=args.data, device=args.device)

    model = PointNetRegressor(
        n_targets=len(target_names),
        use_scale=checkpoint.get("use_scale", True),
        dropout=checkpoint.get("dropout", 0.3),
        pool=checkpoint.get("pool", "max"),
    ).to(args.device)
    model.load_state_dict(checkpoint["state_dict"])

    baselines = json.loads(BASELINE_REPORT.read_text(encoding="utf-8"))["targets"]
    data = np.load(args.data, allow_pickle=False)

    val_rows, val_predicted = predict(model, bundle, "val")
    test_rows, test_predicted = predict(model, bundle, "test")
    val_actual = bundle.raw_targets[val_rows]
    test_actual = bundle.raw_targets[test_rows]

    print(f"checkpoint : {args.checkpoint.name}  (best epoch {checkpoint.get('epoch')})")
    print(f"targets    : {target_names}")
    print(f"pool       : {checkpoint.get('pool', 'max')}   scale input: "
          f"{checkpoint.get('use_scale', True)}")
    print()

    results = {}
    for column, name in enumerate(target_names):
        train_mean = float(bundle.mean[column])

        val_usable = np.isfinite(val_actual[:, column])
        test_usable = np.isfinite(test_actual[:, column])
        va, vp = val_actual[val_usable, column], val_predicted[val_usable, column]
        ta, tp = test_actual[test_usable, column], test_predicted[test_usable, column]

        val_score = score(va, vp, train_mean)
        test_score = score(ta, tp, train_mean)

        bands = calibrate_intervals(va, vp)
        coverage = check_coverage(bands, ta, tp)

        floors = baselines.get(name, {}).get("test", {})
        results[name] = {
            "val": val_score,
            "test": test_score,
            "val_to_test_r2_drop": round(val_score["r2"] - test_score["r2"], 4),
            "test_baselines": {
                "mean": floors.get("mean_baseline", {}).get("r2"),
                "mesh": floors.get("mesh", {}).get("r2"),
                "mesh+cad": floors.get("mesh+cad", {}).get("r2"),
            },
            "prediction_interval": {
                "method": "multiplicative bands from val residual quantiles, "
                          "coverage verified on test",
                "bands": bands,
                "coverage": coverage,
            },
            "error_breakdown_test": breakdown(
                bundle, test_rows, test_actual[:, column], test_predicted[:, column], column, data
            ),
            "calibration_test": calibration_by_decile(
                test_actual[:, column], test_predicted[:, column]
            ),
        }

        mesh = results[name]["test_baselines"]["mesh"]
        cad = results[name]["test_baselines"]["mesh+cad"]
        print(f"{name}")
        print(f"  test   R2 {test_score['r2']:.4f}   MAE {test_score['mae']:.4f}   "
              f"RMSE {test_score['rmse']:.4f}   n {test_score['n']}")
        print(f"  val    R2 {val_score['r2']:.4f}   (drop {val_score['r2'] - test_score['r2']:+.4f})")
        print(f"  floors mean {floors.get('mean_baseline', {}).get('r2', 0):.3f}   "
              f"mesh {mesh:.3f}   mesh+cad {cad:.3f}   "
              f"-> vs mesh {test_score['r2'] - mesh:+.4f}")
        print("  prediction interval")
        for level, entry in coverage.items():
            band = bands[level]
            print(f"    {float(level):.0%} nominal -> {entry['empirical']:.1%} actual   "
                  f"[x{band['low_multiplier']:.3f}, x{band['high_multiplier']:.3f}]   "
                  f"median width {entry['median_width']:.1f}")
        print()

    version = {
        "evaluated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "checkpoint": {"path": str(args.checkpoint), **file_digest(args.checkpoint)},
        "dataset": {"path": str(args.data), **file_digest(args.data)},
        "targets": target_names,
        "architecture": {
            "encoder_widths": [64, 64, 128, 1024],
            "pool": checkpoint.get("pool", "max"),
            "head_widths": [512, 256],
            "scale_input": checkpoint.get("use_scale", True),
            "dropout": checkpoint.get("dropout", 0.3),
            "t_net": False,
        },
        "best_epoch": checkpoint.get("epoch"),
        "target_standardisation": {
            name: {"mean": round(float(bundle.mean[i]), 6), "std": round(float(bundle.std[i]), 6)}
            for i, name in enumerate(target_names)
        },
        "scale_standardisation": {
            "applied_to": "log(scale in mm)",
            "mean": round(float(bundle.scale_log_mean), 10),
            "std": round(float(bundle.scale_log_std), 10),
        },
        "split_rule": "sha256('aircraftverse-pointcloud-v1:' + design family) -> 80/10/10; "
                      "family is the design_<n>_<uuid> prefix of design_low_level name",
        "scoring_rule": "R2 in the raw target unit, referenced to the train mean",
        "split_sizes": {
            name: int(len(bundle.indices[name])) for name in ("train", "val", "test")
        },
    }

    report = {
        "model_version": version,
        "targets": results,
        "note": "test split read here for the first time; all model selection used val",
    }
    write_json(args.report, report)

    print("=" * 74)
    print("error breakdown (test, median relative error)")
    for name, entry in results.items():
        print(f"  {name}")
        for group, rows in entry["error_breakdown_test"].items():
            cells = "  ".join(
                f"{label} {stats['median_relative_error']:.1%}" for label, stats in rows.items()
            )
            print(f"    {group:<20} {cells}")
    print()
    print("calibration (test) — predicted median / actual median, by actual decile")
    for name, entry in results.items():
        cal = entry["calibration_test"]
        ratios = "  ".join(f"{d['ratio']:.2f}" for d in cal["deciles"])
        print(f"  {name}")
        print(f"    low -> high   {ratios}")
        print(f"    ceiling       predicts at most {cal['predicted_max']:.0f}, "
              f"actual reaches {cal['actual_max']:.0f} "
              f"({cal['predicted_max_over_actual_max']:.0%})")
    print("=" * 74)
    print(f"report -> {args.report}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
