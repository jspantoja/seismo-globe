import { coverBoxes, getBbox, mergeToMultiPolygon, pointInGeometry } from './geo';
import type {
  SourceMeta,
  StatsBin,
  StatsLargest,
  StatsPoint,
  StatsPrecision,
  StatsRecurrence,
  StatsResponse,
} from './types';

/**
 * Historical earthquake statistics, computed on the server from the USGS
 * ComCat catalogue through its public FDSN Event web service
 * (https://earthquake.usgs.gov/fdsnws/event/1/ — public domain, no key).
 *
 * Strategy: ONE `count` request to learn how many events match the filters,
 * raising the magnitude threshold in 0.5 steps if the result would exceed the
 * service's 20,000-event cap (the response says so — never silently truncated),
 * then ONE CSV request with every event, from which all aggregates are built.
 * Results are cached in memory (and by the CDN, see the route's headers).
 */

const FDSN_BASE = process.env.USGS_FDSN_BASE || 'https://earthquake.usgs.gov/fdsnws/event/1';
const PLATES_URL = 'https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_plates.json';

const MAX_ALLOWED = 20000;
const BUMP_TRIGGER = 19000; // raise the threshold above this many matches
const BUMP_TARGET = 14000; // ...aiming to land comfortably below the cap
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 60;
const DAY_MS = 86_400_000;
const YEAR_MS = 365.25 * DAY_MS;

type BBox = [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]

export const STATS_SOURCE: SourceMeta = {
  name: 'USGS ComCat — FDSN Event Web Service',
  url: 'https://earthquake.usgs.gov/fdsnws/event/1/',
  license: 'Dominio público (gobierno de EE. UU.)',
  fetchedAt: '',
};

export class StatsError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

export interface StatsQuery {
  minMag: number;
  years: number;
  bbox: BBox | null;
  plateCode: string | null;
}

export function parseStatsQuery(sp: URLSearchParams): StatsQuery {
  const minMagRaw = Number(sp.get('minmag') ?? '4.5');
  if (!Number.isFinite(minMagRaw)) throw new StatsError(400, 'invalid_minmag', 'Magnitud mínima inválida.');
  const minMag = Math.min(8, Math.max(0, Math.round(minMagRaw * 10) / 10));

  const yearsRaw = Number(sp.get('years') ?? '10');
  if (!Number.isFinite(yearsRaw)) throw new StatsError(400, 'invalid_years', 'Número de años inválido.');
  const years = Math.min(50, Math.max(1, Math.round(yearsRaw)));

  let bbox: BBox | null = null;
  const bboxRaw = sp.get('bbox');
  if (bboxRaw) {
    const parts = bboxRaw.split(',').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      throw new StatsError(400, 'invalid_bbox', 'Región inválida (se esperan 4 números).');
    }
    const [minLng, minLat, maxLng, maxLat] = parts;
    if (minLng < -180 || maxLng > 180 || minLat < -90 || maxLat > 90 || minLng >= maxLng || minLat >= maxLat) {
      throw new StatsError(400, 'invalid_bbox', 'Región fuera de rango.');
    }
    bbox = [minLng, minLat, maxLng, maxLat].map((n) => Math.round(n * 1000) / 1000) as BBox;
  }

  let plateCode: string | null = null;
  const plateRaw = sp.get('plate');
  if (plateRaw) {
    if (!/^[A-Za-z0-9]{1,6}$/.test(plateRaw)) throw new StatsError(400, 'invalid_plate', 'Código de placa inválido.');
    plateCode = plateRaw.toUpperCase();
  }

  return { minMag, years, bbox, plateCode };
}

// ---------------------------------------------------------------- CSV parsing

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface QuakeRow {
  t: number;
  lat: number;
  lng: number;
  depth: number | null;
  mag: number;
  place: string | null;
  id: string;
  hErr: number | null;
  dErr: number | null;
  mErr: number | null;
  reviewed: boolean;
}

function num(s: string | undefined): number | null {
  if (s === undefined || s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseRows(csv: string): QuakeRow[] {
  if (!csv.trim()) return [];
  const table = parseCsv(csv);
  if (table.length === 0) return [];
  const header = table[0].map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const iTime = col('time');
  const iLat = col('latitude');
  const iLng = col('longitude');
  const iMag = col('mag');
  if (iTime < 0 || iLat < 0 || iLng < 0 || iMag < 0) {
    throw new StatsError(502, 'bad_upstream', 'El USGS devolvió un formato inesperado.');
  }
  const iDepth = col('depth');
  const iPlace = col('place');
  const iId = col('id');
  const iH = col('horizontalError');
  const iD = col('depthError');
  const iM = col('magError');
  const iStatus = col('status');

  const rows: QuakeRow[] = [];
  for (let r = 1; r < table.length; r++) {
    const f = table[r];
    const t = Date.parse(f[iTime] ?? '');
    const lat = num(f[iLat]);
    const lng = num(f[iLng]);
    const mag = num(f[iMag]);
    if (!Number.isFinite(t) || lat === null || lng === null || mag === null) continue;
    rows.push({
      t,
      lat,
      lng,
      mag,
      depth: iDepth >= 0 ? num(f[iDepth]) : null,
      place: iPlace >= 0 && f[iPlace] ? f[iPlace] : null,
      id: iId >= 0 ? f[iId] ?? '' : '',
      hErr: iH >= 0 ? num(f[iH]) : null,
      dErr: iD >= 0 ? num(f[iD]) : null,
      mErr: iM >= 0 ? num(f[iM]) : null,
      reviewed: iStatus >= 0 ? (f[iStatus] ?? '').trim().toLowerCase() === 'reviewed' : false,
    });
  }
  return rows;
}

// ---------------------------------------------------------------- aggregation

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

interface Acc {
  count: number;
  max: number;
}

function bump(map: Map<string, Acc>, key: string, mag: number) {
  const a = map.get(key);
  if (a) {
    a.count++;
    if (mag > a.max) a.max = mag;
  } else {
    map.set(key, { count: 1, max: mag });
  }
}

function toPoint(map: Map<string, Acc>, key: string, partial: boolean): StatsPoint {
  const a = map.get(key);
  return { key, count: a?.count ?? 0, maxMag: a ? round(a.max, 1) : null, partial };
}

export interface ComputeInput {
  rows: QuakeRow[];
  now: number;
  years: number;
  requestedMinMag: number;
  minMag: number;
  scope: 'world' | 'country' | 'plate';
  plateCode: string | null;
  bbox: BBox | null;
}

export function computeStats(input: ComputeInput): StatsResponse {
  const { rows, now, years, requestedMinMag, minMag, scope, plateCode, bbox } = input;
  const nowDate = new Date(now);
  const startYear = nowDate.getUTCFullYear() - (years - 1);
  const rangeStart = Date.UTC(startYear, 0, 1);
  const yearsElapsed = Math.max((now - rangeStart) / YEAR_MS, 1 / 365.25);

  const byYear = new Map<string, Acc>();
  const byMonth = new Map<string, Acc>();
  const byDay = new Map<string, Acc>();
  for (const r of rows) {
    const iso = new Date(r.t).toISOString();
    bump(byYear, iso.slice(0, 4), r.mag);
    bump(byMonth, iso.slice(0, 7), r.mag);
    bump(byDay, iso.slice(0, 10), r.mag);
  }

  // Year / month / day series — zero-filled so gaps are visible, UTC throughout.
  const currentYear = nowDate.getUTCFullYear();
  const yearly: StatsPoint[] = [];
  for (let y = startYear; y <= currentYear; y++) yearly.push(toPoint(byYear, String(y), y === currentYear));

  const monthly: StatsPoint[] = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() - i, 1));
    if (d.getTime() < rangeStart) continue;
    monthly.push(toPoint(byMonth, d.toISOString().slice(0, 7), i === 0));
  }

  const daily: StatsPoint[] = [];
  for (let i = 29; i >= 0; i--) {
    daily.push(toPoint(byDay, new Date(now - i * DAY_MS).toISOString().slice(0, 10), i === 0));
  }

  // Magnitude distribution in 0.5 bins, open-ended at the top.
  const lo = Math.floor(minMag * 2 + 1e-9) / 2;
  const hi = Math.max(7.5, lo);
  const nBins = Math.round((hi - lo) * 2) + 1;
  const magCounts = new Array<number>(nBins).fill(0);
  for (const r of rows) {
    if (r.mag < lo - 1e-9) continue;
    magCounts[Math.min(nBins - 1, Math.floor((r.mag - lo) * 2 + 1e-9))]++;
  }
  const magnitudeBins: StatsBin[] = magCounts.map((count, i) => {
    const a = lo + i * 0.5;
    return { label: i === nBins - 1 ? `${a.toFixed(1)}+` : `${a.toFixed(1)}–${(a + 0.4).toFixed(1)}`, count };
  });

  // Depth classes (km): shallow quakes release their energy closest to people.
  const depthDefs: { label: string; max: number }[] = [
    { label: 'Superficial (0–33 km)', max: 33 },
    { label: 'Somero (33–70 km)', max: 70 },
    { label: 'Intermedio (70–300 km)', max: 300 },
    { label: 'Profundo (300+ km)', max: Infinity },
  ];
  const depthCounts = depthDefs.map(() => 0);
  for (const r of rows) {
    if (r.depth === null) continue;
    const d = Math.max(0, r.depth);
    depthCounts[depthDefs.findIndex((def) => d < def.max)]++;
  }
  const depthBins: StatsBin[] = depthDefs.map((def, i) => ({ label: def.label, count: depthCounts[i] }));

  // Recurrence: how often events at or above a size occurred in the window.
  const thresholds = [...new Set([minMag, 5, 6, 7])].filter((t) => t >= minMag - 1e-9).sort((a, b) => a - b);
  const recurrence: StatsRecurrence[] = thresholds.map((t) => {
    const count = rows.filter((r) => r.mag >= t - 1e-9).length;
    return {
      minMag: t,
      count,
      perYear: round(count / yearsElapsed, 2),
      returnYears: count > 0 ? round(yearsElapsed / count, 2) : null,
    };
  });

  const largest: StatsLargest[] = [...rows]
    .sort((a, b) => b.mag - a.mag || b.t - a.t)
    .slice(0, 10)
    .map((r) => ({
      id: r.id,
      mag: round(r.mag, 1),
      place: r.place,
      time: r.t,
      depthKm: r.depth !== null ? round(r.depth, 1) : null,
      lat: r.lat,
      lng: r.lng,
      url: r.id ? `https://earthquake.usgs.gov/earthquakes/eventpage/${encodeURIComponent(r.id)}` : 'https://earthquake.usgs.gov/earthquakes/map/',
    }));

  const hErrs = rows.map((r) => r.hErr).filter((v): v is number => v !== null);
  const dErrs = rows.map((r) => r.dErr).filter((v): v is number => v !== null);
  const mErrs = rows.map((r) => r.mErr).filter((v): v is number => v !== null);
  const precision: StatsPrecision = {
    sample: rows.length,
    reviewedPct: rows.length ? round((rows.filter((r) => r.reviewed).length / rows.length) * 100, 1) : null,
    medianHorizontalErrorKm: hErrs.length ? round(median(hErrs)!, 2) : null,
    medianDepthErrorKm: dErrs.length ? round(median(dErrs)!, 2) : null,
    medianMagError: mErrs.length ? round(median(mErrs)!, 3) : null,
    withHorizontalError: hErrs.length,
    withDepthError: dErrs.length,
    withMagError: mErrs.length,
  };

  const total = rows.length;
  const perYear = round(total / yearsElapsed, 2);
  const last12Months = rows.filter((r) => now - r.t <= 365 * DAY_MS).length;
  const maxMag = total ? round(Math.max(...rows.map((r) => r.mag)), 1) : null;

  return {
    scope,
    plateCode,
    bbox,
    source: { ...STATS_SOURCE, fetchedAt: nowDate.toISOString() },
    range: { from: new Date(rangeStart).toISOString().slice(0, 10), to: nowDate.toISOString().slice(0, 10), years, yearsElapsed: round(yearsElapsed, 2) },
    requestedMinMag,
    minMag,
    adjusted: Math.abs(minMag - requestedMinMag) > 1e-9,
    total,
    perYear,
    maxMag,
    last12Months,
    vsAveragePct: perYear > 0 ? round((last12Months / perYear - 1) * 100, 0) : null,
    yearly,
    monthly,
    daily,
    magnitudeBins,
    depthBins,
    recurrence,
    largest,
    precision,
  };
}

// ---------------------------------------------------------------- USGS access

function usgsParams(minMag: number, starttime: string, bbox: BBox | null): Record<string, string> {
  const p: Record<string, string> = {
    starttime,
    minmagnitude: String(minMag),
    eventtype: 'earthquake',
  };
  if (bbox) {
    p.minlongitude = String(bbox[0]);
    p.minlatitude = String(bbox[1]);
    p.maxlongitude = String(bbox[2]);
    p.maxlatitude = String(bbox[3]);
  }
  return p;
}

const HEADERS = { 'User-Agent': 'seismo-globe (educational; statistics from the public USGS FDSN service)' };

async function usgsGet(path: string, params: Record<string, string>, timeoutMs: number): Promise<Response> {
  const url = `${FDSN_BASE}/${path}?${new URLSearchParams(params).toString()}`;
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs), headers: HEADERS });
  } catch (err) {
    throw new StatsError(503, 'upstream_unreachable', `No se pudo contactar al USGS (${err instanceof Error ? err.message : 'error de red'}).`);
  }
  if (!res.ok && res.status !== 204) {
    throw new StatsError(502, 'upstream_error', `El USGS respondió ${res.status}.`);
  }
  return res;
}

async function usgsCount(minMag: number, starttime: string, bbox: BBox | null): Promise<number> {
  const res = await usgsGet('count', { format: 'geojson', ...usgsParams(minMag, starttime, bbox) }, 15000);
  if (res.status === 204) return 0;
  const body = await res.json().catch(() => null);
  const n = Number(body?.count);
  if (!Number.isFinite(n)) throw new StatsError(502, 'bad_upstream', 'Respuesta de conteo inesperada del USGS.');
  return n;
}

async function usgsCsv(minMag: number, starttime: string, bbox: BBox | null): Promise<string> {
  const res = await usgsGet(
    'query',
    { format: 'csv', orderby: 'time-asc', limit: String(MAX_ALLOWED), ...usgsParams(minMag, starttime, bbox) },
    45000
  );
  return res.status === 204 ? '' : res.text();
}

let platesPromise: Promise<any[]> | null = null;

async function getPlates(): Promise<any[]> {
  if (!platesPromise) {
    platesPromise = fetch(PLATES_URL, { next: { revalidate: 60 * 60 * 24 * 7 }, signal: AbortSignal.timeout(15000) })
      .then((r) => {
        if (!r.ok) throw new Error(`plates ${r.status}`);
        return r.json();
      })
      .then((fc) => (fc.features ?? []) as any[])
      .catch((err) => {
        platesPromise = null;
        throw new StatsError(503, 'plates_unavailable', `No se pudieron cargar las placas (${err instanceof Error ? err.message : 'error'}).`);
      });
  }
  return platesPromise;
}

// ---------------------------------------------------------------- orchestration

interface CacheEntry {
  at: number;
  data: StatsResponse;
}
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<StatsResponse>>();

/** Runs `fn` over `items` with at most `limit` calls in flight, preserving order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const POOL = 5;

async function compute(query: StatsQuery): Promise<StatsResponse> {
  const now = Date.now();
  const startYear = new Date(now).getUTCFullYear() - (query.years - 1);
  const starttime = `${startYear}-01-01`;

  // Regions sent to the USGS (null = no spatial filter, i.e. the whole planet).
  let bbox = query.bbox;
  let regions: (BBox | null)[] = [query.bbox];
  let plateGeometry: any = null;
  if (query.plateCode) {
    // A plate can be split in several features (e.g. Kermadec across the antimeridian).
    const parts = (await getPlates()).filter((f) => String(f.properties?.Code ?? '').toUpperCase() === query.plateCode);
    if (parts.length === 0) throw new StatsError(404, 'unknown_plate', 'Placa desconocida.');
    plateGeometry = mergeToMultiPolygon(parts.map((f) => f.geometry));
    bbox = getBbox(plateGeometry);
    // Query only the rectangles that actually cover the plate: for huge plates the
    // plain bbox spans a whole latitude band of the planet.
    regions = coverBoxes(plateGeometry) ?? [bbox];
  }

  const countAll = async (mag: number) =>
    (await mapPool(regions, POOL, (r) => usgsCount(mag, starttime, r))).reduce((a, b) => a + b, 0);

  let minMag = query.minMag;
  let count = await countAll(minMag);
  for (let i = 0; i < 5 && count > BUMP_TRIGGER && minMag < 8; i++) {
    const step = Math.max(0.5, Math.ceil(Math.log10(count / BUMP_TARGET) * 2) / 2);
    minMag = Math.min(8, Math.round((minMag + step) * 10) / 10);
    count = await countAll(minMag);
  }
  if (count > MAX_ALLOWED) {
    throw new StatsError(502, 'too_many_events', 'Demasiados eventos para este filtro; sube la magnitud mínima.');
  }

  let rows: QuakeRow[] = [];
  if (count > 0) {
    const chunks = await mapPool(regions, POOL, async (r) => parseRows(await usgsCsv(minMag, starttime, r)));
    // Neighbouring rectangles share their edges: drop duplicates by event id.
    const seen = new Set<string>();
    for (const chunk of chunks) {
      for (const row of chunk) {
        if (row.id) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
        }
        rows.push(row);
      }
    }
    rows.sort((a, b) => a.t - b.t);
  }
  if (plateGeometry) rows = rows.filter((r) => pointInGeometry(r.lng, r.lat, plateGeometry));

  return computeStats({
    rows,
    now,
    years: query.years,
    requestedMinMag: query.minMag,
    minMag,
    scope: query.plateCode ? 'plate' : query.bbox ? 'country' : 'world',
    plateCode: query.plateCode,
    bbox,
  });
}

export async function getStats(query: StatsQuery): Promise<StatsResponse> {
  const key = JSON.stringify(query);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const pending = inflight.get(key);
  if (pending) return pending;

  const job = compute(query)
    .then((data) => {
      cache.set(key, { at: Date.now(), data });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
      return data;
    })
    .catch((err) => {
      // Serve the last good (even expired) answer rather than failing outright.
      if (hit) return hit.data;
      throw err;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}
