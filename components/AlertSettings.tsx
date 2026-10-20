'use client';

import { useMemo, useState } from 'react';
import {
  ALERT_MAG_OPTIONS,
  QUIET_EXCEPT_OPTIONS,
  describeAlertRule,
  isQuietNow,
  magOptionLabel,
  minutesToTime,
  timeToMinutes,
  type AlertSettings,
} from '@/lib/alerts';

interface Props {
  settings: AlertSettings;
  countryList: { id: string; name: string }[];
  notificationPermission: NotificationPermission | 'unsupported';
  onChange: (next: AlertSettings) => void;
  onRequestPermission: () => void;
  onClose: () => void;
}

const FOLLOW_GLOBAL = 'global';

export default function AlertSettings({
  settings,
  countryList,
  notificationPermission,
  onChange,
  onRequestPermission,
  onClose,
}: Props) {
  const [filter, setFilter] = useState('');

  // Countries already watched when the panel opens come first, so they are easy to review.
  // The order is fixed for the life of the panel: ticking a box never makes rows jump.
  const [pinned] = useState(() => new Set(settings.countryIds));

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matches = q ? countryList.filter((c) => c.name.toLowerCase().includes(q)) : countryList;
    return [...matches.filter((c) => pinned.has(c.id)), ...matches.filter((c) => !pinned.has(c.id))];
  }, [filter, countryList, pinned]);

  const names = useMemo(() => Object.fromEntries(countryList.map((c) => [c.id, c.name])), [countryList]);

  const toggleCountry = (id: string) => {
    const has = settings.countryIds.includes(id);
    onChange({
      ...settings,
      countryIds: has ? settings.countryIds.filter((c) => c !== id) : [...settings.countryIds, id],
    });
  };

  const setCountryMag = (id: string, value: string) => {
    const next = { ...settings.countryMinMag };
    if (value === FOLLOW_GLOBAL) delete next[id];
    else next[id] = Number(value);
    onChange({ ...settings, countryMinMag: next });
  };

  const setQuiet = (patch: Partial<AlertSettings['quiet']>) => onChange({ ...settings, quiet: { ...settings.quiet, ...patch } });

  const setTime = (key: 'from' | 'to', text: string) => {
    const minutes = timeToMinutes(text);
    if (minutes !== null) setQuiet({ [key]: minutes });
  };

  const watchedCount = settings.countryIds.length;
  const quietNow = isQuietNow(settings.quiet, new Date());
  const emptyWindow = settings.quiet.enabled && settings.quiet.from === settings.quiet.to;

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

      <div className="alert-settings__label">Magnitud mínima</div>
      <div className="alert-settings__inline">
        <select
          className="alert-settings__select"
          aria-label="Magnitud mínima para avisar"
          value={settings.minMag}
          onChange={(e) => onChange({ ...settings, minMag: Number(e.target.value) })}
        >
          {ALERT_MAG_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {magOptionLabel(m)}
            </option>
          ))}
        </select>
        <span className="alert-settings__hint">en todo lo que vigiles; puedes afinarla por país</span>
      </div>

      <div className="alert-settings__label">Horario sin avisos</div>
      <label className="alert-settings__row">
        <input type="checkbox" checked={settings.quiet.enabled} onChange={(e) => setQuiet({ enabled: e.target.checked })} />
        Silenciar avisos en este horario
        {quietNow && <span className="alert-settings__badge">ahora</span>}
      </label>
      {settings.quiet.enabled && (
        <div className="alert-settings__quiet">
          <label>
            Desde
            <input
              type="time"
              className="alert-settings__select"
              value={minutesToTime(settings.quiet.from)}
              onChange={(e) => setTime('from', e.target.value)}
            />
          </label>
          <label>
            Hasta
            <input
              type="time"
              className="alert-settings__select"
              value={minutesToTime(settings.quiet.to)}
              onChange={(e) => setTime('to', e.target.value)}
            />
          </label>
          <label className="alert-settings__quiet-wide">
            Avisar igual si es
            <select
              className="alert-settings__select"
              value={settings.quiet.exceptMag}
              onChange={(e) => setQuiet({ exceptMag: Number(e.target.value) })}
            >
              {QUIET_EXCEPT_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? 'Nunca' : `M${m} o más`}
                </option>
              ))}
            </select>
          </label>
          {emptyWindow && <div className="alert-settings__hint">«Desde» y «Hasta» coinciden: no se silencia nada.</div>}
          <div className="alert-settings__hint">
            Hora de este dispositivo. Los sismos siguen apareciendo en el globo; solo se silencian el aviso y la
            notificación.
          </div>
        </div>
      )}

      <div className="alert-settings__label">
        Países a vigilar{watchedCount > 0 ? ` (${watchedCount})` : ' (todos si no eliges ninguno)'}
      </div>
      <input
        className="alert-settings__search"
        placeholder="Buscar país…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="alert-settings__list">
        {filtered.map((c) => {
          const watched = settings.countryIds.includes(c.id);
          const own = Object.prototype.hasOwnProperty.call(settings.countryMinMag, c.id) ? settings.countryMinMag[c.id] : null;
          return (
            <div key={c.id} className="alert-settings__country">
              <label className="alert-settings__row alert-settings__row--compact">
                <input type="checkbox" checked={watched} onChange={() => toggleCountry(c.id)} />
                {c.name}
              </label>
              {watched && (
                <select
                  className="alert-settings__select alert-settings__select--small"
                  aria-label={`Magnitud mínima en ${c.name}`}
                  value={own === null ? FOLLOW_GLOBAL : String(own)}
                  onChange={(e) => setCountryMag(c.id, e.target.value)}
                >
                  <option value={FOLLOW_GLOBAL}>Global</option>
                  {ALERT_MAG_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {magOptionLabel(m)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div style={{ color: 'var(--text-dim)', fontSize: 12.5, padding: '6px 0' }}>Sin resultados</div>
        )}
      </div>

      <div className="alert-settings__summary">{describeAlertRule(settings, names)}</div>
      <div className="alert-settings__hint">
        Un sismo cuenta como de un país si ocurre en su territorio o, en el mar, a 200 km o menos de su costa. Con
        varios sismos a la vez, se avisa del de mayor magnitud. Las alertas funcionan mientras esta pestaña esté abierta.
      </div>
    </div>
  );
}
