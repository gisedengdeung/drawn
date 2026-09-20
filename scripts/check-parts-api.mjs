// Run after starting the app with server credentials loaded. Never prints secrets.
async function main() {
  const base = new URL(process.env.PARTS_SMOKE_BASE_URL || 'http://localhost:5173');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
    console.error('Smoke test is restricted to a locally running app.');
    process.exitCode = 1;
    return;
  }
  const examples = [
    { kind: 'motor', model: process.env.PARTS_SMOKE_MODEL || 't_motor_MN4012KV400', quantity: 4 },
    { kind: 'propeller', model: 'apc_propellers_13x4_7SF', quantity: 4 },
    { kind: 'battery', model: 'Tattu5C20000mAh6S1P', quantity: 1 },
  ];
  for (const example of examples) {
    const response = await fetch(new URL('/api/parts/search', base), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ country: 'KR', currency: 'KRW', item: {
        id: `smoke-${example.kind}`, ...example, instances: ['smoke'], specs: {}, issues: [],
      } }), signal: AbortSignal.timeout(65_000),
    });
    const result = await response.json();
    console.log(JSON.stringify({ kind: example.kind, model: example.model,
      httpStatus: response.status, status: result.status, offerCount: result.offers?.length ?? 0,
      offers: result.offers?.map((offer) => ({ productId: offer.productId, url: offer.url,
        optionVerified: offer.optionVerified, optionLabel: offer.optionLabel,
        packPrice: offer.packPrice, currency: offer.currency, retrievedAt: offer.retrievedAt })), warnings: result.warnings }, null, 2));
    if (result.status === 'not_configured') { process.exitCode = 2; return; }
    if (!response.ok || result.status !== 'ok' || !result.offers?.length) process.exitCode = 1;
  }
}

try { await main(); }
catch {
  console.error('상품 조회 검증을 완료하지 못했습니다. 로컬 개발 서버 주소와 실행 상태를 확인하세요.');
  process.exitCode = 1;
}
