import type { BomSnapshot, QuoteLine } from './types';
import { calculateOfferAmounts } from './pricing';

/** The purchase table and totals use the frozen BOM and each row's selected offer. */
export function buildPurchaseSummary(snapshot: BomSnapshot, lines: QuoteLine[]) {
  const rows = snapshot.items.map((item) => {
    const line = lines.find((entry) => entry.item.id === item.id);
    const result = line?.result ?? null;
    const offer = result?.offers.find((entry) => entry.id === line?.selectedOfferId) ?? null;
    return { item, result, offer, amounts: offer ? calculateOfferAmounts(item, offer) : null };
  });
  const confirmed = rows.filter((row) => row.amounts?.subtotal != null);
  const shippingConfirmed = confirmed.filter((row) => row.amounts?.shipping != null);
  const sum = (values: number[]) => Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;
  return {
    rows,
    selectedCount: rows.filter((row) => row.offer).length,
    confirmedCount: confirmed.length,
    shippingConfirmedCount: shippingConfirmed.length,
    subtotal: confirmed.length ? sum(confirmed.map((row) => row.amounts!.subtotal!)) : null,
    shipping: shippingConfirmed.length ? sum(shippingConfirmed.map((row) => row.amounts!.shipping!)) : null,
  };
}
