import type { AssemblyInfo, DesignAssembly, PartCatalog } from '@/lib/drawn-types';

/**
 * 저장 형식(인덱스 번호)을 뷰어가 쓰기 좋은 이름 기반 지도로 푼다.
 * 연결은 양방향으로 넣는다 — 그래프를 어느 쪽으로도 걸을 수 있어야 한다.
 */
export function resolveAssembly(
  entry: DesignAssembly | undefined,
  catalog: PartCatalog,
): AssemblyInfo | null {
  if (!entry?.p?.length) return null;
  const placements = entry.p;
  const neighbours = new Map<string, string[]>();
  for (const [from, to] of entry.c ?? []) {
    const a = placements[from]?.n;
    const b = placements[to]?.n;
    if (!a || !b) continue;
    neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
    neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
  }
  const typeOf = new Map<string, string>();
  const modelOf = new Map<string, string>();
  placements.forEach((part, index) => {
    const type = catalog.types[entry.t?.[index] ?? -1];
    const model = catalog.models[entry.m?.[index] ?? -1];
    if (type) typeOf.set(part.n, type);
    if (model) modelOf.set(part.n, model);
  });
  return { placements, neighbours, typeOf, modelOf };
}

