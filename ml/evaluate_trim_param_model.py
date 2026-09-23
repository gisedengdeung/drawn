"""Score the anchor-free trim model, head to head with the anchored one.

R2 alone has hidden a blocker in every model on this project so far: the top
decile gets under-predicted badly enough that ranking designs by the output
makes the product worse, not better. The point cloud model shrank Max_Distance
by 76% of the IQR at the top. This checks the same thing before the fallback
goes anywhere near the UI.

The anchored model's own test predictions ship in the repo, over the identical
14,571 rows, so the comparison here is row-for-row rather than metric-for-metric.

    python ml/evaluate_trim_param_model.py

Writes ml/reports/trim_param_evaluation.json. ASCII only.
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
from train_trim_param_model import ANCHORS, TARGETS  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
RUNS = REPO_ROOT / "ml" / "runs" / "trim_param"
ANCHORED_PREDICTIONS = (
    REPO_ROOT / "ml" / "sources" / "dongha" / "20260920_160522" / "test_predictions.csv"
)
DESIGN_INDEX = REPO_ROOT / "public" / "data" / "design-index.json"
TRIMS = REPO_ROOT / "ml" / "data" / "trims.npz"
DEFAULT_OUT = REPO_ROOT / "ml" / "reports" / "trim_param_evaluation.json"

MISSING = """\
Train first:

    python ml/train_trim_param_model.py
"""


def decile_bias(actual: np.ndarray, predicted: np.ndarray) -> dict:
    """Bias per decile of the true value, as a percentage of the true IQR.

    A ratio explodes wherever the true value nears zero - pitch changes sign and
    drag is zero at rest - so the difference, scaled by the IQR, is what every
    report in this repo uses.
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
        "top_decile_pct_of_iqr": out[-1],
        "actual_max": round(float(actual.max()), 4),
        "predicted_max": round(float(predicted.max()), 4),
        "predicted_max_over_actual_max": (
            round(float(predicted.max() / actual.max()), 4) if actual.max() != 0 else None
        ),
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args(argv)

    if not RUNS.is_dir() or not (RUNS / "drag.json").is_file():
        print(MISSING)
        return 2
    try:
        import xgboost as xgb
    except ImportError:
        print("xgboost is not installed:  pip install xgboost==2.1.1")
        return 2

    index = {
        int(record["id"]): build_row(record)
        for record in json.loads(DESIGN_INDEX.read_text(encoding="utf-8"))["designs"]
    }

    # The anchored model's test predictions cover its own 641-design split. Once
    # this model is retrained from ml/data/trims.npz it uses the family split
    # instead, and 80% of those 641 land in its training set - scoring there
    # would report memorisation. Keep only designs held out by both.
    held_out = None
    if TRIMS.is_file():
        with np.load(TRIMS, allow_pickle=False) as data:
            held_out = {
                int(design_id)
                for design_id, split in zip(data["design_id"].tolist(), data["split"].tolist())
                if str(split) == "test"
            }

    rows, actual, anchored = [], [], []
    speeds, design_ids = [], []
    skipped = set()
    with ANCHORED_PREDICTIONS.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            design_id = int(row["design_id"])
            if held_out is not None and design_id not in held_out:
                skipped.add(design_id)
                continue
            parameters = index[design_id]
            rows.append([float(row["speed"])] + [parameters[n] for n in FEATURE_NAMES])
            actual.append([float(row[f"target_{n}"]) for n in TARGETS])
            anchored.append([float(row[f"predicted_{n}"]) for n in TARGETS])
            speeds.append(float(row["speed"]))
            design_ids.append(design_id)

    if not rows:
        print("No designs are held out by both splits; nothing comparable to score.")
        return 2

    features = np.array(rows, dtype=np.float32)
    actual = np.array(actual, dtype=np.float64)
    anchored = np.array(anchored, dtype=np.float64)
    speeds = np.array(speeds)
    design_ids = np.array(design_ids)
    feature_names = ["speed"] + list(FEATURE_NAMES)
    matrix = xgb.DMatrix(features, feature_names=feature_names)

    print(f"test rows {len(features):,}  designs {len(set(design_ids.tolist())):,}")
    print("both models scored on the identical rows\n")

    per_target = {}
    moving = speeds > 0
    print(f"  {'target':>12} {'mine':>8} {'anchored':>9} {'diff':>8} "
          f"{'speed>0':>8} {'top decile':>11} {'max ratio':>10}")
    print("  " + "-" * 72)
    for position, name in enumerate(TARGETS):
        booster = xgb.Booster()
        booster.load_model(str(RUNS / f"{name}.json"))
        predicted = booster.predict(matrix)

        truth = actual[:, position]
        finite = np.isfinite(truth)
        mine = r2(truth[finite], predicted[finite])
        theirs = r2(truth[finite], anchored[finite, position])
        moving_only = finite & moving
        mine_moving = r2(truth[moving_only], predicted[moving_only])

        calibration = decile_bias(truth[finite], predicted[finite])
        anchored_calibration = decile_bias(truth[finite], anchored[finite, position])

        error = truth[finite] - predicted[finite]
        per_target[name] = {
            "rows": int(finite.sum()),
            "test_r2": round(mine, 6),
            "test_mae": round(float(np.abs(error).mean()), 4),
            "test_r2_speed_gt0": round(mine_moving, 6),
            "anchored_model": {
                "test_r2": round(theirs, 6),
                "delta": round(mine - theirs, 6),
                "top_decile_pct_of_iqr": anchored_calibration["top_decile_pct_of_iqr"],
                "predicted_max_over_actual_max": anchored_calibration[
                    "predicted_max_over_actual_max"
                ],
            },
            "calibration_test": calibration,
        }
        # lift is zero on almost every row, so its IQR is zero and the decile
        # diagnostic has nothing to divide by.
        top = calibration["top_decile_pct_of_iqr"]
        ratio = calibration["predicted_max_over_actual_max"]
        top_text = f"{top:+.0f}%" if top is not None else "n/a"
        ratio_text = f"{ratio:.2f}" if ratio is not None else "n/a"
        print(
            f"  {name:>12} {mine:>8.4f} {theirs:>9.4f} {mine - theirs:>+8.4f} "
            f"{mine_moving:>8.4f} {top_text:>11} {ratio_text:>10}"
        )

    ranking_unsafe = [
        name
        for name, entry in per_target.items()
        if entry["calibration_test"]["top_decile_pct_of_iqr"] is not None
        and entry["calibration_test"]["top_decile_pct_of_iqr"] < -25
    ]
    weak = [name for name, entry in per_target.items() if entry["test_r2"] < 0.6]

    report = {
        "model": "trim-param-v1",
        "evaluated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "comparison": {
            "against": "ml/sources/dongha/20260920_160522/test_predictions.csv",
            "basis": (
                "Identical test rows, restricted to designs held out by both "
                "splits. The anchored model is given five measured trim values "
                "per design; this one is given none."
            ),
            "designs_excluded_as_trained_on": len(skipped),
            "dropped_anchor_features": list(ANCHORS),
        },
        "scoring_rule": (
            "R2 in the raw unit over finite rows, referenced to the mean of those "
            "rows. Speeds with no valid trim row are absent from the dataset."
        ),
        "per_target": per_target,
        "shrinkage_watch": {
            "why": (
                "Every model on this project so far has under-predicted its top "
                "decile enough to make ranking unsafe. Checked before the fallback "
                "reaches the UI."
            ),
            "threshold": "top decile below -25% of the IQR",
            "ranking_unsafe": ranking_unsafe,
            "safe_to_rank": [n for n in TARGETS if n not in ranking_unsafe],
        },
        "known_issues": [],
    }

    for name in ranking_unsafe:
        bias = per_target[name]["calibration_test"]["top_decile_pct_of_iqr"]
        report["known_issues"].append(
            {
                "id": f"{name}_top_decile_shrinkage",
                "severity": "blocker_for_ranking",
                "detail": (
                    f"{name} under-predicts its top decile by {abs(bias):.0f}% of the "
                    "IQR. Display is fine; do not sort or search designs on it."
                ),
            }
        )
    for name in weak:
        report["known_issues"].append(
            {
                "id": f"{name}_weak",
                "severity": "reporting",
                "detail": (
                    f"{name} reaches only R2 {per_target[name]['test_r2']:.3f}. The "
                    "anchored model scores "
                    f"{per_target[name]['anchored_model']['test_r2']:.3f} here, so "
                    "this is the target itself being hard, not the missing anchors."
                ),
            }
        )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print()
    print(f"wrote {args.out.relative_to(REPO_ROOT)}")
    print()
    print(f"  ranking unsafe : {', '.join(ranking_unsafe) if ranking_unsafe else 'none'}")
    print(f"  safe to rank   : {', '.join(report['shrinkage_watch']['safe_to_rank'])}")
    print(f"  {len(report['known_issues'])} known issues recorded")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
