import { restoreQuote } from './session';
import type { BomSnapshot, QuoteLine } from './types';

export type WorkspaceQuote = { snapshot: BomSnapshot; lines: QuoteLine[] };
export type QuoteScope = { userId: string; projectId: string; runId: string };
export type QuoteWorkspaceEntry = QuoteScope & {
  quote: WorkspaceQuote;
  dirtyItemIds: string[];
  updatedAt: number;
};

export const QUOTE_WORKSPACE_KEY = 'drawn.parts-quote-workspace.v1';
export const MAX_QUOTE_WORKSPACE_ENTRIES = 12;
const MAX_CACHE_SIZE = 2_000_000;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

export function sameQuoteSnapshot(left: BomSnapshot, right: BomSnapshot): boolean {
  return left.designId === right.designId
    && left.fingerprint === right.fingerprint
    && left.createdAt === right.createdAt;
}

export function quoteWorkspaceKey(scope: QuoteScope, snapshot: BomSnapshot): string {
  return JSON.stringify([
    scope.userId, scope.projectId, scope.runId,
    snapshot.designId, snapshot.fingerprint, snapshot.createdAt,
  ]);
}

export function quoteInProject(entry: QuoteWorkspaceEntry, userId: string, projectId: string): boolean {
  return entry.userId === userId && entry.projectId === projectId;
}

/** Refresh provider facts while keeping only valid selections the user has edited. */
export function reconcileQuoteEntry(
  previous: QuoteWorkspaceEntry | undefined,
  scope: QuoteScope,
  canonical: WorkspaceQuote,
  updatedAt: number,
): QuoteWorkspaceEntry {
  const same = previous && quoteWorkspaceKey(previous, previous.quote.snapshot)
    === quoteWorkspaceKey(scope, canonical.snapshot);
  const dirty = new Set(same ? previous.dirtyItemIds : []);
  const prior = new Map((same ? previous.quote.lines : []).map((line) => [line.item.id, line]));
  const retained: string[] = [];
  const lines = canonical.lines.map((line) => {
    const old = prior.get(line.item.id);
    if (!dirty.has(line.item.id) || !old) return line;
    const selection = old.selectedOfferId;
    if (selection !== null && !line.result?.offers.some((offer) => offer.id === selection)) return line;
    retained.push(line.item.id);
    return { ...line, selectedOfferId: selection };
  });
  return { ...scope, quote: { snapshot: canonical.snapshot, lines }, dirtyItemIds: retained, updatedAt };
}

export function selectQuoteOffer(
  entry: QuoteWorkspaceEntry, itemId: string, offerId: string | null, updatedAt: number,
): QuoteWorkspaceEntry {
  const line = entry.quote.lines.find((candidate) => candidate.item.id === itemId);
  if (!line || (offerId !== null && !line.result?.offers.some((offer) => offer.id === offerId))
    || line.selectedOfferId === offerId) return entry;
  return {
    ...entry,
    quote: { ...entry.quote, lines: entry.quote.lines.map((candidate) => candidate.item.id === itemId
      ? { ...candidate, selectedOfferId: offerId } : candidate) },
    dirtyItemIds: [...new Set([...entry.dirtyItemIds, itemId])],
    updatedAt,
  };
}

/** An in-flight save acknowledges its submitted selections, never later edits. */
export function acknowledgeQuoteSave(entry: QuoteWorkspaceEntry, submitted: WorkspaceQuote): QuoteWorkspaceEntry {
  if (!sameQuoteSnapshot(entry.quote.snapshot, submitted.snapshot)) return entry;
  const selections = new Map(submitted.lines.map((line) => [line.item.id, line.selectedOfferId]));
  const lines = new Map(entry.quote.lines.map((line) => [line.item.id, line]));
  return { ...entry, dirtyItemIds: entry.dirtyItemIds.filter((id) =>
    !selections.has(id) || lines.get(id)?.selectedOfferId !== selections.get(id)) };
}

export function upsertQuoteEntry(entries: QuoteWorkspaceEntry[], entry: QuoteWorkspaceEntry): QuoteWorkspaceEntry[] {
  const key = quoteWorkspaceKey(entry, entry.quote.snapshot);
  return [entry, ...entries.filter((candidate) => quoteWorkspaceKey(candidate, candidate.quote.snapshot) !== key)]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_QUOTE_WORKSPACE_ENTRIES);
}

export function latestProjectQuote(
  entries: QuoteWorkspaceEntry[], userId: string | null, projectId: string | null,
): QuoteWorkspaceEntry | undefined {
  if (!userId || !projectId) return undefined;
  return entries.filter((entry) => quoteInProject(entry, userId, projectId))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

/** Stored data is untrusted: reject oversized caches and discard invalid entries. */
export function restoreQuoteWorkspace(text: string): QuoteWorkspaceEntry[] {
  if (text.length > MAX_CACHE_SIZE) return [];
  let value: unknown;
  try { value = JSON.parse(text); } catch { return []; }
  if (!object(value) || value.version !== 1 || !Array.isArray(value.entries)
    || value.entries.length > MAX_QUOTE_WORKSPACE_ENTRIES) return [];
  let entries: QuoteWorkspaceEntry[] = [];
  for (const candidate of value.entries) {
    if (!object(candidate) || !identifier(candidate.userId) || !identifier(candidate.projectId)
      || !identifier(candidate.runId) || typeof candidate.updatedAt !== 'number'
      || !Number.isSafeInteger(candidate.updatedAt) || candidate.updatedAt < 0
      || !Array.isArray(candidate.dirtyItemIds) || candidate.dirtyItemIds.length > 100
      || !object(candidate.quote)) continue;
    const quote = restoreQuote(JSON.stringify(candidate.quote));
    if (!quote || !candidate.dirtyItemIds.every((id): id is string =>
      typeof id === 'string' && quote.lines.some((line) => line.item.id === id))) continue;
    const entry = {
      userId: candidate.userId, projectId: candidate.projectId, runId: candidate.runId,
      updatedAt: candidate.updatedAt, dirtyItemIds: [...new Set(candidate.dirtyItemIds)], quote,
    };
    const duplicate = entries.find((prior) => quoteWorkspaceKey(prior, prior.quote.snapshot)
      === quoteWorkspaceKey(entry, quote.snapshot));
    if (!duplicate || duplicate.updatedAt < entry.updatedAt) entries = upsertQuoteEntry(entries, entry);
  }
  return entries;
}

export function loadQuoteWorkspace(storage: Pick<Storage, 'getItem'>): QuoteWorkspaceEntry[] {
  try { return restoreQuoteWorkspace(storage.getItem(QUOTE_WORKSPACE_KEY) ?? ''); }
  catch { return []; }
}

export function saveQuoteWorkspace(storage: Pick<Storage, 'setItem'>, entries: QuoteWorkspaceEntry[]): boolean {
  const bounded = [...entries].sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_QUOTE_WORKSPACE_ENTRIES);
  let text = JSON.stringify({ version: 1, entries: bounded });
  while (text.length > MAX_CACHE_SIZE && bounded.length) {
    bounded.pop();
    text = JSON.stringify({ version: 1, entries: bounded });
  }
  try { storage.setItem(QUOTE_WORKSPACE_KEY, text); return true; }
  catch { return false; }
}
