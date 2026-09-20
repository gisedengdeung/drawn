import { requireUser } from '../../../../../lib/agent/server/auth';
import { json, fail } from '../../../../../lib/agent/server/http';
import { getRun } from '../../../../../lib/agent/server/store';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { db, user } = await requireUser(request);
    return json(await getRun(db, user.id, (await context.params).id));
  } catch (error) {
    return fail(error);
  }
}
