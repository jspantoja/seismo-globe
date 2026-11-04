/**
 * GPU time per section of a frame, read with EXT_disjoint_timer_query_webgl2 (available in Chrome and
 * its relatives on desktop; not in Safari or most phones). It exists for the diagnostics panel: the
 * JavaScript cost of a frame says little, because the GPU runs behind it, so a slow frame on a real
 * device cannot be pinned on the globe, the countries or the quakes without asking the GPU itself.
 *
 * Sections are strictly sequential (the extension allows one query at a time). The results arrive a
 * few frames late; `poll()` collects whatever has finished and `commit()` validates and smooths it.
 *
 * Nothing here may stall the frame it measures. `getParameter(GPU_DISJOINT_EXT)`, the check that tells
 * whether the readings are void, is a synchronous round trip to the GPU process: it makes the main thread
 * wait until the GPU has finished everything queued, so asked once per frame it turned a pipelined
 * CPU/GPU loop into a serial one (the profile of a spinning globe showed 10.7 s of 12.3 s inside it).
 * So poll() never calls it; commit() does, once a second at most.
 */

const MAX_STAGED = 3000; // ~10 s of sections at 60 fps
const MAX_PENDING = 48; // if the GPU is far behind, stop asking rather than pile queries up
const SMOOTH = 0.2;

interface TimerExt {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

interface Pending {
  query: WebGLQuery;
  label: string;
  frame: number;
  group: string;
}

/** Frames are timed in groups (while the view moves, at rest): a still picture's redraw must not blur the numbers of a drag. */
export const DEFAULT_GROUP = 'default';

export class GpuTimer {
  private readonly ext: TimerExt | null;
  private active: Pending | null = null;
  private pending: Pending[] = [];
  private frame = 0;
  private group = DEFAULT_GROUP;
  private staged: Array<{ label: string; ms: number; frame: number; group: string }> = []; // read, but not yet validated by commit()
  private lastCommit = Number.NEGATIVE_INFINITY;
  private readonly sum = new Map<string, number>(); // this frame's finished sections, label → ms
  private sumFrame = -1;
  private sumGroup = DEFAULT_GROUP;
  /** Smoothed GPU milliseconds per label, for each group. */
  private readonly ms = new Map<string, Map<string, number>>();

  constructor(private gl: WebGL2RenderingContext) {
    this.ext = (gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null) ?? null;
  }

  get supported(): boolean {
    return this.ext !== null;
  }

  /** Starts a new frame (of the given group): sections that were left open are closed. */
  startFrame(group: string = DEFAULT_GROUP): void {
    this.end();
    this.frame++;
    this.group = group;
  }

  /** Ends the section in progress (if any) and starts timing `label`. */
  begin(label: string): void {
    if (!this.ext) return;
    this.end();
    if (this.pending.length >= MAX_PENDING) return;
    const query = this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.active = { query, label, frame: this.frame, group: this.group };
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /**
   * Reads the sections the GPU has finished into a staging list. Call once per frame, after drawing.
   * Only query-result calls (which do not wait for the GPU) are made here.
   */
  poll(): void {
    const ext = this.ext;
    if (!ext || this.pending.length === 0) return;
    const gl = this.gl;
    let done = 0;
    // The GPU finishes sections in order: the first one that is not ready means the rest are not either.
    while (done < this.pending.length && gl.getQueryParameter(this.pending[done].query, gl.QUERY_RESULT_AVAILABLE)) {
      const p = this.pending[done++];
      this.staged.push({ label: p.label, ms: Number(gl.getQueryParameter(p.query, gl.QUERY_RESULT)) / 1e6, frame: p.frame, group: p.group });
      gl.deleteQuery(p.query);
    }
    if (done > 0) this.pending.splice(0, done);
    if (this.staged.length > MAX_STAGED) this.staged.splice(0, this.staged.length - MAX_STAGED);
  }

  /**
   * Validates what poll() read and adds it to the smoothed times. This is the one call that waits for the
   * GPU (the disjoint check), so it is throttled: with `minIntervalMs` since the last one it does nothing
   * unless `now` has moved on far enough. A disjoint event (a power change or similar) voids the readings
   * taken since the last check.
   */
  commit(now: number, minIntervalMs = 1000): void {
    const ext = this.ext;
    if (!ext || now - this.lastCommit < minIntervalMs) return;
    this.lastCommit = now;
    const disjoint = Boolean(this.gl.getParameter(ext.GPU_DISJOINT_EXT));
    const staged = this.staged;
    this.staged = [];
    if (!disjoint) for (const s of staged) this.record(s.label, s.ms, s.frame, s.group);
    // Sections finish in order: the frame being summed is complete once nothing of it is still pending.
    if (this.sumFrame !== -1 && (this.pending.length === 0 || this.pending[0].frame !== this.sumFrame)) this.flush();
  }

  /** Forgets every query: a lost context took them with it. Pass the new context when it is back. */
  reset(gl?: WebGL2RenderingContext): void {
    this.active = null;
    this.pending = [];
    this.staged = [];
    this.lastCommit = Number.NEGATIVE_INFINITY;
    this.sum.clear();
    this.sumFrame = -1;
    this.ms.clear();
    if (gl) this.gl = gl;
  }

  /** The smoothed times of a group, label → ms, plus their total. Empty until the first results arrive. */
  snapshot(group: string = DEFAULT_GROUP): Record<string, number> {
    const out: Record<string, number> = {};
    const labels = this.ms.get(group);
    if (!labels) return out;
    let total = 0;
    for (const [label, ms] of labels) {
      out[label] = ms;
      total += ms;
    }
    if (labels.size > 0) out.total = total;
    return out;
  }

  // Two sections of the same label in one frame (two outline layers, say) add up before they are smoothed.
  private record(label: string, ms: number, frame: number, group: string): void {
    if (this.sumFrame !== -1 && frame !== this.sumFrame) this.flush();
    this.sumFrame = frame;
    this.sumGroup = group;
    this.sum.set(label, (this.sum.get(label) ?? 0) + ms);
  }

  private flush(): void {
    let labels = this.ms.get(this.sumGroup);
    if (!labels) this.ms.set(this.sumGroup, (labels = new Map()));
    for (const [label, ms] of this.sum) {
      const old = labels.get(label);
      labels.set(label, old === undefined ? ms : old * (1 - SMOOTH) + ms * SMOOTH);
    }
    this.sum.clear();
    this.sumFrame = -1;
  }
}
