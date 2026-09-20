'use client';

import type { ReactNode } from 'react';
import { Box, Info } from 'lucide-react';

import { StlViewer } from '@/components/stl-viewer';
import { ParametricUavViewer } from '@/components/parametric-uav-viewer';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  type DesignDraft,
  type DesignSummary,
  formatBatteryLabel,
  formatComponent,
  formatHub,
  formatMotorLabel,
  formatPropellerLabel,
  type ShowcaseDesign,
} from '@/lib/drawn-types';

type DataSource =
  | 'DATASET'
  | 'INTERPOLATED'
  | 'AI PREDICTED'
  | 'DEMO ESTIMATE'
  | 'DATASET RANKING';

const SOURCE_DESCRIPTIONS: Record<DataSource, string> = {
  DATASET: 'AircraftVerse output.json / trims.npy 실측값입니다.',
  INTERPOLATED:
    '학습된 AI 모델이 아닙니다. 같은 hub topology의 가장 가까운 설계 5개를 거리 가중 평균한 Neighbor Estimate v1 추정치입니다.',
  'AI PREDICTED':
    '학습된 PyTorch 트림 모델(backend/predict/trim)의 실시간 예측값입니다. 실측 AircraftVerse trim이 아니라 근사치입니다.',
  'DEMO ESTIMATE': '시연용 추정치이며 AircraftVerse 실측값이 아닙니다.',
  'DATASET RANKING':
    'AI 예측이 아닙니다. 27,714개 전체 설계의 실제 output.json 지표로 계산한 데이터셋 랭킹/Pareto 결과입니다.',
};

export function SourceBadge({ source = 'DATASET' }: { source?: DataSource }) {
  const style =
    source === 'DATASET'
      ? 'border-[#bfdbfe] bg-[#eff6ff] text-[#1b64da]'
      : source === 'INTERPOLATED'
        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
        : source === 'AI PREDICTED'
          ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
          : 'border-violet-200 bg-violet-50 text-violet-700';
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant="outline"
            className={`cursor-help text-[9px] tracking-[0.08em] underline decoration-dotted decoration-1 underline-offset-2 ${style}`}
          />
        }
      >
        {source}
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-left leading-5 whitespace-normal">
        {SOURCE_DESCRIPTIONS[source]}
      </TooltipContent>
    </Tooltip>
  );
}

export function MetricTile({
  label,
  value,
  unit,
  note,
  icon,
  tone = 'slate',
  source = 'DATASET',
}: {
  label: string;
  value: string;
  unit?: string;
  note?: string;
  icon?: ReactNode;
  tone?: 'cyan' | 'violet' | 'green' | 'amber' | 'slate';
  source?: DataSource;
}) {
  const toneClasses = {
    cyan: 'bg-[#eff6ff] text-[#3182f6]',
    violet: 'bg-violet-50 text-violet-700',
    green: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700',
    slate: 'bg-[#f5f5f7] text-[#6e6e73]',
  };
  return (
    <article className="rounded-2xl border border-[#e5e5ea] bg-white p-4 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div
          className={`grid size-9 place-items-center rounded-xl ${toneClasses[tone]}`}
        >
          {icon}
        </div>
        <SourceBadge source={source} />
      </div>
      <p className="text-xs text-[#6e6e73]">{label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold tracking-[-0.04em] text-[#1d1d1f]">
        {value}
        {unit && (
          <span className="ml-1.5 text-xs font-normal text-[#86868b]">
            {unit}
          </span>
        )}
      </p>
      {note && <p className="mt-2 text-[11px] text-[#86868b]">{note}</p>}
    </article>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="mb-1.5 text-xs font-medium text-[#3182f6]">{eyebrow}</p>
        <h1 className="text-2xl font-semibold tracking-[-0.03em] text-[#1d1d1f]">
          {title}
        </h1>
        {description && (
          <p className="mt-1.5 max-w-3xl text-sm leading-6 text-[#6e6e73]">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

export function DesignSelector({
  designs,
  value,
  onChange,
  className = '',
}: {
  designs: Array<Pick<DesignSummary, 'id' | 'numPropellers' | 'numWings'>>;
  value: number;
  onChange: (value: number) => void;
  className?: string;
}) {
  return (
    <Select
      value={String(value)}
      onValueChange={(next) => onChange(Number(next))}
    >
      <SelectTrigger
        className={`h-9 min-w-52 border-[#e5e5ea] bg-white text-[#1d1d1f] ${className}`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="border-[#e5e5ea] bg-white text-[#1d1d1f]">
        {designs.map((design) => (
          <SelectItem key={design.id} value={String(design.id)}>
            Design #{design.id} · {design.numPropellers}P/{design.numWings}W
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ModelStage({
  design,
  draft,
  draftLoading = false,
  className = '',
  label = true,
  emptyDesignId,
  pitchDegrees,
  forceVectors,
  showForceVectors = false,
}: {
  design: ShowcaseDesign | null;
  draft?: DesignDraft | null;
  draftLoading?: boolean;
  className?: string;
  label?: boolean;
  emptyDesignId?: number;
  pitchDegrees?: number | null;
  forceVectors?: {
    drag?: number | null;
    lift?: number | null;
    thrust?: number | null;
  };
  showForceVectors?: boolean;
}) {
  const forceLegend = showForceVectors && (
    <div className="absolute right-4 top-4 z-20 flex flex-wrap justify-end gap-2 text-[10px] font-medium">
      <span className="rounded-full border border-[#bfdbfe] bg-white/90 px-2 py-1 text-[#3182f6]">
        항력
      </span>
      <span className="rounded-full border border-amber-200 bg-white/90 px-2 py-1 text-amber-700">
        양력
      </span>
      <span className="rounded-full border border-emerald-200 bg-white/90 px-2 py-1 text-emerald-700">
        추력
      </span>
    </div>
  );

  return (
    <div
      className={`relative min-h-[360px] overflow-hidden rounded-2xl border border-[#e5e5ea] bg-[#f5f5f7] shadow-sm ${className}`}
    >
      {design ? (
        <>
          {label && (
            <div className="absolute left-4 top-4 z-20 flex gap-2">
              <Badge
                variant="outline"
                className="border-transparent bg-white/85 text-[#1d1d1f] backdrop-blur"
              >
                STL · DESIGN #{design.id}
              </Badge>
              <Badge
                variant="outline"
                className="border-transparent bg-white/85 text-[#1d1d1f] backdrop-blur"
              >
                프로펠러 {design.numPropellers}개
              </Badge>
            </div>
          )}
          {forceLegend}
          <StlViewer
            key={design.modelPath}
            src={design.modelPath}
            pitchDegrees={pitchDegrees}
            forceVectors={forceVectors}
            showForceVectors={showForceVectors}
          />
        </>
      ) : draft ? (
        <>
          {label && (
            <div className="absolute left-4 top-4 z-20 flex gap-2">
              <Badge
                variant="outline"
                className="border-transparent bg-white/85 text-[#1d1d1f] backdrop-blur"
              >
                파라메트릭 · DESIGN #{draft.baselineId}
              </Badge>
              <Badge
                variant="outline"
                className="border-transparent bg-white/85 text-[#1d1d1f] backdrop-blur"
              >
                프로펠러 {draft.numPropellers}개
              </Badge>
            </div>
          )}
          {forceLegend}
          <ParametricUavViewer
            key={draft.baselineId}
            draft={draft}
            pitchDegrees={pitchDegrees ?? 0}
            forceVectors={forceVectors}
            showForces={showForceVectors}
          />
        </>
      ) : (
        <div className="absolute inset-0 grid place-items-center p-8 text-center">
          <div>
            <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl border border-[#e5e5ea] bg-white">
              <Box className="size-5 text-[#86868b]" />
            </div>
            <p className="text-sm font-medium text-[#1d1d1f]">
              {draftLoading
                ? '설계 형상을 불러오는 중입니다'
                : emptyDesignId
                  ? `Design #${emptyDesignId}는 metadata-only입니다`
                  : '3D asset not packaged'}
            </p>
            {!draftLoading && (
              <p className="mt-2 max-w-sm text-xs leading-5 text-[#6e6e73]">
                이 설계의 파라메트릭 개념 형상을 불러오지 못했습니다. 잠시 후
                다시 시도해 주세요.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ConfigurationList({ design }: { design: ShowcaseDesign }) {
  const rows = [
    ['허브', formatHub(design.hub)],
    ['모터', formatMotorLabel(design.motor)],
    ['프로펠러', formatPropellerLabel(design.propeller)],
    ['배터리', formatBatteryLabel(design.battery)],
    [
      '암 길이',
      design.armLength ? `${design.armLength.toFixed(1)} mm` : '—',
    ],
    [
      '날개',
      design.numWings
        ? `${design.numWings} · ${design.nacaProfile ?? formatComponent(design.wingType)}`
        : '없음',
    ],
  ];
  return (
    <div className="divide-y divide-[#e5e5ea]">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="grid grid-cols-[92px_minmax(0,1fr)] gap-3 py-3 text-xs"
        >
          <span className="text-[#86868b]">{label}</span>
          <span className="truncate text-right text-[#1d1d1f]" title={value}>
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function DataDisclaimer({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`mt-4 flex gap-3 rounded-xl border border-amber-200 bg-amber-50 text-amber-900 ${compact ? 'px-3 py-2 text-[11px]' : 'p-4 text-xs leading-5'}`}
    >
      <Info className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
      <p>
        AircraftVerse trim 데이터와 유사도 기반 탐색 결과이며 CFD 전체 유동장,
        비행 인증 또는 제작 안전성을 대체하지 않습니다.
      </p>
    </div>
  );
}
