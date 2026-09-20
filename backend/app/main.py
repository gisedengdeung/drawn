from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import model
from .schemas import HealthResponse, PredictionRequest, PredictionResponse

app = FastAPI(
    title="Drawn Performance Prediction API",
    description="Serves the XGBoost drone-performance model for edited designs.",
    version="0.1.0",
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
def _load_model_on_startup() -> None:
    model.load_model()


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        model_loaded=model.is_model_loaded(),
        model_version=model.model_version(),
    )


@app.post("/predict", response_model=PredictionResponse)
def predict(request: PredictionRequest) -> PredictionResponse:
    result = model.predict(request.features)
    return PredictionResponse(
        **result,
        model_version=model.model_version(),
        is_mock=not model.is_model_loaded(),
    )
