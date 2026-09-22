import { readLocalStl } from '@/lib/server/local-stl';

/**
 * 로컬 원본 STL을 내려 준다. 파라메트릭 형상을 실제와 1:1로 겹쳐 보기 위한
 * 개발용 경로이며, 원본이 없는 환경에서는 404가 난다.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // 경로 조작을 막으려고 숫자만 받는다.
  if (!/^\d+$/.test(id)) return new Response('Not found', { status: 404 });
  const body = await readLocalStl(Number(id));
  if (!body) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(body), {
    headers: { 'content-type': 'model/stl', 'cache-control': 'no-store' },
  });
}
