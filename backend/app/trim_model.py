"""Loads the trim-prediction MLP and runs speed-conditioned predictions.

This is the "성능 확인" (Simulator) model: given one design's geometry/part
mix plus a query speed, it predicts the 8 trim values at that speed (drag,
lift, thrust, pitch, power, current, flightTime, distance) — one point on the
speed curve, not a single aggregate summary. That's `model.py`'s job (the
"파라미터 편집" / Design Lab model, a separate XGBoost model not delivered yet).

Drop `trim_mlp.pt` (PyTorch checkpoint) and `trim_preprocessor.pkl`
(scikit-learn ColumnTransformer + target scaler + category encoders) into
`backend/models/` and this module picks them up automatically on the next
server start. Until both files exist, `predict_trim()` returns a simple
deterministic mock.
"""

from pathlib import Path
from typing import Dict, List, Optional

MODEL_DIR = Path(__file__).resolve().parent.parent / "models"
CHECKPOINT_PATH = MODEL_DIR / "trim_mlp.pt"
PREPROCESSOR_PATH = MODEL_DIR / "trim_preprocessor.pkl"
MOCK_VERSION = "mock-0"

TARGET_KEYS = [
    "drag", "lift", "thrust", "pitch", "power", "current", "flightTime", "distance",
]
NUMERIC_FEATURE_KEYS = [
    "speed", "numPropellers", "numWings", "armLength", "meanArmLength", "maxArmLength",
    "fuselageLength", "fuselageHorizontalDiameter", "fuselageVerticalDiameter",
    "totalWingSpan", "meanWingChord", "parameterCount",
    "dragAt20", "powerAt20", "powerAt0", "thrustAt0", "currentAt0",
]

# Populated by load_model() at startup; stays None until both model files
# are found, in which case predict_trim() falls back to the mock below.
_net = None
_preprocessor = None
_version = MOCK_VERSION


def _build_network(input_dim: int, hidden: List[int], output_dim: int, dropout: float):
    from torch import nn

    layers: List[nn.Module] = []
    sizes = [input_dim, *hidden]
    for in_size, out_size in zip(sizes, sizes[1:]):
        layers += [nn.Linear(in_size, out_size), nn.ReLU(), nn.Dropout(dropout)]
    layers.append(nn.Linear(sizes[-1], output_dim))
    return nn.Sequential(*layers)


def load_model() -> None:
    global _net, _preprocessor, _version
    if not CHECKPOINT_PATH.exists() or not PREPROCESSOR_PATH.exists():
        _net = None
        _preprocessor = None
        _version = MOCK_VERSION
        return
    # Imported lazily so the mock path has no dependency on torch/sklearn/pandas.
    import torch
    import joblib

    checkpoint = torch.load(CHECKPOINT_PATH, map_location="cpu", weights_only=False)
    net = _build_network(
        checkpoint["input_dim"],
        checkpoint["hidden"],
        len(checkpoint["target_columns"]),
        checkpoint["dropout"],
    )
    net.load_state_dict(checkpoint["state_dict"])
    net.eval()
    _net = net
    _preprocessor = joblib.load(PREPROCESSOR_PATH)
    _version = f"trim-mlp-epoch{checkpoint['best_epoch']}"


def is_model_loaded() -> bool:
    return _net is not None


def model_version() -> str:
    return _version


def _safe_category_code(category: str, raw_value: Optional[str]) -> int:
    """Maps a raw part/topology string to the trained integer code. Unseen
    values (including None) get an out-of-range code, which the saved
    OneHotEncoder(handle_unknown="ignore") turns into an all-zero block
    instead of raising — see verification.json / config.json's note on
    unknown categories."""
    if raw_value is None or _preprocessor is None:
        return -1
    encoder = _preprocessor["category_encoders"][category]
    try:
        return int(encoder.transform([raw_value])[0])
    except ValueError:
        return -1


def _mock_predict_trim(features: Dict[str, float]) -> Dict[str, float]:
    speed = features.get("speed", 0.0) or 0.0
    num_propellers = features.get("numPropellers", 4.0) or 4.0
    return {
        "drag": 0.02 * speed**2 * num_propellers,
        "lift": 0.0,
        "thrust": max(0.0, 60.0 - speed * 1.2),
        "pitch": -10.0 - speed * 0.3,
        "power": 200.0 + speed * 40.0,
        "current": 20.0 + speed * 3.0,
        "flightTime": max(0.0, 900.0 - speed * 15.0),
        "distance": speed * 60.0,
    }


def predict_trim(
    features: Dict[str, float],
    hub: Optional[str],
    primary_motor: Optional[str],
    primary_propeller: Optional[str],
    primary_battery: Optional[str],
) -> Dict[str, float]:
    if _net is None or _preprocessor is None:
        return _mock_predict_trim(features)

    import pandas as pd
    import torch

    row = {key: features.get(key, 0.0) for key in NUMERIC_FEATURE_KEYS}
    # Designs whose simulation never reached 20 m/s store the At20 hints as
    # placeholder zeros, and the model has to be told that rather than reading
    # a zero as a real measurement. Derived here instead of taken from the
    # caller so it can never drift out of sync with the hints it describes.
    row["trim20_available"] = 1.0 if (features.get("powerAt20") or 0) > 0 else 0.0
    row["hub_enc"] = _safe_category_code("hub", hub)
    row["primaryMotor_enc"] = _safe_category_code("primaryMotor", primary_motor)
    row["primaryPropeller_enc"] = _safe_category_code("primaryPropeller", primary_propeller)
    row["primaryBattery_enc"] = _safe_category_code("primaryBattery", primary_battery)

    frame = pd.DataFrame([row])
    encoded = _preprocessor["input_transformer"].transform(frame)
    with torch.no_grad():
        scaled_output = _net(torch.tensor(encoded, dtype=torch.float32)).numpy()
    real_output = _preprocessor["target_scaler"].inverse_transform(scaled_output)[0]
    return dict(zip(TARGET_KEYS, (float(value) for value in real_output)))
