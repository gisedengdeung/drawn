import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const migrationRoot = new URL('../drizzle/', import.meta.url);
const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', migrationRoot), 'utf8'));
const migrations = journal.entries.map(entry => ({
  name: `${entry.tag}.sql`,
  sql: readFileSync(new URL(`${entry.tag}.sql`, migrationRoot), 'utf8'),
}));
const schema = database => database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
  .all().map(row => ({ ...row, sql: row.sql?.trim().replace(/\s+/g, ' ') }));

test('journal migrations produce the same schema through deployment-compatible semicolon splitting', t => {
  const whole = new DatabaseSync(':memory:');
  const split = new DatabaseSync(':memory:');
  t.after(() => { whole.close(); split.close(); });
  whole.exec('PRAGMA foreign_keys=ON');
  split.exec('PRAGMA foreign_keys=ON');
  assert.ok(migrations.length > 0);
  for (const migration of migrations) {
    whole.exec(migration.sql);
    const statements = migration.sql.split(';');
    statements.forEach((statement, index) => {
      if (!statement.trim()) return;
      assert.doesNotThrow(() => split.exec(statement),
        `${migration.name}, semicolon-delimited statement ${index + 1}: deployment migrations must not require compound SQL parsing`);
    });
    assert.deepEqual(schema(split), schema(whole), `schema after ${migration.name}`);
  }
  const names = new Set(schema(split).map(entry => entry.name));
  for (const required of ['user', 'session', 'agent_projects', 'agent_revisions', 'agent_runs', 'agent_proposals', 'agent_quotes', 'agent_usage', 'agent_one_running']) {
    assert.ok(names.has(required), `${required} must remain available after deployment migrations`);
  }
  // Quota and history writes are application batches; no hidden trigger may double-charge a migrated database.
  assert.deepEqual(schema(split).filter(entry => entry.type === 'trigger'), []);
  assert.equal(split.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});