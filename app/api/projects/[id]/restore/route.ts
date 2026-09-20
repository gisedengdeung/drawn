import { z } from 'zod';
import { requireUser } from '../../../../../lib/agent/server/auth';
import {
  json,
  fail,
  readJson,
  ApiError,
} from '../../../../../lib/agent/server/http';
import { getProject, saveProject } from '../../../../../lib/agent/server/store';
import type { DesignDraft } from '../../../../../lib/drawn-types';
export const dynamic = 'force-dynamic';
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { db, user } = await requireUser(request),
      id = (await context.params).id;
    await getProject(db, user.id, id);
    const value = z
      .object({
        expectedRevision: z.number().int().positive(),
        revision: z.number().int().positive(),
      })
      .safeParse(await readJson(request));
    if (!value.success)
      throw new ApiError(400, 'invalid_input', '복원할 버전을 확인해 주세요.');
    const row = await db
      .prepare(
        'SELECT draft_json FROM agent_revisions WHERE project_id=? AND revision=?',
      )
      .bind(id, value.data.revision)
      .first<{ draft_json: string }>();
    if (!row)
      throw new ApiError(404, 'not_found', '저장된 버전을 찾을 수 없습니다.');
    return json(
      await saveProject(
        db,
        user.id,
        id,
        value.data.expectedRevision,
        JSON.parse(row.draft_json) as DesignDraft,
      ),
    );
  } catch (error) {
    return fail(error);
  }
}
