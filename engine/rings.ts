import type { EngineLayer, FrameContext, LayerHost } from './engine';
import { makeProgram, parseColor, type Program } from './glcore';
import { DEG2RAD } from './math';
import { LINE_FRAG, RING_VERT } from './shaders';
import { setSurfaceState, setSurfaceUniforms } from './surface';

/**
 * Pulsing rings around the freshest quakes: a circle that grows from the epicentre and fades as it
 * goes, a new one every `periodMs`. Same semantics as the old layer: the final radius is in degrees
 * of arc, the speed in degrees per second, the opacity falls linearly from `opacity` to 0.
 *
 * Nothing is uploaded per frame. A ring "slot" is one GPU instance that knows when it was born; the
 * shader derives age, radius and opacity from the clock. A quake needs ceil(life / period) slots,
 * so a few instances per quake keep it pulsing for ever. Rings of a quake that was already there
 * when the list changes carry on undisturbed; a new quake's first ring starts at its centre.
 */

export const RING_PERIOD_MS = 1100;
export const RING_MAX_SLOTS = 8;
/** The old layer's peak opacity: (200 / 255). */
export const RING_OPACITY = 200 / 255;
/** Every cycle length (k × period, k ≤ 8) divides this many periods, so the clock can wrap exactly. */
export const RING_CLOCK_PERIODS = 840; // lcm(1..8)

export interface RingSpec {
  /** Identity: a ring set that keeps its key (and parameters) is not restarted by a new list. */
  key: string | number;
  lat: number;
  lng: number;
  /** Radius a ring reaches before it disappears, in degrees of arc. */
  maxRadiusDeg: number;
  /** How fast a ring grows, in degrees per second. */
  speedDegPerSec: number;
  /** CSS colour. */
  color: string;
}

export interface RingOptions {
  periodMs?: number;
  /** Ribbon width in CSS pixels. */
  widthPx?: number;
  opacity?: number;
  /** Clock in milliseconds; defaults to performance.now() (tests inject their own). */
  clock?: () => number;
}

/** How long a ring lives, how many slots a quake needs, and the length of the repeating cycle. */
export function ringPlan(maxRadiusDeg: number, speedDegPerSec: number, periodMs: number): { lifeMs: number; slots: number; cycleMs: number } {
  const speed = speedDegPerSec > 0 ? speedDegPerSec : 1;
  const radius = maxRadiusDeg > 0 ? maxRadiusDeg : 1;
  let lifeMs = (radius / speed) * 1000;
  const slots = Math.min(RING_MAX_SLOTS, Math.max(1, Math.ceil(lifeMs / periodMs - 1e-9)));
  const cycleMs = slots * periodMs;
  if (lifeMs > cycleMs) lifeMs = cycleMs; // a ring never lives longer than the longest cycle allowed
  return { lifeMs, slots, cycleMs };
}

/** One ring slot, as the GPU receives it. */
export interface RingSlot {
  /** Added to the clock before wrapping into the cycle. */
  t0: number;
  cycle: number;
  life: number;
  /** Final radius, radians. */
  maxRho: number;
  /** The clock time before which this slot stays hidden (its first birth). */
  start: number;
}

export interface RingState {
  active: boolean;
  /** 0 at birth, 1 at death. */
  f: number;
  /** Angular radius, radians. */
  rho: number;
  /** Fraction of the peak opacity. */
  fade: number;
}

/** The vertex shader's arithmetic, on the CPU: what a slot looks like at a clock time. */
export function ringState(slot: RingSlot, clockMs: number): RingState {
  const m = (clockMs + slot.t0) % slot.cycle;
  const age = m < 0 ? m + slot.cycle : m;
  if (age >= slot.life || clockMs - age < slot.start - 0.5) return { active: false, f: 0, rho: 0, fade: 0 };
  const f = age / slot.life;
  return { active: true, f, rho: slot.maxRho * f, fade: 1 - f };
}

/** The slots of one ring set born at clock time `start`. */
export function ringSlots(spec: Pick<RingSpec, 'maxRadiusDeg' | 'speedDegPerSec'>, periodMs: number, start: number): RingSlot[] {
  const plan = ringPlan(spec.maxRadiusDeg, spec.speedDegPerSec, periodMs);
  const maxRho = Math.max(0, spec.maxRadiusDeg) * DEG2RAD;
  const out: RingSlot[] = [];
  const base = start % plan.cycleMs;
  for (let j = 0; j < plan.slots; j++) {
    out.push({ t0: -base - j * periodMs, cycle: plan.cycleMs, life: plan.lifeMs, maxRho, start: start + j * periodMs });
  }
  return out;
}

const SLOT_FLOATS = 12; // hi (3), lo (3), time (4), start, colour (4 bytes)
const SLOT_BYTES = SLOT_FLOATS * 4;

interface Entry {
  spec: RingSpec;
  start: number;
  slots: RingSlot[];
}

function sameParams(a: RingSpec, b: RingSpec): boolean {
  return a.lat === b.lat && a.lng === b.lng && a.maxRadiusDeg === b.maxRadiusDeg && a.speedDegPerSec === b.speedDegPerSec && a.color === b.color;
}

export class RingLayer implements EngineLayer {
  private entries = new Map<string | number, Entry>();
  private host: LayerHost | null = null;
  private readonly period: number;
  private readonly width: number;
  private readonly opacity: number;
  private readonly clockFn: () => number;
  private epoch: number;
  private animated = true;

  private data = new ArrayBuffer(0);
  private f32 = new Float32Array(0);
  private u8 = new Uint8Array(0);
  private instanceCount = 0;
  private maxRho = 0;

  private prog: Program | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private buf: WebGLBuffer | null = null;
  private uploaded = false;
  private lastSegments = 0;

  constructor(options: RingOptions = {}) {
    this.period = options.periodMs ?? RING_PERIOD_MS;
    this.width = options.widthPx ?? 1.5;
    this.opacity = options.opacity ?? RING_OPACITY;
    this.clockFn = options.clock ?? (() => performance.now());
    this.epoch = this.clockFn();
  }

  attach(host: LayerHost): void {
    this.host = host;
  }

  /** The layer's own clock, in milliseconds since it was created. */
  now(): number {
    return this.clockFn() - this.epoch;
  }

  /** The layer clock for a given frame time (the `now` of a FrameContext). */
  clockAt(frameNow: number): number {
    return frameNow - this.epoch;
  }

  /** Replaces the set of rings. */
  setRings(specs: RingSpec[]): void {
    const now = this.now();
    const next = new Map<string | number, Entry>();
    for (const spec of specs) {
      const old = this.entries.get(spec.key);
      if (old && sameParams(old.spec, spec)) {
        next.set(spec.key, old);
      } else {
        next.set(spec.key, { spec, start: now, slots: ringSlots(spec, this.period, now) });
      }
    }
    this.entries = next;
    this.pack();
    this.host?.requestRender();
  }

  /** Rings animate unless this is turned off (then none are drawn: for people who ask for less motion). */
  setAnimated(on: boolean): void {
    if (on === this.animated) return;
    this.animated = on;
    this.host?.requestRender();
  }

  get slotCount(): number {
    return this.instanceCount;
  }

  /** Every slot of every ring (for tests). */
  allSlots(): { spec: RingSpec; slot: RingSlot }[] {
    const out: { spec: RingSpec; slot: RingSlot }[] = [];
    for (const e of this.entries.values()) for (const slot of e.slots) out.push({ spec: e.spec, slot });
    return out;
  }

  private pack(): void {
    let n = 0;
    for (const e of this.entries.values()) n += e.slots.length;
    if (n * SLOT_BYTES > this.data.byteLength) {
      this.data = new ArrayBuffer(Math.max(16, n) * SLOT_BYTES * 2);
      this.f32 = new Float32Array(this.data);
      this.u8 = new Uint8Array(this.data);
    }
    const f = this.f32;
    let i = 0;
    let maxRho = 0;
    for (const e of this.entries.values()) {
      const spec = e.spec;
      const la = spec.lat * DEG2RAD;
      const lo = spec.lng * DEG2RAD;
      const c = Math.cos(la);
      const v = [c * Math.sin(lo), Math.sin(la), c * Math.cos(lo)];
      const col = parseColor(spec.color);
      for (const slot of e.slots) {
        const o = i * SLOT_FLOATS;
        for (let k = 0; k < 3; k++) {
          const hi = Math.fround(v[k]);
          f[o + k] = hi;
          f[o + 3 + k] = v[k] - hi;
        }
        f[o + 6] = slot.t0;
        f[o + 7] = slot.cycle;
        f[o + 8] = slot.life;
        f[o + 9] = slot.maxRho;
        f[o + 10] = slot.start;
        const b = (o + 11) * 4;
        this.u8[b] = Math.round(col[0] * 255);
        this.u8[b + 1] = Math.round(col[1] * 255);
        this.u8[b + 2] = Math.round(col[2] * 255);
        this.u8[b + 3] = 255;
        if (slot.maxRho > maxRho) maxRho = slot.maxRho;
        i++;
      }
    }
    this.instanceCount = n;
    this.maxRho = maxRho;
    this.uploaded = false;
  }

  animating(): boolean {
    return this.animated && this.instanceCount > 0;
  }

  // ------------------------------------------------------------------ GPU

  init(gl: WebGL2RenderingContext): void {
    this.prog = makeProgram(gl, 'ring', RING_VERT, LINE_FRAG, [
      'u_mvp',
      'u_eyeHi',
      'u_eyeLo',
      'u_eye',
      'u_bias',
      'u_viewport',
      'u_pixel',
      'u_time',
      'u_clock',
      'u_segments',
      'u_width',
      'u_alpha',
    ]);
    this.vao = gl.createVertexArray();
    this.buf = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const attribs: [number, number, number][] = [
      [0, 3, 0],
      [1, 3, 12],
      [2, 4, 24],
      [3, 1, 40],
    ];
    for (const [loc, size, offset] of attribs) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, SLOT_BYTES, offset);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, true, SLOT_BYTES, 44);
    gl.vertexAttribDivisor(4, 1);
    gl.bindVertexArray(null);
    this.uploaded = false;
  }

  /**
   * Steps around a circle for the current zoom: enough that the chord of a step strays less than a
   * quarter of a pixel from the true circle (sag = R·(1 − cos(π/N)) ≈ R·π²/2N², so N ≈ 4.4·√R).
   * Close up a ring is thousands of pixels wide, so this goes up to 1024 steps; the cost is a few
   * hundred thousand vertices for the whole set, which a GPU does not notice.
   */
  segmentsFor(frame: FrameContext): number {
    const radiusPx = Math.min(60000, this.maxRho * frame.camera.pixelsPerUnit());
    const wanted = Math.ceil((4.5 * Math.sqrt(Math.max(radiusPx, 1))) / 8) * 8;
    return Math.min(1024, Math.max(48, wanted));
  }

  draw(frame: FrameContext): void {
    const prog = this.prog;
    const n = this.instanceCount;
    if (!prog || n === 0 || !this.animated) return;
    const gl = frame.gl;
    if (!this.uploaded) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.bufferData(gl.ARRAY_BUFFER, this.f32.subarray(0, n * SLOT_FLOATS), gl.STATIC_DRAW);
      this.uploaded = true;
    }
    const clock = frame.now - this.epoch;
    const wrap = this.period * RING_CLOCK_PERIODS;
    const segments = this.segmentsFor(frame);
    this.lastSegments = segments;
    setSurfaceState(gl);
    gl.useProgram(prog.handle);
    setSurfaceUniforms(gl, prog, frame);
    const u = prog.uniforms;
    gl.uniform1f(u.u_time, clock % wrap);
    gl.uniform1f(u.u_clock, clock);
    gl.uniform1f(u.u_segments, segments);
    gl.uniform1f(u.u_width, this.width);
    gl.uniform1f(u.u_alpha, this.opacity);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 2 * (segments + 1), n);
    gl.bindVertexArray(null);
  }

  /** Segments used by the last frame (for tests and the lab). */
  get segments(): number {
    return this.lastSegments;
  }

  dispose(gl: WebGL2RenderingContext): void {
    if (this.prog) gl.deleteProgram(this.prog.handle);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.buf) gl.deleteBuffer(this.buf);
    this.prog = null;
    this.vao = null;
    this.buf = null;
  }
}
