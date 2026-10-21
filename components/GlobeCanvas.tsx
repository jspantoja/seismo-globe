'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoundaryPath, QuakeFeature } from '@/lib/types';
import { magColor, sourceLabel } from '@/lib/format';
import { pointScaleFor } from '@/lib/globeView';
import { QuakeInstances, type QuakeLayerStyle } from '@/lib/quakeLayer';

const Globe = dynamic(() => import('react-globe.gl'), { ssr: false });

const FLIGHT_MS = 1200; // length of a programmatic camera flight

// Earthquakes are one instanced mesh (lib/quakeLayer.ts) with the look the library's own points had.
const QUAKE_STYLE: QuakeLayerStyle = {
  altitude: 0.018,
  radiusDeg: (q) => Math.max(0.2, (q.mag ?? 1) * 0.15),
  color: (q) => magColor(q.mag),
  resolution: 8,
};
const HOVER_SLOP_PX = 4; // extra reach around a dot for a mouse
const TOUCH_SLOP_PX = 12; // ... and for a finger
const CLICK_MOVE_PX = 5; // a press that moves further than this was a drag, not a click

/** Text of a quake's hover label (plain text: place names come from third-party feeds). */
function quakeTipText(q: QuakeFeature): string {
  return `M ${q.mag ?? '?'} — ${q.place ?? 'ubicación desconocida'}${q.source === 'USGS' ? '' : ` (${sourceLabel(q.source)})`}${
    q.citizen ? ` · 👥 ${q.citizen.reports} reportes` : ''
  }`;
}

// The app's own copy (scripts/fetch-assets.mjs) is used unless it fails to load.
const EARTH_TEXTURE_LOCAL = '/data/earth-dark.jpg';
const EARTH_TEXTURE_CDN = 'https://cdn.jsdelivr.net/npm/three-globe@2.31.1/example/img/earth-dark.jpg';

function subdivisionColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `hsla(${hue}, 55%, 55%, 0.28)`;
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

export default function GlobeCanvas({
  countries,
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
  const globeRef = useRef<any>(null);
  // The globe is loaded lazily: a camera flight requested before it exists
  // (e.g. a country taken from a shared link) is applied as soon as it does.
  const [globeReady, setGlobeReady] = useState(false);
  const [pointScale, setPointScale] = useState(1);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onFlightStartRef = useRef(onFlightStart);
  onFlightStartRef.current = onFlightStart;
  const handleGlobeReady = useCallback(() => {
    setGlobeReady(true);
    onReadyRef.current?.();
  }, []);

  // Probe the local texture once; if it is missing or broken, switch to the CDN.
  const [textureUrl, setTextureUrl] = useState(EARTH_TEXTURE_LOCAL);
  useEffect(() => {
    const probe = new Image();
    probe.onerror = () => setTextureUrl(EARTH_TEXTURE_CDN);
    probe.src = EARTH_TEXTURE_LOCAL;
    return () => {
      probe.onerror = null;
    };
  }, []);

  // ---- Earthquakes: one instanced mesh, with our own hover / click picking ----------------
  const layerRef = useRef<QuakeInstances<QuakeFeature> | null>(null);
  const pointScaleRef = useRef(pointScale);
  pointScaleRef.current = pointScale;
  const quakesRef = useRef(quakes);
  quakesRef.current = quakes;
  const onQuakeClickRef = useRef(onQuakeClick);
  onQuakeClickRef.current = onQuakeClick;
  // The library resolves a click over a dot to the country beneath it; this flag (raised for the
  // frame in which a dot was clicked) tells onPolygonClick to ignore that.
  const dotClickRef = useRef(false);
  const hideTipRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!globeReady || !globeRef.current) return;
    const globe = globeRef.current;
    const canvas: HTMLCanvasElement = globe.renderer().domElement;
    const host = canvas.parentElement;
    if (!host) return;

    const layer = new QuakeInstances<QuakeFeature>(globe.scene(), QUAKE_STYLE);
    layerRef.current = layer;
    layer.update(quakesRef.current, pointScaleRef.current);

    const tip = document.createElement('div');
    tip.className = 'quake-tip';
    tip.style.display = 'none';
    host.appendChild(tip);

    const pickAt = (ev: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const x = ev.clientX - r.left;
      const y = ev.clientY - r.top;
      const slop = ev.pointerType === 'mouse' ? HOVER_SLOP_PX : TOUCH_SLOP_PX;
      return { x, y, w: r.width, quake: layer.quakeAt(layer.pick(globe.camera(), r.width, r.height, x, y, slop)) };
    };

    const hideTip = () => {
      tip.style.display = 'none';
      host.classList.remove('quake-hover');
    };
    hideTipRef.current = hideTip;

    let frame = 0;
    let lastMove: PointerEvent | null = null;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerType !== 'mouse') return;
      if (ev.buttons !== 0) return hideTip(); // dragging the globe
      lastMove = ev;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!lastMove) return;
        const { x, y, w, quake } = pickAt(lastMove);
        if (!quake) return hideTip();
        tip.textContent = quakeTipText(quake);
        tip.style.display = 'block';
        host.classList.add('quake-hover');
        const width = tip.offsetWidth;
        tip.style.left = `${x + 14 + width > w ? Math.max(0, x - 14 - width) : x + 14}px`;
        tip.style.top = `${y + 14}px`;
      });
    };

    let down: { x: number; y: number } | null = null;
    const onDown = (ev: PointerEvent) => {
      down = { x: ev.clientX, y: ev.clientY };
      hideTip();
    };
    const onUp = (ev: PointerEvent) => {
      const start = down;
      down = null;
      if (ev.button !== 0 || !start) return;
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > (ev.pointerType === 'mouse' ? CLICK_MOVE_PX : CLICK_MOVE_PX * 2)) return;
      const { quake } = pickAt(ev);
      if (!quake) return;
      dotClickRef.current = true;
      // The library handles the same click in a frame callback queued before this one runs, so
      // clearing the flag in a later callback of the same frame covers it exactly.
      requestAnimationFrame(() => {
        dotClickRef.current = false;
      });
      onQuakeClickRef.current(quake);
    };

    canvas.addEventListener('pointermove', onMove, { passive: true });
    canvas.addEventListener('pointerdown', onDown, { passive: true });
    canvas.addEventListener('pointerup', onUp, { passive: true });
    canvas.addEventListener('pointerleave', hideTip, { passive: true });

    return () => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', hideTip);
      cancelAnimationFrame(frame);
      hideTipRef.current = () => {};
      tip.remove();
      host.classList.remove('quake-hover');
      layer.dispose();
      layerRef.current = null;
    };
  }, [globeReady]);

  useEffect(() => {
    layerRef.current?.update(quakes, pointScale);
  }, [quakes, pointScale, globeReady]);

  const countryFeatures = useMemo(
    () => (countries?.features ?? []).filter((f: any) => f.properties?.name !== 'Antarctica'),
    [countries]
  );

  // A selected country's own administrative divisions replace that country's
  // outline, while its neighbours stay visible (and clickable) around it.
  const subdivisionFeatures = useMemo(
    () =>
      (subdivisions ?? []).map((f: any) => ({ ...f, properties: { ...f.properties, __sub: true } })),
    [subdivisions]
  );
  const showingSubdivisions = subdivisionFeatures.length > 0;
  // The selected plate is drawn as a translucent polygon *below* the country
  // layer (lower altitude), so countries stay hoverable/clickable on top of it.
  const plateFeature = useMemo(
    () => (selectedPlate ? { ...selectedPlate, properties: { ...selectedPlate.properties, __plate: true } } : null),
    [selectedPlate]
  );
  const polygons = useMemo(() => {
    const base = showingSubdivisions
      ? [...countryFeatures.filter((f: any) => String(f.id) !== selectedCountryId), ...subdivisionFeatures]
      : countryFeatures;
    return plateFeature ? [plateFeature, ...base] : base;
  }, [showingSubdivisions, countryFeatures, subdivisionFeatures, selectedCountryId, plateFeature]);

  // Pulsing "seismic" rings — capped set (see parent) so the animation cost
  // stays bounded regardless of how many quakes are currently displayed.
  const rings = useMemo(
    () =>
      pulseQuakes.map((q) => ({
        lat: q.lat,
        lng: q.lng,
        maxR: Math.max(2.5, (q.mag ?? 3) * 1.6),
        color: magColor(q.mag),
        speed: Math.max(0.6, (q.mag ?? 3) * 0.5),
      })),
    [pulseQuakes]
  );

  // Arrow marker over each brand-new quake. The element factory must keep a
  // stable identity (the layer rebuilds every element when it changes), so the
  // click handler is reached through a ref.
  const arrowElement = useCallback((d: any) => {
    if (d.__user) {
      const marker = document.createElement('div');
      marker.className = 'user-marker';
      marker.setAttribute('role', 'img');
      marker.setAttribute('aria-label', d.label);
      const pulse = document.createElement('span');
      pulse.className = 'user-marker__pulse';
      const dot = document.createElement('span');
      dot.className = 'user-marker__dot';
      const label = document.createElement('span');
      label.className = 'user-marker__label';
      label.textContent = d.label;
      marker.append(pulse, dot, label);
      return marker;
    }
    const q = d as QuakeFeature;
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

  // Arrow markers for brand-new quakes, plus the "you are here" marker when there is one.
  const htmlElements = useMemo(
    () => (userMarker ? [...freshQuakes, { __user: true, id: '__user', ...userMarker }] : freshQuakes),
    [freshQuakes, userMarker]
  );
  const paths = useMemo(() => (radiusRing ? [...boundaries, radiusRing] : boundaries), [boundaries, radiusRing]);

  useEffect(() => {
    if (flyTo && globeReady && globeRef.current) {
      // The flight starts only now (the request may have waited for the globe or a busy
      // main thread), so the parent's "ignore camera events during a flight" window starts now too.
      onFlightStartRef.current?.(FLIGHT_MS);
      globeRef.current.pointOfView({ lat: flyTo.lat, lng: flyTo.lng, altitude: flyTo.altitude }, FLIGHT_MS);
    }
  }, [flyTo, globeReady]);

  return (
    <Globe
      ref={globeRef}
      onGlobeReady={handleGlobeReady}
      globeImageUrl={textureUrl}
      backgroundColor="rgba(0,0,0,0)"
      atmosphereColor="#4fd1c5"
      atmosphereAltitude={0.15}
      onZoom={(pov: any) => {
        hideTipRef.current(); // the globe moved under a resting pointer: the label is stale
        onZoomChange(pov);
        setPointScale(pointScaleFor(pov.altitude)); // no re-render unless the step changes
      }}
      // Country borders (or a selected country's own subdivisions)
      polygonsData={polygons}
      polygonsTransitionDuration={220}
      polygonCapColor={(d: any) => {
        if (d.properties?.__plate) return 'rgba(144, 133, 233, 0.24)';
        if (d.properties?.__sub) return subdivisionColor(d.properties?.name ?? '');
        if (!showingSubdivisions && String(d.id) === selectedCountryId) return 'rgba(79, 209, 197, 0.28)';
        return 'rgba(110, 140, 180, 0.12)';
      }}
      polygonSideColor={() => 'rgba(0,0,0,0)'}
      polygonStrokeColor={(d: any) => {
        if (d.properties?.__plate) return 'rgba(0,0,0,0)';
        if (d.properties?.__sub) return 'rgba(231, 236, 245, 0.6)';
        if (!showingSubdivisions && String(d.id) === selectedCountryId) return '#4fd1c5';
        return 'rgba(180, 200, 225, 0.4)';
      }}
      polygonAltitude={(d: any) =>
        d.properties?.__plate ? 0.002 : d.properties?.__sub ? 0.004 : !showingSubdivisions && String(d.id) === selectedCountryId ? 0.01 : 0.003
      }
      polygonLabel={(d: any) =>
        d.properties?.__plate
          ? `Placa ${d.properties?.PlateName ?? ''}`
          : d.properties?.__sub
          ? `${d.properties?.name ?? ''}${d.properties?.type ? ` (${d.properties.type})` : ''}`
          : `${d.properties?.name ?? ''}`
      }
      onPolygonClick={(d: any) => {
        // Subdivisions are informational; countries (including the neighbours
        // shown around a selected country) can be clicked to switch to them.
        if (dotClickRef.current) return; // the click was on an earthquake lying over this country
        if (!d.properties?.__sub && !d.properties?.__plate) onCountryClick(d);
      }}
      // Tectonic plate boundaries — emphasized layer, color-coded by type
      pathsData={paths}
      pathPoints={(d: any) => d.coords}
      pathColor={(d: any) => (d.boundaryType === 'near-radius' ? '#60a5fa' : d.boundaryType === 'subduction' ? '#ff8a3d' : '#7dd3fc')}
      pathStroke={(d: any) => (d.boundaryType === 'near-radius' ? 0.5 : d.boundaryType === 'subduction' ? 0.55 : 0.35)}
      pathLabel={(d: any) =>
        d.boundaryType === 'near-radius'
          ? `Radio de ${d.plateA} km`
          : `Límite de placas: ${d.plateA} — ${d.plateB}${d.boundaryType === 'subduction' ? ' (zona de subducción)' : ''}`
      }
      pathTransitionDuration={0}
      // Earthquakes are drawn by QuakeInstances (see above), not by the library's points layer.
      // Seismic pulse animation — the "puntos con animación de sismo" layer
      ringsData={rings}
      ringLat={(d: any) => d.lat}
      ringLng={(d: any) => d.lng}
      ringMaxRadius={(d: any) => d.maxR}
      ringResolution={32}
      ringColor={(d: any) => (t: number) => `${d.color}${Math.floor((1 - t) * 200).toString(16).padStart(2, '0')}`}
      ringPropagationSpeed={(d: any) => d.speed}
      ringRepeatPeriod={1100}
      // "Nuevo sismo" arrow marker (HTML layer; only a handful of fresh events)
      htmlElementsData={htmlElements}
      htmlLat={(d: any) => d.lat}
      htmlLng={(d: any) => d.lng}
      htmlAltitude={0.02}
      htmlElement={arrowElement}
      htmlTransitionDuration={0}
    />
  );
}
