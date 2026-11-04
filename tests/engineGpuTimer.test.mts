import assert from 'node:assert/strict';
import { GpuTimer } from '../engine/gpuTimer';

/** A WebGL2 that answers timer queries the way the extension does: a result is available when the test says so. */
function fakeGl(opts: { ext?: boolean } = {}) {
  let nextId = 1;
  const results = new Map<object, number>(); // query → nanoseconds, set when "the GPU finishes"
  const finished = new Set<object>();
  let disjoint = false;
  let open: object | null = null;
  let paramCalls = 0;
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
    getParameter: (what: number) => {
      paramCalls++;
      return what === 0x8fbb ? disjoint : null;
    },
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
    get paramCalls() {
      return paramCalls;
    },
    log,
  };
}

let clock = 0;
/** What the engine does between frames and when the panel asks: collect what finished, then validate it. */
function sync(t: GpuTimer): void {
  t.poll();
  t.commit((clock += 10_000), 0);
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
  sync(t);
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
  sync(t);
  assert.deepEqual(t.snapshot(), {}, 'nothing finished yet: nothing reported');
  assert.equal(made.length, 2);
  f.finish(made[0], 2_000_000); // 2 ms
  sync(t);
  assert.deepEqual(t.snapshot(), {}, 'the frame is not complete while a section is pending');
  f.finish(made[1], 10_000_000); // 10 ms
  sync(t);
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
    sync(t);
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
  sync(t);
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
  sync(t);
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
  sync(t);
  assert.deepEqual(t.snapshot(), {}, 'queries of the old context are forgotten');
}

// --- frames of different groups are smoothed apart
{
  const f = fakeGl();
  const made = spyQueries(f);
  const t = new GpuTimer(f.gl);
  const run = (group: string, ms: number) => {
    t.startFrame(group);
    t.begin('sismos');
    t.end();
    f.finish(made[made.length - 1], ms * 1e6);
    sync(t);
  };
  run('moving', 12);
  run('moving', 12);
  run('rest', 2);
  assert.ok(Math.abs(t.snapshot('moving').sismos - 12) < 1e-9, 'a redraw at rest does not touch the numbers of a drag');
  assert.ok(Math.abs(t.snapshot('rest').sismos - 2) < 1e-9);
  assert.deepEqual(t.snapshot('nothing'), {});
}

// --- the regression: polling a frame never waits for the GPU, and committing does it once, throttled
{
  const f = fakeGl();
  const made = spyQueries(f);
  const t = new GpuTimer(f.gl);
  for (let i = 0; i < 30; i++) {
    t.startFrame('moving');
    t.begin('globo');
    t.begin('sismos');
    t.end();
    for (let k = made.length - 2; k < made.length; k++) f.finish(made[k], 3_000_000);
    t.poll(); // one per frame, as the engine does
  }
  assert.equal(f.paramCalls, 0, 'poll() makes no getParameter call: it is a round trip to the GPU process');
  assert.deepEqual(t.snapshot('moving'), {}, 'nothing is reported until committed');
  t.commit(1000);
  assert.equal(f.paramCalls, 1, 'commit asks once');
  t.commit(1500);
  t.commit(1999);
  assert.equal(f.paramCalls, 1, 'and no more than once a second');
  t.commit(2000);
  assert.equal(f.paramCalls, 2);
  const s = t.snapshot('moving');
  assert.ok(Math.abs(s.globo - 3) < 1e-9 && Math.abs(s.sismos - 3) < 1e-9 && Math.abs(s.total - 6) < 1e-9, JSON.stringify(s));
}

console.log('engineGpuTimer ok');
