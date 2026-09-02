'use client';

import { useMemo, useState } from 'react';
import {
  ArrowUpRight,
  CircleGauge,
  Gauge,
  GitCompareArrows,
  Route,
  Search,
  Sparkles,
  Weight,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import type {
  DatasetIndex,
  DesignSummary,
  ShowcaseDesign,
  ShowcaseMap,
} from '@/lib/aerotwin-types';
import { formatDistance, formatHub, formatMetric } from '@/lib/aerotwin-types';
import {
  ConfigurationList,
  DataDisclaimer,
  MetricTile,
  ModelStage,
  SectionHeading,
  SourceBadge,
} from '@/components/views/shared';

export function ExplorerView({
  dataset,
  showcases,
  selected,
  detail,
  onSelect,
  onOpenSimulator,
  onOpenOptimizer,
}: {
  dataset: DatasetIndex;
  showcases: ShowcaseMap;
  selected: DesignSummary | null;
  detail: ShowcaseDesign | null;
  onSelect: (id: number) => void;
  onOpenSimulator: (id: number) => void;
  onOpenOptimizer: () => void;
}) {
  const [query, setQuery] = useState('');
  const [propellers, setPropellers] = useState('all');
  const [wingMode, setWingMode] = useState('all');
  const [massMax, setMassMax] = useState(15);
  const [feasibleOnly, setFeasibleOnly] = useState(true);
  const [viewerOnly, setViewerOnly] = useState(true);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().replace(/^#/, '').toLowerCase();
    return dataset.designs
      .filter((design) => {
        if (viewerOnly && !design.viewerReady) return false;
        if (feasibleOnly && !design.feasible) return false;
        if (design.mass > massMax) return false;
        if (propellers !== 'all' && design.numPropellers !== Number(propellers)) return false;
        if (wingMode === 'winged' && design.numWings === 0) return false;
        if (wingMode === 'wingless' && design.numWings > 0) return false;
        if (
          normalizedQuery &&
          !String(design.id).includes(normalizedQuery) &&
          !design.hub.toLowerCase().includes(normalizedQuery)
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => b.maxDistance - a.maxDistance);
  }, [dataset.designs, feasibleOnly, massMax, propellers, query, viewerOnly, wingMode]);

  const visibleResults = filtered.slice(0, 60);
  const current = selected ?? visibleResults[0] ?? dataset.designs[0];
  const currentDetail = showcases[String(current.id)] ?? detail;

  return (
    <section className="px-4 py-5 lg:px-6">
      <SectionHeading
        eyebrow="AircraftVerse / Local index"
        title="Design Explorer"
        description="9,238개 로컬 설계의 구조·질량·비행성능을 검색하고 시연용 STL을 직접 확인합니다."
        actions={
          <Button onClick={onOpenOptimizer} className="bg-cyan-300 text-[#041019] hover:bg-cyan-200">
            <Sparkles /> AI 최적화 시작 <ArrowUpRight />
          </Button>
        }
      />

      <div className="grid gap-4 2xl:grid-cols-[310px_minmax(520px,1fr)_320px]">
        <aside className="overflow-hidden rounded-2xl border border-white/9 bg-[#0a1622]">
          <div className="border-b border-white/8 p-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-600" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Design ID 또는 topology"
                className="h-10 border-white/10 bg-white/[0.025] pl-9 text-slate-200"
              />
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <Select value={propellers} onValueChange={(value) => setPropellers(String(value))}>
                <SelectTrigger className="w-full border-white/10 bg-white/[0.025] text-xs text-slate-300">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/10 bg-[#0b1723] text-slate-200">
                  <SelectItem value="all">전체 Prop 수</SelectItem>
                  {[2, 4, 6, 8, 12, 16].map((count) => (
                    <SelectItem key={count} value={String(count)}>{count} Propellers</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={wingMode} onValueChange={(value) => setWingMode(String(value))}>
                <SelectTrigger className="w-full border-white/10 bg-white/[0.025] text-xs text-slate-300">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/10 bg-[#0b1723] text-slate-200">
                  <SelectItem value="all">전체 Wing</SelectItem>
                  <SelectItem value="wingless">Wingless</SelectItem>
                  <SelectItem value="winged">Winged</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="mt-4">
              <div className="mb-2 flex justify-between text-[11px] text-slate-500">
                <span>Mass limit</span><span className="font-mono text-slate-300">≤ {massMax} kg</span>
              </div>
              <Slider
                value={[massMax]}
                min={2}
                max={30}
                step={1}
                onValueChange={(value) => setMassMax(Number(Array.isArray(value) ? value[0] : value))}
                className="[&_[data-slot=slider-range]]:bg-cyan-300"
                aria-label="최대 질량"
              />
            </div>

            <div className="mt-4 space-y-2 rounded-xl border border-white/7 bg-white/[0.02] p-3">
              <div className="flex items-center justify-between gap-3 text-xs text-slate-400">
                유효 비행성능만
                <Switch checked={feasibleOnly} onCheckedChange={setFeasibleOnly} aria-label="유효 비행성능만" />
              </div>
              <div className="flex items-center justify-between gap-3 text-xs text-slate-400">
                3D 시연 설계만
                <Switch checked={viewerOnly} onCheckedChange={setViewerOnly} aria-label="3D 시연 설계만" />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between border-b border-white/8 px-4 py-3 text-xs">
            <span className="text-slate-500">검색 결과</span>
            <span className="font-mono text-slate-300">{filtered.length.toLocaleString()}</span>
          </div>
          <div className="max-h-[520px] overflow-y-auto p-2">
            {visibleResults.length ? (
              visibleResults.map((design) => (
                <button
                  key={design.id}
                  onClick={() => onSelect(design.id)}
                  className={`mb-1 w-full rounded-xl border p-3 text-left transition ${
                    current.id === design.id
                      ? 'border-cyan-300/20 bg-cyan-300/8'
                      : 'border-transparent hover:border-white/7 hover:bg-white/[0.025]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-mono text-xs font-semibold text-slate-200">Design #{design.id}</p>
                      <p className="mt-1 truncate text-[10px] text-slate-600">{formatHub(design.hub)}</p>
                    </div>
                    {design.viewerReady ? (
                      <Badge className="bg-cyan-300/10 text-[9px] text-cyan-200">3D</Badge>
                    ) : (
                      <Badge variant="outline" className="border-white/8 text-[9px] text-slate-600">META</Badge>
                    )}
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 font-mono text-[10px]">
                    <span className="text-cyan-200">{design.maxDistance ? `${(design.maxDistance / 1000).toFixed(1)}km` : '—'}</span>
                    <span className="text-slate-500">{design.mass.toFixed(1)}kg</span>
                    <span className="text-slate-500">{design.numPropellers}P/{design.numWings}W</span>
                  </div>
                </button>
              ))
            ) : (
              <div className="p-8 text-center text-xs leading-5 text-slate-600">조건에 맞는 설계가 없습니다. 질량 또는 3D 필터를 완화해 보세요.</div>
            )}
          </div>
        </aside>

        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-white">Design #{current.id}</h2>
                <SourceBadge />
                {current.feasible ? (
                  <Badge className="bg-emerald-400/12 text-emerald-300">Flight feasible</Badge>
                ) : (
                  <Badge variant="outline" className="border-amber-300/20 text-amber-200">No valid performance</Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-500">{formatHub(current.hub)} · {current.numPropellers} propellers · {current.numWings} wings</p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" className="border-white/10 bg-white/[0.025] text-slate-300">
                <GitCompareArrows /> 비교에 추가
              </Button>
              <Button
                disabled={!currentDetail}
                onClick={() => onOpenSimulator(current.id)}
                className="bg-cyan-300 text-[#041019] hover:bg-cyan-200"
              >
                Simulator 열기 <ArrowUpRight />
              </Button>
            </div>
          </div>

          <ModelStage design={currentDetail} className="min-h-[530px]" />
          <div className="mt-3"><DataDisclaimer compact /></div>
        </div>

        <aside className="space-y-3">
          <div className="rounded-2xl border border-white/9 bg-[#0a1622] p-4">
            <div className="mb-1 flex items-center justify-between">
              <h3 className="text-sm font-medium text-slate-200">Aircraft Configuration</h3>
              <SourceBadge />
            </div>
            {currentDetail ? (
              <ConfigurationList design={currentDetail} />
            ) : (
              <div className="divide-y divide-white/7">
                {[
                  ['Hub', formatHub(current.hub)],
                  ['Propellers', String(current.numPropellers)],
                  ['Wings', String(current.numWings)],
                  ['Arm Length', current.armLength ? `${current.armLength.toFixed(1)} mm` : '—'],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-3 py-3 text-xs"><span className="text-slate-600">{label}</span><span className="text-slate-300">{value}</span></div>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 2xl:grid-cols-1">
            <MetricTile icon={<Route className="size-4" />} label="Maximum Distance" value={current.maxDistance ? formatMetric(current.maxDistance / 1000, 2) : '—'} unit={current.maxDistance ? 'km' : undefined} note={current.speedMfd ? `at ${current.speedMfd} m/s` : '성능 데이터 없음'} tone="cyan" />
            <MetricTile icon={<CircleGauge className="size-4" />} label="Hover Time" value={current.hoverTime ? formatMetric(current.hoverTime, 0) : '—'} unit={current.hoverTime ? 'sec' : undefined} note={current.hoverTime ? `${formatMetric(current.hoverTime / 60, 1)} minutes` : '성능 데이터 없음'} tone="violet" />
            <MetricTile icon={<Gauge className="size-4" />} label="Max Speed" value={current.maxSpeed ? formatMetric(current.maxSpeed, 1) : '—'} unit={current.maxSpeed ? 'm/s' : undefined} tone="green" />
            <MetricTile icon={<Weight className="size-4" />} label="Mass" value={formatMetric(current.mass, 2)} unit="kg" note={`Local rank · ${formatDistance(current.maxDistance)}`} />
          </div>
        </aside>
      </div>
    </section>
  );
}
