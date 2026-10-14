'use client';

interface Props {
  name: string;
  code: string;
  englishName: string;
  major: boolean;
  quakeCount: number;
  maxMag: number | null;
  onOpenStats: () => void;
  onClose: () => void;
}

export default function PlatePanel({ name, code, englishName, major, quakeCount, maxMag, onOpenStats, onClose }: Props) {
  return (
    <div className="panel country-panel">
      <div className="country-panel__header">
        <div className="country-panel__title">🧭 Placa {name}</div>
        <button className="btn" onClick={onClose} aria-label="Quitar selección de placa">
          ✕
        </button>
      </div>

      <div className="country-panel__section">
        <div className="country-panel__label">Clasificación</div>
        <div className="country-panel__value">{major ? 'Placa principal' : 'Placa secundaria o microplaca'}</div>
        <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 2 }}>
          Código PB2002: {code}
          {englishName !== name ? ` · ${englishName}` : ''}
        </div>
      </div>

      <div className="country-panel__section">
        <div className="country-panel__label">Sismicidad (período seleccionado)</div>
        <div className="country-panel__value">
          {quakeCount} sismos dentro de la placa{maxMag !== null ? ` · máx. M${maxMag.toFixed(1)}` : ''}
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 2 }}>
          Fuente de límites:{' '}
          <a
            href="https://github.com/fraxen/tectonicplates"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--text-dim)' }}
          >
            PB2002 (Bird, 2003)
          </a>
        </div>
      </div>

      <button className="btn active country-panel__action" onClick={onOpenStats}>
        📊 Ver estadísticas de esta placa
      </button>
    </div>
  );
}
