import { requireUser } from '../../../../../../lib/agent/server/auth';
import {
  json,
  fail,
  sameOrigin,
} from '../../../../../../lib/agent/server/http';
import { cancelRun } from '../../../../../../lib/agent/server/store';
export const dynamic = 'force-dynamic';
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    sameOrigin(request);
    const { db, user } = await requireUser(request);
    await cancelRun(db, user.id, (await context.params).id);
    return json({ cancelled: true });
  } catch (error) {
    return fail(error);
  }
}
