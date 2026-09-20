'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  CircleGauge,
  Crosshair,
  Gauge,
  GitCompareArrows,
  History,
  PackageCheck,
  Radar,
  Route,
  Search,
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
  CANDIDATE_OBJECTIVES,
  CANDIDATE_PRESETS,
  buildCandidatePool,
  rankCandidates,
  type Objective,
  type ScoredDesign,
} from '@/lib/candidate-search';
import {
  ConfigurationList,
  DataDisclaimer,
  MetricTile,
  ModelStage,
  SectionHeading,
  SourceBadge,
} from '@/components/views/shared';

const FAVORITES_STORAGE_KEY = 'aerotwin:favorite-designs';
const RECENT_STORAGE_KEY = 'aerotwin:recent-designs';
const RECENT_LIMIT = 8;

const PRESET_ICONS: Record<string, typeof PackageCheck> = {
  Delivery: PackageCheck,
  Surveillance: Radar,
  Racing: Crosshair,
  'Heavy Payload': ShieldCheck,
};

type SearchMode = 'filter' | 'candidate';

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

export function ExplorerView({
  dataset,
  showcases,
  selected,
  onSelect,
  onOpenLab,
  onOpenSimulator,
  onOpenCompare,
}: {
  dataset: DatasetIndex;
  showcases: ShowcaseMap;
  selected: DesignSummary | null;
  onSelect: (id: number) => void;
  onOpenLab: (id: number) => void;
  onOpenSimulator: (id: number) => void;
  onOpenCompare: (aId: number, preferredBId?: number) => void;
}) {
  const [mode, setMode] = useState<SearchMode>('filter');
  const [query, setQuery] = useState('');
  const [propellers, setPropellers] = useState('all');
  const [wingMode, setWingMode] = useState('all');
  const [massMax, setMassMax] = useState(15);
  const [feasibleOnly, setFeasibleOnly] = useState(true);
  const [viewerOnly, setViewerOnly] = useState(true);
  const [favorites, setFavorites] = useState<number[]>([]);
  const [recent, setRecent] = useState<number[]>([]);

  const [preset, setPreset] = useState('Delivery');
  const [objective, setObjective] = useState<Objective>('range');
  const [candidateMassLimit, setCandidateMassLimit] = useState(10);
  const [candidatePowerLimit, setCandidatePowerLimit] = useState(2500);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ScoredDesign[]>([]);
  const [searchBaselineId, setSearchBaselineId] = useState<number | null>(null);
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

  const toggleFavorite = (id: number) => {
    setFavorites((previous) => {
      const next = previous.includes(id)
        ? previous.filter((item) => item !== id)
        : [id, ...previous];
      writeStoredIds(FAVORITES_STORAGE_KEY, next);
      return next;
    });
  };

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
  const currentId = current.id;
  const currentDetail = showcases[String(currentId)] ?? null;

  useEffect(() => {
    window.queueMicrotask(() => {
      setRecent((previous) => {
        const next = [currentId, ...previous.filter((id) => id !== currentId)].slice(0, RECENT_LIMIT);
        writeStoredIds(RECENT_STORAGE_KEY, next);
        return next;
      });
    });
  }, [currentId]);

  const candidatePool = buildCandidatePool(dataset.designs, currentId, candidateMassLimit, candidatePowerLimit, objective);

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
    if (runTimeoutRef.current != null) window.clearTimeout(runTimeoutRef.current);
    setSearchBaselineId(current.id);
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
    <section className="px-4 py-4 lg:px-6">
      <SectionHeading
        eyebrow="1단계 · 기준 설계 선택"
        title="설계 탐색"
        description="27,714개 전체 설계는 파라메트릭 개념 형상으로 편집하고, 대표 12개는 원본 STL까지 함께 확인할 수 있습니다."
        actions={
          mode === 'filter' && (
            <Button onClick={() => setMode('candidate')} className="bg-[#147d91] text-white hover:bg-[#0f6878]">
              <Sparkles /> 조건으로 후보 찾기 <ArrowUpRight />
            </Button>
          )
        }
      />

      <div className="grid gap-4 lg:grid-cols-[290px_minmax(0,1fr)] 2xl:grid-cols-[320px_minmax(500px,1fr)_300px]">
        <aside className="workspace-panel overflow-hidden rounded-xl">
          <div className="border-b border-[#dbe4ea] p-3.5">
            <div className="mb-3 grid grid-cols-2 rounded-lg bg-[#eef2f5] p-1 text-[11px] font-medium">
              <button
                onClick={() => setMode('filter')}
                className={`rounded-md px-2 py-2 transition ${mode === 'filter' ? 'bg-white text-[#0f6475] shadow-sm' : 'text-[#607383]'}`}
              >
                필터로 찾기
              </button>
              <button
                onClick={() => setMode('candidate')}
                className={`rounded-md px-2 py-2 transition ${mode === 'candidate' ? 'bg-white text-[#0f6475] shadow-sm' : 'text-[#607383]'}`}
              >
                조건으로 후보 찾기
              </button>
            </div>

            {mode === 'filter' ? (
              <>
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
                    비행거리 계산 가능한 설계도
                    <Switch checked={feasibleOnly} onCheckedChange={setFeasibleOnly} aria-label="비행거리 계산 가능한 설계도" />
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="mb-1 flex items-center gap-2">
                  <SourceBadge source="DATASET RANKING" />
                  <Badge variant="outline" className="border-[#d8cfee] bg-violet-50 text-[10px] text-violet-700">학습 AI 아닌 데이터셋 랭킹</Badge>
                </div>
                <p className="mb-3 text-sm font-medium text-[#294353]">임무 Preset</p>
                <div className="grid grid-cols-2 gap-2">
                  {CANDIDATE_PRESETS.map(({ name }) => {
                    const Icon = PRESET_ICONS[name];
                    return (
                      <button key={name} onClick={() => applyPreset(name)} className={`rounded-lg border p-2.5 text-left transition ${preset === name ? 'border-[#9ccdd6] bg-[#eef8fa] text-[#0f6475]' : 'border-[#dbe4ea] bg-white text-[#607383] hover:bg-[#f4f7f9]'}`}>
                        <Icon className="mb-1.5 size-4" />
                        <span className="text-[11px] font-medium">{name}</span>
                      </button>
                    );
                  })}
                </div>

                <p className="mb-2 mt-4 text-sm font-medium text-[#294353]">탐색 목표</p>
                <div className="grid grid-cols-2 gap-2">
                  {CANDIDATE_OBJECTIVES.map((item) => (
                    <button key={item.id} onClick={() => { cancelPendingRun(); setObjective(item.id); }} className={`rounded-lg border p-2.5 text-left transition ${objective === item.id ? 'border-violet-300 bg-violet-50' : 'border-[#dbe4ea] bg-white hover:bg-[#f4f7f9]'}`}>
                      <p className={`text-[11px] font-medium ${objective === item.id ? 'text-violet-900' : 'text-[#526675]'}`}>{item.label}</p>
                      <p className="mt-0.5 text-[10px] text-[#718391]">{item.detail}</p>
                    </button>
                  ))}
                </div>

                <p className="mb-2 mt-4 text-xs font-medium text-[#294353]">제약조건</p>
                <div className="mb-2 grid grid-cols-2 gap-2">
                  <div>
                    <span className="mb-1 block text-[10px] text-[#718391]">최대 질량 kg</span>
                    <Input aria-label="최대 질량" type="number" min={2} max={100} value={candidateMassLimit} onChange={(event) => { cancelPendingRun(); setCandidateMassLimit(Number(event.target.value)); }} className="h-9 border-[#ccd8df] bg-white font-mono text-xs text-[#172b3a]" />
                  </div>
                  <div>
                    <span className="mb-1 block text-[10px] text-[#718391]">최대 전력 W</span>
                    <Input aria-label="최대 소비전력" type="number" min={200} max={10000} step={100} value={candidatePowerLimit} onChange={(event) => { cancelPendingRun(); setCandidatePowerLimit(Number(event.target.value)); }} className="h-9 border-[#ccd8df] bg-white font-mono text-xs text-[#172b3a]" />
                  </div>
                </div>

                <div className="mt-2 flex items-center justify-between rounded-lg border border-[#dbe4ea] bg-[#f4f7f9] px-3 py-2 text-xs">
                  <span className="text-[#607383]">조건 통과 후보</span>
                  <span className="font-mono font-semibold text-[#0f6475]">{candidatePool.length.toLocaleString()}개</span>
                </div>
                <Button disabled={running || candidatePool.length === 0} onClick={runCandidateSearch} className="mt-3 h-10 w-full bg-[#147d91] text-white hover:bg-[#0f6878]">
                  <Sparkles /> {running ? '후보 순위 계산 중…' : '상위 후보 계산'}
                </Button>
                {running && <Progress value={82} className="mt-2 [&_[data-slot=progress-indicator]]:bg-violet-400" />}
              </>
            )}
          </div>

          {mode === 'filter' && (favorites.length > 0 || recent.length > 0) && (
            <div className="space-y-3 border-b border-[#dbe4ea] p-3.5">
              {favorites.length > 0 && (
                <div>
                  <p className="mb-1.5 flex items-center gap-1 text-[10px] font-medium text-[#607383]">
                    <Star className="size-3 fill-amber-400 text-amber-500" /> 즐겨찾기 · {favorites.length}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {favorites.map((id) => (
                      <button
                        key={id}
                        onClick={() => onSelect(id)}
                        className={`rounded-full border px-2 py-1 font-mono text-[10px] transition ${
                          current.id === id
                            ? 'border-[#9ccdd6] bg-[#eef8fa] text-[#0f6475]'
                            : 'border-[#dbe4ea] bg-white text-[#526675] hover:bg-[#f4f7f9]'
                        }`}
                      >
                        #{id}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {recent.length > 0 && (
                <div>
                  <p className="mb-1.5 flex items-center gap-1 text-[10px] font-medium text-[#607383]">
                    <History className="size-3" /> 최근 본 설계
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {recent.map((id) => (
                      <button
                        key={id}
                        onClick={() => onSelect(id)}
                        className={`rounded-full border px-2 py-1 font-mono text-[10px] transition ${
                          current.id === id
                            ? 'border-[#9ccdd6] bg-[#eef8fa] text-[#0f6475]'
                            : 'border-[#dbe4ea] bg-white text-[#526675] hover:bg-[#f4f7f9]'
                        }`}
                      >
                        #{id}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {mode === 'filter' ? (
            <>
              <div className="flex items-center justify-between border-b border-[#dbe4ea] px-3.5 py-2.5 text-xs">
                <span className="text-[#607383]">검색 결과 <small className="ml-1 text-[10px]">(최대 60개 표시)</small></span>
                <span className="font-mono font-medium text-[#294353]">{filtered.length.toLocaleString()}</span>
              </div>
              <div className="max-h-[430px] overflow-y-auto p-2">
                {visibleResults.length ? (
                  visibleResults.map((design) => {
                    const isFavorite = favorites.includes(design.id);
                    return (
                      <div key={design.id} className="relative mb-2 last:mb-0">
                        <button
                          onClick={() => onSelect(design.id)}
                          className={`w-full rounded-xl border p-3 pr-9 text-left transition ${
                            current.id === design.id
                              ? 'border-[#9ccdd6] bg-[#eef8fa] shadow-sm'
                              : 'border-[#cfdbe2] bg-white hover:border-[#9ccdd6] hover:bg-[#f7f9fb]'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="font-mono text-xs font-semibold text-[#233b4a]">Design #{design.id}</p>
                              <p className="mt-1 truncate text-[11px] text-[#718391]">{formatHub(design.hub)}</p>
                            </div>
                            {showcases[String(design.id)] ? (
                              <Badge className="shrink-0 bg-[#e5f5f7] text-[9px] text-[#0f6475]">STL + 편집</Badge>
                            ) : (
                              <Badge variant="outline" className="shrink-0 border-[#dbe4ea] text-[9px] text-[#0f6475]">프리뷰 편집</Badge>
                            )}
                          </div>
                          <div className="mt-3 grid grid-cols-3 gap-2 font-mono text-[10px]">
                            <span className="font-medium text-[#0f6475]">{design.maxDistance ? `${(design.maxDistance / 1000).toFixed(1)}km` : '—'}</span>
                            <span className="text-[#607383]">{design.mass.toFixed(1)}kg</span>
                            <span className="text-[#607383]">{design.numPropellers}P/{design.numWings}W</span>
                          </div>
                        </button>
                        <button
                          onClick={() => toggleFavorite(design.id)}
                          aria-label={isFavorite ? `Design #${design.id} 즐겨찾기 해제` : `Design #${design.id} 즐겨찾기 추가`}
                          aria-pressed={isFavorite}
                          className="absolute right-2 top-2 rounded p-0.5 text-[#b7c3cb] hover:bg-[#e9eff3] hover:text-amber-500"
                        >
                          <Star className={`size-3.5 ${isFavorite ? 'fill-amber-400 text-amber-500' : ''}`} />
                        </button>
                      </div>
                    );
                  })
                ) : (
                  <div className="p-8 text-center text-xs leading-5 text-[#607383]">조건에 맞는 설계가 없습니다. 질량 조건을 완화하거나 전체 DB를 확인하세요.</div>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-[#dbe4ea] px-3.5 py-2.5 text-xs">
                <span className="text-[#607383]">{running ? '순위 계산 중' : results.length ? '순위 후보' : '아직 계산 전'}</span>
                {results.length > 0 && <span className="font-mono font-medium text-[#294353]">{results.length}개</span>}
              </div>
              <div className="max-h-[430px] overflow-y-auto p-2">
                {running ? (
                  <div className="grid min-h-40 place-items-center p-8 text-center">
                    <div><Sparkles className="mx-auto mb-3 size-6 animate-pulse text-violet-700" /><p className="text-xs text-violet-700">제약 필터 → 목적 점수 → 상위 후보</p></div>
                  </div>
                ) : results.length ? (
                  results.map((design, index) => (
                    <button
                      key={design.id}
                      onClick={() => onSelect(design.id)}
                      aria-label={`순위 ${index + 1} Design #${design.id} 선택`}
                      className={`mb-1 w-full rounded-xl border p-3 text-left transition ${
                        current.id === design.id
                          ? 'border-[#9ccdd6] bg-[#eef8fa] shadow-sm'
                          : 'border-transparent hover:border-[#dbe4ea] hover:bg-[#f7f9fb]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="flex items-center gap-1.5 font-mono text-xs font-semibold text-[#233b4a]">
                            {index === 0 && <Trophy className="size-3 text-violet-700" />}
                            순위 {index + 1} · Design #{design.id}
                          </p>
                          <p className="mt-1 truncate text-[11px] text-[#718391]">{formatHub(design.hub)}</p>
                        </div>
                        <span className="shrink-0 font-mono text-[10px] font-semibold text-violet-700">{design.score.toFixed(3)}</span>
                      </div>
                      <div className="mt-3 grid grid-cols-3 gap-2 font-mono text-[10px]">
                        <span className="font-medium text-[#0f6475]">{design.maxDistance ? `${(design.maxDistance / 1000).toFixed(1)}km` : '—'}</span>
                        <span className="text-[#607383]">{design.mass.toFixed(1)}kg</span>
                        <span className="text-[#607383]">{formatMetric(design.power, 0)}W</span>
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="p-8 text-center text-xs leading-5 text-[#607383]">목표와 제약조건을 검토한 뒤 &lsquo;상위 후보 계산&rsquo;을 눌러보세요.</div>
                )}
              </div>
              {results.length > 0 && searchBaselineId != null && searchBaselineId !== current.id && (
                <div className="border-t border-[#dbe4ea] p-3">
                  <Button
                    onClick={() => onOpenCompare(current.id, searchBaselineId)}
                    variant="outline"
                    className="h-9 w-full border-violet-200 bg-violet-50 text-xs text-violet-800 hover:bg-violet-100"
                  >
                    <GitCompareArrows /> 탐색 전 설계(#{searchBaselineId})와 비교
                  </Button>
                </div>
              )}
            </>
          )}
        </aside>

        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#dbe4ea] bg-white px-4 py-3 shadow-sm">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-[#172b3a]">Design #{current.id}</h2>
                <button
                  onClick={() => toggleFavorite(current.id)}
                  aria-label={favorites.includes(current.id) ? '즐겨찾기 해제' : '즐겨찾기 추가'}
                  aria-pressed={favorites.includes(current.id)}
                  className="rounded p-1 text-[#b7c3cb] hover:bg-[#f4f7f9] hover:text-amber-500"
                >
                  <Star className={`size-4 ${favorites.includes(current.id) ? 'fill-amber-400 text-amber-500' : ''}`} />
                </button>
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
