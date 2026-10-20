'use client';

import { useMemo, useState } from 'react';
import { formatRelative, magColor, magLabel, sourceLabel } from '@/lib/format';
import { RADIUS_OPTIONS, parseCoordinate, type LatLng, type NearbyQuake } from '@/lib/nearby';
import type { QuakeFeature } from '@/lib/types';

type SortKey = 'distance' | 'time' | 'mag';

const SORT_LABEL: Record<SortKey, string> = {
  distance: 'Más cercanos',
  time: 'Más recientes',
  mag: 'Mayor magnitud',
};

const PAGE = 100;

export interface NearCenter extends LatLng {
  source: 'gps' | 'manual';
}

/** "a 21 km al N", or "a menos de 1 km" when the quake is at the point itself (a direction means nothing there). */
function offsetText(distanceKm: number, direction: string): string {
  return distanceKm < 1 ? 'a menos de 1 km' : `a ${Math.round(distanceKm)} km al ${direction}`;
}

function sorted(items: NearbyQuake[], key: SortKey): NearbyQuake[] {
  const copy = [...items];
  if (key === 'time') return copy.sort((a, b) => b.quake.time - a.quake.time);
  if (key === 'mag') return copy.sort((a, b) => (b.quake.mag ?? -Infinity) - (a.quake.mag ?? -Infinity));
  return copy; // already nearest first
}

export default function NearbyPanel({
  center,
  locating,
  error,
  radiusKm,
  items,
  periodLabel,
  onRadius,
  onLocate,
  onManual,
  onSelect,
  onClose,
}: {
  center: NearCenter | null;
  locating: boolean;
  error: string | null;
  radiusKm: number;
  items: NearbyQuake[];
  periodLabel: string;
  onRadius: (km: number) => void;
  onLocate: () => void;
  onManual: (point: LatLng) => void;
  onSelect: (q: QuakeFeature) => void;
  onClose: () => void;
}) {
  const [sort, setSort] = useState<SortKey>('distance');
  const [shown, setShown] = useState(PAGE);
  const [typing, setTyping] = useState(false);
  const [latText, setLatText] = useState('');
  const [lngText, setLngText] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const rows = useMemo(() => sorted(items, sort), [items, sort]);
  const visible = rows.slice(0, shown);
  const nearest = items[0] ?? null;
  const showForm = typing || (!!error && !center);

  const submitManual = () => {
    const lat = parseCoordinate(latText, 'lat');
    const lng = parseCoordinate(lngText, 'lng');
    if (lat === null || lng === null) {
      setFormError('Escribe una latitud entre −90 y 90 y una longitud entre −180 y 180 (por ejemplo 4.71 y −74.07).');
      return;
    }
    setFormError(null);
    setTyping(false);
    onManual({ lat, lng });
  };

  return (
    <div className="panel quake-list near-panel" role="region" aria-label="Sismos cerca de mí">
      <div className="quake-list__header">
        <div>
          <div className="stats-panel__title">📍 Cerca de mí</div>
          <div className="stats-panel__scope">
            {center
              ? `${center.source === 'gps' ? 'Tu ubicación aproximada' : 'Punto elegido'} · ${center.lat.toFixed(2)}, ${center.lng.toFixed(2)}`
              : locating
                ? 'Buscando tu ubicación…'
                : 'Sin ubicación todavía'}
          </div>
        </div>
        <button className="btn" onClick={onClose} aria-label="Cerrar sismos cerca de mí">
          ✕
        </button>
      </div>

      {locating && (
        <div className="near-panel__status" role="status">
          <div className="spinner" /> El navegador te pedirá permiso para usar tu ubicación.
        </div>
      )}

      {error && !locating && (
        <div className="stats-note stats-note--warn" role="alert">
          {error}
        </div>
      )}

      <div className="near-panel__actions">
        <button className="btn" onClick={onLocate} disabled={locating}>
          {center?.source === 'gps' ? '↻ Actualizar mi ubicación' : '📍 Usar mi ubicación'}
        </button>
        <button className="btn" onClick={() => setTyping((v) => !v)} aria-expanded={showForm}>
          ✎ Escribir coordenadas
        </button>
      </div>

      {showForm && (
        <form
          className="near-panel__form"
          onSubmit={(e) => {
            e.preventDefault();
            submitManual();
          }}
        >
          <label>
            Latitud
            <input
              className="quake-list__search"
              inputMode="decimal"
              placeholder="4.71"
              value={latText}
              onChange={(e) => setLatText(e.target.value)}
              aria-label="Latitud"
            />
          </label>
          <label>
            Longitud
            <input
              className="quake-list__search"
              inputMode="decimal"
              placeholder="-74.07"
              value={lngText}
              onChange={(e) => setLngText(e.target.value)}
              aria-label="Longitud"
            />
          </label>
          <button className="btn active" type="submit">
            Usar este punto
          </button>
          {formError && (
            <div className="near-panel__form-error" role="alert">
              {formError}
            </div>
          )}
        </form>
      )}

      {center && (
        <>
          <div className="seg" role="group" aria-label="Radio de búsqueda">
            {RADIUS_OPTIONS.map((km) => (
              <button
                key={km}
                className={`btn ${radiusKm === km ? 'active' : ''}`}
                aria-pressed={radiusKm === km}
                onClick={() => {
                  onRadius(km);
                  setShown(PAGE);
                }}
              >
                {km} km
              </button>
            ))}
          </div>

          <div className="seg" role="group" aria-label="Ordenar por">
            {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
              <button
                key={k}
                className={`btn ${sort === k ? 'active' : ''}`}
                aria-pressed={sort === k}
                onClick={() => {
                  setSort(k);
                  setShown(PAGE);
                }}
              >
                {SORT_LABEL[k]}
              </button>
            ))}
          </div>

          <div className="quake-list__count">
            {items.length === 0
              ? `Ningún sismo a menos de ${radiusKm} km · ${periodLabel}`
              : `${items.length.toLocaleString('es')} ${items.length === 1 ? 'sismo' : 'sismos'} a menos de ${radiusKm} km · ${periodLabel}`}
          </div>
          {nearest && (
            <div className="near-panel__nearest">
              Más cercano: M {magLabel(nearest.quake.mag)} {offsetText(nearest.distanceKm, nearest.direction)}
            </div>
          )}

          {items.length === 0 ? (
            <div className="stats-note">
              No hay sismos registrados en esta zona con los filtros actuales. Prueba con un radio mayor, con «Última
              semana» o «Último mes», o baja la magnitud mínima. Que no haya sismos aquí no significa que no pueda
              haberlos.
            </div>
          ) : (
            <ul className="quake-list__rows">
              {visible.map(({ quake: q, distanceKm: d, direction }) => {
                const color = magColor(q.mag);
                return (
                  <li key={q.id}>
                    <button className="quake-list__row" onClick={() => onSelect(q)}>
                      <span className="quake-list__mag" style={{ background: `${color}22`, color }}>
                        {magLabel(q.mag)}
                      </span>
                      <span className="quake-list__main">
                        <span className="quake-list__place">{q.place ?? 'Ubicación no especificada'}</span>
                        <span className="quake-list__meta">
                          {offsetText(d, direction)} · {formatRelative(q.time)}
                          {q.depthKm !== null ? ` · prof. ${Math.round(q.depthKm)} km` : ''}
                          {q.source !== 'USGS' ? ` · ${sourceLabel(q.source)}` : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {rows.length > visible.length && (
            <button className="btn quake-list__more" onClick={() => setShown((n) => n + PAGE)}>
              Mostrar {Math.min(PAGE, rows.length - visible.length)} más
            </button>
          )}
        </>
      )}

      <div className="near-panel__privacy">
        Tu ubicación se usa solo en este navegador: no se envía a ningún servidor, no se guarda y no va en los enlaces
        que compartes. Esta aplicación no es un sistema oficial de alerta temprana.
      </div>
    </div>
  );
}
