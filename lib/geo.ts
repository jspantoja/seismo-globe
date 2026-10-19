import type { BoundaryPath } from './types';

type LineGeometry =
  | { type: 'LineString'; coordinates: [number, number][] }
  | { type: 'MultiLineString'; coordinates: [number, number][][] };

interface BoundaryFeature {
  type: 'Feature';
  properties: { PlateA?: string; PlateB?: string; Type?: string; Name?: string };
  geometry: LineGeometry;
}

interface BoundaryFeatureCollection {
  type: 'FeatureCollection';
  features: BoundaryFeature[];
}

/**
 * Converts the PB2002 plate-boundary GeoJSON (Bird, 2003) — coordinates in
 * [lng, lat] order, some as MultiLineString — into flat [lat, lng] paths
 * ready for react-globe.gl's `pathsData`.
 */
export function toBoundaryPaths(fc: BoundaryFeatureCollection): BoundaryPath[] {
  const out: BoundaryPath[] = [];
  let idx = 0;

  for (const f of fc.features ?? []) {
    const geom = f.geometry;
    const lines: [number, number][][] =
      geom.type === 'LineString' ? [geom.coordinates] : geom.type === 'MultiLineString' ? geom.coordinates : [];

    const props = f.properties ?? {};
    const boundaryType = props.Type && props.Type.trim() ? props.Type.trim() : 'unclassified';

    for (const line of lines) {
      if (line.length < 2) continue;
      out.push({
        id: `b${idx++}`,
        plateA: props.PlateA ?? '',
        plateB: props.PlateB ?? '',
        boundaryType,
        coords: line.map(([lng, lat]) => [lat, lng]),
      });
    }
  }

  return out;
}

// ---- Geometry helpers for country-level filtering ----

function pointInRing(lng: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function pointInPolygonRings(lng: number, lat: number, rings: [number, number][][]): boolean {
  if (rings.length === 0) return false;
  if (!pointInRing(lng, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(lng, lat, rings[i])) return false;
  }
  return true;
}

export function pointInGeometry(lng: number, lat: number, geometry: any): boolean {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') return pointInPolygonRings(lng, lat, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((poly: [number, number][][]) => pointInPolygonRings(lng, lat, poly));
  }
  return false;
}

function allOuterRingPoints(geometry: any): [number, number][] {
  if (!geometry) return [];
  const polys: [number, number][][][] =
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  const points: [number, number][] = [];
  for (const poly of polys) points.push(...(poly[0] ?? []));
  return points;
}

export function getBbox(geometry: any): [number, number, number, number] | null {
  const points = allOuterRingPoints(geometry);
  if (points.length === 0) return null;
  let minLng = Infinity,
    minLat = Infinity,
    maxLng = -Infinity,
    maxLat = -Infinity;
  for (const [lng, lat] of points) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLng, minLat, maxLng, maxLat];
}

export function padBbox(
  bbox: [number, number, number, number],
  degrees: number
): [number, number, number, number] {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  return [
    Math.max(-180, minLng - degrees),
    Math.max(-90, minLat - degrees),
    Math.min(180, maxLng + degrees),
    Math.min(90, maxLat + degrees),
  ];
}

export function isInBbox(lng: number, lat: number, bbox: [number, number, number, number]): boolean {
  return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

/**
 * Approximate intersection test between two Polygon/MultiPolygon geometries:
 * true if either geometry has a sampled outer-ring vertex inside the other.
 * Not exact for edge-crossing-only cases, but reliable enough to answer
 * "which tectonic plates does this country sit on" at globe scale.
 */
export function geometriesLikelyIntersect(a: any, b: any): boolean {
  const sample = (geometry: any, max = 80) => {
    const points = allOuterRingPoints(geometry);
    if (points.length <= max) return points;
    const step = Math.ceil(points.length / max);
    return points.filter((_, i) => i % step === 0);
  };
  const aPoints = sample(a);
  const bPoints = sample(b);
  if (aPoints.some(([lng, lat]) => pointInGeometry(lng, lat, b))) return true;
  if (bPoints.some(([lng, lat]) => pointInGeometry(lng, lat, a))) return true;
  return false;
}

/**
 * Bounding box meant for "country-sized" selection. Territories that cross the
 * antimeridian (Russia, Fiji, New Zealand's Chatham Islands, ...) would
 * otherwise get a bbox spanning the whole planet. When the full box is wider
 * than 200 degrees of longitude, keep only the parts that sit within 90 degrees
 * of the largest landmass (by vertex count) and merge their boxes.
 */
export function getMainBbox(geometry: any): [number, number, number, number] | null {
  const full = getBbox(geometry);
  if (!full) return null;
  if (full[2] - full[0] <= 200 || geometry?.type !== 'MultiPolygon') return full;

  const parts = (geometry.coordinates as [number, number][][][])
    .map((poly) => ({ bbox: getBbox({ type: 'Polygon', coordinates: poly }), size: poly[0]?.length ?? 0 }))
    .filter((p): p is { bbox: [number, number, number, number]; size: number } => p.bbox !== null);
  if (parts.length === 0) return full;

  const ref = parts.reduce((best, p) => (p.size > best.size ? p : best));
  const refCenter = (ref.bbox[0] + ref.bbox[2]) / 2;
  const near = parts.filter((p) => Math.abs((p.bbox[0] + p.bbox[2]) / 2 - refCenter) <= 90);
  return [
    Math.min(...near.map((p) => p.bbox[0])),
    Math.min(...near.map((p) => p.bbox[1])),
    Math.max(...near.map((p) => p.bbox[2])),
    Math.max(...near.map((p) => p.bbox[3])),
  ];
}

function ringSignedArea(ring: [number, number][]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return sum / 2;
}

/**
 * Returns a copy of a Polygon/MultiPolygon with the ring winding the globe
 * renderer (d3-geo) expects: exterior rings clockwise, holes counter-clockwise.
 * A ring wound the other way is read as "the whole planet except this shape".
 */
export function normalizeWinding(geometry: any): any {
  const fix = (rings: [number, number][][]) =>
    rings.map((ring, i) => {
      const clockwise = ringSignedArea(ring) < 0;
      return clockwise === (i === 0) ? ring : [...ring].reverse();
    });
  if (geometry?.type === 'Polygon') return { ...geometry, coordinates: fix(geometry.coordinates) };
  if (geometry?.type === 'MultiPolygon') return { ...geometry, coordinates: geometry.coordinates.map(fix) };
  return geometry;
}

/** Merges the polygons of several Polygon/MultiPolygon geometries into one MultiPolygon. */
export function mergeToMultiPolygon(geometries: any[]): any {
  const coordinates: [number, number][][][] = [];
  for (const g of geometries) {
    if (g?.type === 'Polygon') coordinates.push(g.coordinates);
    else if (g?.type === 'MultiPolygon') coordinates.push(...g.coordinates);
  }
  return { type: 'MultiPolygon', coordinates };
}

type Box = [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]

/**
 * Covers a Polygon/MultiPolygon with a small set of rectangles, much tighter
 * than its overall bounding box. Needed for huge plates whose bbox spans the
 * planet (they cross the antimeridian or enclose a pole): querying that whole
 * band would pull in thousands of unrelated events from other plates.
 *
 * The geometry is overlaid on a `cell`-degree grid; a cell is kept when it
 * holds a vertex of an outer ring (rings are densified so long edges are
 * caught too) or when its centre is inside the shape. Holes are ignored
 * (conservative: the boxes may include a little more, never less). Kept cells
 * are merged into horizontal strips, then identical stacked strips are fused.
 * Returns null when the cover would need more than `maxBoxes` rectangles, so
 * the caller can fall back to the plain bbox.
 */
export function coverBoxes(geometry: any, cell = 10, maxBoxes = 24): Box[] | null {
  const polys: [number, number][][][] =
    geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  if (polys.length === 0) return null;

  const nCols = Math.ceil(360 / cell);
  const nRows = Math.ceil(180 / cell);
  const col = (lng: number) => Math.min(nCols - 1, Math.max(0, Math.floor((lng + 180) / cell)));
  const row = (lat: number) => Math.min(nRows - 1, Math.max(0, Math.floor((lat + 90) / cell)));
  const kept = new Set<number>();
  const mark = (lng: number, lat: number) => kept.add(row(lat) * nCols + col(lng));

  for (const poly of polys) {
    const ring = poly[0] ?? [];
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      mark(x1, y1);
      // Densify so an edge that skips over cells still marks every cell it crosses.
      // (Edges spanning the antimeridian/pole run along the map edge; stepping in
      // plain lng/lat visits exactly the cells a straight map line crosses.)
      const steps = Math.ceil(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) / (cell / 2));
      for (let s = 1; s < steps; s++) mark(x1 + ((x2 - x1) * s) / steps, y1 + ((y2 - y1) * s) / steps);
    }
    const bb = getBbox({ type: 'Polygon', coordinates: poly });
    if (!bb) continue;
    for (let r = row(bb[1]); r <= row(bb[3]); r++) {
      for (let c = col(bb[0]); c <= col(bb[2]); c++) {
        const id = r * nCols + c;
        if (kept.has(id)) continue;
        const cx = -180 + c * cell + cell / 2;
        const cy = -90 + r * cell + cell / 2;
        if (pointInPolygonRings(cx, cy, poly)) kept.add(id);
      }
    }
  }

  // Horizontal strips per latitude band.
  let strips: Box[] = [];
  for (let r = 0; r < nRows; r++) {
    let start = -1;
    for (let c = 0; c <= nCols; c++) {
      const on = c < nCols && kept.has(r * nCols + c);
      if (on && start < 0) start = c;
      if (!on && start >= 0) {
        strips.push([
          -180 + start * cell,
          Math.max(-90, -90 + r * cell),
          Math.min(180, -180 + c * cell),
          Math.min(90, -90 + (r + 1) * cell),
        ]);
        start = -1;
      }
    }
  }

  // Fuse vertically stacked strips that share the same longitude span.
  strips.sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
  const fused: Box[] = [];
  for (const s of strips) {
    const last = fused[fused.length - 1];
    if (last && last[0] === s[0] && last[2] === s[2] && Math.abs(last[3] - s[1]) < 1e-9) last[3] = s[3];
    else fused.push([...s] as Box);
  }
  strips = fused;
  return strips.length > 0 && strips.length <= maxBoxes ? strips : null;
}
