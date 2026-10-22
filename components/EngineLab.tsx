'use client';

import { useEffect, useRef, useState } from 'react';
import { GlobeEngine, EngineUnsupportedError, type Pov } from '@/engine';

declare global {
  interface Window {
    __engine?: GlobeEngine;
  }
}

const PLACES: { name: string; pov: Pov }[] = [
  { name: 'Colombia', pov: { lat: 4.6, lng: -74.1, altitude: 0.9 } },
  { name: 'Japón', pov: { lat: 36, lng: 138, altitude: 0.9 } },
  { name: 'Chile', pov: { lat: -33.5, lng: -70.7, altitude: 0.6 } },
  { name: 'Polo norte', pov: { lat: 89, lng: 0, altitude: 1.2 } },
  { name: 'Meridiano 180°', pov: { lat: 0, lng: 180, altitude: 1.6 } },
  { name: 'Mundo', pov: { lat: 15, lng: -40, altitude: 2.5 } },
];

/**
 * Laboratory for the engine's own WebGL2 renderer. It is a test bench: the production globe
 * still draws with the libraries until the engine passes every check.
 */
export default function EngineLab() {
  const hostRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLPreElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let engine: GlobeEngine;
    try {
      engine = new GlobeEngine(host, {
        textureUrls: ['/data/earth-dark.jpg', 'https://cdn.jsdelivr.net/npm/three-globe@2.31.1/example/img/earth-dark.jpg'],
        countDrawCalls: true,
      });
    } catch (err) {
      setError(err instanceof EngineUnsupportedError ? 'Tu navegador no tiene WebGL2.' : 'No se pudo iniciar el motor gráfico.');
      return;
    }
    window.__engine = engine;

    const hud = window.setInterval(() => {
      const el = hudRef.current;
      if (!el) return;
      const p = engine.camera.pov();
      const s = engine.stats;
      const sz = engine.size;
      el.textContent =
        `lat ${p.lat.toFixed(3)}  lng ${p.lng.toFixed(3)}  alt ${p.altitude.toFixed(4)}\n` +
        `${sz.width}×${sz.height} @${sz.pixelRatio.toFixed(2)}x   fps ${s.fps.toFixed(0)}   cpu ${s.cpuMs.toFixed(2)} ms\n` +
        `llamadas de dibujo ${s.drawCalls}   cuadros ${s.frames}`;
    }, 250);

    return () => {
      window.clearInterval(hud);
      if (window.__engine === engine) delete window.__engine;
      engine.destroy();
    };
  }, []);

  return (
    <main className="engine-lab">
      <div ref={hostRef} className="engine-lab-host" />
      {error && <p className="engine-lab-error">{error}</p>}
      <pre ref={hudRef} className="engine-lab-hud" aria-hidden="true" />
      <div className="engine-lab-bar">
        {PLACES.map((p) => (
          <button key={p.name} type="button" onClick={() => window.__engine?.flyTo(p.pov, 1800)}>
            {p.name}
          </button>
        ))}
        <button type="button" onClick={() => window.__engine?.debugLoseContext(400)}>
          Perder contexto
        </button>
      </div>
    </main>
  );
}
