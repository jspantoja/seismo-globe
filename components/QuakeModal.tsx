'use client';

import type { QuakeFeature } from '@/lib/types';
import { formatDateTime, formatRelative, magLabel } from '@/lib/format';

function magColor(mag: number | null): string {
  const m = mag ?? 0;
  if (m < 2) return '#4fd1c5';
  if (m < 4) return '#ecc94b';
  if (m < 5) return '#f6ad55';
  if (m < 6) return '#ed8936';
  if (m < 7) return '#f56565';
  return '#c53030';
}

export default function QuakeModal({ quake, onClose }: { quake: QuakeFeature; onClose: () => void }) {
  const isSgc = quake.source === 'SGC';
  const isEmsc = quake.source === 'EMSC';
  const isCatalog = quake.source === 'EMSC-CAT';
  const citizen = quake.citizen ?? null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="panel modal" onClick={(e) => e.stopPropagation()}>
        <button className="btn modal__close" onClick={onClose} aria-label="Cerrar">
          ✕
        </button>

        <div className="mag-badge" style={{ background: `${magColor(quake.mag)}22`, color: magColor(quake.mag) }}>
          M {magLabel(quake.mag)}
        </div>
        {isSgc && (
          <div
            style={{
              display: 'inline-block',
              marginLeft: 8,
              padding: '3px 8px',
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--accent-2)',
              background: 'rgba(246, 173, 85, 0.15)',
              verticalAlign: 'middle',
            }}
          >
            ⚠ FUENTE NO OFICIAL
          </div>
        )}
        {isEmsc && (
          <div
            style={{
              display: 'inline-block',
              marginLeft: 8,
              padding: '3px 8px',
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--accent-2)',
              background: 'rgba(246, 173, 85, 0.15)',
              verticalAlign: 'middle',
            }}
          >
            PRELIMINAR · REPORTES CIUDADANOS
          </div>
        )}
        {isCatalog && (
          <div
            style={{
              display: 'inline-block',
              marginLeft: 8,
              padding: '3px 8px',
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--accent-2)',
              background: 'rgba(246, 173, 85, 0.15)',
              verticalAlign: 'middle',
            }}
          >
            PRELIMINAR · FUENTE DE RESPALDO
          </div>
        )}
        <h2>{quake.place ?? 'Ubicación no especificada'}</h2>
        <div style={{ color: 'var(--text-dim)', fontSize: 12.5, marginBottom: 10 }}>
          {formatDateTime(quake.time)} · {formatRelative(quake.time)}
        </div>

        <div className="modal__row">
          <span>Profundidad</span>
          <span>{quake.depthKm !== null ? `${quake.depthKm.toFixed(1)} km` : 'sin dato'}</span>
        </div>
        <div className="modal__row">
          <span>Coordenadas</span>
          <span>
            {quake.lat.toFixed(3)}, {quake.lng.toFixed(3)}
          </span>
        </div>
        <div className="modal__row">
          <span>Tipo de magnitud</span>
          <span>{quake.magType ?? 'sin dato'}</span>
        </div>
        <div className="modal__row">
          <span>Estado</span>
          <span>{quake.status === 'reviewed' ? 'Revisado por sismólogos' : 'Automático (preliminar)'}</span>
        </div>
        {quake.intensity && (
          <div className="modal__row">
            <span>Intensidad</span>
            <span>{quake.intensity}</span>
          </div>
        )}
        {quake.source === 'USGS' && (
          <div className="modal__row">
            <span>Reportes "lo sentí" (USGS)</span>
            <span>{quake.felt !== null ? quake.felt : 'sin reportes aún'}</span>
          </div>
        )}
        {citizen && (
          <div className="modal__row">
            <span>Reportes ciudadanos (EMSC)</span>
            <span>
              {citizen.reports.toLocaleString('es')}{' '}
              <a href={citizen.url} target="_blank" rel="noreferrer">
                ver ↗
              </a>
            </span>
          </div>
        )}
        {quake.sig !== null && (
          <div className="modal__row">
            <span>Índice de significancia</span>
            <span>{quake.sig}</span>
          </div>
        )}

        {quake.tsunami === 1 && <div className="modal__tsunami">⚠ Alerta de posible tsunami asociada</div>}

        {isEmsc ? (
          <div className="modal__sources">
            Fuente: EMSC (Euro-Mediterranean Seismological Centre), testimonios «¿lo sentiste?» recogidos en
            emsc-csem.org y la app LastQuake. Datos bajo licencia CC BY 4.0. Magnitud, ubicación y hora son
            preliminares. <strong>El número de reportes no mide daños</strong>: depende de cuánta gente usa la
            app en esa zona.
            <br />
            <a href={quake.url} target="_blank" rel="noreferrer">
              Ver ficha del evento en el EMSC ↗
            </a>
          </div>
        ) : isCatalog ? (
          <div className="modal__sources">
            Fuente: EMSC (Euro-Mediterranean Seismological Centre), catálogo sísmico. Se muestra como{' '}
            <strong>respaldo</strong> porque el USGS no estaba respondiendo. Magnitud, ubicación y hora son
            preliminares y pueden diferir de las del USGS. Cite: EMSC.
            <br />
            <a href={quake.url} target="_blank" rel="noreferrer">
              Ver ficha del evento en el EMSC ↗
            </a>
            {citizen && (
              <>
                <br />
                Reportes ciudadanos: EMSC (CC BY 4.0), preliminares; el número de reportes no mide daños.
              </>
            )}
          </div>
        ) : isSgc ? (
          <div className="modal__sources">
            Fuente: Servicio Geológico Colombiano (SGC), Red Sismológica Nacional de Colombia. Estado:{' '}
            {quake.status === 'reviewed' ? 'manual (revisado)' : 'automático (preliminar)'}.
            <br />
            <strong>Integración comunitaria no oficial</strong> — esta aplicación es independiente, no usa el
            logo del SGC y no cuenta con respaldo institucional confirmado. Autorización de republicación:
            pendiente de solicitud.
            <br />
            <a href="https://www.sgc.gov.co/sismos" target="_blank" rel="noreferrer">
              Ver portal oficial del SGC ↗
            </a>
            {citizen && (
              <>
                <br />
                Reportes ciudadanos: EMSC (CC BY 4.0), preliminares; el número de reportes no mide daños.
              </>
            )}
          </div>
        ) : (
          <div className="modal__sources">
            Fuente: USGS Earthquake Hazards Program (dominio público).
            <br />
            <a href={quake.url} target="_blank" rel="noreferrer">
              Ver ficha oficial del evento ↗
            </a>
            {citizen && (
              <>
                <br />
                Reportes ciudadanos: EMSC (CC BY 4.0), preliminares; el número de reportes no mide daños.
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
