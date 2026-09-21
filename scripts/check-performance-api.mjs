#!/usr/bin/env node
/** Check the local learned model independently of Google login and OpenAI billing. */
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string', default: 'http://localhost:3000' },
    'design-id': { type: 'string', default: '17297' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (values.help) {
  console.log('Usage: npm run model:check -- [--base-url http://localhost:3000] [--design-id 17297]');
  console.log('Checks model verification and actual prediction. No OpenAI request or login is used.');
  process.exit(0);
}

const targets = ['drag', 'lift', 'thrust', 'pitch', 'power', 'current', 'flightTime', 'distance'];
const speeds = [0, 20, 49];
async function main() {
  const base = new URL(values['base-url']);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('Use an HTTP(S) base URL without credentials.');
  }
  const designId = Number(values['design-id']);
  if (!Number.isSafeInteger(designId) || designId < 1) throw new Error('design-id must be a positive integer.');
  async function request(path, payload) {
    const response = await fetch(new URL(path, base), {
      method: payload ? 'POST' : 'GET',
      headers: payload ? { 'Content-Type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = typeof data?.error === 'string' ? data.error : 'Unexpected API response';
      throw new Error(`${path}: HTTP ${response.status} ${data?.code ?? ''} ${message}`);
    }
    return data;
  }

  const model = await request('/api/performance/model');
  if (model?.ready !== true || model?.verification?.passed !== true || !model.modelVersion) {
    throw new Error(`Model is not verified: ${model?.reason ?? 'invalid_status'}`);
  }
  const result = await request('/api/performance/predict', { designId, speeds });
  if (result?.modelVersion !== model.modelVersion || result?.source !== 'baseline-conditioned'
      || result?.designId !== designId || !result.fingerprint
      || !Array.isArray(result.predictions) || result.predictions.length !== speeds.length) {
    throw new Error('Prediction metadata does not match the selected design/model.');
  }
  const seen = new Set();
  for (const row of result.predictions) {
    if (!speeds.includes(row.speed) || seen.has(row.speed)
        || targets.some((key) => row[key] !== null && !Number.isFinite(row[key]))
        || targets.some((key) => !Number.isFinite(row.rawPredictions?.[key]))) {
      throw new Error('Prediction is missing a requested speed or contains invalid model outputs.');
    }
    seen.add(row.speed);
  }
  console.log(`PASS: ${model.modelVersion}; ${model.verification.rows} verified samples; design #${designId}`);
  console.table(result.predictions.map((row) => Object.fromEntries(
    ['speed', ...targets].map((key) => [key, row[key] === null ? 'unavailable' : Number(row[key].toFixed(3))]),
  )));
  console.log('Source: local trained model. OpenAI credits are not used.');
  console.log('Mass, maximum speed and flight feasibility are not predicted by this model.');
  if (result.outsideTrainingRange?.length) console.log('Outside training range:', result.outsideTrainingRange.join(', '));
  if (result.unknownCategory?.length) console.log('Unknown categories:', result.unknownCategory.join(', '));
}
main().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : 'Unknown error'}`);
  process.exitCode = 1;
});
