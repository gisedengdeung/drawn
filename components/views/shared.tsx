'use client';

import type { ReactNode } from 'react';
import { Box, Info } from 'lucide-react';

import { StlViewer } from '@/components/stl-viewer';
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
  type DesignSummary,
  formatComponent,
  formatHub,
  type ShowcaseDesign,
} from '@/lib/aerotwin-types';

type DataSource =
  | 'DATASET'
  | 'INTERPOLATED'
  | 'DEMO ESTIMATE'
  | 'DATASET RANKING';

const SOURCE_DESCRIPTIONS: Record<DataSource, string> = {
  DATASET: 'AircraftVerse output.json / trims.npy 실측값입니다.',
  INTERPOLATED:
    '학습된 AI 모델이 아닙니다. 같은 hub topology의 가장 가까운 설계 5개를 거리 가중 평균한 Neighbor Estimate v1 추정치입니다.',
  'DEMO ESTIMATE': '시연용 추정치이며 AircraftVerse 실측값이 아닙니다.',
  'DATASET RANKING':
    'AI 예측이 아닙니다. 27,714개 전체 설계의 실제 output.json 지표로 계산한 데이터셋 랭킹/Pareto 결과입니다.',
};

export function SourceBadge({ source = 'DATASET' }: { source?: DataSource }) {
  const style =
    source === 'DATASET'
      ? 'border-[#b8dfe4] bg-[#eef8fa] text-[#0f6475]'
      : source === 'INTERPOLATED'
        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
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
    cyan: 'bg-[#eef8fa] text-[#147d91]',
    violet: 'bg-violet-50 text-violet-700',
    green: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700',
    slate: 'bg-[#f1f5f7] text-[#607383]',
  };
  return (
    <article className="rounded-2xl border border-[#dbe4ea] bg-white p-4 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div
          className={`grid size-9 place-items-center rounded-xl ${toneClasses[tone]}`}
        >
          {icon}
        </div>
        <SourceBadge source={source} />
      </div>
      <p className="text-xs text-[#607383]">{label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold tracking-[-0.04em] text-[#172b3a]">
        {value}
        {unit && (
          <span className="ml-1.5 text-xs font-normal text-[#738591]">
            {unit}
          </span>
        )}
      </p>
      {note && <p className="mt-2 text-[11px] text-[#82919c]">{note}</p>}
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
        <p className="mb-1.5 text-xs font-medium text-[#147d91]">{eyebrow}</p>
        <h1 className="text-2xl font-semibold tracking-[-0.035em] text-[#172b3a]">
          {title}
        </h1>
        {description && (
          <p className="mt-1.5 max-w-3xl text-sm leading-6 text-[#607383]">
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
        className={`h-9 min-w-52 border-[#dbe4ea] bg-white text-[#294353] ${className}`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="border-[#dbe4ea] bg-white text-[#294353]">
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
  className = '',
  label = true,
  emptyDesignId,
  pitchDegrees,
  forceVectors,
  showForceVectors = false,
}: {
  design: ShowcaseDesign | null;
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
  return (
    <div
      className={`relative min-h-[360px] overflow-hidden rounded-2xl border border-[#dbe4ea] bg-[#eef3f6] shadow-sm ${className}`}
    >
      {design ? (
        <>
          {label && (
            <div className="absolute left-4 top-4 z-20 flex gap-2">
              <Badge
                variant="outline"
                className="border-[#cfdae0] bg-white/85 text-[#294353] backdrop-blur"
              >
                STL · DESIGN #{design.id}
              </Badge>
              <Badge
                variant="outline"
                className="border-[#cfdae0] bg-white/85 text-[#294353] backdrop-blur"
              >
                프로펠러 {design.numPropellers}개
              </Badge>
            </div>
          )}
          {showForceVectors && (
            <div className="absolute right-4 top-4 z-20 flex flex-wrap justify-end gap-2 text-[10px] font-medium">
              <span className="rounded-full border border-[#b9dce2] bg-white/90 px-2 py-1 text-[#147d91]">
                항력
              </span>
              <span className="rounded-full border border-amber-200 bg-white/90 px-2 py-1 text-amber-700">
                양력
              </span>
              <span className="rounded-full border border-emerald-200 bg-white/90 px-2 py-1 text-emerald-700">
                추력
              </span>
            </div>
          )}
          <StlViewer
            key={design.modelPath}
            src={design.modelPath}
            pitchDegrees={pitchDegrees}
            forceVectors={forceVectors}
            showForceVectors={showForceVectors}
          />
        </>
      ) : (
        <div className="absolute inset-0 grid place-items-center p-8 text-center">
          <div>
            <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl border border-[#dbe4ea] bg-white">
              <Box className="size-5 text-[#738591]" />
            </div>
            <p className="text-sm font-medium text-[#294353]">
              {emptyDesignId
                ? `Design #${emptyDesignId}는 metadata-only입니다`
                : '3D asset not packaged'}
            </p>
            <p className="mt-2 max-w-sm text-xs leading-5 text-[#607383]">
              원본 STL이 없는 설계도 파라메트릭 Design Studio에서 개념 형상으로
              편집할 수 있습니다.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export function ConfigurationList({ design }: { design: ShowcaseDesign }) {
  const rows = [
    ['허브', formatHub(design.hub)],
    ['모터', formatComponent(design.motor)],
    ['프로펠러', formatComponent(design.propeller)],
    ['배터리', formatComponent(design.battery)],
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
    <div className="divide-y divide-[#e7edf1]">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="grid grid-cols-[92px_minmax(0,1fr)] gap-3 py-3 text-xs"
        >
          <span className="text-[#738591]">{label}</span>
          <span className="truncate text-right text-[#294353]" title={value}>
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
