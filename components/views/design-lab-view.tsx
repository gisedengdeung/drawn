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

import { ParametricUavViewer } from '@/components/parametric-uav-viewer';
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
  DesignDraft,
  DesignSummary,
  DraftGeometryMode,
  ParameterDefinition,
  ParameterGroup,
  ShowcaseDesign,
  WingParameters,
} from '@/lib/drawn-types';
import { formatBatteryLabel, formatComponent, formatEnergyConfiguration, formatMetric, formatMotorLabel, formatPropellerLabel, isAvailableMetric, percentChange } from '@/lib/drawn-types';
import { DataDisclaimer, DesignSelector, SectionHeading, SourceBadge } from '@/components/views/shared';

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
  const { baseline, draft, setDraft, catalogs, loading, loadError } = workspace;
  const [mode, setMode] = useState<DraftGeometryMode>('parametric-preview');
  const [showGhost, setShowGhost] = useState(false);
  const [changedGroup, setChangedGroup] = useState<ParameterGroup | null>(null);
  const [search, setSearch] = useState('');
  const [openSections, setOpenSections] = useState<string[]>(['structure', 'fuselage', 'propulsion']);
  const [expertMode, setExpertMode] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('preview');
  const [compareOpen, setCompareOpen] = useState(false);
  const [estimateState, setEstimateState] = useState<'ready' | 'calculating'>('ready');
  const [estimateImpact, setEstimateImpact] = useState<'performance' | 'geometry-only'>('performance');
  const highlightTimeoutRef = useRef<number | null>(null);
  const estimateTimeoutRef = useRef<number | null>(null);
  const packagedReference = referenceDesign ?? ('modelPath' in selected ? selected as ShowcaseDesign : null);

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
    <section className="px-3 py-4 lg:px-5">
      <SectionHeading
        eyebrow={`파라메트릭 Design Studio / Baseline #${selected.id}`}
        title="설계 파라미터와 3D를 한 화면에서 조정하세요"
        description="치수·부품·날개 조건은 즉시 개념 형상에 반영되고, 성능은 AircraftVerse 범위 안에서 데이터 유사도 기반으로 갱신됩니다."
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={onOpenParts} disabled={loading || !draft} className="bg-[#147d91] text-white hover:bg-[#106c7d]"><ShoppingBag className="size-4" />부품 agent에서 정리</Button>
            {expertMode && <Badge variant="outline" className="border-[#b8dfe4] bg-[#eef8fa] text-[#0f6475]">원본 {parameterCount} · 편집 가능 {editableParameterCount}</Badge>}
            <DesignSelector designs={designs} value={selected.id} onChange={onSelect} />
          </div>
        )}
      />

      <div className="mb-3 grid grid-cols-3 rounded-xl border border-[#dbe4ea] bg-white p-1 lg:hidden">
        {([
          ['parameters', '파라미터', SlidersHorizontal],
          ['preview', '3D', Box],
          ['performance', '성능', Activity],
        ] as const).map(([id, label, Icon]) => (
          <button key={id} onClick={() => setMobilePanel(id)} className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-semibold ${mobilePanel === id ? 'bg-[#147d91] text-white' : 'text-[#607383]'}`}>
            <Icon className="size-3.5" /> {label}
          </button>
        ))}
      </div>

      <div className="grid gap-3 lg:h-[calc(100vh-205px)] lg:min-h-[560px] lg:grid-cols-[minmax(260px,.85fr)_minmax(360px,1.5fr)_minmax(230px,.75fr)]">
        <aside className={`${mobilePanel === 'parameters' ? 'block' : 'hidden'} min-h-[560px] overflow-hidden rounded-2xl border border-[#dbe4ea] bg-white shadow-sm lg:block`}>
          <div className="border-b border-[#e2e9ee] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-[#172b3a]">설계 파라미터</p>
                <p className="mt-1 text-xs text-[#607383]">{changedCount ? `${changedCount}개 변경됨` : 'Baseline과 동일'}</p>
              </div>
              <Button size="icon-sm" variant="ghost" onClick={resetAll} disabled={!changedCount} aria-label="전체 초기화" className="text-[#607383]"><RotateCcw /></Button>
            </div>
            <div className="relative mt-3">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[#82919c]" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="파라미터 검색" className="h-9 border-[#dbe4ea] bg-[#f8fafb] pl-8 text-xs" />
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-[#e2e9ee] bg-[#f8fafb] px-3 py-2">
              <div>
                <p className="text-xs font-medium text-[#526675]">전문가 모드</p>
                <p className="mt-0.5 text-[10px] leading-4 text-[#8a99a4]">데이터셋 원본 변수 {parameterCount}개를 그대로 편집합니다</p>
              </div>
              <Switch checked={expertMode} onCheckedChange={toggleExpertMode} size="sm" aria-label="전문가 모드" />
            </div>
          </div>

          <ScrollArea className="h-[500px] lg:h-[calc(100%-116px)]">
            {loading || !draft || !baseline ? (
              <div className="grid h-80 place-items-center text-xs text-[#607383]">설계 파라미터를 준비하고 있습니다…</div>
            ) : (
              <Accordion multiple value={openSections} onValueChange={(value) => setOpenSections(value.map(String))} className="px-3 pb-5">
                {groupVisible('structure', ['topology', 'hub', 'arm', 'angle', 'offset', '구조', '길이']) && (
                  <ParameterSection value="structure" icon={<Layers3 />} title="기체 구조" count={1 + draft.segments.length * 3} hint={GROUP_HINTS.structure}>
                    <ReadOnlyValue label="허브 형태" value={formatComponent(draft.topology)} note="허브(몸통 중심) 형태 변경은 1단계 설계 선택에서 다른 설계를 고르면 됩니다." />
                    {draft.segments.map((segment, index) => (
                      <div key={segment.id} className="rounded-xl border border-[#e2e9ee] bg-[#f8fafb] p-3">
                        <p className="mb-3 flex items-center justify-between text-xs font-semibold text-[#294353]">
                          팔 {index + 1}<span className="font-normal text-[#7b8c98]">{formatComponent(segment.nodeType)}</span>
                        </p>
                        <NumberSlider label="팔 길이" unit="mm" min={50} max={520} step={1} value={segment.length} baseline={baseline.segments[index]?.length ?? segment.length} onChange={(value) => mutateDraft('structure', (next) => { next.segments[index].length = value; })} />
                        <NumberSlider label="장착 각도" unit="°" min={-135} max={360} step={1} value={segment.angle} baseline={baseline.segments[index]?.angle ?? segment.angle} onChange={(value) => mutateDraft('structure', (next) => { next.segments[index].angle = value; })} />
                        <NumberSlider label="결합 위치 오프셋" unit="mm" min={-50} max={50} step={1} value={segment.offset} baseline={baseline.segments[index]?.offset ?? segment.offset} onChange={(value) => mutateDraft('structure', (next) => { next.segments[index].offset = value; })} />
                      </div>
                    ))}
                  </ParameterSection>
                )}

                {groupVisible('fuselage', ['동체', 'length', 'diameter', 'floor', '길이', '직경']) && (
                  <ParameterSection value="fuselage" icon={<Box />} title="동체" count={4} hint={GROUP_HINTS.fuselage}>
                    <NumberSlider label="길이" unit="mm" min={84} max={559} step={1} value={draft.fuselage.length} baseline={baseline.fuselage.length} onChange={(value) => mutateDraft('fuselage', (next) => { next.fuselage.length = value; })} />
                    <NumberSlider label="가로 지름" unit="mm" min={120} max={805} step={1} value={draft.fuselage.horizontalDiameter} baseline={baseline.fuselage.horizontalDiameter} onChange={(value) => mutateDraft('fuselage', (next) => { next.fuselage.horizontalDiameter = value; })} />
                    <NumberSlider label="세로 지름" unit="mm" min={51} max={354} step={1} value={draft.fuselage.verticalDiameter} baseline={baseline.fuselage.verticalDiameter} onChange={(value) => mutateDraft('fuselage', (next) => { next.fuselage.verticalDiameter = value; })} />
                    <NumberSlider label="바닥 높이" unit="mm" min={8} max={60} step={0.5} value={draft.fuselage.floorHeight} baseline={baseline.fuselage.floorHeight} onChange={(value) => mutateDraft('fuselage', (next) => { next.fuselage.floorHeight = value; })} />
                  </ParameterSection>
                )}

                {groupVisible('propulsion', ['motor', 'propeller', '추진', '모터', '프로펠러']) && (
                  <ParameterSection value="propulsion" icon={<CircleGauge />} title="추진 시스템" count={draft.propulsionGroups.length * 2} hint={GROUP_HINTS.propulsion}>
                    {draft.propulsionGroups.map((propulsion, index) => (
                      <div key={propulsion.id} className="rounded-xl border border-[#e2e9ee] bg-[#f8fafb] p-3">
                        <p className="mb-2 text-xs font-semibold text-[#294353]">모터·프로펠러 세트 {index + 1}</p>
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
                    <NumberSlider label="탑재 화물 질량" unit="kg" min={0} max={20} step={0.1} value={draft.payload.mass} baseline={baseline.payload.mass} onChange={(value) => mutateDraft('payload', (next) => { next.payload.mass = value; })} />
                  </ParameterSection>
                )}

                {Object.keys(draft.layout).length > 0 && groupVisible('layout', ['sensor', 'battery x', 'battery y', '센서', '배치']) && (
                  <ParameterSection value="layout" icon={<Ruler />} title="내부 배치" count={Object.keys(draft.layout).length * 2} advanced hint={GROUP_HINTS.layout}>
                    {Object.entries(draft.layout).map(([name, position]) => (
                      <div key={name} className="rounded-xl border border-[#e2e9ee] bg-[#f8fafb] p-3">
                        <p className="mb-2 text-xs font-semibold capitalize text-[#294353]">{formatComponent(name)}</p>
                        <NumberSlider label="X 위치" unit="mm" min={-280} max={280} step={1} value={position.x} baseline={baseline.layout[name]?.x ?? position.x} onChange={(value) => mutateDraft('layout', (next) => { next.layout[name].x = value; }, false)} />
                        <NumberSlider label="Y 위치" unit="mm" min={-280} max={280} step={1} value={position.y} baseline={baseline.layout[name]?.y ?? position.y} onChange={(value) => mutateDraft('layout', (next) => { next.layout[name].y = value; }, false)} />
                      </div>
                    ))}
                  </ParameterSection>
                )}

                {expertMode && (
                <ParameterSection value="source-parameters" icon={<SlidersHorizontal />} title="전문가용 원본 변수" count={parameterCount} advanced hint="AircraftVerse 데이터셋 원본 변수명을 그대로 보여줍니다. 위 친화적 그룹과 같은 값이 다시 나타날 수 있어요 — 대부분은 위에서 조정하는 것만으로 충분하고, 이 목록은 원본 그대로 세밀하게 맞추고 싶을 때만 쓰면 됩니다.">
                  <div className="rounded-xl border border-[#cfe1e5] bg-[#eef8fa] p-3 text-[10px] leading-4 text-[#45616f]">
                    설계 원본의 {parameterCount}개 변수를 1:1로 보존합니다. 이름은 데이터셋 원본 표기라 위 그룹보다 낯설 수 있어요. 성능 계산에 쓰이는 변수는 실제로 반영되고, 나머지는 3D 형상에만 반영됩니다.
                  </div>
                  {(draft.parameterDefinitions ?? [])
                    .filter((definition) => !query || `${definition.label} ${GROUP_LABELS[definition.group]} ${definition.optimization ?? ''}`.toLocaleLowerCase('ko-KR').includes(query))
                    .map((definition) => (
                      <div key={definition.id} id={`source-parameter-${encodeURIComponent(definition.id)}`} tabIndex={-1} className="rounded-xl outline-none focus:ring-2 focus:ring-[#147d91]">
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

        <div className={`${mobilePanel === 'preview' ? 'block' : 'hidden'} min-h-[560px] overflow-hidden rounded-2xl border border-[#dbe4ea] bg-[#eef3f6] shadow-sm lg:block`}>
          <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-[#dbe4ea] bg-white px-3 py-2.5">
              <div className="flex rounded-lg bg-[#edf2f5] p-1">
                <ModeButton active={mode === 'parametric-preview'} onClick={() => setMode('parametric-preview')}>설계 미리보기</ModeButton>
                <ModeButton active={mode === 'exact-stl'} onClick={() => packagedReference && setMode('exact-stl')} disabled={!packagedReference}>원본 STL</ModeButton>
              </div>
              <Badge variant="outline" className={mode === 'parametric-preview' ? 'border-[#b8dfe4] bg-[#eef8fa] text-[#0f6475]' : 'border-[#d6dee4] bg-white text-[#607383]'}>
                {mode === 'parametric-preview' ? '개념 형상 · 제조용 CAD 아님' : `AircraftVerse #${selected.id}`}
              </Badge>
              <div className="ml-auto flex items-center gap-2 text-xs text-[#607383]">
                <Switch aria-label="기준 설계 Ghost 표시" checked={showGhost} onCheckedChange={setShowGhost} size="sm" disabled={mode === 'exact-stl'} />
                <span>기준 Ghost</span>
              </div>
            </div>
            <div className="relative min-h-0 flex-1">
              {loading ? (
                <div className="absolute inset-0 grid place-items-center text-sm text-[#607383]">Design #{selected.id} 형상을 불러오는 중…</div>
              ) : draft && baseline && mode === 'parametric-preview' ? (
                <ParametricUavViewer draft={draft} baseline={baseline} showGhost={showGhost} changedGroup={changedGroup} />
              ) : packagedReference ? (
                <StlViewer src={packagedReference.modelPath} />
              ) : (
                <div className="absolute inset-0 grid place-items-center text-sm text-[#607383]">이 설계에는 배포된 원본 STL이 없습니다.</div>
              )}
              {mode === 'parametric-preview' && <div className="pointer-events-none absolute bottom-3 left-3 z-20 flex items-center gap-2 rounded-lg border border-[#cfdae0] bg-white/90 px-3 py-2 text-[11px] text-[#607383] shadow-sm backdrop-blur">
                <MousePointer2 className="size-3" /> 드래그 회전 · 스크롤 확대
              </div>}
              {changedGroup && (
                <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-lg bg-[#147d91] px-3 py-2 text-xs font-semibold text-white shadow-sm">
                  {GROUP_LABELS[changedGroup]} 반영됨
                </div>
              )}
            </div>
            <div className="grid grid-cols-3 border-t border-[#dbe4ea] bg-white text-center text-xs">
              <ViewerStat label="팔 전체 폭" value={`${formatMetric(maxArmSpan(draft), 0)} mm`} />
              <ViewerStat label="동체 길이" value={draft ? `${formatMetric(draft.fuselage.length, 0)} mm` : '—'} />
              <ViewerStat label="날개 수" value={draft ? `${draft.numWings || draft.wings.length}개` : '—'} />
            </div>
          </div>
        </div>

        <aside className={`${mobilePanel === 'performance' ? 'block' : 'hidden'} min-h-[560px] overflow-hidden rounded-2xl border border-[#dbe4ea] bg-white shadow-sm lg:block`}>
          <ScrollArea className="h-full">
            <div className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-[#172b3a]">실시간 성능 변화</p>
                  <p className="mt-1 text-xs text-[#607383]">Baseline 대비 현재 Draft</p>
                </div>
                <SourceBadge source="INTERPOLATED" />
              </div>
              <div className="mt-3 rounded-xl border border-[#dbe4ea] bg-[#f8fafb] p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 font-medium text-[#294353]"><span className={`size-2 rounded-full ${estimateState === 'calculating' ? 'animate-pulse bg-amber-500' : estimateImpact === 'geometry-only' ? 'bg-[#147d91]' : 'bg-emerald-600'}`} />{estimateState === 'calculating' ? '성능 계산 중' : estimateImpact === 'geometry-only' ? '3D만 반영됨' : '업데이트됨'}</span>
                  <span className="font-mono text-[#607383]">{estimateImpact === 'geometry-only' ? '추정 입력 제외' : `${estimate?.similarity ?? 100}% 유사`}</span>
                </div>
                <p className="mt-2 text-[11px] text-[#738591]">{estimateImpact === 'geometry-only' ? '이 CAD 파생 파라미터는 데이터셋 KPI 거리 계산에 사용하지 않습니다.' : <>가장 가까운 AircraftVerse 설계 <strong className="text-[#294353]">#{estimate?.closestId ?? selected.id}</strong></>}</p>
              </div>

              {estimate && (
                <div className="mt-3 divide-y divide-[#e7edf1]">
                  <EstimateRow icon={<Ruler />} label="최대 비행거리" before={selected.maxDistance / 1000} after={estimate.range / 1000} unit="km" better="up" />
                  <EstimateRow icon={<CircleGauge />} label="최고 속도" before={selected.maxSpeed} after={estimate.maxSpeed} unit="m/s" better="up" />
                  <EstimateRow icon={<Activity />} label="체공 시간" before={selected.hoverTime} after={estimate.hover} unit="sec" better="up" />
                  <EstimateRow icon={<Zap />} label="소비전력" before={selected.power} after={estimate.power} unit="W" better="down" />
                  <EstimateRow icon={<Wind />} label="항력 (20m/s)" before={selected.dragAt20} after={estimate.drag} unit="N" better="down" />
                  <EstimateRow icon={<Weight />} label="질량" before={selected.mass} after={estimate.mass} unit="kg" better="down" />
                </div>
              )}

              <div className="mt-4 rounded-xl border border-[#dbe4ea] bg-white p-3 text-xs">
                <p className="font-semibold text-[#294353]">변경 요약</p>
                <div className="mt-2 flex items-center justify-between text-[#607383]"><span>편집된 파라미터</span><strong className="font-mono text-[#0f6475]">{changedCount}</strong></div>
                <div className="mt-2 flex items-center justify-between text-[#607383]"><span>파라메트릭 상태</span><strong className="text-emerald-700">실시간</strong></div>
              </div>

              <Button onClick={() => setCompareOpen(true)} disabled={!draft || !baseline} className="mt-4 h-10 w-full bg-[#147d91] text-white hover:bg-[#106c7d]">
                <GitCompareArrows /> Baseline과 비교 <ChevronRight />
              </Button>
              <Button onClick={onOpenDatasetCompare} variant="ghost" className="mt-1 h-9 w-full text-xs text-[#607383] hover:bg-[#f1f5f7]">
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
        <DialogContent className="max-h-[92vh] overflow-y-auto border-[#dbe4ea] bg-[#f7f9fb] p-5 text-[#172b3a] sm:max-w-[1180px]">
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
                <div className="rounded-xl border border-[#dbe4ea] bg-white p-4">
                  <p className="text-sm font-semibold">변경된 파라미터</p>
                  <div className="mt-3 max-h-52 overflow-y-auto divide-y divide-[#e7edf1]">
                    {draftDifferences(baseline, draft).length ? draftDifferences(baseline, draft).slice(0, 24).map((item, index) => (
                      <div key={`${item.label}-${index}`} className="grid grid-cols-[1fr_auto_auto] gap-2 py-2 text-xs">
                        <span className="text-[#607383]">{item.label}</span>
                        <span className="font-mono text-[#8a99a4]">{item.before}</span>
                        <span className="font-mono font-semibold text-[#0f6475]">→ {item.after}</span>
                      </div>
                    )) : <p className="py-8 text-center text-xs text-[#82919c]">아직 변경된 파라미터가 없습니다.</p>}
                  </div>
                </div>
                <div className="rounded-xl border border-[#dbe4ea] bg-white p-4">
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
    <div className="overflow-hidden rounded-xl border border-[#dbe4ea] bg-white">
      <div className="border-b border-[#dbe4ea] px-3 py-2 text-xs font-semibold text-[#294353]">{label}</div>
      <div className="relative h-64 bg-[#eef3f6]"><ParametricUavViewer draft={draft} syncGroup={`draft-compare-${draft.baselineId}`} /></div>
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
    <div className="rounded-lg border border-[#e2e9ee] bg-[#f8fafb] p-3">
      <p className="text-[10px] text-[#738591]">{label}</p>
      <p className="mt-1 font-mono text-xs text-[#82919c]">{beforeAvailable ? formatMetric(before, digits) : '—'} →</p>
      <p className="mt-0.5 font-mono text-sm font-semibold text-[#294353]">{afterAvailable ? `${formatMetric(after, digits)} ${unit}` : '—'}</p>
      <p className={`mt-1 font-mono text-[10px] ${good ? 'text-emerald-700' : 'text-amber-700'}`}>{change == null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`}</p>
    </div>
  );
}

function ParameterSection({ value, icon, title, count, advanced = false, hint, children }: { value: string; icon: React.ReactNode; title: string; count: number; advanced?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <AccordionItem value={value} className="border-[#e2e9ee]">
      <AccordionTrigger className="px-1 py-3 hover:no-underline">
        <span className="flex items-center gap-2 text-[#294353] [&>svg]:size-4 [&>svg]:text-[#147d91]">
          {icon}{title}
          {advanced && <Badge variant="outline" className="h-5 border-[#dbe4ea] text-[9px] text-[#738591]">전문가용</Badge>}
          {hint && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    aria-label={`${title} 설명`}
                    className="grid size-4 shrink-0 cursor-help place-items-center rounded-full text-[#9aabb5] hover:bg-[#e9eff3] hover:text-[#147d91]"
                  />
                }
              >
                <Info className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent className="max-w-64 text-left leading-5 whitespace-normal">{hint}</TooltipContent>
            </Tooltip>
          )}
        </span>
        <span className="mr-2 text-[10px] font-normal text-[#82919c]">{count}</span>
      </AccordionTrigger>
      <AccordionContent className="space-y-3 px-1 pb-4">{children}</AccordionContent>
    </AccordionItem>
  );
}

function NumberSlider({ label, unit, min, max, step, value, baseline, onChange }: { label: string; unit: string; min: number; max: number; step: number; value: number; baseline: number; onChange: (value: number) => void }) {
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
        <span className="text-[#607383]">{label}</span>
        <span className="flex items-center gap-1.5">
          {changed && <button onClick={() => onChange(baseline)} aria-label={`${label} 초기화`} className="rounded p-0.5 text-[#82919c] hover:bg-[#e9eff3] hover:text-[#294353]"><RotateCcw className="size-3" /></button>}
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
              className={`w-16 rounded border border-transparent bg-transparent px-1 text-right font-mono font-semibold outline-none hover:border-[#dbe4ea] focus:border-[#147d91] focus:bg-white ${changed ? 'text-[#0f7182]' : 'text-[#294353]'}`}
            />
            <span className="text-[#95a3ad]">{unit}</span>
          </span>
        </span>
      </div>
      <Slider value={[value]} min={safeMin} max={safeMax} step={step} onValueChange={(next) => onChange(Number(Array.isArray(next) ? next[0] : next))} aria-label={label} className="[&_[data-slot=slider-range]]:bg-[#147d91]" />
      <div className="mt-1.5 flex justify-between font-mono text-[9px] text-[#95a3ad]"><span>{safeMin}</span><span>기준 {formatMetric(baseline, step < 1 ? 1 : 0)}</span><span>{safeMax}</span></div>
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
    <div className="rounded-xl border border-[#e2e9ee] bg-[#f8fafb] p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-all font-mono text-[10px] font-semibold text-[#294353]">{definition.label}</p>
          <p className="mt-1 text-[9px] text-[#82919c]">{GROUP_LABELS[definition.group]} · {definition.optimization ?? 'CAD 파생값'}</p>
        </div>
        <Badge variant="outline" className={`h-5 shrink-0 px-1.5 text-[8px] ${definition.affectsPerformance ? 'border-[#b8dfe4] text-[#0f6475]' : 'border-[#dbe4ea] text-[#738591]'}`}>{impactLabel}</Badge>
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
        <div className="flex items-center justify-between py-1 text-[11px] text-[#607383]">
          <span>{value ? '켜짐' : '꺼짐'}</span>
          <div className="flex items-center gap-2">
            {value !== baseline && (
              <button onClick={() => onChange(Boolean(baseline))} aria-label={`${definition.label} 초기화`} className="rounded p-1 text-[#82919c] hover:bg-[#e9eff3]"><RotateCcw className="size-3" /></button>
            )}
            <Switch aria-label={definition.label} checked={value} onCheckedChange={(checked) => onChange(Boolean(checked))} size="sm" disabled={!definition.editable} />
          </div>
        </div>
      ) : typeof value === 'string' && /NACA|PROFILE/i.test(definition.label) ? (
        <ControlSelect label="날개 단면 (NACA)" value={value} options={nacaOptions} baseline={String(baseline ?? '')} onChange={onChange} />
      ) : (
        <ReadOnlyValue label="값" value={String(value ?? '—')} note="3D 형상에만 반영되는 파생값 · 읽기 전용" />
      )}
      {definition.compatibility && <p className="mt-2 text-[9px] text-[#82919c]">{definition.compatibility}</p>}
    </div>
  );
}

function ControlSelect({ label, value, options, baseline, format = formatComponent, onChange }: { label: string; value: string; options: string[]; baseline?: string; format?: (value: string) => string; onChange: (value: string) => void }) {
  const changed = Boolean(baseline && value !== baseline);
  const safeOptions = options.includes(value) ? options : [value, ...options];
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] text-[#607383]">{label}</span>
        {changed && baseline && <button onClick={() => onChange(baseline)} aria-label={`${label} 초기화`} className="rounded p-0.5 text-[#82919c] hover:bg-[#e9eff3]"><RotateCcw className="size-3" /></button>}
      </div>
      <Select value={value} onValueChange={(next) => onChange(String(next))}>
        <SelectTrigger className={`h-9 w-full border-[#dbe4ea] bg-white text-xs ${changed ? 'text-[#0f7182]' : 'text-[#294353]'}`}><SelectValue /></SelectTrigger>
        <SelectContent className="max-h-72 max-w-[360px] border-[#dbe4ea] bg-white text-[#294353]">
          {safeOptions.filter(Boolean).map((option) => <SelectItem key={option} value={option}>{format(option)}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

function WingControls({ wing, baseline, nacaOptions, onChange }: { wing: WingParameters; baseline: WingParameters; nacaOptions: string[]; onChange: (mutator: (wing: WingParameters) => void) => void }) {
  return (
    <div className="rounded-xl border border-[#e2e9ee] bg-[#f8fafb] p-3">
      <p className="mb-3 flex items-center justify-between text-xs font-semibold text-[#294353]">날개 세트<span className="font-normal text-[#7b8c98]">{formatComponent(wing.type)}</span></p>
      <ControlSelect label="날개 단면 (NACA)" value={wing.nacaProfile} options={nacaOptions} baseline={baseline.nacaProfile} onChange={(value) => onChange((next) => { next.nacaProfile = value; })} />
      <NumberSlider label="날개 폭 (Span)" unit="mm" min={200} max={2000} step={1} value={wing.span} baseline={baseline.span} onChange={(value) => onChange((next) => { next.span = value; })} />
      <NumberSlider label="안쪽 날개 깊이" unit="mm" min={100} max={500} step={1} value={wing.chordInner} baseline={baseline.chordInner} onChange={(value) => onChange((next) => { next.chordInner = value; if (next.chordOuter > value) next.chordOuter = value; })} />
      <NumberSlider label="바깥쪽 날개 깊이" unit="mm" min={50} max={Math.max(50, wing.chordInner)} step={1} value={Math.min(wing.chordOuter, wing.chordInner)} baseline={Math.min(baseline.chordOuter, wing.chordInner)} onChange={(value) => onChange((next) => { next.chordOuter = value; })} />
      <NumberSlider label="장착 각도" unit="°" min={0} max={360} step={1} value={wing.rotation} baseline={baseline.rotation} onChange={(value) => onChange((next) => { next.rotation = value; })} />
      <NumberSlider label="결합 튜브 오프셋" unit="mm" min={-100} max={160} step={1} value={wing.tubeOffset} baseline={baseline.tubeOffset} onChange={(value) => onChange((next) => { next.tubeOffset = value; })} />
      <NumberSlider label="에일러론 비율" unit="" min={0.1} max={1} step={0.01} value={wing.aileronBias} baseline={baseline.aileronBias} onChange={(value) => onChange((next) => { next.aileronBias = value; })} />
      <NumberSlider label="플랩 비율" unit="" min={0.1} max={1} step={0.01} value={wing.flapBias} baseline={baseline.flapBias} onChange={(value) => onChange((next) => { next.flapBias = value; })} />
    </div>
  );
}

function ReadOnlyValue({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-[#e2e9ee] bg-[#f8fafb] p-3">
      <div className="flex items-center justify-between gap-3 text-xs"><span className="text-[#607383]">{label}</span><strong className="truncate text-right text-[#294353]">{value}</strong></div>
      {note && <p className="mt-1.5 text-[10px] text-[#8a99a4]">{note}</p>}
    </div>
  );
}

function ModeButton({ active, onClick, children, disabled = false }: { active: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return <button onClick={onClick} disabled={disabled} className={`rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${active ? 'bg-white text-[#0f6475] shadow-sm' : 'text-[#607383] hover:text-[#294353]'}`}>{children}</button>;
}

function ViewerStat({ label, value }: { label: string; value: string }) {
  return <div className="border-r border-[#e2e9ee] px-2 py-2.5 last:border-r-0"><span className="block text-[9px] uppercase tracking-[0.08em] text-[#82919c]">{label}</span><strong className="mt-0.5 block font-mono text-[11px] text-[#294353]">{value}</strong></div>;
}

function EstimateRow({ icon, label, before, after, unit, better }: { icon: React.ReactNode; label: string; before: number; after: number; unit: string; better: 'up' | 'down' }) {
  const change = percentChange(before, after);
  const improved = change != null && (better === 'up' ? change >= 0 : change <= 0);
  const digits = unit === 'W' || unit === 'sec' ? 0 : 1;
  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs text-[#607383] [&>svg]:size-3.5">{icon}{label}</span>
        <span className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] ${change == null ? 'bg-[#edf2f5] text-[#738591]' : improved ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{change == null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`}</span>
      </div>
      <div className="mt-1.5 grid grid-cols-[1fr_auto_1fr] items-center gap-2 font-mono text-xs">
        <span className="text-[#82919c]">{isAvailableMetric(before) ? formatMetric(before, digits) : '—'}</span>
        <ChevronRight className="size-3 text-[#a4b0b8]" />
        <strong className="text-right text-[#294353]">{isAvailableMetric(after) ? `${formatMetric(after, digits)} ${unit}` : '—'}</strong>
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
