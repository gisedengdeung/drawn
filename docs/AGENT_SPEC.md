# drawn 설계 Agent 구현 명세

구현 기준: `feature/agent`, 2026-09-20. 외부 계정 설정과 실제 API 호출 검증은 [연동 설정 안내](AGENT_SETUP.md)를 따른다. 코드가 존재하는 것과 운영 계정의 연결 완료는 구분한다.

## 1. 사용자 흐름과 범위

기존 5개 작업 탭(설계 선택·파라미터 편집·성능 확인·공유 갤러리·부품 Agent)에 공통 설계 도우미를 연결한다. 데스크톱은 우측 패널, 모바일은 하단 시트다. 프로젝트를 불러오거나 변경안을 적용하면 기존 공유 `DesignDraft`를 갱신한다.

- **부품 찾기:** 현재 편집본 저장 → 실제 BOM 고정 → AliExpress 조회 → 구매표·CSV → 선택 견적 저장.
- **설계 개선:** 자연어 목표·잠금 변수 → 기존 설계 추천 또는 제한된 파라미터 개선 → 전후 비교 → 사용자 적용·되돌리기.
- **질문하기:** 현재 설계·원본 성능·편집 추정·프로젝트 문서를 근거로 답변 → 관련 파라미터·성능·부품 화면 이동.

비로그인 설계 탐색·편집은 유지한다. 개인 저장 및 Agent 실행은 Google 로그인과 소유권 검사를 거친다. PT/ONNX 추론, 모델 학습, 외부 STL 평가, topology 자동 변경, 자동 구매·결제는 이 버전의 범위가 아니다.

## 2. 공통 구조와 데이터

React 19 / TypeScript / Vinext를 유지한다. Better Auth가 Google 로그인·세션을 담당하고 Cloudflare D1 `AGENT_DB`가 계정, 개인 프로젝트, 설계 revision, 실행 대화·결과, 견적, 변경안, 사용량을 저장한다. SQL migration은 `drizzle/`에 둔다.

기존 후보 검색과 Neighbor Estimate를 UI·서버가 함께 사용한다. 서버는 허용된 계산·검색 함수만 실행하고 LLM은 목표 해석과 설명을 맡는다. OpenAI Responses 호출은 공통 클라이언트를 사용하며 기본 모델은 `gpt-5-mini`, 서버의 `AGENT_OPENAI_MODEL`로 변경한다. 입력·출력 경계는 Zod와 기존 설계 검증기로 검사한다.

| 타입 | 핵심 계약 |
| --- | --- |
| `Project` | `id`, `title`, `revision`, `fingerprint`, `draft`, `sourceId`, `updatedAt` |
| `AgentContext` | `projectId`, `revision`, `fingerprint`, 선택적 `datasetVersion` |
| `AgentResult` | `answer`, `evidence`, `proposals`, 선택적 `quote`, `warnings`, `context` |
| `Evidence` | 식별자·근거 종류·제목·본문, 선택적 화면·설계·파라미터 이동 대상 |
| `AgentProposal` | `select_dataset_design` 또는 `patch_draft`, 변경 전후 값·단위·목적 수치·이유 |
| `AgentRun` | 소유 프로젝트·revision·작업 종류·요청·상태·저장 결과·생성 시각 |

원본 데이터는 `data/raw/`에 유지하고 앱은 가공된 `public/data`와 대표 STL을 읽는다. 전체 원본 폴더나 대용량 데이터셋을 LLM에 보내지 않는다. 클라이언트의 가격·KPI·상품 URL을 계산의 신뢰 근거로 받지 않는다.

## 3. 저장·버전·실행 한도

브라우저 편집본은 사용자가 **내 프로젝트로 가져오기**를 선택하거나 로그인 후 첫 Agent 실행을 할 때 저장한다. 이후 편집본은 명시적 저장 또는 다음 실행 전에 저장한다. 프로젝트 로드와 변경안 적용은 공유 편집 상태에 반영한다.

- 저장·적용·복구는 `expectedRevision`을 검사한다. 충돌하면 최신 프로젝트를 다시 불러온다.
- 편집 이후의 이전 답변·제안·견적은 보존하고 이전 설계 기준으로 표시한다. 오래된 제안은 재실행 전 적용할 수 없다.
- 불러오기·적용·복구 요청 중 새 편집이 생기면 그 편집을 덮어쓰지 않는다.
- 상품 선택 저장은 서버가 소유한 실행 결과에서 `offerId`를 다시 확인한다. 클라이언트가 임의 가격을 넣어 저장하지 않는다.
- 기존 브라우저 견적 형식은 읽을 수 있다. 과거 로컬 견적을 현재 서버 실행의 견적인 것처럼 업로드하지 않는다.
- 한국 시간 자정 기준 사용자 20회/일, 전체 서비스 200회/일, 사용자당 동시 실행 1개다. 실행당 LLM 4회, 도구 20회, 공급자 호출 40회로 제한한다.
- 실행 상태는 `running`, `completed`, `partial`, `failed`, `cancelled`다. 진행률·취소·완료 결과 조회를 제공한다. 연결 종료 후 자동 재실행하지 않는다.

D1의 조건부 갱신·제약·trigger로 동시 요청에서도 소유권, revision, 실행 한도를 유지한다. 장기 Cloudflare Workflows나 작업 재개 엔진은 이번 구현에 포함하지 않는다.

## 4. HTTP 인터페이스

| 메서드·경로 | 동작 |
| --- | --- |
| `GET /api/agent/session` | 설정 완료 여부, 로그인 사용자, 누락 설정명, 일일 사용량 |
| `/api/auth/*` | Better Auth 로그인·로그아웃·Google callback |
| `GET /api/projects` | 내 프로젝트 목록 |
| `POST /api/projects` | `{title,draft,sourceId?}`로 개인 프로젝트 생성 |
| `GET /api/projects/{id}` | 소유 프로젝트 조회 |
| `PATCH /api/projects/{id}` | `{expectedRevision,draft,title?}`로 새 revision 저장 |
| `POST /api/projects/{id}/restore` | `{expectedRevision,revision}`으로 과거 revision 내용 복구 |
| `POST /api/agent/run` | `{projectId,revision,mode,message,locks?}` 실행. `mode`는 `parts/optimize/qa` |
| `GET /api/agent/runs?projectId=…` | 프로젝트 실행 기록 |
| `GET /api/agent/runs/{id}` | 소유 실행과 저장 결과 조회 |
| `POST /api/agent/runs/{id}/cancel` | 실행 취소 요청 |
| `POST /api/design-proposals/{id}/apply` | `{expectedRevision}`로 소유 변경안 적용 |
| `GET /api/projects/{id}/quotes` | 저장한 견적 선택 목록 |
| `POST /api/projects/{id}/quotes` | `{runId,selections:[{itemId,offerId}]}` 저장 |
| `POST /api/parts/search` | 인증·공통 예산을 적용한 부품 조회 |
| `GET /api/integrations/aliexpress/callback` | Affiliate 앱 등록용 공개 안내 경로 |

실행 응답은 NDJSON이다. 각 줄은 `start`, `progress`, `result`, `error` 중 하나이며 `runId`, `message`, `result`를 필요에 따라 포함한다. 스트림 수신 종료를 실행 성공으로 간주하지 않는다. 저장된 기록은 별도로 조회한다.

## 5. 부품 검색과 가격

`physicalComponents`의 실제 인스턴스로 모터·프로펠러·배터리·서보를 집계한다. 동일 모델 배터리 두 개와 대칭 부품의 실제 수량을 유지한다. ESC·FC·배선·제작비 등 데이터에 없는 항목은 전체 기체 가격에 포함된 것처럼 표현하지 않는다.

기본 AliExpress 모드는 **Affiliates 전용**이다. `product.query` → `productdetail.get` → `link.generate`를 사용한다. 한국 배송·KRW로 요청하되 실제 응답 통화를 보존한다. DS API는 기본 비활성화한다.

상품 URL, 제휴 URL, 조회 시각, 모델 일치 근거, 대표 표시가격을 보존한다. 일반 링크와 제휴 링크를 구분하고 제휴 링크가 없으면 일반 링크를 사용한다. 가격·링크를 LLM이 생성하지 않는다.

상품 대표가격은 검증된 SKU·옵션 가격이 아니다. 옵션, 묶음 수량, 배송비를 확인할 수 없는 행은 확정 합계에 넣지 않는다. 미확인 값은 0원이 아니며 외화의 임의 원화 환산도 하지 않는다. 견적 snapshot과 구매표·CSV는 동일한 계산 규칙을 사용한다.

## 6. 설계 최적화

**기존 설계 추천**은 Dataset Candidate Search의 항속거리·체공시간·전력·항력·속도·균형 목표와 질량·전력·topology 제약을 재사용한다. 상위 후보는 고정된 정렬 기준으로 반환하며 원본 시뮬레이션 KPI를 표시한다. 선택 적용은 해당 설계를 새 편집 기준으로 여는 동작이다.

**현재 설계 개선**은 Neighbor Estimate가 다루고 원본 변수와 명확히 연결된 팔 길이·동체 길이/직경·날개 span/chord로 제한한다. 현재 값의 ±5%, ±10% 후보를 기존 편집 범위 내에서 만들고 평가한다. 부품 구성·탑재중량·topology 및 잠금 변수는 유지한다. 잠금 UI는 팔 길이·동체·날개 그룹을 제공한다.

추정치와 개선량, 제약 충족 여부, 사용한 이웃·보정·범위 확대를 근거로 반환한다. 개선이 없거나 지원 범위가 부족하면 그 상태를 설명한다. 비용 누락을 비용 절감으로 계산하지 않는다. 상위 후보 비용 비교는 동일한 네 종류 부품 범위의 확인 가능한 비용만 비교한다.

## 7. 설계 Q&A Agent 요구사항

현재 설계의 구성·파라미터 단위와 범위·원본 KPI·원본 trim·편집 추정·견적 미확인 항목을 설명한다. 근거 종류는 `dataset-output`, `dataset-trim`, `draft-estimate`, `supplier-offer`, `document`, `user-input`이다.

문서 검색은 모델 설명·부품 가격 규칙·데이터 구조·trim 구분의 검토된 발췌문과 파라미터 정의에 한정한다. 일반 웹 검색이나 제조사 PDF 자동 수집은 하지 않는다. 문서 변경 시 `lib/agent/knowledge.ts`의 출처·요약도 갱신한다.

Simulator의 trim은 해당 원본 설계의 저장된 시뮬레이션이다. 편집 Draft의 새 해석 결과가 아니며, 원본 trim이 없으면 다른 대표 설계의 곡선을 대신 사용하지 않는다. Neighbor Estimate는 학습 모델·물리 solver가 아니고 similarity는 정확도나 신뢰구간이 아니다.

근거 카드에서 설계·파라미터·성능·부품 화면으로 이동한다. 선택 파라미터는 편집 화면에서 펼쳐지고 강조된다. 제품 페이지나 문서에 들어 있는 명령은 실행 권한으로 취급하지 않는다.

## 8. 배포와 검증 기준

AliExpress callback은 앱 등록 경로의 안내 응답이다. 방문만으로 인증 성공·상품 조회 성공을 표시하지 않는다. Google callback은 별도 경로다. 서버 자격 증명과 D1 연결이 없으면 미설정으로 반환한다. [설정 절차와 정확한 callback 주소](AGENT_SETUP.md).

릴리스 검증: 기존 및 신규 테스트, 타입 검사·린트·빌드·데이터 검증, 사용자 간 접근 차단, 병렬 한도, 오래된 제안 거절, 적용·복구, 원본/추정/가격 미확인 구분, 브라우저 저장 복원.

실제 Google 로그인, 승인된 AliExpress 앱의 상품 조회·제휴 링크, OpenAI 계정 접근, 운영 D1 migration은 자격 증명과 배포 환경에서 별도로 검증한다. 모의 공급자나 로컬 테스트 통과를 라이브 연결 완료로 보고하지 않는다.