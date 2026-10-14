import type { QuakeFeature } from './types';

/**
 * Attaches crowd-sourced reports (EMSC testimonies) to the events other
 * networks already published, so the same earthquake is not drawn twice.
 *
 * Agencies disagree slightly on origin time and location, so two events are
 * the same earthquake when they are within MAX_DT_MS of each other, within
 * MAX_KM, and (when both have one) within MAX_DMAG magnitude units. Each base
 * event can take at most one report set; unmatched reports stay standalone
 * (source "EMSC") — typically places the base networks do not cover.
 */
const MAX_DT_MS = 90_000;
const MAX_KM = 100;
const MAX_DMAG = 1.0;

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function mergeCitizenReports(base: QuakeFeature[], reports: QuakeFeature[]): QuakeFeature[] {
  if (reports.length === 0) return base;

  const order = base.map((_, i) => i).sort((a, b) => base[a].time - base[b].time);
  const times = order.map((i) => base[i].time);
  const enriched = new Map<number, QuakeFeature>();
  const standalone: QuakeFeature[] = [];

  // Events with most testimonies first: they claim the best match.
  const byReports = [...reports].sort((a, b) => (b.citizen?.reports ?? 0) - (a.citizen?.reports ?? 0));
  for (const e of byReports) {
    if (!e.citizen) continue;

    // First candidate whose time is >= e.time - MAX_DT_MS.
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < e.time - MAX_DT_MS) lo = mid + 1;
      else hi = mid;
    }

    let best = -1;
    let bestScore = Infinity;
    for (let k = lo; k < times.length && times[k] <= e.time + MAX_DT_MS; k++) {
      const bi = order[k];
      if (enriched.has(bi)) continue;
      const b = base[bi];
      const km = haversineKm(b.lat, b.lng, e.lat, e.lng);
      if (km > MAX_KM) continue;
      if (b.mag !== null && e.mag !== null && Math.abs(b.mag - e.mag) > MAX_DMAG) continue;
      const score = km / MAX_KM + Math.abs(b.time - e.time) / MAX_DT_MS;
      if (score < bestScore) {
        bestScore = score;
        best = bi;
      }
    }

    if (best >= 0) enriched.set(best, { ...base[best], citizen: e.citizen });
    else standalone.push(e);
  }

  return [...base.map((q, i) => enriched.get(i) ?? q), ...standalone];
}
