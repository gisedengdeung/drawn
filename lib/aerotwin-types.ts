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
  meanArmLength: number;
  maxArmLength: number;
  fuselageLength: number;
  fuselageHorizontalDiameter: number;
  fuselageVerticalDiameter: number;
  totalWingSpan: number;
  meanWingChord: number;
  primaryMotor: string | null;
  primaryPropeller: string | null;
  primaryBattery: string | null;
  dragAt20: number;
  powerAt20: number;
  feasible: boolean;
  viewerReady: boolean;
  paretoOptimal: boolean;
  parameterCount: number;
  shard: number;
};

export type DraftGeometryMode = 'exact-stl' | 'parametric-preview';

export type ParameterGroup =
  | 'structure'
  | 'fuselage'
  | 'propulsion'
  | 'energy'
  | 'payload'
  | 'wing'
  | 'layout';

export type ParameterDefinition = {
  id: string;
  path: string;
  label: string;
  group: ParameterGroup;
  unit: string | null;
  range: { min: number; max: number } | null;
  min?: number | null;
  max?: number | null;
  step: number | null;
  baseline: number | string | boolean | null;
  value: number | string | boolean | null;
  optimization?: string | null;
  editable: boolean;
  advanced: boolean;
  affectsGeometry: boolean;
  affectsPerformance: boolean;
  compatibility?: string | null;
};

export type ParametricNode = {
  id: string;
  path: string;
  nodeType: string;
  slot: string;
  parameters: Record<string, number | string | boolean | null>;
};

export type WingParameters = {
  id: string;
  path: string;
  type: string;
  nacaProfile: string;
  span: number;
  chordInner: number;
  chordOuter: number;
  taperOffset: boolean;
  rotation: number;
  aileronBias: number;
  flapBias: number;
  load: number;
  tubeOffset: number;
  servoType?: string;
};

export type DesignSegment = {
  id: string;
  path: string;
  nodeType: string;
  slot: string;
  parentPath: string | null;
  depth: number;
  multiplicity: number;
  length: number;
  angle: number;
  offset: number;
  parameters: Record<string, number | string | boolean | null>;
  motorType?: string;
  propellerType?: string;
  wing?: WingParameters;
};

export type PropulsionGroup = {
  id: string;
  path: string;
  segmentId: string;
  motorType: string;
  propellerType: string;
  motorInstance?: string;
  propellerInstance?: string;
};

export type PhysicalComponent = {
  instance: string;
  type: string;
  choice: string;
};

export type SourceParameterTuple = [
  name: string,
  value: number | string | boolean | null,
  optimization: string | null,
  targetCount: number,
];

export type DesignDraft = {
  baselineId: number;
  name: string;
  topology: string;
  numPropellers: number;
  numWings: number;
  nodes: ParametricNode[];
  segments: DesignSegment[];
  propulsionGroups: PropulsionGroup[];
  parameterDefinitions: ParameterDefinition[];
  sourceParameters: SourceParameterTuple[];
  physicalComponents: {
    motors: PhysicalComponent[];
    propellers: PhysicalComponent[];
    batteries: PhysicalComponent[];
    wings: PhysicalComponent[];
    servos: PhysicalComponent[];
  };
  energy: {
    batteryTypes: string[];
    configuration: string;
  };
  fuselage: {
    length: number;
    horizontalDiameter: number;
    verticalDiameter: number;
    floorHeight: number;
  };
  wings: WingParameters[];
  payload: {
    mass: number;
  };
  layout: Record<string, { x: number; y: number }>;
};

export type CompareTarget =
  | { kind: 'dataset'; designId: number }
  | { kind: 'draft'; draft: DesignDraft };

export type ComponentCatalogs = {
  motors: string[];
  propellers: string[];
  batteries: string[];
  servos: string[];
  nacaProfiles: string[];
  nodeTypes: string[];
};

export type DesignShard = Record<string, DesignDraft>;

export type ParetoFrontData = {
  objectives: {
    maximize: ['maxDistance'];
    minimize: ['power', 'mass'];
  };
  kneeMethod: string;
  kneeId: number;
  designIds: number[];
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
  fieldValidity: Record<TrimField, boolean>;
};

export type TrimField =
  | 'distance'
  | 'flightTime'
  | 'pitch'
  | 'maxUc'
  | 'thrust'
  | 'lift'
  | 'drag'
  | 'current'
  | 'power'
  | 'motorCurrentRatio'
  | 'motorPowerRatio'
  | 'batteryCurrentRatio';

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
  shardSize: number;
  shardCount: number;
  catalogCounts: Record<keyof ComponentCatalogs, number>;
  nodeTypeCount: number;
  paretoFrontSize: number;
  paretoKneeId: number;
  parameterCount: {
    average: number;
    maximum: number;
  };
};

export type DatasetIndex = {
  summary: DatasetSummary;
  designs: DesignSummary[];
};

export type ShowcaseMap = Record<string, ShowcaseDesign>;

export type WorkspaceView =
  | 'explore'
  | 'simulator'
  | 'lab'
  | 'gallery';

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
  const symmetry = value.includes('Sym')
    ? 'Symmetric'
    : value.includes('_')
      ? 'Branched'
      : 'Hub';
  return `${match[1]}-way ${symmetry}`;
}

export function percentChange(before: number, after: number) {
  if (!isAvailableMetric(before) || !isAvailableMetric(after)) return null;
  return ((after - before) / before) * 100;
}

export function isAvailableMetric(
  value: number | null | undefined,
): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
