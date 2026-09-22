'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BatteryCharging,
  Box,
  ChevronRight,
  CircleGauge,
  GitCompareArrows,
  Info,
  Layers3,
  MousePointer2,
  Package,
  Plane,
  RotateCcw,
  Ruler,
  Search,
  SlidersHorizontal,
  ShoppingBag,
  Weight,
  Wind,
  Zap,
} from 'lucide-react';

import { PerformancePredictionPanel } from './performance-prediction-panel';
import { ParametricUavViewer, TYPE_COLORS } from '@/components/parametric-uav-viewer';
import { StlViewer } from '@/components/stl-viewer';
import { cloneDraft } from '@/lib/design-draft';
import { countChanges, estimateDraft } from '@/lib/design-performance';
import type { DesignWorkspace } from '@/hooks/use-design-workspace';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
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
  ParameterDefinition,
  ParameterGroup,
  PartPlacement,
  ShowcaseDesign,
  WingParameters,
} from '@/lib/drawn-types';
import { formatBatteryLabel, formatComponent, formatEnergyConfiguration, formatMetric, formatMotorLabel, formatPropellerLabel, isAvailableMetric, percentChange } from '@/lib/drawn-types';
import { DataDisclaimer, DesignSelector, SectionHeading } from '@/components/views/shared';

type MobilePanel = 'parameters' | 'preview' | 'performance';

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
  designs,
  selected,
  referenceDesign,
  datasetDesigns = [],
  onSelect,
  onOpenDatasetCompare,
  onOpenParts,
  workspace,
  focusedParameterId,
}: {
  designs: Array<Pick<DesignSummary, 'id' | 'numPropellers' | 'numWings'>>;
  selected: DesignSummary;
  referenceDesign?: ShowcaseDesign | null;
  datasetDesigns?: DesignSummary[];
  onSelect: (id: number) => void;
  onOpenDatasetCompare: () => void;
  onOpenParts: () => void;
  workspace: DesignWorkspace;
  focusedParameterId?: string | null;
}) {
  const { baseline, draft, setDraft, catalogs, placements, loading, loadError } = workspace;
  const [mode, setMode] = useState<DraftGeometryMode>('parametric-preview');
  const [showGhost, setShowGhost] = useState(false);
  const [changedGroup, setChangedGroup] = useState<ParameterGroup | null>(null);
  const [search, setSearch] = useState('');
  const [openSections, setOpenSections] = useState<string[]>(['structure', 'fuselage', 'propulsion']);
  const [expertMode, setExpertMode] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('preview');
  const [compareOpen, setCompareOpen] = useState(false);
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
  /** 왼쪽 패널 탭. 부품 목록이 파라미터 아코디언에 끼면 매번 밀려 내려간다. */
  const [panelTab, setPanelTab] = useState<'parameters' | 'parts'>('parameters');
  const [estimateState, setEstimateState] = useState<'ready' | 'calculating'>('ready');
  const [estimateImpact, setEstimateImpact] = useState<'performance' | 'geometry-only'>('performance');
  const highlightTimeoutRef = useRef<number | null>(null);
  const estimateTimeoutRef = useRef<number | null>(null);
  const packagedReference = referenceDesign ?? ('modelPath' in selected ? selected as ShowcaseDesign : null);
  // 배포된 STL이 없어도 개발 PC의 원본에서 받아올 수 있다.
  const originalStlUrl = packagedReference?.modelPath ?? `/local-model/${selected.id}`;

  const focusedParameter = draft?.parameterDefinitions.find((definition) => definition.id === focusedParameterId || definition.path === focusedParameterId);
  const focusId = focusedParameter?.id;
  const focusLabel = focusedParameter?.label;
  useEffect(() => {
    if (!focusId || !focusLabel) return;
    let scrollFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      setSearch(focusLabel);
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
  }, [focusId, focusLabel]);
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
  const parameterCount = draft?.parameterDefinitions?.length ?? 0;
  const editableParameterCount = draft?.parameterDefinitions?.filter((item) => item.editable).length ?? 0;
  const query = search.trim().toLocaleLowerCase('ko-KR');
  const groupVisible = (group: ParameterGroup, terms: string[]) => !query
    || GROUP_LABELS[group].toLocaleLowerCase('ko-KR').includes(query)
    || terms.some((term) => term.toLocaleLowerCase('ko-KR').includes(query));

  return (
    <section className="@container/lab px-3 py-4 lg:px-5">
      <SectionHeading
        eyebrow={`파라메트릭 Design Studio / Baseline #${selected.id}`}
        title="설계 파라미터와 3D를 한 화면에서 조정하세요"
        description="치수·부품·날개 조건을 편집하고, 속도별 AI 예측과 기존 설계 KPI를 함께 확인하세요."
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={onOpenParts} disabled={loading || !draft} className="bg-[#3182f6] text-white hover:bg-[#1b64da]"><ShoppingBag className="size-4" />부품 찾기</Button>
            {expertMode && <Badge variant="outline" className="border-[#bfdbfe] bg-[#eff6ff] text-[#1b64da]">원본 {parameterCount} · 편집 가능 {editableParameterCount}</Badge>}
            <DesignSelector designs={designs} value={selected.id} onChange={onSelect} />
          </div>
        )}
      />

      <div className="mb-3 grid grid-cols-3 rounded-xl bg-[#f5f5f7] p-1 @min-[900px]/lab:hidden">
        {([
          ['parameters', '파라미터', SlidersHorizontal],
          ['preview', '3D', Box],
          ['performance', '성능', Activity],
        ] as const).map(([id, label, Icon]) => (
          <button key={id} aria-pressed={mobilePanel === id} onClick={() => setMobilePanel(id)} className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-semibold transition ${mobilePanel === id ? 'bg-white text-[#1d1d1f] shadow-sm' : 'text-[#6e6e73]'}`}>
            <Icon className={`size-3.5 ${mobilePanel === id ? 'text-[#3182f6]' : ''}`} /> {label}
          </button>
        ))}
      </div>

      <div className="grid gap-3 @min-[900px]/lab:h-[calc(100vh-205px)] @min-[900px]/lab:min-h-[560px] @min-[900px]/lab:grid-cols-[minmax(260px,.85fr)_minmax(360px,1.5fr)_minmax(230px,.75fr)]">
        <aside className={`${mobilePanel === 'parameters' ? 'block' : 'hidden'} min-h-[560px] overflow-hidden rounded-2xl border border-[#e5e5ea] bg-white shadow-sm @min-[900px]/lab:block`}>
          <div className="border-b border-[#e5e5ea] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-[#1d1d1f]">설계 파라미터</p>
                <p className="mt-1 text-xs text-[#6e6e73]">{changedCount ? `${changedCount}개 변경됨` : 'Baseline과 동일'}</p>
              </div>
              <Button size="icon-sm" variant="ghost" onClick={resetAll} disabled={!changedCount} aria-label="전체 초기화" className="text-[#6e6e73]"><RotateCcw /></Button>
            </div>
            <div className="relative mt-3">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[#86868b]" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="파라미터 검색" className="h-9 border-[#e5e5ea] bg-[#f5f5f7] pl-8 text-xs" />
            </div>
            {panelTab === 'parameters' && (
              <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-[#f5f5f7] px-3 py-2">
                <div>
                  <p className="text-xs font-medium text-[#6e6e73]">전문가 모드</p>
                  <p className="mt-0.5 text-[10px] leading-4 text-[#86868b]">데이터셋 원본 변수 {parameterCount}개를 그대로 편집합니다</p>
                </div>
                <Switch checked={expertMode} onCheckedChange={toggleExpertMode} size="sm" aria-label="전문가 모드" />
              </div>
            )}
            {placements && (
              <div className="mt-3 grid grid-cols-2 rounded-xl bg-[#f5f5f7] p-1">
                {([
                  ['parameters', '파라미터', SlidersHorizontal],
                  ['parts', '부품', Package],
                ] as const).map(([id, label, Icon]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setPanelTab(id)}
                    aria-pressed={panelTab === id}
                    className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-semibold transition ${panelTab === id ? 'bg-white text-[#1d1d1f] shadow-sm' : 'text-[#6e6e73]'}`}
                  >
                    <Icon className={`size-3.5 ${panelTab === id ? 'text-[#3182f6]' : ''}`} />
                    {label}
                    {id === 'parts' && selectedParts.length > 0 && (
                      <span className="rounded-full bg-[#3182f6] px-1.5 text-[10px] text-white">{selectedParts.length}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <ScrollArea className="h-[500px] @min-[900px]/lab:h-[calc(100%-116px)]">
            {loading || !draft || !baseline ? (
              <div className="grid h-80 place-items-center text-xs text-[#6e6e73]">설계 파라미터를 준비하고 있습니다…</div>
            ) : panelTab === 'parts' && placements ? (
              <PartsPanel
                assembly={placements}
                selected={selectedParts}
                onSelect={setSelectedParts}
                openTypes={openTypes}
                onToggleType={(type) => setOpenTypes((current) =>
                  current.includes(type)
                    ? current.filter((item) => item !== type)
                    : [...current, type])}
                search={search}
              />
            ) : (
              <Accordion multiple value={openSections} onValueChange={(value) => setOpenSections(value.map(String))} className="px-3 pb-5">
                {groupVisible('structure', ['topology', 'hub', 'arm', 'angle', 'offset', '구조', '길이']) && (
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

                {groupVisible('fuselage', ['동체', 'length', 'diameter', 'floor', '길이', '직경']) && (
                  <ParameterSection value="fuselage" icon={<Box />} title="동체" count={4} hint={GROUP_HINTS.fuselage}>
                    <NumberSlider label="길이" unit="mm" min={84} max={559} step={1} value={draft.fuselage.length} baseline={baseline.fuselage.length} onChange={(value) => mutateDraft('fuselage', (next) => { next.fuselage.length = value; })} />
                    <NumberSlider label="가로 지름" unit="mm" min={120} max={805} step={1} value={draft.fuselage.horizontalDiameter} baseline={baseline.fuselage.horizontalDiameter} onChange={(value) => mutateDraft('fuselage', (next) => { next.fuselage.horizontalDiameter = value; })} />
                    <NumberSlider label="세로 지름" unit="mm" min={51} max={354} step={1} value={draft.fuselage.verticalDiameter} baseline={baseline.fuselage.verticalDiameter} onChange={(value) => mutateDraft('fuselage', (next) => { next.fuselage.verticalDiameter = value; })} />
                    <NumberSlider label="바닥 높이" unit="mm" min={8} max={60} step={0.5} value={draft.fuselage.floorHeight} baseline={baseline.fuselage.floorHeight} onChange={(value) => mutateDraft('fuselage', (next) => { next.fuselage.floorHeight = value; })} geometryOnly />
                  </ParameterSection>
                )}

                {groupVisible('propulsion', ['motor', 'propeller', '추진', '모터', '프로펠러']) && (
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

                {groupVisible('energy', ['battery', '배터리', '전력', 'energy']) && (
                  <ParameterSection value="energy" icon={<BatteryCharging />} title="전력 시스템" count={draft.energy.batteryTypes.length} hint={GROUP_HINTS.energy}>
                    {draft.energy.batteryTypes.map((battery, index) => (
                      <ControlSelect key={`${index}-${battery}`} label={`배터리 ${index + 1}`} value={battery} options={catalogs.batteries} baseline={baseline.energy.batteryTypes[index]} format={formatBatteryLabel} onChange={(value) => mutateDraft('energy', (next) => { next.energy.batteryTypes[index] = value; })} />
                    ))}
                    <ReadOnlyValue label="배터리 구성" value={formatEnergyConfiguration(draft.energy.configuration)} />
                  </ParameterSection>
                )}

                {draft.wings.length > 0 && groupVisible('wing', ['wing', 'naca', 'span', 'chord', '날개']) && (
                  <ParameterSection value="wing" icon={<Plane />} title="날개" count={draft.wings.length * 9} hint={GROUP_HINTS.wing}>
                    {draft.wings.map((wing, index) => (
                      <WingControls key={wing.id} wing={wing} baseline={baseline.wings[index] ?? wing} nacaOptions={catalogs.nacaProfiles} onChange={(mutator) => mutateDraft('wing', (next) => mutator(next.wings[index]))} />
                    ))}
                  </ParameterSection>
                )}

                {groupVisible('payload', ['payload', 'cargo', '탑재', '중량']) && (
                  <ParameterSection value="payload" icon={<Weight />} title="탑재 중량" count={1} advanced hint={GROUP_HINTS.payload}>
                    <NumberSlider label="탑재 화물 질량" unit="kg" min={0} max={20} step={0.1} value={draft.payload.mass} baseline={baseline.payload.mass} onChange={(value) => mutateDraft('payload', (next) => { next.payload.mass = value; })} geometryOnly />
                  </ParameterSection>
                )}

                {Object.keys(draft.layout).length > 0 && groupVisible('layout', ['sensor', 'battery x', 'battery y', '센서', '배치']) && (
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
                  {(draft.parameterDefinitions ?? [])
                    .filter((definition) => !query || `${definition.label} ${GROUP_LABELS[definition.group]} ${definition.optimization ?? ''}`.toLocaleLowerCase('ko-KR').includes(query))
                    .map((definition) => (
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
        </aside>

        <div className={`${mobilePanel === 'preview' ? 'block' : 'hidden'} min-h-[560px] overflow-hidden rounded-2xl border border-[#e5e5ea] bg-[#f5f5f7] shadow-sm @min-[900px]/lab:block`}>
          <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-[#e5e5ea] bg-white px-3 py-2.5">
              <div className="flex rounded-lg bg-[#f5f5f7] p-1">
                <ModeButton active={mode === 'parametric-preview'} onClick={() => setMode('parametric-preview')}>설계 미리보기</ModeButton>
                <ModeButton active={mode === 'exact-stl'} onClick={() => setMode('exact-stl')}>원본 STL</ModeButton>
                <ModeButton active={sideBySide} onClick={() => setSideBySide((value) => !value)}>나란히</ModeButton>
              </div>
              <Badge variant="outline" className={mode === 'parametric-preview' ? 'border-[#bfdbfe] bg-[#eff6ff] text-[#1b64da]' : 'border-[#e5e5ea] bg-white text-[#6e6e73]'}>
                {mode === 'parametric-preview' ? '개념 형상 · 제조용 CAD 아님' : `AircraftVerse #${selected.id}`}
              </Badge>
              <div className="ml-auto flex items-center gap-2 text-xs text-[#6e6e73]">
                <Switch aria-label="기준 설계 Ghost 표시" checked={showGhost} onCheckedChange={setShowGhost} size="sm" disabled={mode === 'exact-stl'} />
                <span>기준 Ghost</span>
              </div>
            </div>
            <div className="relative min-h-0 flex-1">
              {loading ? (
                <div className="absolute inset-0 grid place-items-center text-sm text-[#6e6e73]">Design #{selected.id} 형상을 불러오는 중…</div>
              ) : draft && baseline && sideBySide ? (
                <div className="absolute inset-0 grid grid-cols-2 divide-x divide-[#e5e5ea]">
                  <div className="relative">
                    <ParametricUavViewer draft={draft} baseline={baseline} showGhost={showGhost} changedGroup={changedGroup} assembly={placements} bladeCount={bladeCount} selection={selectedParts} onSelectionChange={setSelectedParts} syncGroup={`compare-${selected.id}`} />
                    <span className="pointer-events-none absolute left-3 top-3 z-20 rounded-md bg-white/90 px-2 py-1 text-[10px] font-semibold text-[#3182f6] backdrop-blur">개념 형상</span>
                  </div>
                  <div className="relative">
                    <StlViewer key={originalStlUrl} src={originalStlUrl} />
                    <span className="pointer-events-none absolute left-3 top-3 z-20 rounded-md bg-white/90 px-2 py-1 text-[10px] font-semibold text-[#6e6e73] backdrop-blur">원본 STL</span>
                  </div>
                </div>
              ) : draft && baseline && mode === 'parametric-preview' ? (
                <ParametricUavViewer draft={draft} baseline={baseline} showGhost={showGhost} changedGroup={changedGroup} assembly={placements} bladeCount={bladeCount} selection={selectedParts} onSelectionChange={setSelectedParts} />
              ) : (
                <StlViewer key={originalStlUrl} src={originalStlUrl} />
              )}
              {mode === 'parametric-preview' && <div className="pointer-events-none absolute bottom-3 left-3 z-20 flex items-center gap-2 rounded-lg border border-[#e5e5ea] bg-white/90 px-3 py-2 text-[11px] text-[#6e6e73] shadow-sm backdrop-blur">
                <MousePointer2 className="size-3" /> 드래그 회전 · 스크롤 확대
              </div>}
              {mode === 'parametric-preview' && (
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
                <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-lg bg-[#3182f6] px-3 py-2 text-xs font-semibold text-white shadow-sm">
                  {GROUP_LABELS[changedGroup]} 반영됨
                </div>
              )}
            </div>
            <div className="grid grid-cols-3 border-t border-[#e5e5ea] bg-white text-center text-xs">
              <ViewerStat label="팔 전체 폭" value={`${formatMetric(maxArmSpan(draft), 0)} mm`} />
              <ViewerStat label="동체 길이" value={draft ? `${formatMetric(draft.fuselage.length, 0)} mm` : '—'} />
              <ViewerStat label="날개 수" value={draft ? `${draft.numWings || draft.wings.length}개` : '—'} />
            </div>
          </div>
        </div>

        <aside className={`${mobilePanel === 'performance' ? 'block' : 'hidden'} min-h-[560px] overflow-hidden rounded-2xl border border-[#e5e5ea] bg-white shadow-sm @min-[900px]/lab:block`}>
          <ScrollArea className="h-full">
            <div className="p-4">
              <div className="mb-5"><PerformancePredictionPanel designId={selected.id} draft={draft} disabled={loading || !draft} inputError={loadError} compact /></div>
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

              <div className="mt-4 rounded-xl border border-[#e5e5ea] bg-white p-3 text-xs">
                <p className="font-semibold text-[#3c3c43]">변경 요약</p>
                <div className="mt-2 flex items-center justify-between text-[#6e6e73]"><span>편집된 파라미터</span><strong className="font-mono text-[#1b64da]">{changedCount}</strong></div>
                <div className="mt-2 flex items-center justify-between text-[#6e6e73]"><span>파라메트릭 상태</span><strong className="text-emerald-700">실시간</strong></div>
              </div>

              <Button onClick={() => setCompareOpen(true)} disabled={!draft || !baseline} className="mt-4 h-10 w-full bg-[#3182f6] text-white hover:bg-[#1b64da]">
                <GitCompareArrows /> Baseline과 비교 <ChevronRight />
              </Button>
              <Button onClick={onOpenDatasetCompare} variant="ghost" className="mt-1 h-9 w-full text-xs text-[#6e6e73] hover:bg-[#f5f5f7]">
                데이터셋 설계끼리 A/B 비교
              </Button>
              <DataDisclaimer compact />
            </div>
          </ScrollArea>
        </aside>
      </div>

      {loadError && (
        <p className="mt-2 text-[11px] text-amber-700">전체 설계 트리를 읽지 못해 대표 설계의 호환 파라미터로 표시했습니다: {loadError}</p>
      )}

      <Dialog open={compareOpen} onOpenChange={setCompareOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto border-[#e5e5ea] bg-[#f5f5f7] p-5 text-[#1d1d1f] sm:max-w-[1180px]">
          <DialogHeader>
            <DialogTitle className="text-xl">Baseline vs 현재 Draft</DialogTitle>
            <DialogDescription>같은 카메라 방향의 개념 형상과 변경된 파라미터·성능을 함께 비교합니다.</DialogDescription>
          </DialogHeader>
          {baseline && draft && estimate && (
            <div className="mt-2 space-y-4">
              <div className="grid gap-3 lg:grid-cols-2">
                <ComparePreview label={`A · Baseline #${selected.id}`} draft={baseline} />
                <ComparePreview label="B · 현재 Draft" draft={draft} />
              </div>
              <div className="grid gap-3 lg:grid-cols-[1fr_1.2fr]">
                <div className="rounded-xl border border-[#e5e5ea] bg-white p-4">
                  <p className="text-sm font-semibold">변경된 파라미터</p>
                  <div className="mt-3 max-h-52 overflow-y-auto divide-y divide-[#e5e5ea]">
                    {draftDifferences(baseline, draft).length ? draftDifferences(baseline, draft).slice(0, 24).map((item, index) => (
                      <div key={`${item.label}-${index}`} className="grid grid-cols-[1fr_auto_auto] gap-2 py-2 text-xs">
                        <span className="text-[#6e6e73]">{item.label}</span>
                        <span className="font-mono text-[#86868b]">{item.before}</span>
                        <span className="font-mono font-semibold text-[#1b64da]">→ {item.after}</span>
                      </div>
                    )) : <p className="py-8 text-center text-xs text-[#86868b]">아직 변경된 파라미터가 없습니다.</p>}
                  </div>
                </div>
                <div className="rounded-xl border border-[#e5e5ea] bg-white p-4">
                  <p className="text-sm font-semibold">성능 변화</p>
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <CompareMetric label="비행거리" before={selected.maxDistance / 1000} after={estimate.range / 1000} unit="km" />
                    <CompareMetric label="체공시간" before={selected.hoverTime} after={estimate.hover} unit="s" />
                    <CompareMetric label="최고속도" before={selected.maxSpeed} after={estimate.maxSpeed} unit="m/s" />
                    <CompareMetric label="소비전력" before={selected.power} after={estimate.power} unit="W" invert />
                    <CompareMetric label="항력" before={selected.dragAt20} after={estimate.drag} unit="N" invert />
                    <CompareMetric label="질량" before={selected.mass} after={estimate.mass} unit="kg" invert />
                  </div>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ComparePreview({ label, draft }: { label: string; draft: DesignDraft }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[#e5e5ea] bg-white">
      <div className="border-b border-[#e5e5ea] px-3 py-2 text-xs font-semibold text-[#3c3c43]">{label}</div>
      <div className="relative h-64 bg-[#f5f5f7]"><ParametricUavViewer draft={draft} syncGroup={`draft-compare-${draft.baselineId}`} /></div>
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

function ViewerStat({ label, value }: { label: string; value: string }) {
  return <div className="border-r border-[#e5e5ea] px-2 py-2.5 last:border-r-0"><span className="block text-[9px] uppercase tracking-[0.08em] text-[#86868b]">{label}</span><strong className="mt-0.5 block font-mono text-[11px] text-[#3c3c43]">{value}</strong></div>;
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

function maxArmSpan(draft: DesignDraft | null) {
  if (!draft) return 0;
  const distanceByPath = new Map<string, number>();
  const ordered = [...draft.segments].sort((left, right) => left.path.split('.').length - right.path.split('.').length);
  for (const segment of ordered) {
    const parentDistance = segment.parentPath ? distanceByPath.get(segment.parentPath) ?? 0 : 0;
    distanceByPath.set(segment.path, parentDistance + segment.length);
  }
  return Math.max(...distanceByPath.values(), ...draft.segments.map((segment) => segment.length), 0) * 2;
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
