/**
 * The shareable part of the app's state, kept in the page address so a link
 * reproduces what the sender was looking at. Everything read from a URL is
 * untrusted: each value is validated and anything unexpected is ignored.
 *
 *   ?periodo=week&mag=4.5&pais=170&sgc=1&emsc=1&lista=1&sismo=us7000abcd
 *   (placa=SA instead of pais= for a tectonic plate)
 */
export type UrlPeriod = 'hour' | 'day' | 'week' | 'month';

const PERIODS: readonly UrlPeriod[] = ['hour', 'day', 'week', 'month'];
const MIN_MAGS: readonly number[] = [0, 2.5, 4.5];
const COUNTRY_RE = /^\d{1,3}$/; // world-atlas numeric ISO id
const PLATE_RE = /^[A-Za-z]{2,3}$/; // PB2002 plate code
const QUAKE_RE = /^[\w.:+-]{1,100}$/;

export interface UrlState {
  period: UrlPeriod | null;
  minMag: number | null;
  sgc: boolean;
  emsc: boolean;
  country: string | null;
  plate: string | null; // upper case
  quake: string | null;
  list: boolean;
}

export function parseUrlState(search: string): UrlState {
  const p = new URLSearchParams(search);
  const period = p.get('periodo');
  const mag = p.get('mag');
  const magNum = mag === null || mag.trim() === '' ? NaN : Number(mag);
  const country = p.get('pais');
  const plate = p.get('placa');
  const quake = p.get('sismo');
  return {
    period: PERIODS.includes(period as UrlPeriod) ? (period as UrlPeriod) : null,
    minMag: MIN_MAGS.includes(magNum) ? magNum : null,
    sgc: p.get('sgc') === '1',
    emsc: p.get('emsc') === '1',
    country: country && COUNTRY_RE.test(country) ? country : null,
    // A country and a plate are mutually exclusive in the app; the country wins.
    plate: !(country && COUNTRY_RE.test(country)) && plate && PLATE_RE.test(plate) ? plate.toUpperCase() : null,
    quake: quake && QUAKE_RE.test(quake) ? quake : null,
    list: p.get('lista') === '1',
  };
}

/** "?a=b&c=d" or "" — defaults (24 h, all magnitudes, nothing enabled) are left out. */
export function buildSearch(s: Partial<UrlState>): string {
  const p = new URLSearchParams();
  if (s.period && s.period !== 'day' && PERIODS.includes(s.period)) p.set('periodo', s.period);
  if (s.minMag && MIN_MAGS.includes(s.minMag)) p.set('mag', String(s.minMag));
  if (s.sgc) p.set('sgc', '1');
  if (s.emsc) p.set('emsc', '1');
  if (s.country && COUNTRY_RE.test(s.country)) p.set('pais', s.country);
  else if (s.plate && PLATE_RE.test(s.plate)) p.set('placa', s.plate.toUpperCase());
  if (s.quake && QUAKE_RE.test(s.quake)) p.set('sismo', s.quake);
  if (s.list) p.set('lista', '1');
  const q = p.toString();
  return q ? `?${q}` : '';
}

/**
 * Period for a link to one specific quake. The link is opened later than it
 * is copied, so the window is chosen generously (a quake 20 h old still fits
 * in "24 h" for a few hours at most, so older ones jump to the next window).
 */
export function periodCovering(ageMs: number): UrlPeriod {
  if (ageMs <= 12 * 3_600_000) return 'day';
  if (ageMs <= 5 * 86_400_000) return 'week';
  return 'month';
}

/** Smallest magnitude filter that still includes the quake, to keep long periods light. */
export function minMagFor(mag: number | null, period: UrlPeriod): number {
  if (period === 'day' || mag === null) return 0;
  if (mag >= 4.5) return 4.5;
  if (mag >= 2.5) return 2.5;
  return 0;
}
