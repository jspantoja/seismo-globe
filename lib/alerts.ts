import type { QuakeFeature } from './types';
import { magLabel, sourceLabel } from './format';

// The key keeps its historical "v1" name so settings saved by earlier versions are
// found and migrated; the real schema version lives inside the stored object.
const STORAGE_KEY = 'seismo-globe:alert-settings:v1';
const SCHEMA_VERSION = 2;

/** Magnitude thresholds offered in the UI. 0 means "any magnitude". */
export const ALERT_MAG_OPTIONS = [0, 2.5, 3, 4, 4.5, 5, 6, 7] as const;
/** Magnitudes that may break through quiet hours. 0 means "never". */
export const QUIET_EXCEPT_OPTIONS = [0, 5, 6, 7] as const;

export interface QuietHours {
  enabled: boolean;
  /** Start of the silent window, minutes after local midnight (0–1439). */
  from: number;
  /** End of the silent window (exclusive), minutes after local midnight. It may be earlier than `from`: the window then crosses midnight. */
  to: number;
  /** A quake at or above this magnitude still alerts during quiet hours; 0 = none does. */
  exceptMag: number;
}

export interface AlertSettings {
  enabled: boolean;
  countryIds: string[]; // world-atlas numeric ids, e.g. "170" for Colombia
  browserNotifications: boolean;
  /** Smallest magnitude that triggers an alert; 0 = all. */
  minMag: number;
  /** Per-country threshold that replaces `minMag` for that country. Absent = follow the global one. */
  countryMinMag: Record<string, number>;
  quiet: QuietHours;
}

export function defaultAlertSettings(): AlertSettings {
  return {
    enabled: false,
    countryIds: [],
    browserNotifications: false,
    minMag: 0,
    countryMinMag: {},
    quiet: { enabled: false, from: 22 * 60, to: 6 * 60, exceptMag: 0 },
  };
}

function cleanMag(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 10 ? Math.round(n * 10) / 10 : fallback;
}

function cleanMinutes(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : NaN;
  return Number.isInteger(n) && n >= 0 && n < 24 * 60 ? n : fallback;
}

/**
 * Turns whatever was in storage into valid settings. Settings saved before magnitude
 * thresholds and quiet hours existed (the original schema) keep everything they had
 * and receive the neutral defaults for the new fields, so nobody's alerts change
 * behaviour after an update. Anything malformed falls back to its default.
 */
export function parseAlertSettings(raw: unknown): AlertSettings {
  const base = defaultAlertSettings();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const p = raw as Record<string, unknown>;

  const countryMinMag: Record<string, number> = {};
  if (p.countryMinMag && typeof p.countryMinMag === 'object' && !Array.isArray(p.countryMinMag)) {
    for (const [id, v] of Object.entries(p.countryMinMag as Record<string, unknown>)) {
      if (id === '__proto__' || id.length > 16) continue;
      const m = cleanMag(v, -1);
      if (m >= 0) countryMinMag[id] = m;
    }
  }

  const q = p.quiet && typeof p.quiet === 'object' && !Array.isArray(p.quiet) ? (p.quiet as Record<string, unknown>) : {};

  return {
    enabled: !!p.enabled,
    countryIds: Array.isArray(p.countryIds) ? [...new Set(p.countryIds.map(String))] : [],
    browserNotifications: !!p.browserNotifications,
    minMag: cleanMag(p.minMag, base.minMag),
    countryMinMag,
    quiet: {
      enabled: !!q.enabled,
      from: cleanMinutes(q.from, base.quiet.from),
      to: cleanMinutes(q.to, base.quiet.to),
      exceptMag: cleanMag(q.exceptMag, base.quiet.exceptMag),
    },
  };
}

export function loadAlertSettings(): AlertSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? parseAlertSettings(JSON.parse(raw)) : defaultAlertSettings();
  } catch {
    return defaultAlertSettings();
  }
}

export function saveAlertSettings(settings: AlertSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, ...settings }));
  } catch {
    /* localStorage unavailable (private mode, quota, etc.) — alerts just won't persist */
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const has = (o: Record<string, number>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** The magnitude threshold that applies to a quake in `countryId` (null = no specific country). */
export function thresholdFor(settings: AlertSettings, countryId: string | null): number {
  if (countryId !== null && has(settings.countryMinMag, countryId)) return settings.countryMinMag[countryId];
  return settings.minMag;
}

/** True when `now` (device local time) falls inside the quiet window. An empty window (from == to) never silences. */
export function isQuietNow(quiet: QuietHours, now: Date): boolean {
  if (!quiet.enabled || quiet.from === quiet.to) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  return quiet.from < quiet.to ? m >= quiet.from && m < quiet.to : m >= quiet.from || m < quiet.to;
}

export interface AlertHit {
  quake: QuakeFeature;
  /** Name of the watched country the quake belongs to; undefined when watching everywhere. */
  countryName?: string;
}

export interface CountryRef {
  id: string;
  name: string;
}

/**
 * Of the freshly arrived quakes, the one that should raise an alert, or null.
 * Rules, in order: alerts on; the quake belongs to a watched country (or none is chosen =
 * everywhere); its magnitude reaches the threshold for that country; and, inside quiet
 * hours, it reaches the exception magnitude. When several qualify the strongest wins
 * (ties: the most recent), so one burst of aftershocks yields one alert about the biggest.
 * A quake with no published magnitude only qualifies when the threshold is "any".
 */
export function pickAlert(
  fresh: QuakeFeature[],
  settings: AlertSettings,
  resolveCountry: (quake: QuakeFeature) => CountryRef | null,
  now: Date
): AlertHit | null {
  if (!settings.enabled || fresh.length === 0) return null;
  const watch = new Set(settings.countryIds);
  const quiet = isQuietNow(settings.quiet, now);

  let best: AlertHit | null = null;
  for (const q of fresh) {
    let country: CountryRef | null = null;
    if (watch.size > 0) {
      country = resolveCountry(q);
      if (!country || !watch.has(country.id)) continue;
    }
    const threshold = thresholdFor(settings, country ? country.id : null);
    if (threshold > 0 && (q.mag === null || q.mag < threshold)) continue;
    if (quiet && !(settings.quiet.exceptMag > 0 && q.mag !== null && q.mag >= settings.quiet.exceptMag)) continue;

    if (!best || (q.mag ?? -1) > (best.quake.mag ?? -1) || ((q.mag ?? -1) === (best.quake.mag ?? -1) && q.time > best.quake.time)) {
      best = { quake: q, countryName: country?.name };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, '0');

export function minutesToTime(minutes: number): string {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

/** "HH:MM" from an <input type="time"> to minutes after midnight, or null when empty/invalid. */
export function timeToMinutes(text: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

export const magOptionLabel = (m: number) => (m === 0 ? 'Todas' : `M${m}+`);

/** One sentence that says exactly what the current settings will do. */
export function describeAlertRule(settings: AlertSettings, names: Record<string, string>): string {
  if (!settings.enabled) return 'Las alertas están desactivadas.';
  const where =
    settings.countryIds.length === 0
      ? 'en todo el mundo'
      : `en ${settings.countryIds
          .map((id) => {
            const own = has(settings.countryMinMag, id) ? settings.countryMinMag[id] : null;
            const name = names[id] ?? id;
            return own !== null && own !== settings.minMag ? `${name} (${magOptionLabel(own)})` : name;
          })
          .join(', ')}`;
  const mag = settings.minMag > 0 ? `de magnitud ${settings.minMag} o más` : 'de cualquier magnitud';
  let text = `Avisará de sismos nuevos ${mag} ${where}.`;
  const { quiet } = settings;
  if (quiet.enabled && quiet.from !== quiet.to) {
    text += ` En silencio de ${minutesToTime(quiet.from)} a ${minutesToTime(quiet.to)}`;
    text += quiet.exceptMag > 0 ? `, salvo M${quiet.exceptMag}+.` : '.';
  }
  return text;
}

// ---------------------------------------------------------------------------
// Browser notifications
// ---------------------------------------------------------------------------

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export function notifyQuake(quake: QuakeFeature, watchedLabel?: string): void {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  try {
    const title = `Sismo M${magLabel(quake.mag)}${watchedLabel ? ` — ${watchedLabel}` : ''}`;
    const body = `${quake.place ?? 'Ubicación desconocida'} (${sourceLabel(quake.source)})`;
    const notif = new Notification(title, { body, tag: quake.id });
    notif.onclick = () => {
      window.focus();
      notif.close();
    };
  } catch {
    /* Notification constructor can throw in some contexts (e.g. some mobile browsers) */
  }
}
