import { ApiError } from './http';
export type Bindings = Record<string, unknown> & {
  AGENT_DB?: D1Database;
  GALLERY_DB?: D1Database;
  ASSETS?: { fetch: typeof fetch };
};
export async function bindings(): Promise<Bindings> {
  try {
    const runtime = await import('cloudflare:workers');
    return runtime.env as Bindings;
  } catch {
    return {};
  }
}
export function setting(env: Bindings, name: string): string {
  const value = env[name] ?? process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}
export function requireDatabase(env: Bindings): D1Database {
  const db = env.AGENT_DB;
  if (!db)
    throw new ApiError(
      503,
      'not_configured',
      '개인 설계 저장소가 연결되지 않았습니다.',
    );
  return db;
}
export function authMissing(env: Bindings): string[] {
  return [
    ...(!env.AGENT_DB ? ['AGENT_DB'] : []),
    ...[
      'APP_BASE_URL',
      'BETTER_AUTH_SECRET',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
    ].filter((name) => !setting(env, name)),
  ];
}
