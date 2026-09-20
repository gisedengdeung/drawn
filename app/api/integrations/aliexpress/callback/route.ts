export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const unexpected = ['code', 'access_token', 'error'].some((key) =>
    query.has(key),
  );
  const message = unexpected
    ? '이 경로는 Affiliates 앱 등록용입니다. 판매자 OAuth 인증과 토큰 발급을 처리하지 않습니다.'
    : 'drawn AliExpress Affiliates callback 경로가 준비되었습니다. 상품 API 연결은 서버 설정과 실제 조회로 별도 확인합니다.';
  return new Response(
    '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>drawn · AliExpress</title><body><main><h1>AliExpress Affiliates</h1><p>' +
      message +
      '</p><a href="/">drawn으로 돌아가기</a></main></body></html>',
    {
      status: unexpected ? 400 : 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      },
    },
  );
}
