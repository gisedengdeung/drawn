# Neighbor Estimate v1 — Model Card

## 목적

학습 checkpoint가 아직 없는 팀 프로젝트 초기 단계에서 `설계 변경 → 즉시 3D 변화 → 데이터 근접 성능 변화 → 비교` 흐름을 검증하기 위한 deterministic AircraftVerse 인접 설계 추정기입니다. 화면에서 AI 예측으로 표기하지 않습니다.

## 입력

- 같은 hub topology의 전체 AircraftVerse metadata 후보
- Arm 평균, 동체 길이·수평/수직 직경, 날개 span/chord
- 모든 Motor·Propeller·Battery 변경 수와 NACA 변경
- Arm angle/offset, wing rotation/control-surface 변경량
- 배터리 문자열에서 추출한 mAh와 payload mass

## 출력

- 예상 Mass
- Maximum Distance
- Hover Time
- Max Speed
- Power @ MFD
- Drag @ 20m/s

## 계산 방식

정규화 설계 거리의 역제곱 가중치로 가까운 5개 설계를 찾고 유효한 KPI만 보간합니다. 그 결과에 다음 제한된 보정을 적용합니다.

- 배터리 용량비: Range/Hover와 질량 보정
- Motor·Propeller·Battery·NACA 변경 수: 효율 보정
- Arm 길이·angle·offset, 동체 체적, 날개 면적·rotation: drag/power 보정
- payload 변화: 질량 보정

모든 factor는 과도한 외삽을 막기 위해 제한 범위로 clamp됩니다. 같은 입력은 항상 같은 결과를 반환합니다.

Optimization 표식이 없는 CAD 파생/내부 배치 변수는 개념 형상에는 반영하지만 데이터셋 KPI 거리에는 넣지 않으며, UI에 `3D만 반영됨 · 추정 입력 제외`라고 표시합니다.

## Dataset Candidate Search v2

Optimizer는 세 파트의 27,714개 전체 설계에 대해 실제 `output.json` 및 `trims.npy` 기반 `Drag @ 20m/s`를 사용합니다. 이것은 학습 모델의 추론이 아니라 Mass/Power 제약과 목적별 정규화 점수에 의한 데이터셋 랭킹입니다.

- Max Range
- Max Hover
- Min Power
- Min Drag @ 20m/s
- Max Speed
- Balanced: `Range ↑ / Power ↓ / Mass ↓`의 실제 비지배 front를 계산하고 정규화 ideal point까지 거리가 가장 짧은 knee 후보를 우선 반환

## 알려진 제한

- 학습 모델이 아니므로 confidence 또는 검증셋 R²를 제공하지 않습니다.
- 로컬 `pointCloud.npy`는 명세의 10,000점이 아니라 `(100, 3)`입니다. 10,000점 geometry encoder를 학습하려면 STL에서 생성한 파생 샘플임을 별도로 기록해야 합니다.
- 성능값과 trim 행의 0은 해석 실패 또는 비실현 상태일 수 있어 실제 물리량 0으로 랭킹하지 않습니다.
- 문자열에서 추출한 component envelope는 제조사 정식 component DB 치수를 대체하지 않습니다.
- 브라우저 형상은 25개 tree node type의 부모·자식과 대칭 복제를 표현하는 개념 모델이며 원본 STEP을 재생성하는 CAD kernel이 아닙니다.
- topology 변경과 신규 외부 STL을 평가하지 않습니다.
- CFD pressure/velocity field, Cd contour를 생성하지 않습니다.
- 비행 인증이나 제작 안전성 판단에 사용할 수 없습니다.

## 교체 계획

1. `design_seq` Transformer로 Hover/Range/Mass/Speed model 학습
2. PointNet/DGCNN geometry embedding 결합
   — **geometry 축 완료(2026-09-14): `pointnet-geometry-v1`.** 아래 참고.
3. design + velocity 조건부 trim model 학습
4. ~~검증셋 R²/MAE, prediction interval, model version 기록~~
   — **`pointnet-geometry-v1`에 대해 완료.** `ml/reports/stage4_evaluation.json`
5. 동일 UI contract를 유지한 채 FastAPI inference endpoint로 교체

## pointnet-geometry-v1 (2026-09-14)

3D 형상만 입력으로 받는 학습 모델입니다. **아직 UI에 연결되어 있지 않습니다.**
현재 화면은 위에 기술된 `Neighbor Estimate v1`이 그대로 담당합니다.
입력 변수·구조·근거는 [POINTNET_MODEL.md](POINTNET_MODEL.md)에 있습니다.

### 입력

STL 표면에서 면적 가중 샘플링한 점 1,024개와 크기 스칼라 1개.
**부품 선택(모터·프로펠러·배터리), CAD 설계 변수, 로터 수는 입력에 없습니다.**

### 검증셋 성능 (test split, 2026-09-14)

| 타깃 | n | R² | MAE | RMSE | 평균 예측 | `mesh` 회귀 |
| --- | --- | --- | --- | --- | --- | --- |
| `Mass` | 2,723 | 0.8792 | 1.13 kg | 1.78 kg | 0.000 | 0.397 |
| `Max_Distance` | 1,083 | 0.6233 | 1,233 m | 2,242 m | 0.000 | 0.046 |

비교 기준은 두 가지입니다. `mesh`는 메시에서 잴 수 있는 스칼라 6개만 쓴 선형회귀로,
모델과 동일한 정보를 받은 공정한 바닥입니다. `mesh+cad`(0.919 / 0.535)는 CAD 설계 변수를
정답으로 받으므로 합격선이 아니라 지향점입니다.

### Prediction interval

val 잔차 분위수로 만든 곱셈형 구간이며, test에서 포함률을 검증했습니다.

| 타깃 | 명목 | 실제 | 구간 |
| --- | --- | --- | --- |
| `Mass` | 80% / 90% | 80.8% / 90.0% | ×0.762~×1.210 / ×0.701~×1.331 |
| `Max_Distance` | 80% / 90% | 82.3% / 91.1% | ×0.342~×1.778 / ×0.207~×2.341 |

**`Max_Distance`는 점 추정 단독 노출 금지.** 90% 구간이 ×0.21~×2.34입니다.

### 알려진 약점

| 구간 | `Mass` 중앙 상대오차 | `Max_Distance` |
| --- | --- | --- |
| 날개 있음 (전체 22.9%) | 19.7% | 68.2% |
| 로터 9개 이상 | 14.5% | 91.2% |
| 대형 기체 861mm 이상 | 17.9% | 61.4% |

부품을 보지 못하므로 같은 형상에 배터리만 바뀐 설계를 구분하지 못합니다.
이 모델은 교체 계획의 **결합되는 한 축**이며 단독 사용을 전제로 하지 않습니다.

### `Max_Distance`를 랭킹에 쓰지 마세요

예측이 평균으로 수축합니다. 실제값 10분위별 예측/실제 비율입니다.

| 분위 | 1(최저) | 5 | 10(최고) |
| --- | --- | --- | --- |
| `Mass` | 1.19 | 1.03 | 0.97 |
| `Max_Distance` | **3.77** | 1.04 | **0.80** |

**예측 상한이 19,824m입니다.** 데이터셋 최대는 40,905m입니다.
Pareto knee인 design 20015(40,905m)를 1,400m로, 13077(35,050m)을 2,746m로 예측합니다.

분산의 62%만 설명하는 회귀 모델의 정상 거동이지만(설명 못 하는 만큼 학습 평균 3,098m로 끌림),
결과적으로 **상위 설계를 상위로 식별하지 못합니다.**

현재의 `Dataset Candidate Search v2`는 실측 `output.json` 랭킹입니다.
**이 모델로 대체하면 퇴보합니다.** 교체 계획 5번의 대상이 아닙니다.

### Model version

체크포인트 sha256 `d677197f50a27923614d073c9ff84174`,
데이터 sha256(앞 64MB) `261afb206bb3dd979fadd43de070e759`,
split train 22,177 / val 2,803 / test 2,723 (family 해시 80/10/10).

### 배포

`ml/export_onnx.py`가 `pointnet-geometry-v1.onnx`(5.2MB, sha256
`c4c11030c7ebe9a77d367bbdcf5119aa`)를 만듭니다. 전처리·후처리가 그래프에 편입되어 있어
mm 좌표를 넣으면 kg·m가 나옵니다. PyTorch와 최대 상대차 6.6e-06으로 일치합니다.

**ONNX 파일만 전달하면 안 됩니다.** 샘플링 규약(면적 가중 1,024점, mm)과 위 약점 절이
함께 가야 합니다. 받는 쪽은 `python ml/verify_onnx.py`로 자기 환경을 먼저 확인하세요
(numpy와 onnxruntime만 있으면 됩니다).
