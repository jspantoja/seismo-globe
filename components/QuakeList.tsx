'use client';

import { useMemo, useState } from 'react';
import type { QuakeFeature } from '@/lib/types';
import { formatRelative, magColor, magLabel, sourceLabel } from '@/lib/format';

type SortKey = 'time' | 'mag' | 'depth';

const SORT_LABEL: Record<SortKey, string> = {
  time: 'Más recientes',
  mag: 'Mayor magnitud',
  depth: 'Más profundos',
};

const PAGE = 100;

/** Lower-case without accents, so "Bogota" finds "Bogotá". */
function plain(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Descending by `value`; events without the value go last. */
function byDesc(value: (q: QuakeFeature) => number | null) {
  return (a: QuakeFeature, b: QuakeFeature) => (value(b) ?? -Infinity) - (value(a) ?? -Infinity);
}

const SORTERS: Record<SortKey, (a: QuakeFeature, b: QuakeFeature) => number> = {
  time: byDesc((q) => q.time),
  mag: byDesc((q) => q.mag),
  depth: byDesc((q) => q.depthKm),
};

export default function QuakeList({
  quakes,
  scopeLabel,
  linkCopied,
  onSelect,
  onCopyLink,
  onClose,
}: {
  quakes: QuakeFeature[];
  scopeLabel: string;
  linkCopied: boolean;
  onSelect: (q: QuakeFeature) => void;
  onCopyLink: () => void;
  onClose: () => void;
}) {
  const [sort, setSort] = useState<SortKey>('time');
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);

  const rows = useMemo(() => {
    const needle = plain(search.trim());
    const filtered = needle ? quakes.filter((q) => plain(q.place ?? '').includes(needle)) : quakes;
    return [...filtered].sort(SORTERS[sort]);
  }, [quakes, search, sort]);

  const visible = rows.slice(0, shown);

  return (
    <div className="panel quake-list" role="region" aria-label="Lista de sismos">
      <div className="quake-list__header">
        <div>
          <div className="stats-panel__title">📋 Sismos</div>
          <div className="stats-panel__scope">{scopeLabel}</div>
        </div>
        <button className="btn" onClick={onClose} aria-label="Cerrar la lista">
          ✕
        </button>
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

      <input
        className="quake-list__search"
        type="search"
        placeholder="Buscar por lugar…"
        aria-label="Buscar por lugar"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setShown(PAGE);
        }}
      />

      <div className="quake-list__count">
        {rows.length === quakes.length
          ? `${rows.length.toLocaleString('es')} sismos`
          : `${rows.length.toLocaleString('es')} de ${quakes.length.toLocaleString('es')} sismos`}
      </div>

      {visible.length === 0 ? (
        <div className="stats-note">
          {quakes.length === 0 ? 'No hay sismos con estos filtros.' : 'Ningún sismo coincide con la búsqueda.'}
        </div>
      ) : (
        <ul className="quake-list__rows">
          {visible.map((q) => {
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
                      {formatRelative(q.time)}
                      {q.depthKm !== null ? ` · prof. ${Math.round(q.depthKm)} km` : ''}
                      {q.source !== 'USGS' ? ` · ${sourceLabel(q.source)}` : ''}
                      {q.citizen ? ` · 👥 ${q.citizen.reports.toLocaleString('es')}` : ''}
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

      <button className="btn quake-list__share" onClick={onCopyLink}>
        {linkCopied ? '✓ Enlace copiado' : '🔗 Copiar enlace de esta vista'}
      </button>
    </div>
  );
}
