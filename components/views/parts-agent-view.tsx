'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Download, ExternalLink, LoaderCircle, RefreshCw, ShoppingBag, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { buildPurchaseSummary } from '@/lib/parts/summary';
import { createBomSnapshot, draftFingerprint } from '@/lib/parts/bom';
import { calculateOfferAmounts } from '@/lib/parts/pricing';
import { quoteToCsv } from '@/lib/parts/csv';
import { productLink, searchPartQueue } from '@/lib/parts/client';
import { loadStoredQuote, saveStoredQuote } from '@/lib/parts/session';
import type { DesignDraft } from '@/lib/drawn-types';
import type { BomSnapshot, PartKind, PartSearchResult, PartSpecs, ProductOffer, QuoteLine } from '@/lib/parts/types';

const KIND_LABELS: Record<PartKind, string> = { motor: '모터', propeller: '프로펠러', battery: '배터리', servo: '서보' };
const STATUS_LABELS: Record<PartSearchResult['status'], string> = {
  ok: '검색 완료', not_found: '검색 범위에서 미발견', not_configured: '상품 조회 연결 준비 중',
  permission_denied: '상품 조회 권한 필요', rate_limited: '조회 한도 · 잠시 후 재검색', error: '조회 실패',
};
const MATCH_LABELS: Record<ProductOffer['match'], string> = { exact: '동일 모델', alternative: '대체 후보 · 확인 필요', needs_review: '규격 확인 필요' };
type Phase = 'idle' | 'pending' | 'searching' | 'done';

function won(value: number | null) {
  return value == null ? '미확인' : new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 2 }).format(value);
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '미확인' : date.toLocaleString('ko-KR', { hour12: false });
}

function modelLabel(model: string) {
  return model.replace(/^t_motor_/, 'T-Motor ').replace(/^kde_direct_/, 'KDE Direct ')
    .replace(/^apc_propellers_/, 'APC ').replace(/(\d)_(\d)/g, '$1.$2').replace(/_/g, ' ').replace(/(\d)x(\d)/gi, '$1×$2') || '모델 미확인';
}

function specsLabel(specs: PartSpecs) {
  return [specs.motorKv != null ? `${specs.motorKv} KV` : null,
    specs.diameterIn != null ? `지름 ${specs.diameterIn}인치` : null,
    specs.pitchIn != null ? `피치 ${specs.pitchIn}인치` : null,
    specs.cells != null ? `${specs.cells}S` : null,
    specs.capacityMah != null ? `${specs.capacityMah.toLocaleString('ko-KR')} mAh` : null,
    specs.dischargeC != null ? `${specs.dischargeC}C` : null,
    specs.voltage != null ? `${specs.voltage}V` : null].filter(Boolean).join(' · ');
}

export function PartsAgentView({ draft, disabled = false, selectedDesignId, loadError, onOpenDesign }: {
  draft: DesignDraft | null; disabled?: boolean; selectedDesignId: number | null; loadError: string | null; onOpenDesign: () => void;
}) {
  const [ready, setReady] = useState(false);
  const [snapshot, setSnapshot] = useState<BomSnapshot | null>(null);
  const [lines, setLines] = useState<QuoteLine[]>([]);
  const [phases, setPhases] = useState<Record<string, Phase>>({});
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const fingerprint = useMemo(() => draft ? draftFingerprint(draft) : null, [draft]);
  const stale = Boolean(snapshot && (snapshot.designId !== selectedDesignId || (fingerprint && fingerprint !== snapshot.fingerprint)));
  const running = Object.values(phases).some((phase) => phase === 'pending' || phase === 'searching');

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const saved = loadStoredQuote(sessionStorage);
        if (saved) {
          setSnapshot(saved.snapshot);
          setLines(saved.lines);
        }
      } catch { /* Browser storage can be disabled; quotes still work in memory. */ }
      setReady(true);
    });
    return () => { active = false; generation.current += 1; controller.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!ready || !snapshot) return;
    try { saveStoredQuote(sessionStorage, { snapshot, lines }); } catch { /* Access to browser storage can be disabled. */ }
  }, [ready, snapshot, lines]);

  const currentBom = useMemo(() => draft ? createBomSnapshot(draft) : null, [draft]);
  const displayed = snapshot ?? currentBom;
  const displayLines = useMemo(() => snapshot ? lines : (currentBom?.items ?? []).map((item) => ({ item, result: null, selectedOfferId: null })), [snapshot, lines, currentBom]);
  const summary = useMemo(() => displayed ? buildPurchaseSummary(displayed, displayLines) : null, [displayed, displayLines]);

  async function searchItems(items: BomSnapshot['items']) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const turn = ++generation.current;
    const queue = items.filter((item) => item.model.trim());
    setPhases(Object.fromEntries(queue.map((item) => [item.id, 'pending' as Phase])));
    setLines((current) => current.map((line) => queue.some((item) => item.id === line.item.id) ? { ...line, result: null, selectedOfferId: null } : line));
    await searchPartQueue({ items: queue, signal: abort.signal,
      onStart: (item) => { if (generation.current === turn) setPhases((current) => ({ ...current, [item.id]: 'searching' })); },
      onResult: (item, result) => {
        if (generation.current !== turn) return;
        // Alternative candidates always require an explicit selection.
        const selected = result.offers.find((offer) => offer.match === 'exact' && calculateOfferAmounts(item, offer).subtotal != null);
        setLines((current) => current.map((line) => line.item.id === item.id ? { ...line, result, selectedOfferId: selected?.id ?? null } : line));
        setPhases((current) => ({ ...current, [item.id]: 'done' }));
      },
    });
    if (generation.current === turn && !abort.signal.aborted) {
      setPhases((current) => Object.fromEntries(Object.keys(current).map((id) => [id, 'done' as Phase])));
    }
  }

  function newQuote() {
    if (!draft || disabled || !ready) return;
    const next = createBomSnapshot(draft);
    setSnapshot(next);
    setLines(next.items.map((item) => ({ item, result: null, selectedOfferId: null })));
    void searchItems(next.items);
  }

  function stopSearch() {
    generation.current += 1;
    controller.current?.abort();
    setPhases((current) => Object.fromEntries(Object.entries(current).map(([id, phase]) => [id, phase === 'done' ? 'done' : 'idle'])));
  }

  function download() {
    if (!displayed) return;
    const url = URL.createObjectURL(new Blob([quoteToCsv(displayed, displayLines)], { type: 'text/csv;charset=utf-8;' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `drawn-parts-${displayed.designId}-${displayed.createdAt.slice(0, 10)}.csv`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section className="px-3 py-5 sm:px-5 lg:px-6" aria-labelledby="parts-agent-heading">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold text-[#3182f6]">5단계 · 구매 준비</p>
          <h1 id="parts-agent-heading" className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight text-[#1d1d1f]"><ShoppingBag className="size-6 text-[#3182f6]" />부품 agent</h1>
          <p className="mt-2 text-sm leading-6 text-[#6e6e73]">설계에 필요한 부품을 모으고, 구매할 상품과 금액을 정리하세요.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onOpenDesign}>설계 편집</Button>
          <Button variant="outline" onClick={download} disabled={!ready || !displayLines.length}><Download className="size-4" />CSV 저장</Button>
          <Button onClick={newQuote} disabled={!ready || disabled || !draft} className="bg-[#3182f6] text-white hover:bg-[#1b64da]"><ShoppingBag className="size-4" />{snapshot ? '현재 설계로 새 견적' : '현재 설계로 검색'}</Button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#e5e5ea] bg-white px-4 py-3 text-sm">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <span className="font-semibold text-[#3c3c43]">현재 설계 #{selectedDesignId ?? '—'}</span>
          <span className="text-[#6e6e73]">{disabled ? '부품 목록을 불러오는 중…' : `필요 부품 ${currentBom?.items.length ?? 0}종`}</span>
        </div>
        <span className="rounded-full bg-[#eff6ff] px-3 py-1 text-xs font-medium text-[#1b64da]">AliExpress · 한국 배송 조건 · 원화</span>
      </div>
      {loadError && <p role="alert" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{loadError} 실제 부품 정보가 부족한 항목은 수량 미확인으로 표시합니다.</p>}
      {stale && <output className="mb-4 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><AlertCircle className="size-4 shrink-0" />아래 결과는 이전 설계 기준입니다. 변경한 부품을 반영하려면 ‘현재 설계로 새 견적’을 눌러 주세요.</output>}

      {!ready || !displayed || !summary ? (
        <div className="grid min-h-56 place-items-center rounded-2xl border border-[#e5e5ea] bg-white p-8 text-sm text-[#6e6e73]"><p className="flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" />설계에서 부품 목록을 준비하고 있습니다.</p></div>
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <Total label="구매 후보 선택" value={`${summary.selectedCount} / ${displayLines.length}종`} note={`${displayLines.length - summary.selectedCount}종 선택 필요`} />
            <Total label="확인된 부품 소계" value={won(summary.subtotal)} note={`${summary.confirmedCount}종 반영 · 미확인 금액 제외`} />
            <Total label="확인된 배송비" value={won(summary.shipping)} note={`${summary.shippingConfirmedCount}종 확인 · 최종 결제액 아님`} />
          </div>

          <section className="overflow-hidden rounded-2xl border border-[#e5e5ea] bg-white" aria-labelledby="purchase-summary-heading">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e5e5ea] px-4 py-4 sm:px-5">
              <div>
                <h2 id="purchase-summary-heading" className="text-base font-semibold text-[#1d1d1f]">최종 구매 정리</h2>
                <p className="mt-1 text-xs text-[#6e6e73]">설계 #{displayed.designId} · {snapshot ? `견적 기준 ${dateLabel(displayed.createdAt)}` : '현재 설계의 부품 목록 · 검색 전'}</p>
              </div>
              <span className="text-xs text-[#6e6e73]">선택한 상품과 CSV에 같은 수량·금액이 반영됩니다.</span>
            </div>
            <Table className="min-w-[840px] text-sm">
              <TableHeader className="bg-[#f5f5f7] [&_th]:px-4 [&_th]:text-[#6e6e73]">
                <TableRow><TableHead>필요 부품</TableHead><TableHead>필요 수량</TableHead><TableHead>선택 상품 · 옵션</TableHead><TableHead>판매 묶음</TableHead><TableHead>구매 묶음</TableHead><TableHead className="text-right">부품 소계</TableHead><TableHead>상품 링크</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {summary.rows.map(({ item, result, offer, amounts }) => {
                  const url = offer ? productLink(offer.url) : null;
                  return (
                    <TableRow key={item.id} className="border-[#e5e5ea] [&_td]:px-4 [&_td]:py-4 [&_td]:align-top">
                      <TableCell className="max-w-64 whitespace-normal"><p className="text-xs font-medium text-[#3182f6]">{KIND_LABELS[item.kind]}</p><p className="mt-1 break-words font-medium text-[#3c3c43]">{modelLabel(item.model)}</p><p className="mt-1 text-xs text-[#86868b]">{specsLabel(item.specs) || '규격 확인 필요'}</p></TableCell>
                      <TableCell>{item.quantity == null ? '미확인' : `${item.quantity}개`}</TableCell>
                      <TableCell className="max-w-80 whitespace-normal">{offer ? <><p className="break-words font-medium text-[#3c3c43]">{offer.title}</p><p className="mt-1 text-xs text-[#6e6e73]">{offer.optionLabel || '옵션 미확인'}</p><p className="mt-1 text-xs text-amber-800">{MATCH_LABELS[offer.match]}{amounts?.subtotal == null ? ' · 금액 확인 필요' : ''}</p></> : <p className="text-[#86868b]">{result ? result.offers.length ? '구매 후보를 선택하세요' : STATUS_LABELS[result.status] : '상품 검색 전'}</p>}<a href={`#part-${encodeURIComponent(item.id)}`} className="mt-2 inline-block text-xs font-medium text-[#3182f6] underline underline-offset-2">{offer ? '후보 변경' : '후보 확인'}</a></TableCell>
                      <TableCell>{offer ? <><p>{offer.packQuantity == null ? '수량 미확인' : `${offer.packQuantity}개 / 묶음`}</p><p className="mt-1 text-xs text-[#6e6e73]">{offer.currency === 'KRW' ? won(offer.packPrice) : offer.packPrice == null ? '가격 미확인' : `${offer.packPrice} ${offer.currency}`}</p></> : '미확인'}</TableCell>
                      <TableCell>{amounts?.packCount == null ? '미확인' : `${amounts.packCount}묶음`}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums text-[#3c3c43]">{won(amounts?.subtotal ?? null)}</TableCell>
                      <TableCell>{url ? <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-[#3182f6] underline underline-offset-2">상품 보기<ExternalLink className="size-3" /></a> : <span className="text-[#86868b]">미확인</span>}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {!displayLines.length && <p className="p-8 text-center text-sm text-[#6e6e73]">현재 설계에 기록된 검색 대상 부품이 없습니다.</p>}
          </section>

          <section className="mt-6" aria-labelledby="purchase-candidates-heading">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div><h2 id="purchase-candidates-heading" className="text-base font-semibold text-[#1d1d1f]">상품 후보 비교</h2><p className="mt-1 text-sm text-[#6e6e73]">선택한 후보가 위 정리표에 반영됩니다. 대체 후보는 규격을 확인해 주세요.</p></div>
              {snapshot && (running ? <Button variant="outline" size="sm" onClick={stopSearch}><Square className="size-3" />검색 중지</Button> : <Button variant="outline" size="sm" onClick={() => void searchItems(snapshot.items)} disabled={!snapshot.items.some((item) => item.model.trim())}><RefreshCw className="size-3.5" />전체 다시 검색</Button>)}
            </div>
            {running && <output aria-live="polite" className="mb-3 flex items-center gap-2 text-sm text-[#1b64da]"><LoaderCircle className="size-4 animate-spin" />{displayLines.filter((line) => line.result).length} / {displayLines.length}종 조회 · 다른 탭에서도 검색은 계속됩니다.</output>}
            <div className="space-y-3">
              {displayLines.map((line) => (
                <PartRow key={line.item.id} line={line} phase={phases[line.item.id] ?? (line.result ? 'done' : 'idle')} retryDisabled={!snapshot || running || !line.item.model.trim()}
                  onRetry={() => void searchItems([line.item])}
                  onSelect={(id) => setLines((current) => current.map((entry) => entry.item.id === line.item.id ? { ...entry, selectedOfferId: id } : entry))} />
              ))}
            </div>
          </section>
          <div className="mt-4 rounded-xl border border-[#e5e5ea] bg-white p-4 text-xs leading-6 text-[#6e6e73]">
            <p className="font-semibold text-[#3c3c43]">견적에 포함되지 않는 항목</p>
            {displayed.exclusions.map((text, index) => <p key={index}>{text}</p>)}
            <p>미확인 배송비·세금·쿠폰은 합계에 포함하지 않습니다. 검색 결과는 알리 제휴 상품 범위에 한정됩니다.</p>
          </div>
        </>
      )}
    </section>
  );
}

function Total({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="rounded-xl border border-[#e5e5ea] bg-white px-4 py-3"><p className="text-xs text-[#6e6e73]">{label}</p><p className="mt-1 text-xl font-semibold tracking-tight text-[#1d1d1f]">{value}</p><p className="mt-1 text-xs text-[#86868b]">{note}</p></div>;
}

function PartRow({ line, phase, retryDisabled, onRetry, onSelect }: { line: QuoteLine; phase: Phase; retryDisabled: boolean; onRetry: () => void; onSelect: (id: string | null) => void }) {
  const { item, result } = line;
  const searching = phase === 'pending' || phase === 'searching';
  return (
    <section id={`part-${item.id}`} aria-label={`${KIND_LABELS[item.kind]} ${item.model || '모델 미확인'}`} className="scroll-mt-36 overflow-hidden rounded-xl border border-[#e5e5ea] bg-white">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#e5e5ea] bg-[#f5f5f7] px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-[#3182f6]">{KIND_LABELS[item.kind]} · 필요 {item.quantity ?? '미확인'}{item.quantity != null ? '개' : ''}</p>
          <h3 className="mt-1 break-words text-sm font-semibold text-[#1d1d1f]">{modelLabel(item.model)}</h3>
          {specsLabel(item.specs) && <p className="mt-1 text-xs text-[#6e6e73]">{specsLabel(item.specs)}</p>}
          {item.issues.map((issue, index) => <p key={index} className="mt-1 text-xs text-amber-800">{issue}</p>)}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#6e6e73]">{phase === 'searching' ? '검색 중' : phase === 'pending' ? '대기 중' : result ? STATUS_LABELS[result.status] : item.model ? '검색 전' : '모델 확인 필요'}</span>
          <Button variant="ghost" size="icon-sm" aria-label={`${item.model || KIND_LABELS[item.kind]} 다시 검색`} disabled={retryDisabled} onClick={onRetry}>{searching ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}</Button>
        </div>
      </div>
      <div className="p-3 sm:p-4">
        {result?.warnings.map((warning, index) => <p key={index} className="mb-2 text-xs leading-5 text-amber-800">{warning}</p>)}
        {result?.offers.length ? (
          <fieldset className="space-y-2">
            <legend className="mb-2 text-xs text-[#6e6e73]">구매 후보 선택 · 대체 후보는 자동으로 반영하지 않습니다</legend>
            {result.offers.map((offer) => {
              const amount = calculateOfferAmounts(item, offer);
              const selected = line.selectedOfferId === offer.id;
              const url = productLink(offer.url);
              return (
                <div key={offer.id} className={`rounded-lg border p-3 ${selected ? 'border-[#3182f6] bg-[#eff6ff]' : 'border-[#e5e5ea]'}`}>
                  <div className="flex items-start gap-2">
                    <input type="radio" name={`offer-${item.id}`} aria-label={`${offer.title} ${offer.optionLabel ?? '옵션 미확인'}`} checked={selected} onChange={() => onSelect(offer.id)} className="mt-1 accent-[#3182f6]" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2"><span className={`text-xs font-semibold ${offer.match === 'exact' ? 'text-emerald-700' : 'text-amber-800'}`}>{offer.match === 'exact' && <Check className="mr-1 inline size-3" />}{MATCH_LABELS[offer.match]}</span>{url && <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-[#3182f6] underline underline-offset-2">상품 보기<ExternalLink className="size-3" /></a>}</div>
                      <p className="mt-1 break-words text-sm font-medium text-[#3c3c43]">{offer.title}</p>
                      <p className="mt-1 break-words text-xs text-[#6e6e73]">판매 옵션: {offer.optionLabel || '미확인'}{!offer.optionVerified ? ' · 가격 확인 필요' : ''}</p>
                      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
                        <Price label="판매 묶음 가격" value={offer.currency === 'KRW' ? won(offer.packPrice) : offer.packPrice == null ? '미확인' : `${offer.packPrice} ${offer.currency}`} />
                        <Price label="묶음당 개수 / 구매 묶음" value={`${offer.packQuantity ?? '?'}개 / ${amount.packCount ?? '?'}묶음`} />
                        <Price label="개당 가격 / 소계" value={`${won(amount.unitPrice)} / ${won(amount.subtotal)}`} />
                        <Price label="한국 배송 / 배송비" value={`${offer.shippingAvailable == null ? '미확인' : offer.shippingAvailable ? '가능' : '불가'} / ${won(amount.shipping)}`} />
                      </div>
                      {offer.stock === 0 && <p className="mt-2 text-xs text-red-700">현재 품절</p>}
                      {offer.reasons.map((reason, index) => <p key={index} className="mt-1 text-xs leading-5 text-[#6e6e73]">{reason}</p>)}
                      {amount.subtotal == null && <p className="mt-2 text-xs text-amber-800">옵션·수량·재고·규격 정보가 충분히 확인되지 않아 소계에 반영하지 않습니다.</p>}
                      <p className="mt-2 text-xs text-[#86868b]">조회 {dateLabel(offer.retrievedAt)}</p>
                    </div>
                  </div>
                </div>
              );
            })}
            {line.selectedOfferId && <button type="button" onClick={() => onSelect(null)} className="text-xs text-[#6e6e73] underline underline-offset-2">선택 해제</button>}
          </fieldset>
        ) : <p className="py-2 text-xs text-[#86868b]">{searching ? '모델과 판매 옵션을 확인하고 있습니다…' : result?.status === 'not_configured' ? '연결 준비가 끝나면 이 부품 목록으로 다시 검색할 수 있습니다.' : result ? '확인된 구매 후보가 없습니다. 부품 목록은 CSV로 저장할 수 있습니다.' : '모델이 확인된 부품은 다시 검색할 수 있습니다.'}</p>}
      </div>
    </section>
  );
}

function Price({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[#86868b]">{label}</p><p className="mt-1 font-medium tabular-nums text-[#3c3c43]">{value}</p></div>;
}
