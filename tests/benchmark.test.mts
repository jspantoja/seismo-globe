import assert from 'node:assert/strict';
import type { BenchmarkWindow } from '../engine';
import { formatBenchmark, runBenchmark, summarizeGaps, type BenchTarget } from '../lib/benchmark';

// --- gap statistics
{
  assert.deepEqual(summarizeGaps([]), { frames: 0, fps: 0, meanMs: 0, p95Ms: 0, maxMs: 0 });
  const s = summarizeGaps(Array(100).fill(20));
  assert.equal(s.frames, 100);
  assert.equal(s.fps, 50);
  assert.equal(s.meanMs, 20);
  assert.equal(s.p95Ms, 20);
  const spiky = summarizeGaps([...Array(95).fill(16), ...Array(5).fill(100)]);
  assert.equal(spiky.maxMs, 100);
  assert.equal(spiky.p95Ms, 100, 'the slowest 5% show in p95');
  assert.ok(spiky.fps < 1000 / 16, 'and pull the average down');
}

// --- the runner: phases in order, a warm-up that is not measured, always cleans up
{
  const log: string[] = [];
  let clock = 0;
  let current = 'none';
  const windows = new Map<string, number>();
  const target: BenchTarget = {
    begin: () => void log.push('begin'),
    window: () => void log.push(`window@${current}`),
    read: (): BenchmarkWindow => {
      const gap = current === 'slow' ? 40 : 16;
      return { gaps: Array(50).fill(gap), elapsedMs: 4000, gpuMs: current === 'slow' ? { globo: 8, sismos: 30, total: 38 } : null, pixelRatio: 1.25, canvasWidth: 3590, canvasHeight: 2105 };
    },
    end: () => void log.push('end'),
    sleep: async (ms) => {
      clock += ms;
      log.push(`sleep ${ms}`);
    },
  };
  const phases = [
    { label: 'normal', apply: () => void (current = 'fast') },
    { label: 'lento', apply: () => void (current = 'slow') },
  ];
  const seen: string[] = [];
  const res = await runBenchmark(target, phases, { warmupMs: 100, measureMs: 400, onPhase: (i, n, label) => seen.push(`${i + 1}/${n} ${label}`) });
  assert.deepEqual(log, ['begin', 'sleep 100', 'window@fast', 'sleep 400', 'sleep 100', 'window@slow', 'sleep 400', 'end']);
  assert.deepEqual(seen, ['1/2 normal', '2/2 lento']);
  assert.equal(clock, 1000);
  assert.equal(res.length, 2);
  assert.equal(Math.round(res[0].fps), 63);
  assert.equal(res[1].fps, 25);
  assert.equal(windows.size, 0);

  const text = formatBenchmark(res, 4000);
  const lines = text.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /3590×2105 px \(1\.25×\) · 4 s por fase/);
  assert.match(lines[1], /^normal: 63 fps · 16 ms \(p95 16, máx 16\)$/, 'no GPU part when the browser has no timer');
  assert.match(lines[2], /^lento: 25 fps · 40 ms \(p95 40, máx 40\) · GPU 38 ms \(globo 8 · sismos 30\)$/);
}

// --- it puts everything back even if a phase throws
{
  let ended = false;
  const target: BenchTarget = {
    begin: () => {},
    window: () => {},
    read: () => ({ gaps: [], elapsedMs: 0, gpuMs: null, pixelRatio: 1, canvasWidth: 1, canvasHeight: 1 }),
    end: () => void (ended = true),
    sleep: async () => {},
  };
  await assert.rejects(runBenchmark(target, [{ label: 'x', apply: () => { throw new Error('boom'); } }]), /boom/);
  assert.equal(ended, true);
  assert.equal(formatBenchmark([], 4000), '');
  assert.match(formatBenchmark([{ label: 'vacía', frames: 0, fps: 0, meanMs: 0, p95Ms: 0, maxMs: 0, gpuMs: null, pixelRatio: 1, canvasWidth: 10, canvasHeight: 10 }], 4000), /vacía: sin fotogramas/);
}

console.log('benchmark tests: ok');
