import type { BenchmarkWindow } from '../engine';

/**
 * The one-tap measurement behind the diagnostics panel's "Medir" button. Asking someone to drag the
 * globe "for ten seconds, then copy the panel" gave readings taken at rest; this spins the globe by
 * itself, a few seconds per phase, switching one thing off at a time (the panels' blur, the quakes, the
 * outlines, everything but the planet) so a single pasted report says what a device's frames cost.
 */

export interface BenchTarget {
  /** Starts the spin at full resolution (the adaptive resolution is held still so phases compare). */
  begin(): void;
  /** Opens a fresh measuring window (what happened before is forgotten). */
  window(): void;
  /** What the current window saw. */
  read(): BenchmarkWindow;
  /** Stops the spin and puts everything back. */
  end(): void;
  sleep(ms: number): Promise<void>;
}

export interface BenchPhase {
  label: string;
  /** Sets the page up for this phase (it is undone by the target's `end`, and by the next phase's own setup). */
  apply(): void;
}

export interface PhaseResult {
  label: string;
  frames: number;
  fps: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
  gpuMs: Record<string, number> | null;
  pixelRatio: number;
  canvasWidth: number;
  canvasHeight: number;
}

/** Frame statistics from the gaps (ms) between consecutive drawn frames. */
export function summarizeGaps(gaps: readonly number[]): { frames: number; fps: number; meanMs: number; p95Ms: number; maxMs: number } {
  const n = gaps.length;
  if (n === 0) return { frames: 0, fps: 0, meanMs: 0, p95Ms: 0, maxMs: 0 };
  const sorted = [...gaps].sort((a, b) => a - b);
  const total = gaps.reduce((a, b) => a + b, 0);
  const mean = total / n;
  const p95 = sorted[Math.min(n - 1, Math.floor(0.95 * n))];
  return { frames: n, fps: mean > 0 ? 1000 / mean : 0, meanMs: mean, p95Ms: p95, maxMs: sorted[n - 1] };
}

export interface BenchOptions {
  warmupMs?: number;
  measureMs?: number;
  /** Called as each phase starts (for a progress line). */
  onPhase?: (index: number, total: number, label: string) => void;
}

export async function runBenchmark(target: BenchTarget, phases: readonly BenchPhase[], options: BenchOptions = {}): Promise<PhaseResult[]> {
  const warmup = options.warmupMs ?? 1000;
  const measure = options.measureMs ?? 4000;
  const results: PhaseResult[] = [];
  target.begin();
  try {
    for (let i = 0; i < phases.length; i++) {
      options.onPhase?.(i, phases.length, phases[i].label);
      phases[i].apply();
      await target.sleep(warmup); // buffers resize, layers rebuild, the GPU settles: not measured
      target.window();
      await target.sleep(measure);
      const w = target.read();
      results.push({ label: phases[i].label, ...summarizeGaps(w.gaps), gpuMs: w.gpuMs, pixelRatio: w.pixelRatio, canvasWidth: w.canvasWidth, canvasHeight: w.canvasHeight });
    }
  } finally {
    target.end();
  }
  return results;
}

const one = (n: number) => (Math.round(n * 10) / 10).toString();

/** The report, one phase per line, as plain text to paste into a message. */
export function formatBenchmark(results: readonly PhaseResult[], measureMs: number): string {
  if (results.length === 0) return '';
  const first = results[0];
  const lines = [`Medición con el globo girando · ${first.canvasWidth}×${first.canvasHeight} px (${first.pixelRatio.toFixed(2)}×) · ${Math.round(measureMs / 1000)} s por fase`];
  for (const r of results) {
    if (r.frames === 0) {
      lines.push(`${r.label}: sin fotogramas`);
      continue;
    }
    let gpu = '';
    if (r.gpuMs && typeof r.gpuMs.total === 'number') {
      const parts = Object.keys(r.gpuMs)
        .filter((k) => k !== 'total' && r.gpuMs![k] >= 0.05)
        .map((k) => `${k} ${one(r.gpuMs![k])}`);
      gpu = ` · GPU ${one(r.gpuMs.total)} ms (${parts.join(' · ')})`;
    }
    lines.push(`${r.label}: ${Math.round(r.fps)} fps · ${one(r.meanMs)} ms (p95 ${one(r.p95Ms)}, máx ${Math.round(r.maxMs)})${gpu}`);
  }
  return lines.join('\n');
}
