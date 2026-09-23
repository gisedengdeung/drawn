import assert from 'node:assert/strict';
import test from 'node:test';
import { SQLiteD1Database } from './helpers/d1.mjs';
import { loadTypeScript } from './helpers/load-typescript.mjs';

const { createAuth } = await loadTypeScript('lib/agent/server/auth.ts');
const BASE_URL = 'http://localhost:5173';
function fixture(t) {
  const db = new SQLiteD1Database();
  t.after(() => db.close());
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('OAuth start and empty-session tests must not contact external services'); });
  const auth = createAuth({ AGENT_DB: db, APP_BASE_URL: BASE_URL,
    BETTER_AUTH_SECRET: 'isolated-test-auth-secret-with-at-least-32-characters',
    GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-client-secret' });
  return { auth, db, network };
}
function socialRequest(overrides = {}, origin = BASE_URL) {
  return new Request(`${BASE_URL}/api/auth/sign-in/social`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Forwarded-For': '127.0.0.1' },
    body: JSON.stringify({ provider: 'google', callbackURL: `${BASE_URL}/`, disableRedirect: true, ...overrides }) });
}

test('Better Auth fails closed when required deployment settings are absent', () => {
  assert.throws(() => createAuth({ APP_BASE_URL: '', BETTER_AUTH_SECRET: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }),
    (error) => error.status === 503 && error.code === 'not_configured');
});

test('real Better Auth get-session returns null without cookies or network requests', async (t) => {
  const { auth, db, network } = fixture(t);
  const response = await auth.handler(new Request(`${BASE_URL}/api/auth/get-session`, { headers: { 'X-Forwarded-For': '127.0.0.1' } }));
  assert.equal(response.status, 200);
  assert.equal(await response.json(), null);
  assert.equal(await auth.api.getSession({ headers: new Headers() }), null);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM session').first()).n, 0);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM user').first()).n, 0);
  assert.equal(network.mock.callCount(), 0);
});

test('Google OAuth start uses the deployed callback and persists CSRF/PKCE state in actual SQLite', async (t) => {
  const { auth, db, network } = fixture(t);
  const response = await auth.handler(socialRequest());
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.redirect, false);
  const url = new URL(payload.url);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'test-client.apps.googleusercontent.com');
  assert.equal(url.searchParams.get('redirect_uri'), `${BASE_URL}/api/auth/callback/google`);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge')?.length > 30);
  const scopes = new Set(url.searchParams.get('scope').split(' '));
  for (const scope of ['openid', 'email', 'profile']) assert.ok(scopes.has(scope), scope);
  const state = url.searchParams.get('state');
  assert.ok(state && state.length >= 32);
  const cookies = response.headers.getSetCookie().join('; ');
  assert.match(cookies, /better-auth\.state=/);
  assert.match(cookies, /HttpOnly/i);
  assert.match(cookies, /SameSite=Lax/i);
  const verifications = (await db.prepare('SELECT * FROM verification').all()).results;
  assert.equal(verifications.length, 1);
  const stored = JSON.parse(verifications[0].value);
  assert.equal(stored.oauthState, state);
  assert.equal(stored.callbackURL, `${BASE_URL}/`);
  assert.ok(stored.codeVerifier.length >= 43);
  assert.ok(stored.expiresAt > Date.now());
  assert.equal((await db.prepare('SELECT count(*) AS n FROM session').first()).n, 0);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM user').first()).n, 0);
  assert.ok((await db.prepare('SELECT count(*) AS n FROM rateLimit').first()).n > 0);
  assert.equal(network.mock.callCount(), 0);
});

test('OAuth rejects credentialed cross-origin requests and untrusted callbacks before creating state', async (t) => {
  const { auth, db, network } = fixture(t);
  const crossOrigin = socialRequest({}, 'https://untrusted.example');
  crossOrigin.headers.set('Cookie', 'better-auth.state=untrusted-placeholder');
  for (const request of [crossOrigin, socialRequest({ callbackURL: 'https://untrusted.example/finish' })]) {
    const response = await auth.handler(request);
    assert.equal(response.status, 403);
  }
  assert.equal((await db.prepare('SELECT count(*) AS n FROM verification').first()).n, 0);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM session').first()).n, 0);
  assert.equal(network.mock.callCount(), 0);
});