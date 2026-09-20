import { parsePartSpecs } from '../bom';
import type { BomItem, PartSearchRequest, PartSearchResult, PartSpecs, ProductOffer } from '../types';
import { AliExpressProvider, type SourceProduct, type SourceSku } from './aliexpress';
import { PartsAI, type SourceAssessment } from './ai';
import { getPartsConfig, type PartsConfig } from './config';
import { PartsError, type Fetcher } from './http';

const category = { motor: 'brushless motor', propeller: 'propeller', battery: 'LiPo battery', servo: 'servo' };
const identity = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
const requiredKeys = { motor: ['motorKv'], propeller: ['diameterIn', 'pitchIn'], battery: ['cells', 'capacityMah'], servo: [] } as const;

export function conflictingSpecs(requested: PartSpecs, actual: PartSpecs): boolean {
  return (['motorKv', 'diameterIn', 'pitchIn', 'cells', 'capacityMah', 'dischargeC', 'voltage'] as const).some((key) =>
    requested[key] !== undefined && actual[key] !== undefined && Math.abs(requested[key]! - actual[key]!) > 0.01);
}

export function packQuantity(text: string): number | null {
  const matches = [...text.matchAll(/\b(\d{1,3})\s*(?:pcs?|pieces?|pack|pairs?)\b/gi)]
    .map((match) => Number(match[1]) * (/pair/i.test(match[0]) ? 2 : 1));
  if (/\bsingle\b/i.test(text)) matches.push(1);
  return matches.length > 0 && matches.every((value) => value === matches[0]) && matches[0] > 0 ? matches[0] : null;
}

function withoutSpecs(item: BomItem, source: string): string {
  let text = source.toLowerCase();
  if (item.kind === 'motor') text = text.replace(/\d+(?:\.\d+)?[\s_-]*kv(?!\d)|kv[\s_-]*\d+(?:\.\d+)?(?=$|[\s_/-])/gi, '');
  if (item.kind === 'propeller') text = text.replace(/\d+(?:[._]\d+)?\s*[x×]\s*\d+(?:[._]\d+)?/gi, '');
  if (item.kind === 'battery') text = text
    .replace(/\d+(?:\.\d+)?\s*mah|\d+\s*s(?:\d+\s*p)?|\d+(?:\.\d+)?\s*c|\d+(?:[._]\d+)?\s*v\b/gi, '');
  return text.replace(/\b\d+\s*(?:pcs?|pieces?|packs?|pairs?)\b/gi, '')
    .replace(/propellers?|batteries|battery|servos?|brushless|motors?/gi, '');
}

function modelIdentity(item: BomItem, source: string): string {
  return identity(withoutSpecs(item, source));
}

function modelCodes(item: BomItem, source: string): string[] {
  return [...new Set([...withoutSpecs(item, source).replaceAll('_', ' ').matchAll(/\b[a-z]{0,8}[-_]?\d{2,6}[a-z]{0,5}\b/gi)]
    .map((match) => identity(match[0])))];
}

function hasIdentity(item: BomItem, source: string): boolean {
  const rawKey = identity(item.model);
  if (rawKey.length < 4 || /^(?:unknown|none|null|na|motor|battery|propeller|servo)$/.test(rawKey)) return false;
  const key = modelIdentity(item, item.model);
  // Specs are checked independently and must be present in the selected SKU.
  // The remaining brand/model identity must still be meaningful (not just numbers).
  const knownShortBrand = item.kind === 'propeller' && key === 'apc'
    && item.specs.diameterIn !== undefined && item.specs.pitchIn !== undefined
    && /\bapc\b/i.test(source.replaceAll('_', ' '));
  return (key.length >= 4 || knownShortBrand) && /[a-z]/.test(key) && modelIdentity(item, source).includes(key);
}

function groundedAlternativeModel(item: BomItem, product: SourceProduct, label: string, assessment: SourceAssessment | undefined): boolean {
  if (assessment?.relation !== 'alternative' || !assessment.evidence) return false;
  const evidence = assessment.evidence;
  if (![product.title, product.description, ...product.skus.map((option) => option.label)].some((text) => text.includes(evidence))) return false;
  const categoryPattern = {
    motor: /\b(?:motors?|brushless|outrunner|inrunner)\b/i,
    propeller: /\b(?:propellers?|airscrews?|props?)\b/i,
    battery: /\b(?:batter(?:y|ies)|lipo|li-ion)\b/i,
    servo: /\bservos?\b/i,
  };
  if (!categoryPattern[item.kind].test(`${product.title} ${label}`)) return false;
  const selected = modelCodes(item, label);
  const advertised = modelCodes(item, product.title);
  const cited = modelCodes(item, evidence);
  // A cited alternative model must identify this selected option, not another
  // model elsewhere in a multi-model listing.
  if (selected.length > 1) return false;
  const offered = selected[0] ?? (advertised.length === 1 ? advertised[0] : null);
  if (offered) return cited.includes(offered) && (advertised.length === 0 || advertised.includes(offered));
  if (item.kind === 'motor' || item.kind === 'servo' || advertised.length > 1) return false;
  // Propellers and batteries often use brand + dimensions/capacity instead of
  // a separate alphanumeric model code. Require that identity in literal title
  // evidence, together with its core numeric specs.
  if (!product.title.includes(evidence)) return false;
  const evidenceSpecs = parsePartSpecs(item.kind, evidence);
  if (!requiredKeys[item.kind].every((key) => evidenceSpecs[key] !== undefined)) return false;
  const remaining = withoutSpecs(item, evidence).replace(/\b(?:lipo|li-ion|lithium|high|quality|new|original|genuine|for|rc|drone|aircraft|model|color|black|white)\b/gi, '');
  return identity(remaining).length >= 3 && /[a-z]{3}/i.test(remaining);
}

function offerFor(item: BomItem, product: SourceProduct, sku: SourceSku | undefined, assessment: SourceAssessment | undefined, retrievedAt: string): ProductOffer | null {
  const label = sku?.label ?? '';
  // A multi-option title may contain other variants. SKU values take precedence;
  // title-only contradictions still exclude product-level candidates.
  const evidenceSpecs = assessment?.evidence ? parsePartSpecs(item.kind, assessment.evidence) : {};
  const titleSpecs = { ...evidenceSpecs, ...parsePartSpecs(item.kind, product.title) };
  const optionSpecs = parsePartSpecs(item.kind, label);
  const specs = { ...titleSpecs, ...optionSpecs };
  const accessory = /\b(?:screws? only|accessor(?:y|ies) only|shaft only|mount only|motor mount|replacement shaft|propeller adapter|sticker|empty case|battery charger|battery holder|servo horn)\b/i;
  if (product.available === false || conflictingSpecs(item.specs, specs) || sku?.stock === 0 || assessment?.relation === 'unrelated' || accessory.test(label) || accessory.test(product.title)) return null;
  const requestedCodes = modelCodes(item, item.model);
  const optionCodes = modelCodes(item, label);
  const titleCodes = modelCodes(item, product.title);
  const alternativeModelVerified = groundedAlternativeModel(item, product, label, assessment);
  // A listing can advertise many motors/servos with the same KV. Selection of
  // another explicitly named model can never be rescued by the listing title.
  if (requestedCodes.length && optionCodes.length && !requestedCodes.every((code) => optionCodes.includes(code)) && !alternativeModelVerified) return null;
  const selectionDisambiguated = requestedCodes.length === 0 || titleCodes.length <= requestedCodes.length || requestedCodes.every((code) => optionCodes.includes(code));
  const modelFound = hasIdentity(item, `${product.title} ${label}`);
  const keys: (keyof PartSpecs)[] = [...new Set<keyof PartSpecs>([...requiredKeys[item.kind], ...Object.keys(item.specs) as (keyof PartSpecs)[]])];
  // Variant-specific values must appear in the selected option itself; title
  // specifications alone may belong to a different, cheaper variant.
  const specificationsComplete = keys.every((key) => item.specs[key] !== undefined && optionSpecs[key] !== undefined);
  // Verifying a selected SKU/price is separate from declaring it the requested
  // model. A grounded alternative stays alternative and requires manual choice.
  const declaredAlternative = assessment?.relation === 'alternative';
  const verifiedModel = declaredAlternative ? alternativeModelVerified : modelFound && selectionDisambiguated;
  const optionVerified = Boolean(sku?.id && label && specificationsComplete && verifiedModel);
  const match = declaredAlternative ? 'alternative' : optionVerified ? 'exact' : 'needs_review';
  const reasons: string[] = [];
  if (modelFound) reasons.push('상품 정보에서 요청 모델 문자열을 확인했습니다.');
  else reasons.push('동일 모델이 확인되지 않았습니다. 호환성을 직접 확인하세요.');
  if (assessment?.evidence) reasons.push(`상품 근거: ${assessment.evidence}`);
  if (!optionVerified) reasons.push('선택 옵션과 부품 규격 확인이 필요합니다. 표시 가격은 확정 견적에 포함되지 않습니다.');
  if (match === 'alternative') reasons.push(optionVerified
    ? '선택 옵션의 규격과 가격을 확인한 대체 후보입니다. 장착 규격과 전기적 호환성을 확인한 뒤 직접 선택하세요.'
    : '대체 후보입니다. 장착 규격과 전기적 호환성을 확인하세요.');
  const pack = packQuantity(sku ? label : product.title);
  if (pack === null) reasons.push('한 판매 묶음에 포함된 수량을 확인하지 못했습니다.');
  reasons.push('한국 배송 가능 여부와 배송비는 구매 페이지에서 확인하세요.');
  const price = sku ? sku.price : product.price;
  return {
    id: `${product.productId}:${sku?.id ?? 'unverified'}`, productId: product.productId, title: product.title, url: product.url,
    optionId: sku?.id ?? null, optionLabel: sku?.label || null, optionVerified,
    packPrice: price, packQuantity: pack, currency: sku?.currency ?? product.currency,
    match, reasons, specs, shippingAvailable: null, shippingCost: null, shippingCurrency: null,
    stock: sku?.stock ?? null, retrievedAt,
  };
}

export function buildOffers(item: BomItem, products: SourceProduct[], assessments: SourceAssessment[], retrievedAt: string): ProductOffer[] {
  const ordered = [...products].sort((a, b) => {
    const rank = (id: string) => { const index = assessments.findIndex((entry) => entry.productId === id); return index < 0 ? 999 : index; };
    return rank(a.productId) - rank(b.productId);
  });
  const offers = ordered.flatMap((product) => {
    const assessment = assessments.find((entry) => entry.productId === product.productId);
    const options = product.skus.length ? product.skus : [undefined];
    const candidates = options.map((sku) => offerFor(item, product, sku, assessment, retrievedAt)).filter((offer): offer is ProductOffer => offer !== null);
    // One seller/product per result; choose a verified option first, not a teaser price.
    candidates.sort((a, b) => Number(b.optionVerified) - Number(a.optionVerified));
    return candidates.slice(0, 1);
  });
  return offers.sort((a, b) => Number(b.optionVerified) - Number(a.optionVerified)).slice(0, 3);
}

export async function searchParts(request: PartSearchRequest, dependencies: { config?: PartsConfig; fetcher?: Fetcher; now?: () => number; signal?: AbortSignal } = {}): Promise<PartSearchResult> {
  const config = dependencies.config ?? getPartsConfig();
  const now = dependencies.now ?? Date.now;
  const retrievedAt = new Date(now()).toISOString();
  const result: PartSearchResult = { itemId: request.item.id, status: 'ok', offers: [], warnings: [], retrievedAt };
  if (!config.appKey || !config.appSecret) return { ...result, status: 'not_configured', warnings: ['실제 상품을 찾으려면 상품 조회 서비스 연결이 필요합니다.'] };
  if (/^(unknown|none|null|n\/?a|미상|미정)$/i.test(request.item.model.trim())) return { ...result, status: 'not_found', warnings: ['부품 모델이 없어 상품을 검색할 수 없습니다.'] };
  const signal = AbortSignal.any([AbortSignal.timeout(55_000), ...(dependencies.signal ? [dependencies.signal] : [])]);
  const fetcher = dependencies.fetcher ?? fetch;
  const provider = new AliExpressProvider(config, fetcher, signal, now);
  const ai = new PartsAI(config, fetcher, signal);
  const queries = [`${request.item.model} ${category[request.item.kind]}`.slice(0, 150)];
  let aiAvailable = Boolean(config.openaiKey);
  if (aiAvailable) {
    try { const query = await ai.query(request.item); if (query && query !== queries[0]) queries.push(query); }
    catch { result.warnings.push('AI 검색어 분석을 사용할 수 없어 원래 모델명으로 검색합니다.'); aiAvailable = false; }
  } else result.warnings.push('AI 분석이 연결되어 있지 않아 모델명과 규격만으로 검색합니다.');
  try {
    const found = new Map<string, SourceProduct>();
    const searches = await Promise.allSettled(queries.slice(0, 2).map((query) => provider.search(query)));
    let searchError: unknown;
    let successfulSearches = 0;
    for (const response of searches) {
      if (response.status === 'fulfilled') { successfulSearches += 1; for (const product of response.value) found.set(product.productId, product); }
      else searchError = response.reason;
    }
    if (!successfulSearches) throw searchError;
    if (searchError) result.warnings.push('일부 검색을 완료하지 못했습니다. 반환된 후보만 표시합니다.');
    const ids = [...found.keys()].slice(0, 6);
    if (!ids.length) return { ...result, status: 'not_found', warnings: [...result.warnings, '조회 가능한 제휴 상품을 찾지 못했습니다.'] };
    // Re-read current product data. Missing detail rows are dropped, never upgraded from search snippets.
    let products = (await provider.details(ids)).filter((product) => ids.includes(product.productId));
    if (config.accessToken) {
      const enriched: SourceProduct[] = [];
      for (let offset = 0; offset < Math.min(products.length, 4); offset += 2) {
        const batch = products.slice(offset, offset + 2);
        const outcomes = await Promise.allSettled(batch.map((product) => provider.skuDetails(product)));
        outcomes.forEach((outcome, index) => {
          if (outcome.status === 'fulfilled') enriched.push(outcome.value);
          else { enriched.push(batch[index]); result.warnings.push(outcome.reason instanceof PartsError ? outcome.reason.message : '일부 상품 옵션을 확인하지 못했습니다.'); }
        });
      }
      products = [...enriched, ...products.slice(4)];
    } else result.warnings.push('상품 옵션 조회 권한이 없어 옵션별 가격은 미확인 상태입니다.');
    let assessments: SourceAssessment[] = [];
    if (aiAvailable && products.length) {
      try { assessments = await ai.assess(request.item, products); }
      catch { result.warnings.push('AI 후보 분석을 완료하지 못해 규격 규칙으로만 분류했습니다.'); }
    }
    result.offers = buildOffers(request.item, products, assessments, retrievedAt);
    if (!result.offers.length) result.status = 'not_found';
    result.warnings = [...new Set(result.warnings)];
    return result;
  } catch (error) {
    return { ...result, status: error instanceof PartsError ? error.status : 'error', offers: [],
      warnings: [...result.warnings, error instanceof PartsError ? error.message : '상품 검색을 완료하지 못했습니다. 잠시 후 다시 시도하세요.'] };
  }
}
