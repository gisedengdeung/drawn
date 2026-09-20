import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTypeScript } from './helpers/load-typescript.mjs';

const { searchParts } = await loadTypeScript('lib/parts/server/search.ts');
const { getPartsConfig } = await loadTypeScript('lib/parts/server/config.ts');
const { AliExpressProvider, parseAffiliateProducts } = await loadTypeScript('lib/parts/server/aliexpress.ts');
const { affiliatePromotionLink } = await loadTypeScript('lib/parts/links.ts');
const { isPartSearchResult, purchaseLink } = await loadTypeScript('lib/parts/client.ts');
const { calculateOfferAmounts } = await loadTypeScript('lib/parts/pricing.ts');
const { restoreQuote } = await loadTypeScript('lib/parts/session.ts');
const { quoteToCsv } = await loadTypeScript('lib/parts/csv.ts');
const config = { appKey: 'test-app', appSecret: 'test-secret', trackingId: 'drawn-test', accessToken: 'unused-token',
  gateway: 'https://eco.taobao.com/router/rest', openaiKey: 'unused-ai', openaiModel: 'gpt-5-mini' };
const url = 'https://www.aliexpress.com/item/1005001234567.html';
const promotionUrl = 'https://s.click.aliexpress.com/e/_Drawn123';
const item = { id: 'motor:test', kind: 'motor', model: 'SunnySky X2212 980KV', quantity: 4,
  specs: { motorKv: 980 }, instances: ['m1', 'm2', 'm3', 'm4'], issues: [] };
const request = { item, country: 'KR', currency: 'KRW' };
const row = { product_id: '1005001234567', product_detail_url: url, product_title: 'SunnySky X2212 980KV motor 1pc',
  target_sale_price: '12500', target_sale_price_currency: 'KRW' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const reply = (method, result) => json({ [method.replaceAll('.', '_') + '_response']: { resp_result: { resp_code: 200, result } } });
function transport(calls, overrides = {}) {
  return async (_input, init) => {
    const params = new URLSearchParams(init.body);
    const method = params.get('method');
    calls.push(method);
    assert.equal(params.get('session'), null);
    if (method === 'aliexpress.affiliate.link.generate') {
      assert.equal(params.get('tracking_id'), config.trackingId);
      assert.equal(params.get('source_values'), url);
      return reply(method, { tracking_id: config.trackingId, promotion_links: { promotion_link: [
        { source_value: url, promotion_link: promotionUrl }, ...overrides.links ?? [],
      ] } });
    }
    return reply(method, { products: { product: [{ ...row, ...overrides.row }] } });
  };
}

test('Affiliate mode uses search, fresh details and source-bound promotion links without DS or nested AI', async () => {
  const calls = [], charges = [];
  const result = await searchParts(request, { config, allowAI: false, consumeBudget: (kind) => { charges.push(kind); return true; }, fetcher: transport(calls) });
  assert.deepEqual(calls, ['aliexpress.affiliate.product.query', 'aliexpress.affiliate.productdetail.get', 'aliexpress.affiliate.link.generate']);
  assert.deepEqual(charges, ['provider', 'provider', 'provider']);
  assert.equal(result.offers[0].url, url);
  assert.equal(result.offers[0].promotionUrl, promotionUrl);
  assert.equal(result.offers[0].priceKind, 'listing');
  assert.equal(result.offers[0].packPrice, 12500);
  assert.equal(result.offers[0].optionVerified, false);
  assert.equal(calculateOfferAmounts(item, result.offers[0]).subtotal, null);
  assert.equal(purchaseLink(result.offers[0]), promotionUrl);
  assert.ok(isPartSearchResult(result, item.id));
  assert.deepEqual(result.warnings, []);
  assert.equal(getPartsConfig({ ALIEXPRESS_ACCESS_TOKEN: 'token' }).dsEnabled, false);
  assert.equal(getPartsConfig({ ALIEXPRESS_DS_ENABLED: 'true' }).dsEnabled, true);
});

test('promotion URL validation rejects foreign hosts, HTTP, credentials, wrong products and redirects', () => {
  for (const value of ['https://s.click.aliexpress.com.evil.test/e/_abc', 'http://s.click.aliexpress.com/e/_abc',
    'https://user:pass@s.click.aliexpress.com/e/_abc', 'https://s.click.aliexpress.com:444/e/_abc',
    'https://www.aliexpress.com/redirect?url=https://evil.test', 'https://s.click.aliexpress.com/e/_abc#fragment',
    'https://www.aliexpress.com/item/1005009999999.html?aff=1']) {
    assert.equal(affiliatePromotionLink(value, row.product_id), null, value);
  }
  const tracked = url + '?aff_fcid=provider-value&aff_platform=api';
  assert.equal(affiliatePromotionLink(tracked, row.product_id), tracked);
  assert.equal(parseAffiliateProducts([{ ...row, promotion_link: promotionUrl }])[0].promotionUrl, promotionUrl);
});

test('link generation cannot attach a response for a different source product', async () => {
  const provider = new AliExpressProvider(config, async (_input, init) => reply(new URLSearchParams(init.body).get('method'), {
    tracking_id: config.trackingId, promotion_links: { promotion_link: [
      { source_value: 'https://www.aliexpress.com/item/1005009999999.html', promotion_link: promotionUrl },
      { source_value: url, promotion_link: 'https://evil.test/item' },
    ] },
  }), AbortSignal.timeout(1000));
  const products = parseAffiliateProducts([row]);
  assert.equal((await provider.promotionLinks(products))[0].promotionUrl, null);
});

test('missing tracking ID and link-provider failure preserve real prices and canonical links', async () => {
  const calls = [];
  const result = await searchParts(request, { config: { ...config, trackingId: '' }, allowAI: false, fetcher: transport(calls) });
  assert.equal(calls.length, 2);
  assert.equal(purchaseLink(result.offers[0]), url);
  let attempts = 0;
  const failed = await searchParts(request, { config, allowAI: false, fetcher: async (input, init) => {
    if (new URLSearchParams(init.body).get('method') === 'aliexpress.affiliate.link.generate') {
      attempts++;
      return json({ error_response: { code: '403', msg: 'private provider detail' } });
    }
    return transport([])(input, init);
  } });
  assert.equal(attempts, 1);
  assert.equal(failed.status, 'ok');
  assert.equal(failed.offers[0].packPrice, 12500);
  assert.equal(purchaseLink(failed.offers[0]), url);
  assert.ok(failed.warnings.length);
  assert.ok(!JSON.stringify(failed).includes('private provider detail'));
});

test('shared budget is charged for retries and stops before the next network attempt', async () => {
  let charged = 0, sent = 0;
  const result = await searchParts(request, { config, allowAI: false,
    consumeBudget: () => ++charged <= 1,
    fetcher: async () => { sent++; return json({}, 503); },
  });
  assert.equal(charged, 2);
  assert.equal(sent, 1);
  assert.equal(result.status, 'rate_limited');
  assert.deepEqual(result.offers, []);
});

test('budget callback failure does not retry or reach a provider', async () => {
  let calls = 0;
  const result = await searchParts(request, { config, allowAI: false,
    consumeBudget: () => { throw new Error('internal quota storage detail'); },
    fetcher: async () => { calls++; throw new Error('must not reach network'); },
  });
  assert.equal(calls, 0);
  assert.equal(result.status, 'rate_limited');
  assert.ok(!JSON.stringify(result).includes('internal quota storage detail'));
});

test('listing price cannot be promoted to a confirmed total in a tampered payload', async () => {
  const result = await searchParts(request, { config, allowAI: false, fetcher: transport([]) });
  const offer = { ...result.offers[0], optionVerified: true, optionId: 'forced', optionLabel: 'forced' };
  assert.equal(calculateOfferAmounts(item, offer).subtotal, null);
  assert.equal(isPartSearchResult({ ...result, offers: [offer] }, item.id), false);
});

test('quote restore and CSV preserve listing metadata and both canonical and promotion URLs', async () => {
  const result = await searchParts(request, { config, allowAI: false, fetcher: transport([]) });
  const snapshot = { fingerprint: '1234567890abcdef', designId: 1, createdAt: '2026-09-20T00:00:00.000Z', items: [item], exclusions: [] };
  const lines = [{ item, result, selectedOfferId: result.offers[0].id }];
  const restored = restoreQuote(JSON.stringify({ snapshot, lines }));
  assert.ok(restored);
  assert.equal(restored.lines[0].result.offers[0].promotionUrl, promotionUrl);
  const csv = quoteToCsv(restored.snapshot, restored.lines);
  assert.ok(csv.includes(url));
  assert.ok(csv.includes(promotionUrl));
  assert.ok(csv.includes('상품 표시 가격'));
});
