import { bindings, authMissing } from '../../../../lib/agent/server/env';
import { createAuth } from '../../../../lib/agent/server/auth';
import { json, fail } from '../../../../lib/agent/server/http';
import { usage } from '../../../../lib/agent/server/store';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const env = await bindings(),
      missing = authMissing(env);
    if (missing.length)
      return json({ configured: false, user: null, missing, usage: null });
    const session = await createAuth(env).api.getSession({
      headers: request.headers,
    });
    return json({
      configured: true,
      user: session
        ? {
            id: session.user.id,
            name: session.user.name,
            email: session.user.email,
          }
        : null,
      missing: [],
      usage: session ? await usage(env.AGENT_DB!, session.user.id) : null,
    });
  } catch (error) {
    return fail(error);
  }
}
