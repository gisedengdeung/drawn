import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load-typescript.mjs';

const {
  acknowledgeQuoteSave, latestProjectQuote, loadQuoteWorkspace, MAX_QUOTE_WORKSPACE_ENTRIES,
  QUOTE_WORKSPACE_KEY, quoteWorkspaceKey, reconcileQuoteEntry, restoreQuoteWorkspace,
  sameQuoteSnapshot, saveQuoteWorkspace, selectQuoteOffer, upsertQuoteEntry,
} = await loadTypeScript('lib/parts/quote-workspace.ts');

const scope = { userId: 'alice', projectId: 'project-a', runId: 'run-1' };
const date = '2026-09-20T00:00:00.000Z';
function quote() {
  const items = ['motor-1', 'motor-2'].map((id) => ({
    id, kind: 'motor', model: 'AT2826 KV900', quantity: 2,
    instances: [id], specs: { motorKv: 900 }, issues: [],
  }));
  const offer = (id) => ({
    id, productId: '123', title: 'AT2826 KV900',
    url: 'https://www.aliexpress.com/item/123.html', optionId: id,
    optionLabel: 'AT2826 KV900 1 pcs', optionVerified: true, packPrice: 20000,
    packQuantity: 1, currency: 'KRW', match: 'exact', reasons: [], specs: { motorKv: 900 },
    shippingAvailable: null, shippingCost: null, shippingCurrency: null,
    stock: 10, retrievedAt: date,
  });
  return {
    snapshot: { fingerprint: '0123456789abcdef', designId: 17297, createdAt: date, items, exclusions: ['제작물 제외'] },
    lines: items.map((item) => ({
      item, result: { itemId: item.id, status: 'ok', offers: [offer('a'), offer('b'), offer('c')], warnings: [], retrievedAt: date },
      selectedOfferId: 'a',
    })),
  };
}
const entry = (override = {}, now = 1) => reconcileQuoteEntry(undefined, { ...scope, ...override }, quote(), now);
const encode = (entries) => JSON.stringify({ version: 1, entries });

test('late canonical quote refresh preserves edited selections and refreshes untouched rows/provider facts', () => {
  const edited = selectQuoteOffer(entry(), 'motor-1', 'b', 2);
  const incoming = quote();
  incoming.lines[0].result.offers[1].packPrice = 21000;
  incoming.lines[1].selectedOfferId = 'c';
  const merged = reconcileQuoteEntry(edited, scope, incoming, 3);
  assert.equal(merged.quote.lines[0].selectedOfferId, 'b');
  assert.equal(merged.quote.lines[0].result.offers[1].packPrice, 21000);
  assert.equal(merged.quote.lines[1].selectedOfferId, 'c');
  assert.deepEqual(merged.dirtyItemIds, ['motor-1']);
  assert.equal(incoming.lines[0].selectedOfferId, 'a');
});

test('explicit deselection survives a delayed saved quote and missing old offers are discarded', () => {
  const deselected = selectQuoteOffer(entry(), 'motor-1', null, 2);
  assert.equal(reconcileQuoteEntry(deselected, scope, quote(), 3).quote.lines[0].selectedOfferId, null);
  const edited = selectQuoteOffer(entry(), 'motor-1', 'b', 2);
  const incoming = quote();
  incoming.lines[0].result.offers = incoming.lines[0].result.offers.filter((offer) => offer.id !== 'b');
  const merged = reconcileQuoteEntry(edited, scope, incoming, 3);
  assert.equal(merged.quote.lines[0].selectedOfferId, 'a');
  assert.deepEqual(merged.dirtyItemIds, []);
});

test('only present offer IDs and BOM lines can be selected', () => {
  const original = entry();
  assert.equal(selectQuoteOffer(original, 'foreign-item', 'b', 2), original);
  assert.equal(selectQuoteOffer(original, 'motor-1', 'foreign-offer', 2), original);
  assert.equal(selectQuoteOffer(original, 'motor-1', 'a', 2), original);
});

test('project/user/run/snapshot identities never share unsaved selections', () => {
  const edited = selectQuoteOffer(entry(), 'motor-1', 'b', 2);
  for (const nextScope of [
    { ...scope, userId: 'bob' }, { ...scope, projectId: 'project-b' }, { ...scope, runId: 'run-2' },
  ]) {
    const next = reconcileQuoteEntry(edited, nextScope, quote(), 3);
    assert.equal(next.quote.lines[0].selectedOfferId, 'a');
    assert.deepEqual(next.dirtyItemIds, []);
    assert.notEqual(quoteWorkspaceKey(nextScope, next.quote.snapshot), quoteWorkspaceKey(scope, edited.quote.snapshot));
  }
  for (const patch of [{ designId: 1985 }, { fingerprint: 'fedcba9876543210' }, { createdAt: '2026-09-20T01:00:00.000Z' }]) {
    const incoming = quote();
    Object.assign(incoming.snapshot, patch);
    assert.equal(sameQuoteSnapshot(edited.quote.snapshot, incoming.snapshot), false);
    assert.equal(reconcileQuoteEntry(edited, scope, incoming, 3).quote.lines[0].selectedOfferId, 'a');
  }
});

test('history switching and reload retain per-run edits with latest quote limited to current project', () => {
  let entries = upsertQuoteEntry([], selectQuoteOffer(entry(), 'motor-1', 'b', 2));
  entries = upsertQuoteEntry(entries, selectQuoteOffer(entry({ runId: 'run-2' }), 'motor-1', 'c', 3));
  entries = upsertQuoteEntry(entries, entry({ userId: 'bob' }, 9));
  entries = upsertQuoteEntry(entries, entry({ projectId: 'project-b' }, 10));
  const restored = restoreQuoteWorkspace(encode(entries));
  assert.equal(latestProjectQuote(restored, 'alice', 'project-a').quote.lines[0].selectedOfferId, 'c');
  assert.equal(latestProjectQuote(restored, null, 'project-a'), undefined);
  assert.equal(latestProjectQuote(restored, 'alice', null), undefined);
  assert.equal(latestProjectQuote(restored, 'charlie', 'project-a'), undefined);
  const prior = restored.find((candidate) => candidate.userId === 'alice' && candidate.projectId === 'project-a' && candidate.runId === 'run-1');
  assert.equal(reconcileQuoteEntry(prior, scope, quote(), 11).quote.lines[0].selectedOfferId, 'b');
});

test('successful save acknowledges only submitted edits and preserves edits made during save', () => {
  const selected = selectQuoteOffer(entry(), 'motor-1', 'b', 2);
  const changedDuringSave = selectQuoteOffer(selected, 'motor-1', 'c', 3);
  assert.deepEqual(acknowledgeQuoteSave(selected, selected.quote).dirtyItemIds, []);
  assert.deepEqual(acknowledgeQuoteSave(changedDuringSave, selected.quote).dirtyItemIds, ['motor-1']);
  const incoming = quote();
  incoming.snapshot.createdAt = '2026-09-20T01:00:00.000Z';
  assert.equal(acknowledgeQuoteSave(selected, incoming), selected);
});

test('cache restoration rejects invalid provider data, malicious links and unknown selections', () => {
  const healthy = entry({ runId: 'healthy' });
  for (const mutate of [
    (value) => { value.quote.lines[0].result.offers[0].url = 'javascript:alert(1)'; },
    (value) => { value.quote.lines[0].selectedOfferId = 'foreign'; },
    (value) => { value.quote.snapshot.designId = 0; },
    (value) => { value.quote.lines[0].result.offers[0].packPrice = 'free'; },
    (value) => { value.quote.lines[0].item = { ...value.quote.lines[0].item, quantity: 99 }; },
    (value) => { value.quote = undefined; },
    (value) => { value.dirtyItemIds = ['foreign']; },
    (value) => { value.userId = ''; },
    (value) => { value.projectId = null; },
    (value) => { value.runId = 1; },
    (value) => { value.updatedAt = -1; },
    (value) => { value.updatedAt = 1.5; },
  ]) {
    const invalid = entry();
    mutate(invalid);
    assert.deepEqual(restoreQuoteWorkspace(encode([invalid, healthy])), [healthy]);
  }
  for (const text of ['{', '{}', 'null', '[]', ' '.repeat(2_000_001), JSON.stringify({ version: 2, entries: [healthy] })]) {
    assert.deepEqual(restoreQuoteWorkspace(text), []);
  }
});

test('cache bounds entries, keeps the newest duplicate and isolates identifiers without delimiter collisions', () => {
  let entries = [];
  for (let index = 0; index < 30; index++) entries = upsertQuoteEntry(entries, entry({ runId: 'run-' + index }, index));
  assert.equal(entries.length, MAX_QUOTE_WORKSPACE_ENTRIES);
  assert.equal(entries[0].runId, 'run-29');
  const older = selectQuoteOffer(entry(), 'motor-1', 'b', 2);
  const newer = selectQuoteOffer(entry(), 'motor-1', 'c', 3);
  for (const duplicates of [[newer, older], [older, newer]]) {
    const restored = restoreQuoteWorkspace(encode(duplicates));
    assert.equal(restored.length, 1);
    assert.equal(restored[0].quote.lines[0].selectedOfferId, 'c');
  }
  assert.notEqual(
    quoteWorkspaceKey({ userId: 'a:b', projectId: 'c', runId: 'd' }, quote().snapshot),
    quoteWorkspaceKey({ userId: 'a', projectId: 'b:c', runId: 'd' }, quote().snapshot),
  );
  assert.deepEqual(restoreQuoteWorkspace(encode(Array(13).fill(entry()))), []);
});

test('storage failures are nonfatal and scoped persistence never overwrites legacy quote keys', () => {
  const values = new Map([['drawn.parts-quote.v1', 'legacy'], ['aerotwin.parts-quote.v1', 'old-legacy']]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const selected = selectQuoteOffer(entry(), 'motor-1', 'b', 2);
  assert.equal(saveQuoteWorkspace(storage, [selected]), true);
  assert.deepEqual(loadQuoteWorkspace(storage), [selected]);
  assert.equal(values.get('drawn.parts-quote.v1'), 'legacy');
  assert.equal(values.get('aerotwin.parts-quote.v1'), 'old-legacy');
  assert.ok(values.has(QUOTE_WORKSPACE_KEY));
  assert.equal(saveQuoteWorkspace({ setItem() { throw Error('Quota exceeded'); } }, [selected]), false);
  assert.deepEqual(loadQuoteWorkspace({ getItem() { throw Error('Disabled'); } }), []);
});

test('persisted cache is size-bounded by evicting older quote copies', () => {
  const values = new Map();
  const entries = [];
  for (let index = 0; index < 12; index++) {
    const large = entry({ runId: 'large-' + index }, index);
    large.quote.snapshot.exclusions = Array(20).fill('x'.repeat(1000));
    for (const line of large.quote.lines) {
      line.result.offers[0].title = 'x'.repeat(300);
      line.result.warnings = Array(20).fill('x'.repeat(5000));
    }
    entries.push(large);
  }
  assert.equal(saveQuoteWorkspace({ setItem: (key, value) => values.set(key, value) }, entries), true);
  assert.ok(values.get(QUOTE_WORKSPACE_KEY).length <= 2_000_000);
  const stored = JSON.parse(values.get(QUOTE_WORKSPACE_KEY));
  assert.ok(stored.entries.length < entries.length);
  assert.equal(stored.entries[0].runId, 'large-11');
  assert.equal(restoreQuoteWorkspace(values.get(QUOTE_WORKSPACE_KEY)).length, stored.entries.length);
});