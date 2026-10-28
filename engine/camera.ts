import {
  DEG2RAD,
  RAD2DEG,
  type Mat4,
  type Vec3,
  angleBetween,
  clamp,
  cross,
  dot,
  easeInOutCubic,
  geoToVec,
  invert,
  lerp,
  multiply,
  normalize,
  perspective,
  rotateAbout,
  rotationTaking,
  scale,
  slerp,
  smoothstep,
  sub,
  transformPoint,
  vecToGeo,
  viewFromBasis,
} from './math';

/**
 * The camera of a globe: it always looks at the centre of a unit sphere from a distance of
 * 1 + altitude, with an orthonormal basis (right, up, back) that can be rotated freely.
 * It knows nothing about the DOM or WebGL; time is passed in, so every motion is testable.
 *
 * Motions:
 *   - grab:    a drag keeps the surface point that was under the cursor under the cursor;
 *   - spin:    letting go of a fast drag carries on with decaying angular velocity;
 *   - zoom:    smoothed, and pinned to a screen position (the point under it stays put);
 *   - flight:  an eased great-circle flight with a rise-and-fall for long distances.
 */

export interface Pov {
  lat: number;
  lng: number;
  altitude: number;
}

export interface ScreenPoint {
  x: number; // CSS pixels from the left
  y: number; // CSS pixels from the top
  /** Normalised device depth in [-1, 1]; outside that range the point is clipped. */
  depth: number;
  /** Clip-space w: the distance in front of the camera. Not positive when the point is behind it. */
  w: number;
}

interface Flight {
  t0: number;
  duration: number;
  from: Vec3;
  to: Vec3;
  alt0: number;
  alt1: number;
  roll0: number;
  rise: number; // extra altitude factor reached half-way through a long flight
}

export const FOV_Y = 50 * DEG2RAD;
const ZOOM_TAU_MS = 85; // time constant of the zoom smoothing
const SPIN_TAU_MS = 320; // time constant of the inertia
const SPIN_MAX = 7; // rad/s
const SPIN_MIN = 0.015; // rad/s: below this the globe is considered at rest
const SPIN_WINDOW_MS = 90; // how much of the drag's end decides the release velocity

export class GlobeCamera {
  right: Vec3 = [1, 0, 0];
  up: Vec3 = [0, 1, 0];
  back: Vec3 = [0, 0, 1];
  altitude = 2.5;
  width = 1;
  height = 1;
  minAltitude = 0.004;
  maxAltitude = 6;
  readonly fovY = FOV_Y;
  /** Increases whenever the view changes. */
  version = 0;

  private flight: Flight | null = null;
  private zoomTarget: { altitude: number; pinX: number | null; pinY: number | null } | null = null;
  private spin: { axis: Vec3; omega: number } | null = null;
  private grabState: { anchor: Vec3; samples: { t: number; axis: Vec3; angle: number }[] } | null = null;
  private lastUpdate: number | null = null;

  private viewProjCache = new Float32Array(16);
  private viewProjVersion = -1;
  private viewProjWidth = 0;
  private viewProjHeight = 0;
  private invViewProjCache = new Float32Array(16);
  private rotProjCache = new Float32Array(16);
  private rotProjVersion = -1;
  private rotProjWidth = 0;
  private rotProjHeight = 0;

  constructor() {
    this.setPov({ lat: 0, lng: 0, altitude: 2.5 });
  }

  // ---------------------------------------------------------------- basic state

  setViewport(width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.version++;
  }

  get aspect(): number {
    return this.width / this.height;
  }

  /** Distance from the globe's centre to the camera. */
  get distance(): number {
    return 1 + this.altitude;
  }

  position(): Vec3 {
    return scale(this.back, this.distance);
  }

  pov(): Pov {
    const g = vecToGeo(this.back);
    return { lat: g.lat, lng: g.lng, altitude: this.altitude };
  }

  /** The "north is up" basis looking down on `back`, rolled by `roll` radians. */
  static basisFor(back: Vec3, roll = 0): { right: Vec3; up: Vec3; back: Vec3 } {
    const b = normalize(back);
    let r = cross([0, 1, 0], b);
    if (Math.hypot(r[0], r[1], r[2]) < 1e-6) {
      // Looking straight down at a pole: pick the direction of longitude 0 so the answer is continuous.
      r = [1, 0, 0];
    }
    r = normalize(r);
    const u = cross(b, r);
    if (roll === 0) return { right: r, up: u, back: b };
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    const r2: Vec3 = [r[0] * c + u[0] * s, r[1] * c + u[1] * s, r[2] * c + u[2] * s];
    return { right: r2, up: cross(b, r2), back: b };
  }

  /** How far the view is rolled away from "north up", in radians. */
  rollAngle(): number {
    const base = GlobeCamera.basisFor(this.back);
    return Math.atan2(dot(this.right, base.up), dot(this.right, base.right));
  }

  /** Jumps to a view, stopping any flight, zoom or spin that was under way. */
  setPov(p: Pov, roll = 0): void {
    this.cancelMotion();
    const b = GlobeCamera.basisFor(geoToVec(clamp(p.lat, -90, 90), p.lng), roll);
    this.right = b.right;
    this.up = b.up;
    this.back = b.back;
    this.altitude = clamp(p.altitude, this.minAltitude, this.maxAltitude);
    this.version++;
  }

  setAltitude(altitude: number): void {
    this.altitude = clamp(altitude, this.minAltitude, this.maxAltitude);
    this.version++;
  }

  private reorthonormalise(): void {
    const b = normalize(this.back);
    const r = normalize(sub(this.right, scale(b, dot(this.right, b))));
    this.back = b;
    this.right = r;
    this.up = cross(b, r);
  }

  /** Rotates the camera about the globe's centre. */
  rotateBy(axis: Vec3, angle: number): void {
    if (angle === 0) return;
    this.right = rotateAbout(this.right, axis, angle);
    this.up = rotateAbout(this.up, axis, angle);
    this.back = rotateAbout(this.back, axis, angle);
    this.reorthonormalise();
    this.version++;
  }

  // ---------------------------------------------------------------- projection

  /** Near and far planes that tightly wrap the globe (and its atmosphere) as seen from here. */
  clipPlanes(): { near: number; far: number } {
    const d = this.distance;
    return { near: Math.max(1e-4, (d - 1) * 0.35), far: d + 1.6 };
  }

  viewProjection(): Float32Array {
    if (this.viewProjVersion === this.version && this.viewProjWidth === this.width && this.viewProjHeight === this.height) {
      return this.viewProjCache;
    }
    const { near, far } = this.clipPlanes();
    const proj = perspective(this.fovY, this.aspect, near, far);
    const view = viewFromBasis(this.right, this.up, this.back, this.position());
    multiply(proj, view, this.viewProjCache);
    invert(this.viewProjCache, this.invViewProjCache);
    this.viewProjVersion = this.version;
    this.viewProjWidth = this.width;
    this.viewProjHeight = this.height;
    return this.viewProjCache;
  }

  /**
   * Projection × rotation, without the camera's translation. Used with positions made relative to
   * the camera in the shader (see eyeSplit), which keeps vertices exact at any zoom.
   */
  rotationProjection(): Float32Array {
    if (this.rotProjVersion === this.version && this.rotProjWidth === this.width && this.rotProjHeight === this.height) {
      return this.rotProjCache;
    }
    const { near, far } = this.clipPlanes();
    const proj = perspective(this.fovY, this.aspect, near, far);
    const rot = viewFromBasis(this.right, this.up, this.back, [0, 0, 0]);
    multiply(proj, rot, this.rotProjCache);
    this.rotProjVersion = this.version;
    this.rotProjWidth = this.width;
    this.rotProjHeight = this.height;
    return this.rotProjCache;
  }

  /** The camera position as two float32 vectors that add up to its float64 value. */
  eyeSplit(hi: Float32Array = new Float32Array(3), lo: Float32Array = new Float32Array(3)): { hi: Float32Array; lo: Float32Array } {
    const e = this.position();
    for (let k = 0; k < 3; k++) {
      hi[k] = e[k];
      lo[k] = e[k] - hi[k];
    }
    return { hi, lo };
  }

  /** The ray through a screen position (CSS pixels). The direction is a unit vector. */
  pixelRay(x: number, y: number): { origin: Vec3; dir: Vec3 } {
    const t = Math.tan(this.fovY / 2);
    const nx = (2 * x) / this.width - 1;
    const ny = 1 - (2 * y) / this.height;
    const cx = nx * this.aspect * t;
    const cy = ny * t;
    const dir = normalize([
      this.right[0] * cx + this.up[0] * cy - this.back[0],
      this.right[1] * cx + this.up[1] * cy - this.back[1],
      this.right[2] * cx + this.up[2] * cy - this.back[2],
    ]);
    return { origin: this.position(), dir };
  }

  /** Where the ray through a screen position meets the unit sphere, or null when it misses the globe. */
  hitSphere(x: number, y: number): Vec3 | null {
    const { origin, dir } = this.pixelRay(x, y);
    const b = dot(origin, dir);
    const c = dot(origin, origin) - 1;
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    if (t < 0) return null;
    return normalize([origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t]);
  }

  /** The sphere point under a screen position; past the edge of the globe, the nearest point of its outline. */
  groundPoint(x: number, y: number): Vec3 {
    const hit = this.hitSphere(x, y);
    if (hit) return hit;
    // Off the globe: slide along the horizon circle, in the direction of the pointer. (The point of
    // closest approach of the ray would be wrong: it moves back towards the centre the further out
    // the pointer goes.) This is continuous with the hit points at the very edge of the globe.
    const { dir } = this.pixelRay(x, y);
    const along = dot(dir, this.back);
    const lateral = normalize([dir[0] - this.back[0] * along, dir[1] - this.back[1] * along, dir[2] - this.back[2] * along]);
    const cosA = 1 / this.distance;
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    return [
      this.back[0] * cosA + lateral[0] * sinA,
      this.back[1] * cosA + lateral[1] * sinA,
      this.back[2] * cosA + lateral[2] * sinA,
    ];
  }

  /** Projects a world point to the screen. */
  project(p: Vec3, out: ScreenPoint = { x: 0, y: 0, depth: 0, w: 0 }): ScreenPoint {
    const m = this.viewProjection();
    const c = transformPoint(m, p[0], p[1], p[2]);
    const w = c[3];
    out.w = w;
    if (w <= 1e-9) {
      out.x = NaN;
      out.y = NaN;
      out.depth = 2;
      return out;
    }
    out.x = (c[0] / w * 0.5 + 0.5) * this.width;
    out.y = (1 - (c[1] / w * 0.5 + 0.5)) * this.height;
    out.depth = c[2] / w;
    return out;
  }

  /**
   * Like `project`, but the point is made relative to the camera in double precision first, so it
   * stays exact however close the camera is (the matrices are float32). Markers use this.
   */
  projectExact(p: Vec3, out: ScreenPoint = { x: 0, y: 0, depth: 0, w: 0 }): ScreenPoint {
    const e = this.position();
    const rx = p[0] - e[0];
    const ry = p[1] - e[1];
    const rz = p[2] - e[2];
    const w = -(rx * this.back[0] + ry * this.back[1] + rz * this.back[2]); // distance in front of the camera
    out.w = w;
    if (w <= 1e-9) {
      out.x = NaN;
      out.y = NaN;
      out.depth = 2;
      return out;
    }
    const t = Math.tan(this.fovY / 2);
    const cx = rx * this.right[0] + ry * this.right[1] + rz * this.right[2];
    const cy = rx * this.up[0] + ry * this.up[1] + rz * this.up[2];
    out.x = (cx / (w * t * this.aspect) * 0.5 + 0.5) * this.width;
    out.y = (0.5 - (cy / (w * t)) * 0.5) * this.height;
    const { near, far } = this.clipPlanes();
    // The same normalised depth the projection matrix gives.
    out.depth = ((far + near) / (far - near)) - (2 * far * near) / ((far - near) * w);
    return out;
  }

  /** True when a point of the unit sphere (scaled by `radius`) faces the camera, i.e. is not behind the horizon. */
  isFacing(unit: Vec3, radius = 1): boolean {
    return dot(this.position(), unit) > radius;
  }

  /** Angular radius, in radians, of the globe as seen from here. */
  horizonAngle(): number {
    return Math.asin(1 / this.distance);
  }

  /** Number of CSS pixels that one scene unit spans at the globe's surface when seen face-on. */
  pixelsPerUnit(): number {
    return this.height / (2 * Math.tan(this.fovY / 2) * (this.distance - 1));
  }

  // ---------------------------------------------------------------- grab (drag)

  beginGrab(x: number, y: number, now: number): void {
    this.cancelMotion();
    this.grabState = { anchor: this.groundPoint(x, y), samples: [] };
    void now;
  }

  /** Moves the pointer to (x, y): rotates the camera so the grabbed point is under it again. */
  dragTo(x: number, y: number, now: number): void {
    const g = this.grabState;
    if (!g) return;
    const current = this.groundPoint(x, y);
    const rot = rotationTaking(current, g.anchor);
    if (!rot) return;
    this.rotateBy(rot.axis, rot.angle);
    g.samples.push({ t: now, axis: rot.axis, angle: rot.angle });
    while (g.samples.length > 2 && now - g.samples[0].t > 250) g.samples.shift();
  }

  /** The pointer was released: the globe carries on with the velocity the drag ended with. */
  endGrab(now: number): void {
    const g = this.grabState;
    this.grabState = null;
    if (!g || g.samples.length < 2) return;
    const recent = g.samples.filter((s) => now - s.t <= SPIN_WINDOW_MS);
    if (recent.length < 2) return; // it stopped before letting go
    const span = Math.max(16, recent[recent.length - 1].t - recent[0].t + 16);
    let wx = 0;
    let wy = 0;
    let wz = 0;
    for (const s of recent) {
      wx += s.axis[0] * s.angle;
      wy += s.axis[1] * s.angle;
      wz += s.axis[2] * s.angle;
    }
    const omega = (Math.hypot(wx, wy, wz) / span) * 1000;
    if (omega < SPIN_MIN * 4) return;
    this.spin = { axis: normalize([wx, wy, wz]), omega: Math.min(SPIN_MAX, omega) };
  }

  get grabbing(): boolean {
    return this.grabState !== null;
  }

  // ---------------------------------------------------------------- zoom

  /**
   * Zooms by `factor` (< 1 comes closer). With a screen position the point of the globe
   * under it stays under it while the zoom settles.
   */
  zoomBy(factor: number, x: number | null = null, y: number | null = null): void {
    this.flight = null;
    this.spin = null;
    const base = this.zoomTarget ? this.zoomTarget.altitude : this.altitude;
    const target = clamp(base * factor, this.minAltitude, this.maxAltitude);
    this.zoomTarget = { altitude: target, pinX: x, pinY: y };
  }

  /** Zooms by `factor` right now (< 1 comes closer), about the centre: for keys held down, frame by frame. */
  zoomNow(factor: number): void {
    this.flight = null;
    this.zoomTarget = null;
    this.spin = null;
    this.altitude = clamp(this.altitude * factor, this.minAltitude, this.maxAltitude);
    this.version++;
  }

  /**
   * A two-finger gesture: zooms by `factor` and moves, so the globe point that was under the
   * previous centre of the fingers ends up under the new one.
   */
  pinch(prevX: number, prevY: number, x: number, y: number, factor: number): void {
    this.cancelMotion();
    const anchor = this.groundPoint(prevX, prevY);
    this.altitude = clamp(this.altitude * factor, this.minAltitude, this.maxAltitude);
    this.version++;
    const rot = rotationTaking(this.groundPoint(x, y), anchor);
    if (rot) this.rotateBy(rot.axis, rot.angle);
  }

  // ---------------------------------------------------------------- flights

  flyTo(target: Pov, durationMs: number, now: number): void {
    this.cancelMotion();
    const dest: Pov = { lat: clamp(target.lat, -90, 90), lng: target.lng, altitude: clamp(target.altitude, this.minAltitude, this.maxAltitude) };
    if (!(durationMs > 0)) {
      this.setPov(dest);
      return;
    }
    const to = geoToVec(dest.lat, dest.lng);
    const dist = angleBetween(this.back, to);
    this.flight = {
      t0: now,
      duration: durationMs,
      from: [...this.back] as Vec3,
      to,
      alt0: this.altitude,
      alt1: dest.altitude,
      roll0: this.rollAngle(),
      rise: 0.55 * smoothstep(0.2, 1.4, dist),
    };
  }

  cancelMotion(): void {
    this.flight = null;
    this.zoomTarget = null;
    this.spin = null;
  }

  get animating(): boolean {
    return this.flight !== null || this.zoomTarget !== null || this.spin !== null;
  }

  get flying(): boolean {
    return this.flight !== null;
  }

  // ---------------------------------------------------------------- time step

  /** Advances every running motion to `now` (milliseconds). Returns true when the view changed. */
  update(now: number): boolean {
    const before = this.version;
    const dt = this.lastUpdate === null ? 0 : clamp(now - this.lastUpdate, 0, 100);
    this.lastUpdate = now;

    if (this.flight) {
      const f = this.flight;
      const t = clamp((now - f.t0) / f.duration, 0, 1);
      const e = easeInOutCubic(t);
      const back = slerp(f.from, f.to, e);
      const lnAlt = lerp(Math.log(f.alt0), Math.log(f.alt1), e);
      const alt = Math.exp(lnAlt) * (1 + f.rise * Math.sin(Math.PI * e));
      const b = GlobeCamera.basisFor(back, f.roll0 * (1 - e));
      this.right = b.right;
      this.up = b.up;
      this.back = b.back;
      this.altitude = clamp(alt, this.minAltitude, this.maxAltitude);
      this.version++;
      if (t >= 1) {
        this.altitude = clamp(f.alt1, this.minAltitude, this.maxAltitude);
        this.flight = null;
      }
    }

    if (this.zoomTarget) {
      const z = this.zoomTarget;
      const pin = z.pinX !== null && z.pinY !== null ? this.hitSphere(z.pinX, z.pinY) : null;
      const k = 1 - Math.exp(-dt / ZOOM_TAU_MS);
      const lnNow = Math.log(this.altitude);
      const lnTarget = Math.log(z.altitude);
      const done = Math.abs(lnTarget - lnNow) < 1e-4;
      this.altitude = done ? z.altitude : Math.exp(lerp(lnNow, lnTarget, k));
      this.version++;
      if (pin) {
        // Keep the pinned surface point under the same pixel at the new altitude.
        const after = this.hitSphere(z.pinX as number, z.pinY as number);
        const rot = after ? rotationTaking(after, pin) : null;
        if (rot) this.rotateBy(rot.axis, rot.angle);
      }
      if (done) this.zoomTarget = null;
    }

    if (this.spin && dt > 0) {
      const s = this.spin;
      this.rotateBy(s.axis, (s.omega * dt) / 1000);
      s.omega *= Math.exp(-dt / SPIN_TAU_MS);
      if (s.omega < SPIN_MIN) this.spin = null;
    }

    return this.version !== before;
  }
}

/** Helper for tests and callers that need a rotation taking one geographic point to another. */
export function degreesBetween(a: Pov, b: Pov): number {
  return angleBetween(geoToVec(a.lat, a.lng), geoToVec(b.lat, b.lng)) * RAD2DEG;
}

