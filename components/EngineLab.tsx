'use client';

import { useEffect, useRef, useState } from 'react';
import { feature } from 'topojson-client';
import {
  AreaLayer,
  GlobeEngine,
  EngineUnsupportedError,
  LineLayer,
  MarkerLayer,
  QuakeLayer,
  RingLayer,
  ringState,
  type AreaSpec,
  type LineSpec,
  type MarkerSpec,
  type Pov,
  type RingSpec,
} from '@/engine';
import { magColor } from '@/lib/format';
import { toBoundaryPaths } from '@/lib/geo';
import { pointScaleFor } from '@/lib/globeView';
import { circlePath } from '@/lib/nearby';

interface LabQuake {
  id: string;
  lat: number;
  lng: number;
  mag: number | null;
  place: string;
}

/** Deterministic pseudo-random numbers, so every run of the lab shows the same planet. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Quakes along the plate boundaries (as in life), a few anywhere, magnitudes by Gutenberg-Richter. */
function makeQuakes(n: number, spine: number[][]): LabQuake[] {
  const rnd = lcg(20261022);
  const out: LabQuake[] = [];
  for (let i = 0; i < n; i++) {
    let lat: number;
    let lng: number;
    if (spine.length && rnd() < 0.8) {
      const p = spine[Math.floor(rnd() * spine.length)];
      lat = p[0] + (rnd() - 0.5) * 4;
      lng = p[1] + (rnd() - 0.5) * 4;
    } else {
      lat = Math.asin(rnd() * 2 - 1) * (180 / Math.PI);
      lng = rnd() * 360 - 180;
    }
    lat = Math.max(-89.5, Math.min(89.5, lat));
    lng = ((((lng + 180) % 360) + 360) % 360) - 180;
    const mag = Math.min(8.6, Math.round((1 - Math.log10(Math.max(1e-6, rnd()))) * 10) / 10);
    out.push({ id: `lab-${i}`, lat, lng, mag, place: `Zona de prueba ${i}` });
  }
  return out;
}

function arrowElement(q: LabQuake): HTMLElement {
  const root = document.createElement('div');
  root.className = 'quake-arrow';
  root.style.setProperty('--arrow-color', magColor(q.mag));
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'quake-arrow__inner';
  btn.setAttribute('aria-label', `Sismo nuevo M${q.mag}: ${q.place}`);
  const label = document.createElement('span');
  label.className = 'quake-arrow__label';
  label.textContent = `NUEVO · M${(q.mag ?? 0).toFixed(1)}`;
  const head = document.createElement('span');
  head.className = 'quake-arrow__head';
  head.textContent = '▼';
  btn.append(label, head);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.__lab?.tapped(q.id);
  });
  root.appendChild(btn);
  return root;
}

function userElement(label: string): HTMLElement {
  const marker = document.createElement('div');
  marker.className = 'user-marker';
  marker.setAttribute('role', 'img');
  marker.setAttribute('aria-label', label);
  const pulse = document.createElement('span');
  pulse.className = 'user-marker__pulse';
  const dot = document.createElement('span');
  dot.className = 'user-marker__dot';
  const text = document.createElement('span');
  text.className = 'user-marker__label';
  text.textContent = label;
  marker.append(pulse, dot, text);
  return marker;
}

declare global {
  interface Window {
    __engine?: GlobeEngine;
    __lab?: {
      areas: AreaLayer<any>;
      lines: LineLayer<any>;
      quakes: QuakeLayer<LabQuake>;
      rings: RingLayer;
      markers: MarkerLayer;
      quakeData: () => LabQuake[];
      setQuakeCount: (n: number) => void;
      setRingsOn: (on: boolean) => void;
      setMarkersOn: (on: boolean) => void;
      hoveredQuake: () => LabQuake | null;
      lastTap: () => { quake: LabQuake | null; id: string | null };
      tapped: (id: string) => void;
      ringStateAt: (frameNow: number) => { spec: RingSpec; rho: number; fade: number; active: boolean }[];
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
    const rings = new RingLayer();
    const quakeLayer = new QuakeLayer<LabQuake>({
      altitude: 0.018,
      radiusDeg: (q) => Math.max(0.2, (q.mag ?? 1) * 0.15),
      color: (q) => magColor(q.mag),
    });
    const markers = new MarkerLayer();
    // Order is drawing order: the map, the rings on the ground, the quakes standing on it, then HTML.
    engine.addLayer(areas);
    engine.addLayer(lines);
    engine.addLayer(rings);
    engine.addLayer(quakeLayer);
    engine.addLayer(markers);
    engine.onPov = (pov) => quakeLayer.setScale(pointScaleFor(pov.altitude));
    quakeLayer.setScale(pointScaleFor(engine.camera.altitude));

    let allQuakes: LabQuake[] = [];
    let spine: number[][] = [];
    let quakeCount = Math.max(0, Math.min(60000, Number(new URLSearchParams(window.location.search).get('n') ?? 8000) || 0));
    let ringsOn = true;
    let markersOn = true;
    let hoveredQuake: LabQuake | null = null;
    let tapQuake: LabQuake | null = null;
    let tapId: string | null = null;

    const applyQuakes = () => {
      const shown = allQuakes.slice(0, quakeCount);
      quakeLayer.setQuakes(shown);
      // The biggest of the set pulse, and the three biggest are "new".
      const top = [...shown].sort((a, b) => (b.mag ?? 0) - (a.mag ?? 0)).slice(0, 40);
      rings.setRings(
        ringsOn
          ? top.map((q) => ({
              key: q.id,
              lat: q.lat,
              lng: q.lng,
              maxRadiusDeg: Math.max(2.5, (q.mag ?? 3) * 1.6),
              speedDegPerSec: Math.max(0.6, (q.mag ?? 3) * 0.5),
              color: magColor(q.mag),
            }))
          : []
      );
      const list: MarkerSpec[] = [];
      if (markersOn) {
        for (const q of top.slice(0, 3)) list.push({ id: q.id, lat: q.lat, lng: q.lng, create: () => arrowElement(q) });
        list.push({ id: 'user', lat: 4.61, lng: -74.08, create: () => userElement('Tú · Bogotá') });
      }
      markers.setMarkers(list);
    };

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
        spine = toBoundaryPaths(bd).flatMap((p) => p.coords as number[][]);
        allQuakes = makeQuakes(60000, spine);
        applyQuakes();
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
      hover: (pos, ev) => {
        if (!pos) {
          hoveredQuake = null;
          return show(null);
        }
        hoveredQuake = quakeLayer.pickQuake(engine.camera, pos.x, pos.y, ev && ev.pointerType !== 'mouse' ? 12 : 4);
        if (hoveredQuake) return show(`M ${hoveredQuake.mag} — ${hoveredQuake.place}`);
        const hit = engine.camera.hitSphere(pos.x, pos.y);
        if (!hit) return show(null);
        const lat = Math.asin(Math.max(-1, Math.min(1, hit[1]))) * (180 / Math.PI);
        const lng = Math.atan2(hit[0], hit[2]) * (180 / Math.PI);
        const near = lines.pickNear(lat, lng, 0.25 * (engine.camera.altitude + 0.05));
        const a = areas.pickAll(lat, lng).find((s) => s.data?.kind === 'country');
        show(near ? near.spec.data?.label ?? null : a?.data?.name ?? null);
      },
      tap: (x, y, ev) => {
        const picked = quakeLayer.pickQuake(engine.camera, x, y, ev && ev.pointerType !== 'mouse' ? 12 : 4);
        if (picked) {
          tapQuake = picked;
          tapId = picked.id;
          return;
        }
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
      quakes: quakeLayer,
      rings,
      markers,
      quakeData: () => allQuakes.slice(0, quakeCount),
      setQuakeCount: (n) => {
        quakeCount = Math.max(0, Math.min(allQuakes.length, n));
        applyQuakes();
      },
      setRingsOn: (on) => {
        ringsOn = on;
        applyQuakes();
      },
      setMarkersOn: (on) => {
        markersOn = on;
        applyQuakes();
      },
      hoveredQuake: () => hoveredQuake,
      lastTap: () => ({ quake: tapQuake, id: tapId }),
      tapped: (id) => {
        tapId = id;
        tapQuake = allQuakes.find((q) => q.id === id) ?? null;
      },
      ringStateAt: (frameNow) =>
        rings.allSlots().map(({ spec, slot }) => {
          const st = ringState(slot, rings.clockAt(frameNow));
          return { spec, rho: st.rho, fade: st.fade, active: st.active };
        }),
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
        `sismos ${quakeLayer.count}   anillos ${rings.slotCount}   marcadores ${markers.count}\n` +
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
        <button type="button" onClick={() => window.__lab?.setQuakeCount(1000)}>
          1 000 sismos
        </button>
        <button type="button" onClick={() => window.__lab?.setQuakeCount(10000)}>
          10 000 sismos
        </button>
        <button type="button" onClick={() => window.__lab?.setQuakeCount(0)}>
          Sin sismos
        </button>
        <button type="button" onClick={() => window.__engine?.debugLoseContext(400)}>
          Perder contexto
        </button>
      </div>
    </main>
  );
}
