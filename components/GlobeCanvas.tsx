'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoundaryPath, QuakeFeature } from '@/lib/types';
import { magColor, sourceLabel } from '@/lib/format';

/** The globe renders point labels as HTML; place names come from third-party feeds. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

const Globe = dynamic(() => import('react-globe.gl'), { ssr: false });

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
}: Props) {
  const globeRef = useRef<any>(null);
  // The globe is loaded lazily: a camera flight requested before it exists
  // (e.g. a country taken from a shared link) is applied as soon as it does.
  const [globeReady, setGlobeReady] = useState(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
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
  const onQuakeClickRef = useRef(onQuakeClick);
  onQuakeClickRef.current = onQuakeClick;
  const arrowElement = useCallback((d: any) => {
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

  useEffect(() => {
    if (flyTo && globeReady && globeRef.current) {
      globeRef.current.pointOfView({ lat: flyTo.lat, lng: flyTo.lng, altitude: flyTo.altitude }, 1200);
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
      onZoom={(pov: any) => onZoomChange(pov)}
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
        if (!d.properties?.__sub && !d.properties?.__plate) onCountryClick(d);
      }}
      // Tectonic plate boundaries — emphasized layer, color-coded by type
      pathsData={boundaries}
      pathPoints={(d: any) => d.coords}
      pathColor={(d: any) => (d.boundaryType === 'subduction' ? '#ff8a3d' : '#7dd3fc')}
      pathStroke={(d: any) => (d.boundaryType === 'subduction' ? 0.55 : 0.35)}
      pathLabel={(d: any) =>
        `Límite de placas: ${d.plateA} — ${d.plateB}${d.boundaryType === 'subduction' ? ' (zona de subducción)' : ''}`
      }
      pathTransitionDuration={0}
      // Earthquakes — flat points instead of tall extruded columns.
      // NOTE: pointsMerge was tried here for performance but broke individual
      // onPointClick hit-testing in practice (clicks fell through to the
      // polygon layer beneath), so it's intentionally left off — clicking a
      // quake to see its details matters more than the merge's GPU savings.
      pointsData={quakes}
      pointLat={(d: any) => d.lat}
      pointLng={(d: any) => d.lng}
      pointColor={(d: any) => magColor(d.mag)}
      pointAltitude={0.018}
      pointRadius={(d: any) => Math.max(0.2, (d.mag ?? 1) * 0.15)}
      pointResolution={8}
      pointLabel={(d: any) =>
        `M ${d.mag ?? '?'} — ${escapeHtml(String(d.place ?? 'ubicación desconocida'))}${
          d.source === 'USGS' ? '' : ` (${sourceLabel(d.source)})`
        }${d.citizen ? ` · 👥 ${d.citizen.reports} reportes` : ''}`
      }
      onPointClick={(d: any) => onQuakeClick(d as QuakeFeature)}
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
      htmlElementsData={freshQuakes}
      htmlLat={(d: any) => d.lat}
      htmlLng={(d: any) => d.lng}
      htmlAltitude={0.02}
      htmlElement={arrowElement}
      htmlTransitionDuration={0}
    />
  );
}
