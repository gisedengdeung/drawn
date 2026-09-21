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
