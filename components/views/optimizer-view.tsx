'use client';

import { useMemo, useState } from 'react';
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
  ShowcaseDesign,
} from '@/lib/aerotwin-types';
import {
  formatDistance,
  formatHub,
  formatMetric,
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
  candidate: { label: 'Candidate', color: '#4c7f89' },
  recommended: { label: 'Recommended', color: '#a78bfa' },
} satisfies ChartConfig;

const objectives: { id: Objective; label: string; detail: string; icon: typeof Route }[] = [
  { id: 'range', label: 'Max Range', detail: '비행거리 ↑', icon: Route },
  { id: 'hover', label: 'Max Hover', detail: '체공시간 ↑', icon: CircleGauge },
  { id: 'power', label: 'Min Power', detail: '소비전력 ↓', icon: Zap },
  { id: 'drag', label: 'Min Drag', detail: 'Drag @20 ↓', icon: Wind },
  { id: 'speed', label: 'Max Speed', detail: '최대속도 ↑', icon: Gauge },
  { id: 'balanced', label: 'Balanced', detail: 'Range·Power·Mass', icon: Radar },
];

export function OptimizerView({
  dataset,
  current,
  onCompare,
}: {
  dataset: DatasetIndex;
  current: ShowcaseDesign;
  onCompare: () => void;
}) {
  const [objective, setObjective] = useState<Objective>('range');
  const [massLimit, setMassLimit] = useState(10);
  const [powerLimit, setPowerLimit] = useState(2500);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ScoredDesign[]>([]);
  const [preset, setPreset] = useState('Delivery');

  const candidatePool = useMemo(
    () => dataset.designs.filter((design) =>
      design.feasible &&
      design.mass > 0 &&
      design.mass <= massLimit &&
      design.power > 0 &&
      design.power <= powerLimit &&
      (objective !== 'drag' || design.dragAt20 > 0),
    ),
    [dataset.designs, massLimit, objective, powerLimit],
  );

  const paretoPoints = useMemo(() => {
    const sorted = [...candidatePool].sort((a, b) => a.power - b.power);
    const step = Math.max(1, Math.ceil(sorted.length / 240));
    return sorted.filter((_, index) => index % step === 0).map((design) => ({
      id: design.id,
      power: design.power,
      range: design.maxDistance / 1000,
      mass: design.mass,
    }));
  }, [candidatePool]);

  const applyPreset = (name: string) => {
    setPreset(name);
    setResults([]);
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
    setRunning(true);
    setResults([]);
    window.setTimeout(() => {
      const maxima = candidatePool.reduce(
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
      const scored = candidatePool
        .map((design) => ({ ...design, score: scoreDesign(design, objective, maxima) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      setResults(scored);
      setRunning(false);
    }, 1100);
  };

  const best = results[0];

  return (
    <section className="px-4 py-5 lg:px-6">
      <SectionHeading
        eyebrow="AI Optimizer / Surrogate-guided search"
        title="목적 기반 설계 최적화"
        description="로컬 설계공간의 실제 output.json 메트릭에 제약조건을 적용하고, 목적별 normalized surrogate score로 상위 설계를 추천합니다."
        actions={<><SourceBadge source="SURROGATE SCORE" /><Badge variant="outline" className="border-white/8 text-slate-500">NSGA-II ready architecture</Badge></>}
      />

      <div className="grid gap-4 xl:grid-cols-[330px_minmax(0,1fr)]">
        <aside className="rounded-2xl border border-white/9 bg-[#0a1622] p-4">
          <p className="text-sm font-medium text-slate-200">Mission Preset</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {[
              ['Delivery', PackageCheck],
              ['Surveillance', Radar],
              ['Racing', Crosshair],
              ['Heavy Payload', ShieldCheck],
            ].map(([name, Icon]) => (
              <button key={String(name)} onClick={() => applyPreset(String(name))} className={`rounded-xl border p-3 text-left transition ${preset === name ? 'border-cyan-300/20 bg-cyan-300/8 text-cyan-100' : 'border-white/8 bg-white/[0.02] text-slate-500 hover:bg-white/[0.04]'}`}>
                <Icon className="mb-2 size-4" />
                <span className="text-[11px] font-medium">{String(name)}</span>
              </button>
            ))}
          </div>

          <p className="mb-3 mt-6 text-sm font-medium text-slate-200">Optimization Objective</p>
          <div className="grid grid-cols-2 gap-2">
            {objectives.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.id} onClick={() => { setObjective(item.id); setResults([]); }} className={`rounded-xl border p-3 text-left transition ${objective === item.id ? 'border-violet-300/25 bg-violet-300/8' : 'border-white/8 bg-white/[0.015] hover:bg-white/[0.04]'}`}>
                  <Icon className={`mb-2 size-4 ${objective === item.id ? 'text-violet-300' : 'text-slate-600'}`} />
                  <p className={`text-[11px] font-medium ${objective === item.id ? 'text-violet-100' : 'text-slate-400'}`}>{item.label}</p>
                  <p className="mt-1 text-[9px] text-slate-600">{item.detail}</p>
                </button>
              );
            })}
          </div>

          <p className="mb-3 mt-6 text-sm font-medium text-slate-200">Constraints</p>
          <div className="mb-3">
            <span className="mb-2 flex items-center justify-between text-xs text-slate-500"><span>Mass</span><span>≤ kg</span></span>
            <Input aria-label="최대 질량" type="number" min={2} max={100} value={massLimit} onChange={(event) => { setMassLimit(Number(event.target.value)); setResults([]); }} className="h-10 border-white/10 bg-white/[0.025] font-mono text-slate-200" />
          </div>
          <div>
            <span className="mb-2 flex items-center justify-between text-xs text-slate-500"><span>Power @ MFD</span><span>≤ W</span></span>
            <Input aria-label="최대 소비전력" type="number" min={200} max={10000} step={100} value={powerLimit} onChange={(event) => { setPowerLimit(Number(event.target.value)); setResults([]); }} className="h-10 border-white/10 bg-white/[0.025] font-mono text-slate-200" />
          </div>

          <div className="mt-4 flex items-center justify-between rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2 text-xs">
            <span className="text-slate-500">Feasible candidates</span>
            <span className="font-mono text-cyan-200">{candidatePool.length.toLocaleString()}</span>
          </div>
          <Button disabled={running || candidatePool.length === 0} onClick={optimize} className="mt-4 h-11 w-full bg-violet-400 text-white hover:bg-violet-300">
            <Sparkles /> {running ? 'Exploring design space…' : 'OPTIMIZE'}
          </Button>
          {running && <Progress value={82} className="mt-3 [&_[data-slot=progress-indicator]]:bg-violet-400" />}
        </aside>

        <div className="min-w-0 space-y-4">
          <section className="rounded-2xl border border-white/9 bg-[#0a1622] p-4 lg:p-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div><div className="flex items-center gap-2"><h2 className="font-semibold text-white">Pareto Design Space</h2><SourceBadge /></div><p className="mt-1 text-xs text-slate-600">Range ↑ vs Power ↓ · 유효 후보 최대 240점 표시</p></div>
              <div className="flex gap-4 text-[10px] text-slate-500"><span className="flex items-center gap-2"><i className="size-2 rounded-full bg-cyan-900" /> 후보</span><span className="flex items-center gap-2"><i className="size-2 rounded-full bg-violet-400" /> 추천</span></div>
            </div>
            <ChartContainer config={chartConfig} className="h-[310px] w-full aspect-auto" initialDimension={{ width: 900, height: 310 }}>
              <ScatterChart margin={{ left: 0, right: 16, top: 10, bottom: 6 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.06)" />
                <XAxis type="number" dataKey="power" name="Power" unit="W" tickLine={false} axisLine={false} tickMargin={8} />
                <YAxis type="number" dataKey="range" name="Range" unit="km" tickLine={false} axisLine={false} width={56} />
                <ZAxis type="number" dataKey="mass" range={[24, 100]} name="Mass" unit="kg" />
                <ChartTooltip cursor={{ strokeDasharray: '3 3' }} content={<ChartTooltipContent />} />
                <Scatter data={paretoPoints} fill="var(--color-candidate)" fillOpacity={0.42} />
                {best && <Scatter data={[{ power: best.power, range: best.maxDistance / 1000, mass: best.mass }]} fill="var(--color-recommended)" />}
              </ScatterChart>
            </ChartContainer>
          </section>

          {running ? (
            <section className="grid min-h-72 place-items-center rounded-2xl border border-violet-300/12 bg-violet-300/5 p-8 text-center">
              <div><Sparkles className="mx-auto mb-4 size-7 animate-pulse text-violet-300" /><p className="font-medium text-violet-100">후보 설계를 평가하고 있습니다</p><p className="mt-2 text-xs text-violet-100/50">제약 필터 → 목적 점수 → Pareto shortlist</p></div>
            </section>
          ) : results.length ? (
            <>
              <div className="grid gap-3 lg:grid-cols-3">
                {results.map((design, index) => <RecommendationCard key={design.id} design={design} rank={index + 1} />)}
              </div>

              <section className="rounded-2xl border border-violet-300/15 bg-[linear-gradient(135deg,rgba(167,139,250,0.09),rgba(34,211,238,0.035))] p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2"><Trophy className="size-4 text-violet-300" /><p className="text-sm font-medium text-violet-100">AI Recommended · Design #{best.id}</p><SourceBadge source="SURROGATE SCORE" /></div>
                    <p className="mt-2 text-xs text-violet-100/55">{formatHub(best.hub)} · constraint 통과 · score {best.score.toFixed(3)}</p>
                  </div>
                  <Button onClick={onCompare} className="bg-violet-400 text-white hover:bg-violet-300"><GitCompareArrows /> A/B Compare 열기 <ArrowRight /></Button>
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
            <section className="grid min-h-60 place-items-center rounded-2xl border border-white/9 bg-[#0a1622] p-8 text-center">
              <div><Sparkles className="mx-auto mb-4 size-6 text-slate-700" /><p className="text-sm font-medium text-slate-300">최적화 목표와 제약조건을 선택하세요</p><p className="mt-2 text-xs text-slate-600">OPTIMIZE를 누르면 상위 3개 설계와 Pareto trade-off를 반환합니다.</p></div>
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
  return range * 0.36 + hover * 0.22 + power * 0.18 + drag * 0.1 + speed * 0.06 + mass * 0.08;
}

function RecommendationCard({ design, rank }: { design: ScoredDesign; rank: number }) {
  return (
    <article className={`rounded-2xl border p-4 ${rank === 1 ? 'border-violet-300/20 bg-violet-300/7' : 'border-white/9 bg-[#0a1622]'}`}>
      <div className="flex items-start justify-between"><div><p className="text-[10px] uppercase tracking-[0.12em] text-slate-600">Rank {rank}</p><p className="mt-1 font-mono text-sm font-semibold text-slate-200">Design #{design.id}</p></div>{rank === 1 && <Badge className="bg-violet-300/12 text-violet-200"><Trophy /> Best</Badge>}</div>
      <p className="mt-3 truncate text-[11px] text-slate-600">{formatHub(design.hub)}</p>
      <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
        <Mini label="Range" value={formatDistance(design.maxDistance)} />
        <Mini label="Power" value={`${formatMetric(design.power, 0)} W`} />
        <Mini label="Hover" value={`${formatMetric(design.hoverTime, 0)} s`} />
        <Mini label="Mass" value={`${formatMetric(design.mass, 2)} kg`} />
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-white/7 pt-3 text-[10px]"><span className="text-slate-600">Surrogate score</span><span className="font-mono text-violet-300">{design.score.toFixed(3)}</span></div>
    </article>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-white/[0.025] p-2"><p className="text-[9px] text-slate-600">{label}</p><p className="mt-1 font-mono text-[11px] text-slate-300">{value}</p></div>;
}

function DeltaMetric({ label, before, after, unit, better }: { label: string; before: number; after: number; unit: string; better: 'up' | 'down' }) {
  const change = percentChange(before, after);
  const good = better === 'up' ? change >= 0 : change <= 0;
  return (
    <div className="rounded-xl border border-white/8 bg-[#08131f]/55 p-3">
      <p className="text-[10px] text-slate-600">{label}</p>
      <p className="mt-1 font-mono text-xs text-slate-300">{formatMetric(after, unit === 'kg' || unit === 'N' ? 2 : 0)} {unit}</p>
      <p className={`mt-1 font-mono text-[10px] ${good ? 'text-emerald-300' : 'text-amber-300'}`}>{change >= 0 ? '+' : ''}{change.toFixed(1)}%</p>
    </div>
  );
}
