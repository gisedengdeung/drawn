export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
export function fail(error: unknown) {
  return error instanceof ApiError
    ? json({ error: error.message, code: error.code }, error.status)
    : json(
        {
          error: '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.',
          code: 'internal_error',
        },
        500,
      );
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    throw new ApiError(403, 'forbidden', '같은 사이트에서 요청해 주세요.');
}
export async function readJson(
  request: Request,
  maximum = 1_000_000,
): Promise<unknown> {
  sameOrigin(request);
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new ApiError(
      415,
      'invalid_content_type',
      'JSON 형식으로 요청해 주세요.',
    );
  const reader = request.body?.getReader();
  if (!reader)
    throw new ApiError(400, 'invalid_input', '요청 내용이 없습니다.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) {
        await reader.cancel();
        throw new ApiError(413, 'too_large', '요청 데이터가 너무 큽니다.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(joined));
  } catch {
    throw new ApiError(400, 'invalid_json', 'JSON 형식을 확인해 주세요.');
  }
}
