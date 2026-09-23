# 모델·학습 자료

현재 웹 서비스가 사용하는 모델은 `backend/model_bundle`의 조건부 trim MLP다.
FastAPI가 PyTorch CPU로 직접 추론한다. 원본 `.pt`와 pickle 파일을 요청마다
읽거나 브라우저에서 추론하지 않는다. 배포 번들은 원본 체크포인트에서 추출한
동일한 가중치와 전처리 값이며, 시작할 때 해시와 실제 예측값을 검사한다.

```text
backend/model_bundle/                 실행용 가중치·전처리·golden·버전
ml/
  artifact-inventory.json              이동 전후 29개 파일의 SHA256 기록
  sources/dongha/                     제공받은 원본 자료, 내부 구조 그대로 보존
    dataset_510k.csv                   현재 모델과 해시가 일치하는 학습 데이터
    20260920_160522/                   체크포인트·전처리·설정·평가·샘플
    v2/                               별도 데이터 버전, 현재 모델에 사용하지 않음
    make_dl_dataset.py                제공된 과거 코드
    train_dl_model.py                  제공된 과거 코드
    train_dl_model (1).py              제공된 과거 코드
  archive/root-artifacts/              이전 루트 파일의 보존본
    best_model.pt                     위 run의 체크포인트와 바이트 단위로 동일
    model_preprocessor.pkl            위 run의 전처리와 바이트 단위로 동일
    dl_preprocessor.pkl               과거 데이터 전처리 파일, 런타임 미사용
  data/                               기존 PointNet 데이터, 변경 없음
  runs/                               기존 PointNet 체크포인트·ONNX·평가, 변경 없음
```

원본 자료와 루트 파일은 총 29개, 96,870,025바이트다. 이동 전후 SHA256을 모두
대조했다. 중복 파일도 삭제하지 않았으며 원래 위치·새 위치·크기·해시는
[`artifact-inventory.json`](artifact-inventory.json)에 기록했다. 기존 PointNet
자료는 22개, 425,889,033바이트이며 현재 MLP 실행과 별개로 보존한다.

## 검증과 재패키징

저장소 루트에서 아래 명령은 원본 체크포인트·전처리·설정·데이터의 해시와
실행 번들의 CPU golden 20개를 검증한다. 파일을 다시 생성하거나 pickle을
역직렬화하지 않는다. `backend/.venv`의 런타임 의존성만 있으면 된다.

```powershell
backend/.venv/Scripts/python.exe scripts/package-performance-model.py --verify-only
```

Linux에서는 `backend/.venv/bin/python`을 사용한다. 서버가 실행 중이면
`GET http://localhost:3000/api/performance/model`에서도 모델 버전, 준비 상태와
golden 검증 결과를 확인할 수 있다. 실제 추론은 `POST /api/performance/predict`다.

번들을 다시 추출할 때 사용하는 기본 경로는 아래와 같다. `--run`, `--dataset`,
`--output`, `--torch-python`으로 다른 위치를 명시할 수 있다.

```text
--run      ml/sources/dongha/20260920_160522
--dataset  ml/sources/dongha/dataset_510k.csv
--output   backend/model_bundle
```

실제 재패키징에는 numpy, pandas, scikit-learn 1.6.1과 PyTorch가 필요하다.
원래 CUDA 예측과의 엄격한 대조를 먼저 통과해야 새 CPU golden을 승인한다.
검증된 환경은 PyTorch 2.13.0+cu130, RTX 5070 Ti, 행렬 정밀도 `high`다.
패키징 스크립트는 학습이나 전처리 재학습을 수행하지 않는다.

원본 `config.json`, `metrics.json`, `dataset_summary.json`의 과거 절대 경로는
학습 당시 증거로 그대로 남겼다. 현재 실행·패키징은 이 경로 문자열 대신 위의
명시적인 경로를 사용한다. `v2/dataset_510k.csv`는 현재 체크포인트의 데이터
해시와 다르므로 대신 사용할 수 없다.

## 재현 범위와 남은 과거 자료

현재 체크포인트의 추론과 원본 예측 대조는 검증됐다. 하지만 제공된 과거 학습
스크립트는 해당 run의 274차원 입력·SiLU 구조·설계별 분할을 재현하는 코드가
아니다. 이 파일들을 현재 모델의 학습 코드로 취급하지 않는다.

`tests/test_make_dl_dataset.py`와 `tests/test_train_dl_model.py`는 현재 없는
`test-ai-modeling`의 개선된 학습 구현을 참조한다. 이 두 과거 테스트는 원형을
유지했으며 현재 추론 검증 통과에 포함하지 않는다. 전체 재학습을 재현하려면
이 테스트가 대상으로 삼는 원래 구현을 복구해야 한다. 상위 폴더에서 확인한
`make_dl_dataset.py`도 구형 코드였고 `train_dl_model.py`는 없었다.

기존 `ml/.venv`는 사라진 `test-ai-modeling/.venv`를 가리키는 junction이다.
이전 환경의 흔적으로 보존했고 현재 실행에는 사용하지 않는다. 런타임은
`backend/.venv` 또는 Docker의 Python 환경을 사용한다.

ML 아티팩트와 배포 번들은 Git에서 추적 가능하게 두었다. `.gitignore`는 로컬
가상환경·캐시만 제외하며, Docker 이미지에는 `ml/` 전체를 넣지 않는다.
실행에 필요한 작은 `backend/model_bundle`만 API 이미지에 포함한다.

## 형상 기반 모델과 파라미터 모델 (feature/hw-drone)

`backend/model_bundle`의 조건부 trim MLP와 별개로 진행한 두 갈래다. 실행 경로에는
들어가 있지 않으며, 어디까지 되고 어디서 막혔는지를 남긴다.

| 갈래 | 스크립트 | 결과 |
| --- | --- | --- |
| PointNet (형상) | `prepare_pointclouds.py`, `train.py`, `evaluate.py`, `export_onnx.py` | `Mass` R² 0.879, `Max_Distance` R² 0.623 |
| 속도 조건부 trim | `trim-validity-v2/source/ml/` | `drag` 0.952, `thrust` 0.808. 유효성 헤드는 UI 미달 |
| 파라미터 (XGBoost) | `param_features.py`, `train_param_model.py`, `evaluate_param_model.py` | `mass` R² 0.990, `maxDistance` 0.750 |

### 형상 모델은 편집 설계에 쓸 수 없다

편집한 설계에는 `cadfile.stl`이 없다. 브라우저가 가진 것은
`components/parametric-uav-viewer.tsx`가 원기둥·상자·구로 조립한 개념 형상뿐이고,
거기서 뽑은 점은 학습 분포 밖이다. showcase 12개로 재보면 `Max_Distance`가 중앙 64%,
최악 90% 달라진다. 재샘플링만으로 생기는 변동이 10.3%인 것과 비교하면 쓸 수 없는
수준이다. 근거는 `reports/parametric_gap.json`.

그래서 편집 설계는 형상이 아니라 **파라미터**를 입력으로 받는다. 필요한 데이터가
`public/data`에 전부 있어 85GB 원본도 GPU도 없이 노트북에서 재현된다.

```bash
python ml/train_param_model.py      # backend/models/ 와 ml/runs/param_model_per_target/
python ml/evaluate_param_model.py   # reports/param_model_evaluation.json
```

피처 이름·순서와 타깃 순서, 백엔드가 고쳐야 할 항목은
`reports/param_model_contract.json`에 있다. 파생 피처 `discLoadingProxy`와
`battWhApprox`는 프롭·배터리를 바꾸면 **함께 다시 계산해야 한다.** 값이 남아 있으면
모순된 입력이 되지만 오류로 잡히지 않는다.

### 랭킹에 쓰면 안 되는 출력

두 모델 모두 상위 분위를 과소예측한다. `power` −73%, `maxSpeed` −50%,
`maxDistance` −41%다. 표시는 괜찮지만 정렬·탐색에 쓰면 퇴보한다. `mass`(+2%)와
`hoverTime`만 안전하다. 상세는 `reports/param_model_evaluation.json`의
`shrinkage_watch`.

### 기각된 시도

`check_hover_anchor.py` — 예측 Mass로 호버 추력을 앵커링하면 thrust MAE가
3.22 → 6.52 N으로 악화된다. 실제 Mass면 1.25 N이므로 개념은 맞지만 Mass 모델
오차가 더 커서 순손실이다. 다시 시도하지 않도록 재현 가능하게 남겼다.
