import assert from 'node:assert/strict';
import type { EngineDiagnostics } from '../engine';
import { diagnosticsRequested, formatDiagnostics, isSoftwareRenderer } from '../lib/diagnostics';

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
};
{
  const t = formatDiagnostics(base, { detail: '110m', quakes: 8000 });
  assert.match(t, /fps 58 · 17 ms por fotograma al moverse/);
  assert.match(t, /JS por fotograma 0\.6 ms · 6 llamadas de dibujo/);
  assert.match(t, /lienzo 1170×2532 px · DPR 3 · resolución 0\.67× \(0\.67× al moverse\)/);
  assert.match(t, /países 110m · 8000 sismos/);
  assert.match(t, /GPU: Apple GPU$/m);
  assert.ok(!/contexto WebGL/.test(t), 'no context-loss line when nothing was lost');
  assert.equal(t.split('\n').length, 5);
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

console.log('diagnostics tests: ok');
