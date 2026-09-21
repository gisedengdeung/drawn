/**
 * Development/standalone Node transport only. Business logic lives in FastAPI.
 * Compose sends /api directly to FastAPI through nginx.
 */
export async function proxyApi(request: Request): Promise<Response> {
  const backend = new URL(process.env.API_INTERNAL_URL || 'http://127.0.0.1:8000');
  const incoming = new URL(request.url);
  const upstream = new URL(backend);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;
  const headers = new Headers(request.headers);
  for (const key of ['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding']) headers.delete(key);
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method, headers, redirect: 'manual', signal: request.signal,
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    init.duplex = 'half';
  }
  try {
    const response = await fetch(upstream, init);
    const output = new Headers(response.headers);
    output.delete('content-encoding');
    output.delete('content-length');
    output.delete('transfer-encoding');
    output.set('Cache-Control', 'no-store');
    // Preserve separate HttpOnly session/state Set-Cookie headers.
    const cookies = response.headers.getSetCookie();
    if (cookies.length) {
      output.delete('set-cookie');
      for (const cookie of cookies) output.append('set-cookie', cookie);
    }
    return new Response(response.body, { status: response.status, headers: output });
  } catch (error) {
    if (request.signal.aborted) throw error;
    return Response.json({ error: 'API 서버에 연결할 수 없습니다.', code: 'backend_unavailable' }, { status: 503 });
  }
}
