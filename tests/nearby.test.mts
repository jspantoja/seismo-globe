import assert from 'node:assert/strict';
import { distanceKm, bearingDeg, compassLabel, nearbyQuakes, circlePath, radiusPath, flightAltitudeFor, parseCoordinate } from '../lib/nearby';
import { pointScaleFor } from '../lib/globeView';
import type { QuakeFeature } from '../lib/types';

const close = (a: number, b: number, tol: number, msg: string) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// --- distance
close(distanceKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }), 111.19, 0.1, '1 degree of latitude');
close(distanceKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }), 111.19, 0.1, '1 degree of longitude at the equator');
close(distanceKm({ lat: 60, lng: 0 }, { lat: 60, lng: 1 }), 55.6, 0.2, 'longitude shrinks with latitude');
close(distanceKm({ lat: 4.711, lng: -74.0721 }, { lat: 6.2442, lng: -75.5812 }), 238, 4, 'Bogota - Medellin');
close(distanceKm({ lat: 0, lng: 179.5 }, { lat: 0, lng: -179.5 }), 111.19, 0.1, 'across the antimeridian');
assert.equal(distanceKm({ lat: 10, lng: 20 }, { lat: 10, lng: 20 }), 0);
close(distanceKm({ lat: 0, lng: 0 }, { lat: 0, lng: 180 }), 20015, 5, 'antipodes');

// --- bearing and compass
close(bearingDeg({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }), 0, 0.01, 'north');
close(bearingDeg({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }), 90, 0.01, 'east');
close(bearingDeg({ lat: 0, lng: 0 }, { lat: -1, lng: 0 }), 180, 0.01, 'south');
close(bearingDeg({ lat: 0, lng: 0 }, { lat: 0, lng: -1 }), 270, 0.01, 'west');
assert.deepEqual([0, 22, 23, 45, 90, 135, 180, 225, 270, 315, 337, 338, 359.9, 360, -45].map(compassLabel),
  ['N', 'N', 'NE', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO', 'NO', 'N', 'N', 'N', 'NO']);

// --- nearbyQuakes
const q = (id: string, lat: number, lng: number): QuakeFeature => ({ id, lat, lng, mag: 4, place: id, time: 0 } as unknown as QuakeFeature);
const here = { lat: 4.7, lng: -74.1 };
const list = [q('far', 40, 20), q('b', 5.4, -74.1), q('a', 4.8, -74.1), q('edge', 4.7 + 99 / 111.19, -74.1), q('out', 4.7 + 101 / 111.19, -74.1), q('e', 4.7, -73.5)];
const near = nearbyQuakes(list, here, 100);
assert.deepEqual(near.map((n) => n.quake.id), ['a', 'e', 'b', 'edge'], 'inside the radius, nearest first');
assert.equal(near[0].direction, 'N');
assert.equal(near[1].direction, 'E');
assert.ok(near.every((n) => n.distanceKm <= 100));
assert.deepEqual(nearbyQuakes([], here, 100), []);
assert.equal(nearbyQuakes(list, here, 50).length, 1, "only the 11 km one is within 50 km (e is 66 km, b is 78 km)");
// a radius reaching across the antimeridian
assert.deepEqual(nearbyQuakes([q('w', 0, -179.8), q('e', 0, 179.8)], { lat: 0, lng: 179.9 }, 50).map((n) => n.quake.id), ['e', 'w']);

// --- circle for the globe
for (const [c, r] of [[{ lat: 4.7, lng: -74.1 }, 200], [{ lat: 0, lng: 0 }, 50], [{ lat: 70, lng: 20 }, 500], [{ lat: -17, lng: 179.9 }, 200], [{ lat: 89, lng: 0 }, 200]] as const) {
  const ring = circlePath(c, r);
  assert.equal(ring.length, 97);
  close(ring[0][0], ring[ring.length - 1][0], 1e-6, 'closed (lat)');
  close(((ring[0][1] - ring[ring.length - 1][1]) % 360 + 540) % 360 - 180, 0, 1e-6, 'closed (lng, modulo a full turn)');
  for (const [lat, lng] of ring) close(distanceKm(c, { lat, lng }), r, 0.5, `ring point at ${r} km`);
  for (let i = 1; i < ring.length; i++) assert.ok(Math.abs(ring[i][1] - ring[i - 1][1]) < 40 || Math.abs(c.lat) > 80, 'longitude stays continuous (no wrap around the planet)');
}
const rp = radiusPath({ lat: 1, lng: 2 }, 200);
assert.equal(rp.boundaryType, 'near-radius');
assert.equal(rp.plateA, '200');

// --- camera
assert.ok(flightAltitudeFor(50) < flightAltitudeFor(200) && flightAltitudeFor(200) < flightAltitudeFor(500));
assert.ok(flightAltitudeFor(1) >= 0.15 && flightAltitudeFor(1e6) <= 1.2);

// --- typed coordinates
for (const [text, kind, expected] of [
  ['4.71', 'lat', 4.71], ['4,71', 'lat', 4.71], [' -74.07 ', 'lng', -74.07], ['+10', 'lat', 10], ['90', 'lat', 90], ['-90', 'lat', -90],
  ['180', 'lng', 180], ['-180', 'lng', -180], ['0', 'lat', 0], ['.5', 'lat', 0.5], ['5.', 'lat', 5],
  ['90.01', 'lat', null], ['181', 'lng', null], ['-181', 'lng', null], ['', 'lat', null], ['abc', 'lat', null], ['4.7.1', 'lat', null],
  ['1,2,3', 'lat', null], ['4°', 'lat', null], ['NaN', 'lat', null], ['Infinity', 'lng', null], ['1e2', 'lng', null], ['--5', 'lat', null],
] as const) assert.equal(parseCoordinate(text, kind), expected, `parseCoordinate(${JSON.stringify(text)}, ${kind})`);

// --- quake dots shrink as the camera gets close
assert.equal(pointScaleFor(2.2), 1);
assert.equal(pointScaleFor(5), 1, 'never bigger than the whole-planet size');
assert.equal(pointScaleFor(0.15), 0.3);
assert.ok(Math.abs(pointScaleFor(0.15 - 1e-9) - pointScaleFor(0.15)) < 0.001, 'no jump when crossing the closest flight');
assert.equal(pointScaleFor(0), 0.03, 'by hand the camera can go lower: dots keep their on-screen size, never below a tenth');
assert.ok(pointScaleFor(0.25) < pointScaleFor(1) && pointScaleFor(1) < pointScaleFor(2));
const steps = new Set<number>();
for (let a = 0.15; a <= 3; a += 0.01) steps.add(pointScaleFor(a)); // the range the app itself flies in
assert.ok(steps.size <= 9, `few distinct steps keep re-renders rare (${steps.size})`);

console.log('nearby tests: ok');
