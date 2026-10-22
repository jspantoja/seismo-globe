import assert from 'node:assert/strict';
import {
  geoToVec,
  vecToGeo,
  wrapLng,
  lngDelta,
  rotateAbout,
  rotationTaking,
  slerp,
  angleBetween,
  arcDegrees,
  perspective,
  viewFromBasis,
  multiply,
  invert,
  transformPoint,
  dot,
  length,
  normalize,
  type Vec3,
} from '../engine/math';

const close = (a: number, b: number, tol: number, msg: string) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const closeVec = (a: ArrayLike<number>, b: ArrayLike<number>, tol: number, msg: string) => {
  for (let i = 0; i < 3; i++) close(a[i], b[i], tol, `${msg}[${i}]`);
};
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

// --- geographic conversion: same convention as three-globe (lng 0 faces +Z, 90E faces +X, north is +Y)
closeVec(geoToVec(0, 0), [0, 0, 1], 1e-12, 'lng 0');
closeVec(geoToVec(0, 90), [1, 0, 0], 1e-12, 'lng 90E');
closeVec(geoToVec(0, -90), [-1, 0, 0], 1e-12, 'lng 90W');
closeVec(geoToVec(0, 180), [0, 0, -1], 1e-12, 'antimeridian');
closeVec(geoToVec(90, 0), [0, 1, 0], 1e-12, 'north pole');
closeVec(geoToVec(-90, 123), [0, -1, 0], 1e-12, 'south pole');
closeVec(geoToVec(10, 20, 2), [2 * Math.cos(10 * Math.PI / 180) * Math.sin(20 * Math.PI / 180), 2 * Math.sin(10 * Math.PI / 180), 2 * Math.cos(10 * Math.PI / 180) * Math.cos(20 * Math.PI / 180)], 1e-12, 'radius');
for (let i = 0; i < 2000; i++) {
  const lat = rnd() * 180 - 90;
  const lng = rnd() * 360 - 180;
  const g = vecToGeo(geoToVec(lat, lng, 1 + rnd()));
  close(g.lat, lat, 1e-9, 'lat round trip');
  if (Math.abs(lat) < 89.999999) close(lngDelta(g.lng, lng), 0, 1e-8, 'lng round trip');
}
close(wrapLng(190), -170, 1e-12, 'wrap 190');
close(wrapLng(-190), 170, 1e-12, 'wrap -190');
close(wrapLng(540), -180, 1e-12, 'wrap 540');
close(wrapLng(180), -180, 1e-12, 'wrap 180');
close(lngDelta(170, -170), 20, 1e-12, 'shortest way over the antimeridian');
close(lngDelta(-170, 170), -20, 1e-12, 'and back');
close(lngDelta(0, 180), 180, 1e-12, 'half a turn');

// --- rotations
closeVec(rotateAbout([1, 0, 0], [0, 1, 0], Math.PI / 2), [0, 0, -1], 1e-12, 'right-handed about Y');
closeVec(rotateAbout([0, 0, 1], [1, 0, 0], Math.PI / 2), [0, -1, 0], 1e-12, 'right-handed about X');
for (let i = 0; i < 2000; i++) {
  const a = normalize([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]);
  const b = normalize([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]);
  const r = rotationTaking(a, b);
  assert.ok(r, 'distinct vectors have a rotation');
  closeVec(rotateAbout(a, r!.axis, r!.angle), b, 1e-9, 'rotation takes a onto b');
  close(length(r!.axis), 1, 1e-12, 'unit axis');
}
assert.equal(rotationTaking([0, 0, 1], [0, 0, 1]), null, 'identical');
const opp = rotationTaking([0, 0, 1], [0, 0, -1])!;
closeVec(rotateAbout([0, 0, 1], opp.axis, opp.angle), [0, 0, -1], 1e-9, 'opposite vectors');
close(dot(opp.axis, [0, 0, 1]), 0, 1e-9, 'axis ⟂ a for opposite vectors');
const tiny = rotationTaking([0, 0, 1], normalize([1e-9, 0, 1]))!;
close(tiny.angle, 1e-9, 1e-12, 'tiny angle is accurate');
close(angleBetween([0, 0, 1], [0, 0, -1]), Math.PI, 1e-12, 'antiparallel angle');
close(angleBetween([1, 0, 0], [0, 1, 0]), Math.PI / 2, 1e-12, 'right angle');
closeVec(slerp([1, 0, 0], [0, 1, 0], 0.5), normalize([1, 1, 0]), 1e-12, 'slerp midpoint');
closeVec(slerp([1, 0, 0], [0, 1, 0], 0), [1, 0, 0], 1e-12, 'slerp 0');
closeVec(slerp([1, 0, 0], [0, 1, 0], 1), [0, 1, 0], 1e-12, 'slerp 1');
close(length(slerp(normalize([1, 2, 3]), normalize([-3, 1, 2]), 0.37)), 1, 1e-12, 'slerp stays on the sphere');
close(arcDegrees(0, 0, 0, 90), 90, 1e-9, 'arc 90');
close(arcDegrees(0, 179.5, 0, -179.5), 1, 1e-9, 'arc across the antimeridian');
close(arcDegrees(4.711, -74.0721, 6.2442, -75.5812), 238 / 111.195, 0.04, 'Bogota - Medellin');

// --- matrices
const view = viewFromBasis([1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 3]);
const proj = perspective(Math.PI / 2, 2, 0.5, 10);
const vp = multiply(proj, view);
const origin = transformPoint(vp, 0, 0, 0);
close(origin[0] / origin[3], 0, 1e-6, 'origin projects to the screen centre x');
close(origin[1] / origin[3], 0, 1e-9, 'origin projects to the screen centre y');
close(origin[3], 3, 1e-6, 'w is the distance in front of the camera');
const edge = transformPoint(vp, 3, 0, 0); // fov 90°, aspect 2: x = 3 at distance 3 is at ndc x = 3 / (3 * 2) = 0.5
close(edge[0] / edge[3], 0.5, 1e-6, 'field of view and aspect');
const up = transformPoint(vp, 0, 3, 0);
close(up[1] / up[3], 1, 1e-6, 'vertical fov 90° puts y = distance on the top edge');
const near = transformPoint(vp, 0, 0, 3 - 0.5);
close(near[2] / near[3], -1, 1e-5, 'near plane maps to -1');
const far = transformPoint(vp, 0, 0, 3 - 10);
close(far[2] / far[3], 1, 1e-5, 'far plane maps to 1');
const inv = invert(vp)!;
const ident = multiply(inv, vp);
for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) close(ident[c * 4 + r], c === r ? 1 : 0, 1e-6, `inverse * matrix [${c},${r}]`);
assert.equal(invert(new Float32Array(16)), null, 'singular matrix');
// a camera rotated to look from +X: the globe's +X point is the closest one
const viewX = viewFromBasis([0, 0, -1], [0, 1, 0], [1, 0, 0], [3, 0, 0]);
const px = transformPoint(multiply(proj, viewX), 1, 0, 0);
close(px[3], 2, 1e-6, 'a camera on +X is 2 units from the +X surface point');

console.log('engine math tests: ok');
