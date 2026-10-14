import type { StatsResponse } from './types';

export type Bbox = [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]

export interface StatsRequest {
  minMag: number;
  years: number;
  bbox: Bbox | null;
  plateCode: string | null;
}

const CLIENT_TTL_MS = 10 * 60_000;
const CLIENT_CACHE_MAX = 40;
const cache = new Map<string, { at: number; data: StatsResponse }>();

/** Keeps a bbox inside the ranges the API accepts, or null if it degenerates. */
export function sanitizeBbox(b: Bbox | null): Bbox | null {
  if (!b) return null;
  const r = (n: number) => Math.round(n * 100) / 100;
  const minLng = Math.max(-180, r(b[0]));
  const minLat = Math.max(-90, r(b[1]));
  const maxLng = Math.min(180, r(b[2]));
  const maxLat = Math.min(90, r(b[3]));
  if (!(minLng < maxLng) || !(minLat < maxLat)) return null;
  return [minLng, minLat, maxLng, maxLat];
}

export function statsQueryString(req: StatsRequest): string {
  const sp = new URLSearchParams({ minmag: String(req.minMag), years: String(req.years) });
  if (req.plateCode) sp.set('plate', req.plateCode);
  else if (req.bbox) sp.set('bbox', req.bbox.join(','));
  return sp.toString();
}

export async function fetchStats(req: StatsRequest, signal?: AbortSignal): Promise<StatsResponse> {
  const qs = statsQueryString(req);
  const hit = cache.get(qs);
  if (hit && Date.now() - hit.at < CLIENT_TTL_MS) return hit.data;

  const res = await fetch(`/api/stats?${qs}`, { signal });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || typeof json !== 'object') {
    throw new Error(json?.message ?? `El servicio de estadísticas respondió ${res.status}.`);
  }
  cache.set(qs, { at: Date.now(), data: json as StatsResponse });
  if (cache.size > CLIENT_CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return json as StatsResponse;
}
