# drawn FastAPI 백엔드

현재 백엔드는 Google 로그인, PostgreSQL 개인 프로젝트·revision·실행 기록·견적, 에이전트 NDJSON 실행·취소·변경안, AliExpress 조회, 공개 갤러리와 학습 모델 추론을 처리합니다. 프런트와 API는 Docker nginx의 같은 origin으로 연결합니다.

진입점은 `backend/app/main.py`, 서버 설정은 `backend/app/settings.py`, DB 스키마·이전은 `backend/alembic`입니다. 모델은 `backend/model_bundle`의 검증된 best MLP 숫자 가중치·전처리를 읽습니다. 모델이 없거나 검증에 실패하면 추론을 비활성화하며, 모형값을 만들어 반환하지 않습니다. 이전 develop의 XGBoost mock `/predict` 서버는 이 구현으로 대체했습니다.

## 실행

저장소 루트에서 Windows + Ubuntu WSL 환경은 다음 명령을 사용합니다.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-docker.ps1
```

접속 주소는 `http://localhost:3000`, API 문서는 `http://localhost:3000/api/docs`입니다. 별도 Python API를 개발할 때도 저장소 루트에서 실행합니다. PostgreSQL 연결 및 비공개 환경 설정을 준비한 뒤 아래 명령을 사용합니다.

```powershell
& backend/.venv/Scripts/python.exe -m alembic -c backend/alembic.ini upgrade head
& backend/.venv/Scripts/python.exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

가상환경·환경변수·프런트 개발 포트·Google callback·D1 import 절차는 [FastAPI 실행·이전 안내](../docs/FASTAPI_MIGRATION.md)를 따르세요. 비밀값은 서버의 비공개 설정에만 저장합니다.

## 주요 확인 경로

| 경로 | 의미 |
| --- | --- |
| `GET /api/health/live` | API 프로세스 응답 |
| `GET /api/health/ready` | PostgreSQL 및 검증된 모델 준비 |
| `GET /api/agent/session` | 로그인 설정 여부와 현재 사용자 세션 |
| `GET /api/performance/model` | 모델 버전·준비·검증 상태 |
| `POST /api/performance/predict` | 서버가 검증한 설계·속도로 실제 best MLP 추론 |
| `POST /api/agent/run` | 저장된 프로젝트·revision에 대한 에이전트 실행 |

학습 모델은 원본 시뮬레이션 입력에 조건화된 속도별 8개 출력을 제공합니다. 질량·최대속도·비행 유효성은 예측하지 않습니다. OpenAI는 별도 목표 해석·답변 서비스이며 로컬 성능 추론에는 필요하지 않습니다. 상세 계약은 [모델 번들](model_bundle/README.md), 완료 검증 범위와 후속 작업은 [에이전트 준비 현황](../docs/AGENT_READINESS.md)에 있습니다.

## 검증

```powershell
# TEST_DATABASE_URL은 별도 PostgreSQL 테스트 DB를 가리켜야 합니다.
& backend/.venv/Scripts/python.exe -m pytest backend/tests
```

실제 PostgreSQL 경쟁·rollback·소유권 검증은 임시 schema에서 수행합니다. `TEST_DATABASE_URL`이 없으면 일부 검사가 skip되므로 실제 DB 검증 완료로 해석하지 않습니다. 자동 테스트의 외부 LLM·Google·상품 응답은 필요한 곳에서 mock을 사용하며, 실제 계정 로그인과 공급자 성공은 별도 검증합니다.
