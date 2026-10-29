import type { EngineDiagnostics } from '../engine';

/**
 * The diagnostics panel (`?diag=1`): numbers read off the engine so someone on a real device can
 * tell what the globe is doing there (frame rate, resolution, graphics driver) without a debugger.
 * Off unless asked for; the choice is remembered for the tab so a reload or a link change keeps it.
 */

const KEY = 'seismo-diag';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** `?diag=1` turns it on for this tab, `?diag=0` off; otherwise whatever the tab remembered. */
export function diagnosticsRequested(search: string, storage: StorageLike | null): boolean {
  const asked = new URLSearchParams(search).get('diag');
  try {
    if (asked === '1') {
      storage?.setItem(KEY, '1');
      return true;
    }
    if (asked === '0') {
      storage?.removeItem(KEY);
      return false;
    }
    return storage?.getItem(KEY) === '1';
  } catch {
    return asked === '1'; // storage blocked: honour the address, just do not remember it
  }
}

export interface DiagExtras {
  /** Which country outlines are drawn: the coarse or the fine set. */
  detail: '110m' | '50m';
  quakes: number;
}

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/i;

/** True when the browser reports a CPU-based "GPU": nothing here says anything about real devices then. */
export function isSoftwareRenderer(name: string): boolean {
  return SOFTWARE_RENDERER.test(name);
}

const one = (n: number) => (Math.round(n * 10) / 10).toString();

/** The panel text, one fact per line (plain text so it can be copied and pasted into a message). */
export function formatDiagnostics(d: EngineDiagnostics, extra: DiagExtras): string {
  const lines: string[] = [];
  const frame = d.frameMs === null ? 'sin medir (mueve el globo)' : `${Math.round(d.frameMs)} ms por fotograma al moverse`;
  lines.push(`fps ${d.fps > 0 ? Math.round(d.fps) : '–'} · ${frame}`);
  lines.push(`JS por fotograma ${one(d.cpuMs)} ms · ${d.drawCalls > 0 ? `${d.drawCalls} llamadas de dibujo` : 'llamadas de dibujo n/d'}`);
  const scale = d.adaptiveScale === null ? 'fija' : `${d.adaptiveScale.toFixed(2)}× al moverse`;
  lines.push(`lienzo ${d.canvasWidth}×${d.canvasHeight} px · DPR ${one(d.devicePixelRatio)} · resolución ${d.pixelRatio.toFixed(2)}× (${scale})`);
  lines.push(`países ${extra.detail} · ${extra.quakes} sismos${d.moving ? ' · en movimiento' : ''}`);
  const gpu = d.renderer ? `${d.renderer}${isSoftwareRenderer(d.renderer) ? ' (por software: las cifras no valen)' : ''}` : 'no informada por el navegador';
  lines.push(`GPU: ${gpu}`);
  if (d.contextLosses > 0) lines.push(`contexto WebGL perdido ${d.contextLosses} ${d.contextLosses === 1 ? 'vez' : 'veces'}`);
  return lines.join('\n');
}
