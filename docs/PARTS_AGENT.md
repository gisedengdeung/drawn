# 부품 구매 후보 에이전트

견적 BOM의 각 행을 `POST /api/parts/search`에 보내면 한국 배송·KRW 기준으로 실제 AliExpress 후보를 최대 3개 반환한다. 모델이 가격이나 URL을 생성하지 않는다. AliExpress 검색과 상세 결과에 실제로 존재한 상품 ID·URL·가격만 결과로 반환한다.

## 서버 설정과 실행

`.env.example`을 참고하여 로컬 서버 환경에 `ALIEXPRESS_APP_KEY`, `ALIEXPRESS_APP_SECRET`을 설정한다. 비밀값은 Git에 올리지 않는다. `OPENAI_API_KEY`가 있으면 Responses API의 구조화 출력으로 검색어와 근거가 있는 후보 순위를 생성한다. 기본 모델은 `gpt-5-mini`, 변경은 `PARTS_OPENAI_MODEL`로 한다. OpenAI 키가 없거나 분석이 실패하면 모델명/규격 규칙으로 검색하며 UI에 그 상태를 표시한다. AliExpress 키가 없으면 `not_configured`를 반환하고 가상 가격을 만들지 않는다.

`ALIEXPRESS_ACCESS_TOKEN`은 선택 설정이다. 해당 앱에 허용된 DS 사용자 승인 토큰이 있으면 SKU 가격·옵션·재고를 추가 확인한다. 토큰 발급·갱신 UI는 이번 범위에 포함하지 않았다. 토큰 만료나 권한 오류를 숨기지 않고 경고에 표시한다. `ALIEXPRESS_TRACKING_ID`는 선택 사항이며 결과에는 API가 반환한 직접 상품 URL을 사용한다.

개발 서버가 실행된 상태에서 `node scripts/check-parts-api.mjs`를 실행한다. 기본 주소는 `http://localhost:5173`이며 모터·프로펠러·배터리 3개 모델을 순서대로 조회한다. 다른 로컬 포트는 `PARTS_SMOKE_BASE_URL`, 검증할 모터명은 `PARTS_SMOKE_MODEL`로 지정한다. 이 명령은 구매 없이 상품 조회만 하며 자격 증명을 출력하지 않는다. 키가 없으면 첫 요청의 `not_configured`를 표시하고 종료 코드 2로 멈춘다. 조회 오류·검색 결과 없음은 종료 코드 1이다. 종료 코드 0은 상품 조회 성공이며 출력의 `optionVerified`가 false면 SKU 가격 검증까지 성공한 것은 아니다. 실제 키가 없는 개발 환경에서는 라이브 조회를 검증했다고 주장하지 않는다.

## 공식 프로토콜과 확인 범위

본 구현은 공개된 개별 API 문서가 명시하는 **TOP 프로토콜**을 사용한다. 기본 HTTPS 게이트웨이는 `https://eco.taobao.com/router/rest`, `ALIEXPRESS_TOP_REGION=US`일 때는 공식 기존 해외 게이트웨이 `https://api.taobao.com/router/rest`다. 임의의 요청 URL은 허용하지 않는다. 파라미터를 ASCII순으로 정렬하고 키+값을 연결하여 App Secret으로 UTF-8 HMAC-MD5를 수행한다. 결과는 대문자 16진수이며 `sign_method=hmac`다. timestamp는 GMT+8이다.

- [공식 Affiliate 검색 API](https://developer.alibaba.com/docs/api.htm?apiId=45803): 키워드, 배송 국가, 통화, 상품 링크와 상품 가격.
- [공식 Affiliate 상세 API](https://developer.alibaba.com/docs/api.htm?apiId=48595): 상품 ID별 현재 데이터. 검색 상품도 상세로 다시 확인한다.
- [공식 DS 상품 API](https://developer.alibaba.com/docs/api.htm?apiId=60452): 승인 필요, SKU 옵션·가격·재고.
- [공식 TOP 서명 설명](https://developer.alibaba.com/docs/doc.htm?articleId=122464&docType=1&treeId=846): HMAC-MD5와 정렬 규칙.
- [기존 Affiliate 호출 안내](https://developer.alibaba.com/docs/doc.htm?articleId=118934&docType=1&treeId=674): 해외 TOP 게이트웨이. 안내 묶음이 폐기 표시되어 있어 현재 계정에서 호출 권한을 먼저 검증해야 한다.
- [AliExpress IOP 서명](https://developer.alibaba.com/docs/doc.htm?articleId=120692&docType=1&treeId=727)은 다른 `/rest` SHA256 프로토콜이다. 이 구현의 TOP 서명과 혼합하지 않는다.

현재 계정에서 이 TOP API가 허용되는지는 실제 발급 키로 smoke test를 통과해야 확인된다. 새 Open Platform 문서가 이 조사 환경에서 열리지 않아 최신 `/sync` 게이트웨이 호환성, 신규 가입 승인 조건과 제한량은 확인하지 못했다. API 키가 특정 IOP 앱만 지원한다면 계정 콘솔의 최신 공식 명세를 확인하고 공급자 어댑터를 갱신해야 한다.

## 가격 및 매칭 규칙

- 상품 대표가격은 표시할 수 있지만 `optionVerified=false`이므로 확정 견적에 사용하지 않는다. `optionVerified`는 선택한 판매 SKU의 모델·숫자 규격·가격 출처 확인이고, 원래 부품과의 호환성 보증은 아니다. 요청 모델까지 확인되면 `exact`로 분류한다. 실제 상품 근거로 식별한 다른 모델은 `alternative`를 유지하며 자동 선택하지 않는다. 동일 부품 종류이고 필요한 숫자 규격과 선택 옵션이 모두 확인된 대체 후보는 사용자가 직접 선택하면 상품 소계를 계산할 수 있다. 옵션이 모호하거나 규격이 빠진 후보는 계산하지 않는다.
- 모터 KV, 프로펠러 지름/피치, 배터리 셀 수/용량이 명시적으로 다르면 후보에서 제외한다. AI의 대체 부품 판단은 항상 검토 대상으로 남는다. 규격 문자열 일치는 기계적/전기적 호환성 보증이 아니다.
- 구매 묶음 수량은 옵션/제목에 명시된 `pcs`, `pieces`, `pack`, `pair`, `single` 표현만 해석한다. 충돌하거나 없으면 `null`이다. 재고는 판매 SKU 묶음 수량이다.
- 배송 가능 여부, 배송비, 세금과 사용자별 할인·쿠폰의 최종 결제액은 미확인이다. 국가 필터가 특정 SKU 배송을 보증한다고 가정하지 않는다. 원화를 요청해도 응답 통화가 다르면 원래 통화를 유지한다. UI에서 미확인 비용을 0원으로 계산하면 안 된다.
- 모델 출력은 제공된 상품 ID에만 연결하고 같은 상품의 원문에 있는 근거 문장만 허용한다. 임의 ID·링크·가격·스펙은 모델 결과에서 읽지 않는다. HTML 설명은 제거하여 전달한다.

## 범위와 운영

요청은 알려진 부품 종류, 240자 이하 모델명, 1~1000의 정수 수량 또는 null, KR/KRW만 허용한다. 요청 본문은 16KB 이하이며 URL은 입력으로 받지 않는다. 검색은 최대 2개, 검색당 8개, 상세 6개, DS 상세 4개, 반환 3개로 제한한다. 외부 요청당 12초, 일시 오류 재시도 1회, 작업 전체 55초로 제한한다. 일부 검색/AI/DS 실패 시 확인된 범위만 결과에 남긴다.

경로는 같은 origin 요청만 허용하고 프로세스당 동시 3개·분당 30개 한도를 둔다. 이는 로컬 개발의 비용 제어이며 인증이나 분산 제한을 대신하지 않는다. 공개 다중 인스턴스 서비스로 배포하기 전에는 사용자 인증, 사용자별 예산, 공유 저장소 기반 rate limit을 추가해야 한다. 원시 외부 응답·키·토큰은 오류 메시지나 로그로 반환하지 않는다. 자동 구매/장바구니/결제는 포함하지 않는다.
