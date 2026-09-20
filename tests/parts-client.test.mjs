import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load-typescript.mjs';

const { searchPartQueue, isPartSearchResult, productLink } = await loadTypeScript('lib/parts/client.ts');
const item = (id, model = `motor-${id}`) => ({ id, kind: 'motor', model, quantity: 2, instances: [], specs: {}, issues: [] });
const result = (id) => ({ itemId: id, status: 'ok', offers: [], warnings: [], retrievedAt: '2026-09-13T00:00:00.000Z' });

test('queue runs at most two searches and preserves other results after an item fails', async () => {
  let active = 0, maximum = 0;
  const received = [];
  await searchPartQueue({
    items: [item('a'), item('b'), item('c'), item('d'), item('unknown', '')],
    signal: new AbortController().signal, onStart() {}, onResult(part, value) { received.push([part.id, value.status]); },
    async search(part) {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (part.id === 'b') throw new Error('provider failed');
      return result(part.id);
    },
  });
  assert.equal(maximum, 2);
  assert.deepEqual(received.sort((a, b) => a[0].localeCompare(b[0])), [['a', 'ok'], ['b', 'error'], ['c', 'ok'], ['d', 'ok']]);
});

test('cancelled quote suppresses late replies and never starts queued items', async () => {
  const control = new AbortController();
  const started = [], received = [], complete = [];
  const run = searchPartQueue({ items: [item('a'), item('b'), item('c')], signal: control.signal,
    onStart(part) { started.push(part.id); }, onResult(part) { received.push(part.id); },
    search(part) { return new Promise((resolve) => complete.push(() => resolve(result(part.id)))); },
  });
  assert.deepEqual(started, ['a', 'b']);
  control.abort();
  complete.forEach((resolve) => resolve());
  await run;
  assert.deepEqual(started, ['a', 'b']);
  assert.deepEqual(received, []);
});

test('result guard checks identity, finite prices, and official product URLs', () => {
  assert.equal(isPartSearchResult(result('a'), 'a'), true);
  assert.equal(isPartSearchResult(result('wrong'), 'a'), false);
  const offer = {
    id: '100:200', productId: '100', title: 'Motor', url: 'https://www.aliexpress.com/item/100.html',
    optionId: '200', optionLabel: 'KV400', optionVerified: true, packPrice: 20000, packQuantity: 1, currency: 'KRW',
    match: 'exact', reasons: ['source match'], specs: { motorKv: 400 }, shippingAvailable: null,
    shippingCost: null, shippingCurrency: null, stock: null, retrievedAt: '2026-09-13T00:00:00.000Z',
  };
  assert.equal(isPartSearchResult({ ...result('a'), offers: [offer] }, 'a'), true);
  for (const patch of [{ packPrice: NaN }, { packPrice: '20000' }, { packQuantity: 0 }, { url: 'javascript:alert(1)' }, { url: 'https://aliexpress.com.evil.example/item/100.html' }]) {
    assert.equal(isPartSearchResult({ ...result('a'), offers: [{ ...offer, ...patch }] }, 'a'), false);
  }
  assert.equal(productLink('https://ko.aliexpress.com/item/100.html'), 'https://ko.aliexpress.com/item/100.html');
  assert.equal(productLink('https://user:pass@www.aliexpress.com/item/100.html'), null);
});
