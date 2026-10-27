import { writeSplit, type PlanarPolygon } from './tessellate';
import { RAD2DEG, angleBetween, geoToVec, slerp, type Vec3 } from './math';

/**
 * Line geometry for the globe's lines (borders, plate boundaries, rings).
 *
 * A line is drawn as a chain of segments, one GPU instance per segment. Each segment carries its two
 * end points (in the split high/low form the shaders use), its neighbours (so the shader can join
 * segments with a miter), a width in pixels and a colour. Between two data points the line follows
 * the great circle, densified to about a degree so it hugs the planet.
 */

/** Bytes and floats of one segment instance: p0 (6) p1 (6) prev (3) next (3) width (1) colour (4 bytes). */
export const SEGMENT_FLOATS = 20;
export const SEGMENT_BYTES = SEGMENT_FLOATS * 4;

export const DEFAULT_LINE_STEP_DEG = 1;

/** A densified chain of points on the sphere, in (high, low) form. */
export interface DensePath {
  /** 6 floats per point: position high part, position low part. */
  pts: Float32Array;
  count: number;
  closed: boolean;
  /** For segment i (from point i to the next), the index of the source edge it belongs to. */
  edgeOf: Uint32Array;
}

/**
 * Densifies a chain of (lng, lat) points: great-circle arcs, at most `stepDeg` long.
 * `lnglat` is flat [lng0, lat0, lng1, lat1, ...].
 */
export function densify(lnglat: ArrayLike<number>, closed: boolean, stepDeg = DEFAULT_LINE_STEP_DEG): DensePath {
  const m = lnglat.length / 2;
  const vecs: Vec3[] = new Array(m);
  for (let i = 0; i < m; i++) vecs[i] = geoToVec(lnglat[i * 2 + 1], lnglat[i * 2]);
  const edges = closed ? m : m - 1;
  const steps = new Uint32Array(Math.max(edges, 0));
  let total = 0;
  for (let e = 0; e < edges; e++) {
    const a = vecs[e];
    const b = vecs[(e + 1) % m];
    const deg = angleBetween(a, b) * RAD2DEG;
    steps[e] = Math.max(1, Math.ceil(deg / stepDeg));
    total += steps[e];
  }
  const count = closed ? total : total + 1;
  const pts = new Float32Array(count * 6);
  const edgeOf = new Uint32Array(Math.max(closed ? count : count - 1, 0));
  let at = 0;
  const put = (v: Vec3) => {
    const o = at * 6;
    const hx = Math.fround(v[0]);
    const hy = Math.fround(v[1]);
    const hz = Math.fround(v[2]);
    pts[o] = hx;
    pts[o + 1] = hy;
    pts[o + 2] = hz;
    pts[o + 3] = v[0] - hx;
    pts[o + 4] = v[1] - hy;
    pts[o + 5] = v[2] - hz;
    at++;
  };
  for (let e = 0; e < edges; e++) {
    const a = vecs[e];
    const b = vecs[(e + 1) % m];
    const n = steps[e];
    for (let k = 0; k < n; k++) {
      // The first point of an edge is the data point itself, exactly as the fills place it.
      if (k === 0) writeAt(pts, at++, lnglat[e * 2], lnglat[e * 2 + 1]);
      else put(slerp(a, b, k / n));
      edgeOf[at - 1] = e;
    }
  }
  if (!closed && m > 0) writeAt(pts, at++, lnglat[(m - 1) * 2], lnglat[(m - 1) * 2 + 1]);
  return { pts, count, closed, edgeOf };
}

function writeAt(pts: Float32Array, index: number, lng: number, lat: number): void {
  writeSplit(pts, index * 6, lng, lat);
}

// ---------------------------------------------------------------------------
// Edge keys, to draw a border shared by two countries once
// ---------------------------------------------------------------------------

const QUANT = 1e5; // 1e-5 degrees, about a metre

function pointKey(lng: number, lat: number): [number, number] {
  // Longitudes that differ by whole turns are the same place.
  const l = ((((lng + 180) % 360) + 360) % 360) - 180;
  return [Math.round(l * QUANT), Math.round(lat * QUANT)];
}

/** A key (about 52 bits) for the edge between two (lng, lat) points; the same for either direction. */
export function edgeKey(lng0: number, lat0: number, lng1: number, lat1: number): number {
  let [x0, y0] = pointKey(lng0, lat0);
  let [x1, y1] = pointKey(lng1, lat1);
  if (x0 > x1 || (x0 === x1 && y0 > y1)) {
    [x0, y0, x1, y1] = [x1, y1, x0, y0];
  }
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x9e3779b9 | 0;
  for (const v of [x0, y0, x1, y1]) {
    h1 = Math.imul(h1 ^ (v | 0), 0x01000193);
    h1 ^= h1 >>> 15;
    h2 = Math.imul(h2 + (v | 0), 0x85ebca6b);
    h2 ^= h2 >>> 13;
  }
  return (h1 >>> 0) * 1048576 + ((h2 >>> 0) & 0xfffff);
}

/** True for an edge that runs along the antimeridian: where the data was cut, not a real border. */
export function onAntimeridian(lng0: number, lng1: number): boolean {
  const on = (l: number) => Math.abs((((l % 360) + 360) % 360) - 180) < 1e-9;
  return on(lng0) && on(lng1);
}

/**
 * A set of edge keys (non-negative numbers below 2^53) in typed arrays: open addressing, no
 * per-entry allocation. `add` reports whether the key was new, so "has, then add" is one probe.
 */
export class EdgeSet {
  private keys: Float64Array;
  private mask: number;
  private size = 0;

  constructor(expected = 1024) {
    let cap = 16;
    while (cap < expected * 2) cap *= 2;
    this.keys = new Float64Array(cap).fill(-1);
    this.mask = cap - 1;
  }

  /** Forgets every key, keeping room for about `expected` of them. */
  reset(expected: number): void {
    let cap = 16;
    while (cap < expected * 2) cap *= 2;
    if (cap !== this.keys.length) {
      this.keys = new Float64Array(cap).fill(-1);
      this.mask = cap - 1;
    } else {
      this.keys.fill(-1);
    }
    this.size = 0;
  }

  get count(): number {
    return this.size;
  }

  /** Adds the key; false when it was already there. */
  add(key: number): boolean {
    if ((this.size + 1) * 2 > this.keys.length) this.grow();
    const keys = this.keys;
    const mask = this.mask;
    let h = Math.imul(key | 0, 0x9e3779b1);
    h ^= h >>> 15;
    let i = h & mask;
    for (;;) {
      const k = keys[i];
      if (k === key) return false;
      if (k === -1) {
        keys[i] = key;
        this.size++;
        return true;
      }
      i = (i + 1) & mask;
    }
  }

  private grow(): void {
    const old = this.keys;
    const cap = old.length * 2;
    this.keys = new Float64Array(cap).fill(-1);
    this.mask = cap - 1;
    this.size = 0;
    for (let n = 0; n < old.length; n++) if (old[n] !== -1) this.add(old[n]);
  }
}

/** The outlines of a polygon prepared for stroking: the densified chain per ring plus a key and a flag per source edge. */
export interface RingStroke {
  path: DensePath;
  keys: Float64Array;
  /** 1 for source edges that must not be drawn (the cut along the antimeridian). */
  hidden: Uint8Array;
}

export function ringStrokes(poly: PlanarPolygon, stepDeg = DEFAULT_LINE_STEP_DEG): RingStroke[] {
  return poly.rings.map((r) => {
    const n = r.length / 2;
    const keys = new Float64Array(n);
    const hidden = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      keys[i] = edgeKey(r[i * 2], r[i * 2 + 1], r[j * 2], r[j * 2 + 1]);
      hidden[i] = onAntimeridian(r[i * 2], r[j * 2]) ? 1 : 0;
    }
    return { path: densify(r, true, stepDeg), keys, hidden };
  });
}

// ---------------------------------------------------------------------------
// Segment buffer
// ---------------------------------------------------------------------------

export type Rgba = [number, number, number, number]; // 0-255 each

export class SegmentBuffer {
  private floats: Float32Array;
  private bytes: Uint8Array;
  count = 0;

  constructor(capacity = 1024) {
    const buf = new ArrayBuffer(capacity * SEGMENT_BYTES);
    this.floats = new Float32Array(buf);
    this.bytes = new Uint8Array(buf);
  }

  private ensure(extra: number): void {
    const need = (this.count + extra) * SEGMENT_BYTES;
    if (need <= this.bytes.length) return;
    let cap = this.bytes.length;
    while (cap < need) cap *= 2;
    const buf = new ArrayBuffer(cap);
    new Uint8Array(buf).set(this.bytes.subarray(0, this.count * SEGMENT_BYTES));
    this.floats = new Float32Array(buf);
    this.bytes = new Uint8Array(buf);
  }

  /**
   * Adds the segments of a path. `skip` (per source edge) leaves out the edges for which it returns
   * true; the segments around a gap end there without a join.
   */
  addPath(path: DensePath, width: number, color: Rgba, skip?: (edge: number) => boolean): void {
    const n = path.count;
    const segs = path.closed ? n : n - 1;
    if (segs <= 0) return;
    this.ensure(segs);
    const p = path.pts;
    const drawn = (i: number): boolean => !skip || !skip(path.edgeOf[i]);
    for (let i = 0; i < segs; i++) {
      if (!drawn(i)) continue;
      const j = (i + 1) % n;
      const prevI = i > 0 ? i - 1 : path.closed ? segs - 1 : -1;
      const nextI = i + 1 < segs ? i + 1 : path.closed ? 0 : -1;
      const hasPrev = prevI >= 0 && drawn(prevI);
      const hasNext = nextI >= 0 && drawn(nextI);
      const k = (i + 2) % n; // the point after j
      const h = (i - 1 + n) % n; // the point before i
      const o = this.count * SEGMENT_FLOATS;
      const f = this.floats;
      for (let c = 0; c < 6; c++) {
        f[o + c] = p[i * 6 + c];
        f[o + 6 + c] = p[j * 6 + c];
      }
      // Neighbours (only their direction matters, so the high part is enough). Without one, repeat the end.
      const prevSrc = hasPrev ? h : i;
      const nextSrc = hasNext ? k : j;
      f[o + 12] = p[prevSrc * 6];
      f[o + 13] = p[prevSrc * 6 + 1];
      f[o + 14] = p[prevSrc * 6 + 2];
      f[o + 15] = p[nextSrc * 6];
      f[o + 16] = p[nextSrc * 6 + 1];
      f[o + 17] = p[nextSrc * 6 + 2];
      f[o + 18] = width;
      const b = (o + 19) * 4;
      this.bytes[b] = color[0];
      this.bytes[b + 1] = color[1];
      this.bytes[b + 2] = color[2];
      this.bytes[b + 3] = color[3];
      this.count++;
    }
  }

  /** Room for `extra` more segments without growing again. */
  reserve(extra: number): void {
    this.ensure(extra);
  }

  /** Appends segments that were built before (the bytes of another buffer's `view()`). */
  append(bytes: Uint8Array, count: number): void {
    this.ensure(count);
    this.bytes.set(bytes.subarray(0, count * SEGMENT_BYTES), this.count * SEGMENT_BYTES);
    this.count += count;
  }

  /** The filled part of the buffer. */
  view(): Uint8Array {
    return this.bytes.subarray(0, this.count * SEGMENT_BYTES);
  }
}
