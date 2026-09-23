import type { DesignDraft } from '@/lib/drawn-types';

export const galleryPurposes = ['취미·입문', '촬영·관측', '장거리 비행', '레이싱', '운송·탑재', '연구·실험'] as const;
export type GalleryPost = {
  id: string;
  title: string;
  author: string;
  purpose: string;
  description: string;
  createdAt: string;
  parentId: string | null;
  baselineId: number;
  numPropellers: number;
  numWings: number;
  reuses: number;
};
export type GalleryDetail = GalleryPost & { draft: DesignDraft };
export type WorkspaceSnapshot = { draft: DesignDraft; sourceId: string | null };
export const workspaceStorageKey = 'drawn-workspace-v1';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 2000;
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e9;
const scalar = (value: unknown) => value === null || text(value) || number(value) || typeof value === 'boolean';
const list = (value: unknown, check: (item: unknown) => boolean): boolean => Array.isArray(value) && value.length <= 5000 && value.every(check);
const fields = (value: unknown, strings: string[], numbers: string[] = []): value is Record<string, unknown> => record(value) && strings.every((key) => text(value[key])) && numbers.every((key) => number(value[key]));
const params = (value: unknown) => record(value) && Object.values(value).every(scalar);
const wing = (value: unknown) => fields(value, ['id', 'path', 'type', 'nacaProfile'], ['span', 'chordInner', 'chordOuter', 'rotation', 'aileronBias', 'flapBias', 'load', 'tubeOffset']) && typeof value.taperOffset === 'boolean';

// Shared by the API and workspace restore: reject malformed snapshots before a 3D viewer uses them.
export function isDesignDraft(value: unknown): value is DesignDraft {
  if (!fields(value, ['name', 'topology'], ['baselineId', 'numPropellers', 'numWings'])) return false;
  if (!Number.isInteger(value.baselineId) || Number(value.baselineId) < 1 || Number(value.baselineId) > 28080) return false;
  if (Number(value.numPropellers) < 0 || Number(value.numPropellers) > 100 || Number(value.numWings) < 0 || Number(value.numWings) > 100) return false;
  return list(value.nodes, (item) => fields(item, ['id', 'path', 'nodeType', 'slot']) && params(item.parameters)) &&
    list(value.segments, (item) => fields(item, ['id', 'path', 'nodeType', 'slot'], ['depth', 'multiplicity', 'length', 'angle', 'offset']) && (item.parentPath === null || text(item.parentPath)) && params(item.parameters) && (!item.wing || wing(item.wing))) &&
    list(value.propulsionGroups, (item) => fields(item, ['id', 'path', 'segmentId', 'motorType', 'propellerType'])) &&
    list(value.parameterDefinitions, (item) => fields(item, ['id', 'path', 'label', 'group']) && scalar(item.value) && scalar(item.baseline) && (item.range === null || fields(item.range, [], ['min', 'max']))) &&
    list(value.sourceParameters, (item) => Array.isArray(item) && item.length === 4 && text(item[0]) && scalar(item[1]) && (item[2] === null || text(item[2])) && number(item[3])) &&
    record(value.physicalComponents) && ['motors', 'propellers', 'batteries', 'wings', 'servos'].every((key) => list((value.physicalComponents as Record<string, unknown>)[key], (item) => fields(item, ['instance', 'type', 'choice']))) &&
    fields(value.energy, ['configuration']) && list(value.energy.batteryTypes, text) &&
    fields(value.fuselage, [], ['length', 'horizontalDiameter', 'verticalDiameter', 'floorHeight']) &&
    list(value.wings, wing) && fields(value.payload, [], ['mass']) &&
    record(value.layout) && Object.values(value.layout).every((item) => fields(item, [], ['x', 'y']));
}

export async function loadDesignDraft(id: number): Promise<DesignDraft> {
  const shard = String(Math.floor(id / 1000)).padStart(3, '0');
  const response = await fetch(`/data/design-trees/shard-${shard}.json`);
  if (!response.ok) throw new Error('설계 데이터를 불러오지 못했습니다. 다시 시도해 주세요.');
  const data = await response.json() as Record<string, unknown>;
  const draft = data[String(id)];
  if (!isDesignDraft(draft)) throw new Error('공유할 수 있는 설계 데이터가 없습니다.');
  return structuredClone(draft);
}

export async function galleryRequest<T>(path = '', init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api/gallery${path}`, { ...init, headers });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? '갤러리 요청을 처리하지 못했습니다.');
  return data;
}
