import type { BoundaryPath, QuakeFeature } from './types';

/** "Earthquakes near me": plain geometry on a sphere, no network and no state. */

export interface LatLng {
  lat: number;
  lng: number;
}

export const RADIUS_OPTIONS = [50, 100, 200, 500] as const;
export const DEFAULT_RADIUS_KM = 200;

const EARTH_RADIUS_KM = 6371.0088;
const RAD = Math.PI / 180;

/** Great-circle (haversine) distance in kilometres. */
export function distanceKm(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial compass bearing from `from` to `to`, in degrees clockwise from north (0..360). */
export function bearingDeg(from: LatLng, to: LatLng): number {
  const dLng = (to.lng - from.lng) * RAD;
  const y = Math.sin(dLng) * Math.cos(to.lat * RAD);
  const x = Math.cos(from.lat * RAD) * Math.sin(to.lat * RAD) - Math.sin(from.lat * RAD) * Math.cos(to.lat * RAD) * Math.cos(dLng);
  return ((Math.atan2(y, x) / RAD) + 360) % 360;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'] as const;

/** Eight-point compass label in Spanish (N, NE, E, SE, S, SO, O, NO). */
export function compassLabel(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

export interface NearbyQuake {
  quake: QuakeFeature;
  distanceKm: number;
  direction: string; // where the quake lies as seen from the centre
}

/** Quakes within `radiusKm` of `center`, nearest first. */
export function nearbyQuakes(quakes: QuakeFeature[], center: LatLng, radiusKm: number): NearbyQuake[] {
  const out: NearbyQuake[] = [];
  for (const quake of quakes) {
    // Cheap rejection: one degree of latitude is ~111 km everywhere.
    if (Math.abs(quake.lat - center.lat) * 111.2 > radiusKm + 1) continue;
    const d = distanceKm(center, quake);
    if (d <= radiusKm) out.push({ quake, distanceKm: d, direction: compassLabel(bearingDeg(center, quake)) });
  }
  return out.sort((a, b) => a.distanceKm - b.distanceKm);
}

/**
 * Closed ring of [lat, lng] points at `radiusKm` from `center`, for the globe's
 * path layer. Longitudes are NOT wrapped into [-180, 180]: the ring stays
 * continuous across the antimeridian, so the line is not drawn around the planet.
 */
export function circlePath(center: LatLng, radiusKm: number, steps = 96): [number, number][] {
  const d = radiusKm / EARTH_RADIUS_KM;
  const lat1 = center.lat * RAD;
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * 2 * Math.PI;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(theta));
    const dLng = Math.atan2(Math.sin(theta) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    out.push([lat2 / RAD, center.lng + dLng / RAD]);
  }
  return out;
}

export function radiusPath(center: LatLng, radiusKm: number): BoundaryPath {
  return { id: 'near-radius', plateA: String(radiusKm), plateB: '', boundaryType: 'near-radius', coords: circlePath(center, radiusKm) };
}

/** Camera altitude (in globe radii) that frames a circle of this radius comfortably. */
export function flightAltitudeFor(radiusKm: number): number {
  return Math.min(1.2, Math.max(0.15, radiusKm / 1500 + 0.12));
}

/** A typed coordinate: accepts "4.71" and "4,71"; null when it is not a number in range. */
export function parseCoordinate(text: string, kind: 'lat' | 'lng'): number | null {
  const s = text.trim().replace(/\s+/g, '');
  if (!/^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/.test(s)) return null;
  const n = Number(s.replace(',', '.'));
  const limit = kind === 'lat' ? 90 : 180;
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}
