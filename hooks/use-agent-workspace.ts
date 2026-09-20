'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesignDraft } from '@/lib/drawn-types';
import { draftFingerprint } from '@/lib/parts/bom';
import type {
  RunEvent,
  AgentMode,
  Project,
  AgentResult,
  AgentRun,
  AgentSession,
} from '@/lib/agent/types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'same-origin',
  });
  const body = (await response.json()) as T & {
    error?: string | { message?: string };
  };
  if (!response.ok) {
    const detail =
      typeof body.error === 'string' ? body.error : body.error?.message;
    throw new Error(
      detail || `요청을 처리하지 못했습니다 (${response.status}).`,
    );
  }
  return body;
}

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : '요청을 처리하지 못했습니다.';

export function useAgentWorkspace({
  draft,
  sourceId,
  onImport,
}: {
  draft: DesignDraft | null;
  sourceId: string | null;
  onImport: (project: Project) => void;
}) {
  const [session, setSession] = useState<AgentSession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [savedSignature, setSavedSignature] = useState('');
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [result, setResult] = useState<AgentResult | null>(null);
  const [resultRunId, setResultRunId] = useState<string | null>(null);
  const [savedQuote, setSavedQuote] = useState<{
    runId: string;
    quote: NonNullable<AgentResult['quote']>;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [undoRevision, setUndoRevision] = useState<number | null>(null);
  const activeRun = useRef<string | null>(null);
  const streamController = useRef<AbortController | null>(null);
  const operationLock = useRef(false);
  const draftSignature = draft ? draftFingerprint(draft) : '';
  const latestDraftSignature = useRef(draftSignature);
  useEffect(() => {
    latestDraftSignature.current = draftSignature;
  }, [draftSignature]);
  const dirty = !!project && draftSignature !== savedSignature;
  const displayQuote =
    savedQuote?.runId === resultRunId
      ? savedQuote.quote
      : (result?.quote ?? null);
  const stale =
    !!result &&
    (!project ||
      result.context.projectId !== project.id ||
      result.context.revision !== project.revision ||
      dirty);

  const refreshSession = useCallback(async () => {
    const value = await request<AgentSession>('/api/agent/session');
    setSession(value);
    return value;
  }, []);
  const refreshProjects = useCallback(async () => {
    const value = await request<{ projects: Project[] }>('/api/projects');
    setProjects(value.projects);
    return value.projects;
  }, []);
  const refreshRuns = useCallback(async (projectId: string) => {
    const value = await request<{ runs: AgentRun[] }>(
      `/api/agent/runs?projectId=${encodeURIComponent(projectId)}`,
    );
    setRuns(value.runs);
    return value.runs;
  }, []);

  useEffect(() => {
    let active = true;
    void request<AgentSession>('/api/agent/session')
      .then(async (value) => {
        if (!active) return;
        setSession(value);
        if (value.user) {
          const saved = await request<{ projects: Project[] }>('/api/projects');
          if (active) setProjects(saved.projects);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(describeError(reason));
      })
      .finally(() => {
        if (active) setSessionLoading(false);
      });
    return () => {
      active = false;
      streamController.current?.abort();
    };
  }, []);

  const signIn = async () => {
    setError('');
    setBusy(true);
    try {
      const value = await request<{ url?: string }>(
        '/api/auth/sign-in/social',
        {
          method: 'POST',
          body: JSON.stringify({
            provider: 'google',
            callbackURL: window.location.origin,
          }),
        },
      );
      if (!value.url)
        throw new Error('로그인 주소를 받지 못했습니다. 설정을 확인해 주세요.');
      const destination = new URL(value.url);
      if (
        destination.protocol !== 'https:' &&
        destination.origin !== window.location.origin
      )
        throw new Error('로그인 주소가 올바르지 않습니다.');
      window.location.assign(destination.href);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    if (operationLock.current) return;
    setBusy(true);
    setError('');
    try {
      await request('/api/auth/sign-out', { method: 'POST', body: '{}' });
      setProject(null);
      setProjects([]);
      setRuns([]);
      setResult(null);
      setResultRunId(null);
      setUndoRevision(null);
      await refreshSession();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  };

  // Persist only on explicit actions. Editor changes never replace a server revision silently.
  const persistDraft = async (createNew = false): Promise<Project> => {
    if (!draft) throw new Error('편집할 설계를 먼저 선택해 주세요.');
    if (!session?.user) throw new Error('Google 로그인 후 이용해 주세요.');
    if (project && !createNew && !dirty) return project;
    const value =
      project && !createNew
        ? await request<Project>(
            `/api/projects/${encodeURIComponent(project.id)}`,
            {
              method: 'PATCH',
              body: JSON.stringify({
                expectedRevision: project.revision,
                draft,
              }),
            },
          )
        : await request<Project>('/api/projects', {
            method: 'POST',
            body: JSON.stringify({
              title: draft.name || `Design #${draft.baselineId}`,
              draft,
              sourceId,
            }),
          });
    setProject(value);
    setSavedSignature(draftSignature);
    setProjects((current) => [
      value,
      ...current.filter((item) => item.id !== value.id),
    ]);
    if (createNew) {
      setRuns([]);
      setResult(null);
      setResultRunId(null);
      setUndoRevision(null);
    }
    return value;
  };

  const save = async (createNew = false) => {
    if (operationLock.current) return;
    operationLock.current = true;
    setBusy(true);
    setError('');
    try {
      await persistDraft(createNew);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      operationLock.current = false;
      setBusy(false);
    }
  };

  const loadProject = async (id: string) => {
    if (operationLock.current) return;
    operationLock.current = true;
    setBusy(true);
    setError('');
    try {
      const [value, history, quotes] = await Promise.all([
        request<Project>(`/api/projects/${encodeURIComponent(id)}`),
        request<{ runs: AgentRun[] }>(
          `/api/agent/runs?projectId=${encodeURIComponent(id)}`,
        ),
        request<{
          quotes: Array<{
            runId: string;
            quote: NonNullable<AgentResult['quote']>;
          }>;
        }>(`/api/projects/${encodeURIComponent(id)}/quotes`),
      ]);
      if (latestDraftSignature.current !== draftSignature)
        throw new Error(
          '불러오는 동안 설계가 편집되었습니다. 현재 편집을 저장한 뒤 프로젝트를 다시 불러와 주세요.',
        );
      onImport(value);
      setProject(value);
      setSavedSignature(draftFingerprint(value.draft));
      setRuns(history.runs);
      const latest = history.runs.find((run) => run.result);
      setSavedQuote(
        quotes.quotes.find((quote) => quote.runId === latest?.id) ?? null,
      );
      setResult(latest?.result ?? null);
      setResultRunId(latest?.id ?? null);
      setUndoRevision(null);
      setProgress([]);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      operationLock.current = false;
      setBusy(false);
    }
  };

  const run = async (
    mode: AgentMode,
    message: string,
    locks: string[] = [],
  ) => {
    if (operationLock.current) return;
    operationLock.current = true;
    setRunning(true);
    setError('');
    setResult(null);
    setResultRunId(null);
    setProgress(['현재 설계를 저장하고 있습니다.']);
    activeRun.current = null;
    const controller = new AbortController();
    streamController.current = controller;
    let saved: Project | null = null;
    try {
      saved = await persistDraft();
      if (controller.signal.aborted) return;
      const response = await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify({
          projectId: saved.id,
          revision: saved.revision,
          mode,
          message,
          locks,
        }),
      });
      if (!response.ok) {
        const value = (await response.json()) as { error?: string };
        throw new Error(
          value.error || `도우미를 실행하지 못했습니다 (${response.status}).`,
        );
      }
      if (!response.body)
        throw new Error(
          '진행 결과를 수신하지 못했습니다. 기록에서 확인해 주세요.',
        );
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let terminal = false;
      const accept = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line) as RunEvent;
        if (event.runId) activeRun.current = event.runId;
        if (event.message)
          setProgress((current) => [...current.slice(-19), event.message!]);
        if (event.type === 'result' && event.result) {
          setResult(event.result);
          setResultRunId(event.runId ?? activeRun.current);
          terminal = true;
        }
        if (event.type === 'error') {
          terminal = true;
          throw new Error(event.message || '실행 중 오류가 발생했습니다.');
        }
      };
      try {
        while (true) {
          const chunk = await reader.read();
          pending += decoder.decode(chunk.value, { stream: !chunk.done });
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) accept(line);
          if (chunk.done) break;
        }
        accept(pending);
      } finally {
        reader.releaseLock();
      }
      if (!terminal)
        throw new Error(
          '연결이 끊어졌습니다. 자동 재실행하지 않았습니다. 실행 기록을 새로고침해 결과를 확인해 주세요.',
        );
    } catch (reason) {
      if (!controller.signal.aborted) setError(describeError(reason));
    } finally {
      streamController.current = null;
      activeRun.current = null;
      operationLock.current = false;
      setRunning(false);
      const updates: Promise<unknown>[] = [refreshSession()];
      if (saved) updates.push(refreshRuns(saved.id));
      void Promise.allSettled(updates);
    }
  };

  const cancel = async () => {
    const id = activeRun.current;
    try {
      if (id)
        await request(`/api/agent/runs/${encodeURIComponent(id)}/cancel`, {
          method: 'POST',
          body: '{}',
        });
      streamController.current?.abort();
      setProgress((current) => [
        ...current,
        '실행을 취소했습니다. 완료된 내용은 실행 기록에서 확인할 수 있습니다.',
      ]);
    } catch (reason) {
      setError(describeError(reason));
    }
  };

  const apply = async (proposalId: string) => {
    if (!project || operationLock.current) return;
    if (stale) {
      setError(
        '제안 이후 설계가 변경되었습니다. 현재 설계로 다시 실행해 주세요.',
      );
      return;
    }
    operationLock.current = true;
    setBusy(true);
    setError('');
    try {
      const value = await request<Project>(
        `/api/design-proposals/${encodeURIComponent(proposalId)}/apply`,
        {
          method: 'POST',
          body: JSON.stringify({ expectedRevision: project.revision }),
        },
      );
      setUndoRevision(project.revision);
      setProject(value);
      setSavedSignature(draftFingerprint(value.draft));
      setProjects((current) => [
        value,
        ...current.filter((item) => item.id !== value.id),
      ]);
      if (latestDraftSignature.current !== draftSignature)
        throw new Error(
          '요청 중 새 편집이 생겨 화면을 바꾸지 않았습니다. 변경안은 프로젝트에 저장되었습니다. 현재 편집을 새 프로젝트로 보존하거나 저장된 프로젝트를 다시 불러와 주세요.',
        );
      onImport(value);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      operationLock.current = false;
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!project || undoRevision == null || operationLock.current) return;
    if (dirty) {
      setError(
        '현재 편집을 먼저 저장하거나 별도 프로젝트로 가져온 뒤 되돌려 주세요.',
      );
      return;
    }
    operationLock.current = true;
    setBusy(true);
    setError('');
    try {
      const value = await request<Project>(
        `/api/projects/${encodeURIComponent(project.id)}/restore`,
        {
          method: 'POST',
          body: JSON.stringify({
            expectedRevision: project.revision,
            revision: undoRevision,
          }),
        },
      );
      setProject(value);
      setSavedSignature(draftFingerprint(value.draft));
      setUndoRevision(null);
      setProjects((current) => [
        value,
        ...current.filter((item) => item.id !== value.id),
      ]);
      if (latestDraftSignature.current !== draftSignature)
        throw new Error(
          '요청 중 새 편집이 생겨 화면을 바꾸지 않았습니다. 되돌린 버전은 프로젝트에 저장되었습니다. 현재 편집을 새 프로젝트로 보존하거나 저장된 프로젝트를 다시 불러와 주세요.',
        );
      onImport(value);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      operationLock.current = false;
      setBusy(false);
    }
  };

  const saveQuote = async (quote: NonNullable<AgentResult['quote']>) => {
    if (!project || !resultRunId || !result?.quote)
      throw new Error('저장할 실행 기록을 먼저 선택해 주세요.');
    if (
      quote.snapshot.fingerprint !== result.quote.snapshot.fingerprint ||
      quote.snapshot.createdAt !== result.quote.snapshot.createdAt
    ) {
      throw new Error(
        '이 견적과 실행 기록의 설계 기준이 다릅니다. 부품을 다시 조회해 주세요.',
      );
    }
    const saved = await request<{
      runId: string;
      quote: NonNullable<AgentResult['quote']>;
    }>(`/api/projects/${encodeURIComponent(project.id)}/quotes`, {
      method: 'POST',
      body: JSON.stringify({
        runId: resultRunId,
        selections: quote.lines.map((line) => ({
          itemId: line.item.id,
          offerId: line.selectedOfferId,
        })),
      }),
    });
    setSavedQuote(saved);
  };
  const selectRun = (item: AgentRun) => {
    if (running) return;
    setResult(item.result ?? null);
    setResultRunId(item.id);
    setProgress([]);
    setError('');
    if (project && item.result?.quote)
      void request<{
        quotes: Array<{
          runId: string;
          quote: NonNullable<AgentResult['quote']>;
        }>;
      }>(`/api/projects/${encodeURIComponent(project.id)}/quotes`)
        .then((value) =>
          setSavedQuote(
            value.quotes.find((quote) => quote.runId === item.id) ?? null,
          ),
        )
        .catch((reason: unknown) => setError(describeError(reason)));
  };
  const refresh = async () => {
    setBusy(true);
    setError('');
    try {
      const current = await refreshSession();
      if (current.user)
        await Promise.all([
          refreshProjects(),
          ...(project ? [refreshRuns(project.id)] : []),
        ]);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  };

  return {
    session,
    sessionLoading,
    projects,
    project,
    runs,
    result,
    resultRunId,
    running,
    busy,
    progress,
    error,
    dirty,
    stale,
    displayQuote,
    saveQuote,
    canUndo: undoRevision != null && !dirty,
    signIn,
    signOut,
    save,
    loadProject,
    run,
    cancel,
    apply,
    undo,
    selectRun,
    refresh,
  };
}

export type AgentWorkspaceController = ReturnType<typeof useAgentWorkspace>;
