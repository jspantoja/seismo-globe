import assert from 'node:assert/strict';
import { GlobeCamera, degreesBetween } from '../engine/camera';
import { angleBetween, dot, geoToVec, length, cross, normalize, lngDelta, RAD2DEG, type Vec3 } from '../engine/math';

const close = (a: number, b: number, tol: number, msg: string) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const closeVec = (a: ArrayLike<number>, b: ArrayLike<number>, tol: number, msg: string) => {
  for (let i = 0; i < 3; i++) close(a[i], b[i], tol, `${msg}[${i}]`);
};
let seed = 777;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

const W = 1440;
const H = 900;
function camera(lat = 0, lng = 0, alt = 2.5): GlobeCamera {
  const c = new GlobeCamera();
  c.setViewport(W, H);
  c.setPov({ lat, lng, altitude: alt });
  return c;
}
function orthonormal(c: GlobeCamera, msg: string) {
  close(length(c.right), 1, 1e-9, `${msg}: |right|`);
  close(length(c.up), 1, 1e-9, `${msg}: |up|`);
  close(length(c.back), 1, 1e-9, `${msg}: |back|`);
  close(dot(c.right, c.up), 0, 1e-9, `${msg}: right ⟂ up`);
  close(dot(c.right, c.back), 0, 1e-9, `${msg}: right ⟂ back`);
  close(dot(c.up, c.back), 0, 1e-9, `${msg}: up ⟂ back`);
  closeVec(cross(c.right, c.up), c.back, 1e-9, `${msg}: right-handed`);
}

// --- pov round trips, including the poles and the antimeridian
for (const [lat, lng, alt] of [[0, 0, 2.5], [45, 120, 0.3], [-33, -72, 1], [10, 179.9, 0.05], [-10, -179.9, 4], [89.99, 33, 0.5]] as const) {
  const c = camera(lat, lng, alt);
  const p = c.pov();
  close(p.lat, lat, 1e-9, 'lat');
  close(lngDelta(p.lng, lng), 0, 1e-9, 'lng');
  close(p.altitude, alt, 1e-12, 'altitude');
  orthonormal(c, `pov ${lat},${lng}`);
  closeVec(c.back, geoToVec(lat, lng), 1e-12, 'looks at the requested point');
  close(c.rollAngle(), 0, 1e-9, 'north is up');
}
for (const lat of [90, -90]) {
  const c = camera(lat, 40, 1);
  orthonormal(c, `pole ${lat}`);
  close(c.pov().lat, lat, 1e-9, 'pole latitude');
}
{
  const c = camera(0, 0, 100);
  assert.equal(c.pov().altitude, c.maxAltitude, 'altitude is clamped to the maximum');
  c.setPov({ lat: 0, lng: 0, altitude: 0 });
  assert.equal(c.pov().altitude, c.minAltitude, 'and to the minimum');
}

// --- rays, hits and projection are consistent
{
  const c = camera(20, -60, 1.2);
  const centre = c.hitSphere(W / 2, H / 2)!;
  closeVec(centre, c.back, 1e-12, 'the screen centre looks at the globe point under the camera');
  assert.equal(c.hitSphere(2, 2), null, 'a corner misses the globe');
  const limb = c.groundPoint(2, 2);
  close(length(limb), 1, 1e-12, 'off-globe ground point is on the sphere');
  close(dot(limb, c.back), 1 / c.distance, 1e-9, 'and on the horizon circle');
  for (let i = 0; i < 500; i++) {
    const x = W * (0.3 + 0.4 * rnd());
    const y = H * (0.2 + 0.6 * rnd());
    const hit = c.hitSphere(x, y);
    if (!hit) continue;
    const s = c.project(hit);
    close(s.x, x, 1e-3, 'project(hit) x');
    close(s.y, y, 1e-3, 'project(hit) y');
    assert.ok(c.isFacing(hit), 'a hit point faces the camera');
    assert.ok(s.depth > -1 && s.depth < 1, 'inside the depth range');
  }
  // the far side faces away and projects behind the globe
  assert.equal(c.isFacing([-c.back[0], -c.back[1], -c.back[2]]), false, 'the antipode does not face the camera');
  const behind = c.project([0, 0, 0]);
  assert.ok(behind.w > 0 && Math.abs(behind.x - W / 2) < 1e-3, 'the globe centre is at the screen centre');
  const wide = camera(0, 0, 0.5);
  assert.ok(wide.horizonAngle() < Math.PI / 2 && wide.horizonAngle() > 0, 'horizon angle');
  close(wide.horizonAngle(), Math.asin(1 / 1.5), 1e-12, 'horizon angle formula');
  const { near, far } = camera(0, 0, 0.004).clipPlanes();
  assert.ok(near > 0 && near < 0.004, 'near plane is in front of the surface even at the minimum altitude');
  assert.ok(far > 2.004, 'far plane is behind the globe');
  const farCam = camera(0, 0, 6).clipPlanes();
  assert.ok(farCam.near < 6 && farCam.far > 8, 'planes at maximum altitude');
}

// --- grab: the point that was grabbed stays under the pointer
for (const alt of [3, 2.5, 1, 0.3, 0.05, 0.008]) {
  for (let trial = 0; trial < 40; trial++) {
    const c = camera(rnd() * 140 - 70, rnd() * 360 - 180, alt);
    let sx = W * (0.35 + 0.3 * rnd());
    let sy = H * (0.3 + 0.4 * rnd());
    if (!c.hitSphere(sx, sy)) continue;
    const anchor = c.groundPoint(sx, sy);
    c.beginGrab(sx, sy, 0);
    let t = 0;
    for (let step = 0; step < 30; step++) {
      sx += (rnd() - 0.45) * 25;
      sy += (rnd() - 0.5) * 18;
      sx = Math.min(W - 5, Math.max(5, sx));
      sy = Math.min(H - 5, Math.max(5, sy));
      t += 16;
      c.dragTo(sx, sy, t);
      const under = c.hitSphere(sx, sy);
      if (under) closeVec(under, anchor, 1e-7, `alt ${alt}: the grabbed point is still under the pointer`);
    }
    orthonormal(c, `after dragging at alt ${alt}`);
    c.endGrab(t + 500);
  }
}
{
  // Dragging past the edge of the globe stays finite and keeps the basis valid.
  const c = camera(30, 10, 2.5);
  c.beginGrab(W / 2, H / 2, 0);
  for (let i = 1; i <= 40; i++) c.dragTo(W / 2 + i * 30, H / 2 - i * 10, i * 16);
  orthonormal(c, 'dragged off the globe');
  assert.ok(Number.isFinite(c.pov().lat) && Number.isFinite(c.pov().lng), 'finite pov');
  // A drag that goes right over a pole must not flip or jump.
  const p = camera(80, 0, 1.5);
  p.beginGrab(W / 2, H / 2, 0);
  let prev = p.pov();
  let crossed = false;
  for (let i = 1; i <= 40; i++) {
    p.dragTo(W / 2, H / 2 + i * 8, i * 16);
    const now = p.pov();
    assert.ok(degreesBetween(prev, now) < 2, `no jump while dragging over the pole (${degreesBetween(prev, now).toFixed(2)}° at step ${i})`);
    if (Math.abs(lngDelta(prev.lng, now.lng)) > 90) crossed = true; // the longitude flips as the view passes over the pole
    prev = now;
  }
  assert.ok(crossed, 'the drag really went over the pole');
  orthonormal(p, 'over the pole');
}

// --- a grabbed point under a stationary pointer does not move the camera
{
  const c = camera(10, 10, 1);
  const before = c.pov();
  c.beginGrab(700, 400, 0);
  c.dragTo(700, 400, 16);
  c.endGrab(32);
  assert.deepEqual(c.pov(), before, 'no movement, no change');
  assert.equal(c.animating, false, 'and no inertia');
}

// --- inertia: a fast drag released while moving keeps going, then comes to rest
{
  const c = camera(0, 0, 1);
  c.beginGrab(900, 450, 0);
  let t = 0;
  for (let i = 1; i <= 12; i++) {
    t += 16;
    c.dragTo(900 - i * 22, 450, t);
  }
  const atRelease = c.pov();
  c.endGrab(t + 4);
  assert.ok(c.animating, 'it keeps spinning after release');
  let now = t + 4;
  c.update(now); // first update only records the time
  let frames = 0;
  while (c.animating && frames < 1000) {
    now += 16;
    c.update(now);
    frames++;
  }
  assert.ok(frames > 10, `it coasts for a while (${frames} frames)`);
  assert.ok(frames < 400, `and stops by itself (${frames} frames)`);
  const travelled = degreesBetween(atRelease, c.pov());
  assert.ok(travelled > 0.5, `it travelled further (${travelled.toFixed(2)}°)`);
  orthonormal(c, 'after the spin');
  // dragging left moves the globe left: the camera's longitude increases
  assert.ok(lngDelta(atRelease.lng, c.pov().lng) > 0, 'direction of the spin follows the drag');
}
{
  // Stopping before letting go leaves no inertia.
  const c = camera(0, 0, 1);
  c.beginGrab(900, 450, 0);
  for (let i = 1; i <= 10; i++) c.dragTo(900 - i * 22, 450, i * 16);
  c.dragTo(900 - 220, 450, 400);
  c.endGrab(800); // 640 ms after the last movement
  assert.equal(c.animating, false, 'a drag that paused before release does not coast');
}
{
  // Starting a new drag stops the coasting.
  const c = camera(0, 0, 1);
  c.beginGrab(900, 450, 0);
  for (let i = 1; i <= 12; i++) c.dragTo(900 - i * 22, 450, i * 16);
  c.endGrab(200);
  assert.ok(c.animating);
  c.beginGrab(500, 400, 210);
  assert.equal(c.animating, false, 'touching the globe stops it');
}

// --- zoom
{
  const c = camera(0, 0, 2);
  c.zoomBy(0.5);
  let now = 0;
  c.update(now);
  let frames = 0;
  while (c.animating && frames < 500) {
    now += 16;
    c.update(now);
    frames++;
  }
  close(c.pov().altitude, 1, 1e-9, 'settles exactly at the target');
  assert.ok(frames > 5 && frames < 120, `smooth, not instantaneous (${frames} frames)`);
  c.zoomBy(0.5);
  c.zoomBy(0.5); // wheel ticks accumulate
  now += 16;
  c.update(now);
  while (c.animating) {
    now += 16;
    c.update(now);
  }
  close(c.pov().altitude, 0.25, 1e-9, 'accumulated zoom');
  c.zoomBy(1e-9);
  while (c.animating) {
    now += 16;
    c.update(now);
  }
  assert.equal(c.pov().altitude, c.minAltitude, 'zoom is limited at the minimum');
  c.zoomBy(1e9);
  while (c.animating) {
    now += 16;
    c.update(now);
  }
  assert.equal(c.pov().altitude, c.maxAltitude, 'and at the maximum');
}
for (const alt of [2.5, 1, 0.3]) {
  // zoom pinned to a pixel: the globe point under it does not move
  const c = camera(15, 40, alt);
  const px = W * 0.62;
  const py = H * 0.4;
  const anchor = c.hitSphere(px, py);
  assert.ok(anchor, 'pin is over the globe');
  c.zoomBy(0.2, px, py);
  let now = 0;
  c.update(now);
  for (let i = 0; i < 400 && c.animating; i++) {
    now += 16;
    c.update(now);
    const under = c.hitSphere(px, py);
    assert.ok(under, 'still over the globe');
    closeVec(under!, anchor!, 1e-7, 'the pinned point stays under the pixel during the zoom');
  }
  close(c.pov().altitude, Math.max(c.minAltitude, alt * 0.2), 1e-9, 'pinned zoom reaches its altitude');
  // zooming out pinned at the same pixel also keeps the point
  const anchor2 = c.hitSphere(px, py)!;
  c.zoomBy(3, px, py);
  c.update(now + 16);
  now += 16;
  for (let i = 0; i < 400 && c.animating; i++) {
    now += 16;
    c.update(now);
    const under = c.hitSphere(px, py);
    if (under) closeVec(under, anchor2, 1e-6, 'zooming out is pinned too');
  }
}
{
  // A pin outside the globe falls back to zooming about the centre.
  const c = camera(0, 0, 2);
  c.zoomBy(0.5, 3, 3);
  let now = 0;
  c.update(now);
  while (c.animating) {
    now += 16;
    c.update(now);
  }
  close(c.pov().lat, 0, 1e-9, 'centre unchanged');
  close(c.pov().altitude, 1, 1e-9, 'altitude reached');
}

// --- pinch: the point under the old centre of the fingers ends up under the new one
for (const alt of [2.5, 0.8, 0.1]) {
  const c = camera(25, -40, alt);
  const anchor = c.groundPoint(600, 380);
  c.pinch(600, 380, 640, 360, 0.8);
  close(c.pov().altitude, alt * 0.8, 1e-12, 'pinch zooms');
  const now = c.groundPoint(640, 360);
  closeVec(now, anchor, 1e-7, `pinch carries the anchor to the new centre (alt ${alt})`);
  orthonormal(c, 'pinch');
  c.pinch(640, 360, 640, 360, 1e-9);
  assert.equal(c.pov().altitude, c.minAltitude, 'pinch is limited too');
}

// --- flights
{
  const c = camera(0, 0, 2.5);
  c.flyTo({ lat: 40, lng: -100, altitude: 0.4 }, 1200, 1000);
  assert.ok(c.flying && c.animating);
  c.update(1000);
  let prevDist = -1;
  let maxAlt = 0;
  for (let t = 1016; t <= 2300; t += 16) {
    c.update(t);
    const d = degreesBetween({ lat: 0, lng: 0, altitude: 0 }, c.pov());
    assert.ok(d >= prevDist - 1e-9, 'the camera only moves forward along the route');
    prevDist = d;
    maxAlt = Math.max(maxAlt, c.pov().altitude);
    orthonormal(c, `flight at ${t}`);
  }
  const end = c.pov();
  close(end.lat, 40, 1e-9, 'arrives at the latitude');
  close(lngDelta(end.lng, -100), 0, 1e-9, 'arrives at the longitude');
  close(end.altitude, 0.4, 1e-12, 'arrives at the altitude');
  close(c.rollAngle(), 0, 1e-9, 'arrives with north up');
  assert.equal(c.flying, false, 'flight is over');
  assert.ok(maxAlt <= 2.5 + 1e-9, 'a flight that ends lower never goes above where it started');
}
{
  // between two low views a long flight rises on the way and comes back down
  const c = camera(0, 0, 0.5);
  c.flyTo({ lat: 40, lng: -100, altitude: 0.5 }, 1200, 0);
  c.update(0);
  let maxAlt = 0;
  for (let t = 16; t <= 1300; t += 16) {
    c.update(t);
    maxAlt = Math.max(maxAlt, c.pov().altitude);
  }
  assert.ok(maxAlt > 0.5 * 1.3, `a long flight rises on the way (${maxAlt.toFixed(2)})`);
  close(c.pov().altitude, 0.5, 1e-12, 'and lands at the requested altitude');
}
{
  // a short hop barely rises
  const c = camera(4, -74, 0.9);
  c.flyTo({ lat: 4.6, lng: -74.1, altitude: 0.9 }, 800, 0);
  c.update(0);
  let maxAlt = 0;
  for (let t = 16; t <= 900; t += 16) {
    c.update(t);
    maxAlt = Math.max(maxAlt, c.pov().altitude);
  }
  assert.ok(maxAlt < 0.9 * 1.05, `a short hop does not balloon (${maxAlt.toFixed(3)})`);
}
{
  // across the antimeridian the short way round
  const c = camera(10, 170, 1);
  c.flyTo({ lat: 10, lng: -170, altitude: 1 }, 1000, 0);
  c.update(0);
  let minAbsLng = 180;
  for (let t = 16; t <= 1100; t += 16) {
    c.update(t);
    minAbsLng = Math.min(minAbsLng, Math.abs(lngDelta(0, c.pov().lng)));
  }
  assert.ok(minAbsLng > 160, `it does not sweep through longitude 0 (${minAbsLng.toFixed(1)})`);
  close(lngDelta(c.pov().lng, -170), 0, 1e-9, 'arrives');
}
{
  // flying to the antipode works and ends where asked
  const c = camera(0, 0, 1);
  c.flyTo({ lat: 0, lng: 180, altitude: 1 }, 1000, 0);
  c.update(0);
  for (let t = 16; t <= 1100; t += 16) c.update(t);
  close(Math.abs(c.pov().lng), 180, 1e-6, 'antipode');
  orthonormal(c, 'antipode');
}
{
  // a rolled view levels out during a flight
  const c = camera(10, 10, 1);
  c.rotateBy(c.back, 0.5);
  close(Math.abs(c.rollAngle()), 0.5, 1e-9, 'rolled by half a radian');
  c.flyTo({ lat: 10, lng: 10, altitude: 1 }, 1000, 0);
  c.update(0);
  for (let t = 16; t <= 1100; t += 16) c.update(t);
  close(c.rollAngle(), 0, 1e-9, 'north is up again');
}
{
  // zero duration is immediate; touching the globe cancels a flight
  const c = camera(0, 0, 2);
  c.flyTo({ lat: 12, lng: 34, altitude: 0.5 }, 0, 0);
  close(c.pov().lat, 12, 1e-9, 'immediate');
  assert.equal(c.animating, false, 'no animation');
  const d = camera(0, 0, 2);
  d.flyTo({ lat: 12, lng: 34, altitude: 0.5 }, 1000, 0);
  d.update(0);
  d.update(300);
  d.beginGrab(700, 400, 310);
  assert.equal(d.flying, false, 'grabbing cancels the flight');
  const here = d.pov();
  d.update(900);
  assert.deepEqual(d.pov(), here, 'and it stays where it was');
  // a wheel zoom during a flight also takes over
  const e = camera(0, 0, 2);
  e.flyTo({ lat: 12, lng: 34, altitude: 0.5 }, 1000, 0);
  e.zoomBy(0.5);
  assert.equal(e.flying, false, 'zooming cancels the flight');
}
{
  // an idle camera reports no change
  const c = camera(5, 5, 1);
  c.update(0);
  assert.equal(c.update(100), false, 'nothing changes while idle');
  assert.equal(c.animating, false);
}

// --- rolling and the basis stay clean after many operations
{
  const c = camera(20, 30, 1);
  for (let i = 0; i < 5000; i++) c.rotateBy(normalize([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]), (rnd() - 0.5) * 0.3);
  orthonormal(c, 'after 5000 random rotations');
}

console.log('engine camera tests: ok');
