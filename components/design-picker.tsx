'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CircleGauge,
  Crosshair,
  Gauge,
  History,
  PackageCheck,
  Radar,
  Route,
  ShieldCheck,
  Sparkles,
  Star,
  Trophy,
  Weight,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import type { DesignSummary, ShowcaseDesign, ShowcaseMap } from '@/lib/drawn-types';
import { classifyAirframe, formatDistance, formatHub, formatMetric } from '@/lib/drawn-types';
import {
  DIRECTION_GROUPS,
  EMPTY_SHAPE_FILTERS,
  WING_PRESENCES,
  describeShape,
  matchesShape,
  shapeFacetCounts,
  shapeFilterCount,
  type ShapeFilters,
} from '@/lib/design-shape';
import { ShapeIcon, WingIcon } from '@/components/shape-icon';
import { useShapeClasses } from '@/hooks/use-shape-classes';
import {
  CANDIDATE_OBJECTIVES,
  CANDIDATE_PRESETS,
  buildCandidatePool,
  rankCandidates,
  type Objective,
  type ScoredDesign,
} from '@/lib/candidate-search';
import { ConfigurationList, MetricTile, SourceBadge } from '@/components/views/shared';

/** 한 번에 보여줄 결과 수. 바닥에 닿으면 이만큼씩 더 붙인다. */
const PAGE = 40;
/** 슬라이더 눈금 끝. 최대 질량이 240,029kg인 이상치가 있어 여기부터는 "제한 없음"이다. */
const MASS_ANY = 31;
const FAVORITES_STORAGE_KEY = 'drawn:favorite-designs';
const RECENT_STORAGE_KEY = 'drawn:recent-designs';
const RECENT_LIMIT = 8;

const PRESET_ICONS: Record<string, typeof PackageCheck> = {
  Delivery: PackageCheck,
  Surveillance: Radar,
  Racing: Crosshair,
  'Heavy Payload': ShieldCheck,
};

type Section = 'filter' | 'recommend' | 'favorites' | 'results' | 'summary';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'filter', label: '필터' },
  { id: 'recommend', label: '추천' },
  { id: 'favorites', label: '즐겨찾기' },
  { id: 'results', label: '목록' },
  { id: 'summary', label: '요약' },
];

function readStoredIds(key: string): number[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === 'number') : [];
  } catch {
    return [];
  }
}

function writeStoredIds(key: string, ids: number[]) {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // Storage unavailable (private mode, quota) — state stays in-memory only.
  }
}

function toggleValue<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/**
 * 설계 27,714개 중에서 기준 설계를 고르는 패널.
 *
 * 탐색 화면(explorer-view)의 기능을 통째로 옮기되, 좁고 긴 아일랜드에 맞춰
 * "섹션"으로 쪼갰다 — 한 번에 하나씩만 보여주고, 섹션마다 자기 콘텐츠 높이만큼만
 * 차지한다(짧으면 패널도 작아지고, 길면 이 패널의 최대 높이에서 스크롤된다).
 */
export function DesignPicker({
  designs,
  showcases,
  selectedId,
  onSelect,
}: {
  designs: DesignSummary[];
  showcases: ShowcaseMap;
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const { classes } = useShapeClasses();
  const [section, setSection] = useState<Section>('filter');
  const [shape, setShape] = useState<ShapeFilters>(EMPTY_SHAPE_FILTERS);
  const [massMax, setMassMax] = useState(MASS_ANY);
  const [feasibleOnly, setFeasibleOnly] = useState(false);
  const [viewerOnly, setViewerOnly] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE);
  const [favorites, setFavorites] = useState<number[]>([]);
  const [recent, setRecent] = useState<number[]>([]);

  const [preset, setPreset] = useState('Delivery');
  const [objective, setObjective] = useState<Objective>('range');
  const [candidateMassLimit, setCandidateMassLimit] = useState(10);
  const [candidatePowerLimit, setCandidatePowerLimit] = useState(2500);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ScoredDesign[]>([]);
  const runTimeoutRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (runTimeoutRef.current != null) window.clearTimeout(runTimeoutRef.current);
  }, []);

  useEffect(() => {
    window.queueMicrotask(() => {
      setFavorites(readStoredIds(FAVORITES_STORAGE_KEY));
      setRecent(readStoredIds(RECENT_STORAGE_KEY));
    });
  }, []);

  useEffect(() => {
    if (selectedId == null) return;
    window.queueMicrotask(() => {
      setRecent((previous) => {
        const next = [selectedId, ...previous.filter((id) => id !== selectedId)].slice(0, RECENT_LIMIT);
        writeStoredIds(RECENT_STORAGE_KEY, next);
        return next;
      });
    });
  }, [selectedId]);

  const toggleFavorite = (id: number) => {
    setFavorites((previous) => {
      const next = previous.includes(id) ? previous.filter((item) => item !== id) : [id, ...previous];
      writeStoredIds(FAVORITES_STORAGE_KEY, next);
      return next;
    });
  };

  // 생김새가 아닌 조건을 먼저 적용한다. 각 칸의 개수 표시는 이 결과를 모집단으로
  // 삼아야 실제로 눌렀을 때와 맞는다.
  const pool = useMemo(
    () =>
      designs.filter((design) => {
        if (viewerOnly && !showcases[String(design.id)]) return false;
        if (feasibleOnly && !design.feasible) return false;
        if (massMax < MASS_ANY && design.mass > massMax) return false;
        return true;
      }),
    [designs, feasibleOnly, massMax, showcases, viewerOnly],
  );

  const facets = useMemo(() => shapeFacetCounts(pool, classes, shape), [classes, pool, shape]);

  const filtered = useMemo(
    () =>
      pool
        .filter((design) => matchesShape(design, classes[String(design.id)], shape))
        .sort((a, b) => b.maxDistance - a.maxDistance || a.id - b.id),
    [classes, pool, shape],
  );

  // 조건이 바뀌면 처음부터 다시 센다.
  const filterKey = `${viewerOnly}|${feasibleOnly}|${massMax}|${JSON.stringify(shape)}`;
  const [lastKey, setLastKey] = useState(filterKey);
  if (lastKey !== filterKey) {
    setLastKey(filterKey);
    setVisibleCount(PAGE);
  }

  const selectedSummary = useMemo(
    () => (selectedId == null ? null : (designs.find((design) => design.id === selectedId) ?? null)),
    [designs, selectedId],
  );
  const selectedDetail = selectedId == null ? null : (showcases[String(selectedId)] ?? null);

  const candidatePool = selectedId == null ? [] : buildCandidatePool(designs, selectedId, candidateMassLimit, candidatePowerLimit, objective);

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
    const found = CANDIDATE_PRESETS.find((item) => item.name === name);
    if (!found) return;
    setObjective(found.objective);
    setCandidateMassLimit(found.massLimit);
    setCandidatePowerLimit(found.powerLimit);
  };

  const runCandidateSearch = () => {
    if (selectedId == null) return;
    if (runTimeoutRef.current != null) window.clearTimeout(runTimeoutRef.current);
    const pool = candidatePool;
    const requestedObjective = objective;
    setRunning(true);
    setResults([]);
    runTimeoutRef.current = window.setTimeout(() => {
      const scored = rankCandidates(pool, requestedObjective, 3);
      setResults(scored);
      setRunning(false);
      runTimeoutRef.current = null;
      if (scored[0]) onSelect(scored[0].id);
    }, 0);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-0.5 border-b border-[#e5e5ea] p-2">
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setSection(item.id)}
            aria-pressed={section === item.id}
            className={`flex-1 rounded-lg px-1.5 py-1.5 text-[10px] font-medium transition ${
              section === item.id ? 'bg-[#eff6ff] text-[#1b64da]' : 'text-[#6e6e73] hover:bg-[#f5f5f7]'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {section === 'filter' && (
          <FilterSection
            shape={shape}
            onShapeChange={setShape}
            facets={facets}
            massMax={massMax}
            onMassMaxChange={setMassMax}
            viewerOnly={viewerOnly}
            onViewerOnlyChange={setViewerOnly}
            feasibleOnly={feasibleOnly}
            onFeasibleOnlyChange={setFeasibleOnly}
            resultCount={filtered.length}
          />
        )}
        {section === 'recommend' && (
          <RecommendSection
            preset={preset}
            objective={objective}
            candidateMassLimit={candidateMassLimit}
            onCandidateMassLimitChange={(value) => { cancelPendingRun(); setCandidateMassLimit(value); }}
            candidatePowerLimit={candidatePowerLimit}
            onCandidatePowerLimitChange={(value) => { cancelPendingRun(); setCandidatePowerLimit(value); }}
            candidatePoolSize={candidatePool.length}
            running={running}
            results={results}
            onApplyPreset={applyPreset}
            onSelectObjective={(id) => { cancelPendingRun(); setObjective(id); }}
            onRun={runCandidateSearch}
            onSelect={onSelect}
            selectedId={selectedId}
          />
        )}
        {section === 'favorites' && (
          <FavoritesSection
            favorites={favorites}
            recent={recent}
            designs={designs}
            selectedId={selectedId}
            onSelect={onSelect}
            onToggleFavorite={toggleFavorite}
          />
        )}
        {section === 'results' && (
          <ResultsSection
            filtered={filtered}
            visibleCount={visibleCount}
            onLoadMore={() => setVisibleCount((count) => Math.min(count + PAGE, filtered.length))}
            total={designs.length}
            selectedId={selectedId}
            onSelect={onSelect}
            favorites={favorites}
            onToggleFavorite={toggleFavorite}
          />
        )}
        {section === 'summary' && <SummarySection summary={selectedSummary} detail={selectedDetail} />}
      </div>
    </div>
  );
}

function FilterSection({
  shape,
  onShapeChange,
  facets,
  massMax,
  onMassMaxChange,
  viewerOnly,
  onViewerOnlyChange,
  feasibleOnly,
  onFeasibleOnlyChange,
  resultCount,
}: {
  shape: ShapeFilters;
  onShapeChange: (updater: (previous: ShapeFilters) => ShapeFilters) => void;
  facets: ReturnType<typeof shapeFacetCounts>;
  massMax: number;
  onMassMaxChange: (value: number) => void;
  viewerOnly: boolean;
  onViewerOnlyChange: (value: boolean) => void;
  feasibleOnly: boolean;
  onFeasibleOnlyChange: (value: boolean) => void;
  resultCount: number;
}) {
  return (
    <div className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] font-semibold text-[#3c3c43]">생김새로 고르기</p>
        {shapeFilterCount(shape) > 0 && (
          <button
            onClick={() => onShapeChange(() => EMPTY_SHAPE_FILTERS)}
            className="rounded-full px-2 py-0.5 text-[10px] font-medium text-[#1b64da] hover:bg-[#eff6ff]"
          >
            조건 지우기
          </button>
        )}
      </div>
      {shapeFilterCount(shape) > 0 && (
        <p className="mb-2 rounded-lg bg-[#eff6ff] px-2.5 py-1.5 text-[11px] font-medium text-[#1b64da]">
          {describeShape(shape)}
        </p>
      )}

      <p className="mb-1.5 text-[10px] font-medium text-[#6e6e73]">프로펠러가 이루는 도형</p>
      <div className="mb-3 grid grid-cols-4 gap-1.5">
        {DIRECTION_GROUPS.map((item) => {
          const count = facets.directions[item.value] ?? 0;
          const active = shape.directions.includes(item.value);
          return (
            <button
              key={item.value}
              onClick={() => onShapeChange((previous) => ({ ...previous, directions: toggleValue(previous.directions, item.value) }))}
              aria-pressed={active}
              disabled={count === 0 && !active}
              className={`flex flex-col items-center gap-0.5 rounded-lg border px-1 py-1.5 transition disabled:opacity-30 ${
                active
                  ? 'border-[#93c5fd] bg-[#eff6ff] text-[#1b64da]'
                  : 'border-[#e5e5ea] bg-white text-[#6e6e73] hover:bg-[#f5f5f7]'
              }`}
            >
              <ShapeIcon directions={item.icon} size={24} />
              <span className="text-[10px] font-medium leading-tight">{item.label}</span>
              <span className="font-mono text-[9px] opacity-70">{count.toLocaleString()}</span>
            </button>
          );
        })}
      </div>

      <p className="mb-1.5 text-[10px] font-medium text-[#6e6e73]">날개</p>
      <div className="grid grid-cols-2 gap-1.5">
        {WING_PRESENCES.map((item) => {
          const count = facets.wings[item.value] ?? 0;
          const active = shape.wings.includes(item.value);
          return (
            <button
              key={item.value}
              onClick={() => onShapeChange((previous) => ({ ...previous, wings: toggleValue(previous.wings, item.value) }))}
              aria-pressed={active}
              disabled={count === 0 && !active}
              className={`flex flex-col items-center gap-0.5 rounded-lg border px-1 py-1.5 transition disabled:opacity-30 ${
                active
                  ? 'border-[#93c5fd] bg-[#eff6ff] text-[#1b64da]'
                  : 'border-[#e5e5ea] bg-white text-[#6e6e73] hover:bg-[#f5f5f7]'
              }`}
            >
              <WingIcon present={item.value === 'wings'} size={24} />
              <span className="text-[10px] font-medium leading-tight">{item.label}</span>
              <span className="font-mono text-[9px] opacity-70">{count.toLocaleString()}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-3">
        <div className="mb-1.5 flex justify-between text-[10px] text-[#6e6e73]">
          <span>최대 질량</span>
          <span className="font-mono font-medium text-[#3c3c43]">
            {massMax >= MASS_ANY ? '제한 없음' : `≤ ${massMax} kg`}
          </span>
        </div>
        <Slider
          value={[massMax]}
          min={2}
          max={MASS_ANY}
          step={1}
          onValueChange={(value) => onMassMaxChange(Number(Array.isArray(value) ? value[0] : value))}
          className="[&_[data-slot=slider-range]]:bg-[#3182f6]"
          aria-label="최대 질량"
        />
      </div>

      <div className="mt-3 space-y-1.5 rounded-lg bg-[#f5f5f7] p-2.5">
        <div className="flex items-center justify-between gap-2 text-[10px] text-[#6e6e73]">
          원본 STL 있는 설계만
          <Switch checked={viewerOnly} onCheckedChange={onViewerOnlyChange} size="sm" aria-label="원본 STL 있는 설계만" />
        </div>
        <div className="flex items-center justify-between gap-2 text-[10px] text-[#6e6e73]">
          비행 해석된 설계만
          <Switch checked={feasibleOnly} onCheckedChange={onFeasibleOnlyChange} size="sm" aria-label="비행 해석된 설계만" />
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between rounded-lg bg-[#f5f5f7] px-3 py-2 text-[11px] text-[#6e6e73]">
        조건에 맞는 설계 <span className="font-mono font-semibold text-[#1b64da]">{resultCount.toLocaleString()}</span>개 · &ldquo;목록&rdquo; 탭에서 확인
      </div>
    </div>
  );
}

function RecommendSection({
  preset,
  objective,
  candidateMassLimit,
  onCandidateMassLimitChange,
  candidatePowerLimit,
  onCandidatePowerLimitChange,
  candidatePoolSize,
  running,
  results,
  onApplyPreset,
  onSelectObjective,
  onRun,
  onSelect,
  selectedId,
}: {
  preset: string;
  objective: Objective;
  candidateMassLimit: number;
  onCandidateMassLimitChange: (value: number) => void;
  candidatePowerLimit: number;
  onCandidatePowerLimitChange: (value: number) => void;
  candidatePoolSize: number;
  running: boolean;
  results: ScoredDesign[];
  onApplyPreset: (name: string) => void;
  onSelectObjective: (id: Objective) => void;
  onRun: () => void;
  onSelect: (id: number) => void;
  selectedId: number | null;
}) {
  return (
    <div className="p-3">
      <div className="mb-1 flex items-center gap-2">
        <SourceBadge source="DATASET RANKING" />
        <Badge variant="outline" className="border-[#d8cfee] bg-violet-50 text-[10px] text-violet-700">학습 AI 아닌 데이터셋 랭킹</Badge>
      </div>
      <p className="mb-2 mt-3 text-[11px] font-semibold text-[#3c3c43]">임무 Preset</p>
      <div className="grid grid-cols-2 gap-1.5">
        {CANDIDATE_PRESETS.map(({ name }) => {
          const Icon = PRESET_ICONS[name];
          return (
            <button key={name} onClick={() => onApplyPreset(name)} className={`rounded-lg border p-2 text-left transition ${preset === name ? 'border-[#93c5fd] bg-[#eff6ff] text-[#1b64da]' : 'border-[#e5e5ea] bg-white text-[#6e6e73] hover:bg-[#f5f5f7]'}`}>
              <Icon className="mb-1 size-3.5" />
              <span className="text-[10px] font-medium">{name}</span>
            </button>
          );
        })}
      </div>

      <p className="mb-2 mt-3 text-[11px] font-semibold text-[#3c3c43]">탐색 목표</p>
      <div className="grid grid-cols-2 gap-1.5">
        {CANDIDATE_OBJECTIVES.map((item) => (
          <button key={item.id} onClick={() => onSelectObjective(item.id)} className={`rounded-lg border p-2 text-left transition ${objective === item.id ? 'border-violet-300 bg-violet-50' : 'border-[#e5e5ea] bg-white hover:bg-[#f5f5f7]'}`}>
            <p className={`text-[10px] font-medium ${objective === item.id ? 'text-violet-900' : 'text-[#6e6e73]'}`}>{item.label}</p>
            <p className="mt-0.5 text-[9px] text-[#6e6e73]">{item.detail}</p>
          </button>
        ))}
      </div>

      <p className="mb-2 mt-3 text-[10px] font-medium text-[#3c3c43]">제약조건</p>
      <div className="mb-2 grid grid-cols-2 gap-2">
        <div>
          <span className="mb-1 block text-[9px] text-[#6e6e73]">최대 질량 kg</span>
          <Input aria-label="최대 질량" type="number" min={2} max={100} value={candidateMassLimit} onChange={(event) => onCandidateMassLimitChange(Number(event.target.value))} className="h-8 border-[#e5e5ea] bg-white font-mono text-xs text-[#1d1d1f]" />
        </div>
        <div>
          <span className="mb-1 block text-[9px] text-[#6e6e73]">최대 전력 W</span>
          <Input aria-label="최대 소비전력" type="number" min={200} max={10000} step={100} value={candidatePowerLimit} onChange={(event) => onCandidatePowerLimitChange(Number(event.target.value))} className="h-8 border-[#e5e5ea] bg-white font-mono text-xs text-[#1d1d1f]" />
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between rounded-lg bg-[#f5f5f7] px-3 py-2 text-xs">
        <span className="text-[#6e6e73]">조건 통과 후보</span>
        <span className="font-mono font-semibold text-[#1b64da]">{candidatePoolSize.toLocaleString()}개</span>
      </div>
      <Button disabled={running || candidatePoolSize === 0 || selectedId == null} onClick={onRun} className="mt-3 h-9 w-full bg-[#3182f6] text-white hover:bg-[#1b64da]">
        <Sparkles /> {running ? '후보 순위 계산 중…' : '상위 후보 계산'}
      </Button>
      {running && <Progress value={82} className="mt-2 [&_[data-slot=progress-indicator]]:bg-violet-400" />}

      {results.length > 0 && (
        <div className="mt-4 divide-y divide-[#e5e5ea] rounded-lg border border-[#e5e5ea]">
          {results.map((design, index) => (
            <button
              key={design.id}
              onClick={() => onSelect(design.id)}
              aria-label={`순위 ${index + 1} Design #${design.id} 선택`}
              className={`w-full px-3 py-2.5 text-left transition ${selectedId === design.id ? 'bg-[#eff6ff]' : 'hover:bg-[#f5f5f7]'}`}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="flex items-center gap-1 text-[11px] font-semibold text-[#3c3c43]">
                  {index === 0 && <Trophy className="size-3 text-violet-700" />}
                  {index + 1}위 · {classifyAirframe(design).label} <span className="font-mono font-normal text-[#6e6e73]">#{design.id}</span>
                </p>
                <span className="shrink-0 font-mono text-[10px] font-semibold text-violet-700">{design.score.toFixed(3)}</span>
              </div>
              <div className="mt-1.5 grid grid-cols-3 gap-2 font-mono text-[10px]">
                <span className="font-medium text-[#1b64da]">{design.maxDistance ? `${(design.maxDistance / 1000).toFixed(1)}km` : '—'}</span>
                <span className="text-[#6e6e73]">{design.mass.toFixed(1)}kg</span>
                <span className="text-[#6e6e73]">{formatMetric(design.power, 0)}W</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FavoritesSection({
  favorites,
  recent,
  designs,
  selectedId,
  onSelect,
  onToggleFavorite,
}: {
  favorites: number[];
  recent: number[];
  designs: DesignSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onToggleFavorite: (id: number) => void;
}) {
  const byId = useMemo(() => new Map(designs.map((design) => [design.id, design])), [designs]);
  const favoriteDesigns = favorites.map((id) => byId.get(id)).filter((design): design is DesignSummary => Boolean(design));
  const recentDesigns = recent.map((id) => byId.get(id)).filter((design): design is DesignSummary => Boolean(design));

  const Row = ({ design }: { design: DesignSummary }) => (
    <div key={design.id} className={`relative ${selectedId === design.id ? 'bg-[#eff6ff]' : 'hover:bg-[#f5f5f7]'}`}>
      <button onClick={() => onSelect(design.id)} className="w-full px-3 py-2 pr-8 text-left transition">
        <p className="text-[11px] font-semibold text-[#3c3c43]">
          {classifyAirframe(design).label} <span className="font-mono font-normal text-[#6e6e73]">#{design.id}</span>
        </p>
        <p className="mt-0.5 font-mono text-[10px] text-[#6e6e73]">{formatHub(design.hub)}</p>
      </button>
      <button
        onClick={() => onToggleFavorite(design.id)}
        aria-label={favorites.includes(design.id) ? `Design #${design.id} 즐겨찾기 해제` : `Design #${design.id} 즐겨찾기 추가`}
        aria-pressed={favorites.includes(design.id)}
        className="absolute right-2 top-2 rounded p-0.5 text-[#86868b] hover:bg-[#e5e5ea] hover:text-amber-500"
      >
        <Star className={`size-3 ${favorites.includes(design.id) ? 'fill-amber-400 text-amber-500' : ''}`} />
      </button>
    </div>
  );

  if (!favoriteDesigns.length && !recentDesigns.length) {
    return <p className="p-6 text-center text-[11px] leading-5 text-[#6e6e73]">즐겨찾기하거나 살펴본 설계가 여기 모입니다. 목록에서 별표를 눌러보세요.</p>;
  }

  return (
    <div>
      {favoriteDesigns.length > 0 && (
        <div>
          <p className="flex items-center gap-1 border-b border-[#e5e5ea] px-3 py-2 text-[10px] font-medium text-[#6e6e73]">
            <Star className="size-3 fill-amber-400 text-amber-500" /> 즐겨찾기 · {favoriteDesigns.length}
          </p>
          <div className="divide-y divide-[#e5e5ea]">{favoriteDesigns.map((design) => <Row key={design.id} design={design} />)}</div>
        </div>
      )}
      {recentDesigns.length > 0 && (
        <div>
          <p className="flex items-center gap-1 border-b border-[#e5e5ea] px-3 py-2 text-[10px] font-medium text-[#6e6e73]">
            <History className="size-3" /> 최근 본 설계 · {recentDesigns.length}
          </p>
          <div className="divide-y divide-[#e5e5ea]">{recentDesigns.map((design) => <Row key={design.id} design={design} />)}</div>
        </div>
      )}
    </div>
  );
}

function ResultsSection({
  filtered,
  visibleCount,
  onLoadMore,
  total,
  selectedId,
  onSelect,
  favorites,
  onToggleFavorite,
}: {
  filtered: DesignSummary[];
  visibleCount: number;
  onLoadMore: () => void;
  total: number;
  selectedId: number | null;
  onSelect: (id: number) => void;
  favorites: number[];
  onToggleFavorite: (id: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between border-b border-[#e5e5ea] px-3 py-2 text-[11px]">
        <span className="text-[#6e6e73]">
          설계 <span className="font-mono font-medium text-[#3c3c43]">{filtered.length.toLocaleString()}</span>
          <small className="ml-1 text-[10px] text-[#86868b]">/ {total.toLocaleString()}</small>
        </span>
      </div>
      <div
        className="divide-y divide-[#e5e5ea]"
        onScroll={(event) => {
          const box = event.currentTarget;
          if (box.scrollTop + box.clientHeight >= box.scrollHeight - 120) onLoadMore();
        }}
      >
        {filtered.slice(0, visibleCount).map((design) => {
          const active = selectedId === design.id;
          return (
            <div key={design.id} className={`relative ${active ? 'bg-[#eff6ff]' : 'hover:bg-[#f5f5f7]'}`}>
              <button onClick={() => onSelect(design.id)} className="w-full px-3 py-2 pr-8 text-left transition">
                <p className="text-[11px] font-semibold text-[#3c3c43]">
                  {classifyAirframe(design).label} <span className="font-mono font-normal text-[#6e6e73]">#{design.id}</span>
                </p>
                <p className="mt-0.5 font-mono text-[10px] text-[#6e6e73]">
                  {design.numPropellers}P{design.numWings > 0 ? `/${design.numWings}W` : ''} · {design.mass.toFixed(1)}kg
                  {design.maxDistance ? ` · ${(design.maxDistance / 1000).toFixed(1)}km` : ''}
                </p>
              </button>
              <button
                onClick={() => onToggleFavorite(design.id)}
                aria-label={favorites.includes(design.id) ? `Design #${design.id} 즐겨찾기 해제` : `Design #${design.id} 즐겨찾기 추가`}
                aria-pressed={favorites.includes(design.id)}
                className="absolute right-2 top-2 rounded p-0.5 text-[#86868b] hover:bg-[#e5e5ea] hover:text-amber-500"
              >
                <Star className={`size-3 ${favorites.includes(design.id) ? 'fill-amber-400 text-amber-500' : ''}`} />
              </button>
            </div>
          );
        })}
        {!filtered.length && (
          <p className="p-6 text-center text-[11px] leading-5 text-[#6e6e73]">조건에 맞는 설계가 없습니다. &ldquo;필터&rdquo; 탭에서 조건을 지우고 다시 골라보세요.</p>
        )}
      </div>
    </div>
  );
}

function SummarySection({ summary, detail }: { summary: DesignSummary | null; detail: ShowcaseDesign | null }) {
  if (!summary) {
    return <p className="p-6 text-center text-[11px] leading-5 text-[#6e6e73]">설계를 고르면 구성과 성능 요약이 여기 나타납니다.</p>;
  }
  return (
    <div className="p-3">
      <div className="mb-3 flex items-center gap-2">
        <p className="text-[11px] font-semibold text-[#3c3c43]">
          {classifyAirframe(summary).label} <span className="font-mono font-normal text-[#6e6e73]">#{summary.id}</span>
        </p>
        {summary.feasible ? (
          <Badge className="bg-emerald-50 text-[9px] text-emerald-700">비행성능 유효</Badge>
        ) : (
          <Badge variant="outline" className="border-amber-200 bg-amber-50 text-[9px] text-amber-700">성능 해석 불가</Badge>
        )}
      </div>

      <div className="rounded-lg border border-[#e5e5ea] bg-white p-3">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-[11px] font-medium text-[#3c3c43]">설계 구성</h3>
          <SourceBadge />
        </div>
        {detail ? (
          <ConfigurationList design={detail} />
        ) : (
          <div className="divide-y divide-[#e5e5ea]">
            {[
              ['허브', formatHub(summary.hub)],
              ['프로펠러', String(summary.numPropellers)],
              ['날개', String(summary.numWings)],
              ['암 길이', summary.armLength ? `${summary.armLength.toFixed(1)} mm` : '—'],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3 py-2 text-[11px]"><span className="text-[#6e6e73]">{label}</span><span className="text-[#3c3c43]">{value}</span></div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <MetricTile icon={<Route className="size-4" />} label="최대 비행거리" value={summary.maxDistance ? formatMetric(summary.maxDistance / 1000, 2) : '—'} unit={summary.maxDistance ? 'km' : undefined} note={summary.speedMfd ? `${summary.speedMfd} m/s 기준` : '성능 데이터 없음'} tone="cyan" />
        <MetricTile icon={<CircleGauge className="size-4" />} label="체공 시간" value={summary.hoverTime ? formatMetric(summary.hoverTime, 0) : '—'} unit={summary.hoverTime ? 'sec' : undefined} tone="violet" />
        <MetricTile icon={<Gauge className="size-4" />} label="최고 속도" value={summary.maxSpeed ? formatMetric(summary.maxSpeed, 1) : '—'} unit={summary.maxSpeed ? 'm/s' : undefined} tone="green" />
        <MetricTile icon={<Weight className="size-4" />} label="질량" value={formatMetric(summary.mass, 2)} unit="kg" note={formatDistance(summary.maxDistance)} />
      </div>
    </div>
  );
}
