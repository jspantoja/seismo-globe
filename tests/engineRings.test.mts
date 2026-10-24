import assert from 'node:assert/strict';
import { GlobeCamera } from '../engine/camera';
import type { FrameContext } from '../engine/engine';
import { DEG2RAD } from '../engine/math';
import { RING_CLOCK_PERIODS, RING_MAX_SLOTS, RING_OPACITY, RING_PERIOD_MS, RingLayer, ringPlan, ringSlots, ringState, type RingSpec } from '../engine/rings';

const close = (a: number, b: number, tol: number, msg: string) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const P = RING_PERIOD_MS;

// the app's own parameters for a quake of magnitude m
const spec = (key: string, m: number, lat = 0, lng = 0): RingSpec => ({
  key,
  lat,
  lng,
  maxRadiusDeg: Math.max(2.5, m * 1.6),
  speedDegPerSec: Math.max(0.6, m * 0.5),
  color: '#f56565',
});

// --- how many slots a quake needs
{
  assert.equal(RING_PERIOD_MS, 1100);
  assert.equal(RING_MAX_SLOTS, 8);
  close(RING_OPACITY, 200 / 255, 1e-12, 'the old peak opacity');
  const m5 = ringPlan(8, 2.5, P);
  assert.equal(m5.slots, 3, 'M5: a ring lives 3.2 s, a new one every 1.1 s');
  close(m5.lifeMs, 3200, 1e-6, 'M5 life');
  assert.equal(m5.cycleMs, 3300);
  assert.equal(ringPlan(2.5, 0.6, P).slots, 4, 'a small quake: slow rings, 4 slots');
  assert.equal(ringPlan(8, 20, P).slots, 1, 'a ring that dies before the next is born needs one slot');
  const slow = ringPlan(10, 0.1, P);
  assert.equal(slow.slots, RING_MAX_SLOTS, 'slots are capped');
  assert.ok(slow.lifeMs <= slow.cycleMs, 'and the life is shortened to fit the cycle');
  assert.ok(ringPlan(0, 0, P).lifeMs > 0, 'nonsense parameters still give a ring');
  for (const m of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    const plan = ringPlan(spec('x', m).maxRadiusDeg, spec('x', m).speedDegPerSec, P);
    assert.ok(plan.slots >= 1 && plan.slots <= 5, `M${m}: ${plan.slots} slots`);
    assert.ok(plan.cycleMs >= plan.lifeMs);
    assert.equal((RING_CLOCK_PERIODS * P) % plan.cycleMs, 0, `M${m}: the cycle divides the wrapped clock`);
  }
}

// --- the slots reproduce "a ring is born every period and grows at constant speed"
{
  for (const m of [1, 3, 5, 7]) {
    const s = spec('q', m);
    for (const start of [0, 137, 5000.5, 86_400_000]) {
      const slots = ringSlots(s, P, start);
      const lifeMs = (s.maxRadiusDeg / s.speedDegPerSec) * 1000;
      for (let T = start - 500; T < start + 12000; T += 83) {
        // brute force: spawn at start, start + P, start + 2P ...; each is alive for `life`
        const expected: number[] = [];
        for (let k = 0; k * P <= T - start + 1e-9; k++) {
          const age = T - (start + k * P);
          if (age >= 0 && age < lifeMs) expected.push(s.speedDegPerSec * (age / 1000) * DEG2RAD);
        }
        const got = slots
          .map((sl) => ringState(sl, T))
          .filter((st) => st.active)
          .map((st) => st.rho);
        expected.sort((a, b) => a - b);
        got.sort((a, b) => a - b);
        assert.equal(got.length, expected.length, `M${m} start ${start} t=${T}: ${expected.length} rings alive`);
        got.forEach((r, i) => close(r, expected[i], 1e-9, `M${m} ring ${i} radius at t=${T}`));
      }
    }
  }
  // nothing before the quake appears: the first ring starts at the centre
  const slots = ringSlots(spec('q', 5), P, 10_000);
  assert.ok(slots.every((sl) => !ringState(sl, 9_990).active), 'no ring exists before the start');
  const first = slots.map((sl) => ringState(sl, 10_000)).filter((st) => st.active);
  assert.equal(first.length, 1, 'at the start, exactly one ring');
  close(first[0].rho, 0, 1e-12, 'it is at the centre');
  close(first[0].fade, 1, 1e-12, 'and fully opaque');
  // fades linearly to nothing
  const mid = slots.map((sl) => ringState(sl, 10_000 + 1600)).filter((st) => st.active);
  const lead = mid.reduce((a, b) => (a.f > b.f ? a : b));
  close(lead.f, 0.5, 1e-9, 'half-way through its life');
  close(lead.fade, 0.5, 1e-9, 'half the opacity');
  close(lead.rho, 4 * DEG2RAD, 1e-9, 'half of the 8 degrees');
}

// --- the wrapped clock the shader receives gives the very same age as the true clock
{
  for (const m of [1, 5, 8]) {
    const s = spec('w', m);
    const slots = ringSlots(s, P, 12_345.678);
    const wrap = P * RING_CLOCK_PERIODS;
    for (const clock of [20_000, 1_000_000, 7_654_321.25, 1e8 + 3]) {
      for (const sl of slots) {
        const m1 = (clock + sl.t0) % sl.cycle;
        const m2 = ((clock % wrap) + sl.t0) % sl.cycle;
        const a1 = m1 < 0 ? m1 + sl.cycle : m1;
        const a2 = m2 < 0 ? m2 + sl.cycle : m2;
        close(a1, a2, 1e-4, `M${m}: wrapped clock ${clock}`);
      }
    }
  }
}

// --- the layer: stable identity, restarts, packing
{
  let t = 1000;
  const layer = new RingLayer({ clock: () => t });
  assert.equal(layer.animating(), false, 'nothing to animate');
  const a = spec('a', 5);
  const b = spec('b', 3, 10, 10);
  layer.setRings([a, b]);
  assert.equal(layer.slotCount, 3 + 3, 'M5 and M3: three slots each');
  assert.equal(layer.animating(), true);
  const bornA = layer.allSlots().filter((e) => e.spec.key === 'a').map((e) => e.slot.start);
  assert.deepEqual(bornA.map((x) => x - bornA[0]), [0, P, 2 * P], 'slots are born one period apart');

  // a later list that still has `a` (unchanged) and a new `c`
  t = 4000;
  layer.setRings([a, spec('c', 2, -20, 50)]);
  const nowA = layer.allSlots().filter((e) => e.spec.key === 'a').map((e) => e.slot.start);
  assert.deepEqual(nowA, bornA, 'a quake that stays keeps its rings going: no restart');
  const bornC = layer.allSlots().filter((e) => e.spec.key === 'c').map((e) => e.slot.start);
  close(bornC[0], 3000, 1e-9, 'a new quake starts now (the layer clock is the injected one, from its creation)');
  assert.ok(layer.allSlots().every((e) => e.spec.key !== 'b'), 'a removed quake is gone');

  // changed parameters (a revised magnitude) restart that quake's rings only
  t = 6000;
  layer.setRings([{ ...a, maxRadiusDeg: 9 }, spec('c', 2, -20, 50)]);
  const restartedA = layer.allSlots().filter((e) => e.spec.key === 'a').map((e) => e.slot.start);
  close(restartedA[0], 5000, 1e-9, 'a changed ring restarts');
  assert.deepEqual(layer.allSlots().filter((e) => e.spec.key === 'c').map((e) => e.slot.start), bornC, 'c is untouched');

  // reduced motion: no animation, nothing drawn
  layer.setAnimated(false);
  assert.equal(layer.animating(), false);
  layer.setAnimated(true);
  assert.equal(layer.animating(), true);
  layer.setRings([]);
  assert.equal(layer.slotCount, 0);
  assert.equal(layer.animating(), false);
}

// --- steps around the circle follow the zoom
{
  const layer = new RingLayer({ clock: () => 0 });
  layer.setRings([spec('big', 8)]);
  const frameAt = (altitude: number): FrameContext => {
    const camera = new GlobeCamera();
    camera.setViewport(1440, 900);
    camera.setPov({ lat: 0, lng: 0, altitude });
    return { gl: null as any, camera, width: 1440, height: 900, pixelRatio: 2, now: 0 };
  };
  let previous = 0;
  for (const alt of [4, 2.5, 1, 0.3, 0.05, 0.004]) {
    const n = layer.segmentsFor(frameAt(alt));
    assert.ok(n >= 48 && n <= 1024 && n % 8 === 0, `altitude ${alt}: ${n} segments`);
    assert.ok(n >= previous, 'closer means more segments');
    previous = n;
  }
  assert.ok(layer.segmentsFor(frameAt(0.05)) >= 200, 'close up, many');
  assert.ok(layer.segmentsFor(frameAt(0.004)) >= 800, 'as close as the camera goes, a ring is tens of thousands of pixels wide');
  assert.ok(layer.segmentsFor(frameAt(4)) <= 80, 'far away, few');
  // the promised accuracy: the chord of a step is within a quarter of a pixel of the circle
  for (const alt of [2.5, 0.3, 0.05, 0.01, 0.004]) {
    const f = frameAt(alt);
    const n = layer.segmentsFor(f);
    const radiusPx = 8 * DEG2RAD * f.camera.pixelsPerUnit();
    const sag = radiusPx * (1 - Math.cos(Math.PI / n));
    assert.ok(sag <= 0.26, `altitude ${alt}: a ${radiusPx.toFixed(0)} px ring with ${n} steps sags ${sag.toFixed(3)} px`);
  }
}

console.log('engineRings tests: ok');
