# Drawn 성능 예측 백엔드 (FastAPI)

드론 성능 예측 모델 두 개를 서빙하는 별도 백엔드입니다. Next.js/Cloudflare
Workers로 배포되는 메인 앱과는 완전히 분리된 Python 서버라, 로컬에서는 따로 띄우고
배포도 별도로(Render, Railway, 자체 서버 등) 하면 됩니다.

- **`/predict`** — "파라미터 편집"(Design Lab) 모델. 설계 하나당 대표 성능값(최대
  비행거리, 체공시간 등) 몇 개를 예측. XGBoost로 학습 예정이나 **아직 전달받은 모델
  파일이 없어 목업으로만 동작**.
- **`/predict/trim`** — "성능 확인"(Simulator) 모델. 설계 + 속도(speed)를 넣으면 그
  속도에서의 트림 값 8개(drag/lift/thrust/pitch/power/current/flightTime/distance)를
  예측. PyTorch MLP로 학습 완료, **실제 모델 로드해서 동작 중**.

## 실행 방법

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

`http://localhost:8000/health`로 두 모델의 로드 상태를, `http://localhost:8000/docs`로
자동 생성된 API 문서를 확인할 수 있습니다.

## `/predict` — Design Lab 요약 모델 (아직 목업)

`backend/models/performance_model.json`이 없으면 대충 그럴듯한 값을 계산해서
돌려주는 **목업(mock)** 모드로 동작합니다. 응답의 `is_mock: true`로 항상 구분할 수
있어요. 진짜 XGBoost 모델이 준비되면:

1. `booster.save_model("performance_model.json")`으로 저장
2. 그 파일을 `backend/models/performance_model.json`에 놓기
3. 서버 재시작 → 자동으로 실제 모델을 로드해서 `is_mock: false`로 예측

모델이 실제로 어떤 순서/개수로 값을 출력하는지에 따라 `app/model.py`의 `predict()`
안 출력 매핑(`max_distance_m`, `hover_time_s`, ...) 부분은 맞춰서 조정이 필요합니다.

```json
// POST /predict
{
  "design_id": 20015,
  "features": { "mass": 4.2, "armLength": 254, "numPropellers": 4, "numWings": 0 }
}
```

`features`는 고정된 스키마가 아니라 이름-숫자 쌍의 자유 형식입니다.

## `/predict/trim` — Simulator 트림 모델 (실제 모델 로드됨)

`backend/models/trim_mlp.pt`(PyTorch 체크포인트)와
`backend/models/trim_preprocessor.pkl`(scikit-learn 전처리기 + 카테고리 인코더 +
타깃 스케일러)이 둘 다 있으면 자동으로 로드됩니다. 지금 이 저장소엔 두 파일이 이미
들어있어요(둘 다 git엔 안 올라감 — `.gitignore` 처리됨. 새 컴퓨터에서 실행하려면
다시 복사해야 함).

입력 필드는 프론트엔드의 `DesignSummary`(`lib/drawn-types.ts`) 필드와 이름이 그대로
같습니다 — `speed`만 사용자가 고르는 값이고, 나머지는 설계 데이터에서 그대로
가져다 쓰면 됩니다.

```json
// POST /predict/trim
{
  "design_id": 17297,
  "speed": 10,
  "numPropellers": 6,
  "numWings": 0,
  "armLength": 199.49,
  "meanArmLength": 335.0,
  "maxArmLength": 470.51,
  "fuselageLength": 203,
  "fuselageHorizontalDiameter": 378.15,
  "fuselageVerticalDiameter": 133.5,
  "totalWingSpan": 0,
  "meanWingChord": 0,
  "parameterCount": 40,
  "hub": "ConnectedHub6_Sym",
  "primaryMotor": "kde_direct_KDE3520XF_400",
  "primaryPropeller": "apc_propellers_15x5_5MR",
  "primaryBattery": "Tattu5C28000mAh6S1P",
  "dragAt20": 15.31,
  "powerAt20": 1418.19,
  "powerAt0": 1152.9,
  "thrustAt0": 68.57,
  "currentAt0": 82.28
}
```

응답:

```json
{
  "drag": 9.44,
  "lift": 1.14,
  "thrust": 72.84,
  "pitch": -6.93,
  "power": 1624.15,
  "current": 104.73,
  "flightTime": 671.28,
  "distance": 6217.96,
  "model_version": "trim-mlp-epoch104",
  "is_mock": false
}
```

`hub`/`primaryMotor`/`primaryPropeller`/`primaryBattery`가 학습 때 못 본 값이거나
`null`이면 해당 부품 카테고리는 전부 0으로 처리되고(에러 안 남), 결과는 그만큼
부정확해질 수 있습니다.

검증셋 R²(`metrics.json`): drag/thrust/power/current/flightTime/distance는
0.96~0.99, lift는 0.24, pitch는 0.47 — lift·pitch는 상대적으로 예측력이 약합니다.

## `GET /health`

두 모델의 로드 상태를 각각 확인합니다: `summary_model_loaded`/`summary_model_version`,
`trim_model_loaded`/`trim_model_version`.

## 프론트엔드 연동 (아직 미연결)

지금은 프론트엔드가 이 서버를 전혀 호출하지 않습니다:

- `components/views/design-lab-view.tsx`의 "실시간 성능 변화" 패널은 데이터셋 내
  유사 설계를 찾아 평균 내는 방식(INTERPOLATED)만 씀 → `/predict` 준비되면 교체 대상
- `components/views/simulator-view.tsx`의 성능 곡선은 데이터셋에 저장된 원본 트림
  곡선만 보여줌(편집 반영 안 됨) → `/predict/trim` 연동하면 임의 속도·편집된 설계에
  대해서도 곡선을 그릴 수 있음

두 연동 다 프론트엔드 쪽 fetch 코드 추가가 남은 작업입니다.
