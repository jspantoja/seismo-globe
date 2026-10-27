import { parseColor } from '../../engine/glcore';
import type { AreaSpec, AssembledAreas, AssembleOptions } from '../../engine/areas';
import { DEFAULT_LINE_STEP_DEG, SegmentBuffer, ringStrokes, type RingStroke, type Rgba } from '../../engine/linegeom';
import { AreaIndex } from '../../engine/picker';
import { DEFAULT_MAX_EDGE_DEG, planarPolygons, tessellate, type AreaMesh, type PlanarPolygon } from '../../engine/tessellate';

/**
 * REFERENCE implementation of the area assembler: the straightforward version (a Set for shared edges,
 * every segment written again on every call), kept to check the optimised assembler byte for byte.
 * Do not optimise this file.
 *
 * Turns a list of areas (countries, subdivisions, a tectonic plate...) into the arrays the GPU
 * draws: one triangle mesh for every fill and one set of line segments for every outline. No GL
 * here, so it can be tested in Node. Geometry that was seen before is not recomputed: the work
 * (triangulation, densifying) is cached per GeoJSON geometry object.
 */

interface Cached {
  polygons: PlanarPolygon[];
  meshes?: (AreaMesh | null)[];
  strokes?: RingStroke[][];
}

const ZERO: Rgba = [0, 0, 0, 0];

function toRgba(css: string | null | undefined): Rgba {
  if (!css) return ZERO;
  const c = parseColor(css);
  return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), Math.round(c[3] * 255)];
}

export class ReferenceAreaAssembler<T = unknown> {
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

  private meshes(c: Cached, maxEdgeDeg: number): (AreaMesh | null)[] {
    if (!c.meshes) c.meshes = c.polygons.map((p) => tessellate(p, maxEdgeDeg));
    return c.meshes;
  }

  private strokesOf(c: Cached, stepDeg: number): RingStroke[][] {
    if (!c.strokes) c.strokes = c.polygons.map((p) => ringStrokes(p, stepDeg));
    return c.strokes;
  }

  assemble(specs: AreaSpec<T>[], options: AssembleOptions = {}): AssembledAreas {
    const maxEdge = options.maxEdgeDeg ?? DEFAULT_MAX_EDGE_DEG;
    const step = options.lineStepDeg ?? DEFAULT_LINE_STEP_DEG;
    const dedupe = options.dedupeEdges ?? true;

    // Painter's order: a stable sort by `order`.
    const ordered = specs.map((s, i) => ({ s, i })).sort((a, b) => (a.s.order ?? 0) - (b.s.order ?? 0) || a.i - b.i);

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
    const segments = new SegmentBuffer(1024);
    const claimed = new Set<number>();
    for (let k = ordered.length - 1; k >= 0; k--) {
      const s = ordered[k].s;
      const width = s.strokeWidth ?? 1;
      if (!s.stroke || width <= 0) continue;
      const color = toRgba(s.stroke);
      if (color[3] === 0) continue;
      const c = this.cached(s.geometry);
      for (const rings of this.strokesOf(c, step)) {
        for (const ring of rings) {
          const edges = ring.keys.length;
          const skip = new Uint8Array(edges);
          for (let e = 0; e < edges; e++) {
            if (ring.hidden[e]) {
              skip[e] = 1;
            } else if (dedupe) {
              if (claimed.has(ring.keys[e])) skip[e] = 1;
              else claimed.add(ring.keys[e]);
            }
          }
          segments.addPath(ring.path, width, color, (e) => skip[e] === 1);
        }
      }
    }

    return { positions, colors, indices, vertexCount, segments: segments.view(), segmentCount: segments.count };
  }
}
