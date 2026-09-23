import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import test from 'node:test';
import { runDev } from '../scripts/dev.mjs';

async function check({ args = [], env = {}, files = {}, health = { database: 'ready', model: { ready: true } }, failure, status = 200 } = {}) {
  const logs = [], errors = [], requests = [], launches = [];
  const code = await runDev({ args, env, cwd: process.cwd(),
    readFile: (path) => files[path.endsWith('.env.backend.local') ? 'backend' : 'local'] || '',
    fetcher: async (url, init) => {
      requests.push({ url: String(url), init });
      if (failure) throw failure;
      return Response.json(health, { status });
    },
    spawnProcess: (...arguments_) => {
      launches.push(arguments_);
      const child = new EventEmitter(); child.kill = () => {};
      queueMicrotask(() => child.emit('exit', 0)); return child;
    }, log: value => logs.push(value), error: value => errors.push(value),
  });
  return { code, logs, errors, requests, launches };
}

test('unreachable separate API stops startup with diagnosis and never retries or leaks the exception', async () => {
  const result = await check({ failure: new Error('private-token-do-not-log') });
  assert.equal(result.code, 1); assert.equal(result.launches.length, 0); assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].url, 'http://127.0.0.1:8000/api/health/ready');
  assert.match(result.errors.join('\n'), /localhost:3000/);
  assert.match(result.errors.join('\n'), /uvicorn/);
  assert.doesNotMatch(result.errors.join('\n'), /private-token/);
});

test('ready API forwards every Vinext argument through Node without shell and uses the checked backend', async () => {
  const args = ['--port=5173', '--hostname', '127.0.0.1', '--verbose', '--mode', 'development'];
  const result = await check({ args, env: { APP_BASE_URL: 'http://localhost:5173', API_INTERNAL_URL: 'http://127.0.0.1:8123' } });
  assert.equal(result.code, 0);
  const [executable, forwarded, options] = result.launches[0];
  assert.equal(executable, process.execPath);
  assert.deepEqual(forwarded, [resolve('node_modules/vinext/dist/cli.js'), 'dev', ...args]);
  assert.equal(options.shell, false); assert.equal(options.stdio, 'inherit');
  assert.equal(options.env.API_INTERNAL_URL, 'http://127.0.0.1:8123');
  assert.equal(result.requests[0].init.redirect, 'error');
});

test('local routing settings follow backend file then explicit environment precedence without copying secret fields', async () => {
  const result = await check({ args: ['-p', '5173'], env: { API_INTERNAL_URL: 'http://127.0.0.1:8123' },
    files: { local: 'APP_BASE_URL=http://localhost:3000\nOPENAI_API_KEY=private-local-value', backend: 'APP_BASE_URL=http://localhost:5173\nAPI_INTERNAL_URL=http://127.0.0.1:8222\nSESSION_SECRET=private-backend-value' } });
  assert.equal(result.code, 0);
  assert.equal(result.requests[0].url, 'http://127.0.0.1:8123/api/health/ready');
  assert.equal(result.launches[0][2].env.OPENAI_API_KEY, undefined);
  assert.equal(result.launches[0][2].env.SESSION_SECRET, undefined);
  assert.doesNotMatch([...result.logs, ...result.errors].join('\n'), /private-/);
});

test('origin mismatch and self proxy stop before network or launch', async () => {
  for (const options of [
    { args: ['--port', '5173'] },
    { args: ['-H', 'other.test'] },
    { env: { API_INTERNAL_URL: 'http://localhost:3000' } },
    { args: ['--port=0'] },
    { env: { API_INTERNAL_URL: 'http://private-user:private-password@localhost:8000' } },
  ]) {
    const result = await check(options);
    assert.equal(result.code, 2); assert.equal(result.requests.length, 0); assert.equal(result.launches.length, 0);
    assert.doesNotMatch(result.errors.join('\n'), /private-user|private-password/);
  }
});

test('missing model warns but permits UI while a non-FastAPI response does not', async () => {
  const missing = await check({ health: { database: 'ready', model: { ready: false, reason: 'missing' } }, status: 503 });
  assert.equal(missing.code, 0); assert.equal(missing.launches.length, 1); assert.match(missing.errors[0], /모델/);
  const wrong = await check({ health: { status: 'ok' } });
  assert.equal(wrong.code, 1); assert.equal(wrong.launches.length, 0);
});

test('Vinext help remains available without a backend or configuration', async () => {
  const result = await check({ args: ['--help'], failure: new Error('no backend') });
  assert.equal(result.code, 0); assert.equal(result.requests.length, 0); assert.equal(result.launches.length, 1);
});
