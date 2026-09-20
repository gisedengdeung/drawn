import { createHmac } from 'node:crypto';
import { affiliatePromotionLink, canonicalProductLink } from '../links';
import type { PartsConfig } from './config';
import { fetchJson, list, PartsError, plain, positiveNumber, record, scalarText, type Fetcher } from './http';

export type SourceProduct = {
  productId: string;
  title: string;
  url: string;
  promotionUrl?: string | null;
  price: number | null;
  currency: string;
  description: string;
  skus: SourceSku[];
  available?: boolean;
};

export type SourceSku = {
  id: string;
  label: string;
  price: number | null;
  currency: string;
  stock: number | null;
};

// TOP protocol: sorted nonempty key/value pairs, UTF-8 HMAC-MD5, uppercase hex.
// This is deliberately not the different AliExpress IOP /rest SHA256 protocol.
export function signTop(params: Record<string, string>, secret: string): string {
  const text = Object.keys(params).filter((key) => key !== 'sign' && params[key] !== '')
    .sort().map((key) => key + params[key]).join('');
  return createHmac('md5', secret).update(text, 'utf8').digest('hex').toUpperCase();
}

export function productUrl(value: unknown, productId: string): string | null {
  return canonicalProductLink(value, productId);
}

function providerFailure(value: Record<string, unknown>): void {
  const code = scalarText(value.code ?? value.resp_code ?? value.rsp_code);
  const detail = scalarText(value.sub_code) + ' ' + scalarText(value.msg ?? value.resp_msg ?? value.rsp_msg);
  if (!code || code === '0' || code === '200') return;
  if (/limit|frequen|throttl/i.test(code + detail) || ['7', '15', '429'].includes(code)) {
    throw new PartsError('rate_limited', 'AliExpress 조회 한도에 도달했습니다. 잠시 후 다시 시도하세요.');
  }
  if (/auth|permission|session|token|sign|app.?key|access.?denied|illegal.?app/i.test(code + detail) || ['9', '11', '12', '27', '29', '40', '41', '42', '401', '403'].includes(code)) {
    throw new PartsError('permission_denied', 'AliExpress 상품 조회 서비스의 연결 권한을 확인해야 합니다.');
  }
  throw new PartsError('error', 'AliExpress가 상품 조회를 처리하지 못했습니다.');
}

export function parseAffiliateProducts(value: unknown): SourceProduct[] {
  return list(value, 'product').flatMap((entry) => {
    // String conversion only: numeric provider IDs must still be safe JS integers.
    if (typeof entry.product_id === 'number' && !Number.isSafeInteger(entry.product_id)) return [];
    const productId = scalarText(entry.product_id);
    if (!/^\d{5,20}$/.test(productId)) return [];
    const url = productUrl(entry.product_detail_url, productId);
    const title = plain(entry.product_title, 500);
    if (!url || !title) return [];
    const targetPrice = positiveNumber(entry.target_sale_price);
    const sourcePrice = positiveNumber(entry.sale_price);
    const currency = plain(targetPrice !== null ? entry.target_sale_price_currency : entry.sale_price_currency, 3).toUpperCase();
    return [{ productId, title, url, promotionUrl: affiliatePromotionLink(entry.promotion_link, productId), price: /^[A-Z]{3}$/.test(currency) ? targetPrice ?? sourcePrice : null,
      currency: /^[A-Z]{3}$/.test(currency) ? currency : 'KRW', description: '', skus: [] }];
  });
}

export class AliExpressProvider {
  constructor(private config: PartsConfig, private fetcher: Fetcher, private signal: AbortSignal, private now: () => number = Date.now) {}

  private async call(method: string, input: Record<string, string>, authorized = false): Promise<Record<string, unknown>> {
    const params: Record<string, string> = {
      method, app_key: this.config.appKey, sign_method: 'hmac',
      timestamp: new Date(this.now() + 8 * 3_600_000).toISOString().slice(0, 19).replace('T', ' '),
      format: 'json', v: '2.0', ...input,
    };
    if (authorized) params.session = this.config.accessToken;
    params.sign = signTop(params, this.config.appSecret);
    const json = await fetchJson(this.config.gateway, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams(params).toString(),
    }, this.fetcher, this.signal);
    if (json.error_response) {
      providerFailure(record(json.error_response));
      throw new PartsError('error', 'AliExpress가 상품 조회를 처리하지 못했습니다.');
    }
    const response = record(json[method.replaceAll('.', '_') + '_response']);
    if (Object.keys(response).length === 0) throw new PartsError('error', 'AliExpress 상품 응답 형식을 확인할 수 없습니다.');
    providerFailure(response);
    if (response.resp_result) {
      const wrapped = record(response.resp_result);
      providerFailure(wrapped);
      return record(wrapped.result);
    }
    return record(response.result);
  }

  async search(query: string): Promise<SourceProduct[]> {
    const result = await this.call('aliexpress.affiliate.product.query', {
      keywords: query, page_no: '1', page_size: '8', target_currency: 'KRW',
      target_language: 'EN', ship_to_country: 'KR', ...(this.config.trackingId ? { tracking_id: this.config.trackingId } : {}),
    });
    return parseAffiliateProducts(result.products);
  }

  async details(ids: string[]): Promise<SourceProduct[]> {
    const result = await this.call('aliexpress.affiliate.productdetail.get', {
      product_ids: ids.slice(0, 6).join(','), country: 'KR', target_currency: 'KRW', target_language: 'EN',
      ...(this.config.trackingId ? { tracking_id: this.config.trackingId } : {}),
    });
    return parseAffiliateProducts(result.products);
  }

  async promotionLinks(products: SourceProduct[]): Promise<SourceProduct[]> {
    if (!this.config.trackingId || !products.length) return products;
    const bounded = products.slice(0, 6);
    const result = await this.call('aliexpress.affiliate.link.generate', {
      promotion_link_type: '0', source_values: bounded.map((product) => product.url).join(','),
      tracking_id: this.config.trackingId,
    });
    if (result.tracking_id && scalarText(result.tracking_id) !== this.config.trackingId) return products;
    const links = new Map<string, string>();
    for (const row of list(result.promotion_links, 'promotion_link')) {
      // Bind every redirect to the exact source sent in this request, never array order.
      const product = bounded.find((candidate) => candidate.url === row.source_value);
      if (!product) continue;
      const link = affiliatePromotionLink(row.promotion_link, product.productId);
      if (link) links.set(product.productId, link);
    }
    return products.map((product) => ({ ...product, promotionUrl: links.get(product.productId) ?? product.promotionUrl ?? null }));
  }

  async skuDetails(product: SourceProduct): Promise<SourceProduct> {
    const result = await this.call('aliexpress.ds.product.get', {
      product_id: product.productId, ship_to_country: 'KR', target_currency: 'KRW', target_language: 'EN',
    }, true);
    const base = record(result.ae_item_base_info_dto);
    if (scalarText(base.product_id) !== product.productId) return product;
    if (base.product_status_type && base.product_status_type !== 'onSelling') return { ...product, skus: [], price: null, available: false };
    const skus = list(result.ae_item_sku_info_dtos, 'ae_item_sku_info_d_t_o').slice(0, 40).flatMap((entry): SourceSku[] => {
      const id = plain(entry.sku_id ?? entry.id, 200);
      if (!/^[\d:;_-]{1,200}$/.test(id)) return [];
      const labels = list(entry.ae_sku_property_dtos, 'ae_sku_property_d_t_o').map((property) =>
        `${plain(property.sku_property_name, 60)}: ${plain(property.property_value_definition_name || property.sku_property_value, 100)}`);
      const currency = plain(entry.currency_code, 3).toUpperCase();
      const stock = positiveNumber(entry.sku_available_stock ?? entry.ipm_sku_stock, true) ?? (entry.sku_stock === false ? 0 : null);
      return [{ id, label: labels.join('; '), price: /^[A-Z]{3}$/.test(currency) ? positiveNumber(entry.offer_sale_price) ?? positiveNumber(entry.sku_price) : null,
        currency: /^[A-Z]{3}$/.test(currency) ? currency : product.currency, stock }];
    });
    return { ...product, description: plain(base.detail, 2500), skus };
  }
}
