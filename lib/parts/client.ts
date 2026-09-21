import type { BomItem, PartSearchResult, ProductOffer } from './types';
import { affiliatePromotionLink, canonicalProductLink } from './links';

const statuses = new Set(['ok', 'not_found', 'not_configured', 'permission_denied', 'rate_limited', 'error']);
const matches = new Set(['exact', 'alternative', 'needs_review']);
const money = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
const nullableString = (value: unknown) => value === null || typeof value === 'string';

export function productLink(url: string) {
  return canonicalProductLink(url);
}

export function purchaseLink(offer: ProductOffer) {
  return affiliatePromotionLink(offer.promotionUrl, offer.productId) ?? canonicalProductLink(offer.url, offer.productId);
}

export function isPartSearchResult(value: unknown, itemId: string): value is PartSearchResult {
  if (!value || typeof value !== 'object') return false;
  const data = value as PartSearchResult;
  return data.itemId === itemId && statuses.has(data.status)
    && Array.isArray(data.warnings) && data.warnings.every((entry) => typeof entry === 'string')
    && typeof data.retrievedAt === 'string' && Array.isArray(data.offers) && data.offers.length <= 3
    && data.offers.every((offer) => offer && typeof offer.id === 'string' && typeof offer.productId === 'string'
      && typeof offer.title === 'string' && typeof offer.url === 'string' && canonicalProductLink(offer.url, offer.productId) !== null
      && (offer.promotionUrl === undefined || offer.promotionUrl === null || affiliatePromotionLink(offer.promotionUrl, offer.productId) !== null)
      && (offer.priceKind === undefined || offer.priceKind === 'listing' || offer.priceKind === 'sku')
      && (offer.provider === undefined || offer.provider === 'aliexpress_affiliate' || offer.provider === 'aliexpress_ds')
      && (offer.market === undefined || (offer.market?.country === 'KR' && offer.market.currencyRequested === 'KRW'))
      && !(offer.priceKind === 'listing' && offer.optionVerified)
      && typeof offer.optionVerified === 'boolean' && nullableString(offer.optionId) && nullableString(offer.optionLabel)
      && money(offer.packPrice) && (offer.packQuantity === null || (Number.isSafeInteger(offer.packQuantity) && offer.packQuantity > 0))
      && typeof offer.currency === 'string' && matches.has(offer.match) && Array.isArray(offer.reasons)
      && offer.reasons.every((reason) => typeof reason === 'string') && offer.specs && typeof offer.specs === 'object'
      && Object.values(offer.specs).every((spec) => typeof spec === 'number' && Number.isFinite(spec) && spec > 0)
      && (offer.shippingAvailable === null || typeof offer.shippingAvailable === 'boolean')
      && money(offer.shippingCost) && nullableString(offer.shippingCurrency) && money(offer.stock)
      && typeof offer.retrievedAt === 'string');
}

async function fetchPart(item: BomItem, signal: AbortSignal): Promise<PartSearchResult> {
  const response = await fetch('/api/parts/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item, country: 'KR', currency: 'KRW' }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
  });
  const value: unknown = await response.json();
  if (!isPartSearchResult(value, item.id)) throw new Error('Invalid parts response');
  return value;
}

/** Bounded queue; a failed item never discards results from other items. */
export async function searchPartQueue({ items, signal, onStart, onResult, search = fetchPart }: {
  items: BomItem[];
  signal: AbortSignal;
  onStart: (item: BomItem) => void;
  onResult: (item: BomItem, result: PartSearchResult) => void;
  search?: (item: BomItem, signal: AbortSignal) => Promise<PartSearchResult>;
}) {
  const queue = items.filter((item) => item.model.trim());
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length && !signal.aborted) {
      const item = queue[cursor++];
      onStart(item);
      let result: PartSearchResult;
      try { result = await search(item, signal); }
      catch (error) {
        if (signal.aborted) return;
        result = { itemId: item.id, status: 'error', offers: [], warnings: [error instanceof Error && error.name === 'TimeoutError'
          ? '조회 시간이 초과되었습니다. 이 부품만 다시 검색할 수 있습니다.'
          : '상품 조회에 연결하지 못했습니다. 잠시 후 다시 검색해 주세요.'], retrievedAt: new Date().toISOString() };
      }
      if (!signal.aborted) onResult(item, result);
    }
  }
  await Promise.all([worker(), worker()]);
}
