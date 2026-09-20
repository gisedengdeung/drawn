import { z } from 'zod';
import { requireUser } from '../../../lib/agent/server/auth';
import { json, fail, readJson, ApiError } from '../../../lib/agent/server/http';
import { listProjects, createProject } from '../../../lib/agent/server/store';
import { validatedDraft } from '../../../lib/agent/server/dataset';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const { db, user } = await requireUser(request);
    return json({ projects: await listProjects(db, user.id) });
  } catch (error) {
    return fail(error);
  }
}
export async function POST(request: Request) {
  try {
    const { db, user, env } = await requireUser(request);
    const value = z
      .object({
        title: z.string().trim().min(1).max(80),
        draft: z.unknown(),
        sourceId: z.uuid().nullable().optional(),
      })
      .safeParse(await readJson(request));
    if (!value.success)
      throw new ApiError(
        400,
        'invalid_input',
        '프로젝트 이름과 설계를 확인해 주세요.',
      );
    const draft = await validatedDraft(env, value.data.draft);
    return json(
      await createProject(
        db,
        user.id,
        value.data.title,
        draft,
        value.data.sourceId ?? null,
      ),
      201,
    );
  } catch (error) {
    return fail(error);
  }
}
