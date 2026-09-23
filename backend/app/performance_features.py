"""Training-compatible raw features; simulation anchors stay server-owned."""
from __future__ import annotations

import math
from typing import Any

import numpy as np

ANCHORS = ("dragAt20", "powerAt20", "powerAt0", "thrustAt0", "currentAt0")
TARGETS = ("drag", "lift", "thrust", "pitch", "power", "current", "flightTime", "distance")
CATEGORIES = ("hub", "primaryMotor", "primaryPropeller", "primaryBattery")


def finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def draft_features(selected: dict, draft: dict) -> dict:
    """Mirror prepare-aircraftverse.mjs, including positive-only dimensions."""
    segments, wings = draft.get("segments", []), draft.get("wings", [])
    lengths = [s["length"] for s in segments if finite(s.get("length")) and s["length"] > 0]
    spans = [w["span"] for w in wings if finite(w.get("span")) and w["span"] > 0]
    chords = [w[k] for w in wings for k in ("chordInner", "chordOuter")
              if finite(w.get(k)) and w[k] > 0]
    fuselage = draft["fuselage"]
    propulsion = draft.get("propulsionGroups", [])
    first = propulsion[0] if propulsion else {}
    batteries = draft.get("energy", {}).get("batteryTypes", [])
    return {
        "numPropellers": draft["numPropellers"], "numWings": draft["numWings"],
        "armLength": segments[0].get("length", 0) if segments else 0,
        "meanArmLength": sum(lengths) / max(len(lengths), 1),
        "maxArmLength": max(lengths, default=0),
        "fuselageLength": fuselage["length"],
        "fuselageHorizontalDiameter": fuselage["horizontalDiameter"],
        "fuselageVerticalDiameter": fuselage["verticalDiameter"],
        "totalWingSpan": sum(spans), "meanWingChord": sum(chords) / max(len(chords), 1),
        "parameterCount": len(draft.get("sourceParameters", [])),
        "hub": draft["topology"], "primaryMotor": first.get("motorType"),
        "primaryPropeller": first.get("propellerType"),
        "primaryBattery": batteries[0] if batteries else None,
        **{name: selected[name] for name in ANCHORS},
    }


def transform(rows: list[dict], preprocessing: dict, *, encoded: bool = False):
    """Apply persisted scales/categories; never fit anything at serving time."""
    numeric, blocks, unknown, outside = [], [], [], []
    means = np.asarray(preprocessing["numeric_mean"], dtype=np.float64)
    scales = np.asarray(preprocessing["numeric_scale"], dtype=np.float64)
    for source in rows:
        row = dict(source)
        row["trim20_available"] = float(finite(row.get("powerAt20")) and row["powerAt20"] > 0)
        values = [row[name] for name in preprocessing["numeric_columns"]]
        if not all(finite(v) for v in values):
            raise ValueError("Nonfinite or missing model input")
        numeric.append((np.asarray(values, dtype=np.float64) - means) / scales)
        block, unseen = [], []
        for name, codes in zip(CATEGORIES, preprocessing["onehot_categories"]):
            if encoded:
                code = row[name + "_enc"]
            else:
                label = row.get(name) or "Unknown"
                classes = preprocessing["category_classes"][name]
                code = classes.index(label) if label in classes else -1
            if code not in codes:
                unseen.append(name)
            block.extend(float(code == known) for known in codes)
        blocks.append(block)
        unknown.append(unseen)
        outside.append([name for name, value in zip(preprocessing["numeric_columns"], values)
                        if not preprocessing["numeric_training_bounds"][name][0] <= value <=
                        preprocessing["numeric_training_bounds"][name][1]])
    matrix = np.concatenate([np.asarray(numeric), np.asarray(blocks)], axis=1).astype(np.float32)
    if matrix.shape != (len(rows), 274) or not np.isfinite(matrix).all():
        raise ValueError("Unexpected model input shape")
    return matrix, unknown, outside


def unsupported_changes(draft: dict, baseline: dict) -> list[str]:
    result = ["mass", "maxSpeed", "flightValidity"]
    for name in ("payload", "layout"):
        if draft.get(name) != baseline.get(name):
            result.append(name)
    if draft.get("fuselage", {}).get("floorHeight") != baseline.get("fuselage", {}).get("floorHeight"):
        result.append("fuselage.floorHeight")
    if draft.get("energy", {}).get("batteryTypes", [])[1:] != baseline.get("energy", {}).get("batteryTypes", [])[1:]:
        result.append("secondaryBatteries")
    old_parameters = {item["id"]: item.get("value") for item in baseline.get("parameterDefinitions", [])}
    if any(item.get("value") != old_parameters.get(item["id"]) for item in draft.get("parameterDefinitions", [])):
        result.append("parameterDefinitions")
    for index, segment in enumerate(draft.get("segments", [])):
        original = baseline.get("segments", [])
        if index < len(original) and any(segment.get(k) != original[index].get(k) for k in ("angle", "offset")):
            result.append("segment.angle/offset")
            break
    if any(any(segment.get(key) != original.get(key) for key in ("motorType", "propellerType"))
           for segment, original in zip(draft.get("segments", []), baseline.get("segments", []))):
        result.append("segment.motorType/propellerType")
    for index, wing in enumerate(draft.get("wings", [])):
        original = baseline.get("wings", [])
        ignored = ("nacaProfile", "rotation", "aileronBias", "flapBias", "load", "tubeOffset")
        if index < len(original) and any(wing.get(k) != original[index].get(k) for k in ignored):
            result.append("wing.profile/rotation/controlSurface")
            break
    if any(wing.get("servoType") != original.get("servoType")
           for wing, original in zip(draft.get("wings", []), baseline.get("wings", []))):
        result.append("wing.servoType")
    if draft.get("propulsionGroups", [])[1:] != baseline.get("propulsionGroups", [])[1:]:
        result.append("secondaryPropulsionGroups")
    return result
