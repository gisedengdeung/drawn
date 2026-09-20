import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { serializeSignedCookie } from 'better-call';
import { SQLiteD1Database } from './helpers/d1.mjs';
import { loadTypeScript } from './helpers/load-typescript.mjs';

// Only supply the Cloudflare runtime binding; production requireUser and Better Auth run unchanged.
const ENV_KEY = Symbol.for('drawn.test.proposal-route-bindings');
const environment = {};
globalThis[ENV_KEY] = environment;
const runtimeURL = `data:text/javascript,${encodeURIComponent("export const env=globalThis[Symbol.for('drawn.test.proposal-route-bindings')];")}`;
const loader = registerHooks({ resolve(specifier, context, nextResolve) {
  return specifier === 'cloudflare:workers' ? { url: runtimeURL, shortCircuit: true } : nextResolve(specifier, context);
} });
after(() => { loader.deregister(); delete globalThis[ENV_KEY]; });
const { createAuth } = await loadTypeScript('lib/agent/server/auth.ts');
const store = await loadTypeScript('lib/agent/server/store.ts');
const { hydrateDraft } = await loadTypeScript('lib/design-draft.ts');
const { POST: apply } = await loadTypeScript('app/api/design-proposals/[id]/apply/route.ts');
const { POST: restore } = await loadTypeScript('app/api/projects/[id]/restore/route.ts');
const shard = JSON.parse(readFileSync(new URL('../public/data/design-trees/shard-000.json', import.meta.url), 'utf8'));
const BASE_URL = 'http://localhost:5173';
const SECRET = 'isolated-route-test-secret-with-at-least-32-characters';

async function fixture(t) {
  const db = new SQLiteD1Database();
  t.after(() => db.close());
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Route tests must not contact external services'); });
  for (const key of Object.keys(environment)) delete environment[key];
  Object.assign(environment, { AGENT_DB: db, APP_BASE_URL: BASE_URL, BETTER_AUTH_SECRET: SECRET,
    GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-client-secret',
    ASSETS: { fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (!/^\/data\/(?:design-index|component-catalogs|design-trees\/shard-\d{3})\.json$/.test(path)) return new Response(null, { status: 404 });
      return new Response(readFileSync(new URL(`../public${path}`, import.meta.url)), { headers: { 'Content-Type': 'application/json' } });
    } },
  });
  const auth = createAuth(environment);
  const context = await auth.$context;
  async function user(name) {
    // Seed a valid test account/session using Better Auth's actual adapter, then use its signed cookie.
    const account = await context.internalAdapter.createUser({ name, email: `${name}@example.test`, emailVerified: true });
    const session = await context.internalAdapter.createSession(account.id, false);
    const cookie = (await serializeSignedCookie('better-auth.session_token', session.token, SECRET, { path: '/', httpOnly: true, sameSite: 'lax' })).split(';')[0];
    assert.equal((await auth.api.getSession({ headers: new Headers({ cookie }) })).user.id, account.id);
    return { id: account.id, cookie };
  }
  const alice = await user('alice');
  const bob = await user('bob');
  const project = await store.createProject(db, alice.id, 'Reverse taper design', hydrateDraft(shard['2']), 'source-gallery');
  return { db, alice, bob, project };
}

async function proposal(db, user, project, after = 95) {
  const runId = await store.startRun(db, user.id, project, 'optimize', 'Improve this design');
  await store.finishRun(db, user.id, runId, 'completed', null);
  const id = crypto.randomUUID();
  const payload = { operation: 'patch_draft', changes: [{ id: 'fuselage:length', label: 'Fuselage length', before: project.draft.fuselage.length, after, unit: 'mm' }], locks: [] };
  await db.prepare("INSERT INTO agent_proposals(id,user_id,project_id,run_id,revision,fingerprint,operation,payload_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,'proposed',?)")
    .bind(id, user.id, project.id, runId, project.revision, project.fingerprint, payload.operation, JSON.stringify(payload), new Date().toISOString()).run();
  return id;
}
function request(user, path, body) {
  return new Request(`${BASE_URL}${path}`, { method: 'POST', headers: { Origin: BASE_URL, 'Content-Type': 'application/json', ...(user ? { Cookie: user.cookie } : {}) }, body: JSON.stringify(body) });
}
const applyRequest = (user, id, expectedRevision = 1) => apply(request(user, `/api/design-proposals/${id}/apply`, { expectedRevision }), { params: Promise.resolve({ id }) });
const restoreRequest = (user, id, expectedRevision, revision = 1) => restore(request(user, `/api/projects/${id}/restore`, { expectedRevision, revision }), { params: Promise.resolve({ id }) });
async function history(db, id) { return (await db.prepare('SELECT revision,draft_json FROM agent_revisions WHERE project_id=? ORDER BY revision').bind(id).all()).results; }
async function proposalStatus(db, id) { return (await db.prepare('SELECT status FROM agent_proposals WHERE id=?').bind(id).first()).status; }

test('actual proposal routes require a valid session and the proposal/project owner', async (t) => {
  const { db, alice, bob, project } = await fixture(t);
  const id = await proposal(db, alice, project);
  assert.equal((await applyRequest(null, id)).status, 401);
  assert.equal((await applyRequest(bob, id)).status, 404);
  assert.equal((await restoreRequest(bob, project.id, 1)).status, 404);
  assert.equal((await store.getProject(db, alice.id, project.id)).revision, 1);
  assert.equal(await proposalStatus(db, id), 'proposed');
});

test('actual proposal apply updates geometry, status and revision history once under concurrent replay', async (t) => {
  const { db, alice, project } = await fixture(t);
  const id = await proposal(db, alice, project);
  const responses = await Promise.all([applyRequest(alice, id), applyRequest(alice, id)]);
  assert.deepEqual(responses.map((response) => response.status).sort((left, right) => left - right), [200, 409]);
  const saved = await store.getProject(db, alice.id, project.id);
  assert.equal(saved.revision, 2);
  assert.equal(saved.draft.fuselage.length, 95);
  assert.deepEqual(saved.draft.wings, project.draft.wings);
  assert.equal(saved.sourceId, project.sourceId);
  assert.equal(await proposalStatus(db, id), 'applied');
  assert.deepEqual((await history(db, project.id)).map((entry) => entry.revision), [1, 2]);
  assert.equal((await applyRequest(alice, id, 2)).status, 409);
  assert.equal((await store.getProject(db, alice.id, project.id)).revision, 2);
});

test('competing proposal IDs cannot both apply to the same revision or consume the losing proposal', async (t) => {
  const { db, alice, project } = await fixture(t);
  const first = await proposal(db, alice, project, 95);
  const second = await proposal(db, alice, project, 96);
  const responses = await Promise.all([applyRequest(alice, first), applyRequest(alice, second)]);
  assert.deepEqual(responses.map((response) => response.status).sort((left, right) => left - right), [200, 409]);
  const statuses = await Promise.all([proposalStatus(db, first), proposalStatus(db, second)]);
  assert.deepEqual(statuses.sort((left, right) => left.localeCompare(right)), ['applied', 'proposed']);
  assert.equal((await store.getProject(db, alice.id, project.id)).revision, 2);
  assert.equal((await history(db, project.id)).length, 2);
});

test('a stale proposal cannot overwrite a newer edit and remains unapplied', async (t) => {
  const { db, alice, project } = await fixture(t);
  const id = await proposal(db, alice, project);
  const changed = structuredClone(project.draft); changed.fuselage.length = 94;
  await store.saveProject(db, alice.id, project.id, 1, changed);
  const response = await applyRequest(alice, id, 2);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'stale_proposal');
  assert.equal((await store.getProject(db, alice.id, project.id)).draft.fuselage.length, 94);
  assert.equal(await proposalStatus(db, id), 'proposed');
});

test('proposal transaction rolls geometry and history back if marking the proposal fails', async (t) => {
  const { db, alice, project } = await fixture(t);
  const id = await proposal(db, alice, project);
  await db.exec("CREATE TRIGGER fail_apply BEFORE UPDATE OF status ON agent_proposals WHEN NEW.status='applied' BEGIN SELECT RAISE(ABORT,'injected test failure'); END;");
  assert.equal((await applyRequest(alice, id)).status, 500);
  assert.deepEqual(await store.getProject(db, alice.id, project.id), project);
  assert.equal(await proposalStatus(db, id), 'proposed');
  assert.deepEqual((await history(db, project.id)).map((entry) => entry.revision), [1]);
});

test('undo restores a historical draft through a new CAS revision and rejects stale or repeated undo', async (t) => {
  const { db, alice, project } = await fixture(t);
  const id = await proposal(db, alice, project);
  assert.equal((await applyRequest(alice, id)).status, 200);
  const responses = await Promise.all([restoreRequest(alice, project.id, 2), restoreRequest(alice, project.id, 2)]);
  assert.deepEqual(responses.map((response) => response.status).sort((left, right) => left - right), [200, 409]);
  const restored = await store.getProject(db, alice.id, project.id);
  assert.equal(restored.revision, 3);
  assert.deepEqual(restored.draft, project.draft);
  assert.deepEqual((await history(db, project.id)).map((entry) => entry.revision), [1, 2, 3]);
  assert.equal((await restoreRequest(alice, project.id, 2)).status, 409);
  assert.equal((await restoreRequest(alice, project.id, 3, 999)).status, 404);
  assert.equal((await store.getProject(db, alice.id, project.id)).revision, 3);
});