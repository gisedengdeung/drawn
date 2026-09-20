import { createAuth } from '../../../../lib/agent/server/auth';
import { bindings } from '../../../../lib/agent/server/env';
import { fail } from '../../../../lib/agent/server/http';
export const dynamic = 'force-dynamic';
async function handler(request: Request) {
  try {
    return await createAuth(await bindings()).handler(request);
  } catch (error) {
    return fail(error);
  }
}
export const GET = handler;
export const POST = handler;
