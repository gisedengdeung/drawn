'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Beaker,
  Boxes,
  CheckCircle2,
  GitCompareArrows,
  Hexagon,
  Sparkles,
} from 'lucide-react';

import { CompareView } from '@/components/views/compare-view';
import { DesignLabView } from '@/components/views/design-lab-view';
import { ExplorerView } from '@/components/views/explorer-view';
import { OptimizerView } from '@/components/views/optimizer-view';
import { SimulatorView } from '@/components/views/simulator-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type {
  DatasetIndex,
  DesignSummary,
  ShowcaseMap,
  WorkspaceView,
} from '@/lib/drawn-types';

const navItems = [
  { id: 'explore' as const, step: 1, label: '설계 선택', short: '탐색', icon: Boxes },
  { id: 'lab' as const, step: 2, label: '파라미터 편집', short: '편집', icon: Beaker },
  { id: 'simulator' as const, step: 3, label: '성능 확인', short: '성능', icon: Activity },
  { id: 'compare' as const, step: 4, label: '설계 비교', short: '비교', icon: GitCompareArrows },
  { id: 'optimizer' as const, step: 5, label: '후보 탐색', short: '후보', icon: Sparkles },
];

export function DrawnApp() {
  const [view, setView] = useState<WorkspaceView>('explore');
  const [dataset, setDataset] = useState<DatasetIndex | null>(null);
  const [showcases, setShowcases] = useState<ShowcaseMap>({});
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [comparePair, setComparePair] = useState<{ aId: number; bId: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch('/data/design-index.json').then((response) => {
        if (!response.ok) throw new Error('설계 인덱스를 불러오지 못했습니다.');
        return response.json() as Promise<DatasetIndex>;
      }),
      fetch('/data/showcase-designs.json').then((response) => {
        if (!response.ok) throw new Error('시연 설계 데이터를 불러오지 못했습니다.');
        return response.json() as Promise<ShowcaseMap>;
      }),
    ])
      .then(([index, showcaseData]) => {
        if (!active) return;
        const showcaseIds = index.summary.showcaseIds;
        if (
          showcaseIds.length !== 12 ||
          showcaseIds.some((id) => !showcaseData[String(id)]) ||
          !showcaseData[String(index.summary.defaultShowcaseId)]
        ) {
          throw new Error('설계 인덱스와 대표 3D 자산이 일치하지 않습니다.');
        }
        const secondId = showcaseIds.find((id) => id !== index.summary.defaultShowcaseId)
          ?? index.summary.defaultShowcaseId;
        setDataset(index);
        setShowcases(showcaseData);
        setSelectedId(index.summary.defaultShowcaseId);
        setComparePair({ aId: index.summary.defaultShowcaseId, bId: secondId });
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : '데이터 로딩 오류');
      });
    return () => {
      active = false;
    };
  }, []);

  const designById = useMemo(
    () => new Map(dataset?.designs.map((design) => [design.id, design]) ?? []),
    [dataset],
  );
  const selectedSummary = useMemo<DesignSummary | null>(
    () => selectedId == null ? null : designById.get(selectedId) ?? null,
    [designById, selectedId],
  );
  const selectedDetail = selectedId == null ? null : showcases[String(selectedId)] ?? null;
  const showcaseList = useMemo(
    () => dataset?.summary.showcaseIds
      .map((id) => showcases[String(id)])
      .filter((design) => Boolean(design)) ?? [],
    [dataset, showcases],
  );
  const labSelectorDesigns = useMemo(() => {
    if (!selectedSummary || showcaseList.some((design) => design.id === selectedSummary.id)) return showcaseList;
    return [selectedSummary, ...showcaseList];
  }, [selectedSummary, showcaseList]);

  const selectShowcaseAndOpen = (id: number, nextView: WorkspaceView) => {
    setSelectedId(id);
    setView(nextView);
  };

  const openCompare = (aId: number, bId: number) => {
    if (!designById.has(aId) || !designById.has(bId)) return;
    setComparePair({ aId, bId });
    setView('compare');
  };

  const openCompareFromExplorer = (aId: number) => {
    const existingB = comparePair?.bId;
    const bId = existingB && existingB !== aId && designById.has(existingB)
      ? existingB
      : dataset?.summary.showcaseIds.find((id) => id !== aId);
    if (bId != null) openCompare(aId, bId);
  };

  return (
    <main className="workspace-light min-h-screen bg-[#f7f9fb] text-[#172b3a]">
      <header className="sticky top-0 z-50 border-b border-[#dbe4ea] bg-white/95 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[1720px] items-center gap-4 px-4 lg:px-6">
          <button onClick={() => setView('explore')} className="flex min-w-0 items-center gap-2.5 text-left">
            <div className="grid size-8 place-items-center rounded-lg bg-[#147d91] shadow-sm">
              <Hexagon className="size-4.5 text-white" />
            </div>
            <div>
              <p className="text-sm font-semibold tracking-[-0.02em] text-[#172b3a]">drawn</p>
              <p className="hidden text-[10px] font-medium tracking-[0.08em] text-[#6b7d8b] sm:block">UAV 설계 워크벤치</p>
            </div>
          </button>

          <div className="hidden h-5 w-px bg-[#dbe4ea] sm:block" />
          <div className="hidden items-center gap-1.5 text-xs text-[#5f7280] sm:flex">
            <CheckCircle2 className="size-3.5 text-emerald-600" />
            AircraftVerse {dataset ? dataset.summary.localDesigns.toLocaleString() : '…'}개 준비됨
          </div>

          <div className="ml-auto flex items-center gap-2">
            <Badge variant="outline" className="border-[#cfdbe2] bg-[#f7f9fb] text-[10px] text-[#526675]">
              파라메트릭 27,714개 · 원본 STL 12개
            </Badge>
          </div>
        </div>

        <nav className="mx-auto flex max-w-[1720px] items-center overflow-x-auto px-2 lg:px-4" aria-label="설계 작업 단계">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = item.id === view;
            return (
              <button
                key={item.id}
                onClick={() => setView(item.id)}
                aria-current={active ? 'page' : undefined}
                className={`group relative flex min-w-fit flex-1 items-center justify-center gap-2 border-b-2 px-3 py-2.5 text-xs font-medium transition lg:text-sm ${
                  active
                    ? 'border-[#147d91] bg-[#eef8fa] text-[#0f6475]'
                    : 'border-transparent text-[#607383] hover:bg-[#f4f7f9] hover:text-[#294353]'
                }`}
              >
                <span className={`grid size-5 place-items-center rounded-full text-[10px] ${active ? 'bg-[#147d91] text-white' : 'bg-[#e9eff3] text-[#607383]'}`}>
                  {item.step}
                </span>
                <Icon className="hidden size-3.5 md:block" />
                <span className="hidden sm:inline">{item.label}</span>
                <span className="sm:hidden">{item.short}</span>
              </button>
            );
          })}
        </nav>
      </header>

      <div className="mx-auto min-h-[calc(100vh-103px)] max-w-[1720px] min-w-0">
          {error ? (
            <div className="m-6 rounded-2xl border border-rose-400/20 bg-rose-400/8 p-8 text-rose-200">
              <p className="font-medium">데이터를 불러오지 못했습니다.</p>
              <p className="mt-2 text-sm text-rose-200/70">{error}</p>
            </div>
          ) : !dataset || showcaseList.length === 0 ? (
            <LoadingWorkspace />
          ) : (
            <>
              {view === 'explore' && (
                <ExplorerView
                  dataset={dataset}
                  showcases={showcases}
                  selected={selectedSummary}
                  onSelect={setSelectedId}
                  onOpenLab={(id) => selectShowcaseAndOpen(id, 'lab')}
                  onOpenSimulator={(id) => selectShowcaseAndOpen(id, 'simulator')}
                  onOpenCompare={openCompareFromExplorer}
                  onOpenOptimizer={() => setView('optimizer')}
                />
              )}
              {view === 'simulator' && selectedDetail && (
                <SimulatorView
                  designs={showcaseList}
                  selected={selectedDetail}
                  onSelect={setSelectedId}
                  onOpenLab={() => setView('lab')}
                />
              )}
              {view === 'simulator' && !selectedDetail && (
                <ShowcaseRequiredState
                  title="Performance Simulator"
                  selectedId={selectedId}
                  defaultId={dataset.summary.defaultShowcaseId}
                  onChoose={(id) => selectShowcaseAndOpen(id, 'simulator')}
                />
              )}
              {view === 'lab' && selectedSummary && (
                <DesignLabView
                  key={selectedSummary.id}
                  designs={labSelectorDesigns}
                  selected={selectedSummary}
                  referenceDesign={selectedDetail}
                  datasetDesigns={dataset.designs}
                  onSelect={setSelectedId}
                  onOpenDatasetCompare={() => openCompareFromExplorer(selectedSummary.id)}
                />
              )}
              {view === 'compare' && comparePair && (
                <CompareView
                  dataset={dataset}
                  showcases={showcases}
                  pair={comparePair}
                  onPairChange={setComparePair}
                />
              )}
              {view === 'optimizer' && (
                <OptimizerView
                  dataset={dataset}
                  current={selectedSummary ?? designById.get(dataset.summary.defaultShowcaseId)!}
                  onCompare={openCompare}
                  onApplyDraft={(id) => selectShowcaseAndOpen(id, 'lab')}
                />
              )}
            </>
          )}
      </div>
    </main>
  );
}

function LoadingWorkspace() {
  return (
    <div className="grid min-h-[calc(100vh-103px)] place-items-center px-6">
      <div className="text-center">
        <div className="mx-auto mb-5 grid size-12 place-items-center rounded-xl border border-[#b9dce3] bg-[#eef8fa]">
          <Hexagon className="size-6 animate-pulse text-[#147d91]" />
        </div>
        <p className="font-medium text-[#233b4a]">AircraftVerse 인덱스를 준비하고 있습니다</p>
        <p className="mt-2 text-sm text-[#607383]">27,714개 설계 메타데이터와 대표 성능 곡선을 불러옵니다.</p>
      </div>
    </div>
  );
}

function ShowcaseRequiredState({
  title,
  selectedId,
  defaultId,
  onChoose,
}: {
  title: string;
  selectedId: number | null;
  defaultId: number;
  onChoose: (id: number) => void;
}) {
  return (
    <section className="grid min-h-[calc(100vh-103px)] place-items-center px-6 text-center">
      <div className="workspace-panel max-w-md rounded-2xl p-8">
        <Boxes className="mx-auto mb-4 size-8 text-[#147d91]" />
        <h1 className="text-lg font-semibold text-[#172b3a]">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-[#607383]">
          Design #{selectedId ?? '—'}는 metadata-only 설계라 STL과 trim 곡선이 패키징되지 않았습니다.
        </p>
        <Button onClick={() => onChoose(defaultId)} className="mt-5 bg-[#147d91] text-white hover:bg-[#0f6878]">
          대표 설계 #{defaultId} 선택
        </Button>
      </div>
    </section>
  );
}
