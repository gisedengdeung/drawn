# AeroTwin

AircraftVerse 기반 UAV 설계 탐색·성능 시뮬레이션·A/B 비교·목적 기반 최적화 MVP입니다.

## 실행

```bash
npm install
npm run data:prepare
npm run dev
```

`npm run data:prepare`는 상위 폴더의 `AircraftVerse_1/AircraftVerse_1`을 읽어 다음 정적 웹 자산을 만듭니다.

- 9,238개 설계 compact metadata index
- 시연용 6개 STL
- 시연 설계의 0–50m/s trim curve JSON

원본 30GB 데이터는 복사하거나 변경하지 않습니다.

## 구현된 사용자 흐름

1. **Design Explorer** — ID/topology 검색, propeller·wing·mass·성능 유효성 필터, 실제 STL 회전/확대
2. **Performance Simulator** — 0–50m/s slider, Drag/Lift/Thrust/Pitch/Power/Current/Flight Time/Distance, 실제 trim 곡선
3. **Design Lab** — Motor/Propeller/Battery/Arm 변경, 원본 대비 demo surrogate 예측
4. **A/B Compare** — 두 설계의 방향성-aware KPI 비교와 속도별 곡선 overlay
5. **AI Optimizer** — mission preset, 목표/제약 설정, 9,238개 설계공간 필터, 상위 3개 추천, Range–Power Pareto 산점도

## 데이터 원칙

- 요약 KPI는 `output.json`을 사용합니다.
- 속도별 곡선은 `trims.npy`를 사용합니다.
- trim의 전부 0인 행과 non-finite 값은 유효하지 않은 상태로 처리합니다.
- 제공된 부분 데이터의 point cloud는 명세와 달리 `100×3`입니다.
- 로컬 설계 9,238개와 AircraftVerse 전체 27,714개를 UI에서 구분합니다.
- `corpus_dic`은 신뢰되지 않은 Python pickle이므로 런타임에서 역직렬화하지 않습니다.

## 현재 모델 경계

학습된 PyTorch checkpoint가 제공되지 않아 Design Lab은 재현 가능한 deterministic `Demo Surrogate v0.1`을 사용합니다. Optimizer의 후보 KPI는 실제 AircraftVerse `output.json`이며 목적 점수만 normalized surrogate score입니다. 상세 공식과 제한은 [docs/MODEL_CARD.md](docs/MODEL_CARD.md)에 기록했습니다.

이 MVP는 CFD 전체 유동장, 제작 안전성 또는 비행 인증을 대체하지 않습니다.

## 팀 분업 제안

| 파트 | 소유 범위 |
| --- | --- |
| Frontend | React/Vinext UI, Three.js STL viewer, Recharts, 접근성/반응형 |
| Data | AircraftVerse 전처리, schema validation, metadata/trim index |
| AI | Transformer/PointNet/Trim 모델 학습, 검증셋 metric, model registry |
| Backend | FastAPI inference, optimization job, PostgreSQL/object storage |
| MLOps | model version, confidence interval, GPU inference, monitoring |

## 검증

```bash
npx tsc --noEmit
npx oxlint components/aerotwin-app.tsx components/stl-viewer.tsx components/views lib/aerotwin-types.ts scripts/prepare-aircraftverse.mjs
npm run build
```

