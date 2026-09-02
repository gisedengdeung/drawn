export type DesignSummary = {
  id: number;
  mass: number;
  maxDistance: number;
  hoverTime: number;
  maxSpeed: number;
  power: number;
  speedMfd: number;
  interferences: number;
  numPropellers: number;
  numWings: number;
  hub: string;
  armLength: number;
  dragAt20: number;
  powerAt20: number;
  feasible: boolean;
  viewerReady: boolean;
};

export type TrimRow = {
  speed: number;
  distance: number | null;
  flightTime: number | null;
  pitch: number | null;
  maxUc: number | null;
  thrust: number | null;
  lift: number | null;
  drag: number | null;
  current: number | null;
  power: number | null;
  motorCurrentRatio: number | null;
  motorPowerRatio: number | null;
  batteryCurrentRatio: number | null;
  valid: boolean;
};

export type ShowcaseDesign = DesignSummary & {
  selectionReason: string;
  sourceName: string;
  generatorVersion: string;
  motor: string | null;
  propeller: string | null;
  battery: string | null;
  wingType: string | null;
  nacaProfile: string | null;
  wingSpan: number;
  wingChord: number;
  modelPath: string;
  trim: TrimRow[];
  output: Record<string, number>;
};

export type DatasetSummary = {
  aircraftVerseTotal: number;
  localDesigns: number;
  validRangeDesigns: number;
  validHoverDesigns: number;
  wingedDesigns: number;
  sourceParts: Array<{
    name: string;
    designCount: number;
    bytes: number;
  }>;
  sourceBytes: number;
  pointCloudShape: [number, number];
  showcaseIds: number[];
  defaultShowcaseId: number;
  source: string;
  trimSchema: string[];
};

export type DatasetIndex = {
  summary: DatasetSummary;
  designs: DesignSummary[];
};

export type ShowcaseMap = Record<string, ShowcaseDesign>;

export type WorkspaceView = 'explore' | 'simulator' | 'lab' | 'compare' | 'optimizer';

export function formatMetric(value: number, digits = 1) {
  return new Intl.NumberFormat('ko-KR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatDistance(value: number) {
  return value >= 1000
    ? `${formatMetric(value / 1000, 2)} km`
    : `${formatMetric(value, 0)} m`;
}

export function formatComponent(value: string | null | undefined) {
  if (!value) return '—';
  return value
    .replace(/^t_motor_/, '')
    .replace(/^apc_propellers_/, 'APC ')
    .replace(/_/g, ' ')
    .replace(/(\d)x(\d)/i, '$1×$2')
    .replace(/(\d)_(\d)/g, '$1.$2');
}

export function formatHub(value: string) {
  const match = value.match(/ConnectedHub(\d+)/);
  if (!match) return formatComponent(value);
  const symmetry = value.includes('Sym') ? 'Symmetric' : value.includes('_') ? 'Branched' : 'Hub';
  return `${match[1]}-way ${symmetry}`;
}

export function percentChange(before: number, after: number) {
  if (!isAvailableMetric(before) || !isAvailableMetric(after)) return null;
  return ((after - before) / before) * 100;
}

export function isAvailableMetric(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
