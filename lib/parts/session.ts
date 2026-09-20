import { isPartSearchResult } from './client';
import type { BomItem, BomSnapshot, PartKind, PartSpecs, QuoteLine } from './types';

const SESSION_KEY = 'drawn.parts-quote.v1';
const LEGACY_SESSION_KEY = 'aerotwin.parts-quote.v1';
type StoredQuote = { snapshot: BomSnapshot; lines: QuoteLine[] };

const kinds = new Set<PartKind>(['motor', 'propeller', 'battery', 'servo']);
const specKeys = new Set<keyof PartSpecs>([
  'motorKv', 'diameterIn', 'pitchIn', 'cells', 'capacityMah', 'dischargeC', 'voltage',
]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function strings(value: unknown, count: number, length: number): value is string[] {
  return Array.isArray(value) && value.length <= count
    && value.every((entry) => typeof entry === 'string' && entry.length <= length);
}

function isoDate(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/);
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && hour < 24 && minute < 60 && second < 60;
}

function bomItem(value: unknown): BomItem | null {
  if (!object(value) || typeof value.id !== 'string' || !value.id.length || value.id.length > 800
    || typeof value.kind !== 'string' || !kinds.has(value.kind as PartKind)
    || typeof value.model !== 'string' || value.model.length > 240
    || (value.quantity !== null && (typeof value.quantity !== 'number'
      || !Number.isSafeInteger(value.quantity) || value.quantity < 1 || value.quantity > 1000))
    || !strings(value.instances, 1000, 160) || !strings(value.issues, 20, 300)
    || !object(value.specs)) return null;
  const specs: PartSpecs = {};
  for (const [key, numeric] of Object.entries(value.specs)) {
    if (!specKeys.has(key as keyof PartSpecs) || typeof numeric !== 'number'
      || !Number.isFinite(numeric) || numeric <= 0 || numeric > 1_000_000
      || (key === 'cells' && (!Number.isInteger(numeric) || numeric > 24))) return null;
    specs[key as keyof PartSpecs] = numeric;
  }
  return {
    id: value.id, kind: value.kind as PartKind, model: value.model,
    quantity: value.quantity as number | null, instances: [...value.instances],
    specs, issues: [...value.issues],
  };
}

function sameItem(left: BomItem, right: BomItem): boolean {
  return left.id === right.id && left.kind === right.kind && left.model === right.model
    && left.quantity === right.quantity
    && JSON.stringify(left.instances) === JSON.stringify(right.instances)
    && JSON.stringify(left.issues) === JSON.stringify(right.issues)
    && [...specKeys].every((key) => left.specs[key] === right.specs[key]);
}

/** Restore one internally consistent v1 quote, or discard it as a whole. */
export function restoreQuote(text: string): StoredQuote | null {
  if (text.length > 1_000_000) return null;
  let saved: unknown;
  try { saved = JSON.parse(text); } catch { return null; }
  if (!object(saved) || !object(saved.snapshot)) return null;
  const source = saved.snapshot;
  if (typeof source.fingerprint !== 'string' || !/^[0-9a-f]{16}$/i.test(source.fingerprint)
    || typeof source.designId !== 'number' || !Number.isSafeInteger(source.designId) || source.designId < 1
    || !isoDate(source.createdAt) || !Array.isArray(source.items) || source.items.length > 100
    || !strings(source.exclusions, 20, 1000)
    || !Array.isArray(saved.lines) || saved.lines.length !== source.items.length) return null;

  const items: BomItem[] = [];
  const itemsById = new Map<string, BomItem>();
  for (const value of source.items) {
    const item = bomItem(value);
    if (!item || itemsById.has(item.id)) return null;
    items.push(item);
    itemsById.set(item.id, item);
  }
  const linesById = new Map<string, QuoteLine>();
  for (const value of saved.lines) {
    if (!object(value)) return null;
    const item = bomItem(value.item);
    const canonical = item && itemsById.get(item.id);
    if (!item || !canonical || !sameItem(item, canonical) || linesById.has(item.id)) return null;
    if (value.result !== null && !isPartSearchResult(value.result, item.id)) return null;
    if (value.selectedOfferId !== null && (typeof value.selectedOfferId !== 'string'
      || !value.result?.offers.some((offer) => offer.id === value.selectedOfferId))) return null;
    linesById.set(item.id, {
      item: canonical, result: value.result, selectedOfferId: value.selectedOfferId,
    });
  }
  return {
    snapshot: {
      fingerprint: source.fingerprint, designId: source.designId, createdAt: source.createdAt,
      items, exclusions: [...source.exclusions],
    },
    lines: items.map((item) => linesById.get(item.id)!),
  };
}

/** Prefer a valid current quote; older tabs can still recover their saved quote. */
export function loadStoredQuote(storage: Pick<Storage, 'getItem'>): StoredQuote | null {
  for (const key of [SESSION_KEY, LEGACY_SESSION_KEY]) {
    try {
      const text = storage.getItem(key);
      const saved = text ? restoreQuote(text) : null;
      if (saved) return saved;
    } catch { /* A blocked key must not prevent legacy recovery. */ }
  }
  return null;
}

/** Leave the legacy copy intact, including when browser storage is full. */
export function saveStoredQuote(storage: Pick<Storage, 'setItem'>, quote: StoredQuote): boolean {
  try {
    storage.setItem(SESSION_KEY, JSON.stringify(quote));
    return true;
  } catch {
    return false;
  }
}
