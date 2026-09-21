import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTypeScript } from './helpers/load-typescript.mjs';

// Ownership, CAS, rollback and undo are exercised against the FastAPI/PostgreSQL
// routes in backend/tests/test_api_postgres.py and test_store_postgres.py.
const { POST: apply } = await loadTypeScript('app/api/design-proposals/[id]/apply/route.ts');
const { POST: restore } = await loadTypeScript('app/api/projects/[id]/restore/route.ts');

for (const [label, handler, path, body] of [
  ['proposal apply', apply, '/api/design-proposals/proposal-1/apply', { expectedRevision: 3 }],
  ['project restore', restore, '/api/projects/project-1/restore', { expectedRevision: 4, revision: 2 }],
]) test(label + ' preserves the authenticated request and FastAPI conflict response', async t => {
  let forwarded;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    forwarded = { path: new URL(url).pathname, cookie: init.headers.get('cookie'),
      origin: init.headers.get('origin'), body: JSON.parse(await new Response(init.body).text()) };
    return Response.json({ error: 'Revision changed', code: 'revision_conflict' }, { status: 409 });
  });
  const response = await handler(new Request('http://localhost:3000' + path, {
    method: 'POST',
    headers: { Cookie: 'drawn.session=test-only', Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: 'ignored-by-transport' }) });
  assert.deepEqual(forwarded, { path, cookie: 'drawn.session=test-only', origin: 'http://localhost:3000', body });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'Revision changed', code: 'revision_conflict' });
});
