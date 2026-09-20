export type PartKind = 'motor' | 'propeller' | 'battery' | 'servo';

export type PartSpecs = {
  motorKv?: number;
  diameterIn?: number;
  pitchIn?: number;
  cells?: number;
  capacityMah?: number;
  dischargeC?: number;
  voltage?: number;
};

export type BomItem = {
  id: string;
  kind: PartKind;
  model: string;
  quantity: number | null;
  instances: string[];
  specs: PartSpecs;
  issues: string[];
};

export type BomSnapshot = {
  fingerprint: string;
  designId: number;
  createdAt: string;
  items: BomItem[];
  exclusions: string[];
};

export type ProductOffer = {
  id: string;
  productId: string;
  title: string;
  url: string;
  optionId: string | null;
  optionLabel: string | null;
  optionVerified: boolean;
  packPrice: number | null;
  packQuantity: number | null;
  currency: string;
  match: 'exact' | 'alternative' | 'needs_review';
  reasons: string[];
  specs: PartSpecs;
  shippingAvailable: boolean | null;
  shippingCost: number | null;
  shippingCurrency: string | null;
  stock: number | null;
  retrievedAt: string;
};

export type PartSearchRequest = {
  item: BomItem;
  country: 'KR';
  currency: 'KRW';
};

export type PartSearchResult = {
  itemId: string;
  status: 'ok' | 'not_found' | 'not_configured' | 'permission_denied' | 'rate_limited' | 'error';
  offers: ProductOffer[];
  warnings: string[];
  retrievedAt: string;
};

export type QuoteLine = {
  item: BomItem;
  result: PartSearchResult | null;
  selectedOfferId: string | null;
};

export type OfferAmounts = {
  packCount: number | null;
  unitPrice: number | null;
  subtotal: number | null;
  shipping: number | null;
};
