import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { feature } from 'topojson-client';
import { triangulate, polygonArea, trianglesArea } from '../engine/earcut';
import { planarPolygons, type PlanarPolygon } from '../engine/tessellate';

let seed = 987654321;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

function flatten(rings: number[][][]): { data: number[]; holes: number[] } {
  const data: number[] = [];
  const holes: number[] = [];
  rings.forEach((ring, k) => {
    // GeoJSON rings repeat the first point at the end: the triangulator wants it once.
    const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
    if (k > 0) holes.push(data.length / 2);
    for (const p of pts) data.push(p[0], p[1]);
  });
  return { data, holes };
}

function checkArea(name: string, data: number[], holes: number[], tol = 1e-9): number[] {
  const tris = triangulate(data, holes);
  const want = polygonArea(data, holes);
  const got = trianglesArea(data, tris);
  const dev = want === 0 ? Math.abs(got) : Math.abs(got - want) / want;
  assert.ok(dev <= tol, `${name}: triangle area ${got} vs polygon area ${want} (deviation ${dev})`);
  return tris;
}

// --- basic shapes
{
  const sq = [0, 0, 4, 0, 4, 4, 0, 4];
  const t = checkArea('square', sq, []);
  assert.equal(t.length / 3, 2, 'a square is two triangles');
  const rev = [0, 4, 4, 4, 4, 0, 0, 0];
  checkArea('square, other winding', rev, []);
  checkArea('L shape', [0, 0, 6, 0, 6, 2, 2, 2, 2, 6, 0, 6], []);
  checkArea('triangle', [0, 0, 5, 0, 0, 5], []);
  const hole = [0, 0, 10, 0, 10, 10, 0, 10, 3, 3, 3, 7, 7, 7, 7, 3];
  const th = checkArea('square with a square hole', hole, [4]);
  assert.equal(th.length / 3, 8, 'a square with a square hole is eight triangles');
  const two = [0, 0, 20, 0, 20, 10, 0, 10, 2, 2, 2, 8, 8, 8, 8, 2, 12, 2, 12, 8, 18, 8, 18, 2];
  checkArea('two holes', two, [4, 8]);
}

// --- degenerate input: repeated points, collinear runs, a closed ring
{
  checkArea('duplicate points', [0, 0, 0, 0, 4, 0, 4, 0, 4, 4, 0, 4, 0, 4], []);
  checkArea('collinear points on every side', [0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 4, 1, 4, 2, 4, 4, 2, 4, 0, 4, 0, 2], []);
  assert.deepEqual(triangulate([0, 0, 1, 1], []), [], 'two points make no triangle');
  assert.deepEqual(triangulate([0, 0, 1, 1, 2, 2], []), [], 'a straight line makes no triangle');
  assert.deepEqual(triangulate([], []), []);
}

// --- random star-shaped polygons, small and large (the large ones use the z-order index)
for (const n of [5, 12, 40, 79, 80, 81, 200, 1500, 6000]) {
  for (let k = 0; k < 6; k++) {
    const data: number[] = [];
    const cx = rnd() * 100 - 50;
    const cy = rnd() * 100 - 50;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = 5 + rnd() * 20;
      data.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    checkArea(`star n=${n}`, data, []);
  }
}

// --- polygons with many holes
for (let k = 0; k < 20; k++) {
  const data: number[] = [];
  const holes: number[] = [];
  const m = 60;
  for (let i = 0; i < m; i++) {
    const a = (i / m) * Math.PI * 2;
    data.push(Math.cos(a) * 50, Math.sin(a) * 30);
  }
  const placed: [number, number, number][] = [];
  const count = 1 + Math.floor(rnd() * 12);
  for (let h = 0; h < count; h++) {
    const hx = (rnd() - 0.5) * 70;
    const hy = (rnd() - 0.5) * 40;
    const hr = 1 + rnd() * 3;
    if (Math.hypot(hx / 50, hy / 30) > 0.7) continue;
    if (placed.some(([x, y, r]) => Math.hypot(x - hx, y - hy) < r + hr + 1)) continue;
    placed.push([hx, hy, hr]);
    holes.push(data.length / 2);
    const hm = 5 + Math.floor(rnd() * 10);
    for (let i = 0; i < hm; i++) {
      const a = (i / hm) * Math.PI * 2;
      data.push(hx + Math.cos(a) * hr, hy + Math.sin(a) * hr);
    }
  }
  checkArea(`ellipse with ${holes.length} holes`, data, holes);
}

// --- the real map: every polygon of the countries (110m and 50m) and of the tectonic plates
function topoFeatures(file: string): any[] {
  const topo = JSON.parse(readFileSync(new URL(`../public/data/${file}`, import.meta.url), 'utf8'));
  return (feature(topo, topo.objects[Object.keys(topo.objects)[0]]) as any).features;
}
// The map's polygons as the engine sees them: antimeridian jumps unwrapped, poles closed.
function polygonsOf(g: any): number[][][][] {
  return planarPolygons(g).map((p: PlanarPolygon) => p.rings.map((r) => Array.from({ length: r.length / 2 }, (_, i) => [r[i * 2], r[i * 2 + 1]])));
}

/** Number of proper crossings between non-adjacent edges of a ring (O(n²): only for short rings). */
function crossings(r: ArrayLike<number>): number {
  const n = r.length / 2;
  const ccw = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => Math.sign((cy - ay) * (bx - ax) - (by - ay) * (cx - ax));
  let found = 0;
  for (let i = 0; i < n; i++) {
    const a = i * 2, b = ((i + 1) % n) * 2;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = j * 2, d = ((j + 1) % n) * 2;
      if (ccw(r[a], r[a + 1], r[b], r[b + 1], r[c], r[c + 1]) !== ccw(r[a], r[a + 1], r[b], r[b + 1], r[d], r[d + 1]) &&
          ccw(r[c], r[c + 1], r[d], r[d + 1], r[a], r[a + 1]) !== ccw(r[c], r[c + 1], r[d], r[d + 1], r[b], r[b + 1])) found++;
    }
  }
  return found;
}

let worst = 0;
let invalid = 0;
let polys = 0;
let withHoles = 0;
let triCount = 0;
const t0 = performance.now();
for (const file of ['countries-110m.json', 'countries-50m.json']) {
  for (const f of topoFeatures(file)) {
    for (const rings of polygonsOf(f.geometry)) {
      const { data, holes } = flatten(rings);
      if (data.length < 6) continue;
      const tris = triangulate(data, holes);
      const want = polygonArea(data, holes);
      const got = trianglesArea(data, tris);
      const dev = want < 1e-12 ? 0 : Math.abs(got - want) / want;
      polys++;
      if (holes.length) withHoles++;
      triCount += tris.length / 3;
      // The simplified 110m data has a few outlines that cross themselves (Sudan, for one): for those no
      // triangulation can match the shoelace area, so they only have to be close.
      const selfCrossing = rings.length === 1 && rings[0].length < 700 && crossings(data) > 0;
      if (selfCrossing) {
        invalid++;
        assert.ok(dev < 0.03, `${file} ${f.properties?.name}: self-crossing outline, area deviation ${dev}`);
      } else {
        worst = Math.max(worst, dev);
        assert.ok(dev < 1e-6, `${file} ${f.properties?.name}: area deviation ${dev}`);
      }
    }
  }
}
const ms = performance.now() - t0;
console.log(`  ${polys} country polygons (${withHoles} with holes), ${triCount} triangles, worst area deviation ${worst.toExponential(2)} (${invalid} outlines cross themselves in the source data), ${ms.toFixed(0)} ms`);

{
  const plates = JSON.parse(readFileSync(new URL('../public/data/PB2002_plates.json', import.meta.url), 'utf8')).features as any[];
  let n = 0;
  for (const f of plates) {
    for (const rings of polygonsOf(f.geometry)) {
      const { data, holes } = flatten(rings);
      if (data.length < 6) continue;
      const tris = triangulate(data, holes);
      const want = polygonArea(data, holes);
      const got = trianglesArea(data, tris);
      assert.ok(Math.abs(got - want) / want < 1e-6, `plate ${f.properties?.Code}: area ${got} vs ${want}`);
      n++;
    }
  }
  console.log(`  ${n} plate polygons triangulated exactly`);
}

// --- every point of the polygon is covered by exactly one triangle, and no triangle sticks out
{
  const names = new Set(['Colombia', 'Chile', 'Indonesia', 'Canada', 'Italy', 'South Africa', 'Japan', 'Norway']);
  const feats = topoFeatures('countries-50m.json').filter((f) => names.has(f.properties?.name));
  assert.ok(feats.length >= 6, 'found the sample countries');
  const inRing = (x: number, y: number, ring: number[]) => {
    let inside = false;
    for (let i = 0, j = ring.length / 2 - 1; i < ring.length / 2; j = i++) {
      const xi = ring[i * 2], yi = ring[i * 2 + 1], xj = ring[j * 2], yj = ring[j * 2 + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  let samples = 0;
  for (const f of feats) {
    for (const rings of polygonsOf(f.geometry)) {
      const { data, holes } = flatten(rings);
      if (data.length < 60) continue;
      const tris = triangulate(data, holes);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < data.length; i += 2) {
        minX = Math.min(minX, data[i]); maxX = Math.max(maxX, data[i]);
        minY = Math.min(minY, data[i + 1]); maxY = Math.max(maxY, data[i + 1]);
      }
      const bounds = [0, ...holes, data.length / 2].map((v) => v * 2);
      for (let s = 0; s < 400; s++) {
        const x = minX + rnd() * (maxX - minX);
        const y = minY + rnd() * (maxY - minY);
        let inside = false;
        for (let r = 0; r + 1 < bounds.length; r++) if (inRing(x, y, data.slice(bounds[r], bounds[r + 1]))) inside = !inside;
        let covered = 0;
        for (let i = 0; i < tris.length; i += 3) {
          const ax = data[tris[i] * 2], ay = data[tris[i] * 2 + 1], bx = data[tris[i + 1] * 2], by = data[tris[i + 1] * 2 + 1], cx = data[tris[i + 2] * 2], cy = data[tris[i + 2] * 2 + 1];
          const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
          const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
          const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
          const neg = d1 < 0 || d2 < 0 || d3 < 0;
          const pos = d1 > 0 || d2 > 0 || d3 > 0;
          if (!(neg && pos)) covered++;
        }
        samples++;
        assert.equal(covered, inside ? 1 : 0, `${f.properties?.name}: point (${x.toFixed(3)}, ${y.toFixed(3)}) ${inside ? 'inside' : 'outside'} covered ${covered} times`);
      }
    }
  }
  console.log(`  ${samples} random points: covered exactly once inside, never outside`);
}

console.log('engine earcut tests: ok');
