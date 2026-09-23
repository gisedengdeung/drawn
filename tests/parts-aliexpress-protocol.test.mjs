import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { loadTypeScript } from './helpers/load-typescript.mjs';

const { getPartsConfig } = await loadTypeScript('lib/parts/server/config.ts');
const { AliExpressProvider, signAliExpressSync } = await loadTypeScript('lib/parts/server/aliexpress.ts');
const modernGateway = 'https://api-sg.aliexpress.com/sync';
const credentials = { ALIEXPRESS_APP_KEY: 'protocol-test-app', ALIEXPRESS_APP_SECRET: 'protocol-test-secret' };
const fixedNow = Date.parse('2026-09-20T20:34:56.789Z');
const query = 'brushless motor 980KV + 1pc';
const product = { product_id: '1005001234567', product_title: '980KV brushless motor',
  product_detail_url: 'https://www.aliexpress.com/item/1005001234567.html',
  target_sale_price: '12500', target_sale_price_currency: 'KRW' };
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const productsReply = () => json({ aliexpress_affiliate_product_query_response: {
  resp_result: { resp_code: 200, resp_msg: 'Call succeeds', result: { products: { product: [product] } } },
} });

test('AliExpress Open Platform is the default even with an existing TOP region setting', () => {
  assert.equal(getPartsConfig({}).gateway, modernGateway);
  for (const region of ['CN', 'US', 'https://untrusted.example']) {
    assert.equal(getPartsConfig({ ALIEXPRESS_TOP_REGION: region }).gateway, modernGateway);
  }
  assert.equal(getPartsConfig({ ALIEXPRESS_API_PROTOCOL: 'https://untrusted.example' }).gateway, modernGateway);
});

test('TOP requires explicit opt-in and keeps its fixed regional gateways', () => {
  for (const region of [undefined, 'CN', 'https://untrusted.example']) {
    assert.equal(getPartsConfig({ ALIEXPRESS_API_PROTOCOL: 'TOP', ALIEXPRESS_TOP_REGION: region }).gateway,
      'https://eco.taobao.com/router/rest');
  }
  assert.equal(getPartsConfig({ ALIEXPRESS_API_PROTOCOL: 'TOP', ALIEXPRESS_TOP_REGION: 'US' }).gateway,
    'https://api.taobao.com/router/rest');
});

test('sync signing matches RFC 4231 case 2 without an API path or secret prefix', () => {
  assert.equal(signAliExpressSync({ 'what do ya want for ': 'nothing?', sign: 'ignored', blank: '' }, 'Jefe'),
    '5BDCC146BF60754E6A042426089575C75A003F089D2739839DEC58B964EC3843');
  const expected = createHmac('sha256', 'test-key').update('a1b2keywordsmotor + propeller', 'utf8').digest('hex').toUpperCase();
  assert.equal(signAliExpressSync({ keywords: 'motor + propeller', b: '2', a: '1', blank: '', sign: 'ignored' }, 'test-key'), expected);
});

test('modern Affiliate search sends form data with epoch milliseconds and a SHA256 signature', async () => {
  const config = getPartsConfig({ ...credentials, ALIEXPRESS_TOP_REGION: 'CN', ALIEXPRESS_ACCESS_TOKEN: 'unused-token' });
  let calls = 0;
  const provider = new AliExpressProvider(config, async (url, init) => {
    calls++;
    assert.equal(url, modernGateway);
    assert.equal(init.method, 'POST');
    assert.match(new Headers(init.headers).get('content-type'), /^application\/x-www-form-urlencoded/i);
    const params = new URLSearchParams(init.body);
    assert.equal(params.get('method'), 'aliexpress.affiliate.product.query');
    assert.equal(params.get('app_key'), credentials.ALIEXPRESS_APP_KEY);
    assert.equal(params.get('sign_method'), 'sha256');
    assert.equal(params.get('timestamp'), String(fixedNow));
    assert.equal(params.get('keywords'), query);
    assert.equal(params.get('session'), null);
    assert.equal(params.get('tracking_id'), null);
    const canonical = `app_keyprotocol-test-appformatjsonkeywords${query}methodaliexpress.affiliate.product.querypage_no1page_size8ship_to_countryKRsign_methodsha256target_currencyKRWtarget_languageENtimestamp${fixedNow}v2.0`;
    const expected = createHmac('sha256', credentials.ALIEXPRESS_APP_SECRET).update(canonical, 'utf8').digest('hex').toUpperCase();
    assert.equal(params.get('sign'), expected);
    assert.ok(!String(init.body).includes(credentials.ALIEXPRESS_APP_SECRET));
    return productsReply();
  }, new AbortController().signal, () => fixedNow);
  const result = await provider.search(query);
  assert.equal(calls, 1);
  assert.equal(result[0].productId, product.product_id);
  assert.equal(result[0].price, 12500);
  assert.equal(result[0].currency, 'KRW');
});

test('explicit legacy TOP preserves HMAC-MD5 and GMT+8 timestamps across midnight', async () => {
  for (const region of ['CN', 'US']) {
    const config = getPartsConfig({ ...credentials, ALIEXPRESS_API_PROTOCOL: 'TOP', ALIEXPRESS_TOP_REGION: region });
    let calls = 0;
    const provider = new AliExpressProvider(config, async (url, init) => {
      calls++;
      assert.equal(url, region === 'US' ? 'https://api.taobao.com/router/rest' : 'https://eco.taobao.com/router/rest');
      assert.equal(init.method, 'POST');
      const params = new URLSearchParams(init.body);
      assert.equal(params.get('sign_method'), 'hmac');
      assert.equal(params.get('timestamp'), '2026-09-21 04:34:56');
      const canonical = `app_keyprotocol-test-appformatjsonkeywords${query}methodaliexpress.affiliate.product.querypage_no1page_size8ship_to_countryKRsign_methodhmactarget_currencyKRWtarget_languageENtimestamp2026-09-21 04:34:56v2.0`;
      const expected = createHmac('md5', credentials.ALIEXPRESS_APP_SECRET).update(canonical, 'utf8').digest('hex').toUpperCase();
      assert.equal(params.get('sign'), expected);
      assert.ok(!String(init.body).includes(credentials.ALIEXPRESS_APP_SECRET));
      return productsReply();
    }, new AbortController().signal, () => fixedNow);
    assert.equal((await provider.search(query))[0].price, 12500);
    assert.equal(calls, 1);
  }
});

test('top-level and wrapped IOP authentication failures become sanitized permission errors', async () => {
  const config = getPartsConfig(credentials);
  const upstream = { code: 'IncompleteSignature', message: `private provider detail ${credentials.ALIEXPRESS_APP_SECRET}` };
  for (const response of [upstream, { error_response: upstream }]) {
    let calls = 0;
    const provider = new AliExpressProvider(config, async () => { calls++; return json(response); }, new AbortController().signal);
    await assert.rejects(provider.search(query), (error) => {
      assert.equal(error.status, 'permission_denied');
      assert.ok(!error.message.includes('private provider detail'));
      assert.ok(!error.message.includes(credentials.ALIEXPRESS_APP_SECRET));
      return true;
    });
    assert.equal(calls, 1);
  }
});
