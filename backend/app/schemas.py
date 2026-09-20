"""Request/response contracts for the performance-prediction API.

Two independent models are served here:
- `/predict` — the "파라미터 편집" (Design Lab) model. Predicts a handful of
  aggregate summary values (max distance, hover time, ...) for an edited
  design. Not delivered yet, so this stays an open feature dict until the
  real training pipeline (XGBoost) is finalized.
- `/predict/trim` — the "성능 확인" (Simulator) model. A trained PyTorch MLP
  that predicts the 8 trim values at one query speed for one design; its
  input fields map 1:1 onto `DesignSummary` in the frontend plus `speed`.
"""

from typing import Dict, Optional

from pydantic import BaseModel, ConfigDict, Field


class PredictionRequest(BaseModel):
    design_id: Optional[int] = Field(
        default=None,
        description="Baseline dataset design id this prediction is for, if any.",
    )
    features: Dict[str, float] = Field(
        default_factory=dict,
        description=(
            "Named numeric features matching the model's training columns "
            "(e.g. armLength, numPropellers, numWings, mass, motorKv, ...)."
        ),
    )


class PredictionResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    max_distance_m: Optional[float] = None
    hover_time_s: Optional[float] = None
    max_speed_mps: Optional[float] = None
    power_w: Optional[float] = None
    drag_at_20_n: Optional[float] = None
    mass_kg: Optional[float] = None
    model_version: str
    is_mock: bool = Field(
        description="True while no trained model file is loaded, so callers "
        "can tell a placeholder estimate apart from a real prediction.",
    )


class TrimPredictionRequest(BaseModel):
    design_id: Optional[int] = Field(default=None, description="Baseline dataset design id, if any.")
    speed: float = Field(description="Query speed in m/s — the point on the trim curve to predict.")
    numPropellers: float
    numWings: float
    armLength: float
    meanArmLength: float
    maxArmLength: float
    fuselageLength: float
    fuselageHorizontalDiameter: float
    fuselageVerticalDiameter: float
    totalWingSpan: float
    meanWingChord: float
    parameterCount: float
    hub: Optional[str] = Field(default=None, description="Topology string, e.g. ConnectedHub6_Sym.")
    primaryMotor: Optional[str] = None
    primaryPropeller: Optional[str] = None
    primaryBattery: Optional[str] = None
    dragAt20: float
    powerAt20: float
    powerAt0: float
    thrustAt0: float
    currentAt0: float


class TrimPredictionResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    drag: float
    lift: float
    thrust: float
    pitch: float
    power: float
    current: float
    flightTime: float
    distance: float
    model_version: str
    is_mock: bool = Field(
        description="True while no trained model file is loaded, so callers "
        "can tell a placeholder estimate apart from a real prediction.",
    )


class HealthResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    status: str
    summary_model_loaded: bool
    summary_model_version: str
    trim_model_loaded: bool
    trim_model_version: str
