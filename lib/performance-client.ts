import type { DesignDraft } from './drawn-types';

export const PERFORMANCE_SPEEDS = Array.from({ length: 51 }, (_, speed) => speed);
export const PERFORMANCE_METRICS = ['drag', 'lift', 'thrust', 'pitch', 'power', 'current', 'flightTime', 'distance'] as const;
export type PerformanceMetric = typeof PERFORMANCE_METRICS[number];
export type PerformancePrediction = Record<PerformanceMetric, number | null> & { speed: number; warnings: string[] };
export type PerformanceRequest = { designId: number; draft?: DesignDraft; speeds?: number[] };
export type PerformanceResult = {
  modelVersion: string;
  source: 'baseline-conditioned';
  fingerprint: string;
  designId: number;
  predictions: PerformancePrediction[];
  warnings: string[];
  unsupportedInputs: string[];
  outsideTrainingRange: string[];
  unknownCategory: string[];
};

export class PerformanceApiError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number) {
    super(message);
    this.name = 'PerformanceApiError';
  }
}

export type PerformanceFailure = {
  message: string;
  code: string | null;
  status: number | null;
  retryable: boolean;
};

/** Input rejections require a changed design; transport/model availability failures can be retried. */
export function performanceFailure(reason: unknown): PerformanceFailure {
  return {
    message: reason instanceof Error ? reason.message : 'AI 예측 서버에 연결하지 못했습니다.',
    code: reason instanceof PerformanceApiError ? reason.code : null,
    status: reason instanceof PerformanceApiError ? reason.status : null,
    retryable: !(reason instanceof PerformanceApiError && reason.status === 422),
  };
}

export function performanceRequestKey(request: PerformanceRequest): string {
  return JSON.stringify([request.designId, request.draft ?? null, request.speeds ?? PERFORMANCE_SPEEDS]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Reject malformed or mismatched results before displaying them for an edited design. */
export function parsePerformanceResult(value: unknown, request: PerformanceRequest): PerformanceResult {
  const invalid = () => new PerformanceApiError('AI 예측 응답을 확인할 수 없습니다. 다시 시도해 주세요.', 'invalid_response', 502);
  if (!isRecord(value) || value.source !== 'baseline-conditioned' || value.designId !== request.designId
    || typeof value.modelVersion !== 'string' || !value.modelVersion || typeof value.fingerprint !== 'string' || !value.fingerprint
    || !stringList(value.warnings) || !stringList(value.unsupportedInputs)
    || !stringList(value.outsideTrainingRange) || !stringList(value.unknownCategory)
    || !Array.isArray(value.predictions)) throw invalid();
  const expected = request.speeds ?? PERFORMANCE_SPEEDS;
  const seen = new Set<number>();
  for (const row of value.predictions) {
    if (!isRecord(row) || typeof row.speed !== 'number' || !expected.includes(row.speed) || seen.has(row.speed)
      || !stringList(row.warnings)
      || PERFORMANCE_METRICS.some((metric) => row[metric] !== null && (typeof row[metric] !== 'number' || !Number.isFinite(row[metric])))) throw invalid();
    seen.add(row.speed);
  }
  if (seen.size !== new Set(expected).size) throw invalid();
  return value as PerformanceResult;
}

export async function requestPerformance(
  request: PerformanceRequest,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<PerformanceResult> {
  signal.throwIfAborted();
  const response = await fetcher('/api/performance/predict', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify(request),
  });
  signal.throwIfAborted();
  const value: unknown = await response.json().catch(() => null);
  signal.throwIfAborted();
  if (!response.ok) {
    const providerError = isRecord(value) && isRecord(value.error) ? value.error : null;
    const code = isRecord(value) && typeof value.code === 'string' ? value.code
      : providerError && typeof providerError.code === 'string' ? providerError.code : 'prediction_failed';
    const message = isRecord(value) && typeof value.error === 'string' ? value.error
      : providerError && typeof providerError.message === 'string' ? providerError.message
      : response.status === 503 ? 'AI 모델이 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.'
      : response.status === 422 ? '현재 설계는 이 모델의 입력 조건을 지원하지 않습니다.'
      : 'AI 예측 서버에 연결하지 못했습니다. 다시 시도해 주세요.';
    throw new PerformanceApiError(message, code, response.status);
  }
  return parsePerformanceResult(value, request);
}

/** Preserve gaps in the original trim mask instead of implying a continuous flight range. */
export function formatValidSpeedRanges(speeds: number[]): string {
  const sorted = [...new Set(speeds)].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return '없음';
  const ranges: string[] = [];
  let start = sorted[0];
  let end = start;
  for (const speed of sorted.slice(1)) {
    if (speed === end + 1) end = speed;
    else { ranges.push(start === end ? String(start) : `${start}–${end}`); start = end = speed; }
  }
  ranges.push(start === end ? String(start) : `${start}–${end}`);
  return `${ranges.join(', ')} m/s`;
}
