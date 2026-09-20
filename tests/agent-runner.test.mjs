import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { SQLiteD1Database } from './helpers/d1.mjs';
import { loadTypeScript } from './helpers/load-typescript.mjs';

const { executeRun } = await loadTypeScript('lib/agent/server/runner.ts');
const store = await loadTypeScript('lib/agent/server/store.ts');
const { hydrateDraft } = await loadTypeScript('lib/design-draft.ts');
const { createBomSnapshot } = await loadTypeScript('lib/parts/bom.ts');
const { calculateOfferAmounts } = await loadTypeScript('lib/parts/pricing.ts');
const { applyDraftChanges } = await loadTypeScript('lib/agent/optimization.ts');
const { estimateDraft } = await loadTypeScript('lib/design-performance.ts');
const callback = await loadTypeScript('app/api/integrations/aliexpress/callback/route.ts');
const index = JSON.parse(readFileSync(new URL('../public/data/design-index.json', import.meta.url), 'utf8'));
const shard = JSON.parse(readFileSync(new URL('../public/data/design-trees/shard-000.json', import.meta.url), 'utf8'));
const baseline = hydrateDraft(shard['1']);
const selected = index.designs.find(design => design.id === 1);
const intent = { objective: 'power', massLimit: null, powerLimit: null, topologyLocked: true, speed: null, compareCost: false };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const response = (value, status = 'completed') => json({ id: 'resp_test', object: 'response', created_at: 1, status,
  output: [{ id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }] }] });
const providerReply = (method, value) => json({ [method.replaceAll('.', '_') + '_response']: { resp_result: { resp_code: 200, result: value } } });

async function fixture(t, options = {}) {
  const db = new SQLiteD1Database();
  t.after(() => db.close());
  const assets = [], requests = [], unexpected = [];
  const network = t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const request = { url, init, body: url.startsWith('https://api.openai.com/') ? JSON.parse(init.body) : new URLSearchParams(init.body) };
    requests.push(request);
    if (url === 'https://api.openai.com/v1/responses' && options.model) return options.model(request.body, requests);
    if (url.startsWith('https://eco.taobao.com/router/rest') && options.provider) return options.provider(request.body, requests);
    unexpected.push(url);
    throw new Error('Unmocked network request blocked');
  });
  t.after(() => assert.deepEqual(unexpected, [], 'all external calls must use explicit local mocks'));
  const env = { APP_BASE_URL: 'https://drawn.test', OPENAI_API_KEY: '', AGENT_OPENAI_MODEL: '', PARTS_OPENAI_MODEL: '',
    ALIEXPRESS_APP_KEY: '', ALIEXPRESS_APP_SECRET: '', ALIEXPRESS_TRACKING_ID: '', ALIEXPRESS_ACCESS_TOKEN: '', ALIEXPRESS_DS_ENABLED: '', ALIEXPRESS_TOP_REGION: '',
    ...options.env,
    ASSETS: { fetch: async request => {
      const path = new URL(request.url).pathname;
      assets.push(path);
      if (path === '/data/design-index.json') return json(index);
      if (path === '/data/design-trees/shard-000.json') return json(shard);
      if (path === '/data/showcase-designs.json') return json(options.showcases ?? {});
      throw new Error('Unexpected dataset asset: ' + path);
    } },
  };
  const project = await store.createProject(db, 'alice', 'Runner fixture', structuredClone(options.draft ?? baseline), null);
  const runId = await store.startRun(db, 'alice', project, options.mode ?? 'parts', 'Fixture request');
  const events = [], controller = new AbortController();
  const execute = (overrides = {}) => executeRun({ db, env, userId: 'alice', runId, project, mode: options.mode ?? 'parts',
    message: options.message ?? '현재 설계 설명', locks: [], signal: controller.signal, emit: event => events.push(event), ...overrides });
  const runRow = () => db.prepare('SELECT * FROM agent_runs WHERE id=?').bind(runId).first();
  return { db, env, project, runId, events, controller, execute, runRow, assets, requests, network };
}

function groundedModel(overrides = {}) {
  return body => {
    assert.equal(body.store, false);
    assert.equal(body.tools, undefined);
    assert.equal(body.max_output_tokens, 1800);
    assert.match(body.instructions, /untrusted data/);
    if (body.text.format.name === 'design_intent') return response({ ...intent, ...overrides.intent });
    assert.equal(body.text.format.name, 'grounded_answer');
    const data = JSON.parse(body.input);
    return response(overrides.answer ?? { answer: '제공된 기준 설계를 확인했습니다. [e1]', evidenceIds: [data.evidence[0].id] }, overrides.status);
  };
}

function affiliateMock() {
  const products = new Map();
  return params => {
    const method = params.get('method');
    assert.equal(params.get('session'), null, 'Affiliates default must not use seller credentials');
    if (method === 'aliexpress.affiliate.product.query') {
      const id = String(1005001000000 + products.size);
      const product = { product_id: id, product_detail_url: `https://www.aliexpress.com/item/${id}.html`,
        product_title: params.get('keywords') + ' 1pc', target_sale_price: String(10000 + products.size), target_sale_price_currency: 'KRW' };
      products.set(id, product);
      return providerReply(method, { products: { product: [product] } });
    }
    if (method === 'aliexpress.affiliate.productdetail.get') return providerReply(method, { products: { product: params.get('product_ids').split(',').map(id => products.get(id)) } });
    assert.equal(method, 'aliexpress.affiliate.link.generate');
    return providerReply(method, { tracking_id: 'drawn-test', promotion_links: { promotion_link: params.get('source_values').split(',').map(source => ({
      source_value: source, promotion_link: 'https://s.click.aliexpress.com/e/_Drawn' + source.match(/item\/(\d+)/)[1],
    })) } });
  };
}

test('parts run without provider configuration preserves canonical BOM and checkpoint without inventing prices', async t => {
  const f = await fixture(t);
  const result = await f.execute();
  assert.equal(f.network.mock.callCount(), 0);
  assert.deepEqual(result.quote.snapshot.items, createBomSnapshot(f.project.draft).items);
  assert.equal(result.quote.snapshot.fingerprint, f.project.fingerprint);
  assert.equal(result.quote.snapshot.designId, 1);
  assert.ok(result.quote.snapshot.exclusions.length);
  assert.ok(result.quote.lines.length > 0);
  assert.ok(result.quote.lines.every(line => line.result.status === 'not_configured' && line.result.offers.length === 0 && line.selectedOfferId === null));
  const original = JSON.parse(result.evidence.find(entry => entry.title === '기준 설계 #1').text);
  assert.equal(original.massKg, selected.mass);
  assert.equal(original.rangeM, selected.maxDistance);
  assert.equal(original.powerW, selected.power);
  assert.match(result.context.datasetVersion, /^aircraftverse-[a-f0-9]{16}$/);
  const saved = JSON.parse((await f.runRow()).result_json);
  assert.deepEqual(saved.quote, result.quote);
  assert.equal((await f.runRow()).llm_calls, 0);
  assert.equal((await f.runRow()).provider_calls, 0);
  assert.ok(result.warnings.some(warning => warning.includes('설정이 필요')));
});

test('parts run uses Affiliates search/detail/link with shared accounting and never nested OpenAI or confirmed listing totals', async t => {
  const f = await fixture(t, { provider: affiliateMock(), env: { ALIEXPRESS_APP_KEY: 'test-app', ALIEXPRESS_APP_SECRET: 'test-secret', ALIEXPRESS_TRACKING_ID: 'drawn-test', OPENAI_API_KEY: 'test-openai' } });
  const result = await f.execute();
  assert.ok(result.quote.lines.every(line => line.result.status === 'ok' && line.result.offers.length === 1));
  for (const line of result.quote.lines) {
    const offer = line.result.offers[0];
    assert.equal(offer.priceKind, 'listing');
    assert.equal(offer.provider, 'aliexpress_affiliate');
    assert.equal(offer.optionVerified, false);
    assert.equal(offer.url, `https://www.aliexpress.com/item/${offer.productId}.html`);
    if (offer.promotionUrl) assert.equal(offer.promotionUrl, `https://s.click.aliexpress.com/e/_Drawn${offer.productId}`);
    else assert.ok(line.result.warnings.length, 'a capped promotion lookup must retain its reason and canonical URL');
    assert.equal(line.selectedOfferId, null);
    assert.equal(calculateOfferAmounts(line.item, offer).subtotal, null);
  }
  const row = await f.runRow();
  assert.equal(row.llm_calls, 0);
  assert.equal(row.provider_calls, Math.min(result.quote.lines.length * 3, store.limits.provider));
  assert.ok(result.quote.lines.some(line => line.result.offers[0].promotionUrl));
  assert.equal(f.network.mock.callCount(), row.provider_calls);
  assert.ok(f.requests.every(request => !request.url.includes('api.openai.com')));
  assert.deepEqual(result.quote.snapshot.items, createBomSnapshot(f.project.draft).items);
});

test('provider retry budget is shared across rows and exhaustion cannot send a forty-first request', async t => {
  const f = await fixture(t, { provider: () => json({ private: 'upstream-secret' }, 503), env: { ALIEXPRESS_APP_KEY: 'test-app', ALIEXPRESS_APP_SECRET: 'test-secret' } });
  await f.db.prepare('UPDATE agent_runs SET provider_calls=? WHERE id=?').bind(store.limits.provider - 1, f.runId).run();
  const result = await f.execute();
  assert.equal(f.network.mock.callCount(), 1);
  assert.equal((await f.runRow()).provider_calls, store.limits.provider);
  assert.ok(result.quote.lines.every(line => line.result.offers.length === 0));
  assert.ok(result.quote.lines.some(line => line.result.status === 'rate_limited'));
  assert.ok(result.warnings.some(warning => warning.includes('완료하지 못')));
  assert.ok(!JSON.stringify(result).includes('upstream-secret'));
  assert.deepEqual(JSON.parse((await f.runRow()).result_json).quote, result.quote);
});

test('QA does not substitute another design trim and supplies authoritative evidence to the real model parser', async t => {
  const f = await fixture(t, { mode: 'qa', message: '20 m/s trim 설명', env: { OPENAI_API_KEY: 'test-openai' },
    model: groundedModel({ intent: { speed: 20 } }), showcases: { '2': { trim: [{ speed: 20, power: 987654321 }] } } });
  const result = await f.execute();
  const trim = result.evidence.find(entry => entry.kind === 'dataset-trim');
  assert.ok(trim);
  assert.equal(trim.target.designId, 1);
  assert.match(trim.text, /공개 원본 trim이 없습니다/);
  assert.ok(!JSON.stringify(result).includes('987654321'));
  const explanation = JSON.parse(f.requests.find(request => request.body.text?.format.name === 'grounded_answer').body.input);
  assert.deepEqual(explanation.evidence, result.evidence);
  assert.equal(JSON.parse(explanation.evidence[0].text).powerW, selected.power);
  assert.equal(result.answer, '제공된 기준 설계를 확인했습니다. [e1]');
  assert.equal((await f.runRow()).llm_calls, 2);
  assert.equal((await f.runRow()).provider_calls, 0);
  assert.deepEqual(result.proposals, []);
});

test('unknown model evidence IDs are not accepted as a grounded answer', async t => {
  const f = await fixture(t, { mode: 'qa', env: { OPENAI_API_KEY: 'test-openai' },
    model: groundedModel({ answer: { answer: 'Invented guaranteed value 999999 [e999]', evidenceIds: ['e999'] } }) });
  const result = await f.execute();
  assert.ok(!result.answer.includes('999999'));
  assert.match(result.answer, /근거를 확인하지 못/);
  assert.ok(result.evidence.length > 0);
});

test('LLM budget can stop explanation after intent while keeping computed evidence and no extra network call', async t => {
  const f = await fixture(t, { mode: 'qa', env: { OPENAI_API_KEY: 'test-openai' }, model: groundedModel() });
  await f.db.prepare('UPDATE agent_runs SET llm_calls=? WHERE id=?').bind(store.limits.llm - 1, f.runId).run();
  const result = await f.execute();
  assert.equal(f.network.mock.callCount(), 1);
  assert.equal((await f.runRow()).llm_calls, store.limits.llm);
  assert.ok(result.evidence.length > 0);
  assert.ok(result.warnings.some(warning => warning.includes('자연어 설명을 완성하지 못')));
});

test('incomplete intent is rejected without retry, proposals or supplier calls', async t => {
  const f = await fixture(t, { mode: 'optimize', env: { OPENAI_API_KEY: 'test-openai' }, model: () => response(intent, 'incomplete') });
  await assert.rejects(f.execute(), error => error.code === 'model_incomplete' && error.status === 502);
  assert.equal(f.network.mock.callCount(), 1);
  assert.equal((await f.runRow()).llm_calls, 1);
  assert.equal((await f.runRow()).provider_calls, 0);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM agent_proposals').first()).n, 0);
});

test('cancelled run cannot load data, spend any call budget, or persist proposals', async t => {
  const f = await fixture(t, { mode: 'qa', env: { OPENAI_API_KEY: 'test-openai' }, model: groundedModel() });
  await store.cancelRun(f.db, 'alice', f.runId);
  await assert.rejects(f.execute(), error => error.code === 'cancelled');
  assert.deepEqual(f.assets, []);
  assert.equal(f.network.mock.callCount(), 0);
  const row = await f.runRow();
  assert.equal(row.tool_calls + row.llm_calls + row.provider_calls, 0);
  assert.equal(row.result_json, null);
});

test('optimizer proposals retain server KPI provenance and reproducible percentage improvement', async t => {
  const draft = structuredClone(baseline); draft.fuselage.length += 17;
  const f = await fixture(t, { mode: 'optimize', draft, env: { OPENAI_API_KEY: 'test-openai' }, model: groundedModel() });
  const result = await f.execute();
  assert.ok(result.proposals.some(proposal => proposal.operation === 'patch_draft'));
  assert.ok(result.proposals.some(proposal => proposal.operation === 'select_dataset_design'));
  const stored = (await f.db.prepare('SELECT * FROM agent_proposals WHERE run_id=?').bind(f.runId).all()).results;
  assert.equal(stored.length, result.proposals.length);
  for (const proposal of result.proposals) {
    const record = stored.find(row => row.id === proposal.id);
    assert.equal(record.user_id, 'alice');
    assert.equal(record.project_id, f.project.id);
    assert.equal(record.fingerprint, f.project.fingerprint);
    assert.equal(record.revision, f.project.revision);
    if (proposal.operation === 'select_dataset_design') {
      const design = index.designs.find(item => item.id === proposal.candidateDesignId);
      assert.deepEqual(proposal.metrics, { mass: design.mass, range: design.maxDistance, hover: design.hoverTime, power: design.power, maxSpeed: design.maxSpeed });
    } else {
      const payload = JSON.parse(record.payload_json);
      const next = applyDraftChanges(f.project.draft, payload.changes, baseline, payload.locks);
      const before = estimateDraft(selected, f.project.draft, baseline, index.designs);
      const after = estimateDraft(selected, next, baseline, index.designs);
      assert.equal(proposal.metrics.power, after.power);
      assert.equal(proposal.metrics.range, after.range);
      const expectedPercent = ((before.power - after.power) / before.power * 100).toFixed(2);
      assert.ok(proposal.reason.includes(expectedPercent + '%'), proposal.reason);
    }
  }
  assert.deepEqual((await store.getProject(f.db, 'alice', f.project.id)).draft, f.project.draft, 'generating proposals must not apply them');
});

test('all-variable lock reaches optimizer without being dropped by the runner', async t => {
  const draft = structuredClone(baseline); draft.fuselage.length += 17;
  const f = await fixture(t, { mode: 'optimize', draft, env: { OPENAI_API_KEY: 'test-openai' }, model: groundedModel() });
  const result = await f.execute({ locks: ['all'] });
  assert.ok(result.proposals.every(proposal => proposal.operation === 'select_dataset_design'));
  assert.ok(result.warnings.some(warning => warning.includes('모두 잠겨')));
});

test('Affiliates callback never reflects query content or accepts seller authorization tokens', async () => {
  const ready = await callback.GET(new Request('https://drawn.test/api/integrations/aliexpress/callback'));
  assert.equal(ready.status, 200);
  for (const name of ['code', 'access_token', 'error']) {
    const marker = '<script>alert("private-token")</script>';
    const reply = await callback.GET(new Request('https://drawn.test/api/integrations/aliexpress/callback?' + new URLSearchParams({ [name]: marker })));
    assert.equal(reply.status, 400);
    const body = await reply.text();
    assert.ok(!body.includes(marker));
    assert.ok(!body.includes('private-token'));
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    assert.equal(reply.headers.get('referrer-policy'), 'no-referrer');
    assert.match(reply.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(body, /토큰 발급을 처리하지 않습니다/);
  }
});
for (const [name, answer] of [
  ['invented numeric price', '부품의 확정 가격은 999999원입니다. [e1]'],
  ['invented supplier URL', '이 링크에서 구매하세요: https://invented-supplier.example/buy [e1]'],
]) test(`valid citation cannot authorize ${name} in model prose`, async t => {
  const f = await fixture(t, { mode: 'qa', env: { OPENAI_API_KEY: 'test-openai' },
    model: groundedModel({ answer: { answer, evidenceIds: ['e1'] } }) });
  const result = await f.execute();
  assert.notEqual(result.answer, answer);
  assert.match(result.answer, /근거를 확인하지 못/);
  assert.ok(!result.answer.includes('999999'));
  assert.ok(!result.answer.includes('invented-supplier'));
  assert.equal(JSON.parse(result.evidence[0].text).powerW, selected.power);
});

test('upstream model error does not retry or spill internal details into stored state', async t => {
  const f = await fixture(t, { mode: 'qa', env: { OPENAI_API_KEY: 'test-openai' },
    model: () => json({ error: { message: 'private upstream diagnostic', type: 'server_error', code: 'server_error' } }, 500) });
  await assert.rejects(f.execute());
  assert.equal(f.network.mock.callCount(), 1);
  const row = await f.runRow();
  assert.equal(row.llm_calls, 1);
  assert.equal(row.provider_calls, 0);
  assert.equal(row.result_json, null);
});