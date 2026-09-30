'use client';

import { useId, useMemo, useState } from 'react';
import {
  BatteryCharging,
  CircleGauge,
  Gauge,
  GitCompareArrows,
  Route,
  Scale,
  Weight,
  Wind,
  X,
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
import { Switch } from '@/components/ui/switch';
import { DesignPicker } from '@/components/design-picker';
import { ParametricUavViewer } from '@/components/parametric-uav-viewer';
import { useDesignPreview } from '@/hooks/use-design-preview';
import { copyViewerCamera } from '@/lib/viewer-camera-sync';
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
} from '@/lib/drawn-types';
import {
  formatHub,
  formatMetric,
  isAvailableMetric,
  percentChange,
} from '@/lib/drawn-types';
import {
  DataDisclaimer,
  SourceBadge,
} from '@/components/views/shared';

const chartConfig = {
  a: { label: 'A 설계', color: '#3182f6' },
  b: { label: 'B 설계', color: '#6750a4' },
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
  const [viewerMode, setViewerMode] = useState<'a' | 'b' | 'dual'>('dual');
  const [cameraLinked, setCameraLinked] = useState(true);
  const [pickerSlot, setPickerSlot] = useState<'a' | 'b' | null>(null);
  const [curveMetric, setCurveMetric] = useState<CurveMetric>('power');
  const designById = useMemo(
    () => new Map(dataset.designs.map((design) => [design.id, design])),
    [dataset.designs],
  );
  const a = designById.get(pair.aId);
  const b = designById.get(pair.bId);
  const aPreview = useDesignPreview(a?.id ?? null);
  const bPreview = useDesignPreview(b?.id ?? null);
  const cameraGroup = `dataset-compare-${useId()}`;

  if (!a || !b) {
    return (
      <section className="m-6 rounded-2xl border border-rose-400/20 bg-rose-400/8 p-8 text-rose-200">
        비교할 설계 ID가 전체 인덱스에 없습니다.
      </section>
    );
  }

  const aDetail = showcases[String(a.id)] ?? null;
  const bDetail = showcases[String(b.id)] ?? null;
  const chartRows = Array.from({ length: 51 }, (_, speed) => ({
    speed,
    a: getTrimValue(aDetail?.trim[speed], curveMetric),
    b: getTrimValue(bDetail?.trim[speed], curveMetric),
  }));
  const hasAnyTrim = Boolean(aDetail || bDetail);

  return (
    <div className="h-full min-h-0">
      <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid min-h-0 grid-rows-[auto_minmax(230px,1fr)_292px] border-r border-[#e5e5ea]">
          <div className="grid grid-cols-2 gap-2 border-b border-[#e5e5ea] bg-white p-3">
            <CompareDesignSlot label="A 설계" tone="cyan" design={a} expanded={pickerSlot === 'a'} onClick={() => setPickerSlot((current) => current === 'a' ? null : 'a')} />
            <CompareDesignSlot label="B 설계" tone="violet" design={b} expanded={pickerSlot === 'b'} onClick={() => setPickerSlot((current) => current === 'b' ? null : 'b')} />
          </div>

          <div className="relative min-h-0 overflow-hidden bg-[#eef3f6]">
            <div className="absolute left-1/2 top-3 z-30 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-2 rounded-2xl border border-[#e5e5ea] bg-white/94 p-1.5 shadow-xl backdrop-blur-xl">
              <div className="flex rounded-lg bg-[#f5f5f7] p-1">
                <CompareModeButton active={viewerMode === 'a'} onClick={() => setViewerMode('a')}>A · #{a.id}</CompareModeButton>
                <CompareModeButton active={viewerMode === 'b'} onClick={() => setViewerMode('b')}>B · #{b.id}</CompareModeButton>
                <CompareModeButton active={viewerMode === 'dual'} onClick={() => setViewerMode('dual')}>듀얼 뷰</CompareModeButton>
              </div>
              {viewerMode === 'dual' && <div className="flex items-center gap-1 rounded-lg bg-[#f5f5f7] p-1 text-[10px] font-medium text-[#3c3c43]">
                <div className="flex items-center gap-1.5 px-1.5">
                  <Switch
                    aria-label="A와 B 설계 카메라 연동"
                    checked={cameraLinked}
                    onCheckedChange={(linked) => {
                      setCameraLinked(linked);
                      if (linked) window.requestAnimationFrame(() => copyViewerCamera(cameraGroup, 'a', 'b'));
                    }}
                    size="sm"
                  />
                  카메라 연동
                </div>
                {!cameraLinked && <>
                  <button type="button" onClick={() => copyViewerCamera(cameraGroup, 'a', 'b')} className="rounded-md bg-white px-2 py-1 shadow-sm hover:text-[#1b64da]">A → B</button>
                  <button type="button" onClick={() => copyViewerCamera(cameraGroup, 'b', 'a')} className="rounded-md bg-white px-2 py-1 shadow-sm hover:text-[#1b64da]">A ← B</button>
                </>}
              </div>}
            </div>
            <div className={`absolute inset-0 grid ${viewerMode === 'dual' ? 'grid-cols-2 divide-x divide-[#dbe4ea]' : 'grid-cols-1'}`}>
              {(viewerMode === 'a' || viewerMode === 'dual') && <CompareParametricPane key="a" preview={aPreview} label={`A · #${a.id}`} tone="cyan" cameraGroup={cameraGroup} cameraId="a" cameraLinked={viewerMode === 'dual' && cameraLinked} paused={pickerSlot != null} />}
              {(viewerMode === 'b' || viewerMode === 'dual') && <CompareParametricPane key="b" preview={bPreview} label={`B · #${b.id}`} tone="violet" cameraGroup={cameraGroup} cameraId="b" cameraLinked={viewerMode === 'dual' && cameraLinked} paused={pickerSlot != null} />}
            </div>
            {pickerSlot && <div className={`absolute top-0 z-50 flex h-[min(460px,100%)] w-1/2 flex-col overflow-hidden border border-t-2 bg-white shadow-2xl animate-in slide-in-from-top-2 ${pickerSlot === 'a' ? 'left-0 border-[#93c5fd]' : 'right-0 border-violet-300'}`}>
              <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[#e5e5ea] px-3">
                <GitCompareArrows className={`size-4 ${pickerSlot === 'a' ? 'text-[#3182f6]' : 'text-violet-600'}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold">{pickerSlot === 'a' ? 'A' : 'B'} 설계 선택</p>
                  <p className="text-[9px] text-[#86868b]">기존 설계 탐색·추천·즐겨찾기 사용</p>
                </div>
                <button type="button" onClick={() => setPickerSlot(null)} aria-label="설계 선택 닫기" className="grid size-7 place-items-center rounded-lg text-[#6e6e73] hover:bg-[#f5f5f7]"><X className="size-4" /></button>
              </div>
              <div className="min-h-0 flex-1">
                <DesignPicker
                  designs={dataset.designs}
                  showcases={showcases}
                  selectedId={pickerSlot === 'a' ? a.id : b.id}
                  layout="split"
                  onSelect={(id) => {
                    if (pickerSlot === 'a') onPairChange(id === b.id ? { aId: id, bId: a.id } : { aId: id, bId: b.id });
                    else onPairChange(id === a.id ? { aId: b.id, bId: id } : { aId: a.id, bId: id });
                    setPickerSlot(null);
                  }}
                />
              </div>
            </div>}
          </div>

          <section className="min-h-0 overflow-hidden border-t border-[#e5e5ea] bg-white p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2"><h2 className="text-sm font-medium text-[#3c3c43]">속도별 성능 비교</h2><SourceBadge /></div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
                  <span className="flex items-center gap-1.5 font-medium text-[#1b64da]"><i className="size-2 rounded-full bg-[#3182f6]" />A 설계 · #{a.id}</span>
                  <span className="flex items-center gap-1.5 font-medium text-violet-700"><i className="size-2 rounded-full bg-[#6750a4]" />B 설계 · #{b.id}</span>
                  <span className="text-[#86868b]">
                    {aDetail && bDetail
                      ? '두 설계의 유효 trim 행만 연결합니다.'
                      : aDetail || bDetail
                        ? '패키징된 한 설계의 trim 곡선만 표시합니다.'
                        : '두 설계 모두 metadata-only라 trim 곡선이 없습니다.'}
                  </span>
                </div>
              </div>
              <div className="flex rounded-lg bg-[#f5f5f7] p-1">
                {([
                  ['power', '소비전력'],
                  ['drag', '항력'],
                  ['distance', '비행거리'],
                ] as const).map(([id, label]) => (
                    <Button key={id} size="sm" variant="ghost" onClick={() => setCurveMetric(id)} className={curveMetric === id ? 'bg-white text-[#1b64da] shadow-sm' : 'text-[#6e6e73]'}>{label}</Button>
                ))}
              </div>
            </div>
            {hasAnyTrim ? (
              <ChartContainer config={chartConfig} className="h-[210px] w-full aspect-auto" initialDimension={{ width: 960, height: 210 }}>
                <LineChart data={chartRows} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#e2e8ec" />
                  <XAxis dataKey="speed" tickLine={false} axisLine={false} tickMargin={10} unit="m/s" />
                  <YAxis tickLine={false} axisLine={false} width={52} />
                  <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                  {aDetail && <Line type="monotone" dataKey="a" name={`A 설계 · #${a.id}`} stroke="var(--color-a)" strokeWidth={2.2} dot={false} connectNulls={false} />}
                  {bDetail && <Line type="monotone" dataKey="b" name={`B 설계 · #${b.id}`} stroke="var(--color-b)" strokeWidth={2.2} dot={false} connectNulls={false} />}
                </LineChart>
              </ChartContainer>
            ) : (
              <div className="grid h-[210px] place-items-center rounded-xl border border-dashed border-[#e5e5ea] bg-[#f5f5f7] text-sm text-[#6e6e73]">
                대표 12개 설계를 선택하면 속도별 곡선을 비교할 수 있습니다.
              </div>
            )}
          </section>
        </div>

        <aside className="min-h-0 overflow-y-auto bg-white p-4">
          <div className="mb-4 flex items-center justify-between">
            <div><h2 className="font-semibold text-[#1d1d1f]">A → B 변경 분석</h2><p className="mt-1 text-xs text-[#6e6e73]">구성 차이와 성능 결과를 순서대로 확인하세요.</p></div>
            <Badge variant="outline" className="border-[#e5e5ea] bg-[#f5f5f7] text-[#6e6e73]">#{a.id} → #{b.id}</Badge>
          </div>

          <section className="rounded-xl bg-[#f5f5f7] p-3.5">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[#3c3c43]"><span className="grid size-5 place-items-center rounded-full bg-[#3182f6] text-[10px] text-white">1</span> 무엇이 바뀌나요?</div>
            <div className="divide-y divide-[#e5e5ea]">
              <ParameterDiffRow label="허브 구조" a={formatHub(a.hub)} b={formatHub(b.hub)} />
              <ParameterDiffRow label="프로펠러 수" a={`${a.numPropellers}개`} b={`${b.numPropellers}개`} />
              <ParameterDiffRow label="날개 수" a={`${a.numWings}개`} b={`${b.numWings}개`} />
              <ParameterDiffRow label="대표 Arm 길이" a={a.armLength ? `${formatMetric(a.armLength, 1)} mm` : '—'} b={b.armLength ? `${formatMetric(b.armLength, 1)} mm` : '—'} />
            </div>
          </section>

          <div className="mb-3 mt-5 flex items-center gap-2 text-xs font-semibold text-[#3c3c43]"><span className="grid size-5 place-items-center rounded-full bg-[#3182f6] text-[10px] text-white">2</span> 성능은 어떻게 달라졌나요?</div>
          <div className="grid grid-cols-[minmax(112px,1.2fr)_1fr_1fr_68px] gap-2 border-b border-[#e5e5ea] pb-3 text-[10px] font-medium text-[#6e6e73]">
            <span>성능 지표</span><span className="text-right text-[#1b64da]">A</span><span className="text-right text-violet-700">B</span><span className="text-right">변화</span>
          </div>
          <div className="divide-y divide-[#e5e5ea]">
            <CompareRow icon={<Route />} label="최대 비행거리" a={a.maxDistance / 1000} b={b.maxDistance / 1000} unit="km" better="up" />
            <CompareRow icon={<CircleGauge />} label="체공 시간" a={a.hoverTime} b={b.hoverTime} unit="sec" better="up" digits={0} />
            <CompareRow icon={<Gauge />} label="최고 속도" a={a.maxSpeed} b={b.maxSpeed} unit="m/s" better="up" />
            <CompareRow icon={<Zap />} label="소비전력 (MFD)" a={a.power} b={b.power} unit="W" better="down" digits={0} />
            <CompareRow icon={<Wind />} label="항력 (20m/s)" a={a.dragAt20} b={b.dragAt20} unit="N" better="down" />
            <CompareRow icon={<Weight />} label="질량" a={a.mass} b={b.mass} unit="kg" better="down" digits={2} />
            <CompareRow icon={<BatteryCharging />} label="프로펠러" a={a.numPropellers} b={b.numPropellers} unit="개" better="neutral" digits={0} />
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
    </div>
  );
}

function CompareDesignSlot({ label, tone, design, expanded, onClick }: { label: string; tone: 'cyan' | 'violet'; design: DesignSummary; expanded: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`flex items-center gap-3 rounded-xl border px-3 py-2 text-left transition hover:shadow-sm ${tone === 'cyan' ? 'border-[#bfdbfe] bg-[#eff6ff]' : 'border-violet-200 bg-violet-50'}`}>
      <span className={`grid size-8 shrink-0 place-items-center rounded-lg bg-white text-xs font-bold shadow-sm ${tone === 'cyan' ? 'text-[#1b64da]' : 'text-violet-700'}`}>{label.slice(0, 1)}</span>
      <span className="min-w-0 flex-1">
        <span className={`block text-[10px] font-semibold ${tone === 'cyan' ? 'text-[#1b64da]' : 'text-violet-700'}`}>{label}</span>
        <span className="block truncate text-xs font-semibold text-[#1d1d1f]">Design #{design.id} · {design.numPropellers}P/{design.numWings}W</span>
      </span>
      <span className="shrink-0 text-[10px] font-medium text-[#6e6e73]">{expanded ? '접기' : '변경'}</span>
    </button>
  );
}

function CompareModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} aria-pressed={active} className={`rounded-md px-2.5 py-1.5 text-[10px] font-semibold transition ${active ? 'bg-white text-[#1b64da] shadow-sm' : 'text-[#6e6e73] hover:text-[#1d1d1f]'}`}>{children}</button>;
}

function CompareParametricPane({
  preview,
  label,
  tone,
  cameraGroup,
  cameraId,
  cameraLinked,
  paused,
}: {
  preview: ReturnType<typeof useDesignPreview>;
  label: string;
  tone: 'cyan' | 'violet';
  cameraGroup: string;
  cameraId: 'a' | 'b';
  cameraLinked: boolean;
  paused: boolean;
}) {
  return (
    <div className="relative min-h-0 overflow-hidden bg-[#eef3f6]">
      {preview ? <ParametricUavViewer draft={preview.draft} assembly={preview.assembly} paused={paused} maxFps={30} cameraFitPadding={1.62} cameraSync={{ group: cameraGroup, id: cameraId, linked: cameraLinked }} /> : <div className="absolute inset-0 grid place-items-center text-xs font-semibold text-[#6e6e73]">파라메트릭 형상 준비 중…</div>}
      <span className={`pointer-events-none absolute left-3 top-3 z-20 rounded-lg border border-white/70 bg-white/90 px-2.5 py-1.5 text-[10px] font-semibold shadow-sm backdrop-blur ${tone === 'cyan' ? 'text-[#1b64da]' : 'text-violet-700'}`}>{label}</span>
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
    ? 'text-[#6e6e73]'
    : bBetter ? 'text-emerald-700' : 'text-amber-700';
  const value = (metric: number, available: boolean) => available
    ? <>{formatMetric(metric, digits)} <small className="text-[9px] text-[#6e6e73]">{unit}</small></>
    : <>—</>;

  return (
    <div className="grid grid-cols-[minmax(112px,1.2fr)_1fr_1fr_68px] items-center gap-2 py-3.5 text-xs">
      <div className="flex items-center gap-2 text-[#6e6e73]"><span className="[&>svg]:size-3.5">{icon}</span><span>{label}</span></div>
      <span className={`text-right font-mono ${aBetter ? 'font-semibold text-[#1b64da]' : 'text-[#6e6e73]'}`}>{value(a, aAvailable)}</span>
      <span className={`text-right font-mono ${bBetter ? 'font-semibold text-violet-700' : 'text-[#6e6e73]'}`}>{value(b, bAvailable)}</span>
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
      <span className="text-[#6e6e73]">{label}</span>
      <span className="truncate text-right font-mono text-[#6e6e73]" title={a}>{a}</span>
      <span className="text-center text-[#86868b]">→</span>
      <span className={`truncate text-right font-mono ${changed ? 'font-semibold text-violet-700' : 'text-[#6e6e73]'}`} title={b}>{b}</span>
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
