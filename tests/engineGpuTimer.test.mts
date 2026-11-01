import assert from 'node:assert/strict';
import { GpuTimer } from '../engine/gpuTimer';

/** A WebGL2 that answers timer queries the way the extension does: a result is available when the test says so. */
function fakeGl(opts: { ext?: boolean } = {}) {
  let nextId = 1;
  const results = new Map<object, number>(); // query → nanoseconds, set when "the GPU finishes"
  const finished = new Set<object>();
  let disjoint = false;
  let open: object | null = null;
  const log: string[] = [];
  const gl = {
    QUERY_RESULT_AVAILABLE: 0x8867,
    QUERY_RESULT: 0x8866,
    getExtension: (name: string) => (opts.ext === false || name !== 'EXT_disjoint_timer_query_webgl2' ? null : { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb }),
    createQuery: () => ({ id: nextId++ }),
    deleteQuery: (q: object) => void log.push(`delete`),
    beginQuery: (_t: number, q: object) => {
      assert.equal(open, null, 'only one query may be active at a time');
      open = q;
    },
    endQuery: () => {
      assert.notEqual(open, null, 'endQuery with nothing open');
      open = null;
    },
    getQueryParameter: (q: object, what: number) => (what === 0x8867 ? finished.has(q) : (results.get(q) ?? 0)),
    getParameter: (what: number) => (what === 0x8fbb ? disjoint : null),
  };
  return {
    gl: gl as unknown as WebGL2RenderingContext,
    finish(q: object, ns: number) {
      results.set(q, ns);
      finished.add(q);
    },
    setDisjoint(v: boolean) {
      disjoint = v;
    },
    get open() {
      return open;
    },
    log,
  };
}

// The queries a timer created, in order, found through begin() calls on a spy.
function spyQueries(f: ReturnType<typeof fakeGl>): object[] {
  const made: object[] = [];
  const orig = f.gl.createQuery.bind(f.gl);
  (f.gl as any).createQuery = () => {
    const q = orig() as object;
    made.push(q);
    return q;
  };
  return made;
}

// --- no extension: everything is a no-op
{
  const f = fakeGl({ ext: false });
  const t = new GpuTimer(f.gl);
  assert.equal(t.supported, false);
  t.startFrame();
  t.begin('globo');
  t.end();
  t.poll();
  assert.deepEqual(t.snapshot(), {});
}

// --- sections are timed in order, results arrive late, and the total adds up
{
  const f = fakeGl();
  const made = spyQueries(f);
  const t = new GpuTimer(f.gl);
  assert.equal(t.supported, true);
  t.startFrame();
  t.begin('globo');
  t.begin('sismos'); // begins the next section: the previous one is closed
  t.end();
  t.poll();
  assert.deepEqual(t.snapshot(), {}, 'nothing finished yet: nothing reported');
  assert.equal(made.length, 2);
  f.finish(made[0], 2_000_000); // 2 ms
  t.poll();
  assert.deepEqual(t.snapshot(), {}, 'the frame is not complete while a section is pending');
  f.finish(made[1], 10_000_000); // 10 ms
  t.poll();
  const s = t.snapshot();
  assert.equal(s.globo, 2);
  assert.equal(s.sismos, 10);
  assert.equal(s.total, 12);
  assert.equal(f.open, null);
  assert.equal(f.log.filter((x) => x === 'delete').length, 2, 'finished queries are released');
}

// --- results are smoothed across frames
{
  const f = fakeGl();
  const made = spyQueries(f);
  const t = new GpuTimer(f.gl);
  for (const ms of [10, 20]) {
    t.startFrame();
    t.begin('sismos');
    t.end();
    f.finish(made[made.length - 1], ms * 1e6);
    t.poll();
  }
  const v = t.snapshot().sismos;
  assert.ok(v > 10 && v < 20, `smoothed between the two readings (${v})`);
}

// --- two sections with one label in a frame add up
{
  const f = fakeGl();
  const made = spyQueries(f);
  const t = new GpuTimer(f.gl);
  t.startFrame();
  t.begin('líneas');
  t.begin('líneas');
  t.end();
  f.finish(made[0], 1_000_000);
  f.finish(made[1], 3_000_000);
  t.poll();
  assert.equal(t.snapshot().líneas, 4);
}

// --- a disjoint event voids the readings
{
  const f = fakeGl();
  const made = spyQueries(f);
  const t = new GpuTimer(f.gl);
  t.startFrame();
  t.begin('sismos');
  t.end();
  f.finish(made[0], 99_000_000);
  f.setDisjoint(true);
  t.poll();
  assert.deepEqual(t.snapshot(), {}, 'a disjoint reading is thrown away');
}

// --- a GPU far behind does not pile queries up
{
  const f = fakeGl();
  const made = spyQueries(f);
  const t = new GpuTimer(f.gl);
  for (let i = 0; i < 200; i++) {
    t.startFrame();
    t.begin('sismos');
    t.end();
  }
  assert.ok(made.length <= 48, `capped (${made.length})`);
}

// --- reset after a lost context
{
  const f = fakeGl();
  const made = spyQueries(f);
  const t = new GpuTimer(f.gl);
  t.startFrame();
  t.begin('globo');
  t.end();
  t.reset(f.gl);
  f.finish(made[0], 1_000_000);
  t.poll();
  assert.deepEqual(t.snapshot(), {}, 'queries of the old context are forgotten');
}

console.log('engineGpuTimer ok');
