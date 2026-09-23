# Drawn

AircraftVerse 기반 UAV 설계 탐색·성능 시뮬레이션·A/B 비교·목적 기반 최적화 MVP입니다.

## 실행

Docker Compose로 프런트(Node/Vinext), FastAPI, PostgreSQL, nginx를 함께 실행합니다.

```bash
node scripts/init-local-env.mjs
# .env.local에 필요한 Google / AliExpress / OpenAI 키를 설정
docker compose --env-file .env.docker.local up -d --build
```

Windows + Ubuntu WSL에서는 `powershell -ExecutionPolicy Bypass -File scripts/start-docker.ps1`을 실행합니다. 접속 주소는 **http://localhost:3000**, API 문서는 **http://localhost:3000/api/docs**입니다.

개발 서버를 따로 실행하거나 기존 D1 데이터를 옮기는 방법은 [FastAPI 실행·이전 안내](docs/FASTAPI_MIGRATION.md)를 참고하세요. Google 로그인에는 등록된 Client ID/Secret과 `/api/auth/callback/google` 반환 주소가 필요합니다. 새 세션 방식으로 전환했으므로 기존 사용자는 한 번 다시 로그인합니다.

앱 실행에는 Git에 포함된 가공 데이터를 사용하므로 원본이 없어도 됩니다. 원본에서 가공 데이터를 다시 만들 때만 `npm run data:prepare`를 실행하세요.

`npm run data:prepare`는 프로그램 내부의 `data/raw/AircraftVerse_1/2/3`을 우선 탐색해 다음 정적 웹 자산을 만듭니다. 내부 데이터가 없으면 이전 구조인 상위 폴더의 `AircraftVerse_1/2/3`을 사용합니다. 필요하면 `npm run data:prepare -- --data-root <part-path>`를 세 파트 각각 반복 지정할 수 있으며, 명시한 경로가 자동 탐색보다 우선합니다.

- 27,714개 전체 설계 compact metadata index
- 1,000 ID 구간 단위의 29개 설계 트리·원본 파라미터 shard
- Motor 49 / Propeller 146 / Battery 56 / Servo 27 / NACA 68 전체 카탈로그
- Range↑·Power↓·Mass↓ 실제 비지배 Pareto front와 knee point
- 목적·토폴로지별 대표 12개 binary STL
- 시연 설계의 0–50m/s trim curve JSON

원본 84.34GiB 데이터는 `data/raw`에 보관하며 전처리에서 변경하지 않습니다. `data/` 전체는 Git 추적·개발 파일 감시·TypeScript 탐색에서 제외하고, 앱에서 사용하는 `public/data`와 대표 `public/models`만 기존처럼 추적합니다. 위치 변경과 배포 원칙은 [docs/DATA_LAYOUT.md](docs/DATA_LAYOUT.md)를 참고하세요.

### 내 주변 비행 장소 (국토부 UL 공역)

헤더의 "주변 비행지" 위젯은 국토교통부 초경량비행장치 비행공역(UA, data.go.kr
dataset 15061946) 34곳을 사용합니다. 원본 CSV는 저장소에 포함하지 않으며,
아래 명령으로 직접 내려받아 갱신합니다.

```bash
# https://www.data.go.kr/data/15061946/fileData.do 에서 로그인 없이 CSV 다운로드 후
# 혹은 drive에 "국토교통부_항공레저_초경량비행장치공역_20251231.csv" 파일을 다운로드 후
npm run data:prepare-drone-zones -- --csv <다운로드한 CSV 경로>
```

연 1회 갱신되는 스냅샷이라 실시간 NOTAM·임시 공역 변경은 반영하지 않습니다.
실제 비행 전에는 [드론 원스톱](https://drone.onestop.go.kr)에서 최종 확인이 필요합니다.

## 도메인 입문

드론 설계를 처음 접한다면 [docs/DRONE_PRIMER.md](docs/DRONE_PRIMER.md)를 먼저 읽어주세요. 부품 이름 규칙, Thrust/Drag/Lift/Power와 trim, 설계 트레이드오프, feasibility 지표를 이 레포의 실제 데이터로 설명합니다.

## 구현된 사용자 흐름

1. **Design Explorer** — 27,714개 ID/topology 검색과 대표 12개 원본 STL 또는 전체 파라메트릭 프리뷰 진입
2. **Design Studio** — 설계당 원본 27–225개 변수를 1:1 보존하고 구조·동체·추진·전력·날개·탑재·배치를 실시간 개념 형상에 반영
3. **Performance Simulator** — 0–50m/s trim slider, STL Pitch 자세, Drag/Lift/Thrust 벡터와 실제 성능 곡선
4. **A/B Compare** — Baseline vs Draft 및 데이터셋 두 설계의 변경 파라미터/KPI/trim 비교. 별도 단계가 아니라 Design Explorer·Design Studio 어디서든 팝업으로 바로 확인
5. **Dataset Candidate Search** — 목표·제약 필터와 실제 output.json 기반 랭킹(균형형은 non-dominated Pareto knee). 별도 단계가 아니라 Design Explorer 사이드바의 "조건으로 후보 찾기" 모드로 통합되어 있으며, 계산된 추천안은 바로 선택되어 3D·성능·A/B 비교로 이어짐
6. **부품 agent** — 현재 설계의 부품 목록, 상품 후보 비교, 최종 구매 정리표와 CSV 저장

## 설계 도우미 AI

현재는 로컬 통합과 핵심 계약 검증 단계입니다. 실제 Google 로그인부터 정상 OpenAI 답변·변경안 적용·견적 재조회까지 이어지는 전체 흐름과 답변 품질은 추가 검증이 필요합니다. 구현 범위와 우선순위별 완료 기준은 [에이전트 완성도와 남은 작업](docs/AGENT_READINESS.md)에 정리했습니다.

상단 **설계 도우미 AI** 패널에서 **부품 찾기·설계 개선·질문하기**를 이용합니다. 현재 프로젝트의 저장된 설계를 기준으로 실제 BOM 수량과 상품 후보를 확인하고, 견적 저장·CSV 내보내기·변경안 적용·되돌리기를 제공합니다. 패널을 닫거나 작업 화면을 바꿔도 선택한 견적을 유지합니다.

비공개 프로젝트와 유료 API 호출은 Google 로그인 후 이용합니다. 상품 가격·링크는 AliExpress 응답에서 가져오며 옵션과 묶음 수량이 확인된 항목만 확정 소계에 넣습니다. OpenAI는 의도 해석과 근거 설명을 담당하며 학습된 비행 성능 모델과 별개입니다.

키가 없거나 공급자 호출이 실패하면 해당 상태를 표시합니다. 자세한 기능은 [설계 도우미 명세](docs/AGENT_SPEC.md), [부품 찾기](docs/PARTS_AGENT.md)를 참고하세요.

```bash
npm test
npm run typecheck
python -m pytest backend/tests
```

실제 부품 조회 점검은 로그인한 프로젝트를 준비한 뒤 `npm run parts:check`로 수행합니다. 쿠키와 프로젝트 설정이 필요하며 기본 주소는 `http://localhost:3000`입니다.

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

## 코드·모델 구조

현재 실행 코드, 이전 서버 참조 코드, 학습 원본의 위치는 [구조 안내](docs/ARCHITECTURE.md)와 [ML 안내](ml/README.md)에 정리했습니다. 루트의 모델 파일은 ML 보관 폴더로 이동하고 실행용 번들은 `backend/model_bundle`에서 관리합니다.

로컬 학습 모델은 OpenAI 잔액과 독립적으로 동작합니다. 서버 실행 후 `npm run model:check`로 실제 예측 응답을 점검할 수 있습니다.

## 현재 모델 경계

입력·출력, 평가 수치의 해석, 편집 설계 예측의 한계와 다음 학습 과제는 [AI 모델 한계와 개선 과제](docs/AI_MODEL_LIMITATIONS.md)를 먼저 참고하세요.

`ml/sources/dongha/20260920_160522/best_model.pt`의 MLP를 FastAPI에 연결했습니다. 전처리·가중치·모델 버전·검증 샘플을 [작은 배포 번들](backend/model_bundle/README.md)로 고정하고 시작 시 검증합니다. 런타임에서 원본 pickle이나 학습 데이터 전체를 읽지 않습니다.

- **원본 시뮬레이션**: 데이터셋 KPI와 저장된 trim을 표시합니다.
- **Neighbor Estimate v1**: 편집 설계의 기존 요약 KPI와 제한된 치수 최적화를 유지합니다.
- **학습된 속도별 예측**: drag, lift, thrust, pitch, power, current, flightTime, distance를 제공합니다. 원본 호버·20m/s 앵커에 조건화되며 형상만 사용하는 모델은 아닙니다.

학습 모델은 질량·최대속도·비행 유효성을 예측하지 않습니다. 필요한 원본 입력이 없는 설계는 오류로 표시하고, 학습 범위 밖 입력·알 수 없는 부품·반영되지 않는 변경을 안내합니다. 물리 범위를 벗어난 출력은 그래프에서 비워 두되 API의 `rawPredictions`에 원래 값을 보존합니다. 원본 유효 trim의 끊긴 구간을 임의로 이어 붙이지 않습니다.

이 앱의 프리뷰와 예측은 CFD 전체 유동장, 제작 안전성 또는 비행 인증을 대체하지 않습니다.

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
