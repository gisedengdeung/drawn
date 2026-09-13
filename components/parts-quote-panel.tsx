'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Download, ExternalLink, LoaderCircle, RefreshCw, ShoppingBag, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
  return value == null ? '미확인' : new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(value);
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

export function PartsQuotePanel({ draft, disabled = false }: { draft: DesignDraft | null; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [snapshot, setSnapshot] = useState<BomSnapshot | null>(null);
  const [lines, setLines] = useState<QuoteLine[]>([]);
  const [phases, setPhases] = useState<Record<string, Phase>>({});
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const fingerprint = useMemo(() => draft ? draftFingerprint(draft) : null, [draft]);
  const stale = Boolean(snapshot && fingerprint !== snapshot.fingerprint);
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

  const totals = useMemo(() => {
    let subtotal = 0, shipping = 0, confirmed = 0, shippingConfirmed = 0;
    for (const line of lines) {
      const offer = line.result?.offers.find((entry) => entry.id === line.selectedOfferId);
      if (!offer) continue;
      const amount = calculateOfferAmounts(line.item, offer);
      if (amount.subtotal != null) { subtotal += amount.subtotal; confirmed += 1; }
      if (amount.subtotal != null && amount.shipping != null) { shipping += amount.shipping; shippingConfirmed += 1; }
    }
    return { subtotal, shipping, confirmed, shippingConfirmed };
  }, [lines]);

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
    if (!draft) return;
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
    if (!snapshot) return;
    const url = URL.createObjectURL(new Blob([quoteToCsv(snapshot, lines)], { type: 'text/csv;charset=utf-8;' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `drawn-parts-${snapshot.designId}-${snapshot.createdAt.slice(0, 10)}.csv`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <>
      <Button disabled={disabled || !draft || !ready} onClick={() => { setOpen(true); if (!snapshot) newQuote(); }} className="bg-[#147d91] text-white hover:bg-[#106c7d]">
        <ShoppingBag className="size-4" /> 알리 부품 견적
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92dvh] w-[calc(100%-1rem)] gap-0 overflow-hidden bg-[#f5f8fa] p-0 sm:max-w-6xl">
          <DialogHeader className="border-b border-[#dbe4ea] bg-white px-5 py-4 pr-12">
            <DialogTitle className="flex items-center gap-2 text-lg text-[#172b3a]"><ShoppingBag className="size-5 text-[#147d91]" /> 알리 부품 견적</DialogTitle>
            <DialogDescription>설계 부품과 판매 옵션을 비교하세요. 한국 배송 · 원화 기준 · 확인된 부품 가격만 소계에 반영합니다.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[calc(92dvh-100px)] overflow-y-auto p-3 sm:p-5">
            {snapshot && (
              <>
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="text-xs text-[#607383]">
                    <strong className="text-[#294353]">설계 #{snapshot.designId} · {lines.length}종</strong>
                    <p className="mt-1">견적 기준 {dateLabel(snapshot.createdAt)}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {running ? <Button variant="outline" size="sm" onClick={stopSearch}><Square className="size-3" /> 검색 중지</Button> : <Button variant="outline" size="sm" onClick={() => void searchItems(snapshot.items)} disabled={!lines.some((line) => line.item.model.trim())}><RefreshCw className="size-3.5" /> 전체 다시 검색</Button>}
                    <Button variant="outline" size="sm" onClick={newQuote} disabled={!draft || disabled}>현재 설계로 새 견적</Button>
                    <Button variant="outline" size="sm" onClick={download} disabled={!lines.length}><Download className="size-3.5" /> CSV 저장</Button>
                  </div>
                </div>
                {stale && <output className="mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><AlertCircle className="size-4 shrink-0" /> 이전 설계 기준입니다. 변경한 부품을 반영하려면 ‘현재 설계로 새 견적’을 눌러 주세요.</output>}
                <div className="mb-4 grid gap-2 sm:grid-cols-3">
                  <Total label="확인된 부품 소계" value={totals.confirmed ? won(totals.subtotal) : '아직 없음'} note={`${totals.confirmed} / ${lines.length}종 반영`} />
                  <Total label="확인된 배송비" value={totals.shippingConfirmed ? won(totals.shipping) : '미확인'} note={`${totals.shippingConfirmed}종 확인 · 미확인 배송비 제외`} />
                  <Total label="견적 상태" value={running ? '상품 검색 중' : `${lines.filter((line) => line.result).length} / ${lines.length}종 조회`} note="쿠폰·추가 비용에 따라 최종 결제액은 달라집니다" />
                </div>
                {running && <output aria-live="polite" className="mb-3 flex items-center gap-2 text-xs text-[#0f6475]"><LoaderCircle className="size-4 animate-spin" /> 두 부품씩 조회하고 있습니다. 완료된 결과부터 확인할 수 있어요.</output>}
                <div className="space-y-3">
                  {lines.map((line) => (
                    <PartRow key={line.item.id} line={line} phase={phases[line.item.id] ?? (line.result ? 'done' : 'idle')} retryDisabled={running || !line.item.model.trim()}
                      onRetry={() => void searchItems([line.item])}
                      onSelect={(id) => setLines((current) => current.map((entry) => entry.item.id === line.item.id ? { ...entry, selectedOfferId: id } : entry))} />
                  ))}
                </div>
                {!lines.length && <p className="rounded-xl border border-[#dbe4ea] bg-white p-8 text-center text-sm text-[#607383]">현재 설계에서 검색할 부품 정보를 확인하지 못했습니다.</p>}
                <div className="mt-4 rounded-xl border border-[#dbe4ea] bg-white p-3 text-xs leading-6 text-[#607383]">
                  <p className="font-semibold text-[#294353]">견적에 포함되지 않는 항목</p>
                  {snapshot.exclusions.map((text, index) => <p key={index}>{text}</p>)}
                  <p>상품이 없다는 뜻과 검색 범위에서 찾지 못했다는 뜻은 다릅니다. 제휴 상품 범위에서 조회하며, 대체 후보는 규격을 확인한 뒤 선택하세요.</p>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Total({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="rounded-xl border border-[#dbe4ea] bg-white px-4 py-3"><p className="text-xs text-[#607383]">{label}</p><p className="mt-1 text-xl font-semibold tracking-tight text-[#172b3a]">{value}</p><p className="mt-1 text-[11px] text-[#738591]">{note}</p></div>;
}

function PartRow({ line, phase, retryDisabled, onRetry, onSelect }: { line: QuoteLine; phase: Phase; retryDisabled: boolean; onRetry: () => void; onSelect: (id: string | null) => void }) {
  const { item, result } = line;
  const searching = phase === 'pending' || phase === 'searching';
  return (
    <section aria-label={`${KIND_LABELS[item.kind]} ${item.model || '모델 미확인'}`} className="overflow-hidden rounded-xl border border-[#dbe4ea] bg-white">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#e7edf1] bg-[#f9fbfc] px-4 py-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-[#147d91]">{KIND_LABELS[item.kind]} · 필요 {item.quantity ?? '미확인'}{item.quantity != null ? '개' : ''}</p>
          <h3 className="mt-1 break-words text-sm font-semibold text-[#172b3a]">{modelLabel(item.model)}</h3>
          {specsLabel(item.specs) && <p className="mt-1 text-xs text-[#607383]">{specsLabel(item.specs)}</p>}
          {item.issues.map((issue, index) => <p key={index} className="mt-1 text-xs text-amber-800">{issue}</p>)}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#607383]">{phase === 'searching' ? '검색 중' : phase === 'pending' ? '대기 중' : result ? STATUS_LABELS[result.status] : item.model ? '검색 전' : '모델 확인 필요'}</span>
          <Button variant="ghost" size="icon-sm" aria-label={`${item.model || KIND_LABELS[item.kind]} 다시 검색`} disabled={retryDisabled} onClick={onRetry}>{searching ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}</Button>
        </div>
      </div>
      <div className="p-3 sm:p-4">
        {result?.warnings.map((warning, index) => <p key={index} className="mb-2 text-xs leading-5 text-amber-800">{warning}</p>)}
        {result?.offers.length ? (
          <fieldset className="space-y-2">
            <legend className="mb-2 text-xs text-[#607383]">구매 후보 선택 · 대체 후보는 자동으로 반영하지 않습니다</legend>
            {result.offers.map((offer) => {
              const amount = calculateOfferAmounts(item, offer);
              const selected = line.selectedOfferId === offer.id;
              const url = productLink(offer.url);
              return (
                <div key={offer.id} className={`rounded-lg border p-3 ${selected ? 'border-[#147d91] bg-[#f0f9fa]' : 'border-[#e2e9ee]'}`}>
                  <div className="flex items-start gap-2">
                    <input type="radio" name={`offer-${item.id}`} aria-label={`${offer.title} ${offer.optionLabel ?? '옵션 미확인'}`} checked={selected} onChange={() => onSelect(offer.id)} className="mt-1 accent-[#147d91]" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2"><span className={`text-[11px] font-semibold ${offer.match === 'exact' ? 'text-emerald-700' : 'text-amber-800'}`}>{offer.match === 'exact' && <Check className="mr-1 inline size-3" />}{MATCH_LABELS[offer.match]}</span>{url && <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-[#147d91] underline underline-offset-2">상품 보기<ExternalLink className="size-3" /></a>}</div>
                      <p className="mt-1 break-words text-sm font-medium text-[#294353]">{offer.title}</p>
                      <p className="mt-1 break-words text-xs text-[#607383]">판매 옵션: {offer.optionLabel || '미확인'}{!offer.optionVerified ? ' · 가격 확인 필요' : ''}</p>
                      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
                        <Price label="판매 묶음 가격" value={offer.currency === 'KRW' ? won(offer.packPrice) : offer.packPrice == null ? '미확인' : `${offer.packPrice} ${offer.currency}`} />
                        <Price label="묶음당 개수 / 구매 묶음" value={`${offer.packQuantity ?? '?'}개 / ${amount.packCount ?? '?'}묶음`} />
                        <Price label="개당 가격 / 소계" value={`${won(amount.unitPrice)} / ${won(amount.subtotal)}`} />
                        <Price label="한국 배송 / 배송비" value={`${offer.shippingAvailable == null ? '미확인' : offer.shippingAvailable ? '가능' : '불가'} / ${won(amount.shipping)}`} />
                      </div>
                      {offer.stock === 0 && <p className="mt-2 text-xs text-red-700">현재 품절</p>}
                      {offer.reasons.map((reason, index) => <p key={index} className="mt-1 text-xs leading-5 text-[#607383]">{reason}</p>)}
                      {amount.subtotal == null && <p className="mt-2 text-xs text-amber-800">옵션·수량·재고·규격 정보가 충분히 확인되지 않아 소계에 반영하지 않습니다.</p>}
                      <p className="mt-2 text-[10px] text-[#82919c]">조회 {dateLabel(offer.retrievedAt)}</p>
                    </div>
                  </div>
                </div>
              );
            })}
            {line.selectedOfferId && <button type="button" onClick={() => onSelect(null)} className="text-xs text-[#607383] underline underline-offset-2">선택 해제</button>}
          </fieldset>
        ) : <p className="py-2 text-xs text-[#738591]">{searching ? '모델과 판매 옵션을 확인하고 있습니다…' : result?.status === 'not_configured' ? '연결 준비가 끝나면 이 부품 목록으로 다시 검색할 수 있습니다.' : result ? '확인된 구매 후보가 없습니다. 부품 목록은 CSV로 저장할 수 있습니다.' : '모델이 확인된 부품은 다시 검색할 수 있습니다.'}</p>}
      </div>
    </section>
  );
}

function Price({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[#738591]">{label}</p><p className="mt-1 font-medium tabular-nums text-[#294353]">{value}</p></div>;
}
