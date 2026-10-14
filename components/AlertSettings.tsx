'use client';

import { useMemo, useState } from 'react';
import type { AlertSettings } from '@/lib/alerts';

interface Props {
  settings: AlertSettings;
  countryList: { id: string; name: string }[];
  notificationPermission: NotificationPermission | 'unsupported';
  onChange: (next: AlertSettings) => void;
  onRequestPermission: () => void;
  onClose: () => void;
}

export default function AlertSettings({
  settings,
  countryList,
  notificationPermission,
  onChange,
  onRequestPermission,
  onClose,
}: Props) {
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return countryList;
    return countryList.filter((c) => c.name.toLowerCase().includes(q));
  }, [filter, countryList]);

  const toggleCountry = (id: string) => {
    const has = settings.countryIds.includes(id);
    onChange({
      ...settings,
      countryIds: has ? settings.countryIds.filter((c) => c !== id) : [...settings.countryIds, id],
    });
  };

  const watchedNames = countryList.filter((c) => settings.countryIds.includes(c.id)).map((c) => c.name);

  return (
    <div className="panel alert-settings">
      <div className="alert-settings__header">
        <div className="country-panel__title">🔔 Alertas en tiempo real</div>
        <button className="btn" onClick={onClose} aria-label="Cerrar">
          ✕
        </button>
      </div>

      <label className="alert-settings__row">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => onChange({ ...settings, enabled: e.target.checked })}
        />
        Activar alertas de sismos nuevos
      </label>

      <label className="alert-settings__row">
        <input
          type="checkbox"
          checked={settings.browserNotifications}
          disabled={notificationPermission === 'unsupported'}
          onChange={(e) => {
            onChange({ ...settings, browserNotifications: e.target.checked });
            if (e.target.checked && notificationPermission === 'default') onRequestPermission();
          }}
        />
        Notificaciones del navegador
        {notificationPermission === 'denied' && (
          <span style={{ color: 'var(--danger)', fontSize: 11 }}> (bloqueadas por el navegador)</span>
        )}
        {notificationPermission === 'unsupported' && (
          <span style={{ color: 'var(--text-dim)', fontSize: 11 }}> (no soportado aquí)</span>
        )}
      </label>

      <div className="alert-settings__label">
        Países a vigilar{watchedNames.length > 0 ? ` (${watchedNames.length})` : ' (todos si no eliges ninguno)'}
      </div>
      <input
        className="alert-settings__search"
        placeholder="Buscar país…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="alert-settings__list">
        {filtered.map((c) => (
          <label key={c.id} className="alert-settings__row alert-settings__row--compact">
            <input
              type="checkbox"
              checked={settings.countryIds.includes(c.id)}
              onChange={() => toggleCountry(c.id)}
            />
            {c.name}
          </label>
        ))}
        {filtered.length === 0 && (
          <div style={{ color: 'var(--text-dim)', fontSize: 12.5, padding: '6px 0' }}>Sin resultados</div>
        )}
      </div>
    </div>
  );
}
