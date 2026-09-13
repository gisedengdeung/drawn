"""Stage 1 — target extraction, validity filtering, and a frozen split.

Reads output.json and design_low_level.json for every design and writes one
table that stages 2-4 all key off:

  * the 16 KPI targets from output.json, each with a validity flag
    (isfinite(v) and v > 0 — a 0 is a failed or infeasible analysis, and
    training on it would teach the model to predict nonsense)
  * design-variable geometry usable as the stage-1 rung of the debugging
    ladder in docs/HANDOFF.md: fuselage length/diameters and arm lengths are
    present on every design, so a model that reads the point cloud correctly
    must be able to regress them. Overall span comes from the STL bounding
    box in stage 2.
  * configuration metadata (rotor count, wing presence, component choices)
    for stratification and error analysis
  * a train/val/test assignment that is a pure function of the design, so it
    is identical on any machine without shipping a split file

Split leakage: the `name` field inside design_low_level.json is
`design_<n>_<uuid>_<suffix>`, and 8,084 families share a `design_<n>_<uuid>`
prefix across a `dw` / `dw_dl` pair — 58% of the dataset has a sibling. Siblings
are not duplicates (their Mass differs by ~5.7% at the median) but they share
topology, component choices and generation seed, so a per-design split would
scatter half of every pair across the train/test boundary and inflate the test
score. Designs are therefore assigned by family, never individually.

Usage:
    ml\\.venv\\Scripts\\python.exe ml\\prepare_targets.py
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

from common import (
    OUTPUT_KEYS,
    REPO_ROOT,
    add_data_root_arg,
    is_available_metric,
    iter_design_dirs,
    resolve_roots,
    write_json,
)

# Primary regression targets, in the order of the debugging ladder.
PRIMARY_TARGETS = ("Mass", "Max_Distance", "Hover_Time")

# Geometry regressable straight from the point cloud — ladder rung 1.
GEOMETRY_TARGETS = (
    "fuselage_length",
    "fuselage_horz_diameter",
    "fuselage_vert_diameter",
    "arm_length_max",
    "arm_length_sum",
)

SPLIT_FRACTIONS = {"train": 0.80, "val": 0.10, "test": 0.10}
SPLIT_SALT = "aircraftverse-pointcloud-v1"

# Any parameter whose name ends in _Length on an arm-like component. The survey
# over 400 designs found Arm_<n>_Length, RotatedArm_<n>_Length and
# FixedRotationArm_<n>_Length; this matches all three.
ARM_LENGTH_RE = re.compile(r"^(?:[A-Za-z]*Arm)_\d+_Length$")
WING_SPAN_RE = re.compile(r"^Wing_\d+_SPAN$")
WING_CHORD_RE = re.compile(r"^Wing_\d+_CHORD_(?:INNER|OUTER)$")

# design_low_level.json "name" is design_<n>_<uuid>_<suffix>. The prefix is the
# design family; the suffix (s / dw / dw_dl) is the variant within it.
FAMILY_RE = re.compile(r"^(design_\d+_[0-9a-f]{32})(?:_(.+))?$")
HUB_RE = re.compile(r"^Para_Hub_(\d+)$")

# Mass passes the >0 validity rule for every design, but 11 designs report
# 60,000-240,000 kg from a blown-up analysis. The sane population tops out at
# 35.3 kg and the next value up is 60,044 kg, so any cut in between is
# equivalent; this one is flagged, never silently dropped.
MASS_PLAUSIBLE_MAX_KG = 50.0

SCALAR_PARAMS = {
    "FUSELAGE_LENGTH": "fuselage_length",
    "FUSELAGE_HORZ_DIAMETER": "fuselage_horz_diameter",
    "FUSELAGE_VERT_DIAMETER": "fuselage_vert_diameter",
    "FUSELAGE_FLOOR_HEIGHT": "fuselage_floor_height",
    "CargoMass": "cargo_mass",
}


def to_float(value):
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if np.isfinite(result) else None


def assign_split(group_key: str) -> str:
    """Deterministic 80/10/10 from a hash — reproducible without a split file."""
    digest = hashlib.sha256(f"{SPLIT_SALT}:{group_key}".encode()).digest()
    # 32 bits of the digest as a uniform fraction in [0, 1)
    fraction = int.from_bytes(digest[:4], "big") / 2**32
    cumulative = 0.0
    for name, share in SPLIT_FRACTIONS.items():
        cumulative += share
        if fraction < cumulative:
            return name
    return "test"


def config_hash(low_level: dict) -> str:
    """Exact-duplicate key: every parameter value and component choice."""
    parameters = sorted(
        f"{p.get('parameter_name')}={p.get('value')}" for p in low_level.get("parameters", [])
    )
    components = sorted(
        f"{c.get('component_type')}:{c.get('component_choice')}"
        for c in low_level.get("components", [])
    )
    payload = "\n".join(parameters) + "\n--\n" + "\n".join(components)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def extract_design(low_level: dict) -> dict:
    """Pull geometry scalars and configuration metadata out of design_low_level."""
    row: dict = {}

    values: dict[str, float] = {}
    arm_lengths: list[float] = []
    wing_spans: list[float] = []
    wing_chords: list[float] = []
    for parameter in low_level.get("parameters", []):
        name = parameter.get("parameter_name", "")
        number = to_float(parameter.get("value"))
        if number is None:
            continue
        values[name] = number
        if ARM_LENGTH_RE.match(name):
            arm_lengths.append(number)
        elif WING_SPAN_RE.match(name):
            wing_spans.append(number)
        elif WING_CHORD_RE.match(name):
            wing_chords.append(number)

    for source, target in SCALAR_PARAMS.items():
        row[target] = values.get(source)

    row["arm_count"] = len(arm_lengths)
    row["arm_length_max"] = max(arm_lengths) if arm_lengths else None
    row["arm_length_mean"] = sum(arm_lengths) / len(arm_lengths) if arm_lengths else None
    row["arm_length_sum"] = sum(arm_lengths) if arm_lengths else None
    row["wing_count"] = len(wing_spans)
    row["wing_span_max"] = max(wing_spans) if wing_spans else None
    row["wing_span_sum"] = sum(wing_spans) if wing_spans else None
    row["wing_chord_mean"] = sum(wing_chords) / len(wing_chords) if wing_chords else None
    row["has_wing"] = int(bool(wing_spans))

    types = Counter()
    choices: dict[str, str] = {}
    for component in low_level.get("components", []):
        kind = component.get("component_type")
        types[kind] += 1
        if kind in ("Motor", "Propeller", "Battery") and kind not in choices:
            choices[kind] = component.get("component_choice")
    row["n_propeller"] = types.get("Propeller", 0)
    row["n_motor"] = types.get("Motor", 0)
    row["n_battery"] = types.get("Battery", 0)
    row["n_tube"] = types.get("Tube", 0)
    row["n_sensor"] = types.get("Sensor", 0)
    row["n_components"] = sum(types.values())
    row["motor"] = choices.get("Motor")
    row["propeller"] = choices.get("Propeller")
    row["battery"] = choices.get("Battery")

    # A design carries several hubs (e.g. one Para_Hub_6 plus six Para_Hub_2).
    # The main hub is the one with the highest arity.
    arities = [
        int(match.group(1))
        for kind in types
        if isinstance(kind, str) and (match := HUB_RE.match(kind))
    ]
    row["hub_arity_max"] = max(arities) if arities else None
    row["hub"] = f"Para_Hub_{max(arities)}" if arities else None

    name = low_level.get("name") or ""
    row["internal_name"] = name
    match = FAMILY_RE.match(name)
    row["family"] = match.group(1) if match else name
    row["variant"] = (match.group(2) or "") if match else ""
    return row


def build_rows(roots: list[Path]) -> list[dict]:
    rows: list[dict] = []
    started = time.time()
    for root in roots:
        part = root.name
        for design_id, design_dir in sorted(iter_design_dirs(root)):
            output = json.loads((design_dir / "output.json").read_text(encoding="utf-8"))
            low_level = json.loads(
                (design_dir / "design_low_level.json").read_text(encoding="utf-8")
            )

            row: dict = {"design_id": design_id, "part": part}
            for key in OUTPUT_KEYS:
                value = output.get(key)
                row[key] = value
                row[f"{key}_valid"] = int(is_available_metric(value))
            row.update(extract_design(low_level))
            row["config_hash"] = config_hash(low_level)
            mass = output.get("Mass")
            row["mass_plausible"] = int(
                is_available_metric(mass) and mass <= MASS_PLAUSIBLE_MAX_KG
            )
            rows.append(row)

            if len(rows) % 5000 == 0:
                print(f"  ... {len(rows)} designs ({time.time() - started:.0f}s)", flush=True)
    print(f"  read {len(rows)} designs in {time.time() - started:.0f}s", flush=True)
    return rows


def apply_split(rows: list[dict]) -> dict:
    """Assign train/val/test by design family, never by individual design."""
    families: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        families[row["family"]].append(row)

    for family, members in families.items():
        split = assign_split(family)
        for row in members:
            row["split"] = split

    shared = {k: len(v) for k, v in families.items() if len(v) > 1}
    exact = Counter(row["config_hash"] for row in rows)
    return {
        "designs": len(rows),
        "families": len(families),
        "families_with_siblings": len(shared),
        "designs_with_a_sibling": sum(shared.values()),
        "largest_family": max(shared.values(), default=1),
        "family_size_histogram": dict(sorted(Counter(len(v) for v in families.values()).items())),
        "variants": dict(Counter(row["variant"] or "(none)" for row in rows).most_common()),
        "exact_duplicate_configs": sum(1 for count in exact.values() if count > 1),
    }


def sibling_target_gap(rows: list[dict]) -> dict:
    """How different are siblings really? Justifies grouping them, or not."""
    families: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        families[row["family"]].append(row)
    pairs = [members for members in families.values() if len(members) == 2]

    result = {}
    for key in PRIMARY_TARGETS:
        gaps = []
        for first, second in pairs:
            if not (first[f"{key}_valid"] and second[f"{key}_valid"]):
                continue
            a, b = float(first[key]), float(second[key])
            scale = max(abs(a), abs(b))
            if scale > 0:
                gaps.append(abs(a - b) / scale)
        result[key] = {
            "both_valid_pairs": len(gaps),
            "median_relative_gap": round(float(np.median(gaps)), 4) if gaps else None,
            "p90_relative_gap": round(float(np.percentile(gaps, 90)), 4) if gaps else None,
        }
    return result


def mean_baseline(rows: list[dict]) -> dict:
    """Stage 4 needs 'predict the training mean' as the floor to beat."""
    baseline = {}
    for key in PRIMARY_TARGETS + GEOMETRY_TARGETS:
        valid = [row for row in rows if trainable(row, key)]
        train = [float(row[key]) for row in valid if row["split"] == "train"]
        if not train:
            continue
        prediction = float(np.mean(train))
        entry = {"train_mean": round(prediction, 4)}
        for split in ("val", "test"):
            actual = np.asarray(
                [float(row[key]) for row in valid if row["split"] == split], dtype=float
            )
            if actual.size:
                entry[f"{split}_mae"] = round(float(np.abs(actual - prediction).mean()), 4)
                entry[f"{split}_rmse"] = round(
                    float(np.sqrt(((actual - prediction) ** 2).mean())), 4
                )
                entry[f"{split}_n"] = int(actual.size)
        baseline[key] = entry
    return baseline


# Validity (>0 and finite) is necessary but not sufficient: Mass additionally
# has to be physically possible. Stages 2-4 must filter with `trainable`, not
# with the *_valid flag alone.
TRAINABLE_EXTRA = {"Mass": lambda row: bool(row["mass_plausible"])}


def trainable(row: dict, key: str) -> bool:
    if row.get(key) is None or not row.get(f"{key}_valid", 1):
        return False
    extra = TRAINABLE_EXTRA.get(key)
    return extra(row) if extra else True


def describe(values: list[float]) -> dict | None:
    if not values:
        return None
    array = np.asarray(values, dtype=float)
    return {
        "count": int(array.size),
        "mean": round(float(array.mean()), 4),
        "std": round(float(array.std(ddof=0)), 4),
        "min": round(float(array.min()), 4),
        "p50": round(float(np.percentile(array, 50)), 4),
        "max": round(float(array.max()), 4),
    }


def summarize(rows: list[dict]) -> dict:
    total = len(rows)
    splits = Counter(row["split"] for row in rows)

    target_summary: dict[str, dict] = {}
    for key in OUTPUT_KEYS:
        valid_rows = [row for row in rows if row[f"{key}_valid"]]
        trainable_rows = [row for row in rows if trainable(row, key)]
        per_split = Counter(row["split"] for row in trainable_rows)
        target_summary[key] = {
            "valid": len(valid_rows),
            "valid_fraction": round(len(valid_rows) / total, 4),
            "trainable": len(trainable_rows),
            "per_split": {name: per_split.get(name, 0) for name in SPLIT_FRACTIONS},
            "stats_trainable_only": describe([row[key] for row in trainable_rows]),
        }

    geometry_summary = {
        name: describe([row[name] for row in rows if row.get(name) is not None])
        for name in (
            "fuselage_length",
            "fuselage_horz_diameter",
            "fuselage_vert_diameter",
            "fuselage_floor_height",
            "arm_length_max",
            "arm_length_sum",
            "wing_span_max",
        )
    }

    # docs/HANDOFF.md open item: is payload 0.5 kg cargo or cargo + avionics?
    cargo_values = Counter(row.get("cargo_mass") for row in rows)
    sensor_counts = Counter(row.get("n_sensor") for row in rows)

    implausible = [row for row in rows if not row["mass_plausible"]]
    mass_note = {
        "threshold_kg": MASS_PLAUSIBLE_MAX_KG,
        "implausible_designs": len(implausible),
        "max_plausible_mass": round(
            max((row["Mass"] for row in rows if row["mass_plausible"]), default=0.0), 4
        ),
        "implausible": sorted(
            (
                {
                    "design_id": row["design_id"],
                    "mass": round(row["Mass"], 1),
                    "n_propeller": row["n_propeller"],
                    "has_wing": row["has_wing"],
                    "any_kpi_valid": int(
                        any(row[f"{k}_valid"] for k in OUTPUT_KEYS if k != "Mass")
                    ),
                }
                for row in implausible
            ),
            key=lambda entry: -entry["mass"],
        ),
    }

    return {
        "total_designs": total,
        "mass_plausibility": mass_note,
        "split_sizes": {name: splits.get(name, 0) for name in SPLIT_FRACTIONS},
        "split_fractions": {
            name: round(splits.get(name, 0) / total, 4) for name in SPLIT_FRACTIONS
        },
        "targets": target_summary,
        "geometry": geometry_summary,
        "rotor_counts": dict(sorted(Counter(row["n_propeller"] for row in rows).items())),
        "wing_designs": sum(row["has_wing"] for row in rows),
        "wing_fraction": round(sum(row["has_wing"] for row in rows) / total, 4),
        "hub_types": dict(Counter(row["hub"] for row in rows).most_common()),
        "distinct_motors": len({row["motor"] for row in rows if row["motor"]}),
        "distinct_propellers": len({row["propeller"] for row in rows if row["propeller"]}),
        "distinct_batteries": len({row["battery"] for row in rows if row["battery"]}),
        "cargo_mass_values": {str(k): v for k, v in cargo_values.most_common()},
        "sensor_count_values": {str(k): v for k, v in sensor_counts.most_common()},
    }


def write_table(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = list(rows[0].keys())
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Stage 1 target extraction and split")
    add_data_root_arg(parser)
    parser.add_argument("--out", type=Path, default=REPO_ROOT / "ml" / "data" / "targets.csv")
    parser.add_argument(
        "--report", type=Path, default=REPO_ROOT / "ml" / "reports" / "stage1_report.json"
    )
    args = parser.parse_args(argv)

    roots = resolve_roots(args.data_root)

    print("Stage 1 target extraction")
    for root in roots:
        print(f"  root: {root}")
    print()

    print("[1/3] reading output.json + design_low_level.json ...", flush=True)
    rows = build_rows(roots)

    print("[2/3] assigning split by design family ...", flush=True)
    grouping = apply_split(rows)

    print("[3/3] summarizing ...", flush=True)
    summary = summarize(rows)
    summary["grouping"] = grouping
    summary["sibling_target_gap"] = sibling_target_gap(rows)
    summary["mean_baseline"] = mean_baseline(rows)
    summary["split_method"] = {
        "fractions": SPLIT_FRACTIONS,
        "salt": SPLIT_SALT,
        "key": "sha256 of the design family (design_<n>_<uuid> prefix of design_low_level name)",
        "note": "pure function of the design; no split file needed to reproduce",
        "why_family": "dw/dw_dl siblings share topology, components and seed; "
                      "splitting per design would straddle 58% of the dataset",
    }
    summary["validity_rule"] = "isfinite(v) and v > 0, mirroring isAvailableMetric"

    write_table(args.out, rows)
    write_json(args.report, summary)

    # ---- console summary ----------------------------------------------
    print()
    print("=" * 70)
    print(f"designs            : {summary['total_designs']}")
    print(f"families           : {grouping['families']} "
          f"({grouping['designs_with_a_sibling']} designs have a sibling, "
          f"{grouping['designs_with_a_sibling'] / summary['total_designs']:.1%})")
    print(f"exact dup configs  : {grouping['exact_duplicate_configs']}")
    print(f"split (by family)  : " + "  ".join(
        f"{name} {summary['split_sizes'][name]} ({summary['split_fractions'][name]:.1%})"
        for name in SPLIT_FRACTIONS
    ))
    print()
    print("primary targets — trainable designs per split")
    header = f"  {'target':<16}{'valid':>8}{'train-able':>11}" + "".join(
        f"{name:>8}" for name in SPLIT_FRACTIONS
    )
    print(header)
    for key in PRIMARY_TARGETS:
        entry = summary["targets"][key]
        counts = "".join(f"{entry['per_split'][name]:>8}" for name in SPLIT_FRACTIONS)
        print(f"  {key:<16}{entry['valid']:>8}{entry['trainable']:>11}{counts}")
    print()
    print("ladder rung 1 — geometry from design variables (mm)")
    for name in GEOMETRY_TARGETS:
        stats = summary["geometry"].get(name)
        if stats:
            print(f"  {name:<24} n={stats['count']:<6} "
                  f"min={stats['min']:<9.1f} p50={stats['p50']:<9.1f} max={stats['max']:<9.1f}")
    print()
    print("sibling target gap (relative, dw vs dw_dl)")
    for key, entry in summary["sibling_target_gap"].items():
        print(f"  {key:<16} pairs={entry['both_valid_pairs']:<6} "
              f"median={entry['median_relative_gap']}  p90={entry['p90_relative_gap']}")
    print()
    print("mean-prediction baseline (stage 4 floor)")
    for key in PRIMARY_TARGETS:
        entry = summary["mean_baseline"].get(key)
        if entry:
            print(f"  {key:<16} train_mean={entry['train_mean']:<12} "
                  f"test_MAE={entry.get('test_mae')}  test_RMSE={entry.get('test_rmse')}")
    print()
    mass_note = summary["mass_plausibility"]
    print(f"rotor counts       : {summary['rotor_counts']}")
    print(f"hub types          : {summary['hub_types']}")
    print(f"designs with wing  : {summary['wing_designs']} ({summary['wing_fraction']:.1%})")
    print(f"cargo_mass values  : {summary['cargo_mass_values']}")
    print(f"sensor count values: {summary['sensor_count_values']}")
    print(f"implausible Mass   : {mass_note['implausible_designs']} designs > "
          f"{mass_note['threshold_kg']} kg (sane max {mass_note['max_plausible_mass']} kg)")
    print("=" * 70)
    print(f"table  -> {args.out}")
    print(f"report -> {args.report}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
