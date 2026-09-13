import { parsePartSpecs } from '../bom';
import type { PartSearchRequest, PartSpecs } from '../types';
import { hasControls, plain, record } from './http';

export function validatePartSearch(value: unknown): PartSearchRequest | null {
  const body = record(value);
  const item = record(body.item);
  if (body.country !== 'KR' || body.currency !== 'KRW') return null;
  if (!['motor', 'propeller', 'battery', 'servo'].includes(String(item.kind))) return null;
  if (typeof item.id !== 'string' || item.id.length < 1 || item.id.length > 800 || /[<>]/.test(item.id) || hasControls(item.id)) return null;
  if (typeof item.model !== 'string' || item.model.length > 240 || !item.model.trim() || /https?:|www\.|[<>]/i.test(item.model) || hasControls(item.model)) return null;
  if (item.quantity !== null && (typeof item.quantity !== 'number' || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000)) return null;
  if (!Array.isArray(item.instances) || item.instances.length > 1000 || !item.instances.every((entry) => typeof entry === 'string' && entry.length <= 160)) return null;
  if (!Array.isArray(item.issues) || item.issues.length > 20 || !item.issues.every((entry) => typeof entry === 'string' && entry.length <= 300)) return null;
  if (typeof item.specs !== 'object' || item.specs === null || Array.isArray(item.specs)) return null;
  const supplied = record(item.specs);
  const specs: PartSpecs = {};
  const keys: (keyof PartSpecs)[] = ['motorKv', 'diameterIn', 'pitchIn', 'cells', 'capacityMah', 'dischargeC', 'voltage'];
  for (const key of Object.keys(supplied)) {
    if (!keys.includes(key as keyof PartSpecs)) return null;
    const numeric = supplied[key];
    if (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric <= 0 || numeric > 1_000_000) return null;
    if (key === 'cells' && (!Number.isInteger(numeric) || numeric > 24)) return null;
    specs[key as keyof PartSpecs] = numeric;
  }
  const kind = item.kind as PartSearchRequest['item']['kind'];
  return { country: 'KR', currency: 'KRW', item: {
    id: item.id, kind, model: item.model.trim(), quantity: item.quantity as number | null,
    instances: item.instances.map((entry) => plain(entry, 160)), issues: item.issues.map((entry) => plain(entry, 300)),
    specs: { ...specs, ...parsePartSpecs(kind, item.model) },
  } };
}
