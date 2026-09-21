import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const HELP = [
  'FastAPI를 먼저 실행해 주세요: backend/.venv/Scripts/python.exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000',
  'PostgreSQL과 APP_BASE_URL 설정: docs/FASTAPI_MIGRATION.md',
  'Docker 전체 앱이 실행 중이면 http://localhost:3000 에서 바로 이용할 수 있습니다.',
  'Docker API 주소로 자동 전환하지 않습니다. 다른 API 주소는 API_INTERNAL_URL로 지정하세요.',
].join('\n');

function selectedSettings(cwd, env, readFile) {
  const settings = {};
  for (const file of ['.env.local', '.env.backend.local']) {
    let contents;
    try { contents = readFile(resolve(cwd, file), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    // Load only routing settings; never copy backend credentials into the frontend process.
    for (const [key, value] of Object.entries(parseEnv(contents))) {
      if (['APP_BASE_URL', 'API_INTERNAL_URL'].includes(key.toUpperCase())) settings[key.toUpperCase()] = value;
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (['APP_BASE_URL', 'API_INTERNAL_URL'].includes(key.toUpperCase())) settings[key.toUpperCase()] = value;
  }
  return settings;
}

function option(args, long, short, fallback) {
  let value = fallback;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === long || args[index] === short) value = args[++index];
    else if (args[index].startsWith(`${long}=`)) value = args[index].slice(long.length + 1);
  }
  return value;
}

function origin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid origin');
  return url;
}

async function launch(cwd, args, env, spawnProcess, error) {
  return await new Promise((done) => {
    let child;
    try {
      child = spawnProcess(process.execPath, [resolve(cwd, 'node_modules/vinext/dist/cli.js'), 'dev', ...args],
        { cwd, env, stdio: 'inherit', shell: false });
    } catch {
      error('프런트 개발 서버를 시작하지 못했습니다. npm ci로 의존성을 확인해 주세요.');
      done(1); return;
    }
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    const cleanup = () => {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
    };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    child.once('error', () => {
      cleanup(); error('프런트 개발 서버를 시작하지 못했습니다. npm ci로 의존성을 확인해 주세요.'); done(1);
    });
    child.once('exit', (code, signal) => { cleanup(); done(code ?? (signal === 'SIGINT' ? 130 : 1)); });
  });
}

/** Check the separate local FastAPI process before opening a disconnected frontend. */
export async function runDev({ args = process.argv.slice(2), cwd = process.cwd(), env = process.env,
  readFile = readFileSync, fetcher = fetch, spawnProcess = spawn, log = console.log, error = console.error } = {}) {
  if (args.includes('--help') || args.includes('-h')) return await launch(cwd, args, env, spawnProcess, error);
  let backend, app, port, hostname;
  try {
    const settings = selectedSettings(cwd, env, readFile);
    backend = origin(settings.API_INTERNAL_URL || 'http://127.0.0.1:8000');
    app = origin(settings.APP_BASE_URL || 'http://localhost:3000');
    port = Number(option(args, '--port', '-p', '3000'));
    hostname = option(args, '--hostname', '-H', 'localhost');
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !hostname) throw new Error('invalid address');
  } catch {
    error('개발 주소 설정이 잘못되었습니다. APP_BASE_URL/API_INTERNAL_URL은 자격증명 없는 origin, --port는 고정 포트여야 합니다.');
    return 2;
  }
  const appPort = Number(app.port || (app.protocol === 'https:' ? 443 : 80));
  const hostMatches = hostname === app.hostname || ['0.0.0.0', '::'].includes(hostname)
    || (LOOPBACK.has(hostname) && LOOPBACK.has(app.hostname));
  if (app.protocol !== 'http:' || port !== appPort || !hostMatches) {
    error(`개발 서버 주소와 APP_BASE_URL(${app.origin})이 다릅니다. 로그인 반환 주소와 요청 origin이 같아야 합니다.`);
    error('프런트 --port/--hostname과 FastAPI의 APP_BASE_URL을 맞춘 뒤 다시 실행해 주세요.');
    return 2;
  }
  const sameHost = backend.hostname === app.hostname || (LOOPBACK.has(backend.hostname) && LOOPBACK.has(app.hostname));
  if (sameHost && Number(backend.port || (backend.protocol === 'https:' ? 443 : 80)) === port) {
    error('API_INTERNAL_URL이 프런트와 같은 포트를 가리킵니다. 프록시가 반복되지 않도록 별도 FastAPI 주소를 지정해 주세요.');
    return 2;
  }
  let health;
  try {
    const response = await fetcher(new URL('/api/health/ready', backend),
      { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) });
    health = await response.json();
    if (![200, 503].includes(response.status) || health.database !== 'ready' || typeof health.model?.ready !== 'boolean') {
      throw new Error('backend not ready');
    }
  } catch {
    error(`FastAPI 준비 상태를 확인하지 못했습니다: ${backend.origin}\n${HELP}`);
    return 1;
  }
  if (!health.model.ready) error('FastAPI와 DB는 연결됐지만 학습 모델은 준비되지 않았습니다. UI는 실행하며 모델 예측은 준비 후 사용할 수 있습니다.');
  log(`FastAPI 연결 확인. 브라우저 주소: ${app.origin}`);
  log('Google 로그인은 브라우저에서 별도로 확인하세요. 실행 중인 FastAPI의 APP_BASE_URL도 이 주소와 같아야 합니다.');
  return await launch(cwd, args, { ...env, API_INTERNAL_URL: backend.origin }, spawnProcess, error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await runDev();
