import assert from 'node:assert/strict';
import { DETAIL_ENTER_ALTITUDE, DETAIL_LEAVE_ALTITUDE, DETAIL_PRELOAD_ALTITUDE, pointScaleFor, wantsDetail } from '../lib/globeView';

// level of detail: hysteresis around the switch
assert.ok(DETAIL_ENTER_ALTITUDE < DETAIL_LEAVE_ALTITUDE && DETAIL_LEAVE_ALTITUDE < DETAIL_PRELOAD_ALTITUDE, 'enter < leave < preload');
assert.equal(wantsDetail(2.2, false), false, 'the world view is light');
assert.equal(wantsDetail(DETAIL_ENTER_ALTITUDE + 0.01, false), false, 'just outside: still light');
assert.equal(wantsDetail(DETAIL_ENTER_ALTITUDE - 0.01, false), true, 'close enough: detailed');
assert.equal(wantsDetail(DETAIL_ENTER_ALTITUDE + 0.1, true), true, 'once detailed, stays so between the thresholds');
assert.equal(wantsDetail(DETAIL_LEAVE_ALTITUDE - 0.01, true), true);
assert.equal(wantsDetail(DETAIL_LEAVE_ALTITUDE + 0.01, true), false, 'far enough: light again');
// a camera hovering between the thresholds never flips by itself
let state = false;
let flips = 0;
for (const alt of [1.05, 1.1, 1.2, 1.29, 1.2, 1.1, 1.05, 1.15]) {
  const next = wantsDetail(alt, state);
  if (next !== state) flips++;
  state = next;
}
assert.equal(flips, 0, 'no flips inside the hysteresis band');

// the dot scale is unchanged
assert.equal(pointScaleFor(2.2), 1);
assert.equal(pointScaleFor(0.15), 0.3);

console.log('globeView tests: ok');
