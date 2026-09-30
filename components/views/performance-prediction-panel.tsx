'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { BrainCircuit, LoaderCircle, RotateCcw } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from 'recharts';
import type { DesignDraft } from '../../lib/drawn-types';
import { formatMetric } from '../../lib/drawn-types';
import type { PerformanceMetric, PerformancePrediction, PerformanceResult } from '../../lib/performance-client';
import { usePerformancePrediction } from '../../hooks/use-performance-prediction';
import { Button } from '../ui/button';
import { Slider } from '../ui/slider';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '../ui/chart';

const metrics: Array<{ key: PerformanceMetric; label: string; unit: string; digits: number }> = [
  { key: 'drag', label: '항력', unit: 'N', digits: 2 },
  { key: 'lift', label: '양력', unit: 'N', digits: 2 },
  { key: 'thrust', label: '추력', unit: 'N', digits: 2 },
  { key: 'pitch', label: '피치각', unit: 'deg', digits: 1 },
  { key: 'power', label: '전력', unit: 'W', digits: 1 },
  { key: 'current', label: '전류', unit: 'A', digits: 2 },
  { key: 'flightTime', label: '비행 시간', unit: 's', digits: 1 },
  { key: 'distance', label: '비행거리', unit: 'm', digits: 1 },
];

const inputLabels: Record<string, string> = {
  mass: '질량', maxSpeed: '최고 속도', flightValidity: '비행 가능 여부',
  payload: '탑재 중량', layout: '내부 배치',
  'fuselage.floorHeight': '동체 바닥 높이', secondaryBatteries: '보조 배터리',
  parameterDefinitions: '원본 파라미터',
  'segment.angle/offset': '암 각도·오프셋',
  'segment.motorType/propellerType': '암의 모터·프로펠러',
  'wing.profile/rotation/controlSurface': '날개 단면·회전·조종면',
  'wing.servoType': '날개 서보', secondaryPropulsionGroups: '보조 추진 그룹',
  speed: '속도', numPropellers: '프로펠러 수', numWings: '날개 수',
  armLength: '첫 번째 암 길이', meanArmLength: '평균 암 길이', maxArmLength: '최대 암 길이',
  fuselageLength: '동체 길이', fuselageHorizontalDiameter: '동체 가로 지름',
  fuselageVerticalDiameter: '동체 세로 지름', totalWingSpan: '전체 날개 폭',
  meanWingChord: '평균 날개 시위', parameterCount: '파라미터 수',
  dragAt20: '기준 설계 20 m/s 항력', powerAt20: '기준 설계 20 m/s 전력',
  powerAt0: '기준 설계 호버 전력', thrustAt0: '기준 설계 호버 추력',
  currentAt0: '기준 설계 호버 전류', trim20_available: '기준 설계 20 m/s 해석 유무',
  hub: '허브 형태', primaryMotor: '주 모터', primaryPropeller: '주 프로펠러', primaryBattery: '주 배터리',
};

function formatInputLabels(keys: string[]): string {
  return keys.map((key) => inputLabels[key] ?? key).join(', ');
}

export function PerformancePredictionPanel({
  designId,
  draft,
  disabled = false,
  inputError,
  compact = false,
  speed: controlledSpeed,
  onSpeedChange,
  onPitchChange,
  onPredictionChange,
  onResultChange,
  resultOverride,
}: {
  designId: number;
  draft: DesignDraft | null;
  disabled?: boolean;
  inputError?: string | null;
  compact?: boolean;
  speed?: number;
  onSpeedChange?: (speed: number) => void;
  /** 선택한 속도의 예측 피치각. 3D 기체를 그만큼 기울이는 데 쓴다. */
  onPitchChange?: (pitchDegrees: number | null) => void;
  /** 선택한 속도의 공력 예측 전체. 현재 파라메트릭 3D 자세와 힘 벡터에 쓴다. */
  onPredictionChange?: (prediction: PerformancePrediction | null) => void;
  /** 모든 속도의 AI 예측. 편집 화면의 와이드 성능 곡선에 쓴다. */
  onResultChange?: (result: PerformanceResult | null) => void;
  /** 이미 계산된 결과를 표시 전용 패널에서 재사용한다. 주어지면 새 API 요청을 만들지 않는다. */
  resultOverride?: PerformanceResult | null;
}) {
  const id = useId();
  const [localSpeed, setLocalSpeed] = useState(20);
  const [speedDraft, setSpeedDraft] = useState<string | null>(null);
  const [metric, setMetric] = useState<PerformanceMetric>('thrust');
  const speed = controlledSpeed ?? localSpeed;
  const changeSpeed = (next: number) => { setLocalSpeed(next); onSpeedChange?.(next); };
  const commitSpeed = (raw: string) => {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) changeSpeed(Math.min(50, Math.max(0, Math.round(parsed))));
    setSpeedDraft(null);
  };
  const prediction = usePerformancePrediction(designId, draft, !disabled && !inputError && resultOverride === undefined);
  const result = resultOverride === undefined ? prediction.result : resultOverride;
  const row = result?.predictions.find((item) => item.speed === speed);
  const selectedMetric = metrics.find((item) => item.key === metric)!;
  const chartConfig = useMemo(() => ({
    [metric]: { label: `${selectedMetric.label} (${selectedMetric.unit})`, color: '#3182f6' },
  }), [metric, selectedMetric.label, selectedMetric.unit]);
  const warnings = [...new Set([...(result?.warnings ?? []), ...(row?.warnings ?? [])])];

  // 예측이 바뀌면 바깥의 3D 기체 자세도 따라가게 알린다. 예측이 없거나 실패한
  // 동안은 null을 보내, 옛 각도로 기울어진 채 남지 않게 한다.
  const pitch = typeof row?.pitch === 'number' ? row.pitch : null;
  useEffect(() => {
    onPitchChange?.(pitch);
  }, [onPitchChange, pitch]);
  useEffect(() => {
    onPredictionChange?.(row ?? null);
  }, [onPredictionChange, row]);
  useEffect(() => {
    onResultChange?.(result ?? null);
  }, [onResultChange, result]);

  return (
    <section aria-labelledby={`${id}-title`} className="min-w-0 rounded-2xl border border-[#bfdbfe] bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="flex items-center gap-2 text-sm font-semibold text-[#1d1d1f]">
          <BrainCircuit className="size-4 text-[#3182f6]" /> AI 속도별 예측
        </h2>
        <span className="rounded-full bg-[#eff6ff] px-2 py-1 text-[11px] font-medium text-[#1b64da]">기준 설계 조건부 예측</span>
      </div>
      <p className="mt-2 text-xs leading-5 text-[#6e6e73]">기준 설계의 물리 조건을 사용하는 학습 모델입니다. 예측 수치는 실제 비행 가능 여부를 판정하지 않습니다.</p>
      <div className="mt-4">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span id={`${id}-speed`} className="font-medium text-[#3c3c43]">예측 속도</span>
          <label className="flex items-center gap-1 rounded-lg border border-[#d6e6ff] bg-white px-2 py-1 text-[#1b64da] focus-within:border-[#3182f6] focus-within:ring-2 focus-within:ring-[#3182f6]/15">
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={50}
              step={1}
              aria-label="예측 속도 직접 입력"
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
        <Slider
          aria-labelledby={`${id}-speed`}
          value={[speed]} min={0} max={50} step={1}
          onValueChange={(value) => changeSpeed(Number(Array.isArray(value) ? value[0] : value))}
          className="mt-3 [&_[data-slot=slider-range]]:bg-[#3182f6]"
        />
        <div className="mt-1 flex justify-between font-mono text-[11px] text-[#86868b]"><span>0 m/s</span><span>50 m/s</span></div>
      </div>

      {inputError ? (
        <p role="alert" className="mt-4 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">설계 입력을 불러오지 못해 AI 예측을 실행할 수 없습니다. {inputError}</p>
      ) : disabled ? (
        <output className="mt-4 block text-xs text-[#6e6e73]">현재 설계의 입력을 준비하고 있습니다.</output>
      ) : prediction.loading ? (
        <output aria-live="polite" className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#f5f5f7] p-3 text-xs text-[#6e6e73]">
          <span className="flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" />{prediction.stale ? '변경된 설계로 다시 예측 중…' : 'AI 모델 예측 중…'}</span>
          <Button variant="ghost" size="sm" onClick={prediction.cancel}>취소</Button>
        </output>
      ) : prediction.error || prediction.cancelled ? (
        <div role={prediction.error ? 'alert' : 'status'} className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
          {prediction.failure?.status === 422 && <p className="font-semibold">{prediction.failure.code === 'model_input_unavailable' ? '이 설계의 원본 데이터로는 AI 예측을 지원하지 않습니다.' : '현재 설계 입력으로는 AI 예측을 실행할 수 없습니다.'}</p>}
          <p>{prediction.error ?? '예측을 취소했습니다.'}</p>
          {prediction.failure && !prediction.failure.retryable ? (
            <p className="mt-2">{prediction.failure.code === 'model_input_unavailable'
              ? '상단 설계 선택에서 다른 설계를 골라 주세요. 예: #17297. 설계를 바꾸면 자동으로 예측합니다.'
              : '형상과 부품 설정을 확인해 주세요. 입력을 바꾸면 자동으로 다시 예측합니다.'}</p>
          ) : (
            <Button variant="outline" size="sm" className="mt-2 bg-white" onClick={prediction.retry}><RotateCcw /> 다시 예측</Button>
          )}
        </div>
      ) : row && result ? (
        <>
          <div className={`mt-4 grid gap-2 ${compact ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4'}`}>
            {metrics.map((item) => (
              <div key={item.key} className="min-w-0 rounded-xl bg-[#f5f5f7] p-2.5">
                <p className="text-[11px] text-[#6e6e73]">{item.label}</p>
                <p className="mt-1 break-words font-mono text-base font-semibold text-[#1d1d1f]">{row[item.key] == null ? '—' : formatMetric(row[item.key]!, item.digits)} <span className="text-[11px] font-normal text-[#86868b]">{item.unit}</span></p>
              </div>
            ))}
          </div>
          {(result.outsideTrainingRange.length > 0 || result.unknownCategory.length > 0 || result.unsupportedInputs.length > 0 || warnings.length > 0) && (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] leading-5 text-amber-900">
              {result.outsideTrainingRange.length > 0 && <p>요청한 속도 구간에 학습 범위를 벗어난 입력이 있습니다. ({formatInputLabels(result.outsideTrainingRange)})</p>}
              {result.unknownCategory.length > 0 && <p>학습에 없는 부품 또는 분류가 포함되어 있습니다. ({formatInputLabels(result.unknownCategory)})</p>}
              {result.unsupportedInputs.length > 0 && <p>모델 미지원 항목: {formatInputLabels(result.unsupportedInputs)}</p>}
              {warnings.length > 0 && <details><summary className="cursor-pointer font-medium">예측 참고 사항 {warnings.length}개</summary><ul className="mt-1 list-disc space-y-1 pl-4">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
            </div>
          )}
          {!compact && (
            <div className="mt-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <label htmlFor={`${id}-metric`} className="text-xs font-medium text-[#3c3c43]">AI 예측 곡선</label>
                <select id={`${id}-metric`} value={metric} onChange={(event) => setMetric(event.target.value as PerformanceMetric)} className="rounded-lg border border-[#e5e5ea] bg-white px-3 py-1.5 text-xs text-[#3c3c43]">
                  {metrics.map((item) => <option key={item.key} value={item.key}>{item.label} ({item.unit})</option>)}
                </select>
              </div>
              <ChartContainer config={chartConfig} className="h-[240px] w-full aspect-auto" initialDimension={{ width: 900, height: 240 }}>
                <LineChart data={result.predictions} margin={{ left: 0, right: 16, top: 8, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#e5e5ea" />
                  <XAxis dataKey="speed" tickLine={false} axisLine={false} unit="m/s" />
                  <YAxis tickLine={false} axisLine={false} width={56} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ReferenceLine x={speed} stroke="#86868b" strokeDasharray="3 4" />
                  <Line type="monotone" dataKey={metric} stroke="#3182f6" strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ChartContainer>
            </div>
          )}
          <p className="mt-3 break-all text-[11px] text-[#86868b]">모델 {result.modelVersion} · 기준 설계 #{result.designId}</p>
        </>
      ) : null}
    </section>
  );
}
