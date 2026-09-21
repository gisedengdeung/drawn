import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTypeScript } from './helpers/load-typescript.mjs';
const { proxyApi } = await loadTypeScript('lib/server/api-proxy.ts');
function backend(t, url) {
  const previous = process.env.API_INTERNAL_URL;
  process.env.API_INTERNAL_URL = url;
  t.after(() => { if (previous === undefined) delete process.env.API_INTERNAL_URL; else process.env.API_INTERNAL_URL = previous; });
}

test('proxy preserves encoded path, query, body, origin and cookies while removing transport headers', async t => {
  backend(t, 'http://127.0.0.1:8912/old-base?discard=true');
  let sent;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sent = { url: String(url), init, body: await new Response(init.body).text() };
    return Response.json({ ok: true });
  });
  const request = new Request('http://frontend.test/api/projects/id%2F1?filter=a%2Bb&filter=c', {
    method: 'PATCH', headers: {
      'content-type': 'application/json', cookie: 'drawn.session=opaque-session',
      origin: 'http://frontend.test', host: 'frontend.test', connection: 'close',
      'content-length': '2', 'accept-encoding': 'gzip', 'x-request-id': 'request-7',
    }, body: '{}',
  });
  const response = await proxyApi(request);
  assert.equal(sent.url, 'http://127.0.0.1:8912/api/projects/id%2F1?filter=a%2Bb&filter=c');
  assert.equal(sent.init.method, 'PATCH');
  assert.equal(sent.init.redirect, 'manual');
  assert.equal(sent.init.duplex, 'half');
  assert.equal(sent.init.signal, request.signal);
  assert.equal(sent.body, '{}');
  assert.equal(sent.init.headers.get('cookie'), 'drawn.session=opaque-session');
  assert.equal(sent.init.headers.get('origin'), 'http://frontend.test');
  assert.equal(sent.init.headers.get('x-request-id'), 'request-7');
  for (const key of ['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding'])
    assert.equal(sent.init.headers.has(key), false);
  assert.deepEqual(await response.json(), { ok: true });
});

test('network-path input can never change the configured backend origin', async t => {
  backend(t, 'http://127.0.0.1:8912');
  let target;
  t.mock.method(globalThis, 'fetch', async url => {
    target = new URL(url);
    return Response.json({ ok: true });
  });
  await proxyApi(new Request('http://frontend.test//external.example/api/projects'));
  assert.equal(target.origin, 'http://127.0.0.1:8912');
  assert.equal(target.pathname, '//external.example/api/projects');
});

test('OAuth redirects and distinct HttpOnly cookies pass through without following the redirect', async t => {
  const cookies = ['drawn.session=one; HttpOnly; Path=/; SameSite=Lax', 'drawn.oauth_state=two; HttpOnly; Path=/api/auth; SameSite=Lax'];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.redirect, 'manual');
    assert.equal(init.body, undefined);
    const headers = new Headers({ location: 'https://accounts.google.com/authorize', 'content-encoding': 'gzip', 'content-length': '123', 'transfer-encoding': 'chunked' });
    for (const cookie of cookies) headers.append('set-cookie', cookie);
    return new Response(null, { status: 302, headers });
  });
  const response = await proxyApi(new Request('http://frontend.test/api/auth/callback/google?code=example'));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://accounts.google.com/authorize');
  assert.deepEqual(response.headers.getSetCookie(), cookies);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  for (const key of ['content-encoding', 'content-length', 'transfer-encoding']) assert.equal(response.headers.has(key), false);
});

test('upstream errors, status and content type reach the browser unchanged', async t => {
  const raw = JSON.stringify({ error: { code: 'model_input_unavailable', message: 'Valid hover data unavailable' } });
  t.mock.method(globalThis, 'fetch', async () => new Response(raw, { status: 422, headers: { 'content-type': 'application/json', 'retry-after': '4' } }));
  const response = await proxyApi(new Request('http://frontend.test/api/performance/predict'));
  assert.equal(response.status, 422);
  assert.equal(await response.text(), raw);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('retry-after'), '4');
});

test('NDJSON chunks reach the reader before the upstream finishes', { timeout: 3000 }, async t => {
  let sink;
  const stream = new ReadableStream({ start(controller) { sink = controller; } });
  t.mock.method(globalThis, 'fetch', async () => new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } }));
  const response = await proxyApi(new Request('http://frontend.test/api/agent/run', { method: 'POST', body: '{}' }));
  const reader = response.body.getReader();
  const encoder = new TextEncoder();
  sink.enqueue(encoder.encode('{"type":"progress","runId":"run-1"}\n'));
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), '{"type":"progress","runId":"run-1"}\n');
  assert.equal(first.done, false);
  sink.enqueue(encoder.encode('{"type":"result","runId":"run-1"}\n'));
  sink.close();
  const last = await reader.read();
  assert.match(new TextDecoder().decode(last.value), /"type":"result"/);
  assert.equal((await reader.read()).done, true);
  reader.releaseLock();
});

test('client disconnect aborts the upstream and is not turned into a misleading 503', { timeout: 3000 }, async t => {
  const controller = new AbortController();
  const reason = new DOMException('Client disconnected', 'AbortError');
  t.mock.method(globalThis, 'fetch', (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }));
  const request = new Request('http://frontend.test/api/agent/run', { method: 'POST', body: '{}', signal: controller.signal });
  const pending = proxyApi(request);
  controller.abort(reason);
  await assert.rejects(pending, { name: 'AbortError' });
});

test('transport failure returns a sanitized actionable 503', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('private internal database address'); });
  const response = await proxyApi(new Request('http://frontend.test/api/agent/session'));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'backend_unavailable');
});
