import { getBbox } from './geo';

/** The seven largest plates in Bird (2003); everything else is listed as secondary / micro. */
const MAJOR_PLATES = new Set(['AF', 'AN', 'AU', 'EU', 'NA', 'PA', 'SA']);

// Spanish names for the best-known plates; the rest keep Bird's (English) proper names.
const SPANISH_NAMES: Record<string, string> = {
  AF: 'África',
  AN: 'Antártida',
  AU: 'Australia',
  EU: 'Eurasia',
  NA: 'Norteamérica',
  PA: 'Pacífico',
  SA: 'Sudamérica',
  NZ: 'Nazca',
  CA: 'Caribe',
  CO: 'Cocos',
  AR: 'Arabia',
  IN: 'India',
  PS: 'Mar de Filipinas',
  SC: 'Scotia',
  SO: 'Somalia',
  SU: 'Sunda',
  JF: 'Juan de Fuca',
  ND: 'Andes del Norte',
  AP: 'Altiplano',
};

export interface PlateInfo {
  code: string;
  name: string; // display name
  englishName: string;
  major: boolean;
}

export type PlateFeature = {
  type: 'Feature';
  properties: { Code?: string; PlateName?: string };
  geometry: any;
};

export function plateInfo(f: PlateFeature): PlateInfo {
  const code = String(f.properties?.Code ?? '').toUpperCase();
  const englishName = String(f.properties?.PlateName ?? code);
  return { code, englishName, name: SPANISH_NAMES[code] ?? englishName, major: MAJOR_PLATES.has(code) };
}

export function buildPlateList(features: PlateFeature[]): PlateInfo[] {
  // A few plates (Kermadec, Balmoral Reef) are split in two features at the
  // antimeridian: list each plate once.
  const seen = new Set<string>();
  return features
    .map(plateInfo)
    .filter((p) => p.code && !seen.has(p.code) && !!seen.add(p.code))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export interface PlateView {
  /** Camera target for a "fly to this plate" move. */
  lat: number;
  lng: number;
  altitude: number;
}

function outerRingPoints(geometry: any): [number, number][] {
  const polys: [number, number][][][] =
    geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  const pts: [number, number][] = [];
  for (const poly of polys) pts.push(...(poly[0] ?? []));
  return pts;
}

/**
 * Camera view framing a plate. The centre is the mean of the outline's unit
 * vectors on the sphere, so plates that cross the antimeridian (North America,
 * Pacific, Antarctica...) are framed correctly where a lng/lat bounding box
 * would put the camera on the wrong side of the planet.
 */
export function plateCameraView(geometry: any): PlateView | null {
  const pts = outerRingPoints(geometry);
  if (pts.length === 0) return null;

  const rad = Math.PI / 180;
  const vecs = pts.map(([lng, lat]) => {
    const phi = lat * rad;
    const lam = lng * rad;
    return [Math.cos(phi) * Math.cos(lam), Math.cos(phi) * Math.sin(lam), Math.sin(phi)] as const;
  });
  let x = 0;
  let y = 0;
  let z = 0;
  for (const v of vecs) {
    x += v[0];
    y += v[1];
    z += v[2];
  }
  const n = Math.hypot(x, y, z);
  let centre: readonly [number, number, number];
  if (n < 1e-6) {
    const bbox = getBbox(geometry);
    if (!bbox) return null;
    const lat0 = ((bbox[1] + bbox[3]) / 2) * rad;
    const lng0 = ((bbox[0] + bbox[2]) / 2) * rad;
    centre = [Math.cos(lat0) * Math.cos(lng0), Math.cos(lat0) * Math.sin(lng0), Math.sin(lat0)];
  } else {
    centre = [x / n, y / n, z / n];
  }

  // Angular radius = 95th percentile of the angular distance from the centre.
  const angles = vecs
    .map((v) => Math.acos(Math.min(1, Math.max(-1, v[0] * centre[0] + v[1] * centre[1] + v[2] * centre[2]))) / rad)
    .sort((a, b) => a - b);
  const radius = angles[Math.min(angles.length - 1, Math.floor(angles.length * 0.95))];

  return {
    lat: Math.asin(centre[2]) / rad,
    lng: Math.atan2(centre[1], centre[0]) / rad,
    altitude: Math.min(2.4, Math.max(0.35, (radius * 2) / 40)),
  };
}

export { getBbox as plateBbox };
