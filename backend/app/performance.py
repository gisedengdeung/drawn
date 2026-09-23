"""Conditional trim inference. Missing/unverified models never return mock values."""
from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from . import performance_param
from .core.errors import ApiError
from .performance_features import TARGETS, draft_features, finite, transform, unsupported_changes

router = APIRouter()
logger = logging.getLogger(__name__)
_runtime: "Runtime | None" = None
_status: dict[str, Any] = {"ready": False, "reason": "not_initialized", "modelVersion": None}
_fallback_status: dict[str, Any] = {"ready": False, "reason": "not_initialized", "modelVersion": None}


class PredictionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    designId: int = Field(gt=0)
    draft: dict[str, Any] | None = None
    speeds: list[float] = Field(default_factory=lambda: list(range(51)), min_length=1, max_length=51)

    @field_validator("speeds", mode="before")
    @classmethod
    def valid_speeds(cls, values):
        if not isinstance(values, list) or any(not finite(v) or not 0 <= v <= 50 for v in values):
            raise ValueError("Speeds must be finite numbers between 0 and 50 m/s")
        if len(set(values)) != len(values):
            raise ValueError("Duplicate speeds are not supported")
        return values


def checksum(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Runtime:
    def __init__(self, directory: Path):
        import torch

        self.torch = torch
        torch.set_num_threads(2)
        self.manifest = json.loads((directory / "manifest.json").read_text("utf-8"))
        if self.manifest.get("schemaVersion") != 1:
            raise ValueError("Unsupported model manifest")
        for name in ("preprocessing.json", "weights.npz", "golden.json"):
            if checksum(directory / name) != self.manifest["files"][name]["sha256"]:
                raise ValueError("Model artifact checksum mismatch")
        self.preprocessing = json.loads((directory / "preprocessing.json").read_text("utf-8"))
        if self.preprocessing["target_columns"] != ["target_" + name for name in TARGETS]:
            raise ValueError("Unexpected target order")
        if self.manifest.get("activation") != "silu":
            raise ValueError("Unsupported model architecture")
        layers = []
        for left, right in zip((274, 256, 256), (256, 256, 128)):
            layers.extend([torch.nn.Linear(left, right), torch.nn.SiLU(), torch.nn.Dropout(.05)])
        layers.append(torch.nn.Linear(128, 8))
        self.model = torch.nn.Sequential(*layers)
        with np.load(directory / "weights.npz", allow_pickle=False) as arrays:
            state = {name: torch.from_numpy(arrays[name].copy()) for name in arrays.files}
        self.model.load_state_dict(state, strict=True)
        self.model.eval()
        self.version = self.manifest["modelVersion"]
        self.eligible = set(self.manifest["eligibleDesignIds"])
        self.golden = json.loads((directory / "golden.json").read_text("utf-8"))

    def predict(self, matrix):
        with self.torch.inference_mode():
            scaled = self.model(self.torch.from_numpy(matrix)).numpy()
        # sklearn's inverse_transform operates on float32 in two in-place steps.
        scaled *= np.asarray(self.preprocessing["target_scale"], dtype=np.float64)
        scaled += np.asarray(self.preprocessing["target_mean"], dtype=np.float64)
        if not np.isfinite(scaled).all():
            raise ValueError("Nonfinite model prediction")
        return scaled

    def verify(self) -> dict:
        matrix, _, _ = transform(self.golden["inputs"], self.preprocessing, encoded=True)
        actual = self.predict(matrix)
        expected = np.asarray(self.golden["expected"], dtype=np.float64)
        difference = np.abs(actual - expected)
        passed = bool(np.allclose(actual, expected, rtol=2e-6, atol=1e-4))
        return {"passed": passed, "rows": len(actual), "rtol": 2e-6, "atol": 1e-4,
                "maxAbsoluteByTarget": dict(zip(TARGETS, difference.max(axis=0).tolist()))}


def initialize(settings) -> dict:
    global _runtime, _status, _fallback_status
    _runtime = None
    _status = {"ready": False, "reason": "artifact_missing", "modelVersion": None}
    # The parameter fallback loads independently: it answers the designs the
    # anchored model refuses, so it must come up even when that one does not.
    _fallback_status = performance_param.initialize(
        Path(settings.model_dir).parent / "models" / "trim_param"
    )
    directory = Path(settings.model_dir)
    if not (directory / "manifest.json").is_file():
        return dict(_status)
    try:
        candidate = Runtime(directory)
        verification = candidate.verify()
        _status = {"ready": False, "reason": "verification_pending", "modelVersion": candidate.version,
                   "verification": verification, "source": "baseline-conditioned"}
        if verification["passed"] and candidate.manifest.get("architectureVerified") is True:
            _runtime = candidate
            _status.update(ready=True, reason=None)
    except ImportError:
        _status["reason"] = "runtime_missing"
    except Exception:
        logger.exception("Performance model initialization failed")
        _status["reason"] = "artifact_invalid"
    return dict(_status)


def status() -> dict:
    return {**_status, "fallback": dict(_fallback_status)}


@router.get("/performance/model")
def model_status():
    return status()


@router.post("/performance/predict")
def predict(body: PredictionRequest, request: Request):
    return predict_design(request.app.state.settings, body.designId, body.draft, body.speeds)


def _physical_bounds(target: str, value: float) -> bool:
    """Same rule the conditioned path uses, so both sources blank the same cells."""
    return ((target in ("drag", "thrust", "power", "current", "distance") and value < 0)
            or (target == "flightTime" and value <= 0))


def _predict_from_parameters(features: dict, draft: dict, baseline: dict,
                             body: "PredictionRequest") -> dict:
    """Answer from design parameters when the anchored model has no inputs.

    Returns the same shape as the conditioned path - eight targets per
    requested speed - so the client renders one curve either way. Only `source`
    differs, and callers must use it: this model is measurably less accurate,
    and two of its outputs carry restrictions the conditioned one does not.
    """
    from .domain.draft import fingerprint

    if not performance_param.is_ready():
        raise ApiError(422, "model_input_unavailable",
                       "이 모델에 필요한 유효한 원본 호버 입력이 없습니다.")
    try:
        values = performance_param.predict(features, body.speeds)
    except (ValueError, KeyError, TypeError):
        raise ApiError(422, "model_input_invalid",
                       "모델 입력 또는 예측값을 확인할 수 없습니다.") from None

    predictions = []
    for speed, row in zip(body.speeds, values):
        warnings, fields = [], {}
        for target, raw in zip(TARGETS, row):
            value = float(raw)
            invalid = _physical_bounds(target, value)
            # Some targets are withheld rather than shown; see UNRELIABLE in
            # performance_param for the measurement behind each one.
            fields[target] = None if invalid or target in performance_param.UNRELIABLE else value
            if invalid:
                warnings.append("physical_bound:" + target)
            elif target in performance_param.UNRELIABLE:
                warnings.append("unreliable:" + target)
        predictions.append({"speed": speed, **fields,
                            "rawPredictions": dict(zip(TARGETS, map(float, row))),
                            "warnings": warnings,
                            "outsideTrainingRange": [], "unknownCategory": []})

    withheld = [name for name in performance_param.UNRELIABLE if name in TARGETS]
    return {"modelVersion": performance_param.version(), "source": "parameter-only",
            "fingerprint": fingerprint(draft), "designId": body.designId,
            "predictions": predictions,
            "warnings": ["원본 호버·20m/s 값이 없어 설계 파라미터만으로 추정했습니다.",
                         "조건부 모델보다 정확도가 낮습니다. 오차가 큰 항목은 값을 비워 둡니다.",
                         "비행 시간은 긴 쪽을 낮게 추정하므로 설계 순위 비교에 쓰지 마세요.",
                         "비행 유효성과 최고 속도는 이 모델이 예측하지 않습니다."],
            "withheldTargets": withheld,
            "notForRanking": [name for name in performance_param.NOT_FOR_RANKING
                              if name in TARGETS and name not in withheld],
            "unsupportedInputs": unsupported_changes(draft, baseline),
            "outsideTrainingRange": [], "unknownCategory": []}


def predict_design(settings, design_id: int, draft: dict | None = None,
                   speeds: list[float] | None = None) -> dict:
    body = PredictionRequest(designId=design_id, draft=draft,
                             speeds=speeds if speeds is not None else list(range(51)))
    # Fails closed only when neither model can answer. The parameter fallback is
    # a separately trained model with its own load-time checks, not a mock, so
    # an unverified bundle no longer takes the whole endpoint down with it.
    if _runtime is None and not performance_param.is_ready():
        raise ApiError(503, "model_not_ready", "학습 모델 검증이 완료되지 않아 예측을 사용할 수 없습니다.")
    from .domain.draft import fingerprint, validate_draft
    from .services.dataset import catalogs, load_context, load_design

    baseline = load_design(settings, body.designId)
    draft = body.draft if body.draft is not None else baseline
    if draft.get("baselineId") != body.designId:
        raise ApiError(400, "design_mismatch", "기준 설계가 일치하지 않습니다.")
    draft = validate_draft(draft, baseline, catalogs(settings))
    context = load_context(settings, draft)
    selected = context["selected"]
    features = draft_features(selected, draft)
    if _runtime is None or body.designId not in _runtime.eligible:
        # Either the bundle did not verify, or this design has no measured
        # hover/20 m/s anchors. Answer from parameters instead of refusing.
        return _predict_from_parameters(features, draft, baseline, body)
    try:
        matrix, unknown, outside = transform([{**features, "speed": speed} for speed in body.speeds], _runtime.preprocessing)
        values = _runtime.predict(matrix)
    except (ValueError, KeyError, TypeError):
        raise ApiError(422, "model_input_invalid", "모델 입력 또는 예측값을 확인할 수 없습니다.") from None
    predictions = []
    for speed, row, unseen, bounds in zip(body.speeds, values, unknown, outside):
        warnings, fields = [], {}
        for target, raw in zip(TARGETS, row):
            value = float(raw)
            invalid = ((target in ("drag", "thrust", "power", "current", "distance") and value < 0)
                       or (target == "flightTime" and value <= 0))
            fields[target] = None if invalid else value
            if invalid:
                warnings.append("physical_bound:" + target)
        predictions.append({"speed": speed, **fields, "rawPredictions": dict(zip(TARGETS, map(float, row))), "warnings": warnings,
                            "outsideTrainingRange": bounds, "unknownCategory": unseen})
    return {"modelVersion": _runtime.version, "source": "baseline-conditioned",
            "fingerprint": fingerprint(draft), "designId": body.designId,
            "predictions": predictions,
            "warnings": ["기준 설계의 호버·20m/s 시뮬레이션 값을 조건으로 사용했습니다.",
                         "비행 유효성과 최고 속도는 이 모델이 예측하지 않습니다."],
            "unsupportedInputs": unsupported_changes(draft, baseline),
            "outsideTrainingRange": sorted({name for row in outside for name in row}),
            "unknownCategory": sorted({name for row in unknown for name in row})}
