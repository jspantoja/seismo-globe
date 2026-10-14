import type { QuakeFeature } from './types';
import { magLabel, sourceLabel } from './format';

const STORAGE_KEY = 'seismo-globe:alert-settings:v1';

export interface AlertSettings {
  enabled: boolean;
  countryIds: string[]; // world-atlas numeric ids, e.g. "170" for Colombia
  browserNotifications: boolean;
}

const DEFAULT_SETTINGS: AlertSettings = {
  enabled: false,
  countryIds: [],
  browserNotifications: false,
};

export function loadAlertSettings(): AlertSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      enabled: !!parsed.enabled,
      countryIds: Array.isArray(parsed.countryIds) ? parsed.countryIds.map(String) : [],
      browserNotifications: !!parsed.browserNotifications,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveAlertSettings(settings: AlertSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* localStorage unavailable (private mode, quota, etc.) — alerts just won't persist */
  }
}

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
