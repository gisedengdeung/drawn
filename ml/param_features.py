"""Feature and split construction for the parameter-based performance model.

Everything here comes from files that are committed to the repo:

    public/data/design-index.json        27,714 designs, parameters and KPIs
    public/data/design-trees/shard-*.json  the internal name, for the family split

So this model needs no 85 GB source tree and no GPU. That is the point of it.

The features are deliberately restricted to what Design Studio can actually
supply for a design the user just edited. A design that exists only in the
browser has no CAD analysis behind it, so anything the CAD pipeline computes -
`interferences` above all - is not available at inference and is not used here.
Training on a feature the caller cannot provide produces a model that scores
well offline and cannot be deployed.

Component names carry the information the point cloud model was blind to:

    t_motor_AT4125KV540          -> motorKv 540
    apc_propellers_20x10E        -> propDiameterIn 20, propPitchIn 10
    TurnigyGraphene5000mAh3S75C  -> battMah 5000, battSeries 3, battC 75

Feature names are emitted in alphabetical order because backend/app/model.py
builds its DMatrix from `sorted(features.keys())`. XGBoost validates feature
names, so a mismatch raises instead of silently scrambling columns.

ASCII only.
"""

from __future__ import annotations

import glob
import json
import re
import sys
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA = REPO_ROOT / "public" / "data"
INDEX_PATH = DATA / "design-index.json"
SHARD_GLOB = str(DATA / "design-trees" / "shard-*.json")

sys.path.insert(0, str(REPO_ROOT / "ml"))
from prepare_targets import FAMILY_RE, assign_split  # noqa: E402

MM_PER_INCH = 25.4

# Straight from design-index.json. Every one of these is present on a
# DesignDraft, so the browser can send them for an edited design.
INDEX_NUMERIC = (
    "numPropellers",
    "numWings",
    "armLength",
    "meanArmLength",
    "maxArmLength",
    "fuselageLength",
    "fuselageHorizontalDiameter",
    "fuselageVerticalDiameter",
    "totalWingSpan",
    "meanWingChord",
    "parameterCount",
)

# Parsed out of the component and topology names.
DERIVED = (
    "motorKv",
    "propDiameterIn",
    "propPitchIn",
    "battMah",
    "battSeries",
    "battParallel",
    "battCRate",
    "battWhApprox",
    "hubArity",
    "hubSymmetric",
    "discLoadingProxy",
)

FEATURE_NAMES = tuple(sorted(INDEX_NUMERIC + DERIVED))

# raw[0..5] in backend/app/model.py. mass is last so the existing 0..4 mapping
# keeps working if the backend is not updated in the same change.
TARGETS = (
    ("maxDistance", "max_distance_m", "m"),
    ("hoverTime", "hover_time_s", "s"),
    ("maxSpeed", "max_speed_mps", "m/s"),
    ("power", "power_w", "W"),
    ("dragAt20", "drag_at_20_n", "N"),
    ("mass", "mass_kg", "kg"),
)
TARGET_KEYS = tuple(name for name, _, _ in TARGETS)

# 11 designs report 60,000-240,000 kg from a blown-up analysis; the sane
# population tops out near 35 kg. Same gate as ml/prepare_targets.py.
MASS_CEILING_KG = 50.0


def _motor_kv(name: str | None) -> float:
    """KV in rpm/V. The two vendors label it differently.

    t_motor spells it out - t_motor_AntigravityMN4006KV380 -> 380.
    KDE does not - kde_direct_KDE600XF_530_G3 -> 530, the number after the
    frame size. 13 of the 49 motors are KDE, so missing this leaves KV blank on
    37% of designs, and KV is one of the few things that tells the model how
    efficient the drive is.
    """
    text = name or ""
    match = re.search(r"KV(\d+)", text, re.IGNORECASE)
    if match:
        return float(match.group(1))
    match = re.search(r"KDE\d+XF_(\d+)", text)
    return float(match.group(1)) if match else np.nan


def _propeller(name: str | None) -> tuple[float, float]:
    match = re.match(r"apc_propellers_([\d_]+)x([\d_]+)", name or "")
    if not match:
        return (np.nan, np.nan)
    try:
        return (
            float(match.group(1).replace("_", ".")),
            float(match.group(2).replace("_", ".")),
        )
    except ValueError:
        return (np.nan, np.nan)


def _battery(name: str | None) -> tuple[float, float, float, float]:
    """Capacity, series cells, parallel packs, C-rate.

    Tattu writes both counts - Tattu5C28000mAh6S1P -> 6S 1P. Turnigy writes
    only the series count - TurnigyGraphene5000mAh3S75C -> 3S, and a pack with
    no P suffix is a single pack. 25 of the 56 batteries are written that way,
    so requiring the P dropped series voltage on 53% of designs, and voltage
    times capacity is what sets flight time.

    C-rate is read from the segment before mAh (Tattu) or after the cell count
    (Turnigy), never from the S figure.
    """
    text = name or ""
    capacity = re.search(r"(\d+)mAh", text)
    series = re.search(r"(\d+)S", text)
    parallel = re.search(r"\d+S(\d+)P", text)
    rate = re.search(r"(\d+)C\d+mAh", text) or re.search(r"\d+S(\d+)C", text)
    return (
        float(capacity.group(1)) if capacity else np.nan,
        float(series.group(1)) if series else np.nan,
        float(parallel.group(1)) if parallel else (1.0 if series else np.nan),
        float(rate.group(1)) if rate else np.nan,
    )


def _hub(name: str | None) -> tuple[float, float]:
    match = re.search(r"Hub(\d+)", name or "")
    arity = float(match.group(1)) if match else np.nan
    return arity, 1.0 if "Sym" in (name or "") else 0.0


def build_row(record: dict) -> dict[str, float]:
    """Named features for one design. Mirrors what the browser can send."""
    diameter, pitch = _propeller(record.get("primaryPropeller"))
    capacity, series, parallel, c_rate = _battery(record.get("primaryBattery"))
    arity, symmetric = _hub(record.get("hub"))

    # 3.7 V nominal per LiPo cell, times parallel packs. Rough, but it puts
    # capacity and voltage into one number the way flight time actually depends
    # on them - see docs/DRONE_PRIMER.md section 2.
    watt_hours = capacity / 1000.0 * series * 3.7 * parallel if capacity == capacity else np.nan

    rotors = float(record.get("numPropellers") or 0)
    disc_area = rotors * np.pi * (diameter * MM_PER_INCH / 2000.0) ** 2 if diameter == diameter else np.nan
    disc_loading = 1.0 / disc_area if disc_area and disc_area == disc_area and disc_area > 0 else np.nan

    row = {name: float(record.get(name, np.nan) or 0.0) for name in INDEX_NUMERIC}
    row.update(
        motorKv=_motor_kv(record.get("primaryMotor")),
        propDiameterIn=diameter,
        propPitchIn=pitch,
        battMah=capacity,
        battSeries=series,
        battParallel=parallel,
        battCRate=c_rate,
        battWhApprox=watt_hours,
        hubArity=arity,
        hubSymmetric=symmetric,
        discLoadingProxy=disc_loading,
    )
    return row


def load_dataset():
    """Return (X, targets, splits, design_ids) built only from repo files."""
    index = json.loads(INDEX_PATH.read_text(encoding="utf-8"))["designs"]

    names: dict[int, str] = {}
    for path in sorted(glob.glob(SHARD_GLOB)):
        for design_id, draft in json.loads(Path(path).read_text(encoding="utf-8")).items():
            names[int(design_id)] = draft.get("name", "")

    rows, splits, design_ids = [], [], []
    for record in index:
        rows.append(build_row(record))
        design_ids.append(int(record["id"]))
        internal = names.get(int(record["id"]), "")
        match = FAMILY_RE.match(internal)
        splits.append(assign_split(match.group(1) if match else internal))

    features = np.array(
        [[row[name] for name in FEATURE_NAMES] for row in rows], dtype=np.float32
    )
    targets = {
        key: np.array([record.get(key, 0.0) for record in index], dtype=np.float64)
        for key in TARGET_KEYS
    }
    return features, targets, np.array(splits), np.array(design_ids, dtype=np.int64)


def trainable_mask(key: str, values: np.ndarray) -> np.ndarray:
    """A KPI of 0 is a failed analysis, not a physical zero.

    Same rule as is_available_metric in ml/common.py and isAvailableMetric in
    lib/aerotwin-types.ts.
    """
    mask = np.isfinite(values) & (values > 0)
    if key == "mass":
        mask &= values < MASS_CEILING_KG
    return mask


def r2(actual: np.ndarray, predicted: np.ndarray) -> float:
    if actual.size < 2:
        return float("nan")
    denominator = ((actual - actual.mean()) ** 2).sum()
    if denominator <= 0:
        return float("nan")
    return float(1.0 - ((actual - predicted) ** 2).sum() / denominator)
