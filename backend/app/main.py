from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import model, trim_model
from .schemas import (
    HealthResponse,
    PredictionRequest,
    PredictionResponse,
    TrimPredictionRequest,
    TrimPredictionResponse,
)

app = FastAPI(
    title="Drawn Performance Prediction API",
    description=(
        "Serves two models: the Design Lab summary predictor (/predict) and "
        "the Simulator trim-curve predictor (/predict/trim)."
    ),
    version="0.2.0",
)

# The Next.js dev server and any deployed frontend origin need to be allowed
# here; tighten this list once a production frontend URL is known.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _load_models_on_startup() -> None:
    model.load_model()
    trim_model.load_model()


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        summary_model_loaded=model.is_model_loaded(),
        summary_model_version=model.model_version(),
        trim_model_loaded=trim_model.is_model_loaded(),
        trim_model_version=trim_model.model_version(),
    )


@app.post("/predict", response_model=PredictionResponse)
def predict(request: PredictionRequest) -> PredictionResponse:
    result = model.predict(request.features)
    return PredictionResponse(
        **result,
        model_version=model.model_version(),
        is_mock=not model.is_model_loaded(),
    )


@app.post("/predict/trim", response_model=TrimPredictionResponse)
def predict_trim(request: TrimPredictionRequest) -> TrimPredictionResponse:
    features = request.model_dump(exclude={"design_id", "hub", "primaryMotor", "primaryPropeller", "primaryBattery"})
    result = trim_model.predict_trim(
        features,
        hub=request.hub,
        primary_motor=request.primaryMotor,
        primary_propeller=request.primaryPropeller,
        primary_battery=request.primaryBattery,
    )
    return TrimPredictionResponse(
        **result,
        model_version=trim_model.model_version(),
        is_mock=not trim_model.is_model_loaded(),
    )
