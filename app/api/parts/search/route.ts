import { searchParts } from '../../../../lib/parts/server/search';
import { validatePartSearch } from '../../../../lib/parts/server/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let active = 0;
let windowStart = 0;
let windowCount = 0;

function failure(status: string, message: string, code: number, itemId = ''): Response {
  return Response.json({ itemId, status, offers: [], warnings: [message], retrievedAt: new Date().toISOString() },
    { status: code, headers: { 'cache-control': 'no-store', ...(code === 429 ? { 'retry-after': '60' } : {}) } });
}

async function boundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error('Missing body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 16_384) { await reader.cancel(); throw new Error('Body too large'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(joined));
}

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return failure('permission_denied', '같은 사이트에서만 상품 검색을 요청할 수 있습니다.', 403);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return failure('error', 'JSON 형식으로 요청해야 합니다.', 415);
  if (Number(request.headers.get('content-length') || 0) > 16_384) return failure('error', '요청 데이터가 너무 큽니다.', 413);
  let value: unknown;
  try { value = await boundedJson(request); }
  catch { return failure('error', '요청 데이터를 읽을 수 없습니다. 16KB 이하의 JSON을 사용하세요.', 400); }
  const input = validatePartSearch(value);
  if (!input) return failure('error', '부품 모델, 수량 또는 한국 배송·원화 설정을 확인하세요.', 400);
  const time = Date.now();
  if (time - windowStart >= 60_000) { windowStart = time; windowCount = 0; }
  // A modest local budget. A multi-instance public deployment needs an external limiter/auth.
  if (active >= 3 || windowCount >= 30) return failure('rate_limited', '상품 검색이 많습니다. 잠시 후 다시 시도하세요.', 429, input.item.id);
  active += 1;
  windowCount += 1;
  try {
    const result = await searchParts(input, { signal: request.signal });
    const status = result.status === 'not_configured' ? 503 : result.status === 'permission_denied' ? 502 : result.status === 'rate_limited' ? 429 : result.status === 'error' ? 502 : 200;
    return Response.json(result, { status, headers: { 'cache-control': 'no-store' } });
  } finally { active -= 1; }
}
