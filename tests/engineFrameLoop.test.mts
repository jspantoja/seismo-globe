import assert from 'node:assert/strict';
import { FrameLoop, type FrameApi } from '../engine/frameLoop';

/** A fake screen: `vsync()` runs the callbacks queued since the last refresh, once each. */
function screen() {
  let next = 1;
  let queue = new Map<number, (t: number) => void>();
  let queuedEver = 0;
  const api: FrameApi = {
    request(cb) {
      queuedEver++;
      const h = next++;
      queue.set(h, cb);
      return h;
    },
    cancel(h) {
      queue.delete(h);
    },
  };
  return {
    api,
    vsyncs: 0,
    get waiting() {
      return queue.size;
    },
    get queuedEver() {
      return queuedEver;
    },
    vsync(): void {
      this.vsyncs++;
      const due = [...queue.values()];
      queue = new Map();
      for (const cb of due) cb(this.vsyncs * 16.7);
    },
  };
}

// --- asking twice before the refresh queues one callback
{
  const s = screen();
  let runs = 0;
  const loop = new FrameLoop(() => runs++, s.api);
  assert.equal(loop.request(), true);
  assert.equal(loop.request(), false);
  assert.equal(s.waiting, 1);
  s.vsync();
  assert.equal(runs, 1);
  assert.equal(loop.pending, false, 'after it runs, nothing is queued');
}

// --- the regression: a redraw asked for *during* the frame, then the frame asks again at its end.
// That used to leave two callbacks per refresh for the rest of the session.
{
  const s = screen();
  let runs = 0;
  let loopRef: FrameLoop;
  const loop = (loopRef = new FrameLoop(() => {
    runs++;
    loopRef.request(); // a layer or the pov handler asks for a redraw while the frame runs
    loopRef.request(); // and the end of the frame asks for the next one
  }, s.api));
  loop.request();
  for (let i = 0; i < 60; i++) {
    s.vsync();
    assert.equal(s.waiting, 1, `exactly one callback waits after refresh ${i + 1}`);
  }
  assert.equal(runs, 60, 'one frame per refresh, not two');
  assert.equal(loop.ticks, 60);
  assert.equal(s.queuedEver, 61);
}

// --- a frame that stops asking ends the chain; the next request starts it again
{
  const s = screen();
  let runs = 0;
  let again = true;
  let loopRef: FrameLoop;
  const loop = (loopRef = new FrameLoop(() => {
    runs++;
    if (again) loopRef.request();
  }, s.api));
  loop.request();
  s.vsync();
  s.vsync();
  again = false;
  s.vsync();
  assert.equal(s.waiting, 0);
  s.vsync();
  assert.equal(runs, 3, 'idle means no callbacks at all');
  assert.equal(loop.request(), true);
  s.vsync();
  assert.equal(runs, 4);
}

// --- cancel drops the queued callback and allows a new one
{
  const s = screen();
  let runs = 0;
  const loop = new FrameLoop(() => runs++, s.api);
  loop.request();
  loop.cancel();
  assert.equal(s.waiting, 0);
  assert.equal(loop.pending, false);
  s.vsync();
  assert.equal(runs, 0);
  loop.cancel(); // cancelling twice is harmless
  assert.equal(loop.request(), true);
  s.vsync();
  assert.equal(runs, 1);
}

console.log('engineFrameLoop ok');
