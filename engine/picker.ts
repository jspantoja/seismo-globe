import type { PlanarPolygon } from './tessellate';

/**
 * Which area lies under a geographic point. Used for hover labels and clicks, on the CPU:
 * a bounding-box test first, then the even-odd rule over the polygon's rings (outline and holes).
 */

interface Entry<T> {
  item: T;
  order: number;
  seq: number;
  polygons: PlanarPolygon[];
}

export function ringContains(ring: ArrayLike<number>, x: number, y: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const yi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const yj = ring[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonContains(poly: PlanarPolygon, x: number, y: number): boolean {
  const b = poly.bbox;
  if (y < b[1] || y > b[3] || x < b[0] || x > b[2]) return false;
  let inside = false;
  for (const ring of poly.rings) if (ringContains(ring, x, y)) inside = !inside;
  return inside;
}

export class AreaIndex<T> {
  private entries: Entry<T>[] = [];
  private seq = 0;

  clear(): void {
    this.entries = [];
    this.seq = 0;
  }

  add(item: T, polygons: PlanarPolygon[], order = 0): void {
    this.entries.push({ item, order, seq: this.seq++, polygons });
  }

  /** Every area containing the point, topmost first (higher order first; among equals, the one added last). */
  all(lat: number, lng: number): T[] {
    const hits: Entry<T>[] = [];
    // Rings may be stored on another turn of longitude (an island across the antimeridian).
    const xs = [lng, lng + 360, lng - 360];
    for (const e of this.entries) {
      outer: for (const poly of e.polygons) {
        for (const x of xs) {
          if (polygonContains(poly, x, lat)) {
            hits.push(e);
            break outer;
          }
        }
      }
    }
    hits.sort((a, b) => b.order - a.order || b.seq - a.seq);
    return hits.map((h) => h.item);
  }

  at(lat: number, lng: number): T | null {
    let best: Entry<T> | null = null;
    const xs = [lng, lng + 360, lng - 360];
    for (const e of this.entries) {
      if (best && (e.order < best.order || (e.order === best.order && e.seq < best.seq))) continue;
      let hit = false;
      outer: for (const poly of e.polygons) {
        for (const x of xs) {
          if (polygonContains(poly, x, lat)) {
            hit = true;
            break outer;
          }
        }
      }
      if (hit) best = e;
    }
    return best ? best.item : null;
  }
}
