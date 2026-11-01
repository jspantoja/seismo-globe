/**
 * GPU time per section of a frame, read with EXT_disjoint_timer_query_webgl2 (available in Chrome and
 * its relatives on desktop; not in Safari or most phones). It exists for the diagnostics panel: the
 * JavaScript cost of a frame says little, because the GPU runs behind it, so a slow frame on a real
 * device cannot be pinned on the globe, the countries or the quakes without asking the GPU itself.
 *
 * Sections are strictly sequential (the extension allows one query at a time). The results arrive a
 * few frames late; `poll()` collects whatever has finished and smooths it.
 */

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
}

export class GpuTimer {
  private readonly ext: TimerExt | null;
  private active: Pending | null = null;
  private pending: Pending[] = [];
  private frame = 0;
  private readonly sum = new Map<string, number>(); // this frame's finished sections, label → ms
  private sumFrame = -1;
  /** Smoothed GPU milliseconds per label. */
  readonly ms = new Map<string, number>();

  constructor(private gl: WebGL2RenderingContext) {
    this.ext = (gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null) ?? null;
  }

  get supported(): boolean {
    return this.ext !== null;
  }

  /** Starts a new frame: sections that were left open are closed. */
  startFrame(): void {
    this.end();
    this.frame++;
  }

  /** Ends the section in progress (if any) and starts timing `label`. */
  begin(label: string): void {
    if (!this.ext) return;
    this.end();
    if (this.pending.length >= MAX_PENDING) return;
    const query = this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.active = { query, label, frame: this.frame };
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Collects the sections the GPU has finished. Call once per frame, after drawing. */
  poll(): void {
    const ext = this.ext;
    if (!ext || this.pending.length === 0) return;
    const gl = this.gl;
    const disjoint = Boolean(gl.getParameter(ext.GPU_DISJOINT_EXT)); // a power change or similar: timings since the last check are void
    const rest: Pending[] = [];
    for (const p of this.pending) {
      if (!gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE)) {
        rest.push(p);
        continue;
      }
      if (!disjoint) this.record(p.label, Number(gl.getQueryParameter(p.query, gl.QUERY_RESULT)) / 1e6, p.frame);
      gl.deleteQuery(p.query);
    }
    this.pending = rest;
    // Sections finish in order: the frame being summed is complete once nothing of it is still pending.
    if (this.sumFrame !== -1 && (rest.length === 0 || rest[0].frame !== this.sumFrame)) this.flush();
  }

  /** Forgets every query: a lost context took them with it. Pass the new context when it is back. */
  reset(gl?: WebGL2RenderingContext): void {
    this.active = null;
    this.pending = [];
    this.sum.clear();
    this.sumFrame = -1;
    this.ms.clear();
    if (gl) this.gl = gl;
  }

  /** The smoothed times, label → ms, plus their total. Empty until the first results arrive. */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    let total = 0;
    for (const [label, ms] of this.ms) {
      out[label] = ms;
      total += ms;
    }
    if (this.ms.size > 0) out.total = total;
    return out;
  }

  // Two sections of the same label in one frame (two outline layers, say) add up before they are smoothed.
  private record(label: string, ms: number, frame: number): void {
    if (this.sumFrame !== -1 && frame !== this.sumFrame) this.flush();
    this.sumFrame = frame;
    this.sum.set(label, (this.sum.get(label) ?? 0) + ms);
  }

  private flush(): void {
    for (const [label, ms] of this.sum) {
      const old = this.ms.get(label);
      this.ms.set(label, old === undefined ? ms : old * (1 - SMOOTH) + ms * SMOOTH);
    }
    this.sum.clear();
    this.sumFrame = -1;
  }
}
