import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const DEFAULT_MIGRATIONS = [
  new URL('../../drizzle/0000_agent_public_service.sql', import.meta.url),
  new URL('../../drizzle/0001_agent_atomic_guards.sql', import.meta.url),
];

/** Executes the actual application SQL on SQLite; only the D1 Promise/result interface is adapted. */
export class SQLiteD1Database {
  #database;
  #tail = Promise.resolve();
  #closed = false;

  constructor({ migrations = DEFAULT_MIGRATIONS } = {}) {
    this.#database = new DatabaseSync(':memory:');
    this.#database.exec('PRAGMA foreign_keys = ON;');
    for (const migration of migrations) this.#database.exec(readFileSync(migration, 'utf8'));
  }

  prepare(sql) { return new SQLiteD1Statement(this, sql); }

  exec(sql) { return this._enqueue(() => { this.#database.exec(sql); return { count: 1, duration: 0 }; }); }

  _enqueue(operation) {
    const result = this.#tail.then(() => {
      if (this.#closed) throw new Error('Database already closed');
      return operation();
    });
    this.#tail = result.catch(() => undefined);
    return result;
  }

  _execute(statement, mode) {
    if (statement.database !== this) throw new Error('Statement belongs to another D1 database');
    const compiled = this.#database.prepare(statement.sql);
    if (mode === 'run') {
      const result = compiled.run(...statement.parameters);
      return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    }
    if (mode === 'raw') {
      const columns = compiled.columns().map((column) => column.name);
      compiled.setReturnArrays(true);
      return { columns, rows: compiled.all(...statement.parameters) };
    }
    const results = compiled.all(...statement.parameters).map((row) => ({ ...row }));
    const writes = !/^\s*(?:SELECT|PRAGMA|EXPLAIN)\b/i.test(statement.sql);
    const metadata = writes ? this.#database.prepare('SELECT changes() AS changes, last_insert_rowid() AS last_row_id').get() : { changes: 0 };
    return { success: true, results, meta: { ...metadata } };
  }

  batch(statements) {
    return this._enqueue(() => {
      this.#database.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => this._execute(statement, 'all'));
        this.#database.exec('COMMIT');
        return results;
      } catch (error) {
        this.#database.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async close() {
    await this.#tail;
    if (!this.#closed) { this.#closed = true; this.#database.close(); }
  }
}

class SQLiteD1Statement {
  constructor(database, sql, parameters = []) {
    this.database = database;
    this.sql = sql;
    this.parameters = parameters;
  }
  bind(...parameters) { return new SQLiteD1Statement(this.database, this.sql, parameters); }
  run() { return this.database._enqueue(() => this.database._execute(this, 'run')); }
  all() { return this.database._enqueue(() => this.database._execute(this, 'all')); }
  raw(options = {}) {
    return this.database._enqueue(() => {
      const { columns, rows } = this.database._execute(this, 'raw');
      return options.columnNames ? [columns, ...rows] : rows;
    });
  }
  async first(column) {
    const row = (await this.all()).results[0] ?? null;
    return column == null || row == null ? row : row[column];
  }
}