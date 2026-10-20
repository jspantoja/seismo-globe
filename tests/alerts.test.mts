import assert from 'node:assert/strict';
import {
  defaultAlertSettings,
  parseAlertSettings,
  thresholdFor,
  isQuietNow,
  pickAlert,
  minutesToTime,
  timeToMinutes,
  describeAlertRule,
  type AlertSettings,
  type CountryRef,
} from '../lib/alerts';
import type { QuakeFeature } from '../lib/types';

const q = (id: string, mag: number | null, time = 1000, lat = 0, lng = 0): QuakeFeature =>
  ({ id, mag, time, lat, lng, place: id, source: 'usgs' } as unknown as QuakeFeature);
const at = (h: number, m = 0) => new Date(2026, 9, 20, h, m, 0);
const settings = (over: Partial<AlertSettings> = {}): AlertSettings => ({ ...defaultAlertSettings(), enabled: true, ...over });

// --- migration from the original schema: nothing saved is lost, new fields are neutral
const old = parseAlertSettings({ enabled: true, countryIds: [170, '152'], browserNotifications: true });
assert.deepEqual(old, {
  enabled: true,
  countryIds: ['170', '152'],
  browserNotifications: true,
  minMag: 0,
  countryMinMag: {},
  quiet: { enabled: false, from: 22 * 60, to: 6 * 60, exceptMag: 0 },
});
assert.deepEqual(parseAlertSettings(null), defaultAlertSettings());
assert.deepEqual(parseAlertSettings('nope'), defaultAlertSettings());
assert.deepEqual(parseAlertSettings([1, 2]), defaultAlertSettings());

// --- a round trip keeps everything; junk is sanitised
const full = settings({
  countryIds: ['170', '152'],
  minMag: 4.5,
  countryMinMag: { '170': 3, '152': 5 },
  quiet: { enabled: true, from: 23 * 60 + 30, to: 7 * 60, exceptMag: 6 },
});
assert.deepEqual(parseAlertSettings(JSON.parse(JSON.stringify({ version: 2, ...full }))), full);
const junk = parseAlertSettings({
  enabled: 1,
  countryIds: ['170', '170', 170],
  minMag: 'abc',
  countryMinMag: { '170': 99, '152': -2, x: 'y', '076': '3', ['__proto__']: 5 },
  quiet: { enabled: true, from: 5000, to: 'x', exceptMag: -1 },
});
assert.equal(junk.enabled, true);
assert.deepEqual(junk.countryIds, ['170']);
assert.equal(junk.minMag, 0);
assert.deepEqual(junk.countryMinMag, { '076': 3 });
assert.deepEqual(junk.quiet, { enabled: true, from: 22 * 60, to: 6 * 60, exceptMag: 0 });
assert.equal(({} as any).polluted, undefined);

// --- thresholds: a country value replaces the global one, in either direction
const th = settings({ minMag: 4, countryMinMag: { '170': 2.5, '152': 6 } });
assert.equal(thresholdFor(th, null), 4);
assert.equal(thresholdFor(th, '170'), 2.5);
assert.equal(thresholdFor(th, '152'), 6);
assert.equal(thresholdFor(th, '032'), 4);
assert.equal(thresholdFor(settings({ countryMinMag: { '170': 0 }, minMag: 5 }), '170'), 0, 'an explicit "all" beats a global threshold');
assert.equal(thresholdFor(th, 'toString'), 4, 'prototype keys are not thresholds');

// --- quiet hours, including a window across midnight and the boundaries
const night = { enabled: true, from: 22 * 60, to: 6 * 60, exceptMag: 0 };
assert.equal(isQuietNow(night, at(21, 59)), false);
assert.equal(isQuietNow(night, at(22, 0)), true, 'start is inside');
assert.equal(isQuietNow(night, at(23, 59)), true);
assert.equal(isQuietNow(night, at(0, 0)), true);
assert.equal(isQuietNow(night, at(5, 59)), true);
assert.equal(isQuietNow(night, at(6, 0)), false, 'end is outside');
assert.equal(isQuietNow(night, at(12, 0)), false);
const day = { enabled: true, from: 13 * 60, to: 15 * 60, exceptMag: 0 };
assert.equal(isQuietNow(day, at(12, 59)), false);
assert.equal(isQuietNow(day, at(13, 0)), true);
assert.equal(isQuietNow(day, at(14, 59)), true);
assert.equal(isQuietNow(day, at(15, 0)), false);
assert.equal(isQuietNow({ ...night, enabled: false }, at(23)), false);
assert.equal(isQuietNow({ ...night, from: 600, to: 600 }, at(10)), false, 'empty window never silences');

// --- time helpers
assert.equal(minutesToTime(0), '00:00');
assert.equal(minutesToTime(22 * 60 + 5), '22:05');
assert.equal(timeToMinutes('06:30'), 390);
assert.equal(timeToMinutes('23:59'), 1439);
assert.equal(timeToMinutes(''), null);
assert.equal(timeToMinutes('24:00'), null);
assert.equal(timeToMinutes('7:5'), null);

// --- pickAlert
const country = (id: string, name: string): CountryRef => ({ id, name });
const byLat = (qk: QuakeFeature): CountryRef | null => (qk.lat === 4 ? country('170', 'Colombia') : qk.lat === -33 ? country('152', 'Chile') : null);
const noon = at(12);

assert.equal(pickAlert([q('a', 5)], settings({ enabled: false }), byLat, noon), null, 'disabled');
assert.equal(pickAlert([], settings(), byLat, noon), null, 'nothing fresh');
assert.equal(pickAlert([q('a', 2)], settings(), byLat, noon)?.quake.id, 'a', 'everywhere, any magnitude');
assert.equal(pickAlert([q('a', null)], settings(), byLat, noon)?.quake.id, 'a', 'no magnitude passes only when the threshold is "all"');
assert.equal(pickAlert([q('a', null)], settings({ minMag: 2.5 }), byLat, noon), null);

// global threshold
assert.equal(pickAlert([q('a', 3.9)], settings({ minMag: 4 }), byLat, noon), null);
assert.equal(pickAlert([q('a', 4)], settings({ minMag: 4 }), byLat, noon)?.quake.id, 'a', 'threshold is inclusive');

// watched countries
const watch = settings({ countryIds: ['170'] });
assert.equal(pickAlert([q('chile', 6, 1, -33, 0)], watch, byLat, noon), null, 'unwatched country');
assert.equal(pickAlert([q('sea', 6, 1, 50, 0)], watch, byLat, noon), null, 'belongs to no country');
const hit = pickAlert([q('col', 3, 1, 4, 0)], watch, byLat, noon);
assert.equal(hit?.quake.id, 'col');
assert.equal(hit?.countryName, 'Colombia');
assert.equal(pickAlert([q('a', 5)], settings(), byLat, noon)?.countryName, undefined, 'no country label when watching everywhere');

// per-country thresholds
const mixed = settings({ countryIds: ['170', '152'], minMag: 5, countryMinMag: { '170': 3 } });
assert.equal(pickAlert([q('col', 3.2, 1, 4, 0)], mixed, byLat, noon)?.quake.id, 'col', 'Colombia is more sensitive');
assert.equal(pickAlert([q('chi', 4.9, 1, -33, 0)], mixed, byLat, noon), null, 'Chile follows the global 5');
assert.equal(pickAlert([q('chi', 5.1, 1, -33, 0)], mixed, byLat, noon)?.quake.id, 'chi');
const unwatched = settings({ countryIds: [], minMag: 5, countryMinMag: { '170': 1 } });
assert.equal(pickAlert([q('col', 3, 1, 4, 0)], unwatched, byLat, noon), null, 'overrides apply only to watched countries');

// strongest wins, ties go to the latest
assert.equal(pickAlert([q('a', 4, 1), q('b', 5.5, 2), q('c', 5, 3)], settings(), byLat, noon)?.quake.id, 'b');
assert.equal(pickAlert([q('a', 5, 1), q('b', 5, 9), q('c', 5, 3)], settings(), byLat, noon)?.quake.id, 'b');
assert.equal(pickAlert([q('a', null, 1), q('b', 1, 2)], settings(), byLat, noon)?.quake.id, 'b', 'a known magnitude beats an unknown one');
assert.equal(pickAlert([q('small', 2, 1, 4, 0), q('big', 6, 2, -33, 0)], watch, byLat, noon)?.quake.id, 'small', 'only watched quakes compete');

// quiet hours
const quietS = settings({ quiet: { enabled: true, from: 22 * 60, to: 6 * 60, exceptMag: 0 } });
assert.equal(pickAlert([q('a', 7)], quietS, byLat, at(23)), null, 'silent at night, whatever the magnitude');
assert.equal(pickAlert([q('a', 7)], quietS, byLat, at(7))?.quake.id, 'a', 'audible after the window');
const quietX = settings({ quiet: { enabled: true, from: 22 * 60, to: 6 * 60, exceptMag: 6 } });
assert.equal(pickAlert([q('a', 5.9)], quietX, byLat, at(2)), null);
assert.equal(pickAlert([q('a', 6)], quietX, byLat, at(2))?.quake.id, 'a', 'a strong quake breaks through');
assert.equal(pickAlert([q('a', null)], quietX, byLat, at(2)), null, 'unknown magnitude cannot break through');
assert.equal(pickAlert([q('a', 4), q('b', 6.5)], quietX, byLat, at(2))?.quake.id, 'b', 'only the breakthrough one is considered');
// the exception never lowers the normal threshold
assert.equal(pickAlert([q('a', 6)], settings({ minMag: 7, quiet: quietX.quiet }), byLat, at(2)), null);

// --- description
const names = { '170': 'Colombia', '152': 'Chile' };
assert.equal(describeAlertRule(settings({ enabled: false }), names), 'Las alertas están desactivadas.');
assert.equal(describeAlertRule(settings(), names), 'Avisará de sismos nuevos de cualquier magnitud en todo el mundo.');
assert.equal(
  describeAlertRule(full, names),
  'Avisará de sismos nuevos de magnitud 4.5 o más en Colombia (M3+), Chile (M5+). En silencio de 23:30 a 07:00, salvo M6+.'
);
assert.equal(
  describeAlertRule(settings({ countryIds: ['170'], countryMinMag: { '170': 4 }, minMag: 4, quiet: { enabled: true, from: 60, to: 120, exceptMag: 0 } }), names),
  'Avisará de sismos nuevos de magnitud 4 o más en Colombia. En silencio de 01:00 a 02:00.',
  'an override equal to the global threshold is not repeated'
);

console.log('alerts tests: ok');
