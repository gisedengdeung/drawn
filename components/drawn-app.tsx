'use client';

/* oxlint-disable next/no-html-link-for-pages -- Standard anchors avoid Vinext's production Link module export bug. */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  Activity,
  ArrowLeft,
  Beaker,
  Bot,
  Boxes,
  CheckCircle2,
  ChevronDown,
  HelpCircle,
  MapPin,
  Share2,
} from 'lucide-react';

import { DrawnLogo } from '@/components/drawn-logo';
import { CompareView } from '@/components/views/compare-view';
import { DesignLabView } from '@/components/views/design-lab-view';
import { GuideView } from '@/components/views/guide-view';
import { LandingView } from '@/components/views/landing-view';
import { useDesignWorkspace } from '@/hooks/use-design-workspace';
import { useAgentWorkspace } from '@/hooks/use-agent-workspace';
import { usePartsQuoteWorkspace } from '@/hooks/use-parts-quote-workspace';
import { DesignAssistant } from '@/components/agent/design-assistant';
import type { AgentMode, Evidence, Project } from '@/lib/agent/types';
import { GalleryView } from '@/components/views/gallery-view';
import { NearbyFlightSites } from '@/components/views/nearby-flight-sites';
import { isDesignDraft, workspaceStorageKey } from '@/lib/design-gallery';
import { hydrateDraft } from '@/lib/design-draft';
import type { GalleryDetail, WorkspaceSnapshot } from '@/lib/design-gallery';
import { Badge } from '@/components/ui/badge';
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
  EditorTool,
  ShowcaseMap,
  WorkspaceView,
} from '@/lib/drawn-types';

const editorTools = [
  { id: 'design' as const, label: '설계 선택', description: '필터·추천·즐겨찾기에서 기준 설계를 고릅니다.', icon: Boxes },
  { id: 'parameters' as const, label: '파라미터 편집', description: '형상과 부품 수치를 조정해 나만의 기체를 만듭니다.', icon: Beaker },
  { id: 'performance' as const, label: '성능 확인', description: '속도별 예측과 원본 시뮬레이션 곡선을 확인합니다.', icon: Activity },
  { id: 'gallery' as const, label: '공유 갤러리', description: '설계를 게시하거나 다른 설계를 가져옵니다.', icon: Share2 },
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
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantMode, setAssistantMode] = useState<AgentMode>('qa');
  const [partsFocusRequest, setPartsFocusRequest] = useState(0);
  const [focusedParameterId, setFocusedParameterId] = useState<string | undefined>();
  const [chromeOpen, setChromeOpen] = useState(true);
  const [heroDesignId, setHeroDesignId] = useState<number | null>(null);
  const [editorTool, setEditorTool] = useState<EditorTool>('menu');
  const [toolNavigationOpen, setToolNavigationOpen] = useState(true);

  const openEditor = useCallback((tool: EditorTool = 'menu') => {
    setEditorTool(tool);
    setToolNavigationOpen(true);
    setView('lab');
  }, []);

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
    openEditor('parameters');
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
        // 실제 비행 가능(feasible)한 설계 중에서만 골라야 배경이 어색하게 멈춘 형상으로 뜨지 않는다.
        const feasibleIds = index.designs.filter((design) => design.feasible).map((design) => design.id);
        if (feasibleIds.length) setHeroDesignId(feasibleIds[Math.floor(Math.random() * feasibleIds.length)]);
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
        if (sharedId) { setInitialPostId(sharedId); setEditorTool('gallery'); setView('lab'); }
        else if (urlParams.get('view') === 'gallery') { setEditorTool('gallery'); setView('lab'); }
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
  const heroDesign = useMemo<DesignSummary | null>(
    () => (heroDesignId == null ? null : (designById.get(heroDesignId) ?? null)),
    [designById, heroDesignId],
  );
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
  const importAgentProject = useCallback((project: Project) => {
    if (!dataset?.designs.some((design) => design.id === project.draft.baselineId)) {
      throw new Error('현재 데이터셋에서 이 프로젝트의 기준 설계를 찾을 수 없습니다.');
    }
    saveWorkspace({ draft: hydrateDraft(project.draft), sourceId: project.sourceId });
    setSelectedId(project.draft.baselineId);
    setImportVersion((value) => value + 1);
    openEditor('parameters');
    setFocusedParameterId(undefined);
    setWorkspaceNotice(`「${project.title}」 v${project.revision}을 열었습니다.`);
  }, [dataset, openEditor, saveWorkspace]);
  const agentWorkspace = useAgentWorkspace({
    draft: currentDraft,
    sourceId: activeWorkspace?.sourceId ?? null,
    onImport: importAgentProject,
  });
  const partsQuote = usePartsQuoteWorkspace({
    draft: currentDraft,
    userId: agentWorkspace.session?.user?.id ?? null,
    sessionLoading: agentWorkspace.sessionLoading,
    projectId: agentWorkspace.project?.id ?? null,
    runId: agentWorkspace.resultRunId,
    agentQuote: agentWorkspace.result?.context.projectId === agentWorkspace.project?.id
      ? agentWorkspace.displayQuote : null,
    onSaveQuote: agentWorkspace.saveQuote,
    blocked: agentWorkspace.running || agentWorkspace.busy,
  });
  const openPartsAssistant = () => { setAssistantMode('parts'); setAssistantOpen(true); };
  const navigateEvidence = (target: NonNullable<Evidence['target']>) => {
    // Historical parts evidence opens its quote without replacing the edited design.
    if (target.view === 'parts') {
      openPartsAssistant();
      setPartsFocusRequest((value) => value + 1);
      return;
    }
    if (target.designId != null && designById.has(target.designId)) setSelectedId(target.designId);
    setFocusedParameterId(target.parameterId);
    if (target.view === 'explore') openEditor('design');
    else if (target.view === 'simulator') openEditor('performance');
    else if (target.view === 'gallery') openEditor('gallery');
    else if (target.view === 'lab') openEditor('parameters');
    else setView(target.view);
  };
  const showcaseList = useMemo(
    () =>
      dataset?.summary.showcaseIds
        .map((id) => showcases[String(id)])
        .filter((design) => Boolean(design)) ?? [],
    [dataset, showcases],
  );
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
        {view === 'guide' && (
        <header className="sticky top-3 z-50 mx-3 mb-3 lg:mx-4">
          <div className="mx-auto max-w-[1720px] overflow-hidden rounded-2xl border border-[#e5e5ea] bg-white/92 shadow-lg backdrop-blur-xl">
            <div className="flex h-14 items-center gap-4 px-4 lg:px-6">
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

              {chromeOpen && (
                <>
                  <div className="hidden h-5 w-px bg-[#e5e5ea] sm:block" />
                  <div className="hidden items-center gap-1.5 text-xs text-[#6e6e73] sm:flex">
                    <CheckCircle2 className="size-3.5 text-emerald-600" />
                    AircraftVerse{' '}
                    {dataset ? dataset.summary.localDesigns.toLocaleString() : '…'}개
                    준비됨
                  </div>
                </>
              )}

              <div className="ml-auto flex items-center gap-2">
                {chromeOpen && (
                  <>
                    <button type="button" onClick={() => setAssistantOpen((value) => !value)} aria-expanded={assistantOpen} aria-controls="design-assistant-panel" aria-label={assistantOpen ? '설계 도우미 AI 닫기' : '설계 도우미 AI 열기'} className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-2 text-xs font-medium transition ${assistantOpen ? 'bg-[#eff6ff] text-[#3182f6]' : 'bg-[#f5f5f7] text-[#3c3c43] hover:bg-[#ececee]'}`}><Bot className="size-4" /><span className="hidden sm:inline">설계 도우미 AI</span></button>
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
                    {/* Document navigation avoids the current Vinext production Link/prefetch export bug. */}
                    <a href="/packages" className="shrink-0 rounded-full bg-[#3182f6] px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-[#1b64da]">
                      패키지 상품
                    </a>
                    <Badge variant="outline" className="hidden border-transparent bg-[#f5f5f7] text-[10px] text-[#6e6e73] sm:inline-flex">
                      파라메트릭 27,714개 · 원본 STL 12개
                    </Badge>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setChromeOpen((value) => !value)}
                  aria-expanded={chromeOpen}
                  aria-label={chromeOpen ? '메뉴 접기' : '메뉴 펼치기'}
                  className="flex shrink-0 items-center justify-center rounded-full bg-[#f5f5f7] p-2 text-[#6e6e73] transition hover:bg-[#ececee]"
                >
                  <ChevronDown className={`size-3.5 transition-transform ${chromeOpen ? '' : '-rotate-90'}`} />
                </button>
              </div>
            </div>
          </div>
        </header>
        )}

      <div className={`flex items-start ${view === 'lab' ? 'w-full max-w-none' : 'mx-auto max-w-[1720px]'}`}>
      <div className={`min-w-0 flex-1 ${view === 'home' || view === 'lab' ? 'min-h-screen' : 'min-h-[calc(100vh-72px)]'}`}>
          {workspaceNotice && <output className="m-4 flex items-start justify-between gap-4 rounded-lg border border-[#bfdbfe] bg-[#eff6ff] p-3 text-xs text-[#1b64da]"><span>{workspaceNotice}</span><button type="button" onClick={() => setWorkspaceNotice('')} className="shrink-0 underline">닫기</button></output>}
          {error ? (
            <div className="m-6 rounded-2xl border border-rose-400/20 bg-rose-400/8 p-8 text-rose-200">
              <p className="font-medium">데이터를 불러오지 못했습니다.</p>
              <p className="mt-2 text-sm text-rose-200/70">{error}</p>
            </div>
          ) : !dataset || showcaseList.length === 0 ? (
            view === 'home' ? (
              <LandingView
                onStart={() => openEditor('menu')}
                onOpenGuide={() => setView('guide')}
              />
            ) : <LoadingWorkspace />
          ) : (
            <>
              {view === 'lab' && selectedSummary && (
                <div className="relative h-screen min-h-[560px] overflow-hidden">
                  <DesignLabView
                    key={`${selectedSummary.id}-${importVersion}`}
                    selected={selectedSummary}
                    referenceDesign={selectedDetail}
                    datasetDesigns={dataset.designs}
                    showcases={showcases}
                    onSelect={setSelectedId}
                    onOpenDatasetCompare={() => openCompareFromExplorer(selectedSummary.id)}
                    workspace={designWorkspace}
                    focusedParameterId={focusedParameterId}
                    onOpenParts={openPartsAssistant}
                    activeTool={editorTool}
                    onCloseTool={() => {
                      setEditorTool('menu');
                      setToolNavigationOpen(true);
                    }}
                  />

                  <EditorToolNavigation
                    active={editorTool}
                    open={toolNavigationOpen}
                    onOpenChange={setToolNavigationOpen}
                    onSelect={(tool) => {
                      setEditorTool((current) => current === tool ? 'menu' : tool);
                    }}
                    onHome={() => setView('home')}
                    onOpenAssistant={() => setAssistantOpen(true)}
                  />

                  {editorTool === 'gallery' && (
                    <div className="absolute inset-0 z-30 overflow-y-auto bg-[#f5f5f7]/96 backdrop-blur-xl">
                      <button type="button" onClick={() => { setEditorTool('menu'); setToolNavigationOpen(true); }} className="fixed left-3 top-3 z-40 flex items-center gap-1.5 rounded-xl border border-[#e5e5ea] bg-white/94 px-3 py-2 text-xs font-semibold text-[#3c3c43] shadow-lg backdrop-blur-xl hover:bg-white">
                        <ArrowLeft className="size-4" /> 갤러리 닫기
                      </button>
                      <GalleryView
                        current={selectedSummary}
                        workspace={activeWorkspace}
                        initialPostId={initialPostId}
                        onReuse={reuseDesign}
                      />
                    </div>
                  )}
                </div>
              )}
              {view === 'guide' && <GuideView onBack={() => setView('home')} />}
              {view === 'home' && (
                <LandingView
                  heroDesign={heroDesign}
                  onStart={() => openEditor('menu')}
                  onOpenGuide={() => setView('guide')}
                />
              )}
            </>
          )}
        </div>

        <DesignAssistant
          open={assistantOpen}
          onOpenChange={setAssistantOpen}
          mode={assistantMode}
          onModeChange={setAssistantMode}
          controller={agentWorkspace}
          partsQuote={partsQuote}
          partsFocusRequest={partsFocusRequest}
          draftLoading={!dataset || designWorkspace.loading}
          loadError={designWorkspace.loadError}
          draft={currentDraft}
          onNavigate={navigateEvidence}
          onCompare={(id) => { if (selectedId != null) openCompare(selectedId, id); }}
        />
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

function EditorToolNavigation({
  active,
  open,
  onOpenChange,
  onSelect,
  onHome,
  onOpenAssistant,
}: {
  active: EditorTool;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (tool: EditorTool) => void;
  onHome: () => void;
  onOpenAssistant: () => void;
}) {
  if (!open) {
    return (
      <button type="button" onClick={() => onOpenChange(true)} aria-label="편집 메뉴 펼치기" className="absolute bottom-3 left-1/2 z-50 grid size-10 -translate-x-1/2 place-items-center rounded-full border border-[#e5e5ea] bg-white/94 text-[#3182f6] shadow-lg backdrop-blur-xl hover:bg-white">
        <ChevronDown className="size-4 rotate-180" />
      </button>
    );
  }

  return (
    <nav aria-label="편집 도구" className="absolute bottom-3 left-1/2 z-50 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-2xl border border-[#e5e5ea] bg-white/94 p-1.5 shadow-xl backdrop-blur-xl">
      <button type="button" onClick={onHome} aria-label="랜딩으로 돌아가기" className="grid size-9 shrink-0 place-items-center rounded-xl hover:bg-[#f5f5f7]">
        <DrawnLogo className="size-7 rounded-lg" />
      </button>
      <span className="mx-1 h-5 w-px shrink-0 bg-[#e5e5ea]" />
      {editorTools.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onSelect(id)}
          aria-current={active === id ? 'page' : undefined}
          className={`flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition ${active === id ? 'bg-[#1d1d1f] text-white shadow-sm' : 'text-[#6e6e73] hover:bg-[#f5f5f7] hover:text-[#1d1d1f]'}`}
        >
          <Icon className={`size-3.5 ${active === id ? 'text-[#60a5fa]' : ''}`} />
          {label}
        </button>
      ))}
      <span className="mx-1 h-5 w-px shrink-0 bg-[#e5e5ea]" />
      <button type="button" onClick={onOpenAssistant} className="flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold text-[#3182f6] hover:bg-[#eff6ff]">
        <Bot className="size-3.5" /> AI 도우미
      </button>
      <button type="button" onClick={() => onOpenChange(false)} aria-label="편집 메뉴 접기" className="grid size-9 shrink-0 place-items-center rounded-xl text-[#6e6e73] hover:bg-[#f5f5f7] hover:text-[#1d1d1f]">
        <ChevronDown className="size-4" />
      </button>
    </nav>
  );
}

function LoadingWorkspace() {
  return (
    <div className="grid min-h-[calc(100vh-127px)] place-items-center px-6">
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
