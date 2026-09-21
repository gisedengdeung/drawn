export type PartsConfig = {
  appKey: string;
  appSecret: string;
  trackingId: string;
  accessToken: string;
  dsEnabled?: boolean;
  gateway: string;
  openaiKey: string;
  openaiModel: string;
};

export function getPartsConfig(env: Record<string, string | undefined> = process.env): PartsConfig {
  return {
    appKey: env.ALIEXPRESS_APP_KEY?.trim() ?? '',
    appSecret: env.ALIEXPRESS_APP_SECRET?.trim() ?? '',
    trackingId: env.ALIEXPRESS_TRACKING_ID?.trim() ?? '',
    accessToken: env.ALIEXPRESS_ACCESS_TOKEN?.trim() ?? '',
    dsEnabled: env.ALIEXPRESS_DS_ENABLED === 'true',
    // A deployment setting, never an arbitrary URL supplied by a request.
    // Apps created at openservice.aliexpress.com use IOP; TOP is legacy opt-in.
    gateway: env.ALIEXPRESS_API_PROTOCOL === 'TOP'
      ? (env.ALIEXPRESS_TOP_REGION === 'US'
        ? 'https://api.taobao.com/router/rest'
        : 'https://eco.taobao.com/router/rest')
      : 'https://api-sg.aliexpress.com/sync',
    openaiKey: env.OPENAI_API_KEY?.trim() ?? '',
    openaiModel: env.PARTS_OPENAI_MODEL?.trim() || 'gpt-5-mini',
  };
}
