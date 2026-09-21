'use client';

import { useId, useMemo } from 'react';
import {
  AlertCircle,
  Check,
  Download,
  ExternalLink,
  LoaderCircle,
  Save,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { purchaseLink } from '@/lib/parts/client';
import { quoteToCsv } from '@/lib/parts/csv';
import {
  affiliatePromotionLink,
  canonicalProductLink,
} from '@/lib/parts/links';
import { calculateOfferAmounts, offerPriceKind } from '@/lib/parts/pricing';
import { buildPurchaseSummary } from '@/lib/parts/summary';
import type {
  BomItem,
  BomSnapshot,
  PartKind,
  PartSearchResult,
  PartSpecs,
  ProductOffer,
  QuoteLine,
} from '@/lib/parts/types';

const KIND_LABELS: Record<PartKind, string> = {
  motor: '모터',
  propeller: '프로펠러',
  battery: '배터리',
  servo: '서보',
};
const STATUS_LABELS: Record<PartSearchResult['status'], string> = {
  ok: '검색 완료',
  not_found: '검색 범위에서 미발견',
  not_configured: '상품 조회 연결 준비 중',
  permission_denied: '상품 조회 권한 필요',
  rate_limited: '조회 한도 · 잠시 후 재검색',
  error: '조회 실패',
};
const MATCH_LABELS: Record<ProductOffer['match'], string> = {
  exact: '동일 모델',
  alternative: '대체 후보 · 확인 필요',
  needs_review: '규격 확인 필요',
};

function moneyLabel(value: number | null, currency: string | null = 'KRW') {
  if (value == null) return '미확인';
  if (!currency) return `${value.toLocaleString('ko-KR')} · 통화 미확인`;
  if (currency !== 'KRW')
    return `${value.toLocaleString('ko-KR', { maximumFractionDigits: 2 })} ${currency}`;
  return new Intl.NumberFormat('ko-KR', {
    style: 'currency',
    currency: 'KRW',
    maximumFractionDigits: 2,
  }).format(value);
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '미확인'
    : date.toLocaleString('ko-KR', { hour12: false });
}

function modelLabel(model: string) {
  return (
    model
      .replace(/^t_motor_/, 'T-Motor ')
      .replace(/^kde_direct_/, 'KDE Direct ')
      .replace(/^apc_propellers_/, 'APC ')
      .replace(/(\d)_(\d)/g, '$1.$2')
      .replace(/_/g, ' ')
      .replace(/(\d)x(\d)/gi, '$1×$2') || '모델 미확인'
  );
}

function specsLabel(specs: PartSpecs) {
  return [
    specs.motorKv != null ? `${specs.motorKv} KV` : null,
    specs.diameterIn != null ? `지름 ${specs.diameterIn}인치` : null,
    specs.pitchIn != null ? `피치 ${specs.pitchIn}인치` : null,
    specs.cells != null ? `${specs.cells}S` : null,
    specs.capacityMah != null
      ? `${specs.capacityMah.toLocaleString('ko-KR')} mAh`
      : null,
    specs.dischargeC != null ? `${specs.dischargeC}C` : null,
    specs.voltage != null ? `${specs.voltage}V` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function quantityLabel(quantity: number | null) {
  return quantity == null ? '수량 미확인' : `${quantity}개`;
}

/** The current editable design, independent of a previously frozen quote. */
export function PartsBomPreview({
  snapshot,
  loading,
  loadError,
}: {
  snapshot: BomSnapshot | null;
  loading: boolean;
  loadError: string | null;
}) {
  return (
    <section
      aria-label="현재 설계의 필요 부품"
      className="min-w-0 rounded-xl border border-[#e5e5ea] bg-white p-3 text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-[#3c3c43]">
          현재 설계 {snapshot ? `#${snapshot.designId}` : '미선택'}
        </h3>
        <span className="text-[#6e6e73]">
          필요 부품 {snapshot?.items.length ?? 0}종
        </span>
      </div>
      <p className="mt-2 leading-5 text-[#6e6e73]">
        모터·프로펠러·배터리·서보 · AliExpress 제휴 상품 · 한국 배송 조건 · KRW
        요청
      </p>
      {loading ? (
        <output className="mt-3 flex items-center gap-2 text-[#6e6e73]">
          <LoaderCircle className="size-3.5 animate-spin" />
          부품 목록을 불러오는 중…
        </output>
      ) : snapshot?.items.length ? (
        <details className="mt-3">
          <summary className="cursor-pointer rounded text-[#3182f6] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3182f6]">
            필요 모델과 수량 보기
          </summary>
          <ul className="mt-2 divide-y divide-[#e5e5ea]">
            {snapshot.items.map((item) => (
              <li key={item.id} className="min-w-0 py-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <span className="text-[#3182f6]">
                      {KIND_LABELS[item.kind]}
                    </span>
                    <p className="mt-1 break-words font-medium text-[#3c3c43]">
                      {modelLabel(item.model)}
                    </p>
                  </div>
                  <span className="shrink-0 text-[#3c3c43]">
                    {quantityLabel(item.quantity)}
                  </span>
                </div>
                <p className="mt-1 break-words leading-5 text-[#6e6e73]">
                  {specsLabel(item.specs) || '규격 확인 필요'}
                </p>
                {item.issues.map((issue, index) => (
                  <p
                    key={index}
                    className="mt-1 break-words leading-5 text-amber-800"
                  >
                    {issue}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <p className="mt-3 leading-5 text-[#6e6e73]">
          {snapshot
            ? '현재 설계에 기록된 검색 대상 부품이 없습니다.'
            : '설계를 선택하면 필요한 모델과 수량을 확인할 수 있습니다.'}
        </p>
      )}
      {loadError && (
        <p
          role="alert"
          className="mt-3 break-words rounded-lg bg-amber-50 p-2 leading-5 text-amber-900"
        >
          {loadError} 실제 부품 정보가 부족한 항목은 수량 미확인으로 표시합니다.
        </p>
      )}
    </section>
  );
}

/** Controlled quote UI. Search, persistence and cancellation belong to the shared assistant. */
export function PartsQuotePanel({
  snapshot,
  lines,
  ready,
  stale,
  isQuote,
  saving,
  canSave,
  notice,
  disabled,
  onSelect,
  onSave,
}: {
  snapshot: BomSnapshot | null;
  lines: QuoteLine[];
  ready: boolean;
  stale: boolean;
  isQuote: boolean;
  saving: boolean;
  canSave: boolean;
  notice: string;
  disabled: boolean;
  onSelect: (itemId: string, offerId: string | null) => void;
  onSave: () => void;
}) {
  const id = useId();
  const summary = useMemo(
    () => (snapshot ? buildPurchaseSummary(snapshot, lines) : null),
    [snapshot, lines],
  );

  function download() {
    if (!snapshot) return;
    const url = URL.createObjectURL(
      new Blob([quoteToCsv(snapshot, lines)], {
        type: 'text/csv;charset=utf-8;',
      }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `drawn-parts-${snapshot.designId}-${snapshot.createdAt.slice(0, 10)}.csv`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (!ready)
    return (
      <output className="flex items-center gap-2 rounded-xl border border-[#e5e5ea] bg-white p-3 text-xs text-[#6e6e73]">
        <LoaderCircle className="size-4 animate-spin" />
        저장된 부품 목록을 준비하고 있습니다.
      </output>
    );
  if (!snapshot || !summary) return null;

  return (
    <section aria-label="부품 견적과 구매 정리" className="min-w-0 space-y-4">
      {stale && (
        <output className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>
            아래 결과는 이전 설계 기준입니다. 변경한 부품을 반영하려면 현재
            설계로 부품 찾기를 다시 실행해 주세요.
          </span>
        </output>
      )}

      {isQuote && (
        <section aria-labelledby={`${id}-candidates`}>
          <h3 id={`${id}-candidates`} className="font-semibold text-[#1d1d1f]">
            상품 후보 비교
          </h3>
          <p className="mt-1 text-xs leading-5 text-[#6e6e73]">
            설계 #{snapshot.designId} · 견적 기준{' '}
            {dateLabel(snapshot.createdAt)}
            <br />
            동일 모델과 대체 후보를 구분해 선택하세요.
          </p>
          <div className="mt-3 space-y-3">
            {summary.rows.map(({ item, result, offer }) => (
              <PartCard
                key={item.id}
                item={item}
                result={result}
                selectedOffer={offer}
                radioGroup={`${id}-${item.id}`}
                disabled={disabled || saving}
                onSelect={(offerId) => onSelect(item.id, offerId)}
              />
            ))}
          </div>
        </section>
      )}

      <section
        aria-labelledby={`${id}-summary`}
        className="min-w-0 rounded-xl border border-[#e5e5ea] bg-white p-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`${id}-summary`} className="font-semibold text-[#1d1d1f]">
            구매 정리
          </h3>
          <span className="text-xs text-[#6e6e73]">
            {summary.selectedCount} / {summary.rows.length}종 선택
          </span>
        </div>
        <p className="mt-1 text-xs leading-5 text-[#6e6e73]">
          설계 #{snapshot.designId} ·{' '}
          {isQuote
            ? `견적 기준 ${dateLabel(snapshot.createdAt)}`
            : '현재 설계의 부품 목록 · 검색 전'}
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 rounded-lg bg-[#f6f9fb] p-3">
          <Total
            label="확인된 부품 소계"
            value={moneyLabel(summary.subtotal)}
            note={`${summary.confirmedCount}종 반영 · 미확인 금액 제외`}
          />
          <Total
            label="확인된 배송비"
            value={moneyLabel(summary.shipping)}
            note={`${summary.shippingConfirmedCount}종 확인 · 최종 결제액 아님`}
          />
        </div>
        <div className="mt-3 divide-y divide-[#e5e5ea]">
          {summary.rows.map(({ item, result, offer, amounts }) => (
            <details key={item.id} className="min-w-0 py-3">
              <summary className="cursor-pointer rounded text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3182f6]">
                <span className="font-medium text-[#3c3c43]">
                  {KIND_LABELS[item.kind]} · {modelLabel(item.model)} ·{' '}
                  {quantityLabel(item.quantity)}
                </span>
                <span className="mt-1 block break-words leading-5 text-[#6e6e73]">
                  {offer
                    ? `${offer.title} · 소계 ${moneyLabel(amounts?.subtotal ?? null)}`
                    : result
                      ? result.offers.length
                        ? '구매 후보를 선택하세요'
                        : STATUS_LABELS[result.status]
                      : '상품 검색 전'}
                </span>
              </summary>
              {offer ? (
                <div className="mt-3 space-y-2 text-xs">
                  <p className="break-words leading-5 text-[#6e6e73]">
                    선택 옵션: {offer.optionLabel || '미확인'}
                  </p>
                  <p
                    className={
                      offer.match === 'exact'
                        ? 'text-emerald-700'
                        : 'text-amber-800'
                    }
                  >
                    {MATCH_LABELS[offer.match]}
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <Price
                      label="판매 묶음"
                      value={
                        offer.packQuantity == null
                          ? '수량 미확인'
                          : `${offer.packQuantity}개 / 묶음`
                      }
                    />
                    <Price
                      label="구매 묶음"
                      value={
                        amounts?.packCount == null
                          ? '미확인'
                          : `${amounts.packCount}묶음`
                      }
                    />
                    <Price
                      label={
                        offerPriceKind(offer) === 'listing'
                          ? '상품 표시 가격 · 옵션 미확인'
                          : '선택 옵션 가격'
                      }
                      value={moneyLabel(offer.packPrice, offer.currency)}
                    />
                    <Price
                      label="확인된 부품 소계"
                      value={moneyLabel(amounts?.subtotal ?? null)}
                    />
                  </div>
                  <ProductLink offer={offer} />
                </div>
              ) : (
                <p className="mt-2 text-xs leading-5 text-[#6e6e73]">
                  {isQuote
                    ? '위 상품 후보 비교에서 구매 후보를 선택해 주세요.'
                    : '검색 전에도 모델과 필요 수량을 CSV로 저장할 수 있습니다.'}
                </p>
              )}
            </details>
          ))}
        </div>
        {!summary.rows.length && (
          <p className="py-3 text-xs leading-5 text-[#6e6e73]">
            현재 설계에 기록된 검색 대상 부품이 없습니다.
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2 border-t border-[#e5e5ea] pt-3">
          {isQuote && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canSave || saving || disabled}
              onClick={onSave}
            >
              {saving ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
              견적 선택 저장
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!summary.rows.length}
            onClick={download}
          >
            <Download className="size-3.5" />
            CSV 저장
          </Button>
        </div>
        <p className="mt-2 text-xs leading-5 text-[#6e6e73]">
          선택한 상품과 CSV에 같은 수량·금액이 반영됩니다.
        </p>
        {notice && (
          <output
            aria-live="polite"
            className="mt-3 block break-words rounded-lg bg-[#eff6ff] p-2 text-xs leading-5 text-[#3c3c43]"
          >
            {notice}
          </output>
        )}
      </section>

      <details className="rounded-xl border border-[#e5e5ea] bg-white p-3 text-xs leading-5 text-[#6e6e73]">
        <summary className="cursor-pointer rounded font-medium text-[#3c3c43] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3182f6]">
          견적 범위와 미확인 항목
        </summary>
        <div className="mt-2 space-y-2">
          <p>모터·프로펠러·배터리·서보 네 종류 부품의 견적입니다.</p>
          {snapshot.exclusions.map((text, index) => (
            <p key={index} className="break-words">
              {text}
            </p>
          ))}
          <p>
            상품 표시 가격은 요청 옵션의 확정 가격이 아니며 소계에 포함하지
            않습니다. 원통화로 표시된 가격을 임의로 환산하지 않습니다.
          </p>
          <p>
            배송비·세금·쿠폰·한국 배송 가능 여부는 구매 페이지에서 확인하세요.
            검색 결과는 AliExpress 제휴 상품 범위이며, 제휴 링크를 통한 구매 시
            수수료가 발생할 수 있습니다.
          </p>
        </div>
      </details>
    </section>
  );
}

function PartCard({
  item,
  result,
  selectedOffer,
  radioGroup,
  disabled,
  onSelect,
}: {
  item: BomItem;
  result: PartSearchResult | null;
  selectedOffer: ProductOffer | null;
  radioGroup: string;
  disabled: boolean;
  onSelect: (offerId: string | null) => void;
}) {
  return (
    <section
      id={`part-${item.id}`}
      aria-label={`${KIND_LABELS[item.kind]} ${item.model || '모델 미확인'}`}
      className="min-w-0 scroll-mt-4 rounded-xl border border-[#e5e5ea] bg-white p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-[#3182f6]">
            {KIND_LABELS[item.kind]}
          </p>
          <h4 className="mt-1 break-words text-sm font-semibold text-[#1d1d1f]">
            {modelLabel(item.model)}
          </h4>
        </div>
        <span className="shrink-0 text-xs text-[#3c3c43]">
          필요 {quantityLabel(item.quantity)}
        </span>
      </div>
      {selectedOffer ? (
        <div className="mt-3 rounded-lg bg-[#eff6ff] p-2 text-xs">
          <p className="text-[#1b64da]">
            선택한 상품 · {MATCH_LABELS[selectedOffer.match]}
          </p>
          <p className="mt-1 break-words font-medium leading-5 text-[#3c3c43]">
            {selectedOffer.title}
          </p>
          <p className="mt-1 text-[#6e6e73]">
            {offerPriceKind(selectedOffer) === 'listing'
              ? '상품 표시 가격 · 옵션 미확인'
              : '선택 옵션 가격'}{' '}
            {moneyLabel(selectedOffer.packPrice, selectedOffer.currency)}
          </p>
          <div className="mt-2">
            <ProductLink offer={selectedOffer} />
          </div>
        </div>
      ) : (
        <p className="mt-2 text-xs text-[#6e6e73]">
          {result
            ? result.offers.length
              ? '구매 후보를 선택하세요'
              : STATUS_LABELS[result.status]
            : item.model
              ? '상품 검색 전'
              : '모델 확인 필요'}
        </p>
      )}
      <details className="mt-3">
        <summary className="cursor-pointer rounded text-xs font-medium text-[#3182f6] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3182f6]">
          {result?.offers.length
            ? `상품 후보 ${result.offers.length}개 · 옵션과 근거 보기`
            : '규격과 조회 내역 보기'}
        </summary>
        <div className="mt-3 space-y-2 text-xs">
          <p className="break-words leading-5 text-[#6e6e73]">
            필요 규격: {specsLabel(item.specs) || '미확인'}
          </p>
          {item.issues.map((issue, index) => (
            <p key={index} className="break-words leading-5 text-amber-800">
              {issue}
            </p>
          ))}
          {result?.warnings.map((warning, index) => (
            <p key={index} className="break-words leading-5 text-amber-800">
              {warning}
            </p>
          ))}
          {result?.offers.length ? (
            <fieldset className="min-w-0 space-y-2" disabled={disabled}>
              <legend className="mb-2 leading-5 text-[#6e6e73]">
                구매 후보 선택 · 대체 후보는 자동으로 반영하지 않습니다
              </legend>
              {result.offers.map((offer, index) => (
                <OfferCard
                  key={offer.id}
                  item={item}
                  offer={offer}
                  selected={selectedOffer?.id === offer.id}
                  inputId={`${radioGroup}-${index}`}
                  radioGroup={radioGroup}
                  onSelect={() => onSelect(offer.id)}
                />
              ))}
              {selectedOffer && (
                <button
                  type="button"
                  onClick={() => onSelect(null)}
                  className="rounded text-xs text-[#6e6e73] underline underline-offset-2 disabled:opacity-50"
                >
                  선택 해제
                </button>
              )}
            </fieldset>
          ) : (
            <p className="leading-5 text-[#6e6e73]">
              {result?.status === 'not_configured'
                ? '연결 준비가 끝나면 이 부품 목록으로 다시 검색할 수 있습니다.'
                : result
                  ? '확인된 구매 후보가 없습니다. 부품 목록은 CSV로 저장할 수 있습니다.'
                  : '현재 설계로 부품 찾기를 실행해 주세요.'}
            </p>
          )}
          {result && (
            <p className="text-[#86868b]">
              {STATUS_LABELS[result.status]} · 조회{' '}
              {dateLabel(result.retrievedAt)}
            </p>
          )}
        </div>
      </details>
    </section>
  );
}

function OfferCard({
  item,
  offer,
  selected,
  inputId,
  radioGroup,
  onSelect,
}: {
  item: BomItem;
  offer: ProductOffer;
  selected: boolean;
  inputId: string;
  radioGroup: string;
  onSelect: () => void;
}) {
  const amounts = calculateOfferAmounts(item, offer);
  const canonical = canonicalProductLink(offer.url, offer.productId);
  const promotion = affiliatePromotionLink(offer.promotionUrl, offer.productId);
  return (
    <div
      className={`min-w-0 rounded-lg border p-3 ${selected ? 'border-[#3182f6] bg-[#f0f9fa]' : 'border-[#e5e5ea]'}`}
    >
      <div className="flex items-start gap-2">
        <input
          id={inputId}
          type="radio"
          name={radioGroup}
          aria-label={`${offer.title} ${offer.optionLabel ?? '옵션 미확인'}`}
          checked={selected}
          onChange={onSelect}
          className="mt-1 shrink-0 accent-[#3182f6]"
        />
        <div className="min-w-0 flex-1">
          <p
            className={`font-semibold ${offer.match === 'exact' ? 'text-emerald-700' : 'text-amber-800'}`}
          >
            {offer.match === 'exact' && (
              <Check className="mr-1 inline size-3" />
            )}
            {MATCH_LABELS[offer.match]}
          </p>
          <label
            htmlFor={inputId}
            className="mt-1 block cursor-pointer break-words text-sm font-medium leading-5 text-[#3c3c43]"
          >
            {offer.title}
          </label>
          <p className="mt-2 font-medium text-[#3c3c43]">
            {moneyLabel(offer.packPrice, offer.currency)}{' '}
            <span className="font-normal text-[#6e6e73]">
              ·{' '}
              {offerPriceKind(offer) === 'listing'
                ? '상품 표시 가격 · 옵션 미확인'
                : '선택 옵션 가격'}
            </span>
          </p>
          <div className="mt-2">
            <ProductLink offer={offer} />
          </div>
        </div>
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer rounded text-[#6e6e73] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3182f6]">
          옵션·묶음·배송·일치 근거
        </summary>
        <div className="mt-3 space-y-2">
          <p className="break-words leading-5 text-[#6e6e73]">
            판매 옵션: {offer.optionLabel || '미확인'}
            {!offer.optionVerified ? ' · 가격 확인 필요' : ''}
          </p>
          <p className="break-words leading-5 text-[#6e6e73]">
            판매 규격: {specsLabel(offer.specs) || '미확인'}
          </p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-3">
            <Price
              label="묶음당 개수 / 구매 묶음"
              value={`${offer.packQuantity ?? '?'}개 / ${amounts.packCount ?? '?'}묶음`}
            />
            <Price
              label="개당 가격 / 확인된 소계"
              value={`${moneyLabel(amounts.unitPrice)} / ${moneyLabel(amounts.subtotal)}`}
            />
            <Price
              label="한국 배송 / 조회 배송비"
              value={`${offer.shippingAvailable == null ? '미확인' : offer.shippingAvailable ? '가능' : '불가'} / ${moneyLabel(offer.shippingCost, offer.shippingCurrency)}`}
            />
            <Price
              label="확인된 배송비 / 재고"
              value={`${moneyLabel(amounts.shipping)} / ${offer.stock == null ? '미확인' : offer.stock === 0 ? '품절' : `${offer.stock}묶음`}`}
            />
          </div>
          {offer.stock === 0 && <p className="text-red-700">현재 품절</p>}
          {offer.reasons.map((reason, index) => (
            <p key={index} className="break-words leading-5 text-[#6e6e73]">
              {reason}
            </p>
          ))}
          {amounts.subtotal == null && (
            <p className="leading-5 text-amber-800">
              옵션·수량·재고·규격·통화 정보가 충분히 확인되지 않아 소계에
              반영하지 않습니다.
            </p>
          )}
          {promotion && canonical && (
            <a
              href={canonical}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[#3182f6] underline underline-offset-2"
            >
              일반 상품 링크
              <ExternalLink className="size-3" />
            </a>
          )}
          <p className="text-[#86868b]">조회 {dateLabel(offer.retrievedAt)}</p>
        </div>
      </details>
    </div>
  );
}

function ProductLink({ offer }: { offer: ProductOffer }) {
  const url = purchaseLink(offer);
  const promotion = affiliatePromotionLink(offer.promotionUrl, offer.productId);
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer sponsored"
      className="inline-flex items-center gap-1 text-xs font-medium text-[#3182f6] underline underline-offset-2"
    >
      {promotion ? '제휴 상품 보기' : '상품 보기'}
      <ExternalLink className="size-3 shrink-0" />
    </a>
  ) : (
    <span className="text-xs text-[#86868b]">상품 링크 미확인</span>
  );
}

function Total({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-[#6e6e73]">{label}</p>
      <p className="mt-1 break-words text-lg font-semibold tabular-nums text-[#1d1d1f]">
        {value}
      </p>
      <p className="mt-1 text-xs leading-5 text-[#86868b]">{note}</p>
    </div>
  );
}

function Price({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="leading-5 text-[#86868b]">{label}</p>
      <p className="mt-1 break-words font-medium leading-5 tabular-nums text-[#3c3c43]">
        {value}
      </p>
    </div>
  );
}
