const dtf = new Intl.DateTimeFormat('es', {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

export function formatDateTime(ms: number): string {
  return dtf.format(new Date(ms));
}

export function formatRelative(ms: number): string {
  const diffSec = Math.round((Date.now() - ms) / 1000);
  if (diffSec < 5) return 'justo ahora';
  if (diffSec < 60) return `hace ${diffSec} s`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `hace ${diffHr} h`;
  const diffDay = Math.round(diffHr / 24);
  return `hace ${diffDay} d`;
}

export function magLabel(mag: number | null): string {
  return mag === null ? 's/d' : mag.toFixed(1);
}

/** Same magnitude → colour scale as the globe points and the legend. */
export function magColor(mag: number | null): string {
  const m = mag ?? 0;
  if (m < 2) return '#4fd1c5';
  if (m < 4) return '#ecc94b';
  if (m < 5) return '#f6ad55';
  if (m < 6) return '#ed8936';
  if (m < 7) return '#f56565';
  return '#c53030';
}

/** Short, human label of where a quake came from — shown wherever an event is. */
export function sourceLabel(source: string): string {
  switch (source) {
    case 'USGS':
      return 'USGS';
    case 'SGC':
      return 'SGC, no oficial';
    case 'EMSC':
      return 'EMSC, reportes ciudadanos';
    case 'EMSC-CAT':
      return 'EMSC, respaldo';
    default:
      return source;
  }
}

const dateOnly = new Intl.DateTimeFormat('es', { dateStyle: 'medium' });
export function formatDate(ms: number): string {
  return dateOnly.format(new Date(ms));
}

/** "cada 3 meses", "cada 12 días", "cada 4,5 años" — average interval between events. */
export function formatReturnInterval(years: number | null): string {
  if (years === null) return 'sin eventos';
  if (years >= 1) {
    const y = +years.toFixed(years >= 10 ? 0 : 1);
    return `cada ${String(y).replace('.', ',')} ${y === 1 ? 'año' : 'años'}`;
  }
  const days = years * 365.25;
  if (days >= 45) return `cada ${Math.round(days / 30.44)} meses`;
  if (days >= 2) return `cada ${Math.round(days)} días`;
  return `cada ${Math.max(1, Math.round(days * 24))} h`;
}
