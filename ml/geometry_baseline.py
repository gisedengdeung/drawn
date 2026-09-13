"""The floor a point cloud model has to clear.

docs/HANDOFF.md specifies "predict the target mean" as the stage 4 baseline.
That floor is too low to be informative: a linear model on eleven cheap scalars
already reaches R^2 0.92 on Mass. Those scalars are all derivable from the mesh
that feeds the network — bounding box, surface area, fuselage and arm
dimensions — so a PointNet that does not beat this number has learned nothing
that simple geometry did not already give away.

Both floors are reported per target, on the frozen test split:

  mean      predict the training mean (HANDOFF's baseline)
  geometry  ordinary least squares on the eleven scalars

Usage:
    ml\\.venv\\Scripts\\python.exe ml\\geometry_baseline.py
"""

from __future__ import annotations

import argparse
import sys

import numpy as np

from common import REPO_ROOT, write_json

TARGETS = ("Mass", "Max_Distance", "Hover_Time", "Max_Speed", "Power_MFD")


def metrics(actual: np.ndarray, predicted: np.ndarray, train_mean: float) -> dict:
    residual = ((actual - predicted) ** 2).sum()
    total = ((actual - train_mean) ** 2).sum()
    return {
        "r2": round(float(1 - residual / total), 4),
        "mae": round(float(np.abs(actual - predicted).mean()), 4),
        "rmse": round(float(np.sqrt(((actual - predicted) ** 2).mean())), 4),
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Mean and geometry baselines")
    parser.add_argument(
        "--data", default=REPO_ROOT / "ml" / "data" / "pointclouds.npz"
    )
    parser.add_argument(
        "--report", default=REPO_ROOT / "ml" / "reports" / "geometry_baseline.json"
    )
    args = parser.parse_args(argv)

    data = np.load(args.data, allow_pickle=False)
    split = data["split"]
    target_names = list(data["target_names"])
    geometry_names = list(data["geometry_names"])

    features = np.column_stack(
        [data["extents"], data["span"], data["scale"], data["area"], data["geometry"]]
    ).astype(np.float64)
    feature_names = ["extent_x", "extent_y", "extent_z", "span", "scale", "area"] + [
        str(name) for name in geometry_names
    ]
    design_matrix = np.column_stack([features, np.ones(len(features))])

    report = {
        "features": feature_names,
        "n_features": len(feature_names),
        "note": "ordinary least squares fitted on train, scored on test",
        "targets": {},
    }

    print("baselines on the frozen test split")
    print(f"  {'target':<14}{'n_test':>8}{'mean R2':>10}{'geom R2':>10}"
          f"{'geom R2(log)':>14}{'mean MAE':>12}{'geom MAE':>12}")

    for name in TARGETS:
        values = data["targets"][:, target_names.index(name)].astype(np.float64)
        usable = np.isfinite(values) & (values > 0)
        train = usable & (split == "train")
        test = usable & (split == "test")
        if not train.any() or not test.any():
            continue

        train_mean = float(values[train].mean())
        actual = values[test]

        mean_only = metrics(actual, np.full(actual.shape, train_mean), train_mean)

        weights, *_ = np.linalg.lstsq(design_matrix[train], values[train], rcond=None)
        linear = metrics(actual, design_matrix[test] @ weights, train_mean)

        log_values = np.log(values)
        log_weights, *_ = np.linalg.lstsq(design_matrix[train], log_values[train], rcond=None)
        log_predicted = np.exp(design_matrix[test] @ log_weights)
        log_linear = metrics(actual, log_predicted, train_mean)
        log_space = metrics(
            log_values[test], design_matrix[test] @ log_weights, float(log_values[train].mean())
        )

        report["targets"][name] = {
            "n_train": int(train.sum()),
            "n_test": int(test.sum()),
            "train_mean": round(train_mean, 4),
            "mean_baseline": mean_only,
            "geometry_baseline": linear,
            "geometry_baseline_log_fit": log_linear,
            "geometry_baseline_log_space": log_space,
        }

        print(f"  {name:<14}{int(test.sum()):>8}{mean_only['r2']:>10.3f}{linear['r2']:>10.3f}"
              f"{log_space['r2']:>14.3f}{mean_only['mae']:>12.2f}{linear['mae']:>12.2f}")

    write_json(args.report, report)
    print()
    print("A point cloud model must beat the geometry column, not the mean column.")
    print(f"report -> {args.report}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
