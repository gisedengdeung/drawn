# drawn

AircraftVerse 기반 UAV 설계 탐색·성능 시뮬레이션·A/B 비교·목적 기반 최적화 MVP입니다.

## 실행

```bash
npm install
npm run dev
```

앱 실행에는 Git에 포함된 가공 데이터를 사용하므로 원본이 없어도 됩니다. 원본에서 가공 데이터를 다시 만들 때만 `npm run data:prepare`를 실행하세요.

`npm run data:prepare`는 프로그램 내부의 `data/raw/AircraftVerse_1/2/3`을 우선 탐색해 다음 정적 웹 자산을 만듭니다. 내부 데이터가 없으면 이전 구조인 상위 폴더의 `AircraftVerse_1/2/3`을 사용합니다. 필요하면 `npm run data:prepare -- --data-root <part-path>`를 세 파트 각각 반복 지정할 수 있으며, 명시한 경로가 자동 탐색보다 우선합니다.

- 27,714개 전체 설계 compact metadata index
- 1,000 ID 구간 단위의 29개 설계 트리·원본 파라미터 shard
- Motor 49 / Propeller 146 / Battery 56 / Servo 27 / NACA 68 전체 카탈로그
- Range↑·Power↓·Mass↓ 실제 비지배 Pareto front와 knee point
- 목적·토폴로지별 대표 12개 binary STL
- 시연 설계의 0–50m/s trim curve JSON

원본 84.34GiB 데이터는 `data/raw`에 보관하며 전처리에서 변경하지 않습니다. `data/` 전체는 Git 추적·개발 파일 감시·TypeScript 탐색에서 제외하고, 앱에서 사용하는 `public/data`와 대표 `public/models`만 기존처럼 추적합니다. 위치 변경과 배포 원칙은 [docs/DATA_LAYOUT.md](docs/DATA_LAYOUT.md)를 참고하세요.

## 구현된 사용자 흐름

1. **Design Explorer** — 27,714개 ID/topology 검색과 대표 12개 원본 STL 또는 전체 파라메트릭 프리뷰 진입
2. **Design Studio** — 설계당 원본 27–225개 변수를 1:1 보존하고 구조·동체·추진·전력·날개·탑재·배치를 실시간 개념 형상에 반영
3. **Performance Simulator** — 0–50m/s trim slider, STL Pitch 자세, Drag/Lift/Thrust 벡터와 실제 성능 곡선
4. **A/B Compare** — Baseline vs Draft 및 데이터셋 두 설계의 변경 파라미터/KPI/trim 비교
5. **Dataset Candidate Search** — 목표·제약 필터, 실제 non-dominated Pareto와 knee 추천, 추천 ID를 Draft·A/B 흐름으로 연결

## 알리 부품 견적

Design Studio의 **알리 부품 견적** 버튼은 현재 설계의 모터·프로펠러·배터리·서보와 실제 수량을 고정한 뒤 상품 후보를 조회합니다. 동일 모델을 우선 표시하며, 대체 후보는 직접 선택해야 합니다. 옵션 가격과 묶음 수량이 확인된 항목만 소계에 반영하고, 배송 미확인은 0원으로 계산하지 않습니다. 결과는 현재 탭의 세션에 유지되며 CSV로 저장할 수 있습니다.

실제 조회에는 `.env.example`을 참고한 서버 자격 증명 설정이 필요합니다. 로컬에서는 `.env.local`에 설정한 뒤 개발 서버를 다시 시작하세요. 키가 없으면 연결 준비 상태와 부품 목록만 제공하며 가상 상품·가격을 만들지 않습니다. API 권한, 옵션 검증의 한계와 연결 절차는 [부품 에이전트 문서](docs/PARTS_AGENT.md)를 참고하세요.

```bash
npm run typecheck
npm test
npm run parts:check
```

`parts:check`는 실행 중인 로컬 서버(기본 `http://localhost:5173`)에서 모터·프로펠러·배터리의 실제 조회를 확인합니다. 키가 없으면 종료 코드 2로 연결 준비가 필요함을 알립니다. 데이터 이동 기록과 배포 제외 원칙은 [데이터 문서](docs/DATA_LAYOUT.md)에 있습니다.

## 데이터 원칙

- 요약 KPI는 `output.json`을 사용합니다.
- 속도별 곡선은 `trims.npy`를 사용합니다.
- trim의 전부 0인 행과 non-finite 값은 유효하지 않은 상태로 처리합니다.
- 제공된 부분 데이터의 point cloud는 명세와 달리 `100×3`입니다.
- 세 데이터 파트의 27,714개 고유 설계를 하나의 인덱스로 통합합니다.
- 전체 ID는 1–28,080 사이에 희소하게 분포하므로 최대 ID를 설계 수로 사용하지 않습니다.
- `design_tree.json`의 압축된 대칭 subtree는 부모→자식 transform으로 누적한 뒤 hub topology에 따라 복제합니다.
- `design_low_level.json`의 1,279,376개 원본 변수는 compact tuple로 shard에 보존하고 선택한 설계만 브라우저에서 `ParameterDefinition`으로 지연 해석합니다.
- 물리 component instance를 별도로 보존하므로 동일 모델의 dual battery나 대칭 motor/propeller를 Set으로 축약하지 않습니다.
- `corpus_dic`은 신뢰되지 않은 Python pickle이므로 런타임에서 역직렬화하지 않습니다.

## 현재 모델 경계

학습된 PyTorch checkpoint가 제공되지 않아 Design Studio는 같은 topology의 AircraftVerse 인접 설계 5개를 이용한 `Neighbor Estimate v1`으로 표시합니다. CAD 파생 변수는 성능 추정에서 제외됨을 별도로 알립니다. Optimizer 역시 AI 예측으로 부르지 않고 실제 `output.json` 기반 `Dataset Candidate Search v2`로 구분합니다. 상세 공식과 제한은 [docs/MODEL_CARD.md](docs/MODEL_CARD.md)에 기록했습니다.

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
npx oxlint components/drawn-app.tsx components/stl-viewer.tsx components/views lib/drawn-types.ts scripts/prepare-aircraftverse.mjs
npm run build
```
