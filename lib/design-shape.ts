import type { DesignSummary } from './drawn-types';

/**
 * 설계를 생김새로 나누는 축 두 개 — 프로펠러가 이루는 도형, 날개 유무.
 *
 * 둘은 서로 독립이라 아무 축이나 먼저 골라도 되고, 순서가 없습니다.
 *
 * 세 번째 축으로 "도형이 기수 쪽으로 돌아갔는지"(쿼드의 +형 / X형)를 두었다가
 * 뺐습니다. 쿼드·헥사에서는 깨끗하게 갈리지만 프로펠러가 8개를 넘으면 어느
 * 쪽으로 돌려도 기수 앞에 하나쯤 걸려 두 칸이 같아지고(9방향 이상에서 78% 대
 * 76%), 무엇보다 설명을 들어야 뜻이 보이는 필터였습니다. 계산값은
 * `shape-classes.json` 에 그대로 남겨 두어 되살리기 쉽습니다.
 *
 * 원본 `design_tree.json` 에도 트리가 있지만 그건 제작 방식의 트리라 생김새와
 * 어긋납니다 — `ConnectedHub6_Sym` 과 `ConnectedHub6_2_2_2` 는 위에서 보면 프로펠러가
 * 같은 자리에 있는데 서로 다른 칸에 놓이고, 한 칸 내려가면 10 → 1,034 가지로
 * 터집니다. 그래서 보이는 것에서 다시 셉니다.
 *
 * 방향·위치는 `shape-classes.json` 에 미리 계산해 둡니다(설계당 숫자 하나).
 * 날개는 `design-index.json` 의 `numWings` 로 바로 알 수 있습니다.
 */

/** 설계 번호 → `방향 수 × 2 + (정렬이면 1)`. `shape-classes.json` 이 주는 값. */
export type ShapeClassMap = Record<string, number>;

export type DirectionGroup = '1' | '2' | '3' | '4' | '5' | '6' | '7-8' | '9+';
export type Placement = 'aligned' | 'staggered' | 'single';
export type WingPresence = 'none' | 'wings';

/**
 * `icon`은 그 칸을 대표해 그릴 도형의 꼭짓점 수. `note`는 그 칸에 실제로 들어
 * 있는 프로펠러 수다.
 *
 * 도형과 프로펠러 수는 대개 같지만(1~6각은 87~96%) 팔 하나에 프로펠러가 둘
 * 달리면 갈라진다. 프로펠러 16개짜리는 실제로 16각이 1%뿐이고 대개 8각으로
 * 보여서, 축은 도형으로 두고 프로펠러 수는 부제로만 적는다.
 */
export const DIRECTION_GROUPS: { value: DirectionGroup; label: string; note: string; icon: number }[] = [
  { value: '6', label: '육각', note: '프로펠러 6', icon: 6 },
  { value: '4', label: '사각', note: '프로펠러 4', icon: 4 },
  { value: '7-8', label: '칠·팔각', note: '프로펠러 8+', icon: 8 },
  { value: '2', label: '일자', note: '프로펠러 2', icon: 2 },
  { value: '9+', label: '다각', note: '프로펠러 10+', icon: 12 },
  { value: '3', label: '삼각', note: '프로펠러 3', icon: 3 },
  { value: '5', label: '오각', note: '프로펠러 5~7', icon: 5 },
  { value: '1', label: '단일', note: '프로펠러 1', icon: 1 },
];

/**
 * 기수·꼬리 쪽에 프로펠러가 있는지로 갈립니다. 실측으로 `aligned` 의 86%가 기수
 * 쪽에 프로펠러를 두고, `staggered` 는 23%뿐입니다. 쿼드에서는 이것이 흔히 쓰는
 * `+`형 / `X`형과 같아서, 쿼드를 고른 경우에만 그 이름을 덧붙입니다.
 */
export const PLACEMENTS: { value: Placement; label: string; quadLabel: string; hint: string }[] = [
  { value: 'aligned', label: '앞에 프로펠러', quadLabel: '+ 형', hint: '기수·꼬리 쪽에 프로펠러가 있음' },
  { value: 'staggered', label: '앞이 비어 있음', quadLabel: 'X 형', hint: '기수 쪽이 트여 있음' },
  // 프로펠러가 한 방향뿐이면 앞뒤를 말할 수 없다. 칸을 주지 않으면 이 축을 누르는
  // 순간 이 설계들이 조용히 사라진다.
  { value: 'single', label: '해당 없음', quadLabel: '', hint: '프로펠러가 한 방향뿐' },
];

export const WING_PRESENCES: { value: WingPresence; label: string }[] = [
  { value: 'none', label: '날개 없음' },
  { value: 'wings', label: '날개 있음' },
];

export function directionGroupOf(code: number | undefined): DirectionGroup | null {
  if (code === undefined) return null;
  const count = Math.floor(code / 2);
  if (count <= 0) return null;
  if (count <= 6) return String(count) as DirectionGroup;
  return count <= 8 ? '7-8' : '9+';
}

export function placementOf(code: number | undefined): Placement | null {
  if (code === undefined) return null;
  if (Math.floor(code / 2) < 2) return 'single';
  return code % 2 === 1 ? 'aligned' : 'staggered';
}

export function wingPresenceOf(design: Pick<DesignSummary, 'numWings'>): WingPresence {
  return design.numWings > 0 ? 'wings' : 'none';
}

export type ShapeFilters = {
  directions: DirectionGroup[];
  placements: Placement[];
  wings: WingPresence[];
};

export const EMPTY_SHAPE_FILTERS: ShapeFilters = { directions: [], placements: [], wings: [] };

export function shapeFilterCount(filters: ShapeFilters): number {
  return filters.directions.length + filters.placements.length + filters.wings.length;
}

/** 빈 배열은 "이 단은 거르지 않음"을 뜻합니다. 기본값이 곧 전체 27,714개입니다. */
export function matchesShape(
  design: DesignSummary,
  code: number | undefined,
  filters: ShapeFilters,
): boolean {
  if (filters.directions.length) {
    const group = directionGroupOf(code);
    if (!group || !filters.directions.includes(group)) return false;
  }
  if (filters.placements.length) {
    const placement = placementOf(code);
    if (!placement || !filters.placements.includes(placement)) return false;
  }
  if (filters.wings.length && !filters.wings.includes(wingPresenceOf(design))) return false;
  return true;
}

/**
 * 각 단의 선택지가 몇 개를 남기는지 셉니다. 그 단 자신의 선택은 빼고 세므로,
 * 고르기 전에 "이걸 누르면 몇 개"를 볼 수 있고 눌렀다가 0개가 되지 않습니다.
 */
export function shapeFacetCounts(
  designs: DesignSummary[],
  classes: ShapeClassMap,
  filters: ShapeFilters,
): { directions: Record<string, number>; placements: Record<string, number>; wings: Record<string, number> } {
  const counts = {
    directions: {} as Record<string, number>,
    placements: {} as Record<string, number>,
    wings: {} as Record<string, number>,
  };
  const bump = (bucket: Record<string, number>, key: string | null) => {
    if (key) bucket[key] = (bucket[key] ?? 0) + 1;
  };
  for (const design of designs) {
    const code = classes[String(design.id)];
    if (matchesShape(design, code, { ...filters, directions: [] })) {
      bump(counts.directions, directionGroupOf(code));
    }
    if (matchesShape(design, code, { ...filters, placements: [] })) {
      bump(counts.placements, placementOf(code));
    }
    if (matchesShape(design, code, { ...filters, wings: [] })) {
      bump(counts.wings, wingPresenceOf(design));
    }
  }
  return counts;
}

/** 고른 조건을 한 줄로. 예: `헥사 · 엇갈림 · 날개 없음` */
export function describeShape(filters: ShapeFilters): string {
  const parts: string[] = [];
  if (filters.directions.length) {
    parts.push(filters.directions
      .map((value) => DIRECTION_GROUPS.find((item) => item.value === value)?.label ?? value)
      .join('/'));
  }
  if (filters.placements.length) {
    parts.push(filters.placements
      .map((value) => PLACEMENTS.find((item) => item.value === value)?.label ?? value)
      .join('/'));
  }
  if (filters.wings.length) {
    parts.push(filters.wings
      .map((value) => WING_PRESENCES.find((item) => item.value === value)?.label ?? value)
      .join('/'));
  }
  return parts.join(' · ');
}
