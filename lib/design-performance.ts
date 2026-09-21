import type { DesignDraft, DesignSummary } from './drawn-types';
import { isAvailableMetric } from './drawn-types';
import { cloneDraft } from './design-draft';

export type DraftEstimate = {
  mass: number;
  range: number;
  hover: number;
  maxSpeed: number;
  power: number;
  drag: number;
  similarity: number;
  closestId: number;
  source: 'dataset' | 'neighbor-estimate';
  modelVersion: 'neighbor-estimate-v1';
  neighbors: Array<{ designId: number; distance: number; weight: number }>;
  topologyFallbackUsed: boolean;
  appliedCorrections: Record<string, number>;
  assumptions: string[];
  unsupportedInputs: string[];
};

export function estimateDraft(
  selected: DesignSummary,
  draft: DesignDraft,
  baseline: DesignDraft,
  datasetDesigns: DesignSummary[],
): DraftEstimate {
  if (countChanges(draft, baseline) === 0) {
    return {
      mass: selected.mass,
      range: selected.maxDistance,
      hover: selected.hoverTime,
      maxSpeed: selected.maxSpeed,
      power: selected.power,
      drag: selected.dragAt20,
      similarity: 100,
      closestId: selected.id,
      source: 'dataset',
      modelVersion: 'neighbor-estimate-v1',
      neighbors: [{ designId: selected.id, distance: 0, weight: 1 }],
      topologyFallbackUsed: false,
      appliedCorrections: {},
      assumptions: ['Unchanged draft: original AircraftVerse simulation KPIs.'],
      unsupportedInputs: [],
    };
  }
  const baseArm = average(
    baseline.segments.map((item) => item.length),
    selected.armLength || 300,
  );
  const draftArm = average(
    draft.segments.map((item) => item.length),
    baseArm,
  );
  const bodyBase =
    baseline.fuselage.length *
    baseline.fuselage.horizontalDiameter *
    baseline.fuselage.verticalDiameter;
  const bodyDraft =
    draft.fuselage.length *
    draft.fuselage.horizontalDiameter *
    draft.fuselage.verticalDiameter;
  const armRatio = draftArm / Math.max(baseArm, 1);
  const bodyRatio = Math.max(
    0.45,
    Math.min(2.1, bodyDraft / Math.max(bodyBase, 1)),
  );
  const baseBattery = batteryCapacity(baseline.energy.batteryTypes[0]);
  const draftBattery = batteryCapacity(draft.energy.batteryTypes[0]);
  const batteryRatio = Math.max(
    0.55,
    Math.min(1.9, draftBattery / Math.max(baseBattery, 1)),
  );
  const baseWing = baseline.wings.reduce(
    (sum, wing) => sum + wing.span * (wing.chordInner + wing.chordOuter) * 0.5,
    0,
  );
  const draftWing = draft.wings.reduce(
    (sum, wing) => sum + wing.span * (wing.chordInner + wing.chordOuter) * 0.5,
    0,
  );
  const wingRatio =
    baseWing > 0 ? Math.max(0.55, Math.min(1.8, draftWing / baseWing)) : 1;
  const componentChanges =
    draft.propulsionGroups.reduce((sum, group, index) => {
      const base = baseline.propulsionGroups[index];
      return (
        sum +
        (group.motorType !== base?.motorType ? 1 : 0) +
        (group.propellerType !== base?.propellerType ? 1 : 0)
      );
    }, 0) +
    draft.energy.batteryTypes.filter(
      (item, index) => item !== baseline.energy.batteryTypes[index],
    ).length +
    draft.wings.filter(
      (wing, index) => wing.nacaProfile !== baseline.wings[index]?.nacaProfile,
    ).length;
  const meanAngleDelta = average(
    draft.segments.map((segment, index) =>
      Math.abs(
        segment.angle - (baseline.segments[index]?.angle ?? segment.angle),
      ),
    ),
    0,
  );
  const meanOffsetDelta = average(
    draft.segments.map((segment, index) =>
      Math.abs(
        segment.offset - (baseline.segments[index]?.offset ?? segment.offset),
      ),
    ),
    0,
  );
  const meanWingRotationDelta = average(
    draft.wings.map((wing, index) =>
      Math.abs(
        wing.rotation - (baseline.wings[index]?.rotation ?? wing.rotation),
      ),
    ),
    0,
  );
  const controlSurfaceDelta = draft.wings.reduce((sum, wing, index) => {
    const base = baseline.wings[index];
    return (
      sum +
      Math.abs(wing.aileronBias - (base?.aileronBias ?? wing.aileronBias)) +
      Math.abs(wing.flapBias - (base?.flapBias ?? wing.flapBias))
    );
  }, 0);
  const neighbors = nearestDatasetDesigns(selected, draft, datasetDesigns);
  const closest = neighbors[0]?.design ?? selected;
  const neighborMetric = (
    read: (design: DesignSummary) => number,
    fallback: number,
  ) => {
    const usable = neighbors.filter(({ design }) =>
      isAvailableMetric(read(design)),
    );
    if (!usable.length) return fallback;
    const denominator = usable.reduce((sum, item) => sum + item.weight, 0);
    return (
      usable.reduce((sum, item) => sum + read(item.design) * item.weight, 0) /
      Math.max(denominator, 0.0001)
    );
  };
  const datasetMass = neighborMetric((design) => design.mass, selected.mass);
  const mass = Math.max(
    0.5,
    datasetMass + (draft.payload.mass - baseline.payload.mass),
  );
  const massRatio = mass / Math.max(selected.mass, 0.5);
  const layoutDragPenalty =
    1 +
    meanAngleDelta / 900 +
    meanOffsetDelta / 1800 +
    meanWingRotationDelta / 720;
  const dragFactor = Math.max(
    0.55,
    Math.min(
      1.85,
      ((armRatio ** 1.12 * bodyRatio ** 0.22) / wingRatio ** 0.08) *
        layoutDragPenalty,
    ),
  );
  const efficiency = Math.max(0.87, 1 - componentChanges * 0.012);
  const similarityPenalty =
    Math.abs(Math.log(armRatio)) * 18 +
    Math.abs(Math.log(bodyRatio)) * 15 +
    Math.abs(Math.log(batteryRatio)) * 10 +
    componentChanges * 2.8 +
    meanAngleDelta * 0.06 +
    meanOffsetDelta * 0.025 +
    meanWingRotationDelta * 0.04 +
    controlSurfaceDelta * 5;
  const proximityDistance =
    (neighbors[0]?.distance ?? 0) + similarityPenalty / 100;
  return {
    mass,
    range:
      (neighborMetric((design) => design.maxDistance, selected.maxDistance) *
        batteryRatio ** 0.22 *
        efficiency) /
      massRatio ** 0.16,
    hover:
      (neighborMetric((design) => design.hoverTime, selected.hoverTime) *
        batteryRatio ** 0.24 *
        efficiency) /
      massRatio ** 0.28,
    maxSpeed:
      (neighborMetric((design) => design.maxSpeed, selected.maxSpeed) *
        efficiency) /
      dragFactor ** 0.08,
    power:
      (neighborMetric((design) => design.power, selected.power) *
        massRatio ** 0.25 *
        dragFactor ** 0.18) /
      efficiency,
    drag:
      neighborMetric((design) => design.dragAt20, selected.dragAt20) *
      dragFactor ** 0.35,
    similarity: Math.round(Math.max(35, 100 / (1 + proximityDistance * 2.8))),
    closestId: closest.id,
    source: 'neighbor-estimate',
    modelVersion: 'neighbor-estimate-v1',
    neighbors: neighbors.map(({ design, distance, weight }) => ({
      designId: design.id,
      distance,
      weight,
    })),
    topologyFallbackUsed:
      datasetDesigns.length > 0 &&
      datasetDesigns.filter((design) => design.hub === draft.topology).length <
        8,
    appliedCorrections: {
      armRatio,
      bodyRatio,
      batteryRatio,
      wingRatio,
      massRatio,
      layoutDragPenalty,
      dragFactor,
      efficiency,
      componentChanges,
    },
    assumptions: [
      'Deterministic nearest-design estimate with heuristic corrections, not a trained model or physics solver.',
      'Neighbor weights are inverse squared distances; each KPI renormalizes over positive available observations.',
      'Similarity is a distance display, not confidence or flight safety.',
      ...(!datasetDesigns.length
        ? ['Dataset neighbors unavailable; baseline KPIs are used.']
        : []),
      ...(!/\d{3,6}mAh/i.test(baseline.energy.batteryTypes[0] ?? '') ||
      !/\d{3,6}mAh/i.test(draft.energy.batteryTypes[0] ?? '')
        ? [
            'Unrecognized battery capacity uses the existing 5000 mAh heuristic default.',
          ]
        : []),
    ],
    unsupportedInputs: [
      ...(draft.topology !== baseline.topology ? ['topology-change'] : []),
      'manufacturer-component-performance',
      'physical-compatibility',
      'flight-certification',
    ],
  };
}

function nearestDatasetDesigns(
  selected: DesignSummary,
  draft: DesignDraft,
  designs: DesignSummary[],
) {
  if (!designs.length) return [{ design: selected, distance: 0, weight: 1 }];
  const meanArm = average(
    draft.segments.map((item) => item.length),
    selected.meanArmLength || selected.armLength || 300,
  );
  const totalWingSpan = draft.wings.reduce((sum, wing) => sum + wing.span, 0);
  const meanWingChord = average(
    draft.wings.map((wing) => (wing.chordInner + wing.chordOuter) * 0.5),
    0,
  );
  const motor = draft.propulsionGroups[0]?.motorType ?? '';
  const propeller = draft.propulsionGroups[0]?.propellerType ?? '';
  const battery = draft.energy.batteryTypes[0] ?? '';
  const sameTopology = designs.filter(
    (design) => design.hub === draft.topology,
  );
  const candidates =
    sameTopology.length >= 8
      ? sameTopology
      : designs.filter(
          (design) =>
            design.numPropellers === selected.numPropellers &&
            design.numWings > 0 === draft.wings.length > 0,
        );
  return candidates
    .map((design) => {
      const distance =
        normalizedDelta(
          meanArm,
          design.meanArmLength || design.armLength,
          470,
        ) *
          1.2 +
        normalizedDelta(draft.fuselage.length, design.fuselageLength, 475) *
          0.65 +
        normalizedDelta(
          draft.fuselage.horizontalDiameter,
          design.fuselageHorizontalDiameter,
          700,
        ) *
          0.55 +
        normalizedDelta(
          draft.fuselage.verticalDiameter,
          design.fuselageVerticalDiameter,
          303,
        ) *
          0.55 +
        normalizedDelta(totalWingSpan, design.totalWingSpan, 2000) * 0.8 +
        normalizedDelta(meanWingChord, design.meanWingChord, 450) * 0.65 +
        (motor && design.primaryMotor !== motor ? 0.18 : 0) +
        (propeller && design.primaryPropeller !== propeller ? 0.18 : 0) +
        (battery && design.primaryBattery !== battery ? 0.14 : 0);
      return { design, distance, weight: 1 / (distance + 0.025) ** 2 };
    })
    .sort((a, b) => a.distance - b.distance || a.design.id - b.design.id)
    .slice(0, 5);
}

function normalizedDelta(a: number, b: number, range: number) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.abs(a - b) / Math.max(range, 1);
}

export function countChanges(a: DesignDraft, b: DesignDraft) {
  let structuralCount = 0;
  const compare = (left: unknown, right: unknown) => {
    if (
      typeof left === 'object' &&
      left != null &&
      typeof right === 'object' &&
      right != null
    ) {
      const leftRecord = left as Record<string, unknown>;
      const rightRecord = right as Record<string, unknown>;
      for (const key of new Set([
        ...Object.keys(leftRecord),
        ...Object.keys(rightRecord),
      ]))
        compare(leftRecord[key], rightRecord[key]);
    } else if (left !== right) structuralCount += 1;
  };
  const withoutDefinitions = (draft: DesignDraft) => {
    const copy = cloneDraft(draft);
    copy.parameterDefinitions = [];
    return copy;
  };
  compare(withoutDefinitions(a), withoutDefinitions(b));
  const rawCount = (a.parameterDefinitions ?? []).filter(
    (item, index) => item.value !== b.parameterDefinitions?.[index]?.value,
  ).length;
  return Math.max(structuralCount, rawCount);
}

function average(values: number[], fallback: number) {
  return values.length
    ? values.reduce((sum, item) => sum + item, 0) / values.length
    : fallback;
}

function batteryCapacity(value?: string) {
  return Number(value?.match(/(\d{3,6})mAh/i)?.[1] ?? 5000);
}
