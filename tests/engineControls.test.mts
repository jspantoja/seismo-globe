import assert from 'node:assert/strict';
import { GlobeCamera } from '../engine/camera';
import { GlobeControls, type ControlEvents } from '../engine/controls';
import { degreesBetween } from '../engine/camera';

/** A just-enough element: it keeps the listeners so the test can fire keyboard events at it. */
class FakeElement {
  style: Record<string, string> = {};
  tabIndex = -1;
  listeners = new Map<string, Array<(ev: any) => void>>();
  addEventListener(type: string, fn: (ev: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (ev: any) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600 };
  }
  focus(): void {}
  fire(type: string, ev: Record<string, unknown>): { defaultPrevented: boolean } {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, timeStamp: T0 + 0, ...ev };
    for (const fn of this.listeners.get(type) ?? []) fn(event);
    return event;
  }
}

function setup(events: ControlEvents = {}) {
  const el = new FakeElement();
  const camera = new GlobeCamera();
  camera.setViewport(800, 600);
  camera.setPov({ lat: 10, lng: 20, altitude: 1 });
  let wakes = 0;
  const controls = new GlobeControls(el as unknown as HTMLElement, camera, () => wakes++, events);
  return { el, camera, controls, wakes: () => wakes };
}

// The frame clock starts away from zero: a timeStamp of 0 means "unavailable" to the controls.
const T0 = 1000;

/** Runs frames of 16 ms from `from` to `to` ms; returns the last time. */
function run(controls: GlobeControls, from: number, to: number): number {
  let t = from;
  while (t < to) {
    t += 16;
    controls.update(t);
  }
  return t;
}

// --- the element becomes focusable
{
  const { el } = setup();
  assert.equal(el.tabIndex, 0, 'a keyboard user can tab to the globe');
}

// --- unhandled and modified keys are left alone
{
  const { el, controls, wakes } = setup();
  assert.equal(el.fire('keydown', { key: 'a' }).defaultPrevented, false, 'letters are not ours');
  assert.equal(el.fire('keydown', { key: 'Tab' }).defaultPrevented, false, 'Tab must keep moving focus');
  assert.equal(el.fire('keydown', { key: 'ArrowLeft', ctrlKey: true }).defaultPrevented, false, 'Ctrl+Arrow is the browser\'s');
  assert.equal(el.fire('keydown', { key: 'ArrowLeft', altKey: true }).defaultPrevented, false, 'Alt+Arrow (back) is the browser\'s');
  assert.equal(el.fire('keydown', { key: '+', metaKey: true }).defaultPrevented, false, 'Cmd/Ctrl + zoom is the page zoom');
  assert.equal(controls.keysActive, false);
  assert.equal(wakes(), 0);
  assert.equal(el.fire('keydown', { key: '0' }).defaultPrevented, false, '"0" is not ours without a home handler');
}

// --- an arrow key moves the view, smoothly and in the right direction; releasing eases to a stop
{
  const { el, camera, controls, wakes } = setup();
  const start = camera.pov();
  assert.equal(el.fire('keydown', { key: 'ArrowRight', timeStamp: T0 + 0 }).defaultPrevented, true, 'the page must not scroll');
  assert.equal(controls.keysActive, true);
  assert.ok(wakes() >= 1, 'the engine is woken');
  let t = run(controls, T0 + 0, T0 + 400);
  const mid = camera.pov();
  assert.ok(Math.abs(mid.lng - start.lng) > 5, `it moved while held (${mid.lng - start.lng}°)`);
  assert.ok(Math.abs(mid.lat - start.lat) < 1.5, 'and only sideways');
  assert.equal(mid.altitude, start.altitude, 'the altitude is untouched');
  // speed is steady once ramped up: equal time, about equal distance
  const a = camera.pov();
  t = run(controls, t, t + 160);
  const b = camera.pov();
  t = run(controls, t, t + 160);
  const c = camera.pov();
  const d1 = degreesBetween(a, b);
  const d2 = degreesBetween(b, c);
  assert.ok(Math.abs(d1 - d2) / d1 < 0.12, `steady speed (${d1.toFixed(2)}° then ${d2.toFixed(2)}°)`);
  // a repeat event of the held key does not restart or double anything
  el.fire('keydown', { key: 'ArrowRight', repeat: true, timeStamp: t });
  t = run(controls, t, t + 160);
  const d = camera.pov();
  const d3 = degreesBetween(c, d);
  assert.ok(Math.abs(d3 - d1) / d1 < 0.12, 'auto-repeat adds nothing');
  // release: it eases out and stops
  el.fire('keyup', { key: 'ArrowRight', timeStamp: t });
  t = run(controls, t, t + 120);
  const e = camera.pov();
  t = run(controls, t, t + 1000);
  const f = camera.pov();
  assert.equal(controls.keysActive, false, 'it stops by itself');
  const after = degreesBetween(e, f);
  assert.ok(after < d1, `the glide after release is short (${after.toFixed(2)}°)`);
  assert.equal(controls.update(t + 16), false, 'nothing to do once stopped');
  assert.ok(f.lng > start.lng, 'ArrowRight moved the view east');
}

// --- directions of the four arrows
{
  for (const [key, check] of [
    ['ArrowLeft', (a: any, b: any) => b.lng < a.lng],
    ['ArrowRight', (a: any, b: any) => b.lng > a.lng],
    ['ArrowUp', (a: any, b: any) => b.lat > a.lat],
    ['ArrowDown', (a: any, b: any) => b.lat < a.lat],
  ] as const) {
    const { el, camera, controls } = setup();
    const a = camera.pov();
    el.fire('keydown', { key, timeStamp: T0 + 0 });
    const t = run(controls, T0 + 0, T0 + 300);
    el.fire('keyup', { key, timeStamp: t });
    run(controls, t, t + 600);
    assert.ok(check(a, camera.pov()), `${key} moved the view the expected way (${JSON.stringify(a)} -> ${JSON.stringify(camera.pov())})`);
  }
}

// --- a quick tap still moves visibly (minimum hold), and moves less than a long press
{
  const tap = setup();
  const a = tap.camera.pov();
  tap.el.fire('keydown', { key: 'ArrowLeft', timeStamp: T0 + 0 });
  tap.el.fire('keyup', { key: 'ArrowLeft', timeStamp: T0 + 10 });
  run(tap.controls, T0 + 0, T0 + 1500);
  const moved = degreesBetween(a, tap.camera.pov());
  assert.ok(moved > 0.5, `a tap moves the view (${moved.toFixed(2)}°)`);

  const long = setup();
  long.el.fire('keydown', { key: 'ArrowLeft', timeStamp: T0 + 0 });
  const t = run(long.controls, T0 + 0, T0 + 1000);
  long.el.fire('keyup', { key: 'ArrowLeft', timeStamp: t });
  run(long.controls, t, t + 1500);
  const movedLong = degreesBetween(a, long.camera.pov());
  assert.ok(movedLong > moved * 3, `holding moves further (${movedLong.toFixed(1)}° vs ${moved.toFixed(2)}°)`);
}

// --- the step scales with the altitude: close to the ground it is fine-grained
{
  const far = setup();
  far.camera.setPov({ lat: 0, lng: 0, altitude: 2 });
  const near = setup();
  near.camera.setPov({ lat: 0, lng: 0, altitude: 0.05 });
  for (const s of [far, near]) {
    s.el.fire('keydown', { key: 'ArrowRight', timeStamp: T0 + 0 });
    const t = run(s.controls, T0 + 0, T0 + 500);
    s.el.fire('keyup', { key: 'ArrowRight', timeStamp: t });
    run(s.controls, t, t + 800);
  }
  assert.ok(Math.abs(far.camera.pov().lng) > Math.abs(near.camera.pov().lng) * 10, 'the far view moves much faster than the near one');
}

// --- Shift is faster
{
  const slow = setup();
  const fast = setup();
  slow.el.fire('keydown', { key: 'ArrowRight', timeStamp: T0 + 0 });
  fast.el.fire('keydown', { key: 'ArrowRight', shiftKey: true, timeStamp: T0 + 0 });
  run(slow.controls, T0 + 0, T0 + 500);
  run(fast.controls, T0 + 0, T0 + 500);
  assert.ok(fast.camera.pov().lng - 20 > (slow.camera.pov().lng - 20) * 1.8, 'Shift speeds the view up');
}

// --- zoom: + / = / PageUp come closer, - / _ / PageDown go away, within the camera's limits
{
  for (const key of ['+', '=', 'PageUp']) {
    const { el, camera, controls } = setup();
    el.fire('keydown', { key, timeStamp: T0 + 0 });
    const t = run(controls, T0 + 0, T0 + 400);
    el.fire('keyup', { key, timeStamp: t });
    run(controls, t, t + 600);
    assert.ok(camera.altitude < 0.8, `${key} zooms in (${camera.altitude})`);
  }
  for (const key of ['-', '_', 'PageDown']) {
    const { el, camera, controls } = setup();
    el.fire('keydown', { key, timeStamp: T0 + 0 });
    const t = run(controls, T0 + 0, T0 + 400);
    el.fire('keyup', { key, timeStamp: t });
    run(controls, t, t + 600);
    assert.ok(camera.altitude > 1.3, `${key} zooms out (${camera.altitude})`);
  }
  const { el, camera, controls } = setup();
  el.fire('keydown', { key: '+', timeStamp: T0 + 0 });
  run(controls, T0 + 0, T0 + 20000);
  assert.ok(camera.altitude >= camera.minAltitude - 1e-12 && camera.altitude < 0.01, `it stops at the closest altitude (${camera.altitude})`);
  el.fire('keyup', { key: '+', timeStamp: T0 + 20000 });
  el.fire('keydown', { key: '-', timeStamp: T0 + 20100 });
  run(controls, T0 + 20000, T0 + 60000);
  assert.ok(camera.altitude <= camera.maxAltitude + 1e-9 && camera.altitude > 5, `and at the farthest (${camera.altitude})`);
}

// --- two keys at once combine (diagonal), opposite keys cancel
{
  const { el, camera, controls } = setup();
  const a = camera.pov();
  el.fire('keydown', { key: 'ArrowRight', timeStamp: T0 + 0 });
  el.fire('keydown', { key: 'ArrowUp', timeStamp: T0 + 0 });
  const t = run(controls, T0 + 0, T0 + 500);
  const b = camera.pov();
  assert.ok(b.lng > a.lng + 3 && b.lat > a.lat + 3, 'right and up together move diagonally');
  el.fire('keyup', { key: 'ArrowRight', timeStamp: t });
  el.fire('keyup', { key: 'ArrowUp', timeStamp: t });
  run(controls, t, t + 800);

  const opp = setup();
  const o = opp.camera.pov();
  opp.el.fire('keydown', { key: 'ArrowLeft', timeStamp: T0 + 0 });
  opp.el.fire('keydown', { key: 'ArrowRight', timeStamp: T0 + 0 });
  run(opp.controls, T0 + 0, T0 + 400);
  const p = opp.camera.pov();
  assert.ok(degreesBetween(o, p) < 0.01, 'opposite keys cancel');
}

// --- losing focus releases the keys (no runaway view)
{
  const { el, camera, controls } = setup();
  el.fire('keydown', { key: 'ArrowLeft', timeStamp: T0 + 0 });
  const t = run(controls, T0 + 0, T0 + 200);
  el.fire('blur', {});
  run(controls, t, t + 3000);
  assert.equal(controls.keysActive, false, 'the view stops after blur');
  const x = camera.pov();
  run(controls, t + 3000, t + 4000);
  assert.equal(camera.pov().lng, x.lng, 'and stays put');
}

// --- a held key interrupts a flight (the user takes over)
{
  const { el, camera, controls } = setup();
  camera.flyTo({ lat: -30, lng: 100, altitude: 0.5 }, 5000, 0);
  assert.equal(camera.animating, true);
  el.fire('keydown', { key: 'ArrowLeft', timeStamp: T0 + 0 });
  run(controls, T0 + 0, T0 + 100);
  assert.equal(camera.animating, false, 'the flight was cancelled');
}

// --- a glide left by a released key neither cancels a flight nor outlives stopKeys()
{
  const { el, camera, controls } = setup();
  el.fire('keydown', { key: 'ArrowLeft', timeStamp: T0 });
  let t = run(controls, T0, T0 + 300);
  el.fire('keyup', { key: 'ArrowLeft', timeStamp: t });
  t = run(controls, t, t + 40); // released, still gliding
  assert.equal(controls.keysActive, true, 'the glide is still going');
  camera.flyTo({ lat: -30, lng: 100, altitude: 0.5 }, 5000, t);
  run(controls, t, t + 100);
  assert.equal(camera.animating, true, 'a glide does not cancel a flight (only a key that is down does)');
  controls.stopKeys();
  assert.equal(controls.keysActive, false, 'stopKeys ends it at once');
  assert.equal(controls.update(t + 200), false);
}

// --- home key: only with a handler, and it does not move the view by itself
{
  let homes = 0;
  const { el, camera, controls } = setup({ home: () => homes++ });
  const a = camera.pov();
  assert.equal(el.fire('keydown', { key: '0' }).defaultPrevented, true);
  assert.equal(el.fire('keydown', { key: 'Home' }).defaultPrevented, true);
  assert.equal(homes, 2);
  assert.equal(el.fire('keydown', { key: '0', ctrlKey: true }).defaultPrevented, false, 'Ctrl+0 resets the browser zoom: not ours');
  assert.equal(homes, 2);
  assert.equal(controls.keysActive, false);
  assert.deepEqual(camera.pov(), a);
}

// --- "navigated" tells the page the view changed by keys
{
  let navigated = 0;
  const { el, controls } = setup({ navigated: () => navigated++ });
  el.fire('keydown', { key: 'ArrowUp', timeStamp: T0 + 0 });
  assert.equal(navigated, 0, 'nothing has moved yet');
  const t = run(controls, T0 + 0, T0 + 200);
  assert.ok(navigated > 5, `reported while moving (${navigated})`);
  el.fire('keyup', { key: 'ArrowUp', timeStamp: t });
  run(controls, t, t + 1500);
  const n = navigated;
  run(controls, t + 1500, t + 2000);
  assert.equal(navigated, n, 'and not after it stopped');
}

console.log('engineControls tests: ok');
