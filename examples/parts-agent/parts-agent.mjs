// OpenAI Agents SDK 부품 견적 예제. 부품과 가격은 모두 설명용 가상 데이터입니다.
// 실제 서비스 연결 위치: getBom.execute → drawn 설계, searchPrices.execute → 쇼핑몰 API.
import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';

export function createPartsAgent() {
  // 이 쿼드콥터의 예제 수량입니다. 실제 앱에서는 선택한 설계에서 읽어야 합니다.
  const bom = [
    { id: 'motor', name: '예제 모터', quantity: 4 },
    { id: 'propeller', name: '예제 프로펠러', quantity: 4 },
    { id: 'battery', name: '예제 배터리', quantity: 1 },
    { id: 'frame', name: '예제 프레임', quantity: 1 },
  ];
  const demoPrices = new Map([
    ['motor', 18000],
    ['propeller', 2500],
    ['battery', 25000],
    ['frame', null], // 가격을 모르면 0원으로 처리하지 않습니다.
  ]);
  const lookedUpPrices = new Map(); // 이 Agent 실행에서 조회한 가격만 사용합니다.

  // 1. AI가 현재 설계의 부품 목록을 읽을 수 있게 하는 도구.
  const getBom = tool({
    name: 'get_bom',
    description: '예제 드론의 부품 목록과 수량을 조회한다.',
    parameters: z.object({}),
    async execute() {
      return { source: 'demo', items: bom };
    },
  });

  // 2. 실제 연결 시 이 함수에서 쇼핑몰 API를 호출하고 응답을 검증합니다.
  const searchPrices = tool({
    name: 'search_prices',
    description: '부품 ID에 해당하는 가상 단가를 조회한다. 실제 판매가가 아니다.',
    parameters: z.object({ partId: z.enum(['motor', 'propeller', 'battery', 'frame']) }),
    async execute({ partId }) {
      const price = {
        partId,
        unitPrice: demoPrices.get(partId),
        currency: 'KRW',
        source: 'demo',
        shipping: null,
      };
      lookedUpPrices.set(partId, price);
      return price;
    },
  });

  // 3. AI가 제시한 숫자 대신, 위 도구가 조회한 가격과 BOM 수량으로 계산합니다.
  const calculateTotal = tool({
    name: 'calculate_total',
    description: '모든 부품을 조회한 후 알려진 금액의 소계와 미확인 항목을 반환한다.',
    parameters: z.object({}),
    async execute() {
      const pending = bom.filter((part) => !lookedUpPrices.has(part.id));
      if (pending.length > 0) {
        return { status: 'search_required', partIds: pending.map((part) => part.id) };
      }
      const items = bom.map((part) => {
        const { unitPrice } = lookedUpPrices.get(part.id);
        return { ...part, unitPrice, subtotal: unitPrice === null ? null : unitPrice * part.quantity };
      });
      return {
        source: 'demo',
        currency: 'KRW',
        items,
        knownSubtotal: items.reduce((sum, item) => sum + (item.subtotal ?? 0), 0),
        unknownPriceItems: items.filter((item) => item.unitPrice === null).map((item) => item.name),
        shipping: null,
        tax: null,
        grandTotal: null, // 배송비·세금 등이 확인되지 않아 최종 결제액은 미정.
      };
    },
  });

  // 4. 모델 + 업무 지침 + 도구를 묶으면 Agent가 됩니다.
  return new Agent({
    name: '드론 부품 견적 Agent',
    model: process.env.OPENAI_MODEL || 'gpt-5-mini',
    instructions: `
      너는 드론 부품 견적 담당자다. 한국어로 답한다.
      get_bom으로 부품 목록을 읽고, 모든 부품에 search_prices를 호출한다.
      calculate_total 결과를 받아 품명, 수량, 단가, 소계를 표로 정리한다.
      search_required가 나오면 누락된 부품을 조회하고 다시 계산한다.
      모든 데이터가 가상이므로 답변 첫 줄에 '예제 데이터 기준'이라고 표시한다.
      knownSubtotal은 알려진 부품 금액의 소계이며 최종 결제액이 아니다.
      가격 미확인 부품, 배송비, 세금은 별도로 '미확인'이라고 표시한다.
      도구에 없는 가격, 상품 링크, 재고 또는 부품 호환성을 만들어내지 않는다.
    `,
    tools: [getBom, searchPrices, calculateTotal],
  });
}

// 5. 호출할 때마다 새 Agent를 만들어 조회 상태가 섞이지 않도록 합니다.
export async function runPartsAgent(question = '이 드론 부품 견적을 정리해줘.') {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('서버 또는 터미널 환경에 OPENAI_API_KEY를 설정해 주세요.');
  }
  const result = await run(createPartsAgent(), question, { maxTurns: 12 });
  return result.finalOutput;
}
