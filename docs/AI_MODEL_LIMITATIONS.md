# 현재 AI 모델의 범위와 개선 기준

현재 변경은 제공된 `best_model.pt`를 검증하고 로컬 FastAPI 추론에 연결한 것이다.
새 모델을 학습하거나 형상 변경의 실제 비행 성능을 검증한 작업은 아니다.
에이전트도 아래 범위를 지켜 결과의 출처와 한계를 설명해야 한다.

## 1. 현재 실행되는 모델

| 항목 | 현재 상태 |
|---|---|
| 모델 버전 | `best-mlp-20260920-0f87569726f6` |
| 원본 run | `ml/sources/dongha/20260920_160522` |
| 구조 | MLP, `274 → 256 → 256 → 128 → 8`, SiLU, 학습 dropout 0.05 |
| 실행 | FastAPI 안에서 PyTorch CPU 추론, dropout 비활성화 |
| 실행 파일 | `backend/model_bundle`의 가중치 NPZ·전처리 JSON·manifest·golden |
| 문제 정의 | 알려진 기준 설계의 성능을 조건으로 속도별 trim 값을 예측 |

루트에 있던 `.pt`·`.pkl` 파일은 `ml/archive/root-artifacts`에 보존했다.
런타임은 이 보존본을 읽지 않는다. 번들의 NPZ는 원본 체크포인트에서 추출한
동일한 수치 가중치이며 임의로 만든 예측값이 아니다. 시작할 때 파일 해시와
실제 CPU golden 예측을 검사한다. 이 검사는 구현·패키징 일치 검증이며 새로운
설계의 정확도나 비행 가능성을 보증하는 검사는 아니다.

근거: [실행 manifest](../backend/model_bundle/manifest.json),
[런타임 설명](../backend/model_bundle/README.md),
[FastAPI 추론 코드](../backend/app/performance.py),
[원본 이동 기록](../ml/artifact-inventory.json).

## 2. 입력과 출력 계약

원본 입력은 21개다. 17개 수치 입력에 `trim20_available`을 파생해 수치 입력
18개를 만들고, 범주 입력 4개를 원핫 인코딩해 256개 열로 확장한다. 최종 입력은
`18 + 256 = 274`차원이다.

| 입력 종류 | 항목 |
|---|---|
| 속도·수량 | `speed`, `numPropellers`, `numWings` |
| 형상 요약 | `armLength`, `meanArmLength`, `maxArmLength`, `fuselageLength`, `fuselageHorizontalDiameter`, `fuselageVerticalDiameter`, `totalWingSpan`, `meanWingChord`, `parameterCount` |
| 기준 성능 앵커 | `dragAt20`, `powerAt20`, `powerAt0`, `thrustAt0`, `currentAt0` |
| 파생 입력 | `trim20_available = finite(powerAt20) and powerAt20 > 0` |
| 범주 입력 | hub·첫 motor·첫 propeller·첫 battery; 학습 원핫 범주 수는 각각 10·48·142·56 |

출력은 `drag`, `lift`, `thrust`(N), `pitch`(°), `power`(W), `current`(A),
`flightTime`(s), `distance`(m)의 8개다. 모델에 **mass·maxSpeed·flightValidity
출력은 없다**. API의 이 세 미지원 표시는 실패 점수나 신뢰도 저하 표시가 아니다.
같은 8개 타깃으로 다시 학습해도 이 기능이 자동으로 추가되지 않는다.

학습에서 보지 못한 범주는 저장된 전처리 정책에 따라 해당 원핫 블록을 모두
0으로 만들고 경고한다. 이는 지원되는 계산 방식이지 해당 부품의 예측 정확도를
검증했다는 뜻은 아니다. 미지원 항목을 수정해도 예측이 그대로일 수 있으며,
해당 항목을 형상 변경의 효과로 설명해서는 안 된다.

근거: [전처리](../backend/model_bundle/preprocessing.json),
[입력 추출·미지원 항목 판정](../backend/app/performance_features.py).

## 3. 형상 변경 예측의 핵심 한계

현재 모델은 형상만으로 성능을 예측하는 모델이 아니다. 5개의 성능 앵커를
서버가 기준 AircraftVerse 설계에서 가져온다. 사용자가 동체·날개·부품을
수정해도 이 앵커는 수정된 설계에 대한 새 시뮬레이션 값으로 갱신되지 않는다.

따라서 화면에서 수정 후 8개 숫자가 변한다는 것은 모델 입력 변경이 반영돼
추론됐다는 뜻이다. **그 변화량이 실제 수정 설계의 성능 변화와 일치한다는
증거는 아직 없다.** 기존 앵커와 수정된 형상의 조합은 학습에서 관측한 조합과
다를 수 있다. 아래 높은 R²를 형상 수정의 정확도로 옮겨 설명할 수 없다.

바닥 높이, payload, 배치, arm angle/offset, 날개 profile·rotation·control
surface·servo, 보조 추진 그룹·배터리, 개별 segment 부품 override,
`parameterDefinitions`의 값 등은 현재 MLP의 독립적인 입력으로 반영되지 않는다.
실제 변경된 미지원 필드는 API에 표시한다. 형상 요약 입력도 전체 CAD나
포인트클라우드의 표현이 아니며, 같은 요약을 갖는 서로 다른 형상을 구별하지
못할 수 있다.

## 4. Neighbor Estimate와 속도 경고의 의미

기존 6개 KPI의 `Neighbor Estimate v1`은 학습된 MLP와 별도 계산이다. 가까운
데이터 설계 5개의 KPI를 가중 평균하고 경험적인 보정을 적용한다. 원본과 동일한
draft에는 원본 데이터 KPI를 반환한다. 수정 시에는 이웃 선택과 보정으로 계산
경로가 바뀌므로 작은 편집에도 KPI 변화가 커질 수 있다.

이 추정기의 `similarity`는 거리·변경량에서 계산하는 표시 점수다. 현재 구현에는
35의 하한도 있다. **36%·41%·47%를 모델 정확도, 성공 확률, 예측구간 또는
비행 안전 확률로 읽어서는 안 된다.** 최근접 설계 번호도 근거 후보의 식별자일
뿐이다. MLP와 Neighbor Estimate의 값을 한 모델의 전후 결과처럼 비교하지 않는다.

근거: [Neighbor Estimate 모델 카드](MODEL_CARD.md),
[현재 Python 구현](../backend/app/domain/estimate.py),
[브라우저의 기존 KPI 계산](../lib/design-performance.ts).

MLP의 저장된 학습 속도 범위는 `0..49m/s`다. 기본 곡선 요청은 `0..50m/s`의
51개 점이므로 마지막 50m/s가 범위를 벗어난다. 전체 요청의 경고가 보인다고
선택한 20m/s 자체가 범위를 벗어난 것은 아니다. 각 예측 행의 범위 표시와
요청 전체의 합집합 표시를 구분해야 한다. 50m/s의 결과를 검증 범위 안의 값처럼
제시하거나 이 경고만으로 재학습 실패라고 판단하지 않는다.

## 5. 검증 수치와 해석 범위

원본 run의 평가 CSV로 MAE와 R²를 다시 계산했다. 저장된 metrics와의 최대
차이는 CSV 소수점 저장 차이에 해당하는 약 `1.62e-6`이었다.

| 출력 | Validation R² | Test R² | Test MAE |
|---|---:|---:|---:|
| drag | 0.9901 | 0.9859 | 0.537 N |
| lift | 0.2429 | 0.2922 | 0.170 N |
| thrust | 0.9944 | 0.9898 | 1.247 N |
| pitch | 0.4721 | 0.5013 | 2.613° |
| power | 0.9691 | 0.9659 | 105.301 W |
| current | 0.9710 | 0.9646 | 6.088 A |
| flightTime | 0.9902 | 0.9910 | 9.046 s |
| distance | 0.9918 | 0.9913 | 145.504 m |

설계 ID 분할은 train 5,127개, validation 641개, test 641개다. 분할 내부의
중복과 분할 간 교집합은 직접 확인해 모두 0이었다. 평가 CSV도 해당 분할의
설계 ID와 일치한다. 행 수는 각각 120,227 / 14,639 / 14,571이다.

이 수치는 알려진 성능 앵커와 유효 trim 행을 사용하는 평가다. 형상 수정 쌍에
대한 별도 시뮬레이션 검증, 비행 유효성 분류 평가 또는 신규 부품의 정확도
평가가 아니다. lift·pitch의 설명력은 다른 출력보다 낮다. lift의 작은 MAE만
보고 성능이 충분하다고 판단하면 안 된다. 개별 설계별 오차나 예측구간도
위의 전체 평균 MAE에서 바로 얻을 수 없다. R²를 정확도 백분율로 표기하지 않는다.

근거: [원본 metrics](../ml/sources/dongha/20260920_160522/metrics.json),
[test 예측 CSV](../ml/sources/dongha/20260920_160522/test_predictions.csv),
[validation 예측 CSV](../ml/sources/dongha/20260920_160522/validation_predictions.csv),
[설계 분할](../ml/sources/dongha/20260920_160522/split_design_ids.json),
[학습 설정](../ml/sources/dongha/20260920_160522/config.json).

## 6. 데이터 품질과 재현성

비정상 hover 사례인 #20015는 공개 index에서 질량 약 7.371kg,
`thrustAt0=19.27N`, `feasible=true`로 남아 있다. 로컬 원본
`data/raw/AircraftVerse_2/design_20015/trims.npy`의 hover 행을
`allow_pickle=False`로 확인하면 `drag=NaN`, `maxUc=0.5`다. index의 가용성
표시만으로 모든 trim이 정상이라고 판단할 수 없다.

#20015는 현재 run의 eligible 설계 목록에 없으며 API는
`422 model_input_unavailable`을 반환한다. 이 사례가 제외됐다는 사실이 전체
데이터의 물리적 정합성 검증 완료를 뜻하지는 않는다. 다음 데이터 정제에는
nonfinite 행, solver 실패, hover 일관성의 검출 사유와 제외 수를 남겨야 한다.
`maxUc=0.5` 같은 단일 값만으로 정상 행까지 일괄 삭제하는 규칙을 만들지 않는다.

근거: [공개 설계 index](../public/data/design-index.json),
[데이터 생성 당시 요약](../ml/sources/dongha/dataset_summary.json),
[현재 eligible 목록](../backend/model_bundle/manifest.json).

현재 체크포인트의 추론은 재현했고 원본 CUDA 예측과의 대조도 통과했다. 다만
제공된 과거 학습 스크립트는 이 run의 274차원 입력·SiLU 구조·설계별 분할을
만든 정확한 구현과 다르다. 설정에는 train에서만 전처리를 학습하고 validation으로
체크포인트를 선택했다고 기록돼 있으나, 전체 학습 실행을 소스 코드로 다시
검증한 것은 아니다. 없는 `test-ai-modeling` 구현을 참조하는 과거 테스트 2개도
현행 테스트 통과 수에 포함하지 않는다.

원본 학습 metadata의 당시 경로는 증거로 보존했다. 현재 패키징 경로·보존 파일과
재현 범위는 [ML 자료 안내](../ml/README.md)에 정리했다. 다음 명령은 현재
원본 해시와 CPU golden을 검증하며 학습이나 파일 재생성을 하지 않는다.

```powershell
backend/.venv/Scripts/python.exe scripts/package-performance-model.py --verify-only
```

## 7. 다음 작업의 우선순위와 승인 기준

다음 항목은 수행 예정 기준이다. 이 PR에서 재학습하거나 아래 검증을 완료했다는
의미가 아니다. 단순 학습 횟수 증가보다 문제 정의·데이터·평가를 먼저 확정한다.

| 우선순위 | 작업 | 완료를 판단할 근거 |
|---|---|---|
| 1 | 입력·타깃 및 데이터 품질 계약 확정 | 실제 편집 가능한 항목, 단위, 지원 범위와 미지원 항목을 명시한다. 잘못된 hover·실패 행의 처리 사유/건수를 재현 가능하게 기록한다. |
| 2 | 학습 구현 복구와 재현 환경 고정 | 실제 학습 코드, 데이터/분할 해시, 전처리, seed·환경·체크포인트 선택 규칙을 저장한다. 독립 실행에서 전처리와 평가 보고서를 재현한다. |
| 3 | 형상·부품·속도 기반 surrogate 학습 | 수정 설계의 시뮬레이션 결과로 타깃을 만든다. 추론 입력에서 성능 앵커와 타깃에서 파생된 값을 제거하거나, 별도 조건부 모델로 계약을 분리한다. 학습·평가에서도 동일한 입력 가용성을 사용한다. |
| 4 | 수정 설계에 대한 검증 | 기준 설계와 수정본을 같은 분할에 묶어 누출을 막는다. 보지 못한 기준 설계의 편집 쌍, 변경 폭, topology/부품·속도 범위별 오차와 실패율을 보고한다. 허용 오차는 학습 전에 합의한다. |
| 5 | 질량·유효성·최고속도 기능 추가 | 질량의 근거/타깃을 마련하고 비유효 속도를 포함한 분류 데이터를 구성한다. 최고속도와 비연속 유효 속도 집합의 정의를 명시한다. F1뿐 아니라 잘못된 유효 판정, 상한 과대예측과 설계별 속도 집합 일치율을 승인 기준에 넣는다. |
| 6 | 불확실성 및 물리적 일관성 검증 | 설계별 오차·구간 coverage·범위 밖 실패율을 held-out 데이터로 평가한다. 시간/거리·에너지·힘의 관계와 비정상 출력 처리 기준을 정하고 보고한다. 음수 일부를 숨기는 현재 표시 규칙을 유효성 분류로 대체 해석하지 않는다. |

에이전트는 각 답변과 최적화 제안에 계산 출처(`dataset`, `neighbor-estimate`,
`baseline-conditioned`), 모델 버전, draft fingerprint, 속도, 앵커 사용 여부와
미지원 변경을 연결해야 한다. similarity를 AI 신뢰도로 읽는 설명, 미지원 변수의
영향을 계산했다고 주장하는 설명, 예측을 비행 가능성으로 단정하는 설명은
평가 실패로 다룬다. 같은 설계의 전후 비교도 동일한 계산 출처와 조건을 사용해야
한다. 이 기준을 회귀 예제로 검증한 뒤 에이전트의 설계 판단 범위를 넓힌다.
