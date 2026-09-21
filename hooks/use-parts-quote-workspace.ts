'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DesignDraft } from '../lib/drawn-types';
import { createBomSnapshot, draftFingerprint } from '../lib/parts/bom';
import { loadStoredQuote, restoreQuote, saveStoredQuote } from '../lib/parts/session';
import {
  acknowledgeQuoteSave,
  latestProjectQuote,
  loadQuoteWorkspace,
  quoteWorkspaceKey,
  reconcileQuoteEntry,
  sameQuoteSnapshot,
  saveQuoteWorkspace,
  selectQuoteOffer,
  upsertQuoteEntry,
  type QuoteScope,
  type QuoteWorkspaceEntry,
  type WorkspaceQuote,
} from '../lib/parts/quote-workspace';

type Options = {
  draft: DesignDraft | null;
  userId: string | null;
  sessionLoading: boolean;
  projectId: string | null;
  runId: string | null;
  agentQuote: WorkspaceQuote | null;
  onSaveQuote: (quote: WorkspaceQuote) => Promise<void>;
  blocked: boolean;
};

/** Lives beside the shared design workspace, outside responsive/conditional panels. */
export function usePartsQuoteWorkspace({
  draft, userId, sessionLoading, projectId, runId, agentQuote, onSaveQuote, blocked,
}: Options) {
  const [ready, setReady] = useState(false);
  const [entries, setEntries] = useState<QuoteWorkspaceEntry[]>([]);
  const [legacyQuote, setLegacyQuote] = useState<WorkspaceQuote | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ key: string; text: string } | null>(null);
  const saveLock = useRef(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const currentBom = useMemo(() => draft ? createBomSnapshot(draft) : null, [draft]);
  const fingerprint = useMemo(() => draft ? draftFingerprint(draft) : null, [draft]);
  const canonical = useMemo(() => agentQuote ? restoreQuote(JSON.stringify(agentQuote)) : null, [agentQuote]);
  const scope = useMemo<QuoteScope | null>(() =>
    !sessionLoading && userId && projectId && runId ? { userId, projectId, runId } : null,
  [sessionLoading, userId, projectId, runId]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        setEntries(loadQuoteWorkspace(window.sessionStorage));
        setLegacyQuote(loadStoredQuote(window.sessionStorage));
      } catch { /* Browsers may prohibit access to sessionStorage itself. */ }
      setReady(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!ready || !scope || !canonical) return;
    const key = quoteWorkspaceKey(scope, canonical.snapshot);
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setEntries((previous) => {
        const entry = previous.find((candidate) => quoteWorkspaceKey(candidate, candidate.quote.snapshot) === key);
        return upsertQuoteEntry(previous, reconcileQuoteEntry(entry, scope, canonical, Date.now()));
      });
    });
    return () => { active = false; };
  }, [ready, scope, canonical]);

  useEffect(() => {
    if (!ready) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const scopedSaved = saveQuoteWorkspace(window.sessionStorage, entries);
        const legacySaved = !legacyQuote || saveStoredQuote(window.sessionStorage, legacyQuote);
        setStorageFailed(!scopedSaved || !legacySaved);
      } catch { setStorageFailed(true); }
    });
    return () => { active = false; };
  }, [ready, entries, legacyQuote]);

  const visibleEntry = useMemo(() => {
    if (!ready || sessionLoading || !userId || !projectId) return undefined;
    if (scope && canonical) {
      const key = quoteWorkspaceKey(scope, canonical.snapshot);
      const prior = entries.find((entry) => quoteWorkspaceKey(entry, entry.quote.snapshot) === key);
      return reconcileQuoteEntry(prior, scope, canonical, prior?.updatedAt ?? 0);
    }
    return latestProjectQuote(entries, userId, projectId);
  }, [ready, sessionLoading, userId, projectId, scope, canonical, entries]);
  const anonymousQuote = ready && !sessionLoading && !userId && !projectId ? legacyQuote : null;
  const quote = visibleEntry?.quote ?? anonymousQuote;
  const visibleKey = visibleEntry ? quoteWorkspaceKey(visibleEntry, visibleEntry.quote.snapshot)
    : anonymousQuote ? 'legacy' : '';
  const snapshot = quote?.snapshot ?? currentBom;
  const lines = useMemo(() => quote?.lines ?? currentBom?.items.map((item) => ({
    item, result: null, selectedOfferId: null,
  })) ?? [], [quote, currentBom]);
  const stale = !!quote && (!draft || quote.snapshot.designId !== draft.baselineId || quote.snapshot.fingerprint !== fingerprint);
  const canSave = !!(ready && !sessionLoading && !blocked && !savingKey && scope && canonical && visibleEntry
    && quoteWorkspaceKey(scope, canonical.snapshot) === visibleKey
    && sameQuoteSnapshot(visibleEntry.quote.snapshot, canonical.snapshot));

  function selectOffer(itemId: string, offerId: string | null) {
    if (!ready || sessionLoading || blocked || saveLock.current || !quote) return;
    setMessage(null);
    if (visibleEntry) {
      setEntries((previous) => {
        const existing = previous.find((entry) => quoteWorkspaceKey(entry, entry.quote.snapshot) === visibleKey) ?? visibleEntry;
        const refreshed = scope && canonical && quoteWorkspaceKey(scope, canonical.snapshot) === visibleKey
          ? reconcileQuoteEntry(existing, scope, canonical, existing.updatedAt) : existing;
        const selected = selectQuoteOffer(refreshed, itemId, offerId, Date.now());
        return selected === refreshed ? previous : upsertQuoteEntry(previous, selected);
      });
      return;
    }
    if (!anonymousQuote) return;
    const line = anonymousQuote.lines.find((candidate) => candidate.item.id === itemId);
    if (!line || (offerId !== null && !line.result?.offers.some((offer) => offer.id === offerId))) return;
    setLegacyQuote({ ...anonymousQuote, lines: anonymousQuote.lines.map((candidate) => candidate.item.id === itemId
      ? { ...candidate, selectedOfferId: offerId } : candidate) });
  }

  async function save() {
    if (!canSave || !visibleEntry || saveLock.current) return;
    const submitted = visibleEntry.quote;
    const submittedKey = visibleKey;
    saveLock.current = true;
    setSavingKey(submittedKey);
    setMessage(null);
    try {
      await onSaveQuote(submitted);
      setEntries((previous) => previous.map((entry) => quoteWorkspaceKey(entry, entry.quote.snapshot) === submittedKey
        ? acknowledgeQuoteSave(entry, submitted) : entry));
      setMessage({ key: submittedKey, text: '선택한 상품을 프로젝트 견적에 저장했습니다.' });
    } catch (reason) {
      setMessage({ key: submittedKey, text: reason instanceof Error ? reason.message : '견적 선택을 저장하지 못했습니다.' });
    } finally {
      saveLock.current = false;
      setSavingKey(null);
    }
  }

  return {
    snapshot, lines, currentBom, ready: ready && !sessionLoading, stale,
    isQuote: !!quote, saving: savingKey === visibleKey && !!visibleKey,
    canSave, notice: message?.key === visibleKey ? message.text : storageFailed && quote
      ? '브라우저 저장소를 사용할 수 없어 새로고침하면 미저장 상품 선택이 사라질 수 있습니다.' : '',
    selectOffer, save,
  };
}

export type PartsQuoteWorkspace = ReturnType<typeof usePartsQuoteWorkspace>;