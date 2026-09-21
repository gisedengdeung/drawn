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
  liftAt20: number;
  thrustAt20: number;
  pitchAt20: number;
  powerAt20: number;
  currentAt20: number;
  powerAt0: number;
  thrustAt0: number;
  currentAt0: number;
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

/**
 * 원본 Geom.stp에서 추출한 부품 배치. 이름(`MOTOR_3`, `ARM_55703_1` 등)과
 * 허브 원점 기준 좌표를 담으므로 topology 문자열로 배치를 추측할 필요가 없다.
 * 좌표는 STEP 축(Z가 높이, 단위 mm)이며 뷰어에서 Three.js 축으로 변환한다.
 */
export type PartPlacement = {
  /** 부품 이름 */
  n: string;
  /** 위치 [x, y, z] */
  p: [number, number, number];
  /** 부품 로컬 X축 방향 */
  x: [number, number, number];
  /** 부품 로컬 Z축 방향 */
  z: [number, number, number];
  /** 부품 로컬 좌표계 기준 실측 치수 [가로, 세로, 높이] (mm) */
  s?: [number, number, number];
};

export type PartPlacementGroup = Record<string, PartPlacement[]>;

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
  | 'home'
  | 'explore'
  | 'simulator'
  | 'lab'
  | 'gallery'
  | 'guide'
  | 'parts';

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

/**
 * "TurnigyGraphene1200mAh6S75C" 같은 RC 배터리 표기를 풀어서 보여줍니다.
 * S = 직렬로 연결된 셀 수(전압을 결정), P = 병렬 묶음 수(용량을 늘림),
 * C = 방전율(순간적으로 얼마나 센 전류를 낼 수 있는지). 셀 1개는 약 3.7V입니다.
 * 알려진 표기가 아니면 원래 이름을 그대로 돌려줍니다.
 */
export function formatBatteryLabel(name: string | null | undefined) {
  if (!name) return '—';
  const brandMatch = name.match(/^[A-Za-z]+/);
  const capacityMatch = name.match(/(\d+)mAh/i);
  if (!brandMatch || !capacityMatch) return name;

  const spMatch = name.match(/(\d+)S(\d+)P/);
  const sOnlyMatch = !spMatch ? name.match(/(\d+)S(?=\d*C|$)/) : null;
  const series = spMatch ? Number(spMatch[1]) : sOnlyMatch ? Number(sOnlyMatch[1]) : null;
  if (series == null) return name;
  const parallel = spMatch ? Number(spMatch[2]) : 1;
  const cRatingMatch = name.match(/(\d+)C(?=[A-Z0-9]|$)/);
  const suffixMatch = name.match(/(?:\d+S\d+P|\d+S\d+C)([A-Za-z]+)$/);

  const brand = brandMatch[0].replace(/([a-z])([A-Z])/g, '$1 $2');
  const voltage = (series * 3.7).toFixed(1);
  const parts = [
    brand,
    `${Number(capacityMatch[1]).toLocaleString()}mAh`,
    `${series}S${parallel > 1 ? `${parallel}P` : ''} ${voltage}V`,
  ];
  if (cRatingMatch) parts.push(`${cRatingMatch[1]}C`);
  if (suffixMatch) parts.push(suffixMatch[1]);
  return parts.join(' · ');
}

/** AircraftVerse 원본 트리의 fuselageWithComponents 노드 타입을 풀어서 보여줍니다. */
export function formatEnergyConfiguration(value: string | null | undefined) {
  if (value === 'DualBatteryFuselageWithComponents') return '이중 배터리 동체 구성';
  if (value === 'SingleBatteryFuselageWithComponents') return '단일 배터리 동체 구성';
  return formatComponent(value);
}

/**
 * T-motor("t_motor_...KV\d+")·KDE Direct("kde_direct_KDE...\_\d+(_G\d+)?") 표기를
 * 브랜드·모델·KV(전압당 회전수, 낮으면 힘·높으면 속도 위주)로 풀어줍니다.
 * 알려진 표기가 아니면 원래 이름을 그대로 돌려줍니다.
 */
export function formatMotorLabel(name: string | null | undefined) {
  if (!name) return '—';
  if (name.startsWith('t_motor_')) {
    const rest = name.slice('t_motor_'.length);
    const match = rest.match(/^(.+?)KV(\d+)$/);
    if (!match) return name;
    const model = match[1].replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
    return `T-motor ${model} · KV${match[2]}`;
  }
  if (name.startsWith('kde_direct_')) {
    const rest = name.slice('kde_direct_'.length);
    const parts = rest.split('_');
    const model = parts[0];
    const kv = parts.slice(1).find((part) => /^\d+$/.test(part));
    const generation = parts.slice(1).find((part) => /^G\d+$/i.test(part));
    if (!model || !kv) return name;
    return `KDE Direct ${model} · KV${kv}${generation ? ` · ${generation}세대` : ''}`;
  }
  return name;
}

/**
 * APC 프로펠러 표기("apc_propellers_{지름}x{피치}{코드}", 단위 inch, 언더스코어는 소수점)를
 * 지름×피치(인치)로 풀어줍니다. 끝에 붙는 영문 코드(E/W/N/SF/MR 등)는 제조사가 정한
 * 세부 시리즈 구분이라 정확한 차이까지는 단정하지 않고 코드 그대로 덧붙입니다.
 */
export function formatPropellerLabel(name: string | null | undefined) {
  if (!name) return '—';
  if (!name.startsWith('apc_propellers_')) return name;
  const rest = name.slice('apc_propellers_'.length);
  const match = rest.match(/^(\d+)(?:_(\d+))?x(\d+)(?:_(\d+))?([A-Za-z]*)$/);
  if (!match) return name;
  const [, diameterInt, diameterFrac, pitchInt, pitchFrac, suffix] = match;
  const diameter = diameterFrac ? `${diameterInt}.${diameterFrac}` : diameterInt;
  const pitch = pitchFrac ? `${pitchInt}.${pitchFrac}` : pitchInt;
  return `APC ${diameter}×${pitch}인치${suffix ? ` · ${suffix}형` : ''}`;
}

export type AirframeKind = 'quad' | 'hexa' | 'octo' | 'multi' | 'wing';

export function classifyAirframe(
  design: Pick<DesignSummary, 'numPropellers' | 'numWings'>,
): { kind: AirframeKind; label: string } {
  if (design.numWings > 0) return { kind: 'wing', label: '고정익·복합익' };
  if (design.numPropellers === 4) return { kind: 'quad', label: '쿼드콥터' };
  if (design.numPropellers === 6) return { kind: 'hexa', label: '헥사콥터' };
  if (design.numPropellers === 8) return { kind: 'octo', label: '옥토콥터' };
  return { kind: 'multi', label: '멀티콥터' };
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
