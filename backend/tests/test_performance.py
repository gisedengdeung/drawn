import copy
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from backend.app import performance
from backend.app.core.errors import ApiError
from backend.app.performance_features import TARGETS, draft_features, transform, unsupported_changes
from backend.app.services.dataset import load_context, load_design

ROOT = Path(__file__).resolve().parents[2]
SETTINGS = SimpleNamespace(data_root=ROOT / "public/data", model_dir=ROOT / "backend/model_bundle")


@pytest.fixture(scope="module")
def runtime():
    result = performance.initialize(SETTINGS)
    assert result["ready"], result
    return performance._runtime


@pytest.fixture()
def client(runtime):
    app = FastAPI()
    app.state.settings = SETTINGS
    app.include_router(performance.router, prefix="/api")

    @app.exception_handler(ApiError)
    async def failure(request, error):
        return JSONResponse({"error": {"code": error.code, "message": error.message}}, status_code=error.status)

    return TestClient(app)


def test_verified_bundle_reproduces_cpu_golden(runtime):
    assert runtime.manifest["architectureVerified"] is True
    assert "cuda-high" in runtime.manifest["verification"]["matchingOriginalReference"]
    assert runtime.verify()["passed"]
    matrix, _, _ = transform(runtime.golden["inputs"], runtime.preprocessing, encoded=True)
    assert matrix.shape == (20, 274)
    batch = runtime.predict(matrix)
    single = np.concatenate([runtime.predict(matrix[i:i + 1]) for i in range(len(matrix))])
    np.testing.assert_allclose(single, batch, rtol=2e-5, atol=1e-3)


def test_baseline_feature_extractor_matches_canonical_index(runtime):
    for design_id in (411, 17297, 20015):
        draft = load_design(SETTINGS, design_id)
        selected = load_context(SETTINGS, draft)["selected"]
        values = draft_features(selected, draft)
        for name, actual in values.items():
            assert actual == selected[name], (design_id, name, actual, selected[name])


def test_unknown_categories_and_speed_50_are_explicit(runtime):
    row = dict(runtime.golden["inputs"][0], primaryPropeller_enc=4, speed=50)
    matrix, unknown, outside = transform([row], runtime.preprocessing, encoded=True)
    assert unknown == [["primaryPropeller"]]
    assert "speed" in outside[0]
    assert not matrix[0, 18 + 10 + 48:18 + 10 + 48 + 142].any()


def test_real_prediction_shape_anchors_and_edited_geometry(client):
    original = client.post("/api/performance/predict", json={"designId": 17297, "speeds": [0, 20, 50]})
    assert original.status_code == 200, original.text
    payload = original.json()
    assert payload["source"] == "baseline-conditioned"
    assert "speed" in payload["outsideTrainingRange"]
    assert set(TARGETS).issubset(payload["predictions"][0])
    assert "mass" not in payload["predictions"][0]
    draft = load_design(SETTINGS, 17297)
    draft["fuselage"]["length"] += 5
    changed = client.post("/api/performance/predict", json={"designId": 17297, "draft": draft, "speeds": [20]})
    assert changed.status_code == 200, changed.text
    assert changed.json()["fingerprint"] != payload["fingerprint"]
    assert changed.json()["predictions"][0]["power"] != payload["predictions"][1]["power"]


@pytest.mark.parametrize("extra", [
    {"speeds": [-1]}, {"speeds": [51]}, {"speeds": [0, 0]}, {"speeds": [True]},
    {"speeds": []}, {"speeds": list(range(52))}, {"features": {"powerAt0": 1}},
])
def test_rejects_invalid_speeds_and_client_features(client, extra):
    assert client.post("/api/performance/predict", json={"designId": 17297, **extra}).status_code == 422


def test_ineligible_design_does_not_receive_mock(client, runtime):
    index = json.loads((SETTINGS.data_root / "design-index.json").read_text("utf-8"))
    design_id = next(d["id"] for d in index["designs"] if d["id"] not in runtime.eligible)
    response = client.post("/api/performance/predict", json={"designId": design_id, "speeds": [0]})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "model_input_unavailable"


def test_unready_model_fails_closed(client, monkeypatch):
    monkeypatch.setattr(performance, "_runtime", None)
    response = client.post("/api/performance/predict", json={"designId": 17297})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "model_not_ready"


def test_bundle_hash_tampering_is_rejected(tmp_path):
    for path in SETTINGS.model_dir.iterdir():
        if path.is_file():
            (tmp_path / path.name).write_bytes(path.read_bytes())
    (tmp_path / "preprocessing.json").write_text("{}", encoding="utf-8")
    with pytest.raises(ValueError, match="checksum"):
        performance.Runtime(tmp_path)


def test_ignored_floor_height_is_disclosed_without_changing_model_output(client):
    baseline = client.post("/api/performance/predict", json={"designId": 17297, "speeds": [20]}).json()
    draft = load_design(SETTINGS, 17297)
    draft["fuselage"]["floorHeight"] += 1
    response = client.post("/api/performance/predict", json={"designId": 17297, "draft": draft, "speeds": [20]})
    assert response.status_code == 200, response.text
    changed = response.json()
    assert changed["predictions"] == baseline["predictions"]
    assert changed["fingerprint"] != baseline["fingerprint"]
    assert "fuselage.floorHeight" in changed["unsupportedInputs"]


def test_all_editable_but_unmodeled_fields_are_disclosed():
    baseline = {
        "fuselage": {"length": 100, "floorHeight": 20},
        "segments": [{"length": 100, "angle": 0, "offset": 0, "motorType": "A"}],
        "wings": [{"span": 100, "servoType": "A", "rotation": 0}],
        "energy": {"batteryTypes": ["A", "B"]},
        "propulsionGroups": [{"motorType": "A"}, {"motorType": "B"}],
        "parameterDefinitions": [{"id": "control", "value": 0}],
        "payload": {"mass": 0}, "layout": {"motor": {"x": 0, "y": 0}},
    }
    draft = copy.deepcopy(baseline)
    draft["fuselage"]["length"] = 200
    draft["segments"][0]["length"] = 200
    draft["wings"][0]["span"] = 200
    draft["propulsionGroups"][0]["motorType"] = "C"
    draft["energy"]["batteryTypes"][0] = "C"
    assert unsupported_changes(draft, baseline) == ["mass", "maxSpeed", "flightValidity"]
    draft["fuselage"]["floorHeight"] = 25
    draft["segments"][0].update(angle=10, motorType="C")
    draft["wings"][0].update(servoType="C", rotation=10)
    draft["energy"]["batteryTypes"][1] = "C"
    draft["propulsionGroups"][1]["motorType"] = "C"
    draft["parameterDefinitions"][0]["value"] = 1
    draft["payload"]["mass"] = 1
    draft["layout"]["motor"]["x"] = 1
    assert set(unsupported_changes(draft, baseline)) == {
        "mass", "maxSpeed", "flightValidity", "fuselage.floorHeight", "payload", "layout",
        "secondaryBatteries", "secondaryPropulsionGroups", "parameterDefinitions",
        "segment.angle/offset", "segment.motorType/propellerType",
        "wing.profile/rotation/controlSurface", "wing.servoType",
    }
