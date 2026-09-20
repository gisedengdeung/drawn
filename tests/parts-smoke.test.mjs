import assert from 'node:assert/strict';
import test from 'node:test';
import { runPartsSmoke } from '../scripts/check-parts-api.mjs';

const PROJECT_ID = '9b2b24ae-d2d2-441e-912e-cc9c0d682abe';
const RUN_ID = '4ce817f6-17dc-430e-89ce-7aaf8bcd3c26';
const COOKIE = 'better-auth.session_token=private-test-session-token';
const env = { PARTS_SMOKE_PROJECT_ID: PROJECT_ID, PARTS_SMOKE_REVISION: '3', PARTS_SMOKE_SESSION_COOKIE: COOKIE };
const project = { id: PROJECT_ID, revision: 3, fingerprint: 'stored-project-fingerprint' };
function result(status = 'ok') {
  return { context: { projectId: PROJECT_ID, revision: 3, fingerprint: project.fingerprint }, quote: {
    snapshot: { fingerprint: project.fingerprint }, lines: [{ item: { kind: 'motor', model: 'Saved motor \uD83D\uDE81', quantity: 4 }, result: {
      status, offers: status === 'ok' ? [{ productId: '100500test', url: 'https://www.aliexpress.com/item/100500test.html',
        promotionUrl: 'https://s.click.aliexpress.com/test', priceKind: 'listing', optionVerified: false, optionLabel: null,
        packPrice: 54800, packQuantity: null, currency: 'KRW', retrievedAt: '2026-09-20T00:00:00.000Z' }] : [],
    } }],
  } };
}
function events(entries) {
  // Split UTF-8 and JSON tokens across chunks; the final event intentionally has no newline.
  const bytes = new TextEncoder().encode(entries.map((event) => JSON.stringify(event)).join('\r\n'));
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(offset, offset + 7)); offset = Math.min(bytes.length, offset + 7);
  } }), { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } });
}
const completed = (value = result()) => events([{ type: 'start', runId: RUN_ID }, { type: 'progress', runId: RUN_ID }, { type: 'result', runId: RUN_ID, result: value }]);
async function check({ environment = env, responses = [Response.json(project), completed()] } = {}) {
  const requests = [], logs = [], errors = [];
  const exitCode = await runPartsSmoke({ env: environment, log: (value) => logs.push(value), error: (value) => errors.push(value),
    fetcher: async (url, options) => {
      assert.ok(url instanceof URL);
      requests.push({ url: url.href, ...options });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      assert.ok(next, 'The smoke test must never retry or request an arbitrary BOM endpoint');
      return next;
    },
  });
  assert.ok(![...logs, ...errors].join('\n').includes(COOKIE));
  assert.ok(![...logs, ...errors].join('\n').includes('private-test-session-token'));
  return { exitCode, requests, logs, errors };
}

test('parts smoke fails before network for missing credentials, invalid project/revision or non-local origins', async () => {
  for (const environment of [{}, { ...env, PARTS_SMOKE_SESSION_COOKIE: '' }, { ...env, PARTS_SMOKE_PROJECT_ID: 'anything' },
    { ...env, PARTS_SMOKE_REVISION: '0' }, { ...env, PARTS_SMOKE_REVISION: '3.1' }, { ...env, PARTS_SMOKE_REVISION: '9007199254740992' },
    { ...env, PARTS_SMOKE_SESSION_COOKIE: COOKIE + '\r\nOther: header' },
    ...['https://example.com', 'http://localhost.example.com', 'http://user:password@localhost:5173', 'http://localhost:5173/path', 'file:///tmp', 'not a URL']
      .map((base) => ({ ...env, PARTS_SMOKE_BASE_URL: base }))]) {
    const checked = await check({ environment });
    assert.equal(checked.exitCode, 2);
    assert.equal(checked.requests.length, 0);
    assert.match(checked.errors[0], /PARTS_SMOKE_SESSION_COOKIE/);
    assert.match(checked.errors[0], /1 daily Agent run/);
  }
});

test('parts smoke authenticates project GET then makes exactly one canonical parts run without a client BOM', async () => {
  const checked = await check();
  assert.equal(checked.exitCode, 0);
  assert.equal(checked.requests.length, 2);
  const [get, run] = checked.requests;
  assert.equal(get.url, `http://localhost:5173/api/projects/${PROJECT_ID}`);
  assert.equal(run.url, 'http://localhost:5173/api/agent/run');
  assert.equal(run.method, 'POST');
  for (const request of checked.requests) {
    assert.equal(request.headers.Cookie, COOKIE);
    assert.equal(request.headers.Origin, 'http://localhost:5173');
    assert.equal(request.redirect, 'error'); // Cookies must never follow a server redirect elsewhere.
    assert.equal(request.cache, 'no-store');
  }
  assert.deepEqual(JSON.parse(run.body), { projectId: PROJECT_ID, revision: 3, mode: 'parts',
    message: 'Check AliExpress prices and links for this saved project.', locks: [] });
  const summary = JSON.parse(checked.logs.find((value) => value.startsWith('{')));
  assert.equal(summary.lines[0].model, 'Saved motor \uD83D\uDE81');
  assert.equal(summary.lines[0].offers[0].packPrice, 54800);
  assert.equal(summary.lines[0].offers[0].priceKind, 'listing');
  assert.equal(summary.lines[0].offers[0].optionVerified, false);
  assert.match(checked.logs.at(-1), /not confirmed purchase totals/);
});

test('parts smoke refuses stale, unauthenticated, inaccessible and unconfigured project reads before charging', async () => {
  for (const status of [401, 403, 404, 409, 429, 503]) {
    const checked = await check({ responses: [Response.json({ error: COOKIE }, { status })] });
    assert.equal(checked.exitCode, 2);
    assert.equal(checked.requests.length, 1);
  }
  const checked = await check({ responses: [Response.json({ ...project, revision: 4 })] });
  assert.equal(checked.exitCode, 2);
  assert.equal(checked.requests.length, 1);
  assert.match(checked.errors[0], /No run was submitted/);
});

test('parts smoke never retries an uncertain POST, failed stream, missing result or wrong project context', async () => {
  const wrong = result(); wrong.context.revision = 4;
  for (const response of [new Error(COOKIE), events([{ type: 'start', runId: RUN_ID }, { type: 'error', runId: RUN_ID, message: COOKIE }]),
    events([{ type: 'start', runId: RUN_ID }]), completed(wrong), new Response('{broken', { headers: { 'Content-Type': 'application/x-ndjson' } })]) {
    const checked = await check({ responses: [Response.json(project), response] });
    assert.equal(checked.exitCode, 1);
    assert.equal(checked.requests.length, 2);
    assert.match(checked.errors.at(-1), /may have used 1 daily run/);
    assert.match(checked.errors.at(-1), /No automatic retry/);
  }
});

test('parts smoke exposes provider setup failures with exit 2 and no automatic retry', async () => {
  for (const status of ['not_configured', 'permission_denied']) {
    const checked = await check({ responses: [Response.json(project), completed(result(status))] });
    assert.equal(checked.exitCode, 2);
    assert.equal(checked.requests.length, 2);
    assert.match(checked.errors.at(-1), /ALIEXPRESS_APP_KEY/);
    assert.match(checked.errors.at(-1), /accepted run used 1 daily run/);
  }
});

test('parts smoke does not report success for empty, failed or offer-free lookups', async () => {
  const empty = result(); empty.quote.lines = [];
  for (const value of [empty, result('not_found'), result('rate_limited'), result('error')]) {
    const checked = await check({ responses: [Response.json(project), completed(value)] });
    assert.equal(checked.exitCode, 1);
    assert.equal(checked.requests.length, 2);
  }
});

test('parts smoke redacts the session cookie even if a server display field echoes it', async () => {
  const value = result(); value.quote.lines[0].result.offers[0].optionLabel = COOKIE;
  const checked = await check({ responses: [Response.json(project), completed(value)] });
  assert.equal(checked.exitCode, 0);
  assert.match(checked.logs.join('\n'), /\[redacted\]/);
});