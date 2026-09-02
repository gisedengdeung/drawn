'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Boxes,
  Gauge,
  GitCompareArrows,
  RotateCcw,
  Route,
  Sparkles,
  Weight,
  Wind,
  Zap,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import type { ShowcaseDesign } from '@/lib/aerotwin-types';
import {
  formatComponent,
  formatMetric,
  isAvailableMetric,
  percentChange,
} from '@/lib/aerotwin-types';
import {
  DataDisclaimer,
  DesignSelector,
  MetricTile,
  ModelStage,
  SectionHeading,
  SourceBadge,
} from '@/components/views/shared';

type Prediction = {
  mass: number;
  range: number;
  hover: number;
  maxSpeed: number;
  power: number;
  drag: number;
};

export function DesignLabView({
  designs,
  selected,
  onSelect,
  onOpenDatasetCompare,
}: {
  designs: ShowcaseDesign[];
  selected: ShowcaseDesign;
  onSelect: (id: number) => void;
  onOpenDatasetCompare: () => void;
}) {
  const componentOptions = useMemo(
    () => ({
      motors: [...new Set(designs.map((design) => design.motor).filter(Boolean))] as string[],
      propellers: [...new Set(designs.map((design) => design.propeller).filter(Boolean))] as string[],
      batteries: [...new Set(designs.map((design) => design.battery).filter(Boolean))] as string[],
    }),
    [designs],
  );
  const [motor, setMotor] = useState(selected.motor ?? '');
  const [propeller, setPropeller] = useState(selected.propeller ?? '');
  const [battery, setBattery] = useState(selected.battery ?? '');
  const [armLength, setArmLength] = useState(Math.round(selected.armLength || 300));
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [running, setRunning] = useState(false);
  const predictionTimeoutRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (predictionTimeoutRef.current != null) window.clearTimeout(predictionTimeoutRef.current);
  }, []);

  const baselineDrag = selected.trim[20]?.valid ? Number(selected.trim[20].drag ?? 0) : 0;

  const cancelPendingPrediction = () => {
    if (predictionTimeoutRef.current != null) {
      window.clearTimeout(predictionTimeoutRef.current);
      predictionTimeoutRef.current = null;
    }
    setRunning(false);
    setPrediction(null);
  };

  const reset = () => {
    cancelPendingPrediction();
    setMotor(selected.motor ?? '');
    setPropeller(selected.propeller ?? '');
    setBattery(selected.battery ?? '');
    setArmLength(Math.round(selected.armLength || 300));
  };

  const runPrediction = () => {
    if (predictionTimeoutRef.current != null) window.clearTimeout(predictionTimeoutRef.current);
    const requestedMotor = motor;
    const requestedPropeller = propeller;
    const requestedBattery = battery;
    const requestedArmLength = armLength;
    setRunning(true);
    setPrediction(null);
    predictionTimeoutRef.current = window.setTimeout(() => {
      const baseCapacity = parseCapacity(selected.battery);
      const nextCapacity = parseCapacity(requestedBattery);
      const batteryFactor = Math.max(0.6, Math.min(1.75, nextCapacity / baseCapacity));
      const baseKv = parseKv(selected.motor);
      const nextKv = parseKv(requestedMotor);
      const motorEfficiency = Math.max(0.86, Math.min(1.14, 1 + (baseKv - nextKv) / Math.max(baseKv, 1) * 0.1));
      const propDelta = componentOptions.propellers.indexOf(requestedPropeller) - componentOptions.propellers.indexOf(selected.propeller ?? '');
      const propEfficiency = Math.max(0.91, Math.min(1.1, 1 + propDelta * 0.018));
      const armRatio = requestedArmLength / Math.max(selected.armLength, 1);
      const estimatedMass = Math.max(1, selected.mass + (nextCapacity - baseCapacity) * 0.000055 + (nextKv - baseKv) * -0.0005);
      const massRatio = estimatedMass / Math.max(selected.mass, 1);
      const dragFactor = Math.max(0.75, Math.min(1.35, armRatio ** 1.15 * (2 - propEfficiency)));
      setPrediction({
        mass: estimatedMass,
        range: selected.maxDistance * batteryFactor ** 0.58 * motorEfficiency * propEfficiency / massRatio ** 0.32 / dragFactor ** 0.18,
        hover: selected.hoverTime * batteryFactor ** 0.62 * motorEfficiency * propEfficiency / massRatio ** 0.68,
        maxSpeed: selected.maxSpeed * motorEfficiency ** -0.25 * propEfficiency ** 0.18 / dragFactor ** 0.16,
        power: selected.power * massRatio ** 0.55 * dragFactor ** 0.45 / motorEfficiency,
        drag: Number(baselineDrag) * dragFactor,
      });
      setRunning(false);
      predictionTimeoutRef.current = null;
    }, 850);
  };

  return (
    <section className="px-4 py-5 lg:px-6">
      <SectionHeading
        eyebrow={`Design Lab / Draft from #${selected.id}`}
        title="What-if Design Prediction"
        description="원본 설계를 보존한 채 부품과 arm 길이를 바꾸고, deterministic demo surrogate로 성능 변화 방향을 빠르게 확인합니다."
        actions={<DesignSelector designs={designs} value={selected.id} onChange={(id) => { cancelPendingPrediction(); onSelect(id); }} />}
      />

      <div className="grid gap-4 xl:grid-cols-[310px_minmax(480px,1fr)_360px]">
        <aside className="rounded-2xl border border-white/9 bg-[#0a1622] p-4">
          <div className="mb-5 flex items-center justify-between">
            <div><p className="text-sm font-medium text-slate-200">Design Parameters</p><p className="mt-1 text-xs text-slate-600">Draft · 원본 미변경</p></div>
            <Button size="icon-sm" variant="ghost" onClick={reset} className="text-slate-500" aria-label="초기화"><RotateCcw /></Button>
          </div>

          <ControlSelect label="Motor" value={motor} options={componentOptions.motors} onChange={(value) => { cancelPendingPrediction(); setMotor(value); }} />
          <ControlSelect label="Propeller" value={propeller} options={componentOptions.propellers} onChange={(value) => { cancelPendingPrediction(); setPropeller(value); }} />
          <ControlSelect label="Battery" value={battery} options={componentOptions.batteries} onChange={(value) => { cancelPendingPrediction(); setBattery(value); }} />

          <div className="mt-5">
            <div className="mb-3 flex items-center justify-between text-xs"><span className="text-slate-500">Arm Length</span><span className="font-mono text-cyan-200">{armLength} mm</span></div>
            <Slider
              value={[armLength]}
              min={180}
              max={520}
              step={1}
              onValueChange={(value) => { cancelPendingPrediction(); setArmLength(Number(Array.isArray(value) ? value[0] : value)); }}
              className="[&_[data-slot=slider-range]]:bg-cyan-300"
              aria-label="Arm Length"
            />
            <div className="mt-2 flex justify-between text-[10px] text-slate-600"><span>180</span><span>350</span><span>520 mm</span></div>
          </div>

          <div className="mt-6 rounded-xl border border-violet-300/12 bg-violet-300/5 p-3 text-[11px] leading-5 text-violet-100/65">
            이 MVP에는 학습 체크포인트가 없어 부품 용량·KV·형상 변화율 기반의 재현 가능한 demo surrogate를 사용합니다.
          </div>

          <Button onClick={runPrediction} disabled={running} className="mt-4 h-10 w-full bg-violet-400 text-white hover:bg-violet-300">
            <Sparkles /> {running ? 'AI Predicting…' : 'AI 성능 예측'}
          </Button>
          {running && <Progress value={68} className="mt-3 [&_[data-slot=progress-indicator]]:bg-violet-400" />}
        </aside>

        <div className="min-w-0">
          <ModelStage design={selected} className="min-h-[500px]" />
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <MetricTile icon={<Weight className="size-4" />} label="Baseline Mass" value={formatMetric(selected.mass, 2)} unit="kg" />
            <MetricTile icon={<Route className="size-4" />} label="Baseline Range" value={formatMetric(selected.maxDistance / 1000, 2)} unit="km" tone="cyan" />
            <MetricTile icon={<Zap className="size-4" />} label="Baseline Power" value={formatMetric(selected.power, 0)} unit="W" tone="violet" />
            <MetricTile icon={<Wind className="size-4" />} label="Drag @ 20m/s" value={isAvailableMetric(baselineDrag) ? formatMetric(baselineDrag, 1) : '—'} unit={isAvailableMetric(baselineDrag) ? 'N' : undefined} tone="amber" />
          </div>
        </div>

        <aside className="rounded-2xl border border-white/9 bg-[#0a1622] p-4">
          <div className="flex items-start justify-between gap-3">
            <div><p className="text-sm font-medium text-slate-200">AI Prediction</p><p className="mt-1 text-xs text-slate-600">Model · Demo Surrogate v0.1</p></div>
            <SourceBadge source="DEMO ESTIMATE" />
          </div>

          {prediction ? (
            <>
              <div className="mt-5 divide-y divide-white/7">
                <PredictionRow icon={<Route />} label="Maximum Distance" before={selected.maxDistance / 1000} after={prediction.range / 1000} unit="km" better="up" />
                <PredictionRow icon={<Gauge />} label="Max Speed" before={selected.maxSpeed} after={prediction.maxSpeed} unit="m/s" better="up" />
                <PredictionRow icon={<Boxes />} label="Hover Time" before={selected.hoverTime} after={prediction.hover} unit="sec" better="up" />
                <PredictionRow icon={<Zap />} label="Power @ MFD" before={selected.power} after={prediction.power} unit="W" better="down" />
                <PredictionRow icon={<Wind />} label="Drag @ 20m/s" before={Number(baselineDrag)} after={prediction.drag} unit="N" better="down" />
                <PredictionRow icon={<Weight />} label="Mass" before={selected.mass} after={prediction.mass} unit="kg" better="down" />
              </div>
              <p className="mt-4 text-[10px] leading-4 text-slate-600">Draft 전후 값은 위 패널에서 비교합니다. A/B 화면은 실제 AircraftVerse 설계 ID끼리 비교합니다.</p>
              <Button onClick={onOpenDatasetCompare} variant="outline" className="mt-3 h-10 w-full border-white/10 bg-white/[0.025] text-slate-200">
                <GitCompareArrows /> 데이터셋 설계 A/B 비교 <ArrowRight />
              </Button>
            </>
          ) : (
            <div className="grid min-h-[430px] place-items-center text-center">
              <div>
                <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl border border-violet-300/15 bg-violet-300/6"><Sparkles className="size-5 text-violet-300" /></div>
                <p className="text-sm font-medium text-slate-300">변경한 설계를 평가하세요</p>
                <p className="mt-2 max-w-60 text-xs leading-5 text-slate-600">예측 실행 후 원본과 draft의 Range·Hover·Power·Drag를 같은 단위로 비교합니다.</p>
              </div>
            </div>
          )}
          <DataDisclaimer compact />
        </aside>
      </div>
    </section>
  );
}

function ControlSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <label className="mb-4 block">
      <span className="mb-2 block text-xs text-slate-500">{label}</span>
      <Select value={value} onValueChange={(next) => onChange(String(next))}>
        <SelectTrigger className="h-10 w-full border-white/10 bg-white/[0.025] text-xs text-slate-300"><SelectValue /></SelectTrigger>
        <SelectContent className="max-w-[330px] border-white/10 bg-[#0b1723] text-slate-200">
          {options.map((option) => <SelectItem key={option} value={option}>{formatComponent(option)}</SelectItem>)}
        </SelectContent>
      </Select>
    </label>
  );
}

function PredictionRow({ icon, label, before, after, unit, better }: { icon: React.ReactNode; label: string; before: number; after: number; unit: string; better: 'up' | 'down' }) {
  const change = percentChange(before, after);
  const improved = change == null ? false : better === 'up' ? change >= 0 : change <= 0;
  const digits = unit === 'W' || unit === 'sec' ? 0 : 1;
  return (
    <div className="py-4">
      <div className="mb-2 flex items-center gap-2 text-xs text-slate-500"><span className="[&>svg]:size-3.5">{icon}</span>{label}</div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 font-mono text-xs">
        <span className="text-slate-600">{isAvailableMetric(before) ? formatMetric(before, digits) : '—'}</span>
        <ArrowRight className="size-3 text-slate-700" />
        <span className="text-right text-slate-200">{isAvailableMetric(after) ? `${formatMetric(after, digits)} ${unit}` : '—'}</span>
      </div>
      <p className={`mt-1 text-right font-mono text-[10px] ${change == null ? 'text-slate-600' : improved ? 'text-emerald-300' : 'text-amber-300'}`}>{change == null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`}</p>
    </div>
  );
}

function parseCapacity(value: string | null) {
  const match = value?.match(/(\d{3,6})mAh/i);
  return Number(match?.[1] ?? 5000);
}

function parseKv(value: string | null) {
  const match = value?.match(/KV(\d+)/i);
  return Number(match?.[1] ?? 500);
}
