'use client';

import { useMemo, useState } from 'react';
import { Star } from 'lucide-react';

import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import type { DesignSummary, ShowcaseMap } from '@/lib/drawn-types';
import { classifyAirframe } from '@/lib/drawn-types';
import {
  DIRECTION_GROUPS,
  EMPTY_SHAPE_FILTERS,
  WING_PRESENCES,
  describeShape,
  matchesShape,
  shapeFacetCounts,
  shapeFilterCount,
  type ShapeFilters,
} from '@/lib/design-shape';
import { ShapeIcon, WingIcon } from '@/components/shape-icon';
import { useShapeClasses } from '@/hooks/use-shape-classes';

/** 한 번에 보여줄 결과 수. 바닥에 닿으면 이만큼씩 더 붙인다. */
const PAGE = 40;
/** 슬라이더 눈금 끝. 최대 질량이 240,029kg인 이상치가 있어 여기부터는 "제한 없음"이다. */
const MASS_ANY = 31;

/**
 * 설계 27,714개를 생김새로 골라내는 패널.
 *
 * 설계에는 이름이 없어 번호로만 구별되므로, 프로펠러가 이루는 도형과 날개
 * 유무로 좁힌다. 탐색 화면과 스튜디오 화면이 같은 것을 쓴다.
 */
export function DesignPicker({
  designs,
  showcases,
  selectedId,
  onSelect,
  favorites = [],
  onToggleFavorite,
}: {
  designs: DesignSummary[];
  showcases: ShowcaseMap;
  selectedId: number | null;
  onSelect: (id: number) => void;
  favorites?: number[];
  onToggleFavorite?: (id: number) => void;
}) {
  const { classes } = useShapeClasses();
  const [shape, setShape] = useState<ShapeFilters>(EMPTY_SHAPE_FILTERS);
  const [massMax, setMassMax] = useState(MASS_ANY);
  const [feasibleOnly, setFeasibleOnly] = useState(false);
  const [viewerOnly, setViewerOnly] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE);

  // 생김새가 아닌 조건을 먼저 적용한다. 각 칸의 개수 표시는 이 결과를 모집단으로
  // 삼아야 실제로 눌렀을 때와 맞는다.
  const pool = useMemo(
    () =>
      designs.filter((design) => {
        if (viewerOnly && !showcases[String(design.id)]) return false;
        if (feasibleOnly && !design.feasible) return false;
        if (massMax < MASS_ANY && design.mass > massMax) return false;
        return true;
      }),
    [designs, feasibleOnly, massMax, showcases, viewerOnly],
  );

  const facets = useMemo(() => shapeFacetCounts(pool, classes, shape), [classes, pool, shape]);

  const filtered = useMemo(
    () =>
      pool
        .filter((design) => matchesShape(design, classes[String(design.id)], shape))
        .sort((a, b) => b.maxDistance - a.maxDistance || a.id - b.id),
    [classes, pool, shape],
  );

  // 조건이 바뀌면 처음부터 다시 센다.
  const filterKey = `${viewerOnly}|${feasibleOnly}|${massMax}|${JSON.stringify(shape)}`;
  const [lastKey, setLastKey] = useState(filterKey);
  if (lastKey !== filterKey) {
    setLastKey(filterKey);
    setVisibleCount(PAGE);
  }

  const toggle = <T,>(list: T[], value: T) =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-[#e5e5ea] p-3">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[11px] font-semibold text-[#3c3c43]">생김새로 고르기</p>
          {shapeFilterCount(shape) > 0 && (
            <button
              onClick={() => setShape(EMPTY_SHAPE_FILTERS)}
              className="rounded-full px-2 py-0.5 text-[10px] font-medium text-[#1b64da] hover:bg-[#eff6ff]"
            >
              조건 지우기
            </button>
          )}
        </div>
        {shapeFilterCount(shape) > 0 && (
          <p className="mb-2 rounded-lg bg-[#eff6ff] px-2.5 py-1.5 text-[11px] font-medium text-[#1b64da]">
            {describeShape(shape)}
          </p>
        )}

        <p className="mb-1.5 text-[10px] font-medium text-[#6e6e73]">프로펠러가 이루는 도형</p>
        <div className="mb-3 grid grid-cols-4 gap-1.5">
          {DIRECTION_GROUPS.map((item) => {
            const count = facets.directions[item.value] ?? 0;
            const active = shape.directions.includes(item.value);
            return (
              <button
                key={item.value}
                onClick={() => setShape((prev) => ({ ...prev, directions: toggle(prev.directions, item.value) }))}
                aria-pressed={active}
                disabled={count === 0 && !active}
                className={`flex flex-col items-center gap-0.5 rounded-lg border px-1 py-1.5 transition disabled:opacity-30 ${
                  active
                    ? 'border-[#93c5fd] bg-[#eff6ff] text-[#1b64da]'
                    : 'border-[#e5e5ea] bg-white text-[#6e6e73] hover:bg-[#f5f5f7]'
                }`}
              >
                <ShapeIcon directions={item.icon} size={24} />
                <span className="text-[10px] font-medium leading-tight">{item.label}</span>
                <span className="font-mono text-[9px] opacity-70">{count.toLocaleString()}</span>
              </button>
            );
          })}
        </div>

        <p className="mb-1.5 text-[10px] font-medium text-[#6e6e73]">날개</p>
        <div className="grid grid-cols-2 gap-1.5">
          {WING_PRESENCES.map((item) => {
            const count = facets.wings[item.value] ?? 0;
            const active = shape.wings.includes(item.value);
            return (
              <button
                key={item.value}
                onClick={() => setShape((prev) => ({ ...prev, wings: toggle(prev.wings, item.value) }))}
                aria-pressed={active}
                disabled={count === 0 && !active}
                className={`flex flex-col items-center gap-0.5 rounded-lg border px-1 py-1.5 transition disabled:opacity-30 ${
                  active
                    ? 'border-[#93c5fd] bg-[#eff6ff] text-[#1b64da]'
                    : 'border-[#e5e5ea] bg-white text-[#6e6e73] hover:bg-[#f5f5f7]'
                }`}
              >
                <WingIcon present={item.value === 'wings'} size={24} />
                <span className="text-[10px] font-medium leading-tight">{item.label}</span>
                <span className="font-mono text-[9px] opacity-70">{count.toLocaleString()}</span>
              </button>
            );
          })}
        </div>

        <div className="mt-3">
          <div className="mb-1.5 flex justify-between text-[10px] text-[#6e6e73]">
            <span>최대 질량</span>
            <span className="font-mono font-medium text-[#3c3c43]">
              {massMax >= MASS_ANY ? '제한 없음' : `≤ ${massMax} kg`}
            </span>
          </div>
          <Slider
            value={[massMax]}
            min={2}
            max={MASS_ANY}
            step={1}
            onValueChange={(value) => setMassMax(Number(Array.isArray(value) ? value[0] : value))}
            className="[&_[data-slot=slider-range]]:bg-[#3182f6]"
            aria-label="최대 질량"
          />
        </div>

        <div className="mt-3 space-y-1.5 rounded-lg bg-[#f5f5f7] p-2.5">
          <div className="flex items-center justify-between gap-2 text-[10px] text-[#6e6e73]">
            원본 STL 있는 설계만
            <Switch checked={viewerOnly} onCheckedChange={setViewerOnly} size="sm" aria-label="원본 STL 있는 설계만" />
          </div>
          <div className="flex items-center justify-between gap-2 text-[10px] text-[#6e6e73]">
            비행 해석된 설계만
            <Switch checked={feasibleOnly} onCheckedChange={setFeasibleOnly} size="sm" aria-label="비행 해석된 설계만" />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between border-b border-[#e5e5ea] px-3 py-2 text-[11px]">
        <span className="text-[#6e6e73]">
          설계 <span className="font-mono font-medium text-[#3c3c43]">{filtered.length.toLocaleString()}</span>
          <small className="ml-1 text-[10px] text-[#86868b]">/ {designs.length.toLocaleString()}</small>
        </span>
      </div>

      <div
        className="min-h-0 flex-1 divide-y divide-[#e5e5ea] overflow-y-auto"
        onScroll={(event) => {
          const box = event.currentTarget;
          if (box.scrollTop + box.clientHeight >= box.scrollHeight - 120) {
            setVisibleCount((count) => Math.min(count + PAGE, filtered.length));
          }
        }}
      >
        {filtered.slice(0, visibleCount).map((design) => {
          const active = selectedId === design.id;
          return (
            <div key={design.id} className={`relative ${active ? 'bg-[#eff6ff]' : 'hover:bg-[#f5f5f7]'}`}>
              <button
                onClick={() => onSelect(design.id)}
                className="w-full px-3 py-2 pr-8 text-left transition"
              >
                <p className="text-[11px] font-semibold text-[#3c3c43]">
                  {classifyAirframe(design).label}{' '}
                  <span className="font-mono font-normal text-[#6e6e73]">#{design.id}</span>
                </p>
                <p className="mt-0.5 font-mono text-[10px] text-[#6e6e73]">
                  {design.numPropellers}P{design.numWings > 0 ? `/${design.numWings}W` : ''} ·{' '}
                  {design.mass.toFixed(1)}kg
                  {design.maxDistance ? ` · ${(design.maxDistance / 1000).toFixed(1)}km` : ''}
                </p>
              </button>
              {onToggleFavorite && (
                <button
                  onClick={() => onToggleFavorite(design.id)}
                  aria-label={
                    favorites.includes(design.id)
                      ? `Design #${design.id} 즐겨찾기 해제`
                      : `Design #${design.id} 즐겨찾기 추가`
                  }
                  aria-pressed={favorites.includes(design.id)}
                  className="absolute right-2 top-2 rounded p-0.5 text-[#86868b] hover:bg-[#e5e5ea] hover:text-amber-500"
                >
                  <Star className={`size-3 ${favorites.includes(design.id) ? 'fill-amber-400 text-amber-500' : ''}`} />
                </button>
              )}
            </div>
          );
        })}
        {!filtered.length && (
          <p className="p-6 text-center text-[11px] leading-5 text-[#6e6e73]">
            조건에 맞는 설계가 없습니다. 조건을 지우고 다시 골라보세요.
          </p>
        )}
      </div>
    </div>
  );
}
