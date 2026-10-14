/**
 * Fetches JSON trying each URL in order: the app's own copy first (served from
 * the same origin, see scripts/fetch-assets.mjs), then public CDNs. A URL
 * "fails" on a network error, a timeout, a non-2xx status, or a body that is
 * not JSON (e.g. an HTML 404 page), and the next one is tried.
 */
export async function fetchJsonFirst<T = any>(urls: readonly string[], timeoutMs = 12000): Promise<T> {
  let lastError: unknown = new Error('No hay URLs para cargar');
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`${url} respondió ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}
