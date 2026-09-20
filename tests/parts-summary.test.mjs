import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTypeScript } from './helpers/load-typescript.mjs';

const { buildPurchaseSummary } = await loadTypeScript('lib/parts/summary.ts');
const { quoteToCsv } = await loadTypeScript('lib/parts/csv.ts');
const { hydrateDraft, cloneDraft } = await loadTypeScript('lib/design-draft.ts');
const { createBomSnapshot } = await loadTypeScript('lib/parts/bom.ts');

function quote() {
  const item = { id: 'motor:test', kind: 'motor', model: 'Motor KV450', quantity: 5,
    instances: ['m1', 'm2', 'm3', 'm4', 'm5'], specs: { motorKv: 450 }, issues: [] };
  const offer = { id: 'offer-1', productId: '1005001234', title: 'Motor KV450',
    url: 'https://www.aliexpress.com/item/1005001234.html', optionId: '450', optionLabel: 'KV450 / 2 pcs',
    optionVerified: true, packPrice: 12000, packQuantity: 2, currency: 'KRW', match: 'exact', reasons: [],
    specs: { motorKv: 450 }, shippingAvailable: true, shippingCost: null, shippingCurrency: null,
    stock: 8, retrievedAt: '2026-09-13T00:00:00.000Z' };
  const snapshot = { fingerprint: '0123456789abcdef', designId: 2, createdAt: offer.retrievedAt, items: [item], exclusions: [] };
  const lines = [{ item: structuredClone(item), result: { itemId: item.id, status: 'ok', offers: [offer], warnings: [], retrievedAt: offer.retrievedAt }, selectedOfferId: offer.id }];
  return { snapshot, lines, offer };
}

test('purchase table uses frozen quantities, bundle rounding and the same selected prices as CSV', () => {
  const { snapshot, lines } = quote();
  lines[0].item.quantity = 999;
  const summary = buildPurchaseSummary(snapshot, lines);
  assert.equal(summary.rows[0].item, snapshot.items[0]);
  assert.equal(summary.rows[0].amounts.packCount, 3);
  assert.equal(summary.subtotal, 36000);
  assert.equal(summary.shipping, null);
  assert.equal(summary.confirmedCount, 1);
  assert.match(quoteToCsv(snapshot, lines), /"3","6000","36000"/);
});

test('changing the selection includes only that candidate and keeps unverified amounts unknown', () => {
  const { snapshot, lines, offer } = quote();
  const alternative = { ...offer, id: 'offer-2', match: 'alternative', packPrice: 9000, packQuantity: 1, shippingCost: 0, shippingCurrency: 'KRW' };
  lines[0].result.offers.push(alternative);
  lines[0].selectedOfferId = alternative.id;
  let summary = buildPurchaseSummary(snapshot, lines);
  assert.equal(summary.selectedCount, 1);
  assert.equal(summary.subtotal, 45000);
  assert.equal(summary.shipping, 0);
  alternative.optionVerified = false;
  summary = buildPurchaseSummary(snapshot, lines);
  assert.equal(summary.selectedCount, 1);
  assert.equal(summary.confirmedCount, 0);
  assert.equal(summary.subtotal, null);
  assert.equal(summary.shipping, null);
});

test('a BOM before search or with no selection has no fabricated zero totals', () => {
  const { snapshot, lines } = quote();
  lines[0].selectedOfferId = null;
  for (const candidates of [[], lines]) {
    const summary = buildPurchaseSummary(snapshot, candidates);
    assert.equal(summary.rows.length, 1);
    assert.equal(summary.selectedCount, 0);
    assert.equal(summary.subtotal, null);
    assert.equal(summary.shipping, null);
  }
});

test('shared draft hydration preserves physical BOM and baseline when the editor changes a clone', () => {
  const shard = JSON.parse(readFileSync(new URL('../public/data/design-trees/shard-000.json', import.meta.url), 'utf8'));
  const source = shard['2'];
  const baseline = hydrateDraft(source);
  const draft = cloneDraft(baseline);
  assert.deepEqual(baseline.physicalComponents, source.physicalComponents);
  assert.equal(baseline.parameterDefinitions.length, source.sourceParameters.length);
  const original = baseline.propulsionGroups[1].motorType;
  draft.propulsionGroups[1].motorType = 't_motor_AT4120KV560';
  assert.equal(baseline.propulsionGroups[1].motorType, original);
  const bom = createBomSnapshot(draft);
  assert.ok(bom.items.some((item) => item.model === 't_motor_AT4120KV560'));
  assert.equal(bom.items.filter((item) => item.kind === 'battery').reduce((sum, item) => sum + item.quantity, 0), 2);
});
