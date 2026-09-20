"""Loads the trained performance-prediction model and runs predictions.

Drop the trained model in `backend/models/performance_model.json`
(XGBoost's native format) and this module picks it up automatically on the
next server start. Until that file exists, `predict()` returns a simple
deterministic mock so the API contract can be developed against before the
real model is ready.
"""

from pathlib import Path
from typing import Dict, Optional

MODEL_DIR = Path(__file__).resolve().parent.parent / "models"
MODEL_PATH = MODEL_DIR / "performance_model.json"
MOCK_VERSION = "mock-0"

# Populated by load_model() at startup; stays None until a real model file
# is found, in which case predict() falls back to the mock estimate below.
_model = None
_model_version = MOCK_VERSION


def load_model() -> None:
    global _model, _model_version
    if not MODEL_PATH.exists():
        _model = None
        _model_version = MOCK_VERSION
        return
    import xgboost as xgb  # Imported lazily so the mock path has no dependency on it.

    booster = xgb.Booster()
    booster.load_model(str(MODEL_PATH))
    _model = booster
    _model_version = MODEL_PATH.stat().st_mtime_ns.__str__()


def is_model_loaded() -> bool:
    return _model is not None


def model_version() -> str:
    return _model_version


def _mock_predict(features: Dict[str, float]) -> Dict[str, Optional[float]]:
    """A rough, clearly-labeled-as-fake estimate so the endpoint is usable
    before the trained model exists. Mirrors the app's existing nearest-
    neighbor estimate direction (heavier -> shorter range/hover, faster ->
    more drag/power) without claiming any real accuracy.
    """
    mass = features.get("mass", 3.0) or 3.0
    arm_length = features.get("armLength", 250.0) or 250.0
    num_propellers = features.get("numPropellers", 4.0) or 4.0

    power = 150.0 * num_propellers * (mass ** 0.5)
    max_speed = max(5.0, 30.0 - mass * 1.5)
    return {
        "max_distance_m": max(0.0, 6000.0 / max(mass, 0.5) - arm_length * 0.5),
        "hover_time_s": max(0.0, 900.0 / max(mass, 0.5)),
        "max_speed_mps": max_speed,
        "power_w": power,
        "drag_at_20_n": 0.02 * arm_length * num_propellers ** 0.5,
        "mass_kg": mass,
    }


def predict(features: Dict[str, float]) -> Dict[str, Optional[float]]:
    if _model is None:
        return _mock_predict(features)

    import xgboost as xgb

    ordered_keys = sorted(features.keys())
    matrix = xgb.DMatrix([[features[key] for key in ordered_keys]], feature_names=ordered_keys)
    raw = _model.predict(matrix)[0]
    # A real model likely outputs a fixed-order vector; adjust this mapping
    # to match however the training pipeline orders its targets.
    return {
        "max_distance_m": float(raw[0]) if len(raw) > 0 else None,
        "hover_time_s": float(raw[1]) if len(raw) > 1 else None,
        "max_speed_mps": float(raw[2]) if len(raw) > 2 else None,
        "power_w": float(raw[3]) if len(raw) > 3 else None,
        "drag_at_20_n": float(raw[4]) if len(raw) > 4 else None,
        "mass_kg": features.get("mass"),
    }
