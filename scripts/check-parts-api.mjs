import { pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONFIG_HELP = [
  'Start the local app with authentication, D1 and AliExpress credentials configured, then sign in and save a project.',
  'Set PARTS_SMOKE_SESSION_COOKIE to the signed-in browser request Cookie header (keep it private).',
  'Set PARTS_SMOKE_PROJECT_ID and PARTS_SMOKE_REVISION to the saved project ID and current positive revision.',
  'Optional PARTS_SMOKE_BASE_URL defaults to http://localhost:5173; only a local origin is allowed.',
  'Run npm run parts:check. An accepted run uses 1 daily Agent run. There are no automatic retries.',
  'After a failure or timeout, inspect the Agent history before manually running this command again.',
].join('\n');

function configuration(env) {
  const base = new URL(env.PARTS_SMOKE_BASE_URL || 'http://localhost:5173');
  const projectId = env.PARTS_SMOKE_PROJECT_ID?.trim();
  const revisionText = env.PARTS_SMOKE_REVISION?.trim();
  const cookie = env.PARTS_SMOKE_SESSION_COOKIE?.trim();
  const revision = Number(revisionText);
  if (!['http:', 'https:'].includes(base.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('local origin required');
  if (!projectId || !UUID.test(projectId) || !revisionText || !/^[1-9]\d*$/.test(revisionText)
    || !Number.isSafeInteger(revision) || !cookie || !cookie.includes('=') || /[\r\n]/.test(cookie)) throw new Error('missing or invalid configuration');
  return { base, projectId, revision, cookie };
}

async function httpFailure(response, error) {
  // Never print raw responses, credentials or provider exception messages.
  error(`Local API returned HTTP ${response.status}.`);
  if ([400, 401, 403, 404, 409, 429, 503].includes(response.status)) {
    error('Check login, project ownership/current revision, server configuration and the Agent run limit/history.');
    return 2;
  }
  return 1;
}

async function readEvents(response, consume) {
  if (!response.body || !response.headers.get('content-type')?.startsWith('application/x-ndjson')) throw new Error('missing event stream');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', total = 0, complete = false;
  const line = (value) => { if (value.trim()) consume(JSON.parse(value)); };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { pending += decoder.decode(); line(pending); complete = true; break; }
      total += value.byteLength;
      if (total > 8 * 1024 * 1024) throw new Error('event stream too large');
      pending += decoder.decode(value, { stream: true });
      let end;
      while ((end = pending.indexOf('\n')) >= 0) { line(pending.slice(0, end)); pending = pending.slice(end + 1); }
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Runs one authenticated lookup against the server's saved project BOM; never retries. */
export async function runPartsSmoke({ env = process.env, fetcher = fetch, log = console.log, error = console.error } = {}) {
  let config;
  try { config = configuration(env); }
  catch { error('Missing or invalid local smoke-test configuration.\n' + CONFIG_HELP); return 2; }
  const { base, projectId, revision, cookie } = config;
  // Redact the explicit cookie even if a malformed server response echoes it in a display field.
  const secrets = [cookie, ...cookie.split(';').map((part) => part.slice(part.indexOf('=') + 1).trim()).filter((value) => value.length >= 8)];
  const print = (value) => log(secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value));
  const headers = { Cookie: cookie, Origin: base.origin };
  let submitted = false;
  try {
    const response = await fetcher(new URL(`/api/projects/${projectId}`, base), {
      headers, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return await httpFailure(response, error);
    const project = await response.json();
    if (project.id !== projectId || project.revision !== revision || typeof project.fingerprint !== 'string' || !project.fingerprint) {
      error('The saved project does not match PARTS_SMOKE_PROJECT_ID/PARTS_SMOKE_REVISION. Refresh its values before running again. No run was submitted.');
      return 2;
    }
    print(`Checking saved project ${projectId}, revision ${revision}. An accepted request uses 1 daily Agent run; no automatic retries.`);
    submitted = true;
    const run = await fetcher(new URL('/api/agent/run', base), {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, redirect: 'error', cache: 'no-store',
      body: JSON.stringify({ projectId, revision, mode: 'parts', message: 'Check AliExpress prices and links for this saved project.', locks: [] }),
      signal: AbortSignal.timeout(250_000),
    });
    if (!run.ok) return await httpFailure(run, error);
    let result, runId, failed = false, progress = 0;
    await readEvents(run, (event) => {
      if (!event || !['start', 'progress', 'result', 'error'].includes(event.type)) throw new Error('invalid event');
      if (event.runId) {
        if (!UUID.test(event.runId) || (runId && runId !== event.runId)) throw new Error('mismatched run');
        if (!runId) { runId = event.runId; print(`Agent run ${runId}`); }
      }
      if (event.type === 'progress') print(`Parts lookup is running (${++progress} progress events).`);
      if (event.type === 'error') failed = true;
      if (event.type === 'result') { if (result) throw new Error('duplicate result'); result = event.result; }
    });
    if (failed || !result) throw new Error('run did not finish');
    if (result.context?.projectId !== projectId || result.context.revision !== revision || result.context.fingerprint !== project.fingerprint
      || result.quote?.snapshot?.fingerprint !== project.fingerprint || !Array.isArray(result.quote.lines)) throw new Error('mismatched quote');
    const lines = result.quote.lines;
    print(JSON.stringify({ projectId, revision, runId, fingerprint: project.fingerprint, lines: lines.map((line) => ({
      kind: line.item.kind, model: line.item.model, quantity: line.item.quantity, status: line.result?.status ?? 'incomplete',
      offers: line.result?.offers.map((offer) => ({ productId: offer.productId, url: offer.url, promotionUrl: offer.promotionUrl,
        priceKind: offer.priceKind ?? 'listing', optionVerified: offer.optionVerified, optionLabel: offer.optionLabel,
        packPrice: offer.packPrice, packQuantity: offer.packQuantity, currency: offer.currency, retrievedAt: offer.retrievedAt })) ?? [],
    })) }, null, 2));
    if (lines.some((line) => ['not_configured', 'permission_denied'].includes(line.result?.status))) {
      error('Configure ALIEXPRESS_APP_KEY / ALIEXPRESS_APP_SECRET and the required API permissions on the local server. This accepted run used 1 daily run.');
      return 2;
    }
    if (!lines.length || lines.some((line) => !['ok', 'not_found'].includes(line.result?.status))
      || !lines.some((line) => line.result?.offers.length)) {
      error('The lookup did not return a complete set of API responses with at least one product offer. Inspect the saved run; no automatic retry was made.');
      return 1;
    }
    print('Lookup complete. Listing prices and unverified options are not confirmed purchase totals.');
    return 0;
  } catch {
    error(submitted
      ? 'The lookup could not be completed. The request may have used 1 daily run; inspect Agent history before any manual retry. No automatic retry was made.'
      : 'Could not read the saved project. Check the local app and its configuration. No run was submitted.');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runPartsSmoke();