import type { PartSearchResult } from '../types';

export class PartsError extends Error {
  status: PartSearchResult['status'];
  constructor(status: PartSearchResult['status'], message: string) {
    super(message);
    this.name = 'PartsError';
    this.status = status;
  }
}

export type Fetcher = typeof fetch;

export async function fetchJson(
  url: string,
  init: RequestInit,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
      });
    } catch {
      if (attempt === 0 && !signal.aborted) continue;
      throw new PartsError('error', '외부 상품 서비스 연결이 지연되거나 실패했습니다. 잠시 후 다시 시도하세요.');
    }
    if (response.status === 429) throw new PartsError('rate_limited', '외부 서비스의 조회 한도에 도달했습니다. 잠시 후 다시 시도하세요.');
    if (response.status === 401 || response.status === 403) {
      throw new PartsError('permission_denied', '상품 조회 서비스의 연결 권한을 확인해야 합니다.');
    }
    if (response.status >= 500 && attempt === 0 && !signal.aborted) continue;
    if (!response.ok) throw new PartsError('error', '외부 서비스에서 조회 요청을 처리하지 못했습니다.');
    try {
      const value: unknown = await response.json();
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch { /* Return a sanitized message, never provider response bodies or credentials. */ }
    throw new PartsError('error', '외부 서비스가 올바른 상품 데이터를 반환하지 않았습니다.');
  }
  throw new PartsError('error', '조회에 실패했습니다.');
}

export const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function list(value: unknown, childKey?: string): Record<string, unknown>[] {
  const source = childKey && !Array.isArray(value) ? record(value)[childKey] : value;
  return (Array.isArray(source) ? source : []).map(record);
}

export function plain(value: unknown, maxLength = 600): string {
  return scalarText(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#\d+);/gi, ' ')
    // eslint-disable-next-line no-control-regex -- Remove untrusted control characters from provider text.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function scalarText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

export function hasControls(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

export function positiveNumber(value: unknown, allowZero = false): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && (allowZero ? number >= 0 : number > 0) ? number : null;
}
