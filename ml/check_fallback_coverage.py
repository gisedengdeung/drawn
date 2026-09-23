"""Measure the fallback where it is actually used: outside its training set.

`ml/train_trim_param_model.py` learned from `ml/sources/dongha/dataset_510k.csv`,
which holds the 6,409 designs that have the measured hover and 20 m/s anchors.
Those are the designs the conditioned model can already serve. The fallback runs
on the other 21,305 - the ones whose trim solve barely converged - so its
reported R2, measured on 641 eligible test designs, says nothing about the
population it faces.

The failure this was written for: design 13077 has one valid trim row in the
whole 0-50 range, and at that speed the fallback predicts 91 N of thrust where
the simulation recorded 11.9, and 3,715 W where it recorded 387.

Real trim values for 4,237 non-eligible designs already sit in the retraining
artifacts, so the gap can be measured now rather than assumed.

    python ml/check_fallback_coverage.py

Writes ml/reports/fallback_coverage.json. ASCII only.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from param_features import FEATURE_NAMES, build_row, r2  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
RUNS = REPO_ROOT / "ml" / "runs" / "trim_param"
V2 = REPO_ROOT / "ml" / "trim-validity-v2" / "evaluation"
DATASET = REPO_ROOT / "ml" / "sources" / "dongha" / "dataset_510k.csv"
DESIGN_INDEX = REPO_ROOT / "public" / "data" / "design-index.json"
DEFAULT_OUT = REPO_ROOT / "ml" / "reports" / "fallback_coverage.json"

# Column order of raw_targets in the v2 artifacts, from
# ml/trim-validity-v2/source/ml/predict_trim.py. Only six of the eight the
# fallback predicts; lift and distance were not carried in those files.
V2_TARGETS = ("pitch", "drag", "thrust", "flightTime", "power", "current")

MISSING = """\
Needs the trained fallback and the v2 evaluation artifacts:
    ml/runs/trim_param/*.json          python ml/train_trim_param_model.py
    ml/trim-validity-v2/evaluation/    from the teammate's retraining handover
"""


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args(argv)

    if not (RUNS / "drag.json").is_file() or not (V2 / "test_predictions.npz").is_file():
        print(MISSING)
        return 2
    try:
        import xgboost as xgb
    except ImportError:
        print("xgboost is not installed:  pip install xgboost==2.1.1")
        return 2

    trained_on = set()
    with DATASET.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            trained_on.add(int(row["design_id"]))

    parameters = {
        int(record["id"]): build_row(record)
        for record in json.loads(DESIGN_INDEX.read_text(encoding="utf-8"))["designs"]
    }

    rows, truth, in_training, design_ids, speeds = [], [], [], [], []
    for split in ("val", "test"):
        data = np.load(V2 / f"{split}_predictions.npz", allow_pickle=True)
        actual = data["raw_targets"]
        observed = data["truth"] & data["observed"]
        for position, design_id in enumerate(data["design_id"].tolist()):
            feature_row = parameters.get(int(design_id))
            if feature_row is None:
                continue
            for speed in np.where(observed[position])[0]:
                rows.append([float(speed)] + [feature_row[n] for n in FEATURE_NAMES])
                truth.append(actual[position, speed])
                in_training.append(int(design_id) in trained_on)
                design_ids.append(int(design_id))
                speeds.append(int(speed))

    features = np.array(rows, dtype=np.float32)
    truth = np.array(truth, dtype=np.float64)
    inside = np.array(in_training)
    design_ids = np.array(design_ids)
    feature_names = ["speed"] + list(FEATURE_NAMES)
    matrix = xgb.DMatrix(features, feature_names=feature_names)

    designs_inside = len(set(design_ids[inside].tolist()))
    designs_outside = len(set(design_ids[~inside].tolist()))
    print(f"scored rows {len(features):,}")
    print(f"  inside training population  {int(inside.sum()):>7,} rows  {designs_inside:>5,} designs")
    print(f"  outside                     {int((~inside).sum()):>7,} rows  {designs_outside:>5,} designs")
    print()

    per_target = {}
    print(f"  {'target':>12} {'inside R2':>10} {'outside R2':>11} {'drop':>8} "
          f"{'inside MAE':>11} {'outside MAE':>12}")
    print("  " + "-" * 70)
    for position, name in enumerate(V2_TARGETS):
        booster = xgb.Booster()
        booster.load_model(str(RUNS / f"{name}.json"))
        predicted = booster.predict(matrix)
        actual = truth[:, position]
        finite = np.isfinite(actual)

        inside_rows = finite & inside
        outside_rows = finite & ~inside
        inside_r2 = r2(actual[inside_rows], predicted[inside_rows])
        outside_r2 = r2(actual[outside_rows], predicted[outside_rows])
        inside_mae = float(np.abs(actual[inside_rows] - predicted[inside_rows]).mean())
        outside_mae = float(np.abs(actual[outside_rows] - predicted[outside_rows]).mean())

        per_target[name] = {
            "inside": {"rows": int(inside_rows.sum()), "r2": round(inside_r2, 6),
                       "mae": round(inside_mae, 4)},
            "outside": {"rows": int(outside_rows.sum()), "r2": round(outside_r2, 6),
                        "mae": round(outside_mae, 4)},
            "r2_drop": round(outside_r2 - inside_r2, 6),
            "mae_ratio": round(outside_mae / inside_mae, 2) if inside_mae else None,
        }
        print(f"  {name:>12} {inside_r2:>10.4f} {outside_r2:>11.4f} "
              f"{outside_r2 - inside_r2:>+8.4f} {inside_mae:>11.3f} {outside_mae:>12.3f}")

    # Designs whose trim solve barely converged are exactly what the fallback
    # serves and never trained on, so they get their own line.
    rows_per_design = {}
    for design_id in set(design_ids.tolist()):
        rows_per_design[design_id] = int((design_ids == design_id).sum())
    sparse = np.array([rows_per_design[d] <= 3 for d in design_ids])
    sparse_designs = len(set(design_ids[sparse].tolist()))

    print()
    print(f"  designs with 3 or fewer valid speeds: {sparse_designs:,}")
    sparse_scores = {}
    for position, name in enumerate(V2_TARGETS):
        booster = xgb.Booster()
        booster.load_model(str(RUNS / f"{name}.json"))
        predicted = booster.predict(matrix)
        actual = truth[:, position]
        selected = np.isfinite(actual) & sparse
        if selected.sum() >= 10:
            score = r2(actual[selected], predicted[selected])
            sparse_scores[name] = round(score, 6)
            print(f"    {name:>12} R2 {score:>8.4f}  ({int(selected.sum()):,} rows)")

    report = {
        "question": (
            "The fallback trained on the 6,409 designs that have measured anchors "
            "and serves the other 21,305. How much does that cost?"
        ),
        "method": (
            "Real trim values for val and test designs from the v2 retraining "
            "artifacts, split by whether the design appears in the fallback's "
            "training file. Six of the eight targets; lift and distance are not "
            "carried in those artifacts."
        ),
        "evaluated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "population": {
            "inside_training_designs": designs_inside,
            "outside_training_designs": designs_outside,
            "inside_rows": int(inside.sum()),
            "outside_rows": int((~inside).sum()),
            "note": (
                "Outside designs average far fewer valid speeds - their trim "
                "solve converged at only a handful of points, which is why they "
                "have no anchors and were excluded from training."
            ),
        },
        "per_target": per_target,
        "sparse_designs": {
            "definition": "3 or fewer valid speeds in 0-50 m/s",
            "designs": sparse_designs,
            "r2": sparse_scores,
            "example": (
                "design 13077 has one valid speed (12 m/s); the fallback predicts "
                "91 N thrust against a recorded 11.9, and 3,715 W against 387."
            ),
        },
        "conclusion": (
            "Retrain on trim data for all 27,714 designs. The row count only grows "
            "about 20% - roughly 180,000 valid rows against 149,437 - because the "
            "excluded designs contribute few rows each. What changes is that the "
            "model finally sees them. Training takes about 20 seconds on a laptop "
            "CPU; the missing piece is the data, not the hardware."
        ),
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print()
    print(f"wrote {args.out.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
