import assert from 'node:assert/strict';
import { GlobeCamera } from '../engine/camera';
import { quakeCulled, visibility } from '../engine/quakes';

// A small deterministic generator, so a failure can be reproduced.
let seed = 12345;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

function randomUnit(): [number, number, number] {
  const z = rnd() * 2 - 1;
  const t = rnd() * Math.PI * 2;
  const s = Math.sqrt(1 - z * z);
  return [s * Math.cos(t), z, s * Math.sin(t)];
}

const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: number[]) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** True when the segment from `eye` to `p` does not pass through the unit sphere. */
function seesPoint(eye: ArrayLike<number>, p: number[]): boolean {
  const d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
  const a = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const b = 2 * (eye[0] * d[0] + eye[1] * d[1] + eye[2] * d[2]);
  const c = eye[0] * eye[0] + eye[1] * eye[1] + eye[2] * eye[2] - 1;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return true;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return !(t > 0 && t < 1);
}

// --- visibility(): the horizon and the projection scales
{
  const v = visibility([0, 0, 3], [0, 0, 0], 0, Math.PI / 4, 2);
  assert.deepEqual(v.dir, [0, 0, 1]);
  assert.ok(Math.abs(Math.acos(v.cos) - Math.acos(1 / 3)) < 1e-12, 'with no height the cut-off is the horizon angle');
  const tall = visibility([0, 0, 3], [0, 0, 0], 0.05, Math.PI / 4, 2);
  assert.ok(Math.acos(tall.cos) > Math.acos(v.cos), 'a taller prism shows farther past the limb');
  assert.ok(Math.abs(v.fy - 1 / Math.tan(Math.PI / 8)) < 1e-12 && Math.abs(v.fx - v.fy / 2) < 1e-12);
  const near = visibility([0, 0, 1.004], [0, 0, 0], 0.001, Math.PI / 4, 1);
  assert.ok(Number.isFinite(near.cos) && Number.isFinite(near.sin));
  const onSurface = visibility([0, 0, 1], [0, 0, 0], 0, Math.PI / 4, 1);
  assert.equal(onSurface.cos, 1, 'at the surface the horizon is at the camera');
}

// --- a prism that can show a pixel is never culled (random views, sizes and heights)
{
  const cam = new GlobeCamera();
  let culled = 0;
  let kept = 0;
  let checkedVisible = 0;
  for (let trial = 0; trial < 6000; trial++) {
    const aspect = 0.5 + rnd() * 1.8;
    cam.setViewport(Math.round(400 * aspect), 400);
    cam.setPov({ lat: rnd() * 170 - 85, lng: rnd() * 360 - 180, altitude: Math.exp(Math.log(0.004) + rnd() * (Math.log(5) - Math.log(0.004))) });
    const eye = cam.position();
    const clip = cam.rotationProjection();
    const r = Math.exp(Math.log(1e-4) + rnd() * (Math.log(0.12) - Math.log(1e-4)));
    const h = 0.001 + rnd() * 0.05;
    // quakes near the view are the interesting ones: half of them are drawn within 60° of where the camera looks
    let n = randomUnit();
    if (rnd() < 0.5) {
      const d = norm([eye[0], eye[1], eye[2]]);
      const jitter = norm([d[0] + (rnd() - 0.5) * 2.2, d[1] + (rnd() - 0.5) * 2.2, d[2] + (rnd() - 0.5) * 2.2]);
      n = jitter as [number, number, number];
    }
    const isCulled = quakeCulled(n, r, h, eye, clip, cam.fovY, cam.aspect);
    if (isCulled) culled++;
    else kept++;
    if (!isCulled) continue;
    // build the prism's corner points: the base circle and the top circle, in the tangent plane of n
    const axis = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const t1 = norm(cross(axis, n));
    const t2 = cross(n, t1);
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      for (const z of [0, 1]) {
        const p = [0, 1, 2].map((i) => n[i] + (t1[i] * Math.cos(a) + t2[i] * Math.sin(a)) * r + n[i] * z * h);
        const rel = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
        const cx = clip[0] * rel[0] + clip[4] * rel[1] + clip[8] * rel[2] + clip[12];
        const cy = clip[1] * rel[0] + clip[5] * rel[1] + clip[9] * rel[2] + clip[13];
        const cw = clip[3] * rel[0] + clip[7] * rel[1] + clip[11] * rel[2] + clip[15];
        const inside = cw > 0 && Math.abs(cx) <= cw && Math.abs(cy) <= cw;
        if (inside && seesPoint(eye, p)) {
          checkedVisible++;
          assert.fail(`culled a prism with a visible corner (trial ${trial}, alt ${cam.altitude}, r ${r}, h ${h})`);
        }
      }
    }
  }
  assert.equal(checkedVisible, 0);
  assert.ok(culled > 500 && kept > 500, `both outcomes are exercised (culled ${culled}, kept ${kept})`);
}

// --- and it does cull what is plainly out of sight
{
  const cam = new GlobeCamera();
  cam.setViewport(800, 600);
  cam.setPov({ lat: 0, lng: 0, altitude: 1 });
  const eye = cam.position();
  const clip = cam.rotationProjection();
  const d = norm([eye[0], eye[1], eye[2]]);
  const front = d; // under the camera
  const back = [-d[0], -d[1], -d[2]]; // the far side of the planet
  assert.equal(quakeCulled(front, 0.01, 0.01, eye, clip, cam.fovY, cam.aspect), false, 'the point under the camera is kept');
  assert.equal(quakeCulled(back, 0.01, 0.01, eye, clip, cam.fovY, cam.aspect), true, 'the far side is culled');
  // a quake just inside the horizon stays, one well past it goes (camera 1 radius up: the horizon is at 60°)
  const rot = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    const side = norm(cross(d, Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    return [0, 1, 2].map((i) => d[i] * Math.cos(a) + side[i] * Math.sin(a));
  };
  assert.equal(quakeCulled(rot(50), 0.001, 0.001, eye, clip, cam.fovY, cam.aspect), false, '50° from the camera: inside the horizon');
  assert.equal(quakeCulled(rot(100), 0.001, 0.001, eye, clip, cam.fovY, cam.aspect), true, '100° from the camera: beyond it');
}

console.log('engineQuakeCull ok');
