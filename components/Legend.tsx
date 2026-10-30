'use client';

import { useState } from 'react';

const SCALE: [string, string][] = [
  ['#4fd1c5', '< 2'],
  ['#ecc94b', '2–3.9'],
  ['#f6ad55', '4–4.9'],
  ['#ed8936', '5–5.9'],
  ['#f56565', '6–6.9'],
  ['#c53030', '7+'],
];

export default function Legend({
  quakeCount,
  sourceFetchedAt,
  sgcEnabled,
  emscEnabled,
  onOpenSources,
}: {
  quakeCount: number;
  sourceFetchedAt: string | null;
  sgcEnabled: boolean;
  emscEnabled: boolean;
  onOpenSources: () => void;
}) {
  // On a phone the legend would cover a third of the globe: the scale and the "not official" notice stay,
  // the rest folds away behind a button (CSS shows everything on wider screens). The notices about the
  // optional sources stay visible while those sources are on.
  const [open, setOpen] = useState(false);
  const notices = sgcEnabled || emscEnabled;
  return (
    <div className={`panel legend ${open || notices ? 'legend--open' : ''}`}>
      <div className="legend__head">
        <span style={{ fontWeight: 700, fontSize: 12.5, color: 'var(--text)' }}>Magnitud (Richter/Mw)</span>
        <button type="button" className="legend__toggle" aria-expanded={open || notices} onClick={() => setOpen((v) => !v)} disabled={notices}>
          {open || notices ? 'Menos ▴' : 'Más ▾'}
        </button>
      </div>
      <div className="legend__scale">
        {SCALE.map(([color, label]) => (
          <span key={label} className="legend__chip">
            <span className="legend__dot" style={{ background: color }} />
            {label}
          </span>
        ))}
      </div>
      <div className="legend__scale legend__extra">
        <span className="legend__chip">
          <span style={{ width: 14, height: 2, background: '#ff8a3d', display: 'inline-block' }} />
          Límite de subducción
        </span>
        <span className="legend__chip">
          <span style={{ width: 14, height: 2, background: '#7dd3fc', display: 'inline-block' }} />
          Otro límite de placa
        </span>
      </div>
      <div className="legend__sources legend__extra">
        Mostrando {quakeCount} sismos{sourceFetchedAt ? ` · actualizado ${new Date(sourceFetchedAt).toLocaleTimeString('es')}` : ''}
        <br />
        Sismos:{' '}
        <a href="https://earthquake.usgs.gov" target="_blank" rel="noreferrer">
          USGS
        </a>{' '}
        (dominio público) · Placas:{' '}
        <a href="https://github.com/fraxen/tectonicplates" target="_blank" rel="noreferrer">
          Bird 2003 / PB2002
        </a>{' '}
        · Países:{' '}
        <a href="https://github.com/topojson/world-atlas" target="_blank" rel="noreferrer">
          world-atlas
        </a>{' '}
        (datos Natural Earth)
      </div>
      {sgcEnabled && (
        <div className="legend__sources" style={{ marginTop: 6, color: 'var(--accent-2)' }}>
          ⚠ Colombia (SGC): integración comunitaria <strong>no oficial</strong> de un feed público no
          documentado de{' '}
          <a href="https://www.sgc.gov.co/sismos" target="_blank" rel="noreferrer">
            sgc.gov.co
          </a>
          . Autorización de republicación: pendiente de solicitud. Cobertura: últimos 5 días. Esta app no
          está respaldada por el SGC.
        </div>
      )}
      {emscEnabled && (
        <div className="legend__sources" style={{ marginTop: 6 }}>
          👥 Reportes ciudadanos:{' '}
          <a href="https://www.seismicportal.eu/testimonies-ws/" target="_blank" rel="noreferrer">
            EMSC
          </a>{' '}
          (CC BY 4.0). Datos preliminares; el número de testimonios no mide daños. Los eventos sin
          equivalente en USGS/SGC aparecen como «EMSC».
        </div>
      )}
      <div
        className="legend__sources"
        style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--panel-border)' }}
      >
        ⚠ No es un sistema oficial de alerta temprana: datos preliminares, con posibles retrasos o errores.{' '}
        <button className="stats-link" onClick={onOpenSources}>
          Fuentes y licencias
        </button>
      </div>
    </div>
  );
}
