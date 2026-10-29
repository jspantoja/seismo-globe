import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { feature } from 'topojson-client';
import { AreaAssembler, type AreaSpec, type AssembledAreas } from '../engine/areas';
import { EdgeSet, SEGMENT_BYTES, SegmentBuffer, densify } from '../engine/linegeom';
import { ReferenceAreaAssembler } from './helpers/areasReference';

/**
 * The optimised assembler (cached outline blocks, typed edge set, prepared meshes) must produce
 * exactly what the straightforward reference assembler produces, on every call of a sequence that
 * reuses its caches the way the app does (select a country, change selection, add overlays...).
 */

const read = (f: string) => JSON.parse(readFileSync(new URL(`../public/data/${f}`, import.meta.url), 'utf8'));
const countries = (f: string): any[] => {
  const topo = read(f);
  return (feature(topo, topo.objects[Object.keys(topo.objects)[0]]) as any).features.filter((x: any) => x.properties?.name !== 'Antarctica');
};

const bytesOf = (a: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
function assertSame(got: AssembledAreas, want: AssembledAreas, label: string): void {
  assert.equal(got.vertexCount, want.vertexCount, `${label}: vertices`);
  assert.equal(got.segmentCount, want.segmentCount, `${label}: segments`);
  assert.equal(got.indices.length, want.indices.length, `${label}: indices`);
  assert.equal(Buffer.compare(bytesOf(got.positions), bytesOf(want.positions)), 0, `${label}: positions differ`);
  assert.equal(Buffer.compare(bytesOf(got.colors), bytesOf(want.colors)), 0, `${label}: colours differ`);
  assert.equal(Buffer.compare(bytesOf(got.indices), bytesOf(want.indices)), 0, `${label}: indices differ`);
  assert.equal(Buffer.compare(bytesOf(got.segments), bytesOf(want.segments)), 0, `${label}: segment bytes differ`);
}

// --- EdgeSet: a set of numbers like a Set
{
  const set = new EdgeSet(4);
  const ref = new Set<number>();
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < 20000; i++) {
    // keys shaped like edgeKey's: up to ~52 bits, plenty of repeats
    const key = Math.floor(rnd() * 3000) * 1048576 * 7 + Math.floor(rnd() * 40) * 12345;
    assert.equal(set.add(key), !ref.has(key), 'add() reports whether the key was new');
    ref.add(key);
  }
  assert.equal(set.count, ref.size, 'same number of keys');
  set.reset(10);
  assert.equal(set.count, 0);
  assert.equal(set.add(0), true, 'zero is a valid key');
  assert.equal(set.add(0), false);
  assert.equal(set.add(4503599627370495), true, 'the largest 52-bit key');
}

// --- SegmentBuffer.append copies whole segments
{
  const a = new SegmentBuffer(4);
  const path = densify([0, 0, 10, 0, 10, 10], true, 2);
  a.addPath(path, 2, [1, 2, 3, 4]);
  const b = new SegmentBuffer(2);
  b.append(a.view(), a.count);
  b.append(a.view(), a.count);
  assert.equal(b.count, a.count * 2);
  assert.equal(Buffer.compare(bytesOf(b.view().subarray(0, a.count * SEGMENT_BYTES)), bytesOf(a.view())), 0);
  assert.equal(Buffer.compare(bytesOf(b.view().subarray(a.count * SEGMENT_BYTES)), bytesOf(a.view())), 0);
}

const BASE = 'rgba(110, 140, 180, 0.12)';
const EDGE = 'rgba(180, 200, 225, 0.4)';

function baseSpecs(feats: any[], selected: number, replaceSelected = false): AreaSpec<any>[] {
  const specs: AreaSpec<any>[] = [];
  feats.forEach((f, i) => {
    if (replaceSelected && i === selected) return;
    const sel = i === selected;
    specs.push({
      key: `c:${f.id ?? i}:${i}`,
      geometry: f.geometry,
      fill: sel ? 'rgba(79, 209, 197, 0.28)' : BASE,
      stroke: sel ? '#4fd1c5' : EDGE,
      strokeWidth: sel ? 1.5 : 1,
      order: sel ? 3 : 1,
      data: f,
    });
  });
  return specs;
}

function runSequence(feats: any[], plates: any[], label: string): void {
  const fast = new AreaAssembler<any>();
  const slow = new ReferenceAreaAssembler<any>();
  const check = (specs: AreaSpec<any>[], name: string, options = {}) => assertSame(fast.assemble(specs, options), slow.assemble(specs, options), `${label} / ${name}`);

  check(baseSpecs(feats, -1), 'all countries');
  check(baseSpecs(feats, -1), 'same call again (everything cached)');
  check(baseSpecs(feats, 10), 'a country selected');
  check(baseSpecs(feats, 57 % feats.length), 'another country selected');
  check(baseSpecs(feats, -1), 'selection cleared');
  check(baseSpecs(feats, 10, true), 'selected country replaced by overlays (left out)');

  const withPlate = [
    ...plates.slice(0, 3).map((p, i): AreaSpec<any> => ({ key: `p${i}`, geometry: p.geometry, fill: 'rgba(144, 133, 233, 0.24)', order: 0 })),
    ...baseSpecs(feats, 20),
  ];
  check(withPlate, 'plates under the countries');

  // the same geometry twice, stroke-only and fill-only, with equal order (later one on top)
  const twice: AreaSpec<any>[] = [
    { key: 'a', geometry: feats[3].geometry, fill: null, stroke: '#ff0000', strokeWidth: 2, order: 1 },
    { key: 'b', geometry: feats[3].geometry, fill: 'rgba(0,255,0,0.3)', stroke: '#00ff00', strokeWidth: 1, order: 1 },
    { key: 'c', geometry: feats[4].geometry, fill: '#0000ff', stroke: null, order: 2 },
    { key: 'd', geometry: feats[5].geometry, fill: 'rgba(0,0,0,0)', stroke: 'rgba(0,0,0,0)', order: 2 }, // invisible
    { key: 'e', geometry: feats[6].geometry, fill: BASE, stroke: EDGE, strokeWidth: 0, order: 2 }, // zero width
  ];
  check(twice, 'duplicates, missing and invisible styles');
  check(baseSpecs(feats, 3), 'back to the ordinary list');
  check(baseSpecs(feats, 3), 'no edge dedupe', { dedupeEdges: false });
  check(baseSpecs(feats, 4), 'dedupe on again');
  check([], 'nothing');
  check(baseSpecs(feats, 10), 'after nothing');

  // picking works the same way
  fast.assemble(baseSpecs(feats, 10));
  slow.assemble(baseSpecs(feats, 10));
  for (const [lat, lng] of [[4.6, -74.1], [48.8, 2.3], [-33.9, 151.2], [64, -150], [0, -30], [35.7, 139.7]]) {
    assert.equal(fast.index.at(lat, lng)?.key, slow.index.at(lat, lng)?.key, `${label}: pick ${lat},${lng}`);
  }
}

const plates: any[] = read('PB2002_plates.json').features;
runSequence(countries('countries-110m.json'), plates, '110m');
runSequence(countries('countries-50m.json'), plates, '50m');

// --- prepare(): slices the work, yields between slices, and leaves the caches ready
{
  const feats = countries('countries-110m.json');
  const specs = baseSpecs(feats, -1);
  const fast = new AreaAssembler<any>();
  let yields = 0;
  await fast.prepare(specs, {
    sliceMs: 0, // yield after every polygon
    yieldFn: async () => {
      yields++;
    },
  });
  const polygons = feats.reduce((n, f) => n + (f.geometry.type === 'Polygon' ? 1 : f.geometry.coordinates.length), 0);
  assert.ok(yields >= polygons, `a yield per polygon at least (${yields} yields for ${polygons} polygons)`);
  const slow = new ReferenceAreaAssembler<any>();
  assertSame(fast.assemble(specs), slow.assemble(specs), 'assemble after prepare');

  // a generous slice yields rarely
  const lazy = new AreaAssembler<any>();
  let lazyYields = 0;
  await lazy.prepare(specs, { sliceMs: 1e9, yieldFn: async () => void lazyYields++ });
  assert.equal(lazyYields, 0, 'no yield when the slice is never exceeded');
  assertSame(lazy.assemble(specs), slow.assemble(specs), 'assemble after a single-slice prepare');

  // cancelling stops early, and what was done is still valid
  const partial = new AreaAssembler<any>();
  let calls = 0;
  await partial.prepare(specs, { sliceMs: 0, yieldFn: async () => void calls++, cancelled: () => calls >= 5 });
  assert.ok(calls >= 5 && calls < 20, `stopped soon after the cancel (${calls} yields)`);
  assertSame(partial.assemble(specs), slow.assemble(specs), 'assemble after a cancelled prepare');

  // preparing what is already prepared is quick and changes nothing
  let again = 0;
  await fast.prepare(specs, { sliceMs: 1e9, yieldFn: async () => void again++ });
  assertSame(fast.assemble(specs), slow.assemble(specs), 'assemble after preparing twice');
}

// --- the real yieldToMain returns control (a macrotask passes)
{
  const { yieldToMain } = await import('../engine/areas');
  let ran = false;
  setTimeout(() => (ran = true), 0);
  await yieldToMain();
  await yieldToMain();
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(ran, 'timers run around yieldToMain');
}

// --- speed: re-assembling the 1:50m countries after a selection change must be cheap
{
  const feats = countries('countries-50m.json');
  const fast = new AreaAssembler<any>();
  fast.assemble(baseSpecs(feats, -1)); // cold
  const times: number[] = [];
  for (let k = 0; k < 12; k++) {
    const specs = baseSpecs(feats, 5 + k);
    const t = performance.now();
    fast.assemble(specs);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const slow = new ReferenceAreaAssembler<any>();
  slow.assemble(baseSpecs(feats, -1));
  const slowTimes: number[] = [];
  for (let k = 0; k < 12; k++) {
    const specs = baseSpecs(feats, 5 + k);
    const t = performance.now();
    slow.assemble(specs);
    slowTimes.push(performance.now() - t);
  }
  slowTimes.sort((a, b) => a - b);
  console.log(`  50m re-assemble after a selection change: median ${times[6].toFixed(1)} ms (reference ${slowTimes[6].toFixed(1)} ms)`);
  assert.ok(times[6] < slowTimes[6], 'cached assembly is faster than the reference');
}

// --- prepare() moves the cold cost off the assemble that follows it (50m countries)
{
  const feats = countries('countries-50m.json');
  const specs = baseSpecs(feats, -1);
  const cold = new AreaAssembler<any>();
  let t = performance.now();
  cold.assemble(specs);
  const coldMs = performance.now() - t;

  const prepared = new AreaAssembler<any>();
  let longest = 0;
  let slices = 0;
  let last = performance.now();
  await prepared.prepare(specs, {
    sliceMs: 2, // small enough that even a fast machine needs many slices
    yieldFn: async () => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      slices++;
      await new Promise((r) => setImmediate(r));
      last = performance.now();
    },
  });
  t = performance.now();
  prepared.assemble(specs);
  const afterMs = performance.now() - t;
  console.log(`  50m: cold assemble ${coldMs.toFixed(0)} ms; prepared in ${slices} slices (longest ${longest.toFixed(1)} ms), then assemble ${afterMs.toFixed(1)} ms`);
  assert.ok(afterMs < coldMs * 0.5, 'the assemble after prepare is much cheaper than a cold one');
  assert.ok(slices > 10, `the work was really sliced (${slices} slices)`);
}

console.log('engineAreasCache tests: ok');
