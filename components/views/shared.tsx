'use client';

import type { ReactNode } from 'react';
import { Box, Info, MousePointer2 } from 'lucide-react';

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
  formatComponent,
  formatHub,
  type ShowcaseDesign,
} from '@/lib/aerotwin-types';

export function SourceBadge({ source = 'DATASET' }: { source?: 'DATASET' | 'INTERPOLATED' | 'DEMO ESTIMATE' | 'SURROGATE SCORE' }) {
  const style =
    source === 'DATASET'
      ? 'border-cyan-400/20 bg-cyan-400/5 text-cyan-200'
      : source === 'INTERPOLATED'
        ? 'border-emerald-400/20 bg-emerald-400/5 text-emerald-200'
        : 'border-violet-400/20 bg-violet-400/6 text-violet-200';
  return (
    <Badge variant="outline" className={`text-[9px] tracking-[0.08em] ${style}`}>
      {source}
    </Badge>
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
  source?: 'DATASET' | 'INTERPOLATED' | 'DEMO ESTIMATE' | 'SURROGATE SCORE';
}) {
  const toneClasses = {
    cyan: 'bg-cyan-300/8 text-cyan-300',
    violet: 'bg-violet-300/8 text-violet-300',
    green: 'bg-emerald-300/8 text-emerald-300',
    amber: 'bg-amber-300/8 text-amber-300',
    slate: 'bg-white/[0.035] text-slate-400',
  };
  return (
    <article className="rounded-2xl border border-white/9 bg-[#0a1622] p-4">
      <div className="mb-4 flex items-center justify-between">
        <div className={`grid size-9 place-items-center rounded-xl ${toneClasses[tone]}`}>{icon}</div>
        <SourceBadge source={source} />
      </div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold tracking-[-0.04em] text-white">
        {value}{unit && <span className="ml-1.5 text-xs font-normal text-slate-500">{unit}</span>}
      </p>
      {note && <p className="mt-2 text-[11px] text-slate-600">{note}</p>}
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
        <p className="mb-2 text-xs text-slate-500">{eyebrow}</p>
        <h1 className="text-2xl font-semibold tracking-[-0.035em] text-white">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function DesignSelector({
  designs,
  value,
  onChange,
  className = '',
}: {
  designs: ShowcaseDesign[];
  value: number;
  onChange: (value: number) => void;
  className?: string;
}) {
  return (
    <Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
      <SelectTrigger className={`h-9 min-w-52 border-white/10 bg-white/[0.035] text-slate-200 ${className}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="border-white/10 bg-[#0b1723] text-slate-200">
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
}: {
  design: ShowcaseDesign | null;
  className?: string;
  label?: boolean;
}) {
  return (
    <div className={`relative min-h-[360px] overflow-hidden rounded-2xl border border-white/9 bg-[radial-gradient(circle_at_50%_32%,rgba(28,88,105,0.26),transparent_44%),linear-gradient(180deg,#0b1a28,#07111c)] ${className}`}>
      {design ? (
        <>
          {label && (
            <div className="absolute left-4 top-4 z-20 flex gap-2">
              <Badge variant="outline" className="border-white/10 bg-[#07111d]/70 text-slate-300 backdrop-blur">STL · DESIGN #{design.id}</Badge>
              <Badge variant="outline" className="border-white/10 bg-[#07111d]/70 text-slate-300 backdrop-blur">{design.numPropellers} PROP</Badge>
            </div>
          )}
          <div className="absolute bottom-4 left-4 z-20 flex items-center gap-2 rounded-lg border border-white/8 bg-[#07111d]/70 px-3 py-2 text-[11px] text-slate-500 backdrop-blur">
            <MousePointer2 className="size-3" /> 드래그 회전 · 스크롤 확대
          </div>
          <StlViewer key={design.modelPath} src={design.modelPath} />
        </>
      ) : (
        <div className="absolute inset-0 grid place-items-center p-8 text-center">
          <div>
            <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl border border-white/8 bg-white/[0.025]">
              <Box className="size-5 text-slate-600" />
            </div>
            <p className="text-sm font-medium text-slate-300">3D asset not packaged</p>
            <p className="mt-2 max-w-sm text-xs leading-5 text-slate-600">전체 30GB 원본 중 시연용 6개 STL만 웹 앱에 포함했습니다. 메타데이터는 계속 탐색할 수 있습니다.</p>
          </div>
        </div>
      )}
    </div>
  );
}

export function ConfigurationList({ design }: { design: ShowcaseDesign }) {
  const rows = [
    ['Hub', formatHub(design.hub)],
    ['Motor', formatComponent(design.motor)],
    ['Propeller', formatComponent(design.propeller)],
    ['Battery', formatComponent(design.battery)],
    ['Arm Length', design.armLength ? `${design.armLength.toFixed(1)} mm` : '—'],
    ['Wing', design.numWings ? `${design.numWings} · ${design.nacaProfile ?? formatComponent(design.wingType)}` : 'None'],
  ];
  return (
    <div className="divide-y divide-white/7">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[92px_minmax(0,1fr)] gap-3 py-3 text-xs">
          <span className="text-slate-600">{label}</span>
          <span className="truncate text-right text-slate-300" title={value}>{value}</span>
        </div>
      ))}
    </div>
  );
}

export function DataDisclaimer({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`flex gap-3 rounded-xl border border-amber-300/12 bg-amber-300/[0.045] text-amber-100/75 ${compact ? 'px-3 py-2 text-[11px]' : 'p-4 text-xs leading-5'}`}>
      <Info className="mt-0.5 size-3.5 shrink-0 text-amber-300" />
      <p>설계 탐색용 surrogate 결과이며 CFD 전체 유동장, 비행 인증 또는 제작 안전성을 대체하지 않습니다.</p>
    </div>
  );
}
