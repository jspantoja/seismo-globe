'use client';

import { useEffect } from 'react';

const SOURCES: { name: string; use: string; terms: string; url: string }[] = [
  {
    name: 'USGS Earthquake Hazards Program',
    use: 'Sismos del mundo en tiempo real y estadísticas históricas.',
    terms: 'Dominio público (gobierno de EE. UU.).',
    url: 'https://earthquake.usgs.gov',
  },
  {
    name: 'Servicio Geológico Colombiano (SGC) — no oficial',
    use: 'Sismos de Colombia (opcional, últimos 5 días).',
    terms:
      'Integración comunitaria no oficial de un feed público no documentado. Autorización de republicación: pendiente. Esta aplicación no está respaldada por el SGC.',
    url: 'https://www.sgc.gov.co/sismos',
  },
  {
    name: 'EMSC — reportes ciudadanos «¿lo sentiste?»',
    use: 'Cuántas personas reportaron sentir un sismo (opcional).',
    terms: 'CC BY 4.0, cite: EMSC. Preliminar; el número de reportes no mide daños.',
    url: 'https://www.seismicportal.eu/testimonies-ws/',
  },
  {
    name: 'EMSC — catálogo sísmico',
    use: 'Respaldo automático cuando el USGS no responde.',
    terms: 'Cite: EMSC. Datos preliminares.',
    url: 'https://www.seismicportal.eu/',
  },
  {
    name: 'Placas tectónicas — Bird (2003), modelo PB2002',
    use: 'Límites y polígonos de placas.',
    terms: 'Distribuido en github.com/fraxen/tectonicplates (consulte allí su licencia). Es un modelo de 2003.',
    url: 'https://github.com/fraxen/tectonicplates',
  },
  {
    name: 'Natural Earth (vía world-atlas y datasets/geo-ne-admin1)',
    use: 'Países y divisiones administrativas.',
    terms: 'Dominio público. Los límites son aproximados.',
    url: 'https://www.naturalearthdata.com',
  },
  {
    name: 'Códigos de país ISO 3166',
    use: 'Relacionar cada país con sus divisiones y su bandera.',
    terms: 'Tabla del repositorio lukes/ISO-3166-Countries-with-Regional-Codes.',
    url: 'https://github.com/lukes/ISO-3166-Countries-with-Regional-Codes',
  },
];

export default function SourcesModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="panel modal"
        role="dialog"
        aria-modal="true"
        aria-label="Fuentes y licencias"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 520 }}
      >
        <button className="btn modal__close" onClick={onClose} aria-label="Cerrar">
          ✕
        </button>
        <h2>Fuentes y licencias</h2>

        <div className="modal__sources" style={{ marginTop: 8, color: 'var(--accent-2)' }}>
          ⚠ Esta aplicación es independiente y <strong>no es un sistema oficial de alerta temprana</strong>. Los
          datos son preliminares, pueden tener retrasos o errores y no deben usarse para decisiones de seguridad.
          Ante un sismo, siga las indicaciones de su autoridad local de protección civil.
        </div>

        <ul style={{ listStyle: 'none', margin: '14px 0 0', padding: 0 }}>
          {SOURCES.map((s) => (
            <li key={s.name} style={{ padding: '9px 0', borderTop: '1px solid var(--panel-border)', fontSize: 13 }}>
              <div style={{ fontWeight: 600 }}>
                <a href={s.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                  {s.name} ↗
                </a>
              </div>
              <div style={{ color: 'var(--text-dim)', marginTop: 2 }}>{s.use}</div>
              <div style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 2 }}>{s.terms}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
