import assert from 'node:assert/strict';
import { DETAIL_ENTER_ALTITUDE, DETAIL_LEAVE_ALTITUDE, DETAIL_PRELOAD_ALTITUDE, describeView, distanceWords, pointScaleFor, wantsDetail } from '../lib/globeView';

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

// what is said after keyboard navigation
assert.equal(distanceWords(0.1), 'muy cerca');
assert.equal(distanceWords(0.5), 'cerca');
assert.equal(distanceWords(1.2), 'a media distancia');
assert.equal(distanceWords(2.2), 'vista completa');
assert.equal(describeView('Colombia', 0.5, 4.61, -74.08), 'Centro de la vista: Colombia (4.6° N, 74.1° O), cerca.');
assert.equal(describeView(null, 2.2, -33.9, 151.2), 'Centro de la vista: mar o zona sin país (33.9° S, 151.2° E), vista completa.');
assert.equal(describeView('  ', 1, 0, 0), 'Centro de la vista: mar o zona sin país (0.0° N, 0.0° E), a media distancia.');

console.log('globeView tests: ok');
