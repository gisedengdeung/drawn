'use client';

import { useEffect, useState } from 'react';
import type { AssemblyInfo, DesignDraft, PartCatalog, PartPlacementGroup } from '@/lib/drawn-types';
import { hydrateDraft } from '@/lib/design-draft';
import { resolveAssembly } from '@/lib/assembly';

type Preview = { draft: DesignDraft; assembly: AssemblyInfo | null };

const jsonRequests = new Map<string, Promise<unknown>>();

function readCached<T>(url: string): Promise<T> {
  const cached = jsonRequests.get(url);
  if (cached) return cached as Promise<T>;
  const request = fetch(url).then((response) => {
    if (!response.ok) throw new Error(url);
    return response.json() as Promise<T>;
  });
  jsonRequests.set(url, request);
  void request.catch(() => {
    if (jsonRequests.get(url) === request) jsonRequests.delete(url);
  });
  return request;
}

/**
 * 원본 STL이 없는 설계를 미리 보여주기 위해 설계 트리와 부품 배치만 읽는다.
 * 편집용 `useDesignWorkspace`와 달리 카탈로그·draft 상태를 들고 있지 않아
 * 목록에서 설계를 옮겨 다닐 때 가볍다.
 */
export function useDesignPreview(designId: number | null) {
  const [preview, setPreview] = useState<{ id: number; value: Preview | null } | null>(null);

  useEffect(() => {
    if (designId == null) return;
    let active = true;
    const shard = String(Math.floor(designId / 1000)).padStart(3, '0');
    const group = String(Math.floor(designId / 20)).padStart(4, '0');

    void Promise.all([
      readCached<Record<string, DesignDraft>>(`/data/design-trees/shard-${shard}.json`),
      // 배치가 없어도 개념 형상은 그릴 수 있으므로 실패를 삼킨다.
      Promise.all([
        readCached<PartPlacementGroup>(`/data/part-placements/group-${group}.json`),
        readCached<PartCatalog>('/data/part-catalog.json').catch(
          () => ({ types: [], models: [] }) as PartCatalog,
        ),
      ])
        .then(([groups, catalog]) => resolveAssembly(groups[String(designId)], catalog))
        .catch(() => null),
    ])
      .then(([designs, assembly]) => {
        if (!active) return;
        const source = designs[String(designId)];
        setPreview({
          id: designId,
          value: source ? { draft: hydrateDraft(source), assembly } : null,
        });
      })
      .catch(() => {
        if (active) setPreview({ id: designId, value: null });
      });
    return () => { active = false; };
  }, [designId]);

  // 다른 설계로 옮겨간 직후 옛 형상을 그대로 보여주지 않는다.
  return preview?.id === designId ? preview.value : null;
}
