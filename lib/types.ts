// 'EMSC' = an event that exists only as citizen testimonies; 'EMSC-CAT' = an
// event from the EMSC seismic catalogue, used as a backup when USGS is down.
export type QuakeSource = 'USGS' | 'SGC' | 'EMSC' | 'EMSC-CAT';

/** Citizen "did you feel it" testimonies attached to an event (EMSC, CC BY 4.0). */
export interface CitizenReports {
  source: 'EMSC';
  reports: number; // number of testimonies; NOT a measure of damage
  url: string; // EMSC event page
  eventId: string; // EMSC unified id (UNID)
}

export interface QuakeFeature {
  id: string;
  mag: number | null;
  magType: string | null;
  place: string | null;
  time: number; // epoch ms
  updated: number; // epoch ms
  url: string; // human-readable event page
  detailUrl: string; // machine-readable detail feed
  felt: number | null; // number of "did you feel it" reports
  tsunami: number; // 0 | 1
  alert: string | null; // green/yellow/orange/red
  status: string; // automatic | reviewed
  sig: number | null; // significance score
  depthKm: number | null;
  lat: number;
  lng: number;
  source: QuakeSource;
  intensity?: string | null; // e.g. "MMI 4" when the source publishes felt-intensity
  citizen?: CitizenReports | null; // crowd-sourced testimonies from another network (see lib/citizen.ts)
}

export interface SourceMeta {
  name: string;
  url: string;
  license: string;
  fetchedAt: string; // ISO
}

export interface EarthquakesResponse {
  quakes: QuakeFeature[];
  source: SourceMeta;
  stale: boolean;
  staleReason?: string;
  period: 'hour' | 'day' | 'week' | 'month';
  minMagnitude: number;
  count: number;
}

export interface PlateFeatureProps {
  LAYER: string;
  Code: string;
  PlateName: string;
}

export interface BoundaryPath {
  id: string;
  plateA: string;
  plateB: string;
  boundaryType: string; // e.g. "subduction" or "unclassified"
  coords: [number, number][]; // [lat, lng] pairs
}

// ---- Historical statistics (see lib/stats.ts) ----

export interface StatsPoint {
  key: string; // "YYYY", "YYYY-MM" or "YYYY-MM-DD" (UTC)
  count: number;
  maxMag: number | null;
  partial: boolean; // period still in progress
}

export interface StatsBin {
  label: string;
  count: number;
}

export interface StatsRecurrence {
  minMag: number;
  count: number;
  perYear: number;
  returnYears: number | null; // average years between events, null if none occurred
}

export interface StatsLargest {
  id: string;
  mag: number;
  place: string | null;
  time: number;
  depthKm: number | null;
  lat: number;
  lng: number;
  url: string;
}

export interface StatsPrecision {
  sample: number;
  reviewedPct: number | null;
  medianHorizontalErrorKm: number | null;
  medianDepthErrorKm: number | null;
  medianMagError: number | null;
  withHorizontalError: number;
  withDepthError: number;
  withMagError: number;
}

export interface StatsResponse {
  scope: 'world' | 'country' | 'plate';
  plateCode: string | null;
  countryId: string | null; // set when the country was resolved with its real borders
  offshoreKm: number | null; // sea distance from the coast still counted for the country
  bbox: [number, number, number, number] | null;
  source: SourceMeta;
  range: { from: string; to: string; years: number; yearsElapsed: number };
  requestedMinMag: number;
  minMag: number; // effective threshold (may be raised to respect the 20,000-event cap)
  adjusted: boolean;
  total: number;
  perYear: number;
  maxMag: number | null;
  last12Months: number;
  vsAveragePct: number | null;
  yearly: StatsPoint[];
  monthly: StatsPoint[];
  daily: StatsPoint[];
  magnitudeBins: StatsBin[];
  depthBins: StatsBin[];
  recurrence: StatsRecurrence[];
  largest: StatsLargest[];
  precision: StatsPrecision;
}
