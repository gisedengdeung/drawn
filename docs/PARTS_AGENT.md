# 설계 도우미 AI · 부품 찾기

> FastAPI + PostgreSQL 전환 실행 및 설정: [FASTAPI_MIGRATION.md](FASTAPI_MIGRATION.md). 기존 Sites/D1 배포 안내는 이전 구조 참고입니다.

현재 설계의 실제 BOM을 기준으로 AliExpress 제휴 상품의 표시 가격과 구매 링크를 찾는다. 모델이 가격·URL·상품 ID를 생성하지 않는다. 검색 결과는 제휴 상품 범위이며 전체 쇼핑몰의 최저가나 구매 가능성을 보장하지 않는다.

상단 **설계 도우미 AI → 부품 찾기** 또는 파라미터 편집 화면의 부품 찾기 버튼으로 연다. 별도 부품 탭으로 이동하지 않고 오른쪽 패널에서 BOM 확인, 검색, 상품 비교·선택, 견적 저장, CSV 내보내기까지 진행한다. 데스크톱 패널은 기본 420px에서 최대 640px로 펼칠 수 있으며 중앙 작업 공간은 최소 480px를 유지한다. 화면 너비 1024px 미만에서는 같은 기능을 하단 시트로 제공한다.

## 기본 모드: Affiliates API

서버는 `aliexpress.affiliate.product.query`로 검색하고, `aliexpress.affiliate.productdetail.get`으로 실제 상세 가격을 다시 조회한다. Tracking ID가 설정되면 `aliexpress.affiliate.link.generate`도 호출한다. 검색 결과가 있어도 상세에서 사라진 상품은 제외한다.

- `url`: 동일 상품 ID의 정규 상품 URL. 이전 v1 견적과 호환되도록 유지한다.
- `promotionUrl`: API가 반환한 HTTPS 제휴 링크 또는 null. 생성 응답의 `source_value`가 요청한 상품 URL과 정확히 일치할 때만 연결한다. 임의 리다이렉트·유사 도메인·인증 정보가 포함된 URL은 거부한다.
- `priceKind: listing`: 상품 표시 가격. 원하는 옵션의 가격인지 확인되지 않았으므로 확정 소계에 포함하지 않는다.
- `priceKind: sku`: 명시적으로 활성화한 DS 조회에서 받은 옵션 가격. 실제 옵션·모델·규격·묶음 수량 검증을 통과해야 소계에 포함된다.
- `market`: 한국 조건과 KRW 요청이라는 조회 범위를 기록한다. 응답 통화가 다르면 변환하거나 원화로 가장하지 않는다.

기본 모드는 DS 토큰을 요구하지 않으며 DS 권한이 없다는 경고도 표시하지 않는다. 상품 카드에는 표시 가격, 조회 시각, 규격 확인 상태와 제휴 링크를 보여준다. 링크 생성이 실패하면 확인한 가격과 일반 상품 URL을 유지한다. 상품 표시 가격을 개당 가격·필요 수량별 확정 견적으로 바꾸지 않는다.

## 서버 설정

`.env.example`을 참고한다. 다음 값은 서버 비밀 설정이며 브라우저용 접두사를 붙이지 않는다.

| 설정 | 용도 |
|---|---|
| `ALIEXPRESS_APP_KEY`, `ALIEXPRESS_APP_SECRET` | 상품 조회와 서명 |
| `ALIEXPRESS_TRACKING_ID` | 제휴 링크 생성. 없으면 일반 상품 링크 사용 |
| `ALIEXPRESS_API_PROTOCOL` | 기본 `IOP`: 새 AliExpress Open Platform 앱. `TOP`은 기존 TOP 앱만 사용 |
| `ALIEXPRESS_TOP_REGION` | `TOP` 모드에서만 `CN` 기본값 또는 `US` 게이트웨이 선택 |
| `ALIEXPRESS_DS_ENABLED=true` | 선택적인 DS 옵션 조회 활성화 |
| `ALIEXPRESS_ACCESS_TOKEN` | DS를 명시적으로 켠 경우에만 사용하는 승인 토큰 |
| `OPENAI_API_KEY`, `PARTS_OPENAI_MODEL` | 단독 부품 검색에서 선택적인 검색어·근거 분석 |

DS 토큰을 넣는 것만으로 DS 호출을 시작하지 않는다. 권한을 확보하고 `ALIEXPRESS_DS_ENABLED=true`도 설정해야 한다. 토큰 발급·갱신은 이 공급자 모듈에 포함하지 않는다.

공통 Agent는 이미 의도를 해석하므로 `searchParts(..., { allowAI: false, consumeBudget })`로 호출한다. `consumeBudget(kind)`는 모든 외부 HTTP 시도 직전에 호출되며 재시도도 포함한다. `kind`는 `provider` 또는 `ai`이고, false를 반환하거나 예외가 발생하면 네트워크 호출을 막는다. 호출 한도는 상위 실행 예산과 연결해야 하며 이 훅은 사용자 인증을 대신하지 않는다.

## 프로토콜과 권한 확인

새 Open Platform 앱은 기본적으로 `https://api-sg.aliexpress.com/sync`를 사용한다. 비어 있지 않은 파라미터의 키를 정렬해 키·값을 연결하고 UTF-8 HMAC-SHA256 대문자 16진수로 서명한다. `/sync`의 dotted method는 서명에 API 경로 접두사를 넣지 않으며 timestamp는 Unix 밀리초다. 이 요청 방식은 실제 발급 앱의 상품 검색 응답으로 검증했다. [AliExpress 서명 문서](https://developer.alibaba.com/docs/doc.htm?articleId=120692&docType=1&treeId=727).

기존 TOP 앱만 `ALIEXPRESS_API_PROTOCOL=TOP`을 명시한다. 이때 CN `eco.taobao.com/router/rest`, US `api.taobao.com/router/rest`를 사용하며 HMAC-MD5와 GMT+8 timestamp를 유지한다. `ALIEXPRESS_TOP_REGION`만 설정해도 기본 IOP 모드는 바뀌지 않는다.

- [Affiliate 검색 API](https://developer.alibaba.com/docs/api.htm?apiId=45803)
- [Affiliate 상세 API](https://developer.alibaba.com/docs/api.htm?apiId=48595)
- [Affiliate 링크 생성 API](https://developer.alibaba.com/docs/api.htm?apiId=45804)

위 API는 사용자 승인이 필요하지 않은 API로 문서화되어 있다. 이 기능만을 위해 DS 판매자 OAuth를 요구하지 않는다. 다만 계정에 발급된 앱의 API 권한과 게이트웨이 지원은 실제 계정에서 검증해야 한다. 새 플랫폼의 프로토콜이나 권한을 자동으로 가정하지 않는다.

## 구매 정리와 저장

기존 `drawn.parts-quote.v1` 및 `aerotwin.parts-quote.v1` 견적은 복원 가능하다. 새 메타데이터가 없는 견적은 기존 검증 상태를 보존하며, 옵션 ID를 기준으로 가격 표시 이름만 결정한다. 새 응답의 잘못된 제휴 링크나 상품 ID 불일치는 저장 복원 단계에서도 거부한다.

UI와 CSV는 같은 선택·수량·소계 계산을 사용한다. CSV에는 일반 상품 URL과 구매 링크, 제휴 링크, 가격 기준, 조회 범위를 함께 저장한다. 확인하지 못한 가격·배송비는 0원이 아닌 미확인으로 남는다. 제휴 링크를 통한 구매 시 수수료가 발생할 수 있음을 표시한다.

검색은 공통 Agent 실행 경로를 사용하며 로그인, 실행 예산, 진행 상태, 취소도 다른 모드와 공유한다. 검증된 BOM과 결과를 패널의 부품 카드와 견적 요약에 표시하고, 설계가 바뀌면 이전 설계 기준임을 표시한다. 상품별 수량·동일 모델/대체 후보·가격 확인 수준·조회 시각·구매 링크를 확인한 뒤 후보를 선택한다.

견적 선택은 패널을 닫거나 질문하기·설계 개선으로 전환해도 유지한다. 같은 실행을 다시 표시하거나 모바일 시트로 바뀌었다는 이유만으로 선택을 원본 응답으로 덮어쓰지 않는다. 선택 저장은 해당 Agent 실행과 BOM·생성 시각이 일치하는 견적에 대해서만 활성화하며, 저장 중에는 선택 변경을 막고 성공·실패를 표시한다. 서버는 실행 ID와 프로젝트 소유권을 별도로 검증한다. 이전 실행 기록의 부품 근거 링크는 현재 편집 설계를 바꾸지 않고 패널의 부품 찾기를 연다.

## 검증

`node --test tests/parts-*.test.mjs`로 서명, 제휴 URL 검증, 상세 재조회, 링크 생성의 상품 연결, DS 명시적 활성화, 가격 구분, 호출 예산과 재시도 차단, v1 복원, CSV 일치를 검증한다.

브라우저에서는 패널 닫기·모드 변경·화면 너비 변경 후 구매 후보 선택 유지, 프로젝트·실행별 견적 분리, 편집 후 이전 견적 표시, 패널 안에서 견적 저장·CSV 내보내기와 구매 링크 열기를 확인한다.

실제 발급 키를 사용하는 읽기 전용 연결 확인은 `scripts/check-parts-api.mjs`로 수행한다. 비밀값을 출력하지 않으며 키가 없거나 공급자가 거부하면 성공으로 보고하지 않는다. 모의 응답 테스트 통과는 실제 계정의 연결 성공을 뜻하지 않는다.