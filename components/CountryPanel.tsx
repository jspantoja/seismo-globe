'use client';

interface Props {
  name: string;
  flag: string;
  plates: string[] | null; // null = still computing
  subdivisionsLoading: boolean;
  subdivisionsCount: number;
  subdivisionsUnavailable: boolean;
  quakeCount: number;
  maxMag: number | null;
  onOpenStats: () => void;
  onClose: () => void;
}

export default function CountryPanel({
  name,
  flag,
  plates,
  subdivisionsLoading,
  subdivisionsCount,
  subdivisionsUnavailable,
  quakeCount,
  maxMag,
  onOpenStats,
  onClose,
}: Props) {
  return (
    <div className="panel country-panel">
      <div className="country-panel__header">
        <div className="country-panel__title">
          {flag} {name}
        </div>
        <button className="btn" onClick={onClose} aria-label="Quitar selección">
          ✕
        </button>
      </div>

      <div className="country-panel__section">
        <div className="country-panel__label">División política</div>
        {subdivisionsLoading ? (
          <div className="country-panel__value">Cargando…</div>
        ) : subdivisionsUnavailable ? (
          <div className="country-panel__value" style={{ color: 'var(--text-dim)' }}>
            No disponible para este país
          </div>
        ) : (
          <>
            <div className="country-panel__value">{subdivisionsCount} divisiones administrativas</div>
            <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 2 }}>
              Fuente:{' '}
              <a
                href="https://github.com/datasets/geo-ne-admin1"
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--text-dim)' }}
              >
                Natural Earth (admin-1)
              </a>
            </div>
          </>
        )}
      </div>

      <div className="country-panel__section">
        <div className="country-panel__label">Placas y microplacas</div>
        {plates === null ? (
          <div className="country-panel__value">Calculando…</div>
        ) : plates.length === 0 ? (
          <div className="country-panel__value" style={{ color: 'var(--text-dim)' }}>
            No se detectó intersección
          </div>
        ) : (
          <div className="country-panel__chips">
            {plates.map((p) => (
              <span key={p} className="country-panel__chip">
                {p}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="country-panel__section">
        <div className="country-panel__label">Sismicidad (período seleccionado)</div>
        <div className="country-panel__value">
          {quakeCount} sismos{maxMag !== null ? ` · máx. M${maxMag.toFixed(1)}` : ''}
        </div>
      </div>

      <button className="btn active country-panel__action" onClick={onOpenStats}>
        📊 Ver estadísticas históricas
      </button>
    </div>
  );
}
