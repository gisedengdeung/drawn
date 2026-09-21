import { betterAuth } from 'better-auth';
import {
  authMissing,
  bindings,
  requireDatabase,
  setting,
  type Bindings,
} from './env';
import { ApiError } from './http';
export function createAuth(env: Bindings) {
  if (authMissing(env).length)
    throw new ApiError(
      503,
      'not_configured',
      'Google 로그인과 저장소 설정이 필요합니다.',
    );
  const baseURL = setting(env, 'APP_BASE_URL');
  return betterAuth({
    database: requireDatabase(env),
    baseURL,
    secret: setting(env, 'BETTER_AUTH_SECRET'),
    trustedOrigins: [baseURL],
    socialProviders: {
      google: {
        clientId: setting(env, 'GOOGLE_CLIENT_ID'),
        clientSecret: setting(env, 'GOOGLE_CLIENT_SECRET'),
      },
    },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 30 },
    advanced: { database: { generateId: () => crypto.randomUUID() } },
    logger: { level: 'error', disabled: true },
  });
}
export async function requireUser(request: Request) {
  const env = await bindings();
  const session = await createAuth(env).api.getSession({
    headers: request.headers,
  });
  if (!session)
    throw new ApiError(401, 'unauthorized', 'Google 로그인 후 이용해 주세요.');
  return { user: session.user, env, db: requireDatabase(env) };
}
