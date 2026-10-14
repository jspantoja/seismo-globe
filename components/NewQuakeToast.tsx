'use client';

import type { QuakeFeature } from '@/lib/types';
import { formatRelative, magLabel, sourceLabel } from '@/lib/format';

export default function NewQuakeToast({
  quake,
  onClick,
  onLocate,
  isAlert,
  style,
}: {
  quake: QuakeFeature;
  onClick: () => void;
  onLocate?: () => void;
  isAlert?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <div className={`panel toast ${isAlert ? 'toast--alert' : ''}`} onClick={onClick} role="alert" style={style}>
      <div className="toast__title">{isAlert ? '🔔 Alerta: sismo en país vigilado' : '▲ Nuevo sismo detectado'}</div>
      <div className="toast__body">
        M {magLabel(quake.mag)} — {quake.place ?? 'ubicación desconocida'}
      </div>
      <div className="toast__meta">
        {formatRelative(quake.time)} · fuente: {sourceLabel(quake.source)} · toca para ver detalles
      </div>
      {onLocate && (
        <button
          className="toast__locate"
          onClick={(e) => {
            e.stopPropagation();
            onLocate();
          }}
        >
          📍 Ver en el globo
        </button>
      )}
    </div>
  );
}
