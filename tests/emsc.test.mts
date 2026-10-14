import assert from 'node:assert/strict';
import { parseTestimonies, mapEmscRow, parseEmscTime } from '../lib/emsc';
import { mergeCitizenReports } from '../lib/citizen';
import type { QuakeFeature } from '../lib/types';

// --- time parsing
assert.equal(parseEmscTime('2026-02-22T16:57:45.650 UTC'), Date.UTC(2026, 1, 22, 16, 57, 45, 650));
assert.equal(parseEmscTime('2026-02-22T16:57:45Z'), Date.UTC(2026, 1, 22, 16, 57, 45));
assert.equal(parseEmscTime('2026-02-22T16:57:45'), Date.UTC(2026, 1, 22, 16, 57, 45)); // no Z -> UTC
assert.equal(parseEmscTime('2026-02-22 16:57:45'), Date.UTC(2026, 1, 22, 16, 57, 45));
assert.equal(parseEmscTime(1771779465), 1771779465000);
assert.equal(parseEmscTime(1771779465000), 1771779465000);
assert.equal(parseEmscTime('nonsense'), null);
assert.equal(parseEmscTime(null), null);

// --- shape A: flat ev_* rows (format=json example)
const shapeA = [
  { ev_unid: '20260222_0000123', ev_evid: '1234567', ev_event_time: '2026-02-22T16:57:45.650 UTC', ev_latitude: 4.5, ev_longitude: -74.2, ev_depth: 10, ev_mag_value: 4.6, ev_mag_type: 'mb', ev_region: 'COLOMBIA', ev_nbtestimonies: 37, ev_last_update: '2026-02-22T17:10:00 UTC' },
  { ev_unid: 'x2', ev_event_time: '2026-02-22T10:00:00Z', ev_latitude: 40, ev_longitude: 10, ev_nbtestimonies: 0 }, // 0 testimonies -> dropped
  { ev_unid: 'x3', ev_event_time: 'bad', ev_latitude: 40, ev_longitude: 10, ev_nbtestimonies: 5 }, // bad time -> dropped
  { ev_unid: 'x4', ev_event_time: '2026-02-22T10:00:00Z', ev_latitude: 99, ev_longitude: 10, ev_nbtestimonies: 5 }, // bad lat -> dropped
  null,
  'junk',
];
const a = parseTestimonies(shapeA);
assert.equal(a.length, 1);
assert.equal(a[0].id, 'emsc-20260222_0000123');
assert.equal(a[0].source, 'EMSC');
assert.equal(a[0].mag, 4.6);
assert.equal(a[0].magType, 'mb');
assert.equal(a[0].place, 'COLOMBIA');
assert.equal(a[0].depthKm, 10);
assert.equal(a[0].felt, null);
assert.equal(a[0].status, 'automatic');
assert.equal(a[0].citizen?.reports, 37);
assert.equal(a[0].citizen?.url, 'https://www.emsc-csem.org/Earthquake_information/earthquake.php?id=1234567');

// --- shape B: GeoJSON FeatureCollection
const shapeB = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', id: '20260222_0000999', geometry: { type: 'Point', coordinates: [-70.1, -33.2, -25] }, properties: { time: '2026-02-22T18:00:00.0Z', mag: 5.1, magtype: 'mw', flynn_region: 'CENTRAL CHILE', feltreportCount: '12', source_id: '777' } },
  ],
};
const b = parseTestimonies(shapeB);
assert.equal(b.length, 1);
assert.equal(b[0].lat, -33.2);
assert.equal(b[0].lng, -70.1);
assert.equal(b[0].depthKm, 25);
assert.equal(b[0].citizen?.reports, 12);
assert.equal(b[0].place, 'CENTRAL CHILE');

// --- envelopes + errors
assert.equal(parseTestimonies({ events: shapeA }).length, 1);
assert.equal(parseTestimonies([]).length, 0);
assert.throws(() => parseTestimonies({ foo: 1 }), /forma inesperada/);
assert.throws(() => parseTestimonies(null), /forma inesperada/);

// duplicates collapse
assert.equal(parseTestimonies([...shapeA, ...shapeA]).length, 1);

// --- merge
const mk = (id: string, t: number, lat: number, lng: number, mag: number | null, source: 'USGS' | 'SGC' = 'USGS'): QuakeFeature => ({
  id, mag, magType: null, place: null, time: t, updated: t, url: '', detailUrl: '', felt: null, tsunami: 0, alert: null,
  status: 'reviewed', sig: null, depthKm: 10, lat, lng, source,
});
const rep = (id: string, t: number, lat: number, lng: number, mag: number | null, n: number): QuakeFeature => ({
  ...mk(id, t, lat, lng, mag), source: 'EMSC', status: 'automatic', citizen: { source: 'EMSC', reports: n, url: 'u', eventId: id },
});

const T = Date.UTC(2026, 9, 12, 12, 0, 0);
const base = [
  mk('us1', T, 4.5, -74.2, 4.5),
  mk('us2', T + 3_600_000, 35, 139, 5.0),
  mk('sgc1', T + 20_000, 4.52, -74.18, 4.4, 'SGC'),
];

// a matches us1 (and not sgc1 first because score is lower for us1)
let m = mergeCitizenReports(base, [rep('e1', T + 5_000, 4.5, -74.21, 4.6, 40)]);
assert.equal(m.length, 3);
assert.equal(m[0].citizen?.reports, 40);
assert.equal(m[0].source, 'USGS');
assert.equal(m[2].citizen, undefined);
assert.equal(base[0].citizen, undefined, 'must not mutate input');

// two reports for the same area: only one base each; the 2nd falls to sgc1
m = mergeCitizenReports(base, [rep('e1', T + 5_000, 4.5, -74.21, 4.6, 40), rep('e2', T + 6_000, 4.5, -74.2, 4.5, 10)]);
assert.equal(m.length, 3);
assert.equal(m.filter((q) => q.citizen).length, 2);
assert.equal(m[0].citizen?.eventId, 'e1');
assert.equal(m[2].citizen?.eventId, 'e2');

// too far (>100 km) or too late (>90 s) or magnitude gap (>1) -> standalone
m = mergeCitizenReports(base, [rep('far', T, 6, -74.2, 4.5, 3)]);
assert.equal(m.length, 4); assert.equal(m[3].source, 'EMSC');
m = mergeCitizenReports(base, [rep('late', T + 200_000, 4.5, -74.2, 4.5, 3)]);
assert.equal(m.length, 4); assert.equal(m[3].id, 'late');
m = mergeCitizenReports(base, [rep('dmag', T, 4.5, -74.2, 6.0, 3)]);
assert.equal(m.length, 4);

// null magnitudes still match on space/time
m = mergeCitizenReports(base, [rep('nomag', T + 1000, 35.01, 139.0, null, 8)]);
assert.equal(m.length, 4); // us2 is 1h later -> no match, standalone
// ...and a real match with null mag:
m = mergeCitizenReports(base, [rep('nomag2', T + 3_600_000 + 1000, 35.01, 139.0, null, 8)]);
assert.equal(m.length, 3); assert.equal(m[1].citizen?.reports, 8);

// empty cases
assert.equal(mergeCitizenReports(base, []), base);
assert.deepEqual(mergeCitizenReports([], [rep('solo', T, 0, 0, 3, 2)]).map((q) => q.id), ['solo']);

// performance sanity: 20k base x 1k reports
const big: QuakeFeature[] = Array.from({ length: 20000 }, (_, i) => mk(`b${i}`, T - i * 3000, (i % 180) - 90, (i % 360) - 180, 3));
const reps = Array.from({ length: 1000 }, (_, i) => rep(`r${i}`, T - i * 3000 + 1000, (i % 180) - 90, (i % 360) - 180, 3, 1 + (i % 7)));
const t0 = performance.now();
const mm = mergeCitizenReports(big, reps);
const ms = performance.now() - t0;
assert.equal(mm.length, 20000);
assert.equal(mm.filter((q) => q.citizen).length, 1000);
assert.ok(ms < 500, `merge too slow: ${ms}ms`);

console.log(`ALL EMSC TESTS PASSED (merge 20k×1k in ${ms.toFixed(1)} ms)`);
