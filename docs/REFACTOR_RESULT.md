# develop · FastAPI · best 모델 통합 결과

작업 브랜치: `refactor/develop-fastapi-dongha`

프런트 기준: develop `4ee7d864b8169ea3defcaa3dcbd9a1c0f70613fb`

기존 변경 백업: `work/refactor-before-fastapi-20260921`

## 적용한 내용

- develop의 흰색·파란색 디자인, 로고와 화면 구성을 반영하면서 설계 도우미 패널·견적 선택·프로젝트 작업 흐름을 유지했다.
- 로그인, 프로젝트와 revision, 에이전트 NDJSON 실행·취소·이력, 변경안 적용·되돌리기, 견적, AliExpress, 갤러리의 업무 처리를 FastAPI로 옮겼다. Next/Vinext API 파일은 개발·단독 실행용 전달 계층이며 Docker에서는 nginx가 FastAPI로 바로 전달한다.
- 저장소는 SQLAlchemy async + PostgreSQL, 스키마 관리는 Alembic으로 전환했다. Google OIDC/PKCE와 서버 세션을 사용한다.
- 원본 best MLP의 전처리·가중치·golden 값을 검증 가능한 작은 번들로 만들고 속도별 8개 출력을 설계 편집·시뮬레이터·Q&A 근거에 연결했다.
- 기존 Neighbor Estimate KPI와 후보 최적화는 유지했다. 학습 모델의 질량·최대속도·유효성 미지원, 원본 앵커 의존성, 범위 밖 입력을 표시한다.
- 원본 trim의 유효 속도 구간이 끊겨 있으면 구간을 나누어 표시한다. 예측의 물리 경계 위반값은 그래프에서 비우고 API `rawPredictions`에는 원값을 보존한다.
- CPU 모델 서버, Node 프런트, PostgreSQL, nginx의 Docker Compose와 WSL 실행 스크립트를 추가했다.

## 검증

| 항목 | 결과 |
| --- | --- |
| JavaScript 단위·계약·프록시 테스트 | 165개 통과 |
| Python 전체 테스트, 실제 PostgreSQL 포함 | 100개 통과, skip 없음 |
| TypeScript 검사와 변경 UI/프록시 lint | 통과 |
| 프런트 production build | 로컬 Windows와 Docker Linux 통과 |
| 모델 원본 검증 | 원본 GPU 샘플의 SiLU/정밀도 설정 확인, 20개 golden 대조 통과 |
| Docker Linux CPU 모델 | 20개 golden의 8개 출력 모두 일치 |
| Python/TS 동작 대조 | 실제 설계 hydration·fingerprint·BOM, 전체 데이터의 6개 목표 후보 랭킹·제한 최적화 일치 |
| 실제 API 통합 | 저장·CAS 충돌·적용·되돌리기·견적·NDJSON·취소·갤러리 확인 |
| Google 인증 | 합성 OIDC·PKCE 검증 통과; 실제 Google 로그인 화면 진입 확인, 계정 인증 완료는 별도 |
| 실제 AliExpress | 일반 모터 검색 8개 상품 반환; 해당 KDE 모터의 빈 검색은 not_found로 처리 |
| 실제 OpenAI | 429 credit_balance_exhausted 반환. 외부 계정 잔액 부족 안내 추가 |

기존 로컬 D1에는 사용자·프로젝트·기록·견적·갤러리 데이터가 0건이었다. 운영 D1 export는 제공되지 않았으므로 운영 데이터 이전은 실행하지 않았다. 비어 있지 않은 합성 export로 모든 테이블 ID/소유권/JSON 유지, 기존 대상 보호, 실패 시 전체 rollback을 검증했다.

Vinext 1.0.0-beta.5의 production Link가 동적 navigation export를 찾지 못해 선로딩과 클릭 이동이 실패하는 문제를 확인했다. 별도 패키지·지도 페이지로 가는 링크는 표준 브라우저 링크로 처리하며, 작업 화면 내부의 React 탭 전환은 유지한다. 의존성 파일을 직접 패치하거나 콘솔 오류를 숨기지 않는다.

브라우저 검증 자료는 `work/refactor-verification`에 보관했다. 실제 설계 #17297을 불러오고 동체 길이를 203 → 223 mm로 수정해 예측 갱신을 확인했다.

## 실행과 필요한 외부 설정

`powershell -ExecutionPolicy Bypass -File scripts/start-docker.ps1`

접속: http://localhost:3000

API 문서: http://localhost:3000/api/docs

실제 실행 중인 Docker 서비스 4개(frontend/api/postgres/nginx)의 Healthy 상태와 Windows에서의 HTTP 응답을 확인했다. 최초 통합 검증 당시 프런트 이미지는 `5ee2c437494c`, API 이미지는 `fa81bb781997`다. 패키지 → 상세 → 설계 화면, 비행 지도 → 설계 화면으로 실제 클릭 이동을 검증했고 편집값 223 mm / 25 mm가 유지됐다. 수정 후 검증 경로에서 브라우저 콘솔 오류가 없었다. 별도 검증용 Windows 서버(3001/8000)는 종료했다.

Google 로그인은 `.env.local`의 `GOOGLE_CLIENT_ID`와 `GOOGLE_CLIENT_SECRET`, Google Console의 반환 주소 등록이 필요하다. OpenAI 설명·의도 해석에는 계정 크레딧이 필요하다. 학습된 성능 모델은 OpenAI와 독립적으로 동작한다.

설정과 기존 데이터 이전: [FASTAPI_MIGRATION.md](FASTAPI_MIGRATION.md)

모델 지원 범위·출처: [model_bundle/README.md](../backend/model_bundle/README.md)

위 기록은 로컬 통합 검증 결과다. 운영 사이트 배포·원격 데이터 이전은 실행하지 않았다. 코드 리뷰를 위한 `develop` 대상 PR과 운영 준비 완료는 구분한다.

## 2026-09-21 추가 정리와 로컬 추론 점검

- `dongha/`는 `ml/sources/dongha/`로, 루트의 `best_model.pt`, `model_preprocessor.pkl`, `dl_preprocessor.pkl`는 `ml/archive/root-artifacts/`로 이동했다. 29개 파일, 96,870,025바이트의 이동 전후 SHA256이 모두 같다. 루트 체크포인트와 model 전처리는 원본 run의 파일과 동일한 중복본이었다.
- `backend/model_bundle`의 실행용 숫자 파일은 변경하지 않았다. 새 원본 경로를 기준으로 exporter의 `--verify-only`로 원본 해시와 20개 CPU golden을 확인했다.
- 설계 #17297에서 길이 203→223mm를 바꾸자 20m/s 예측 추력 70.02→70.63N, 전력 1387.4→1390.6W로 변했다. 로컬 성능 모델의 실제 추론과 화면 갱신을 확인했다.
- 설계 #20015는 필요한 유효 원본 호버 입력이 없어 서버가 422로 거절한다. 화면에서 이 영구 입력 오류와 일시적인 서버 오류를 구분하고, 효과 없는 재시도 버튼 대신 다른 설계 선택을 안내하도록 수정했다.
- `npm run dev` 시작 전에 별도 FastAPI 연결과 개발 주소를 점검한다. 백엔드가 없는 상태에서 화면만 뜨는 문제를 방지하며 포트도 자동 변경하지 않는다. Docker 앱의 기본 주소는 계속 `http://localhost:3000`이다.
- `npm run model:check`를 추가했다. 로그인이나 OpenAI 호출 없이 준비 상태·버전·속도별 실제 8개 출력을 검사한다. #17297 성공과 #20015의 명시적인 입력 오류를 확인했다.
- 추가 변경 후 JavaScript 전체 테스트 172개 통과, 변경 UI의 TypeScript·lint·성능 클라이언트 테스트 통과. 기존 Python 전체 100개 검증과 별도로 이번 변경의 모델 검증 결과는 ML 안내에 기록했다.

Google 키는 이제 서버에 반영됐다. 실제 로그인 버튼에서 `drawn`의 Google 계정 입력 화면까지 연결됐고, 사용자 계정의 로그인 완료는 별도 확인 대상이다. OpenAI는 마지막 실호출에서 `credit_balance_exhausted`를 반환했다. 무료 토큰 등록만으로 결제 잔액이 생기지는 않으며, 학습 성능 모델의 동작은 OpenAI 잔액과 무관하다.

학습 자료에는 재현 한계가 남아 있다. 과거 학습 테스트 두 개가 참조하는 `test-ai-modeling`의 개선된 구현이 제공되지 않았고, 받은 구형 학습 스크립트는 현재 체크포인트의 구조와 일치하지 않는다. 기존 테스트를 숨기거나 새 학습 결과로 오인하지 않도록 원본을 보존하고 [ML 안내](../ml/README.md)에 명시했다. 추론 검증과 전체 재학습 재현은 구분한다.

현재 코드·모델·이전 서버 참조의 위치: [구조 안내](ARCHITECTURE.md).

## PR에서 함께 검토할 미완료 사항

이번 변경은 develop 디자인과 FastAPI·PostgreSQL·학습 모델의 통합 단계다. 수정 형상에 대한 성능 정확도와 실제 외부 계정을 연결한 에이전트 전체 흐름의 완성을 의미하지 않는다.

- [AI 모델 한계와 개선 과제](AI_MODEL_LIMITATIONS.md): 21개 원본 입력·파생 입력을 포함한 274차원과 8개 출력, 원본 시뮬레이션 앵커 의존성, Neighbor Estimate와의 차이, 미지원 출력, 속도 경고·깨진 호버 데이터, 평가·재학습 재현의 한계.
- [에이전트 완성도와 남은 작업](AGENT_READINESS.md): 구현된 계약과 실제/mock 검증 구분, 로그인→저장→답변→적용→복구→견적 흐름의 완료 기준, 답변 근거·실패 상태·취소·운영 개선 우선순위.

최종 추가 검증: 모델 테스트 16개 통과. 프런트 이미지 `9769c79727dc`를 로컬 Docker에 반영했고 앱·API HTTP 200을 확인했다. 새 화면에서 #20015의 명시적인 입력 미지원 안내와 재시도 버튼 제거, 드롭다운으로 #17297 선택 후 8개 예측값·곡선 복구를 검증했다. 별도 검증 브라우저는 종료했다.


## 2026-09-21 PR 병합 검증

최신 develop `4ee7d864b8169ea3defcaa3dcbd9a1c0f70613fb`를 브랜치에 병합했다. 기존 XGBoost 목업 서버는 현재 FastAPI 구현으로 대체했고, develop의 화면 스타일과 초기 홈 로딩을 반영하면서 에이전트·실제 MLP·기하 offset·끊긴 trim 구간 처리를 유지했다.

- JavaScript 172개 및 실제 PostgreSQL을 포함한 backend 테스트 100개가 다시 통과했다. backend skip은 0개이며 외부 공급자 mock 범위는 에이전트 문서에 명시했다.
- 모델 원본 해시와 CPU golden 20개 × 출력 8개를 다시 검증했고 최대 절대 차이는 모두 0이었다.
- 최종 병합 화면의 TypeScript·변경 파일 lint·Windows production build가 통과했다. 위 Docker/Linux·브라우저 기록은 앞선 통합 검증 시점의 결과다.
- Git에 저장되는 보존 파일 29개와 해시 보호 번들 3개의 바이트·SHA256을 대조했다. `.gitattributes`로 원본·배포 번들의 줄바꿈 변환을 막아 다른 OS에서도 검증 해시를 유지한다.
- PR 전체 대상에서 실제 환경 비밀값·가상환경·기존 PointNet 데이터 제외와 파일당 100MiB 미만을 확인했다. 원본 학습 자료는 이동 해시 보존을 위해 기존 공백까지 변경하지 않았다.

운영 배포, 운영 데이터 이전, 새로운 모델 학습 또는 실제 외부 계정 전체 흐름을 완료한 결과는 아니다. 다음 작업의 완료 기준은 AI 모델 한계·에이전트 완성도 문서를 따른다.
