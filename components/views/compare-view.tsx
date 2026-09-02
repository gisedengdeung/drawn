'use client';

import { useMemo, useState } from 'react';
import {
  BatteryCharging,
  CircleGauge,
  Gauge,
  Route,
  Scale,
  Weight,
  Wind,
  Zap,
} from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from 'recharts';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import type {
  DatasetIndex,
  DesignSummary,
  ShowcaseMap,
  TrimRow,
} from '@/lib/aerotwin-types';
import {
  formatMetric,
  isAvailableMetric,
  percentChange,
} from '@/lib/aerotwin-types';
import {
  DataDisclaimer,
  DesignSelector,
  ModelStage,
  SectionHeading,
  SourceBadge,
} from '@/components/views/shared';

const chartConfig = {
  a: { label: 'Design A', color: '#67e8f9' },
  b: { label: 'Design B', color: '#a78bfa' },
} satisfies ChartConfig;

type CurveMetric = 'power' | 'drag' | 'distance';
type ComparePair = { aId: number; bId: number };

export function CompareView({
  dataset,
  showcases,
  pair,
  onPairChange,
}: {
  dataset: DatasetIndex;
  showcases: ShowcaseMap;
  pair: ComparePair;
  onPairChange: (pair: ComparePair) => void;
}) {
  const [activeModel, setActiveModel] = useState<'a' | 'b'>('b');
  const [curveMetric, setCurveMetric] = useState<CurveMetric>('power');
  const designById = useMemo(
    () => new Map(dataset.designs.map((design) => [design.id, design])),
    [dataset.designs],
  );
  const a = designById.get(pair.aId);
  const b = designById.get(pair.bId);

  if (!a || !b) {
    return (
      <section className="m-6 rounded-2xl border border-rose-400/20 bg-rose-400/8 p-8 text-rose-200">
        비교할 설계 ID가 전체 인덱스에 없습니다.
      </section>
    );
  }

  const aDetail = showcases[String(a.id)] ?? null;
  const bDetail = showcases[String(b.id)] ?? null;
  const selectorOptions = [
    a,
    b,
    ...dataset.summary.showcaseIds
      .map((id) => designById.get(id))
      .filter((design): design is DesignSummary => Boolean(design)),
  ].filter((design, index, designs) =>
    designs.findIndex((candidate) => candidate.id === design.id) === index,
  );

  const chartRows = Array.from({ length: 51 }, (_, speed) => ({
    speed,
    a: getTrimValue(aDetail?.trim[speed], curveMetric),
    b: getTrimValue(bDetail?.trim[speed], curveMetric),
  }));
  const hasAnyTrim = Boolean(aDetail || bDetail);

  return (
    <section className="px-4 py-5 lg:px-6">
      <SectionHeading
        eyebrow="A/B Compare / Dataset metrics"
        title="설계 Trade-off 비교"
        description="전체 메타데이터의 KPI를 비교하며, 패키징된 대표 설계는 속도별 trim 곡선과 STL도 함께 표시합니다."
        actions={<SourceBadge />}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(420px,0.8fr)]">
        <div>
          <div className="mb-3 grid grid-cols-2 gap-3">
            <DesignChoice
              label="Design A"
              tone="cyan"
              designs={selectorOptions}
              value={a.id}
              onChange={(aId) => onPairChange({ aId, bId: b.id })}
            />
            <DesignChoice
              label="Design B"
              tone="violet"
              designs={selectorOptions}
              value={b.id}
              onChange={(bId) => onPairChange({ aId: a.id, bId })}
            />
          </div>

          <div className="relative">
            <div className="absolute right-4 top-4 z-30 flex rounded-xl border border-white/8 bg-[#07111d]/75 p-1 backdrop-blur">
              <Button size="sm" variant="ghost" onClick={() => setActiveModel('a')} className={activeModel === 'a' ? 'bg-cyan-300/10 text-cyan-200' : 'text-slate-500'}>A · #{a.id}</Button>
              <Button size="sm" variant="ghost" onClick={() => setActiveModel('b')} className={activeModel === 'b' ? 'bg-violet-300/10 text-violet-200' : 'text-slate-500'}>B · #{b.id}</Button>
            </div>
            <ModelStage
              design={activeModel === 'a' ? aDetail : bDetail}
              emptyDesignId={activeModel === 'a' ? a.id : b.id}
              className="min-h-[470px]"
              label={false}
            />
          </div>

          <section className="mt-4 rounded-2xl border border-white/9 bg-[#0a1622] p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2"><h2 className="text-sm font-medium text-slate-200">Speed Performance</h2><SourceBadge /></div>
                <p className="mt-1 text-xs text-slate-600">
                  {aDetail && bDetail
                    ? '두 설계의 유효 trim 행만 연결합니다.'
                    : aDetail || bDetail
                      ? '패키징된 한 설계의 trim 곡선만 표시합니다.'
                      : '두 설계 모두 metadata-only라 trim 곡선이 없습니다.'}
                </p>
              </div>
              <div className="flex rounded-xl border border-white/8 bg-white/[0.02] p-1">
                {([
                  ['power', 'Power'],
                  ['drag', 'Drag'],
                  ['distance', 'Distance'],
                ] as const).map(([id, label]) => (
                  <Button key={id} size="sm" variant="ghost" onClick={() => setCurveMetric(id)} className={curveMetric === id ? 'bg-white/8 text-white' : 'text-slate-500'}>{label}</Button>
                ))}
              </div>
            </div>
            {hasAnyTrim ? (
              <ChartContainer config={chartConfig} className="h-[260px] w-full aspect-auto" initialDimension={{ width: 760, height: 260 }}>
                <LineChart data={chartRows} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="speed" tickLine={false} axisLine={false} tickMargin={10} unit="m/s" />
                  <YAxis tickLine={false} axisLine={false} width={52} />
                  <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                  {aDetail && <Line type="monotone" dataKey="a" name={`Design #${a.id}`} stroke="var(--color-a)" strokeWidth={2.2} dot={false} connectNulls={false} />}
                  {bDetail && <Line type="monotone" dataKey="b" name={`Design #${b.id}`} stroke="var(--color-b)" strokeWidth={2.2} dot={false} connectNulls={false} />}
                </LineChart>
              </ChartContainer>
            ) : (
              <div className="grid h-[260px] place-items-center rounded-xl border border-dashed border-white/8 text-sm text-slate-600">
                대표 12개 설계를 선택하면 속도별 곡선을 비교할 수 있습니다.
              </div>
            )}
          </section>
        </div>

        <aside className="rounded-2xl border border-white/9 bg-[#0a1622] p-4 lg:p-5">
          <div className="mb-5 flex items-center justify-between">
            <div><h2 className="font-semibold text-white">Before / After</h2><p className="mt-1 text-xs text-slate-600">Design A 대비 Design B</p></div>
            <Badge variant="outline" className="border-white/8 text-slate-500">A → B</Badge>
          </div>

          <div className="grid grid-cols-[minmax(120px,1.2fr)_1fr_1fr_76px] gap-2 border-b border-white/8 pb-3 text-[10px] uppercase tracking-[0.1em] text-slate-600">
            <span>Metric</span><span className="text-right text-cyan-300">A · #{a.id}</span><span className="text-right text-violet-300">B · #{b.id}</span><span className="text-right">Change</span>
          </div>
          <div className="divide-y divide-white/7">
            <CompareRow icon={<Route />} label="Max Distance" a={a.maxDistance / 1000} b={b.maxDistance / 1000} unit="km" better="up" />
            <CompareRow icon={<CircleGauge />} label="Hover Time" a={a.hoverTime} b={b.hoverTime} unit="sec" better="up" digits={0} />
            <CompareRow icon={<Gauge />} label="Max Speed" a={a.maxSpeed} b={b.maxSpeed} unit="m/s" better="up" />
            <CompareRow icon={<Zap />} label="Power @ MFD" a={a.power} b={b.power} unit="W" better="down" digits={0} />
            <CompareRow icon={<Wind />} label="Drag @ 20m/s" a={a.dragAt20} b={b.dragAt20} unit="N" better="down" />
            <CompareRow icon={<Weight />} label="Mass" a={a.mass} b={b.mass} unit="kg" better="down" digits={2} />
            <CompareRow icon={<BatteryCharging />} label="Propellers" a={a.numPropellers} b={b.numPropellers} unit="ea" better="neutral" digits={0} />
          </div>

          <div className="mt-5 rounded-2xl border border-violet-300/12 bg-violet-300/5 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-violet-100"><Scale className="size-4 text-violet-300" /> Trade-off summary</div>
            <p className="mt-2 text-xs leading-5 text-violet-100/60">
              Design B는 A 대비 비행거리 {signed(percentChange(a.maxDistance, b.maxDistance))}, Hover {signed(percentChange(a.hoverTime, b.hoverTime))}이며 소비전력은 {signed(percentChange(a.power, b.power))}입니다.
            </p>
          </div>
          <div className="mt-4"><DataDisclaimer compact /></div>
        </aside>
      </div>
    </section>
  );
}

function DesignChoice({
  label,
  tone,
  designs,
  value,
  onChange,
}: {
  label: string;
  tone: 'cyan' | 'violet';
  designs: DesignSummary[];
  value: number;
  onChange: (id: number) => void;
}) {
  return (
    <div className={`rounded-2xl border p-3 ${tone === 'cyan' ? 'border-cyan-300/15 bg-cyan-300/5' : 'border-violet-300/15 bg-violet-300/5'}`}>
      <p className={`mb-2 text-[10px] uppercase tracking-[0.12em] ${tone === 'cyan' ? 'text-cyan-300' : 'text-violet-300'}`}>{label}</p>
      <DesignSelector designs={designs} value={value} onChange={onChange} className="w-full" />
    </div>
  );
}

function CompareRow({
  icon,
  label,
  a,
  b,
  unit,
  better,
  digits = 1,
}: {
  icon: React.ReactNode;
  label: string;
  a: number;
  b: number;
  unit: string;
  better: 'up' | 'down' | 'neutral';
  digits?: number;
}) {
  const aAvailable = isAvailableMetric(a);
  const bAvailable = isAvailableMetric(b);
  const change = percentChange(a, b);
  const aBetter = aAvailable && bAvailable && (better === 'up' ? a > b : better === 'down' ? a < b : false);
  const bBetter = aAvailable && bAvailable && (better === 'up' ? b > a : better === 'down' ? b < a : false);
  const changeTone = better === 'neutral' || change == null || change === 0
    ? 'text-slate-600'
    : bBetter ? 'text-emerald-300' : 'text-amber-300';
  const value = (metric: number, available: boolean) => available
    ? <>{formatMetric(metric, digits)} <small className="text-[9px] text-slate-700">{unit}</small></>
    : <>—</>;

  return (
    <div className="grid grid-cols-[minmax(120px,1.2fr)_1fr_1fr_76px] items-center gap-2 py-4 text-xs">
      <div className="flex items-center gap-2 text-slate-500"><span className="[&>svg]:size-3.5">{icon}</span><span>{label}</span></div>
      <span className={`text-right font-mono ${aBetter ? 'font-semibold text-cyan-200' : 'text-slate-500'}`}>{value(a, aAvailable)}</span>
      <span className={`text-right font-mono ${bBetter ? 'font-semibold text-violet-200' : 'text-slate-500'}`}>{value(b, bAvailable)}</span>
      <span className={`text-right font-mono text-[10px] ${changeTone}`}>
        {change == null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`}
      </span>
    </div>
  );
}

function getTrimValue(row: TrimRow | undefined, metric: CurveMetric) {
  if (!row?.valid) return null;
  const value = row[metric];
  if (value == null || !Number.isFinite(value) || value === 0) return null;
  return metric === 'distance' ? value / 1000 : value;
}

function signed(value: number | null) {
  return value == null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}
