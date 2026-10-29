/**
 * Adaptive resolution while the view moves.
 *
 * Browsers only tell a page how long frames take (the gap between animation frames), not how much
 * GPU headroom is left, so the governor works from that gap alone:
 *   - when the typical (median) recent frame is slower than `slowMs` it lowers the resolution, by about the square
 *     root of the speed it is missing (the cost of a frame follows the number of pixels);
 *   - when frames keep up at a lowered resolution it tries one step back up from time to time. A
 *     failed attempt (slow again soon after) doubles the wait before the next one, so a device that
 *     really cannot afford the full resolution settles instead of flickering between two.
 * The engine draws at the full resolution whenever the view is still, so this only ever affects
 * motion; it never needs to find the "right" resolution for a still picture.
 *
 * Pure logic, no browser: tests feed it frame gaps and read the scale it picks.
 */

export interface GovernorOptions {
  /** Lowest scale it will pick (default 0.5). */
  min?: number;
  /** A median frame gap above this is too slow, in ms (default 27: under ~37 fps). */
  slowMs?: number;
  /** The gap it aims for when it lowers the scale, in ms (default 17). */
  targetMs?: number;
  /** How many frame gaps make an assessment (default 12). */
  window?: number;
  /** First wait before trying a higher scale, in ms (default 6000). */
  probeAfterMs?: number;
  /** Longest wait between attempts, in ms (default 120000). */
  maxProbeWaitMs?: number;
}

/** A gap longer than this is a stall (tab hidden, long task), not a sustained rate. */
const STALL_MS = 250;
/** Frames this soon after trying a higher scale that come slow count as a failed attempt. */
const PROBE_GRACE_MS = 3000;

export class ResolutionGovernor {
  /** The scale to draw moving frames at (1 = the device's resolution, capped by the engine). */
  scale = 1;
  /** The median frame gap of the latest full assessment, in ms (null before the first one): for diagnostics. */
  lastMedianMs: number | null = null;

  private readonly min: number;
  private readonly slowMs: number;
  private readonly targetMs: number;
  private readonly size: number;
  private readonly maxWait: number;
  private probeWait: number;
  private readonly firstWait: number;

  private gaps: number[] = [];
  private lastChange = Number.NEGATIVE_INFINITY;
  private lastProbe = Number.NEGATIVE_INFINITY;
  private probing = false;

  constructor(options: GovernorOptions = {}) {
    this.min = options.min ?? 0.5;
    this.slowMs = options.slowMs ?? 27;
    this.targetMs = options.targetMs ?? 17;
    this.size = options.window ?? 12;
    this.firstWait = options.probeAfterMs ?? 6000;
    this.probeWait = this.firstWait;
    this.maxWait = options.maxProbeWaitMs ?? 120000;
  }

  /**
   * Feeds the gap between two consecutive frames of continuous motion (ms) at time `now` (ms).
   * Returns the new scale when it changes, otherwise null.
   */
  frame(gapMs: number, now: number): number | null {
    const gap = Math.min(STALL_MS, Math.max(0, gapMs));
    this.gaps.push(gap);
    if (this.gaps.length > this.size) this.gaps.shift();
    if (this.gaps.length < this.size) return null;
    // The median: one long frame (a garbage collection, a hitch) must not look like a slow device.
    const sorted = [...this.gaps].sort((a, b) => a - b);
    const avg = sorted[sorted.length >> 1];
    this.lastMedianMs = avg;

    if (avg > this.slowMs && this.scale > this.min) {
      if (this.probing && now - this.lastProbe < PROBE_GRACE_MS) {
        this.probeWait = Math.min(this.maxWait, this.probeWait * 2); // that attempt failed
      }
      this.probing = false;
      const factor = Math.min(0.9, Math.max(0.6, Math.sqrt(this.targetMs / avg)));
      return this.set(Math.max(this.min, this.scale * factor), now);
    }

    if (this.scale < 1 && avg <= this.targetMs + 3 && now - this.lastChange >= this.probeWait && now - this.lastProbe >= this.probeWait) {
      this.probing = true;
      this.lastProbe = now;
      return this.set(Math.min(1, this.scale * 1.15), now);
    }
    if (this.probing && now - this.lastProbe >= PROBE_GRACE_MS) {
      // The higher scale held: the next attempt can come sooner again.
      this.probing = false;
      this.probeWait = Math.max(this.firstWait, this.probeWait / 2);
    }
    return null;
  }

  /** Forgets the recent frames (the motion stopped: the next frames start a new assessment). */
  rest(): void {
    this.gaps = [];
  }

  private set(scale: number, now: number): number | null {
    const next = Math.round(scale * 100) / 100;
    this.gaps = [];
    this.lastChange = now;
    if (next === this.scale) return null;
    this.scale = next;
    return next;
  }
}
