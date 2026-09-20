# 속도 조건부 Trim 모델 — 작업 설계서

**받는 사람: 데스크탑(CUDA GPU)에서 학습을 맡을 팀원.**
`ml/` 코드베이스를 처음 보는 사람이 이 문서만으로 시작할 수 있게 썼습니다.

배경은 [POINTNET_MODEL.md](POINTNET_MODEL.md)(기존 모델), [DRONE_PRIMER.md](DRONE_PRIMER.md)(드론 용어),
[HANDOFF.md](HANDOFF.md)(데이터 구조)에 있습니다. 먼저 읽어두면 훨씬 수월합니다.

---

## 1. 무엇을 만드는가

**형상 + 비행속도를 넣으면 그 속도에서의 비행 상태를 예측하는 모델**입니다.

```
지금 있는 모델 :  STL           →  Mass, Max_Distance          (설계당 2개)
이번에 만들 것 :  STL + 속도    →  비행 상태 6개 + 유효성      (속도마다)
```

[MODEL_CARD.md](MODEL_CARD.md) 교체 계획 3번 `design + velocity 조건부 trim model 학습`입니다.

### 왜 필요한가

웹앱의 **Performance Simulator**(3단계 탭)는 0–50 m/s 슬라이더를 움직이면
Drag / Lift / Thrust / Pitch / Power / Current / Flight Time / Distance 8개가 즉시 바뀝니다.

이 값들은 지금 `trims.npy`에서 **그냥 읽고 있습니다.** 모델이 관여하지 않습니다.
확인해보면 design 17297의 13 m/s 행과 화면 값이 완전히 일치합니다.

| | drag | thrust | pitch | power | current | flightTime | distance |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 데이터 | 6.69 | 68.39 | −5.6 | 1297.73 | 84.64 | 952.73 | 12385.52 |
| 화면 | 6.7 | 68.4 | −5.6 | 1,298 | 84.6 | 953 | 12.4 km |

**그래서 사용자가 Design Studio에서 형상을 바꾸는 순간 이 화면은 쓸 수 없게 됩니다.**
새 설계에는 `trims.npy`가 없으니까요. 이 모델이 그 자리를 채웁니다.

---

## 2. 시작 전 필요한 것

| | |
| --- | --- |
| 원본 데이터 | `AircraftVerse_1/2/3` 압축 해제본 약 85GB (팀 드라이브 zip 3개, 각 3.8GB) |
| GPU | CUDA. 기존 모델은 RTX 3070 8GB에서 21.5분 학습 |
| 환경 | `ml/README.md`의 venv 절차. `ml/requirements.txt` + PyTorch |
| 브랜치 | `feature/hw-drone` |

원본 폴더는 `drone-craft`의 형제 위치에 두거나 `--data-root`로 지정합니다
(자세한 배치는 [HANDOFF.md](HANDOFF.md) "원본 데이터" 절).

```
AircraftVerse_1/design_<id>/trims.npy     ← 이번 작업의 타깃 원천
AircraftVerse_1/design_<id>/cadfile.stl   ← 입력 원천 (기존과 동일)
```

---

## 3. 데이터 계약

### 3.1 `trims.npy` 구조

설계 하나당 `(51, 12)` float64입니다. **행 = 속도 0~50 m/s (1 m/s 간격), 열 = 12개 항목.**

열 순서는 `ml/common.py`의 `TRIM_FIELDS`가 유일한 정의입니다. 직접 세지 마세요.
shape 검증은 같은 파일의 `TRIMS_SCHEMA = ("<f8", (51, 12))`를 쓰세요.

```
0 distance   1 flightTime        2 pitch             3 maxUc
4 thrust     5 lift              6 drag              7 current
8 power      9 motorCurrentRatio 10 motorPowerRatio  11 batteryCurrentRatio
```

### 3.2 유효성 — 전부 0인 행은 "성능 0"이 아니라 해석 실패

`ml/common.py`에 이미 있습니다. **새로 만들지 말고 그대로 쓰세요.**

```python
from common import TRIM_FIELDS, trim_row_valid

col = {name: i for i, name in enumerate(TRIM_FIELDS)}   # verify_stage0.py:176과 같은 관용구
pitch = trims[speed, col["pitch"]]
# trim_row_valid(row): 어떤 열이든 finite이고 0이 아니면 유효
```

유효 속도 구간은 설계마다 극단적으로 다릅니다. showcase 12개 실측입니다.

| 설계 | 유효 구간 | 유효 행 수 |
| --- | --- | --- |
| 3803 | 0–49 m/s | 50 |
| 17297 | 0–29 m/s | 30 |
| 8893 | 0–14 m/s | 15 |
| **1459** | **17–20 m/s** | **4** |
| **13077** | **12–12 m/s** | **1** |

12개 전체에서 유효 행은 368 / 612 = **60%** 입니다.
전체 규모는 27,714 × 51 = 1,413,414행이고, 그중 유효분이 학습 대상입니다.

> 참고로 기존 `Max_Distance` 모델의 학습 표본은 8,604개였습니다.
> **감독 신호가 두 자릿수 배로 늘어납니다.** encoder에게 좋은 일입니다.

### 3.3 split은 반드시 기존 것을 그대로

`ml/prepare_targets.py`의 `assign_split()`을 재사용하세요.

```python
SPLIT_SALT = "aircraftverse-pointcloud-v1"
# sha256(f"{SPLIT_SALT}:{family}") → 80/10/10, family 단위
```

파일로 저장된 split이 아니라 **해시에서 매번 계산**되므로 어느 기계에서도 같습니다.
설계 개체가 아니라 **family 단위**로 나눕니다(같은 family는 topology·부품이 거의 같아 누수가 됩니다).

**이걸 바꾸면 기존 모델과 수치를 비교할 수 없게 됩니다.** 그대로 쓰세요.

---

## 4. 출력 설계 — 8개를 그대로 예측하지 않습니다

화면의 8개 중 **6개만 회귀로 예측하고, 1개는 계산하고, 1개는 뺍니다.**

| 화면 값 | 처리 | 이유 |
| --- | --- | --- |
| `pitch` | 회귀 | |
| `drag` | 회귀 | |
| `thrust` | 회귀 | |
| `flightTime` | 회귀 | |
| `power` | 회귀 | |
| `current` | 회귀 | |
| **`distance`** | **계산** | `distance = speed × flightTime` |
| **`lift`** | **제외** | 유효 행의 98.6%가 0 |

### `distance`를 예측하지 마세요

정확히 성립하는 항등식입니다. 검증했습니다.

```
design 17297 @ 25 m/s :  25 × 813.77 = 20,344.25   vs   데이터 20,344.35
```

예측하면 `flightTime`과 모순되는 값이 나올 수 있습니다. **유도하면 공짜로 일관성이 보장됩니다.**

### `lift`를 타깃에 넣지 마세요

showcase 유효 행 368개 중 `lift != 0`인 것은 **5개(1.4%)** 뿐입니다.
날개 없는 기체는 정의상 0이라서요(데이터셋의 77%가 날개 0).

그대로 회귀에 넣으면 **"전부 0"이라고 답해도 R²가 높게 나옵니다.**
날개 기체만 따로 다루거나, 이번 범위에서는 제외하세요.

### ⚠ 유효성 헤드는 필수입니다

회귀만 만들면 **40 m/s로 뜨지도 못하는 기체에 그럴듯한 숫자를 뱉습니다. 에러 없이요.**
화면의 `유효 trim 범위 0-29 m/s` 배지가 이 출력입니다.

**속도별 이진 분류 헤드를 반드시 같이 학습시키세요.**

---

## 5. 모델 구조

기존 `ml/model.py`의 `PointNetEncoder`를 그대로 쓰고 **헤드만 조건부로** 바꿉니다.

```
points (B, 1024, 3)
    │
    ▼  PointNetEncoder(pool="maxmean")          ← 무겁다. 설계당 1회
embedding (B, 2048)
    │
    ├── concat  log(scale) 표준화 (B, 1)
    ▼
design_features (B, D)
    │
    ├── concat  speed/50  (B, 51, 1)            ← 51개 속도로 확장
    ▼  작은 MLP                                   ← 가볍다
    ├──▶ 회귀 6개    (B, 51, 6)
    └──▶ 유효성 로짓 (B, 51)
```

### ⭐ 배치를 이렇게 짜세요 — 이게 핵심입니다

**설계 하나를 인코딩한 뒤 51개 속도 전부에 재사용합니다.**

```python
feat = encoder(points)                        # (B, D)       무거운 연산 1회
feat = feat[:, None, :].expand(-1, 51, -1)    # (B, 51, D)   복사만
out  = head(cat([feat, speed_grid], -1))      # (B, 51, 7)   싼 연산
```

(설계, 속도) 쌍을 무작위로 뽑으면 같은 설계를 몇 번씩 다시 인코딩하게 됩니다.
위 방식이면 **인코더 1회당 감독 신호가 51배**입니다. 거의 공짜입니다.

손실은 마스크로 가립니다.

```python
reg_loss = huber(pred[mask], target[mask])        # 유효 행만
cls_loss = bce_with_logits(logit, mask.float())   # 51행 전부
loss = reg_loss + LAMBDA * cls_loss               # LAMBDA는 튜닝 대상
```

### 정규화

| | 방식 | 이유 |
| --- | --- | --- |
| 속도 | `speed / 50` | 학습 통계에 의존하지 않아 ONNX에 넣기 쉽습니다 |
| `scale` | 기존과 동일 `log(scale)` 표준화 | [POINTNET_MODEL.md](POINTNET_MODEL.md) 2.2절 |
| 타깃 | train 유효 행에서만 표준화 | val/test 통계를 쓰면 누수입니다 |

---

## 6. 단계별 작업

### 6.1 `ml/prepare_trims.py` (신규)

`prepare_targets.py` / `prepare_pointclouds.py`와 같은 골격으로 만드세요
(`add_data_root_arg`, `resolve_roots`, `iter_design_dirs`, `write_json` 재사용).

읽기: 설계별 `trims.npy`
쓰기: `ml/data/trims.npz`

```python
design_id   (N,)        int32
trim        (N, 51, 6)  float32   # pitch, drag, thrust, flightTime, power, current
trim_valid  (N, 51)     bool
split       (N,)                  # assign_split(family)
```

**점구름은 다시 뽑지 마세요.** 기존 `ml/data/pointclouds.npz`에 있습니다.
`design_id`로 조인하면 됩니다(순서 가정 금지). 이 파일은 약 36MB로 작습니다.

리포트는 `ml/reports/stage6_trims.json`에 남기세요 — 유효 행 수, 속도별 분포,
split별 개수, 설계별 유효 구간 히스토그램.

### 6.2 `ml/dataset_trim.py` (신규)

`dataset.py`의 `Bundle` / `load_bundle` 패턴을 따르되 trim 축을 추가합니다.
타깃 표준화는 **train의 유효 행에서만** 계산합니다.

### 6.3 `ml/model_trim.py` (신규)

`model.py`의 `PointNetEncoder`를 import해서 재사용하고, 조건부 헤드만 새로 씁니다.
encoder를 복붙하지 마세요 — 기존 모델과 구조가 갈라집니다.

### 6.4 `ml/train_trim.py` (신규)

`train.py`의 CLI 규약을 따르세요 (`--epochs --batch-size --lr --pool --patience --tag --device`).
**모델 선택은 val로만** 합니다. test는 평가 스크립트에서 한 번만 읽습니다.

### 6.5 `ml/evaluate_trim.py` (신규)

`ml/reports/stage7_trim_evaluation.json`에 기록:

- 출력 6개 각각의 test R² / MAE
- **속도 0 행을 제외한 수치도 따로** (아래 함정 5번)
- 유효성 분류: precision / recall / 예측 구간 vs 실제 구간
- prediction interval (기존 `evaluate.py`의 곱셈형 밴드 방식 재사용)
- baseline 대비

**baseline을 반드시 두세요.** 기존 문서 4.3절의 교훈입니다.

| baseline | 내용 |
| --- | --- |
| 속도별 평균 | 각 속도에서 전 설계 평균 |
| `mesh` + 속도 | 형상 요약 스칼라 6개 + 속도로 선형회귀 |

`mesh+cad`는 설계 변수를 정답으로 받으므로 **합격선이 아니라 지향점**입니다.

### 6.6 `ml/export_onnx_trim.py` (신규)

**인코더와 헤드를 따로 내보내세요.** UI가 이걸 원합니다.

```
trim-encoder-v1.onnx :  points_mm (1,1024,3)               →  design_features (1,D)
trim-head-v1.onnx    :  design_features (1,D), speed (1,51) →  trim (1,51,6), valid (1,51)
```

설계를 고를 때 인코더를 1회 돌리고, **슬라이더는 헤드만 재실행**합니다.
51개 속도를 한 번에 넣어 곡선 전체를 그려도 순식간입니다.

`export_onnx.py`처럼 전처리·후처리를 그래프에 넣고,
`verify_onnx.py`에 대응하는 수신측 검증 스크립트도 같이 만드세요.

---

## 7. 함정 목록

기존 작업에서 실제로 겪었거나 데이터에서 확인한 것들입니다.

1. **`distance`를 예측하지 마세요.** `speed × flightTime`으로 유도합니다.
2. **`lift`는 98.6%가 0.** 회귀 타깃에 넣으면 R²가 가짜로 올라갑니다.
3. **유효성 헤드 없이 배포 금지.** 못 나는 속도에 조용히 숫자가 나옵니다.
4. **유효 행이 1~4개인 설계가 있습니다**(13077은 1개). 학습·평가 모두에서 극단값입니다.
5. **속도 0 행은 쉽습니다.** `drag = 0`, `distance = 0`, `pitch = 0`이 거의 자동입니다.
   전체 R²에 섞으면 성능이 과대평가됩니다. **속도 0 제외 수치를 따로 보고하세요.**
6. **`power` / `current`는 기대치를 낮추세요.** 84.6A라는 전류는 배터리가 6S냐 4S냐로
   결정되는데 point cloud에는 그 정보가 없습니다. `Max_Distance` R² 0.62가 나온 것과 같은 이유입니다.
   반대로 **`drag`와 `pitch`는 순수 공력·기하라 잘 나올 가능성이 높습니다.**
7. **수축(shrinkage)을 처음부터 감시하세요.** 기존 모델의 `Max_Distance`가 극단값을
   평균으로 끌어당기는 문제를 겪었습니다([POINTNET_MODEL.md](POINTNET_MODEL.md) 6절).
   Huber loss가 이 경향을 **강화**합니다. MSE와 로그 타깃을 초기에 같이 실험해보세요.
   10분위별 `예측/실제` 비율 표를 학습 중에도 찍으면 일찍 발견합니다.
8. **콘솔 출력은 ASCII로.** 한국어 Windows는 cp949라 em-dash 하나에
   `UnicodeEncodeError`로 스크립트가 죽습니다. 실제로 `verify_onnx.py`에서 발생했습니다.
9. **샘플링 난수만으로 예측이 흔들립니다.** 같은 STL도 시드가 다르면 `Max_Distance`가
   7,031~14,328m로 벌어집니다(`ml/reports/sampling_variance.json`).
   평가할 때 재샘플링 분산을 같이 재두면 해석이 쉬워집니다.

---

## 8. 재사용할 기존 코드

새로 만들지 말고 import하세요.

| 대상 | 위치 |
| --- | --- |
| `trim_row_valid()`, `TRIM_FIELDS`, `TRIMS_SCHEMA` | `ml/common.py` |
| `is_available_metric()` | `ml/common.py` |
| `iter_design_dirs()`, `resolve_roots()`, `add_data_root_arg()`, `write_json()` | `ml/common.py` |
| `assign_split()`, `SPLIT_SALT`, family 추출 | `ml/prepare_targets.py` |
| `PointNetEncoder` | `ml/model.py` |
| `Bundle` / `load_bundle` 패턴 | `ml/dataset.py` |
| 곱셈형 prediction interval | `ml/evaluate.py` |
| 점구름 `(N, 1024, 3)` + scale | `ml/data/pointclouds.npz` |

---

## 9. 완료 기준

- [ ] `ml/reports/stage6_trims.json` — 유효 행 수와 분포가 기록됨
- [ ] 출력 6개의 test R²가 **속도 0 포함/제외 두 가지로** 기록됨
- [ ] 두 baseline 대비 수치가 기록됨
- [ ] 유효성 분류 precision/recall이 기록됨
- [ ] 10분위 `예측/실제` 비율 표로 수축 여부가 문서화됨
- [ ] 인코더/헤드 분리 ONNX + 수신측 검증 스크립트
- [ ] `docs/TRIM_MODEL.md` — [POINTNET_MODEL.md](POINTNET_MODEL.md)와 같은 수준의 설명
- [ ] **쓰면 안 되는 용도**가 명시됨 (기존 모델의 "랭킹 금지"에 해당하는 것)

---

## 10. 질문이 생기면

| 주제 | 문서 |
| --- | --- |
| 데이터 구조 | [HANDOFF.md](HANDOFF.md) |
| 드론 용어 (trim, pitch, thrust가 뭔지) | [DRONE_PRIMER.md](DRONE_PRIMER.md) |
| 기존 모델이 왜 그렇게 나왔는지 | [POINTNET_MODEL.md](POINTNET_MODEL.md) |
| 웹앱이 이 값을 어떻게 쓰는지 | `components/views/simulator-view.tsx` |
