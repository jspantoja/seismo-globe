/**
 * Administrative subdivisions (states/provinces/departments) for every
 * country, sourced from the Natural Earth "admin-1" dataset via the
 * well-established `datasets/geo-ne-admin1` mirror (CORS-enabled, verified
 * live — confirmed this is the full global set: 4,589 regions across 251
 * countries, e.g. Colombia's real 33 departments, not a partial sample).
 *
 * The raw file is ~43MB with ~100 properties per feature, so instead of
 * shipping it to the browser we fetch+cache it ONCE here on the server,
 * then filter to the requested country and simplify its geometry (rounded
 * coordinates + Douglas-Peucker) before responding — the browser only ever
 * receives a small, country-sized payload (a few KB to a few hundred KB for
 * the largest countries).
 */

const SOURCE_URL = 'https://raw.githubusercontent.com/datasets/geo-ne-admin1/main/data/admin1.geojson';
const DECIMALS = 3; // ~110m
const TOLERANCE_DEG = 0.02; // ~2.2km — generalizes well at globe scale without losing small territories

type Ring = [number, number][];

interface RawFeature {
  type: 'Feature';
  properties: Record<string, any>;
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: any };
}

export interface SubdivisionFeature {
  type: 'Feature';
  properties: { name: string; type: string | null };
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: any };
}

let datasetPromise: Promise<RawFeature[]> | null = null;

async function getRawDataset(): Promise<RawFeature[]> {
  if (!datasetPromise) {
    datasetPromise = fetch(SOURCE_URL, {
      // ~60MB: far above the 2MB Next data-cache item limit, so don't try to
      // use it. Reuse comes from the module-level promise below plus the
      // per-country memo and the CDN cache headers set by the route.
      cache: 'no-store',
      signal: AbortSignal.timeout(45000),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Fuente de divisiones respondió ${res.status}`);
        return res.json();
      })
      .then((fc) => fc.features as RawFeature[])
      .catch((err) => {
        datasetPromise = null; // allow retry on next request instead of caching a failure forever
        throw err;
      });
  }
  return datasetPromise;
}

function round(n: number): number {
  return Math.round(n * 10 ** DECIMALS) / 10 ** DECIMALS;
}

function sqSegDist(p: [number, number], p1: [number, number], p2: [number, number]): number {
  let [x, y] = p1;
  let dx = p2[0] - x;
  let dy = p2[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = p2[0];
      y = p2[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

function simplifyDP(pts: Ring, first: number, last: number, sqTol: number, out: Ring) {
  let maxDist = sqTol;
  let index = -1;
  for (let i = first + 1; i < last; i++) {
    const d = sqSegDist(pts[i], pts[first], pts[last]);
    if (d > maxDist) {
      index = i;
      maxDist = d;
    }
  }
  if (index > -1) {
    if (index - first > 1) simplifyDP(pts, first, index, sqTol, out);
    out.push(pts[index]);
    if (last - index > 1) simplifyDP(pts, index, last, sqTol, out);
  }
}

function simplify(points: Ring, tolerance: number): Ring {
  if (points.length <= 2) return points;
  const out: Ring = [points[0]];
  simplifyDP(points, 0, points.length - 1, tolerance * tolerance, out);
  out.push(points[points.length - 1]);
  return out;
}

function dedupe(ring: Ring): Ring {
  const out: Ring = [];
  for (const p of ring) {
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) out.push(p);
  }
  if (out.length > 2) {
    const f = out[0];
    const l = out[out.length - 1];
    if (f[0] !== l[0] || f[1] !== l[1]) out.push(f);
  }
  return out;
}

function processRing(ring: Ring): Ring | null {
  const rounded = ring.map(([x, y]) => [round(x), round(y)] as [number, number]);
  const simplified = dedupe(simplify(rounded, TOLERANCE_DEG));
  // Never let simplification collapse a real ring below a usable shape.
  if (simplified.length < 4) {
    const fallback = dedupe(rounded);
    return fallback.length >= 4 ? fallback : null;
  }
  return simplified;
}

/**
 * Signed planar area of a ring (shoelace, x=lng, y=lat). Negative = clockwise.
 */
function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return sum / 2;
}

/**
 * The globe renderer (three-globe, via d3-geo) interprets ring winding on the
 * sphere: exterior rings must be clockwise and holes counter-clockwise, and a
 * ring wound the other way is read as "everything EXCEPT this polygon" — which
 * paints the whole planet. A couple of source rings (e.g. in Alaska/Florida)
 * come out the wrong way (originally or after simplification), so every ring
 * is normalised here.
 */
function orient(ring: Ring, clockwise: boolean): Ring {
  const isClockwise = signedArea(ring) < 0;
  return isClockwise === clockwise ? ring : [...ring].reverse();
}

function processPolygonRings(rings: Ring[]): Ring[] {
  const processed = rings.map(processRing).filter((r): r is Ring => r !== null);
  if (processed.length === 0) return [];
  // The first ring is the exterior; the rest are holes.
  return processed.map((r, i) => orient(r, i === 0));
}

function processGeometry(geom: RawFeature['geometry']): SubdivisionFeature['geometry'] | null {
  if (geom.type === 'Polygon') {
    const rings = processPolygonRings(geom.coordinates as Ring[]);
    return rings.length ? { type: 'Polygon', coordinates: rings } : null;
  }
  if (geom.type === 'MultiPolygon') {
    const polys = (geom.coordinates as Ring[][]).map(processPolygonRings).filter((poly) => poly.length > 0);
    return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
  }
  return null;
}

const countryMemo = new Map<string, SubdivisionFeature[]>();

export async function getSubdivisionsForCountry(iso3: string): Promise<SubdivisionFeature[]> {
  // Antarctica's single "region" wraps the antimeridian and the pole; the
  // globe draws no country outline for it either, so there's nothing to show.
  if (iso3 === 'ATA') return [];
  const memo = countryMemo.get(iso3);
  if (memo) return memo;
  const all = await getRawDataset();
  const out: SubdivisionFeature[] = [];
  for (const f of all) {
    if (f.properties.adm0_a3 !== iso3) continue;
    const name = f.properties.name;
    if (!name) continue;
    const geometry = processGeometry(f.geometry);
    if (!geometry) continue;
    out.push({ type: 'Feature', properties: { name, type: f.properties.type_en ?? f.properties.type ?? null }, geometry });
  }
  countryMemo.set(iso3, out);
  return out;
}
