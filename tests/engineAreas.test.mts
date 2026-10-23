import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { feature } from 'topojson-client';
import { AreaAssembler, toRgba, type AreaSpec } from '../engine/areas';
import { AreaIndex } from '../engine/picker';
import { planarPolygons } from '../engine/tessellate';
import { SEGMENT_BYTES, SEGMENT_FLOATS, SegmentBuffer, densify, edgeKey, onAntimeridian, ringStrokes } from '../engine/linegeom';
import { distanceToArc } from '../engine/surface';
import { RAD2DEG, angleBetween, geoToVec } from '../engine/math';

const close = (a: number, b: number, tol: number, msg: string) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const read = (f: string) => JSON.parse(readFileSync(new URL(`../public/data/${f}`, import.meta.url), 'utf8'));
const countries = (f: string): any[] => {
  const topo = read(f);
  return (feature(topo, topo.objects[Object.keys(topo.objects)[0]]) as any).features.filter((x: any) => x.properties?.name !== 'Antarctica');
};

// --- colours
assert.deepEqual(toRgba('rgba(110, 140, 180, 0.12)'), [110, 140, 180, 31]);
assert.deepEqual(toRgba('#4fd1c5'), [79, 209, 197, 255]);
assert.deepEqual(toRgba(null), [0, 0, 0, 0]);
assert.equal(toRgba('hsla(120, 55%, 55%, 0.28)')[3], 71);

// --- edge keys
{
  assert.equal(edgeKey(10, 20, 11, 21), edgeKey(11, 21, 10, 20), 'direction does not matter');
  assert.equal(edgeKey(180, 10, 180, 12), edgeKey(-180, 10, -180, 12), 'the antimeridian is one place');
  assert.equal(edgeKey(190, 10, 191, 12), edgeKey(-170, 10, -169, 12), 'whole turns of longitude are the same place');
  assert.notEqual(edgeKey(10, 20, 11, 21), edgeKey(10, 20, 11, 21.00002), 'different edges differ');
  assert.ok(onAntimeridian(180, -180) && onAntimeridian(180, 180) && onAntimeridian(-180, -180) && !onAntimeridian(180, 179) && !onAntimeridian(10, 10));
}

// --- densify: great circle arcs, short steps, exact end points
{
  const path = densify([0, 0, 90, 0, 90, 60], false, 1);
  assert.equal(path.closed, false);
  assert.equal(path.count, 90 + 60 + 1, 'one point per degree of arc, plus the last');
  assert.equal(path.edgeOf.length, path.count - 1);
  const pos = (i: number) => [path.pts[i * 6] + path.pts[i * 6 + 3], path.pts[i * 6 + 1] + path.pts[i * 6 + 4], path.pts[i * 6 + 2] + path.pts[i * 6 + 5]] as [number, number, number];
  for (let i = 0; i + 1 < path.count; i++) assert.ok(angleBetween(pos(i), pos(i + 1)) * RAD2DEG <= 1.0001, 'steps of at most a degree');
  const want = geoToVec(60, 90);
  for (let k = 0; k < 3; k++) close(pos(path.count - 1)[k], want[k], 1e-15, 'last point exact');
  assert.equal(path.edgeOf[0], 0);
  assert.equal(path.edgeOf[path.count - 2], 1);
  // The long way round the antimeridian is not taken: 170E to 170W is 20 degrees.
  const across = densify([170, 0, -170, 0], false, 1);
  assert.equal(across.count, 21);
  const ring = densify([0, 0, 10, 0, 10, 10], true, 5);
  assert.equal(ring.closed, true);
  assert.equal(ring.edgeOf.length, ring.count);
}

// --- segment buffer: neighbours, skipping, layout
{
  const path = densify([0, 0, 2, 0, 4, 0, 6, 0], false, 10); // three segments, one per edge
  assert.equal(path.count, 4);
  const buf = new SegmentBuffer(2);
  buf.addPath(path, 1.5, [10, 20, 30, 255]);
  assert.equal(buf.count, 3);
  const f = new Float32Array(buf.view().buffer, buf.view().byteOffset, buf.count * SEGMENT_FLOATS);
  assert.equal(buf.view().length, 3 * SEGMENT_BYTES);
  // Segment 1: previous = point 0, next = point 3
  const hiOf = (i: number) => [path.pts[i * 6], path.pts[i * 6 + 1], path.pts[i * 6 + 2]];
  assert.deepEqual([f[SEGMENT_FLOATS + 12], f[SEGMENT_FLOATS + 13], f[SEGMENT_FLOATS + 14]], hiOf(0));
  assert.deepEqual([f[SEGMENT_FLOATS + 15], f[SEGMENT_FLOATS + 16], f[SEGMENT_FLOATS + 17]], hiOf(3));
  assert.equal(f[SEGMENT_FLOATS + 18], 1.5, 'width');
  assert.deepEqual(Array.from(buf.view().subarray(SEGMENT_BYTES + 76, SEGMENT_BYTES + 80)), [10, 20, 30, 255], 'colour');
  // Segment 0 has no previous: it repeats its own start; the last has no next: it repeats its end.
  assert.deepEqual([f[12], f[13], f[14]], hiOf(0));
  assert.deepEqual([f[2 * SEGMENT_FLOATS + 15], f[2 * SEGMENT_FLOATS + 16], f[2 * SEGMENT_FLOATS + 17]], hiOf(3));
  // Skipping the middle edge leaves two segments that end without joining across the gap.
  const gap = new SegmentBuffer(2);
  gap.addPath(path, 1, [1, 1, 1, 255], (e) => e === 1);
  assert.equal(gap.count, 2);
  const g = new Float32Array(gap.view().buffer, gap.view().byteOffset, gap.count * SEGMENT_FLOATS);
  assert.deepEqual([g[15], g[16], g[17]], [g[6], g[7], g[8]], 'the segment before the gap has no next');
  assert.deepEqual([g[SEGMENT_FLOATS + 12], g[SEGMENT_FLOATS + 13], g[SEGMENT_FLOATS + 14]], [g[SEGMENT_FLOATS], g[SEGMENT_FLOATS + 1], g[SEGMENT_FLOATS + 2]], 'the segment after it has no previous');
  // A closed path wraps around.
  const loop = densify([0, 0, 4, 0, 2, 3], true, 10);
  const lb = new SegmentBuffer(1);
  lb.addPath(loop, 1, [0, 0, 0, 255]);
  assert.equal(lb.count, 3);
  const l = new Float32Array(lb.view().buffer, lb.view().byteOffset, lb.count * SEGMENT_FLOATS);
  const hl = (i: number) => [loop.pts[i * 6], loop.pts[i * 6 + 1], loop.pts[i * 6 + 2]];
  assert.deepEqual([l[12], l[13], l[14]], hl(2), 'segment 0 of a loop: previous is the last point');
  assert.deepEqual([l[2 * SEGMENT_FLOATS + 15], l[2 * SEGMENT_FLOATS + 16], l[2 * SEGMENT_FLOATS + 17]], hl(1), 'last segment of a loop: next is the second point');
}

// --- distance to an arc
{
  const a = geoToVec(0, 0), b = geoToVec(0, 10);
  close(distanceToArc(geoToVec(0, 5), a, b) * RAD2DEG, 0, 1e-9, 'on the arc');
  close(distanceToArc(geoToVec(2, 5), a, b) * RAD2DEG, 2, 1e-6, 'beside the arc');
  close(distanceToArc(geoToVec(0, 13), a, b) * RAD2DEG, 3, 1e-6, 'beyond its end: distance to the end point');
  close(distanceToArc(geoToVec(0, -4), a, b) * RAD2DEG, 4, 1e-6, 'beyond its start');
  close(distanceToArc(geoToVec(3, 3), a, a) * RAD2DEG, angleBetween(geoToVec(3, 3), a) * RAD2DEG, 1e-9, 'degenerate arc');
}

// --- index: order, ties, antimeridian
{
  const square = (x0: number, y0: number, x1: number, y1: number) => ({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] });
  const idx = new AreaIndex<string>();
  idx.add('big', planarPolygons(square(0, 0, 20, 20)), 1);
  idx.add('small', planarPolygons(square(5, 5, 10, 10)), 3);
  idx.add('twin', planarPolygons(square(5, 5, 10, 10)), 3);
  idx.add('under', planarPolygons(square(5, 5, 10, 10)), 0);
  assert.equal(idx.at(7, 7), 'twin', 'higher order wins, and among equals the one added last');
  assert.deepEqual(idx.all(7, 7), ['twin', 'small', 'big', 'under']);
  assert.equal(idx.at(15, 15), 'big');
  assert.equal(idx.at(30, 30), null);
  // A polygon stored on the other turn of longitude (170E to 190E) is found from both sides.
  const wrap = new AreaIndex<string>();
  wrap.add('island', planarPolygons(square(170, 0, 190, 10)), 0);
  assert.equal(wrap.at(5, 175), 'island');
  assert.equal(wrap.at(5, -175), 'island');
  assert.equal(wrap.at(5, -160), null);
  // A hole is not inside.
  const donut = { type: 'Polygon', coordinates: [square(0, 0, 10, 10).coordinates[0], [[3, 3], [3, 7], [7, 7], [7, 3], [3, 3]]] };
  const d = new AreaIndex<string>();
  d.add('donut', planarPolygons(donut), 0);
  assert.equal(d.at(5, 5), null);
  assert.equal(d.at(1, 1), 'donut');
}

// --- assembling the real map
{
  const feats = countries('countries-110m.json');
  const specs: AreaSpec[] = feats.map((f) => ({ key: String(f.id), geometry: f.geometry, fill: 'rgba(110,140,180,0.12)', stroke: 'rgba(180,200,225,0.4)', strokeWidth: 1, data: f.properties?.name }));
  const asm = new AreaAssembler();
  const t0 = performance.now();
  const full = asm.assemble(specs);
  const cold = performance.now() - t0;
  const t1 = performance.now();
  const warm = asm.assemble(specs.map((s, i) => (i === 7 ? { ...s, fill: 'rgba(79,209,197,0.28)' } : s)));
  const again = performance.now() - t1;
  assert.equal(full.vertexCount * 6, full.positions.length);
  assert.equal(full.vertexCount * 4, full.colors.length);
  assert.equal(warm.vertexCount, full.vertexCount, 'a colour change keeps the geometry');
  assert.equal(warm.segmentCount, full.segmentCount);
  assert.ok(again < cold, `second assembly is cheaper (${again.toFixed(1)} ms vs ${cold.toFixed(1)} ms)`);
  for (let i = 0; i < full.indices.length; i++) assert.ok(full.indices[i] < full.vertexCount, 'indices in range');

  // Shared borders are drawn once.
  const noDedupe = asm.assemble(specs, { dedupeEdges: false });
  assert.ok(full.segmentCount < noDedupe.segmentCount * 0.85, `dedupe removes shared edges (${full.segmentCount} vs ${noDedupe.segmentCount})`);

  // No segment runs along the antimeridian (where polygons are cut): both ends at x ≈ 0, z < 0.
  const cutSegmentsOf = (a: { segments: Uint8Array; segmentCount: number }) => {
    const f32 = new Float32Array(a.segments.buffer, a.segments.byteOffset, a.segmentCount * SEGMENT_FLOATS);
    let n = 0;
    for (let i = 0; i < a.segmentCount; i++) {
      const o = i * SEGMENT_FLOATS;
      const x0 = f32[o] + f32[o + 3], z0 = f32[o + 2] + f32[o + 5], x1 = f32[o + 6] + f32[o + 9], z1 = f32[o + 8] + f32[o + 11];
      if (Math.abs(x0) < 1e-6 && Math.abs(x1) < 1e-6 && z0 < 0 && z1 < 0) n++;
    }
    return n;
  };
  assert.equal(cutSegmentsOf(full), 0, 'no line along the antimeridian (110m)');
  // The 50m data does have such cut edges (Fiji): they are left out, so the check means something.
  const feats50 = countries('countries-50m.json');
  let cutEdges = 0;
  for (const f of feats50) for (const poly of planarPolygons(f.geometry)) for (const r of ringStrokes(poly)) cutEdges += r.hidden.reduce((a, b) => a + b, 0);
  assert.ok(cutEdges >= 4, `the 50m rings contain ${cutEdges} edges along the antimeridian`);
  const full50 = new AreaAssembler().assemble(feats50.map((f) => ({ key: String(f.id), geometry: f.geometry, stroke: '#fff', strokeWidth: 1 })));
  assert.equal(cutSegmentsOf(full50), 0, 'no line along the antimeridian (50m)');

  // The top area claims a shared edge: Colombia (selected, order 3) keeps its whole outline, its neighbours lose the shared parts.
  const colombia = feats.find((f) => f.properties?.name === 'Colombia')!;
  const sel = specs.map((s) => (s.data === 'Colombia' ? { ...s, order: 3, stroke: '#4fd1c5', strokeWidth: 2 } : s));
  const asm2 = new AreaAssembler();
  const withSel = asm2.assemble(sel);
  const bytes = withSel.segments;
  let teal = 0;
  for (let i = 0; i < withSel.segmentCount; i++) {
    const c = i * SEGMENT_BYTES + 76;
    if (bytes[c] === 79 && bytes[c + 1] === 209 && bytes[c + 2] === 197) teal++;
  }
  const own = new AreaAssembler().assemble([{ key: 'c', geometry: colombia.geometry, stroke: '#4fd1c5', strokeWidth: 2 }]);
  assert.equal(teal, own.segmentCount, 'the selected country keeps its whole outline in its own colour');

  // The index finds countries.
  const at = (la: number, ln: number) => asm.index.at(la, ln)?.data ?? null;
  assert.equal(at(4.6, -74.1), 'Colombia');
  assert.equal(at(48.85, 2.35), 'France');
  assert.equal(at(-33.9, 151.2), 'Australia');
  assert.equal(at(0, -30), null);

  // Missing geometry is tolerated.
  const odd = new AreaAssembler().assemble([{ key: 'x', geometry: null, fill: '#fff' }, { key: 'y', geometry: { type: 'Point', coordinates: [0, 0] }, fill: '#fff' }]);
  assert.equal(odd.vertexCount, 0);
  console.log(`  110m map: ${full.vertexCount} vertices, ${full.indices.length / 3} triangles, ${full.segmentCount} segments (${noDedupe.segmentCount} without sharing), cold ${cold.toFixed(0)} ms, warm ${again.toFixed(1)} ms`);
}

console.log('engine areas tests: ok');
