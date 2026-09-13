import type { DesignDraft, PhysicalComponent } from '../drawn-types';
import type { BomItem, BomSnapshot, PartKind, PartSpecs } from './types';

const kinds: PartKind[] = ['motor', 'propeller', 'battery', 'servo'];
const missingInstance = '실제 부품 인스턴스를 확인할 수 없어 수량을 확정하지 않았습니다.';
type InstanceRecord = { instance: string | null; model: string; issues: string[]; uncertain: boolean };

/** Only read specifications stated in the model; never infer electrical ratings. */
export function parsePartSpecs(kind: PartKind, model: string): PartSpecs {
  const specs: PartSpecs = {};
  if (kind === 'motor') {
    // SKU labels can say "980KV 4pcs"; the trailing pack count is not KV.
    // Conversely, in MN4012KV400 the number before KV belongs to the model.
    const prefix = /KV[\s_:=-]*(\d+(?:\.\d+)?)(?![\d.,a-z])/gi;
    const suffix = /(?<![\d.,])(\d+(?:\.\d+)?)[\s_]*KV(?![a-z0-9])/gi;
    const suffixMatches = [...model.matchAll(suffix)];
    const suffixPositions = new Set(suffixMatches.map((match) => match.index + match[0].toUpperCase().lastIndexOf('KV')));
    const prefixMatches = [...model.matchAll(prefix)].filter((match) => !suffixPositions.has(match.index));
    const ratings = new Set([...prefixMatches, ...suffixMatches].map((match) => Number(match[1])));
    const range = /(?:KV[\s_:=-]*\d+(?:\.\d+)?\s*(?:[-~/,–—]|\bto\b)\s*\d+(?:\.\d+)?\b|\d+(?:\.\d+)?\s*(?:[-~/,–—]|\bto\b)\s*\d+(?:\.\d+)?\s*KV)/i;
    if (ratings.size === 1 && !range.test(model)) {
      const rating = [...ratings][0];
      if (Number.isFinite(rating) && rating > 0) specs.motorKv = rating;
    }
  }
  if (kind === 'propeller') {
    const dimensions = model.match(/(\d+(?:[._]\d+)?)\s*[x×]\s*(\d+(?:[._]\d+)?)/i);
    if (dimensions) {
      specs.diameterIn = Number(dimensions[1].replace('_', '.'));
      specs.pitchIn = Number(dimensions[2].replace('_', '.'));
    }
  }
  if (kind === 'battery') {
    const capacity = model.match(/(\d+(?:\.\d+)?)\s*mAh/i);
    const cells = model.match(/(\d+)\s*S(?=\d|P|\b|[_-])/i);
    const discharge = model.match(/(\d+(?:\.\d+)?)\s*C(?=\d|\b|Square|[_-])/i);
    const voltage = model.match(/(\d+(?:[._]\d+)?)\s*V\b/i);
    if (capacity && Number(capacity[1]) > 0) specs.capacityMah = Number(capacity[1]);
    if (cells && Number(cells[1]) > 0) specs.cells = Number(cells[1]);
    if (discharge && Number(discharge[1]) > 0) specs.dischargeC = Number(discharge[1]);
    if (voltage && Number(voltage[1].replace('_', '.')) > 0) specs.voltage = Number(voltage[1].replace('_', '.'));
  }
  return specs;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry ?? null)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function stableHash(text: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    first = Math.imul(first ^ text.charCodeAt(index), 0x01000193);
    second = Math.imul(second ^ text.charCodeAt(index), 0x5bd1e995);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

/** Deterministic across object key order, including edits beyond the BOM. */
export function draftFingerprint(draft: DesignDraft): string {
  return stableHash(canonical(draft));
}

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function physicalRecords(components: PhysicalComponent[], overlays: Map<string, Set<string>>): InstanceRecord[] {
  const records = new Map<string, InstanceRecord>();
  const unlinked: InstanceRecord[] = [];
  for (const component of components) {
    const instance = normalize(component.instance);
    const edits = overlays.get(instance);
    const conflicting = Boolean(edits && edits.size > 1);
    const model = edits?.size === 1 ? [...edits][0] : normalize(component.choice);
    const record: InstanceRecord = {
      instance: instance || null,
      model,
      issues: conflicting ? ['동일 인스턴스에 서로 다른 모델 변경이 연결되어 있습니다.'] : [],
      uncertain: !instance || conflicting,
    };
    if (!instance) {
      record.issues.push(missingInstance);
      unlinked.push(record);
      continue;
    }
    const previous = records.get(instance);
    if (!previous) records.set(instance, record);
    else if (previous.model !== model) {
      previous.uncertain = true;
      previous.issues.push('중복 인스턴스의 원본 모델 정보가 서로 다릅니다.');
    }
  }
  return [...records.values(), ...unlinked];
}

function addOverlay(overlays: Map<string, Set<string>>, instance: string, model: string) {
  const models = overlays.get(instance) ?? new Set<string>();
  models.add(normalize(model));
  overlays.set(instance, models);
}

export function createBomSnapshot(draft: DesignDraft): BomSnapshot {
  const items: BomItem[] = [];
  const exclusions = ['기체 제작물과 설계에 기록되지 않은 부품은 견적에 포함되지 않습니다.'];
  for (const kind of kinds) {
    const sourceKeys = { motor: 'motors', propeller: 'propellers', battery: 'batteries', servo: 'servos' } as const;
    const physical = draft.physicalComponents?.[sourceKeys[kind]] ?? [];
    const overlays = new Map<string, Set<string>>();
    const unlinked: InstanceRecord[] = [];
    if (kind === 'motor' || kind === 'propeller') {
      for (const group of draft.propulsionGroups ?? []) {
        const instance = normalize(kind === 'motor' ? group.motorInstance : group.propellerInstance);
        const model = normalize(kind === 'motor' ? group.motorType : group.propellerType);
        if (instance && physical.some((component) => component.instance === instance)) addOverlay(overlays, instance, model);
        else if (model) unlinked.push({ instance: null, model, uncertain: true, issues: [missingInstance] });
      }
    }
    if (kind === 'battery') {
      (draft.energy?.batteryTypes ?? []).forEach((model, index) => {
        const instance = normalize(physical[index]?.instance);
        if (instance) addOverlay(overlays, instance, model);
        else if (normalize(model)) unlinked.push({ instance: null, model: normalize(model), uncertain: true, issues: [missingInstance] });
      });
    }
    if (kind === 'servo') {
      for (const wing of draft.wings ?? []) {
        if (wing.servoType === undefined) continue;
        // The preprocessor explicitly joins expanded physical wings to servos
        // by their physical-array index. Template wing order has no such join.
        const wingIndex = (draft.physicalComponents?.wings ?? []).findIndex((component) => wing.path === `physical.${component.instance}`);
        const instance = wingIndex >= 0 ? normalize(physical[wingIndex]?.instance) : '';
        if (instance) addOverlay(overlays, instance, wing.servoType);
        else if (!physical.some((component) => normalize(component.choice) === normalize(wing.servoType))) {
          unlinked.push({ instance: null, model: normalize(wing.servoType), uncertain: true, issues: ['날개와 실제 서보의 연결을 확인할 수 없습니다.'] });
        }
      }
    }
    const records = [...physicalRecords(physical, overlays), ...unlinked];
    if (kind === 'servo' && physical.length && unlinked.length) {
      records.forEach((record) => {
        record.uncertain = true;
        record.issues.push('연결되지 않은 서보 변경이 있어 기존 모델의 수량도 확인이 필요합니다.');
      });
    }
    const grouped = new Map<string, BomItem>();
    for (const record of records) {
      const item = grouped.get(record.model) ?? {
        id: `${kind}:${stableHash(record.model)}`,
        kind,
        model: record.model,
        quantity: 0,
        instances: [],
        specs: parsePartSpecs(kind, record.model),
        issues: [],
      };
      if (record.instance && !item.instances.includes(record.instance)) item.instances.push(record.instance);
      item.quantity = record.uncertain || item.quantity === null ? null : item.quantity + 1;
      item.issues.push(...record.issues);
      if (!record.model) item.issues.push('부품 모델명이 없어 검색할 수 없습니다.');
      if (!Object.keys(item.specs).length) item.issues.push('모델명에서 확인 가능한 규격이 없어 상품 규격을 별도로 확인해야 합니다.');
      item.issues = [...new Set(item.issues)];
      grouped.set(record.model, item);
    }
    items.push(...grouped.values());
  }
  if (!draft.physicalComponents?.motors?.length || !draft.physicalComponents?.propellers?.length) {
    exclusions.push('추진계 실제 부품 목록이 부족합니다. 대칭 개수나 도면 템플릿으로 수량을 추정하지 않았습니다.');
  }
  return {
    fingerprint: draftFingerprint(draft),
    designId: draft.baselineId,
    createdAt: new Date().toISOString(),
    items,
    exclusions,
  };
}
