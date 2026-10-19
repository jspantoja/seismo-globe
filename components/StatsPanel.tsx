'use client';

import { useEffect, useMemo, useState } from 'react';
import { ColumnChart, HBars, SeriesTable, fmtInt, type SeriesKind } from './StatsCharts';
import { fetchStats, statsQueryString, sanitizeBbox, type Bbox } from '@/lib/statsClient';
import { formatDate, formatDateTime, formatReturnInterval, magColor } from '@/lib/format';
import type { StatsResponse } from '@/lib/types';

export interface StatsScope {
  kind: 'world' | 'country' | 'plate';
  label: string;
  bbox: Bbox | null;
  plateCode: string | null;
  countryId: string | null;
}

const YEAR_OPTIONS = [5, 10, 20, 30];
const MAG_OPTIONS = [2.5, 4.5, 5, 6];

const SERIES_META: Record<SeriesKind, { label: string; hint: string }> = {
  year: { label: 'Por año', hint: 'sismos por año calendario (UTC)' },
  month: { label: 'Por mes', hint: 'sismos por mes, últimos 24 meses' },
  day: { label: 'Por día', hint: 'sismos por día, últimos 30 días' },
};

interface LoadState {
  key: string | null;
  data: StatsResponse | null;
  error: string | null;
  loading: boolean;
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat-tile">
      <div className="stat-tile__label">{label}</div>
      <div className="stat-tile__value">{value}</div>
      {sub && <div className="stat-tile__sub">{sub}</div>}
    </div>
  );
}

export default function StatsPanel({ scope, onClose }: { scope: StatsScope; onClose: () => void }) {
  const [minMag, setMinMag] = useState(4.5);
  const [years, setYears] = useState(10);
  const [series, setSeries] = useState<SeriesKind>('year');
  const [tableView, setTableView] = useState(false);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<LoadState>({ key: null, data: null, error: null, loading: true });

  const bbox = useMemo(() => sanitizeBbox(scope.bbox), [scope.bbox]);
  const bboxKey = bbox ? bbox.join(',') : '';
  const request = useMemo(
    () => ({
      minMag,
      years,
      bbox: scope.plateCode || scope.countryId ? null : bbox,
      plateCode: scope.plateCode,
      countryId: scope.plateCode ? null : scope.countryId,
    }),
    // bboxKey stands in for the (value-equal but identity-unstable) bbox array
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [minMag, years, bboxKey, scope.plateCode, scope.countryId]
  );
  const key = statsQueryString(request);

  useEffect(() => {
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchStats(request, ctrl.signal)
      .then((data) => setState({ key, data, error: null, loading: false }))
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : 'No se pudieron cargar las estadísticas.',
        }));
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Never show numbers that belong to another scope/filter than the one selected.
  const data = state.key === key ? state.data : null;
  const bbNote =
    scope.kind === 'country'
      ? data?.offshoreKm
        ? `Cuenta los sismos dentro del territorio del país y los ocurridos en el mar a menos de ${data.offshoreKm} km de su costa (siempre para el país más cercano). Fronteras de Natural Earth 1:50m: simplificadas, con margen de unos kilómetros.`
        : scope.countryId
          ? 'Cuenta los sismos dentro del territorio del país y los ocurridos en el mar cerca de su costa.'
          : 'Este territorio no tiene un código de país estándar: la región es un rectángulo que lo rodea e incluye zonas vecinas y mar adyacente.'
      : scope.kind === 'plate'
        ? 'Solo eventos cuyo epicentro cae dentro del polígono de la placa (Bird, 2003).'
        : null;

  return (
    <aside className="panel stats-panel" aria-label="Estadísticas sísmicas">
      <div className="stats-panel__header">
        <div>
          <div className="stats-panel__title">📊 Estadísticas sísmicas</div>
          <div className="stats-panel__scope">{scope.label}</div>
        </div>
        <button className="btn" onClick={onClose} aria-label="Cerrar estadísticas">
          ✕
        </button>
      </div>

      <div className="stats-panel__controls">
        <div className="stats-panel__control">
          <span className="stats-panel__control-label">Período</span>
          <div className="seg">
            {YEAR_OPTIONS.map((y) => (
              <button key={y} className={`btn ${years === y ? 'active' : ''}`} onClick={() => setYears(y)}>
                {y} años
              </button>
            ))}
          </div>
        </div>
        <div className="stats-panel__control">
          <span className="stats-panel__control-label">Magnitud mínima</span>
          <div className="seg">
            {MAG_OPTIONS.map((m) => (
              <button key={m} className={`btn ${minMag === m ? 'active' : ''}`} onClick={() => setMinMag(m)}>
                M{m}+
              </button>
            ))}
          </div>
        </div>
        {minMag < 4.5 && (
          <div className="stats-note">
            El catálogo global del USGS solo es completo desde ~M4.5; por debajo las cifras subestiman la sismicidad real
            (sobre todo fuera de EE. UU.).
          </div>
        )}
      </div>

      {!data && state.loading && (
        <div className="stats-loading">
          <div className="spinner" />
          <div>Consultando el catálogo del USGS…</div>
          <div className="stats-loading__sub">La primera consulta de un filtro puede tardar unos segundos.</div>
        </div>
      )}

      {!data && state.error && !state.loading && (
        <div className="stats-error" role="alert">
          <div>{state.error}</div>
          <button className="btn active" onClick={() => setRetry((n) => n + 1)}>
            Reintentar
          </button>
        </div>
      )}

      {data && (
        <div className={state.loading ? 'stats-body stats-body--busy' : 'stats-body'}>
          {data.adjusted && (
            <div className="stats-note stats-note--warn">
              Para no superar el límite de 20.000 eventos por consulta del USGS, el umbral se subió de M
              {data.requestedMinMag} a <strong>M{data.minMag}+</strong>. Los datos de abajo corresponden a ese umbral.
            </div>
          )}

          <div className="stat-tiles">
            <Tile
              label={`Sismos M${data.minMag}+`}
              value={fmtInt(data.total)}
              sub={`${data.range.from} → ${data.range.to}`}
            />
            <Tile label="Promedio anual" value={fmtInt(Math.round(data.perYear))} sub="eventos por año" />
            <Tile
              label="Magnitud máxima"
              value={data.maxMag !== null ? `M${data.maxMag.toFixed(1)}` : '—'}
              sub={data.largest[0]?.place ?? undefined}
            />
            <Tile
              label="Últimos 12 meses"
              value={fmtInt(data.last12Months)}
              sub={
                data.vsAveragePct === null
                  ? undefined
                  : data.vsAveragePct === 0
                    ? 'igual al promedio'
                    : `${data.vsAveragePct > 0 ? '▲' : '▼'} ${Math.abs(data.vsAveragePct)} % ${
                        data.vsAveragePct > 0 ? 'sobre' : 'bajo'
                      } el promedio`
              }
            />
          </div>

          <section className="stats-section">
            <div className="stats-section__head">
              <h3>Frecuencia en el tiempo</h3>
              <button className="stats-link" onClick={() => setTableView((v) => !v)}>
                {tableView ? 'Ver gráfico' : 'Ver tabla'}
              </button>
            </div>
            <div className="seg seg--tabs" role="tablist">
              {(Object.keys(SERIES_META) as SeriesKind[]).map((k) => (
                <button
                  key={k}
                  role="tab"
                  aria-selected={series === k}
                  className={`btn ${series === k ? 'active' : ''}`}
                  onClick={() => setSeries(k)}
                >
                  {SERIES_META[k].label}
                </button>
              ))}
            </div>
            <div className="stats-section__hint">{SERIES_META[series].hint}</div>
            {tableView ? (
              <SeriesTable
                points={series === 'year' ? data.yearly : series === 'month' ? data.monthly : data.daily}
                kind={series}
              />
            ) : (
              <ColumnChart
                points={series === 'year' ? data.yearly : series === 'month' ? data.monthly : data.daily}
                kind={series}
                ariaLabel={`Sismos M${data.minMag}+ ${SERIES_META[series].hint}`}
              />
            )}
            {(series === 'year' ? data.yearly : series === 'month' ? data.monthly : data.daily).some((p) => p.partial) &&
              !tableView && <div className="stats-section__hint">La barra más clara es el período en curso (incompleto).</div>}
          </section>

          <section className="stats-section">
            <h3>Distribución por magnitud</h3>
            <HBars rows={data.magnitudeBins.map((b) => ({ label: `M${b.label}`, count: b.count }))} />
          </section>

          <section className="stats-section">
            <h3>Profundidad del foco</h3>
            <HBars rows={data.depthBins.map((b) => ({ label: b.label, count: b.count }))} />
            <div className="stats-section__hint">
              A igual magnitud, los sismos superficiales (&lt; 33 km) suelen sentirse con más fuerza y causar más daño.
            </div>
          </section>

          <section className="stats-section">
            <h3>Recurrencia histórica</h3>
            <table className="stats-table stats-table--plain">
              <thead>
                <tr>
                  <th>Umbral</th>
                  <th>Eventos</th>
                  <th>Por año</th>
                  <th>Intervalo medio</th>
                </tr>
              </thead>
              <tbody>
                {data.recurrence.map((r) => (
                  <tr key={r.minMag}>
                    <td>M{r.minMag}+</td>
                    <td>{fmtInt(r.count)}</td>
                    <td>{r.perYear.toLocaleString('es')}</td>
                    <td>{formatReturnInterval(r.returnYears)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="stats-section__hint">
              Promedios históricos del período elegido: describen qué tan seguido ocurre algo así, no predicen cuándo
              ocurrirá el próximo sismo.
            </div>
          </section>

          <section className="stats-section">
            <h3>Precisión de la localización</h3>
            <div className="stat-tiles stat-tiles--compact">
              <Tile
                label="Error horizontal mediano"
                value={data.precision.medianHorizontalErrorKm !== null ? `${data.precision.medianHorizontalErrorKm} km` : 'n/d'}
                sub={`informado en ${fmtInt(data.precision.withHorizontalError)} de ${fmtInt(data.precision.sample)}`}
              />
              <Tile
                label="Error de profundidad mediano"
                value={data.precision.medianDepthErrorKm !== null ? `${data.precision.medianDepthErrorKm} km` : 'n/d'}
                sub={`informado en ${fmtInt(data.precision.withDepthError)} de ${fmtInt(data.precision.sample)}`}
              />
              <Tile
                label="Error de magnitud mediano"
                value={data.precision.medianMagError !== null ? `±${data.precision.medianMagError}` : 'n/d'}
                sub={`informado en ${fmtInt(data.precision.withMagError)} de ${fmtInt(data.precision.sample)}`}
              />
              <Tile
                label="Revisados por analistas"
                value={data.precision.reviewedPct !== null ? `${data.precision.reviewedPct} %` : 'n/d'}
                sub="el resto es automático"
              />
            </div>
            <div className="stats-section__hint">
              El USGS no publica el error de cada evento; las medianas usan solo los que sí lo informan.
            </div>
          </section>

          <section className="stats-section">
            <h3>Mayores sismos del período</h3>
            <ol className="largest">
              {data.largest.map((q) => (
                <li key={q.id || `${q.time}-${q.lat}`}>
                  <span className="largest__mag" style={{ background: magColor(q.mag) }}>
                    {q.mag.toFixed(1)}
                  </span>
                  <span className="largest__body">
                    <span className="largest__place">{q.place ?? 'ubicación desconocida'}</span>
                    <span className="largest__meta">
                      {formatDate(q.time)}
                      {q.depthKm !== null ? ` · ${q.depthKm} km` : ''}
                    </span>
                  </span>
                  <a href={q.url} target="_blank" rel="noreferrer" className="largest__link" aria-label="Abrir en el USGS">
                    USGS ↗
                  </a>
                </li>
              ))}
            </ol>
          </section>

          <div className="stats-source">
            {bbNote && <div>{bbNote}</div>}
            <div>
              Fuente:{' '}
              <a href={data.source.url} target="_blank" rel="noreferrer">
                {data.source.name}
              </a>{' '}
              · {data.source.license} · consultado {formatDateTime(Date.parse(data.source.fetchedAt))}
            </div>
            <div>Fechas en UTC. Solo eventos clasificados como sismo (se excluyen explosiones y otros).</div>
          </div>
        </div>
      )}
    </aside>
  );
}
