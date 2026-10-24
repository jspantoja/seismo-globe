import type { EngineLayer, FrameContext, LayerHost } from './engine';
import { AreaAssembler, toRgba, type AreaSpec, type AssembleOptions, type AssembledAreas } from './areas';
import { makeProgram, type Program } from './glcore';
import { SEGMENT_BYTES, SegmentBuffer, densify, DEFAULT_LINE_STEP_DEG, type DensePath } from './linegeom';
import { DEG2RAD, RAD2DEG, cross, dot, geoToVec, normalize, vecToGeo, type Vec3 } from './math';
import { FILL_FRAG, FILL_VERT, LINE_FRAG, LINE_VERT } from './shaders';

/**
 * Layers that lie on the planet's surface: filled areas with outlines (countries, regions, a plate)
 * and plain lines (plate boundaries, a radius ring). They are drawn without the depth buffer, in
 * the order they were added, and anything beyond the horizon is hidden by the shaders.
 */

const SURFACE_UNIFORMS = ['u_mvp', 'u_eyeHi', 'u_eyeLo', 'u_eye', 'u_bias'];

export function setSurfaceState(gl: WebGL2RenderingContext): void {
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied alpha
  gl.disable(gl.DEPTH_TEST);
  gl.depthMask(false);
  gl.disable(gl.CULL_FACE);
}

const scratchHi = new Float32Array(3);
const scratchLo = new Float32Array(3);

export function setSurfaceUniforms(gl: WebGL2RenderingContext, prog: Program, frame: FrameContext): void {
  const u = prog.uniforms;
  const cam = frame.camera;
  const eye = cam.position();
  const split = cam.eyeSplit(scratchHi, scratchLo);
  gl.uniformMatrix4fv(u.u_mvp, false, cam.rotationProjection());
  gl.uniform3fv(u.u_eyeHi, split.hi);
  gl.uniform3fv(u.u_eyeLo, split.lo);
  gl.uniform3f(u.u_eye, eye[0], eye[1], eye[2]);
  gl.uniform1f(u.u_bias, cam.altitude * (cam.altitude + 2)); // |eye|² − 1, without the cancellation
  if (u.u_viewport) gl.uniform2f(u.u_viewport, frame.width, frame.height);
  if (u.u_pixel) gl.uniform1f(u.u_pixel, 1 / frame.pixelRatio);
}

// ---------------------------------------------------------------------------
// Fills: one indexed triangle list with a colour per vertex
// ---------------------------------------------------------------------------

class FillRenderer {
  private prog: Program | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private pos: WebGLBuffer | null = null;
  private col: WebGLBuffer | null = null;
  private idx: WebGLBuffer | null = null;
  private indexCount = 0;

  init(gl: WebGL2RenderingContext): void {
    this.prog = makeProgram(gl, 'fill', FILL_VERT, FILL_FRAG, SURFACE_UNIFORMS);
    this.vao = gl.createVertexArray();
    this.pos = gl.createBuffer();
    this.col = gl.createBuffer();
    this.idx = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pos);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.col);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 4, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idx);
    gl.bindVertexArray(null);
    this.indexCount = 0;
  }

  upload(gl: WebGL2RenderingContext, data: AssembledAreas): void {
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pos);
    gl.bufferData(gl.ARRAY_BUFFER, data.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.col);
    gl.bufferData(gl.ARRAY_BUFFER, data.colors, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.indexCount = data.indices.length;
  }

  draw(gl: WebGL2RenderingContext, frame: FrameContext): void {
    if (!this.prog || this.indexCount === 0) return;
    gl.useProgram(this.prog.handle);
    setSurfaceUniforms(gl, this.prog, frame);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  dispose(gl: WebGL2RenderingContext): void {
    if (this.prog) gl.deleteProgram(this.prog.handle);
    if (this.vao) gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.pos);
    gl.deleteBuffer(this.col);
    gl.deleteBuffer(this.idx);
    this.prog = null;
    this.vao = null;
  }
}

// ---------------------------------------------------------------------------
// Lines: one instance per segment
// ---------------------------------------------------------------------------

class LineRenderer {
  private prog: Program | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private buf: WebGLBuffer | null = null;
  private count = 0;

  init(gl: WebGL2RenderingContext): void {
    this.prog = makeProgram(gl, 'line', LINE_VERT, LINE_FRAG, [...SURFACE_UNIFORMS, 'u_viewport', 'u_pixel']);
    this.vao = gl.createVertexArray();
    this.buf = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const stride = SEGMENT_BYTES;
    const floats = [
      [0, 3, 0],
      [1, 3, 12],
      [2, 3, 24],
      [3, 3, 36],
      [4, 3, 48],
      [5, 3, 60],
      [6, 1, 72],
    ];
    for (const [loc, size, offset] of floats) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.enableVertexAttribArray(7);
    gl.vertexAttribPointer(7, 4, gl.UNSIGNED_BYTE, true, stride, 76);
    gl.vertexAttribDivisor(7, 1);
    gl.bindVertexArray(null);
    this.count = 0;
  }

  upload(gl: WebGL2RenderingContext, data: Uint8Array, count: number): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.count = count;
  }

  draw(gl: WebGL2RenderingContext, frame: FrameContext): void {
    if (!this.prog || this.count === 0) return;
    gl.useProgram(this.prog.handle);
    setSurfaceUniforms(gl, this.prog, frame);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);
  }

  dispose(gl: WebGL2RenderingContext): void {
    if (this.prog) gl.deleteProgram(this.prog.handle);
    if (this.vao) gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.buf);
    this.prog = null;
    this.vao = null;
  }
}

// ---------------------------------------------------------------------------
// Public layers
// ---------------------------------------------------------------------------

/** Filled areas with outlines: countries, regions, a tectonic plate. */
export class AreaLayer<T = unknown> implements EngineLayer {
  private readonly assembler = new AreaAssembler<T>();
  private assembled: AssembledAreas | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private host: LayerHost | null = null;
  private fills = new FillRenderer();
  private lines = new LineRenderer();
  private uploaded = false;

  constructor(private readonly options: AssembleOptions = {}) {}

  attach(host: LayerHost): void {
    this.host = host;
  }

  setAreas(specs: AreaSpec<T>[]): void {
    this.assembled = this.assembler.assemble(specs, this.options);
    this.uploaded = false;
    this.host?.requestRender();
  }

  /** The topmost area under a geographic point. */
  pick(lat: number, lng: number): AreaSpec<T> | null {
    return this.assembler.index.at(lat, lng);
  }

  /** Every area under a point, topmost first. */
  pickAll(lat: number, lng: number): AreaSpec<T>[] {
    return this.assembler.index.all(lat, lng);
  }

  get stats(): { vertices: number; triangles: number; segments: number } {
    const a = this.assembled;
    return a ? { vertices: a.vertexCount, triangles: a.indices.length / 3, segments: a.segmentCount } : { vertices: 0, triangles: 0, segments: 0 };
  }

  init(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    this.fills.init(gl);
    this.lines.init(gl);
    this.uploaded = false;
  }

  private upload(gl: WebGL2RenderingContext): void {
    this.uploaded = true;
    const a = this.assembled;
    if (!a) return;
    this.fills.upload(gl, a);
    this.lines.upload(gl, a.segments, a.segmentCount);
  }

  draw(frame: FrameContext): void {
    const gl = frame.gl;
    if (!this.uploaded) this.upload(gl);
    setSurfaceState(gl);
    this.fills.draw(gl, frame);
    this.lines.draw(gl, frame);
  }

  dispose(gl: WebGL2RenderingContext): void {
    this.fills.dispose(gl);
    this.lines.dispose(gl);
    this.gl = null;
  }
}

export interface LineSpec<T = unknown> {
  /** Flat [lng0, lat0, lng1, lat1, ...]. */
  points: ArrayLike<number>;
  closed?: boolean;
  /** CSS colour. */
  color: string;
  /** Width in CSS pixels (below 1 the line is dimmer, not thinner). */
  width: number;
  data?: T;
}

interface StoredLine<T> {
  spec: LineSpec<T>;
  path: DensePath;
  vecs: Vec3[]; // the densified points as unit vectors, for picking
}

/** Plain lines on the surface: plate boundaries, a radius ring. */
export class LineLayer<T = unknown> implements EngineLayer {
  private lines: StoredLine<T>[] = [];
  private data: { bytes: Uint8Array; count: number } | null = null;
  private renderer = new LineRenderer();
  private host: LayerHost | null = null;
  private uploaded = false;

  constructor(private readonly stepDeg = DEFAULT_LINE_STEP_DEG) {}

  attach(host: LayerHost): void {
    this.host = host;
  }

  setLines(specs: LineSpec<T>[]): void {
    const buffer = new SegmentBuffer(2048);
    this.lines = [];
    for (const spec of specs) {
      if (spec.points.length < 4) continue;
      const path = densify(spec.points, spec.closed ?? false, this.stepDeg);
      buffer.addPath(path, spec.width, toRgba(spec.color));
      const vecs: Vec3[] = [];
      for (let i = 0; i < path.count; i++) {
        const o = i * 6;
        vecs.push([path.pts[o] + path.pts[o + 3], path.pts[o + 1] + path.pts[o + 4], path.pts[o + 2] + path.pts[o + 5]]);
      }
      this.lines.push({ spec, path, vecs });
    }
    this.data = { bytes: buffer.view(), count: buffer.count };
    this.uploaded = false;
    this.host?.requestRender();
  }

  get segmentCount(): number {
    return this.data?.count ?? 0;
  }

  /**
   * The line nearest to a geographic point, if within `toleranceDeg` of it (angular distance on the
   * sphere); the distance is returned too.
   */
  pickNear(lat: number, lng: number, toleranceDeg: number): { spec: LineSpec<T>; distanceDeg: number } | null {
    const p = geoToVec(lat, lng);
    let best: { spec: LineSpec<T>; distanceDeg: number } | null = null;
    let bestRad = toleranceDeg * DEG2RAD;
    for (const line of this.lines) {
      const v = line.vecs;
      const n = v.length;
      const segs = line.path.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const d = distanceToArc(p, v[i], v[(i + 1) % n]);
        if (d < bestRad) {
          bestRad = d;
          best = { spec: line.spec, distanceDeg: d * RAD2DEG };
        }
      }
    }
    return best;
  }

  init(gl: WebGL2RenderingContext): void {
    this.renderer.init(gl);
    this.uploaded = false;
  }

  draw(frame: FrameContext): void {
    const gl = frame.gl;
    if (!this.uploaded) {
      this.uploaded = true;
      if (this.data) this.renderer.upload(gl, this.data.bytes, this.data.count);
    }
    setSurfaceState(gl);
    this.renderer.draw(gl, frame);
  }

  dispose(gl: WebGL2RenderingContext): void {
    this.renderer.dispose(gl);
  }
}

/** Angular distance (radians) from the unit vector p to the great-circle arc a–b. */
export function distanceToArc(p: Vec3, a: Vec3, b: Vec3): number {
  const n = cross(a, b);
  const nl = Math.hypot(n[0], n[1], n[2]);
  const toA = Math.acos(Math.min(1, Math.max(-1, dot(p, a))));
  const toB = Math.acos(Math.min(1, Math.max(-1, dot(p, b))));
  if (nl < 1e-15) return Math.min(toA, toB);
  const nn = normalize(n);
  // Foot of the perpendicular on the great circle: inside the arc when it is on the same side of
  // a as b and of b as a.
  const foot = normalize([p[0] - nn[0] * dot(p, nn), p[1] - nn[1] * dot(p, nn), p[2] - nn[2] * dot(p, nn)]);
  const inside = dot(cross(a, foot), nn) >= 0 && dot(cross(foot, b), nn) >= 0;
  if (inside) return Math.abs(Math.asin(Math.min(1, Math.max(-1, dot(p, nn)))));
  return Math.min(toA, toB);
}

export { vecToGeo };
