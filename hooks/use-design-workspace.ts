'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type {
  AssemblyInfo,
  ComponentCatalogs,
  DesignAssembly,
  DesignDraft,
  DesignSummary,
  PartCatalog,
  PartPlacementGroup,
  ShowcaseDesign,
} from '@/lib/drawn-types';
import { catalogsFromShowcases, cloneDraft, draftFromDesign, hydrateDraft } from '@/lib/design-draft';
import { resolveAssembly } from '@/lib/assembly';

/** prepare-part-placements.mjs가 설계 20개씩 한 파일로 묶는다. */
const PLACEMENT_GROUP_SIZE = 20;

const EMPTY_CATALOGS: ComponentCatalogs = {
  motors: [], propellers: [], batteries: [], servos: [], nacaProfiles: [], nodeTypes: [],
};

type LoadedWorkspace = {
  designId: number;
  importVersion: number;
  baseline: DesignDraft;
  draft: DesignDraft | null;
  catalogs: ComponentCatalogs;
  placements: AssemblyInfo | null;
  loadError: string | null;
};

export type DesignWorkspace = {
  baseline: DesignDraft | null;
  draft: DesignDraft | null;
  setDraft: Dispatch<SetStateAction<DesignDraft | null>>;
  catalogs: ComponentCatalogs;
  /** 원본 STEP 부품 배치. 없으면 뷰어가 기존 추정 배치로 되돌아간다. */
  placements: AssemblyInfo | null;
  loading: boolean;
  loadError: string | null;
};

/** One editable design shared by the editor and the parts workspace. */
export function useDesignWorkspace(
  selected: DesignSummary | null,
  reference: ShowcaseDesign | null,
  initialDraft: DesignDraft | null = null,
  importVersion = 0,
  onDraftChange?: Dispatch<SetStateAction<DesignDraft | null>>,
): DesignWorkspace {
  const [loaded, setLoaded] = useState<LoadedWorkspace | null>(null);
  const selectedId = selected?.id;
  const loadedId = loaded?.designId;
  const loadedImportVersion = loaded?.importVersion;

  useEffect(() => {
    // Reuse a still-loaded design when the user returns before another load finishes.
    // Starting another request here could overwrite edits made after returning.
    if (!selected || (loadedId === selected.id && loadedImportVersion === importVersion)) return;
    const abort = new AbortController();
    const shard = String(Math.floor(selected.id / 1000)).padStart(3, '0');
    const read = async <T,>(url: string, message: string): Promise<T> => {
      const response = await fetch(url, { signal: abort.signal });
      if (!response.ok) throw new Error(message);
      return response.json() as Promise<T>;
    };
    const group = String(Math.floor(selected.id / PLACEMENT_GROUP_SIZE)).padStart(4, '0');
    // Placements only sharpen the preview, so a miss must not fail the whole load.
    // 조립 그래프와 부품 카탈로그를 함께 읽어 뷰어가 쓰는 형태로 푼다.
    const readPlacements = Promise.all([
      read<PartPlacementGroup>(`/data/part-placements/group-${group}.json`, 'placements'),
      read<PartCatalog>('/data/part-catalog.json', 'part catalog').catch(
        () => ({ types: [], models: [] }) as PartCatalog,
      ),
    ])
      .then(([groups, catalog]) => resolveAssembly(groups[String(selected.id)], catalog))
      .catch(() => null);

    void Promise.all([
      read<Record<string, DesignDraft>>(`/data/design-trees/shard-${shard}.json`, '설계 트리를 불러오지 못했습니다.'),
      read<ComponentCatalogs>('/data/component-catalogs.json', '부품 카탈로그를 불러오지 못했습니다.'),
      readPlacements,
    ]).then(([designs, catalogs, placements]) => {
      if (abort.signal.aborted) return;
      const source = designs[String(selected.id)];
      if (!source) throw new Error(`Design #${selected.id}의 설계 트리가 없습니다.`);
      const baseline = hydrateDraft(source);
      const draft = initialDraft?.baselineId === selected.id ? initialDraft : baseline;
      setLoaded({ designId: selected.id, importVersion, baseline, draft: cloneDraft(draft), catalogs, placements, loadError: null });
    }).catch((reason: unknown) => {
      if (abort.signal.aborted) return;
      const baseline = draftFromDesign(selected, reference);
      const draft = initialDraft?.baselineId === selected.id ? initialDraft : baseline;
      setLoaded({ designId: selected.id, importVersion, baseline, draft: cloneDraft(draft),
        catalogs: reference ? catalogsFromShowcases([reference]) : EMPTY_CATALOGS,
        placements: null,
        loadError: reason instanceof Error ? reason.message : '설계 로딩 오류' });
    });
    return () => abort.abort();
  }, [selected, reference, loadedId, loadedImportVersion, initialDraft, importVersion]);

  // Mask stale drafts during selection changes and same-design gallery imports.
  // This also prevents persistence from overwriting the newly imported snapshot.
  const current = loaded && loaded.designId === selectedId && loaded.importVersion === importVersion ? loaded : null;
  const draft = current ? (initialDraft?.baselineId === selectedId ? initialDraft : current.draft) : null;
  const setDraft = useCallback<Dispatch<SetStateAction<DesignDraft | null>>>((update) => {
    if (!current) return;
    if (onDraftChange) {
      onDraftChange((previous) => {
        const previousDraft = previous?.baselineId === selectedId ? previous : current.draft;
        const nextDraft = typeof update === 'function' ? update(previousDraft) : update;
        return nextDraft && nextDraft.baselineId !== selectedId ? previousDraft : nextDraft;
      });
      return;
    }
    setLoaded((previous) => {
      if (!previous || previous.designId !== selectedId || previous.importVersion !== importVersion) return previous;
      const nextDraft = typeof update === 'function' ? update(previous.draft) : update;
      if (nextDraft && nextDraft.baselineId !== previous.designId) return previous;
      return { ...previous, draft: nextDraft };
    });
  }, [current, selectedId, importVersion, onDraftChange]);

  return { baseline: current?.baseline ?? null, draft, setDraft, placements: current?.placements ?? null,
    catalogs: current?.catalogs ?? EMPTY_CATALOGS, loading: !current, loadError: current?.loadError ?? null };
}
