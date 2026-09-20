'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ComponentCatalogs, DesignDraft, DesignSummary, ShowcaseDesign } from '@/lib/drawn-types';
import { catalogsFromShowcases, cloneDraft, draftFromDesign, hydrateDraft } from '@/lib/design-draft';

const EMPTY_CATALOGS: ComponentCatalogs = {
  motors: [], propellers: [], batteries: [], servos: [], nacaProfiles: [], nodeTypes: [],
};

type LoadedWorkspace = {
  designId: number;
  importVersion: number;
  baseline: DesignDraft;
  draft: DesignDraft | null;
  catalogs: ComponentCatalogs;
  loadError: string | null;
};

export type DesignWorkspace = {
  baseline: DesignDraft | null;
  draft: DesignDraft | null;
  setDraft: Dispatch<SetStateAction<DesignDraft | null>>;
  catalogs: ComponentCatalogs;
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
    void Promise.all([
      read<Record<string, DesignDraft>>(`/data/design-trees/shard-${shard}.json`, '설계 트리를 불러오지 못했습니다.'),
      read<ComponentCatalogs>('/data/component-catalogs.json', '부품 카탈로그를 불러오지 못했습니다.'),
    ]).then(([designs, catalogs]) => {
      if (abort.signal.aborted) return;
      const source = designs[String(selected.id)];
      if (!source) throw new Error(`Design #${selected.id}의 설계 트리가 없습니다.`);
      const baseline = hydrateDraft(source);
      const draft = initialDraft?.baselineId === selected.id ? initialDraft : baseline;
      setLoaded({ designId: selected.id, importVersion, baseline, draft: cloneDraft(draft), catalogs, loadError: null });
    }).catch((reason: unknown) => {
      if (abort.signal.aborted) return;
      const baseline = draftFromDesign(selected, reference);
      const draft = initialDraft?.baselineId === selected.id ? initialDraft : baseline;
      setLoaded({ designId: selected.id, importVersion, baseline, draft: cloneDraft(draft),
        catalogs: reference ? catalogsFromShowcases([reference]) : EMPTY_CATALOGS,
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

  return { baseline: current?.baseline ?? null, draft, setDraft,
    catalogs: current?.catalogs ?? EMPTY_CATALOGS, loading: !current, loadError: current?.loadError ?? null };
}
