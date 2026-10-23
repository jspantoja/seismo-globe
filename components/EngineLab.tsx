'use client';

import { useEffect, useRef, useState } from 'react';
import { feature } from 'topojson-client';
import { AreaLayer, GlobeEngine, EngineUnsupportedError, LineLayer, type AreaSpec, type LineSpec, type Pov } from '@/engine';
import { toBoundaryPaths } from '@/lib/geo';
import { circlePath } from '@/lib/nearby';

declare global {
  interface Window {
    __engine?: GlobeEngine;
    __lab?: {
      areas: AreaLayer<any>;
      lines: LineLayer<any>;
      select: (id: string | null) => void;
      setPlate: (code: string | null) => void;
      setRing: (on: boolean) => void;
      useDetailed: (on: boolean) => Promise<void>;
      hovered: () => string | null;
      stats: () => { areas: AreaLayer['stats']; lines: number; buildMs: number };
    };
  }
}

const PLACES: { name: string; pov: Pov }[] = [
  { name: 'Colombia', pov: { lat: 4.6, lng: -74.1, altitude: 0.9 } },
  { name: 'Japón', pov: { lat: 36, lng: 138, altitude: 0.9 } },
  { name: 'Chile', pov: { lat: -33.5, lng: -70.7, altitude: 0.6 } },
  { name: 'Fiyi', pov: { lat: -17, lng: 179.5, altitude: 0.35 } },
  { name: 'Polo norte', pov: { lat: 89, lng: 0, altitude: 1.2 } },
  { name: 'Mundo', pov: { lat: 15, lng: -40, altitude: 2.5 } },
];

const TEXTURES = ['/data/earth-dark.jpg', 'https://cdn.jsdelivr.net/npm/three-globe@2.31.1/example/img/earth-dark.jpg'];

function lineColor(type: string): string {
  return type === 'near-radius' ? '#60a5fa' : type === 'subduction' ? '#ff8a3d' : '#7dd3fc';
}
function lineWidth(type: string): number {
  return type === 'near-radius' ? 1.5 : type === 'subduction' ? 1.6 : 1.1;
}

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
      engine = new GlobeEngine(host, { textureUrls: TEXTURES, countDrawCalls: true });
    } catch (err) {
      setError(err instanceof EngineUnsupportedError ? 'Tu navegador no tiene WebGL2.' : 'No se pudo iniciar el motor gráfico.');
      return;
    }
    window.__engine = engine;
    let destroyed = false;

    const areas = new AreaLayer<{ id: string; name: string; kind: string }>();
    const lines = new LineLayer<{ label: string }>();
    engine.addLayer(areas);
    engine.addLayer(lines);

    let countries: any[] = [];
    let plates: any[] = [];
    let selected: string | null = null;
    let plateCode: string | null = null;
    let ring = false;
    let hovered: string | null = null;
    let boundaryLines: LineSpec<{ label: string }>[] = [];
    let buildMs = 0;

    const refreshAreas = () => {
      const t0 = performance.now();
      const specs: AreaSpec<{ id: string; name: string; kind: string }>[] = [];
      const plate = plateCode ? plates.find((p) => p.properties?.Code === plateCode) : null;
      if (plate) specs.push({ key: `plate-${plateCode}`, geometry: plate.geometry, fill: 'rgba(144, 133, 233, 0.24)', order: 0, data: { id: plateCode!, name: `Placa ${plate.properties?.PlateName}`, kind: 'plate' } });
      for (const f of countries) {
        const id = String(f.id);
        const isSel = id === selected;
        specs.push({
          key: id,
          geometry: f.geometry,
          fill: isSel ? 'rgba(79, 209, 197, 0.28)' : 'rgba(110, 140, 180, 0.12)',
          stroke: isSel ? '#4fd1c5' : 'rgba(180, 200, 225, 0.4)',
          strokeWidth: isSel ? 1.6 : 1,
          order: isSel ? 3 : 1,
          data: { id, name: f.properties?.name ?? id, kind: 'country' },
        });
      }
      areas.setAreas(specs);
      buildMs = performance.now() - t0;
    };

    const refreshLines = () => {
      const all = [...boundaryLines];
      if (ring) {
        const c = engine.camera.pov();
        const pts = circlePath({ lat: c.lat, lng: c.lng }, 800);
        all.push({ points: pts.flatMap(([lat, lng]) => [lng, lat]), color: lineColor('near-radius'), width: lineWidth('near-radius'), data: { label: 'Radio de 800 km' } });
      }
      lines.setLines(all);
    };

    const loadCountries = async (file: string) => {
      const topo = await (await fetch(file)).json();
      const key = Object.keys(topo.objects)[0];
      countries = (feature(topo, topo.objects[key]) as any).features.filter((f: any) => f.properties?.name !== 'Antarctica');
      refreshAreas();
    };

    (async () => {
      try {
        await loadCountries('/data/countries-110m.json');
        const [pl, bd] = await Promise.all([fetch('/data/PB2002_plates.json').then((r) => r.json()), fetch('/data/PB2002_boundaries.json').then((r) => r.json())]);
        if (destroyed) return;
        plates = pl.features;
        boundaryLines = toBoundaryPaths(bd).map((p) => ({
          points: p.coords.flatMap(([lat, lng]) => [lng, lat]),
          color: lineColor(p.boundaryType),
          width: lineWidth(p.boundaryType),
          data: { label: `Límite de placas: ${p.plateA} — ${p.plateB}` },
        }));
        refreshLines();
        refreshAreas();
      } catch (err) {
        console.error(err);
      }
    })();

    const show = (name: string | null) => {
      hovered = name;
      engine.setCursor(name ? 'pointer' : null);
      engine.requestRender();
    };
    engine.setEvents({
      hover: (pos) => {
        if (!pos) return show(null);
        const hit = engine.camera.hitSphere(pos.x, pos.y);
        if (!hit) return show(null);
        const lat = Math.asin(Math.max(-1, Math.min(1, hit[1]))) * (180 / Math.PI);
        const lng = Math.atan2(hit[0], hit[2]) * (180 / Math.PI);
        const near = lines.pickNear(lat, lng, 0.25 * (engine.camera.altitude + 0.05));
        const a = areas.pickAll(lat, lng).find((s) => s.data?.kind === 'country');
        show(near ? near.spec.data?.label ?? null : a?.data?.name ?? null);
      },
      tap: (x, y) => {
        const hit = engine.camera.hitSphere(x, y);
        if (!hit) return;
        const lat = Math.asin(Math.max(-1, Math.min(1, hit[1]))) * (180 / Math.PI);
        const lng = Math.atan2(hit[0], hit[2]) * (180 / Math.PI);
        const a = areas.pickAll(lat, lng).find((s) => s.data?.kind === 'country');
        selected = a ? a.data!.id : null;
        refreshAreas();
      },
    });

    window.__lab = {
      areas,
      lines,
      select: (id) => {
        selected = id;
        refreshAreas();
      },
      setPlate: (code) => {
        plateCode = code;
        refreshAreas();
      },
      setRing: (on) => {
        ring = on;
        refreshLines();
      },
      useDetailed: async (on) => {
        await loadCountries(on ? '/data/countries-50m.json' : '/data/countries-110m.json');
      },
      hovered: () => hovered,
      stats: () => ({ areas: areas.stats, lines: lines.segmentCount, buildMs }),
    };

    const hud = window.setInterval(() => {
      const el = hudRef.current;
      if (!el) return;
      const p = engine.camera.pov();
      const s = engine.stats;
      const sz = engine.size;
      const a = areas.stats;
      el.textContent =
        `lat ${p.lat.toFixed(3)}  lng ${p.lng.toFixed(3)}  alt ${p.altitude.toFixed(4)}\n` +
        `${sz.width}×${sz.height} @${sz.pixelRatio.toFixed(2)}x   fps ${s.fps.toFixed(0)}   cpu ${s.cpuMs.toFixed(2)} ms\n` +
        `llamadas de dibujo ${s.drawCalls}   triángulos ${a.triangles}   segmentos ${a.segments + lines.segmentCount}\n` +
        (hovered ? `» ${hovered}` : '');
    }, 250);

    return () => {
      destroyed = true;
      window.clearInterval(hud);
      if (window.__engine === engine) delete window.__engine;
      delete window.__lab;
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
        <button type="button" onClick={() => window.__lab?.setPlate('SA')}>
          Placa Sudamérica
        </button>
        <button type="button" onClick={() => window.__lab?.setPlate(null)}>
          Sin placa
        </button>
        <button type="button" onClick={() => window.__lab?.useDetailed(true)}>
          Países 50 m
        </button>
        <button type="button" onClick={() => window.__lab?.useDetailed(false)}>
          Países 110 m
        </button>
        <button type="button" onClick={() => window.__lab?.setRing(true)}>
          Anillo
        </button>
        <button type="button" onClick={() => window.__engine?.debugLoseContext(400)}>
          Perder contexto
        </button>
      </div>
    </main>
  );
}
