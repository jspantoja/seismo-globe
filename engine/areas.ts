import { parseColor } from './glcore';
import { DEFAULT_LINE_STEP_DEG, EdgeSet, SegmentBuffer, ringStrokes, type RingStroke, type Rgba } from './linegeom';
import { AreaIndex } from './picker';
import { DEFAULT_MAX_EDGE_DEG, planarPolygons, tessellate, type AreaMesh, type PlanarPolygon } from './tessellate';

/**
 * Turns a list of areas (countries, subdivisions, a tectonic plate...) into the arrays the GPU
 * draws: one triangle mesh for every fill and one set of line segments for every outline. No GL
 * here, so it can be tested in Node. Geometry that was seen before is not recomputed: the work
 * (triangulation, densifying) is cached per GeoJSON geometry object, and so are the line segments
 * of each outline ring (rebuilt only when the ring's style or the edges it may draw change), which
 * makes re-assembling after a small change (selecting a country) cheap.
 *
 * `prepare` does the expensive part of a big, new set (the 1:50m countries) ahead of time in short
 * slices that give the browser back its main thread between them, so that the later `assemble`
 * only copies.
 */

export interface AreaSpec<T = unknown> {
  key: string | number;
  /** GeoJSON Polygon or MultiPolygon, [lng, lat]. */
  geometry: any;
  /** CSS colour of the fill; null or missing: no fill. */
  fill?: string | null;
  /** CSS colour of the outline; null or missing: no outline. */
  stroke?: string | null;
  /** Outline width in CSS pixels. */
  strokeWidth?: number;
  /** Drawing and picking order: larger is on top. */
  order?: number;
  /** Handed back by picking. */
  data?: T;
}

export interface AssembledAreas {
  /** Per vertex 6 floats: position high, position low. */
  positions: Float32Array;
  /** Per vertex 4 bytes, straight (not premultiplied) RGBA. */
  colors: Uint8Array;
  indices: Uint32Array;
  vertexCount: number;
  /** Line segment instances (see linegeom.ts). */
  segments: Uint8Array;
  segmentCount: number;
}

interface Cached {
  polygons: PlanarPolygon[];
  meshes?: (AreaMesh | null)[];
  strokes?: RingStroke[][];
}

export interface AssembleOptions {
  maxEdgeDeg?: number;
  lineStepDeg?: number;
  /** Draw an edge shared by two areas once (the one on top wins). Default true. */
  dedupeEdges?: boolean;
}

export interface PrepareOptions extends AssembleOptions {
  /** Longest stretch of work between two yields, in milliseconds (default 6). */
  sliceMs?: number;
  /** Gives the main thread back (default: `yieldToMain`). */
  yieldFn?: () => Promise<void>;
  /** Checked between slices: return true to stop preparing. */
  cancelled?: () => boolean;
}

/** Lets the browser run its own work (input, painting) before the next slice. */
export function yieldToMain(): Promise<void> {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (sched && typeof sched.yield === 'function') return sched.yield();
  if (typeof MessageChannel !== 'undefined') {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        resolve();
      };
      ch.port2.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The line segments of one outline ring as last built, and what they were built for. */
interface RingBlock {
  width: number;
  rgba: number;
  /** Per source edge: 1 when it was left out (cut along the antimeridian, or claimed by an area above). */
  skip: Uint8Array;
  bytes: Uint8Array;
  count: number;
}

/** One polygon's outline rings with the style they are drawn in. */
interface Ink {
  rings: RingStroke[];
  width: number;
  color: Rgba;
  rgba: number;
}

const ZERO: Rgba = [0, 0, 0, 0];

export function toRgba(css: string | null | undefined): Rgba {
  if (!css) return ZERO;
  const c = parseColor(css);
  return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), Math.round(c[3] * 255)];
}

function sameBytes(a: Uint8Array, b: Uint8Array, n: number): boolean {
  if (a.length !== n) return false;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class AreaAssembler<T = unknown> {
  private cache = new WeakMap<object, Cached>();
  readonly index = new AreaIndex<AreaSpec<T>>();

  private cached(geometry: any): Cached {
    if (!geometry || typeof geometry !== 'object') return { polygons: [], meshes: [], strokes: [] };
    let c = this.cache.get(geometry);
    if (!c) {
      c = { polygons: planarPolygons(geometry) };
      this.cache.set(geometry, c);
    }
    return c;
  }

  /** Triangulated polygons of a geometry; built one polygon at a time, so `prepare` can slice the work. */
  private meshes(c: Cached, maxEdgeDeg: number): (AreaMesh | null)[] {
    const out = c.meshes ?? (c.meshes = []);
    while (out.length < c.polygons.length) out.push(tessellate(c.polygons[out.length], maxEdgeDeg));
    return out;
  }

  private strokesOf(c: Cached, stepDeg: number): RingStroke[][] {
    const out = c.strokes ?? (c.strokes = []);
    while (out.length < c.polygons.length) out.push(ringStrokes(c.polygons[out.length], stepDeg));
    return out;
  }

  private readonly blocks = new WeakMap<RingStroke, RingBlock>();
  private readonly claimed = new EdgeSet(1024);

  /**
   * Does ahead of time the work `assemble` would do for these specs and has not done yet:
   * outlines to planar polygons, triangulation and densified outlines, in slices of `sliceMs`.
   */
  async prepare(specs: AreaSpec<T>[], options: PrepareOptions = {}): Promise<void> {
    const maxEdge = options.maxEdgeDeg ?? DEFAULT_MAX_EDGE_DEG;
    const step = options.lineStepDeg ?? DEFAULT_LINE_STEP_DEG;
    const sliceMs = options.sliceMs ?? 6;
    const yieldFn = options.yieldFn ?? yieldToMain;
    let sliceStart = performance.now();
    const checkpoint = async (): Promise<boolean> => {
      if (performance.now() - sliceStart < sliceMs) return false;
      await yieldFn();
      sliceStart = performance.now();
      return options.cancelled?.() ?? false;
    };
    for (const s of specs) {
      const wantFill = !!s.fill && toRgba(s.fill)[3] > 0;
      const wantStroke = !!s.stroke && (s.strokeWidth ?? 1) > 0 && toRgba(s.stroke)[3] > 0;
      if (!wantFill && !wantStroke) continue;
      const c = this.cached(s.geometry);
      if (await checkpoint()) return;
      for (let i = 0; i < c.polygons.length; i++) {
        if (wantFill) {
          const out = c.meshes ?? (c.meshes = []);
          if (out.length <= i) out.push(tessellate(c.polygons[i], maxEdge));
        }
        if (wantStroke) {
          const out = c.strokes ?? (c.strokes = []);
          if (out.length <= i) out.push(ringStrokes(c.polygons[i], step));
        }
        if (await checkpoint()) return;
      }
    }
    // The outline segments of every ring, for these styles and this order of areas.
    const dedupe = options.dedupeEdges ?? true;
    const { inks, edgeTotal } = this.collectInks(this.orderSpecs(specs), step);
    const steps = this.strokeSteps(inks, edgeTotal, dedupe, null);
    for (let r = steps.next(); !r.done; r = steps.next()) {
      if (await checkpoint()) return;
    }
  }

  /** Painter's order: a stable sort by `order`. */
  private orderSpecs(specs: AreaSpec<T>[]): { s: AreaSpec<T>; i: number }[] {
    return specs.map((s, i) => ({ s, i })).sort((a, b) => (a.s.order ?? 0) - (b.s.order ?? 0) || a.i - b.i);
  }

  /** The outlines to draw, topmost area first (it claims shared edges first), with their totals. */
  private collectInks(ordered: { s: AreaSpec<T> }[], step: number): { inks: Ink[]; edgeTotal: number; segmentTotal: number } {
    const inks: Ink[] = [];
    let edgeTotal = 0;
    let segmentTotal = 0;
    for (let k = ordered.length - 1; k >= 0; k--) {
      const s = ordered[k].s;
      const width = s.strokeWidth ?? 1;
      if (!s.stroke || width <= 0) continue;
      const color = toRgba(s.stroke);
      if (color[3] === 0) continue;
      const rgba = ((color[0] << 24) | (color[1] << 16) | (color[2] << 8) | color[3]) >>> 0;
      const c = this.cached(s.geometry);
      for (const rings of this.strokesOf(c, step)) {
        inks.push({ rings, width, color, rgba });
        for (const ring of rings) {
          edgeTotal += ring.keys.length;
          segmentTotal += ring.path.closed ? ring.path.count : Math.max(0, ring.path.count - 1);
        }
      }
    }
    return { inks, edgeTotal, segmentTotal };
  }

  /**
   * Walks the outlines in order, deciding per ring which edges it may draw (those not claimed by an
   * area above) and making sure its segments are built for that; one step per ring, so a caller can
   * slice the work. With an `out` buffer the segments are appended to it; without, this only warms
   * the per-ring caches.
   */
  private *strokeSteps(inks: Ink[], edgeTotal: number, dedupe: boolean, out: SegmentBuffer | null, claimedSet?: EdgeSet): Generator<void, void, void> {
    const claimed = claimedSet ?? new EdgeSet(edgeTotal);
    claimed.reset(dedupe ? edgeTotal : 0);
    let skip = new Uint8Array(1024);
    for (const { rings, width, color, rgba } of inks) {
      for (const ring of rings) {
        const edges = ring.keys.length;
        if (skip.length < edges) skip = new Uint8Array(Math.max(edges, skip.length * 2));
        for (let e = 0; e < edges; e++) {
          skip[e] = ring.hidden[e] === 1 || (dedupe && !claimed.add(ring.keys[e])) ? 1 : 0;
        }
        let block = this.blocks.get(ring);
        if (!block || block.width !== width || block.rgba !== rgba || !sameBytes(block.skip, skip, edges)) {
          const tmp = new SegmentBuffer(Math.max(16, ring.path.count));
          tmp.addPath(ring.path, width, color, (e) => skip[e] === 1);
          block = { width, rgba, skip: skip.slice(0, edges), bytes: tmp.view(), count: tmp.count };
          this.blocks.set(ring, block);
        }
        if (out) out.append(block.bytes, block.count);
        yield;
      }
    }
  }

  assemble(specs: AreaSpec<T>[], options: AssembleOptions = {}): AssembledAreas {
    const maxEdge = options.maxEdgeDeg ?? DEFAULT_MAX_EDGE_DEG;
    const step = options.lineStepDeg ?? DEFAULT_LINE_STEP_DEG;
    const dedupe = options.dedupeEdges ?? true;

    const ordered = this.orderSpecs(specs);

    this.index.clear();
    for (const { s } of ordered) {
      const c = this.cached(s.geometry);
      if (c.polygons.length) this.index.add(s, c.polygons, s.order ?? 0);
    }

    // ---- fills
    let vertexCount = 0;
    let indexCount = 0;
    const parts: { mesh: AreaMesh; color: Rgba }[] = [];
    for (const { s } of ordered) {
      if (!s.fill) continue;
      const color = toRgba(s.fill);
      if (color[3] === 0) continue;
      const c = this.cached(s.geometry);
      for (const mesh of this.meshes(c, maxEdge)) {
        if (!mesh) continue;
        parts.push({ mesh, color });
        vertexCount += mesh.vertexCount;
        indexCount += mesh.indices.length;
      }
    }
    const positions = new Float32Array(vertexCount * 6);
    const colors = new Uint8Array(vertexCount * 4);
    const indices = new Uint32Array(indexCount);
    let v = 0;
    let ix = 0;
    for (const { mesh, color } of parts) {
      positions.set(mesh.vertices, v * 6);
      for (let i = 0; i < mesh.vertexCount; i++) {
        const o = (v + i) * 4;
        colors[o] = color[0];
        colors[o + 1] = color[1];
        colors[o + 2] = color[2];
        colors[o + 3] = color[3];
      }
      for (let i = 0; i < mesh.indices.length; i++) indices[ix + i] = mesh.indices[i] + v;
      v += mesh.vertexCount;
      ix += mesh.indices.length;
    }

    // ---- outlines: the area on top claims a shared edge, so it is drawn once, in the top area's style
    const { inks, edgeTotal, segmentTotal } = this.collectInks(ordered, step);
    const segments = new SegmentBuffer(Math.max(16, segmentTotal));
    const steps = this.strokeSteps(inks, edgeTotal, dedupe, segments, this.claimed);
    while (!steps.next().done);

    return { positions, colors, indices, vertexCount, segments: segments.view(), segmentCount: segments.count };
  }
}
