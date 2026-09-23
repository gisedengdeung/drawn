# 부품 견적 Agent 코드 예제

`parts-agent.mjs`는 OpenAI Agents SDK로 만든 독립적인 코드 예제입니다. drawn 화면이나 서버에는 아직 연결하지 않았습니다. 현재 체크아웃에는 이전 대화에서 언급한 `lib/parts`가 없어 그 경로를 참조하지 않습니다.

코드는 `tool()`로 도구 3개를 만들고, `new Agent()`에 모델·업무 지침·도구를 등록한 뒤, `run()`으로 실행합니다.

| 도구 | 현재 동작 | 실제 서비스 연결 위치 |
| --- | --- | --- |
| `get_bom` | 가상의 드론 부품 목록 반환 | drawn에서 선택한 설계의 부품·수량 |
| `search_prices` | 가상의 원화 단가 반환 | 쇼핑몰 API 및 응답 검증 |
| `calculate_total` | 조회된 단가와 수량을 코드로 합산 | 검증된 견적 데이터 |

예제의 알려진 부품 소계는 107,000원입니다. 프레임 가격, 배송비, 세금은 미확인이므로 최종 결제액은 반환하지 않습니다. 모터 4개 등의 수량은 이 예제만의 값입니다. 모든 드론에 적용하면 안 됩니다.

## 실행 방법

아래는 사용자가 실행할 때의 절차입니다. 패키지 설치와 실제 OpenAI 요청은 이 예제를 작성하면서 수행하지 않았습니다.

PowerShell에서 이 폴더로 이동한 뒤 패키지를 이 폴더에 설치합니다. 앱 루트의 의존성은 변경하지 않습니다.

```powershell
Set-Location 'C:\Dev\drawn\drawn\examples\parts-agent'
npm install --prefix . @openai/agents zod
```

터미널 또는 서버의 환경 변수에 `OPENAI_API_KEY`를 설정한 상태에서 실행합니다. 키를 브라우저 코드나 저장소에 넣지 않습니다. 기본 모델은 `gpt-5-mini`이며 `OPENAI_MODEL`로 바꿀 수 있습니다.

```powershell
node --input-type=module -e 'import { runPartsAgent } from "./parts-agent.mjs"; console.log(await runPartsAgent("이 드론 부품 견적을 정리해줘."));'
```

이 명령은 OpenAI API를 호출합니다. 쇼핑몰은 호출하지 않으며, 가격은 계속 가상 데이터입니다.

모델이 어떤 도구를 선택하고 호출하는지는 실제 API 실행 후 확인할 수 있습니다. 파일 구문 검사만으로 모델의 도구 사용이나 최종 답변 품질까지 검증되는 것은 아닙니다.

공식 문서: [Agent 정의](https://developers.openai.com/api/docs/guides/agents/define-agents), [빠른 시작](https://developers.openai.com/api/docs/guides/agents/quickstart).
