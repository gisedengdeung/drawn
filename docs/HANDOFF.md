# ML 작업 인수인계 — Point Cloud 성능 예측 모델

이 문서는 **데스크탑 환경에서 새 세션을 시작할 때 맥락을 이어받기 위한** 인수인계 노트입니다.
노트북에서 레포를 분석하고 정리한 결과를 담고 있으며, 모든 수치는 이 레포의 실제 데이터로 검증했습니다.

드론 도메인 지식은 [DRONE_PRIMER.md](DRONE_PRIMER.md), 현재 추정기의 한계는 [MODEL_CARD.md](MODEL_CARD.md)를 참고하세요.

> **0~3단계는 데스크탑에서 완료되었습니다 (2026-09-14).** 환경 구축, 27,714개 전수 검증,
> 타깃 추출과 split 고정, point cloud 샘플링, PointNet 학습까지 끝났습니다.
> 학습셋 `ml/data/pointclouds.npz`(333MB)와 체크포인트
> `ml/runs/rung3_mass_distance.pt`가 있습니다(둘 다 git 제외).
>
> **모델이 무엇을 보고 어떻게 이 결과를 냈는지는 [POINTNET_MODEL.md](POINTNET_MODEL.md)에
> 따로 정리했습니다.** 입력 변수, 구조, 왜 이 수치가 나왔는지를 설명합니다.
>
> 재현 절차는 [../ml/README.md](../ml/README.md), 원본 결과는 `ml/reports/`와 `ml/runs/`입니다.
> 남은 것은 **4단계(test split 채점, prediction interval, model version 기록)**입니다.
>
> 특히 [4단계 baseline이 바뀌었습니다](#4단계-baseline이-바뀌었습니다) — 평균 예측이 아니라
> `mesh` 회귀를 이겨야 하며, `mesh+cad`를 합격선으로 쓰면 안 됩니다.

## 담당 작업

**3D 형상(point cloud)을 입력으로 받아 드론 성능 KPI를 예측하는 딥러닝 모델**을 만듭니다.
[MODEL_CARD.md](MODEL_CARD.md)의 교체 계획 2번 `PointNet/DGCNN geometry embedding 결합`에 해당합니다.

## 현재 레포 상태

- Next.js 프론트엔드 단독. **백엔드가 없습니다.**
- `public/data/`의 정적 JSON을 브라우저가 직접 fetch하고, 추정 계산도 클라이언트 JS에서 돕니다.
- README의 FastAPI는 아직 제안 단계입니다.
- `public/data`(238MB)와 STL 12개가 git에 커밋되어 있어, **원본 없이도 웹앱은 실행됩니다.**

```bash
npm install && npm run dev   # 원본 데이터 불필요
```

## 원본 데이터

공유 드라이브의 zip 3개(각 3.8GB, 합계 약 11.4GB)를 풀면 약 85GB입니다.

```
<workspace>/
├── AircraftVerse_1/          9,238 designs
│   ├── design_1/
│   │   ├── cadfile.stl            ← point cloud를 여기서 뽑습니다
│   │   ├── Geom.stp               ← STEP CAD. 용량 대부분. 파싱 안 함
│   │   ├── design_low_level.json  ← 설계 변수 전체
│   │   ├── design_seq.json        ← Transformer branch용 (이번 작업 범위 밖)
│   │   ├── design_tree.json       ← 부품 트리
│   │   ├── output.json            ← 학습 타깃 KPI
│   │   ├── pointCloud.npy         ← (100, 3) float32
│   │   └── trims.npy              ← (51, 12) float64
│   └── ...
├── AircraftVerse_2/          9,238
├── AircraftVerse_3/          9,238
└── drone-craft/              ← 이 레포. AircraftVerse_*와 형제 위치
```

총 **27,714개 설계**입니다. `npm run data:prepare`를 다시 돌릴 경우에만 위 형제 배치가 필요하며,
다른 위치에 풀었다면 `--data-root <경로>`를 세 번 지정하면 됩니다. ML 학습에는 배치 제약이 없습니다.

`corpus_dic`(72KB)은 신뢰되지 않은 Python pickle입니다. **`pickle.load`를 호출하지 마세요.**
`design_seq` 계열 vocabulary로 보이며 point cloud 작업에는 필요하지 않습니다.

## 핵심 발견 3가지

작업 방향을 바꾸는 내용이므로 시작 전에 반드시 확인하세요.

### 1. 제공된 `pointCloud.npy`는 100점입니다

전처리 스크립트가 shape를 단언하고 있습니다.

```js
// scripts/prepare-aircraftverse.mjs:742
assertNpySchema(path.join(designDir, 'pointCloud.npy'), '<f4', [100, 3]);
```

AircraftVerse 명세의 10,000점이 아니라 **(100, 3)** 입니다. PointNet 계열은 보통 1,024~10,000점을 쓰므로
100점은 6-rotor 형상을 표현하기에 지나치게 성깁니다.

**대응: `cadfile.stl`에서 직접 면적 가중 샘플링하세요.**

```python
import trimesh
mesh = trimesh.load(stl_path)
points, _ = trimesh.sample.sample_surface(mesh, 1024)   # (1024, 3)
```

> **0단계에서 확정.** 27,714개 전부 `<f4 (100, 3)`입니다. 예외 없습니다.
> STL 샘플링도 동작을 확인했습니다 (design 17297: 5,872면 → 1,024점).

### 2. 단위 구 정규화는 크기 정보를 파괴합니다

PointNet 예제는 대부분 centroid 이동 후 단위 구로 정규화합니다. 분류 과제에는 맞지만
**이번 과제는 성능 회귀**이고, 드론은 크기가 성능을 지배합니다
(레포 내 설계의 날개폭은 1.3m부터 5.2m까지 분포).

정규화하면 30cm 기체와 5m 기체가 동일한 입력이 됩니다.

**대응: `scale`을 버리지 말고 별도 스칼라 입력으로 함께 넣으세요.**

```python
centroid = points.mean(axis=0)
points = points - centroid
scale = np.abs(points).max()
points = points / scale          # scale을 feature로 보존할 것
```

이 항목을 놓치면 성능이 나오지 않는데 원인 추적이 매우 어렵습니다.

> **0단계에서 확정: STL 좌표 단위는 mm입니다.** 표본 20개 전부 mm였고,
> design 17297의 bounding box는 `1111 × 1538 × 307 mm`입니다.
> 따라서 위 `scale`도 mm 단위 스칼라이며, `output.json`의 `Mass`(kg)나
> `Max_Distance`(m)와 스케일이 다릅니다. feature로 넣을 때 로그 변환이나 표준화를 검토하세요.

### 3. 형상만으로는 성능 예측이 제한적입니다

동일 형상이라도 모터 KV, 배터리 용량에 따라 비행거리가 몇 배 달라지는데 point cloud에는 그 정보가 없습니다.
[MODEL_CARD.md](MODEL_CARD.md)의 계획도 geometry를 **결합되는 한 축**으로 두고 있습니다.

**형상 단독 모델의 R²가 0.4~0.6이어도 실패가 아닙니다.** 부품 정보와 결합할 때 값어치가 나옵니다.
이 기대치를 팀과 먼저 공유하세요.

## 학습 타깃

`output.json`에서 가져옵니다. 실제 키 이름은 다음과 같습니다.

```
Mass, Max_Distance, Hover_Time, Max_Speed, Power_MFD, Speed_MFD,
Interferences, Max_uc_at_MFD,
Mot_amps_ratio_MFD, Mot_power_ratio_MFD, Batt_amps_ratio_MFD, ...
```

### 0을 학습시키지 마세요

성능값 0은 물리량 0이 아니라 **해석 실패 또는 비실현 상태**입니다.

| 타깃 | 유효 설계 수 | 비율 |
| --- | --- | --- |
| `Mass` | 27,714 | 100% |
| `Max_Distance` | 10,737 | 39% |
| `Hover_Time` | 7,789 | 28% |

`trims.npy`의 전부 0인 행과 non-finite 값도 동일하게 무효 처리합니다.
프론트엔드의 `isAvailableMetric`([lib/aerotwin-types.ts](../lib/aerotwin-types.ts))이 같은 규칙을 씁니다.

### 디버깅 사다리

처음부터 어려운 KPI를 맞히려 하지 말고 순서대로 올라가세요.

| 순서 | 타깃 | 목적 | 통과 기준 |
| --- | --- | --- | --- |
| 1 | 순수 기하량 (전체 span, 동체 길이) | 파이프라인 검증 | R² > 0.95 |
| 2 | `Mass` | 쉬운 실제 타깃 | — |
| 3 | `Max_Distance`, `Hover_Time` | 실제 목표 | — |

1번이 통과하지 못하면 모델이 아니라 **데이터 로딩이 틀린 것**입니다. 여기서 잡고 진행하세요.

> **2단계 데이터로 확인한 주의 — 1번 계단만으로는 부족합니다.**
>
> `span`은 `log(scale)` 하나만으로 **R² 0.926**이 나옵니다 (`span/scale` 비율이 p50 1.998, std 0.189로 좁음).
> `scale`을 모델 입력으로 넣는 순간 0.926이 공짜로 들어오므로, 0.95 통과는
> point cloud를 읽었다는 증거가 아니라 **`scale` 배선이 연결됐다는 증거**일 뿐입니다.
>
> **1번 계단에 scale 불변량을 최소 하나 넣으세요.** `extents[2]/extents[0]` 같은 종횡비나
> `fuselage_vert_diameter / scale`은 정규화된 구름을 실제로 읽어야만 풀립니다.
> 이쪽이 실패해야 "데이터 로딩이 틀렸다"는 원래 의도대로 걸립니다.
>
> 2번 계단(`Mass`)도 마찬가지로 해석에 주의가 필요합니다. 아래 "4단계 baseline" 절 참고.

## 하드웨어

| | 노트북 | 데스크탑 |
| --- | --- | --- |
| CPU/GPU | Intel Core Ultra 7 258V / Arc iGPU | RTX 3070 (8GB) |
| RAM | 32GB | — |
| CUDA | 없음 | 있음 |
| 용도 | 전처리, 코드 작성, 웹앱 | **학습** |

**학습은 데스크탑에서 합니다.** Arc iGPU는 PyTorch XPU 백엔드로 동작은 하지만 자료가 적어
환경 세팅에서 학습 시간보다 더 소모됩니다. RTX 3070 8GB는 PointNet에 충분합니다
(1,024점, batch 32 기준 VRAM 2~3GB).

전처리는 GPU를 쓰지 않으므로 어느 쪽에서 해도 됩니다. 전처리 결과는 작습니다.

```
27,714 × 1,024점 × 3좌표 × 4byte = 약 340 MB
```

85GB 원본이 340MB 학습셋이 되므로, 한쪽에서 전처리하고 파일 하나만 옮겨도 됩니다.

## 작업 단계

| 단계 | 내용 | 환경 | 예상 |
| --- | --- | --- | --- |
| 0 | ~~압축 해제, `pointCloud.npy` shape 확인~~ **완료** | 아무 곳 | 반나절 |
| 1 | ~~타깃 추출, 유효성 필터, split 고정~~ **완료** | 아무 곳 | 1일 |
| 2 | ~~STL → point cloud 샘플링, `.npz` 저장~~ **완료** (실제 2.7분) | 아무 곳 (CPU) | 2~4시간 |
| 3 | ~~PointNet 학습~~ **완료** (실제 21.5분) → [POINTNET_MODEL.md](POINTNET_MODEL.md) | **데스크탑** | 2~3일 |
| 4 | 검증셋 R²/MAE, baseline 대비 비교 | 데스크탑 | 1일 |
| 5 | ONNX 내보내기 또는 FastAPI 연결 | — | 이후 |

4단계의 baseline은 **"타깃 평균으로만 예측했을 때"** 입니다. 이 기준이 없으면 R² 수치의 좋고 나쁨을 판단할 수 없습니다.
[MODEL_CARD.md](MODEL_CARD.md)가 요구하는 기록 항목은 검증셋 R²/MAE, prediction interval, model version입니다.

## 코드 배치

같은 레포의 `ml/` 폴더에 둡니다.

```
drone-craft/
├── ml/
│   ├── README.md                # 환경 구축 절차 (0단계에서 작성)
│   ├── requirements.txt         # numpy, trimesh
│   ├── common.py                # 공유 유틸. 유효성 규칙·trim 열 순서의 유일한 정의
│   ├── verify_stage0.py         # 0단계 전수 검증
│   ├── prepare_targets.py       # 1단계 타깃 추출·split
│   ├── prepare_pointclouds.py   # 2단계 STL → (N, 1024, 3) + scale
│   ├── geometry_baseline.py     # 3·4단계가 넘어야 할 바닥
│   ├── reports/                 # 검증 리포트 (커밋)
│   ├── dataset.py
│   ├── model.py                 # PointNet
│   ├── train.py
│   ├── evaluate.py
│   ├── data/                    # .npz 산출물 (git 제외)
│   └── .venv/                   # (git 제외)
├── app/ components/ lib/        # 기존 프론트엔드
└── public/data/                 # 커밋된 정적 자산
```

`.gitignore`에 ML 산출물 제외 규칙을 추가해두었습니다. **340MB `.npz`를 커밋하지 않도록 주의하세요.**

## 0단계 검증 결과

데스크탑에서 `ml/verify_stage0.py`로 27,714개를 전수 검증했습니다. **10개 항목 전부 통과**(약 30초).
재현은 [../ml/README.md](../ml/README.md), 원본 결과는 `ml/reports/stage0_report.json`입니다.

### 확정된 사실

| 항목 | 결과 | 다음 단계에서의 의미 |
| --- | --- | --- |
| 설계 수 | 27,714 (9,238 × 3) | — |
| `pointCloud.npy` | 27,714개 전부 `<f4 (100, 3)` | 핵심 발견 #1 확정. STL 샘플링 필요 |
| `trims.npy` | 27,714개 전부 `<f8 (51, 12)` | — |
| 파일 무결성 | 5개 필수 파일 누락 0건, 깨진 STL 0건 | 2단계에서 예외 처리 부담 없음 |
| **design ID** | **세 파트에 걸쳐 전역 유일** | 1단계 split 키를 ID 단독으로 잡아도 안전 |
| `output.json` 키 | 16개, HANDOFF 목록과 일치 | — |
| 유효 설계 수 | Mass 27,714 / Max_Distance 10,737 / Hover_Time 7,789 | 유효성 규칙 해석이 프론트엔드와 일치함을 확인 |
| **trim 열 순서** | design 17297로 실측 확인 | 아래 참조 |
| STL 단위 | **mm** (표본 20개 전부) | 2단계 `scale` feature 단위 |
| CUDA | torch 2.14.0+cu126, RTX 3070 8GB 인식 | 3단계 학습 가능 |

### trim 열 순서 (실측 확인됨)

`trims.npy`에는 열 이름이 없습니다. 아래 순서는 `scripts/prepare-aircraftverse.mjs`에만 기록되어 있었고,
0단계에서 design 17297의 실제 값으로 확인했습니다.

```
0 distance   1 flightTime  2 pitch    3 maxUc
4 thrust     5 lift        6 drag     7 current
8 power      9 motorCurrentRatio  10 motorPowerRatio  11 batteryCurrentRatio
```

대조에 쓴 값 — 전부 일치했습니다.

| 검증 | 실측 |
| --- | --- |
| `trim[0].thrust` = `Mass × 9.8` | 68.57 = 6.9967 × 9.8 |
| `trim[25].distance` = `25 × flightTime` | 20,344.35 |
| drag(5/10/15/20/25) | 1.0 / 3.98 / 8.85 / 15.31 / 23.17 N |
| 첫 무효 속도 행 | 30 m/s (유효 30행) |

행 인덱스는 속도(m/s) 0–50이고, 모든 열이 0이거나 non-finite인 행이 무효입니다.

## 1단계 결과

`ml/prepare_targets.py`가 `ml/data/targets.csv`(27,714행 × 65열)와 `ml/reports/stage1_report.json`을
만듭니다. 약 25초. 아래 세 가지는 **작업 방향을 바꾸는 내용**이라 2단계 전에 반드시 읽으세요.

### 1. split은 design이 아니라 family 단위여야 합니다

`design_low_level.json`의 `name`은 `design_<n>_<uuid>_<variant>` 형식입니다.
**8,084개 family가 `dw`/`dw_dl` 쌍을 가지며, 전체의 58.3%(16,168개)가 형제를 가집니다.**

형제는 완전 중복이 아닙니다. topology·부품·시드가 같고 치수만 다릅니다.

| 타깃 | 형제 간 상대차 중앙값 | p90 |
| --- | --- | --- |
| `Mass` | 5.7% | 8.3% |
| `Max_Distance` | 7.3% | 27.4% |
| `Hover_Time` | 6.2% | 12.2% |

design_id로 무작위 분할하면 형제 절반이 train/test를 가로질러 검증 점수가 부풀려집니다.
파라미터·부품이 바이트 단위로 동일한 **완전 중복은 0건**이므로, 내용 해시만으로는 이 관계를 못 잡습니다.
`prepare_targets.py`는 `sha256(salt + family)`로 배정하므로 **split 파일 없이 재현**됩니다.

실제 결과: train 22,187 (80.1%) / val 2,803 (10.1%) / test 2,724 (9.8%), family가 split을 가로지르는 경우 0건.

### 2. `Mass`는 100% 유효하지만 11개가 물리적으로 불가능합니다

`isAvailableMetric` 규칙(`>0`, finite)은 27,714개 전부 통과합니다. 그런데 11개 설계가
**60,000~240,000 kg**을 보고합니다. 정상 집단의 최대는 35.3 kg이고 그다음 값이 60,044 kg입니다.
11개 모두 다른 KPI는 전부 0(해석 실패)입니다.

**유효성(`*_valid`)은 필요조건이지 충분조건이 아닙니다.** `prepare_targets.py`의 `trainable(row, key)`가
학습 필터의 유일한 정의이며, 2~4단계는 이것으로 걸러야 합니다. 11개는 삭제하지 않고
`mass_plausible` 열로 표시만 해두었습니다.

이 필터를 빼먹으면 `Mass` baseline이 train 평균 59.2 kg / test RMSE 576.8로 망가집니다.

### 3. 4단계 baseline 수치

"타깃 평균으로만 예측했을 때"의 실제 값입니다. 이 기준 없이는 R² 해석이 불가능합니다.

| 타깃 | train 평균 | test MAE | test RMSE | trainable 수 |
| --- | --- | --- | --- | --- |
| `Mass` | 7.78 kg | 3.71 | 5.13 | 27,703 |
| `Max_Distance` | 3,098 m | 2,554 | 3,653 | 10,737 |
| `Hover_Time` | 175.1 s | 123.0 | 168.1 | 7,789 |

### 디버깅 사다리 1번 타깃 (STL 불필요)

설계 변수에서 바로 뽑았고 전 설계에 존재합니다. 단위는 mm입니다.

| 타깃 | min | p50 | max |
| --- | --- | --- | --- |
| `fuselage_length` | 84.0 | 180.0 | 559.0 |
| `fuselage_horz_diameter` | 311.4 | 372.9 | 804.9 |
| `arm_length_max` | 50.1 | 397.8 | 500.0 |
| `arm_length_sum` | 50.1 | 753.4 | 7,070.5 |

"전체 span"은 STL bounding box이므로 2단계에서 샘플링과 함께 기록하면 됩니다.

### 데이터셋 구성 (참고)

| 항목 | 값 |
| --- | --- |
| 로터 수 | 1–16. 최빈 6개(9,803), 4개(7,574) |
| 메인 허브 | Para_Hub_6 13,652 / Para_Hub_4 10,701 / Para_Hub_3 2,111 / Para_Hub_2 1,250 |
| 날개 보유 | 6,343 (22.9%) — DRONE_PRIMER의 23%와 일치 |
| 부품 종류 | 모터 49 / 프로펠러 146 / 배터리 56 — `component-catalogs.json`과 일치 |

## 2단계 결과

`ml/prepare_pointclouds.py`가 `ml/data/pointclouds.npz`(333MB, git 제외)를 만듭니다.
27,714개 전부 **2.7분**(18워커, 173/s), 실패 0건. 자체 검증 6항목 전부 통과.

0단계에서 trimesh로 따로 잰 design 17297의 STL extents `[1111.242, 1538.105, 306.82]`와
2단계 산출물이 소수점까지 일치합니다.

| 키 | shape | 비고 |
| --- | --- | --- |
| `points` | (27714, 1024, 3) f4 | 정규화된 단위구 좌표 |
| `scale` | (27714,) f4 | **mm. 별도 스칼라 입력으로 넣으세요** |
| `centroid` | (27714, 3) f4 | mm |
| `extents` / `span` | (27714, 3) / (27714,) f4 | 메시 bbox. 사다리 1번 타깃 |
| `targets` | (27714, 5) f4 | 학습 불가면 `NaN` |

`raw_mm = points * scale + centroid`로 완전 복원됩니다.
`targets`의 `NaN`이 곧 학습 필터이므로, 손실 계산에서 마스킹만 하면 됩니다.

| | min | p50 | max |
| --- | --- | --- | --- |
| `scale` (mm) | 165.7 | 594.3 | 3,027.7 |
| `span` (mm) | 332.4 | 1,159.8 | 5,957.8 |

## 4단계 baseline이 바뀌었습니다

이 문서는 4단계 baseline을 **"타깃 평균으로만 예측했을 때"**로 정의했습니다.
2단계 데이터로 재보니 **그 바닥은 너무 낮아 판단 기준이 되지 못합니다.**

다만 **대체 기준을 잘못 잡기 쉽습니다.** `ml/geometry_baseline.py`는 서로 다른 질문에 답하는
두 기준을 냅니다. 이 구분을 놓치면 결론이 정반대로 납니다.

| 기준 | 피처 | 답하는 질문 |
| --- | --- | --- |
| **`mesh`** (6) | bbox extents, span, scale, 표면적 | 메시를 훑어서 잴 수 있는 것만. **모델과 동일 정보** |
| `mesh+cad` (11) | 위 + 동체 길이·직경, arm 길이 | 위 + `design_low_level.json`의 **CAD 생성 파라미터** |

test split 기준입니다. val도 리포트에 있습니다.

| 타깃 | n_test | 평균 | **`mesh`** | `mesh+cad` | mesh MAE | mesh+cad MAE |
| --- | --- | --- | --- | --- | --- | --- |
| `Mass` | 2,723 | 0.000 | **0.397** | 0.919 | 2.73 | 1.06 |
| `Max_Distance` | 1,083 | 0.000 | **0.046** | 0.535 | 2,472 | 1,385 |
| `Hover_Time` | 804 | 0.000 | **0.017** | 0.598 | 121.2 | 69.6 |
| `Max_Speed` | 1,083 | 0.000 | **0.178** | 0.228 | 7.53 | 7.29 |
| `Power_MFD` | 1,090 | 0.000 | **0.203** | 0.438 | 814.8 | 655.4 |

### `mesh+cad`를 합격선으로 쓰지 마세요

`mesh+cad`의 힘은 **거의 전부 CAD 파라미터에서** 나옵니다 (`Mass` 0.40 → 0.92,
`Max_Distance` 0.05 → 0.54). 그 5개는 메시에서 잰 값이 아니라 형상을 **생성한** 설계 변수이고,
JSON에서 읽은 정답입니다. 모델은 그걸 형상에서 추론한 다음에야 쓸 수 있으므로
나란히 놓으면 공정하지 않습니다.

**point cloud 모델은 `mesh` 열과 비교하세요.** `mesh+cad`는 합격선이 아니라 **지향점**입니다.

이 구분이 실제로 판정을 뒤집었습니다. 3단계 PointNet의 `Mass` val R² 0.852는
`mesh+cad` 0.923과 비교하면 "실패"지만 `mesh` 0.447과 비교하면 거의 두 배입니다.
더 직접적인 증거로, `fuselage_vert_diameter`를 `mesh` 스칼라로 맞히면 R² 0.236인 반면
PointNet은 0.885입니다 — 모델은 형상에서 CAD 파라미터를 잘 복원하고 있습니다.

[MODEL_CARD.md](MODEL_CARD.md)의 기록 항목에 **두 기준을 모두** 남기세요.

### 타깃을 로그 변환하지 마세요

같은 스칼라로 log 공간에서 적합한 뒤 `exp`로 되돌려 **원래 단위에서** 채점하면 전부 집니다.

| 타깃 | raw 적합 | log 적합 |
| --- | --- | --- |
| `Mass` | **0.919** | 0.848 |
| `Max_Distance` | **0.535** | **−17.438** |
| `Hover_Time` | **0.598** | 0.357 |
| `Power_MFD` | **0.438** | 0.302 |

`Max_Distance`가 붕괴하는 이유는 p50 1,677m에 max 40,905m(24배)인 두꺼운 꼬리를 `exp`가 증폭시키기 때문입니다.

R²를 **log 공간에서 채점하면 log가 이기는 것처럼 보입니다**(분모가 다름). 실제로 이 함정에 빠져
한 번 잘못 기록했다가 정정했습니다. `ml/reports/geometry_baseline.json`의
`geometry_baseline_log_space_NOT_COMPARABLE` 항목이 그 값이며, 위 표와 나란히 비교하면 안 됩니다.

꼬리 문제 자체는 남습니다. 해법은 타깃 변환이 아니라 **손실 변경**입니다 —
타깃을 z-score 정규화하고 Huber loss를 쓰면 채점 공간을 유지한 채 꼬리 지배를 막습니다.

### 따라오는 두 가지

**`Mass`는 span이 아니라 동체 크기로 예측됩니다.** `fuselage_vert_diameter`와 질량의 상관이
0.881인 반면 span은 0.18입니다. 배터리를 담는 동체가 질량을 지배합니다.
사다리 2번(`Mass`)이 쉬운 이유가 크기 자체가 아니라는 점을 알고 가세요.

**핵심 발견 3번의 "형상 단독 R² 0.4~0.6"은 설계 변수를 알 때의 수치입니다.**
`mesh+cad` 기준으로 `Max_Distance` 0.54 / `Hover_Time` 0.60이 맞지만,
형상만 주어졌을 때의 선형 기준(`mesh`)은 0.05 / 0.02로 훨씬 낮습니다.
즉 형상에서 성능으로 가는 길의 대부분은 **설계 변수 복원**이고,
그게 point cloud 모델이 실제로 하는 일입니다.

## 환경 구축 시 주의

데스크탑에는 Python도 Node.js도 없었습니다. `python.exe`는 0바이트 Microsoft Store 스텁입니다.
사용자 PATH 최상단이 `WindowsApps`이고 python.org 설치 프로그램은 PATH 뒤에 추가하므로,
설치 후에도 맨 이름 `python`은 스텁이 잡힐 수 있습니다.

**`py` 런처와 venv 명시 경로만 쓰세요.** 자세한 절차는 [../ml/README.md](../ml/README.md)에 있습니다.

## 참고 — 검증된 수치

`public/data/showcase-designs.json`의 design 17297(6-rotor, 7.0kg)로 확인한 값입니다.
파이프라인 검증 시 대조군으로 쓸 수 있습니다.

| 관계 | 값 |
| --- | --- |
| 호버 추력 = 무게 | `6.9967 × 9.8 = 68.57 N` = `trim[0].thrust` |
| 거리 = 속도 × 시간 | `25 × 813.77 = 20,344 m` = `trim[25].distance` |
| 항력 ∝ V² | 5→1.0, 10→3.98, 15→8.85, 20→15.31, 25→23.17 N |
| 속도 한계 | 30 m/s 이상 trim 행 전부 무효 |

## 미해결 항목

| 항목 | 내용 |
| --- | --- |
| ~~**payload 0.5kg의 정체**~~ | **1단계에서 해소. 순수 화물입니다.** `CargoMass = 0.5`는 `Cargo` 컴포넌트에 붙고, avionics는 별도 `Sensor` 컴포넌트 6개(Autopilot, GPS, Current, Voltage, RpmTemp, Variometer)로 따로 모델링됩니다. 27,714개 전부 `CargoMass = 0.5`이고 `Sensor` 개수도 전부 6개입니다. 즉 0.5kg에 avionics는 포함되지 않습니다 |
| **Pareto knee 라벨 불일치** | `pareto-front.json`과 `design-index.json`의 `paretoKneeId`는 20015인데, `showcase-designs.json`의 16491이 `selectionReason`에 `Pareto knee`로 표기됨. `scripts/prepare-aircraftverse.mjs`의 라벨링 문제로 보임 |
| ~~**point cloud 출처**~~ | **0단계에서 사실상 해소.** design 17297 기준 제공된 100점의 bounding box가 STL bounding box 안에 그대로 들어가고 좌표계·단위(mm)가 같습니다 (STL `1111×1538×307`, npy `1073×1450×299`). 100점으로는 극단 꼭짓점을 못 맞히므로 약간 작게 나오는 것이 자연스럽습니다. **STL 표면에서 샘플링된 것으로 봅니다.** 어차피 100점은 쓰지 않으므로 추가 조사는 불필요합니다 |

## 데스크탑에서 시작하기

```bash
git clone https://github.com/gisedengdeung/drone-craft.git
cd drone-craft
git checkout feature/hw-drone
```

새 세션에서 이 문서와 [DRONE_PRIMER.md](DRONE_PRIMER.md), [MODEL_CARD.md](MODEL_CARD.md)를 먼저 읽히면
노트북에서 정리한 맥락을 그대로 이어갈 수 있습니다.
