import { z } from 'zod';
import { requireUser } from '../../../../lib/agent/server/auth';
import {
  getProject,
  startRun,
  finishRun,
  cancelRun,
  getRun,
  isCancelled,
} from '../../../../lib/agent/server/store';
import { setting } from '../../../../lib/agent/server/env';
import { readJson, fail, ApiError } from '../../../../lib/agent/server/http';
import { executeRun } from '../../../../lib/agent/server/runner';
import type { RunEvent } from '../../../../lib/agent/types';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const { db, user, env } = await requireUser(request);
    const parsed = z
      .object({
        projectId: z.uuid(),
        revision: z.number().int().positive(),
        mode: z.enum(['parts', 'optimize', 'qa']),
        message: z.string().trim().min(1).max(2000),
        locks: z.array(z.string().max(300)).max(100).default([]),
      })
      .safeParse(await readJson(request, 32000));
    if (!parsed.success)
      throw new ApiError(
        400,
        'invalid_input',
        '프로젝트·설계 버전·질문을 확인해 주세요.',
      );
    const input = parsed.data,
      project = await getProject(db, user.id, input.projectId);
    if (project.revision !== input.revision)
      throw new ApiError(
        409,
        'stale_revision',
        '저장된 최신 설계에서 다시 실행해 주세요.',
      );
    if (input.mode !== 'parts' && !setting(env, 'OPENAI_API_KEY'))
      throw new ApiError(
        503,
        'not_configured',
        'OpenAI API 설정이 필요합니다.',
      );
    const runId = await startRun(
      db,
      user.id,
      project,
      input.mode,
      input.message,
    );
    const abort = new AbortController(),
      signal = AbortSignal.any([
        request.signal,
        abort.signal,
        AbortSignal.timeout(240000),
      ]),
      encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let checking = false;
        const cancellationPoll = setInterval(() => {
          if (checking) return;
          checking = true;
          void isCancelled(db, user.id, runId)
            .then((cancelled) => {
              if (cancelled) abort.abort();
            })
            .catch(() => abort.abort())
            .finally(() => {
              checking = false;
            });
        }, 1000);
        const emit = (event: RunEvent) => {
          if (!abort.signal.aborted) {
            try {
              controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
            } catch {
              abort.abort();
            }
          }
        };
        emit({ type: 'start', runId, message: '작업을 시작했습니다.' });
        try {
          const result = await executeRun({
            db,
            env,
            userId: user.id,
            runId,
            project,
            ...input,
            signal,
            emit,
          });
          if (await isCancelled(db, user.id, runId))
            throw new ApiError(409, 'cancelled', '작업이 취소되었습니다.');
          const finished = await finishRun(
            db,
            user.id,
            runId,
            result.warnings.some((w) =>
              /완료하지 못|설정이 필요|확인해 주세요/.test(w),
            )
              ? 'partial'
              : 'completed',
            result,
          );
          if (!finished)
            throw new ApiError(409, 'cancelled', 'The run was cancelled.');
          emit({ type: 'result', runId, result });
        } catch (error) {
          if (signal.aborted || (await isCancelled(db, user.id, runId))) {
            await cancelRun(db, user.id, runId);
            emit({
              type: 'error',
              runId,
              message: '작업이 취소되었거나 제한 시간을 초과했습니다.',
            });
          } else {
            const saved = await getRun(db, user.id, runId);
            await finishRun(
              db,
              user.id,
              runId,
              saved.result ? 'partial' : 'failed',
              saved.result,
            );
            emit({
              type: 'error',
              runId,
              message:
                error instanceof ApiError
                  ? error.message
                  : '작업을 완료하지 못했습니다. 저장된 결과를 확인해 주세요.',
            });
          }
        } finally {
          clearInterval(cancellationPoll);
          try {
            controller.close();
          } catch {
            /* Disconnected consumer. */
          }
        }
      },
      async cancel() {
        abort.abort();
        await cancelRun(db, user.id, runId);
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return fail(error);
  }
}
