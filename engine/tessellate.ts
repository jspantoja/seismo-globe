import { triangulate } from './earcut';
import { DEG2RAD } from './math';

/**
 * From a GeoJSON polygon to a triangle mesh on the globe.
 *
 * The polygon is triangulated in the flat (longitude, latitude) plane, where its topology is
 * simple, and every triangle is then subdivided until no edge is longer than a couple of degrees
 * on the sphere, so that the mesh follows the planet's curvature. Each vertex is stored as a
 * (high, low) pair of float32 numbers that add up to its float64 position: the vertex shader
 * subtracts the camera position in that split form, which keeps vertices exact to the metre
 * however far the camera zooms in (see RTE in shaders.ts).
 *
 * Rings that cross the antimeridian are "unwrapped" first: the datasets store them as a jump of
 * about 360° between neighbouring points, which flat triangulation would read as a polygon
 * spanning the whole world.
 */

export type Coord = ArrayLike<number>; // [lng, lat]

/** A polygon in the flat plane: ring 0 is the outline, the rest are holes. Flat [x0, y0, x1, y1, ...]. */
export interface PlanarPolygon {
  rings: Float64Array[];
  /** Bounding box in the plane: [minLng, minLat, maxLng, maxLat]. */
  bbox: [number, number, number, number];
}

export interface AreaMesh {
  /** Per vertex: position high part (3 floats) then low part (3 floats). */
  vertices: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  /** The vertices' (lng, lat) in the plane; only filled in when asked for (tests). */
  planar?: Float64Array;
}

export const DEFAULT_MAX_EDGE_DEG = 2.5;

/** Cleans a ring: no closing copy of the first point, no repeated neighbours. Unwraps antimeridian jumps. */
export function planarRing(ring: ArrayLike<Coord>): Float64Array | null {
  const pts: number[] = [];
  let offset = 0;
  let lastX = NaN;
  let lastY = NaN;
  let firstX = NaN;
  for (let i = 0; i < ring.length; i++) {
    const rawX = ring[i][0];
    const y = ring[i][1];
    if (!Number.isFinite(rawX) || !Number.isFinite(y)) continue;
    if (i > 0 && !Number.isNaN(lastX)) {
      // Keep the walk continuous: a jump of more than half a turn is the antimeridian.
      const d = rawX + offset - lastX;
      if (d > 180) offset -= 360 * Math.round(d / 360);
      else if (d < -180) offset += 360 * Math.round(-d / 360);
    }
    const x = rawX + offset;
    if (x === lastX && y === lastY) continue;
    if (Number.isNaN(firstX)) firstX = x;
    pts.push(x, y);
    lastX = x;
    lastY = y;
  }
  if (pts.length >= 4 && lastX === pts[0] && lastY === pts[1]) {
    pts.length -= 2; // GeoJSON repeats the first point at the end
    lastX = pts[pts.length - 2];
    lastY = pts[pts.length - 1];
  }
  if (pts.length < 6) return null;

  // Does the ring close in the unwrapped plane? If its end is a whole number of turns away from
  // its start, it goes around a pole: close it along the pole.
  const gap = firstX - lastX;
  const turns = Math.round(gap / 360);
  if (turns !== 0 && Math.abs(gap - turns * 360) < 90) {
    let meanLat = 0;
    for (let i = 1; i < pts.length; i += 2) meanLat += pts[i];
    const pole = meanLat >= 0 ? 90 : -90;
    pts.push(lastX, pole, firstX, pole);
  }
  return Float64Array.from(pts);
}

/** Cleans every ring of a GeoJSON polygon (outline first) into the plane. Null when the outline is degenerate. */
export function planarPolygon(rings: ArrayLike<ArrayLike<Coord>>): PlanarPolygon | null {
  const out: Float64Array[] = [];
  for (let k = 0; k < rings.length; k++) {
    const r = planarRing(rings[k]);
    if (!r) {
      if (k === 0) return null;
      continue;
    }
    out.push(r);
  }
  if (out.length === 0) return null;

  // A hole must sit on the same "turn" of longitude as its outline.
  const outer = out[0];
  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < outer.length; i += 2) {
    if (outer[i] < minX) minX = outer[i];
    if (outer[i] > maxX) maxX = outer[i];
  }
  const centre = (minX + maxX) / 2;
  for (let k = 1; k < out.length; k++) {
    const h = out[k];
    let hx = 0;
    for (let i = 0; i < h.length; i += 2) hx += h[i];
    hx /= h.length / 2;
    const shift = 360 * Math.round((centre - hx) / 360);
    if (shift !== 0) for (let i = 0; i < h.length; i += 2) h[i] += shift;
  }

  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < outer.length; i += 2) {
    if (outer[i + 1] < minY) minY = outer[i + 1];
    if (outer[i + 1] > maxY) maxY = outer[i + 1];
  }
  return { rings: out, bbox: [minX, minY, maxX, maxY] };
}

/** The polygons of a GeoJSON Polygon or MultiPolygon geometry, in the plane. */
export function planarPolygons(geometry: any): PlanarPolygon[] {
  const list: ArrayLike<ArrayLike<Coord>>[] =
    geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  const out: PlanarPolygon[] = [];
  for (const rings of list) {
    const p = planarPolygon(rings);
    if (p) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mesh
// ---------------------------------------------------------------------------

/** Great-circle-ish length, in degrees, of a straight edge of the plane (longitude shrinks towards the poles). */
function edgeDegrees(x0: number, y0: number, x1: number, y1: number): number {
  const dy = y1 - y0;
  const crossesEquator = (y0 <= 0 && y1 >= 0) || (y0 >= 0 && y1 <= 0);
  const nearest = crossesEquator ? 0 : Math.min(Math.abs(y0), Math.abs(y1));
  const dx = (x1 - x0) * Math.cos(nearest * DEG2RAD);
  return Math.hypot(dx, dy);
}

export function tessellate(poly: PlanarPolygon, maxEdgeDeg = DEFAULT_MAX_EDGE_DEG, keepPlanar = false): AreaMesh | null {
  // One flat array: outline, then holes.
  let total = 0;
  for (const r of poly.rings) total += r.length;
  const data = new Float64Array(total);
  const holes: number[] = [];
  let at = 0;
  poly.rings.forEach((r, k) => {
    if (k > 0) holes.push(at / 2);
    data.set(r, at);
    at += r.length;
  });

  const tris = triangulate(data, holes);
  if (tris.length === 0) return null;

  // Compact the vertices that triangles use, then refine.
  const xs: number[] = [];
  const ys: number[] = [];
  const remap = new Map<number, number>();
  const use = (i: number): number => {
    let j = remap.get(i);
    if (j === undefined) {
      j = xs.length;
      xs.push(data[i * 2]);
      ys.push(data[i * 2 + 1]);
      remap.set(i, j);
    }
    return j;
  };
  const midpoints = new Map<number, number>();
  const mid = (a: number, b: number): number => {
    const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
    let m = midpoints.get(key);
    if (m === undefined) {
      m = xs.length;
      xs.push((xs[a] + xs[b]) / 2);
      ys.push((ys[a] + ys[b]) / 2);
      midpoints.set(key, m);
    }
    return m;
  };
  const out: number[] = [];
  const stack: number[] = [];
  for (let t = 0; t < tris.length; t += 3) {
    stack.push(use(tris[t]), use(tris[t + 1]), use(tris[t + 2]));
    while (stack.length) {
      const c = stack.pop()!;
      const b = stack.pop()!;
      const a = stack.pop()!;
      const ab = edgeDegrees(xs[a], ys[a], xs[b], ys[b]);
      const bc = edgeDegrees(xs[b], ys[b], xs[c], ys[c]);
      const ca = edgeDegrees(xs[c], ys[c], xs[a], ys[a]);
      const longest = Math.max(ab, bc, ca);
      if (longest <= maxEdgeDeg) {
        out.push(a, b, c);
      } else if (longest === ab) {
        const m = mid(a, b);
        stack.push(a, m, c, m, b, c);
      } else if (longest === bc) {
        const m = mid(b, c);
        stack.push(a, b, m, a, m, c);
      } else {
        const m = mid(c, a);
        stack.push(a, b, m, m, b, c);
      }
    }
  }

  const n = xs.length;
  const vertices = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) writeSplit(vertices, i * 6, xs[i], ys[i]);
  const mesh: AreaMesh = { vertices, indices: Uint32Array.from(out), vertexCount: n };
  if (keepPlanar) {
    mesh.planar = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      mesh.planar[i * 2] = xs[i];
      mesh.planar[i * 2 + 1] = ys[i];
    }
  }
  return mesh;
}

/** The unit-sphere position of (lng, lat), written as three high floats and three low floats. */
export function writeSplit(out: Float32Array, at: number, lng: number, lat: number): void {
  const la = lat * DEG2RAD;
  const lo = lng * DEG2RAD;
  const c = Math.cos(la);
  const x = c * Math.sin(lo);
  const y = Math.sin(la);
  const z = c * Math.cos(lo);
  const hx = Math.fround(x);
  const hy = Math.fround(y);
  const hz = Math.fround(z);
  out[at] = hx;
  out[at + 1] = hy;
  out[at + 2] = hz;
  out[at + 3] = x - hx;
  out[at + 4] = y - hy;
  out[at + 5] = z - hz;
}
