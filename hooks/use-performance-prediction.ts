'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DesignDraft } from '../lib/drawn-types';
import {
  PERFORMANCE_SPEEDS,
  performanceRequestKey,
  performanceFailure,
  type PerformanceFailure,
  requestPerformance,
  type PerformanceResult,
} from '../lib/performance-client';

type PredictionState = {
  key: string;
  status: 'loading' | 'ready' | 'error' | 'cancelled';
  result: PerformanceResult | null;
  error: PerformanceFailure | null;
};

export function usePerformancePrediction(designId: number, draft: DesignDraft | null, enabled = true) {
  const request = useMemo(() => ({ designId, ...(draft ? { draft } : {}), speeds: PERFORMANCE_SPEEDS }), [designId, draft]);
  const key = useMemo(() => performanceRequestKey(request), [request]);
  const [state, setState] = useState<PredictionState | null>(null);
  const [attempt, setAttempt] = useState(0);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    active.current = controller;
    // Geometry sliders remain immediate; only the remote request is debounced.
    const timer = window.setTimeout(() => {
      if (controller.signal.aborted) return;
      setState({ key, status: 'loading', result: null, error: null });
      void requestPerformance(request, controller.signal).then((result) => {
        if (!controller.signal.aborted) setState({ key, status: 'ready', result, error: null });
      }).catch((reason: unknown) => {
        if (!controller.signal.aborted) setState({
          key, status: 'error', result: null,
          error: performanceFailure(reason),
        });
      });
    }, 350);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (active.current === controller) active.current = null;
    };
  }, [enabled, key, request, attempt]);
  const cancel = useCallback(() => {
    active.current?.abort();
    setState({ key, status: 'cancelled', result: null, error: null });
  }, [key]);
  const retry = useCallback(() => {
    setState({ key, status: 'loading', result: null, error: null });
    setAttempt((value) => value + 1);
  }, [key]);
  // Hide an old design's prediction synchronously, before effect cleanup runs.
  const current = state?.key === key ? state : null;
  return {
    result: enabled ? current?.result ?? null : null,
    error: enabled ? current?.error?.message ?? null : null,
    failure: enabled ? current?.error ?? null : null,
    loading: enabled && (!current || current.status === 'loading'),
    cancelled: enabled && current?.status === 'cancelled',
    stale: Boolean(enabled && state && state.key !== key),
    cancel,
    retry,
  };
}
