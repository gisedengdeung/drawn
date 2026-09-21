import type {
  ComponentCatalogs,
  DesignDraft,
  ParameterDefinition,
  WingParameters,
} from '../drawn-types';
import { hydrateDraft } from '../design-draft';
import { isDesignDraft } from '../design-gallery';

export class DraftValidationError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Range = readonly [number, number];
export const DRAFT_UI_RANGES = {
  segmentLength: [50, 520],
  segmentAngle: [-135, 360],
  segmentOffset: [-50, 50],
  fuselageLength: [84, 559],
  fuselageHorizontal: [120, 805],
  fuselageVertical: [51, 354],
  floorHeight: [8, 60],
  payload: [0, 20],
  layout: [-280, 280],
  wingSpan: [200, 2000],
  wingInnerChord: [100, 500],
  wingRotation: [0, 360],
  wingTubeOffset: [-100, 160],
  wingBias: [0.1, 1],
} as const;

function invalid(code: string, message: string): never {
  throw new DraftValidationError(code, message);
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  return value;
}
function unchanged(actual: unknown, expected: unknown) {
  if (JSON.stringify(stable(actual)) !== JSON.stringify(stable(expected)))
    invalid(
      'invalid_structure',
      '원본 구성과 부품 연결 식별자는 변경할 수 없습니다.',
    );
}
function fields<T>(actual: T, expected: T, keys: Array<keyof T>) {
  for (const key of keys) unchanged(actual[key], expected[key]);
}
function numbers(
  value: number,
  baseline: number,
  range: Range,
  extra: Range[] = [],
): number {
  // NumberSlider includes the server baseline in its envelope, never an arbitrary submitted value.
  const min = Math.min(
    range[0],
    Math.floor(baseline),
    ...extra.map((item) => item[0]),
  );
  const max = Math.max(
    range[1],
    Math.ceil(baseline),
    ...extra.map((item) => item[1]),
  );
  if (!Number.isFinite(value) || value < min || value > max)
    invalid(
      'out_of_range',
      '편집 값이 원본 기준 허용 범위를 벗어났습니다. 연결이 불명확한 원본 변수는 기본 편집 범위 안에서 수정해 주세요.',
    );
  return value;
}
function choice(
  value: string | undefined,
  baseline: string | undefined,
  catalog: string[],
): string | undefined {
  if (value === baseline) return baseline;
  if (typeof value !== 'string' || !catalog.includes(value))
    invalid(
      'unknown_component',
      '서버 부품 카탈로그에 없는 모델 또는 프로파일입니다.',
    );
  return value;
}
function ranges(
  definitions: ParameterDefinition[],
  pattern: RegExp,
  baseline?: number,
): Range[] {
  return definitions
    .filter(
      (def) =>
        def.editable &&
        def.range &&
        typeof def.value === 'number' &&
        pattern.test(`${def.label} ${def.optimization ?? ''}`.toUpperCase()) &&
        (baseline === undefined ||
          (typeof def.baseline === 'number' &&
            Math.abs(def.baseline - baseline) <=
              Math.max(0.02, Math.abs(def.baseline) * 0.0001))),
    )
    .map((def) => [def.range!.min, def.range!.max] as const);
}

function parameterValues(
  input: DesignDraft,
  baseline: DesignDraft,
  catalogs: ComponentCatalogs,
) {
  const supplied = new Map<string, ParameterDefinition>();
  const known = new Set(baseline.parameterDefinitions.map((def) => def.id));
  for (const def of input.parameterDefinitions) {
    if (!known.has(def.id) || supplied.has(def.id))
      invalid('invalid_parameter', '중복되거나 원본에 없는 변수 식별자입니다.');
    supplied.set(def.id, def);
  }
  // Raw dataset/gallery drafts have no expanded definitions. A partially stripped edit is not a raw draft.
  if (supplied.size && supplied.size !== known.size)
    invalid(
      'invalid_parameter',
      '원본 변수 목록이 누락되었습니다. 설계를 다시 불러와 주세요.',
    );
  return baseline.parameterDefinitions.map((def) => {
    const value = supplied.get(def.id)?.value ?? def.value;
    const explicitlyNull =
      supplied.has(def.id) && supplied.get(def.id)!.value === null;
    const next = explicitlyNull ? null : value;
    if (next === def.value) return structuredClone(def);
    if (!def.editable)
      invalid(
        'readonly_parameter',
        '읽기 전용 원본 변수는 변경할 수 없습니다.',
      );
    if (typeof next !== typeof def.value || next === null || def.value === null)
      invalid(
        'invalid_parameter_type',
        '원본 변수의 값 형식은 변경할 수 없습니다.',
      );
    if (
      typeof next === 'number' &&
      (!Number.isFinite(next) ||
        !def.range ||
        next < def.range.min ||
        next > def.range.max)
    )
      invalid('out_of_range', '원본 변수의 허용 범위를 벗어났습니다.');
    if (
      typeof next === 'string' &&
      (!/NACA|PROFILE/i.test(def.label) ||
        !catalogs.nacaProfiles.includes(next))
    )
      invalid(
        'unknown_component',
        '원본 프로파일은 서버 카탈로그에서 선택해 주세요.',
      );
    return { ...structuredClone(def), value: next };
  });
}

function wingValue(
  input: WingParameters,
  baseline: WingParameters,
  defs: ParameterDefinition[],
  catalogs: ComponentCatalogs,
): WingParameters {
  fields(input, baseline, ['id', 'path', 'type', 'taperOffset', 'load']);
  const wing = structuredClone(baseline);
  wing.nacaProfile = choice(
    input.nacaProfile,
    baseline.nacaProfile,
    catalogs.nacaProfiles,
  )!;
  wing.servoType = choice(input.servoType, baseline.servoType, catalogs.servos);
  wing.span = numbers(
    input.span,
    baseline.span,
    DRAFT_UI_RANGES.wingSpan,
    ranges(defs, /WING_.*SPAN/, baseline.span),
  );
  wing.chordInner = numbers(
    input.chordInner,
    baseline.chordInner,
    DRAFT_UI_RANGES.wingInnerChord,
    ranges(defs, /WING_.*CHORD.*(?:1|INNER)/, baseline.chordInner),
  );
  wing.chordOuter = numbers(
    input.chordOuter,
    baseline.chordOuter,
    [50, Math.max(50, wing.chordInner)],
    ranges(defs, /WING_.*CHORD.*(?:2|OUTER)/, baseline.chordOuter),
  );
  wing.rotation = numbers(
    input.rotation,
    baseline.rotation,
    DRAFT_UI_RANGES.wingRotation,
    ranges(defs, /WING_.*(?:TUBE_)?ROT/, baseline.rotation),
  );
  wing.tubeOffset = numbers(
    input.tubeOffset,
    baseline.tubeOffset,
    DRAFT_UI_RANGES.wingTubeOffset,
    ranges(defs, /WING_.*TUBE_OFFSET/, baseline.tubeOffset),
  );
  wing.aileronBias = numbers(
    input.aileronBias,
    baseline.aileronBias,
    DRAFT_UI_RANGES.wingBias,
    ranges(defs, /WING_.*AILERON/, baseline.aileronBias),
  );
  wing.flapBias = numbers(
    input.flapBias,
    baseline.flapBias,
    DRAFT_UI_RANGES.wingBias,
    ranges(defs, /WING_.*FLAP/, baseline.flapBias),
  );
  return wing;
}

/** Rebuild a persisted draft from trusted structure and a small, validated set of editable values. */
export function validateDraftAgainstBaseline(
  input: unknown,
  rawBaseline: DesignDraft,
  catalogs: ComponentCatalogs,
): DesignDraft {
  if (!isDesignDraft(input))
    invalid('invalid_draft', '설계 데이터 형식을 확인해 주세요.');
  const baseline = hydrateDraft(rawBaseline);
  fields(input, baseline, [
    'baselineId',
    'topology',
    'numPropellers',
    'numWings',
  ]);
  unchanged(input.physicalComponents, baseline.physicalComponents);
  unchanged(input.nodes, baseline.nodes);
  unchanged(input.sourceParameters, baseline.sourceParameters);
  unchanged(input.energy.configuration, baseline.energy.configuration);
  unchanged(input.segments.length, baseline.segments.length);
  unchanged(input.propulsionGroups.length, baseline.propulsionGroups.length);
  unchanged(input.wings.length, baseline.wings.length);
  unchanged(
    input.energy.batteryTypes.length,
    baseline.energy.batteryTypes.length,
  );
  unchanged(
    Object.keys(input.layout).sort(),
    Object.keys(baseline.layout).sort(),
  );

  const result = structuredClone(baseline);
  result.name = input.name;
  result.parameterDefinitions = parameterValues(input, baseline, catalogs);
  // Only server metadata grants geometric range extensions; client range/readonly flags are discarded.
  const defs = baseline.parameterDefinitions;
  result.segments = input.segments.map((segment, index) => {
    const source = baseline.segments[index];
    fields(segment, source, [
      'id',
      'path',
      'nodeType',
      'slot',
      'parentPath',
      'depth',
      'multiplicity',
      'parameters',
      'wing',
    ]);
    return {
      ...structuredClone(source),
      length: numbers(
        segment.length,
        source.length,
        DRAFT_UI_RANGES.segmentLength,
        ranges(
          defs,
          /ARM_.*LENGTH|ROTATEDARM_.*LENGTH|ARM_LENGTH/,
          source.length,
        ),
      ),
      angle: numbers(
        segment.angle,
        source.angle,
        DRAFT_UI_RANGES.segmentAngle,
        ranges(
          defs,
          /CLOCK_ANGLE|ANGHORZCONN|ROT2|BODY_ROT_ANGLE/,
          source.angle,
        ),
      ),
      offset: numbers(
        segment.offset,
        source.offset,
        DRAFT_UI_RANGES.segmentOffset,
      ),
      motorType: choice(segment.motorType, source.motorType, catalogs.motors),
      propellerType: choice(
        segment.propellerType,
        source.propellerType,
        catalogs.propellers,
      ),
    };
  });
  result.propulsionGroups = input.propulsionGroups.map((group, index) => {
    const source = baseline.propulsionGroups[index];
    fields(group, source, [
      'id',
      'path',
      'segmentId',
      'motorInstance',
      'propellerInstance',
    ]);
    return {
      ...structuredClone(source),
      motorType: choice(group.motorType, source.motorType, catalogs.motors)!,
      propellerType: choice(
        group.propellerType,
        source.propellerType,
        catalogs.propellers,
      )!,
    };
  });
  result.energy.batteryTypes = input.energy.batteryTypes.map((model, index) =>
    choice(model, baseline.energy.batteryTypes[index], catalogs.batteries)!,
  );
  result.fuselage = {
    length: numbers(
      input.fuselage.length,
      baseline.fuselage.length,
      DRAFT_UI_RANGES.fuselageLength,
      ranges(defs, /^FUSELAGE_LENGTH(?:\s|$)/),
    ),
    horizontalDiameter: numbers(
      input.fuselage.horizontalDiameter,
      baseline.fuselage.horizontalDiameter,
      DRAFT_UI_RANGES.fuselageHorizontal,
      ranges(defs, /^FUSELAGE_(?:HORZ|HORIZONTAL)_DIAMETER(?:\s|$)/),
    ),
    verticalDiameter: numbers(
      input.fuselage.verticalDiameter,
      baseline.fuselage.verticalDiameter,
      DRAFT_UI_RANGES.fuselageVertical,
      ranges(defs, /^FUSELAGE_(?:VERT|VERTICAL)_DIAMETER(?:\s|$)/),
    ),
    floorHeight: numbers(
      input.fuselage.floorHeight,
      baseline.fuselage.floorHeight,
      DRAFT_UI_RANGES.floorHeight,
      ranges(defs, /^FUSELAGE_FLOOR_HEIGHT(?:\s|$)/),
    ),
  };
  result.payload.mass = numbers(
    input.payload.mass,
    baseline.payload.mass,
    DRAFT_UI_RANGES.payload,
    ranges(defs, /^(?:CARGOMASS|CARGO_MASS)(?:\s|$)/),
  );
  result.wings = input.wings.map((wing, index) =>
    wingValue(wing, baseline.wings[index], defs, catalogs),
  );
  for (const key of Object.keys(baseline.layout))
    result.layout[key] = {
      x: numbers(
        input.layout[key].x,
        baseline.layout[key].x,
        DRAFT_UI_RANGES.layout,
      ),
      y: numbers(
        input.layout[key].y,
        baseline.layout[key].y,
        DRAFT_UI_RANGES.layout,
      ),
    };
  return result;
}
