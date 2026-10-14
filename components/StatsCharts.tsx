'use client';

import { useMemo, useState } from 'react';
import type { StatsPoint } from '@/lib/types';

const nf = new Intl.NumberFormat('es');
export const fmtInt = (n: number) => nf.format(n);

const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTHS_LONG = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

export type SeriesKind = 'year' | 'month' | 'day';

function compact(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}K`;
  return String(n);
}

/** Round y-axis ticks to clean numbers (1 / 2 / 5 × 10^k). */
export function niceTicks(max: number, target = 4): { ticks: number[]; top: number } {
  if (!(max > 0)) return { ticks: [0, 1], top: 1 };
  const rough = max / target;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / pow;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * pow;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 1000; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { ticks, top };
}

function shortLabel(kind: SeriesKind, key: string): string {
  if (kind === 'year') return key;
  if (kind === 'month') {
    const [y, m] = key.split('-');
    return `${MONTHS_SHORT[Number(m) - 1]} ${y.slice(2)}`;
  }
  const [, m, d] = key.split('-');
  return `${Number(d)} ${MONTHS_SHORT[Number(m) - 1]}`;
}

export function longLabel(kind: SeriesKind, key: string): string {
  if (kind === 'year') return key;
  if (kind === 'month') {
    const [y, m] = key.split('-');
    return `${MONTHS_LONG[Number(m) - 1]} de ${y}`;
  }
  const [y, m, d] = key.split('-');
  return `${Number(d)} de ${MONTHS_LONG[Number(m) - 1]} de ${y}`;
}

/** 4px rounded data-end, square at the baseline. */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

const W = 420;
const H = 176;
const ML = 34;
const MR = 6;
const MT = 14;
const MB = 22;

export function ColumnChart({ points, kind, ariaLabel }: { points: StatsPoint[]; kind: SeriesKind; ariaLabel: string }) {
  const [active, setActive] = useState<number | null>(null);

  const geo = useMemo(() => {
    const max = points.reduce((m, p) => Math.max(m, p.count), 0);
    const { ticks, top } = niceTicks(max);
    const innerW = W - ML - MR;
    const innerH = H - MT - MB;
    const band = innerW / Math.max(points.length, 1);
    const barW = Math.max(1.5, Math.min(24, band - 2));
    const bars = points.map((p, i) => {
      const h = top > 0 ? (p.count / top) * innerH : 0;
      const x = ML + i * band + (band - barW) / 2;
      return { x, y: MT + innerH - h, h, w: barW, cx: ML + i * band + band / 2 };
    });
    const every = Math.max(1, Math.ceil(40 / band));
    const maxIdx = max > 0 ? points.findIndex((p) => p.count === max) : -1;
    return { ticks, top, innerH, band, bars, every, max, maxIdx };
  }, [points]);

  const act = active !== null ? points[active] : null;
  const actBar = active !== null ? geo.bars[active] : null;

  return (
    <div className="chart" onPointerLeave={() => setActive(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} className="chart__svg">
        {geo.ticks.map((t) => {
          const y = MT + geo.innerH - (t / geo.top) * geo.innerH;
          return (
            <g key={t}>
              <line x1={ML} x2={W - MR} y1={y} y2={y} className={t === 0 ? 'chart__axis' : 'chart__grid'} />
              <text x={ML - 6} y={y + 3.5} textAnchor="end" className="chart__tick">
                {compact(t)}
              </text>
            </g>
          );
        })}

        {points.map((p, i) => {
          const b = geo.bars[i];
          return (
            <path
              key={p.key}
              d={barPath(b.x, b.y, b.w, b.h, 4)}
              className="chart__bar"
              style={{ opacity: p.partial ? 0.45 : active === i ? 1 : 0.88 }}
            />
          );
        })}

        {/* Labels thinned backwards from the newest period so the latest is always named. */}
        {points.map((p, i) =>
          (points.length - 1 - i) % geo.every === 0 ? (
            <text key={`x${p.key}`} x={geo.bars[i].cx} y={H - 6} textAnchor="middle" className="chart__tick">
              {shortLabel(kind, p.key)}
            </text>
          ) : null
        )}

        {/* One direct label: the extreme. */}
        {geo.maxIdx >= 0 && (
          <text
            x={Math.min(W - MR - 10, Math.max(ML + 10, geo.bars[geo.maxIdx].cx))}
            y={geo.bars[geo.maxIdx].y - 4}
            textAnchor="middle"
            className="chart__direct"
          >
            {fmtInt(geo.max)}
          </text>
        )}

        {points.map((p, i) => (
          <rect
            key={`h${p.key}`}
            x={ML + i * geo.band}
            y={MT}
            width={geo.band}
            height={geo.innerH}
            fill="transparent"
            onPointerEnter={() => setActive(i)}
            onPointerMove={() => setActive(i)}
            onClick={() => setActive(i)}
          />
        ))}
      </svg>

      {act && actBar && (
        <div
          className="chart__tip"
          style={{
            left: `${Math.min(86, Math.max(14, (actBar.cx / W) * 100))}%`,
            top: `${Math.max(0, (actBar.y / H) * 100 - 6)}%`,
          }}
        >
          <strong>{longLabel(kind, act.key)}</strong>
          <span>
            {fmtInt(act.count)} sismos{act.maxMag !== null ? ` · máx. M${act.maxMag.toFixed(1)}` : ''}
          </span>
          {act.partial && <span className="chart__tip-note">período en curso (incompleto)</span>}
        </div>
      )}
    </div>
  );
}

export function SeriesTable({ points, kind }: { points: StatsPoint[]; kind: SeriesKind }) {
  const rows = useMemo(() => [...points].reverse(), [points]);
  return (
    <div className="stats-table-wrap">
      <table className="stats-table">
        <thead>
          <tr>
            <th>Período</th>
            <th>Sismos</th>
            <th>Mag. máx.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.key}>
              <td>
                {longLabel(kind, p.key)}
                {p.partial ? ' (en curso)' : ''}
              </td>
              <td>{fmtInt(p.count)}</td>
              <td>{p.maxMag !== null ? p.maxMag.toFixed(1) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HBars({ rows }: { rows: { label: string; count: number }[] }) {
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
  return (
    <div className="hbars">
      {rows.map((r) => (
        <div className="hbars__row" key={r.label}>
          <span className="hbars__label">{r.label}</span>
          <span className="hbars__track">
            <span className="hbars__bar" style={{ width: `${max > 0 ? Math.max(r.count > 0 ? 1.5 : 0, (r.count / max) * 100) : 0}%` }} />
          </span>
          <span className="hbars__value">{fmtInt(r.count)}</span>
        </div>
      ))}
    </div>
  );
}
