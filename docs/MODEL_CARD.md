# Demo Surrogate v0.1 — Model Card

## 목적

학습 checkpoint가 아직 없는 팀 프로젝트 초기 단계에서 `설계 변경 → 즉시 성능 변화 → 비교`의 UX와 시스템 경계를 검증하기 위한 deterministic estimator입니다.

## 입력

- 선택한 AircraftVerse 설계의 `output.json` 기준 성능
- `design_seq.json`의 motor, propeller, battery, arm length
- 배터리 문자열에서 추출한 mAh
- 모터 문자열에서 추출한 KV
- 선택된 시연 부품 조합

## 출력

- 예상 Mass
- Maximum Distance
- Hover Time
- Max Speed
- Power @ MFD
- Drag @ 20m/s

## 계산 방식

기준 설계의 데이터셋 성능에 다음 재현 가능한 factor를 적용합니다.

- 배터리 용량비: Range/Hover와 질량 보정
- Motor KV 변화: 효율과 질량의 제한된 보정
- Propeller 선택: 시연 후보 순서 기반 제한된 효율 factor
- Arm 길이비: drag factor와 power 보정

모든 factor는 과도한 외삽을 막기 위해 제한 범위로 clamp됩니다. 같은 입력은 항상 같은 결과를 반환합니다.

## Dataset Ranking v1

Optimizer는 세 파트의 27,714개 전체 설계에 대해 실제 `output.json` 및 `trims.npy` 기반 `Drag @ 20m/s`를 사용합니다. 이것은 학습 모델의 추론이 아니라 Mass/Power 제약과 목적별 정규화 점수에 의한 데이터셋 랭킹입니다.

- Max Range
- Max Hover
- Min Power
- Min Drag @ 20m/s
- Max Speed
- Balanced: Range 36%, Hover 22%, Power 18%, Drag 10%, Speed 6%, Mass 8%

## 알려진 제한

- 학습 모델이 아니므로 confidence 또는 검증셋 R²를 제공하지 않습니다.
- 로컬 `pointCloud.npy`는 명세의 10,000점이 아니라 `(100, 3)`입니다. 10,000점 geometry encoder를 학습하려면 STL에서 생성한 파생 샘플임을 별도로 기록해야 합니다.
- 성능값과 trim 행의 0은 해석 실패 또는 비실현 상태일 수 있어 실제 물리량 0으로 랭킹하지 않습니다.
- 문자열에서 추출한 component property는 정식 component DB 전체 속성을 대체하지 않습니다.
- topology 변경과 신규 외부 STL을 평가하지 않습니다.
- CFD pressure/velocity field, Cd contour를 생성하지 않습니다.
- 비행 인증이나 제작 안전성 판단에 사용할 수 없습니다.

## 교체 계획

1. `design_seq` Transformer로 Hover/Range/Mass/Speed model 학습
2. PointNet/DGCNN geometry embedding 결합
3. design + velocity 조건부 trim model 학습
4. 검증셋 R²/MAE, prediction interval, model version 기록
5. 동일 UI contract를 유지한 채 FastAPI inference endpoint로 교체
