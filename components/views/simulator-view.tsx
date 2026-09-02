'use client';

import { useMemo, useState } from 'react';
import {
  ArrowRight,
  BatteryCharging,
  CircleGauge,
  Gauge,
  MoveDown,
  MoveUp,
  Plane,
  Timer,
  Wind,
  Zap,
} from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from 'recharts';

import { Button } from '@/components/ui/button';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Slider } from '@/components/ui/slider';
import type { ShowcaseDesign } from '@/lib/aerotwin-types';
import { formatHub, formatMetric } from '@/lib/aerotwin-types';
import {
  ConfigurationList,
  DataDisclaimer,
  DesignSelector,
  MetricTile,
  ModelStage,
  SectionHeading,
  SourceBadge,
} from '@/components/views/shared';

const overviewConfig = {
  drag: { label: 'Drag (N)', color: '#67e8f9' },
  power: { label: 'Power (W)', color: '#a78bfa' },
} satisfies ChartConfig;

const aeroConfig = {
  drag: { label: 'Drag (N)', color: '#67e8f9' },
  thrust: { label: 'Thrust (N)', color: '#6ee7b7' },
  lift: { label: 'Lift (N)', color: '#fbbf24' },
} satisfies ChartConfig;

const electricConfig = {
  power: { label: 'Power (W)', color: '#a78bfa' },
  current: { label: 'Current (A)', color: '#67e8f9' },
} satisfies ChartConfig;

type CurveMode = 'overview' | 'aero' | 'electric';

export function SimulatorView({
  designs,
  selected,
  onSelect,
  onOpenLab,
}: {
  designs: ShowcaseDesign[];
  selected: ShowcaseDesign;
  onSelect: (id: number) => void;
  onOpenLab: () => void;
}) {
  const [speed, setSpeed] = useState(20);
  const [curveMode, setCurveMode] = useState<CurveMode>('overview');
  const trim = selected.trim[speed];
  const validRows = useMemo(() => selected.trim.filter((row) => row.valid), [selected]);
  const config = curveMode === 'overview' ? overviewConfig : curveMode === 'aero' ? aeroConfig : electricConfig;

  return (
    <section className="px-4 py-5 lg:px-6">
      <SectionHeading
        eyebrow={`Performance Simulator / Design #${selected.id}`}
        title="속도별 Trim Performance"
        description="0–50m/s의 실제 trims.npy 행을 탐색하며 공력·추진·전력 성능이 함께 변하는 과정을 확인합니다."
        actions={
          <>
            <DesignSelector designs={designs} value={selected.id} onChange={onSelect} />
            <Button onClick={onOpenLab} className="bg-cyan-300 text-[#041019] hover:bg-cyan-200">
              What-if 설계 <ArrowRight />
            </Button>
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_340px]">
        <ModelStage design={selected} className="min-h-[455px]" />
        <aside className="rounded-2xl border border-white/9 bg-[#0a1622] p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[10px] uppercase tracking-[0.16em] text-slate-600">Current aircraft</p>
              <p className="mt-1 font-mono text-sm font-semibold text-slate-200">Design #{selected.id}</p>
            </div>
            <SourceBadge />
          </div>
          <p className="mt-3 text-xs text-slate-500">{formatHub(selected.hub)} · {selected.numPropellers} propellers · {selected.numWings} wings</p>
          <div className="mt-4"><ConfigurationList design={selected} /></div>
          <DataDisclaimer compact />
        </aside>
      </div>

      <section className="mt-4 rounded-2xl border border-white/9 bg-[#0a1622] p-4 lg:p-5">
        <div className="grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <h2 className="font-semibold text-white">Flight Speed</h2>
              <SourceBadge />
            </div>
            <p className="text-xs text-slate-500">행 index = 속도 (m/s)</p>
            <div className="my-8 flex items-end gap-2">
              <span className="font-mono text-5xl font-semibold tracking-[-0.07em] text-cyan-200">{speed}</span>
              <span className="mb-1 text-sm text-slate-500">m/s</span>
            </div>
            <Slider
              value={[speed]}
              min={0}
              max={50}
              step={1}
              onValueChange={(value) => setSpeed(Number(Array.isArray(value) ? value[0] : value))}
              className="[&_[data-slot=slider-range]]:bg-cyan-300 [&_[data-slot=slider-thumb]]:size-4 [&_[data-slot=slider-thumb]]:border-cyan-200"
              aria-label="비행 속도"
            />
            <div className="mt-2 flex justify-between font-mono text-[10px] text-slate-600"><span>0</span><span>10</span><span>20</span><span>30</span><span>40</span><span>50</span></div>

            <div className="mt-6 rounded-xl border border-white/8 bg-white/[0.02] p-3">
              <div className="flex items-center justify-between text-xs"><span className="text-slate-500">유효 속도 범위</span><span className="font-mono text-emerald-300">0–{validRows.at(-1)?.speed ?? 0} m/s</span></div>
              <div className="mt-2 flex items-center justify-between text-xs"><span className="text-slate-500">Output Max Speed</span><span className="font-mono text-slate-300">{selected.maxSpeed} m/s</span></div>
            </div>
          </div>

          <div className="min-w-0 border-l border-white/8 pl-0 xl:pl-5">
            {trim?.valid ? (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <LiveMetric icon={<Wind />} label="Drag" value={trim.drag} unit="N" tone="cyan" />
                <LiveMetric icon={<MoveUp />} label="Lift" value={trim.lift} unit="N" tone="amber" />
                <LiveMetric icon={<Plane />} label="Thrust" value={trim.thrust} unit="N" tone="green" />
                <LiveMetric icon={<Gauge />} label="Pitch" value={trim.pitch} unit="deg" tone="violet" />
                <LiveMetric icon={<Zap />} label="Power" value={trim.power} unit="W" tone="violet" />
                <LiveMetric icon={<BatteryCharging />} label="Current" value={trim.current} unit="A" tone="cyan" />
                <LiveMetric icon={<Timer />} label="Flight Time" value={trim.flightTime} unit="sec" tone="green" />
                <LiveMetric icon={<CircleGauge />} label="Distance" value={trim.distance ? trim.distance / 1000 : null} unit="km" tone="amber" />
              </div>
            ) : (
              <div className="grid min-h-44 place-items-center rounded-2xl border border-amber-300/15 bg-amber-300/5 p-6 text-center">
                <div>
                  <MoveDown className="mx-auto mb-3 size-6 text-amber-300" />
                  <p className="text-sm font-medium text-amber-100">유효한 trim 상태가 없습니다</p>
                  <p className="mt-2 text-xs text-amber-100/60">Design #{selected.id}은 {speed}m/s에서 수렴한 성능 데이터가 없습니다.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="mt-4 rounded-2xl border border-white/9 bg-[#0a1622] p-4 lg:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2"><h2 className="font-semibold text-white">Performance Curve</h2><SourceBadge /></div>
            <p className="mt-1 text-xs text-slate-500">실선은 유효한 AircraftVerse trim 행만 표시합니다.</p>
          </div>
          <div className="flex rounded-xl border border-white/8 bg-white/[0.02] p-1">
            {([
              ['overview', 'Overview'],
              ['aero', 'Aerodynamic'],
              ['electric', 'Electrical'],
            ] as const).map(([id, label]) => (
              <Button key={id} size="sm" variant="ghost" onClick={() => setCurveMode(id)} className={curveMode === id ? 'bg-white/8 text-white' : 'text-slate-500'}>{label}</Button>
            ))}
          </div>
        </div>

        <ChartContainer config={config} className="h-[300px] w-full aspect-auto" initialDimension={{ width: 900, height: 300 }}>
          <LineChart data={validRows} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="speed" tickLine={false} axisLine={false} tickMargin={10} unit="m/s" />
            <YAxis yAxisId="left" tickLine={false} axisLine={false} width={42} />
            <YAxis yAxisId="right" orientation="right" tickLine={false} axisLine={false} width={48} />
            <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
            <ReferenceLine x={speed} stroke="#f8fafc" strokeOpacity={0.38} strokeDasharray="3 4" />
            {curveMode === 'overview' && (
              <>
                <Line yAxisId="left" type="monotone" dataKey="drag" stroke="var(--color-drag)" strokeWidth={2.2} dot={false} />
                <Line yAxisId="right" type="monotone" dataKey="power" stroke="var(--color-power)" strokeWidth={2.2} dot={false} />
              </>
            )}
            {curveMode === 'aero' && (
              <>
                <Line yAxisId="left" type="monotone" dataKey="drag" stroke="var(--color-drag)" strokeWidth={2.2} dot={false} />
                <Line yAxisId="left" type="monotone" dataKey="thrust" stroke="var(--color-thrust)" strokeWidth={2.2} dot={false} />
                <Line yAxisId="left" type="monotone" dataKey="lift" stroke="var(--color-lift)" strokeWidth={2.2} dot={false} />
              </>
            )}
            {curveMode === 'electric' && (
              <>
                <Line yAxisId="right" type="monotone" dataKey="power" stroke="var(--color-power)" strokeWidth={2.2} dot={false} />
                <Line yAxisId="left" type="monotone" dataKey="current" stroke="var(--color-current)" strokeWidth={2.2} dot={false} />
              </>
            )}
          </LineChart>
        </ChartContainer>
      </section>
    </section>
  );
}

function LiveMetric({ icon, label, value, unit, tone }: { icon: React.ReactNode; label: string; value: number | null; unit: string; tone: 'cyan' | 'violet' | 'green' | 'amber' }) {
  return (
    <MetricTile
      icon={<span className="[&>svg]:size-4">{icon}</span>}
      label={label}
      value={value == null ? '—' : formatMetric(value, unit === 'W' || unit === 'sec' ? 0 : 1)}
      unit={value == null ? undefined : unit}
      tone={tone}
      source="DATASET"
    />
  );
}
