import type { BomSnapshot, QuoteLine } from './types';
import { calculateOfferAmounts, offerPriceKind } from './pricing';
import { purchaseLink } from './client';

const kindNames = { motor: '모터', propeller: '프로펠러', battery: '배터리', servo: '서보' };
const matchNames = { exact: '동일 모델', alternative: '대체 후보', needs_review: '확인 필요' };

function cell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? '미확인' : String(value);
  // Quoting alone does not prevent Excel from interpreting formula prefixes.
  if (typeof value !== 'number' && /^[\s\uFEFF]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function quoteToCsv(snapshot: BomSnapshot, lines: QuoteLine[]): string {
  const rows: Array<Array<string | number | null | undefined>> = [[
    '설계 ID', '설계 기준', '견적 생성 시각', '부품 종류', '필요 모델', '필요 수량', '규격', '실제 인스턴스',
    '조회 상태', '상품명', '상품 링크', '판매 옵션', '옵션 검증', '후보 분류', '비교 근거',
    '표시 가격', '통화', '묶음당 개수', '구매 묶음 수', '개당 가격', '부품 소계 (KRW)',
    '한국 배송 가능', '배송비 (KRW)', '조회 시각', '확인 사항',
    '구매 링크', '제휴 링크', '가격 기준', '조회 범위',
  ]];
  let subtotal = 0;
  let shipping = 0;
  let confirmed = 0;
  let shippingConfirmed = 0;
  for (const item of snapshot.items) {
    const line = lines.find((candidate) => candidate.item.id === item.id);
    const offer = line?.result?.offers.find((candidate) => candidate.id === line.selectedOfferId);
    const amounts = offer ? calculateOfferAmounts(item, offer) : null;
    if (amounts?.subtotal !== null && amounts?.subtotal !== undefined) {
      subtotal += amounts.subtotal;
      confirmed++;
    }
    if (amounts?.shipping !== null && amounts?.shipping !== undefined) {
      shipping += amounts.shipping;
      shippingConfirmed++;
    }
    rows.push([
      snapshot.designId, snapshot.fingerprint, snapshot.createdAt, kindNames[item.kind], item.model,
      item.quantity, JSON.stringify(item.specs), item.instances.join('; '), line?.result?.status ?? '미조회',
      offer?.title, offer?.url, offer?.optionLabel, offer ? (offer.optionVerified ? '확인' : '미확인') : null,
      offer ? matchNames[offer.match] : null, offer?.reasons.join('; '), offer?.packPrice, offer?.currency,
      offer?.packQuantity, amounts?.packCount, amounts?.unitPrice, amounts?.subtotal,
      offer?.shippingAvailable === true ? '가능' : offer?.shippingAvailable === false ? '불가' : '미확인',
      amounts?.shipping, offer?.retrievedAt ?? line?.result?.retrievedAt,
      [...item.issues, ...line?.result?.warnings ?? []].join('; '),
      offer ? purchaseLink(offer) : null, offer?.promotionUrl ?? null,
      offer ? (offerPriceKind(offer) === 'listing' ? '상품 표시 가격 · 옵션 미확인' : '선택 옵션 가격') : null,
      'AliExpress 제휴 상품 · 한국 조건 · KRW 요청 · 배송/결제액 미확인',
    ]);
  }
  const total = Array<string | number | null>(29).fill('');
  total[3] = '확인된 금액 합계';
  total[20] = confirmed ? Math.round(subtotal * 100) / 100 : null;
  total[22] = shippingConfirmed ? Math.round(shipping * 100) / 100 : null;
  total[24] = `부품 ${confirmed}/${snapshot.items.length}개 항목 · 배송비 ${shippingConfirmed}/${snapshot.items.length}개 항목 확인. 미확인 금액 제외, 최종 결제액 아님. ${snapshot.exclusions.join(' ')}`;
  rows.push(total);
  return `\uFEFF${rows.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}
