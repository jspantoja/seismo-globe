import type { EarthquakesResponse, QuakeFeature, SourceMeta } from './types';
import { getEmscCatalog } from './emsc';

export type Period = 'hour' | 'day' | 'week' | 'month';

const VALID_PERIODS: Period[] = ['hour', 'day', 'week', 'month'];

function magKeyFor(minMag: number): '1.0' | '2.5' | '4.5' | 'all' {
  if (minMag >= 4.5) return '4.5';
  if (minMag >= 2.5) return '2.5';
  if (minMag >= 1.0) return '1.0';
  return 'all';
}

export function parsePeriod(raw: string | null): Period {
  if (raw && (VALID_PERIODS as string[]).includes(raw)) return raw as Period;
  return 'day';
}

export function parseMinMag(raw: string | null): number {
  const n = raw ? Number(raw) : 0;
  if (Number.isNaN(n) || n < 0) return 0;
  return n;
}

export const USGS_SOURCE: SourceMeta = {
  name: 'USGS Earthquake Hazards Program',
  url: 'https://earthquake.usgs.gov/earthquakes/feed/',
  license: 'Dominio público (gobierno de EE. UU.)',
  fetchedAt: '',
};

const lastGood = new Map<string, EarthquakesResponse>();

function feedUrl(period: Period, minMag: number): string {
  const magKey = magKeyFor(minMag);
  return `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${magKey}_${period}.geojson`;
}

function mapFeature(f: any): QuakeFeature | null {
  const geom = f?.geometry?.coordinates;
  const p = f?.properties;
  if (!geom || geom.length < 2 || !p) return null;
  const [lng, lat, depthKm] = geom;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  return {
    id: f.id,
    mag: typeof p.mag === 'number' ? p.mag : null,
    magType: p.magType ?? null,
    place: p.place ?? null,
    time: p.time,
    updated: p.updated,
    url: p.url,
    detailUrl: p.detail,
    felt: typeof p.felt === 'number' ? p.felt : null,
    tsunami: p.tsunami ?? 0,
    alert: p.alert ?? null,
    status: p.status ?? 'automatic',
    sig: typeof p.sig === 'number' ? p.sig : null,
    depthKm: typeof depthKm === 'number' ? depthKm : null,
    lat,
    lng,
    source: 'USGS',
  };
}

export async function getEarthquakes(period: Period, minMag: number): Promise<EarthquakesResponse> {
  const cacheKey = `${magKeyFor(minMag)}_${period}`;
  const url = feedUrl(period, minMag);

  try {
    const res = await fetch(url, {
      next: { revalidate: 45 },
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'seismo-globe (educational, contact via project page)' },
    });

    if (!res.ok) throw new Error(`USGS respondió ${res.status}`);

    const geojson = await res.json();
    const quakes = (geojson.features ?? [])
      .map(mapFeature)
      .filter((q: QuakeFeature | null): q is QuakeFeature => q !== null)
      .sort((a: QuakeFeature, b: QuakeFeature) => b.time - a.time);

    const payload: EarthquakesResponse = {
      quakes,
      source: { ...USGS_SOURCE, fetchedAt: new Date().toISOString() },
      stale: false,
      period,
      minMagnitude: minMag,
      count: quakes.length,
    };

    lastGood.set(cacheKey, payload);
    return payload;
  } catch (err) {
    const cached = lastGood.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        stale: true,
        staleReason: err instanceof Error ? err.message : 'Fuente no disponible',
      };
    }

    // No cached copy (e.g. a cold start while USGS is down): rather than show
    // nothing, fall back to the EMSC catalogue. It is clearly labelled as a
    // backup (stale + staleReason, source "EMSC-CAT") and never cached as USGS.
    const reason = err instanceof Error ? err.message : 'error desconocido';
    try {
      const backup = await getEmscCatalog(period, minMag);
      return {
        ...backup,
        stale: true,
        staleReason: `USGS no responde (${reason}); mostrando el catálogo del EMSC como respaldo`,
      };
    } catch (backupErr) {
      const backupReason = backupErr instanceof Error ? backupErr.message : 'error desconocido';
      throw new Error(
        `No se pudo contactar al USGS (${reason}) ni al catálogo de respaldo del EMSC (${backupReason}), y aún no hay datos en caché`
      );
    }
  }
}
