"""Request/response contracts for the performance-prediction API.

The exact feature set is whatever the XGBoost model ends up trained on, so
`features` stays an open dict of named numeric values rather than a fixed
schema. Once the real training pipeline is finalized, tighten this to a
concrete set of required fields if that's more convenient for validation.
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


class HealthResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    status: str
    model_loaded: bool
    model_version: str
