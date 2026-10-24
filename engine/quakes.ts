import type { EngineLayer, FrameContext, LayerHost } from './engine';
import type { GlobeCamera } from './camera';
import { makeProgram, parseColor, type Program } from './glcore';
import { DEG2RAD, geoToVec, normalize } from './math';
import { QUAKE_FRAG, QUAKE_VERT } from './shaders';

/**
 * Earthquakes: every one is a small prism standing on the globe, all drawn with ONE instanced call.
 * The look follows the old points layer (altitude, radius in degrees of arc, a zoom scale), but the
 * work is the engine's own: the GPU places every prism from a 32-byte record, the zoom scale is a
 * uniform (rescaling costs nothing), and hover / click use a screen-space search on the CPU that
 * touches each quake once with a few multiplications.
 */

/** The old layer clamped a dot's radius at 30° of arc; so does this one. */
export const MAX_RADIUS_DEG = 30;

export interface QuakeLike {
  lat: number;
  lng: number;
  mag: number | null;
}

export interface QuakeStyle<Q> {
  /** Height of each prism, in globe radii. */
  altitude: number;
  /** Radius of each prism, in degrees of arc, before the zoom scale. */
  radiusDeg: (q: Q) => number;
  /** CSS colour. */
  color: (q: Q) => string;
  /** Levels of detail of the prism (default QUAKE_LOD). */
  lod?: QuakeLod[];
}

/**
 * A dot gets the first level whose `minPx` its radius on screen reaches, counting from the last: small
 * dots (the vast majority) are 8-sided, and a dot that grows large, close up, is smooth.
 */
export interface QuakeLod {
  sides: number;
  /** Smallest on-screen radius, in CSS pixels, that uses this level. */
  minPx: number;
}

export const QUAKE_LOD: QuakeLod[] = [
  { sides: 8, minPx: 0 },
  { sides: 16, minPx: 10 },
  { sides: 32, minPx: 28 },
];

/** Index of the first element of the ascending array that is >= `value`. */
function lowerBound(sorted: ArrayLike<number>, n: number, value: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Splits instances sorted by radius (radians, ascending) into one contiguous range per level of
 * detail, for the given zoom scale and pixels per unit of size. Level k covers [starts[k], starts[k+1]).
 */
export function lodRanges(sortedRadius: ArrayLike<number>, n: number, scale: number, pxPerUnit: number, lod: QuakeLod[] = QUAKE_LOD): number[] {
  const k = scale * pxPerUnit;
  const starts: number[] = [0];
  for (let level = 1; level < lod.length; level++) {
    // radius (radians) at which a dot reaches this level's pixel size
    starts.push(k > 1e-12 ? lowerBound(sortedRadius, n, lod[level].minPx / k) : n);
  }
  starts.push(n);
  for (let i = 1; i < starts.length; i++) if (starts[i] < starts[i - 1]) starts[i] = starts[i - 1];
  return starts;
}

/**
 * The vertices of a prism of unit radius and unit height, as a plain triangle list: per vertex its
 * local position (x, y on the unit circle, z from 0 at the base to 1 at the top) and the face
 * normal in the same frame. Side faces are flat; the base is not drawn (it is under the surface).
 */
export function prismTemplate(sides: number): { data: Float32Array; vertexCount: number } {
  const n = Math.max(3, Math.floor(sides));
  const vertexCount = n * 6 + n * 3;
  const data = new Float32Array(vertexCount * 6);
  let o = 0;
  const put = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    data[o++] = x;
    data[o++] = y;
    data[o++] = z;
    data[o++] = nx;
    data[o++] = ny;
    data[o++] = nz;
  };
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    const c0 = Math.cos(a0);
    const s0 = Math.sin(a0);
    const c1 = Math.cos(a1);
    const s1 = Math.sin(a1);
    const nx = Math.cos(am);
    const ny = Math.sin(am);
    put(c0, s0, 0, nx, ny, 0);
    put(c1, s1, 0, nx, ny, 0);
    put(c1, s1, 1, nx, ny, 0);
    put(c0, s0, 0, nx, ny, 0);
    put(c1, s1, 1, nx, ny, 0);
    put(c0, s0, 1, nx, ny, 0);
  }
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    put(0, 0, 1, 0, 0, 1);
    put(Math.cos(a0), Math.sin(a0), 1, 0, 0, 1);
    put(Math.cos(a1), Math.sin(a1), 1, 0, 0, 1);
  }
  return { data, vertexCount };
}

const INSTANCE_FLOATS = 8; // hi (3), lo (3), radius, colour (4 bytes)
const INSTANCE_BYTES = INSTANCE_FLOATS * 4;
const ORDER_SPAN = 1048576; // sort keys are radius * ORDER_SPAN + index: room for a million quakes
const MIN_HEIGHT = 0.001;

export class QuakeLayer<Q extends QuakeLike = QuakeLike> implements EngineLayer {
  private quakes: Q[] = [];
  private host: LayerHost | null = null;
  private scale = 1;
  private readonly lod: QuakeLod[];

  // CPU side: kept for picking and to rebuild the GPU buffers after a lost context.
  private unit = new Float64Array(0); // unit vector of each quake (in the order given)
  private radius = new Float32Array(0); // radians of arc, before the scale (in the order given)
  private rgb = new Uint8Array(0); // colour of each quake (in the order given)
  private order = new Uint32Array(0); // GPU instance k is quake order[k]: sorted by radius, for levels of detail
  private sortedRadius = new Float32Array(0);
  private instances = new ArrayBuffer(0);
  private f32 = new Float32Array(0);
  private u8 = new Uint8Array(0);
  private capacity = 0;
  private readonly colors = new Map<string, [number, number, number]>();

  // GPU side
  private prog: Program | null = null;
  private levels: { vao: WebGLVertexArrayObject | null; buffer: WebGLBuffer | null; vertices: number }[] = [];
  private instanceBuffer: WebGLBuffer | null = null;
  private uploaded = false;

  constructor(private readonly style: QuakeStyle<Q>) {
    this.lod = (style.lod ?? QUAKE_LOD).map((l) => ({ sides: Math.max(3, Math.floor(l.sides)), minPx: l.minPx }));
  }

  attach(host: LayerHost): void {
    this.host = host;
  }

  get count(): number {
    return this.quakes.length;
  }

  /** Height of a prism in globe radii. */
  get height(): number {
    return Math.max(this.style.altitude, MIN_HEIGHT);
  }

  get zoomScale(): number {
    return this.scale;
  }

  /** Shows these quakes. The same array again does nothing (pass `force` after changing one in place). */
  setQuakes(quakes: Q[], force = false): void {
    if (quakes === this.quakes && !force) return;
    this.quakes = quakes;
    const n = quakes.length;
    this.ensureCapacity(n);
    for (let i = 0; i < n; i++) {
      const q = quakes[i];
      const v = geoToVec(q.lat, q.lng);
      this.unit[i * 3] = v[0];
      this.unit[i * 3 + 1] = v[1];
      this.unit[i * 3 + 2] = v[2];
      const deg = Math.min(MAX_RADIUS_DEG, +this.style.radiusDeg(q));
      this.radius[i] = (Number.isFinite(deg) ? Math.max(0, deg) : 0) * DEG2RAD;
      const c = this.colorOf(this.style.color(q));
      this.rgb[i * 3] = c[0];
      this.rgb[i * 3 + 1] = c[1];
      this.rgb[i * 3 + 2] = c[2];
    }

    // GPU order: ascending radius (ties keep the given order), so each level of detail is one range.
    const keys = new Float64Array(n);
    for (let i = 0; i < n; i++) keys[i] = Math.round(this.radius[i] * 1e5) * ORDER_SPAN + i;
    keys.sort();
    const f = this.f32;
    const u8 = this.u8;
    for (let k = 0; k < n; k++) {
      const i = keys[k] % ORDER_SPAN;
      this.order[k] = i;
      this.sortedRadius[k] = this.radius[i];
      const o = k * INSTANCE_FLOATS;
      for (let c = 0; c < 3; c++) {
        const hi = Math.fround(this.unit[i * 3 + c]);
        f[o + c] = hi;
        f[o + 3 + c] = this.unit[i * 3 + c] - hi;
      }
      f[o + 6] = this.radius[i];
      const b = (o + 7) * 4;
      u8[b] = this.rgb[i * 3];
      u8[b + 1] = this.rgb[i * 3 + 1];
      u8[b + 2] = this.rgb[i * 3 + 2];
      u8[b + 3] = 255;
    }
    this.uploaded = false;
    this.host?.requestRender();
  }

  /** The zoom scale applied to every radius (1 = as styled). */
  setScale(scale: number): void {
    if (scale === this.scale) return;
    this.scale = scale;
    this.host?.requestRender();
  }

  private ensureCapacity(n: number): void {
    if (n <= this.capacity && this.capacity > 0) return;
    let cap = Math.max(64, this.capacity);
    while (cap < n) cap *= 2; // powers of two: a stream of slightly larger catalogues does not reallocate each time
    this.capacity = cap;
    this.unit = new Float64Array(cap * 3);
    this.radius = new Float32Array(cap);
    this.rgb = new Uint8Array(cap * 3);
    this.order = new Uint32Array(cap);
    this.sortedRadius = new Float32Array(cap);
    this.instances = new ArrayBuffer(cap * INSTANCE_BYTES);
    this.f32 = new Float32Array(this.instances);
    this.u8 = new Uint8Array(this.instances);
  }

  private colorOf(css: string): [number, number, number] {
    let c = this.colors.get(css);
    if (!c) {
      const p = parseColor(css);
      c = [Math.round(p[0] * 255), Math.round(p[1] * 255), Math.round(p[2] * 255)];
      this.colors.set(css, c);
    }
    return c;
  }

  // ------------------------------------------------------------------ picking

  /**
   * Index (into the array last given to `setQuakes`) of the quake under the screen position
   * (`x`, `y`), in CSS pixels from the top-left, or -1. Only quakes on the hemisphere facing the camera
   * count, so nothing behind the globe can be picked. A quake is hit when the position is within its
   * drawn radius plus `slopPx`; among several, the one whose centre is nearest wins.
   */
  pick(camera: GlobeCamera, x: number, y: number, slopPx: number): number {
    const n = this.quakes.length;
    const W = camera.width;
    const H = camera.height;
    if (n === 0 || W <= 0 || H <= 0) return -1;
    const e = camera.position();
    const [rx, ry, rz] = camera.right;
    const [ux, uy, uz] = camera.up;
    const [bx, by, bz] = camera.back;
    const tanHalf = Math.tan(camera.fovY / 2);
    const kx = 1 / (tanHalf * camera.aspect);
    const ky = 1 / tanHalf;
    const pxPerUnit = H / (2 * tanHalf); // pixels per unit of size at a distance of 1
    const mid = 1 + this.height / 2; // aim at the middle of the prism
    const scale = this.scale;
    const unit = this.unit;
    let best = -1;
    let bestD2 = Infinity;
    for (let i = 0; i < n; i++) {
      const nx = unit[i * 3];
      const ny = unit[i * 3 + 1];
      const nz = unit[i * 3 + 2];
      // A surface point faces the camera when the camera is above its tangent plane.
      if (e[0] * nx + e[1] * ny + e[2] * nz <= 1) continue;
      const px = nx * mid - e[0];
      const py = ny * mid - e[1];
      const pz = nz * mid - e[2];
      const depth = -(px * bx + py * by + pz * bz);
      if (depth <= 1e-9) continue;
      const sx = (((px * rx + py * ry + pz * rz) * kx) / depth * 0.5 + 0.5) * W;
      const sy = (0.5 - (((px * ux + py * uy + pz * uz) * ky) / depth) * 0.5) * H;
      const dx = sx - x;
      const dy = sy - y;
      const d2 = dx * dx + dy * dy;
      const reach = (this.radius[i] * scale * pxPerUnit) / depth + slopPx;
      if (d2 <= reach * reach && d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return best;
  }

  /** The packed instance records exactly as the GPU receives them (for tests). */
  debugInstances(): { floats: Float32Array; bytes: Uint8Array; count: number; capacity: number; order: Uint32Array } {
    const n = this.quakes.length;
    return { floats: this.f32.subarray(0, n * INSTANCE_FLOATS), bytes: this.u8.subarray(0, n * INSTANCE_BYTES), count: n, capacity: this.capacity, order: this.order.subarray(0, n) };
  }

  /** The instance ranges of each level of detail for a camera (for tests and the lab). */
  lodStarts(camera: GlobeCamera): number[] {
    return lodRanges(this.sortedRadius, this.quakes.length, this.scale, camera.pixelsPerUnit(), this.lod);
  }

  quakeAt(index: number): Q | null {
    return index >= 0 && index < this.quakes.length ? this.quakes[index] : null;
  }

  /** The quake under a screen position, or null. */
  pickQuake(camera: GlobeCamera, x: number, y: number, slopPx: number): Q | null {
    return this.quakeAt(this.pick(camera, x, y, slopPx));
  }

  // ------------------------------------------------------------------ GPU

  init(gl: WebGL2RenderingContext): void {
    this.prog = makeProgram(gl, 'quake', QUAKE_VERT, QUAKE_FRAG, ['u_mvp', 'u_eyeHi', 'u_eyeLo', 'u_scale', 'u_height', 'u_light']);
    this.instanceBuffer = gl.createBuffer();
    this.levels = this.lod.map((l) => {
      const tmpl = prismTemplate(l.sides);
      const vao = gl.createVertexArray();
      const buffer = gl.createBuffer();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, tmpl.data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      for (const loc of [2, 3, 4, 5]) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribDivisor(loc, 1);
      }
      gl.bindVertexArray(null);
      return { vao, buffer, vertices: tmpl.vertexCount };
    });
    this.uploaded = false;
  }

  /** Points the per-instance attributes of the bound VAO at the records starting at instance `first`. */
  private pointInstances(gl: WebGL2RenderingContext, first: number): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    const base = first * INSTANCE_BYTES;
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, INSTANCE_BYTES, base);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, INSTANCE_BYTES, base + 12);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, INSTANCE_BYTES, base + 24);
    gl.vertexAttribPointer(5, 4, gl.UNSIGNED_BYTE, true, INSTANCE_BYTES, base + 28);
  }

  draw(frame: FrameContext): void {
    const prog = this.prog;
    const n = this.quakes.length;
    if (!prog || n === 0 || this.levels.length === 0) return;
    const gl = frame.gl;
    if (!this.uploaded) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.f32.subarray(0, n * INSTANCE_FLOATS), gl.STATIC_DRAW);
      this.uploaded = true;
    }
    const cam = frame.camera;
    const u = prog.uniforms;
    gl.useProgram(prog.handle);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.CULL_FACE);
    const split = cam.eyeSplit(scratchHi, scratchLo);
    const light = normalize([cam.right[0] + cam.up[0] + cam.back[0], cam.right[1] + cam.up[1] + cam.back[1], cam.right[2] + cam.up[2] + cam.back[2]]);
    gl.uniformMatrix4fv(u.u_mvp, false, cam.rotationProjection());
    gl.uniform3fv(u.u_eyeHi, split.hi);
    gl.uniform3fv(u.u_eyeLo, split.lo);
    gl.uniform1f(u.u_scale, this.scale);
    gl.uniform1f(u.u_height, this.height);
    gl.uniform3f(u.u_light, light[0], light[1], light[2]);
    const starts = lodRanges(this.sortedRadius, n, this.scale, cam.pixelsPerUnit(), this.lod);
    for (let level = 0; level < this.levels.length; level++) {
      const from = starts[level];
      const count = starts[level + 1] - from;
      if (count <= 0) continue;
      const l = this.levels[level];
      gl.bindVertexArray(l.vao);
      this.pointInstances(gl, from);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, l.vertices, count);
    }
    gl.bindVertexArray(null);
  }

  dispose(gl: WebGL2RenderingContext): void {
    if (this.prog) gl.deleteProgram(this.prog.handle);
    for (const l of this.levels) {
      if (l.vao) gl.deleteVertexArray(l.vao);
      if (l.buffer) gl.deleteBuffer(l.buffer);
    }
    if (this.instanceBuffer) gl.deleteBuffer(this.instanceBuffer);
    this.prog = null;
    this.levels = [];
    this.instanceBuffer = null;
  }
}

const scratchHi = new Float32Array(3);
const scratchLo = new Float32Array(3);
