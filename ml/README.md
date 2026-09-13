# ml/ — Point Cloud 성능 예측 모델

[docs/HANDOFF.md](../docs/HANDOFF.md)의 작업 단계를 구현합니다.
도메인 배경은 [docs/DRONE_PRIMER.md](../docs/DRONE_PRIMER.md), 현재 추정기의 한계는 [docs/MODEL_CARD.md](../docs/MODEL_CARD.md)를 참고하세요.

| 단계 | 파일 | 상태 |
| --- | --- | --- |
| 0 | `verify_stage0.py` | 완료 |
| 1 | `prepare_targets.py` | 완료 — 타깃 추출, 유효성 필터, split 고정 |
| 2 | `prepare_pointclouds.py` | 완료 — STL → (N, 1024, 3) + scale |
| — | `geometry_baseline.py` | 완료 — 3·4단계가 넘어야 할 바닥 |
| 3 | `model.py`, `train.py` | 예정 — PointNet |
| 4 | `evaluate.py` | 예정 — R²/MAE, baseline 대비 |

## 환경

이 데스크탑에는 원래 Python도 Node.js도 없었습니다(`python.exe`는 Microsoft Store 스텁).
아래는 실제로 실행한 설치 절차입니다.

```powershell
winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
winget install --id OpenJS.NodeJS.LTS  -e --accept-source-agreements --accept-package-agreements
```

### `python` 대신 `py`를 쓰는 이유

사용자 PATH 최상단이 `C:\Users\<user>\AppData\Local\Microsoft\WindowsApps`이고,
python.org 설치 프로그램은 PATH 뒤에 경로를 추가합니다. 그래서 설치 후에도 맨 이름 `python`을 치면
0바이트 Store 스텁이 먼저 잡힐 수 있습니다.

**`py` 런처(System32에 설치, 머신 PATH)와 venv의 명시 경로만 사용하세요.**

```powershell
py -3.12 -m venv ml\.venv
ml\.venv\Scripts\python.exe -m pip install --upgrade pip
ml\.venv\Scripts\python.exe -m pip install -r ml\requirements.txt
```

### PyTorch

CUDA 휠은 별도 인덱스가 필요해 `requirements.txt`에 넣지 않았습니다.

```powershell
ml\.venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu126
```

RTX 3070 + 드라이버 560.94 기준으로 cu126 휠을 씁니다. `torch.cuda.is_available()`이 `False`면
cu124로 내려서 재시도하세요.

```powershell
ml\.venv\Scripts\python.exe -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

## 데이터 위치

`AircraftVerse_1/2/3`이 이 레포와 형제 위치에 있으면 인자 없이 동작합니다.

```
drone/
├── AircraftVerse_1/   9,238 designs
├── AircraftVerse_2/   9,238
├── AircraftVerse_3/   9,238
└── drone-craft/       ← 이 레포
```

다른 곳에 있다면 `--data-root`를 세 번 지정하세요.

```powershell
ml\.venv\Scripts\python.exe ml\verify_stage0.py --data-root D:\av1 --data-root D:\av2 --data-root D:\av3
```

## 0단계 — 검증

```powershell
ml\.venv\Scripts\python.exe ml\verify_stage0.py
```

27,714개를 전수 순회하며 1~2분 안에 끝납니다. 결과는 `ml/reports/stage0_report.json`에 저장되고
종료 코드는 통과 시 0, 실패 시 1입니다.

검증 항목:

| 항목 | 내용 |
| --- | --- |
| 파일 무결성 | 설계마다 `cadfile.stl`, `output.json`, `design_low_level.json`, `pointCloud.npy`, `trims.npy` 존재 |
| NPY 스키마 | 헤더를 직접 파싱해 `pointCloud.npy` = `<f4 (100,3)`, `trims.npy` = `<f8 (51,12)` 단언 |
| ID 유일성 | 세 파트에 걸쳐 design ID 중복 여부. split 누수 방지에 필요 |
| 타깃 유효성 | `isfinite(v) and v > 0` 규칙으로 HANDOFF의 유효 설계 수 재현 |
| trim 열 순서 | design 17297의 thrust/distance/drag를 HANDOFF 검증값과 대조 |
| STL | 로드 가능 여부, 단위(mm/m), `sample_surface` 동작 |
| CUDA | `torch.cuda.is_available()` |

### 주의

- `corpus_dic`은 신뢰되지 않은 Python pickle입니다. **`pickle.load`를 호출하지 마세요.**
  이 폴더의 어떤 스크립트도 건드리지 않습니다.
- `Geom.stp`는 파싱하지 않습니다. 용량 대부분을 차지하지만 이번 작업 범위 밖입니다.
- `ml/data/`, `*.npz`, `*.pt`, `ml/.venv/`는 `.gitignore`에 있습니다.
  **340MB `.npz`를 커밋하지 마세요.** `ml/reports/`는 작으므로 커밋합니다.

## 1단계 — 타깃 추출과 split

```powershell
ml\.venv\Scripts\python.exe ml\prepare_targets.py
```

27,714개의 `output.json`과 `design_low_level.json`을 읽어 약 25초에 끝납니다.

| 산출물 | 내용 |
| --- | --- |
| `ml/data/targets.csv` | 27,714행 × 65열. git 제외 |
| `ml/reports/stage1_report.json` | 요약·baseline·근거. 커밋 |

### 학습 필터는 `*_valid`가 아니라 `trainable`입니다

`*_valid`는 `isfinite(v) and v > 0` 규칙만 적용합니다. 필요조건이지 충분조건이 아닙니다.
`Mass`는 27,714개 전부 이 규칙을 통과하지만, **11개 설계가 60,000~240,000 kg**을 보고합니다.
정상 집단의 최대값은 35.3 kg이고 그다음 값이 60,044 kg이라 사이 어디를 끊어도 같습니다.

`prepare_targets.py`의 `trainable(row, key)`가 유일한 정의입니다. 2~4단계는 이것으로 거르세요.
`mass_plausible` 열이 CSV에 있고, 11개는 삭제하지 않고 표시만 해두었습니다 (리포트에 ID 나열).

### split은 design이 아니라 family 단위입니다

`design_low_level.json`의 `name`은 `design_<n>_<uuid>_<variant>` 형식입니다.
**8,084개 family가 `dw`/`dw_dl` 쌍을 가지며, 이는 전체의 58.3%(16,168개)입니다.**

형제는 완전 중복이 아닙니다 — topology·부품·시드는 같고 치수만 다릅니다.

| 타깃 | 형제 간 상대차 중앙값 | p90 |
| --- | --- | --- |
| `Mass` | 5.7% | 8.3% |
| `Max_Distance` | 7.3% | 27.4% |
| `Hover_Time` | 6.2% | 12.2% |

이 정도면 design 단위로 나눌 때 형제 절반이 train/test를 가로질러 점수가 부풀려집니다.
그래서 **family 단위로 배정**합니다. 완전 중복(파라미터·부품 바이트 동일)은 0건이므로 exact hash만으로는 못 잡습니다.

배정은 `sha256(salt + family)` 기반이라 **split 파일 없이 어느 기계에서나 동일하게 재현**됩니다.
비율은 80/10/10이고 실제로는 train 22,187 / val 2,803 / test 2,724가 나옵니다.

### 4단계 baseline

"타깃 평균으로만 예측"이 넘어야 할 바닥입니다. 리포트의 `mean_baseline`에 들어 있습니다.

| 타깃 | train 평균 | test MAE | test RMSE |
| --- | --- | --- | --- |
| `Mass` | 7.78 kg | 3.71 | 5.13 |
| `Max_Distance` | 3,098 m | 2,554 | 3,653 |
| `Hover_Time` | 175.1 s | 123.0 | 168.1 |

### 디버깅 사다리 1번 타깃

STL 없이 설계 변수에서 바로 뽑았습니다. 전 설계에 존재합니다 (단위 mm).

| 타깃 | min | p50 | max |
| --- | --- | --- | --- |
| `fuselage_length` | 84.0 | 180.0 | 559.0 |
| `fuselage_horz_diameter` | 311.4 | 372.9 | 804.9 |
| `arm_length_max` | 50.1 | 397.8 | 500.0 |
| `arm_length_sum` | 50.1 | 753.4 | 7,070.5 |

HANDOFF가 말하는 "전체 span"은 STL bounding box라 2단계에서 함께 기록합니다.

## 2단계 — point cloud 샘플링

```powershell
ml\.venv\Scripts\python.exe ml\prepare_pointclouds.py
ml\.venv\Scripts\python.exe ml\prepare_pointclouds.py --limit 200   # 스모크 테스트
```

i9-10900KF 18워커에서 **2.7분**(173 designs/s), 실패 0건. 산출물은 `ml/data/pointclouds.npz` **333MB**(git 제외).

### 배열

| 키 | shape | 단위 | 비고 |
| --- | --- | --- | --- |
| `points` | (27714, 1024, 3) f4 | 정규화 | 단위구 내부 |
| `scale` | (27714,) f4 | mm | **버리면 안 되는 크기 정보** |
| `centroid` | (27714, 3) f4 | mm | |
| `bbox_min` / `bbox_max` / `extents` | (27714, 3) f4 | mm | 메시 bounding box |
| `span` | (27714,) f4 | mm | `extents.max()`. 사다리 1번 타깃 |
| `targets` | (27714, 5) f4 | | 학습 불가면 `NaN` |
| `geometry` | (27714, 5) f4 | mm | 설계 변수 기하량 |
| `split` / `family` | (27714,) str | | 1단계와 동일 |
| `n_propeller` / `has_wing` / `n_faces` / `area` | (27714,) | | |

```python
raw_mm = points * scale[:, None, None] + centroid[:, None, :]   # 완전 복원
```

**`targets`의 `NaN`이 학습 필터입니다.** `trainable` 규칙(유효성 + Mass 물리 타당성)을 이미 적용해
`NaN`으로 채웠으므로, 손실 계산 시 `NaN` 마스킹만 하면 됩니다.

### 검증 6항목

전부 통과했습니다. `ml/reports/stage2_report.json`에 있습니다.

`all_designs_sampled` · `points_finite` · `denormalises_into_bbox` ·
`normalised_within_unit_cube` · `scale_positive` · `split_matches_stage1`

0단계에서 trimesh로 따로 잰 design 17297의 STL extents `[1111.242, 1538.105, 306.82]`와
2단계 `extents`가 소수점까지 일치합니다.

| | min | p50 | max |
| --- | --- | --- | --- |
| `scale` (mm) | 165.7 | 594.3 | 3,027.7 |
| `span` (mm) | 332.4 | 1,159.8 | 5,957.8 |

## Baseline — 3·4단계가 넘어야 할 선

```powershell
ml\.venv\Scripts\python.exe ml\geometry_baseline.py
```

HANDOFF는 4단계 baseline을 "타깃 평균 예측"으로 정의합니다. **그 바닥은 너무 낮습니다.**
메시에서 그냥 얻어지는 스칼라 11개(bbox extents, span, scale, 표면적, 동체·arm 치수)에
최소제곱을 돌리면 이미 아래가 나옵니다. test split 기준입니다.

모든 R²는 **원래 단위(kg, m, s)에서 채점**했습니다.

| 타깃 | n_test | 평균 R² | **기하 R²** | log 적합 | 평균 MAE | 기하 MAE |
| --- | --- | --- | --- | --- | --- | --- |
| `Mass` | 2,723 | 0.000 | **0.919** | 0.848 | 3.71 | 1.06 |
| `Max_Distance` | 1,083 | 0.000 | **0.535** | −17.438 | 2,554 | 1,385 |
| `Hover_Time` | 804 | 0.000 | **0.598** | 0.357 | 123.0 | 69.6 |
| `Max_Speed` | 1,083 | 0.000 | **0.228** | 0.143 | 8.46 | 7.29 |
| `Power_MFD` | 1,090 | 0.000 | **0.438** | 0.302 | 945.6 | 655.4 |

**PointNet은 평균이 아니라 기하 열을 이겨야 합니다.** 이 스칼라들은 전부 입력 메시에서 나오므로,
못 이기면 단순 기하가 이미 주던 것 이상을 배우지 못한 것입니다.

### 타깃을 로그 변환하지 마세요

`log 적합` 열은 log 공간에서 적합한 뒤 `exp`로 되돌려 **원래 단위에서 채점**한 값입니다.
**모든 타깃에서 raw 적합에 집니다.** `Max_Distance`는 −17.4로 완전히 붕괴하는데,
p50 1,677m에 max 40,905m(24배)라 `exp`가 꼬리의 오차를 증폭시키기 때문입니다.

리포트 JSON에는 `geometry_baseline_log_space_NOT_COMPARABLE` 항목도 있습니다.
이건 log 공간에서 채점한 값이라 **분모가 다릅니다.** 위 표와 나란히 놓고 비교하면 안 됩니다
(그렇게 비교하면 log가 이기는 것처럼 보입니다).

꼬리 문제 자체는 남습니다. 해법은 타깃 변환이 아니라 **손실 변경**입니다 —
타깃을 z-score 정규화하고 Huber loss를 쓰면 채점 공간을 유지한 채 꼬리 지배를 막습니다.

`Mass`가 0.919인 이유는 span이 아니라 **동체 크기**입니다 — `fuselage_vert_diameter`와 질량의
상관이 0.881이고 span은 0.18에 불과합니다. 배터리를 담는 동체가 질량을 지배하며,
그 정보는 메시 안에 들어 있습니다.

`Max_Distance` 0.54 / `Hover_Time` 0.60은 HANDOFF 핵심 발견 3번이 예고한 0.4~0.6 구간과 일치합니다.
형상 단독의 한계를 실측으로 확인한 셈입니다.

## trims.npy 열 순서

파일에 열 이름이 없습니다. 아래 순서의 유일한 근거는
[scripts/prepare-aircraftverse.mjs:33-46](../scripts/prepare-aircraftverse.mjs#L33-L46)이며,
`verify_stage0.py`의 check D가 실측으로 확인합니다.

```
0 distance   1 flightTime  2 pitch    3 maxUc
4 thrust     5 lift        6 drag     7 current
8 power      9 motorCurrentRatio  10 motorPowerRatio  11 batteryCurrentRatio
```

행 인덱스는 속도(m/s) 0–50입니다. 모든 열이 0이거나 non-finite인 행은 무효이며,
이는 계산 실패가 아니라 그 속도에서 균형해가 없다는 뜻입니다.

## 값 0의 취급

성능값 0은 물리량 0이 아니라 해석 실패 또는 비실현 상태입니다.
유효성 규칙은 프론트엔드의 `isAvailableMetric`([lib/aerotwin-types.ts](../lib/aerotwin-types.ts))과
동일하게 `isfinite(v) and v > 0`으로 맞춥니다. **0을 학습시키지 마세요.**
