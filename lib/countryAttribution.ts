import { coverBoxes, getBbox, pointInPolygonRings } from './geo';

/**
 * Which country does an earthquake belong to?
 *
 * A rectangle around a country also holds its neighbours and the open sea, so
 * counting "what falls inside the box" over-counts. The rule used instead is:
 *
 *   1. an epicentre inside a country's territory belongs to that country;
 *   2. one that is not inside any country (i.e. at sea) belongs to the NEAREST
 *      country, provided its coast is at most `OFFSHORE_KM` away;
 *   3. anything farther (open ocean, mid-ocean ridges) belongs to no country.
 *
 * Every event therefore has at most one country, and a country's total adds up
 * with the rest of the world. Subduction-zone quakes, which are mostly offshore,
 * are kept for the country they threaten. Accuracy is bounded by the map data
 * (Natural Earth 1:50m): borders and coasts are simplified by a few kilometres.
 */
export const OFFSHORE_KM = 200;

const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LNG = 111.32; // at the equator
const RAD = Math.PI / 180;

type Ring = [number, number][];
type Box = [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]

interface Part {
  bbox: Box;
  rings: Ring[]; // rings[0] is the outer ring, the rest are holes
}

export interface CountryEntry {
  id: string;
  name: string;
  geometry: any;
  parts: Part[];
}

export interface CountryIndex {
  entries: CountryEntry[];
  byId: Map<string, CountryEntry>;
  parts: { entry: CountryEntry; part: Part }[];
}

/** world-atlas ids are ISO 3166-1 numeric strings ("170"); a few disputed territories have none. */
export function countryIdOf(feature: any): string {
  return feature?.id !== undefined && feature?.id !== null ? String(feature.id) : `n:${feature?.properties?.name ?? '?'}`;
}

function polygonsOf(geometry: any): Ring[][] {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

/**
 * Natural Earth draws shapes that straddle the antimeridian as ONE ring that jumps
 * from lng 180 to -180 (Fiji's Taveuni, parts of Russia). Read as flat coordinates,
 * such a ring is a sliver spanning the whole map. This lays the ring out
 * continuously (e.g. 179.9 .. 180.1); the caller also keeps a copy shifted by
 * 360 degrees so points on either side of the line find the shape.
 * Returns null when the ring has no jump, or when it circles a pole (Antarctica),
 * which is already correct in flat coordinates.
 */
function unwrapRing(ring: Ring): Ring | null {
  let jumps = false;
  for (let i = 1; i < ring.length; i++) {
    if (Math.abs(ring[i][0] - ring[i - 1][0]) > 180) {
      jumps = true;
      break;
    }
  }
  if (!jumps) return null;
  const out: Ring = [[ring[0][0], ring[0][1]]];
  let offset = 0;
  for (let i = 1; i < ring.length; i++) {
    const dx = ring[i][0] - ring[i - 1][0];
    if (dx > 180) offset -= 360;
    else if (dx < -180) offset += 360;
    out.push([ring[i][0] + offset, ring[i][1]]);
  }
  return Math.abs(offset) > 1e-9 ? null : out; // a net drift means the ring goes around a pole
}

function shiftRing(ring: Ring, dx: number): Ring {
  return ring.map(([x, y]) => [x + dx, y]);
}

/** The flat polygons that stand for one real polygon: itself, or the unwrapped ring plus its 360-degree twin. */
function flatPolygons(rings: Ring[]): Ring[][] {
  const outer = unwrapRing(rings[0]);
  if (!outer) return [rings];
  const mid = (outer.reduce((m, p) => Math.min(m, p[0]), Infinity) + outer.reduce((m, p) => Math.max(m, p[0]), -Infinity)) / 2;
  const holes = rings.slice(1).map((h) => {
    const u = unwrapRing(h) ?? h;
    const hMid = u.reduce((a, p) => a + p[0], 0) / Math.max(1, u.length);
    return shiftRing(u, Math.round((mid - hMid) / 360) * 360);
  });
  const base = [outer, ...holes];
  const xs = outer.map((p) => p[0]);
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const out = [base];
  if (hi > 180) out.push(base.map((r) => shiftRing(r, -360)));
  if (lo < -180) out.push(base.map((r) => shiftRing(r, 360)));
  return out;
}

export function buildCountryIndex(features: any[]): CountryIndex {
  const entries: CountryEntry[] = [];
  const byId = new Map<string, CountryEntry>();
  const parts: { entry: CountryEntry; part: Part }[] = [];
  for (const f of features) {
    const polys = polygonsOf(f?.geometry);
    if (polys.length === 0) continue;
    const flat = polys.flatMap((rings) => (rings[0] && rings[0].length >= 3 ? flatPolygons(rings) : []));
    if (flat.length === 0) continue;
    const entry: CountryEntry = {
      id: countryIdOf(f),
      name: f.properties?.name ?? '',
      geometry: { type: 'MultiPolygon', coordinates: flat }, // sliver-free, for covering with query rectangles
      parts: [],
    };
    for (const rings of flat) {
      const bbox = getBbox({ type: 'Polygon', coordinates: rings });
      if (!bbox) continue;
      const part: Part = { bbox, rings };
      entry.parts.push(part);
      parts.push({ entry, part });
    }
    entries.push(entry);
    byId.set(entry.id, entry);
  }
  return { entries, byId, parts };
}

// ------------------------------------------------------------------ distances

/** Smallest difference between two longitudes, in degrees (0..180). */
function lngGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Signed longitude difference b - a folded into [-180, 180]. */
function lngDelta(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  return d;
}

/** Could the point be within `maxKm` of this part? Cheap test on its bounding box, antimeridian-aware. */
function nearBox(lng: number, lat: number, b: Box, maxKm: number): boolean {
  const latMargin = maxKm / KM_PER_DEG_LAT;
  if (lat < b[1] - latMargin || lat > b[3] + latMargin) return false;
  const lngMargin = Math.min(180, latMargin / Math.max(Math.cos(lat * RAD), 0.05));
  if (lng >= b[0] && lng <= b[2]) return true;
  return Math.min(lngGap(lng, b[0]), lngGap(lng, b[2])) <= lngMargin;
}

function distToRingKm(lng: number, lat: number, ring: Ring, k: number): number {
  let best = Infinity;
  const kx = k * KM_PER_DEG_LNG;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    // Edges spanning the map (the cut along the antimeridian, the Antarctic rim) are not coastline.
    if (Math.abs(b[0] - a[0]) > 180) continue;
    const ax = lngDelta(lng, a[0]) * kx;
    const ay = (a[1] - lat) * KM_PER_DEG_LAT;
    const bx = lngDelta(lng, b[0]) * kx;
    const by = (b[1] - lat) * KM_PER_DEG_LAT;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const px = ax + t * dx;
    const py = ay + t * dy;
    const d = Math.sqrt(px * px + py * py);
    if (d < best) best = d;
  }
  return best;
}

// ----------------------------------------------------------------- attribution

/** Id of the country the point belongs to under the rule above, or null. */
export function countryOf(index: CountryIndex, lng: number, lat: number, maxKm: number = OFFSHORE_KM): string | null {
  for (const { entry, part } of index.parts) {
    const b = part.bbox;
    if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
    if (pointInPolygonRings(lng, lat, part.rings)) return entry.id;
  }
  const k = Math.max(Math.cos(lat * RAD), 0.01);
  let bestId: string | null = null;
  let bestKm = maxKm;
  for (const { entry, part } of index.parts) {
    if (!nearBox(lng, lat, part.bbox, bestKm)) continue;
    for (const ring of part.rings) {
      const d = distToRingKm(lng, lat, ring, k);
      if (d <= bestKm) {
        bestKm = d;
        bestId = entry.id;
      }
    }
  }
  return bestId;
}

// -------------------------------------------------------- USGS query rectangles

/**
 * Rectangles to ask the USGS for so that every event this country could own is
 * included: a tight cover of its territory, widened by the offshore distance.
 * (The events are then filtered with `countryOf`, so the rectangles only need
 * to be a superset.) Rectangles that would cross the antimeridian are split.
 */
export function queryBoxesFor(entry: CountryEntry, maxKm: number = OFFSHORE_KM): Box[] {
  let base: Box[] | null = null;
  for (const cell of [3, 5, 10, 20]) {
    base = coverBoxes(entry.geometry, cell, 24);
    if (base) break;
  }
  if (!base) {
    const bb = getBbox(entry.geometry);
    base = bb ? [bb] : [];
  }
  const padLat = maxKm / KM_PER_DEG_LAT + 0.3;
  const out: Box[] = [];
  for (const [x0, y0, x1, y1] of base) {
    const minLat = Math.max(-90, y0 - padLat);
    const maxLat = Math.min(90, y1 + padLat);
    const widest = Math.max(Math.abs(minLat), Math.abs(maxLat));
    const padLng = Math.min(40, padLat / Math.max(Math.cos(Math.min(widest, 85) * RAD), 0.1));
    const minLng = x0 - padLng;
    const maxLng = x1 + padLng;
    if (minLng < -180) {
      out.push([-180, minLat, Math.min(180, maxLng), maxLat]);
      out.push([Math.max(-180, 360 + minLng), minLat, 180, maxLat]);
    } else if (maxLng > 180) {
      out.push([Math.max(-180, minLng), minLat, 180, maxLat]);
      out.push([-180, minLat, Math.min(180, maxLng - 360), maxLat]);
    } else {
      out.push([minLng, minLat, maxLng, maxLat]);
    }
  }
  return out;
}
