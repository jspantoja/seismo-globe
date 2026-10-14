import assert from 'node:assert/strict';
import { parseCatalog, mapCatalogRow } from '../lib/emsc';
import { getEarthquakes } from '../lib/usgs';
import { fetchJsonFirst } from '../lib/assets';
import { loadLastQuakes, saveLastQuakes } from '../lib/localCache';
import { sourceLabel } from '../lib/format';

const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ---------------------------------------------------------------- catalogue parser
const catalog = {
  type: 'FeatureCollection',
  metadata: { count: 3 },
  features: [
    { type: 'Feature', id: '20261012_0000418', geometry: { type: 'Point', coordinates: [36.56, 38.75, -5] },
      properties: { source_id: '2073746', source_catalog: 'EMSC-RTS', lastupdate: '2026-10-12T23:35:15.0Z', time: '2026-10-12T22:12:24.97Z',
        flynn_region: 'CENTRAL TURKEY', lat: 38.7542, lon: 36.5617, depth: 5.0, evtype: 'ke', auth: 'AFAD', mag: 3.2, magtype: 'ml', unid: '20261012_0000418' } },
    { type: 'Feature', id: 'geo_only', geometry: { type: 'Point', coordinates: [-74.2, 4.5, -30] },
      properties: { time: '2026-10-12T20:00:00Z', mag: '4.6', flynn_region: 'COLOMBIA' } },
    { type: 'Feature', id: 'bad', geometry: { type: 'Point', coordinates: [500, 4.5] }, properties: { time: '2026-10-12T20:00:00Z' } },
    { type: 'Feature', id: 'notime', geometry: { type: 'Point', coordinates: [1, 2] }, properties: {} },
    null,
  ],
};
const parsed = parseCatalog(catalog);
assert.equal(parsed.length, 2);
assert.equal(parsed[0].id, 'emsc-20261012_0000418');
assert.equal(parsed[0].source, 'EMSC-CAT');
assert.equal(parsed[0].mag, 3.2);
assert.equal(parsed[0].magType, 'ml');
assert.equal(parsed[0].depthKm, 5);
assert.equal(parsed[0].place, 'CENTRAL TURKEY');
assert.equal(parsed[0].status, 'automatic');
assert.equal(parsed[0].citizen, undefined);
assert.equal(parsed[0].url, 'https://www.emsc-csem.org/Earthquake_information/earthquake.php?id=2073746');
assert.equal(parsed[0].time, Date.UTC(2026, 9, 12, 22, 12, 24, 970));
// geometry-only event: lat/lng from coordinates, depth from the 3rd coordinate (negative = depth), mag string -> number
assert.equal(parsed[1].lat, 4.5);
assert.equal(parsed[1].lng, -74.2);
assert.equal(parsed[1].depthKm, 30);
assert.equal(parsed[1].mag, 4.6);
assert.equal(parseCatalog([]).length, 0);
assert.throws(() => parseCatalog({ nope: 1 }), /forma inesperada/);
assert.equal(mapCatalogRow(null as any), null);

// ---------------------------------------------------------------- USGS -> EMSC backup
const usgsOk = { features: [{ id: 'us1', geometry: { coordinates: [-74, 4.6, 10] }, properties: { mag: 4.5, place: 'x', time: 1000, updated: 1000, url: 'u', detail: 'd', status: 'reviewed' } }] };
let usgsUp = true;
let emscUp = true;
const calls: string[] = [];
globalThis.fetch = (async (input: any) => {
  const url = String(input);
  calls.push(url);
  if (url.includes('earthquake.usgs.gov')) {
    if (!usgsUp) throw new Error('boom usgs');
    return json(usgsOk);
  }
  if (url.includes('seismicportal.eu/fdsnws/event')) {
    if (!emscUp) return json({ error: 'x' }, 500);
    return json(catalog);
  }
  throw new Error('unexpected url ' + url);
}) as typeof fetch;

// 1) cold start with USGS down -> backup, flagged stale, never cached as USGS
usgsUp = false;
let r = await getEarthquakes('day', 0);
assert.equal(r.stale, true);
assert.match(r.staleReason ?? '', /USGS no responde/);
assert.match(r.staleReason ?? '', /EMSC/);
assert.ok(r.source.name.startsWith('EMSC'));
assert.equal(r.count, 2);
assert.ok(r.quakes.every((q) => q.source === 'EMSC-CAT'));
assert.match(calls.at(-1)!, /format=json/);
assert.match(calls.at(-1)!, /limit=3000/);
assert.doesNotMatch(calls.at(-1)!, /minmagnitude/);

// minmag is forwarded to the backup
r = await getEarthquakes('week', 4.5);
assert.match(calls.at(-1)!, /minmagnitude=4.5/);

// 2) both down, no cache -> throws with both reasons
emscUp = false;
await assert.rejects(() => getEarthquakes('hour', 0), /USGS.*EMSC.*caché/s);

// 3) USGS healthy -> normal; then USGS fails with a cache -> stale cached USGS (NOT the backup)
usgsUp = true; emscUp = true;
r = await getEarthquakes('month', 0);
assert.equal(r.stale, false);
assert.equal(r.quakes[0].source, 'USGS');
usgsUp = false;
const before = calls.length;
r = await getEarthquakes('month', 0);
assert.equal(r.stale, true);
assert.equal(r.quakes[0].source, 'USGS');
assert.ok(r.source.name.startsWith('USGS'));
assert.equal(calls.slice(before).filter((u) => u.includes('seismicportal')).length, 0, 'must not call the backup when a USGS cache exists');

// ---------------------------------------------------------------- fetchJsonFirst
const seen: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  seen.push(url);
  if (url === 'a-404') return new Response('nope', { status: 404 });
  if (url === 'a-html') return new Response('<html>not json</html>', { status: 200 });
  if (url === 'a-throw') throw new Error('network');
  if (url === 'a-hang') {
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  }
  if (url === 'ok') return json({ fine: true });
  throw new Error('unexpected ' + url);
}) as typeof fetch;

assert.deepEqual(await fetchJsonFirst(['ok', 'a-404']), { fine: true });
assert.deepEqual(seen, ['ok'], 'stops at the first URL that works');
seen.length = 0;
assert.deepEqual(await fetchJsonFirst(['a-404', 'a-html', 'a-throw', 'a-hang', 'ok'], 60), { fine: true });
assert.deepEqual(seen, ['a-404', 'a-html', 'a-throw', 'a-hang', 'ok']);
await assert.rejects(() => fetchJsonFirst(['a-404', 'a-throw'], 60), /network/);
await assert.rejects(() => fetchJsonFirst([]), /No hay URLs/);

globalThis.fetch = realFetch;

// ---------------------------------------------------------------- localStorage cache
class MemStorage {
  m = new Map<string, string>();
  failSet = false;
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { if (this.failSet) throw new Error('QuotaExceededError'); this.m.set(k, v); }
}
const ls = new MemStorage();
(globalThis as any).localStorage = ls;

const quake = (id: string) => ({ id, mag: 4, magType: null, place: null, time: 1, updated: 1, url: '', detailUrl: '', felt: null, tsunami: 0, alert: null, status: 'reviewed', sig: null, depthKm: 1, lat: 1, lng: 2, source: 'USGS' as const });
const resp = (stale = false) => ({ quakes: [quake('a'), quake('b')], source: { name: 'USGS', url: '', license: '', fetchedAt: '2026-10-13T00:00:00Z' }, stale, period: 'day' as const, minMagnitude: 0, count: 2 });

assert.equal(loadLastQuakes('day', 0), null, 'empty storage');
saveLastQuakes('day', 0, resp(true));
assert.equal(loadLastQuakes('day', 0), null, 'stale/backup data is never saved');
saveLastQuakes('day', 0, resp());
const got = loadLastQuakes('day', 0);
assert.equal(got?.data.quakes.length, 2);
assert.equal(got?.data.source.fetchedAt, '2026-10-13T00:00:00Z');
assert.equal(loadLastQuakes('week', 0), null, 'different period -> miss');
assert.equal(loadLastQuakes('day', 4.5), null, 'different magnitude -> miss');

ls.setItem('seismo-globe:last-usgs:v1', '{not json');
assert.equal(loadLastQuakes('day', 0), null, 'corrupted JSON');
ls.setItem('seismo-globe:last-usgs:v1', JSON.stringify({ key: 'day_0', savedAt: Date.now(), data: { quakes: [{ id: 1 }] } }));
assert.equal(loadLastQuakes('day', 0), null, 'malformed quakes rejected');
ls.setItem('seismo-globe:last-usgs:v1', JSON.stringify({ key: 'day_0', savedAt: Date.now() - 8 * 86400000, data: resp() }));
assert.equal(loadLastQuakes('day', 0), null, 'older than 7 days');

ls.failSet = true;
assert.doesNotThrow(() => saveLastQuakes('day', 0, resp()), 'quota errors are swallowed');
ls.failSet = false;
// huge payloads are skipped
const big = { ...resp(), quakes: Array.from({ length: 12000 }, (_, i) => quake('q' + i)) };
ls.m.clear();
saveLastQuakes('day', 0, big);
assert.equal(ls.m.size, 0, 'over the size cap -> not stored');
// no localStorage at all
delete (globalThis as any).localStorage;
assert.equal(loadLastQuakes('day', 0), null);
assert.doesNotThrow(() => saveLastQuakes('day', 0, resp()));

// ---------------------------------------------------------------- labels
assert.equal(sourceLabel('USGS'), 'USGS');
assert.equal(sourceLabel('SGC'), 'SGC, no oficial');
assert.equal(sourceLabel('EMSC'), 'EMSC, reportes ciudadanos');
assert.equal(sourceLabel('EMSC-CAT'), 'EMSC, respaldo');

console.log('ALL BACKUP / ASSET / CACHE TESTS PASSED');
