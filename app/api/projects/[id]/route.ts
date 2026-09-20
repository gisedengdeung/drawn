import { z } from 'zod';
import { requireUser } from '../../../../lib/agent/server/auth';
import {
  json,
  fail,
  readJson,
  ApiError,
} from '../../../../lib/agent/server/http';
import { getProject, saveProject } from '../../../../lib/agent/server/store';
import { validatedDraft } from '../../../../lib/agent/server/dataset';
type Context = { params: Promise<{ id: string }> };
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: Context) {
  try {
    const { db, user } = await requireUser(request);
    return json(await getProject(db, user.id, (await context.params).id));
  } catch (error) {
    return fail(error);
  }
}
export async function PATCH(request: Request, context: Context) {
  try {
    const { db, user, env } = await requireUser(request),
      id = (await context.params).id;
    await getProject(db, user.id, id);
    const parsed = z
      .object({
        expectedRevision: z.number().int().positive(),
        draft: z.unknown(),
        title: z.string().trim().min(1).max(80).optional(),
      })
      .safeParse(await readJson(request));
    if (!parsed.success)
      throw new ApiError(
        400,
        'invalid_input',
        '설계 버전과 값을 확인해 주세요.',
      );
    return json(
      await saveProject(
        db,
        user.id,
        id,
        parsed.data.expectedRevision,
        await validatedDraft(env, parsed.data.draft),
        parsed.data.title,
      ),
    );
  } catch (error) {
    return fail(error);
  }
}
