import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTypeScript } from './helpers/load-typescript.mjs';

const {
  PERFORMANCE_METRICS,
  PerformanceApiError,
  formatValidSpeedRanges,
  parsePerformanceResult,
  performanceRequestKey,
  performanceFailure,
  requestPerformance,
} = await loadTypeScript('lib/performance-client.ts');

const request = { designId: 20015, speeds: [0, 20, 50] };
const result = () => ({
  modelVersion: 'dongha-mlp-test',
  source: 'baseline-conditioned',
  fingerprint: 'baseline-20015-test',
  designId: 20015,
  predictions: request.speeds.map((speed) => ({
    speed, drag: 0, lift: -2, thrust: 12.5, pitch: -4, power: 100,
    current: 2, flightTime: 30, distance: speed * 30, warnings: [],
  })),
  warnings: ['Baseline-conditioned prediction; validity is not predicted.'],
  unsupportedInputs: [],
  outsideTrainingRange: [],
  unknownCategory: [],
});

test('all eight model outputs retain zero and negative physical quantities', () => {
  const response = parsePerformanceResult(result(), request);
  assert.equal(PERFORMANCE_METRICS.length, 8);
  assert.equal(response.predictions[0].drag, 0);
  assert.equal(response.predictions[0].lift, -2);
  assert.equal(response.predictions[0].pitch, -4);
  assert.equal(response.predictions[0].distance, 0);
});

test('malformed, partial and wrong-design responses cannot appear as current predictions', () => {
  for (const mutate of [
    (value) => { value.designId = 411; },
    (value) => { value.source = 'mock'; },
    (value) => { value.modelVersion = ''; },
    (value) => { value.fingerprint = ''; },
    (value) => { value.predictions.pop(); },
    (value) => { value.predictions[1].speed = 0; },
    (value) => { value.predictions[1].power = Number.NaN; },
    (value) => { delete value.predictions[1].flightTime; },
    (value) => { value.unsupportedInputs = [42]; },
    (value) => { value.predictions[0].warnings = null; },
  ]) {
    const value = result();
    mutate(value);
    assert.throws(() => parsePerformanceResult(value, request), { code: 'invalid_response' });
  }
});

test('request sends the exact edited draft to the same-origin endpoint', async () => {
  const controller = new AbortController();
  const draft = { baselineId: 20015, segments: [{ id: 'arm', offset: 12 }] };
  const input = { ...request, draft };
  let received;
  const response = await requestPerformance(input, controller.signal, async (url, options) => {
    received = { url, options };
    return Response.json(result());
  });
  assert.equal(received.url, '/api/performance/predict');
  assert.equal(received.options.credentials, 'same-origin');
  assert.equal(received.options.signal, controller.signal);
  assert.deepEqual(JSON.parse(received.options.body), input);
  assert.equal(response.modelVersion, 'dongha-mlp-test');
});

test('unsupported input and missing model remain explicit errors without heuristic fallback', async () => {
  for (const [status, code] of [[422, 'unsupported_input'], [503, 'model_not_ready']]) {
    await assert.rejects(
      requestPerformance(request, new AbortController().signal, async () =>
        Response.json({ error: 'Model unavailable', code }, { status })),
      (error) => error instanceof PerformanceApiError && error.status === status && error.code === code,
    );
  }
  await assert.rejects(
    requestPerformance(request, new AbortController().signal, async () => new Response('unavailable', { status: 503 })),
    { code: 'prediction_failed', status: 503 },
  );
});

test('cancelled old response is rejected even if the transport ignores its abort signal', async () => {
  const first = new AbortController();
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const oldRequest = requestPerformance(request, first.signal, () => delayed);
  first.abort();
  const fresh = await requestPerformance(request, new AbortController().signal, async () => Response.json(result()));
  release(Response.json({ ...result(), modelVersion: 'old-response' }));
  await assert.rejects(oldRequest, { name: 'AbortError' });
  assert.equal(fresh.modelVersion, 'dongha-mlp-test');
});

test('cancellation during JSON decoding also rejects the old response', async () => {
  const controller = new AbortController();
  await assert.rejects(requestPerformance(request, controller.signal, async () => ({
    ok: true,
    status: 200,
    async json() { controller.abort(); return result(); },
  })), { name: 'AbortError' });
});

test('request identity changes for geometry-only edits as well as design or speed changes', () => {
  const base = { ...request, draft: { baselineId: 20015, segments: [{ offset: 0 }] } };
  assert.notEqual(performanceRequestKey(base), performanceRequestKey({ ...base, draft: { baselineId: 20015, segments: [{ offset: 5 }] } }));
  assert.notEqual(performanceRequestKey(base), performanceRequestKey({ ...base, designId: 411 }));
  assert.notEqual(performanceRequestKey(base), performanceRequestKey({ ...base, speeds: [20] }));
});

test('original valid-speed labels preserve gaps, duplicates, missing hover and empty masks', () => {
  assert.equal(formatValidSpeedRanges([0, 1, 4, 5, 9]), '0–1, 4–5, 9 m/s');
  assert.equal(formatValidSpeedRanges([5, 4, 4]), '4–5 m/s');
  assert.equal(formatValidSpeedRanges([]), '없음');
});


test('physical-bound nulls and named input warnings remain explicit', () => {
  const value = result();
  value.predictions[0].flightTime = null;
  value.predictions[0].warnings = ['physical_bound:flightTime'];
  value.outsideTrainingRange = ['speed'];
  value.unknownCategory = ['motor_type'];
  const parsed = parsePerformanceResult(value, request);
  assert.equal(parsed.predictions[0].flightTime, null);
  assert.deepEqual(parsed.outsideTrainingRange, ['speed']);
  assert.deepEqual(parsed.unknownCategory, ['motor_type']);
});

test('structured FastAPI error messages preserve the actionable model error', async () => {
  await assert.rejects(requestPerformance(request, new AbortController().signal, async () =>
    Response.json({ error: { code: 'model_input_unavailable', message: 'Valid hover data unavailable' } }, { status: 422 })),
    { code: 'model_input_unavailable', message: 'Valid hover data unavailable' });
});


test('permanent model input rejection preserves its cause and cannot offer an unchanged-input retry', () => {
  const unavailable = performanceFailure(new PerformanceApiError('Valid hover data unavailable', 'model_input_unavailable', 422));
  assert.deepEqual(unavailable, {
    message: 'Valid hover data unavailable', code: 'model_input_unavailable', status: 422, retryable: false,
  });
  assert.equal(performanceFailure(new PerformanceApiError('Bad geometry', 'model_input_invalid', 422)).retryable, false);
  assert.equal(performanceFailure(new PerformanceApiError('Model loading', 'model_not_ready', 503)).retryable, true);
  const network = performanceFailure(new TypeError('Failed to fetch'));
  assert.deepEqual(network, { message: 'Failed to fetch', code: null, status: null, retryable: true });
});
