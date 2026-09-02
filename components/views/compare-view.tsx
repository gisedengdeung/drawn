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
  formatHub,
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
  a: { label: 'Design A', color: '#147d91' },
  b: { label: 'Design B', color: '#6750a4' },
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
    <section className="px-4 py-4 lg:px-6">
      <SectionHeading
        eyebrow="4단계 · 설계 비교"
        title="무엇이 바뀌고, 성능이 어떻게 달라졌나요?"
        description="설계 구성의 차이를 먼저 확인한 뒤 AircraftVerse 성능 결과를 같은 단위로 비교합니다."
        actions={<SourceBadge />}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(390px,0.85fr)]">
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
            <div className="absolute right-4 top-4 z-30 flex rounded-lg border border-[#dbe4ea] bg-white/90 p-1 shadow-sm backdrop-blur">
              <Button size="sm" variant="ghost" onClick={() => setActiveModel('a')} className={activeModel === 'a' ? 'bg-[#e8f5f7] text-[#0f6475]' : 'text-[#607383]'}>A · #{a.id}</Button>
              <Button size="sm" variant="ghost" onClick={() => setActiveModel('b')} className={activeModel === 'b' ? 'bg-violet-50 text-violet-700' : 'text-[#607383]'}>B · #{b.id}</Button>
            </div>
            <ModelStage
              design={activeModel === 'a' ? aDetail : bDetail}
              emptyDesignId={activeModel === 'a' ? a.id : b.id}
              className="min-h-[390px] lg:min-h-[430px]"
              label={false}
            />
          </div>

          <section className="workspace-panel mt-4 rounded-xl p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2"><h2 className="text-sm font-medium text-[#294353]">속도별 성능 비교</h2><SourceBadge /></div>
                <p className="mt-1 text-xs text-[#607383]">
                  {aDetail && bDetail
                    ? '두 설계의 유효 trim 행만 연결합니다.'
                    : aDetail || bDetail
                      ? '패키징된 한 설계의 trim 곡선만 표시합니다.'
                      : '두 설계 모두 metadata-only라 trim 곡선이 없습니다.'}
                </p>
              </div>
              <div className="flex rounded-lg border border-[#dbe4ea] bg-[#f4f7f9] p-1">
                {([
                  ['power', 'Power'],
                  ['drag', 'Drag'],
                  ['distance', 'Distance'],
                ] as const).map(([id, label]) => (
                    <Button key={id} size="sm" variant="ghost" onClick={() => setCurveMetric(id)} className={curveMetric === id ? 'bg-white text-[#0f6475] shadow-sm' : 'text-[#607383]'}>{label}</Button>
                ))}
              </div>
            </div>
            {hasAnyTrim ? (
              <ChartContainer config={chartConfig} className="h-[260px] w-full aspect-auto" initialDimension={{ width: 760, height: 260 }}>
                <LineChart data={chartRows} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#e2e8ec" />
                  <XAxis dataKey="speed" tickLine={false} axisLine={false} tickMargin={10} unit="m/s" />
                  <YAxis tickLine={false} axisLine={false} width={52} />
                  <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                  {aDetail && <Line type="monotone" dataKey="a" name={`Design #${a.id}`} stroke="var(--color-a)" strokeWidth={2.2} dot={false} connectNulls={false} />}
                  {bDetail && <Line type="monotone" dataKey="b" name={`Design #${b.id}`} stroke="var(--color-b)" strokeWidth={2.2} dot={false} connectNulls={false} />}
                </LineChart>
              </ChartContainer>
            ) : (
              <div className="grid h-[260px] place-items-center rounded-xl border border-dashed border-[#cfdbe2] bg-[#f7f9fb] text-sm text-[#607383]">
                대표 12개 설계를 선택하면 속도별 곡선을 비교할 수 있습니다.
              </div>
            )}
          </section>
        </div>

        <aside className="workspace-panel rounded-xl p-4 lg:p-5">
          <div className="mb-4 flex items-center justify-between">
            <div><h2 className="font-semibold text-[#172b3a]">A → B 변경 분석</h2><p className="mt-1 text-xs text-[#607383]">구성 차이와 성능 결과를 순서대로 확인하세요.</p></div>
            <Badge variant="outline" className="border-[#cfdbe2] bg-[#f7f9fb] text-[#526675]">#{a.id} → #{b.id}</Badge>
          </div>

          <section className="rounded-xl border border-[#dbe4ea] bg-[#f7f9fb] p-3.5">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[#294353]"><span className="grid size-5 place-items-center rounded-full bg-[#147d91] text-[10px] text-white">1</span> 무엇이 바뀌나요?</div>
            <div className="divide-y divide-[#e2e8ec]">
              <ParameterDiffRow label="허브 구조" a={formatHub(a.hub)} b={formatHub(b.hub)} />
              <ParameterDiffRow label="프로펠러 수" a={`${a.numPropellers}개`} b={`${b.numPropellers}개`} />
              <ParameterDiffRow label="날개 수" a={`${a.numWings}개`} b={`${b.numWings}개`} />
              <ParameterDiffRow label="대표 Arm 길이" a={a.armLength ? `${formatMetric(a.armLength, 1)} mm` : '—'} b={b.armLength ? `${formatMetric(b.armLength, 1)} mm` : '—'} />
            </div>
          </section>

          <div className="mb-3 mt-5 flex items-center gap-2 text-xs font-semibold text-[#294353]"><span className="grid size-5 place-items-center rounded-full bg-[#147d91] text-[10px] text-white">2</span> 성능은 어떻게 달라졌나요?</div>
          <div className="grid grid-cols-[minmax(112px,1.2fr)_1fr_1fr_68px] gap-2 border-b border-[#dbe4ea] pb-3 text-[10px] font-medium text-[#718391]">
            <span>성능 지표</span><span className="text-right text-[#0f6475]">A</span><span className="text-right text-violet-700">B</span><span className="text-right">변화</span>
          </div>
          <div className="divide-y divide-[#e5ebef]">
            <CompareRow icon={<Route />} label="Max Distance" a={a.maxDistance / 1000} b={b.maxDistance / 1000} unit="km" better="up" />
            <CompareRow icon={<CircleGauge />} label="Hover Time" a={a.hoverTime} b={b.hoverTime} unit="sec" better="up" digits={0} />
            <CompareRow icon={<Gauge />} label="Max Speed" a={a.maxSpeed} b={b.maxSpeed} unit="m/s" better="up" />
            <CompareRow icon={<Zap />} label="Power @ MFD" a={a.power} b={b.power} unit="W" better="down" digits={0} />
            <CompareRow icon={<Wind />} label="Drag @ 20m/s" a={a.dragAt20} b={b.dragAt20} unit="N" better="down" />
            <CompareRow icon={<Weight />} label="Mass" a={a.mass} b={b.mass} unit="kg" better="down" digits={2} />
            <CompareRow icon={<BatteryCharging />} label="Propellers" a={a.numPropellers} b={b.numPropellers} unit="ea" better="neutral" digits={0} />
          </div>

          <div className="mt-5 rounded-xl border border-violet-200 bg-violet-50 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-violet-900"><Scale className="size-4 text-violet-600" /> 핵심 Trade-off</div>
            <p className="mt-2 text-xs leading-5 text-violet-800">
              B 설계는 A 대비 비행거리 {signed(percentChange(a.maxDistance, b.maxDistance))}, 체공시간 {signed(percentChange(a.hoverTime, b.hoverTime))}, 소비전력 {signed(percentChange(a.power, b.power))}입니다.
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
    <div className={`rounded-xl border p-3 ${tone === 'cyan' ? 'border-[#b9dce3] bg-[#eef8fa]' : 'border-violet-200 bg-violet-50'}`}>
      <p className={`mb-2 text-[10px] font-semibold tracking-[0.08em] ${tone === 'cyan' ? 'text-[#0f6475]' : 'text-violet-700'}`}>{label}</p>
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
    ? 'text-[#718391]'
    : bBetter ? 'text-emerald-700' : 'text-amber-700';
  const value = (metric: number, available: boolean) => available
    ? <>{formatMetric(metric, digits)} <small className="text-[9px] text-[#8796a1]">{unit}</small></>
    : <>—</>;

  return (
    <div className="grid grid-cols-[minmax(112px,1.2fr)_1fr_1fr_68px] items-center gap-2 py-3.5 text-xs">
      <div className="flex items-center gap-2 text-[#526675]"><span className="[&>svg]:size-3.5">{icon}</span><span>{label}</span></div>
      <span className={`text-right font-mono ${aBetter ? 'font-semibold text-[#0f6475]' : 'text-[#607383]'}`}>{value(a, aAvailable)}</span>
      <span className={`text-right font-mono ${bBetter ? 'font-semibold text-violet-700' : 'text-[#607383]'}`}>{value(b, bAvailable)}</span>
      <span className={`text-right font-mono text-[10px] ${changeTone}`}>
        {change == null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`}
      </span>
    </div>
  );
}

function ParameterDiffRow({ label, a, b }: { label: string; a: string; b: string }) {
  const changed = a !== b;
  return (
    <div className="grid grid-cols-[100px_1fr_18px_1fr] items-center gap-2 py-2.5 text-[11px]">
      <span className="text-[#607383]">{label}</span>
      <span className="truncate text-right font-mono text-[#526675]" title={a}>{a}</span>
      <span className="text-center text-[#9aa8b2]">→</span>
      <span className={`truncate text-right font-mono ${changed ? 'font-semibold text-violet-700' : 'text-[#8796a1]'}`} title={b}>{b}</span>
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
