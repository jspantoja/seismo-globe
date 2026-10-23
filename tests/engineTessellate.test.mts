import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { feature } from 'topojson-client';
import { planarPolygons, planarRing, tessellate, DEFAULT_MAX_EDGE_DEG, type PlanarPolygon } from '../engine/tessellate';
import { geoToVec, DEG2RAD, angleBetween, RAD2DEG } from '../engine/math';

const read = (f: string) => JSON.parse(readFileSync(new URL(`../public/data/${f}`, import.meta.url), 'utf8'));
const features = (f: string): any[] => {
  const topo = read(f);
  return (feature(topo, topo.objects[Object.keys(topo.objects)[0]]) as any).features;
};

// --- unwrapping the antimeridian
{
  // A small island split by the antimeridian but stored as one ring (the way the source data has Fiji).
  const ring = [[-180, -16.0], [-179.8, -16.0], [-179.9, -16.5], [-180, -16.55], [179.36, -16.8], [178.7, -17.0], [178.6, -16.6], [179.1, -16.4], [179.4, -16.3], [180, -16.0], [-180, -16.0]];
  const r = planarRing(ring)!;
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < r.length; i += 2) { minX = Math.min(minX, r[i]); maxX = Math.max(maxX, r[i]); }
  assert.ok(maxX - minX < 3, `the ring spans ${maxX - minX} degrees of longitude after unwrapping`);
  // The same ring entered the other way round the antimeridian gives the same shape.
  const shifted = ring.map(([x, y]) => [x < 0 ? x + 360 : x, y]);
  const r2 = planarRing(shifted)!;
  let mn2 = Infinity, mx2 = -Infinity;
  for (let i = 0; i < r2.length; i += 2) { mn2 = Math.min(mn2, r2[i]); mx2 = Math.max(mx2, r2[i]); }
  assert.ok(mx2 - mn2 < 3);
  // A ring around the south pole (it runs the full 360 degrees of longitude) is closed along the pole.
  const polar = [[-180, -70], [-90, -72], [0, -75], [90, -72], [180, -70], [180, -90], [-180, -90], [-180, -70]];
  const pr = planarRing(polar)!;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < pr.length; i += 2) { lo = Math.min(lo, pr[i]); hi = Math.max(hi, pr[i]); }
  assert.ok(hi - lo >= 359.9 && hi - lo <= 360.1, `polar ring spans ${hi - lo}`);
  const open = [[-180, -70], [-90, -72], [0, -75], [90, -72], [179.9, -70]];
  const or = planarRing(open)!;
  assert.ok(Array.from(or).some((v, i) => i % 2 === 1 && v === -90), 'an open ring around the pole is closed along it');
  assert.equal(planarRing([[0, 0], [1, 1]]), null);
  assert.equal(planarRing([[0, 0], [0, 0], [0, 0]]), null);
}

/** Spherical area (steradians) of the region a planar ring bounds, with edges straight in (lng, lat): |∮ sin(lat) dlng|. */
function ringArea(r: ArrayLike<number>): number {
  const n = r.length / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const l0 = r[i * 2] * DEG2RAD, p0 = r[i * 2 + 1] * DEG2RAD, l1 = r[j * 2] * DEG2RAD, p1 = r[j * 2 + 1] * DEG2RAD;
    const dp = p1 - p0;
    sum += (l1 - l0) * (Math.abs(dp) < 1e-12 ? Math.sin(p0) : (Math.cos(p0) - Math.cos(p1)) / dp);
  }
  return Math.abs(sum);
}
const polygonSr = (p: PlanarPolygon) => p.rings.reduce((acc, r, k) => acc + (k === 0 ? 1 : -1) * ringArea(r), 0);

/** Area of the flat triangles of a mesh, in steradians on the unit sphere (flat area; the sphere is smooth enough here). */
function meshSr(m: { vertices: Float32Array; indices: Uint32Array }): number {
  const P = (i: number) => [m.vertices[i * 6] + m.vertices[i * 6 + 3], m.vertices[i * 6 + 1] + m.vertices[i * 6 + 4], m.vertices[i * 6 + 2] + m.vertices[i * 6 + 5]];
  let total = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = P(m.indices[t]), b = P(m.indices[t + 1]), c = P(m.indices[t + 2]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    total += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return total;
}

/** True when a short ring crosses itself (a few outlines of the simplified 110m data do; no mesh can be exact for them). */
function crossesItself(r: ArrayLike<number>): boolean {
  const n = r.length / 2;
  if (n > 700) return false;
  const ccw = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => Math.sign((cy - ay) * (bx - ax) - (by - ay) * (cx - ax));
  for (let i = 0; i < n; i++) {
    const a = i * 2, b = ((i + 1) % n) * 2;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = j * 2, d = ((j + 1) % n) * 2;
      if (ccw(r[a], r[a + 1], r[b], r[b + 1], r[c], r[c + 1]) !== ccw(r[a], r[a + 1], r[b], r[b + 1], r[d], r[d + 1]) &&
          ccw(r[c], r[c + 1], r[d], r[d + 1], r[a], r[a + 1]) !== ccw(r[c], r[c + 1], r[d], r[d + 1], r[b], r[b + 1])) return true;
    }
  }
  return false;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function checkMesh(name: string, poly: PlanarPolygon, deep: boolean): { sr: number; want: number; triangles: number } {
  const mesh = tessellate(poly, DEFAULT_MAX_EDGE_DEG, true);
  assert.ok(mesh, `${name}: a mesh`);
  const m = mesh!;
  assert.equal(m.vertices.length, m.vertexCount * 6);
  const planar = m.planar!;
  // Valid indices, finite numbers, vertices on the unit sphere and equal to the exact position.
  for (let i = 0; i < m.indices.length; i++) assert.ok(m.indices[i] < m.vertexCount, `${name}: index in range`);
  for (let v = 0; v < m.vertexCount; v++) {
    const exact = geoToVec(planar[v * 2 + 1], planar[v * 2]);
    for (let k = 0; k < 3; k++) {
      const got = m.vertices[v * 6 + k] + m.vertices[v * 6 + 3 + k];
      assert.ok(Number.isFinite(got) && Math.abs(got - exact[k]) < 1e-14, `${name}: hi + lo reproduces the position (${got} vs ${exact[k]})`);
    }
  }
  // No edge is longer than the limit on the sphere.
  let longest = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = m.indices[t + e], b = m.indices[t + ((e + 1) % 3)];
      const ang = angleBetween(geoToVec(planar[a * 2 + 1], planar[a * 2]), geoToVec(planar[b * 2 + 1], planar[b * 2])) * RAD2DEG;
      longest = Math.max(longest, ang);
    }
  }
  assert.ok(longest <= DEFAULT_MAX_EDGE_DEG * 1.05, `${name}: longest edge ${longest}°`);

  // Edge use: nothing is shared by more than two triangles, and every edge used once lies on the outline (no cracks).
  const use = new Map<number, number>();
  for (let t = 0; t < m.indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = m.indices[t + e], b = m.indices[t + ((e + 1) % 3)];
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      use.set(key, (use.get(key) ?? 0) + 1);
    }
  }
  if (deep && !poly.rings.some(crossesItself)) {
    for (const [key, count] of use) {
      assert.ok(count <= 2, `${name}: an edge used by ${count} triangles`);
      if (count !== 1) continue;
      const a = Math.floor(key / 4294967296), b = key % 4294967296;
      const mx = (planar[a * 2] + planar[b * 2]) / 2, my = (planar[a * 2 + 1] + planar[b * 2 + 1]) / 2;
      let onOutline = false;
      for (const r of poly.rings) {
        const n = r.length / 2;
        for (let i = 0; i < n && !onOutline; i++) {
          const j = (i + 1) % n;
          if (distToSegment(mx, my, r[i * 2], r[i * 2 + 1], r[j * 2], r[j * 2 + 1]) < 1e-7) onOutline = true;
        }
        if (onOutline) break;
      }
      assert.ok(onOutline, `${name}: a crack inside the mesh (edge ${a}-${b} at ${mx.toFixed(3)}, ${my.toFixed(3)})`);
    }
  }

  const want = polygonSr(poly);
  const sr = meshSr(m);
  return { sr, want, triangles: m.indices.length / 3 };
}

// --- the map
let worst = 0;
let count = 0;
let tris = 0;
const t0 = performance.now();
for (const f of features('countries-110m.json')) {
  if (f.properties?.name === 'Antarctica') continue;
  for (const poly of planarPolygons(f.geometry)) {
    const { sr, want, triangles } = checkMesh(`110m ${f.properties?.name}`, poly, true);
    // Flat triangles sit slightly inside the sphere: allow a little, and more for tiny polygons (rounding).
    const rel = Math.abs(sr - want) / Math.max(want, 1e-9);
    if (want > 1e-5) worst = Math.max(worst, rel);
    assert.ok(rel < 0.02 || Math.abs(sr - want) < 2e-7, `110m ${f.properties?.name}: mesh ${sr} sr vs outline ${want} sr`);
    count++;
    tris += triangles;
  }
}
console.log(`  110m countries: ${count} polygons, ${tris} triangles, worst area error ${(worst * 100).toFixed(2)}%, ${(performance.now() - t0).toFixed(0)} ms`);

{
  const plates = read('PB2002_plates.json').features as any[];
  let n = 0, t = 0;
  const t1 = performance.now();
  for (const f of plates) {
    for (const poly of planarPolygons(f.geometry)) {
      const { sr, want, triangles } = checkMesh(`plate ${f.properties?.Code}`, poly, true);
      assert.ok(Math.abs(sr - want) / want < 0.03, `plate ${f.properties?.Code}: mesh ${sr} sr vs outline ${want} sr`);
      n++;
      t += triangles;
    }
  }
  console.log(`  plates: ${n} polygons, ${t} triangles, ${(performance.now() - t1).toFixed(0)} ms`);
  // The plates tile the planet: their areas add up to 4π.
  let sum = 0;
  for (const f of plates) for (const poly of planarPolygons(f.geometry)) sum += meshSr(tessellate(poly)!);
  assert.ok(Math.abs(sum - 4 * Math.PI) / (4 * Math.PI) < 0.02, `the plates cover ${(sum / (4 * Math.PI) * 100).toFixed(2)}% of the sphere`);
  console.log(`  the plates cover ${(sum / (4 * Math.PI) * 100).toFixed(2)}% of the sphere`);
}

{
  const t2 = performance.now();
  let n = 0, t = 0, v = 0, slow = 0;
  for (const f of features('countries-50m.json')) {
    if (f.properties?.name === 'Antarctica') continue;
    for (const poly of planarPolygons(f.geometry)) {
      const t3 = performance.now();
      const mesh = tessellate(poly);
      slow = Math.max(slow, performance.now() - t3);
      if (!mesh) continue;
      n++;
      t += mesh.indices.length / 3;
      v += mesh.vertexCount;
    }
  }
  console.log(`  50m countries: ${n} polygons, ${t} triangles, ${v} vertices, ${(performance.now() - t2).toFixed(0)} ms (slowest polygon ${slow.toFixed(0)} ms)`);
}

console.log('engine tessellate tests: ok');
