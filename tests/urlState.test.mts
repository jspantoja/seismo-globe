import assert from 'node:assert/strict';
import { parseUrlState, buildSearch, periodCovering, minMagFor } from '../lib/urlState';

const empty = { period: null, minMag: null, sgc: false, emsc: false, country: null, plate: null, quake: null, list: false };

// --- parsing valid links
assert.deepEqual(parseUrlState(''), empty);
assert.deepEqual(parseUrlState('?foo=bar'), empty);
assert.deepEqual(parseUrlState('?periodo=week&mag=4.5&pais=170&sgc=1&emsc=1&lista=1&sismo=us7000abcd'), {
  period: 'week', minMag: 4.5, sgc: true, emsc: true, country: '170', plate: null, quake: 'us7000abcd', list: true,
});
assert.equal(parseUrlState('periodo=hour').period, 'hour'); // leading "?" is optional
assert.equal(parseUrlState('?placa=sa').plate, 'SA', 'plate codes are upper-cased');
assert.equal(parseUrlState('?mag=2.5').minMag, 2.5);
assert.equal(parseUrlState('?mag=0').minMag, 0);
assert.equal(parseUrlState('?sismo=emsc-20261014_0000063').quake, 'emsc-20261014_0000063');

// --- country and plate are exclusive: the country wins
assert.deepEqual([parseUrlState('?pais=170&placa=SA').country, parseUrlState('?pais=170&placa=SA').plate], ['170', null]);
// ...but an invalid country does not hide a valid plate
assert.equal(parseUrlState('?pais=abc&placa=SA').plate, 'SA');

// --- everything untrusted is rejected
for (const bad of [
  '?periodo=year', '?periodo=', '?periodo=DAY', '?periodo=week;drop',
  '?mag=3', '?mag=-1', '?mag=abc', '?mag=', '?mag=4.5.5', '?mag=Infinity',
  '?pais=abcd', '?pais=1234', '?pais=<script>', '?pais=', '?pais=undefined',
  '?placa=1', '?placa=ABCD', '?placa=<b>',
  `?sismo=${'a'.repeat(101)}`, '?sismo=a b', '?sismo=<img src=x>', '?sismo=a/b', '?sismo=',
]) {
  assert.deepEqual(parseUrlState(bad), empty, `must ignore ${bad}`);
}
assert.equal(parseUrlState('?sgc=true').sgc, false, 'only "1" enables a flag');
assert.equal(parseUrlState('?lista=yes').list, false);

// --- building
assert.equal(buildSearch({}), '');
assert.equal(buildSearch({ period: 'day', minMag: 0 }), '', 'defaults are omitted');
assert.equal(
  buildSearch({ period: 'week', minMag: 4.5, country: '170', sgc: true, emsc: true, list: true, quake: 'us1' }),
  '?periodo=week&mag=4.5&sgc=1&emsc=1&pais=170&sismo=us1&lista=1'
);
assert.equal(buildSearch({ plate: 'sa' }), '?placa=SA');
assert.equal(buildSearch({ country: '170', plate: 'SA' }), '?pais=170', 'never writes both');
assert.equal(buildSearch({ country: 'undefined' }), '', 'a country without a numeric id is not shareable');
assert.equal(buildSearch({ quake: 'a b<c' }), '', 'invalid values are dropped, not escaped');

// --- round trip
const state = { period: 'month' as const, minMag: 2.5, sgc: true, emsc: false, country: null, plate: 'PA', quake: 'sgc2026abc', list: true };
assert.deepEqual(parseUrlState(buildSearch(state)), state);

// --- period / magnitude chosen for a link to one quake
assert.equal(periodCovering(0), 'day');
assert.equal(periodCovering(12 * 3_600_000), 'day');
assert.equal(periodCovering(12 * 3_600_000 + 1), 'week');
assert.equal(periodCovering(5 * 86_400_000), 'week');
assert.equal(periodCovering(5 * 86_400_000 + 1), 'month');
assert.equal(minMagFor(5.1, 'week'), 4.5);
assert.equal(minMagFor(4.49, 'month'), 2.5);
assert.equal(minMagFor(1.2, 'month'), 0);
assert.equal(minMagFor(null, 'week'), 0);
assert.equal(minMagFor(6, 'day'), 0, 'the 24 h feed is light enough without a filter');

console.log('ALL URL STATE TESTS PASSED');
