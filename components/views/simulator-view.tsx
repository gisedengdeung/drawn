'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  ArrowLeft,
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
import type { DesignDraft, DesignSummary, ShowcaseDesign } from '@/lib/drawn-types';
import { ParametricUavViewer } from '@/components/parametric-uav-viewer';
import { PerformancePredictionPanel } from './performance-prediction-panel';
import { formatValidSpeedRanges } from '@/lib/performance-client';
import { formatHub, formatMetric } from '@/lib/drawn-types';
import {
  DataDisclaimer,
  DesignSelector,
  ModelStage,
  SectionHeading,
  SourceBadge,
} from '@/components/views/shared';

const overviewConfig = {
  drag: { label: '항력 (N)', color: '#3182f6' },
  power: { label: '전력 (W)', color: '#6750a4' },
} satisfies ChartConfig;

const aeroConfig = {
  drag: { label: '항력 (N)', color: '#3182f6' },
  thrust: { label: '추력 (N)', color: '#178653' },
  lift: { label: '양력 (N)', color: '#c47a13' },
} satisfies ChartConfig;

const electricConfig = {
  power: { label: '전력 (W)', color: '#6750a4' },
  current: { label: '전류 (A)', color: '#3182f6' },
} satisfies ChartConfig;

type CurveMode = 'overview' | 'aero' | 'electric';

export function SimulatorView({ designs, selected, referenceDesign, draft, baseline, loading = false, loadError, onSelect, onOpenLab }: {
  designs: Array<Pick<DesignSummary, 'id' | 'numPropellers' | 'numWings'>>;
  selected: DesignSummary;
  referenceDesign?: ShowcaseDesign | null;
  draft: DesignDraft | null;
  baseline: DesignDraft | null;
  loading?: boolean;
  loadError?: string | null;
  onSelect: (id: number) => void;
  onOpenLab: () => void;
}) {
  const [speed, setSpeed] = useState(20);
  // AI가 예측한 자세. 원본 STL이 없는 설계는 이 값으로 기체를 기울인다.
  const [predictedPitch, setPredictedPitch] = useState<number | null>(null);
  const handlePitch = useCallback((value: number | null) => setPredictedPitch(value), []);
  return (
    <section className="px-4 py-4 lg:px-6">
      <SectionHeading eyebrow={`3단계 · 성능 확인 / Design #${selected.id}`} title="속도별 비행성능" description="현재 편집 설계의 AI 예측과 기준 설계의 원본 시뮬레이션을 구분해 확인하세요." actions={<><DesignSelector designs={designs} value={selected.id} onChange={onSelect} /><Button onClick={onOpenLab} className="bg-[#3182f6] text-white hover:bg-[#1b64da]"><ArrowLeft /> 파라미터 편집</Button></>} />
      <PerformancePredictionPanel designId={selected.id} draft={draft} disabled={loading || !draft} inputError={loadError} speed={speed} onSpeedChange={setSpeed} onPitchChange={handlePitch} />
      {referenceDesign ? <DatasetSimulation selected={referenceDesign} speed={speed} onSpeedChange={setSpeed} /> : (
        <div className="mt-4 overflow-hidden rounded-2xl border border-[#e5e5ea] bg-white">
          <p className="p-4 text-xs text-[#6e6e73]">이 설계의 원본 STL·trim 곡선은 배포되지 않았습니다. 현재 편집 형상과 위 AI 예측을 확인할 수 있습니다.</p>
          <div className="relative h-[440px]">
            {draft && baseline && (
              <ParametricUavViewer draft={draft} baseline={baseline} pitchDegrees={predictedPitch ?? 0} />
            )}
            {predictedPitch != null && (
              // 원본 시뮬레이션 값이 아니라 추정값이라는 것을 화면에서 구분한다.
              <div className="absolute left-4 top-4 z-20 rounded-full bg-white/85 px-2.5 py-1 text-[10px] font-medium text-[#1b64da] backdrop-blur">
                AI 추정 자세 · {speed} m/s · {predictedPitch.toFixed(1)}°
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function DatasetSimulation({ selected, speed, onSpeedChange }: { selected: ShowcaseDesign; speed: number; onSpeedChange: (speed: number) => void }) {
  const [curveMode, setCurveMode] = useState<CurveMode>('overview');
  const trim = selected.trim[speed];
  const validRows = useMemo(() => selected.trim.filter((row) => row.valid), [selected]);
  const chartRows = selected.trim.map((row) => row.valid ? row : { speed: row.speed });
  const config = curveMode === 'overview' ? overviewConfig : curveMode === 'aero' ? aeroConfig : electricConfig;

  return (
    <section className="min-w-0">
      <div className="mb-3 mt-5"><h2 className="text-base font-semibold text-[#1d1d1f]">기준 설계 원본 시뮬레이션</h2><p className="mt-1 text-xs text-[#6e6e73]">AircraftVerse 기준 설계 #{selected.id}의 저장된 결과입니다. 현재 편집 내용은 위 AI 예측에만 반영됩니다.</p></div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <ModelStage
          design={selected}
          className="min-h-[500px] lg:min-h-[520px]"
          pitchDegrees={trim?.valid ? trim.pitch : 0}
          forceVectors={trim?.valid ? { drag: trim.drag, lift: trim.lift, thrust: trim.thrust } : undefined}
          showForceVectors={Boolean(trim?.valid)}
        />
        <aside className="workspace-panel rounded-xl p-4">
          <div className="flex items-start justify-between gap-3 border-b border-[#e5e5ea] pb-3">
            <div>
              <p className="text-xs font-medium text-[#6e6e73]">현재 설계</p>
              <p className="mt-1 font-mono text-base font-semibold text-[#1d1d1f]">Design #{selected.id}</p>
              <p className="mt-1 text-[11px] text-[#6e6e73]">{formatHub(selected.hub)} · {selected.numPropellers}P / {selected.numWings}W</p>
            </div>
            <SourceBadge />
          </div>

          <div className="mt-4">
            <div className="flex items-end justify-between">
              <div>
                <p className="text-xs font-medium text-[#6e6e73]">비행 속도</p>
                <p className="mt-1 text-[11px] text-[#6e6e73]">0–50 m/s · 1 m/s 간격</p>
              </div>
              <p className="font-mono text-3xl font-semibold tracking-[-0.05em] text-[#1b64da]">
                {speed}<span className="ml-1 text-xs font-normal text-[#6e6e73]">m/s</span>
              </p>
            </div>
            <Slider
              value={[speed]}
              min={0}
              max={50}
              step={1}
              onValueChange={(value) => onSpeedChange(Number(Array.isArray(value) ? value[0] : value))}
              className="mt-5 [&_[data-slot=slider-range]]:bg-[#3182f6] [&_[data-slot=slider-thumb]]:size-4 [&_[data-slot=slider-thumb]]:border-[#3182f6]"
              aria-label="비행 속도"
            />
            <div className="mt-2 flex justify-between font-mono text-[10px] text-[#6e6e73]"><span>0</span><span>10</span><span>20</span><span>30</span><span>40</span><span>50</span></div>
            <div className="mt-3 flex items-center justify-between rounded-lg bg-[#f5f5f7] px-3 py-2 text-[11px]">
              <span className="text-[#6e6e73]">원본 유효 trim 구간</span>
              <span className="font-mono font-medium text-emerald-700">{formatValidSpeedRanges(validRows.map((row) => row.speed))}</span>
            </div>
          </div>

          <div className="mt-4 min-w-0">
            {trim?.valid ? (
              <div className="grid grid-cols-2 gap-2">
                <LiveMetric icon={<Wind />} label="항력" value={trim.drag} unit="N" tone="cyan" />
                <LiveMetric icon={<MoveUp />} label="양력" value={trim.lift} unit="N" tone="amber" />
                <LiveMetric icon={<Plane />} label="추력" value={trim.thrust} unit="N" tone="green" />
                <LiveMetric icon={<Gauge />} label="피치각" value={trim.pitch} unit="deg" tone="violet" />
                <LiveMetric icon={<Zap />} label="전력" value={trim.power} unit="W" tone="violet" />
                <LiveMetric icon={<BatteryCharging />} label="전류" value={trim.current} unit="A" tone="cyan" />
                <LiveMetric icon={<Timer />} label="비행 시간" value={trim.flightTime} unit="sec" tone="green" />
                <LiveMetric icon={<CircleGauge />} label="비행거리" value={trim.distance != null ? trim.distance / 1000 : null} unit="km" tone="amber" />
              </div>
            ) : (
              <div className="grid min-h-56 place-items-center rounded-xl border border-amber-200 bg-amber-50 p-5 text-center">
                <div>
                  <MoveDown className="mx-auto mb-3 size-6 text-amber-600" />
                  <p className="text-sm font-medium text-amber-900">이 속도에서는 해석값이 없습니다</p>
                  <p className="mt-2 text-xs leading-5 text-amber-700">Design #{selected.id}의 {speed}m/s trim 계산이 수렴하지 않았습니다.</p>
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>

      <section className="workspace-panel mt-4 rounded-xl p-4 lg:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2"><h2 className="font-semibold text-[#1d1d1f]">속도별 성능 곡선</h2><SourceBadge /></div>
            <p className="mt-1 text-xs text-[#6e6e73]">원본 trim의 유효 구간을 표시합니다. 해석값이 없는 속도에서는 곡선이 끊어집니다.</p>
          </div>
          <div className="flex rounded-lg bg-[#f5f5f7] p-1">
            {([
              ['overview', '요약'],
              ['aero', '공력'],
              ['electric', '전력'],
            ] as const).map(([id, label]) => (
              <Button key={id} size="sm" variant="ghost" onClick={() => setCurveMode(id)} className={curveMode === id ? 'bg-white text-[#1b64da] shadow-sm' : 'text-[#6e6e73]'}>{label}</Button>
            ))}
          </div>
        </div>

        <ChartContainer config={config} className="h-[300px] w-full aspect-auto" initialDimension={{ width: 900, height: 300 }}>
          <LineChart data={chartRows} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#e2e8ec" />
            <XAxis dataKey="speed" tickLine={false} axisLine={false} tickMargin={10} unit="m/s" />
            <YAxis yAxisId="left" tickLine={false} axisLine={false} width={42} />
            <YAxis yAxisId="right" orientation="right" tickLine={false} axisLine={false} width={48} />
            <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
            <ReferenceLine x={speed} stroke="#334e5d" strokeOpacity={0.45} strokeDasharray="3 4" />
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
        <div className="mt-3"><DataDisclaimer compact /></div>
      </section>
    </section>
  );
}

function LiveMetric({ icon, label, value, unit, tone }: { icon: React.ReactNode; label: string; value: number | null; unit: string; tone: 'cyan' | 'violet' | 'green' | 'amber' }) {
  const available = value != null && Number.isFinite(value);
  const toneClass = {
    cyan: 'bg-[#eff6ff] text-[#1b64da]',
    violet: 'bg-violet-50 text-violet-700',
    green: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700',
  }[tone];
  return (
    <div className="rounded-lg border border-[#e5e5ea] bg-white p-2.5">
      <div className="flex items-center gap-2">
        <span className={`grid size-6 place-items-center rounded-md [&>svg]:size-3.5 ${toneClass}`}>{icon}</span>
        <span className="text-[11px] text-[#6e6e73]">{label}</span>
      </div>
      <p className="mt-2 font-mono text-base font-semibold text-[#1d1d1f]">
        {available ? formatMetric(value, unit === 'W' || unit === 'sec' ? 0 : 1) : '—'}
        {available && <span className="ml-1 text-[10px] font-normal text-[#6e6e73]">{unit}</span>}
      </p>
    </div>
  );
}
