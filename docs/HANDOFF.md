# ML 작업 인수인계 — Point Cloud 성능 예측 모델

이 문서는 **데스크탑 환경에서 새 세션을 시작할 때 맥락을 이어받기 위한** 인수인계 노트입니다.
노트북에서 레포를 분석하고 정리한 결과를 담고 있으며, 모든 수치는 이 레포의 실제 데이터로 검증했습니다.

드론 도메인 지식은 [DRONE_PRIMER.md](DRONE_PRIMER.md), 현재 추정기의 한계는 [MODEL_CARD.md](MODEL_CARD.md)를 참고하세요.

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

데스크탑에서 데이터를 푼 뒤 실제 shape를 먼저 재확인할 것:

```python
import numpy as np
print(np.load('AircraftVerse_1/design_1/pointCloud.npy').shape)
```

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
| 0 | 압축 해제, `pointCloud.npy` shape 확인 | 아무 곳 | 반나절 |
| 1 | 타깃 추출, 유효성 필터, split 고정 | 아무 곳 | 1일 |
| 2 | STL → point cloud 샘플링, `.npz` 저장 | 아무 곳 (CPU) | 2~4시간 |
| 3 | PointNet 학습 | **데스크탑** | 2~3일 |
| 4 | 검증셋 R²/MAE, baseline 대비 비교 | 데스크탑 | 1일 |
| 5 | ONNX 내보내기 또는 FastAPI 연결 | — | 이후 |

4단계의 baseline은 **"타깃 평균으로만 예측했을 때"** 입니다. 이 기준이 없으면 R² 수치의 좋고 나쁨을 판단할 수 없습니다.
[MODEL_CARD.md](MODEL_CARD.md)가 요구하는 기록 항목은 검증셋 R²/MAE, prediction interval, model version입니다.

## 코드 배치

같은 레포의 `ml/` 폴더에 둡니다.

```
drone-craft/
├── ml/
│   ├── prepare_pointclouds.py   # STL → (N, 1024, 3) + scale + targets
│   ├── dataset.py
│   ├── model.py                 # PointNet
│   ├── train.py
│   ├── evaluate.py
│   └── data/                    # .npz 산출물 (git 제외)
├── app/ components/ lib/        # 기존 프론트엔드
└── public/data/                 # 커밋된 정적 자산
```

`.gitignore`에 ML 산출물 제외 규칙을 추가해두었습니다. **340MB `.npz`를 커밋하지 않도록 주의하세요.**

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
| **payload 0.5kg의 정체** | 전 설계가 `payload.mass = 0.5`로 고정. avionics(FC/GPS/무선) 포함인지 순수 화물인지 불명. `design_low_level.json`을 열어 확인 필요 |
| **Pareto knee 라벨 불일치** | `pareto-front.json`과 `design-index.json`의 `paretoKneeId`는 20015인데, `showcase-designs.json`의 16491이 `selectionReason`에 `Pareto knee`로 표기됨. `scripts/prepare-aircraftverse.mjs`의 라벨링 문제로 보임 |
| **point cloud 출처** | 제공된 100점이 STL에서 파생된 것인지 별도 생성인지 미확인 |

## 데스크탑에서 시작하기

```bash
git clone https://github.com/gisedengdeung/drone-craft.git
cd drone-craft
git checkout feature/hw-drone
```

새 세션에서 이 문서와 [DRONE_PRIMER.md](DRONE_PRIMER.md), [MODEL_CARD.md](MODEL_CARD.md)를 먼저 읽히면
노트북에서 정리한 맥락을 그대로 이어갈 수 있습니다.
