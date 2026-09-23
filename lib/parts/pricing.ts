import type { BomItem, OfferAmounts, ProductOffer } from './types';

function positiveInteger(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

function money(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

/** Older saved quotes infer the display label without changing their existing verification. */
export function offerPriceKind(offer: ProductOffer): 'listing' | 'sku' {
  return offer.priceKind ?? (offer.optionId ? 'sku' : 'listing');
}

/** Stock and shippingCost are expressed for SKU packs and this line's order. */
export function calculateOfferAmounts(item: BomItem, offer: ProductOffer): OfferAmounts {
  const unknown: OfferAmounts = { packCount: null, unitPrice: null, subtotal: null, shipping: null };
  const specConflict = (Object.keys(item.specs) as Array<keyof BomItem['specs']>).some((key) => {
    const required = item.specs[key];
    const offered = offer.specs[key];
    return required !== undefined && offered !== undefined && Math.abs(required - offered) > 0.00001;
  });
  if (!positiveInteger(item.quantity) || !positiveInteger(offer.packQuantity)
    || offer.priceKind === 'listing' || !offer.optionVerified || !money(offer.packPrice) || offer.packPrice <= 0
    || offer.currency !== 'KRW' || offer.shippingAvailable === false || specConflict) return unknown;
  const packCount = Math.ceil(item.quantity / offer.packQuantity);
  if (offer.stock !== null && (!Number.isSafeInteger(offer.stock) || offer.stock < packCount)) return unknown;
  const subtotal = Math.round(packCount * offer.packPrice * 100) / 100;
  if (!Number.isFinite(subtotal) || subtotal > Number.MAX_SAFE_INTEGER) return unknown;
  return {
    packCount,
    unitPrice: offer.packPrice / offer.packQuantity,
    subtotal,
    shipping: offer.shippingAvailable === true && offer.shippingCurrency === 'KRW' && money(offer.shippingCost) ? offer.shippingCost : null,
  };
}
