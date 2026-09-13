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
   — **geometry 축은 학습 완료(2026-09-14).** `Mass` val R² 0.854, `Max_Distance` 0.628.
   입력·구조·근거는 [POINTNET_MODEL.md](POINTNET_MODEL.md). 아직 UI에 연결하지 않았습니다.
3. design + velocity 조건부 trim model 학습
4. 검증셋 R²/MAE, prediction interval, model version 기록
5. 동일 UI contract를 유지한 채 FastAPI inference endpoint로 교체
