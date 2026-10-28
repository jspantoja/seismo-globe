import { type GlobeCamera } from './camera';
import { clamp } from './math';

/**
 * Pointer, wheel and keyboard input for a globe. It only translates gestures into camera
 * calls and tells the engine when to draw; what a tap means is up to whoever listens.
 */

export interface ControlEvents {
  /** A press and release that did not move: x, y in CSS pixels from the element's top-left corner. */
  tap?: (x: number, y: number, ev: PointerEvent) => void;
  /** The mouse moved over the element without a button down (null: it left). */
  hover?: (pos: { x: number; y: number } | null, ev?: PointerEvent) => void;
  /** A gesture that moves the view started (true) or ended (false). */
  interact?: (active: boolean) => void;
  /** The pointer is being dragged (for the cursor). */
  dragging?: (active: boolean) => void;
  /** A navigation key moved or zoomed the view (to announce where it is now, for instance). */
  navigated?: () => void;
  /** The "home" key (0 or Home) was pressed: show the whole planet again. Without a handler the key is left alone. */
  home?: () => void;
}

const MOUSE_SLOP = 4; // px of movement that still counts as a tap
const TOUCH_SLOP = 9;
const TAP_MS = 500;
const WHEEL_STEP = 0.0012;
const PINCH_WHEEL_STEP = 0.01; // a trackpad pinch arrives as ctrl+wheel with small deltas
const DOUBLE_CLICK_ZOOM = 0.45;
// Keyboard: a held key moves the view smoothly, frame by frame, instead of in repeat-rate steps.
const KEY_PAN_RATE = 0.55; // radians per second, per unit of camera altitude (capped, see KEY_PAN_ALTITUDE_MAX)
const KEY_PAN_ALTITUDE_MAX = 2.2;
const KEY_ZOOM_RATE = 1.3; // e-folds of altitude per second
const KEY_FAST = 2.5; // Shift
const KEY_MIN_HOLD_MS = 120; // a tap moves the view for at least this long
const KEY_SMOOTH_MS = 70; // time constant of the speed's ramp up and down

type KeyAction = 'left' | 'right' | 'up' | 'down' | 'in' | 'out';
const KEY_ACTIONS: Record<string, KeyAction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  '+': 'in',
  '=': 'in',
  PageUp: 'in',
  '-': 'out',
  _: 'out',
  PageDown: 'out',
};

interface Tracked {
  x: number;
  y: number;
  startX: number;
  startY: number;
  t0: number;
  type: string;
  moved: boolean;
}

export class GlobeControls {
  events: ControlEvents;
  private pointers = new Map<number, Tracked>();
  private pinch: { cx: number; cy: number; dist: number } | null = null;
  private isDragging = false;
  private disposers: Array<() => void> = [];
  // keyboard motion
  private heldKeys = new Map<KeyAction, { down: number; up: number | null }>();
  private keyVel = { pan: 0, tilt: 0, zoom: 0 }; // smoothed speeds, -1..1
  private keyClock = 0;
  private keyFast = false;

  constructor(
    private readonly el: HTMLElement,
    private readonly camera: GlobeCamera,
    private readonly wake: () => void,
    events: ControlEvents = {}
  ) {
    this.events = events;
    el.style.touchAction = 'none';
    if (el.tabIndex < 0) el.tabIndex = 0;

    this.on('pointerdown', this.onDown as EventListener);
    this.on('pointermove', this.onMove as EventListener);
    this.on('pointerup', this.onUp as EventListener);
    this.on('pointercancel', this.onUp as EventListener);
    this.on('pointerleave', this.onLeave as EventListener);
    this.on('lostpointercapture', this.onLostCapture as EventListener);
    this.on('wheel', this.onWheel as EventListener, { passive: false });
    this.on('dblclick', this.onDoubleClick as EventListener);
    this.on('keydown', this.onKey as EventListener);
    this.on('keyup', this.onKeyUp as EventListener);
    this.on('blur', this.releaseKeys as EventListener);
    this.on('contextmenu', ((ev: Event) => {
      if (this.pointers.size > 0) ev.preventDefault();
    }) as EventListener);
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.pointers.clear();
  }

  private on(type: string, fn: EventListener, options?: AddEventListenerOptions): void {
    this.el.addEventListener(type, fn, options);
    this.disposers.push(() => this.el.removeEventListener(type, fn, options));
  }

  private local(ev: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  private stamp(ev: Event): number {
    return ev.timeStamp > 0 ? ev.timeStamp : performance.now();
  }

  private setDragging(active: boolean): void {
    if (this.isDragging === active) return;
    this.isDragging = active;
    this.events.dragging?.(active);
  }

  // ------------------------------------------------------------------ pointers

  private onDown = (ev: PointerEvent): void => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (this.pointers.size >= 2) return;
    const { x, y } = this.local(ev);
    try {
      this.el.setPointerCapture(ev.pointerId);
    } catch {
      // The pointer is already gone (a very fast tap): nothing to capture.
    }
    this.el.focus({ preventScroll: true });
    const now = this.stamp(ev);
    this.pointers.set(ev.pointerId, { x, y, startX: x, startY: y, t0: now, type: ev.pointerType, moved: false });
    if (this.pointers.size === 1) {
      this.camera.beginGrab(x, y, now);
      this.events.interact?.(true);
    } else {
      // A second finger: the grab becomes a pinch (no inertia).
      this.camera.endGrab(now);
      this.camera.cancelMotion();
      for (const p of this.pointers.values()) p.moved = true;
      this.pinch = this.pinchState();
      this.setDragging(true);
    }
    this.wake();
  };

  private pinchState(): { cx: number; cy: number; dist: number } | null {
    if (this.pointers.size < 2) return null;
    const [a, b] = [...this.pointers.values()];
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
  }

  private onMove = (ev: PointerEvent): void => {
    const p = this.pointers.get(ev.pointerId);
    const { x, y } = this.local(ev);
    if (!p) {
      if (ev.pointerType === 'mouse' && ev.buttons === 0) this.events.hover?.({ x, y }, ev);
      return;
    }
    p.x = x;
    p.y = y;
    const now = this.stamp(ev);
    if (this.pointers.size === 1) {
      if (!p.moved) {
        const slop = p.type === 'mouse' ? MOUSE_SLOP : TOUCH_SLOP;
        if (Math.hypot(x - p.startX, y - p.startY) > slop) {
          p.moved = true;
          this.setDragging(true);
          this.events.hover?.(null, ev);
        }
      }
      if (p.moved) this.camera.dragTo(x, y, now);
    } else {
      const next = this.pinchState();
      if (next && this.pinch) {
        this.camera.pinch(this.pinch.cx, this.pinch.cy, next.cx, next.cy, this.pinch.dist / next.dist);
      }
      this.pinch = next;
    }
    this.wake();
  };

  private onUp = (ev: PointerEvent): void => {
    const p = this.pointers.get(ev.pointerId);
    if (!p) return;
    const { x, y } = this.local(ev);
    this.finish(ev.pointerId, x, y, this.stamp(ev), ev.type === 'pointercancel', ev);
  };

  private onLostCapture = (ev: PointerEvent): void => {
    // The browser took the pointer away without a pointerup (a system gesture, a dialog...).
    const p = this.pointers.get(ev.pointerId);
    if (p) this.finish(ev.pointerId, p.x, p.y, this.stamp(ev), true, null);
  };

  private finish(id: number, x: number, y: number, now: number, cancelled: boolean, ev: PointerEvent | null): void {
    const p = this.pointers.get(id);
    if (!p) return;
    p.x = x;
    p.y = y;
    this.pointers.delete(id);
    try {
      this.el.releasePointerCapture(id);
    } catch {
      // Already released.
    }

    if (this.pointers.size === 0) {
      this.pinch = null;
      this.setDragging(false);
      if (cancelled) {
        this.camera.endGrab(now);
        this.camera.cancelMotion();
      } else if (!p.moved && now - p.t0 < TAP_MS) {
        this.camera.endGrab(now);
        if (ev) this.events.tap?.(x, y, ev);
      } else {
        this.camera.endGrab(now); // lets go with the speed the drag had
      }
      this.events.interact?.(false);
    } else {
      // One finger of a pinch left: the other one carries on dragging.
      this.pinch = null;
      const rest = [...this.pointers.values()][0];
      rest.moved = true;
      this.camera.beginGrab(rest.x, rest.y, now);
    }
    this.wake();
  }

  private onLeave = (ev: PointerEvent): void => {
    if (ev.pointerType === 'mouse' && this.pointers.size === 0) this.events.hover?.(null, ev);
  };

  // ------------------------------------------------------------------ wheel, double click

  private onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    let dy = ev.deltaY;
    if (dy === 0) return;
    if (ev.deltaMode === 1) dy *= 16;
    else if (ev.deltaMode === 2) dy *= this.el.clientHeight || 800;
    const step = ev.ctrlKey ? PINCH_WHEEL_STEP : WHEEL_STEP;
    const { x, y } = this.local(ev);
    this.camera.zoomBy(Math.exp(clamp(dy * step, -0.7, 0.7)), x, y);
    this.events.hover?.(null);
    this.wake();
  };

  private onDoubleClick = (ev: MouseEvent): void => {
    ev.preventDefault();
    const { x, y } = this.local(ev);
    this.camera.zoomBy(DOUBLE_CLICK_ZOOM, x, y);
    this.wake();
  };

  // ------------------------------------------------------------------ keyboard

  /** True while a navigation key is down or the view is still easing to a stop: the engine keeps drawing. */
  get keysActive(): boolean {
    return this.heldKeys.size > 0 || this.keyVel.pan !== 0 || this.keyVel.tilt !== 0 || this.keyVel.zoom !== 0;
  }

  private onKey = (ev: KeyboardEvent): void => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    this.keyFast = ev.shiftKey;
    if ((ev.key === 'Home' || ev.key === '0') && this.events.home) {
      ev.preventDefault();
      this.events.home();
      return;
    }
    const action = KEY_ACTIONS[ev.key];
    if (!action) return;
    ev.preventDefault();
    const now = this.stamp(ev);
    const held = this.heldKeys.get(action);
    if (!held || held.up !== null) this.heldKeys.set(action, { down: now, up: null });
    this.wake();
  };

  private onKeyUp = (ev: KeyboardEvent): void => {
    this.keyFast = ev.shiftKey;
    const action = KEY_ACTIONS[ev.key];
    if (!action) return;
    const held = this.heldKeys.get(action);
    if (held && held.up === null) held.up = this.stamp(ev);
    this.wake();
  };

  /** Drops every held key and the glide that follows them (the view is about to be moved some other way). */
  stopKeys(): void {
    this.heldKeys.clear();
    this.keyVel.pan = 0;
    this.keyVel.tilt = 0;
    this.keyVel.zoom = 0;
    this.keyClock = 0;
  }

  /** Focus left the element: no key can be "still down". */
  private releaseKeys = (): void => {
    const now = performance.now();
    for (const held of this.heldKeys.values()) if (held.up === null) held.up = now;
  };

  /**
   * Moves the camera for the keys held down at `now` (ms, the frame clock). Returns whether the view
   * changed. Call once per frame, before the camera's own update.
   */
  update(now: number): boolean {
    if (!this.keysActive) {
      this.keyClock = 0;
      return false;
    }
    const dt = this.keyClock ? clamp(now - this.keyClock, 0, 100) : 16;
    this.keyClock = now;

    let pan = 0;
    let tilt = 0;
    let zoom = 0;
    for (const [action, held] of this.heldKeys) {
      const end = held.up === null ? Infinity : Math.max(held.up, held.down + KEY_MIN_HOLD_MS);
      if (now >= end) {
        this.heldKeys.delete(action);
        continue;
      }
      if (action === 'left') pan -= 1;
      else if (action === 'right') pan += 1;
      else if (action === 'up') tilt -= 1;
      else if (action === 'down') tilt += 1;
      else if (action === 'in') zoom -= 1;
      else zoom += 1;
    }
    const k = 1 - Math.exp(-dt / KEY_SMOOTH_MS);
    const v = this.keyVel;
    v.pan += (pan - v.pan) * k;
    v.tilt += (tilt - v.tilt) * k;
    v.zoom += (zoom - v.zoom) * k;
    const REST = 0.01;
    if (pan === 0 && Math.abs(v.pan) < REST) v.pan = 0;
    if (tilt === 0 && Math.abs(v.tilt) < REST) v.tilt = 0;
    if (zoom === 0 && Math.abs(v.zoom) < REST) v.zoom = 0;
    if (v.pan === 0 && v.tilt === 0 && v.zoom === 0) return false;

    const cam = this.camera;
    const fast = this.keyFast ? KEY_FAST : 1;
    const omega = KEY_PAN_RATE * clamp(cam.altitude, 0.02, KEY_PAN_ALTITUDE_MAX) * fast * (dt / 1000);
    if (pan !== 0 || tilt !== 0 || zoom !== 0) cam.cancelMotion(); // a key is down: the user takes over from a flight or a glide
    if (v.pan !== 0) cam.rotateBy(cam.up, v.pan * omega);
    if (v.tilt !== 0) cam.rotateBy(cam.right, v.tilt * omega);
    if (v.zoom !== 0) cam.zoomNow(Math.exp(v.zoom * KEY_ZOOM_RATE * fast * (dt / 1000)));
    this.events.navigated?.();
    return true;
  }
}
