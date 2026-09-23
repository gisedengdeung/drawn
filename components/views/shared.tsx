'use client';

import type { ReactNode } from 'react';
import { Box, Info } from 'lucide-react';

import { useState } from 'react';
import { StlViewer } from '@/components/stl-viewer';
import { ParametricUavViewer } from '@/components/parametric-uav-viewer';
import { useDesignPreview } from '@/hooks/use-design-preview';
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
      ? 'border-[#bfdbfe] bg-[#eff6ff] text-[#1b64da]'
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
          {showForceVectors && (
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
          )}
          <StlViewer
            key={design.modelPath}
            src={design.modelPath}
            pitchDegrees={pitchDegrees}
            forceVectors={forceVectors}
            showForceVectors={showForceVectors}
          />
        </>
      ) : emptyDesignId ? (
        <ParametricStage designId={emptyDesignId} label={label} />
      ) : (
        <div className="absolute inset-0 grid place-items-center p-8 text-center">
          <div>
            <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl border border-[#e5e5ea] bg-white">
              <Box className="size-5 text-[#86868b]" />
            </div>
            <p className="text-sm font-medium text-[#1d1d1f]">3D asset not packaged</p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 원본 STL이 배포되지 않은 설계(27,714개 중 27,702개)를 개념 형상으로 보여준다.
 * 예전에는 "metadata-only입니다" 안내만 띄웠는데, 파라메트릭 형상이 STEP 부품
 * 좌표까지 쓰게 된 뒤로는 빈 화면을 둘 이유가 없다.
 */
function ParametricStage({ designId, label }: { designId: number; label: boolean }) {
  const preview = useDesignPreview(designId);
  // 개발 PC에 원본이 있으면 실제 형상과 나란히 놓고 볼 수 있다.
  const [sideBySide, setSideBySide] = useState(false);
  if (!preview) {
    return (
      <div className="absolute inset-0 grid place-items-center text-xs font-semibold tracking-[0.12em] text-[#6e6e73]">
        개념 형상 준비 중
      </div>
    );
  }
  return (
    <>
      {label && (
        <div className="absolute left-4 top-4 z-20 flex gap-2">
          <Badge variant="outline" className="border-transparent bg-white/85 text-[#1d1d1f] backdrop-blur">
            개념 형상 · DESIGN #{designId}
          </Badge>
          <Badge variant="outline" className="border-transparent bg-white/85 text-[#1d1d1f] backdrop-blur">
            프로펠러 {preview.draft.numPropellers}개
          </Badge>
        </div>
      )}
      {sideBySide ? (
        <div className="absolute inset-0 grid grid-cols-2 divide-x divide-[#e5e5ea]">
          <div className="relative">
            <ParametricUavViewer draft={preview.draft} assembly={preview.assembly} syncGroup={`stage-${designId}`} />
            <span className="pointer-events-none absolute bottom-3 left-3 z-20 rounded-md bg-white/90 px-2 py-1 text-[10px] font-semibold text-[#3182f6] backdrop-blur">개념 형상</span>
          </div>
          <div className="relative">
            <StlViewer key={designId} src={`/local-model/${designId}`} />
            <span className="pointer-events-none absolute bottom-3 left-3 z-20 rounded-md bg-white/90 px-2 py-1 text-[10px] font-semibold text-[#6e6e73] backdrop-blur">원본 STL</span>
          </div>
        </div>
      ) : (
        <ParametricUavViewer draft={preview.draft} assembly={preview.assembly} />
      )}
      <button
        type="button"
        onClick={() => setSideBySide((value) => !value)}
        aria-pressed={sideBySide}
        title="개발 PC에 AircraftVerse 원본이 있을 때만 오른쪽에 표시됩니다"
        className={`absolute bottom-3 right-3 z-20 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium shadow-sm backdrop-blur ${sideBySide ? 'border-[#3182f6] bg-[#3182f6] text-white' : 'border-[#e5e5ea] bg-white/90 text-[#3c3c43] hover:bg-white'}`}
      >
        원본과 나란히
      </button>
      {!sideBySide && (
        <p className="pointer-events-none absolute bottom-3 left-4 z-20 rounded-lg bg-white/85 px-2 py-1 text-[10px] text-[#6e6e73] backdrop-blur">
          원본 STL이 배포되지 않은 설계입니다 · 제조용 CAD 아님
        </p>
      )}
    </>
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
