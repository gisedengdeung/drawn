'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BatteryCharging,
  Box,
  ChevronRight,
  CircleGauge,
  GitCompareArrows,
  Layers3,
  MousePointer2,
  Plane,
  RotateCcw,
  Ruler,
  Search,
  SlidersHorizontal,
  Weight,
  Wind,
  Zap,
} from 'lucide-react';

import { ParametricUavViewer } from '@/components/parametric-uav-viewer';
import { StlViewer } from '@/components/stl-viewer';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import type {
  ComponentCatalogs,
  DesignDraft,
  DesignSegment,
  DesignSummary,
  DraftGeometryMode,
  ParameterDefinition,
  ParameterGroup,
  ShowcaseDesign,
  WingParameters,
} from '@/lib/aerotwin-types';
import { formatComponent, formatMetric, isAvailableMetric, percentChange } from '@/lib/aerotwin-types';
import { DataDisclaimer, DesignSelector, SectionHeading, SourceBadge } from '@/components/views/shared';

type DraftEstimate = {
  mass: number;
  range: number;
  hover: number;
  maxSpeed: number;
  power: number;
  drag: number;
  similarity: number;
  closestId: number;
};

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

const EMPTY_CATALOGS: ComponentCatalogs = {
  motors: [],
  propellers: [],
  batteries: [],
  servos: [],
  nacaProfiles: [],
  nodeTypes: [],
};

export function DesignLabView({
  designs,
  selected,
  referenceDesign,
  datasetDesigns = [],
  onSelect,
  onOpenDatasetCompare,
  initialDraft = null,
  onDraftChange,
}: {
  designs: Array<Pick<DesignSummary, 'id' | 'numPropellers' | 'numWings'>>;
  selected: DesignSummary;
  referenceDesign?: ShowcaseDesign | null;
  datasetDesigns?: DesignSummary[];
  onSelect: (id: number) => void;
  onOpenDatasetCompare: () => void;
  initialDraft?: DesignDraft | null;
  onDraftChange?: (draft: DesignDraft) => void;
}) {
  const [baseline, setBaseline] = useState<DesignDraft | null>(null);
  const [draft, setDraft] = useState<DesignDraft | null>(null);
  // The parent keeps this snapshot across workflow steps. Do not reload on each edit.
  const initialDraftRef = useRef(initialDraft);
  useEffect(() => {
    if (draft) onDraftChange?.(draft);
  }, [draft, onDraftChange]);
  const [catalogs, setCatalogs] = useState<ComponentCatalogs>(EMPTY_CATALOGS);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<DraftGeometryMode>('parametric-preview');
  const [showGhost, setShowGhost] = useState(false);
  const [changedGroup, setChangedGroup] = useState<ParameterGroup | null>(null);
  const [search, setSearch] = useState('');
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('preview');
  const [compareOpen, setCompareOpen] = useState(false);
  const [estimateState, setEstimateState] = useState<'ready' | 'calculating'>('ready');
  const [estimateImpact, setEstimateImpact] = useState<'performance' | 'geometry-only'>('performance');
  const highlightTimeoutRef = useRef<number | null>(null);
  const estimateTimeoutRef = useRef<number | null>(null);
  const packagedReference = referenceDesign ?? ('modelPath' in selected ? selected as ShowcaseDesign : null);

  useEffect(() => {
    let active = true;
    window.queueMicrotask(() => {
      if (!active) return;
      setLoading(true);
      setLoadError(null);
      setBaseline(null);
      setDraft(null);
    });
    const shard = String(Math.floor(selected.id / 1000)).padStart(3, '0');
    Promise.all([
      fetch(`/data/design-trees/shard-${shard}.json`).then((response) => {
        if (!response.ok) throw new Error('설계 트리 shard를 불러오지 못했습니다.');
        return response.json() as Promise<Record<string, DesignDraft>>;
      }),
      fetch('/data/component-catalogs.json').then((response) => {
        if (!response.ok) throw new Error('부품 카탈로그를 불러오지 못했습니다.');
        return response.json() as Promise<ComponentCatalogs>;
      }),
    ])
      .then(([shardData, nextCatalogs]) => {
        if (!active) return;
        const loaded = shardData[String(selected.id)];
        if (!loaded) throw new Error(`Design #${selected.id}의 설계 트리가 없습니다.`);
        const nextDraft = hydrateDraft(loaded);
        setBaseline(nextDraft);
        setDraft(initialDraftRef.current?.baselineId === selected.id ? hydrateDraft(initialDraftRef.current) : cloneDraft(nextDraft));
        setCatalogs(nextCatalogs);
        setMode('parametric-preview');
      })
      .catch((reason: unknown) => {
        if (!active) return;
        const fallback = draftFromDesign(selected, packagedReference);
        setBaseline(fallback);
        setDraft(initialDraftRef.current?.baselineId === selected.id ? hydrateDraft(initialDraftRef.current) : cloneDraft(fallback));
        setCatalogs(packagedReference ? catalogsFromShowcases([packagedReference]) : EMPTY_CATALOGS);
        setLoadError(reason instanceof Error ? reason.message : '설계 트리 로딩 오류');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [packagedReference, selected]);

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
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="border-[#b8dfe4] bg-[#eef8fa] text-[#0f6475]">원본 {parameterCount} · 편집 가능 {editableParameterCount}</Badge>
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
          </div>

          <ScrollArea className="h-[500px] lg:h-[calc(100%-116px)]">
            {loading || !draft || !baseline ? (
              <div className="grid h-80 place-items-center text-xs text-[#607383]">설계 파라미터를 준비하고 있습니다…</div>
            ) : (
              <Accordion multiple defaultValue={['structure', 'fuselage', 'propulsion']} className="px-3 pb-5">
                {groupVisible('structure', ['topology', 'hub', 'arm', 'angle', 'offset', '구조', '길이']) && (
                  <ParameterSection value="structure" icon={<Layers3 />} title="기체 구조" count={1 + draft.segments.length * 3}>
                    <ReadOnlyValue label="Hub topology" value={formatComponent(draft.topology)} note="Topology 변경은 기준 설계 선택에서 수행" />
                    {draft.segments.map((segment, index) => (
                      <div key={segment.id} className="rounded-xl border border-[#e2e9ee] bg-[#f8fafb] p-3">
                        <p className="mb-3 flex items-center justify-between text-xs font-semibold text-[#294353]">
                          Segment {index + 1}<span className="font-normal text-[#7b8c98]">{formatComponent(segment.nodeType)}</span>
                        </p>
                        <NumberSlider label="Arm length" unit="mm" min={50} max={520} step={1} value={segment.length} baseline={baseline.segments[index]?.length ?? segment.length} onChange={(value) => mutateDraft('structure', (next) => { next.segments[index].length = value; })} />
                        <NumberSlider label="Angle" unit="°" min={-135} max={360} step={1} value={segment.angle} baseline={baseline.segments[index]?.angle ?? segment.angle} onChange={(value) => mutateDraft('structure', (next) => { next.segments[index].angle = value; })} />
                        <NumberSlider label="Flange offset" unit="mm" min={-50} max={50} step={1} value={segment.offset} baseline={baseline.segments[index]?.offset ?? segment.offset} onChange={(value) => mutateDraft('structure', (next) => { next.segments[index].offset = value; })} />
                      </div>
                    ))}
                  </ParameterSection>
                )}

                {groupVisible('fuselage', ['동체', 'length', 'diameter', 'floor', '길이', '직경']) && (
                  <ParameterSection value="fuselage" icon={<Box />} title="동체" count={4}>
                    <NumberSlider label="Length" unit="mm" min={84} max={559} step={1} value={draft.fuselage.length} baseline={baseline.fuselage.length} onChange={(value) => mutateDraft('fuselage', (next) => { next.fuselage.length = value; })} />
                    <NumberSlider label="Horizontal diameter" unit="mm" min={120} max={805} step={1} value={draft.fuselage.horizontalDiameter} baseline={baseline.fuselage.horizontalDiameter} onChange={(value) => mutateDraft('fuselage', (next) => { next.fuselage.horizontalDiameter = value; })} />
                    <NumberSlider label="Vertical diameter" unit="mm" min={51} max={354} step={1} value={draft.fuselage.verticalDiameter} baseline={baseline.fuselage.verticalDiameter} onChange={(value) => mutateDraft('fuselage', (next) => { next.fuselage.verticalDiameter = value; })} />
                    <NumberSlider label="Floor height" unit="mm" min={8} max={60} step={0.5} value={draft.fuselage.floorHeight} baseline={baseline.fuselage.floorHeight} onChange={(value) => mutateDraft('fuselage', (next) => { next.fuselage.floorHeight = value; })} />
                  </ParameterSection>
                )}

                {groupVisible('propulsion', ['motor', 'propeller', '추진', '모터', '프로펠러']) && (
                  <ParameterSection value="propulsion" icon={<CircleGauge />} title="추진 시스템" count={draft.propulsionGroups.length * 2}>
                    {draft.propulsionGroups.map((propulsion, index) => (
                      <div key={propulsion.id} className="rounded-xl border border-[#e2e9ee] bg-[#f8fafb] p-3">
                        <p className="mb-2 text-xs font-semibold text-[#294353]">Propulsion Group {index + 1}</p>
                        <ControlSelect label="Motor" value={propulsion.motorType} options={catalogs.motors} baseline={baseline.propulsionGroups[index]?.motorType} onChange={(value) => mutateDraft('propulsion', (next) => { next.propulsionGroups[index].motorType = value; syncSegmentComponent(next, propulsion.segmentId, 'motorType', value); })} />
                        <ControlSelect label="Propeller" value={propulsion.propellerType} options={catalogs.propellers} baseline={baseline.propulsionGroups[index]?.propellerType} onChange={(value) => mutateDraft('propulsion', (next) => { next.propulsionGroups[index].propellerType = value; syncSegmentComponent(next, propulsion.segmentId, 'propellerType', value); })} />
                      </div>
                    ))}
                  </ParameterSection>
                )}

                {groupVisible('energy', ['battery', '배터리', '전력', 'energy']) && (
                  <ParameterSection value="energy" icon={<BatteryCharging />} title="전력 시스템" count={draft.energy.batteryTypes.length}>
                    {draft.energy.batteryTypes.map((battery, index) => (
                      <ControlSelect key={`${index}-${battery}`} label={`Battery ${index + 1}`} value={battery} options={catalogs.batteries} baseline={baseline.energy.batteryTypes[index]} onChange={(value) => mutateDraft('energy', (next) => { next.energy.batteryTypes[index] = value; })} />
                    ))}
                    <ReadOnlyValue label="Configuration" value={formatComponent(draft.energy.configuration)} />
                  </ParameterSection>
                )}

                {draft.wings.length > 0 && groupVisible('wing', ['wing', 'naca', 'span', 'chord', '날개']) && (
                  <ParameterSection value="wing" icon={<Plane />} title="날개" count={draft.wings.length * 9}>
                    {draft.wings.map((wing, index) => (
                      <WingControls key={wing.id} wing={wing} baseline={baseline.wings[index] ?? wing} nacaOptions={catalogs.nacaProfiles} onChange={(mutator) => mutateDraft('wing', (next) => mutator(next.wings[index]))} />
                    ))}
                  </ParameterSection>
                )}

                {groupVisible('payload', ['payload', 'cargo', '탑재', '중량']) && (
                  <ParameterSection value="payload" icon={<Weight />} title="탑재 중량" count={1} advanced>
                    <NumberSlider label="Cargo mass" unit="kg" min={0} max={20} step={0.1} value={draft.payload.mass} baseline={baseline.payload.mass} onChange={(value) => mutateDraft('payload', (next) => { next.payload.mass = value; })} />
                  </ParameterSection>
                )}

                {Object.keys(draft.layout).length > 0 && groupVisible('layout', ['sensor', 'battery x', 'battery y', '센서', '배치']) && (
                  <ParameterSection value="layout" icon={<Ruler />} title="내부 배치" count={Object.keys(draft.layout).length * 2} advanced>
                    {Object.entries(draft.layout).map(([name, position]) => (
                      <div key={name} className="rounded-xl border border-[#e2e9ee] bg-[#f8fafb] p-3">
                        <p className="mb-2 text-xs font-semibold capitalize text-[#294353]">{formatComponent(name)}</p>
                        <NumberSlider label="X offset" unit="mm" min={-280} max={280} step={1} value={position.x} baseline={baseline.layout[name]?.x ?? position.x} onChange={(value) => mutateDraft('layout', (next) => { next.layout[name].x = value; }, false)} />
                        <NumberSlider label="Y offset" unit="mm" min={-280} max={280} step={1} value={position.y} baseline={baseline.layout[name]?.y ?? position.y} onChange={(value) => mutateDraft('layout', (next) => { next.layout[name].y = value; }, false)} />
                      </div>
                    ))}
                  </ParameterSection>
                )}

                <ParameterSection value="source-parameters" icon={<SlidersHorizontal />} title="AircraftVerse 원본 파라미터" count={parameterCount} advanced>
                  <div className="rounded-xl border border-[#cfe1e5] bg-[#eef8fa] p-3 text-[10px] leading-4 text-[#45616f]">
                    설계 원본의 {parameterCount}개 파라미터를 1:1로 보존합니다. Optimization 파라미터는 성능 근접도에, CAD 파생 파라미터는 개념 형상에만 반영됩니다.
                  </div>
                  {(draft.parameterDefinitions ?? [])
                    .filter((definition) => !query || `${definition.label} ${GROUP_LABELS[definition.group]} ${definition.optimization ?? ''}`.toLocaleLowerCase('ko-KR').includes(query))
                    .map((definition) => (
                      <SourceParameterControl
                        key={definition.id}
                        definition={definition}
                        nacaOptions={catalogs.nacaProfiles}
                        onChange={(value) => mutateDraft(
                          definition.group,
                          (next) => applySourceParameter(next, definition.id, value),
                          definition.affectsPerformance,
                        )}
                      />
                    ))}
                </ParameterSection>
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
              <ViewerStat label="Arm span" value={`${formatMetric(maxArmSpan(draft), 0)} mm`} />
              <ViewerStat label="Fuselage" value={draft ? `${formatMetric(draft.fuselage.length, 0)} mm` : '—'} />
              <ViewerStat label="Wings" value={draft ? `${draft.numWings || draft.wings.length} physical` : '—'} />
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

function ParameterSection({ value, icon, title, count, advanced = false, children }: { value: string; icon: React.ReactNode; title: string; count: number; advanced?: boolean; children: React.ReactNode }) {
  return (
    <AccordionItem value={value} className="border-[#e2e9ee]">
      <AccordionTrigger className="px-1 py-3 hover:no-underline">
        <span className="flex items-center gap-2 text-[#294353] [&>svg]:size-4 [&>svg]:text-[#147d91]">{icon}{title}{advanced && <Badge variant="outline" className="h-5 border-[#dbe4ea] text-[9px] text-[#738591]">Advanced</Badge>}</span>
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
          <p className="mt-1 text-[9px] text-[#82919c]">{GROUP_LABELS[definition.group]} · {definition.optimization ?? 'CAD derived'}</p>
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
          <span>{value ? 'Enabled' : 'Disabled'}</span>
          <div className="flex items-center gap-2">
            {value !== baseline && (
              <button onClick={() => onChange(Boolean(baseline))} aria-label={`${definition.label} 초기화`} className="rounded p-1 text-[#82919c] hover:bg-[#e9eff3]"><RotateCcw className="size-3" /></button>
            )}
            <Switch aria-label={definition.label} checked={value} onCheckedChange={(checked) => onChange(Boolean(checked))} size="sm" disabled={!definition.editable} />
          </div>
        </div>
      ) : typeof value === 'string' && /NACA|PROFILE/i.test(definition.label) ? (
        <ControlSelect label="Profile" value={value} options={nacaOptions} baseline={String(baseline ?? '')} onChange={onChange} />
      ) : (
        <ReadOnlyValue label="Value" value={String(value ?? '—')} note="파생 CAD 파라미터 · 읽기 전용" />
      )}
      {definition.compatibility && <p className="mt-2 text-[9px] text-[#82919c]">{definition.compatibility}</p>}
    </div>
  );
}

function ControlSelect({ label, value, options, baseline, onChange }: { label: string; value: string; options: string[]; baseline?: string; onChange: (value: string) => void }) {
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
          {safeOptions.filter(Boolean).map((option) => <SelectItem key={option} value={option}>{formatComponent(option)}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

function WingControls({ wing, baseline, nacaOptions, onChange }: { wing: WingParameters; baseline: WingParameters; nacaOptions: string[]; onChange: (mutator: (wing: WingParameters) => void) => void }) {
  return (
    <div className="rounded-xl border border-[#e2e9ee] bg-[#f8fafb] p-3">
      <p className="mb-3 flex items-center justify-between text-xs font-semibold text-[#294353]">Wing group<span className="font-normal text-[#7b8c98]">{formatComponent(wing.type)}</span></p>
      <ControlSelect label="NACA profile" value={wing.nacaProfile} options={nacaOptions} baseline={baseline.nacaProfile} onChange={(value) => onChange((next) => { next.nacaProfile = value; })} />
      <NumberSlider label="Span" unit="mm" min={200} max={2000} step={1} value={wing.span} baseline={baseline.span} onChange={(value) => onChange((next) => { next.span = value; })} />
      <NumberSlider label="Inner chord" unit="mm" min={100} max={500} step={1} value={wing.chordInner} baseline={baseline.chordInner} onChange={(value) => onChange((next) => { next.chordInner = value; if (next.chordOuter > value) next.chordOuter = value; })} />
      <NumberSlider label="Outer chord" unit="mm" min={50} max={Math.max(50, wing.chordInner)} step={1} value={Math.min(wing.chordOuter, wing.chordInner)} baseline={Math.min(baseline.chordOuter, wing.chordInner)} onChange={(value) => onChange((next) => { next.chordOuter = value; })} />
      <NumberSlider label="Rotation" unit="°" min={0} max={360} step={1} value={wing.rotation} baseline={baseline.rotation} onChange={(value) => onChange((next) => { next.rotation = value; })} />
      <NumberSlider label="Tube offset" unit="mm" min={-100} max={160} step={1} value={wing.tubeOffset} baseline={baseline.tubeOffset} onChange={(value) => onChange((next) => { next.tubeOffset = value; })} />
      <NumberSlider label="Aileron bias" unit="" min={0.1} max={1} step={0.01} value={wing.aileronBias} baseline={baseline.aileronBias} onChange={(value) => onChange((next) => { next.aileronBias = value; })} />
      <NumberSlider label="Flap bias" unit="" min={0.1} max={1} step={0.01} value={wing.flapBias} baseline={baseline.flapBias} onChange={(value) => onChange((next) => { next.flapBias = value; })} />
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

function cloneDraft(value: DesignDraft) {
  return JSON.parse(JSON.stringify(value)) as DesignDraft;
}

function hydrateDraft(value: DesignDraft) {
  const draft = cloneDraft(value);
  if (draft.parameterDefinitions?.length || !draft.sourceParameters?.length) return draft;
  draft.parameterDefinitions = draft.sourceParameters.map(([name, parameterValue, optimization, targetCount], index) => {
    const group = classifyParameterGroup(name, optimization);
    const affectsGeometry = ['structure', 'fuselage', 'propulsion', 'energy', 'wing', 'layout', 'payload'].includes(group);
    const fixedDerived = /CONTROLCHANNELAUTO|CONTROL_CHANNEL_AUTO|FIXEDROTATION/i.test(name);
    return {
      id: `parameter:${name.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}:${index}`,
      path: `lowLevel.parameters.${index}`,
      label: name,
      group,
      unit: sourceParameterUnit(name, optimization),
      range: sourceParameterRange(name, optimization, parameterValue),
      step: sourceParameterStep(name, parameterValue),
      baseline: parameterValue,
      value: parameterValue,
      optimization,
      editable: !fixedDerived && (typeof parameterValue === 'number' || typeof parameterValue === 'boolean' || /NACA|PROFILE/i.test(name)),
      advanced: !optimization,
      affectsGeometry,
      affectsPerformance: Boolean(optimization) && group !== 'layout',
      compatibility: targetCount ? `${targetCount} CAD component${targetCount === 1 ? '' : 's'} linked` : null,
    };
  });
  return draft;
}

function classifyParameterGroup(name: string, optimization: string | null): ParameterGroup {
  const token = `${name} ${optimization ?? ''}`.toLowerCase();
  if (/cargo|payload|mass/.test(token)) return 'payload';
  if (/wing|naca|aileron|flap|servo/.test(token)) return 'wing';
  if (/battery.*(?:x|y)|sensor|autopilot|current.*(?:x|y)|voltage.*(?:x|y)|gps|vario|rpm.*(?:x|y)/.test(token)) return 'layout';
  if (/fuselage|diameter|floor|body_(?!rot)/.test(token)) return 'fuselage';
  if (/motor|propeller|prop_|rpm/.test(token)) return 'propulsion';
  if (/battery|capacity|voltage|current/.test(token)) return 'energy';
  return 'structure';
}

function sourceParameterUnit(name: string, optimization: string | null) {
  const token = `${name} ${optimization ?? ''}`.toLowerCase();
  if (/angle|rotation|_rot|clock/.test(token)) return '°';
  if (/mass|cargo|payload|load/.test(token)) return /wing.*load/.test(token) ? 'g' : 'kg';
  if (/length|span|chord|offset|diameter|height|(?:^|_)[xy](?:_|$)/.test(token)) return 'mm';
  return null;
}

function sourceParameterRange(name: string, optimization: string | null, value: number | string | boolean | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const token = `${name} ${optimization ?? ''}`.toLowerCase();
  if (/bias|ratio|taper.*offset/.test(token)) return { min: 0, max: 1 };
  if (/angle|rotation|_rot|clock/.test(token)) return { min: Math.min(-180, Math.floor(value)), max: Math.max(360, Math.ceil(value)) };
  if (/length|span|chord|diameter|height/.test(token)) return { min: 0, max: Math.max(Math.ceil(value * 2), Math.ceil(value), 10) };
  if (/offset|(?:^|_)[xy](?:_|$)/.test(token)) {
    const extent = Math.max(Math.ceil(Math.abs(value) * 2), 300);
    return { min: -extent, max: extent };
  }
  if (/mass|cargo|payload|load/.test(token)) return { min: 0, max: Math.max(Math.ceil(value * 2), 20) };
  const extent = Math.max(Math.abs(value), 1);
  return { min: Math.floor(value - extent), max: Math.ceil(value + extent) };
}

function sourceParameterStep(name: string, value: number | string | boolean | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (/bias|ratio/i.test(name)) return 0.01;
  if (/mass/i.test(name)) return 0.1;
  return Math.abs(value) < 10 && !Number.isInteger(value) ? 0.1 : 1;
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

function estimateDraft(selected: DesignSummary, draft: DesignDraft, baseline: DesignDraft, datasetDesigns: DesignSummary[]): DraftEstimate {
  if (countChanges(draft, baseline) === 0) {
    return {
      mass: selected.mass,
      range: selected.maxDistance,
      hover: selected.hoverTime,
      maxSpeed: selected.maxSpeed,
      power: selected.power,
      drag: selected.dragAt20,
      similarity: 100,
      closestId: selected.id,
    };
  }
  const baseArm = average(baseline.segments.map((item) => item.length), selected.armLength || 300);
  const draftArm = average(draft.segments.map((item) => item.length), baseArm);
  const bodyBase = baseline.fuselage.length * baseline.fuselage.horizontalDiameter * baseline.fuselage.verticalDiameter;
  const bodyDraft = draft.fuselage.length * draft.fuselage.horizontalDiameter * draft.fuselage.verticalDiameter;
  const armRatio = draftArm / Math.max(baseArm, 1);
  const bodyRatio = Math.max(0.45, Math.min(2.1, bodyDraft / Math.max(bodyBase, 1)));
  const baseBattery = batteryCapacity(baseline.energy.batteryTypes[0]);
  const draftBattery = batteryCapacity(draft.energy.batteryTypes[0]);
  const batteryRatio = Math.max(0.55, Math.min(1.9, draftBattery / Math.max(baseBattery, 1)));
  const baseWing = baseline.wings.reduce((sum, wing) => sum + wing.span * (wing.chordInner + wing.chordOuter) * 0.5, 0);
  const draftWing = draft.wings.reduce((sum, wing) => sum + wing.span * (wing.chordInner + wing.chordOuter) * 0.5, 0);
  const wingRatio = baseWing > 0 ? Math.max(0.55, Math.min(1.8, draftWing / baseWing)) : 1;
  const componentChanges = draft.propulsionGroups.reduce((sum, group, index) => {
    const base = baseline.propulsionGroups[index];
    return sum + (group.motorType !== base?.motorType ? 1 : 0) + (group.propellerType !== base?.propellerType ? 1 : 0);
  }, 0)
    + draft.energy.batteryTypes.filter((item, index) => item !== baseline.energy.batteryTypes[index]).length
    + draft.wings.filter((wing, index) => wing.nacaProfile !== baseline.wings[index]?.nacaProfile).length;
  const meanAngleDelta = average(
    draft.segments.map((segment, index) => Math.abs(segment.angle - (baseline.segments[index]?.angle ?? segment.angle))),
    0,
  );
  const meanOffsetDelta = average(
    draft.segments.map((segment, index) => Math.abs(segment.offset - (baseline.segments[index]?.offset ?? segment.offset))),
    0,
  );
  const meanWingRotationDelta = average(
    draft.wings.map((wing, index) => Math.abs(wing.rotation - (baseline.wings[index]?.rotation ?? wing.rotation))),
    0,
  );
  const controlSurfaceDelta = draft.wings.reduce((sum, wing, index) => {
    const base = baseline.wings[index];
    return sum + Math.abs(wing.aileronBias - (base?.aileronBias ?? wing.aileronBias)) + Math.abs(wing.flapBias - (base?.flapBias ?? wing.flapBias));
  }, 0);
  const neighbors = nearestDatasetDesigns(selected, draft, datasetDesigns);
  const closest = neighbors[0]?.design ?? selected;
  const neighborMetric = (read: (design: DesignSummary) => number, fallback: number) => {
    const usable = neighbors.filter(({ design }) => isAvailableMetric(read(design)));
    if (!usable.length) return fallback;
    const denominator = usable.reduce((sum, item) => sum + item.weight, 0);
    return usable.reduce((sum, item) => sum + read(item.design) * item.weight, 0) / Math.max(denominator, 0.0001);
  };
  const datasetMass = neighborMetric((design) => design.mass, selected.mass);
  const mass = Math.max(0.5, datasetMass + (draft.payload.mass - baseline.payload.mass));
  const massRatio = mass / Math.max(selected.mass, 0.5);
  const layoutDragPenalty = 1 + meanAngleDelta / 900 + meanOffsetDelta / 1800 + meanWingRotationDelta / 720;
  const dragFactor = Math.max(0.55, Math.min(1.85, armRatio ** 1.12 * bodyRatio ** 0.22 / wingRatio ** 0.08 * layoutDragPenalty));
  const efficiency = Math.max(0.87, 1 - componentChanges * 0.012);
  const similarityPenalty = Math.abs(Math.log(armRatio)) * 18 + Math.abs(Math.log(bodyRatio)) * 15 + Math.abs(Math.log(batteryRatio)) * 10 + componentChanges * 2.8 + meanAngleDelta * 0.06 + meanOffsetDelta * 0.025 + meanWingRotationDelta * 0.04 + controlSurfaceDelta * 5;
  const proximityDistance = (neighbors[0]?.distance ?? 0) + similarityPenalty / 100;
  return {
    mass,
    range: neighborMetric((design) => design.maxDistance, selected.maxDistance) * batteryRatio ** 0.22 * efficiency / massRatio ** 0.16,
    hover: neighborMetric((design) => design.hoverTime, selected.hoverTime) * batteryRatio ** 0.24 * efficiency / massRatio ** 0.28,
    maxSpeed: neighborMetric((design) => design.maxSpeed, selected.maxSpeed) * efficiency / dragFactor ** 0.08,
    power: neighborMetric((design) => design.power, selected.power) * massRatio ** 0.25 * dragFactor ** 0.18 / efficiency,
    drag: neighborMetric((design) => design.dragAt20, selected.dragAt20) * dragFactor ** 0.35,
    similarity: Math.round(Math.max(35, 100 / (1 + proximityDistance * 2.8))),
    closestId: closest.id,
  };
}

function nearestDatasetDesigns(selected: DesignSummary, draft: DesignDraft, designs: DesignSummary[]) {
  if (!designs.length) return [{ design: selected, distance: 0, weight: 1 }];
  const meanArm = average(draft.segments.map((item) => item.length), selected.meanArmLength || selected.armLength || 300);
  const totalWingSpan = draft.wings.reduce((sum, wing) => sum + wing.span, 0);
  const meanWingChord = average(draft.wings.map((wing) => (wing.chordInner + wing.chordOuter) * 0.5), 0);
  const motor = draft.propulsionGroups[0]?.motorType ?? '';
  const propeller = draft.propulsionGroups[0]?.propellerType ?? '';
  const battery = draft.energy.batteryTypes[0] ?? '';
  const sameTopology = designs.filter((design) => design.hub === draft.topology);
  const candidates = sameTopology.length >= 8
    ? sameTopology
    : designs.filter((design) => design.numPropellers === selected.numPropellers && (design.numWings > 0) === (draft.wings.length > 0));
  return candidates
    .map((design) => {
      const distance =
        normalizedDelta(meanArm, design.meanArmLength || design.armLength, 470) * 1.2
        + normalizedDelta(draft.fuselage.length, design.fuselageLength, 475) * 0.65
        + normalizedDelta(draft.fuselage.horizontalDiameter, design.fuselageHorizontalDiameter, 700) * 0.55
        + normalizedDelta(draft.fuselage.verticalDiameter, design.fuselageVerticalDiameter, 303) * 0.55
        + normalizedDelta(totalWingSpan, design.totalWingSpan, 2000) * 0.8
        + normalizedDelta(meanWingChord, design.meanWingChord, 450) * 0.65
        + (motor && design.primaryMotor !== motor ? 0.18 : 0)
        + (propeller && design.primaryPropeller !== propeller ? 0.18 : 0)
        + (battery && design.primaryBattery !== battery ? 0.14 : 0);
      return { design, distance, weight: 1 / (distance + 0.025) ** 2 };
    })
    .sort((a, b) => a.distance - b.distance || a.design.id - b.design.id)
    .slice(0, 5);
}

function normalizedDelta(a: number, b: number, range: number) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.abs(a - b) / Math.max(range, 1);
}

function countChanges(a: DesignDraft, b: DesignDraft) {
  let structuralCount = 0;
  const compare = (left: unknown, right: unknown) => {
    if (typeof left === 'object' && left != null && typeof right === 'object' && right != null) {
      const leftRecord = left as Record<string, unknown>;
      const rightRecord = right as Record<string, unknown>;
      for (const key of new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])) compare(leftRecord[key], rightRecord[key]);
    } else if (left !== right) structuralCount += 1;
  };
  const withoutDefinitions = (draft: DesignDraft) => {
    const copy = cloneDraft(draft);
    copy.parameterDefinitions = [];
    return copy;
  };
  compare(withoutDefinitions(a), withoutDefinitions(b));
  const rawCount = (a.parameterDefinitions ?? []).filter((item, index) => item.value !== b.parameterDefinitions?.[index]?.value).length;
  return Math.max(structuralCount, rawCount);
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

function average(values: number[], fallback: number) {
  return values.length ? values.reduce((sum, item) => sum + item, 0) / values.length : fallback;
}

function batteryCapacity(value?: string) {
  return Number(value?.match(/(\d{3,6})mAh/i)?.[1] ?? 5000);
}

function draftFromDesign(design: DesignSummary, reference?: ShowcaseDesign | null): DesignDraft {
  const segment: DesignSegment = {
    id: 'segment-0', path: 'hub.mainSegment', nodeType: 'PropArm', slot: 'mainSegment', length: design.armLength || 300,
    parentPath: null, depth: 1, multiplicity: Math.max(design.numPropellers, 1),
    angle: 0, offset: 0, parameters: {}, motorType: reference?.motor ?? '', propellerType: reference?.propeller ?? '',
  };
  const wings: WingParameters[] = design.numWings ? [{
    id: 'wing-0', path: 'hub.wing', type: reference?.wingType ?? 'Wing', nacaProfile: reference?.nacaProfile ?? '0012', span: reference?.wingSpan || 800,
    chordInner: reference?.wingChord || 220, chordOuter: (reference?.wingChord || 220) * 0.62, taperOffset: true, rotation: 0, aileronBias: 0.5, flapBias: 0.5, load: 400, tubeOffset: 0,
  }] : [];
  return {
    baselineId: design.id, name: reference?.sourceName ?? `design-${design.id}`, topology: design.hub,
    numPropellers: design.numPropellers, numWings: design.numWings, nodes: [], segments: [segment],
    propulsionGroups: [{ id: 'propulsion-0', path: segment.path, segmentId: segment.id, motorType: reference?.motor ?? '', propellerType: reference?.propeller ?? '' }],
    parameterDefinitions: [],
    sourceParameters: [],
    physicalComponents: { motors: [], propellers: [], batteries: [], wings: [], servos: [] },
    energy: { batteryTypes: [reference?.battery ?? ''], configuration: 'SingleBattery' },
    fuselage: { length: 220, horizontalDiameter: 360, verticalDiameter: 135, floorHeight: 24 },
    wings, payload: { mass: 0.5 }, layout: {},
  };
}

function catalogsFromShowcases(designs: ShowcaseDesign[]): ComponentCatalogs {
  const unique = (values: Array<string | null>) => [...new Set(values.filter(Boolean) as string[])].sort();
  return {
    motors: unique(designs.map((item) => item.motor)), propellers: unique(designs.map((item) => item.propeller)), batteries: unique(designs.map((item) => item.battery)),
    servos: [], nacaProfiles: unique(designs.map((item) => item.nacaProfile)), nodeTypes: unique(designs.map((item) => item.hub)),
  };
}
