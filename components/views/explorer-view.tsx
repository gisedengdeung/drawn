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
  onSelect,
  onOpenLab,
  onOpenSimulator,
  onOpenCompare,
  onOpenOptimizer,
}: {
  dataset: DatasetIndex;
  showcases: ShowcaseMap;
  selected: DesignSummary | null;
  onSelect: (id: number) => void;
  onOpenLab: (id: number) => void;
  onOpenSimulator: (id: number) => void;
  onOpenCompare: (id: number) => void;
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
        if (viewerOnly && !showcases[String(design.id)]) return false;
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
      .sort((a, b) => {
        if (normalizedQuery) {
          const aExact = String(a.id) === normalizedQuery;
          const bExact = String(b.id) === normalizedQuery;
          if (aExact !== bExact) return aExact ? -1 : 1;
        }
        return b.maxDistance - a.maxDistance || a.id - b.id;
      });
  }, [dataset.designs, feasibleOnly, massMax, propellers, query, showcases, viewerOnly, wingMode]);

  const visibleResults = filtered.slice(0, 60);
  const current = selected ?? visibleResults[0] ?? dataset.designs[0];
  const currentDetail = showcases[String(current.id)] ?? null;

  return (
    <section className="px-4 py-4 lg:px-6">
      <SectionHeading
        eyebrow="1단계 · 기준 설계 선택"
        title="설계 탐색"
        description="27,714개 전체 설계는 파라메트릭 개념 형상으로 편집하고, 대표 12개는 원본 STL까지 함께 확인할 수 있습니다."
        actions={
          <Button onClick={onOpenOptimizer} className="bg-[#147d91] text-white hover:bg-[#0f6878]">
            <Sparkles /> 조건으로 후보 찾기 <ArrowUpRight />
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)] 2xl:grid-cols-[290px_minmax(500px,1fr)_300px]">
        <aside className="workspace-panel overflow-hidden rounded-xl">
          <div className="border-b border-[#dbe4ea] p-3.5">
            <div className="mb-3 grid grid-cols-2 rounded-lg bg-[#eef2f5] p-1 text-[11px] font-medium">
              <button
                onClick={() => setViewerOnly(true)}
                className={`rounded-md px-2 py-2 transition ${viewerOnly ? 'bg-white text-[#0f6475] shadow-sm' : 'text-[#607383]'}`}
              >
                원본 STL · 12
              </button>
              <button
                onClick={() => setViewerOnly(false)}
                className={`rounded-md px-2 py-2 transition ${!viewerOnly ? 'bg-white text-[#0f6475] shadow-sm' : 'text-[#607383]'}`}
              >
                프리뷰 · 27,714
              </button>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#718391]" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="설계 ID 또는 topology 검색"
                className="h-10 border-[#ccd8df] bg-white pl-9 text-[#172b3a]"
              />
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <Select value={propellers} onValueChange={(value) => setPropellers(String(value))}>
                <SelectTrigger className="w-full border-[#ccd8df] bg-white text-xs text-[#304958]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-[#ccd8df] bg-white text-[#304958]">
                  <SelectItem value="all">전체 Prop 수</SelectItem>
                  {[2, 4, 6, 8, 12, 16].map((count) => (
                    <SelectItem key={count} value={String(count)}>{count} Propellers</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={wingMode} onValueChange={(value) => setWingMode(String(value))}>
                <SelectTrigger className="w-full border-[#ccd8df] bg-white text-xs text-[#304958]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-[#ccd8df] bg-white text-[#304958]">
                  <SelectItem value="all">전체 Wing</SelectItem>
                  <SelectItem value="wingless">Wingless</SelectItem>
                  <SelectItem value="winged">Winged</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="mt-4">
              <div className="mb-2 flex justify-between text-xs text-[#607383]">
                <span>최대 질량</span><span className="font-mono font-medium text-[#294353]">≤ {massMax} kg</span>
              </div>
              <Slider
                value={[massMax]}
                min={2}
                max={30}
                step={1}
                onValueChange={(value) => setMassMax(Number(Array.isArray(value) ? value[0] : value))}
                className="[&_[data-slot=slider-range]]:bg-[#147d91]"
                aria-label="최대 질량"
              />
            </div>

            <div className="mt-4 rounded-lg border border-[#dbe4ea] bg-[#f7f9fb] p-3">
              <div className="flex items-center justify-between gap-3 text-xs text-[#526675]">
                유효 비행성능만
                <Switch checked={feasibleOnly} onCheckedChange={setFeasibleOnly} aria-label="유효 비행성능만" />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between border-b border-[#dbe4ea] px-3.5 py-2.5 text-xs">
            <span className="text-[#607383]">검색 결과 <small className="ml-1 text-[10px]">(최대 60개 표시)</small></span>
            <span className="font-mono font-medium text-[#294353]">{filtered.length.toLocaleString()}</span>
          </div>
          <div className="max-h-[430px] overflow-y-auto p-2">
            {visibleResults.length ? (
              visibleResults.map((design) => (
                <button
                  key={design.id}
                  onClick={() => onSelect(design.id)}
                  className={`mb-1 w-full rounded-xl border p-3 text-left transition ${
                    current.id === design.id
                      ? 'border-[#9ccdd6] bg-[#eef8fa] shadow-sm'
                      : 'border-transparent hover:border-[#dbe4ea] hover:bg-[#f7f9fb]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-mono text-xs font-semibold text-[#233b4a]">Design #{design.id}</p>
                      <p className="mt-1 truncate text-[11px] text-[#718391]">{formatHub(design.hub)}</p>
                    </div>
                    {showcases[String(design.id)] ? (
                      <Badge className="bg-[#e5f5f7] text-[9px] text-[#0f6475]">STL + 편집</Badge>
                    ) : (
                      <Badge variant="outline" className="border-[#dbe4ea] text-[9px] text-[#0f6475]">프리뷰 편집</Badge>
                    )}
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 font-mono text-[10px]">
                    <span className="font-medium text-[#0f6475]">{design.maxDistance ? `${(design.maxDistance / 1000).toFixed(1)}km` : '—'}</span>
                    <span className="text-[#607383]">{design.mass.toFixed(1)}kg</span>
                    <span className="text-[#607383]">{design.numPropellers}P/{design.numWings}W</span>
                  </div>
                </button>
              ))
            ) : (
              <div className="p-8 text-center text-xs leading-5 text-[#607383]">조건에 맞는 설계가 없습니다. 질량 조건을 완화하거나 전체 DB를 확인하세요.</div>
            )}
          </div>
        </aside>

        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#dbe4ea] bg-white px-4 py-3 shadow-sm">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-[#172b3a]">Design #{current.id}</h2>
                <SourceBadge />
                {current.feasible ? (
                  <Badge className="bg-emerald-50 text-emerald-700">비행성능 유효</Badge>
                ) : (
                  <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">성능 해석 불가</Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-[#607383]">{formatHub(current.hub)} · 프로펠러 {current.numPropellers}개 · 날개 {current.numWings}개</p>
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={() => onOpenCompare(current.id)} variant="outline" className="border-[#ccd8df] bg-white text-[#3c5362] hover:bg-[#f4f7f9]">
                <GitCompareArrows /> 비교
              </Button>
              {currentDetail && (
                <Button onClick={() => onOpenSimulator(current.id)} variant="outline" className="border-[#ccd8df] bg-white text-[#3c5362] hover:bg-[#f4f7f9]">
                  성능 확인
                </Button>
              )}
              <Button onClick={() => onOpenLab(current.id)} className="bg-[#147d91] text-white hover:bg-[#0f6878]">
                3D 편집 <ArrowUpRight />
              </Button>
            </div>
          </div>

          <ModelStage design={currentDetail} emptyDesignId={current.id} className="min-h-[430px] lg:min-h-[470px]" />
          <div className="mt-3"><DataDisclaimer compact /></div>
        </div>

        <aside className="grid gap-3 lg:col-span-2 lg:grid-cols-[minmax(220px,1.35fr)_repeat(4,minmax(140px,1fr))] 2xl:col-span-1 2xl:grid-cols-1">
          <div className="workspace-panel rounded-xl p-4">
            <div className="mb-1 flex items-center justify-between">
              <h3 className="text-sm font-medium text-[#294353]">설계 구성</h3>
              <SourceBadge />
            </div>
            {currentDetail ? (
              <ConfigurationList design={currentDetail} />
            ) : (
              <div className="divide-y divide-[#e5ebef]">
                {[
                  ['Hub', formatHub(current.hub)],
                  ['Propellers', String(current.numPropellers)],
                  ['Wings', String(current.numWings)],
                  ['Arm Length', current.armLength ? `${current.armLength.toFixed(1)} mm` : '—'],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-3 py-3 text-xs"><span className="text-[#718391]">{label}</span><span className="text-[#294353]">{value}</span></div>
                ))}
              </div>
            )}
          </div>

          <div className="contents">
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
