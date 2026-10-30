'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AreaLayer,
  EngineUnsupportedError,
  GlobeEngine,
  LineLayer,
  MarkerLayer,
  QuakeLayer,
  RingLayer,
  vecToGeo,
  type AreaSpec,
  type LineSpec,
  type MarkerSpec,
  type QuakeStyle,
} from '@/engine';
import type { BoundaryPath, QuakeFeature } from '@/lib/types';
import { magColor, sourceLabel } from '@/lib/format';
import { DETAIL_PRELOAD_ALTITUDE, describeView, heightScaleFor, pointScaleFor, wantsDetail } from '@/lib/globeView';
import { diagnosticsRequested, formatDiagnostics, type DiagExtras } from '@/lib/diagnostics';

/**
 * The globe of the app, drawn by the project's own WebGL2 engine (see /engine): the planet, the
 * countries, the plate boundaries, the earthquakes, the pulsing rings and the HTML markers are layers
 * of one engine; this component only feeds them data and turns pointer events into the app's actions.
 */

const FLIGHT_MS = 1200; // length of a programmatic camera flight

// Earthquakes: a prism standing on the surface, its radius in degrees of arc by magnitude.
const QUAKE_STYLE: QuakeStyle<QuakeFeature> = {
  altitude: 0.018,
  radiusDeg: (q) => Math.max(0.2, (q.mag ?? 1) * 0.15),
  color: (q) => magColor(q.mag),
};
const HOVER_SLOP_PX = 4; // extra reach around a dot for a mouse
const TOUCH_SLOP_PX = 12; // ... and for a finger
const LINE_PICK_DEG = 0.25; // how close to a boundary the pointer must be, per unit of (altitude + 0.05)

/** Text of a quake's hover label (plain text: place names come from third-party feeds). */
function quakeTipText(q: QuakeFeature): string {
  return `M ${q.mag ?? '?'} — ${q.place ?? 'ubicación desconocida'}${q.source === 'USGS' ? '' : ` (${sourceLabel(q.source)})`}${
    q.citizen ? ` · 👥 ${q.citizen.reports} reportes` : ''
  }`;
}

// The app's own copy (scripts/fetch-assets.mjs) is used unless it fails to load.
const EARTH_TEXTURES = ['/data/earth-dark.jpg', 'https://cdn.jsdelivr.net/npm/three-globe@2.31.1/example/img/earth-dark.jpg'];

const COUNTRY_FILL = 'rgba(110, 140, 180, 0.12)';
const COUNTRY_STROKE = 'rgba(180, 200, 225, 0.4)';
const SELECTED_FILL = 'rgba(79, 209, 197, 0.28)';
const SELECTED_STROKE = '#4fd1c5';
const PLATE_FILL = 'rgba(144, 133, 233, 0.24)';
const SUBDIVISION_STROKE = 'rgba(231, 236, 245, 0.6)';

function subdivisionColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `hsla(${hue}, 55%, 55%, 0.28)`;
}

function boundaryColor(type: string): string {
  return type === 'near-radius' ? '#60a5fa' : type === 'subduction' ? '#ff8a3d' : '#7dd3fc';
}
function boundaryWidth(type: string): number {
  return type === 'near-radius' ? 1.5 : type === 'subduction' ? 1.6 : 1.1;
}
function boundaryLabel(p: BoundaryPath): string {
  return p.boundaryType === 'near-radius'
    ? `Radio de ${p.plateA} km`
    : `Límite de placas: ${p.plateA} — ${p.plateB}${p.boundaryType === 'subduction' ? ' (zona de subducción)' : ''}`;
}

export interface FlyTo {
  lat: number;
  lng: number;
  altitude: number;
}

export interface Pov {
  lat: number;
  lng: number;
  altitude: number;
}

interface Props {
  countries: any | null;
  /** The 1:50m country features, once loaded: drawn instead of `countries` when the camera is close. */
  detailedCountries?: any[] | null;
  /** The camera came close enough that the detailed borders will be wanted: start loading them. */
  onNeedDetail?: () => void;
  /** The "home" key (0 / Home) was pressed on the globe: show the whole planet again. */
  onHome?: () => void;
  boundaries: BoundaryPath[];
  quakes: QuakeFeature[];
  pulseQuakes: QuakeFeature[];
  freshQuakes: QuakeFeature[]; // brand-new events: get a bouncing arrow marker
  onQuakeClick: (q: QuakeFeature) => void;
  onCountryClick: (feature: any) => void;
  selectedCountryId: string | null;
  subdivisions: any[] | null;
  selectedPlate: any | null; // PB2002 feature, geometry already winding-normalized
  flyTo: FlyTo | null;
  onZoomChange: (pov: Pov) => void;
  onReady?: () => void; // the globe is initialised and the camera can be moved
  onFlightStart?: (durationMs: number) => void; // a programmatic camera flight is really starting now
  userMarker?: { lat: number; lng: number; label: string } | null; // "you are here" (kept in this browser only)
  radiusRing?: BoundaryPath | null; // circle drawn around the marker
}

type AreaKind = 'country' | 'sub' | 'plate';
interface AreaData {
  kind: AreaKind;
  feature: any;
}
interface LineData {
  label: string;
}

interface Layers {
  engine: GlobeEngine;
  areas: AreaLayer<AreaData>;
  lines: LineLayer<LineData>;
  rings: RingLayer;
  quakes: QuakeLayer<QuakeFeature>;
  markers: MarkerLayer;
}

declare global {
  interface Window {
    /** Diagnostic hook: the globe's engine and layers (used by the browser tests). */
    __seismoGlobe?: Layers;
  }
}

export default function GlobeCanvas({
  countries,
  detailedCountries = null,
  onNeedDetail,
  onHome,
  boundaries,
  quakes,
  pulseQuakes,
  freshQuakes,
  onQuakeClick,
  onCountryClick,
  selectedCountryId,
  subdivisions,
  selectedPlate,
  flyTo,
  onZoomChange,
  onReady,
  onFlightStart,
  userMarker = null,
  radiusRing = null,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const layersRef = useRef<Layers | null>(null);
  // The engine is created after mount; the data effects below wait for it, and a camera flight
  // requested before it exists (e.g. a country taken from a shared link) is applied as soon as it does.
  const [ready, setReady] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  // `?diag=1`: a small panel with what the engine measures (see lib/diagnostics.ts). Off for everyone else.
  const [diag, setDiag] = useState(false);
  const diagRef = useRef<HTMLButtonElement>(null);
  const diagExtraRef = useRef<DiagExtras>({ detail: '110m', quakes: 0 });
  // Level of detail: the camera asks for the fine borders (wantFine) and they are used once prepared (fineReady).
  const [wantFine, setWantFine] = useState(false);
  const [fineReady, setFineReady] = useState(false);
  const wantFineRef = useRef(false);
  const detailAskedRef = useRef(false);
  // What a screen reader says after the view was moved with the keyboard.
  const [announcement, setAnnouncement] = useState('');
  const helpId = useId();

  // Latest callbacks, reachable from the engine's long-lived handlers.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onFlightStartRef = useRef(onFlightStart);
  onFlightStartRef.current = onFlightStart;
  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;
  const onQuakeClickRef = useRef(onQuakeClick);
  onQuakeClickRef.current = onQuakeClick;
  const onCountryClickRef = useRef(onCountryClick);
  onCountryClickRef.current = onCountryClick;
  const onNeedDetailRef = useRef(onNeedDetail);
  onNeedDetailRef.current = onNeedDetail;
  const onHomeRef = useRef(onHome);
  onHomeRef.current = onHome;

  // ---- The engine, its layers, the label and the pointer handling ------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let diagOn = false;
    try {
      diagOn = diagnosticsRequested(window.location.search, window.sessionStorage);
    } catch {
      diagOn = diagnosticsRequested(window.location.search, null); // storage blocked in this browser
    }
    setDiag(diagOn);
    let engine: GlobeEngine;
    try {
      engine = new GlobeEngine(host, {
        countDrawCalls: diagOn,
        textureUrls: EARTH_TEXTURES,
        atmosphereColor: '#4fd1c5',
        atmosphereAltitude: 0.15,
        adaptiveResolution: true, // lowers the sharpness only while moving, on devices that cannot keep up
      });
    } catch (err) {
      if (!(err instanceof EngineUnsupportedError)) console.error(err);
      setUnsupported(true);
      onReadyRef.current?.(); // the rest of the app does not need the globe
      return;
    }
    // A focusable, keyboard-driven surface: an "application", not a picture.
    engine.canvas.setAttribute('role', 'application');
    engine.canvas.setAttribute('aria-roledescription', 'globo interactivo');
    engine.canvas.setAttribute('aria-label', 'Globo terráqueo con los sismos recientes');
    engine.canvas.setAttribute('aria-describedby', helpId);
    engine.canvas.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown ArrowLeft ArrowRight + - 0 Home');

    const areas = new AreaLayer<AreaData>();
    const lines = new LineLayer<LineData>();
    const rings = new RingLayer();
    const quakeLayer = new QuakeLayer<QuakeFeature>(QUAKE_STYLE);
    const markers = new MarkerLayer();
    // Drawing order: the map, the rings on the ground, the quakes standing on it, then HTML.
    engine.addLayer(areas);
    engine.addLayer(lines);
    engine.addLayer(rings);
    engine.addLayer(quakeLayer);
    engine.addLayer(markers);

    const reducedMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)');
    rings.setAnimated(!(reducedMotion && reducedMotion.matches));

    const tip = document.createElement('div');
    tip.className = 'globe-tip';
    tip.style.display = 'none';
    host.appendChild(tip);
    let tipVisible = false;
    const hideTip = () => {
      if (!tipVisible) return;
      tipVisible = false;
      tip.style.display = 'none';
      engine.setCursor(null);
    };
    const showTip = (text: string, x: number, y: number, clickable: boolean) => {
      tipVisible = true;
      tip.textContent = text;
      tip.style.display = 'block';
      const width = tip.offsetWidth;
      const host_w = host.clientWidth;
      tip.style.left = `${x + 14 + width > host_w ? Math.max(0, x - 14 - width) : x + 14}px`;
      tip.style.top = `${y + 14}px`;
      engine.setCursor(clickable ? 'pointer' : null);
    };

    const slopFor = (ev?: PointerEvent) => (ev && ev.pointerType !== 'mouse' ? TOUCH_SLOP_PX : HOVER_SLOP_PX);
    const geoAt = (x: number, y: number) => {
      const hit = engine.camera.hitSphere(x, y);
      return hit ? vecToGeo(hit) : null;
    };

    // After the view was moved with the keys, say where it is (once it has stopped for a moment).
    let announceTimer: ReturnType<typeof setTimeout> | 0 = 0;
    const announce = () => {
      announceTimer = 0;
      const pov = engine.camera.pov();
      const area = areas.pick(pov.lat, pov.lng);
      const p = area?.data?.feature?.properties ?? {};
      const place = area?.data?.kind === 'plate' ? null : (p.name as string | undefined) ?? null;
      setAnnouncement(describeView(place, pov.altitude, pov.lat, pov.lng));
    };

    engine.setEvents({
      navigated: () => {
        if (announceTimer) clearTimeout(announceTimer);
        announceTimer = setTimeout(announce, 700);
      },
      home: () => onHomeRef.current?.(),
      hover: (pos, ev) => {
        if (!pos) return hideTip();
        const quake = quakeLayer.pickQuake(engine.camera, pos.x, pos.y, slopFor(ev));
        if (quake) return showTip(quakeTipText(quake), pos.x, pos.y, true);
        const g = geoAt(pos.x, pos.y);
        if (!g) return hideTip();
        const near = lines.pickNear(g.lat, g.lng, LINE_PICK_DEG * (engine.camera.altitude + 0.05));
        if (near?.spec.data) return showTip(near.spec.data.label, pos.x, pos.y, false);
        const area = areas.pick(g.lat, g.lng);
        if (!area?.data) return hideTip();
        const p = area.data.feature?.properties ?? {};
        const label = area.data.kind === 'plate' ? `Placa ${p.PlateName ?? ''}` : area.data.kind === 'sub' ? `${p.name ?? ''}${p.type ? ` (${p.type})` : ''}` : `${p.name ?? ''}`;
        showTip(label, pos.x, pos.y, area.data.kind === 'country');
      },
      tap: (x, y, ev) => {
        hideTip();
        const quake = quakeLayer.pickQuake(engine.camera, x, y, slopFor(ev));
        if (quake) return onQuakeClickRef.current(quake);
        const g = geoAt(x, y);
        if (!g) return;
        // Subdivisions and plates are informational; a country (including the neighbours shown
        // around a selected one) can be clicked to switch to it.
        const area = areas.pick(g.lat, g.lng);
        if (area?.data?.kind === 'country') onCountryClickRef.current(area.data.feature);
      },
      interact: (active) => {
        if (active) hideTip();
      },
    });

    engine.onPov = (pov) => {
      hideTip(); // the globe moved under a resting pointer: the label is stale
      quakeLayer.setScale(pointScaleFor(pov.altitude)); // a uniform: free
      quakeLayer.setHeightScale(heightScaleFor(pov.altitude));
      const fine = wantsDetail(pov.altitude, wantFineRef.current);
      if (fine !== wantFineRef.current) {
        wantFineRef.current = fine;
        setWantFine(fine); // re-renders only when the camera crosses the threshold
      }
      if (!detailAskedRef.current && pov.altitude < DETAIL_PRELOAD_ALTITUDE) {
        detailAskedRef.current = true;
        onNeedDetailRef.current?.();
      }
      onZoomChangeRef.current(pov);
    };
    quakeLayer.setScale(pointScaleFor(engine.camera.altitude));
    quakeLayer.setHeightScale(heightScaleFor(engine.camera.altitude));

    const layers: Layers = { engine, areas, lines, rings, quakes: quakeLayer, markers };
    layersRef.current = layers;
    window.__seismoGlobe = layers;
    setReady(true);
    onReadyRef.current?.();

    return () => {
      if (announceTimer) clearTimeout(announceTimer);
      if (window.__seismoGlobe === layers) delete window.__seismoGlobe;
      layersRef.current = null;
      setReady(false);
      tip.remove();
      engine.destroy();
    };
  }, [helpId]);

  // ---- Map: countries, a selected country's subdivisions, a selected plate -----------------------
  const countryFeatures = useMemo<any[]>(
    () => (countries?.features ?? []).filter((f: any) => f.properties?.name !== 'Antarctica'),
    [countries]
  );
  // The same countries (same ids, so selection and clicks mean the same) with their 1:50m outlines.
  const fineCountryFeatures = useMemo<any[] | null>(() => {
    if (!detailedCountries || countryFeatures.length === 0) return null;
    const fineById = new Map<string, any>();
    for (const f of detailedCountries) fineById.set(String(f.id), f);
    return countryFeatures.map((f) => fineById.get(String(f.id)) ?? f);
  }, [countryFeatures, detailedCountries]);
  const detailActive = wantFine && fineReady && fineCountryFeatures !== null;
  diagExtraRef.current = { detail: detailActive ? '50m' : '110m', quakes: quakes.length };
  const shownCountries = detailActive ? fineCountryFeatures : countryFeatures;
  // A selected country's own administrative divisions replace that country's outline, while its
  // neighbours stay visible (and clickable) around it.
  const showingSubdivisions = (subdivisions?.length ?? 0) > 0;
  // The selected plate is drawn as a translucent polygon *below* the countries, so they stay
  // hoverable and clickable on top of it.
  useEffect(() => {
    const L = layersRef.current;
    if (!L || !ready) return;
    const specs: AreaSpec<AreaData>[] = [];
    if (selectedPlate?.geometry) {
      specs.push({ key: 'plate', geometry: selectedPlate.geometry, fill: PLATE_FILL, order: 0, data: { kind: 'plate', feature: selectedPlate } });
    }
    for (const f of shownCountries ?? countryFeatures) {
      const id = String(f.id);
      if (showingSubdivisions && id === selectedCountryId) continue; // replaced by its subdivisions
      const selected = !showingSubdivisions && id === selectedCountryId;
      specs.push({
        key: `c:${id}`,
        geometry: f.geometry,
        fill: selected ? SELECTED_FILL : COUNTRY_FILL,
        stroke: selected ? SELECTED_STROKE : COUNTRY_STROKE,
        strokeWidth: selected ? 1.5 : 1,
        order: selected ? 3 : 1,
        data: { kind: 'country', feature: f },
      });
    }
    (subdivisions ?? []).forEach((f: any, i: number) => {
      specs.push({
        key: `s:${i}`,
        geometry: f.geometry,
        fill: subdivisionColor(f.properties?.name ?? ''),
        stroke: SUBDIVISION_STROKE,
        strokeWidth: 1,
        order: 2,
        data: { kind: 'sub', feature: f },
      });
    });
    L.areas.setAreas(specs);
  }, [ready, countryFeatures, shownCountries, subdivisions, showingSubdivisions, selectedCountryId, selectedPlate]);

  // The fine borders are triangulated and outlined ahead of time, in short slices that leave the
  // main thread free, so that switching to them is only a copy.
  useEffect(() => {
    const L = layersRef.current;
    setFineReady(false);
    if (!L || !ready || !fineCountryFeatures) return;
    let cancelled = false;
    const specs: AreaSpec<AreaData>[] = fineCountryFeatures.map((f) => ({
      key: `c:${String(f.id)}`,
      geometry: f.geometry,
      fill: COUNTRY_FILL,
      stroke: COUNTRY_STROKE,
      strokeWidth: 1,
      order: 1,
    }));
    L.areas
      .prepare(specs, { cancelled: () => cancelled })
      .then(() => {
        if (!cancelled) setFineReady(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ready, fineCountryFeatures]);

  // ---- Plate boundaries and the "near me" circle -------------------------------------------------
  useEffect(() => {
    const L = layersRef.current;
    if (!L || !ready) return;
    const specs: LineSpec<LineData>[] = [];
    for (const p of radiusRing ? [...boundaries, radiusRing] : boundaries) {
      if (p.coords.length < 2) continue;
      const points = new Float64Array(p.coords.length * 2);
      p.coords.forEach(([lat, lng], i) => {
        points[i * 2] = lng;
        points[i * 2 + 1] = lat;
      });
      specs.push({ points, color: boundaryColor(p.boundaryType), width: boundaryWidth(p.boundaryType), data: { label: boundaryLabel(p) } });
    }
    L.lines.setLines(specs);
  }, [ready, boundaries, radiusRing]);

  // ---- Earthquakes ---------------------------------------------------------------------------------
  useEffect(() => {
    layersRef.current?.quakes.setQuakes(quakes);
  }, [ready, quakes]);

  // Pulsing seismic rings — a capped set (see parent) so the cost stays bounded however many quakes are shown.
  useEffect(() => {
    layersRef.current?.rings.setRings(
      pulseQuakes.map((q) => ({
        key: q.id,
        lat: q.lat,
        lng: q.lng,
        maxRadiusDeg: Math.max(2.5, (q.mag ?? 3) * 1.6),
        speedDegPerSec: Math.max(0.6, (q.mag ?? 3) * 0.5),
        color: magColor(q.mag),
      }))
    );
  }, [ready, pulseQuakes]);

  // ---- Markers: an arrow over each brand-new quake, and "you are here" -------------------------------
  const arrowElement = useCallback((q: QuakeFeature) => {
    const root = document.createElement('div');
    root.className = 'quake-arrow';
    root.style.setProperty('--arrow-color', magColor(q.mag));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quake-arrow__inner';
    btn.setAttribute('aria-label', `Sismo nuevo M${q.mag ?? '?'}: ${q.place ?? 'ubicación desconocida'}`);
    const label = document.createElement('span');
    label.className = 'quake-arrow__label';
    label.textContent = `NUEVO · M${q.mag !== null && q.mag !== undefined ? q.mag.toFixed(1) : '?'}`;
    const head = document.createElement('span');
    head.className = 'quake-arrow__head';
    head.textContent = '▼';
    btn.append(label, head);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onQuakeClickRef.current(q);
    });
    root.appendChild(btn);
    return root;
  }, []);

  useEffect(() => {
    const L = layersRef.current;
    if (!L || !ready) return;
    const specs: MarkerSpec[] = freshQuakes.map((q) => ({ id: `q:${q.id}`, lat: q.lat, lng: q.lng, create: () => arrowElement(q) }));
    if (userMarker) {
      const { lat, lng, label } = userMarker;
      specs.push({
        id: `user:${lat},${lng},${label}`,
        lat,
        lng,
        create: () => {
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
        },
      });
    }
    L.markers.setMarkers(specs);
  }, [ready, freshQuakes, userMarker, arrowElement]);

  // ---- Camera flights --------------------------------------------------------------------------------
  useEffect(() => {
    const L = layersRef.current;
    if (flyTo && ready && L) {
      // The flight starts only now (the request may have waited for the engine or a busy
      // main thread), so the parent's "ignore camera events during a flight" window starts now too.
      // People who asked for less motion get the new view at once instead of a flight.
      const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const duration = calm ? 0 : FLIGHT_MS;
      onFlightStartRef.current?.(duration);
      L.engine.flyTo({ lat: flyTo.lat, lng: flyTo.lng, altitude: flyTo.altitude }, duration);
    }
  }, [flyTo, ready]);

  // The diagnostics panel refreshes twice a second, only while it is shown.
  useEffect(() => {
    if (!diag || !ready) return;
    const update = () => {
      const el = diagRef.current;
      const L = layersRef.current;
      if (!el || !L) return;
      el.textContent = formatDiagnostics(L.engine.diagnostics(), diagExtraRef.current);
    };
    update();
    const id = window.setInterval(update, 500);
    return () => window.clearInterval(id);
  }, [diag, ready]);

  const copyDiagnostics = useCallback(async () => {
    const el = diagRef.current;
    if (!el) return;
    const text = el.textContent ?? '';
    try {
      await navigator.clipboard.writeText(`SeismoGlobe diag\n${text}\n${navigator.userAgent}`);
      el.dataset.copied = '1';
      window.setTimeout(() => {
        if (el.isConnected) delete el.dataset.copied;
      }, 1500);
    } catch {
      /* clipboard blocked: the text is on screen to read out */
    }
  }, []);

  return (
    <div ref={hostRef} className="globe-host">
      <p id={helpId} className="sr-only">
        Globo interactivo. Con el foco en el globo: las flechas lo giran (con Mayús, más rápido), más y menos acercan y
        alejan, y el cero o Inicio vuelven a la vista completa. Los sismos y los países también están en la lista y en el
        selector de país.
      </p>
      <div className="globe-keys" aria-hidden="true">
        <kbd>←</kbd><kbd>↑</kbd><kbd>↓</kbd><kbd>→</kbd> mover · <kbd>+</kbd><kbd>−</kbd> zoom · <kbd>0</kbd> vista completa
      </div>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {diag && !unsupported && (
        <button type="button" ref={diagRef} className="globe-diag" onClick={copyDiagnostics} aria-label="Diagnóstico del globo: tocar para copiar" />
      )}
      {unsupported && (
        <div className="globe-unsupported" role="alert">
          Tu navegador no admite WebGL 2, necesario para el globo 3D. La lista de sismos, las estadísticas y las alertas siguen funcionando.
        </div>
      )}
    </div>
  );
}
