/** Canonical identity is independent of affiliate redirects and tracking parameters. */
export function canonicalProductLink(value: unknown, productId?: string): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/(^|\.)aliexpress\.com$/i.test(url.hostname)
      || url.username || url.password || url.port) return null;
    const match = url.pathname.match(/^\/item\/(?:[^/]+\/)?(\d{1,20})\.html$/);
    if (!match || (productId && match[1] !== productId)) return null;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch { return null; }
}

/** Only provider-returned HTTPS AliExpress promotion URLs may become purchase links. */
export function affiliatePromotionLink(value: unknown, productId?: string): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    if (url.hostname === 's.click.aliexpress.com' && /^\/e\/[A-Za-z0-9_-]+$/.test(url.pathname)) return url.href;
    // Some responses use a directly tracked item link. Its identity must agree.
    return productId && canonicalProductLink(value, productId) && url.search ? url.href : null;
  } catch { return null; }
}
