"""Parameter-only trim inference, for designs the anchored model cannot serve.

The model in `model_bundle` is conditioned on five measured trim values taken
from the design's own analysis - dragAt20, powerAt20, powerAt0, thrustAt0 and
currentAt0. Those exist for 6,409 of 27,714 designs, and for none that a user
has just edited, so `performance.predict_design` answered 422 and the panel
showed no numbers at all. Editing is the feature this endpoint exists for.

This runs the same eight targets over the same speeds from design parameters
alone. Component names carry what the anchors were standing in for:

    t_motor_AT4125KV540          -> motorKv 540
    apc_propellers_20x10E        -> propDiameterIn 20, propPitchIn 10
    TurnigyGraphene5000mAh3S75C  -> battMah 5000, battSeries 3, battC 75

Dropping the anchors costs accuracy, measured on the identical test rows:

    drag       0.983 vs 0.986      distance    0.954 vs 0.991
    thrust     0.953 vs 0.990      flightTime  0.933 vs 0.991
    current    0.838 vs 0.965      power       0.732 vs 0.966
    pitch      0.602 vs 0.501      lift        0.137 vs 0.292

So the anchored model stays first choice wherever it can run. Details in
ml/reports/trim_param_evaluation.json.
"""

from __future__ import annotations

import json
import logging
import math
import re
from pathlib import Path
from typing import Any

import numpy as np

from .performance_features import TARGETS, finite

logger = logging.getLogger(__name__)

MM_PER_INCH = 25.4
NOMINAL_CELL_VOLTS = 3.7

# Alphabetical after "speed", matching ml/param_features.py. XGBoost validates
# feature names, so a mismatch raises instead of scrambling columns.
PARAM_FEATURES = (
    "armLength", "battCRate", "battMah", "battParallel", "battSeries",
    "battWhApprox", "discLoadingProxy", "fuselageHorizontalDiameter",
    "fuselageLength", "fuselageVerticalDiameter", "hubArity", "hubSymmetric",
    "maxArmLength", "meanArmLength", "meanWingChord", "motorKv", "numPropellers",
    "numWings", "parameterCount", "propDiameterIn", "propPitchIn", "totalWingSpan",
)
FEATURE_ORDER = ("speed",) + PARAM_FEATURES

# Shown, but the top decile is under-predicted by 46% of the IQR, so the
# longest-endurance designs are ranked below shorter ones. Fine to display,
# never to sort or search on. See shrinkage_watch in
# ml/reports/trim_param_evaluation.json.
NOT_FOR_RANKING = ("flightTime",)

# Blanked rather than shown, each for its own reason.
#
# lift  - identically zero on the 77% of designs that have no wings, so there is
#         almost nothing to learn. It also sat out the retraining, because
#         ml/data/trims.npz carries six targets and lift is not one of them, so
#         its booster still comes from the eligible-only source. On designs held
#         out by both splits it scores R2 -3.209, worse than predicting the mean.
#
# pitch - the retraining fixed the other targets but not this one. Outside the
#         original training population it went from R2 0.196 to 0.083, and on
#         designs whose trim solve converged at three or fewer speeds, 0.343 to
#         0.142 (ml/reports/fallback_coverage.json). Mixing barely-converged
#         designs into training appears to have cost pitch elsewhere too.
#
# power was here until the model was retrained on all 27,714 designs rather than
# the 6,409 with measured anchors. Outside the training population it rose from
# R2 0.641 to 0.832, and on the sparse designs from 0.223 to 0.575, while its
# top-decile shrinkage fell from 32% of the IQR to 9%. It is returned again.
UNRELIABLE = ("lift", "pitch")

_boosters: dict[str, Any] = {}
_version: str | None = None


def _motor_kv(name: str | None) -> float:
    """t_motor spells KV out; KDE puts it after the frame size."""
    text = name or ""
    match = re.search(r"KV(\d+)", text, re.IGNORECASE)
    if match:
        return float(match.group(1))
    match = re.search(r"KDE\d+XF_(\d+)", text)
    return float(match.group(1)) if match else math.nan


def _propeller(name: str | None) -> tuple[float, float]:
    match = re.match(r"apc_propellers_([\d_]+)x([\d_]+)", name or "")
    if not match:
        return (math.nan, math.nan)
    try:
        return (float(match.group(1).replace("_", ".")),
                float(match.group(2).replace("_", ".")))
    except ValueError:
        return (math.nan, math.nan)


def _battery(name: str | None) -> tuple[float, float, float, float]:
    """Tattu writes 6S1P; Turnigy writes only 3S, and no P suffix means one pack."""
    text = name or ""
    capacity = re.search(r"(\d+)mAh", text)
    series = re.search(r"(\d+)S", text)
    parallel = re.search(r"\d+S(\d+)P", text)
    rate = re.search(r"(\d+)C\d+mAh", text) or re.search(r"\d+S(\d+)C", text)
    return (
        float(capacity.group(1)) if capacity else math.nan,
        float(series.group(1)) if series else math.nan,
        float(parallel.group(1)) if parallel else (1.0 if series else math.nan),
        float(rate.group(1)) if rate else math.nan,
    )


def _hub(name: str | None) -> tuple[float, float]:
    match = re.search(r"Hub(\d+)", name or "")
    return (float(match.group(1)) if match else math.nan,
            1.0 if "Sym" in (name or "") else 0.0)


def parameter_row(features: dict) -> dict[str, float]:
    """Turn `draft_features` output into the model's inputs.

    `draft_features` already reads the edited draft rather than the baseline,
    so arm lengths and fuselage dimensions reflect what the user changed. Only
    the component names still need parsing, plus two derived quantities.
    """
    diameter, pitch = _propeller(features.get("primaryPropeller"))
    capacity, series, parallel, c_rate = _battery(features.get("primaryBattery"))
    arity, symmetric = _hub(features.get("hub"))

    watt_hours = (
        capacity / 1000.0 * series * NOMINAL_CELL_VOLTS * parallel
        if finite(capacity) and finite(series) and finite(parallel)
        else math.nan
    )

    rotors = float(features.get("numPropellers") or 0)
    disc_loading = math.nan
    if finite(diameter) and rotors > 0:
        area = rotors * math.pi * (diameter * MM_PER_INCH / 2000.0) ** 2
        disc_loading = 1.0 / area if area > 0 else math.nan

    row = {
        name: float(features.get(name) or 0.0)
        for name in (
            "armLength", "fuselageHorizontalDiameter", "fuselageLength",
            "fuselageVerticalDiameter", "maxArmLength", "meanArmLength",
            "meanWingChord", "numPropellers", "numWings", "parameterCount",
            "totalWingSpan",
        )
    }
    row.update(
        motorKv=_motor_kv(features.get("primaryMotor")),
        propDiameterIn=diameter, propPitchIn=pitch,
        battMah=capacity, battSeries=series, battParallel=parallel,
        battCRate=c_rate, battWhApprox=watt_hours,
        hubArity=arity, hubSymmetric=symmetric, discLoadingProxy=disc_loading,
    )
    return row


def initialize(directory: Path) -> dict:
    """Load one booster per target. Absent files leave the fallback disabled."""
    global _boosters, _version
    _boosters, _version = {}, None

    missing = [name for name in TARGETS if not (directory / f"{name}.json").is_file()]
    if len(missing) == len(TARGETS):
        return {"ready": False, "reason": "artifact_missing", "modelVersion": None}
    if missing:
        return {"ready": False, "reason": "artifact_incomplete", "modelVersion": None,
                "missingTargets": missing}
    try:
        import xgboost as xgb
    except ImportError:
        return {"ready": False, "reason": "runtime_missing", "modelVersion": None}

    try:
        newest = 0
        for name in TARGETS:
            path = directory / f"{name}.json"
            booster = xgb.Booster()
            booster.load_model(str(path))
            if list(booster.feature_names or ()) != list(FEATURE_ORDER):
                raise ValueError(f"Feature order mismatch in {name}.json")
            _boosters[name] = booster
            newest = max(newest, path.stat().st_mtime_ns)
        _version = f"trim-param-v1-{newest}"
    except Exception:
        logger.exception("Parameter fallback initialization failed")
        _boosters, _version = {}, None
        return {"ready": False, "reason": "artifact_invalid", "modelVersion": None}

    return {"ready": True, "reason": None, "modelVersion": _version,
            "source": "parameter-only", "notForRanking": list(NOT_FOR_RANKING),
            "unreliable": list(UNRELIABLE)}


def is_ready() -> bool:
    return bool(_boosters)


def version() -> str | None:
    return _version


def predict(features: dict, speeds: list[float]) -> list[list[float]]:
    """One row of eight target values per requested speed."""
    import xgboost as xgb

    row = parameter_row(features)
    matrix = np.array(
        [[float(speed)] + [row[name] for name in PARAM_FEATURES] for speed in speeds],
        dtype=np.float32,
    )
    data = xgb.DMatrix(matrix, feature_names=list(FEATURE_ORDER))
    columns = [_boosters[name].predict(data) for name in TARGETS]
    values = np.column_stack(columns).astype(np.float64)
    if not np.isfinite(values).all():
        raise ValueError("Nonfinite fallback prediction")
    return values.tolist()
