import type { EarthquakesResponse } from './types';

/**
 * Remembers the last live USGS response in this browser so the app opens with
 * data instantly and still shows something (clearly labelled) when every
 * source is unreachable. localStorage can be unavailable or full (private
 * mode, quota), so every access is wrapped and the app works without it.
 */
const KEY = 'seismo-globe:last-usgs:v1';
const MAX_CHARS = 1_500_000; // stay well under the ~5 MB quota; skip huge periods
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

interface Saved {
  key: string;
  savedAt: number;
  data: EarthquakesResponse;
}

const keyFor = (period: string, minMag: number) => `${period}_${minMag}`;

function looksLikeQuake(q: any): boolean {
  return (
    q &&
    typeof q.id === 'string' &&
    typeof q.lat === 'number' &&
    typeof q.lng === 'number' &&
    typeof q.time === 'number' &&
    typeof q.source === 'string'
  );
}

/** Only live (non-stale) data is saved, so a backup is never remembered as if it were USGS. */
export function saveLastQuakes(period: string, minMag: number, data: EarthquakesResponse): void {
  try {
    if (data.stale) return;
    const text = JSON.stringify({ key: keyFor(period, minMag), savedAt: Date.now(), data } satisfies Saved);
    if (text.length > MAX_CHARS) return;
    localStorage.setItem(KEY, text);
  } catch {
    /* unavailable or over quota: nothing to do */
  }
}

export function loadLastQuakes(period: string, minMag: number): { data: EarthquakesResponse; savedAt: number } | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<Saved>;
    if (saved.key !== keyFor(period, minMag) || typeof saved.savedAt !== 'number') return null;
    if (Date.now() - saved.savedAt > MAX_AGE_MS) return null;
    const data = saved.data;
    if (!data || !Array.isArray(data.quakes) || !data.quakes.every(looksLikeQuake)) return null;
    return { data, savedAt: saved.savedAt };
  } catch {
    return null;
  }
}
