# 설계 도우미 AI 계정·배포 설정

> FastAPI + PostgreSQL 전환 실행 및 설정: [FASTAPI_MIGRATION.md](FASTAPI_MIGRATION.md). 기존 Sites/D1 배포 안내는 이전 구조 참고입니다.

이 문서는 기존 배포 주소 `https://aerotwin-uav-ai.barcy.chatgpt.site`를 기준으로 한다. 경로 구현과 운영 연결은 별개다. Google OAuth, AliExpress 앱 권한, OpenAI 키, 운영 D1 설정이 실제로 준비되고 확인되기 전까지 연결 완료로 표시하지 않는다.

## 1. 먼저 배포할 callback 주소

AliExpress App Console의 **Affiliates API 앱 → Callback URL**에는 다음 주소를 입력한다.

```text
https://aerotwin-uav-ai.barcy.chatgpt.site/api/integrations/aliexpress/callback
```

1. `feature/agent`의 callback 경로가 포함된 빌드를 기존 Sites 프로젝트에 배포한다.
2. 브라우저에서 위 URL을 열어 drawn의 Affiliate 앱 등록 안내가 HTTPS로 표시되는지 확인한다. 기존 배포가 새 코드를 받지 않았다면 경로가 아직 없을 수 있다.
3. 공개 접근이 확인된 정확한 주소를 App Console에 저장한다. 서버의 `APP_BASE_URL`도 같은 origin으로 설정한다.

이 경로는 OAuth 코드 교환이나 판매자 로그인을 수행하지 않는다. 임의의 `code`, `error` 쿼리로 방문해도 해당 값을 출력하거나 인증 성공으로 표시하지 않는다. 상품 검색·상세·링크 생성의 실제 성공은 별도 API 조회로 확인한다.

## 2. AliExpress Affiliates 앱

1. App Console에서 **Affiliates API** 앱을 생성하거나 기존 앱을 선택한다.
2. 위 callback URL을 등록하고 앱의 상품 검색·상세·제휴 링크 API 사용 권한과 승인 상태를 확인한다.
3. 앱의 **App Key**, **App Secret**과 사용할 **Tracking ID**를 확보한다. 이 값은 서버 설정에만 저장한다.
4. 아래 환경변수를 설정한다. `openservice.aliexpress.com`에서 발급한 앱은 기본 `IOP` 모드와 `api-sg.aliexpress.com/sync`를 사용한다. 기존 TOP 앱만 `ALIEXPRESS_API_PROTOCOL=TOP`과 계정에 맞는 `ALIEXPRESS_TOP_REGION=CN` 또는 `US`를 설정한다.

```dotenv
ALIEXPRESS_APP_KEY=<App Key>
ALIEXPRESS_APP_SECRET=<App Secret>
ALIEXPRESS_TRACKING_ID=<Tracking ID>
ALIEXPRESS_API_PROTOCOL=IOP
ALIEXPRESS_DS_ENABLED=false
```

Affiliates 기본 흐름에서는 `ALIEXPRESS_ACCESS_TOKEN`을 넣지 않는다. 판매자 DS OAuth는 이번 설정과 별개다. 공식 Affiliate 검색·상세 API는 사용자 승인 불필요로 설명되어 있다. [상품 검색 문서](https://developer.alibaba.com/docs/api.htm?apiId=45803), [상품 상세 문서](https://developer.alibaba.com/docs/api.htm?apiId=48595).

서버는 `aliexpress.affiliate.product.query`, `aliexpress.affiliate.productdetail.get`, `aliexpress.affiliate.link.generate`를 호출한다. 조회 국가는 KR, 요청 통화는 KRW다. 표시가격과 상품 URL·제휴 URL은 실제 응답에서만 사용한다.

연결 확인은 로그인한 앱에서 현재 설계를 저장한 뒤 **설계 도우미 AI → 부품 찾기**를 실행한다. 오른쪽 패널 안에서 검색 결과, 구매 후보 선택, 견적 저장과 CSV 내보내기까지 확인한다. 좁은 화면에서는 같은 기능을 하단 시트로 제공한다. 미설정, 권한 부족, 조회 실패, 조회 성공을 구분한다. 상품이 검색되었다고 SKU·묶음 수량·배송비가 확정된 것은 아니다.

## 3. Google 로그인

Google OAuth callback 주소는 AliExpress callback과 다르다.

```text
https://aerotwin-uav-ai.barcy.chatgpt.site/api/auth/callback/google
```

1. [Google Cloud Console](https://console.cloud.google.com/)에 로그인해 상단 프로젝트 선택기에서 drawn용 프로젝트를 선택하거나 생성한다.
2. 왼쪽 메뉴 **Google Auth platform → Branding**으로 이동한다. 처음이라면 **Get started**를 눌러 앱 이름 `drawn`, 지원 이메일, 연락 이메일을 입력한다. 기존 설정이 있으면 Branding에서 같은 항목을 확인한다.
3. 공개 서비스는 **Audience → External**을 선택한다. 개발 중에는 **Testing** 상태에서 **Test users → Add users**로 직접 로그인할 Google 계정을 추가한다. [공식 동의 화면 설정](https://developers.google.com/workspace/guides/configure-oauth-consent).
4. **Clients → Create client → Application type: Web application**을 선택한다. 이름은 예를 들어 `drawn-web`으로 지정한다.
5. **Authorized JavaScript origins**와 **Authorized redirect URIs**에 아래 값을 등록한다. 로컬을 테스트할 때만 localhost 행을 추가한다. redirect URI의 프로토콜·호스트·포트·경로가 정확히 일치해야 한다. [Google 웹 서버 OAuth 설정](https://developers.google.com/identity/protocols/oauth2/web-server).

| 구분 | Authorized JavaScript origins | Authorized redirect URIs |
| --- | --- | --- |
| 운영 | `https://aerotwin-uav-ai.barcy.chatgpt.site` | `https://aerotwin-uav-ai.barcy.chatgpt.site/api/auth/callback/google` |
| 로컬 개발 | `http://localhost:5173` | `http://localhost:5173/api/auth/callback/google` |

6. 생성 직후의 **Client ID**와 **Client Secret**을 아래 환경변수에 넣는다. Secret은 다시 볼 수 없을 수 있으므로 생성 화면에서 안전하게 보관한다.
7. **Data Access**에서는 로그인에 필요한 기본 프로필·이메일 범위만 사용한다. 현재 앱은 Gmail·Drive 접근 권한을 요구하지 않는다. 공개 전환은 **Audience**에서 운영 계정의 동의 화면·도메인 설정을 마무리한 뒤 진행한다.
```dotenv
APP_BASE_URL=https://aerotwin-uav-ai.barcy.chatgpt.site
BETTER_AUTH_SECRET=<고유한 충분한 길이의 임의 Secret>
GOOGLE_CLIENT_ID=<OAuth Client ID>
GOOGLE_CLIENT_SECRET=<OAuth Client Secret>
```

Better Auth가 `/api/auth/*` 경로의 로그인과 세션을 처리한다. 도메인이 바뀌면 `APP_BASE_URL`, Google origin·redirect URI, AliExpress callback을 함께 바꾼다. [Better Auth Google 설정](https://better-auth.com/docs/authentication/google).

## 4. OpenAI 키와 서버 환경변수

[OpenAI API 플랫폼](https://platform.openai.com/)에서 사용할 프로젝트를 선택하고 **프로젝트 설정 → API keys → Create new secret key**로 서버용 키를 만든다. 이 프로젝트의 모델 접근 권한과 API 사용 한도를 확인한 뒤 `OPENAI_API_KEY`에 저장한다. [공식 프로젝트·API 키 안내](https://help.openai.com/en/articles/9186755).

앱의 무료 일일 횟수 제한과 API 계정의 과금·사용 한도는 별도다. API Secret, App Secret, Google Client Secret은 채팅에 붙여 넣지 말고 아래의 로컬 파일이나 호스팅의 서버 Secret 입력란에 직접 넣는다.
```dotenv
OPENAI_API_KEY=<서버 전용 API Key>
AGENT_OPENAI_MODEL=gpt-5-mini
PARTS_OPENAI_MODEL=gpt-5-mini
```

모델 접근 권한은 실제 계정에서 확인한다. 키는 클라이언트 번들, 공개 환경변수, Git, 브라우저 localStorage에 넣지 않는다. 로컬은 Git에서 제외한 환경 파일을 사용하고, 배포는 Sites의 서버 환경변수·secret 설정에 저장한다.

## 5. Sites 배포와 D1

개인 계정·프로젝트·revision·대화 실행·견적·한도는 **Cloudflare D1의 `AGENT_DB` binding**을 사용한다. 이 저장소는 `.openai/hosting.json`에 `"d1": "AGENT_DB"`를 선언한다. Sites 배포는 이 선언으로 호스팅 DB를 준비하고, 패키지에 포함된 `drizzle/` migration을 적용한다. `GALLERY_DB`가 있으면 기존 갤러리 저장소를 유지하고, Sites에서는 `AGENT_DB`의 공유 갤러리 테이블을 사용한다.

- Git에 들어가는 값은 binding 이름·migration·환경변수 예시다. 실제 서버 Secret은 배포 환경의 변수/Secret 설정에 별도로 저장한다.
- 로컬 `.env.local`을 작성해도 Sites 서버 환경변수가 자동으로 설정되는 것은 아니다. 운영 `APP_BASE_URL`은 HTTPS 주소로, 로컬 값은 localhost로 각각 설정한다.
- 배포 후 `/api/agent/session`의 `configured`·`missing`과 배포 migration 결과를 확인한다. Google 로그인 뒤 사용자별 프로젝트 저장까지 성공해야 연결이 완료된다.
- 운영 DB에는 로컬 명령의 `--local`을 `--remote`로 바꿔 임의 실행하지 않는다. 운영 migration은 Sites 배포 흐름에서 관리한다.

`drizzle/`의 journal에 등록된 migration을 순서대로 적용한다. 현재 계정·프로젝트·실행 테이블, 공유 갤러리 테이블, 초기 로컬 트리거 제거 migration이 포함되어 있다. Sites 배포와 로컬 migration 도구가 적용 이력을 관리하므로 개별 SQL을 수동으로 재실행하지 않는다.

## 6. 현재 Windows 로컬 실행

이 문서의 Sites/D1·Better Auth 설명은 이전 배포 구조의 기록입니다. 현재 서버는 FastAPI와 PostgreSQL이며, 과거의 Wrangler migration·`GALLERY_DB` 설정·5173 전용 명령을 실행하지 않습니다. Google OAuth와 외부 공급자 계정은 재사용할 수 있지만 실제 서비스 origin과 callback을 현재 주소에 맞춰야 합니다.

Windows + Ubuntu WSL에서는 저장소 루트에서 다음 명령으로 전체 앱을 실행합니다.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-docker.ps1
```

브라우저는 `http://localhost:3000`으로 엽니다. Google 반환 주소는 `http://localhost:3000/api/auth/callback/google`이며, 비공개 `.env.local`의 Google·AliExpress·OpenAI 설정은 API 컨테이너가 사용합니다. 설정값을 변경했다면 API 컨테이너를 다시 만들어 적용합니다.

```powershell
wsl -d Ubuntu -u root --cd /mnt/c/Dev/drawn/drawn -- docker compose --env-file .env.docker.local up -d --no-deps --no-build --force-recreate api
```

`GET /api/agent/session`에서 `configured: true`는 필수 설정값이 채워졌다는 뜻입니다. 실제 Google 로그인과 저장 성공까지 보장하지 않습니다. 로그인 후 `user`가 채워지는지, 프로젝트를 저장하고 다시 불러올 수 있는지 확인합니다.

프런트 개발 서버만 실행하는 `npm run dev`에는 별도로 실행한 FastAPI와 PostgreSQL이 필요합니다. 현재 Docker가 공개하는 3000 포트와 별도 FastAPI의 기본 8000 포트는 다릅니다. 실행 전 API 연결과 origin 설정을 점검하며, 모델이 준비되지 않았을 때는 경고 후 UI를 시작합니다. 정확한 가상환경·DB migration·개발 포트 설정은 [FastAPI 실행·이전 안내](FASTAPI_MIGRATION.md)를 따릅니다.

## 7. 설정 후 확인 순서

1. AliExpress callback의 공개 HTTPS 응답 확인.
2. Google 로그인 → 로그아웃 → 재로그인, 로그인 없는 개인 API 접근 차단 확인.
3. 현재 설계를 **내 프로젝트로 가져오기**, 편집 저장, 새로고침 후 프로젝트 불러오기.
4. **설계 도우미 AI → 부품 찾기**에서 실제 상품 가격·통화·조회 시각·링크 확인. 패널 안에서 선택 견적 저장과 CSV 내보내기 확인. 패널 닫기·다른 모드 전환·화면 너비 변경 후 선택이 유지되는지도 확인.
5. 설계 개선 결과의 변경 전후 확인 → 적용 → 되돌리기. 제안 뒤 편집한 경우 재실행 요구 확인.
6. Q&A의 근거·파라미터 이동과 원본 trim이 없는 설계의 부재 안내 확인.
7. 일일 한도·동시 실행·취소·실행 기록 조회를 확인한 뒤 공개 운영 상태로 전환.

상품 구매·결제나 판매자 계정 권한 승인은 수행하지 않는다. 현재 원본 데이터·추정 모델의 제한과 견적 범위는 [설계 도우미 AI 명세](AGENT_SPEC.md), [부품 찾기](PARTS_AGENT.md)를 참고한다.
운영 배포 호환성: revision 기록·사용량 증가는 복합 SQL 트리거 대신 하나의 D1 `batch` 안에서 조건부 SQL로 처리한다. 첫 배포에서 실패했던 복합 트리거 SQL은 교정했으며, `0003_remove_legacy_agent_triggers.sql`은 이전 로컬 DB에 남은 트리거를 제거해 중복 집계를 방지한다. 테이블과 저장 데이터는 유지한다.
