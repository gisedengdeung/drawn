import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { SQLiteD1Database } from './helpers/d1.mjs';
import { loadTypeScript } from './helpers/load-typescript.mjs';

const store = await loadTypeScript('lib/agent/server/store.ts');
const source = JSON.parse(readFileSync(new URL('../public/data/design-trees/shard-000.json', import.meta.url), 'utf8'))['2'];
const draft = () => structuredClone(source);
const errorCode = (code, status) => (error) => error.code === code && (status == null || error.status === status);
function database(t) { const db = new SQLiteD1Database(); t.after(() => db.close()); return db; }
async function seedUsage(db, bucket, count, day = store.dayKey()) {
  await db.prepare('INSERT INTO agent_usage(bucket,day,count) VALUES(?,?,?) ON CONFLICT(bucket,day) DO UPDATE SET count=excluded.count').bind(bucket, day, count).run();
}
async function row(db, id) { return db.prepare('SELECT * FROM agent_runs WHERE id=?').bind(id).first(); }
function result(project, answer = 'Stored answer') {
  return { answer, evidence: [], proposals: [], warnings: [], context: { projectId: project.id, revision: project.revision, fingerprint: project.fingerprint } };
}

test('SQLite-backed D1 preserves project and run ownership in get/list/save/cancel', async (t) => {
  const db = database(t);
  const alice = await store.createProject(db, 'alice', 'Alice project', draft(), 'gallery-1');
  const bob = await store.createProject(db, 'bob', 'Bob project', draft(), null);
  assert.equal(alice.revision, 1);
  assert.equal(alice.sourceId, 'gallery-1');
  assert.deepEqual((await store.listProjects(db, 'alice')).map((project) => project.id), [alice.id]);
  assert.deepEqual((await store.listProjects(db, 'bob')).map((project) => project.id), [bob.id]);
  await assert.rejects(store.getProject(db, 'bob', alice.id), errorCode('not_found', 404));
  await assert.rejects(store.saveProject(db, 'bob', alice.id, 1, draft()), errorCode('not_found', 404));
  const id = await store.startRun(db, 'alice', alice, 'qa', 'Explain my design');
  assert.equal((await store.getRun(db, 'alice', id)).projectId, alice.id);
  assert.deepEqual((await store.listRuns(db, 'alice', alice.id)).map((run) => run.id), [id]);
  await assert.rejects(store.getRun(db, 'bob', id), errorCode('not_found', 404));
  await assert.rejects(store.listRuns(db, 'bob', alice.id), errorCode('not_found', 404));
  await assert.rejects(store.cancelRun(db, 'bob', id), errorCode('not_found', 404));
  await store.finishRun(db, 'bob', id, 'completed', result(alice));
  assert.equal((await store.getRun(db, 'alice', id)).status, 'running');
});

test('concurrent compare-and-swap saves admit one revision and preserve exact history', async (t) => {
  const db = database(t);
  const project = await store.createProject(db, 'alice', 'Initial', draft(), null);
  const first = draft(); first.fuselage.length += 1;
  const second = draft(); second.fuselage.length += 2;
  const saves = await Promise.allSettled([
    store.saveProject(db, 'alice', project.id, 1, first, 'First'),
    store.saveProject(db, 'alice', project.id, 1, second, 'Second'),
  ]);
  assert.equal(saves.filter((item) => item.status === 'fulfilled').length, 1);
  const rejected = saves.find((item) => item.status === 'rejected');
  assert.equal(rejected.reason.code, 'stale_revision');
  const saved = await store.getProject(db, 'alice', project.id);
  assert.equal(saved.revision, 2);
  assert.notEqual(saved.fingerprint, project.fingerprint);
  const history = (await db.prepare('SELECT * FROM agent_revisions WHERE project_id=? ORDER BY revision').bind(project.id).all()).results;
  assert.deepEqual(history.map((item) => item.revision), [1, 2]);
  assert.deepEqual(JSON.parse(history[0].draft_json), project.draft);
  assert.deepEqual(JSON.parse(history[1].draft_json), saved.draft);
  assert.equal(history[1].fingerprint, saved.fingerprint);
  await assert.rejects(store.saveProject(db, 'alice', project.id, 1, draft()), errorCode('stale_revision', 409));
  assert.equal((await db.prepare('SELECT count(*) AS n FROM agent_revisions WHERE project_id=?').bind(project.id).first()).n, 2);
});

test('revision history constraint failure rolls back the batched project update with its metadata', async (t) => {
  const db = database(t);
  const project = await store.createProject(db, 'alice', 'Initial', draft(), null);
  await db.prepare('INSERT INTO agent_revisions(project_id,revision,fingerprint,draft_json,created_at) VALUES(?,?,?,?,?)')
    .bind(project.id, 2, 'collision', JSON.stringify(draft()), project.updatedAt).run();
  const changed = draft(); changed.fuselage.length += 2;
  await assert.rejects(store.saveProject(db, 'alice', project.id, 1, changed, 'Should roll back'), /UNIQUE constraint failed/);
  assert.deepEqual(await store.getProject(db, 'alice', project.id), project);
});

test('simultaneous start attempts enforce one active run without charging failed inserts', async (t) => {
  const db = database(t);
  const project = await store.createProject(db, 'alice', 'Design', draft(), null);
  const starts = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => store.startRun(db, 'alice', project, 'qa', `Request ${index}`)));
  assert.equal(starts.filter((item) => item.status === 'fulfilled').length, 1);
  assert.ok(starts.filter((item) => item.status === 'rejected').every((item) => item.reason.code === 'already_running' && item.reason.status === 409));
  const usage = await store.usage(db, 'alice');
  assert.equal(usage.used, 1);
  assert.equal(usage.globalRemaining, store.limits.global - 1);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM agent_runs').first()).n, 1);
});

test('user daily quota admits only its last slot and does not charge rejected attempts', async (t) => {
  const db = database(t);
  const project = await store.createProject(db, 'alice', 'Design', draft(), null);
  await seedUsage(db, 'alice', store.limits.user - 1);
  await seedUsage(db, '*', store.limits.user - 1);
  const starts = await Promise.allSettled(Array.from({ length: 6 }, () => store.startRun(db, 'alice', project, 'qa', 'Last daily slot')));
  assert.equal(starts.filter((item) => item.status === 'fulfilled').length, 1);
  assert.ok(starts.filter((item) => item.status === 'rejected').every((item) => item.reason.code === 'daily_limit'));
  const id = starts.find((item) => item.status === 'fulfilled').value;
  await store.cancelRun(db, 'alice', id);
  await assert.rejects(store.startRun(db, 'alice', project, 'qa', 'Already at limit'), errorCode('daily_limit', 429));
  const usage = await store.usage(db, 'alice');
  assert.equal(usage.used, store.limits.user);
  assert.equal(usage.globalRemaining, store.limits.global - store.limits.user);
});

test('concurrent different users share the same final global daily quota slot', async (t) => {
  const db = database(t);
  const users = ['alice', 'bob', 'carol', 'dan'];
  const projects = await Promise.all(users.map((user) => store.createProject(db, user, user, draft(), null)));
  await seedUsage(db, '*', store.limits.global - 1);
  const starts = await Promise.allSettled(users.map((user, index) => store.startRun(db, user, projects[index], 'qa', 'Global last slot')));
  assert.equal(starts.filter((item) => item.status === 'fulfilled').length, 1);
  assert.ok(starts.filter((item) => item.status === 'rejected').every((item) => item.reason.code === 'daily_limit'));
  const usages = await Promise.all(users.map((user) => store.usage(db, user)));
  assert.equal(usages.reduce((sum, usage) => sum + usage.used, 0), 1);
  assert.ok(usages.every((usage) => usage.globalRemaining === 0));
});

test('expired leases reject work, are cancelled when replaced, and cannot finish late', async (t) => {
  const db = database(t);
  const project = await store.createProject(db, 'alice', 'Design', draft(), null);
  const expired = await store.startRun(db, 'alice', project, 'qa', 'Expires');
  await db.prepare('UPDATE agent_runs SET lease_until=? WHERE id=?').bind(Date.now() - 1, expired).run();
  assert.equal(await store.isCancelled(db, 'alice', expired), true);
  await assert.rejects(store.consumeBudget(db, 'alice', expired, 'tool'), errorCode('budget_or_cancelled', 429));
  const replacement = await store.startRun(db, 'alice', project, 'qa', 'New work');
  assert.equal((await row(db, expired)).cancel_requested, 1);
  assert.equal((await store.getRun(db, 'alice', expired)).status, 'cancelled');
  assert.equal((await store.getRun(db, 'alice', replacement)).status, 'running');
  await store.finishRun(db, 'alice', expired, 'completed', result(project, 'Late old response'));
  assert.equal((await store.getRun(db, 'alice', expired)).status, 'cancelled');
  assert.equal((await store.getRun(db, 'alice', expired)).result, null);
  assert.equal((await store.usage(db, 'alice')).used, 2);
});

test('failed batched replacement rolls back expired-lease cleanup and quota effects', async (t) => {
  const db = database(t);
  const project = await store.createProject(db, 'alice', 'Design', draft(), null);
  const id = await store.startRun(db, 'alice', project, 'qa', 'Expires');
  await db.prepare('UPDATE agent_runs SET lease_until=? WHERE id=?').bind(Date.now() - 1, id).run();
  await seedUsage(db, 'alice', store.limits.user);
  const before = await row(db, id);
  await assert.rejects(store.startRun(db, 'alice', project, 'qa', 'Blocked replacement'), errorCode('daily_limit', 429));
  assert.deepEqual(await row(db, id), before);
  assert.equal((await store.usage(db, 'alice')).globalRemaining, store.limits.global - 1);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM agent_runs').first()).n, 1);
});

test('shared 4/20/40 call budgets count atomically and reject another user', async (t) => {
  const db = database(t);
  const project = await store.createProject(db, 'alice', 'Design', draft(), null);
  const id = await store.startRun(db, 'alice', project, 'qa', 'Budget tests');
  for (const [kind, column] of [['llm', 'llm_calls'], ['tool', 'tool_calls'], ['provider', 'provider_calls']]) {
    await assert.rejects(store.consumeBudget(db, 'bob', id, kind), errorCode('budget_or_cancelled', 429));
    const calls = await Promise.allSettled(Array.from({ length: store.limits[kind] + 7 }, () => store.consumeBudget(db, 'alice', id, kind)));
    assert.equal(calls.filter((item) => item.status === 'fulfilled').length, store.limits[kind], kind);
    assert.ok(calls.filter((item) => item.status === 'rejected').every((item) => item.reason.code === 'budget_or_cancelled'));
    assert.equal((await row(db, id))[column], store.limits[kind]);
  }
  assert.equal((await store.usage(db, 'alice')).used, 1);
});

test('cancellation and completed state prevent late result overwrite and additional calls', async (t) => {
  const db = database(t);
  const project = await store.createProject(db, 'alice', 'Design', draft(), null);
  const cancelled = await store.startRun(db, 'alice', project, 'qa', 'Cancel me');
  await store.cancelRun(db, 'alice', cancelled);
  await store.finishRun(db, 'alice', cancelled, 'completed', result(project, 'Late response'));
  assert.equal((await store.getRun(db, 'alice', cancelled)).status, 'cancelled');
  assert.equal((await store.getRun(db, 'alice', cancelled)).result, null);
  assert.equal(await store.isCancelled(db, 'alice', cancelled), true);
  await assert.rejects(store.consumeBudget(db, 'alice', cancelled, 'llm'), errorCode('budget_or_cancelled'));
  const completed = await store.startRun(db, 'alice', project, 'qa', 'Complete me');
  const answer = result(project);
  await store.finishRun(db, 'alice', completed, 'completed', answer);
  await store.finishRun(db, 'alice', completed, 'failed', result(project, 'Must not overwrite'));
  await store.cancelRun(db, 'alice', completed);
  assert.equal((await store.getRun(db, 'alice', completed)).status, 'completed');
  assert.deepEqual((await store.getRun(db, 'alice', completed)).result, answer);
  await assert.rejects(store.consumeBudget(db, 'alice', completed, 'provider'), errorCode('budget_or_cancelled'));
  assert.equal(await store.isCancelled(db, 'alice', 'missing-run'), true);
});

test('KST day boundary and new-day quota reset are independent of the host timezone', async (t) => {
  assert.equal(store.dayKey(Date.parse('2026-09-20T14:59:59.999Z')), '2026-09-20');
  assert.equal(store.dayKey(Date.parse('2026-09-20T15:00:00.000Z')), '2026-09-21');
  assert.equal(store.dayKey(Date.parse('2026-12-31T15:00:00.000Z')), '2027-01-01');
  const db = database(t);
  const previousDay = store.dayKey(Date.now() - 86400000);
  await seedUsage(db, 'alice', store.limits.user, previousDay);
  await seedUsage(db, '*', store.limits.global, previousDay);
  const before = await store.usage(db, 'alice');
  assert.equal(before.used, 0);
  assert.equal(before.globalRemaining, store.limits.global);
  assert.equal(before.resetAt, new Date(Date.parse(`${store.dayKey()}T00:00:00+09:00`) + 86400000).toISOString());
  const project = await store.createProject(db, 'alice', 'Design', draft(), null);
  await store.startRun(db, 'alice', project, 'qa', 'New day');
  assert.equal((await store.usage(db, 'alice')).used, 1);
});
test('expired response cannot complete even before another run replaces its lease', async (t) => {
  const db = database(t);
  const project = await store.createProject(db, 'alice', 'Design', draft(), null);
  const id = await store.startRun(db, 'alice', project, 'qa', 'Long request');
  await db.prepare('UPDATE agent_runs SET lease_until=? WHERE id=?').bind(Date.now() - 1, id).run();
  assert.equal(await store.isCancelled(db, 'alice', id), true);
  const before = await row(db, id);
  await store.finishRun(db, 'alice', id, 'completed', result(project, 'Expired completion'));
  assert.deepEqual(await row(db, id), before);
  assert.equal((await store.getRun(db, 'alice', id)).result, null);
});

test('fresh migrations require no triggers and a failed initial history insert rolls back project creation', async (t) => {
  const db = database(t);
  assert.deepEqual((await db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()).results, []);
  const id = crypto.randomUUID();
  t.mock.method(crypto, 'randomUUID', () => id);
  await db.prepare('INSERT INTO agent_revisions(project_id,revision,fingerprint,draft_json,created_at) VALUES(?,1,?,?,?)')
    .bind(id, 'existing-history-collision', JSON.stringify(draft()), new Date().toISOString()).run();
  await assert.rejects(store.createProject(db, 'alice', 'Must roll back', draft(), null), /UNIQUE constraint failed/);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM agent_projects').first()).n, 0);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM agent_revisions').first()).n, 1);
});

test('failure in the final quota write rolls back the new run, user charge and expired lease cleanup', async (t) => {
  const db = database(t);
  const project = await store.createProject(db, 'alice', 'Design', draft(), null);
  const expired = await store.startRun(db, 'alice', project, 'qa', 'Existing run');
  await db.prepare('UPDATE agent_runs SET lease_until=? WHERE id=?').bind(Date.now() - 1, expired).run();
  await seedUsage(db, 'test-sentinel', 0);
  // A real SQLite constraint fails only on the last (global) UPSERT, after the user charge.
  await db.exec("CREATE UNIQUE INDEX test_fail_global_charge ON agent_usage ((1)) WHERE bucket='test-sentinel' OR (bucket='*' AND count>1);");
  const before = await row(db, expired);
  const usageBefore = (await db.prepare('SELECT * FROM agent_usage ORDER BY bucket,day').all()).results;
  await assert.rejects(store.startRun(db, 'alice', project, 'qa', 'Must roll back'), /UNIQUE constraint failed/);
  assert.deepEqual(await row(db, expired), before);
  assert.deepEqual((await db.prepare('SELECT * FROM agent_usage ORDER BY bucket,day').all()).results, usageBefore);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM agent_runs').first()).n, 1);
});

test('legacy trigger removal preserves existing rows and leaves exactly one history entry and charge per write', async (t) => {
  const db = new SQLiteD1Database({ migrations: [new URL('../drizzle/0000_agent_public_service.sql', import.meta.url)] });
  t.after(() => db.close());
  // Simulate a local database that already applied the original trigger migration.
  await db.exec(`
    CREATE TRIGGER agent_project_initial_revision AFTER INSERT ON agent_projects BEGIN
      INSERT INTO agent_revisions(project_id,revision,fingerprint,draft_json,created_at) VALUES(NEW.id,NEW.revision,NEW.fingerprint,NEW.draft_json,NEW.updated_at);
    END;
    CREATE TRIGGER agent_project_revision AFTER UPDATE OF revision ON agent_projects WHEN NEW.revision<>OLD.revision BEGIN
      INSERT INTO agent_revisions(project_id,revision,fingerprint,draft_json,created_at) VALUES(NEW.id,NEW.revision,NEW.fingerprint,NEW.draft_json,NEW.updated_at);
    END;
    CREATE TRIGGER agent_run_quota BEFORE INSERT ON agent_runs BEGIN
      SELECT CASE WHEN COALESCE((SELECT count FROM agent_usage WHERE bucket=NEW.user_id AND day=NEW.day),0)>=20 THEN RAISE(ABORT,'user_daily_limit') END;
      SELECT CASE WHEN COALESCE((SELECT count FROM agent_usage WHERE bucket='*' AND day=NEW.day),0)>=200 THEN RAISE(ABORT,'global_daily_limit') END;
    END;
    CREATE TRIGGER agent_run_charge AFTER INSERT ON agent_runs BEGIN
      INSERT INTO agent_usage(bucket,day,count) VALUES(NEW.user_id,NEW.day,1) ON CONFLICT(bucket,day) DO UPDATE SET count=count+1;
      INSERT INTO agent_usage(bucket,day,count) VALUES('*',NEW.day,1) ON CONFLICT(bucket,day) DO UPDATE SET count=count+1;
    END;
  `);
  const id = crypto.randomUUID(), runId = crypto.randomUUID(), now = new Date().toISOString();
  await db.prepare('INSERT INTO agent_projects(id,user_id,title,revision,fingerprint,draft_json,source_id,updated_at) VALUES(?,?,?,1,?,?,?,?)')
    .bind(id, 'alice', 'Legacy project', 'legacy-fingerprint', JSON.stringify(draft()), 'legacy-source', now).run();
  await db.prepare("INSERT INTO agent_runs(id,user_id,project_id,revision,mode,status,message,created_at,updated_at,lease_until,day) VALUES(?,?,?,1,'qa','running','Legacy run',?,?,?,?)")
    .bind(runId, 'alice', id, now, now, Date.now() + 300000, store.dayKey()).run();
  const before = await store.getProject(db, 'alice', id), runBefore = await row(db, runId);
  await db.exec(readFileSync(new URL('../drizzle/0003_remove_legacy_agent_triggers.sql', import.meta.url), 'utf8'));
  assert.deepEqual((await db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()).results, []);
  assert.deepEqual(await store.getProject(db, 'alice', id), before);
  assert.deepEqual(await row(db, runId), runBefore);
  assert.equal((await store.usage(db, 'alice')).used, 1);
  const changed = draft(); changed.fuselage.length += 1;
  const saved = await store.saveProject(db, 'alice', id, 1, changed);
  assert.equal(saved.revision, 2);
  assert.deepEqual((await db.prepare('SELECT revision FROM agent_revisions WHERE project_id=? ORDER BY revision').bind(id).all()).results.map((entry) => entry.revision), [1, 2]);
  await store.cancelRun(db, 'alice', runId);
  await store.startRun(db, 'alice', saved, 'qa', 'After migration');
  assert.equal((await store.usage(db, 'alice')).used, 2);
  assert.equal((await store.usage(db, 'alice')).globalRemaining, store.limits.global - 2);
  const created = await store.createProject(db, 'bob', 'New project', draft(), null);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM agent_revisions WHERE project_id=?').bind(created.id).first()).n, 1);
});
test('at the exact lease deadline a run is cancelled, cannot finish and can be replaced', async (t) => {
  const db = database(t);
  const timestamp = Date.now();
  t.mock.method(Date, 'now', () => timestamp);
  const project = await store.createProject(db, 'alice', 'Design', draft(), null);
  const expired = await store.startRun(db, 'alice', project, 'qa', 'Deadline');
  await db.prepare('UPDATE agent_runs SET lease_until=? WHERE id=?').bind(timestamp, expired).run();
  assert.equal(await store.isCancelled(db, 'alice', expired), true);
  assert.equal((await store.getRun(db, 'alice', expired)).status, 'cancelled');
  assert.equal(await store.finishRun(db, 'alice', expired, 'completed', result(project)), false);
  await assert.rejects(store.consumeBudget(db, 'alice', expired, 'tool'), errorCode('budget_or_cancelled'));
  const replacement = await store.startRun(db, 'alice', project, 'qa', 'After deadline');
  assert.equal((await row(db, expired)).cancel_requested, 1);
  assert.equal((await store.getRun(db, 'alice', replacement)).status, 'running');
  assert.equal((await store.usage(db, 'alice')).used, 2);
});