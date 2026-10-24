import assert from 'node:assert/strict';
import { GlobeCamera } from '../engine/camera';
import { DEG2RAD, geoToVec } from '../engine/math';
import { MAX_RADIUS_DEG, QUAKE_LOD, QuakeLayer, lodRanges, prismTemplate, type QuakeLike } from '../engine/quakes';

const close = (a: number, b: number, tol: number, msg: string) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const W = 1440;
const H = 900;
const style = { altitude: 0.018, radiusDeg: (q: QuakeLike) => Math.max(0.2, (q.mag ?? 1) * 0.15), color: () => '#ecc94b' };
const q = (lat: number, lng: number, mag: number | null = 4): QuakeLike => ({ lat, lng, mag });

/** A camera `distance` from the centre of the globe, over (lat, lng). */
function cameraOver(lat: number, lng: number, distance = 3): GlobeCamera {
  const cam = new GlobeCamera();
  cam.setViewport(W, H);
  cam.setPov({ lat, lng, altitude: distance - 1 });
  return cam;
}

/** Screen position (through the matrices, independently of `pick`) of the middle of a prism. */
const aim = (cam: GlobeCamera, lat: number, lng: number) => cam.project(geoToVec(lat, lng, 1 + 0.018 / 2));

// --- the prism template
{
  for (const sides of [3, 8, 12]) {
    const { data, vertexCount } = prismTemplate(sides);
    assert.equal(vertexCount, sides * 9, `${sides} sides: 6 vertices per side face + 3 per top triangle`);
    assert.equal(data.length, vertexCount * 6);
    for (let i = 0; i < vertexCount; i++) {
      const [x, y, z, nx, ny, nz] = Array.from(data.subarray(i * 6, i * 6 + 6));
      close(Math.hypot(x, y), i < sides * 6 ? 1 : i % 3 === 0 ? 0 : 1, 1e-6, 'on the unit circle (or the cap centre)');
      assert.ok(z === 0 || z === 1, 'base or top');
      close(Math.hypot(nx, ny, nz), 1, 1e-6, 'unit normals');
      assert.ok(nz >= 0, 'nothing faces down: the base is not drawn');
    }
    // every triangle winds so its geometric normal agrees with the stored face normal
    for (let t = 0; t < vertexCount / 3; t++) {
      const p = [0, 1, 2].map((k) => Array.from(data.subarray((t * 3 + k) * 6, (t * 3 + k) * 6 + 3)));
      const n = Array.from(data.subarray(t * 3 * 6 + 3, t * 3 * 6 + 6));
      const a = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
      const b = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
      const g = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      assert.ok(g[0] * n[0] + g[1] * n[1] + g[2] * n[2] > 1e-9, `triangle ${t} of ${sides} faces outwards`);
    }
  }
  assert.equal(prismTemplate(1).vertexCount, 27, 'fewer than 3 sides is raised to 3');
}

// --- the GPU records
{
  const layer = new QuakeLayer(style);
  assert.equal(layer.count, 0);
  const quakes = [q(0, 0, 5), q(45, 120.123456789, 3), q(-90, 0, 2), q(90, 0, 2), q(10, 10, null)];
  layer.setQuakes(quakes);
  const { floats, bytes, count, order } = layer.debugInstances();
  assert.equal(count, 5);
  assert.deepEqual(Array.from(order).sort(), [0, 1, 2, 3, 4], 'every quake is in the GPU buffer once');
  for (let k = 1; k < count; k++) assert.ok(floats[k * 8 + 6] >= floats[(k - 1) * 8 + 6], 'instances are sorted by radius (levels of detail are contiguous ranges)');
  for (let k = 0; k < count; k++) {
    const i = order[k];
    const quake = quakes[i];
    const v = geoToVec(quake.lat, quake.lng);
    for (let c = 0; c < 3; c++) close(floats[k * 8 + c] + floats[k * 8 + 3 + c], v[c], 1e-15, `quake ${i}: high + low rebuild the position to double precision`);
    const expected = Math.min(MAX_RADIUS_DEG, Math.max(0.2, (quake.mag ?? 1) * 0.15)) * DEG2RAD;
    close(floats[k * 8 + 6], expected, 1e-7, `quake ${i} radius in radians`);
    assert.deepEqual(Array.from(bytes.subarray(k * 32 + 28, k * 32 + 32)), [236, 201, 75, 255], 'colour #ecc94b');
  }
  assert.equal(layer.height, 0.018);

  const huge = new QuakeLayer({ ...style, radiusDeg: () => 500 });
  huge.setQuakes([q(0, 0)]);
  close(huge.debugInstances().floats[6], MAX_RADIUS_DEG * DEG2RAD, 1e-7, 'radius is capped at 30 degrees');
  const odd = new QuakeLayer({ ...style, radiusDeg: () => NaN, altitude: 0 });
  odd.setQuakes([q(0, 0)]);
  assert.equal(odd.debugInstances().floats[6], 0, 'a nonsense radius becomes zero, not NaN');
  assert.equal(odd.height, 0.001, 'a degenerate height is raised');
}

// --- levels of detail: dots are drawn with more sides as they grow on screen
{
  assert.deepEqual(QUAKE_LOD.map((l) => l.sides), [8, 16, 32]);
  const radii = Float32Array.from([0.001, 0.002, 0.004, 0.004, 0.011, 0.02, 0.05, 0.1]); // radians, ascending
  // 1000 px per unit at a scale of 1: pixel radii 1, 2, 4, 4, 11, 20, 50, 100
  assert.deepEqual(lodRanges(radii, 8, 1, 1000), [0, 4, 6, 8], 'small, medium and large dots: a range per level, ending at the count');
  assert.deepEqual(lodRanges(radii, 8, 0.05, 1000), [0, 8, 8, 8], 'zoom scale 0.05: every dot is small');
  assert.deepEqual(lodRanges(radii, 8, 1, 100000), [0, 0, 0, 8], 'a very close camera: every dot is large');
  assert.deepEqual(lodRanges(radii, 8, 0, 1000), [0, 8, 8, 8], 'a zero scale does not divide by zero');
  assert.deepEqual(lodRanges(radii, 0, 1, 1000), [0, 0, 0, 0], 'no dots');
  // the ranges partition [0, n) in order, whatever the camera
  for (const scale of [0.25, 0.4, 1]) {
    for (const ppu of [10, 300, 4000, 90000]) {
      const r = lodRanges(radii, 8, scale, ppu);
      assert.equal(r.length, 4);
      assert.equal(r[0], 0);
      assert.equal(r[3], 8);
      for (let k = 1; k < r.length; k++) assert.ok(r[k] >= r[k - 1]);
    }
  }
  // on a real layer, through a camera: zoomed out all dots are the simplest level, zoomed in the big ones are smooth
  const layer = new QuakeLayer(style);
  const mix = [q(0, 0, 8), q(10, 10, 5), q(20, 20, 2), q(30, 30, 1), q(40, 40, 3)];
  layer.setQuakes(mix);
  const far = layer.lodStarts(cameraOver(0, 0, 3.5)); // altitude 2.5
  assert.equal(far[1], 5, 'world view: all small');
  layer.setScale(0.25); // what the app uses when the camera is this close
  const starts = layer.lodStarts(cameraOver(0, 0, 1.05)); // altitude 0.05: about 19,000 px per unit
  assert.deepEqual(starts, [0, 0, 2, 5], 'close up: dots of 25 px and 17 px are medium, the three over 28 px are smooth');
}

// --- growth, shrinking, empty data, identical arrays
{
  const layer = new QuakeLayer(style);
  const many = Array.from({ length: 1000 }, (_, i) => q((i % 170) - 85, (i % 350) - 175));
  layer.setQuakes(many);
  assert.equal(layer.count, 1000);
  const cap = layer.debugInstances().capacity;
  assert.ok(cap >= 1000 && (cap & (cap - 1)) === 0, 'capacity is a power of two');
  layer.setQuakes(many.slice(0, 10));
  assert.equal(layer.count, 10, 'shrinks');
  assert.equal(layer.debugInstances().capacity, cap, 'without reallocating');
  layer.setQuakes([]);
  assert.equal(layer.count, 0);
  assert.equal(layer.pick(cameraOver(0, 0), W / 2, H / 2, 6), -1, 'nothing to pick');
  assert.equal(layer.pickQuake(cameraOver(0, 0), W / 2, H / 2, 6), null);
  const bigger = Array.from({ length: cap + 5 }, (_, i) => q((i % 100) - 50, (i % 300) - 150));
  layer.setQuakes(bigger);
  assert.equal(layer.count, cap + 5, 'grows past its capacity');
  assert.ok(layer.debugInstances().capacity >= cap + 5);

  // the same array does not rebuild; `force` does
  const arr = [q(0, 0, 4)];
  layer.setQuakes(arr);
  arr[0].mag = 8; // changed in place: the layer cannot know
  layer.setQuakes(arr);
  close(layer.debugInstances().floats[6], 0.6 * DEG2RAD, 1e-7, 'same array: untouched');
  layer.setQuakes(arr, true);
  close(layer.debugInstances().floats[6], 1.2 * DEG2RAD, 1e-7, 'forced: rebuilt');
}

// --- picking (the cases of the old layer, now on the engine's own camera)
{
  const layer = new QuakeLayer(style);
  const quakes = [q(0, 0, 5), q(0, 10, 4), q(0, 180, 6), q(60, 0, 3), q(-40, -100, 4)];
  layer.setQuakes(quakes);
  const cam = cameraOver(0, 0);

  const centre = aim(cam, 0, 0);
  close(centre.x, W / 2, 1e-6, 'the globe centre is the screen centre');
  assert.equal(layer.pick(cam, centre.x, centre.y, 6), 0, 'the quake under the pointer');
  const side = aim(cam, 0, 10);
  assert.equal(layer.pick(cam, side.x, side.y, 6), 1, 'another quake');
  assert.equal(layer.pick(cam, side.x + 1.5, side.y - 1.5, 6), 1, 'a pixel or two off still hits (slop)');
  assert.equal(layer.pick(cam, W / 2 + 200, H / 2 - 150, 6), -1, 'empty sea');
  assert.equal(layer.quakeAt(layer.pick(cam, side.x, side.y, 6))?.mag, 4);

  // hit radius = drawn radius + slop, measured from the geometry itself (a point on the dot's rim)
  const drawnPx = Math.abs(aim(cam, 0, 0.75).x - centre.x);
  assert.ok(drawnPx > 5, `a M5 dot is several pixels wide here (${drawnPx.toFixed(1)})`);
  assert.equal(layer.pick(cam, centre.x + drawnPx - 1, centre.y, 0), 0, 'inside the drawn disc, no slop needed');
  assert.equal(layer.pick(cam, centre.x + drawnPx + 12, centre.y, 0), -1, 'well outside the disc without slop');
  assert.equal(layer.pick(cam, centre.x + drawnPx + 5, centre.y, 8), 0, 'slop widens the target');

  // the far side of the globe is never pickable, even right behind a visible point
  assert.equal(layer.pick(cam, W / 2, H / 2, 6), 0, 'the near quake wins at the centre, not the one at lng 180 behind it');
  assert.equal(layer.pick(cameraOver(0, 180), W / 2, H / 2, 6), 2, 'seen from the other side, the lng 180 quake is picked');

  // a quake just over the limb is hidden, one just inside it is not
  const limbCam = cameraOver(0, 0, 3);
  const limbDeg = (Math.acos(1 / 3) * 180) / Math.PI;
  const only = (lng: number) => {
    const l = new QuakeLayer({ ...style, radiusDeg: () => 3 });
    l.setQuakes([q(0, lng)]);
    return l;
  };
  const out = aim(limbCam, 0, limbDeg + 3);
  const inn = aim(limbCam, 0, limbDeg - 3);
  assert.equal(only(limbDeg + 3).pick(limbCam, out.x, out.y, 10), -1, 'just past the limb: hidden');
  assert.equal(only(limbDeg - 3).pick(limbCam, inn.x, inn.y, 10), 0, 'just inside the limb: visible');

  // overlapping quakes: the one whose centre is nearest wins
  const pair = new QuakeLayer({ ...style, radiusDeg: () => 2 });
  pair.setQuakes([q(0, 0, 4), q(0, 1, 6)]);
  const sa = aim(cam, 0, 0);
  const sb = aim(cam, 0, 1);
  assert.equal(pair.pick(cam, sa.x + 0.5, sa.y, 4), 0);
  assert.equal(pair.pick(cam, sb.x - 0.5, sb.y, 4), 1);
  assert.equal(pair.quakeAt(1)?.mag, 6);
  assert.equal(pair.quakeAt(2), null);
  assert.equal(pair.quakeAt(-1), null);

  // the zoom scale changes the target size, and a closer camera makes the same dot bigger
  layer.setScale(0.3);
  assert.equal(layer.zoomScale, 0.3);
  assert.equal(layer.pick(cam, centre.x + drawnPx - 1, centre.y, 0), -1, 'a smaller dot has a smaller target');
  layer.setScale(1);
  const near = cameraOver(0, 0, 1.12);
  const nc = aim(near, 0, 0);
  assert.equal(layer.pick(near, nc.x + drawnPx * 2, nc.y, 0), 0, 'zoomed in, the target grows with the dot');

  // a rolled and tilted camera: each quake is still found where it is drawn
  const tilted = cameraOver(20, 15, 2);
  tilted.rotateBy(tilted.back, 0.9); // roll
  tilted.rotateBy(tilted.right, 0.15);
  const spread = [q(18, 10, 5), q(22, 20, 5), q(15, 14, 5), q(24, 16, 5)];
  const sl = new QuakeLayer(style);
  sl.setQuakes(spread);
  spread.forEach((k, i) => {
    const s = aim(tilted, k.lat, k.lng);
    assert.ok(s.depth > -1 && s.depth < 1 && s.x > 0 && s.x < W && s.y > 0 && s.y < H, `quake ${i} is on screen`);
    assert.equal(sl.pick(tilted, s.x, s.y, 0), i, `quake ${i} is found where it is drawn, with the view rolled`);
  });
}

// --- picking agrees with the projection matrices everywhere, close up too
{
  const sparse = Array.from({ length: 60 }, (_, i) => q(((i * 53) % 150) - 75, ((i * 97) % 340) - 170, 2 + (i % 5)));
  const layer = new QuakeLayer(style);
  layer.setQuakes(sparse);
  let checked = 0;
  for (const [lat, lng, dist] of [[10, 20, 3], [-30, 100, 2], [40, -60, 1.5], [0, 0, 1.05]] as const) {
    const cam = cameraOver(lat, lng, dist);
    sparse.forEach((k, i) => {
      const s = aim(cam, k.lat, k.lng);
      if (!(s.depth > -1 && s.depth < 1 && s.x > 2 && s.x < W - 2 && s.y > 2 && s.y < H - 2)) return;
      const v = geoToVec(k.lat, k.lng);
      const e = cam.position();
      if (v[0] * e[0] + v[1] * e[1] + v[2] * e[2] <= 1) return; // the far side
      assert.equal(layer.pick(cam, s.x, s.y, 0), i, `camera ${lat},${lng} @${dist}: quake ${i} is pickable exactly where it is drawn`);
      checked++;
    });
  }
  assert.ok(checked > 20, `many quakes were checked (${checked})`);
}

// --- speed: 20,000 quakes, 200 picks
{
  const layer = new QuakeLayer(style);
  const quakes = Array.from({ length: 20000 }, (_, i) => q(((i * 37) % 170) - 85, ((i * 91) % 350) - 175, (i % 70) / 10));
  let t = performance.now();
  layer.setQuakes(quakes);
  const build = performance.now() - t;
  const cam = cameraOver(10, 20);
  t = performance.now();
  for (let i = 0; i < 200; i++) layer.pick(cam, (i * 7) % W, (i * 5) % H, 6);
  const per = (performance.now() - t) / 200;
  console.log(`  20,000 quakes: build ${build.toFixed(0)} ms, pick ${per.toFixed(2)} ms each`);
  assert.ok(per < 5, `a pick over 20,000 quakes stays cheap (${per.toFixed(2)} ms)`);
  const t2 = performance.now();
  layer.setScale(0.7);
  assert.ok(performance.now() - t2 < 5, 're-scaling is free: it is one uniform');
}

console.log('engineQuakes tests: ok');
