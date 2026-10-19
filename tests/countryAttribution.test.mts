import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { feature } from 'topojson-client';
import { buildCountryIndex, countryOf, queryBoxesFor, OFFSHORE_KM } from '../lib/countryAttribution';

const square = (id: string, x0: number, y0: number, x1: number, y1: number) => ({
  type: 'Feature',
  id,
  properties: { name: id },
  geometry: { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] },
});

// ---------------------------------------------------------------- synthetic world
// A = 0..10 x 0..10, B = 10..20 x 0..10 (shares A's east edge), a hole in B, and an island C.
const B = square('B', 10, 0, 20, 10);
(B.geometry.coordinates as number[][][]).push([[14, 4], [14, 6], [16, 6], [16, 4], [14, 4]]); // lake
const world = buildCountryIndex([
  square('A', 0, 0, 10, 10),
  B,
  square('C', 30, 0, 32, 2),
  // one country split across the antimeridian, as in world-atlas
  { type: 'Feature', id: 'F', properties: { name: 'F' }, geometry: { type: 'MultiPolygon', coordinates: [
    [[[176, -20], [180, -20], [180, -16], [176, -16], [176, -20]]],
    [[[-180, -20], [-178, -20], [-178, -16], [-180, -16], [-180, -20]]],
  ] } },
]);

// territory wins, borders go to the side they are on
assert.equal(countryOf(world, 5, 5), 'A');
assert.equal(countryOf(world, 15, 2), 'B');
// inside B's lake (a hole) and within 200 km of B's shore -> still B (nearest), not "nobody"
assert.equal(countryOf(world, 15, 5), 'B');
// at sea: nearest country within the offshore distance
assert.equal(countryOf(world, 5, 11), 'A'); // ~110 km north of A
assert.equal(countryOf(world, 5, -1.5), 'A'); // ~166 km south of A
assert.equal(countryOf(world, 5, 12), null); // ~221 km: too far
assert.equal(countryOf(world, 5, 11.9), null); // ~210 km: still too far (km, not degrees)
assert.equal(countryOf(world, 5, 11.6), 'A'); // ~177 km
// between A and C the sea is split at the midpoint
assert.equal(countryOf(world, 21, 1), 'B'); // 1 deg from B, 9 from C
assert.equal(countryOf(world, 29, 1), 'C');
// longitude degrees shrink with latitude: same 1.5 deg gap, far fewer km at 70 N
const polar = buildCountryIndex([square('P', 0, 68, 10, 70)]);
assert.equal(countryOf(polar, 12.0, 69), 'P'); // 2 deg lng at 69 N ~ 80 km
assert.equal(countryOf(polar, 20.0, 69), null); // 10 deg ~ 400 km
// antimeridian: the same country on both sides, offshore on either side
assert.equal(countryOf(world, 178, -18), 'F');
assert.equal(countryOf(world, -179, -18), 'F');
assert.equal(countryOf(world, -178.5, -18), 'F'); // 0.5 deg east of the western piece
assert.equal(countryOf(world, 179.9, -14.5), 'F'); // sea just north of the eastern edge, across no gap
assert.equal(countryOf(world, -179.5, -14.5), 'F'); // other side of the line
assert.equal(countryOf(world, 0, 60), null);
// a shape drawn as ONE ring that jumps from 180 to -180 (Natural Earth does this): it is
// a small shape, not a sliver across the whole map
const wrapped = buildCountryIndex([
  { type: 'Feature', id: 'W', properties: { name: 'W' }, geometry: { type: 'Polygon', coordinates: [
    [[179, 0], [180, 0], [-180, 0], [-179, 0], [-179, 2], [-180, 2], [180, 2], [179, 2], [179, 0]],
  ] } },
]);
assert.equal(countryOf(wrapped, 179.5, 1), 'W');
assert.equal(countryOf(wrapped, -179.5, 1), 'W');
assert.equal(countryOf(wrapped, 0, 1), null, 'no sliver across the map');
assert.equal(countryOf(wrapped, 114, 1), null);
assert.equal(countryOf(wrapped, -178, 1), 'W'); // ~110 km east of it, across the line
assert.equal(countryOf(wrapped, 178, 1), 'W'); // ~110 km west of it
assert.equal(countryOf(wrapped, 175, 1), null); // ~440 km
{
  const boxes = queryBoxesFor(wrapped.byId.get('W')!);
  assert.ok(boxes.every((b) => b[2] - b[0] < 60), 'query rectangles stay small');
}
// nothing degenerate
assert.equal(countryOf(buildCountryIndex([]), 0, 0), null);
assert.equal(OFFSHORE_KM, 200);

// the USGS rectangles cover the territory plus the offshore margin, and never leave the map
{
  const boxes = queryBoxesFor(world.byId.get('A')!);
  const covers = (lng: number, lat: number) => boxes.some(([a, b, c, d]) => lng >= a && lng <= c && lat >= b && lat <= d);
  for (const [lng, lat] of [[5, 5], [5, 11.6], [5, -1.7], [-1.8, 5], [11.8, 5], [0.1, 0.1]]) assert.ok(covers(lng, lat), `${lng},${lat}`);
  assert.ok(!covers(5, 20), 'far sea is not requested');
  for (const [a, b, c, d] of boxes) assert.ok(a >= -180 && c <= 180 && b >= -90 && d <= 90 && a < c && b < d);
  const f = queryBoxesFor(world.byId.get('F')!);
  const cf = (lng: number, lat: number) => f.some(([a, b, c, d]) => lng >= a && lng <= c && lat >= b && lat <= d);
  assert.ok(cf(-177, -18) && cf(178, -18) && cf(-179.5, -14.5) && cf(179.5, -14.5), 'covers both sides of the antimeridian');
}

// ------------------------------------------------------------------- real borders
const topo = JSON.parse(readFileSync(new URL('../node_modules/world-atlas/countries-50m.json', import.meta.url), 'utf8'));
const real = buildCountryIndex((feature(topo, topo.objects.countries) as any).features);
const name = (id: string | null) => (id ? real.byId.get(id)?.name ?? id : null);

const places: [string, number, number, string | null][] = [
  ['Bogotá', -74.07, 4.71, 'Colombia'],
  ['Cúcuta (frontera con Venezuela)', -72.5, 7.89, 'Colombia'],
  ['San Cristóbal, Venezuela', -72.23, 7.77, 'Venezuela'],
  ['Caracas', -66.9, 10.49, 'Venezuela'],
  ['Ciudad de Panamá', -79.52, 8.98, 'Panama'],
  ['Quito', -78.5, -0.18, 'Ecuador'],
  ['Pacífico a ~100 km de Colombia', -78.4, 3.4, 'Colombia'],
  ['Tohoku 2011 (~130 km mar adentro)', 142.37, 38.3, 'Japan'],
  ['Fosa de Chile frente a Maule', -73.2, -35.9, 'Chile'],
  ['Mar de Banda, Indonesia', 128.0, -6.5, 'Indonesia'],
  ['Mar al suroeste de Attu (Aleutianas, ~100 km)', 172.0, 52.0, 'United States of America'],
  ['Dorsal mesoatlántica', -30, 0, null],
  ['Pacífico profundo', -140, 0, null],
  ['Los Ángeles', -118.25, 34.05, 'United States of America'],
  ['Wellington', 174.78, -41.29, 'New Zealand'],
  ['Islas Chatham', -176.5, -43.9, 'New Zealand'],
  ['Suva, Fiyi', 178.44, -18.14, 'Fiji'],
  ['Mar abierto en la franja de la antigua "astilla" de Fiyi', 114.9, -16.5, null],
  ['Idem, otra longitud', -30, -16.4, null],
  ['Taveuni, Fiyi (lado este del meridiano 180)', -179.9, -16.8, 'Fiji'],
  ['Maseru, Lesoto (enclave)', 27.48, -29.31, 'Lesotho'],
  ['Johannesburgo', 28.05, -26.2, 'South Africa'],
];
for (const [label, lng, lat, expected] of places) assert.equal(name(countryOf(real, lng, lat)), expected, label);

// a speed budget: 20,000 events (the most one statistics request can hold)
{
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const t0 = Date.now();
  const colombia = real.byId.get('170')!;
  const boxes = queryBoxesFor(colombia);
  let owned = 0;
  for (let i = 0; i < 20000; i++) {
    const [a, b, c, d] = boxes[Math.floor(rnd() * boxes.length)];
    if (countryOf(real, a + rnd() * (c - a), b + rnd() * (d - b)) === '170') owned++;
  }
  const ms = Date.now() - t0;
  assert.ok(owned > 0 && ms < 4000, `20,000 lookups took ${ms} ms`);
  console.log(`  20,000 lookups: ${ms} ms (${owned} in Colombia's share)`);
}

console.log('countryAttribution tests: ok');
