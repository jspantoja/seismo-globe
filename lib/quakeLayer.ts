import {
  Color,
  CylinderGeometry,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
  type Camera,
  type Object3D,
  type PerspectiveCamera,
} from 'three';

/**
 * All earthquakes drawn as ONE instanced mesh.
 *
 * react-globe.gl's points layer creates a mesh per quake: one draw call each, and the
 * library also ray-casts against every one of them on a timer to find the hovered point.
 * With a month of data (about 10,000 events) that is ~10,000 draw calls per frame.
 * Here the whole set is a single draw call, and hover/click use a screen-space search
 * (see `pick`) that touches each quake once with a couple of multiplications.
 *
 * Geometry, orientation and scale copy three-globe's own points so the look is unchanged:
 * a prism standing on the surface, `altitude` tall, `radiusDeg` wide.
 */

/** three-globe's globe radius, in scene units. */
export const GLOBE_RADIUS = 100;
const PX_PER_DEG = (2 * Math.PI * GLOBE_RADIUS) / 360; // scene units per degree of arc at the surface
const MAX_RADIUS_DEG = 30; // three-globe clamps the radius the same way
const Z_AXIS = new Vector3(0, 0, 1);

/** Same conversion as three-globe's `polar2Cartesian` (its own scene coordinates). */
export function polar2Cartesian(lat: number, lng: number, relAltitude = 0): { x: number; y: number; z: number } {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((90 - lng) * Math.PI) / 180;
  const r = GLOBE_RADIUS * (1 + relAltitude);
  const s = Math.sin(phi);
  return { x: r * s * Math.cos(theta), y: r * Math.cos(phi), z: r * s * Math.sin(theta) };
}

export interface LayerQuake {
  lat: number;
  lng: number;
  mag: number | null;
}

export interface QuakeLayerStyle {
  /** Height of each prism, in globe radii. */
  altitude: number;
  /** Width of each prism's radius, in degrees of arc, before the zoom scale. */
  radiusDeg: (q: LayerQuake) => number;
  color: (q: LayerQuake) => string;
  /** Sides of the prism. */
  resolution: number;
}

export class QuakeInstances<Q extends LayerQuake = LayerQuake> {
  private mesh: InstancedMesh | null = null;
  private capacity = 0;
  private quakes: Q[] = [];
  private scale = 1;
  // Per-quake geometry kept for picking and for cheap re-scaling.
  private surface = new Float32Array(0); // xyz of the base centre
  private normal = new Float32Array(0); // xyz unit vector, outwards
  private baseRadius = new Float32Array(0); // before the zoom scale, scene units
  private height = new Float32Array(0);
  private readonly geometry: CylinderGeometry;
  private readonly material = new MeshLambertMaterial({ color: 0xffffff });
  private readonly colors = new Map<string, Color>();
  private readonly tmpPos = new Vector3();
  private readonly tmpQuat = new Quaternion();
  private readonly tmpScale = new Vector3();
  private readonly tmpMat = new Matrix4();
  private readonly tmpNormal = new Vector3();

  constructor(private readonly parent: Object3D, private readonly style: QuakeLayerStyle) {
    // A prism along +Z from the base (z = 0) to the top (z = 1), like three-globe's after its transforms.
    this.geometry = new CylinderGeometry(1, 1, 1, style.resolution);
    this.geometry.rotateX(Math.PI / 2);
    this.geometry.translate(0, 0, 0.5);
  }

  get count(): number {
    return this.quakes.length;
  }

  /** The instanced mesh, once there is data (exposed for tests). */
  get object(): InstancedMesh | null {
    return this.mesh;
  }

  /**
   * Shows `quakes` at the given zoom scale. The same array at a new scale only rewrites the
   * matrices; a different array rebuilds positions and colours too.
   */
  update(quakes: Q[], scale: number): void {
    const dataChanged = quakes !== this.quakes;
    if (!dataChanged && scale === this.scale) return;
    this.scale = scale;
    if (dataChanged) this.loadData(quakes);
    this.writeMatrices();
  }

  private ensureCapacity(n: number): void {
    if (this.mesh && n <= this.capacity) return;
    // Grow in powers of two so a stream of slightly larger catalogues does not reallocate each time.
    let cap = Math.max(64, this.capacity);
    while (cap < n) cap *= 2;
    if (this.mesh) {
      this.parent.remove(this.mesh);
      this.mesh.dispose();
    }
    const mesh = new InstancedMesh(this.geometry, this.material, cap);
    mesh.frustumCulled = false; // it spans the whole globe; culling would only cost
    mesh.raycast = () => {}; // never part of the library's per-frame hover ray-casting
    mesh.name = 'quake-instances';
    this.parent.add(mesh);
    this.mesh = mesh;
    this.capacity = cap;
    this.surface = new Float32Array(cap * 3);
    this.normal = new Float32Array(cap * 3);
    this.baseRadius = new Float32Array(cap);
    this.height = new Float32Array(cap);
  }

  private colorOf(css: string): Color {
    let c = this.colors.get(css);
    if (!c) {
      c = new Color(css);
      this.colors.set(css, c);
    }
    return c;
  }

  private loadData(quakes: Q[]): void {
    this.quakes = quakes;
    const n = quakes.length;
    if (n === 0 && !this.mesh) return;
    this.ensureCapacity(n);
    const mesh = this.mesh!;
    const height = Math.max(this.style.altitude * GLOBE_RADIUS, 0.1); // avoid a degenerate matrix
    for (let i = 0; i < n; i++) {
      const q = quakes[i];
      const p = polar2Cartesian(q.lat, q.lng, 0);
      const len = Math.hypot(p.x, p.y, p.z) || 1;
      this.surface[i * 3] = p.x;
      this.surface[i * 3 + 1] = p.y;
      this.surface[i * 3 + 2] = p.z;
      this.normal[i * 3] = p.x / len;
      this.normal[i * 3 + 1] = p.y / len;
      this.normal[i * 3 + 2] = p.z / len;
      this.baseRadius[i] = Math.min(MAX_RADIUS_DEG, +this.style.radiusDeg(q)) * PX_PER_DEG;
      this.height[i] = height;
      mesh.setColorAt(i, this.colorOf(this.style.color(q)));
    }
    mesh.count = n;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  private writeMatrices(): void {
    const mesh = this.mesh;
    if (!mesh) return;
    const n = this.quakes.length;
    for (let i = 0; i < n; i++) {
      this.tmpPos.set(this.surface[i * 3], this.surface[i * 3 + 1], this.surface[i * 3 + 2]);
      this.tmpNormal.set(this.normal[i * 3], this.normal[i * 3 + 1], this.normal[i * 3 + 2]);
      this.tmpQuat.setFromUnitVectors(Z_AXIS, this.tmpNormal);
      const r = this.baseRadius[i] * this.scale;
      this.tmpScale.set(r, r, this.height[i]);
      this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
      mesh.setMatrixAt(i, this.tmpMat);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Index (into the array last given to `update`) of the quake under the screen position
   * (`x`, `y`) — in pixels from the top-left of a `width` × `height` viewport — or -1.
   * Only quakes on the hemisphere facing the camera count, so nothing behind the globe can
   * be picked. A quake is hit when the position is within its drawn radius plus `slopPx`;
   * among several, the one whose centre is nearest wins.
   */
  pick(camera: PerspectiveCamera | Camera, width: number, height: number, x: number, y: number, slopPx: number): number {
    const n = this.quakes.length;
    if (n === 0 || width <= 0 || height <= 0) return -1;
    camera.updateMatrixWorld();
    const cam = this.tmpPos.setFromMatrixPosition(camera.matrixWorld);
    const cx = cam.x;
    const cy = cam.y;
    const cz = cam.z;
    const fov = (camera as PerspectiveCamera).fov ?? 50;
    const pxPerUnitAtOne = height / (2 * Math.tan((fov * Math.PI) / 360)); // pixels per scene unit at distance 1
    const v = this.tmpNormal;
    let best = -1;
    let bestD2 = Infinity;
    for (let i = 0; i < n; i++) {
      const nx = this.normal[i * 3];
      const ny = this.normal[i * 3 + 1];
      const nz = this.normal[i * 3 + 2];
      // A surface point faces the camera when the camera is above its tangent plane.
      if (cx * nx + cy * ny + cz * nz <= GLOBE_RADIUS) continue;
      const h = this.height[i] / 2; // aim at the middle of the prism
      const px = this.surface[i * 3] + nx * h;
      const py = this.surface[i * 3 + 1] + ny * h;
      const pz = this.surface[i * 3 + 2] + nz * h;
      v.set(px, py, pz).project(camera as PerspectiveCamera);
      if (v.z < -1 || v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * width;
      const sy = (-v.y * 0.5 + 0.5) * height;
      const dx = sx - x;
      const dy = sy - y;
      const d2 = dx * dx + dy * dy;
      const dist = Math.hypot(px - cx, py - cy, pz - cz) || 1;
      const reach = (this.baseRadius[i] * this.scale * pxPerUnitAtOne) / dist + slopPx;
      if (d2 <= reach * reach && d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return best;
  }

  quakeAt(index: number): Q | null {
    return index >= 0 && index < this.quakes.length ? this.quakes[index] : null;
  }

  dispose(): void {
    if (this.mesh) {
      this.parent.remove(this.mesh);
      this.mesh.dispose();
      this.mesh = null;
    }
    this.geometry.dispose();
    this.material.dispose();
    this.quakes = [];
  }
}
