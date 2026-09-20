import type { DesignSummary } from './drawn-types';

export type Objective = 'range' | 'hover' | 'power' | 'drag' | 'speed' | 'balanced';

export type ScoredDesign = DesignSummary & { score: number };

export const CANDIDATE_OBJECTIVES: { id: Objective; label: string; detail: string }[] = [
  { id: 'range', label: '비행거리 최대', detail: '비행거리 ↑' },
  { id: 'hover', label: '체공시간 최대', detail: '체공시간 ↑' },
  { id: 'power', label: '소비전력 최소', detail: '소비전력 ↓' },
  { id: 'drag', label: '항력 최소', detail: '항력 ↓' },
  { id: 'speed', label: '최대속도 최대', detail: '최고속도 ↑' },
  { id: 'balanced', label: '균형형', detail: '3목적 Pareto knee' },
];

export const CANDIDATE_PRESETS: {
  name: string;
  objective: Objective;
  massLimit: number;
  powerLimit: number;
}[] = [
  { name: 'Delivery', objective: 'range', massLimit: 10, powerLimit: 2500 },
  { name: 'Surveillance', objective: 'hover', massLimit: 12, powerLimit: 2200 },
  { name: 'Racing', objective: 'speed', massLimit: 6, powerLimit: 3200 },
  { name: 'Heavy Payload', objective: 'balanced', massLimit: 18, powerLimit: 4200 },
];

/** 목적·질량·전력 제약을 만족하는 후보 풀을 만듭니다. */
export function buildCandidatePool(
  designs: DesignSummary[],
  currentId: number,
  massLimit: number,
  powerLimit: number,
  objective: Objective,
) {
  return designs.filter((design) => {
    if (
      design.id === currentId ||
      !design.feasible ||
      design.mass <= 0 ||
      design.mass > massLimit ||
      design.power <= 0 ||
      design.power > powerLimit
    ) return false;
    if (objective === 'hover') return design.hoverTime > 0;
    if (objective === 'drag') return design.dragAt20 > 0;
    if (objective === 'speed') return design.maxSpeed > 0;
    return design.maxDistance > 0;
  });
}

function scoreDesign(
  design: DesignSummary,
  objective: Objective,
  max: Record<'range' | 'hover' | 'power' | 'drag' | 'speed' | 'mass', number>,
) {
  const range = design.maxDistance / max.range;
  const hover = design.hoverTime / max.hover;
  const power = 1 - design.power / max.power;
  const drag = design.dragAt20 ? 1 - design.dragAt20 / max.drag : 0;
  const speed = design.maxSpeed / max.speed;
  const mass = 1 - design.mass / max.mass;
  if (objective === 'range') return range;
  if (objective === 'hover') return hover;
  if (objective === 'power') return power;
  if (objective === 'drag') return drag;
  if (objective === 'speed') return speed;
  return range + power + mass;
}

function scoreParetoKnee(designs: DesignSummary[]): ScoredDesign[] {
  const sorted = [...designs].sort(
    (left, right) => left.power - right.power || left.mass - right.mass || right.maxDistance - left.maxDistance || left.id - right.id,
  );
  const front: DesignSummary[] = [];
  for (const design of sorted) {
    if (front.some((candidate) => candidate.power <= design.power && candidate.mass <= design.mass && candidate.maxDistance >= design.maxDistance)) continue;
    for (let index = front.length - 1; index >= 0; index -= 1) {
      const candidate = front[index];
      if (design.power <= candidate.power && design.mass <= candidate.mass && design.maxDistance >= candidate.maxDistance) front.splice(index, 1);
    }
    front.push(design);
  }
  const bounds = front.reduce(
    (acc, design) => ({
      minRange: Math.min(acc.minRange, design.maxDistance), maxRange: Math.max(acc.maxRange, design.maxDistance),
      minPower: Math.min(acc.minPower, design.power), maxPower: Math.max(acc.maxPower, design.power),
      minMass: Math.min(acc.minMass, design.mass), maxMass: Math.max(acc.maxMass, design.mass),
    }),
    { minRange: Infinity, maxRange: -Infinity, minPower: Infinity, maxPower: -Infinity, minMass: Infinity, maxMass: -Infinity },
  );
  const normalizedDistance = (design: DesignSummary) => Math.hypot(
    1 - (design.maxDistance - bounds.minRange) / Math.max(bounds.maxRange - bounds.minRange, 1),
    (design.power - bounds.minPower) / Math.max(bounds.maxPower - bounds.minPower, 1),
    (design.mass - bounds.minMass) / Math.max(bounds.maxMass - bounds.minMass, 1),
  );
  return front
    .map((design) => ({ ...design, score: 1 / (1 + normalizedDistance(design)) }))
    .sort((left, right) => right.score - left.score || left.id - right.id);
}

/** 후보 풀을 목적에 맞게 채점해 상위 N개를 반환합니다. */
export function rankCandidates(pool: DesignSummary[], objective: Objective, limit = 3): ScoredDesign[] {
  if (objective === 'balanced') return scoreParetoKnee(pool).slice(0, limit);
  const maxima = pool.reduce(
    (acc, design) => ({
      range: Math.max(acc.range, design.maxDistance),
      hover: Math.max(acc.hover, design.hoverTime),
      power: Math.max(acc.power, design.power),
      drag: Math.max(acc.drag, design.dragAt20),
      speed: Math.max(acc.speed, design.maxSpeed),
      mass: Math.max(acc.mass, design.mass),
    }),
    { range: 1, hover: 1, power: 1, drag: 1, speed: 1, mass: 1 },
  );
  return pool
    .map((design) => ({ ...design, score: scoreDesign(design, objective, maxima) }))
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .slice(0, limit);
}
