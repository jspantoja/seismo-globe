import assert from 'node:assert/strict';
import type { EngineDiagnostics } from '../engine';
import { diagnosticsRequested, experimentFlags, formatDiagnostics, isSoftwareRenderer } from '../lib/diagnostics';

const memory = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};

// --- the switch: address first, then what the tab remembers
{
  const st = memory();
  assert.equal(diagnosticsRequested('', st), false, 'off by default');
  assert.equal(diagnosticsRequested('?diag=1', st), true, 'on from the address');
  assert.equal(diagnosticsRequested('', st), true, 'remembered by the tab after the address was rewritten');
  assert.equal(diagnosticsRequested('?pais=170', st), true, 'other parameters do not turn it off');
  assert.equal(diagnosticsRequested('?diag=0', st), false, 'off from the address');
  assert.equal(diagnosticsRequested('', st), false, 'and forgotten');
  assert.equal(diagnosticsRequested('?diag=2', st), false, 'only 1 turns it on');
  assert.equal(diagnosticsRequested('?diag=1', null), true, 'works without storage');
  const blocked = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  assert.equal(diagnosticsRequested('?diag=1', blocked), true, 'blocked storage still honours the address');
  assert.equal(diagnosticsRequested('', blocked), false, 'and never throws');
}

// --- the experiment switches: off from the address, remembered by the tab, back on with =1
{
  const st = memory();
  assert.deepEqual(experimentFlags('', st), { msaa: true, glass: true }, 'both on by default');
  assert.deepEqual(experimentFlags('?msaa=0', st), { msaa: false, glass: true });
  assert.deepEqual(experimentFlags('?pais=170', st), { msaa: false, glass: true }, 'remembered after the address was rewritten');
  assert.deepEqual(experimentFlags('?glass=0', st), { msaa: false, glass: false });
  assert.deepEqual(experimentFlags('?msaa=1', st), { msaa: true, glass: false }, '=1 puts one back');
  assert.deepEqual(experimentFlags('?msaa=2&glass=1', st), { msaa: true, glass: true }, 'only 0 turns one off');
  assert.deepEqual(experimentFlags('?msaa=0&glass=0', null), { msaa: false, glass: false }, 'works without storage');
  const blocked = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  assert.deepEqual(experimentFlags('?msaa=0', blocked), { msaa: false, glass: true }, 'blocked storage still honours the address');
  assert.deepEqual(experimentFlags('', blocked), { msaa: true, glass: true }, 'and never throws');
}

// --- software renderers are recognised
for (const name of ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', 'llvmpipe (LLVM 15.0.7, 256 bits)', 'Microsoft Basic Render Driver']) {
  assert.ok(isSoftwareRenderer(name), name);
}
for (const name of ['Apple GPU', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Adreno (TM) 740', 'Mali-G78']) {
  assert.ok(!isSoftwareRenderer(name), name);
}

// --- the text
const base: EngineDiagnostics = {
  fps: 58.4,
  frames: 900,
  cpuMs: 0.62,
  drawCalls: 6,
  contextLosses: 0,
  canvasWidth: 1170,
  canvasHeight: 2532,
  devicePixelRatio: 3,
  pixelRatio: 0.67,
  adaptiveScale: 0.67,
  frameMs: 16.7,
  moving: false,
  renderer: 'Apple GPU',
  samples: 4,
  gpuMs: null,
};
{
  const t = formatDiagnostics(base, { detail: '110m', quakes: 8000 });
  assert.match(t, /fps 58 · 17 ms por fotograma al moverse/);
  assert.match(t, /JS por fotograma 0\.6 ms · 6 llamadas de dibujo/);
  assert.match(t, /lienzo 1170×2532 px · DPR 3 · resolución 0\.67× \(0\.67× al moverse\)/);
  assert.match(t, /países 110m · 8000 sismos/);
  assert.match(t, /GPU: Apple GPU$/m);
  assert.ok(!/contexto WebGL/.test(t), 'no context-loss line when nothing was lost');
  assert.match(t, /GPU por capa: este navegador no tiene medidor/);
  assert.match(t, /suavizado 4× \(MSAA\)$/m, 'no panel info about the glass when the page does not say');
  assert.equal(t.split('\n').length, 7);
}
{
  const t = formatDiagnostics({ ...base, fps: 0, frameMs: null, drawCalls: 0, adaptiveScale: null, renderer: '', contextLosses: 2, moving: true }, { detail: '50m', quakes: 0 });
  assert.match(t, /fps – · sin medir/);
  assert.match(t, /llamadas de dibujo n\/d/);
  assert.match(t, /\(fija\)/);
  assert.match(t, /países 50m · 0 sismos · en movimiento/);
  assert.match(t, /GPU: no informada/);
  assert.match(t, /contexto WebGL perdido 2 veces/);
}
{
  const t = formatDiagnostics({ ...base, renderer: 'llvmpipe (LLVM 15.0.7, 256 bits)', contextLosses: 1 }, { detail: '110m', quakes: 1 });
  assert.match(t, /por software: las cifras no valen/);
  assert.match(t, /perdido 1 vez$/);
}

{
  const waiting = formatDiagnostics({ ...base, gpuMs: {} }, { detail: '110m', quakes: 1 });
  assert.match(waiting, /GPU por capa: midiendo… \(mueve el globo\)/);
  const t = formatDiagnostics({ ...base, gpuMs: { total: 12.04, sismos: 9.43, globo: 1.2, marcadores: 0.01, 'áreas': 0.8, otra: 0.6 } }, { detail: '110m', quakes: 1 });
  assert.match(t, /GPU por capa \(ms\): globo 1\.2 · áreas 0\.8 · sismos 9\.4 · marcadores 0 · otra 0\.6 · total 12$/m, 'layers in drawing order, unknown ones after, total last');
}

{
  const t = formatDiagnostics({ ...base, samples: 0 }, { detail: '110m', quakes: 1, glass: true });
  assert.match(t, /sin suavizado MSAA · desenfoque de paneles sí/);
  assert.match(formatDiagnostics(base, { detail: '110m', quakes: 1, glass: false }), /suavizado 4× \(MSAA\) · desenfoque de paneles no/);
}

console.log('diagnostics tests: ok');
