/**
 * Owns the one pending animation-frame callback of the engine.
 *
 * `request()` is idempotent: while a callback is already queued, asking again does nothing. That is
 * what keeps a single chain of callbacks alive. Without it, a redraw requested *while* a frame runs
 * (a layer, the pov handler) queued a callback and the end of the frame queued another one, and from
 * then on two chains ran side by side: twice per frame, every second call empty. The frame-rate and
 * the resolution governor then measured gaps of ~0 ms (a 60 Hz screen reported 200 fps).
 */
export interface FrameApi {
  request(callback: (time: number) => void): number;
  cancel(handle: number): void;
}

const browserApi: FrameApi = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

export class FrameLoop {
  private handle = 0;
  private queued = false;
  /** How many callbacks have run: one per screen refresh at most, whatever asked for them. */
  ticks = 0;

  constructor(
    private readonly run: (time: number) => void,
    private readonly api: FrameApi = browserApi,
  ) {}

  get pending(): boolean {
    return this.queued;
  }

  /** Queues the callback for the next refresh unless one is already queued. Returns whether it queued. */
  request(): boolean {
    if (this.queued) return false;
    this.queued = true;
    this.handle = this.api.request(this.tick);
    return true;
  }

  cancel(): void {
    if (!this.queued) return;
    this.queued = false;
    this.api.cancel(this.handle);
    this.handle = 0;
  }

  private tick = (time: number): void => {
    this.queued = false; // from here on the callback may ask for the next one
    this.handle = 0;
    this.ticks++;
    this.run(time);
  };
}
