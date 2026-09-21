import type {
  DesignDraft,
  DesignSummary,
  ParameterGroup,
} from '../drawn-types';
import {
  buildCandidatePool,
  rankCandidates,
  type Objective,
} from '../candidate-search';
import { cloneDraft } from '../design-draft';
import { estimateDraft, type DraftEstimate } from '../design-performance';

export type OptimizationOptions = {
  objective: Objective;
  massLimit?: number;
  powerLimit?: number;
  topologyLocked?: boolean;
  lockedParameterIds?: string[];
};
export type EditableParameter = {
  id: string;
  path: string;
  label: string;
  unit: 'mm';
  group: ParameterGroup;
  value: number;
  min: number;
  max: number;
  step: number;
};
export type DraftChange = {
  id: string;
  label: string;
  before: number;
  after: number;
  unit: 'mm';
};
export type DraftProposal = {
  id: string;
  changes: DraftChange[];
  before: DraftEstimate;
  after: DraftEstimate;
  improvement: number;
  source: 'neighbor-estimate';
};
export type DraftOptimizationInput = OptimizationOptions & {
  selected: DesignSummary;
  baseline: DesignDraft;
  draft: DesignDraft;
  designs: DesignSummary[];
};
export type DraftOptimizationResult = {
  source: 'neighbor-estimate';
  baselineEstimate: DraftEstimate;
  currentEstimate: DraftEstimate;
  proposals: DraftProposal[];
  parameters: EditableParameter[];
  evaluatedCount: number;
  reason: string;
  assumptions: string[];
};

const OBJECTIVES: Objective[] = [
  'range',
  'hover',
  'power',
  'drag',
  'speed',
  'balanced',
];
export const MAX_DRAFT_EVALUATIONS = 64;
const finitePositive = (value: number) => Number.isFinite(value) && value > 0;

function limits(options: OptimizationOptions) {
  if (!OBJECTIVES.includes(options.objective))
    throw new Error('지원하지 않는 최적화 목표입니다.');
  const massLimit = options.massLimit ?? 100000;
  const powerLimit = options.powerLimit ?? 1000000;
  if (!finitePositive(massLimit) || !finitePositive(powerLimit))
    throw new Error('질량·전력 한도는 양수여야 합니다.');
  return { massLimit, powerLimit };
}

/** Reuses the Explorer ranking; a dataset candidate replaces the baseline, not individual fields. */
export function recommendDatasetCandidates(
  designs: DesignSummary[],
  selected: DesignSummary,
  options: OptimizationOptions,
) {
  const { massLimit, powerLimit } = limits(options);
  const topologyLocked = options.topologyLocked ?? true;
  const pool = buildCandidatePool(
    designs,
    selected.id,
    massLimit,
    powerLimit,
    options.objective,
  ).filter(
    (design) =>
      (!topologyLocked || design.hub === selected.hub) &&
      [design.mass, design.power].every(finitePositive) &&
      (options.objective === 'hover'
        ? finitePositive(design.hoverTime)
        : options.objective === 'drag'
          ? finitePositive(design.dragAt20)
          : options.objective === 'speed'
            ? finitePositive(design.maxSpeed)
            : finitePositive(design.maxDistance)),
  );
  return {
    source: 'dataset' as const,
    objective: options.objective,
    candidateCount: pool.length,
    candidates: rankCandidates(pool, options.objective, 3),
    constraints: {
      massLimit,
      powerLimit,
      topologyLocked,
      topology: topologyLocked ? selected.hub : null,
    },
    assumptions: [
      'AircraftVerse 시뮬레이션 KPI로 순위를 계산했습니다.',
      '후보 선택은 다른 기준 설계를 여는 동작입니다. 현재 설계의 일부 변경과 구분합니다.',
      'feasible은 원본 최대 비행거리가 양수라는 뜻이며 제작·비행 안전 판정이 아닙니다.',
    ],
  };
}

/** Explicit geometry controls already exposed by DesignLab. No source-name/value heuristics. */
export function listEditableParameters(
  draft: DesignDraft,
  baseline: DesignDraft = draft,
): EditableParameter[] {
  const parameters: EditableParameter[] = [];
  const add = (
    id: string,
    path: string,
    label: string,
    group: ParameterGroup,
    value: number,
    original: number,
    min: number,
    max: number,
  ) => {
    if (!finitePositive(value) || !finitePositive(original)) return;
    const definitions = draft.parameterDefinitions.filter(
      (definition) => definition.path === path || definition.id === id,
    );
    if (definitions.some((definition) => !definition.editable)) return;
    let lower = Math.max(
      0.001,
      Math.min(min, Math.floor(original), Math.floor(value)),
    );
    let upper = Math.max(max, Math.ceil(original), Math.ceil(value));
    for (const definition of definitions) {
      if (definition.range) {
        lower = Math.max(lower, definition.range.min);
        upper = Math.min(upper, definition.range.max);
      }
      if (definition.min != null) lower = Math.max(lower, definition.min);
      if (definition.max != null) upper = Math.min(upper, definition.max);
    }
    if (
      !Number.isFinite(lower) ||
      !Number.isFinite(upper) ||
      lower > upper ||
      value < lower ||
      value > upper
    )
      return;
    parameters.push({
      id,
      path,
      label,
      group,
      unit: 'mm',
      value,
      min: lower,
      max: upper,
      step: 1,
    });
  };
  for (const [key, label, min, max] of [
    ['length', '동체 길이', 84, 559],
    ['horizontalDiameter', '동체 수평 직경', 120, 805],
    ['verticalDiameter', '동체 수직 직경', 51, 354],
  ] as const)
    add(
      `fuselage:${key}`,
      `fuselage.${key}`,
      label,
      'fuselage',
      draft.fuselage[key],
      baseline.fuselage[key],
      min,
      max,
    );
  const uniqueSegmentIds = new Set(draft.segments.map((segment) => segment.id));
  if (uniqueSegmentIds.size === draft.segments.length)
    draft.segments.forEach((segment, index) => {
      const original = baseline.segments.find((item) => item.id === segment.id);
      if (original)
        add(
          `segment:${encodeURIComponent(segment.id)}:length`,
          `segments.${index}.length`,
          `Arm ${index + 1} 길이`,
          'structure',
          segment.length,
          original.length,
          50,
          520,
        );
    });
  const uniqueWingIds = new Set(draft.wings.map((wing) => wing.id));
  if (uniqueWingIds.size === draft.wings.length)
    draft.wings.forEach((wing, index) => {
      const original = baseline.wings.find((item) => item.id === wing.id);
      if (!original) return;
      for (const [key, label, min, max] of [
        ['span', '스팬', 200, 2000],
        ['chordInner', '안쪽 시위', 100, 500],
        ['chordOuter', '바깥 시위', 50, Math.max(50, wing.chordInner)],
      ] as const)
        add(
          `wing:${encodeURIComponent(wing.id)}:${key}`,
          `wings.${index}.${key}`,
          `날개 ${index + 1} ${label}`,
          'wing',
          wing[key],
          original[key],
          min,
          max,
        );
    });
  return parameters;
}

function locked(
  parameter: EditableParameter,
  locks: string[],
  draft: DesignDraft,
  parameters: EditableParameter[],
) {
  return locks.some((id) => {
    if (
      ['all', '*', parameter.id, parameter.path, parameter.group].includes(id)
    )
      return true;
    if (
      parameters.some((entry) => entry.id === id || entry.path === id) ||
      [
        'structure',
        'fuselage',
        'wing',
        'energy',
        'propulsion',
        'payload',
        'layout',
      ].includes(id)
    )
      return false;
    const definition = draft.parameterDefinitions.find(
      (entry) => entry.id === id,
    );
    // A raw parameter without an explicit binding locks its entire group conservatively.
    return definition ? definition.group === parameter.group : true;
  });
}

function writeParameter(
  draft: DesignDraft,
  parameter: EditableParameter,
  value: number,
) {
  const [group, position, field] = parameter.path.split('.');
  if (
    group === 'fuselage' &&
    ['length', 'horizontalDiameter', 'verticalDiameter'].includes(position)
  ) {
    draft.fuselage[
      position as 'length' | 'horizontalDiameter' | 'verticalDiameter'
    ] = value;
  } else if (group === 'segments' && field === 'length')
    draft.segments[Number(position)].length = value;
  else if (
    group === 'wings' &&
    ['span', 'chordInner', 'chordOuter'].includes(field)
  ) {
    draft.wings[Number(position)][
      field as 'span' | 'chordInner' | 'chordOuter'
    ] = value;
  } else throw new Error('지원하지 않는 변경 대상입니다.');
  // Only exact declared bindings are synchronized. Never infer a CAD binding from its name or value.
  for (const definition of draft.parameterDefinitions) {
    if (definition.path === parameter.path || definition.id === parameter.id)
      definition.value = value;
  }
}

/** Shared server/client application path. Caller additionally checks its draft fingerprint/revision. */
export function applyDraftChanges(
  draft: DesignDraft,
  changes: DraftChange[],
  baseline: DesignDraft = draft,
  lockedParameterIds: string[] = [],
): DesignDraft {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 12)
    throw new Error('변경은 1~12개만 적용할 수 있습니다.');
  const parameters = listEditableParameters(draft, baseline);
  const seen = new Set<string>();
  const next = cloneDraft(draft);
  for (const change of changes) {
    const parameter = parameters.find((entry) => entry.id === change.id);
    if (
      !parameter ||
      seen.has(change.id) ||
      locked(parameter, lockedParameterIds, draft, parameters)
    )
      throw new Error('잠겼거나 지원하지 않는 변경 대상입니다.');
    seen.add(change.id);
    if (
      change.unit !== 'mm' ||
      !Number.isFinite(change.before) ||
      change.before !== parameter.value
    )
      throw new Error(
        '현재 값과 변경안의 기준 값이 다릅니다. 다시 계산해 주세요.',
      );
    if (
      !finitePositive(change.after) ||
      change.after < parameter.min ||
      change.after > parameter.max ||
      Math.abs(change.after - parameter.value) > parameter.value * 0.100001 ||
      change.after === parameter.value
    )
      throw new Error('허용 범위 또는 ±10% 변경 한도를 벗어났습니다.');
    writeParameter(next, parameter, change.after);
  }
  for (const wing of next.wings) {
    const previous = draft.wings.find((entry) => entry.id === wing.id);
    if (
      !previous ||
      (wing.chordInner === previous.chordInner &&
        wing.chordOuter === previous.chordOuter)
    )
      continue;
    // AircraftVerse includes reverse-taper wings. Preserve existing geometry, while a proposal
    // must not introduce reverse taper or increase its ratio compared with the current draft.
    const maximumTaperRatio = Math.max(
      1,
      previous.chordOuter / previous.chordInner,
    );
    if (wing.chordOuter / wing.chordInner > maximumTaperRatio + 1e-9) {
      throw new Error(
        '새 역테이퍼를 만들거나 기존 역테이퍼 비율을 증가시키는 변경은 지원하지 않습니다.',
      );
    }
  }
  return next;
}

function improvement(
  before: DraftEstimate,
  after: DraftEstimate,
  objective: Objective,
): number | null {
  if (objective === 'balanced') {
    if (
      ![
        before.range,
        before.power,
        before.mass,
        after.range,
        after.power,
        after.mass,
      ].every(finitePositive)
    )
      return null;
    // Dominance over the current draft prevents a hidden trade-off from appearing as an improvement.
    if (
      after.range < before.range ||
      after.power > before.power ||
      after.mass > before.mass
    )
      return null;
    return (
      (after.range / before.range -
        1 +
        (1 - after.power / before.power) +
        (1 - after.mass / before.mass)) /
      3
    );
  }
  const key = objective === 'speed' ? 'maxSpeed' : objective;
  if (!finitePositive(before[key]) || !finitePositive(after[key])) return null;
  return (
    ((after[key] - before[key]) / before[key]) *
    (objective === 'power' || objective === 'drag' ? -1 : 1)
  );
}

export function optimizeDraft(
  input: DraftOptimizationInput,
): DraftOptimizationResult {
  const { selected, baseline, draft, designs, objective } = input;
  const { massLimit, powerLimit } = limits(input);
  if (selected.id !== baseline.baselineId || selected.id !== draft.baselineId)
    throw new Error('설계 기준이 일치하지 않습니다.');
  const baselineEstimate = estimateDraft(selected, baseline, baseline, designs);
  const currentEstimate = estimateDraft(selected, draft, baseline, designs);
  const parameters = listEditableParameters(draft, baseline);
  const result: DraftOptimizationResult = {
    source: 'neighbor-estimate',
    baselineEstimate,
    currentEstimate,
    parameters,
    proposals: [],
    evaluatedCount: 0,
    reason: '',
    assumptions: [
      '각 변경안은 한 개의 형상 변수만 현재 값 대비 ±5% 또는 ±10% 범위에서 탐색합니다.',
      '부품·배터리·탑재량·topology는 변경하지 않습니다. 치수와 부품의 실제 간섭·호환성은 검증하지 않습니다.',
      '결과는 인접 설계 추정에 따른 비교안이며 실제 성능 개선이나 전역 최적해가 아닙니다.',
      '균형형 Draft 제안은 거리 감소·전력 증가·질량 증가가 없는 경우만 제시합니다.',
    ],
  };
  if (
    draft.topology !== baseline.topology ||
    draft.numPropellers !== baseline.numPropellers ||
    draft.numWings !== baseline.numWings
  ) {
    result.reason =
      'topology 또는 추진기·날개 개수가 바뀐 설계는 지원하지 않습니다.';
    return result;
  }
  if (
    !designs.length ||
    ![currentEstimate.mass, currentEstimate.power].every(finitePositive) ||
    improvement(currentEstimate, currentEstimate, objective) == null
  ) {
    result.reason =
      '비교에 필요한 유효한 기준 성능 또는 이웃 데이터가 부족합니다.';
    return result;
  }
  const unlocked = parameters.filter(
    (parameter) =>
      !locked(parameter, input.lockedParameterIds ?? [], draft, parameters),
  );
  // Spread a bounded budget across groups so a large arm tree does not hide all wing controls.
  const groups = ['fuselage', 'structure', 'wing'] as const;
  const queues = groups.map((group) =>
    unlocked.filter((parameter) => parameter.group === group),
  );
  const ordered: EditableParameter[] = [];
  while (
    queues.some((queue) => queue.length) &&
    ordered.length < MAX_DRAFT_EVALUATIONS / 4
  ) {
    for (const queue of queues) {
      const parameter = queue.shift();
      if (parameter) ordered.push(parameter);
    }
  }
  const seen = new Set<string>();
  for (const parameter of ordered)
    for (const ratio of [-0.1, -0.05, 0.05, 0.1]) {
      if (result.evaluatedCount >= MAX_DRAFT_EVALUATIONS) break;
      const afterValue = Math.round(parameter.value * (1 + ratio));
      const key = `${parameter.id}:${afterValue}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const change: DraftChange = {
        id: parameter.id,
        label: parameter.label,
        before: parameter.value,
        after: afterValue,
        unit: 'mm',
      };
      let candidate: DesignDraft;
      try {
        candidate = applyDraftChanges(
          draft,
          [change],
          baseline,
          input.lockedParameterIds,
        );
      } catch {
        continue;
      }
      result.evaluatedCount += 1;
      const after = estimateDraft(selected, candidate, baseline, designs);
      if (
        ![after.mass, after.power].every(finitePositive) ||
        after.mass > massLimit ||
        after.power > powerLimit
      )
        continue;
      const gain = improvement(currentEstimate, after, objective);
      if (gain == null || gain <= 1e-6) continue;
      result.proposals.push({
        id: `draft:${key}`,
        changes: [change],
        before: currentEstimate,
        after,
        improvement: gain,
        source: 'neighbor-estimate',
      });
    }
  result.proposals.sort(
    (left, right) =>
      right.improvement - left.improvement ||
      left.id.localeCompare(right.id, 'en'),
  );
  result.proposals = result.proposals.slice(0, 3);
  result.reason = result.proposals.length
    ? '현재 설계보다 목표 지표가 개선되는 추정안을 찾았습니다.'
    : unlocked.length
      ? '허용 범위·잠금·제약 안에서 더 나은 추정안을 찾지 못했습니다.'
      : '탐색 가능한 형상 변수가 모두 잠겨 있습니다.';
  return result;
}
