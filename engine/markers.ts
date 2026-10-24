import type { EngineLayer, FrameContext, LayerHost } from './engine';
import type { ScreenPoint } from './camera';
import { geoToVec, type Vec3 } from './math';

/**
 * HTML markers over the globe: the "new quake" arrow, the "you are here" pin. They are ordinary DOM
 * (styled and made accessible with CSS and ARIA, clickable), moved every frame to the screen position
 * of a geographic point, and hidden while the planet is in the way.
 */

/**
 * True when `point` can be seen from `eye`, i.e. the segment between them does not pass through the
 * unit sphere. Exact (a point above the surface near the limb is still seen when it is beyond the
 * horizon plane of the surface), and a point lying on the near side of the surface counts as visible.
 */
export function pointVisible(eye: Vec3, point: Vec3): boolean {
  const dx = point[0] - eye[0];
  const dy = point[1] - eye[1];
  const dz = point[2] - eye[2];
  const dd = dx * dx + dy * dy + dz * dz;
  if (dd === 0) return true;
  // Parameter of the point of the segment closest to the globe's centre.
  const t = Math.min(1, Math.max(0, -(eye[0] * dx + eye[1] * dy + eye[2] * dz) / dd));
  const cx = eye[0] + dx * t;
  const cy = eye[1] + dy * t;
  const cz = eye[2] + dz * t;
  return cx * cx + cy * cy + cz * cz >= 1 - 1e-9;
}

export interface MarkerSpec {
  /** Identity: a marker whose id is still in the list keeps its element. */
  id: string | number;
  lat: number;
  lng: number;
  /** Height above the surface in globe radii (default 0.02). */
  altitude?: number;
  /** Builds the element; called once, when the id first appears. Its (0, 0) is the geographic point. */
  create: () => HTMLElement;
}

interface Placed {
  spec: MarkerSpec;
  point: Vec3;
  wrapper: HTMLElement;
  x: number;
  y: number;
  hidden: boolean;
}

export class MarkerLayer implements EngineLayer {
  private host: LayerHost | null = null;
  private placed = new Map<string | number, Placed>();
  private readonly screen: ScreenPoint = { x: 0, y: 0, depth: 0, w: 0 };
  private pending: MarkerSpec[] | null = null;

  attach(host: LayerHost): void {
    this.host = host;
    if (this.pending) {
      const list = this.pending;
      this.pending = null;
      this.setMarkers(list);
    }
  }

  get count(): number {
    return this.placed.size;
  }

  /** The wrapper element of a marker, if it exists (tests, and callers that need to focus it). */
  elementOf(id: string | number): HTMLElement | null {
    return this.placed.get(id)?.wrapper ?? null;
  }

  /** Whether a marker is currently hidden because the planet is in front of it. */
  isHidden(id: string | number): boolean {
    return this.placed.get(id)?.hidden ?? true;
  }

  setMarkers(specs: MarkerSpec[]): void {
    const host = this.host;
    if (!host) {
      this.pending = specs;
      return;
    }
    const next = new Map<string | number, Placed>();
    for (const spec of specs) {
      const point = geoToVec(spec.lat, spec.lng, 1 + (spec.altitude ?? 0.02));
      const old = this.placed.get(spec.id);
      if (old) {
        old.spec = spec;
        old.point = point;
        next.set(spec.id, old);
        this.placed.delete(spec.id);
        continue;
      }
      const doc = host.overlay.ownerDocument;
      const wrapper = doc.createElement('div');
      wrapper.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;will-change:transform;visibility:hidden;';
      wrapper.appendChild(spec.create());
      host.overlay.appendChild(wrapper);
      next.set(spec.id, { spec, point, wrapper, x: NaN, y: NaN, hidden: true });
    }
    for (const gone of this.placed.values()) gone.wrapper.remove();
    this.placed = next;
    host.requestRender();
  }

  init(): void {}

  draw(frame: FrameContext): void {
    if (this.placed.size === 0) return;
    const cam = frame.camera;
    const eye = cam.position();
    const dpr = frame.pixelRatio;
    const s = this.screen;
    for (const m of this.placed.values()) {
      let show = pointVisible(eye, m.point);
      if (show) {
        cam.projectExact(m.point, s);
        show = Number.isFinite(s.x) && s.depth >= -1 && s.depth <= 1;
      }
      if (!show) {
        if (!m.hidden) {
          m.wrapper.style.visibility = 'hidden';
          m.hidden = true;
        }
        continue;
      }
      // Whole device pixels: text and borders stay crisp, and the marker does not shimmer as it moves.
      const x = Math.round(s.x * dpr) / dpr;
      const y = Math.round(s.y * dpr) / dpr;
      if (x !== m.x || y !== m.y) {
        m.wrapper.style.transform = `translate(${x}px, ${y}px)`;
        m.x = x;
        m.y = y;
      }
      if (m.hidden) {
        m.wrapper.style.visibility = 'visible';
        m.hidden = false;
      }
    }
  }

  dispose(): void {
    for (const m of this.placed.values()) m.wrapper.remove();
    this.placed.clear();
  }
}
