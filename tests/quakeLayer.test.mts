import assert from 'node:assert/strict';
import { Color, Group, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { GLOBE_RADIUS, QuakeInstances, polar2Cartesian, type LayerQuake } from '../lib/quakeLayer';

const close = (a: number, b: number, tol: number, msg: string) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const W = 1440;
const H = 900;
const style = { altitude: 0.018, radiusDeg: (q: LayerQuake) => Math.max(0.2, (q.mag ?? 1) * 0.15), color: () => '#ecc94b', resolution: 8 };
const q = (lat: number, lng: number, mag: number | null = 4): LayerQuake => ({ lat, lng, mag });

/** A camera `distance` away over (lat, lng), looking at the globe's centre. */
function cameraOver(lat: number, lng: number, distance = 300): PerspectiveCamera {
  const cam = new PerspectiveCamera(50, W / H, 0.1, 10000);
  const p = polar2Cartesian(lat, lng, distance / GLOBE_RADIUS - 1);
  cam.position.set(p.x, p.y, p.z);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  return cam;
}

/** Screen position of a point of the scene, for building expectations independently of `pick`. */
function screenOf(cam: PerspectiveCamera, v: Vector3): { x: number; y: number } {
  const p = v.clone().project(cam);
  return { x: (p.x * 0.5 + 0.5) * W, y: (-p.y * 0.5 + 0.5) * H };
}

// --- same coordinates as three-globe
{
  const o = polar2Cartesian(0, 0);
  close(o.x, 0, 1e-9, 'lat 0 lng 0: x');
  close(o.y, 0, 1e-9, 'lat 0 lng 0: y');
  close(o.z, GLOBE_RADIUS, 1e-9, 'lat 0 lng 0 faces +z');
  const e = polar2Cartesian(0, 90);
  close(e.x, GLOBE_RADIUS, 1e-9, 'lng 90 faces +x');
  const n = polar2Cartesian(90, 0);
  close(n.y, GLOBE_RADIUS, 1e-9, 'north pole is +y');
  const hi = polar2Cartesian(10, 20, 0.5);
  close(Math.hypot(hi.x, hi.y, hi.z), GLOBE_RADIUS * 1.5, 1e-9, 'relative altitude');
}

// --- one mesh, one instance per quake, standing on the surface and pointing outwards
{
  const parent = new Group();
  const layer = new QuakeInstances(parent, style);
  assert.equal(layer.object, null, 'nothing is created before there is data');
  const quakes = [q(0, 0, 5), q(45, 120, 3), q(-90, 0, 2), q(90, 0, 2)];
  layer.update(quakes, 1);
  const mesh = layer.object!;
  assert.equal(parent.children.length, 1, 'a single object in the scene');
  assert.equal(mesh.count, 4);
  quakes.forEach((k, i) => {
    const m = new Matrix4();
    mesh.getMatrixAt(i, m);
    const pos = new Vector3();
    const quat = new Quaternion();
    const scl = new Vector3();
    m.decompose(pos, quat, scl);
    const surf = polar2Cartesian(k.lat, k.lng);
    close(pos.x, surf.x, 1e-3, `quake ${i} x`);
    close(pos.y, surf.y, 1e-3, `quake ${i} y`);
    close(pos.z, surf.z, 1e-3, `quake ${i} z`);
    const up = new Vector3(0, 0, 1).applyQuaternion(quat);
    close(up.x, surf.x / GLOBE_RADIUS, 1e-3, `quake ${i} points outwards (x)`);
    close(up.y, surf.y / GLOBE_RADIUS, 1e-3, `quake ${i} points outwards (y)`);
    close(up.z, surf.z / GLOBE_RADIUS, 1e-3, `quake ${i} points outwards (z)`);
    close(scl.z, 0.018 * GLOBE_RADIUS, 1e-6, 'height');
    const expectedR = Math.max(0.2, (k.mag ?? 1) * 0.15) * ((2 * Math.PI * GLOBE_RADIUS) / 360);
    close(scl.x, expectedR, 1e-4, `quake ${i} radius`);
    close(scl.x, scl.y, 1e-4, 'round, not oval');
  });
  const c = new Color();
  mesh.getColorAt(0, c);
  assert.ok(c.r > 0.5 && c.b < 0.5, 'instance colour is set (yellow)');
  assert.doesNotThrow(() => mesh.raycast({} as any, [] as any), 'never takes part in the library ray-casting');

  // a new zoom scale only changes radii
  layer.update(quakes, 0.5);
  const m2 = new Matrix4();
  mesh.getMatrixAt(0, m2);
  const p2 = new Vector3();
  const s2 = new Vector3();
  m2.decompose(p2, new Quaternion(), s2);
  close(s2.x, 0.75 * ((2 * Math.PI * GLOBE_RADIUS) / 360) * 0.5, 1e-4, 'radius follows the zoom scale');
  close(p2.z, GLOBE_RADIUS, 1e-3, 'position unchanged by the scale');
  assert.equal(layer.object, mesh, 'the same mesh is reused');

  // the radius is clamped like three-globe does
  const big = new QuakeInstances(new Group(), { ...style, radiusDeg: () => 500 });
  big.update([q(0, 0)], 1);
  const mb = new Matrix4();
  big.object!.getMatrixAt(0, mb);
  const sb = new Vector3();
  mb.decompose(new Vector3(), new Quaternion(), sb);
  close(sb.x, 30 * ((2 * Math.PI * GLOBE_RADIUS) / 360), 1e-4, 'radius is capped at 30 degrees');

  layer.dispose();
  assert.equal(parent.children.length, 0, 'dispose removes the mesh from the scene');
}

// --- growth, shrinking and empty data
{
  const parent = new Group();
  const layer = new QuakeInstances(parent, style);
  const many = Array.from({ length: 1000 }, (_, i) => q((i % 170) - 85, (i % 350) - 175));
  layer.update(many, 1);
  assert.equal(layer.object!.count, 1000);
  const cap = layer.object!.instanceMatrix.count;
  assert.ok(cap >= 1000);
  layer.update(many.slice(0, 10), 1);
  assert.equal(layer.object!.count, 10, 'shrinks without reallocating');
  assert.equal(layer.object!.instanceMatrix.count, cap);
  layer.update([], 1);
  assert.equal(layer.object!.count, 0);
  assert.equal(layer.pick(cameraOver(0, 0), W, H, W / 2, H / 2, 6), -1, 'nothing to pick');
  const bigger = Array.from({ length: cap + 5 }, (_, i) => q((i % 100) - 50, (i % 300) - 150));
  layer.update(bigger, 1);
  assert.equal(layer.object!.count, cap + 5, 'grows past its capacity');
  assert.equal(parent.children.length, 1, 'still a single object after growing');
  layer.dispose();
}

// --- picking
{
  const parent = new Group();
  const layer = new QuakeInstances(parent, style);
  const quakes = [q(0, 0, 5), q(0, 10, 4), q(0, 180, 6), q(60, 0, 3), q(-40, -100, 4)];
  layer.update(quakes, 1);
  const cam = cameraOver(0, 0);

  // each quake is found where it is drawn: aim at the middle of its prism
  const aim = (i: number) => {
    const s = polar2Cartesian(quakes[i].lat, quakes[i].lng, 0.018 / 2);
    return screenOf(cam, new Vector3(s.x, s.y, s.z));
  };
  const centre = aim(0);
  close(centre.x, W / 2, 1, 'the globe centre is the screen centre');
  assert.equal(layer.pick(cam, W, H, centre.x, centre.y, 6), 0, 'the quake under the pointer');
  const side = aim(1);
  assert.equal(layer.pick(cam, W, H, side.x, side.y, 6), 1, 'another quake');
  assert.equal(layer.pick(cam, W, H, side.x + 1.5, side.y - 1.5, 6), 1, 'a pixel or two off still hits (slop)');
  assert.equal(layer.pick(cam, W, H, W / 2 + 200, H / 2 - 150, 6), -1, 'empty sea');

  // hit radius = drawn radius + slop: measure the edge from the geometry itself
  const drawnPx = (() => {
    const edge = polar2Cartesian(0, 0.75 * 1.0, 0.018 / 2); // 0.75 deg is this quake's radius
    return Math.abs(screenOf(cam, new Vector3(edge.x, edge.y, edge.z)).x - centre.x);
  })();
  assert.ok(drawnPx > 5, `a M5 dot is several pixels wide here (${drawnPx.toFixed(1)})`);
  assert.equal(layer.pick(cam, W, H, centre.x + drawnPx - 1, centre.y, 0), 0, 'inside the drawn disc, no slop needed');
  assert.equal(layer.pick(cam, W, H, centre.x + drawnPx + 12, centre.y, 0), -1, 'well outside the disc without slop');
  assert.equal(layer.pick(cam, W, H, centre.x + drawnPx + 5, centre.y, 8), 0, 'slop widens the target');

  // the far side of the globe is never pickable, even right behind a visible point
  const behind = layer.pick(cam, W, H, W / 2, H / 2, 6);
  assert.equal(behind, 0, 'the near quake wins at the centre, not the one at lng 180 behind it');
  const farCam = cameraOver(0, 180);
  assert.equal(layer.pick(farCam, W, H, W / 2, H / 2, 6), 2, 'seen from the other side, the lng 180 quake is picked');
  assert.equal(layer.pick(cameraOver(0, 180), W, H, W / 2, H / 2, 6) === 0, false);
  // a quake just over the limb is hidden, one just inside it is not
  const limbCam = cameraOver(0, 0, 300);
  const cosLimit = GLOBE_RADIUS / 300; // visible while cos(angle from the camera axis) > R / d
  const angleOut = (Math.acos(cosLimit) * 180) / Math.PI + 3;
  const angleIn = (Math.acos(cosLimit) * 180) / Math.PI - 3;
  const p = (lng: number) => {
    const s = polar2Cartesian(0, lng, 0.018 / 2);
    return screenOf(limbCam, new Vector3(s.x, s.y, s.z));
  };
  // (separate layers: so close to the limb the two would overlap on screen)
  const hiddenLayer = new QuakeInstances(new Group(), { ...style, radiusDeg: () => 3 });
  hiddenLayer.update([q(0, angleOut)], 1);
  assert.equal(hiddenLayer.pick(limbCam, W, H, p(angleOut).x, p(angleOut).y, 10), -1, 'just past the limb: hidden');
  const shownLayer = new QuakeInstances(new Group(), { ...style, radiusDeg: () => 3 });
  shownLayer.update([q(0, angleIn)], 1);
  assert.equal(shownLayer.pick(limbCam, W, H, p(angleIn).x, p(angleIn).y, 10), 0, 'just inside the limb: visible');

  // overlapping quakes: the one whose centre is nearest wins
  const pair = new QuakeInstances(new Group(), { ...style, radiusDeg: () => 2 });
  pair.update([q(0, 0, 4), q(0, 1, 6)], 1);
  const pa = polar2Cartesian(0, 0, 0.009);
  const pb = polar2Cartesian(0, 1, 0.009);
  const sa = screenOf(cam, new Vector3(pa.x, pa.y, pa.z));
  const sb = screenOf(cam, new Vector3(pb.x, pb.y, pb.z));
  assert.equal(pair.pick(cam, W, H, sa.x + 0.5, sa.y, 4), 0);
  assert.equal(pair.pick(cam, W, H, sb.x - 0.5, sb.y, 4), 1);
  assert.equal(pair.quakeAt(1)?.mag, 6);
  assert.equal(pair.quakeAt(2), null);
  assert.equal(pair.quakeAt(-1), null);

  // zoom scale changes the target size
  layer.update(quakes, 0.3);
  assert.equal(layer.pick(cam, W, H, centre.x + drawnPx - 1, centre.y, 0), -1, 'a smaller dot has a smaller target');

  // closer camera (zoomed in) → the same dot covers more pixels
  layer.update(quakes, 1);
  const near = cameraOver(0, 0, 112);
  const nc = aim.length ? (() => { const s = polar2Cartesian(0, 0, 0.009); return screenOf(near, new Vector3(s.x, s.y, s.z)); })() : centre;
  assert.equal(layer.pick(near, W, H, nc.x + drawnPx * 2, nc.y, 0), 0, 'zoomed in, the target grows with the dot');
  layer.dispose();
}

// --- speed: 20,000 quakes, 200 picks
{
  const layer = new QuakeInstances(new Group(), style);
  const quakes = Array.from({ length: 20000 }, (_, i) => q(((i * 37) % 170) - 85, ((i * 91) % 350) - 175, (i % 70) / 10));
  let t = performance.now();
  layer.update(quakes, 1);
  const build = performance.now() - t;
  const cam = cameraOver(10, 20);
  t = performance.now();
  for (let i = 0; i < 200; i++) layer.pick(cam, W, H, (i * 7) % W, (i * 5) % H, 6);
  const per = (performance.now() - t) / 200;
  console.log(`  20,000 quakes: build ${build.toFixed(0)} ms, pick ${per.toFixed(2)} ms each`);
  assert.ok(per < 5, `a pick over 20,000 quakes stays cheap (${per.toFixed(2)} ms)`);
  const t2 = performance.now();
  layer.update(quakes, 0.7);
  assert.ok(performance.now() - t2 < 250, 're-scaling 20,000 quakes is quick');
}

console.log('quakeLayer tests: ok');
