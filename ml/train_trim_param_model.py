"""Train a speed-conditional trim model that needs no baseline anchors.

The model shipped in backend/model_bundle predicts the eight trim values very
well - drag 0.990, thrust 0.994, distance 0.992 on validation - but it is fed
five measured values from the design's own trim table:

    dragAt20  powerAt20  powerAt0  thrustAt0  currentAt0

Those come from the CAD trim analysis, so a design the user just edited does
not have them. backend/app/performance.py says so directly: a design outside
`eligibleDesignIds` (6,409 of 27,714, or 23%) gets a 422 and the panel shows
a "not supported for this design" notice with no numbers at all.

This trains the same task on the same rows and the same split, with the
anchors removed and replaced by parameters the browser can actually supply -
motor KV, propeller size, battery capacity and cell count, parsed from the
component names by ml/param_features.py.

It will score lower than the anchored model. That is the point: the comparison
below is what the fallback costs, measured rather than assumed.

    python ml/train_trim_param_model.py

Writes ml/runs/trim_param/*.json and ml/reports/trim_param_model.json.
ASCII only.
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
DATASET = REPO_ROOT / "ml" / "sources" / "dongha" / "dataset_510k.csv"
SPLIT_FILE = REPO_ROOT / "ml" / "sources" / "dongha" / "20260920_160522" / "split_design_ids.json"
DESIGN_INDEX = REPO_ROOT / "public" / "data" / "design-index.json"
RUNS = REPO_ROOT / "ml" / "runs" / "trim_param"
REPORT = REPO_ROOT / "ml" / "reports" / "trim_param_model.json"

# The eight the Performance Simulator draws, in the order performance.py returns.
TARGETS = ("drag", "lift", "thrust", "pitch", "power", "current", "flightTime", "distance")

# Present in the CSV, deliberately unused: these are measured trim values, and
# an edited design has none of them.
ANCHORS = ("dragAt20", "powerAt20", "powerAt0", "thrustAt0", "currentAt0")

# Dongha's validation R2, for the cost-of-dropping-anchors comparison.
ANCHORED_VAL_R2 = {
    "drag": 0.9901, "lift": 0.2429, "thrust": 0.9944, "pitch": 0.4721,
    "power": 0.9691, "current": 0.9710, "flightTime": 0.9902, "distance": 0.9918,
}

PARAMS = {
    "objective": "reg:squarederror",
    "max_depth": 8,
    "eta": 0.05,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "lambda": 1.0,
    "nthread": 8,
}
ROUNDS = 3000
EARLY_STOP = 60

MISSING = """\
Needs files that arrive with origin/develop:
    ml/sources/dongha/dataset_510k.csv
    ml/sources/dongha/20260920_160522/split_design_ids.json
Merge origin/develop first.
"""


def _parameters_by_design() -> dict[int, dict]:
    return {
        int(record["id"]): build_row(record)
        for record in json.loads(DESIGN_INDEX.read_text(encoding="utf-8"))["designs"]
    }


def load_rows_from_csv():
    """The eligible-only source: 6,409 designs that have measured anchors.

    Kept so the original run stays reproducible, but it is not what the fallback
    should learn from - see load_rows_from_npz.
    """
    per_design = _parameters_by_design()
    split_ids = json.loads(SPLIT_FILE.read_text(encoding="utf-8"))
    split_of = {}
    for name, key in (("train", "train"), ("val", "validation"), ("test", "test")):
        for design_id in split_ids[key]:
            split_of[int(design_id)] = name

    features, targets, splits, design_ids = [], [], [], []
    with DATASET.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            design_id = int(row["design_id"])
            parameters = per_design.get(design_id)
            if parameters is None:
                continue
            features.append(
                [float(row["speed"])] + [parameters[name] for name in FEATURE_NAMES]
            )
            targets.append([float(row[f"target_{name}"]) for name in TARGETS])
            splits.append(split_of.get(design_id, "train"))
            design_ids.append(design_id)

    return (
        np.array(features, dtype=np.float32),
        np.array(targets, dtype=np.float64),
        np.array(splits),
        np.array(design_ids, dtype=np.int64),
    )


def load_rows_from_npz(path: Path):
    """Every design's trim rows, which is the population the fallback serves.

    The CSV above covers only designs with measured anchors, and those are
    exactly the ones the conditioned model already handles. Trained on them, the
    fallback met designs it had never seen: pitch fell from R2 0.904 to 0.196
    and power from 0.962 to 0.641 outside that population, and design 13077,
    whose trim solve converged at a single speed, got 3,715 W against a recorded
    387 (ml/reports/fallback_coverage.json).

    ml/prepare_trims.py writes this file from trims.npy, carrying the family
    split so scores stay comparable with every other model here.

    It holds six targets. lift and distance are not in it, so those two keep the
    boosters trained from the CSV unless they are added upstream.
    """
    per_design = _parameters_by_design()
    with np.load(path, allow_pickle=False) as data:
        ids = data["design_id"]
        trim = data["trim"]                      # (N, 51, 6)
        regression_mask = data["regression_mask"]  # (N, 51, 6)
        split = data["split"]
        names = [str(name) for name in data["target_names"]]

    position_of = {name: index for index, name in enumerate(names)}
    missing = [name for name in TARGETS if name not in position_of]

    features, targets, splits, design_ids = [], [], [], []
    for row, design_id in enumerate(ids.tolist()):
        parameters = per_design.get(int(design_id))
        if parameters is None:
            continue
        usable = regression_mask[row].any(axis=1)
        for speed in np.where(usable)[0]:
            values = []
            for name in TARGETS:
                index = position_of.get(name)
                values.append(
                    float(trim[row, speed, index])
                    if index is not None and regression_mask[row, speed, index]
                    else np.nan
                )
            features.append([float(speed)] + [parameters[n] for n in FEATURE_NAMES])
            targets.append(values)
            splits.append(str(split[row]))
            design_ids.append(int(design_id))

    return (
        np.array(features, dtype=np.float32),
        np.array(targets, dtype=np.float64),
        np.array(splits),
        np.array(design_ids, dtype=np.int64),
        missing,
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rounds", type=int, default=ROUNDS)
    parser.add_argument("--max-depth", type=int, default=PARAMS["max_depth"])
    parser.add_argument(
        "--trims", type=Path, default=None,
        help="ml/data/trims.npz from ml/prepare_trims.py; covers all 27,714 "
             "designs instead of the 6,409 with measured anchors",
    )
    args = parser.parse_args(argv)
    PARAMS["max_depth"] = args.max_depth

    if args.trims is None and (not DATASET.is_file() or not SPLIT_FILE.is_file()):
        print(MISSING)
        return 2
    if args.trims is not None and not args.trims.is_file():
        print(f"not found: {args.trims}")
        print()
        print("Build it first:")
        print("    python ml/prepare_trims.py")
        return 2
    try:
        import xgboost as xgb
    except ImportError:
        print("xgboost is not installed:  pip install xgboost==2.1.1")
        return 2

    started = time.time()
    unavailable: list[str] = []
    if args.trims is not None:
        features, targets, splits, design_ids, unavailable = load_rows_from_npz(args.trims)
        resolved = args.trims.resolve()
        source = str(
            resolved.relative_to(REPO_ROOT) if resolved.is_relative_to(REPO_ROOT) else resolved
        )
    else:
        features, targets, splits, design_ids = load_rows_from_csv()
        source = str(DATASET.relative_to(REPO_ROOT))
    feature_names = ["speed"] + list(FEATURE_NAMES)

    print(f"source {source}")
    print(f"rows {features.shape[0]:,}  features {features.shape[1]} "
          f"(speed + {len(FEATURE_NAMES)} parameters, no anchors)")
    if unavailable:
        print(f"  targets not in this file, left as previously trained: "
              f"{', '.join(unavailable)}")
    for name in ("train", "val", "test"):
        rows = splits == name
        print(f"  {name:>5} {rows.sum():>7,} rows  "
              f"{len(set(design_ids[rows].tolist())):>5,} designs")
    print(f"  dropped anchors: {', '.join(ANCHORS)}")
    print()

    is_train, is_val, is_test = splits == "train", splits == "val", splits == "test"
    RUNS.mkdir(parents=True, exist_ok=True)

    results = {}
    print(f"  {'target':>12} {'val R2':>8} {'test R2':>8} {'test MAE':>10} "
          f"{'anchored':>9} {'cost':>8}")
    print("  " + "-" * 62)
    for position, name in enumerate(TARGETS):
        values = targets[:, position]
        finite = np.isfinite(values)
        if name in unavailable or finite.sum() < 100:
            print(f"  {name:>12} {'skipped - not in this source':>50}")
            continue
        dtrain = xgb.DMatrix(features[is_train & finite], label=values[is_train & finite],
                             feature_names=feature_names)
        dval = xgb.DMatrix(features[is_val & finite], label=values[is_val & finite],
                           feature_names=feature_names)
        dtest = xgb.DMatrix(features[is_test & finite], label=values[is_test & finite],
                            feature_names=feature_names)

        booster = xgb.train(
            PARAMS, dtrain, num_boost_round=args.rounds,
            evals=[(dval, "val")], early_stopping_rounds=EARLY_STOP, verbose_eval=False,
        )
        best = booster.best_iteration + 1
        booster.save_model(str(RUNS / f"{name}.json"))

        val_actual = values[is_val & finite]
        test_actual = values[is_test & finite]
        val_score = r2(val_actual, booster.predict(dval, iteration_range=(0, best)))
        test_predicted = booster.predict(dtest, iteration_range=(0, best))
        test_score = r2(test_actual, test_predicted)
        mae = float(np.abs(test_actual - test_predicted).mean())

        anchored = ANCHORED_VAL_R2[name]
        results[name] = {
            "val_r2": round(val_score, 6),
            "test_r2": round(test_score, 6),
            "test_mae": round(mae, 4),
            "best_iteration": int(best),
            "rows": {"train": int((is_train & finite).sum()),
                     "test": int((is_test & finite).sum())},
            "anchored_model_val_r2": anchored,
            "cost_of_dropping_anchors": round(val_score - anchored, 6),
        }
        print(f"  {name:>12} {val_score:>8.4f} {test_score:>8.4f} {mae:>10.3f} "
              f"{anchored:>9.4f} {val_score - anchored:>+8.4f}")

    report = {
        "model": "trim-param-v1",
        "purpose": (
            "Fallback for designs the anchored model refuses. backend/app/"
            "performance.py returns 422 model_input_unavailable for anything "
            "outside its 6,409 eligible designs, and for every edited design, "
            "because the five anchor values do not exist until a CAD trim "
            "analysis has been run."
        ),
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "task": "conditional_speed_to_trim_regression, without baseline anchors",
        "targets": list(TARGETS),
        "feature_names": feature_names,
        "dropped_anchor_features": list(ANCHORS),
        "why_anchors_are_dropped": (
            "dragAt20, powerAt20, powerAt0, thrustAt0 and currentAt0 are measured "
            "trim values from the design's own table. Feeding them back makes the "
            "task interpolation between known points, which is why the anchored "
            "model reaches 0.99, and why it cannot serve a design that has no "
            "table yet."
        ),
        "split": {
            "source": "ml/sources/dongha/20260920_160522/split_design_ids.json",
            "note": "Dongha's exact split, so the numbers compare directly.",
            "designs": {name: int(len(set(design_ids[splits == name].tolist())))
                        for name in ("train", "val", "test")},
            "rows": {name: int((splits == name).sum())
                     for name in ("train", "val", "test")},
        },
        "per_target": results,
        "runtime": {"library": "xgboost", "version": "2.1.1", "format": "native json"},
        "files": {name: f"ml/runs/trim_param/{name}.json" for name in TARGETS},
        "source": source,
        "targets_not_retrained": unavailable,
        "max_depth": args.max_depth,
        "elapsed_seconds": round(time.time() - started, 1),
    }

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print()
    print(f"wrote {REPORT.relative_to(REPO_ROOT)}")
    print(f"wrote {RUNS.relative_to(REPO_ROOT)}/*.json  ({len(TARGETS)} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
