/**
 * Math for the globe engine: vectors, rotations and 4×4 matrices. No dependencies.
 *
 * Conventions (the same as three-globe's, so existing coordinates keep their meaning,
 * but with the globe's radius as 1):
 *   - Y is up (the north pole); longitude 0 faces +Z; longitude 90°E faces +X.
 *   - A point at (lat, lng) is (cos lat · sin lng, sin lat, cos lat · cos lng).
 *   - Matrices are column-major, as WebGL expects.
 */

export type Vec3 = [number, number, number];

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const EARTH_RADIUS_KM = 6371.0088;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// ---------------------------------------------------------------------------
// Geographic ↔ cartesian
// ---------------------------------------------------------------------------

export function geoToVec(lat: number, lng: number, radius = 1): Vec3 {
  const la = lat * DEG2RAD;
  const lo = lng * DEG2RAD;
  const c = Math.cos(la) * radius;
  return [c * Math.sin(lo), Math.sin(la) * radius, c * Math.cos(lo)];
}

export function vecToGeo(v: Vec3): { lat: number; lng: number } {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return { lat: Math.asin(clamp(v[1] / len, -1, 1)) * RAD2DEG, lng: Math.atan2(v[0], v[2]) * RAD2DEG };
}

/** Wraps a longitude into [-180, 180). */
export function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/** Shortest signed longitude difference b − a, in (-180, 180]. */
export function lngDelta(a: number, b: number): number {
  const d = wrapLng(b - a);
  return d === -180 ? 180 : d;
}

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
}

/** Rodrigues rotation of `v` about the unit `axis` by `angle` radians. */
export function rotateAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = dot(axis, v) * (1 - c);
  const x = cross(axis, v);
  return [v[0] * c + x[0] * s + axis[0] * d, v[1] * c + x[1] * s + axis[1] * d, v[2] * c + x[2] * s + axis[2] * d];
}

/** Angle between two vectors, stable for tiny and for near-opposite angles. */
export function angleBetween(a: Vec3, b: Vec3): number {
  return Math.atan2(length(cross(a, b)), dot(a, b));
}

/** The rotation (unit axis, angle) that takes the direction `a` onto `b`; null when they already coincide. */
export function rotationTaking(a: Vec3, b: Vec3): { axis: Vec3; angle: number } | null {
  const c = cross(a, b);
  const s = length(c);
  const d = dot(a, b);
  if (s < 1e-12) {
    if (d > 0) return null;
    // Opposite: any axis perpendicular to `a` will do.
    const helper: Vec3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return { axis: normalize(cross(a, helper)), angle: Math.PI };
  }
  return { axis: [c[0] / s, c[1] / s, c[2] / s], angle: Math.atan2(s, d) };
}

/** Spherical interpolation between two unit vectors. */
export function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const rot = rotationTaking(a, b);
  if (!rot) return a;
  return rotateAbout(a, rot.axis, rot.angle * t);
}

/** Great-circle distance in degrees between two geographic points. */
export function arcDegrees(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return angleBetween(geoToVec(lat1, lng1), geoToVec(lat2, lng2)) * RAD2DEG;
}

// ---------------------------------------------------------------------------
// Matrices (column-major, 16 numbers)
// ---------------------------------------------------------------------------

export type Mat4 = Float32Array | number[];

/** OpenGL-style perspective projection (clip z in [-w, w]). */
export function perspective(fovY: number, aspect: number, near: number, far: number, out: Mat4 = new Float32Array(16)): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  for (let i = 0; i < 16; i++) out[i] = 0;
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

/** View matrix of a camera at `eye` whose orthonormal axes (in world space) are right, up and back (+Z of the camera). */
export function viewFromBasis(right: Vec3, up: Vec3, back: Vec3, eye: Vec3, out: Mat4 = new Float32Array(16)): Mat4 {
  out[0] = right[0];
  out[1] = up[0];
  out[2] = back[0];
  out[3] = 0;
  out[4] = right[1];
  out[5] = up[1];
  out[6] = back[1];
  out[7] = 0;
  out[8] = right[2];
  out[9] = up[2];
  out[10] = back[2];
  out[11] = 0;
  out[12] = -dot(right, eye);
  out[13] = -dot(up, eye);
  out[14] = -dot(back, eye);
  out[15] = 1;
  return out;
}

/** out = a · b (b is applied first). `out` may be a or b. */
export function multiply(a: Mat4, b: Mat4, out: Mat4 = new Float32Array(16)): Mat4 {
  const r = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let row = 0; row < 4; row++) {
      r[c * 4 + row] =
        a[row] * b[c * 4] + a[4 + row] * b[c * 4 + 1] + a[8 + row] * b[c * 4 + 2] + a[12 + row] * b[c * 4 + 3];
    }
  }
  for (let i = 0; i < 16; i++) out[i] = r[i];
  return out;
}

/** Multiplies the point (x, y, z, 1) by the matrix; returns clip coordinates [x, y, z, w]. */
export function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}

/** Inverse of a general 4×4 matrix, or null when it is singular. */
export function invert(m: Mat4, out: Mat4 = new Float32Array(16)): Mat4 | null {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}
