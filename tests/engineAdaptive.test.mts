import assert from 'node:assert/strict';
import { ResolutionGovernor } from '../engine/adaptive';

/** Feeds `count` frames of the given gap, advancing a clock; returns the last scale change (or null) and the clock. */
function feed(g: ResolutionGovernor, clock: { t: number }, gap: number, count: number): number[] {
  const changes: number[] = [];
  for (let i = 0; i < count; i++) {
    clock.t += gap;
    const s = g.frame(gap, clock.t);
    if (s !== null) changes.push(s);
  }
  return changes;
}

// --- a device that keeps up is left alone
{
  const g = new ResolutionGovernor();
  const clock = { t: 0 };
  assert.deepEqual(feed(g, clock, 16.7, 600), [], '60 fps: no change');
  assert.equal(g.scale, 1);
  assert.deepEqual(feed(g, clock, 22, 300), [], 'a bit under 60 fps is still fine');
}

// --- a slow device is brought down, in steps, to a floor
{
  const g = new ResolutionGovernor({ min: 0.5 });
  const clock = { t: 0 };
  // 50 ms frames (20 fps) at any scale: it keeps lowering until the floor
  const changes = feed(g, clock, 50, 400);
  assert.ok(changes.length >= 2, `several steps (${changes})`);
  for (let i = 1; i < changes.length; i++) assert.ok(changes[i] < changes[i - 1], 'strictly decreasing');
  assert.equal(g.scale, 0.5, 'stops at the floor');
  assert.equal(Math.min(...changes), 0.5);
  assert.ok(changes[0] >= 0.6 && changes[0] <= 0.9, `the first step is a measured one (${changes[0]})`);
}

// --- the step follows the missing speed: a little slow lowers a little, very slow lowers a lot
{
  const mild = new ResolutionGovernor();
  const a = feed(mild, { t: 0 }, 32, 12);
  const heavy = new ResolutionGovernor();
  const b = feed(heavy, { t: 0 }, 90, 12);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.ok(a[0] > b[0], `mild ${a[0]} stays higher than heavy ${b[0]}`);
}

// --- a single long frame (a hitch, a hidden tab) does not trigger anything
{
  const g = new ResolutionGovernor();
  const clock = { t: 0 };
  feed(g, clock, 16.7, 50);
  assert.deepEqual(feed(g, clock, 4000, 1), [], 'one stall alone: no change');
  assert.deepEqual(feed(g, clock, 16.7, 50), []);
  assert.equal(g.scale, 1);
}

// --- no assessment before a full window of frames
{
  const g = new ResolutionGovernor({ window: 12 });
  const clock = { t: 0 };
  assert.deepEqual(feed(g, clock, 80, 11), [], 'eleven slow frames are not yet an assessment');
  assert.equal(feed(g, clock, 80, 1).length, 1, 'the twelfth is');
}

// --- recovery: after a wait of good frames it tries a higher scale
{
  const g = new ResolutionGovernor({ probeAfterMs: 5000 });
  const clock = { t: 0 };
  feed(g, clock, 50, 12);
  const low = g.scale;
  assert.ok(low < 1);
  assert.deepEqual(feed(g, clock, 16.7, 100), [], 'too soon to try again (under 5 s)');
  const up = feed(g, clock, 16.7, 400);
  assert.ok(up.length >= 1 && up[0] > low, `then it goes up (${up})`);
  assert.ok(up[0] <= low * 1.15 + 0.011, 'one modest step');
}

// --- a failed attempt doubles the wait
{
  const g = new ResolutionGovernor({ probeAfterMs: 4000, maxProbeWaitMs: 60000 });
  const clock = { t: 0 };
  feed(g, clock, 60, 12); // down
  const times: number[] = [];
  let lastScale = g.scale;
  for (let round = 0; round < 3; round++) {
    // good frames until it probes up
    let probedAt = -1;
    for (let i = 0; i < 4000 && probedAt < 0; i++) {
      clock.t += 16.7;
      const s = g.frame(16.7, clock.t);
      if (s !== null && s > lastScale) {
        probedAt = clock.t;
        lastScale = s;
      }
    }
    assert.ok(probedAt > 0, `round ${round}: it probes`);
    times.push(probedAt);
    // ...and the higher scale turns out too slow: back down
    for (let i = 0; i < 40; i++) {
      clock.t += 70;
      const s = g.frame(70, clock.t);
      if (s !== null) lastScale = s;
    }
  }
  const gap1 = times[1] - times[0];
  const gap2 = times[2] - times[1];
  assert.ok(gap2 > gap1 * 1.5, `waits grow after failures (${Math.round(gap1)} ms, then ${Math.round(gap2)} ms)`);
}

// --- rest() starts a new assessment
{
  const g = new ResolutionGovernor({ window: 12 });
  const clock = { t: 0 };
  feed(g, clock, 80, 8);
  g.rest();
  assert.deepEqual(feed(g, clock, 80, 8), [], 'the frames before the rest do not count');
}

// --- the last assessed median is kept for the diagnostics panel
{
  const g = new ResolutionGovernor({ window: 12 });
  assert.equal(g.lastMedianMs, null, 'nothing measured yet');
  const clock = { t: 0 };
  feed(g, clock, 40, 12);
  assert.equal(g.lastMedianMs, 40, 'the median of the first full window');
}

// --- scale values are tidy numbers
{
  const g = new ResolutionGovernor();
  const clock = { t: 0 };
  for (const s of feed(g, clock, 45, 200)) assert.equal(s, Math.round(s * 100) / 100, 'two decimals');
}

console.log('engineAdaptive tests: ok');
