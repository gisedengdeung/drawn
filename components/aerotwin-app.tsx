'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Beaker,
  Boxes,
  ChevronDown,
  GitCompareArrows,
  Hexagon,
  Info,
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
} from '@/lib/aerotwin-types';

const navItems = [
  { id: 'explore' as const, label: 'Design Explorer', icon: Boxes },
  { id: 'simulator' as const, label: 'Performance', icon: Activity },
  { id: 'lab' as const, label: 'Design Lab', icon: Beaker },
  { id: 'compare' as const, label: 'A/B Compare', icon: GitCompareArrows },
  { id: 'optimizer' as const, label: 'AI Optimizer', icon: Sparkles },
];

export function AeroTwinApp() {
  const [view, setView] = useState<WorkspaceView>('explore');
  const [dataset, setDataset] = useState<DatasetIndex | null>(null);
  const [showcases, setShowcases] = useState<ShowcaseMap>({});
  const [selectedId, setSelectedId] = useState(17297);
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
        setDataset(index);
        setShowcases(showcaseData);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : '데이터 로딩 오류');
      });
    return () => {
      active = false;
    };
  }, []);

  const selectedSummary = useMemo<DesignSummary | null>(
    () => dataset?.designs.find((design) => design.id === selectedId) ?? null,
    [dataset, selectedId],
  );
  const selectedDetail = showcases[String(selectedId)] ?? null;
  const showcaseList = useMemo(
    () => Object.values(showcases).sort((a, b) => a.id - b.id),
    [showcases],
  );

  const selectShowcaseAndOpen = (id: number, nextView: WorkspaceView) => {
    const fallback = showcases[String(id)] ? id : 17297;
    setSelectedId(fallback);
    setView(nextView);
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-50 flex h-16 items-center border-b border-white/8 bg-[#07111d]/92 px-4 backdrop-blur-xl lg:px-6">
        <button onClick={() => setView('explore')} className="flex min-w-0 items-center gap-3 text-left">
          <div className="grid size-9 place-items-center rounded-xl border border-cyan-300/25 bg-cyan-300/10 shadow-[0_0_24px_rgba(34,211,238,0.12)]">
            <Hexagon className="size-5 text-cyan-300" />
          </div>
          <div>
            <p className="font-semibold tracking-[-0.02em]">AeroTwin</p>
            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">UAV Intelligence</p>
          </div>
        </button>

        <div className="ml-8 hidden items-center gap-2 rounded-full border border-white/8 bg-white/[0.025] px-3 py-1.5 text-xs text-slate-400 md:flex">
          <span className="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
          Local dataset ready <span className="text-slate-600">·</span>{' '}
          {dataset ? dataset.summary.localDesigns.toLocaleString() : '…'} designs
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Badge variant="outline" className="hidden border-violet-400/20 bg-violet-400/8 text-violet-200 sm:inline-flex">
            <Sparkles /> Demo Surrogate v0.1
          </Badge>
          <Button variant="outline" className="border-white/10 bg-white/[0.035] text-slate-200 hover:bg-white/8">
            팀 워크스페이스 <ChevronDown />
          </Button>
        </div>
      </header>

      <div className="grid min-h-[calc(100vh-64px)] grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="hidden border-r border-white/8 bg-[#08131f] p-4 lg:flex lg:flex-col">
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = item.id === view;
              const accent = item.id === 'optimizer';
              return (
                <button
                  key={item.id}
                  onClick={() => setView(item.id)}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition ${
                    active
                      ? accent
                        ? 'bg-violet-300/10 text-violet-200'
                        : 'bg-cyan-300/10 text-cyan-200'
                      : accent
                        ? 'text-violet-300/75 hover:bg-white/5 hover:text-violet-200'
                        : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
                  }`}
                >
                  <Icon className="size-4" /> {item.label}
                </button>
              );
            })}
          </nav>
          <div className="mt-auto rounded-2xl border border-white/8 bg-white/[0.025] p-4">
            <div className="mb-3 flex items-center gap-2 text-xs font-medium text-slate-300">
              <Info className="size-3.5 text-cyan-300" /> 데이터 범위
            </div>
            <p className="text-xs leading-5 text-slate-500">
              AircraftVerse 전체 27,714개 중 현재 로컬 샘플 9,238개를 탐색합니다.
            </p>
            <div className="mt-3 flex items-center gap-2 text-[10px] text-slate-600">
              <span className="size-1.5 rounded-full bg-amber-300" /> CFD 전체 유동장이 아닌 trim 성능 데이터
            </div>
          </div>
        </aside>

        <div className="min-w-0">
          <nav className="flex gap-1 overflow-x-auto border-b border-white/8 bg-[#08131f] px-3 py-2 lg:hidden">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <Button
                  key={item.id}
                  size="sm"
                  variant={view === item.id ? 'secondary' : 'ghost'}
                  onClick={() => setView(item.id)}
                  className={view === item.id ? 'text-cyan-200' : 'text-slate-500'}
                >
                  <Icon /> {item.label}
                </Button>
              );
            })}
          </nav>

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
                  detail={selectedDetail}
                  onSelect={setSelectedId}
                  onOpenSimulator={(id) => selectShowcaseAndOpen(id, 'simulator')}
                  onOpenOptimizer={() => setView('optimizer')}
                />
              )}
              {view === 'simulator' && (
                <SimulatorView
                  designs={showcaseList}
                  selected={selectedDetail ?? showcases['17297']}
                  onSelect={setSelectedId}
                  onOpenLab={() => setView('lab')}
                />
              )}
              {view === 'lab' && (
                <DesignLabView
                  key={selectedDetail?.id ?? 17297}
                  designs={showcaseList}
                  selected={selectedDetail ?? showcases['17297']}
                  onSelect={setSelectedId}
                  onCompare={() => setView('compare')}
                />
              )}
              {view === 'compare' && <CompareView designs={showcaseList} />}
              {view === 'optimizer' && (
                <OptimizerView
                  dataset={dataset}
                  current={selectedDetail ?? showcases['1000']}
                  onCompare={() => setView('compare')}
                />
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function LoadingWorkspace() {
  return (
    <div className="grid min-h-[calc(100vh-64px)] place-items-center px-6">
      <div className="text-center">
        <div className="mx-auto mb-5 grid size-12 place-items-center rounded-2xl border border-cyan-300/20 bg-cyan-300/8">
          <Hexagon className="size-6 animate-pulse text-cyan-300" />
        </div>
        <p className="font-medium text-slate-200">AircraftVerse 인덱스를 준비하고 있습니다</p>
        <p className="mt-2 text-sm text-slate-500">9,238개 설계 메타데이터와 trim curve를 로드합니다.</p>
      </div>
    </div>
  );
}
