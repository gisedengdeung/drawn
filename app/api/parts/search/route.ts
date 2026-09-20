import { z } from 'zod';
import { searchParts } from '../../../../lib/parts/server/search';
import { getPartsConfig } from '../../../../lib/parts/server/config';
import { validatePartSearch } from '../../../../lib/parts/server/validation';
import { createBomSnapshot } from '../../../../lib/parts/bom';
import { requireUser } from '../../../../lib/agent/server/auth';
import { readJson, ApiError } from '../../../../lib/agent/server/http';
import { setting } from '../../../../lib/agent/server/env';
import {
  getProject,
  startRun,
  consumeBudget,
  finishRun,
  cancelRun,
} from '../../../../lib/agent/server/store';
export const dynamic = 'force-dynamic';
function failure(status: string, message: string, code: number, itemId = '') {
  return Response.json(
    {
      itemId,
      status,
      offers: [],
      warnings: [message],
      retrievedAt: new Date().toISOString(),
    },
    { status: code, headers: { 'cache-control': 'no-store' } },
  );
}
export async function POST(request: Request) {
  let runId: string | undefined;
  try {
    const raw = await readJson(request, 16384),
      input = validatePartSearch(raw);
    if (!input)
      return failure(
        'error',
        '부품 모델, 수량 또는 한국 배송·원화 설정을 확인하세요.',
        400,
      );
    const { db, user, env } = await requireUser(request);
    const context = z
      .object({ projectId: z.uuid(), revision: z.number().int().positive() })
      .safeParse(raw);
    if (!context.success)
      throw new ApiError(
        400,
        'invalid_input',
        '저장된 프로젝트와 버전이 필요합니다. 설계 도우미에서 검색해 주세요.',
      );
    const project = await getProject(db, user.id, context.data.projectId);
    if (project.revision !== context.data.revision)
      throw new ApiError(
        409,
        'stale_revision',
        '최신 설계로 다시 검색해 주세요.',
      );
    const snapshot = createBomSnapshot(project.draft),
      item = snapshot.items.find((i) => i.id === input.item.id);
    if (!item)
      throw new ApiError(400, 'invalid_item', '현재 설계에 없는 부품입니다.');
    runId = await startRun(
      db,
      user.id,
      project,
      'parts',
      '부품 조회: ' + item.model,
    );
    try {
      const config = getPartsConfig(
        Object.fromEntries(
          [
            'ALIEXPRESS_APP_KEY',
            'ALIEXPRESS_APP_SECRET',
            'ALIEXPRESS_TRACKING_ID',
            'ALIEXPRESS_ACCESS_TOKEN',
            'ALIEXPRESS_DS_ENABLED',
            'ALIEXPRESS_TOP_REGION',
          ].map((name) => [name, setting(env, name)]),
        ),
      );
      const result = await searchParts(
        { item, country: 'KR', currency: 'KRW' },
        {
          config,
          signal: request.signal,
          allowAI: false,
          consumeBudget: () => consumeBudget(db, user.id, runId!, 'provider'),
        },
      );
      await finishRun(
        db,
        user.id,
        runId,
        result.status === 'ok' || result.status === 'not_found'
          ? 'completed'
          : 'partial',
        {
          answer: result.warnings.join(' '),
          evidence: [],
          proposals: [],
          quote: {
            snapshot,
            lines: snapshot.items.map((i) => ({
              item: i,
              result: i.id === item.id ? result : null,
              selectedOfferId: null,
            })),
          },
          warnings: result.warnings,
          context: {
            projectId: project.id,
            revision: project.revision,
            fingerprint: project.fingerprint,
          },
        },
      );
      const code =
        result.status === 'not_configured'
          ? 503
          : result.status === 'rate_limited'
            ? 429
            : result.status === 'error' || result.status === 'permission_denied'
              ? 502
              : 200;
      return Response.json(result, {
        status: code,
        headers: { 'cache-control': 'no-store' },
      });
    } catch (error) {
      await cancelRun(db, user.id, runId);
      throw error;
    }
  } catch (error) {
    return failure(
      error instanceof ApiError && error.status === 429
        ? 'rate_limited'
        : error instanceof ApiError && error.status === 503
          ? 'not_configured'
          : 'error',
      error instanceof ApiError
        ? error.message
        : '검색 요청을 처리하지 못했습니다.',
      error instanceof ApiError ? error.status : 500,
    );
  }
}
