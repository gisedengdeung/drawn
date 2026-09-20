import type { ComponentCatalogs, DesignDraft, DesignSegment, DesignSummary, ParameterGroup, ShowcaseDesign, WingParameters } from './drawn-types';

export function cloneDraft(value: DesignDraft) {
  return JSON.parse(JSON.stringify(value)) as DesignDraft;
}

export function hydrateDraft(value: DesignDraft) {
  const draft = cloneDraft(value);
  if (draft.parameterDefinitions?.length || !draft.sourceParameters?.length) return draft;
  draft.parameterDefinitions = draft.sourceParameters.map(([name, parameterValue, optimization, targetCount], index) => {
    const group = classifyParameterGroup(name, optimization);
    const affectsGeometry = ['structure', 'fuselage', 'propulsion', 'energy', 'wing', 'layout', 'payload'].includes(group);
    const fixedDerived = /CONTROLCHANNELAUTO|CONTROL_CHANNEL_AUTO|FIXEDROTATION/i.test(name);
    return {
      id: `parameter:${name.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}:${index}`,
      path: `lowLevel.parameters.${index}`,
      label: name,
      group,
      unit: sourceParameterUnit(name, optimization),
      range: sourceParameterRange(name, optimization, parameterValue),
      step: sourceParameterStep(name, parameterValue),
      baseline: parameterValue,
      value: parameterValue,
      optimization,
      editable: !fixedDerived && (typeof parameterValue === 'number' || typeof parameterValue === 'boolean' || /NACA|PROFILE/i.test(name)),
      advanced: !optimization,
      affectsGeometry,
      affectsPerformance: Boolean(optimization) && group !== 'layout',
      compatibility: targetCount ? `${targetCount} CAD component${targetCount === 1 ? '' : 's'} linked` : null,
    };
  });
  return draft;
}

function classifyParameterGroup(name: string, optimization: string | null): ParameterGroup {
  const token = `${name} ${optimization ?? ''}`.toLowerCase();
  if (/cargo|payload|mass/.test(token)) return 'payload';
  if (/wing|naca|aileron|flap|servo/.test(token)) return 'wing';
  if (/battery.*(?:x|y)|sensor|autopilot|current.*(?:x|y)|voltage.*(?:x|y)|gps|vario|rpm.*(?:x|y)/.test(token)) return 'layout';
  if (/fuselage|diameter|floor|body_(?!rot)/.test(token)) return 'fuselage';
  if (/motor|propeller|prop_|rpm/.test(token)) return 'propulsion';
  if (/battery|capacity|voltage|current/.test(token)) return 'energy';
  return 'structure';
}

function sourceParameterUnit(name: string, optimization: string | null) {
  const token = `${name} ${optimization ?? ''}`.toLowerCase();
  if (/angle|rotation|_rot|clock/.test(token)) return '°';
  if (/mass|cargo|payload|load/.test(token)) return /wing.*load/.test(token) ? 'g' : 'kg';
  if (/length|span|chord|offset|diameter|height|(?:^|_)[xy](?:_|$)/.test(token)) return 'mm';
  return null;
}

function sourceParameterRange(name: string, optimization: string | null, value: number | string | boolean | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const token = `${name} ${optimization ?? ''}`.toLowerCase();
  if (/bias|ratio|taper.*offset/.test(token)) return { min: 0, max: 1 };
  if (/angle|rotation|_rot|clock/.test(token)) return { min: Math.min(-180, Math.floor(value)), max: Math.max(360, Math.ceil(value)) };
  if (/length|span|chord|diameter|height/.test(token)) return { min: 0, max: Math.max(Math.ceil(value * 2), Math.ceil(value), 10) };
  if (/offset|(?:^|_)[xy](?:_|$)/.test(token)) {
    const extent = Math.max(Math.ceil(Math.abs(value) * 2), 300);
    return { min: -extent, max: extent };
  }
  if (/mass|cargo|payload|load/.test(token)) return { min: 0, max: Math.max(Math.ceil(value * 2), 20) };
  const extent = Math.max(Math.abs(value), 1);
  return { min: Math.floor(value - extent), max: Math.ceil(value + extent) };
}

function sourceParameterStep(name: string, value: number | string | boolean | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (/bias|ratio/i.test(name)) return 0.01;
  if (/mass/i.test(name)) return 0.1;
  return Math.abs(value) < 10 && !Number.isInteger(value) ? 0.1 : 1;
}

export function draftFromDesign(design: DesignSummary, reference?: ShowcaseDesign | null): DesignDraft {
  const segment: DesignSegment = {
    id: 'segment-0', path: 'hub.mainSegment', nodeType: 'PropArm', slot: 'mainSegment', length: design.armLength || 300,
    parentPath: null, depth: 1, multiplicity: Math.max(design.numPropellers, 1),
    angle: 0, offset: 0, parameters: {}, motorType: reference?.motor ?? '', propellerType: reference?.propeller ?? '',
  };
  const wings: WingParameters[] = design.numWings ? [{
    id: 'wing-0', path: 'hub.wing', type: reference?.wingType ?? 'Wing', nacaProfile: reference?.nacaProfile ?? '0012', span: reference?.wingSpan || 800,
    chordInner: reference?.wingChord || 220, chordOuter: (reference?.wingChord || 220) * 0.62, taperOffset: true, rotation: 0, aileronBias: 0.5, flapBias: 0.5, load: 400, tubeOffset: 0,
  }] : [];
  return {
    baselineId: design.id, name: reference?.sourceName ?? `design-${design.id}`, topology: design.hub,
    numPropellers: design.numPropellers, numWings: design.numWings, nodes: [], segments: [segment],
    propulsionGroups: [{ id: 'propulsion-0', path: segment.path, segmentId: segment.id, motorType: reference?.motor ?? '', propellerType: reference?.propeller ?? '' }],
    parameterDefinitions: [],
    sourceParameters: [],
    physicalComponents: { motors: [], propellers: [], batteries: [], wings: [], servos: [] },
    energy: { batteryTypes: [reference?.battery ?? ''], configuration: 'SingleBattery' },
    fuselage: { length: 220, horizontalDiameter: 360, verticalDiameter: 135, floorHeight: 24 },
    wings, payload: { mass: 0.5 }, layout: {},
  };
}

export function catalogsFromShowcases(designs: ShowcaseDesign[]): ComponentCatalogs {
  const unique = (values: Array<string | null>) => [...new Set(values.filter(Boolean) as string[])].sort();
  return {
    motors: unique(designs.map((item) => item.motor)), propellers: unique(designs.map((item) => item.propeller)), batteries: unique(designs.map((item) => item.battery)),
    servos: [], nacaProfiles: unique(designs.map((item) => item.nacaProfile)), nodeTypes: unique(designs.map((item) => item.hub)),
  };
}
