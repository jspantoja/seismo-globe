import type { EarthquakesResponse, QuakeFeature, SourceMeta } from './types';
import type { Period } from './usgs';

/**
 * EMSC — Euro-Mediterranean Seismological Centre: crowd-sourced felt reports
 * ("testimonies") collected on emsc-csem.org and the LastQuake app.
 *
 * Public web service, no key: https://www.seismicportal.eu/testimonies-ws/
 * OpenAPI: https://www.seismicportal.eu/testimonies-ws/api/openapi.json
 * Terms (from EMSC's llms.txt): data under CC BY 4.0 — cite "EMSC"; never cache
 * live data for more than 10 minutes; label parameters as preliminary; do not
 * use the number of testimonies as a proxy for damage.
 *
 * The response schema is only documented by example (and the example for
 * `format=json` and the GeoJSON one use different field names), so the parser
 * below accepts both shapes and `?debug=1` on the API route reports what the
 * live service actually returned.
 */
const TESTIMONIES_URL = 'https://www.seismicportal.eu/testimonies-ws/api/search';
const EVENT_PAGE = 'https://www.emsc-csem.org/Earthquake_information/earthquake.php?id=';
const REQUEST_HEADERS = { 'User-Agent': 'seismo-globe (educational; EMSC felt reports viewer)', Accept: 'application/json' };
const TIMEOUT_MS = 12000;
const LIMIT = 1000;

export const EMSC_SOURCE: SourceMeta = {
  name: 'EMSC — reportes ciudadanos «¿lo sentiste?» (Euro-Mediterranean Seismological Centre)',
  url: 'https://www.seismicportal.eu/testimonies-ws/',
  license:
    'CC BY 4.0 — atribución: EMSC. Testimonios recogidos en emsc-csem.org y la app LastQuake. Parámetros preliminares; el número de reportes no mide daños.',
  fetchedAt: '',
};

const PERIOD_MS: Record<Period, number> = {
  hour: 3.6e6,
  day: 8.64e7,
  week: 6.048e8,
  month: 2.628e9,
};

export class EmscShapeError extends Error {}

type Row = Record<string, any>;

function first(o: Row, ...keys: string[]): any {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Accepts "2026-02-22T16:57:45.650 UTC", ISO strings with/without Z, and epoch seconds/ms. */
export function parseEmscTime(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? (v > 1e12 ? v : v * 1000) : null;
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (s.toUpperCase().endsWith(' UTC')) s = `${s.slice(0, -4)}Z`;
  if (s.includes(' ') && !s.includes('T')) s = s.replace(' ', 'T');
  if (!/(Z|[+-]\d\d:?\d\d)$/.test(s)) s = `${s}Z`; // EMSC publishes UTC
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** Rows of the response, whatever the envelope: array, FeatureCollection, or {events|results|data|items}. */
function rowsOf(body: unknown): Row[] {
  if (Array.isArray(body)) return body as Row[];
  const o = body as Row | null;
  if (o && Array.isArray(o.features)) return o.features;
  for (const k of ['events', 'results', 'data', 'items']) if (o && Array.isArray(o[k])) return o[k];
  throw new EmscShapeError('Respuesta del EMSC con forma inesperada (no es una lista de eventos)');
}

export function mapEmscRow(raw: Row): QuakeFeature | null {
  if (!raw || typeof raw !== 'object') return null;
  // GeoJSON feature -> merge properties with geometry/id.
  const isFeature = raw.type === 'Feature';
  const r: Row = isFeature ? { ...(raw.properties ?? {}) } : raw;
  const coords: unknown[] | undefined = isFeature ? raw.geometry?.coordinates : undefined;

  const unid = String(first(r, 'ev_unid', 'unid', 'eventid', 'event_id') ?? (isFeature ? raw.id : raw.id) ?? '').trim();
  if (!unid) return null;

  const lat = toNum(first(r, 'ev_latitude', 'lat', 'latitude')) ?? (coords ? toNum(coords[1]) : null);
  const lng = toNum(first(r, 'ev_longitude', 'lon', 'lng', 'longitude')) ?? (coords ? toNum(coords[0]) : null);
  if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const time = parseEmscTime(first(r, 'ev_event_time', 'time', 'event_time'));
  if (time === null) return null;

  const reports = toNum(first(r, 'ev_nbtestimonies', 'feltreportCount', 'nbtestimonies', 'nvalues'));
  if (reports === null || reports < 1) return null; // an event in this service has at least one testimony

  const evid = first(r, 'ev_evid', 'source_id', 'evid');
  const depthRaw = toNum(first(r, 'ev_depth', 'depth')) ?? (coords && coords.length > 2 ? toNum(coords[2]) : null);
  const updated = parseEmscTime(first(r, 'ev_last_update', 'last_update', 'lastupdate')) ?? time;
  const pageUrl = evid !== undefined ? `${EVENT_PAGE}${encodeURIComponent(String(evid))}` : 'https://www.emsc-csem.org/Earthquake_information/';

  const region = first(r, 'ev_region', 'region', 'flynn_region');
  const magType = first(r, 'ev_mag_type', 'magtype');

  return {
    id: `emsc-${unid}`,
    mag: toNum(first(r, 'ev_mag_value', 'mag', 'magnitude')),
    magType: magType !== undefined ? String(magType) : null,
    place: region !== undefined ? String(region) : null,
    time,
    updated,
    url: pageUrl,
    detailUrl: '',
    felt: null, // `felt` is USGS' own "Did you feel it?" count; EMSC's lives in `citizen`
    tsunami: 0,
    alert: null,
    status: 'automatic', // EMSC marks these as preliminary
    sig: null,
    depthKm: depthRaw === null ? null : Math.abs(depthRaw),
    lat,
    lng,
    source: 'EMSC',
    intensity: null,
    citizen: { source: 'EMSC', reports: Math.round(reports), url: pageUrl, eventId: unid },
  };
}

export function parseTestimonies(body: unknown): QuakeFeature[] {
  const out: QuakeFeature[] = [];
  const seen = new Set<string>();
  for (const row of rowsOf(body)) {
    const q = mapEmscRow(row);
    if (q && !seen.has(q.id)) {
      seen.add(q.id);
      out.push(q);
    }
  }
  return out.sort((a, b) => b.time - a.time);
}

// ---------------------------------------------------------------------------
// EMSC seismic catalogue (FDSN event service) — plan B when USGS is down.
// Same publisher and terms as the testimonies above, but these are plain
// earthquake events (source "EMSC-CAT"), not citizen reports.
// ---------------------------------------------------------------------------
const CATALOG_URL = 'https://www.seismicportal.eu/fdsnws/event/1/query';
const CATALOG_LIMIT = 3000;

export const EMSC_CATALOG_SOURCE: SourceMeta = {
  name: 'EMSC — catálogo sísmico (respaldo; Euro-Mediterranean Seismological Centre)',
  url: 'https://www.seismicportal.eu/',
  license:
    'Atribución: EMSC. Datos preliminares, mostrados como respaldo porque el USGS no respondió. Cobertura global, más densa en Europa y el Mediterráneo.',
  fetchedAt: '',
};

export function mapCatalogRow(raw: Row): QuakeFeature | null {
  if (!raw || typeof raw !== 'object') return null;
  const isFeature = raw.type === 'Feature';
  const r: Row = isFeature ? { ...(raw.properties ?? {}) } : raw;
  const coords: unknown[] | undefined = isFeature ? raw.geometry?.coordinates : undefined;

  const unid = String(first(r, 'unid', 'ev_unid', 'eventid') ?? raw.id ?? '').trim();
  if (!unid) return null;

  const lat = toNum(first(r, 'lat', 'latitude')) ?? (coords ? toNum(coords[1]) : null);
  const lng = toNum(first(r, 'lon', 'lng', 'longitude')) ?? (coords ? toNum(coords[0]) : null);
  if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const time = parseEmscTime(first(r, 'time', 'event_time'));
  if (time === null) return null;

  const evid = first(r, 'source_id', 'evid');
  const pageUrl =
    evid !== undefined
      ? `${EVENT_PAGE}${encodeURIComponent(String(evid))}`
      : 'https://www.emsc-csem.org/Earthquake_information/';
  const depthRaw = toNum(first(r, 'depth')) ?? (coords && coords.length > 2 ? toNum(coords[2]) : null);
  const region = first(r, 'flynn_region', 'region', 'ev_region');
  const magType = first(r, 'magtype', 'mag_type');

  return {
    id: `emsc-${unid}`,
    mag: toNum(first(r, 'mag', 'magnitude')),
    magType: magType !== undefined ? String(magType) : null,
    place: region !== undefined ? String(region) : null,
    time,
    updated: parseEmscTime(first(r, 'lastupdate', 'last_update')) ?? time,
    url: pageUrl,
    detailUrl: '',
    felt: null,
    tsunami: 0,
    alert: null,
    status: 'automatic', // EMSC publishes these as preliminary
    sig: null,
    depthKm: depthRaw === null ? null : Math.abs(depthRaw),
    lat,
    lng,
    source: 'EMSC-CAT',
    intensity: null,
  };
}

export function parseCatalog(body: unknown): QuakeFeature[] {
  const out: QuakeFeature[] = [];
  const seen = new Set<string>();
  for (const row of rowsOf(body)) {
    const q = mapCatalogRow(row);
    if (q && !seen.has(q.id)) {
      seen.add(q.id);
      out.push(q);
    }
  }
  return out.sort((a, b) => b.time - a.time);
}

function buildCatalogUrl(period: Period, minMag: number): string {
  const p = new URLSearchParams({
    format: 'json',
    starttime: new Date(Date.now() - PERIOD_MS[period]).toISOString().slice(0, 19),
    orderby: 'time',
    limit: String(CATALOG_LIMIT),
  });
  if (minMag > 0) p.set('minmagnitude', String(minMag));
  return `${CATALOG_URL}?${p.toString()}`;
}

/** Backup catalogue for the whole world. Throws if the EMSC cannot be reached. */
export async function getEmscCatalog(period: Period, minMag: number): Promise<EarthquakesResponse> {
  const res = await fetch(buildCatalogUrl(period, minMag), {
    cache: 'no-store',
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let quakes: QuakeFeature[] = [];
  if (res.status !== 204) {
    if (!res.ok) throw new Error(`El EMSC respondió ${res.status}`);
    quakes = parseCatalog(await res.json());
  }
  return {
    quakes,
    source: { ...EMSC_CATALOG_SOURCE, fetchedAt: new Date().toISOString() },
    stale: false,
    period,
    minMagnitude: minMag,
    count: quakes.length,
  };
}

function buildUrl(period: Period, minMag: number): string {
  const p = new URLSearchParams({
    starttime: new Date(Date.now() - PERIOD_MS[period]).toISOString().slice(0, 19),
    orderby: 'time-desc',
    limit: String(LIMIT),
    format: 'json',
  });
  if (minMag > 0) p.set('minmagnitude', String(minMag));
  return `${TESTIMONIES_URL}?${p.toString()}`;
}

const lastGood = new Map<string, { fetchedAt: number; quakes: QuakeFeature[] }>();

export async function getEmscQuakes(period: Period, minMag: number): Promise<EarthquakesResponse> {
  const key = `${period}_${minMag}`;
  try {
    const res = await fetch(buildUrl(period, minMag), {
      cache: 'no-store',
      headers: REQUEST_HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let quakes: QuakeFeature[] = [];
    if (res.status !== 204) {
      if (!res.ok) throw new Error(`El EMSC respondió ${res.status}`);
      quakes = parseTestimonies(await res.json());
    }
    lastGood.set(key, { fetchedAt: Date.now(), quakes });
    return {
      quakes,
      source: { ...EMSC_SOURCE, fetchedAt: new Date().toISOString() },
      stale: false,
      period,
      minMagnitude: minMag,
      count: quakes.length,
    };
  } catch (err) {
    const cached = lastGood.get(key);
    if (cached) {
      return {
        quakes: cached.quakes,
        source: { ...EMSC_SOURCE, fetchedAt: new Date(cached.fetchedAt).toISOString() },
        stale: true,
        staleReason: err instanceof Error ? err.message : 'Fuente no disponible',
        period,
        minMagnitude: minMag,
        count: cached.quakes.length,
      };
    }
    throw new Error(`No se pudo contactar al EMSC y aún no hay datos en caché (${err instanceof Error ? err.message : 'error desconocido'})`);
  }
}

/** What the live service returned, for `?debug=1` (always HTTP 200). */
export function debugEmsc(period: Period, minMag: number) {
  return debugService(buildUrl(period, minMag), parseTestimonies);
}

export function debugEmscCatalog(period: Period, minMag: number) {
  return debugService(buildCatalogUrl(period, minMag), parseCatalog);
}

async function debugService(url: string, parse: (body: unknown) => QuakeFeature[]) {
  const started = Date.now();
  const report: Record<string, unknown> = { url, now: new Date().toISOString() };
  try {
    const res = await fetch(url, { cache: 'no-store', headers: REQUEST_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    report.status = res.status;
    report.contentType = res.headers.get('content-type');
    report.bytes = text.length;
    report.ms = Date.now() - started;
    report.bodyHead = text.slice(0, 400);
    if (res.ok && text.trim()) {
      const body = JSON.parse(text);
      report.topLevel = Array.isArray(body) ? 'array' : typeof body;
      report.topLevelKeys = Array.isArray(body) ? null : Object.keys(body ?? {}).slice(0, 20);
      const rows = rowsOf(body);
      report.rows = rows.length;
      const sample = rows[0] as Row | undefined;
      report.firstRowKeys = sample ? Object.keys(sample.type === 'Feature' ? { ...sample.properties, __geometry: 1 } : sample) : null;
      const parsed = parse(body);
      report.parsed = parsed.length;
      report.newestEvent = parsed[0] ? new Date(parsed[0].time).toISOString() : null;
      report.firstParsed = parsed[0] ?? null;
    }
  } catch (err) {
    report.error = err instanceof Error ? err.message : 'error desconocido';
    report.ms = Date.now() - started;
  }
  return report;
}
