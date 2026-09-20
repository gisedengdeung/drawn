# Drawn 성능 예측 백엔드 (FastAPI)

XGBoost로 학습한 드론 성능 예측 모델을 서빙하는 별도 백엔드입니다. Next.js/Cloudflare
Workers로 배포되는 메인 앱과는 완전히 분리된 Python 서버라, 로컬에서는 따로 띄우고
배포도 별도로(Render, Railway, 자체 서버 등) 하면 됩니다.

## 실행 방법

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

`http://localhost:8000/health`로 살아있는지, `http://localhost:8000/docs`로 자동
생성된 API 문서를 확인할 수 있습니다.

## 지금 상태: 모델 없이도 동작하는 목업

`backend/models/performance_model.json`이 없으면 `/predict`가 대충 그럴듯한 값을
계산해서 돌려주는 **목업(mock)** 모드로 동작합니다. 응답의 `is_mock: true`로 항상
구분할 수 있어요. 진짜 모델이 준비되면:

1. XGBoost 모델을 `booster.save_model("performance_model.json")`으로 저장
2. 그 파일을 `backend/models/performance_model.json`에 놓기
3. 서버 재시작 → 자동으로 실제 모델을 로드해서 `is_mock: false`로 예측

모델이 실제로 어떤 순서/개수로 값을 출력하는지에 따라 `app/model.py`의
`predict()` 안 출력 매핑(`max_distance_m`, `hover_time_s`, ...) 부분은 맞춰서
조정이 필요할 수 있습니다.

## API

### `POST /predict`

```json
{
  "design_id": 20015,
  "features": {
    "mass": 4.2,
    "armLength": 254,
    "numPropellers": 4,
    "numWings": 0
  }
}
```

`features`는 고정된 스키마가 아니라 이름-숫자 쌍의 자유 형식입니다. 실제 모델이
어떤 컬럼으로 학습됐는지에 맞춰서 그대로 넘기면 됩니다.

응답:

```json
{
  "max_distance_m": 2870.5,
  "hover_time_s": 214.3,
  "max_speed_mps": 24.1,
  "power_w": 946.0,
  "drag_at_20_n": 6.3,
  "mass_kg": 4.2,
  "model_version": "mock-0",
  "is_mock": true
}
```

### `GET /health`

서버 상태와 모델 로드 여부를 확인합니다.

## 프론트엔드 연동 (아직 미연결)

지금은 프론트엔드(`components/views/design-lab-view.tsx`의 "실시간 성능 변화" 패널)가
데이터셋 내 유사 설계를 찾아 평균 내는 방식(INTERPOLATED)만 쓰고 있습니다. 이 API가
준비되면 그 패널에서 이 서버를 호출해서 실제 모델 예측값으로 교체/보강하는 작업이
다음 단계입니다 — 모델의 실제 입력 피처 목록이 정해지면 그때 프론트엔드 쪽 연동을
진행하면 됩니다.
