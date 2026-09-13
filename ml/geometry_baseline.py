"""The floors a point cloud model has to clear.

docs/HANDOFF.md specifies "predict the target mean" as the stage 4 baseline,
which is too low to be informative. But the obvious replacement is easy to get
wrong, and this script reports two different floors because they answer two
different questions.

  mesh        bounding box, span, scale, surface area. Everything here is
              measurable from the mesh by gross inspection, so this is the
              apples-to-apples floor for a model whose only input is that mesh.

  mesh+cad    the above plus fuselage length, fuselage diameters and arm
              lengths, taken from design_low_level.json. These are the CAD
              parameters that *generated* the geometry. Handing them to a
              regression asks "given the design variables, how well can you
              predict the KPI" — a different and much easier question than
              "can you predict the KPI from shape".

The gap between the two is large (Mass 0.45 vs 0.92 on val), and almost all of
the headline number comes from the CAD variables. A point cloud model has to
infer those variables from geometry before it can use them, so mesh+cad is a
target to aim at, not the bar for whether the model works. Compare against
`mesh`.

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

    mesh_features = np.column_stack(
        [data["extents"], data["span"], data["scale"], data["area"]]
    ).astype(np.float64)
    mesh_names = ["extent_x", "extent_y", "extent_z", "span", "scale", "area"]
    cad_features = data["geometry"].astype(np.float64)

    feature_sets = {
        "mesh": (mesh_features, mesh_names),
        "mesh+cad": (
            np.column_stack([mesh_features, cad_features]),
            mesh_names + [str(name) for name in geometry_names],
        ),
    }
    design_matrices = {
        key: np.column_stack([block, np.ones(len(block))])
        for key, (block, _) in feature_sets.items()
    }

    report = {
        "feature_sets": {
            key: {"features": names, "n": len(names)}
            for key, (_, names) in feature_sets.items()
        },
        "note": "ordinary least squares fitted on train, scored on val and test. "
                "`mesh` is the apples-to-apples floor for a point cloud model; "
                "`mesh+cad` adds the CAD parameters that generated the geometry.",
        "targets": {},
    }

    for scored_split in ("val", "test"):
        print(f"baselines on the frozen {scored_split} split "
              f"— every R2 scored in the raw target unit")
        print(f"  {'target':<14}{'n':>8}{'mean':>9}{'mesh':>9}{'mesh+cad':>11}"
              f"{'mesh MAE':>12}{'mesh+cad MAE':>14}")

        for name in TARGETS:
            values = data["targets"][:, target_names.index(name)].astype(np.float64)
            usable = np.isfinite(values) & (values > 0)
            train = usable & (split == "train")
            held_out = usable & (split == scored_split)
            if not train.any() or not held_out.any():
                continue

            train_mean = float(values[train].mean())
            actual = values[held_out]

            entry = report["targets"].setdefault(
                name, {"n_train": int(train.sum()), "train_mean": round(train_mean, 4)}
            )
            scored: dict = {
                "n": int(held_out.sum()),
                "mean_baseline": metrics(
                    actual, np.full(actual.shape, train_mean), train_mean
                ),
            }

            for key, matrix in design_matrices.items():
                weights, *_ = np.linalg.lstsq(matrix[train], values[train], rcond=None)
                scored[key] = metrics(actual, matrix[held_out] @ weights, train_mean)

            # log fit on the full set only — it is a losing option either way
            log_values = np.log(values)
            matrix = design_matrices["mesh+cad"]
            log_weights, *_ = np.linalg.lstsq(matrix[train], log_values[train], rcond=None)
            scored["mesh+cad_log_fit"] = metrics(
                actual, np.exp(matrix[held_out] @ log_weights), train_mean
            )
            scored["mesh+cad_log_space_NOT_COMPARABLE"] = {
                **metrics(
                    log_values[held_out],
                    matrix[held_out] @ log_weights,
                    float(log_values[train].mean()),
                ),
                "warning": "scored in log space against a log-space mean, so its "
                           "denominator differs from every other r2 here. Never "
                           "compare it with the raw-space numbers.",
            }

            entry[scored_split] = scored
            print(f"  {name:<14}{scored['n']:>8}{scored['mean_baseline']['r2']:>9.3f}"
                  f"{scored['mesh']['r2']:>9.3f}{scored['mesh+cad']['r2']:>11.3f}"
                  f"{scored['mesh']['mae']:>12.2f}{scored['mesh+cad']['mae']:>14.2f}")
        print()

    write_json(args.report, report)
    print("Compare a point cloud model against the `mesh` column: that is the same")
    print("information the model gets. `mesh+cad` is fed the CAD parameters that")
    print("generated the geometry, which the model has to infer first.")
    print("A log fit loses in the raw unit, so use a robust loss, not a transform.")
    print(f"report -> {args.report}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
