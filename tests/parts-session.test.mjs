import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load-typescript.mjs';

const { restoreQuote } = await loadTypeScript('lib/parts/session.ts');
const { quoteToCsv } = await loadTypeScript('lib/parts/csv.ts');

function savedQuote() {
  const item = {
    id: 'motor:0123456789abcdef', kind: 'motor', model: 'AT2826 KV900', quantity: 2,
    instances: ['motor-1', 'motor-2'], specs: { motorKv: 900 }, issues: [],
  };
  const offer = {
    id: '123:sku1', productId: '123', title: 'AT2826 KV900',
    url: 'https://www.aliexpress.com/item/123.html', optionId: 'sku1',
    optionLabel: 'AT2826 KV900 1 pcs', optionVerified: true, packPrice: 20000,
    packQuantity: 1, currency: 'KRW', match: 'exact', reasons: [], specs: { motorKv: 900 },
    shippingAvailable: null, shippingCost: null, shippingCurrency: null,
    stock: 10, retrievedAt: '2026-09-13T00:00:00.000Z',
  };
  return {
    snapshot: {
      fingerprint: '0123456789abcdef', designId: 17297,
      createdAt: '2026-09-13T00:00:00.000Z', items: [structuredClone(item)], exclusions: ['제작물 제외'],
    },
    lines: [{ item, result: { itemId: item.id, status: 'ok', offers: [offer], warnings: [], retrievedAt: offer.retrievedAt }, selectedOfferId: offer.id }],
  };
}

const restore = (value) => restoreQuote(JSON.stringify(value));

test('restores a valid quote and uses canonical snapshot items for UI and CSV', () => {
  const saved = savedQuote();
  const result = restore(saved);
  assert.deepEqual(result, saved);
  assert.equal(result.lines[0].item, result.snapshot.items[0]);
  assert.match(quoteToCsv(result.snapshot, result.lines), /40000/);
});

test('rejects missing snapshot instances even when the parallel line item is valid', () => {
  const saved = savedQuote();
  delete saved.snapshot.items[0].instances;
  assert.equal(restore(saved), null);
});

test('rejects missing, invalid and impossible dates before download or CSV can use them', () => {
  for (const date of [undefined, null, 0, 'invalid', '2026-02-30T00:00:00.000Z', '2026-13-01T00:00:00.000Z', '2026-09-13T24:00:00.000Z']) {
    const saved = savedQuote();
    saved.snapshot.createdAt = date;
    assert.equal(restore(saved), null, `date ${date}`);
  }
  const saved = savedQuote();
  saved.snapshot.createdAt = '2024-02-29T09:00:00+09:00';
  assert.ok(restore(saved));
});

test('rejects malformed and oversized saved payloads and invalid snapshot identity', () => {
  for (const text of ['{', 'null', '[]', 'true', ' '.repeat(1_000_001)]) assert.equal(restoreQuote(text), null);
  for (const fields of [{ fingerprint: '' }, { fingerprint: 'not-a-fingerprint' }, { designId: 0 }, { designId: 1.5 }, { designId: Number.MAX_SAFE_INTEGER + 1 }, { exclusions: [null] }]) {
    const saved = savedQuote();
    Object.assign(saved.snapshot, fields);
    assert.equal(restore(saved), null);
  }
});

test('rejects invalid BOM field types, values and limits', () => {
  const invalid = [
    { id: '' }, { kind: 'frame' }, { model: 123 }, { model: 'x'.repeat(241) },
    { quantity: 0 }, { quantity: 0.5 }, { quantity: 1001 }, { quantity: undefined },
    { instances: [null] }, { instances: ['x'.repeat(161)] }, { issues: [null] },
    { issues: ['x'.repeat(301)] }, { specs: [] }, { specs: { surprise: 1 } },
    { specs: { motorKv: 0 } }, { specs: { motorKv: -1 } }, { specs: { motorKv: '900' } },
    { specs: { motorKv: 1_000_001 } }, { specs: { cells: 2.5 } }, { specs: { cells: 25 } },
  ];
  for (const fields of invalid) {
    const saved = savedQuote();
    Object.assign(saved.snapshot.items[0], fields);
    assert.equal(restore(saved), null, JSON.stringify(fields));
  }
  assert.equal(restoreQuote(JSON.stringify(savedQuote()).replace('"motorKv":900', '"motorKv":1e999')), null);
});

test('rejects lines from a different source item even if their IDs match', () => {
  for (const fields of [
    { kind: 'propeller' }, { model: 'AT3520 KV900' }, { quantity: 4 },
    { instances: ['other-motor'] }, { specs: { motorKv: 1000 } }, { issues: ['different source'] },
  ]) {
    const saved = savedQuote();
    Object.assign(saved.lines[0].item, fields);
    assert.equal(restore(saved), null, JSON.stringify(fields));
  }
});

test('rejects duplicate IDs, missing lines, foreign lines and oversized item lists', () => {
  let saved = savedQuote();
  saved.snapshot.items.push(structuredClone(saved.snapshot.items[0]));
  saved.lines.push(structuredClone(saved.lines[0]));
  assert.equal(restore(saved), null);
  saved = savedQuote();
  saved.lines = [];
  assert.equal(restore(saved), null);
  saved = savedQuote();
  saved.lines[0].item.id = 'other';
  assert.equal(restore(saved), null);
  saved = savedQuote();
  saved.snapshot.items = Array(101).fill(saved.snapshot.items[0]);
  saved.lines = Array(101).fill(saved.lines[0]);
  assert.equal(restore(saved), null);
  saved = savedQuote();
  saved.snapshot.items.push({ ...saved.snapshot.items[0], id: 'other' });
  saved.lines.push(structuredClone(saved.lines[0]));
  assert.equal(restore(saved), null);
});

test('validates responses and permits only selected offers present on the line', () => {
  let saved = savedQuote();
  saved.lines[0].result.itemId = 'other';
  assert.equal(restore(saved), null);
  saved = savedQuote();
  saved.lines[0].result.offers[0].url = 'javascript:alert(1)';
  assert.equal(restore(saved), null);
  for (const selected of ['missing', undefined, 3]) {
    saved = savedQuote();
    saved.lines[0].selectedOfferId = selected;
    assert.equal(restore(saved), null);
  }
  saved = savedQuote();
  saved.lines[0].result = null;
  assert.equal(restore(saved), null);
  saved.lines[0].selectedOfferId = null;
  assert.ok(restore(saved));
});

test('normalizes line ordering to the snapshot while retaining each selection', () => {
  const saved = savedQuote();
  const second = { ...structuredClone(saved.snapshot.items[0]), id: 'second', model: '', quantity: null, instances: [] };
  saved.snapshot.items.push(second);
  saved.lines.unshift({ item: structuredClone(second), result: null, selectedOfferId: null });
  const result = restore(saved);
  assert.ok(result);
  assert.equal(result.lines[0].selectedOfferId, '123:sku1');
  assert.equal(result.lines[1].item, result.snapshot.items[1]);
});

test('compares specifications independent of object key order and permits an empty quote', () => {
  const saved = savedQuote();
  saved.snapshot.items[0].specs = { motorKv: 900, voltage: 12 };
  saved.lines[0].item.specs = { voltage: 12, motorKv: 900 };
  assert.ok(restore(saved));
  saved.snapshot.items = [];
  saved.lines = [];
  assert.ok(restore(saved));
});
