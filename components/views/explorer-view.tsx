'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  CircleGauge,
  Crosshair,
  Gauge,
  GitCompareArrows,
  History,
  Info,
  PackageCheck,
  Radar,
  Route,
  ShieldCheck,
  Sparkles,
  Star,
  Trophy,
  Weight,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import type {
  AirframeKind,
  DatasetIndex,
  DesignSummary,
  ShowcaseMap,
} from '@/lib/drawn-types';
import {
  classifyAirframe,
  formatDistance,
  formatHub,
  formatMetric,
} from '@/lib/drawn-types';
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

const FAVORITES_STORAGE_KEY = 'drawn:favorite-designs';
const RECENT_STORAGE_KEY = 'drawn:recent-designs';
const ONBOARDING_STORAGE_KEY = 'drawn:onboarding-dismissed';
const RECENT_LIMIT = 8;

const AIRFRAME_KIND_OPTIONS: { value: 'all' | AirframeKind; label: string }[] = [
  { value: 'all', label: '전체 형태' },
  { value: 'quad', label: '쿼드콥터' },
  { value: 'hexa', label: '헥사콥터' },
  { value: 'octo', label: '옥토콥터' },
  { value: 'multi', label: '멀티콥터' },
  { value: 'wing', label: '고정익·복합익' },
];

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
  onOpenGuide,
}: {
  dataset: DatasetIndex;
  showcases: ShowcaseMap;
  selected: DesignSummary | null;
  onSelect: (id: number) => void;
  onOpenLab: (id: number) => void;
  onOpenSimulator: (id: number) => void;
  onOpenCompare: (aId: number, preferredBId?: number) => void;
  onOpenGuide: () => void;
}) {
  const [mode, setMode] = useState<SearchMode>('filter');
  const [airframeKind, setAirframeKind] = useState<'all' | AirframeKind>('all');
  const [massMax, setMassMax] = useState(15);
  const [feasibleOnly, setFeasibleOnly] = useState(true);
  const [viewerOnly, setViewerOnly] = useState(true);
  const [favorites, setFavorites] = useState<number[]>([]);
  const [recent, setRecent] = useState<number[]>([]);
  const [showOnboarding, setShowOnboarding] = useState(false);

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
      try {
        setShowOnboarding(localStorage.getItem(ONBOARDING_STORAGE_KEY) !== '1');
      } catch {
        setShowOnboarding(true);
      }
    });
  }, []);

  const dismissOnboarding = () => {
    setShowOnboarding(false);
    try {
      localStorage.setItem(ONBOARDING_STORAGE_KEY, '1');
    } catch {
      // Storage unavailable — dismissal just won't persist across reloads.
    }
  };

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
    return dataset.designs
      .filter((design) => {
        if (viewerOnly && !showcases[String(design.id)]) return false;
        if (feasibleOnly && !design.feasible) return false;
        if (design.mass > massMax) return false;
        if (airframeKind !== 'all' && classifyAirframe(design).kind !== airframeKind) return false;
        return true;
      })
      .sort((a, b) => b.maxDistance - a.maxDistance || a.id - b.id);
  }, [airframeKind, dataset.designs, feasibleOnly, massMax, showcases, viewerOnly]);

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
      />

      {showOnboarding && (
        <div className="workspace-panel relative mb-4 flex items-center gap-3 overflow-hidden rounded-xl border border-[#bfdbfe] bg-[#eff6ff] px-4 py-3">
          <Info className="size-4 shrink-0 text-[#1b64da]" />
          <p className="flex-1 text-xs text-[#3c3c43]">
            드론을 잘 몰라도 괜찮아요. 화면 용어와 사용 흐름을 3분 안에 정리해드려요.
          </p>
          <button
            onClick={onOpenGuide}
            className="shrink-0 rounded-lg bg-[#3182f6] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#1b64da]"
          >
            처음이신가요? 가이드 보기 →
          </button>
          <button
            onClick={dismissOnboarding}
            aria-label="안내 닫기"
            className="shrink-0 rounded p-1 text-[#6b8cae] hover:bg-white/60 hover:text-[#1b64da]"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[290px_minmax(0,1fr)] 2xl:grid-cols-[320px_minmax(500px,1fr)_300px]">
        <aside className="workspace-panel overflow-hidden rounded-xl">
          <div className="border-b border-[#e5e5ea] p-3.5">
            <div className="mb-3 grid grid-cols-2 rounded-lg bg-[#f5f5f7] p-1 text-[11px] font-medium">
              <button
                onClick={() => setMode('filter')}
                className={`rounded-md px-2 py-2 transition ${mode === 'filter' ? 'bg-white text-[#1b64da] shadow-sm' : 'text-[#6e6e73]'}`}
              >
                모델 정하기
              </button>
              <button
                onClick={() => setMode('candidate')}
                className={`rounded-md px-2 py-2 transition ${mode === 'candidate' ? 'bg-white text-[#1b64da] shadow-sm' : 'text-[#6e6e73]'}`}
              >
                목적에 따라 모델 추천 받기
              </button>
            </div>

            {mode === 'filter' ? (
              <>
                <div className="mb-3 grid grid-cols-2 rounded-lg bg-[#f5f5f7] p-1 text-[11px] font-medium">
                  <button
                    onClick={() => setViewerOnly(true)}
                    className={`rounded-md px-2 py-2 transition ${viewerOnly ? 'bg-white text-[#1b64da] shadow-sm' : 'text-[#6e6e73]'}`}
                  >
                    원본 STL · 12
                  </button>
                  <button
                    onClick={() => setViewerOnly(false)}
                    className={`rounded-md px-2 py-2 transition ${!viewerOnly ? 'bg-white text-[#1b64da] shadow-sm' : 'text-[#6e6e73]'}`}
                  >
                    프리뷰 · 27,714
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {AIRFRAME_KIND_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => setAirframeKind(option.value)}
                      className={`rounded-full border px-2.5 py-1.5 text-[11px] font-medium transition ${
                        airframeKind === option.value
                          ? 'border-[#93c5fd] bg-[#eff6ff] text-[#1b64da]'
                          : 'border-[#e5e5ea] bg-white text-[#6e6e73] hover:bg-[#f5f5f7]'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>

                <div className="mt-4">
                  <div className="mb-2 flex justify-between text-xs text-[#6e6e73]">
                    <span>최대 질량</span><span className="font-mono font-medium text-[#3c3c43]">≤ {massMax} kg</span>
                  </div>
                  <Slider
                    value={[massMax]}
                    min={2}
                    max={30}
                    step={1}
                    onValueChange={(value) => setMassMax(Number(Array.isArray(value) ? value[0] : value))}
                    className="[&_[data-slot=slider-range]]:bg-[#3182f6]"
                    aria-label="최대 질량"
                  />
                </div>

                <div className="mt-4 rounded-lg bg-[#f5f5f7] p-3">
                  <div className="flex items-center justify-between gap-3 text-xs text-[#6e6e73]">
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
                <p className="mb-3 text-sm font-medium text-[#3c3c43]">임무 Preset</p>
                <div className="grid grid-cols-2 gap-2">
                  {CANDIDATE_PRESETS.map(({ name }) => {
                    const Icon = PRESET_ICONS[name];
                    return (
                      <button key={name} onClick={() => applyPreset(name)} className={`rounded-lg border p-2.5 text-left transition ${preset === name ? 'border-[#93c5fd] bg-[#eff6ff] text-[#1b64da]' : 'border-[#e5e5ea] bg-white text-[#6e6e73] hover:bg-[#f5f5f7]'}`}>
                        <Icon className="mb-1.5 size-4" />
                        <span className="text-[11px] font-medium">{name}</span>
                      </button>
                    );
                  })}
                </div>

                <p className="mb-2 mt-4 text-sm font-medium text-[#3c3c43]">탐색 목표</p>
                <div className="grid grid-cols-2 gap-2">
                  {CANDIDATE_OBJECTIVES.map((item) => (
                    <button key={item.id} onClick={() => { cancelPendingRun(); setObjective(item.id); }} className={`rounded-lg border p-2.5 text-left transition ${objective === item.id ? 'border-violet-300 bg-violet-50' : 'border-[#e5e5ea] bg-white hover:bg-[#f5f5f7]'}`}>
                      <p className={`text-[11px] font-medium ${objective === item.id ? 'text-violet-900' : 'text-[#6e6e73]'}`}>{item.label}</p>
                      <p className="mt-0.5 text-[10px] text-[#6e6e73]">{item.detail}</p>
                    </button>
                  ))}
                </div>

                <p className="mb-2 mt-4 text-xs font-medium text-[#3c3c43]">제약조건</p>
                <div className="mb-2 grid grid-cols-2 gap-2">
                  <div>
                    <span className="mb-1 block text-[10px] text-[#6e6e73]">최대 질량 kg</span>
                    <Input aria-label="최대 질량" type="number" min={2} max={100} value={candidateMassLimit} onChange={(event) => { cancelPendingRun(); setCandidateMassLimit(Number(event.target.value)); }} className="h-9 border-[#e5e5ea] bg-white font-mono text-xs text-[#1d1d1f]" />
                  </div>
                  <div>
                    <span className="mb-1 block text-[10px] text-[#6e6e73]">최대 전력 W</span>
                    <Input aria-label="최대 소비전력" type="number" min={200} max={10000} step={100} value={candidatePowerLimit} onChange={(event) => { cancelPendingRun(); setCandidatePowerLimit(Number(event.target.value)); }} className="h-9 border-[#e5e5ea] bg-white font-mono text-xs text-[#1d1d1f]" />
                  </div>
                </div>

                <div className="mt-2 flex items-center justify-between rounded-lg bg-[#f5f5f7] px-3 py-2 text-xs">
                  <span className="text-[#6e6e73]">조건 통과 후보</span>
                  <span className="font-mono font-semibold text-[#1b64da]">{candidatePool.length.toLocaleString()}개</span>
                </div>
                <Button disabled={running || candidatePool.length === 0} onClick={runCandidateSearch} className="mt-3 h-10 w-full bg-[#3182f6] text-white hover:bg-[#1b64da]">
                  <Sparkles /> {running ? '후보 순위 계산 중…' : '상위 후보 계산'}
                </Button>
                {running && <Progress value={82} className="mt-2 [&_[data-slot=progress-indicator]]:bg-violet-400" />}
              </>
            )}
          </div>

          {mode === 'filter' && (favorites.length > 0 || recent.length > 0) && (
            <div className="space-y-3 border-b border-[#e5e5ea] p-3.5">
              {favorites.length > 0 && (
                <div>
                  <p className="mb-1.5 flex items-center gap-1 text-[10px] font-medium text-[#6e6e73]">
                    <Star className="size-3 fill-amber-400 text-amber-500" /> 즐겨찾기 · {favorites.length}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {favorites.map((id) => (
                      <button
                        key={id}
                        onClick={() => onSelect(id)}
                        className={`rounded-full border px-2 py-1 font-mono text-[10px] transition ${
                          current.id === id
                            ? 'border-[#93c5fd] bg-[#eff6ff] text-[#1b64da]'
                            : 'border-[#e5e5ea] bg-white text-[#6e6e73] hover:bg-[#f5f5f7]'
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
                  <p className="mb-1.5 flex items-center gap-1 text-[10px] font-medium text-[#6e6e73]">
                    <History className="size-3" /> 최근 본 설계
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {recent.map((id) => (
                      <button
                        key={id}
                        onClick={() => onSelect(id)}
                        className={`rounded-full border px-2 py-1 font-mono text-[10px] transition ${
                          current.id === id
                            ? 'border-[#93c5fd] bg-[#eff6ff] text-[#1b64da]'
                            : 'border-[#e5e5ea] bg-white text-[#6e6e73] hover:bg-[#f5f5f7]'
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
              <div className="flex items-center justify-between border-b border-[#e5e5ea] px-3.5 py-2.5 text-xs">
                <span className="text-[#6e6e73]">검색 결과 <small className="ml-1 text-[10px]">(최대 60개 표시)</small></span>
                <span className="font-mono font-medium text-[#3c3c43]">{filtered.length.toLocaleString()}</span>
              </div>
              <div className="max-h-[430px] divide-y divide-[#e5e5ea] overflow-y-auto">
                {visibleResults.length ? (
                  visibleResults.map((design) => {
                    const isFavorite = favorites.includes(design.id);
                    return (
                      <div key={design.id} className={`relative ${current.id === design.id ? 'bg-[#eff6ff]' : 'hover:bg-[#f5f5f7]'}`}>
                        <button
                          onClick={() => onSelect(design.id)}
                          className="w-full px-3.5 py-3 pr-9 text-left transition"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-xs font-semibold text-[#3c3c43]">
                                {classifyAirframe(design).label} <span className="font-mono font-normal text-[#6e6e73]">#{design.id}</span>
                              </p>
                              <p className="mt-1 truncate text-[11px] text-[#6e6e73]">{formatHub(design.hub)}</p>
                            </div>
                            {showcases[String(design.id)] ? (
                              <Badge className="shrink-0 bg-[#eff6ff] text-[9px] text-[#1b64da]">STL + 편집</Badge>
                            ) : (
                              <Badge variant="outline" className="shrink-0 border-[#e5e5ea] text-[9px] text-[#1b64da]">프리뷰 편집</Badge>
                            )}
                          </div>
                          <div className="mt-3 grid grid-cols-3 gap-2 font-mono text-[10px]">
                            <span className="font-medium text-[#1b64da]">{design.maxDistance ? `${(design.maxDistance / 1000).toFixed(1)}km` : '—'}</span>
                            <span className="text-[#6e6e73]">{design.mass.toFixed(1)}kg</span>
                            <span className="text-[#6e6e73]">{design.numPropellers}P/{design.numWings}W</span>
                          </div>
                        </button>
                        <button
                          onClick={() => toggleFavorite(design.id)}
                          aria-label={isFavorite ? `Design #${design.id} 즐겨찾기 해제` : `Design #${design.id} 즐겨찾기 추가`}
                          aria-pressed={isFavorite}
                          className="absolute right-2.5 top-3 rounded p-0.5 text-[#86868b] hover:bg-[#e5e5ea] hover:text-amber-500"
                        >
                          <Star className={`size-3.5 ${isFavorite ? 'fill-amber-400 text-amber-500' : ''}`} />
                        </button>
                      </div>
                    );
                  })
                ) : (
                  <div className="p-8 text-center text-xs leading-5 text-[#6e6e73]">조건에 맞는 설계가 없습니다. 질량 조건을 완화하거나 전체 DB를 확인하세요.</div>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-[#e5e5ea] px-3.5 py-2.5 text-xs">
                <span className="text-[#6e6e73]">{running ? '순위 계산 중' : results.length ? '순위 후보' : '아직 계산 전'}</span>
                {results.length > 0 && <span className="font-mono font-medium text-[#3c3c43]">{results.length}개</span>}
              </div>
              <div className="max-h-[430px] divide-y divide-[#e5e5ea] overflow-y-auto">
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
                      className={`w-full px-3.5 py-3 text-left transition ${
                        current.id === design.id
                          ? 'bg-[#eff6ff]'
                          : 'hover:bg-[#f5f5f7]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="flex items-center gap-1.5 text-xs font-semibold text-[#3c3c43]">
                            {index === 0 && <Trophy className="size-3 text-violet-700" />}
                            순위 {index + 1} · {classifyAirframe(design).label} <span className="font-mono font-normal text-[#6e6e73]">#{design.id}</span>
                          </p>
                          <p className="mt-1 truncate text-[11px] text-[#6e6e73]">{formatHub(design.hub)}</p>
                        </div>
                        <span className="shrink-0 font-mono text-[10px] font-semibold text-violet-700">{design.score.toFixed(3)}</span>
                      </div>
                      <div className="mt-3 grid grid-cols-3 gap-2 font-mono text-[10px]">
                        <span className="font-medium text-[#1b64da]">{design.maxDistance ? `${(design.maxDistance / 1000).toFixed(1)}km` : '—'}</span>
                        <span className="text-[#6e6e73]">{design.mass.toFixed(1)}kg</span>
                        <span className="text-[#6e6e73]">{formatMetric(design.power, 0)}W</span>
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="p-8 text-center text-xs leading-5 text-[#6e6e73]">목표와 제약조건을 검토한 뒤 &lsquo;상위 후보 계산&rsquo;을 눌러보세요.</div>
                )}
              </div>
              {results.length > 0 && searchBaselineId != null && searchBaselineId !== current.id && (
                <div className="border-t border-[#e5e5ea] p-3">
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

        <div className="flex min-w-0 flex-col">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#e5e5ea] bg-white px-4 py-3 shadow-sm">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-[#1d1d1f]">
                  {classifyAirframe(current).label} <span className="font-mono text-base font-normal text-[#6e6e73]">#{current.id}</span>
                </h2>
                <button
                  onClick={() => toggleFavorite(current.id)}
                  aria-label={favorites.includes(current.id) ? '즐겨찾기 해제' : '즐겨찾기 추가'}
                  aria-pressed={favorites.includes(current.id)}
                  className="rounded p-1 text-[#86868b] hover:bg-[#f5f5f7] hover:text-amber-500"
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
              <p className="mt-1 text-xs text-[#6e6e73]">{formatHub(current.hub)} · 프로펠러 {current.numPropellers}개 · 날개 {current.numWings}개</p>
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={() => onOpenCompare(current.id)} variant="outline" className="border-[#e5e5ea] bg-white text-[#3c3c43] hover:bg-[#f5f5f7]">
                <GitCompareArrows /> 비교
              </Button>
              {currentDetail && (
                <Button onClick={() => onOpenSimulator(current.id)} variant="outline" className="border-[#e5e5ea] bg-white text-[#3c3c43] hover:bg-[#f5f5f7]">
                  성능 확인
                </Button>
              )}
              <Button onClick={() => onOpenLab(current.id)} className="bg-[#3182f6] text-white hover:bg-[#1b64da]">
                파라미터 편집 <ArrowUpRight />
              </Button>
            </div>
          </div>

          <ModelStage design={currentDetail} emptyDesignId={current.id} className="min-h-[430px] flex-1 lg:min-h-[470px]" />
          <div className="mt-3"><DataDisclaimer compact /></div>
        </div>

        <aside className="grid gap-3 lg:col-span-2 lg:grid-cols-[minmax(220px,1.35fr)_repeat(4,minmax(140px,1fr))] 2xl:col-span-1 2xl:grid-cols-1">
          <div className="workspace-panel rounded-xl p-4">
            <div className="mb-1 flex items-center justify-between">
              <h3 className="text-sm font-medium text-[#3c3c43]">설계 구성</h3>
              <SourceBadge />
            </div>
            {currentDetail ? (
              <ConfigurationList design={currentDetail} />
            ) : (
              <div className="divide-y divide-[#e5e5ea]">
                {[
                  ['허브', formatHub(current.hub)],
                  ['프로펠러', String(current.numPropellers)],
                  ['날개', String(current.numWings)],
                  ['암 길이', current.armLength ? `${current.armLength.toFixed(1)} mm` : '—'],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-3 py-3 text-xs"><span className="text-[#6e6e73]">{label}</span><span className="text-[#3c3c43]">{value}</span></div>
                ))}
              </div>
            )}
          </div>

          <div className="contents">
            <MetricTile icon={<Route className="size-4" />} label="최대 비행거리" value={current.maxDistance ? formatMetric(current.maxDistance / 1000, 2) : '—'} unit={current.maxDistance ? 'km' : undefined} note={current.speedMfd ? `${current.speedMfd} m/s 기준` : '성능 데이터 없음'} tone="cyan" />
            <MetricTile icon={<CircleGauge className="size-4" />} label="체공 시간" value={current.hoverTime ? formatMetric(current.hoverTime, 0) : '—'} unit={current.hoverTime ? 'sec' : undefined} note={current.hoverTime ? `${formatMetric(current.hoverTime / 60, 1)}분` : '성능 데이터 없음'} tone="violet" />
            <MetricTile icon={<Gauge className="size-4" />} label="최고 속도" value={current.maxSpeed ? formatMetric(current.maxSpeed, 1) : '—'} unit={current.maxSpeed ? 'm/s' : undefined} tone="green" />
            <MetricTile icon={<Weight className="size-4" />} label="질량" value={formatMetric(current.mass, 2)} unit="kg" note={`데이터셋 내 순위 · ${formatDistance(current.maxDistance)}`} />
          </div>
        </aside>
      </div>
    </section>
  );
}
