import { requireUser } from '../../../../lib/agent/server/auth';
import { json, fail, ApiError } from '../../../../lib/agent/server/http';
import { listRuns } from '../../../../lib/agent/server/store';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const { db, user } = await requireUser(request),
      projectId = new URL(request.url).searchParams.get('projectId');
    if (!projectId)
      throw new ApiError(400, 'invalid_input', '프로젝트가 필요합니다.');
    return json({ runs: await listRuns(db, user.id, projectId) });
  } catch (error) {
    return fail(error);
  }
}
