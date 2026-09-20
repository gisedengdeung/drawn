'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import Link from 'next/link';
import {
  Activity,
  Beaker,
  Boxes,
  CheckCircle2,
  HelpCircle,
  MapPin,
  Share2,
  ShoppingBag,
} from 'lucide-react';

import { CompareView } from '@/components/views/compare-view';
import { DesignLabView } from '@/components/views/design-lab-view';
import { ExplorerView } from '@/components/views/explorer-view';
import { GuideView } from '@/components/views/guide-view';
import { LandingView } from '@/components/views/landing-view';
import { SimulatorView } from '@/components/views/simulator-view';
import { PartsAgentView } from '@/components/views/parts-agent-view';
import { useDesignWorkspace } from '@/hooks/use-design-workspace';
import { GalleryView } from '@/components/views/gallery-view';
import { NearbyFlightSites } from '@/components/views/nearby-flight-sites';
import { DrawnLogo } from '@/components/drawn-logo';
import { isDesignDraft, workspaceStorageKey } from '@/lib/design-gallery';
import { hydrateDraft } from '@/lib/design-draft';
import type { GalleryDetail, WorkspaceSnapshot } from '@/lib/design-gallery';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { TooltipProvider } from '@/components/ui/tooltip';
import type {
  DatasetIndex,
  DesignDraft,
  DesignSummary,
  ShowcaseMap,
  WorkspaceView,
} from '@/lib/drawn-types';

const navItems = [
  { id: 'explore' as const, step: 1, label: '설계 선택', short: '탐색', icon: Boxes },
  { id: 'lab' as const, step: 2, label: '파라미터 편집', short: '편집', icon: Beaker },
  { id: 'simulator' as const, step: 3, label: '성능 확인', short: '성능', icon: Activity },
  { id: 'gallery' as const, step: 4, label: '공유 갤러리', short: '공유', icon: Share2 },
  { id: 'parts' as const, step: 5, label: '부품 agent', short: '부품 agent', icon: ShoppingBag },
];

export function DrawnApp() {
  const [view, setView] = useState<WorkspaceView>('home');
  const [dataset, setDataset] = useState<DatasetIndex | null>(null);
  const [showcases, setShowcases] = useState<ShowcaseMap>({});
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [comparePair, setComparePair] = useState<{
    aId: number;
    bId: number;
  } | null>(null);
  const [compareDialogOpen, setCompareDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [workspaceNotice, setWorkspaceNotice] = useState('');
  const [initialPostId, setInitialPostId] = useState<string | null>(null);
  const [importVersion, setImportVersion] = useState(0);

  const saveWorkspace = useCallback((snapshot: WorkspaceSnapshot) => {
    setWorkspace(snapshot);
    try { localStorage.setItem(workspaceStorageKey, JSON.stringify(snapshot)); }
    catch { setWorkspaceNotice('브라우저 저장 공간이 부족해 새로고침하면 편집 내용이 사라질 수 있습니다. 갤러리에 게시해 보관해 주세요.'); }
  }, []);
  const onDraftChange = useCallback<Dispatch<SetStateAction<DesignDraft | null>>>((update) => {
    setWorkspace((current) => {
      const draft = typeof update === 'function' ? update(current?.draft ?? null) : update;
      if (!draft) return null;
      return { draft, sourceId: current?.draft.baselineId === draft.baselineId ? current.sourceId : null };
    });
  }, []);

  const reuseDesign = (post: GalleryDetail) => {
    if (!isDesignDraft(post.draft) || !dataset?.designs.some((design) => design.id === post.baselineId)) {
      throw new Error('현재 데이터셋에서 이 설계의 기준 데이터를 찾을 수 없습니다.');
    }
    saveWorkspace({ draft: hydrateDraft(post.draft), sourceId: post.id });
    setSelectedId(post.baselineId);
    setImportVersion((value) => value + 1);
    setView('lab');
    setWorkspaceNotice(`“${post.title}” 설계를 가져왔습니다. 복사본을 편집 중이며 원본 게시물은 유지됩니다.`);
  };

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch('/data/design-index.json').then((response) => {
        if (!response.ok) throw new Error('설계 인덱스를 불러오지 못했습니다.');
        return response.json() as Promise<DatasetIndex>;
      }),
      fetch('/data/showcase-designs.json').then((response) => {
        if (!response.ok)
          throw new Error('시연 설계 데이터를 불러오지 못했습니다.');
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
        const secondId =
          showcaseIds.find((id) => id !== index.summary.defaultShowcaseId) ??
          index.summary.defaultShowcaseId;
        setDataset(index);
        setShowcases(showcaseData);
        setSelectedId(index.summary.defaultShowcaseId);
        try {
          const stored = localStorage.getItem(workspaceStorageKey);
          const restored = stored ? JSON.parse(stored) as WorkspaceSnapshot : null;
          if (restored && isDesignDraft(restored.draft) && index.designs.some((design) => design.id === restored.draft.baselineId)) {
            setWorkspace({ draft: hydrateDraft(restored.draft), sourceId: typeof restored.sourceId === 'string' ? restored.sourceId : null });
            setSelectedId(restored.draft.baselineId);
          }
        } catch { setWorkspaceNotice('이전에 저장한 편집 내용을 읽지 못해 기본 설계로 열었습니다.'); }
        const urlParams = new URLSearchParams(window.location.search);
        const sharedId = urlParams.get('gallery');
        if (sharedId) { setInitialPostId(sharedId); setView('gallery'); }
        else if (urlParams.get('view') === 'gallery') setView('gallery');
        setComparePair({ aId: index.summary.defaultShowcaseId, bId: secondId });
      })
      .catch((reason: unknown) => {
        if (active)
          setError(
            reason instanceof Error ? reason.message : '데이터 로딩 오류',
          );
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
    () => (selectedId == null ? null : (designById.get(selectedId) ?? null)),
    [designById, selectedId],
  );
  const selectedDetail =
    selectedId == null ? null : (showcases[String(selectedId)] ?? null);
  const designWorkspace = useDesignWorkspace(
    selectedSummary, selectedDetail, workspace?.draft ?? null, importVersion, onDraftChange,
  );
  const currentDraft = designWorkspace.draft;
  const activeWorkspace = useMemo<WorkspaceSnapshot | null>(() => currentDraft ? {
    draft: currentDraft,
    sourceId: workspace?.draft.baselineId === currentDraft.baselineId ? workspace.sourceId : null,
  } : workspace, [currentDraft, workspace]);

  useEffect(() => {
    if (!activeWorkspace) return;
    let active = true;
    // Schedule serialization outside the render/interaction path; only failures update UI state.
    void Promise.resolve().then(() => {
      if (active) localStorage.setItem(workspaceStorageKey, JSON.stringify(activeWorkspace));
    }).catch(() => {
      if (active) setWorkspaceNotice('브라우저 저장 공간이 부족해 새로고침하면 편집 내용이 사라질 수 있습니다. 갤러리에 게시해 보관해 주세요.');
    });
    return () => { active = false; };
  }, [activeWorkspace]);
  const showcaseList = useMemo(
    () =>
      dataset?.summary.showcaseIds
        .map((id) => showcases[String(id)])
        .filter((design) => Boolean(design)) ?? [],
    [dataset, showcases],
  );
  const labSelectorDesigns = useMemo(() => {
    if (
      !selectedSummary ||
      showcaseList.some((design) => design.id === selectedSummary.id)
    )
      return showcaseList;
    return [selectedSummary, ...showcaseList];
  }, [selectedSummary, showcaseList]);

  const selectShowcaseAndOpen = (id: number, nextView: WorkspaceView) => {
    setSelectedId(id);
    setView(nextView);
  };

  const openCompare = (aId: number, bId: number) => {
    if (!designById.has(aId) || !designById.has(bId)) return;
    setComparePair({ aId, bId });
    setCompareDialogOpen(true);
  };

  const openCompareFromExplorer = (aId: number, preferredBId?: number) => {
    const existingB = comparePair?.bId;
    const bId =
      preferredBId != null && preferredBId !== aId && designById.has(preferredBId)
        ? preferredBId
        : existingB && existingB !== aId && designById.has(existingB)
          ? existingB
          : dataset?.summary.showcaseIds.find((id) => id !== aId);
    if (bId != null) openCompare(aId, bId);
  };

  return (
    <TooltipProvider delay={200}>
      <main className="workspace-light min-h-screen bg-[#f5f5f7] text-[#1d1d1f]">
        <header className="sticky top-0 z-50 border-b border-[#e5e5ea] bg-white/80 backdrop-blur-xl">
          <div className="mx-auto flex h-14 max-w-[1720px] items-center gap-4 px-4 lg:px-6">
            <button
              onClick={() => setView('home')}
              className="flex min-w-0 items-center gap-2.5 text-left"
            >
              <DrawnLogo className="size-8 shrink-0 rounded-lg shadow-sm" />
              <div>
                <p className="text-sm font-semibold tracking-[-0.02em] text-[#1d1d1f]">
                  Drawn
                </p>
                <p className="hidden text-[10px] font-medium tracking-[0.02em] text-[#86868b] sm:block">
                  UAV 설계 워크벤치
                </p>
              </div>
            </button>

            <div className="hidden h-5 w-px bg-[#e5e5ea] sm:block" />
            <div className="hidden items-center gap-1.5 text-xs text-[#6e6e73] sm:flex">
              <CheckCircle2 className="size-3.5 text-emerald-600" />
              AircraftVerse{' '}
              {dataset ? dataset.summary.localDesigns.toLocaleString() : '…'}개
              준비됨
            </div>

            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => setView('guide')}
                aria-current={view === 'guide' ? 'page' : undefined}
                className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-2 text-xs font-medium transition ${
                  view === 'guide'
                    ? 'bg-[#eff6ff] text-[#3182f6]'
                    : 'bg-[#f5f5f7] text-[#3c3c43] hover:bg-[#ececee]'
                }`}
              >
                <HelpCircle className="size-3.5" /> <span className="hidden sm:inline">가이드</span>
              </button>
              <Popover>
                <PopoverTrigger className="flex shrink-0 items-center gap-1.5 rounded-full bg-[#f5f5f7] px-3 py-2 text-xs font-medium text-[#3c3c43] transition hover:bg-[#ececee]">
                  <MapPin className="size-3.5 text-[#3182f6]" />
                  <span className="hidden sm:inline">주변 비행지</span>
                </PopoverTrigger>
                <PopoverContent align="end" sideOffset={8} className="w-[min(22rem,calc(100vw-32px))] bg-white p-4 text-[#1d1d1f] shadow-xl">
                  <NearbyFlightSites />
                </PopoverContent>
              </Popover>
              <Link href="/packages" className="shrink-0 rounded-full bg-[#3182f6] px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-[#1b64da]">
                패키지 상품
              </Link>
              <Badge variant="outline" className="hidden border-transparent bg-[#f5f5f7] text-[10px] text-[#6e6e73] sm:inline-flex">
                파라메트릭 27,714개 · 원본 STL 12개
              </Badge>
            </div>
          </div>

          <nav className="mx-auto max-w-[1720px] px-2 pb-2.5 lg:px-4" aria-label="설계 작업 단계">
            <div className="flex items-center gap-0.5 overflow-x-auto rounded-xl bg-[#f5f5f7] p-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = item.id === view;
                return (
                  <button
                    key={item.id}
                    onClick={() => setView(item.id)}
                    aria-current={active ? 'page' : undefined}
                    className={`flex min-w-fit flex-1 items-center justify-center gap-1.5 rounded-[10px] px-2 py-1.5 text-xs font-medium transition sm:px-3 lg:text-sm ${
                      active
                        ? 'bg-white text-[#1d1d1f] shadow-sm'
                        : 'text-[#6e6e73] hover:text-[#1d1d1f]'
                    }`}
                  >
                    <Icon className={`size-3.5 ${active ? 'text-[#3182f6]' : ''}`} />
                    <span className="hidden sm:inline">{item.label}</span>
                    <span className="sm:hidden">{item.short}</span>
                  </button>
                );
              })}
            </div>
          </nav>
        </header>

      <div className="mx-auto min-h-[calc(100vh-103px)] max-w-[1720px] min-w-0">
          {workspaceNotice && <output className="m-4 flex items-start justify-between gap-4 rounded-lg border border-[#bfdbfe] bg-[#eff6ff] p-3 text-xs text-[#1b64da]"><span>{workspaceNotice}</span><button type="button" onClick={() => setWorkspaceNotice('')} className="shrink-0 underline">닫기</button></output>}
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
                  onOpenSimulator={(id) =>
                    selectShowcaseAndOpen(id, 'simulator')
                  }
                  onOpenCompare={openCompareFromExplorer}
                  onOpenGuide={() => setView('guide')}
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
                  title="성능 확인"
                  selectedId={selectedId}
                  defaultId={dataset.summary.defaultShowcaseId}
                  onChoose={(id) => selectShowcaseAndOpen(id, 'simulator')}
                />
              )}
              {view === 'lab' && selectedSummary && (
                <DesignLabView
                  key={`${selectedSummary.id}-${importVersion}`}
                  designs={labSelectorDesigns}
                  selected={selectedSummary}
                  referenceDesign={selectedDetail}
                  datasetDesigns={dataset.designs}
                  onSelect={setSelectedId}
                  onOpenDatasetCompare={() => openCompareFromExplorer(selectedSummary.id)}
                  workspace={designWorkspace}
                  onOpenParts={() => setView('parts')}
                />
              )}
              {view === 'gallery' && (
                <GalleryView
                  current={selectedSummary ?? designById.get(dataset.summary.defaultShowcaseId)!}
                  workspace={activeWorkspace}
                  initialPostId={initialPostId}
                  onReuse={reuseDesign}
                />
              )}
              <div hidden={view !== 'parts'}>
                <PartsAgentView
                  draft={designWorkspace.draft}
                  disabled={designWorkspace.loading}
                  selectedDesignId={selectedId}
                  loadError={designWorkspace.loadError}
                  onOpenDesign={() => setView('lab')}
                />
              </div>
              {view === 'guide' && <GuideView onBack={() => setView('explore')} />}
              {view === 'home' && (
                <LandingView
                  onStart={() => setView('explore')}
                  onOpenGuide={() => setView('guide')}
                />
              )}
            </>
          )}
        </div>

        <Dialog open={compareDialogOpen && Boolean(dataset && comparePair)} onOpenChange={setCompareDialogOpen}>
          <DialogContent className="max-h-[92vh] overflow-y-auto border-[#e5e5ea] bg-[#f5f5f7] p-5 text-[#1d1d1f] sm:max-w-[1180px]">
            <DialogHeader>
              <DialogTitle className="text-xl">설계 비교</DialogTitle>
              <DialogDescription>설계 구성의 차이를 먼저 확인한 뒤 AircraftVerse 성능 결과를 같은 단위로 비교합니다.</DialogDescription>
            </DialogHeader>
            {dataset && comparePair && (
              <CompareView
                dataset={dataset}
                showcases={showcases}
                pair={comparePair}
                onPairChange={setComparePair}
              />
            )}
          </DialogContent>
        </Dialog>
      </main>
    </TooltipProvider>
  );
}

function LoadingWorkspace() {
  return (
    <div className="grid min-h-[calc(100vh-103px)] place-items-center px-6">
      <div className="text-center">
        <div className="mx-auto mb-5 grid size-12 place-items-center rounded-xl border border-[#b9dce3] bg-[#eef8fa]">
          <DrawnLogo className="size-7" />
        </div>
        <p className="font-medium text-[#3c3c43]">
          AircraftVerse 인덱스를 준비하고 있습니다
        </p>
        <p className="mt-2 text-sm text-[#6e6e73]">
          27,714개 설계 메타데이터와 대표 성능 곡선을 불러옵니다.
        </p>
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
        <Boxes className="mx-auto mb-4 size-8 text-[#3182f6]" />
        <h1 className="text-lg font-semibold text-[#1d1d1f]">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-[#6e6e73]">
          Design #{selectedId ?? '—'}는 metadata-only 설계라 STL과 trim 곡선이
          패키징되지 않았습니다.
        </p>
        <Button
          onClick={() => onChoose(defaultId)}
          className="mt-5 bg-[#3182f6] text-white hover:bg-[#1b64da]"
        >
          대표 설계 #{defaultId} 선택
        </Button>
      </div>
    </section>
  );
}
