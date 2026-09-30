'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  BatteryCharging,
  Box,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  CircleGauge,
  Database,
  Gauge,
  GitCompareArrows,
  Info,
  Layers3,
  Lock,
  Package,
  Plane,
  RotateCcw,
  Ruler,
  SlidersHorizontal,
  ShoppingBag,
  Timer,
  Unlock,
  Weight,
  Wind,
  X,
  Zap,
} from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  XAxis,
  YAxis,
} from 'recharts';

import { PerformancePredictionPanel } from './performance-prediction-panel';
import { ParametricUavViewer, TYPE_COLORS } from '@/components/parametric-uav-viewer';
import { DesignPicker } from '@/components/design-picker';
import { StlViewer } from '@/components/stl-viewer';
import { cloneDraft } from '@/lib/design-draft';
import { countChanges, estimateDraft } from '@/lib/design-performance';
import type { DesignWorkspace } from '@/hooks/use-design-workspace';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type {
  AssemblyInfo,
  DesignDraft,
  DesignSummary,
  DraftGeometryMode,
  EditorTool,
  ParameterDefinition,
  ParameterGroup,
  PartPlacement,
  ShowcaseDesign,
  ShowcaseMap,
  TrimRow,
  WingParameters,
} from '@/lib/drawn-types';
import { formatBatteryLabel, formatComponent, formatEnergyConfiguration, formatMetric, formatMotorLabel, formatPropellerLabel, isAvailableMetric, percentChange } from '@/lib/drawn-types';
import { formatValidSpeedRanges, type PerformancePrediction, type PerformanceResult } from '@/lib/performance-client';
import { DataDisclaimer } from '@/components/views/shared';
import { copyViewerCamera } from '@/lib/viewer-camera-sync';

type MobilePanel = 'parameters' | 'preview' | 'performance';
type BaselineCompareView = 'baseline' | 'draft' | 'dual';
type PerformanceSource = 'ai' | 'dataset';

const GROUP_LABELS: Record<ParameterGroup, string> = {
  structure: '기체 구조',
  fuselage: '동체',
  propulsion: '추진 시스템',
  energy: '전력 시스템',
  payload: '탑재 중량',
  wing: '날개',
  layout: '내부 배치',
};

/** 그룹별 물음표 툴팁 설명. GuideView의 초심자용 설명과 같은 톤으로 씁니다. */
const GROUP_HINTS: Record<ParameterGroup, string> = {
  structure: '허브에 연결된 팔(Arm)의 길이·각도예요. 팔이 길면 프로펠러끼리 간섭이 줄어 안정적이지만, 무게와 항력이 늘어 속도·비행거리엔 불리할 수 있어요.',
  fuselage: '몸통(동체)의 길이와 지름이에요. 크면 부품을 더 튼튼하게 담을 수 있지만, 무게와 항력이 늘어 비행거리·속도엔 불리해요.',
  propulsion: '추력을 만드는 모터와 프로펠러예요. 크고 강력할수록 무거운 짐을 들거나 빠르게 날 수 있지만, 무게와 소비전력도 함께 늘어나요. (KV=모터가 1V당 도는 회전수로 낮으면 힘·높으면 속도 위주, 프로펠러는 지름×피치를 인치로 표기)',
  energy: '배터리 용량·구성이에요. 크면 더 오래 날 수 있지만, 배터리 자체 무게 때문에 어느 지점을 넘으면 오히려 비행시간이 늘지 않을 수 있어요. (S=직렬로 연결된 셀 수로 전압을 결정, C=순간적으로 낼 수 있는 최대 방전 속도)',
  payload: '드론이 실어 나르는 화물의 무게예요. 늘리면 실을 수 있는 짐은 많아지지만, 그만큼 비행거리·체공시간이 줄어들어요.',
  wing: '날개는 프로펠러 힘 없이도 양력을 얻게 해줘서 같은 배터리로 더 멀리·오래 날 수 있게 해줘요. 대신 제자리 비행(호버링)은 어려워져요.',
  layout: '센서·배터리 같은 내부 부품의 배치 위치예요. 무게중심에 영향을 줄 수 있지만, 데이터셋 성능 점수 계산에는 반영되지 않는 참조용 값이에요.',
};

const EXPERT_MODE_STORAGE_KEY = 'aerotwin:design-lab-expert-mode';

export function DesignLabView({
  selected,
  referenceDesign,
  datasetDesigns = [],
  showcases = {},
  onSelect,
  onOpenDatasetCompare,
  onOpenParts,
  workspace,
  focusedParameterId,
  activeTool = 'parameters',
  onCloseTool,
  suspended = false,
}: {
  selected: DesignSummary;
  referenceDesign?: ShowcaseDesign | null;
  datasetDesigns?: DesignSummary[];
  showcases?: ShowcaseMap;
  onSelect: (id: number) => void;
  onOpenDatasetCompare: () => void;
  onOpenParts: () => void;
  workspace: DesignWorkspace;
  focusedParameterId?: string | null;
  activeTool?: EditorTool;
  onCloseTool?: () => void;
  /** 상위 전체 화면 보드에 가려진 동안 배경 WebGL 렌더링을 멈춘다. */
  suspended?: boolean;
}) {
  const { baseline, draft, setDraft, catalogs, placements, loading, loadError } = workspace;
  const [mode, setMode] = useState<DraftGeometryMode>('parametric-preview');
  const [showGhost, setShowGhost] = useState(false);
  const [changedGroup, setChangedGroup] = useState<ParameterGroup | null>(null);
  const [openSections, setOpenSections] = useState<string[]>(['structure', 'fuselage', 'propulsion']);
  const [expertMode, setExpertMode] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('preview');
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareDetailsOpen, setCompareDetailsOpen] = useState(true);
  const [baselineCompareView, setBaselineCompareView] = useState<BaselineCompareView>('dual');
  const [baselineCameraLinked, setBaselineCameraLinked] = useState(true);
  /** 부품 탭에서 고른 부품 이름들. 3D에서는 이것만 제 색으로 남는다. */
  const [selectedParts, setSelectedParts] = useState<string[]>([]);
  const [openTypes, setOpenTypes] = useState<string[]>([]);
  /** 프로펠러 날개 수는 데이터에 없어 보는 사람이 고르는 표시 설정이다. */
  const [bladeCount, setBladeCount] = useState<2 | 4>(2);
  /**
   * 개념 형상과 원본 STL을 나란히 둔다. 겹쳐 그리면 회색끼리 묻혀서 어느 쪽이
   * 무엇인지 읽기 어려웠다. 원본은 로컬에 있을 때만 뜬다.
   */
  const [sideBySide, setSideBySide] = useState(false);
  const [cameraLinked, setCameraLinked] = useState(true);
  const [viewerToolbarOpen, setViewerToolbarOpen] = useState(true);
  /** 왼쪽 패널 탭. 부품 목록이 파라미터 아코디언에 끼면 매번 밀려 내려간다. */
  const [panelTab, setPanelTab] = useState<'design' | 'parameters' | 'parts'>('parameters');
  // 아일랜드는 3D 위에 떠 있으므로 접어서 화면을 완전히 비울 수 있어야 한다.
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  // 설계를 고르면 현재 3D에 반영된 파라메트릭 모델 정보를 오른쪽에 바로 보여준다.
  const [modelInfoHiddenFor, setModelInfoHiddenFor] = useState<number | null>(null);
  // 성능 확인 탭에서 흡수한 속도별 시트. AI 예측과 같은 speed를 공유해 한 값으로 본다.
  const [chartsOpen, setChartsOpen] = useState(false);
  const [speed, setSpeed] = useState(20);
  const [aiPredictionOpen, setAiPredictionOpen] = useState(false);
  const [performanceSource, setPerformanceSource] = useState<PerformanceSource>('ai');
  const [sideViewLocked, setSideViewLocked] = useState(false);
  const [sideViewResetKey, setSideViewResetKey] = useState(0);
  /** 선택한 속도의 AI 출력. STL이 아니라 현재 파라메트릭 형상에만 적용한다. */
  const [aiFlightState, setAiFlightState] = useState<PerformancePrediction | null>(null);
  const [aiPerformanceResult, setAiPerformanceResult] = useState<PerformanceResult | null>(null);
  const [estimateState, setEstimateState] = useState<'ready' | 'calculating'>('ready');
  const [estimateImpact, setEstimateImpact] = useState<'performance' | 'geometry-only'>('performance');
  const highlightTimeoutRef = useRef<number | null>(null);
  const estimateTimeoutRef = useRef<number | null>(null);
  const aiPredictionPanelRef = useRef<HTMLDivElement>(null);
  const packagedReference = referenceDesign ?? ('modelPath' in selected ? selected as ShowcaseDesign : null);
  const originalTrimAvailable = Boolean(packagedReference?.trim.some((row) => row.valid));
  const originalTrimRow = packagedReference?.trim.find((row) => row.speed === speed) ?? null;
  // 배포된 STL이 없어도 개발 PC의 원본에서 받아올 수 있다.
  const originalStlUrl = packagedReference?.modelPath ?? `/local-model/${selected.id}`;
  const comparisonCameraGroup = `design-compare-${selected.id}`;
  const baselineComparisonCameraGroup = `baseline-draft-${selected.id}`;

  const focusedParameter = draft?.parameterDefinitions.find((definition) => definition.id === focusedParameterId || definition.path === focusedParameterId);
  const focusId = focusedParameter?.id;
  useEffect(() => {
    if (!focusId) return;
    let scrollFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      setExpertMode(true);
      setMobilePanel('parameters');
      setOpenSections((sections) => sections.includes('source-parameters') ? sections : [...sections, 'source-parameters']);
      scrollFrame = window.requestAnimationFrame(() => {
        const control = document.getElementById(`source-parameter-${encodeURIComponent(focusId)}`);
        control?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        control?.focus({ preventScroll: true });
      });
    });
    return () => { window.cancelAnimationFrame(frame); window.cancelAnimationFrame(scrollFrame); };
  }, [focusId]);
  useEffect(() => {
    window.queueMicrotask(() => {
      try {
        setExpertMode(localStorage.getItem(EXPERT_MODE_STORAGE_KEY) === '1');
      } catch {
        // Storage unavailable — default to easy mode.
      }
    });
  }, []);

  const toggleExpertMode = (next: boolean) => {
    setExpertMode(next);
    try {
      localStorage.setItem(EXPERT_MODE_STORAGE_KEY, next ? '1' : '0');
    } catch {
      // Storage unavailable — the toggle still works for this session only.
    }
  };

  useEffect(() => () => {
    if (highlightTimeoutRef.current != null) window.clearTimeout(highlightTimeoutRef.current);
    if (estimateTimeoutRef.current != null) window.clearTimeout(estimateTimeoutRef.current);
  }, []);

  const markChanged = (group: ParameterGroup, affectsPerformance = true) => {
    setChangedGroup(group);
    setEstimateImpact(affectsPerformance ? 'performance' : 'geometry-only');
    setEstimateState(affectsPerformance ? 'calculating' : 'ready');
    if (highlightTimeoutRef.current != null) window.clearTimeout(highlightTimeoutRef.current);
    highlightTimeoutRef.current = window.setTimeout(() => setChangedGroup(null), 750);
    if (estimateTimeoutRef.current != null) window.clearTimeout(estimateTimeoutRef.current);
    if (affectsPerformance) {
      estimateTimeoutRef.current = window.setTimeout(() => setEstimateState('ready'), 260);
    }
  };

  const mutateDraft = (group: ParameterGroup, mutator: (value: DesignDraft) => void, affectsPerformance = true) => {
    setDraft((current) => {
      if (!current) return current;
      const next = cloneDraft(current);
      mutator(next);
      return next;
    });
    setMode('parametric-preview');
    markChanged(group, affectsPerformance);
  };

  const resetAll = () => {
    if (!baseline) return;
    setDraft(cloneDraft(baseline));
    setChangedGroup(null);
    setEstimateState('ready');
    setEstimateImpact('performance');
  };

  const estimate = useMemo(
    () => draft && baseline ? estimateDraft(selected, draft, baseline, datasetDesigns) : null,
    [baseline, datasetDesigns, draft, selected],
  );
  const changedCount = useMemo(() => draft && baseline ? countChanges(draft, baseline) : 0, [baseline, draft]);
  const differences = useMemo(() => draft && baseline ? draftDifferences(baseline, draft) : [], [baseline, draft]);
  const parameterCount = draft?.parameterDefinitions?.length ?? 0;
  const showLeftPanel = activeTool === 'design' || activeTool === 'parameters';
  const showPerformancePanel = activeTool === 'performance';
  const showViewerControls = showLeftPanel || showPerformancePanel;
  const effectivePanelTab = activeTool === 'design'
    ? 'design'
    : panelTab === 'design' ? 'parameters' : panelTab;
  const showModelInfo = activeTool === 'design' && modelInfoHiddenFor !== selected.id;
  const handlePredictionChange = useCallback((prediction: PerformancePrediction | null) => {
    setAiFlightState(prediction);
  }, []);
  const handlePerformanceResultChange = useCallback((result: PerformanceResult | null) => {
    setAiPerformanceResult(result);
  }, []);
  const closeAiPrediction = useCallback(() => {
    setAiPredictionOpen(false);
    setSideViewLocked(false);
    setChartsOpen(false);
  }, []);
  const showAiPrediction = showPerformancePanel && aiPredictionOpen;
  const showAiFlight = showAiPrediction && aiFlightState !== null;
  const boardUsesOriginal = chartsOpen && performanceSource === 'dataset';
  const showOriginalFlight = showAiPrediction && boardUsesOriginal && Boolean(originalTrimRow?.valid);
  const activeFlightState = boardUsesOriginal
    ? showOriginalFlight ? originalTrimRow : null
    : showAiFlight ? aiFlightState : null;
  const visualizationSource: PerformanceSource = boardUsesOriginal ? 'dataset' : 'ai';
  const activeForces = useMemo(() => activeFlightState ? {
    drag: activeFlightState.drag,
    lift: activeFlightState.lift,
    thrust: activeFlightState.thrust,
  } : undefined, [activeFlightState]);
  useEffect(() => {
    if (!originalTrimAvailable && performanceSource === 'dataset') {
      window.queueMicrotask(() => setPerformanceSource('ai'));
    }
  }, [originalTrimAvailable, performanceSource]);
  useEffect(() => {
    if (!aiPredictionOpen) return;
    const frame = window.requestAnimationFrame(() => {
      aiPredictionPanelRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [aiPredictionOpen]);
  useEffect(() => {
    if (showPerformancePanel || (!aiPredictionOpen && !sideViewLocked)) return;
    window.queueMicrotask(closeAiPrediction);
  }, [aiPredictionOpen, closeAiPrediction, showPerformancePanel, sideViewLocked]);

  return (
    // 3D를 바닥에 깔고 패널을 그 위에 띄운다. 예전에는 3칸 그리드라 뷰어가
    // 가로의 절반도 쓰지 못했다.
    <section className="@container/lab relative h-full min-h-[560px] overflow-hidden">
      <div className="mb-3 hidden">
        {([
          ['parameters', '파라미터', SlidersHorizontal],
          ['preview', '3D', Box],
          ['performance', '성능', Activity],
        ] as const).map(([id, label, Icon]) => (
          <button key={id} aria-pressed={mobilePanel === id} onClick={() => setMobilePanel(id)}>
            <Icon /> {label}
          </button>
        ))}
      </div>

      <div className="h-full">
        {showLeftPanel && <aside
          // bottom-3로 고정 스트레치하지 않고 max-height만 준다 — 섹션 콘텐츠가 짧으면
          // 패널도 그만큼만 차지하고, 길면 이 상한에서 꺾여 안에서 스크롤된다.
          className={`absolute left-3 top-3 z-20 flex w-[310px] flex-col overflow-hidden rounded-2xl border border-[#e5e5ea] bg-white/92 shadow-lg backdrop-blur transition-[max-height] ${
            leftOpen ? 'bottom-3' : 'h-12'
          }`}
        >
          <div className="border-b border-[#e5e5ea] p-2.5">
            <div className="flex items-center justify-between gap-1">
              {onCloseTool && (
                <Button size="icon-sm" variant="ghost" onClick={onCloseTool} aria-label="작업 패널 닫기" className="shrink-0 text-[#6e6e73]">
                  <ArrowLeft />
                </Button>
              )}
              <button
                type="button"
                onClick={() => setLeftOpen((open) => !open)}
                aria-expanded={leftOpen}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <ChevronDown className={`size-4 shrink-0 text-[#86868b] transition-transform ${leftOpen ? '' : '-rotate-90'}`} />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-[#1d1d1f]">{activeTool === 'design' ? '설계 선택' : '설계 파라미터'}</span>
                  {leftOpen && (
                    <span className="mt-0.5 block text-xs text-[#6e6e73]">{activeTool === 'design' ? `기준 설계 #${selected.id}` : changedCount ? `${changedCount}개 변경됨` : 'Baseline과 동일'}</span>
                  )}
                </span>
              </button>
              {leftOpen && activeTool === 'parameters' && (
                <Button size="icon-sm" variant="ghost" onClick={resetAll} disabled={!changedCount} aria-label="전체 초기화" className="text-[#6e6e73]"><RotateCcw /></Button>
              )}
            </div>
            {leftOpen && effectivePanelTab === 'parameters' && (
              <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-[#f5f5f7] px-3 py-2">
                <div>
                  <p className="text-xs font-medium text-[#6e6e73]">전문가 모드</p>
                  <p className="mt-0.5 text-[10px] leading-4 text-[#86868b]">데이터셋 원본 변수 {parameterCount}개를 그대로 편집합니다</p>
                </div>
                <Switch checked={expertMode} onCheckedChange={toggleExpertMode} size="sm" aria-label="전문가 모드" />
              </div>
            )}
            {leftOpen && activeTool === 'parameters' && (
              <div className={`mt-3 grid rounded-xl bg-[#f5f5f7] p-1 ${placements ? 'grid-cols-2' : 'grid-cols-1'}`}>
                {([
                  ['parameters', '파라미터', SlidersHorizontal],
                  ['parts', '부품', Package],
                ] as const)
                  .filter(([id]) => id !== 'parts' || placements)
                  .map(([id, label, Icon]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setPanelTab(id)}
                    aria-pressed={effectivePanelTab === id}
                    className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-semibold transition ${effectivePanelTab === id ? 'bg-white text-[#1d1d1f] shadow-sm' : 'text-[#6e6e73]'}`}
                  >
                    <Icon className={`size-3.5 ${effectivePanelTab === id ? 'text-[#3182f6]' : ''}`} />
                    {label}
                    {id === 'parts' && selectedParts.length > 0 && (
                      <span className="rounded-full bg-[#3182f6] px-1.5 text-[10px] text-white">{selectedParts.length}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {effectivePanelTab === 'design' ? (
            <div className="min-h-0 flex-1 overflow-hidden">
              <DesignPicker
                designs={datasetDesigns}
                showcases={showcases}
                selectedId={selected.id}
                onSelect={(id) => {
                  setSelectedParts([]);
                  onSelect(id);
                }}
                onOpenModelInfo={() => setModelInfoHiddenFor(null)}
              />
            </div>
          ) : (
          <ScrollArea className="min-h-0 flex-1">
            {loading || !draft || !baseline ? (
              <div className="grid h-80 place-items-center text-xs text-[#6e6e73]">설계 파라미터를 준비하고 있습니다…</div>
            ) : effectivePanelTab === 'parts' && placements ? (
              <PartsPanel
                assembly={placements}
                selected={selectedParts}
                onSelect={setSelectedParts}
                openTypes={openTypes}
                onToggleType={(type) => setOpenTypes((current) =>
                  current.includes(type)
                    ? current.filter((item) => item !== type)
                    : [...current, type])}
                search=""
              />
            ) : (
              <Accordion multiple value={openSections} onValueChange={(value) => setOpenSections(value.map(String))} className="px-3 pb-5">
                {(
                  <ParameterSection value="structure" icon={<Layers3 />} title="기체 구조" count={1 + draft.segments.length * 3} hint={GROUP_HINTS.structure}>
                    <ReadOnlyValue label="허브 형태" value={formatComponent(draft.topology)} note="허브(몸통 중심) 형태 변경은 1단계 설계 선택에서 다른 설계를 고르면 됩니다." />
                    {draft.segments.map((segment, index) => (
                      <div key={segment.id} className="rounded-xl bg-[#f5f5f7] p-3">
                        <p className="mb-3 flex items-center justify-between text-xs font-semibold text-[#3c3c43]">
                          팔 {index + 1}<span className="font-normal text-[#6e6e73]">{formatComponent(segment.nodeType)}</span>
                        </p>
                        <NumberSlider label="팔 길이" unit="mm" min={50} max={520} step={1} value={segment.length} baseline={baseline.segments[index]?.length ?? segment.length} onChange={(value) => mutateDraft('structure', (next) => { next.segments[index].length = value; })} />
                        <NumberSlider label="장착 각도" unit="°" min={-135} max={360} step={1} value={segment.angle} baseline={baseline.segments[index]?.angle ?? segment.angle} onChange={(value) => mutateDraft('structure', (next) => { next.segments[index].angle = value; })} geometryOnly />
                        <NumberSlider label="결합 위치 오프셋" unit="mm" min={-50} max={50} step={1} value={segment.offset} baseline={baseline.segments[index]?.offset ?? segment.offset} onChange={(value) => mutateDraft('structure', (next) => { next.segments[index].offset = value; })} geometryOnly />
                      </div>
                    ))}
                  </ParameterSection>
                )}

                {(
                  <ParameterSection value="fuselage" icon={<Box />} title="동체" count={4} hint={GROUP_HINTS.fuselage}>
                    <NumberSlider label="길이" unit="mm" min={84} max={559} step={1} value={draft.fuselage.length} baseline={baseline.fuselage.length} onChange={(value) => mutateDraft('fuselage', (next) => { next.fuselage.length = value; })} />
                    <NumberSlider label="가로 지름" unit="mm" min={120} max={805} step={1} value={draft.fuselage.horizontalDiameter} baseline={baseline.fuselage.horizontalDiameter} onChange={(value) => mutateDraft('fuselage', (next) => { next.fuselage.horizontalDiameter = value; })} />
                    <NumberSlider label="세로 지름" unit="mm" min={51} max={354} step={1} value={draft.fuselage.verticalDiameter} baseline={baseline.fuselage.verticalDiameter} onChange={(value) => mutateDraft('fuselage', (next) => { next.fuselage.verticalDiameter = value; })} />
                    <NumberSlider label="바닥 높이" unit="mm" min={8} max={60} step={0.5} value={draft.fuselage.floorHeight} baseline={baseline.fuselage.floorHeight} onChange={(value) => mutateDraft('fuselage', (next) => { next.fuselage.floorHeight = value; })} geometryOnly />
                  </ParameterSection>
                )}

                {(
                  <ParameterSection value="propulsion" icon={<CircleGauge />} title="추진 시스템" count={draft.propulsionGroups.length * 2} hint={GROUP_HINTS.propulsion}>
                    {draft.propulsionGroups.map((propulsion, index) => (
                      <div key={propulsion.id} className="rounded-xl bg-[#f5f5f7] p-3">
                        <p className="mb-2 text-xs font-semibold text-[#3c3c43]">모터·프로펠러 세트 {index + 1}</p>
                        <ControlSelect label="모터" value={propulsion.motorType} options={catalogs.motors} baseline={baseline.propulsionGroups[index]?.motorType} format={formatMotorLabel} onChange={(value) => mutateDraft('propulsion', (next) => { next.propulsionGroups[index].motorType = value; syncSegmentComponent(next, propulsion.segmentId, 'motorType', value); })} />
                        <ControlSelect label="프로펠러" value={propulsion.propellerType} options={catalogs.propellers} baseline={baseline.propulsionGroups[index]?.propellerType} format={formatPropellerLabel} onChange={(value) => mutateDraft('propulsion', (next) => { next.propulsionGroups[index].propellerType = value; syncSegmentComponent(next, propulsion.segmentId, 'propellerType', value); })} />
                      </div>
                    ))}
                  </ParameterSection>
                )}

                {(
                  <ParameterSection value="energy" icon={<BatteryCharging />} title="전력 시스템" count={draft.energy.batteryTypes.length} hint={GROUP_HINTS.energy}>
                    {draft.energy.batteryTypes.map((battery, index) => (
                      <ControlSelect key={`${index}-${battery}`} label={`배터리 ${index + 1}`} value={battery} options={catalogs.batteries} baseline={baseline.energy.batteryTypes[index]} format={formatBatteryLabel} onChange={(value) => mutateDraft('energy', (next) => { next.energy.batteryTypes[index] = value; })} />
                    ))}
                    <ReadOnlyValue label="배터리 구성" value={formatEnergyConfiguration(draft.energy.configuration)} />
                  </ParameterSection>
                )}

                {draft.wings.length > 0 && (
                  <ParameterSection value="wing" icon={<Plane />} title="날개" count={draft.wings.length * 9} hint={GROUP_HINTS.wing}>
                    {draft.wings.map((wing, index) => (
                      <WingControls key={wing.id} wing={wing} baseline={baseline.wings[index] ?? wing} nacaOptions={catalogs.nacaProfiles} onChange={(mutator) => mutateDraft('wing', (next) => mutator(next.wings[index]))} />
                    ))}
                  </ParameterSection>
                )}

                {(
                  <ParameterSection value="payload" icon={<Weight />} title="탑재 중량" count={1} advanced hint={GROUP_HINTS.payload}>
                    <NumberSlider label="탑재 화물 질량" unit="kg" min={0} max={20} step={0.1} value={draft.payload.mass} baseline={baseline.payload.mass} onChange={(value) => mutateDraft('payload', (next) => { next.payload.mass = value; })} geometryOnly />
                  </ParameterSection>
                )}

                {Object.keys(draft.layout).length > 0 && (
                  <ParameterSection value="layout" icon={<Ruler />} title="내부 배치" count={Object.keys(draft.layout).length * 2} advanced hint={GROUP_HINTS.layout}>
                    {Object.entries(draft.layout).map(([name, position]) => (
                      <div key={name} className="rounded-xl bg-[#f5f5f7] p-3">
                        <p className="mb-2 text-xs font-semibold capitalize text-[#3c3c43]">{formatComponent(name)}</p>
                        <NumberSlider label="X 위치" unit="mm" min={-280} max={280} step={1} value={position.x} baseline={baseline.layout[name]?.x ?? position.x} onChange={(value) => mutateDraft('layout', (next) => { next.layout[name].x = value; }, false)} geometryOnly />
                        <NumberSlider label="Y 위치" unit="mm" min={-280} max={280} step={1} value={position.y} baseline={baseline.layout[name]?.y ?? position.y} onChange={(value) => mutateDraft('layout', (next) => { next.layout[name].y = value; }, false)} geometryOnly />
                      </div>
                    ))}
                  </ParameterSection>
                )}

                {expertMode && (
                <ParameterSection value="source-parameters" icon={<SlidersHorizontal />} title="전문가용 원본 변수" count={parameterCount} advanced hint="AircraftVerse 데이터셋 원본 변수명을 그대로 보여줍니다. 위 친화적 그룹과 같은 값이 다시 나타날 수 있어요 — 대부분은 위에서 조정하는 것만으로 충분하고, 이 목록은 원본 그대로 세밀하게 맞추고 싶을 때만 쓰면 됩니다.">
                  <div className="rounded-xl border border-[#bfdbfe] bg-[#eff6ff] p-3 text-[10px] leading-4 text-[#3c3c43]">
                    설계 원본의 {parameterCount}개 변수를 1:1로 보존합니다. 이름은 데이터셋 원본 표기라 위 그룹보다 낯설 수 있어요. 성능 계산에 쓰이는 변수는 실제로 반영되고, 나머지는 3D 형상에만 반영됩니다.
                  </div>
                  {(draft.parameterDefinitions ?? []).map((definition) => (
                      <div key={definition.id} id={`source-parameter-${encodeURIComponent(definition.id)}`} tabIndex={-1} className="rounded-xl outline-none focus:ring-2 focus:ring-[#3182f6]">
                      <SourceParameterControl
                        definition={definition}
                        nacaOptions={catalogs.nacaProfiles}
                        onChange={(value) => mutateDraft(
                          definition.group,
                          (next) => applySourceParameter(next, definition.id, value),
                          definition.affectsPerformance,
                        )}
                      />
                      </div>
                    ))}
                </ParameterSection>
                )}
              </Accordion>
            )}
          </ScrollArea>
          )}
        </aside>}

        <div className="absolute inset-0 z-0 bg-[#f5f5f7]">
          <div className="flex h-full flex-col">
            {/* 아래 작업 메뉴처럼 독립적으로 접을 수 있는 뷰 전환 도구막대. */}
            {!viewerToolbarOpen && (
              <button
                type="button"
                onClick={() => setViewerToolbarOpen(true)}
                aria-label="뷰 전환 도구막대 펼치기"
                className="absolute left-1/2 top-3 z-30 grid size-10 -translate-x-1/2 place-items-center rounded-full border border-[#e5e5ea] bg-white/94 text-[#3182f6] shadow-lg backdrop-blur-xl hover:bg-white"
              >
                <ChevronDown className="size-4" />
              </button>
            )}
            {viewerToolbarOpen && <div className="absolute left-1/2 top-3 z-30 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-2 overflow-x-auto rounded-2xl border border-[#e5e5ea] bg-white/94 p-1.5 shadow-xl backdrop-blur-xl">
              <div className="flex rounded-lg bg-[#f5f5f7] p-1">
                <ModeButton active={!sideBySide && mode === 'parametric-preview'} onClick={() => { setSideBySide(false); setMode('parametric-preview'); }}>파라메트릭스</ModeButton>
                <ModeButton active={!sideBySide && mode === 'exact-stl'} onClick={() => { setSideBySide(false); setMode('exact-stl'); }}>원본 STL</ModeButton>
                <ModeButton active={sideBySide} onClick={() => setSideBySide(true)}>듀얼 뷰</ModeButton>
              </div>
              {sideBySide && (
                <div className="flex items-center gap-1.5 rounded-lg bg-[#f5f5f7] p-1">
                  <div className="flex items-center gap-1.5 px-1.5 text-[10px] font-medium text-[#3c3c43]">
                    <Switch
                      aria-label="두 뷰어 카메라 연동"
                      checked={cameraLinked}
                      onCheckedChange={(linked) => {
                        setCameraLinked(linked);
                        if (linked) {
                          window.requestAnimationFrame(() => copyViewerCamera(comparisonCameraGroup, 'parametric', 'stl'));
                        }
                      }}
                      size="sm"
                    />
                    카메라 연동
                  </div>
                  {!cameraLinked && (
                    <>
                      <button
                        type="button"
                        onClick={() => copyViewerCamera(comparisonCameraGroup, 'parametric', 'stl')}
                        className="rounded-md bg-white px-2 py-1 text-[10px] font-medium text-[#3c3c43] shadow-sm hover:text-[#1b64da]"
                        title="왼쪽 파라메트릭 카메라를 오른쪽 STL에 적용"
                      >
                        왼쪽 → 오른쪽
                      </button>
                      <button
                        type="button"
                        onClick={() => copyViewerCamera(comparisonCameraGroup, 'stl', 'parametric')}
                        className="rounded-md bg-white px-2 py-1 text-[10px] font-medium text-[#3c3c43] shadow-sm hover:text-[#1b64da]"
                        title="오른쪽 STL 카메라를 왼쪽 파라메트릭에 적용"
                      >
                        왼쪽 ← 오른쪽
                      </button>
                    </>
                  )}
                </div>
              )}
              <div className="flex shrink-0 items-center gap-2 px-1 text-xs text-[#6e6e73]">
                <Switch aria-label="기준 설계 Ghost 표시" checked={showGhost} onCheckedChange={setShowGhost} size="sm" disabled={!sideBySide && mode === 'exact-stl'} />
                <span>기준 Ghost</span>
              </div>
              {showAiPrediction && (mode === 'parametric-preview' || sideBySide) && (
                <FlightCameraControls
                  locked={sideViewLocked}
                  onReset={() => setSideViewResetKey((key) => key + 1)}
                  onToggleLock={() => setSideViewLocked((locked) => !locked)}
                />
              )}
              <button
                type="button"
                onClick={() => setViewerToolbarOpen(false)}
                aria-label="뷰 전환 도구막대 접기"
                className="grid size-8 shrink-0 place-items-center rounded-lg text-[#6e6e73] hover:bg-[#f5f5f7] hover:text-[#1d1d1f]"
              >
                <ChevronDown className="size-4 rotate-180" />
              </button>
            </div>}
            <div className="relative min-h-0 flex-1">
              {loading ? (
                <div className="absolute inset-0 grid place-items-center text-sm text-[#6e6e73]">Design #{selected.id} 형상을 불러오는 중…</div>
              ) : draft && baseline && sideBySide ? (
                <div className="absolute inset-0 grid grid-cols-2 divide-x divide-[#e5e5ea]">
                  <div className="relative">
                    <ParametricUavViewer draft={draft} baseline={baseline} showGhost={showGhost} changedGroup={changedGroup} assembly={placements} bladeCount={bladeCount} selection={selectedParts} onSelectionChange={setSelectedParts} paused={suspended || compareOpen || chartsOpen} cameraFitPadding={1.62} cameraSync={{ group: comparisonCameraGroup, id: 'parametric', linked: cameraLinked }} viewPreset={showAiPrediction ? 'side' : 'perspective'} sideViewLocked={sideViewLocked} sideViewResetKey={sideViewResetKey} pitchDegrees={activeFlightState?.pitch ?? 0} forceVectors={activeForces} showForces={Boolean(activeFlightState)} />
                    <span className="pointer-events-none absolute left-3 top-3 z-20 rounded-md bg-white/90 px-2 py-1 text-[10px] font-semibold text-[#3182f6] backdrop-blur">파라메트릭스</span>
                    {activeFlightState && !chartsOpen && <FlightVisualizationLegend row={activeFlightState} source={visualizationSource} />}
                  </div>
                  <div className="relative">
                    <StlViewer key={originalStlUrl} src={originalStlUrl} paused={suspended || compareOpen || chartsOpen} cameraFitPadding={1.62} cameraSync={{ group: comparisonCameraGroup, id: 'stl', linked: cameraLinked }} showControls={false} />
                    <span className="pointer-events-none absolute right-3 top-3 z-20 rounded-md bg-white/90 px-2 py-1 text-[10px] font-semibold text-[#6e6e73] backdrop-blur">원본 STL</span>
                  </div>
                </div>
              ) : draft && baseline && mode === 'parametric-preview' ? (
                <>
                  <ParametricUavViewer draft={draft} baseline={baseline} showGhost={showGhost} changedGroup={changedGroup} assembly={placements} bladeCount={bladeCount} selection={selectedParts} onSelectionChange={setSelectedParts} paused={suspended || compareOpen || chartsOpen} cameraFitPadding={1.62} viewPreset={showAiPrediction ? 'side' : 'perspective'} sideViewLocked={sideViewLocked} sideViewResetKey={sideViewResetKey} pitchDegrees={activeFlightState?.pitch ?? 0} forceVectors={activeForces} showForces={Boolean(activeFlightState)} />
                  {activeFlightState && !chartsOpen && <FlightVisualizationLegend row={activeFlightState} source={visualizationSource} />}
                </>
              ) : (
                <StlViewer key={originalStlUrl} src={originalStlUrl} paused={suspended || compareOpen || chartsOpen} />
              )}
              {showViewerControls && mode === 'parametric-preview' && (
                <div className="absolute bottom-3 right-3 z-20 flex items-center gap-1 rounded-lg border border-[#e5e5ea] bg-white/90 p-1 text-[11px] shadow-sm backdrop-blur">
                  <span className="px-1.5 text-[#86868b]">프로펠러</span>
                  {([2, 4] as const).map((count) => (
                    <button
                      key={count}
                      type="button"
                      onClick={() => setBladeCount(count)}
                      aria-pressed={bladeCount === count}
                      className={`rounded-md px-2 py-1 font-medium tabular-nums ${bladeCount === count ? 'bg-[#1d1d1f] text-white' : 'text-[#6e6e73] hover:bg-[#f5f5f7]'}`}
                    >
                      {count}엽
                    </button>
                  ))}
                </div>
              )}
              {changedGroup && (
                <div className="pointer-events-none absolute right-3 top-[72px] z-20 rounded-lg bg-[#3182f6] px-3 py-2 text-xs font-semibold text-white shadow-sm">
                  {GROUP_LABELS[changedGroup]} 반영됨
                </div>
              )}
            </div>
          </div>
        </div>

        {showModelInfo && <aside className="absolute right-3 top-3 z-20 flex max-h-[calc(100%-24px)] w-[300px] flex-col overflow-hidden rounded-2xl border border-[#e5e5ea] bg-white/92 shadow-lg backdrop-blur">
          <div className="flex shrink-0 items-center gap-2 border-b border-[#e5e5ea] px-3 py-2">
            <Info className="size-4 text-[#3182f6]" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-[#1d1d1f]">모델 정보</p>
              <p className="truncate text-[10px] text-[#6e6e73]">현재 파라메트릭 출력 · #{selected.id}</p>
            </div>
            <Button size="icon-sm" variant="ghost" onClick={() => setModelInfoHiddenFor(selected.id)} aria-label="모델 정보 닫기" className="shrink-0 text-[#6e6e73]">
              <X />
            </Button>
          </div>
          <div className="min-h-0 overflow-y-auto overscroll-contain">
            <ModelInfoPanel
              selected={selected}
              draft={draft}
              assembly={placements}
              selectedParts={selectedParts}
              onSelectionChange={setSelectedParts}
              estimate={estimate}
              changedCount={changedCount}
              loading={loading}
            />
          </div>
        </aside>}

        {showPerformancePanel && <aside
          className={`absolute right-3 z-20 flex w-[320px] flex-col overflow-hidden border border-[#e5e5ea] bg-white/92 backdrop-blur ${
            chartsOpen && aiPredictionOpen
              ? 'hidden'
              : `top-3 rounded-2xl shadow-lg ${rightOpen ? 'bottom-3' : 'max-h-11'}`
          }`}
        >
          <div className="flex w-full shrink-0 items-center gap-2 border-b border-[#e5e5ea] px-3 py-2">
            {(aiPredictionOpen || onCloseTool) && (
              <Button size="icon-sm" variant="ghost" onClick={aiPredictionOpen ? closeAiPrediction : onCloseTool} aria-label={aiPredictionOpen ? '기존 성능으로 돌아가기' : '성능 패널 닫기'} className="shrink-0 text-[#6e6e73]">
                <ArrowLeft />
              </Button>
            )}
            <button type="button" onClick={() => setRightOpen((open) => !open)} aria-expanded={rightOpen} className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left">
              <ChevronDown className={`size-4 shrink-0 text-[#86868b] transition-transform ${rightOpen ? '' : '-rotate-90'}`} />
              <span className="text-sm font-semibold text-[#1d1d1f]">{aiPredictionOpen ? 'AI 속도별 예측' : '성능'}</span>
            </button>
            {!aiPredictionOpen && <Button
              size="sm"
              onClick={onOpenParts}
              disabled={loading || !draft}
              className="h-7 shrink-0 bg-[#3182f6] px-2 text-[11px] text-white hover:bg-[#1b64da]"
            >
              <ShoppingBag className="size-3" />부품 찾기
            </Button>}
          </div>
          <ScrollArea className={`min-h-0 flex-1 ${rightOpen ? '' : 'hidden'}`}>
            <div className="p-4">
              {aiPredictionOpen ? (
                <div ref={aiPredictionPanelRef}>
                  <PerformancePredictionPanel designId={selected.id} draft={draft} disabled={loading || !draft} inputError={loadError} speed={speed} onSpeedChange={setSpeed} onPredictionChange={handlePredictionChange} onResultChange={handlePerformanceResultChange} compact />
                  <Button
                    type="button"
                    onClick={() => {
                      if (!chartsOpen && !aiPerformanceResult && originalTrimAvailable) setPerformanceSource('dataset');
                      setChartsOpen((open) => !open);
                    }}
                    disabled={!aiPerformanceResult && !originalTrimAvailable}
                    aria-expanded={chartsOpen}
                    className={`mt-3 h-10 w-full ${chartsOpen ? 'border border-[#d1d1d6] bg-white text-[#3c3c43] hover:bg-[#f5f5f7]' : 'bg-[#1d1d1f] text-white hover:bg-[#343437]'}`}
                  >
                    <Activity className="size-4" /> {chartsOpen ? '분석 보드 닫기' : '분석 보드 열기'} {chartsOpen ? <X className="ml-auto size-4" /> : <ChevronRight className="ml-auto size-4" />}
                  </Button>
                </div>
              ) : <>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-[#1d1d1f]">기존 설계 KPI 비교</p>
                  <p className="mt-1 text-xs text-[#6e6e73]">Baseline 대비 현재 Draft</p>
                </div>
                {estimate && <Tooltip>
                  <TooltipTrigger render={<Badge variant="outline" className={`cursor-help text-[10px] underline decoration-dotted underline-offset-2 ${estimate.source === 'dataset' ? 'border-[#bfdbfe] bg-[#eff6ff] text-[#1b64da]' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`} />}>
                    {estimate.source === 'dataset' ? '원본 시뮬레이션' : '편집 설계 추정'}
                  </TooltipTrigger>
                  <TooltipContent className="max-w-64 text-left leading-5 whitespace-normal">
                    {estimate.source === 'dataset' ? '편집하지 않은 설계의 AircraftVerse 원본 시뮬레이션 KPI입니다. 실물 측정값이나 새로 계산한 해석 결과가 아닙니다.' : 'Neighbor Estimate v1: 인접 설계의 거리 가중 평균과 편집 보정을 사용한 추정값입니다. 학습 모델이나 물리 해석 결과가 아닙니다.'}
                  </TooltipContent>
                </Tooltip>}
              </div>
              <div className="mt-3 rounded-xl bg-[#f5f5f7] p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 font-medium text-[#3c3c43]"><span className={`size-2 rounded-full ${estimateState === 'calculating' ? 'animate-pulse bg-amber-500' : estimateImpact === 'geometry-only' ? 'bg-[#3182f6]' : 'bg-emerald-600'}`} />{estimateState === 'calculating' ? '성능 계산 중' : estimateImpact === 'geometry-only' ? '3D만 반영됨' : '업데이트됨'}</span>
                  <span className="font-mono text-[#6e6e73]">{estimate?.source === 'dataset' ? '원본 KPI' : estimateImpact === 'geometry-only' ? '추정 입력 제외' : `${estimate?.similarity ?? 100}% 유사`}</span>
                </div>
                <p className="mt-2 text-[11px] text-[#86868b]">{estimate?.source === 'dataset' ? <>AircraftVerse 기준 설계 <strong className="text-[#3c3c43]">#{selected.id}</strong>의 저장된 원본 시뮬레이션 값입니다.</> : estimateImpact === 'geometry-only' ? '이 CAD 파생 파라미터는 데이터셋 KPI 거리 계산에 사용하지 않습니다.' : <>Neighbor Estimate v1 · 가장 가까운 설계 <strong className="text-[#3c3c43]">#{estimate?.closestId ?? selected.id}</strong></>}</p>
              </div>

              {estimate && (
                <div className="mt-3 divide-y divide-[#e5e5ea]">
                  <EstimateRow icon={<Ruler />} label="최대 비행거리" before={selected.maxDistance / 1000} after={estimate.range / 1000} unit="km" better="up" />
                  <EstimateRow icon={<CircleGauge />} label="최고 속도" before={selected.maxSpeed} after={estimate.maxSpeed} unit="m/s" better="up" />
                  <EstimateRow icon={<Activity />} label="체공 시간" before={selected.hoverTime} after={estimate.hover} unit="sec" better="up" />
                  <EstimateRow icon={<Zap />} label="소비전력" before={selected.power} after={estimate.power} unit="W" better="down" />
                  <EstimateRow icon={<Wind />} label="항력 (20m/s)" before={selected.dragAt20} after={estimate.drag} unit="N" better="down" />
                  <EstimateRow icon={<Weight />} label="질량" before={selected.mass} after={estimate.mass} unit="kg" better="down" />
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  setAiPredictionOpen(true);
                  setSideViewLocked(false);
                  setRightOpen(true);
                  setSideBySide(false);
                  setMode('parametric-preview');
                }}
                aria-expanded="false"
                className="mt-4 flex w-full items-center gap-2 rounded-xl border border-[#bfdbfe] bg-[#eff6ff] px-3 py-3 text-left text-sm font-semibold text-[#1b64da] transition-colors hover:bg-[#e5f0ff]"
              >
                <BrainCircuit className="size-4 shrink-0" />
                <span className="flex-1">AI 속도별 예측</span>
                <ChevronRight className="size-4" />
              </button>

              <div className="mt-4 rounded-xl border border-[#e5e5ea] bg-white p-3 text-xs">
                <p className="font-semibold text-[#3c3c43]">변경 요약</p>
                <div className="mt-2 flex items-center justify-between text-[#6e6e73]"><span>편집된 파라미터</span><strong className="font-mono text-[#1b64da]">{changedCount}</strong></div>
                <div className="mt-2 flex items-center justify-between text-[#6e6e73]"><span>파라메트릭 상태</span><strong className="text-emerald-700">실시간</strong></div>
              </div>

              <Button onClick={() => { setCompareDetailsOpen(true); setBaselineCompareView('dual'); setBaselineCameraLinked(true); setCompareOpen(true); }} disabled={!draft || !baseline} className="mt-4 h-10 w-full bg-[#3182f6] text-white hover:bg-[#1b64da]">
                <GitCompareArrows /> Baseline과 비교 <ChevronRight />
              </Button>
              <Button onClick={onOpenDatasetCompare} variant="ghost" className="mt-1 h-9 w-full text-xs text-[#6e6e73] hover:bg-[#f5f5f7]">
                데이터셋 설계끼리 A/B 비교
              </Button>
              <DataDisclaimer compact />
              </>}
            </div>
          </ScrollArea>
        </aside>}

        {showAiPrediction && chartsOpen && draft && baseline && <section className="absolute bottom-[72px] left-3 right-3 top-[72px] z-20 flex min-h-0 flex-col overflow-hidden rounded-2xl border border-[#dbe4ea] bg-white/96 shadow-2xl backdrop-blur-xl">
          <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[#e5e5ea] px-3">
            {performanceSource === 'ai' ? <BrainCircuit className="size-4 text-[#3182f6]" /> : <Database className="size-4 text-emerald-600" />}
            <div className="flex min-w-0 flex-1 items-center">
              <div className="min-w-0 shrink-0">
                <p className="text-sm font-semibold text-[#1d1d1f]">비행 성능 분석</p>
              <p className="truncate text-[10px] text-[#86868b]">{performanceSource === 'ai' ? '현재 편집 Draft의 AI 예측' : `기준 설계 #${selected.id}의 저장된 원본 trim`} · {speed} m/s</p>
              </div>
              <fieldset className="m-0 ml-8 flex min-w-0 shrink-0 rounded-lg border-0 bg-[#f5f5f7] p-0.5" aria-label="성능 데이터 소스">
                <ModeButton active={performanceSource === 'ai'} onClick={() => setPerformanceSource('ai')}>AI 예측</ModeButton>
                <Tooltip>
                  <TooltipTrigger render={<span />}>
                    <ModeButton active={performanceSource === 'dataset'} disabled={!originalTrimAvailable} onClick={() => setPerformanceSource('dataset')}>원본 시뮬레이션</ModeButton>
                  </TooltipTrigger>
                  {!originalTrimAvailable && <TooltipContent>이 설계에는 배포된 원본 trim 데이터가 없습니다.</TooltipContent>}
                </Tooltip>
              </fieldset>
            </div>
            <Button size="icon-sm" variant="ghost" onClick={() => setChartsOpen(false)} aria-label="분석 보드 닫기" className="text-[#6e6e73]">
              <X />
            </Button>
          </header>
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px]">
            <div className="grid min-h-0 grid-rows-[minmax(220px,1fr)_300px]">
              <div className="relative min-h-0 overflow-hidden border-b border-[#e5e5ea] bg-[#eef3f6]">
                {performanceSource === 'dataset' && packagedReference ? (
                  <StlViewer
                    key={packagedReference.modelPath}
                    src={packagedReference.modelPath}
                    pitchDegrees={showOriginalFlight ? originalTrimRow?.pitch ?? 0 : 0}
                    forceVectors={showOriginalFlight ? activeForces : undefined}
                    showForceVectors={showOriginalFlight}
                    cameraFitPadding={1.7}
                    showControls={false}
                    paused={suspended || compareOpen}
                  />
                ) : (
                  <ParametricUavViewer
                    draft={draft}
                    baseline={baseline}
                    showGhost={showGhost}
                    changedGroup={changedGroup}
                    assembly={placements}
                    bladeCount={bladeCount}
                    selection={selectedParts}
                    onSelectionChange={setSelectedParts}
                    paused={suspended || compareOpen}
                    cameraFitPadding={1.7}
                    viewPreset="side"
                    sideViewLocked={sideViewLocked}
                    sideViewResetKey={sideViewResetKey}
                    pitchDegrees={showAiFlight ? aiFlightState.pitch ?? 0 : 0}
                    forceVectors={showAiFlight ? activeForces : undefined}
                    showForces={showAiFlight}
                  />
                )}
                <div className={`pointer-events-none absolute left-3 top-3 z-20 rounded-xl border bg-white/92 px-3 py-2 shadow-sm backdrop-blur ${performanceSource === 'ai' ? 'border-[#bfdbfe] text-[#1b64da]' : 'border-emerald-200 text-emerald-700'}`}>
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold">{performanceSource === 'ai' ? <BrainCircuit className="size-3.5" /> : <Database className="size-3.5" />}{performanceSource === 'ai' ? 'AI 예측 · 현재 Draft' : `원본 시뮬레이션 · 기준 #${selected.id}`}</p>
                  <p className="mt-0.5 text-[10px] font-medium text-[#6e6e73]">{performanceSource === 'ai' ? '파라메트릭 형상' : '원본 STL 형상'} · {speed} m/s</p>
                </div>
                {activeFlightState && <FlightVisualizationLegend row={activeFlightState} source={performanceSource} />}
                {performanceSource === 'dataset' && !showOriginalFlight && <div className="absolute inset-0 z-10 grid place-items-center bg-white/25"><p className="rounded-xl border border-amber-200 bg-amber-50/95 px-4 py-3 text-xs font-medium text-amber-900 shadow-sm">{speed} m/s에서는 원본 trim 해석이 수렴하지 않았습니다.</p></div>}
              </div>
              <div className="min-h-0 overflow-hidden p-4">
                {performanceSource === 'dataset' && packagedReference ? (
                  <SpeedCurveSheet rows={packagedReference.trim} source="dataset" speed={speed} onSpeedChange={setSpeed} />
                ) : aiPerformanceResult ? (
                  <SpeedCurveSheet rows={aiPerformanceResult.predictions} source="ai" speed={speed} onSpeedChange={setSpeed} />
                ) : (
                  <p className="grid h-full place-items-center text-xs text-[#6e6e73]">현재 편집 설계의 AI 곡선을 계산하고 있습니다…</p>
                )}
              </div>
            </div>
            <aside className="min-h-0 overflow-hidden border-l border-[#e5e5ea] bg-white p-3">
              {performanceSource === 'dataset' && packagedReference ? (
                <OriginalTrimPanel design={packagedReference} speed={speed} onSpeedChange={setSpeed} />
              ) : aiPerformanceResult ? (
                <PerformancePredictionPanel
                  designId={selected.id}
                  draft={draft}
                  disabled={false}
                  speed={speed}
                  onSpeedChange={setSpeed}
                  onPredictionChange={handlePredictionChange}
                  resultOverride={aiPerformanceResult}
                  compact
                />
              ) : (
                <p className="grid h-full place-items-center text-xs text-[#6e6e73]">AI 예측을 준비하고 있습니다…</p>
              )}
            </aside>
          </div>
        </section>}
      </div>

      {loadError && (
        <p className="mt-2 text-[11px] text-amber-700">전체 설계 트리를 읽지 못해 대표 설계의 호환 파라미터로 표시했습니다: {loadError}</p>
      )}

      <Dialog open={compareOpen} onOpenChange={setCompareOpen}>
        <DialogContent className="flex h-[calc(100dvh-32px)] w-[calc(100vw-32px)] max-h-none max-w-none flex-col gap-0 overflow-hidden border-[#dbe4ea] bg-[#f5f5f7] p-0 text-[#1d1d1f] sm:max-w-none">
          <DialogHeader className="relative shrink-0 border-b border-[#e5e5ea] bg-white px-5 py-3 pr-14">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-lg">Baseline vs 현재 Draft</DialogTitle>
                <DialogDescription className="mt-1">두 파라메트릭 형상을 같은 카메라로 조작하고 변경점과 성능 차이를 확인합니다.</DialogDescription>
              </div>
            </div>
            <div className="absolute left-1/2 top-1/2 z-10 flex max-w-[46vw] -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-2xl border border-[#e5e5ea] bg-white/96 p-1.5 shadow-lg backdrop-blur-xl">
              <div className="flex rounded-lg bg-[#f5f5f7] p-1">
                <ModeButton active={baselineCompareView === 'baseline'} onClick={() => setBaselineCompareView('baseline')}>Baseline</ModeButton>
                <ModeButton active={baselineCompareView === 'draft'} onClick={() => setBaselineCompareView('draft')}>현재 Draft</ModeButton>
                <ModeButton active={baselineCompareView === 'dual'} onClick={() => setBaselineCompareView('dual')}>듀얼 뷰</ModeButton>
              </div>
              {baselineCompareView === 'dual' && <div className="flex items-center gap-1 rounded-lg bg-[#f5f5f7] p-1 text-[10px] font-medium text-[#3c3c43]">
                <div className="flex items-center gap-1.5 px-1.5">
                  <Switch
                    aria-label="Baseline과 현재 Draft 카메라 연동"
                    checked={baselineCameraLinked}
                    onCheckedChange={(linked) => {
                      setBaselineCameraLinked(linked);
                      if (linked) window.requestAnimationFrame(() => copyViewerCamera(baselineComparisonCameraGroup, 'baseline', 'draft'));
                    }}
                    size="sm"
                  />
                  카메라 연동
                </div>
                {!baselineCameraLinked && <>
                  <button type="button" onClick={() => copyViewerCamera(baselineComparisonCameraGroup, 'baseline', 'draft')} className="rounded-md bg-white px-2 py-1 shadow-sm hover:text-[#1b64da]" title="Baseline 카메라를 현재 Draft에 적용">A → B</button>
                  <button type="button" onClick={() => copyViewerCamera(baselineComparisonCameraGroup, 'draft', 'baseline')} className="rounded-md bg-white px-2 py-1 shadow-sm hover:text-[#1b64da]" title="현재 Draft 카메라를 Baseline에 적용">A ← B</button>
                </>}
              </div>}
            </div>
          </DialogHeader>
          {baseline && draft && estimate && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className={`grid min-h-[280px] flex-1 ${baselineCompareView === 'dual' ? 'grid-cols-2 divide-x divide-[#dbe4ea]' : 'grid-cols-1'}`}>
                {(baselineCompareView === 'baseline' || baselineCompareView === 'dual') && <ComparePreview
                  label={`A · Baseline #${selected.id}`}
                  draft={baseline}
                  cameraGroup={baselineComparisonCameraGroup}
                  cameraId="baseline"
                  cameraLinked={baselineCompareView === 'dual' && baselineCameraLinked}
                  assembly={placements}
                  bladeCount={bladeCount}
                />}
                {(baselineCompareView === 'draft' || baselineCompareView === 'dual') && <ComparePreview
                  label="B · 현재 Draft"
                  draft={draft}
                  cameraGroup={baselineComparisonCameraGroup}
                  cameraId="draft"
                  cameraLinked={baselineCompareView === 'dual' && baselineCameraLinked}
                  assembly={placements}
                  bladeCount={bladeCount}
                />}
              </div>
              <div className="shrink-0 border-t border-[#dbe4ea] bg-white">
                <button type="button" onClick={() => setCompareDetailsOpen((open) => !open)} aria-expanded={compareDetailsOpen} className="flex h-11 w-full items-center gap-2 px-4 text-left hover:bg-[#fafafa]">
                  <ChevronDown className={`size-4 text-[#86868b] transition-transform ${compareDetailsOpen ? 'rotate-180' : ''}`} />
                  <span className="text-sm font-semibold">비교 상세</span>
                  <span className="rounded-full bg-[#eff6ff] px-2 py-0.5 text-[10px] font-medium text-[#1b64da]">변경 {differences.length}개</span>
                  <span className="text-[10px] text-[#86868b]">파라미터와 KPI 변화</span>
                  <span className="ml-auto text-[10px] text-[#6e6e73]">{compareDetailsOpen ? '접기' : '펼치기'}</span>
                </button>
                {compareDetailsOpen && <div className="grid h-[286px] min-h-0 grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)] gap-3 overflow-hidden border-t border-[#e5e5ea] bg-[#f5f5f7] p-3">
                  <div className="flex min-h-0 flex-col rounded-xl border border-[#e5e5ea] bg-white p-3">
                    <p className="text-sm font-semibold">변경된 파라미터</p>
                    <div className="mt-2 min-h-0 flex-1 overflow-y-auto divide-y divide-[#e5e5ea] pr-1">
                      {differences.length ? differences.map((item, index) => (
                        <div key={`${item.label}-${index}`} className="grid grid-cols-[1fr_auto_auto] gap-2 py-2 text-xs">
                          <span className="truncate text-[#6e6e73]">{item.label}</span>
                          <span className="font-mono text-[#86868b]">{item.before}</span>
                          <span className="font-mono font-semibold text-[#1b64da]">→ {item.after}</span>
                        </div>
                      )) : <p className="py-8 text-center text-xs text-[#86868b]">아직 변경된 파라미터가 없습니다.</p>}
                    </div>
                  </div>
                  <div className="min-h-0 overflow-hidden rounded-xl border border-[#e5e5ea] bg-white p-3">
                    <p className="text-sm font-semibold">성능 변화</p>
                    <div className="mt-2 grid grid-cols-3 gap-2">
                      <CompareMetric label="비행거리" before={selected.maxDistance / 1000} after={estimate.range / 1000} unit="km" />
                      <CompareMetric label="체공시간" before={selected.hoverTime} after={estimate.hover} unit="s" />
                      <CompareMetric label="최고속도" before={selected.maxSpeed} after={estimate.maxSpeed} unit="m/s" />
                      <CompareMetric label="소비전력" before={selected.power} after={estimate.power} unit="W" invert />
                      <CompareMetric label="항력" before={selected.dragAt20} after={estimate.drag} unit="N" invert />
                      <CompareMetric label="질량" before={selected.mass} after={estimate.mass} unit="kg" invert />
                    </div>
                  </div>
                </div>}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function FlightVisualizationLegend({ row, source }: { row: PerformancePrediction | TrimRow; source: PerformanceSource }) {
  const value = (amount: number | null) => amount == null ? '—' : `${amount.toFixed(2)} N`;
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-20 rounded-xl border border-white/70 bg-white/88 px-3 py-2 shadow-sm backdrop-blur">
      <div className="flex items-center gap-2 text-[11px] font-semibold text-[#1d1d1f]">
        <span className={`rounded-md px-1.5 py-0.5 ${source === 'ai' ? 'bg-[#eff6ff] text-[#1b64da]' : 'bg-emerald-50 text-emerald-700'}`}>{source === 'ai' ? 'AI 비행 자세' : '원본 trim 자세'}</span>
        <span className="tabular-nums">{row.speed} m/s</span>
        <span className="text-[#86868b]">피치 {row.pitch == null ? '—' : `${row.pitch.toFixed(1)}°`}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-3 text-[11px] text-[#6e6e73]">
        <span className="flex items-center gap-1"><i className="size-2 rounded-full bg-[#e97942]" />항력 {value(row.drag)}</span>
        <span className="flex items-center gap-1"><i className="size-2 rounded-full bg-[#1c9b62]" />양력 {value(row.lift)}</span>
        <span className="flex items-center gap-1"><i className="size-2 rounded-full bg-[#6d5bd0]" />추력 {value(row.thrust)}</span>
      </div>
    </div>
  );
}

function FlightCameraControls({
  locked,
  onReset,
  onToggleLock,
}: {
  locked: boolean;
  onReset: () => void;
  onToggleLock: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 rounded-lg bg-[#f5f5f7] p-1">
      <button type="button" onClick={onReset} className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium text-[#3c3c43] hover:bg-[#f5f5f7]" title="정확한 측면 카메라로 돌아가기">
        <RotateCcw className="size-3.5" /> 측면으로 복귀
      </button>
      <button
        type="button"
        onClick={onToggleLock}
        aria-pressed={locked}
        className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium ${locked ? 'bg-[#1d1d1f] text-white' : 'text-[#3c3c43] hover:bg-[#f5f5f7]'}`}
        title={locked ? '측면 고정 해제' : '상하 회전과 화면 이동을 막고 측면 고정'}
      >
        {locked ? <Lock className="size-3.5" /> : <Unlock className="size-3.5" />}
        측면 고정
      </button>
    </div>
  );
}

const performanceMetricCards = [
  { key: 'drag', label: '항력', unit: 'N', digits: 2 },
  { key: 'lift', label: '양력', unit: 'N', digits: 2 },
  { key: 'thrust', label: '추력', unit: 'N', digits: 2 },
  { key: 'pitch', label: '피치각', unit: 'deg', digits: 1 },
  { key: 'power', label: '전력', unit: 'W', digits: 1 },
  { key: 'current', label: '전류', unit: 'A', digits: 2 },
  { key: 'flightTime', label: '비행 시간', unit: 's', digits: 1 },
  { key: 'distance', label: '비행거리', unit: 'm', digits: 1 },
] as const;

function OriginalTrimPanel({ design, speed, onSpeedChange }: { design: ShowcaseDesign; speed: number; onSpeedChange: (speed: number) => void }) {
  const [speedDraft, setSpeedDraft] = useState<string | null>(null);
  const row = design.trim.find((item) => item.speed === speed) ?? null;
  const validSpeeds = useMemo(() => design.trim.filter((item) => item.valid).map((item) => item.speed), [design]);
  const commitSpeed = (raw: string) => {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) onSpeedChange(Math.min(50, Math.max(0, Math.round(parsed))));
    setSpeedDraft(null);
  };

  return (
    <section className="min-w-0 rounded-2xl border border-emerald-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[#1d1d1f]"><Database className="size-4 text-emerald-600" /> 원본 속도별 trim</h2>
        <span className="rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700">AircraftVerse 저장값</span>
      </div>
      <p className="mt-2 text-xs leading-5 text-[#6e6e73]">기준 설계 #{design.id}의 저장된 시뮬레이션 결과입니다. 현재 Draft의 편집 내용은 반영되지 않습니다.</p>
      <div className="mt-4">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="font-medium text-[#3c3c43]">trim 속도</span>
          <label className="flex items-center gap-1 rounded-lg border border-emerald-200 bg-white px-2 py-1 text-emerald-700 focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-500/15">
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={50}
              step={1}
              aria-label="원본 trim 속도 직접 입력"
              value={speedDraft ?? String(speed)}
              onFocus={(event) => { setSpeedDraft(String(speed)); event.currentTarget.select(); }}
              onChange={(event) => setSpeedDraft(event.currentTarget.value)}
              onBlur={(event) => commitSpeed(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') setSpeedDraft(null);
              }}
              className="w-10 bg-transparent text-right font-mono font-semibold outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <span className="font-mono font-semibold">m/s</span>
          </label>
        </div>
        <Slider value={[speed]} min={0} max={50} step={1} onValueChange={(value) => onSpeedChange(Number(Array.isArray(value) ? value[0] : value))} className="mt-3 [&_[data-slot=slider-range]]:bg-emerald-600 [&_[data-slot=slider-thumb]]:border-emerald-600" />
        <div className="mt-1 flex justify-between font-mono text-[11px] text-[#86868b]"><span>0 m/s</span><span>50 m/s</span></div>
        <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-[11px] leading-4 text-emerald-800">
          유효 trim 구간 <strong className="ml-1 font-mono">{formatValidSpeedRanges(validSpeeds)}</strong>
        </div>
      </div>

      {row?.valid ? (
        <div className="mt-4 grid grid-cols-2 gap-2">
          {performanceMetricCards.map((metric) => {
            const amount = row[metric.key];
            return <div key={metric.key} className="min-w-0 rounded-xl bg-[#f5f5f7] p-2.5">
              <p className="text-[11px] text-[#6e6e73]">{metric.label}</p>
              <p className="mt-1 break-words font-mono text-base font-semibold text-[#1d1d1f]">{amount == null ? '—' : formatMetric(amount, metric.digits)} <span className="text-[11px] font-normal text-[#86868b]">{metric.unit}</span></p>
            </div>;
          })}
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs leading-5 text-amber-900">
          <p className="font-semibold">이 속도에서는 원본 해석값이 없습니다.</p>
          <p className="mt-1">Design #{design.id}의 {speed} m/s trim 계산이 수렴하지 않았습니다.</p>
        </div>
      )}
      <p className="mt-3 text-[11px] text-[#86868b]">원본 데이터 · 기준 설계 #{design.id}</p>
    </section>
  );
}

function ModelInfoPanel({
  selected,
  draft,
  assembly,
  selectedParts,
  onSelectionChange,
  estimate,
  changedCount,
  loading,
}: {
  selected: DesignSummary;
  draft: DesignDraft | null;
  assembly: AssemblyInfo | null;
  selectedParts: string[];
  onSelectionChange: (names: string[]) => void;
  estimate: ReturnType<typeof estimateDraft> | null;
  changedCount: number;
  loading: boolean;
}) {
  if (loading || !draft) {
    return <div className="grid h-48 place-items-center px-5 text-center text-xs text-[#6e6e73]">현재 모델 정보를 준비하고 있습니다…</div>;
  }

  const partNames = (category: 'hub' | 'structure' | 'propeller' | 'wing' | 'battery') => {
    if (!assembly) return [];
    return assembly.placements.flatMap((part) => {
      const type = assembly.typeOf.get(part.n) ?? '';
      const name = part.n;
      const isMainHub = /^MAINHUB/i.test(name);
      const matches = category === 'hub'
        ? isMainHub
        : category === 'structure'
          ? !isMainHub && /tube|para[_ ]?hub|flange|bend|branch|cross|connector|joint|arm/i.test(`${type} ${name}`)
          : category === 'propeller'
            ? /propeller/i.test(`${type} ${name}`)
            : category === 'wing'
              ? /wing/i.test(type) || /^WING/i.test(name)
              : /battery/i.test(`${type} ${name}`);
      return matches ? [name] : [];
    });
  };

  const configuration = [
    { label: '기준 설계', value: `#${selected.id}`, parts: [] as string[], icon: <Info />, tone: 'bg-slate-100 text-slate-500' },
    { label: '허브 형태', value: formatComponent(draft.topology), parts: partNames('hub'), icon: <Box />, tone: 'bg-cyan-50 text-cyan-700' },
    { label: '편집 가능한 구조 단계', value: `${draft.segments.length}개`, parts: partNames('structure'), icon: <Layers3 />, tone: 'bg-blue-50 text-blue-700' },
    { label: '프로펠러', value: `${draft.numPropellers}개`, parts: partNames('propeller'), icon: <CircleGauge />, tone: 'bg-violet-50 text-violet-700' },
    { label: '날개', value: `${draft.numWings}개`, parts: partNames('wing'), icon: <Plane />, tone: 'bg-sky-50 text-sky-700' },
    { label: '배터리', value: `${draft.energy.batteryTypes.length}개`, parts: partNames('battery'), icon: <BatteryCharging />, tone: 'bg-emerald-50 text-emerald-700' },
  ];

  const visibleParts = assembly?.placements.filter((part) => {
    const type = assembly.typeOf.get(part.n);
    return type && type !== 'Orient';
  }) ?? [];
  const visibleTypes = new Set(visibleParts.map((part) => assembly?.typeOf.get(part.n)).filter(Boolean)).size;

  const toggleParts = (names: string[]) => {
    const chosen = new Set(selectedParts);
    const allChosen = names.every((name) => chosen.has(name));
    onSelectionChange(
      allChosen
        ? selectedParts.filter((name) => !names.includes(name))
        : [...selectedParts, ...names.filter((name) => !chosen.has(name))],
    );
  };

  const metrics = [
    { label: '최대 비행거리', value: estimate ? formatMetric(estimate.range / 1000, 2) : '—', unit: 'km', icon: <Ruler className="size-3.5" /> },
    { label: '체공 시간', value: estimate ? formatMetric(estimate.hover, 0) : '—', unit: 'sec', icon: <Timer className="size-3.5" /> },
    { label: '최고 속도', value: estimate ? formatMetric(estimate.maxSpeed, 1) : '—', unit: 'm/s', icon: <Gauge className="size-3.5" /> },
    { label: '현재 질량', value: estimate ? formatMetric(estimate.mass, 2) : formatMetric(selected.mass, 2), unit: 'kg', icon: <Weight className="size-3.5" /> },
  ];

  return (
    <div className="p-3">
      <div className="rounded-xl border border-[#bfdbfe] bg-[#eff6ff] p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-[#1b64da]"><Box className="size-3.5" />현재 출력 모델</span>
          <Badge variant="outline" className="border-[#bfdbfe] bg-white text-[9px] text-[#1b64da]">실시간</Badge>
        </div>
        <p className="mt-2 text-[10px] leading-4 text-[#526579]">
          화면의 파라메트릭 형상과 편집 상태를 기준으로 표시합니다. 설계를 다시 고르면 이 패널도 자동으로 갱신됩니다.
        </p>
      </div>

      <div className="mt-3 rounded-xl border border-[#e5e5ea] bg-[#f5f5f7]/80 p-2">
        <div className="flex items-center justify-between px-1 py-1.5">
          <div>
            <p className="text-xs font-semibold text-[#3c3c43]">형상 구성</p>
            <p className="mt-0.5 text-[9px] text-[#86868b]">항목을 누르면 관련 부품 전체가 강조됩니다</p>
          </div>
          <span className="text-right text-[9px] leading-4 text-[#6e6e73]">
            {visibleParts.length ? `${visibleParts.length}개 · ${visibleTypes}종` : changedCount ? `${changedCount}개 편집됨` : '원본 상태'}
          </span>
        </div>
        <div className="mt-1 grid gap-1.5">
          {configuration.map(({ label, value, parts, icon, tone }) => {
            const selectedCount = parts.filter((name) => selectedParts.includes(name)).length;
            const active = parts.length > 0 && selectedCount === parts.length;
            const partial = selectedCount > 0 && !active;
            return (
              <button
                key={label}
                type="button"
                disabled={!parts.length}
                aria-pressed={parts.length ? active : undefined}
                onClick={() => toggleParts(parts)}
                className={`flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-[11px] transition ${
                  active
                    ? 'border-[#93c5fd] bg-[#eff6ff] shadow-sm'
                    : partial
                      ? 'border-[#bfdbfe] bg-white shadow-sm'
                      : 'border-transparent bg-white hover:border-[#dbe4ea] hover:shadow-sm'
                } ${parts.length ? '' : 'cursor-default'}`}
              >
                <span className={`grid size-7 shrink-0 place-items-center rounded-lg [&>svg]:size-3.5 ${active ? 'bg-[#3182f6] text-white' : tone}`}>
                  {icon}
                </span>
                <span className="min-w-0 flex-1 text-left">
                  <span className={`block truncate font-medium ${active ? 'text-[#1b64da]' : 'text-[#3c3c43]'}`}>{label}</span>
                  {parts.length > 0 && <small className="mt-0.5 block text-[9px] text-[#86868b]">연결 부품 {parts.length}개</small>}
                </span>
                <span className={`max-w-[112px] truncate text-right font-mono text-[10px] font-semibold ${active ? 'text-[#1b64da]' : 'text-[#3c3c43]'}`}>
                  {value}
                  {selectedCount > 0 && <small className="ml-1 block font-sans font-normal text-[#3182f6]">선택 {selectedCount}/{parts.length}</small>}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        {metrics.map((metric) => (
          <div key={metric.label} className="rounded-xl border border-[#e5e5ea] bg-gradient-to-br from-white to-[#f7f9fb] p-2.5 shadow-[0_1px_1px_rgba(15,23,42,0.03)]">
            <p className="flex items-center gap-1.5 text-[10px] text-[#6e6e73]"><span className="grid size-6 place-items-center rounded-md bg-[#eff6ff] text-[#3182f6]">{metric.icon}</span>{metric.label}</p>
            <p className="mt-1.5 font-mono text-base font-semibold tracking-tight text-[#1d1d1f]">
              {metric.value}<span className="ml-1 text-[9px] font-normal text-[#86868b]">{metric.unit}</span>
            </p>
          </div>
        ))}
      </div>

      <p className="mt-3 rounded-lg bg-[#f5f5f7] px-2.5 py-2 text-[9px] leading-4 text-[#86868b]">
        {estimate?.source === 'dataset'
          ? '성능 수치는 편집 전 기준 설계의 저장된 데이터셋 값입니다.'
          : '편집 후 성능 수치는 현재 파라미터와 인접 설계를 이용한 추정값입니다.'}
      </p>
    </div>
  );
}

const speedOverviewConfig = {
  pitch: { label: '피치각 (deg)', color: '#3182f6' },
  power: { label: '전력 (W)', color: '#6750a4' },
} satisfies ChartConfig;

const speedAeroConfig = {
  drag: { label: '항력 (N)', color: '#f4773c' },
  thrust: { label: '추력 (N)', color: '#6554d9' },
  lift: { label: '양력 (N)', color: '#00a86b' },
} satisfies ChartConfig;

const speedElectricConfig = {
  power: { label: '전력 (W)', color: '#6750a4' },
  current: { label: '전류 (A)', color: '#3182f6' },
} satisfies ChartConfig;

const speedEnduranceConfig = {
  flightTime: { label: '비행 시간 (s)', color: '#178653' },
  distance: { label: '비행거리 (m)', color: '#c47a13' },
} satisfies ChartConfig;

type SpeedCurveMode = 'overview' | 'aero' | 'electric' | 'endurance';

/** 같은 차트에서 AI 예측과 저장된 원본 trim을 전환해 비교한다. */
function SpeedCurveSheet({ rows, source, speed, onSpeedChange }: { rows: Array<PerformancePrediction | TrimRow>; source: PerformanceSource; speed: number; onSpeedChange: (speed: number) => void }) {
  const [curveMode, setCurveMode] = useState<SpeedCurveMode>('overview');
  const selectedCandidate = rows.find((row) => row.speed === speed) ?? null;
  const selectedRow = selectedCandidate && (!('valid' in selectedCandidate) || selectedCandidate.valid) ? selectedCandidate : null;
  const chartRows = useMemo(() => rows.map((row) => 'valid' in row && !row.valid ? { speed: row.speed } : row), [rows]);
  const config = curveMode === 'overview'
    ? speedOverviewConfig
    : curveMode === 'aero'
      ? speedAeroConfig
      : curveMode === 'electric'
        ? speedElectricConfig
        : speedEnduranceConfig;

  return (
    <div className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-[#6e6e73]">{source === 'ai' ? '현재 Draft의 AI 예측' : '기준 설계의 원본 trim'} · 세로선은 선택한 속도 <strong className={`ml-1 font-mono ${source === 'ai' ? 'text-[#1b64da]' : 'text-emerald-700'}`}>{speed} m/s</strong> · 차트를 눌러 변경</p>
          <div className="flex rounded-lg bg-[#f5f5f7] p-1">
            {([
              ['overview', '요약'],
              ['aero', '공력'],
              ['electric', '전력'],
              ['endurance', '운항'],
            ] as const).map(([id, label]) => (
              <Button key={id} size="sm" variant="ghost" onClick={() => setCurveMode(id)} className={curveMode === id ? 'bg-white text-[#1b64da] shadow-sm' : 'text-[#6e6e73]'}>{label}</Button>
            ))}
          </div>
        </div>
        <ChartContainer config={config} className="h-[240px] w-full aspect-auto" initialDimension={{ width: 700, height: 240 }}>
          <LineChart
            data={chartRows}
            margin={{ left: 0, right: 12, top: 8, bottom: 0 }}
            onClick={(chart) => {
              const nextSpeed = Number(chart?.activeLabel);
              if (Number.isFinite(nextSpeed)) onSpeedChange(nextSpeed);
            }}
          >
            <CartesianGrid vertical={false} stroke="#e2e8ec" />
            <XAxis dataKey="speed" tickLine={false} axisLine={false} tickMargin={10} unit="m/s" />
            <YAxis yAxisId="left" tickLine={false} axisLine={false} width={42} />
            <YAxis yAxisId="right" orientation="right" tickLine={false} axisLine={false} width={48} />
            <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
            <ReferenceLine
              x={speed}
              stroke={source === 'ai' ? '#1b64da' : '#178653'}
              strokeWidth={2}
              label={{ value: `${speed} m/s`, position: 'insideTopRight', fill: source === 'ai' ? '#1b64da' : '#178653', fontSize: 10 }}
            />
            {curveMode === 'overview' && (
              <>
                <Line yAxisId="left" type="monotone" dataKey="pitch" stroke="var(--color-pitch)" strokeWidth={2.2} dot={false} />
                <Line yAxisId="right" type="monotone" dataKey="power" stroke="var(--color-power)" strokeWidth={2.2} dot={false} />
                {selectedRow?.pitch != null && <ReferenceDot yAxisId="left" x={speed} y={selectedRow.pitch} r={4.5} fill="var(--color-pitch)" stroke="white" strokeWidth={2} />}
                {selectedRow?.power != null && <ReferenceDot yAxisId="right" x={speed} y={selectedRow.power} r={4.5} fill="var(--color-power)" stroke="white" strokeWidth={2} />}
              </>
            )}
            {curveMode === 'aero' && (
              <>
                <Line yAxisId="left" type="monotone" dataKey="drag" stroke="var(--color-drag)" strokeWidth={2.2} dot={false} />
                <Line yAxisId="left" type="monotone" dataKey="thrust" stroke="var(--color-thrust)" strokeWidth={2.2} dot={false} />
                <Line yAxisId="left" type="monotone" dataKey="lift" stroke="var(--color-lift)" strokeWidth={2.2} dot={false} />
                {selectedRow?.drag != null && <ReferenceDot yAxisId="left" x={speed} y={selectedRow.drag} r={4.5} fill="var(--color-drag)" stroke="white" strokeWidth={2} />}
                {selectedRow?.thrust != null && <ReferenceDot yAxisId="left" x={speed} y={selectedRow.thrust} r={4.5} fill="var(--color-thrust)" stroke="white" strokeWidth={2} />}
                {selectedRow?.lift != null && <ReferenceDot yAxisId="left" x={speed} y={selectedRow.lift} r={4.5} fill="var(--color-lift)" stroke="white" strokeWidth={2} />}
              </>
            )}
            {curveMode === 'electric' && (
              <>
                <Line yAxisId="right" type="monotone" dataKey="power" stroke="var(--color-power)" strokeWidth={2.2} dot={false} />
                <Line yAxisId="left" type="monotone" dataKey="current" stroke="var(--color-current)" strokeWidth={2.2} dot={false} />
                {selectedRow?.power != null && <ReferenceDot yAxisId="right" x={speed} y={selectedRow.power} r={4.5} fill="var(--color-power)" stroke="white" strokeWidth={2} />}
                {selectedRow?.current != null && <ReferenceDot yAxisId="left" x={speed} y={selectedRow.current} r={4.5} fill="var(--color-current)" stroke="white" strokeWidth={2} />}
              </>
            )}
            {curveMode === 'endurance' && (
              <>
                <Line yAxisId="left" type="monotone" dataKey="flightTime" stroke="var(--color-flightTime)" strokeWidth={2.2} dot={false} />
                <Line yAxisId="right" type="monotone" dataKey="distance" stroke="var(--color-distance)" strokeWidth={2.2} dot={false} />
                {selectedRow?.flightTime != null && <ReferenceDot yAxisId="left" x={speed} y={selectedRow.flightTime} r={4.5} fill="var(--color-flightTime)" stroke="white" strokeWidth={2} />}
                {selectedRow?.distance != null && <ReferenceDot yAxisId="right" x={speed} y={selectedRow.distance} r={4.5} fill="var(--color-distance)" stroke="white" strokeWidth={2} />}
              </>
            )}
          </LineChart>
        </ChartContainer>
    </div>
  );
}

function ComparePreview({
  label,
  draft,
  cameraGroup,
  cameraId,
  cameraLinked,
  assembly,
  bladeCount,
}: {
  label: string;
  draft: DesignDraft;
  cameraGroup: string;
  cameraId: 'baseline' | 'draft';
  cameraLinked: boolean;
  assembly: AssemblyInfo | null;
  bladeCount: 2 | 4;
}) {
  return (
    <div className="relative min-h-0 overflow-hidden bg-[#eef3f6]">
      <ParametricUavViewer
        draft={draft}
        assembly={assembly}
        bladeCount={bladeCount}
        cameraFitPadding={1.62}
        cameraSync={{ group: cameraGroup, id: cameraId, linked: cameraLinked }}
      />
      <span className="pointer-events-none absolute left-3 top-3 z-20 rounded-lg border border-white/70 bg-white/90 px-3 py-1.5 text-xs font-semibold text-[#3c3c43] shadow-sm backdrop-blur">
        {label}
      </span>
    </div>
  );
}

function CompareMetric({ label, before, after, unit, invert = false }: { label: string; before: number; after: number; unit: string; invert?: boolean }) {
  const change = percentChange(before, after);
  const good = change != null && (invert ? change <= 0 : change >= 0);
  const beforeAvailable = isAvailableMetric(before);
  const afterAvailable = isAvailableMetric(after);
  const digits = unit === 'W' || unit === 's' ? 0 : 1;
  return (
    <div className="rounded-lg bg-[#f5f5f7] p-3">
      <p className="text-[10px] text-[#86868b]">{label}</p>
      <p className="mt-1 font-mono text-xs text-[#86868b]">{beforeAvailable ? formatMetric(before, digits) : '—'} →</p>
      <p className="mt-0.5 font-mono text-sm font-semibold text-[#3c3c43]">{afterAvailable ? `${formatMetric(after, digits)} ${unit}` : '—'}</p>
      <p className={`mt-1 font-mono text-[10px] ${good ? 'text-emerald-700' : 'text-amber-700'}`}>{change == null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`}</p>
    </div>
  );
}

function ParameterSection({ value, icon, title, count, advanced = false, hint, children }: { value: string; icon: React.ReactNode; title: string; count: number; advanced?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <AccordionItem value={value} className="border-[#e5e5ea]">
      <AccordionTrigger className="px-1 py-3 hover:no-underline">
        <span className="flex items-center gap-2 text-[#3c3c43] [&>svg]:size-4 [&>svg]:text-[#3182f6]">
          {icon}{title}
          {advanced && <Badge variant="outline" className="h-5 border-[#e5e5ea] text-[9px] text-[#86868b]">전문가용</Badge>}
          {hint && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    aria-label={`${title} 설명`}
                    className="grid size-4 shrink-0 cursor-help place-items-center rounded-full text-[#86868b] hover:bg-[#e5e5ea] hover:text-[#3182f6]"
                  />
                }
              >
                <Info className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent className="max-w-64 text-left leading-5 whitespace-normal">{hint}</TooltipContent>
            </Tooltip>
          )}
        </span>
        <span className="mr-2 text-[10px] font-normal text-[#86868b]">{count}</span>
      </AccordionTrigger>
      <AccordionContent className="space-y-3 px-1 pb-4">{children}</AccordionContent>
    </AccordionItem>
  );
}

/**
 * `geometryOnly`는 3D 형상에만 반영되고 AI 성능 예측에는 쓰이지 않는 값이다.
 * 어느 값이 그런지는 backend/app/performance_features.py 의
 * `unsupported_changes()`가 정한다. 예측 응답의 `unsupportedInputs`에도 같은
 * 키가 실려 오므로, 예측 패널의 안내와 이 배지가 어긋나면 둘 중 하나가
 * 낡은 것이다. 지금 대상은 암 각도·오프셋, 동체 바닥 높이, 탑재 중량,
 * 내부 배치, 날개 회전·조종면·튜브 오프셋이다.
 */
function NumberSlider({ label, unit, min, max, step, value, baseline, onChange, geometryOnly = false }: { label: string; unit: string; min: number; max: number; step: number; value: number; baseline: number; onChange: (value: number) => void; geometryOnly?: boolean }) {
  const changed = Math.abs(value - baseline) > Math.max(step / 2, 0.0001);
  const safeMin = Math.min(min, Math.floor(baseline), Math.floor(value));
  const safeMax = Math.max(max, Math.ceil(baseline), Math.ceil(value));
  const digits = step < 1 ? 1 : 0;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const skipCommitRef = useRef(false);

  const commit = (raw: string) => {
    setEditing(false);
    const parsed = Number(raw.replace(/,/g, '').trim());
    if (!Number.isFinite(parsed)) {
      setText(formatMetric(value, digits));
      return;
    }
    const clamped = Math.min(safeMax, Math.max(safeMin, parsed));
    if (Math.abs(clamped - value) > Math.max(step / 2, 0.0001)) onChange(clamped);
    else setText(formatMetric(value, digits));
  };

  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-2 flex items-center justify-between gap-2 text-[11px]">
        <span className="flex items-center gap-1 text-[#6e6e73]">
          {label}
          {geometryOnly && (
            <span
              title="이 값은 3D 형상에만 반영되고 AI 성능 예측에는 쓰이지 않습니다."
              className="rounded bg-[#f0f0f2] px-1 py-px text-[9px] font-medium text-[#86868b]"
            >
              형상만
            </span>
          )}
        </span>
        <span className="flex items-center gap-1.5">
          {changed && <button onClick={() => onChange(baseline)} aria-label={`${label} 초기화`} className="rounded p-0.5 text-[#86868b] hover:bg-[#e5e5ea] hover:text-[#3c3c43]"><RotateCcw className="size-3" /></button>}
          <span className="flex items-center gap-1">
            <input
              type="text"
              inputMode="decimal"
              value={editing ? text : formatMetric(value, digits)}
              onFocus={() => { setEditing(true); setText(formatMetric(value, digits)); }}
              onChange={(event) => setText(event.target.value)}
              onBlur={(event) => {
                if (skipCommitRef.current) {
                  skipCommitRef.current = false;
                  return;
                }
                commit(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
                else if (event.key === 'Escape') {
                  skipCommitRef.current = true;
                  setText(formatMetric(value, digits));
                  setEditing(false);
                  event.currentTarget.blur();
                }
              }}
              aria-label={`${label} 값 직접 입력`}
              className={`w-16 rounded border border-transparent bg-transparent px-1 text-right font-mono font-semibold outline-none hover:border-[#e5e5ea] focus:border-[#3182f6] focus:bg-white ${changed ? 'text-[#1b64da]' : 'text-[#3c3c43]'}`}
            />
            <span className="text-[#86868b]">{unit}</span>
          </span>
        </span>
      </div>
      <Slider value={[value]} min={safeMin} max={safeMax} step={step} onValueChange={(next) => onChange(Number(Array.isArray(next) ? next[0] : next))} aria-label={label} className="[&_[data-slot=slider-range]]:bg-[#3182f6]" />
      <div className="mt-1.5 flex justify-between font-mono text-[9px] text-[#86868b]"><span>{safeMin}</span><span>기준 {formatMetric(baseline, step < 1 ? 1 : 0)}</span><span>{safeMax}</span></div>
    </div>
  );
}

function SourceParameterControl({
  definition,
  nacaOptions,
  onChange,
}: {
  definition: ParameterDefinition;
  nacaOptions: string[];
  onChange: (value: number | string | boolean | null) => void;
}) {
  const baseline = definition.baseline;
  const value = definition.value;
  const impactLabel = definition.affectsPerformance
    ? '3D + 성능'
    : definition.affectsGeometry
      ? '3D 반영'
      : '참조값';
  return (
    <div className="rounded-xl bg-[#f5f5f7] p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-all font-mono text-[10px] font-semibold text-[#3c3c43]">{definition.label}</p>
          <p className="mt-1 text-[9px] text-[#86868b]">{GROUP_LABELS[definition.group]} · {definition.optimization ?? 'CAD 파생값'}</p>
        </div>
        <Badge variant="outline" className={`h-5 shrink-0 px-1.5 text-[8px] ${definition.affectsPerformance ? 'border-[#bfdbfe] text-[#1b64da]' : 'border-[#e5e5ea] text-[#86868b]'}`}>{impactLabel}</Badge>
      </div>
      {typeof value === 'number' && definition.range && definition.step ? (
        <NumberSlider
          label={definition.label}
          unit={definition.unit ?? ''}
          min={definition.range.min}
          max={definition.range.max}
          step={definition.step}
          value={value}
          baseline={typeof baseline === 'number' ? baseline : value}
          onChange={onChange}
        />
      ) : typeof value === 'boolean' ? (
        <div className="flex items-center justify-between py-1 text-[11px] text-[#6e6e73]">
          <span>{value ? '켜짐' : '꺼짐'}</span>
          <div className="flex items-center gap-2">
            {value !== baseline && (
              <button onClick={() => onChange(Boolean(baseline))} aria-label={`${definition.label} 초기화`} className="rounded p-1 text-[#86868b] hover:bg-[#e5e5ea]"><RotateCcw className="size-3" /></button>
            )}
            <Switch aria-label={definition.label} checked={value} onCheckedChange={(checked) => onChange(Boolean(checked))} size="sm" disabled={!definition.editable} />
          </div>
        </div>
      ) : typeof value === 'string' && /NACA|PROFILE/i.test(definition.label) ? (
        <ControlSelect label="날개 단면 (NACA)" value={value} options={nacaOptions} baseline={String(baseline ?? '')} onChange={onChange} />
      ) : (
        <ReadOnlyValue label="값" value={String(value ?? '—')} note="3D 형상에만 반영되는 파생값 · 읽기 전용" />
      )}
      {definition.compatibility && <p className="mt-2 text-[9px] text-[#86868b]">{definition.compatibility}</p>}
    </div>
  );
}

function ControlSelect({ label, value, options, baseline, format = formatComponent, onChange }: { label: string; value: string; options: string[]; baseline?: string; format?: (value: string) => string; onChange: (value: string) => void }) {
  const changed = Boolean(baseline && value !== baseline);
  const safeOptions = options.includes(value) ? options : [value, ...options];
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] text-[#6e6e73]">{label}</span>
        {changed && baseline && <button onClick={() => onChange(baseline)} aria-label={`${label} 초기화`} className="rounded p-0.5 text-[#86868b] hover:bg-[#e5e5ea]"><RotateCcw className="size-3" /></button>}
      </div>
      <Select value={value} onValueChange={(next) => onChange(String(next))}>
        <SelectTrigger className={`h-9 w-full border-[#e5e5ea] bg-white text-xs ${changed ? 'text-[#1b64da]' : 'text-[#3c3c43]'}`}><SelectValue /></SelectTrigger>
        <SelectContent className="max-h-72 max-w-[360px] border-[#e5e5ea] bg-white text-[#3c3c43]">
          {safeOptions.filter(Boolean).map((option) => <SelectItem key={option} value={option}>{format(option)}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

function WingControls({ wing, baseline, nacaOptions, onChange }: { wing: WingParameters; baseline: WingParameters; nacaOptions: string[]; onChange: (mutator: (wing: WingParameters) => void) => void }) {
  return (
    <div className="rounded-xl bg-[#f5f5f7] p-3">
      <p className="mb-3 flex items-center justify-between text-xs font-semibold text-[#3c3c43]">날개 세트<span className="font-normal text-[#6e6e73]">{formatComponent(wing.type)}</span></p>
      <ControlSelect label="날개 단면 (NACA)" value={wing.nacaProfile} options={nacaOptions} baseline={baseline.nacaProfile} onChange={(value) => onChange((next) => { next.nacaProfile = value; })} />
      <NumberSlider label="날개 폭 (Span)" unit="mm" min={200} max={2000} step={1} value={wing.span} baseline={baseline.span} onChange={(value) => onChange((next) => { next.span = value; })} />
      <NumberSlider label="안쪽 날개 깊이" unit="mm" min={100} max={500} step={1} value={wing.chordInner} baseline={baseline.chordInner} onChange={(value) => onChange((next) => { next.chordInner = value; if (next.chordOuter > value) next.chordOuter = value; })} />
      <NumberSlider label="바깥쪽 날개 깊이" unit="mm" min={50} max={Math.max(50, wing.chordInner)} step={1} value={Math.min(wing.chordOuter, wing.chordInner)} baseline={Math.min(baseline.chordOuter, wing.chordInner)} onChange={(value) => onChange((next) => { next.chordOuter = value; })} />
      <NumberSlider label="장착 각도" unit="°" min={0} max={360} step={1} value={wing.rotation} baseline={baseline.rotation} onChange={(value) => onChange((next) => { next.rotation = value; })} geometryOnly />
      <NumberSlider label="결합 튜브 오프셋" unit="mm" min={-100} max={160} step={1} value={wing.tubeOffset} baseline={baseline.tubeOffset} onChange={(value) => onChange((next) => { next.tubeOffset = value; })} geometryOnly />
      <NumberSlider label="에일러론 비율" unit="" min={0.1} max={1} step={0.01} value={wing.aileronBias} baseline={baseline.aileronBias} onChange={(value) => onChange((next) => { next.aileronBias = value; })} geometryOnly />
      <NumberSlider label="플랩 비율" unit="" min={0.1} max={1} step={0.01} value={wing.flapBias} baseline={baseline.flapBias} onChange={(value) => onChange((next) => { next.flapBias = value; })} geometryOnly />
    </div>
  );
}

function ReadOnlyValue({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl bg-[#f5f5f7] p-3">
      <div className="flex items-center justify-between gap-3 text-xs"><span className="text-[#6e6e73]">{label}</span><strong className="truncate text-right text-[#3c3c43]">{value}</strong></div>
      {note && <p className="mt-1.5 text-[10px] text-[#86868b]">{note}</p>}
    </div>
  );
}

function ModeButton({ active, onClick, children, disabled = false }: { active: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return <button onClick={onClick} disabled={disabled} className={`rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${active ? 'bg-white text-[#1b64da] shadow-sm' : 'text-[#6e6e73] hover:text-[#3c3c43]'}`}>{children}</button>;
}

function EstimateRow({ icon, label, before, after, unit, better }: { icon: React.ReactNode; label: string; before: number; after: number; unit: string; better: 'up' | 'down' }) {
  const change = percentChange(before, after);
  const improved = change != null && (better === 'up' ? change >= 0 : change <= 0);
  const digits = unit === 'W' || unit === 'sec' ? 0 : 1;
  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs text-[#6e6e73] [&>svg]:size-3.5">{icon}{label}</span>
        <span className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] ${change == null ? 'bg-[#f5f5f7] text-[#86868b]' : improved ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{change == null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`}</span>
      </div>
      <div className="mt-1.5 grid grid-cols-[1fr_auto_1fr] items-center gap-2 font-mono text-xs">
        <span className="text-[#86868b]">{isAvailableMetric(before) ? formatMetric(before, digits) : '—'}</span>
        <ChevronRight className="size-3 text-[#86868b]" />
        <strong className="text-right text-[#3c3c43]">{isAvailableMetric(after) ? `${formatMetric(after, digits)} ${unit}` : '—'}</strong>
      </div>
    </div>
  );
}

function applySourceParameter(
  draft: DesignDraft,
  parameterId: string,
  value: number | string | boolean | null,
) {
  const definition = draft.parameterDefinitions.find((item) => item.id === parameterId);
  if (!definition) return;
  const previous = definition.value;
  definition.value = value;
  const token = `${definition.label} ${definition.optimization ?? ''}`.toUpperCase();
  const numeric = typeof value === 'number' ? value : Number.NaN;
  const baseline = typeof definition.baseline === 'number' ? definition.baseline : Number.NaN;
  const delta = Number.isFinite(numeric) && Number.isFinite(baseline) ? numeric - baseline : 0;
  const close = (candidate: number) => Number.isFinite(baseline) && Math.abs(candidate - baseline) <= Math.max(0.02, Math.abs(baseline) * 0.0001);

  if (Number.isFinite(numeric) && /ARM_.*LENGTH|ROTATEDARM_.*LENGTH|ARM_LENGTH/.test(token)) {
    const exact = draft.segments.filter((segment) => close(segment.length));
    const targets = exact.length
      ? exact
      : [...draft.segments].sort((left, right) => Math.abs(left.length - baseline) - Math.abs(right.length - baseline)).slice(0, 1);
    targets.forEach((segment) => {
      segment.length = Math.max(1, exact.length ? numeric : segment.length + delta);
    });
  } else if (Number.isFinite(numeric) && /CLOCK_ANGLE|ANGHORZCONN|ROT2|BODY_ROT_ANGLE/.test(token)) {
    const exact = draft.segments.filter((segment) => close(segment.angle));
    const targets = exact.length ? exact : draft.segments.slice(0, 1);
    targets.forEach((segment) => {
      segment.angle = exact.length ? numeric : segment.angle + delta;
    });
  } else if (Number.isFinite(numeric) && /FUSELAGE_LENGTH/.test(token)) {
    draft.fuselage.length = numeric;
  } else if (Number.isFinite(numeric) && /FUSELAGE_(?:HORZ|HORIZONTAL)/.test(token)) {
    draft.fuselage.horizontalDiameter = numeric;
  } else if (Number.isFinite(numeric) && /FUSELAGE_(?:VERT|VERTICAL)/.test(token)) {
    draft.fuselage.verticalDiameter = numeric;
  } else if (Number.isFinite(numeric) && /FUSELAGE_FLOOR/.test(token)) {
    draft.fuselage.floorHeight = numeric;
  } else if (Number.isFinite(numeric) && /CARGOMASS|CARGO_MASS/.test(token)) {
    draft.payload.mass = numeric;
  } else if (/WING_.*NACA|NACA_PROFILE/.test(token) && typeof value === 'string') {
    draft.wings.forEach((wing) => {
      if (String(wing.nacaProfile) === String(previous)) wing.nacaProfile = value;
    });
  } else if (Number.isFinite(numeric) && /WING_.*SPAN/.test(token)) {
    draft.wings.forEach((wing) => { if (close(wing.span)) wing.span = numeric; });
  } else if (Number.isFinite(numeric) && /WING_.*CHORD.*(?:1|INNER)/.test(token)) {
    draft.wings.forEach((wing) => { if (close(wing.chordInner)) wing.chordInner = numeric; });
  } else if (Number.isFinite(numeric) && /WING_.*CHORD.*(?:2|OUTER)/.test(token)) {
    draft.wings.forEach((wing) => { if (close(wing.chordOuter)) wing.chordOuter = numeric; });
  } else if (Number.isFinite(numeric) && /WING_.*(?:TUBE_)?ROT/.test(token)) {
    draft.wings.forEach((wing) => { if (close(wing.rotation)) wing.rotation = numeric; });
  } else if (Number.isFinite(numeric) && /WING_.*TUBE_OFFSET/.test(token)) {
    draft.wings.forEach((wing) => { if (close(wing.tubeOffset)) wing.tubeOffset = numeric; });
  } else if (Number.isFinite(numeric) && /WING_.*AILERON/.test(token)) {
    draft.wings.forEach((wing) => { if (close(wing.aileronBias)) wing.aileronBias = numeric; });
  } else if (Number.isFinite(numeric) && /WING_.*FLAP/.test(token)) {
    draft.wings.forEach((wing) => { if (close(wing.flapBias)) wing.flapBias = numeric; });
  } else if (Number.isFinite(numeric) && /FUSELAGE_.*_[XY](?:\s|$)/.test(token)) {
    const axis = /_X(?:\s|$)/.test(token) ? 'x' : 'y';
    const normalizedToken = token.replace(/[^A-Z0-9]/g, '');
    const entry = Object.entries(draft.layout).find(([name]) => normalizedToken.includes(name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()));
    if (entry) entry[1][axis] = numeric;
  }
}

function syncSegmentComponent(draft: DesignDraft, segmentId: string, key: 'motorType' | 'propellerType', value: string) {
  const segment = draft.segments.find((item) => item.id === segmentId);
  if (segment) segment[key] = value;
}

function draftDifferences(baseline: DesignDraft, draft: DesignDraft) {
  const rows: Array<{ label: string; before: string; after: string }> = [];
  const add = (label: string, before: number | string | boolean, after: number | string | boolean, unit = '') => {
    if (before === after) return;
    const show = (value: number | string | boolean) => typeof value === 'number' ? `${formatMetric(value, Number.isInteger(value) ? 0 : 1)}${unit}` : typeof value === 'boolean' ? (value ? 'On' : 'Off') : formatComponent(value);
    rows.push({ label, before: show(before), after: show(after) });
  };
  draft.parameterDefinitions.forEach((definition, index) => {
    const base = baseline.parameterDefinitions[index];
    if (!base || definition.value == null || base.value == null) return;
    add(definition.label, base.value, definition.value, definition.unit ?? '');
  });
  draft.segments.forEach((segment, index) => {
    const base = baseline.segments[index];
    if (!base) return;
    add(`Segment ${index + 1} arm`, base.length, segment.length, 'mm');
    add(`Segment ${index + 1} angle`, base.angle, segment.angle, '°');
    add(`Segment ${index + 1} offset`, base.offset, segment.offset, 'mm');
  });
  add('Fuselage length', baseline.fuselage.length, draft.fuselage.length, 'mm');
  add('Fuselage horizontal', baseline.fuselage.horizontalDiameter, draft.fuselage.horizontalDiameter, 'mm');
  add('Fuselage vertical', baseline.fuselage.verticalDiameter, draft.fuselage.verticalDiameter, 'mm');
  draft.propulsionGroups.forEach((group, index) => {
    const base = baseline.propulsionGroups[index];
    if (!base) return;
    add(`Motor ${index + 1}`, base.motorType, group.motorType);
    add(`Propeller ${index + 1}`, base.propellerType, group.propellerType);
  });
  draft.energy.batteryTypes.forEach((battery, index) => add(`Battery ${index + 1}`, baseline.energy.batteryTypes[index] ?? '—', battery));
  draft.wings.forEach((wing, index) => {
    const base = baseline.wings[index];
    if (!base) return;
    add(`Wing ${index + 1} span`, base.span, wing.span, 'mm');
    add(`Wing ${index + 1} inner chord`, base.chordInner, wing.chordInner, 'mm');
    add(`Wing ${index + 1} outer chord`, base.chordOuter, wing.chordOuter, 'mm');
    add(`Wing ${index + 1} NACA`, base.nacaProfile, wing.nacaProfile);
  });
  add('Cargo mass', baseline.payload.mass, draft.payload.mass, 'kg');
  return rows;
}

/**
 * 부품 탭. 종류별로 묶어 보여주고, 고르면 3D에서 그 부품만 제 색으로 남고
 * 나머지는 색을 잃는다. 작은 부품은 3D에서 직접 누르기 어려워 목록이 필요하다.
 * 파라미터 아코디언 안에 두면 펼칠 때마다 다른 항목이 밀려나서 탭으로 분리했다.
 */
function PartsPanel({ assembly, selected, onSelect, openTypes, onToggleType, search }: {
  assembly: AssemblyInfo;
  selected: string[];
  onSelect: (names: string[]) => void;
  openTypes: string[];
  onToggleType: (type: string) => void;
  search: string;
}) {
  const groups = useMemo(() => {
    const byType = new Map<string, PartPlacement[]>();
    for (const part of assembly.placements) {
      const type = assembly.typeOf.get(part.n);
      // 조립 루트와 기준 좌표계는 형상이 없어 고를 것이 없다.
      if (!type || type === 'Orient') continue;
      byType.set(type, [...(byType.get(type) ?? []), part]);
    }
    return [...byType].sort((a, b) => b[1].length - a[1].length);
  }, [assembly]);

  const needle = search.trim().toLowerCase();
  const visible = needle
    ? groups.filter(([type, parts]) =>
        type.toLowerCase().includes(needle) ||
        parts.some((part) => part.n.toLowerCase().includes(needle)))
    : groups;
  if (!visible.length) return null;

  const total = groups.reduce((sum, [, parts]) => sum + parts.length, 0);
  const chosen = new Set(selected);
  const swatch = (type: string) => `#${(TYPE_COLORS[type] ?? 0x9aa7ad).toString(16).padStart(6, '0')}`;

  return (
    <div className="grid gap-1.5 px-3 pb-5 pt-3">
      <p className="px-0.5 pb-1 text-[10px] leading-4 text-[#86868b]">
        3D는 기본이 무채색입니다. 여기서 고른 부품에만 색이 입혀지고 나머지는
        흐려집니다. 종류를 누르면 같은 종류 전체가, 화살표를 펼치면 하나씩 고를 수
        있습니다. 여러 개를 함께 고를 수 있어요.
      </p>
      {selected.length > 0 && (
        <button
          type="button"
          onClick={() => onSelect([])}
          className="mb-1 w-full rounded-xl bg-[#1d1d1f] px-3 py-2 text-xs font-semibold text-white"
        >
          색 전부 지우기 ({selected.length}개)
        </button>
      )}
      {visible.map(([type, parts]) => {
        const names = parts.map((part) => part.n);
        const allChosen = names.every((name) => chosen.has(name));
        const someChosen = names.some((name) => chosen.has(name));
        const open = openTypes.includes(type);
        return (
          <div
            key={type}
            className={`overflow-hidden rounded-xl ${someChosen ? 'bg-white ring-1 ring-[#d5d5da]' : 'bg-[#f5f5f7]'}`}
          >
            <div className="flex items-center gap-2 p-2.5">
              <span className="size-3 shrink-0 rounded-full" style={{ background: swatch(type) }} />
              <button
                type="button"
                onClick={() => onSelect(
                  allChosen
                    ? selected.filter((name) => !names.includes(name))
                    : [...selected, ...names.filter((name) => !chosen.has(name))],
                )}
                className={`min-w-0 flex-1 text-left text-xs font-semibold ${someChosen ? 'text-[#1d1d1f]' : 'text-[#3c3c43]'}`}
              >
                {type.replaceAll('_', ' ')}
                <span className="ml-1.5 font-normal text-[#86868b]">
                  {someChosen ? `${names.filter((name) => chosen.has(name)).length}/${parts.length}` : parts.length}
                </span>
              </button>
              {parts.length > 1 && (
                <button
                  type="button"
                  aria-label={`${type} 목록 펼치기`}
                  onClick={() => onToggleType(type)}
                  className="shrink-0 rounded-md px-1 text-[#6e6e73] hover:bg-white"
                >
                  <ChevronRight className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
                </button>
              )}
            </div>
            {open && parts.length > 1 && (
              <div className="grid gap-1 px-2.5 pb-2.5">
                {parts.map((part) => {
                  const active = chosen.has(part.n);
                  return (
                    <button
                      key={part.n}
                      type="button"
                      onClick={() => onSelect(
                        active
                          ? selected.filter((name) => name !== part.n)
                          : [...selected, part.n],
                      )}
                      className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] ${active ? 'bg-white font-semibold text-[#1d1d1f] shadow-sm' : 'text-[#6e6e73] hover:bg-white/60'}`}
                    >
                      <span className="truncate">{part.n}</span>
                      {part.s && (
                        <span className="shrink-0 tabular-nums text-[10px] text-[#86868b]">
                          {part.s.map((value) => Math.round(value)).join('×')}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      <p className="mt-2 px-0.5 text-[10px] text-[#86868b]">
        모두 {total}개 · {visible.length}종
      </p>
    </div>
  );
}
