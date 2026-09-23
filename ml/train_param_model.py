"""Train the parameter-based performance model and let the numbers pick a shape.

Two shapes are trained and compared on validation, because they trade off
differently and the answer is not obvious in advance:

  A. one multi-output booster - what backend/app/model.py expects today, a
     single .json returning a vector. The catch is that one model needs every
     target present on the same row, so it can only train on the intersection
     of the per-target validity masks. Mass is available on 27,703 designs and
     Max_Distance on 10,737, so the intersection is far smaller than either.

  B. one booster per target - each trains on its own valid rows, so each sees
     the most data it can. Costs five files and a backend change.

Both are saved. The report states which one won and by how much, so the choice
is a recorded decision rather than a guess.

    python ml/train_param_model.py

Writes backend/models/performance_model.json (shape A),
ml/runs/param_model_per_target/*.json (shape B) and
ml/reports/param_model_contract.json, which is the file to hand the backend
owner along with the model. ASCII only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from param_features import (  # noqa: E402
    FEATURE_NAMES,
    MASS_CEILING_KG,
    TARGETS,
    TARGET_KEYS,
    load_dataset,
    r2,
    trainable_mask,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
SINGLE_OUT = REPO_ROOT / "backend" / "models" / "performance_model.json"
MULTI_DIR = REPO_ROOT / "ml" / "runs" / "param_model_per_target"
CONTRACT_OUT = REPO_ROOT / "ml" / "reports" / "param_model_contract.json"

PARAMS = {
    "objective": "reg:squarederror",
    "max_depth": 6,
    "eta": 0.05,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "lambda": 1.0,
    "nthread": 8,
}
ROUNDS = 2000
EARLY_STOP = 60


def sha256_prefix(path: Path, length: int = 32) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:length]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rounds", type=int, default=ROUNDS)
    args = parser.parse_args(argv)

    try:
        import xgboost as xgb
    except ImportError:
        print("xgboost is not installed:  pip install xgboost==2.1.1")
        return 2

    started = time.time()
    features, targets, splits, design_ids = load_dataset()
    print(f"designs {features.shape[0]:,}  features {features.shape[1]}")
    print(f"split   train {(splits == 'train').sum():,}  "
          f"val {(splits == 'val').sum():,}  test {(splits == 'test').sum():,}")
    print()

    masks = {key: trainable_mask(key, targets[key]) for key in TARGET_KEYS}
    intersection = np.logical_and.reduce([masks[key] for key in TARGET_KEYS])
    print("trainable rows per target")
    for key in TARGET_KEYS:
        print(f"  {key:>12} {masks[key].sum():>7,}")
    print(f"  {'ALL SIX':>12} {intersection.sum():>7,}   <- shape A is limited to this")
    print()

    is_train = splits == "train"
    is_val = splits == "val"

    # ---- shape B: one booster per target -------------------------------
    MULTI_DIR.mkdir(parents=True, exist_ok=True)
    per_target: dict[str, dict] = {}
    boosters = {}
    for key in TARGET_KEYS:
        values = targets[key]
        train_rows = masks[key] & is_train
        val_rows = masks[key] & is_val
        dtrain = xgb.DMatrix(features[train_rows], label=values[train_rows], feature_names=list(FEATURE_NAMES))
        dval = xgb.DMatrix(features[val_rows], label=values[val_rows], feature_names=list(FEATURE_NAMES))
        booster = xgb.train(
            PARAMS, dtrain, num_boost_round=args.rounds,
            evals=[(dval, "val")], early_stopping_rounds=EARLY_STOP, verbose_eval=False,
        )
        best = booster.best_iteration + 1
        predicted = booster.predict(dval, iteration_range=(0, best))
        score = r2(values[val_rows], predicted)
        boosters[key] = booster
        per_target[key] = {
            "train_rows": int(train_rows.sum()),
            "val_rows": int(val_rows.sum()),
            "best_iteration": int(best),
            "val_r2": round(score, 6),
        }
        booster.save_model(str(MULTI_DIR / f"{key}.json"))

    # ---- shape A: one multi-output booster ------------------------------
    stacked = np.column_stack([targets[key] for key in TARGET_KEYS])
    train_rows = intersection & is_train
    val_rows = intersection & is_val
    dtrain = xgb.DMatrix(features[train_rows], label=stacked[train_rows], feature_names=list(FEATURE_NAMES))
    dval = xgb.DMatrix(features[val_rows], label=stacked[val_rows], feature_names=list(FEATURE_NAMES))
    single = xgb.train(
        PARAMS, dtrain, num_boost_round=args.rounds,
        evals=[(dval, "val")], early_stopping_rounds=EARLY_STOP, verbose_eval=False,
    )
    best_single = single.best_iteration + 1
    SINGLE_OUT.parent.mkdir(parents=True, exist_ok=True)
    single.save_model(str(SINGLE_OUT))

    # Score both on each target's OWN valid validation rows.
    #
    # Scoring only on the intersection looks fairer but is not: designs where
    # all six analyses succeeded are a tamer population, and shape A is trained
    # on exactly that, so it wins there by specialising. At inference both
    # shapes are asked about arbitrary edited designs, so the honest population
    # is every row where the target is defined. Judged that way the ranking
    # flips - on the intersection shape A led by 0.005 on average, on each
    # target's own rows shape B leads by 0.111.
    print(f"{'target':>12} {'val rows':>9} {'A multi':>9} {'B per-target':>13} {'B - A':>8}")
    print("-" * 56)
    comparison = {}
    intersection_val = single.predict(dval, iteration_range=(0, best_single))
    for position, key in enumerate(TARGET_KEYS):
        own_rows = masks[key] & is_val
        own = xgb.DMatrix(features[own_rows], feature_names=list(FEATURE_NAMES))
        actual = targets[key][own_rows]
        a_score = r2(actual, single.predict(own, iteration_range=(0, best_single))[:, position])
        b_score = r2(
            actual,
            boosters[key].predict(own, iteration_range=(0, per_target[key]["best_iteration"])),
        )
        comparison[key] = {
            "val_rows": int(own_rows.sum()),
            "shape_a_val_r2": round(a_score, 6),
            "shape_b_val_r2": round(b_score, 6),
            "delta": round(b_score - a_score, 6),
            "shape_a_val_r2_on_intersection": round(
                r2(stacked[val_rows][:, position], intersection_val[:, position]), 6
            ),
        }
        print(f"{key:>12} {own_rows.sum():>9,} {a_score:>9.4f} "
              f"{b_score:>13.4f} {b_score - a_score:>+8.4f}")

    mean_delta = float(np.mean([c["delta"] for c in comparison.values()]))
    winner = "B_per_target" if mean_delta > 0.01 else "A_multi_output"
    print("-" * 56)
    print(f"{'mean':>12} {'':>9} {'':>9} {'':>13} {mean_delta:>+8.4f}")
    print()
    print(f"  shape A trains on {int(train_rows.sum()):,} rows (all six targets present)")
    print(f"  shape B trains on up to {max(p['train_rows'] for p in per_target.values()):,} rows per target")
    print(f"  WINNER: {winner}")
    print()

    contract = {
        "model_name": "param-performance-v1",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "what_this_is": (
            "Gradient-boosted trees over design parameters, not geometry. It "
            "replaces the point cloud path for edited designs, which cannot be "
            "predicted from shape because the browser has no CAD mesh - see "
            "ml/reports/parametric_gap.json."
        ),
        "runtime": {"library": "xgboost", "version": "2.1.1", "format": "native json"},
        "shapes": {
            "A_multi_output": {
                "file": str(SINGLE_OUT.relative_to(REPO_ROOT)).replace("\\", "/"),
                "sha256": sha256_prefix(SINGLE_OUT),
                "output": "one vector per row, in target_order below",
                "train_rows": int(train_rows.sum()),
                "note": "what backend/app/model.py expects today",
            },
            "B_per_target": {
                "directory": str(MULTI_DIR.relative_to(REPO_ROOT)).replace("\\", "/"),
                "files": {key: f"{key}.json" for key in TARGET_KEYS},
                "sha256": {key: sha256_prefix(MULTI_DIR / f"{key}.json") for key in TARGET_KEYS},
                "train_rows": {key: per_target[key]["train_rows"] for key in TARGET_KEYS},
                "note": "needs backend/app/model.py to load and call five boosters",
            },
        },
        "recommended_shape": winner,
        "shape_comparison_val": comparison,
        "how_the_shapes_were_compared": (
            "On each target's own valid validation rows, which is the population "
            "the deployed model faces. Scoring only on rows where all six "
            "analyses succeeded flatters shape A, because that subset is tamer "
            "and shape A is trained on exactly it - by that measure shape A led "
            "slightly, and by the honest measure shape B leads clearly."
        ),
        "feature_names_alphabetical": list(FEATURE_NAMES),
        "feature_contract": (
            "backend/app/model.py builds its DMatrix from sorted(features.keys()), "
            "so the caller must send exactly these names. XGBoost validates the "
            "names and raises on a mismatch rather than scrambling columns."
        ),
        "feature_notes": {
            "units": "lengths in mm, motorKv in rpm/V, propeller sizes in inches, battMah in mAh",
            "missing_values": "NaN is allowed; xgboost handles it natively",
            "excluded_on_purpose": {
                "interferences": (
                    "computed by the CAD pipeline, so an edited design in the "
                    "browser cannot supply it. Training on it would produce a "
                    "model that cannot be deployed."
                ),
                "mass": (
                    "not an input. It is a target - the user does not know the "
                    "mass of a design they just edited."
                ),
            },
        },
        "target_order": [
            {"index": position, "key": key, "response_field": field, "unit": unit}
            for position, (key, field, unit) in enumerate(TARGETS)
        ],
        "backend_changes_required": [
            "mass_kg currently returns features.get('mass'); it must come from the "
            "model instead, at raw[5] in shape A. The user cannot supply the mass "
            "of a design they are still editing.",
            "If shape B is adopted, load the five boosters from the directory and "
            "call each one, instead of a single booster returning a vector.",
            "No frontend code calls /predict yet on origin/develop.",
        ],
        "validity_rule": (
            "A KPI of 0 is a failed analysis, not a physical zero, so zero rows "
            f"are excluded per target. Mass is additionally capped at {MASS_CEILING_KG} kg "
            "because 11 designs report a blown-up analysis."
        ),
        "split_rule": (
            "sha256('aircraftverse-pointcloud-v1:' + family) -> 80/10/10, by design "
            "family, identical to ml/prepare_targets.py so scores stay comparable "
            "with the point cloud models."
        ),
        "data_sources": [
            "public/data/design-index.json",
            "public/data/design-trees/shard-*.json (internal name, for the split)",
        ],
        "elapsed_seconds": round(time.time() - started, 1),
    }
    CONTRACT_OUT.parent.mkdir(parents=True, exist_ok=True)
    CONTRACT_OUT.write_text(json.dumps(contract, indent=2) + "\n", encoding="utf-8")

    print(f"wrote {SINGLE_OUT.relative_to(REPO_ROOT)}")
    print(f"wrote {MULTI_DIR.relative_to(REPO_ROOT)}/*.json  ({len(TARGET_KEYS)} files)")
    print(f"wrote {CONTRACT_OUT.relative_to(REPO_ROOT)}")
    print()
    print("Hand the contract to the backend owner with the model. It names the")
    print("features, their order, the target order and what model.py must change.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
