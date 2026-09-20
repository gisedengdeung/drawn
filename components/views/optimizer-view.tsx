'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  CircleGauge,
  Crosshair,
  Gauge,
  GitCompareArrows,
  PackageCheck,
  Radar,
  Route,
  ShieldCheck,
  Sparkles,
  Trophy,
  Wind,
  Zap,
} from 'lucide-react';
import {
  CartesianGrid,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import type {
  DatasetIndex,
  DesignSummary,
} from '@/lib/aerotwin-types';
import {
  formatDistance,
  formatHub,
  formatMetric,
  isAvailableMetric,
  percentChange,
} from '@/lib/aerotwin-types';
import {
  DataDisclaimer,
  SectionHeading,
  SourceBadge,
} from '@/components/views/shared';

type Objective = 'range' | 'hover' | 'power' | 'drag' | 'speed' | 'balanced';
type ScoredDesign = DesignSummary & { score: number };

const chartConfig = {
  candidate: { label: '조건 통과 후보', color: '#9aabb5' },
  pareto: { label: '2목적 Pareto 후보', color: '#147d91' },
  recommended: { label: '현재 추천', color: '#6750a4' },
} satisfies ChartConfig;

const objectives: { id: Objective; label: string; detail: string; icon: typeof Route }[] = [
  { id: 'range', label: '비행거리 최대', detail: 'Range ↑', icon: Route },
  { id: 'hover', label: '체공시간 최대', detail: 'Hover ↑', icon: CircleGauge },
  { id: 'power', label: '소비전력 최소', detail: 'Power ↓', icon: Zap },
  { id: 'drag', label: '항력 최소', detail: 'Drag @20 ↓', icon: Wind },
  { id: 'speed', label: '최대속도 최대', detail: 'Speed ↑', icon: Gauge },
  { id: 'balanced', label: '균형형', detail: '3목적 Pareto knee', icon: Radar },
];

export function OptimizerView({
  dataset,
  current,
  onCompare,
  onApplyDraft,
  onOpenGallery,
}: {
  dataset: DatasetIndex;
  current: DesignSummary;
  onCompare: (aId: number, bId: number) => void;
  onApplyDraft: (id: number) => void;
  onOpenGallery: () => void;
}) {
  const [objective, setObjective] = useState<Objective>('range');
  const [massLimit, setMassLimit] = useState(10);
  const [powerLimit, setPowerLimit] = useState(2500);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ScoredDesign[]>([]);
  const [preset, setPreset] = useState('Delivery');
  const runTimeoutRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (runTimeoutRef.current != null) window.clearTimeout(runTimeoutRef.current);
  }, []);

  const candidatePool = useMemo(
    () => dataset.designs.filter((design) => {
      if (
        design.id === current.id ||
        !design.feasible ||
        design.mass <= 0 ||
        design.mass > massLimit ||
        design.power <= 0 ||
        design.power > powerLimit
      ) return false;
      if (objective === 'hover') return design.hoverTime > 0;
      if (objective === 'drag') return design.dragAt20 > 0;
      if (objective === 'speed') return design.maxSpeed > 0;
      if (objective === 'balanced') {
        return design.maxDistance > 0;
      }
      return design.maxDistance > 0;
    }),
    [current.id, dataset.designs, massLimit, objective, powerLimit],
  );

  const designSpaceSample = useMemo(() => {
    const sorted = [...candidatePool].sort((a, b) => a.power - b.power);
    const step = Math.max(1, Math.ceil(sorted.length / 240));
    return sorted.filter((_, index) => index % step === 0).map((design) => ({
      id: design.id,
      power: design.power,
      range: design.maxDistance / 1000,
      mass: design.mass,
    }));
  }, [candidatePool]);

  const paretoPoints = useMemo(() => buildParetoPoints(candidatePool), [candidatePool]);

  const cancelPendingRun = () => {
    if (runTimeoutRef.current != null) {
      window.clearTimeout(runTimeoutRef.current);
      runTimeoutRef.current = null;
    }
    setRunning(false);
    setResults([]);
  };

  const applyPreset = (name: string) => {
    cancelPendingRun();
    setPreset(name);
    if (name === 'Delivery') {
      setObjective('range'); setMassLimit(10); setPowerLimit(2500);
    } else if (name === 'Surveillance') {
      setObjective('hover'); setMassLimit(12); setPowerLimit(2200);
    } else if (name === 'Racing') {
      setObjective('speed'); setMassLimit(6); setPowerLimit(3200);
    } else {
      setObjective('balanced'); setMassLimit(18); setPowerLimit(4200);
    }
  };

  const optimize = () => {
    if (runTimeoutRef.current != null) window.clearTimeout(runTimeoutRef.current);
    const requestedCandidates = candidatePool;
    const requestedObjective = objective;
    setRunning(true);
    setResults([]);
    runTimeoutRef.current = window.setTimeout(() => {
      const maxima = requestedCandidates.reduce(
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
      const scored = requestedObjective === 'balanced'
        ? scoreParetoKnee(requestedCandidates).slice(0, 3)
        : requestedCandidates
          .map((design) => ({ ...design, score: scoreDesign(design, requestedObjective, maxima) }))
          .sort((a, b) => b.score - a.score || a.id - b.id)
          .slice(0, 3);
      setResults(scored);
      setRunning(false);
      runTimeoutRef.current = null;
    }, 0);
  };

  const best = results[0];

  return (
    <section className="px-4 py-4 lg:px-6">
      <SectionHeading
        eyebrow="5단계 · 조건에 맞는 후보 탐색"
        title="데이터셋 후보 탐색"
        description="27,714개 실제 output.json 메트릭을 조건으로 필터링하고, 선택한 목적 점수로 순위를 계산합니다."
        actions={<><SourceBadge source="DATASET RANKING" /><Badge variant="outline" className="border-[#d8cfee] bg-violet-50 text-violet-700">학습 AI가 아닌 데이터셋 랭킹</Badge><Button onClick={onOpenGallery} className="bg-[#147d91] text-white hover:bg-[#0f6475]">6단계 · 공유 갤러리 →</Button></>}
      />

      <div className="grid gap-4 lg:grid-cols-[310px_minmax(0,1fr)]">
        <aside className="workspace-panel rounded-xl p-4">
          <p className="text-sm font-medium text-[#294353]">임무 Preset</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {[
              ['Delivery', PackageCheck],
              ['Surveillance', Radar],
              ['Racing', Crosshair],
              ['Heavy Payload', ShieldCheck],
            ].map(([name, Icon]) => (
              <button key={String(name)} onClick={() => applyPreset(String(name))} className={`rounded-lg border p-3 text-left transition ${preset === name ? 'border-[#9ccdd6] bg-[#eef8fa] text-[#0f6475]' : 'border-[#dbe4ea] bg-white text-[#607383] hover:bg-[#f4f7f9]'}`}>
                <Icon className="mb-2 size-4" />
                <span className="text-[11px] font-medium">{String(name)}</span>
              </button>
            ))}
          </div>

          <p className="mb-3 mt-5 text-sm font-medium text-[#294353]">탐색 목표</p>
          <div className="grid grid-cols-2 gap-2">
            {objectives.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.id} onClick={() => { cancelPendingRun(); setObjective(item.id); }} className={`rounded-lg border p-3 text-left transition ${objective === item.id ? 'border-violet-300 bg-violet-50' : 'border-[#dbe4ea] bg-white hover:bg-[#f4f7f9]'}`}>
                  <Icon className={`mb-2 size-4 ${objective === item.id ? 'text-violet-700' : 'text-[#718391]'}`} />
                  <p className={`text-[11px] font-medium ${objective === item.id ? 'text-violet-900' : 'text-[#526675]'}`}>{item.label}</p>
                  <p className="mt-1 text-[10px] text-[#718391]">{item.detail}</p>
                </button>
              );
            })}
          </div>

          <p className="mb-3 mt-5 text-sm font-medium text-[#294353]">제약조건</p>
          <div className="mb-3">
            <span className="mb-2 flex items-center justify-between text-xs text-[#607383]"><span>최대 질량</span><span>kg 이하</span></span>
            <Input aria-label="최대 질량" type="number" min={2} max={100} value={massLimit} onChange={(event) => { cancelPendingRun(); setMassLimit(Number(event.target.value)); }} className="h-10 border-[#ccd8df] bg-white font-mono text-[#172b3a]" />
          </div>
          <div>
            <span className="mb-2 flex items-center justify-between text-xs text-[#607383]"><span>최대 소비전력 @ MFD</span><span>W 이하</span></span>
            <Input aria-label="최대 소비전력" type="number" min={200} max={10000} step={100} value={powerLimit} onChange={(event) => { cancelPendingRun(); setPowerLimit(Number(event.target.value)); }} className="h-10 border-[#ccd8df] bg-white font-mono text-[#172b3a]" />
          </div>

          <div className="mt-4 flex items-center justify-between rounded-lg border border-[#dbe4ea] bg-[#f4f7f9] px-3 py-2 text-xs">
            <span className="text-[#607383]">조건 통과 후보</span>
            <span className="font-mono font-semibold text-[#0f6475]">{candidatePool.length.toLocaleString()}개</span>
          </div>
          <Button disabled={running || candidatePool.length === 0} onClick={optimize} className="mt-4 h-11 w-full bg-[#147d91] text-white hover:bg-[#0f6878]">
            <Sparkles /> {running ? '후보 순위 계산 중…' : '상위 후보 계산'}
          </Button>
          {running && <Progress value={82} className="mt-3 [&_[data-slot=progress-indicator]]:bg-violet-400" />}
        </aside>

        <div className="min-w-0 space-y-4">
          <section className="workspace-panel rounded-xl p-4 lg:p-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div><div className="flex items-center gap-2"><h2 className="font-semibold text-[#172b3a]">Range–Power 2목적 Pareto</h2><SourceBadge /></div><p className="mt-1 text-xs text-[#607383]">회색은 최대 240개 표본, 청록색은 더 낮은 전력과 더 긴 거리에 동시에 지배되지 않는 실제 2목적 후보입니다.</p></div>
              <div className="flex flex-wrap gap-4 text-[10px] text-[#607383]"><span className="flex items-center gap-2"><i className="size-2 rounded-full bg-[#9aabb5]" /> 표본 후보</span><span className="flex items-center gap-2"><i className="size-2 rounded-full bg-[#147d91]" /> Pareto {paretoPoints.length}개</span><span className="flex items-center gap-2"><i className="size-2 rounded-full bg-violet-700" /> 현재 추천</span></div>
            </div>
            <ChartContainer config={chartConfig} className="h-[310px] w-full aspect-auto" initialDimension={{ width: 900, height: 310 }}>
              <ScatterChart margin={{ left: 0, right: 16, top: 10, bottom: 6 }}>
                <CartesianGrid stroke="#e2e8ec" />
                <XAxis type="number" dataKey="power" name="Power" unit="W" tickLine={false} axisLine={false} tickMargin={8} />
                <YAxis type="number" dataKey="range" name="Range" unit="km" tickLine={false} axisLine={false} width={56} />
                <ZAxis type="number" dataKey="mass" range={[24, 100]} name="Mass" unit="kg" />
                <ChartTooltip cursor={{ strokeDasharray: '3 3' }} content={<ChartTooltipContent />} />
                <Scatter data={designSpaceSample} fill="var(--color-candidate)" fillOpacity={0.42} />
                <Scatter data={paretoPoints} fill="var(--color-pareto)" fillOpacity={0.9} />
                {best && <Scatter data={[{ power: best.power, range: best.maxDistance / 1000, mass: best.mass }]} fill="var(--color-recommended)" />}
              </ScatterChart>
            </ChartContainer>
          </section>

          {running ? (
            <section className="grid min-h-72 place-items-center rounded-xl border border-violet-200 bg-violet-50 p-8 text-center">
              <div><Sparkles className="mx-auto mb-4 size-7 animate-pulse text-violet-700" /><p className="font-medium text-violet-900">후보 순위를 계산하고 있습니다</p><p className="mt-2 text-xs text-violet-700">제약 필터 → 목적 점수 → 상위 후보</p></div>
            </section>
          ) : results.length ? (
            <>
              <div className="grid gap-3 lg:grid-cols-3">
                {results.map((design, index) => <RecommendationCard key={design.id} design={design} rank={index + 1} />)}
              </div>

              <section className="rounded-xl border border-violet-200 bg-[linear-gradient(135deg,#f5f2ff,#eef8fa)] p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2"><Trophy className="size-4 text-violet-700" /><p className="text-sm font-medium text-violet-900">데이터셋 추천 · Design #{best.id}</p><SourceBadge source="DATASET RANKING" /></div>
                    <p className="mt-2 text-xs text-violet-700">{formatHub(best.hub)} · 제약조건 통과 · {objective === 'balanced' ? '비지배 Pareto knee' : `목적 점수 ${best.score.toFixed(3)}`}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => onApplyDraft(best.id)} variant="outline" className="border-violet-200 bg-white text-violet-800 hover:bg-violet-50"><Sparkles /> 추천안을 Draft로 열기</Button>
                    <Button onClick={() => onCompare(current.id, best.id)} className="bg-violet-700 text-white hover:bg-violet-800"><GitCompareArrows /> 현재 설계와 비교 <ArrowRight /></Button>
                  </div>
                </div>
                <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-5">
                  <DeltaMetric label="Range" before={current.maxDistance} after={best.maxDistance} unit="m" better="up" />
                  <DeltaMetric label="Hover" before={current.hoverTime} after={best.hoverTime} unit="sec" better="up" />
                  <DeltaMetric label="Power" before={current.power} after={best.power} unit="W" better="down" />
                  <DeltaMetric label="Mass" before={current.mass} after={best.mass} unit="kg" better="down" />
                  <DeltaMetric label="Drag @20" before={current.dragAt20} after={best.dragAt20} unit="N" better="down" />
                </div>
              </section>
            </>
          ) : (
            <section className="workspace-panel grid min-h-60 place-items-center rounded-xl p-8 text-center">
              <div><Sparkles className="mx-auto mb-4 size-6 text-[#718391]" /><p className="text-sm font-medium text-[#294353]">목표와 제약조건을 검토하세요</p><p className="mt-2 text-xs text-[#607383]">‘상위 후보 계산’을 누르면 데이터셋 점수 기준 상위 3개 설계를 반환합니다.</p></div>
            </section>
          )}
          <DataDisclaimer compact />
        </div>
      </div>
    </section>
  );
}

function scoreDesign(design: DesignSummary, objective: Objective, max: Record<'range' | 'hover' | 'power' | 'drag' | 'speed' | 'mass', number>) {
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

function buildParetoPoints(designs: DesignSummary[]) {
  const sorted = [...designs]
    .filter((design) => design.power > 0 && design.maxDistance > 0)
    .sort((a, b) => a.power - b.power || b.maxDistance - a.maxDistance || a.id - b.id);
  const points: Array<{ id: number; power: number; range: number; mass: number }> = [];
  let bestRange = Number.NEGATIVE_INFINITY;
  for (const design of sorted) {
    if (design.maxDistance <= bestRange) continue;
    bestRange = design.maxDistance;
    points.push({
      id: design.id,
      power: design.power,
      range: design.maxDistance / 1000,
      mass: design.mass,
    });
  }
  return points;
}

function RecommendationCard({ design, rank }: { design: ScoredDesign; rank: number }) {
  return (
    <article className={`rounded-xl border p-4 shadow-sm ${rank === 1 ? 'border-violet-200 bg-violet-50' : 'border-[#dbe4ea] bg-white'}`}>
      <div className="flex items-start justify-between"><div><p className="text-[10px] font-medium tracking-[0.08em] text-[#718391]">순위 {rank}</p><p className="mt-1 font-mono text-sm font-semibold text-[#233b4a]">Design #{design.id}</p></div>{rank === 1 && <Badge className="bg-violet-100 text-violet-800"><Trophy /> 추천</Badge>}</div>
      <p className="mt-3 truncate text-[11px] text-[#607383]">{formatHub(design.hub)}</p>
      <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
        <Mini label="Range" value={formatDistance(design.maxDistance)} />
        <Mini label="Power" value={`${formatMetric(design.power, 0)} W`} />
        <Mini label="Hover" value={isAvailableMetric(design.hoverTime) ? `${formatMetric(design.hoverTime, 0)} s` : '—'} />
        <Mini label="Mass" value={`${formatMetric(design.mass, 2)} kg`} />
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-[#e5ebef] pt-3 text-[10px]"><span className="text-[#718391]">데이터셋 점수</span><span className="font-mono font-semibold text-violet-700">{design.score.toFixed(3)}</span></div>
    </article>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-[#f4f7f9] p-2"><p className="text-[9px] text-[#718391]">{label}</p><p className="mt-1 font-mono text-[11px] text-[#294353]">{value}</p></div>;
}

function DeltaMetric({ label, before, after, unit, better }: { label: string; before: number; after: number; unit: string; better: 'up' | 'down' }) {
  const change = percentChange(before, after);
  const good = change == null ? false : better === 'up' ? change >= 0 : change <= 0;
  const available = isAvailableMetric(after);
  return (
    <div className="rounded-xl border border-[#dbe4ea] bg-white p-3">
      <p className="text-[10px] text-[#718391]">{label}</p>
      <p className="mt-1 font-mono text-xs text-[#294353]">{available ? `${formatMetric(after, unit === 'kg' || unit === 'N' ? 2 : 0)} ${unit}` : '—'}</p>
      <p className={`mt-1 font-mono text-[10px] ${change == null ? 'text-[#718391]' : good ? 'text-emerald-700' : 'text-amber-700'}`}>{change == null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`}</p>
    </div>
  );
}
