import { geometriesLikelyIntersect } from './geo';
import { fetchJsonFirst } from './assets';

// Public, free, no-key sources — fetched on demand, only when a country is selected.
// The app's own copy (copied in at build time) goes first; the pinned GitHub commit is the fallback.
const ISO_TABLE_URLS = [
  '/data/iso-3166.json',
  'https://raw.githubusercontent.com/lukes/ISO-3166-Countries-with-Regional-Codes/145f1ad3caff212ed25f42b0ee2c8b92a75af895/all/all.json',
];

interface IsoRow {
  name: string;
  'alpha-2': string;
  'alpha-3': string;
  'country-code': string;
}

let isoTablePromise: Promise<IsoRow[]> | null = null;

/** Fetches (once, cached) the ISO 3166 table mapping numeric codes to alpha-2/alpha-3. */
function getIsoTable(): Promise<IsoRow[]> {
  if (!isoTablePromise) {
    isoTablePromise = fetchJsonFirst<IsoRow[]>(ISO_TABLE_URLS).catch(() => {
      // Do not remember a failure: the next country pick retries instead of
      // leaving flags and subdivisions broken for the rest of the session.
      isoTablePromise = null;
      return [] as IsoRow[];
    });
  }
  return isoTablePromise;
}

export interface IsoCodes {
  alpha2: string;
  alpha3: string;
}

/** world-atlas topojson ids are ISO 3166-1 numeric, zero-padded to 3 digits as a string. */
export async function resolveIsoCodes(numericId: string): Promise<IsoCodes | null> {
  const table = await getIsoTable();
  const padded = numericId.padStart(3, '0');
  const row = table.find((r) => r['country-code'] === padded);
  if (!row) return null;
  return { alpha2: row['alpha-2'], alpha3: row['alpha-3'] };
}

export function flagEmoji(alpha2: string): string {
  if (!/^[A-Z]{2}$/i.test(alpha2)) return '';
  const codePoints = alpha2
    .toUpperCase()
    .split('')
    .map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65));
  return String.fromCodePoint(...codePoints);
}

export interface SubdivisionsResult {
  features: any[];
  unavailable: boolean;
}

const subdivisionsCache = new Map<string, SubdivisionsResult>();

/**
 * Fetches ADM1 (states/provinces/departments) for a country from our own
 * /api/subdivisions route, which serves pre-simplified geometry derived
 * from the Natural Earth admin-1 dataset (see lib/subdivisions.ts for why
 * this is done server-side rather than via a client-side third-party call).
 * Gracefully returns { unavailable: true } for territories without data
 * instead of throwing, since that's an expected case for small countries.
 */
export async function getSubdivisions(iso3: string): Promise<SubdivisionsResult> {
  const cached = subdivisionsCache.get(iso3);
  if (cached) return cached;

  try {
    const res = await fetch(`/api/subdivisions?iso3=${iso3}`, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`subdivisions route respondió ${res.status}`);
    const data = await res.json();
    const result: SubdivisionsResult = {
      features: data.features ?? [],
      unavailable: !!data.unavailable || !data.features || data.features.length === 0,
    };
    subdivisionsCache.set(iso3, result);
    return result;
  } catch {
    const result: SubdivisionsResult = { features: [], unavailable: true };
    subdivisionsCache.set(iso3, result);
    return result;
  }
}

/** Returns the names of tectonic plates/microplates whose polygon likely overlaps the given country geometry. */
export function findIntersectingPlates(countryGeometry: any, plateFeatures: any[]): string[] {
  const names = new Set<string>(); // a plate split at the antimeridian has two features
  for (const plate of plateFeatures) {
    if (geometriesLikelyIntersect(countryGeometry, plate.geometry)) {
      names.add(plate.properties?.PlateName ?? plate.properties?.Code ?? 'Desconocida');
    }
  }
  return [...names];
}
