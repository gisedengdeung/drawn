# FastAPI 전환 실행·데이터 이전 안내

프론트는 Node/Vinext, 모든 `/api/*` 업무 처리는 Python FastAPI, 저장소는 PostgreSQL이다. Nginx가 하나의 origin으로 연결한다. 로그인·프로젝트·실행 기록·취소·변경안·견적·공개 갤러리를 유지하며 Cloudflare Worker/D1 binding은 새 서버 실행에 필요하지 않다.

## Docker로 실행

저장소 루트에서 `node scripts/init-local-env.mjs`로 비공개 설정 파일을 준비한다. 이 PC는 Ubuntu WSL 내부 Docker Engine을 사용한다. Windows에서는 `powershell -ExecutionPolicy Bypass -File scripts/start-docker.ps1`로 실행할 수 있다. Docker Desktop을 사용하는 다른 환경에서도 같은 Compose 파일을 사용할 수 있다. WSL 내부에서 직접 실행할 때는 다음과 같다.

```bash
cd /mnt/c/Dev/drawn/drawn
sudo env COMPOSE_BAKE=false DOCKER_BUILDKIT=0 docker compose --env-file .env.docker.local up -d --build
sudo docker compose --env-file .env.docker.local ps
curl -fsS http://localhost:3000/api/health/ready
```

브라우저 주소는 `http://localhost:3000`이다. `.env.docker.local`에는 `POSTGRES_PASSWORD`, `SESSION_SECRET`, `APP_BASE_URL=http://localhost:3000`을 설정한다. PostgreSQL 비밀번호는 연결 URL 안에 사용되므로 URL 안전 문자의 충분히 긴 무작위 값을 사용한다. Google·OpenAI·AliExpress 서버 설정은 기존 비공개 `.env.local`에서 API 컨테이너로 전달된다. 두 파일의 내용을 Git이나 채팅에 올리지 않는다.

API 컨테이너는 시작할 때 Alembic migration을 적용한다. PostgreSQL 데이터는 `postgres_data` named volume에 남는다. 컨테이너를 종료해도 이 volume은 유지하며, 운영 데이터가 있는 volume을 삭제하지 않는다. 프론트와 API 포트는 외부에 직접 공개하지 않고 Nginx만 localhost에 연결한다.

실제 운영 도메인에서는 HTTPS reverse proxy를 앞에 두고 `APP_BASE_URL`을 최종 HTTPS origin으로 맞춘다. Google OAuth에 다음 주소를 등록한다.

- JavaScript origin: 실제 `APP_BASE_URL`
- Redirect URI: `APP_BASE_URL/api/auth/callback/google`
- AliExpress 앱 등록 callback: `APP_BASE_URL/api/integrations/aliexpress/callback`

`/api/health/live`는 프로세스 응답, `/api/health/ready`는 DB와 검증된 모델 준비를 확인한다. Google 로그인과 외부 공급자 실호출 성공은 health 응답만으로 확인되지 않는다.

## Python 로컬 개발

진입점은 `backend/app/main.py`, 설정은 `backend/app/settings.py`다. 설정 우선순위는 명시적 환경변수와 비공개 `.env.backend.local`, 기존 `.env.local` 순이다. `DATABASE_URL`은 별도로 준비한 PostgreSQL의 `postgresql+asyncpg://...` URL이어야 한다.

Windows PowerShell에서 저장소 루트 기준으로 실행한다.

```powershell
python -m venv backend/.venv
& backend/.venv/Scripts/python.exe -m pip install -r backend/requirements.txt
& backend/.venv/Scripts/python.exe -m alembic -c backend/alembic.ini upgrade head
& backend/.venv/Scripts/python.exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

프론트 개발 서버는 다른 터미널에서 `npm run dev -- --hostname 127.0.0.1 --port 3000`으로 시작한다. 개발 프록시의 FastAPI 주소와 `APP_BASE_URL`을 해당 포트에 맞춘다. 프론트 환경변수에 Secret을 공개 접두사로 넣지 않는다.

### 화면 개발과 모델 점검

`npm run dev`는 별도 FastAPI의 `/api/health/ready`를 먼저 확인합니다. 기본 백엔드는 `http://127.0.0.1:8000`입니다. 백엔드가 없으면 실행 방법과 Docker 앱 주소를 안내하고 종료합니다. 모델만 준비되지 않은 경우에는 경고와 함께 화면을 실행합니다.

현재 Docker API는 내부 네트워크에만 있으므로 `npm run dev`만 실행해서 Docker API에 연결되지는 않습니다. 앱을 이용하려면 `http://localhost:3000`을 사용하세요. 프런트 코드를 개발하려면 별도 Python API를 실행하고 두 프로세스의 주소를 맞춥니다.

기본 포트 3000으로 개발하려면 Docker nginx와 포트가 겹치지 않아야 합니다. 다른 포트(예: 5173)를 쓰려면 `.env.backend.local`의 `APP_BASE_URL=http://localhost:5173`을 설정하고 Python API를 재시작한 뒤 `npm run dev -- --port 5173`을 실행합니다. Google Console에도 `http://localhost:5173/api/auth/callback/google`을 등록합니다. 프런트만 다른 포트로 바꾸면 로그인과 저장 요청이 실패할 수 있습니다.

`API_INTERNAL_URL`은 별도 Python API의 origin입니다. 프런트 자신의 주소로 설정하면 프록시 요청이 반복되므로 실행 점검에서 거절합니다. 포트가 사용 중이면 다른 포트로 자동 이동하지 않고 종료합니다.

`npm run model:check`는 로그인과 OpenAI 없이 실제 best MLP 예측을 확인합니다. 모델에 필요한 원본 호버 입력이 없는 설계(예: #20015)는 `422 model_input_unavailable`을 반환합니다. 다른 설계를 선택해야 하며 #17297은 예측과 치수 변경의 갱신을 확인한 설계입니다.

OpenAI 의도 해석·설명은 별도 외부 API입니다. 무료 토큰도 양수 잔액과 해당 프로젝트의 공유 설정이 필요합니다. 선불 첫 충전 최소 금액은 5달러입니다. [무료 토큰 조건](https://help.openai.com/en/articles/10306912-sharing-feedback-evals-and-api-data-with-openai), [선불 결제 안내](https://help.openai.com/en/articles/8264644).

원본 모델·학습 자료의 위치는 [구조 안내](ARCHITECTURE.md)를 참고하세요.

## 기존 D1 데이터 이전

이번 로컬 확인에서는 개인 에이전트 D1 데이터가 0건이었다. **운영 D1 export는 확보하지 않았으며 운영 데이터 이전을 완료한 상태가 아니다.** importer와 PostgreSQL 트랜잭션은 별도의 비어 있지 않은 합성 export로 검증했다.

운영 이전은 기존 서비스의 쓰기를 중지한 뒤 최종 export를 확보해 수행한다. `AGENT_DB` 외에 `GALLERY_DB`를 따로 사용했다면 두 export가 필요하다. importer는 지정한 로컬 SQLite 파일 또는 D1 SQL export만 읽으며 Cloudflare에 직접 접속하지 않는다.

```powershell
& backend/.venv/Scripts/python.exe -m backend.tools.import_d1 --source exports/agent.sqlite --gallery-source exports/gallery.sql
```

기본 동작은 검증만 하는 dry run이다. 출력에는 테이블별 건수만 포함한다. 별도 갤러리 DB가 없으면 `--gallery-source`를 생략한다. 이전 전에 target PostgreSQL에 Alembic migration을 적용하고 업무 데이터는 비워 둔다. 검증 결과를 확인한 뒤 다음과 같이 실제 import한다.

```powershell
& backend/.venv/Scripts/python.exe -m backend.tools.import_d1 --source exports/agent.sqlite --gallery-source exports/gallery.sql --apply
```

`--apply`는 설정된 `DATABASE_URL`의 DB로 가져온다. 원본 파일을 변경하지 않고 기존 target 행을 덮어쓰지 않는다. importer끼리의 동시 실행을 막고 전체 import를 한 트랜잭션으로 처리한다. 제약 위반이나 건수 불일치가 생기면 전부 rollback한다.

이전 시 유지하는 데이터는 다음과 같다.

- Google provider subject와 기존 user ID 매핑, 프로젝트·revision·실행·변경안·견적·갤러리 ID와 소유권
- 저장된 JSON 근거·가격·모델 출처·fingerprint, 프로젝트의 현재 revision과 history
- 일일 사용량과 이미 완료한 실행 결과

Better Auth session, OAuth state, Google access/refresh/ID token은 가져오지 않는다. 사용자는 전환 후 Google에 한 번 다시 로그인한다. 이메일만으로 기존 계정을 자동 연결하지 않고 Google subject가 일치하는 기존 ID를 사용한다. 이전 순간 진행 중이던 실행은 `cancelled`로 바꾸고 부분 결과를 보존한다. 유료 작업을 자동 재실행하지 않는다.

원본 DB와 export를 보관하고, 새 서버에서 사용자별 프로젝트·기록·견적·갤러리 표본과 건수를 확인한 뒤 접속 대상을 전환한다. 되돌릴 때는 양쪽의 쓰기가 동시에 발생하지 않게 중지하고 기존 서비스와 보관한 DB를 복구한다. 이미 새 서버에서 작성한 데이터는 별도로 보존한다.

## 동작 계약과 검증

`POST /api/agent/run`은 기존 `start/progress/result/error` NDJSON을 유지한다. 요청 실행 제한은 240초, DB lease는 300초다. 취소는 DB에 기록하며 연결 종료 후 자동 재실행하지 않는다. 사용자당 동시 실행 1개, KST 기준 사용자 20회/일·전체 200회/일, 실행당 LLM/도구/공급자 4/20/40회 한도를 PostgreSQL 트랜잭션으로 유지한다.

프로젝트 저장·적용·복구는 revision을 검사한다. 오래된 변경안, 다른 사용자 소유의 데이터, 실행 결과에 없는 상품 선택은 거절한다. 공개 갤러리는 기존처럼 로그인 없이 조회·공유·재사용할 수 있다.

```powershell
# TEST_DATABASE_URL에는 별도 PostgreSQL 테스트 DB URL을 설정한다.
& backend/.venv/Scripts/python.exe -m pytest backend/tests
npm test
npm run typecheck
npm run build
```

PostgreSQL 테스트는 임시 schema를 만들고 정리한다. `TEST_DATABASE_URL`이 없으면 해당 테스트를 skip하므로 전체 통과로 해석하지 않는다. 테스트에는 병렬 revision/한도 경쟁, rollback, Google OIDC 검증·state replay, 사용자 격리, NDJSON·취소, 실제 모델 근거 연결, 견적 저장, 갤러리, D1 import가 포함된다. 모델 입력·기능 제한과 번들 검증은 `backend/model_bundle/README.md`를 함께 확인한다.
