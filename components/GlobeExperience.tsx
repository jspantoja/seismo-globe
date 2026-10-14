'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import GlobeCanvas, { type FlyTo, type Pov } from './GlobeCanvas';
import QuakeModal from './QuakeModal';
import NewQuakeToast from './NewQuakeToast';
import Legend from './Legend';
import CountryPanel from './CountryPanel';
import PlatePanel from './PlatePanel';
import StatsPanel, { type StatsScope } from './StatsPanel';
import AlertSettingsPanel from './AlertSettings';
import {
  toBoundaryPaths,
  getBbox,
  getMainBbox,
  padBbox,
  isInBbox,
  pointInGeometry,
  normalizeWinding,
  mergeToMultiPolygon,
} from '@/lib/geo';
import { buildPlateList, plateInfo, plateCameraView, type PlateInfo } from '@/lib/plates';
import { resolveIsoCodes, flagEmoji, getSubdivisions, findIntersectingPlates } from '@/lib/countryData';
import {
  loadAlertSettings,
  saveAlertSettings,
  requestNotificationPermission,
  notifyQuake,
  notificationsSupported,
  type AlertSettings,
} from '@/lib/alerts';
import { mergeCitizenReports } from '@/lib/citizen';
import { fetchJsonFirst } from '@/lib/assets';
import { loadLastQuakes, saveLastQuakes } from '@/lib/localCache';
import { formatRelative } from '@/lib/format';
import SourcesModal from './SourcesModal';
import type { BoundaryPath, EarthquakesResponse, QuakeFeature } from '@/lib/types';

// Each layer is loaded from the app's own copy first (scripts/fetch-assets.mjs
// puts them in /data at build time), then from the public CDN as a fallback.
const COUNTRIES_TOPOJSON_URLS = [
  '/data/countries-110m.json',
  'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json',
];
const PLATE_BOUNDARIES_URLS = [
  '/data/PB2002_boundaries.json',
  'https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_boundaries.json',
];
const PLATE_POLYGONS_URLS = [
  '/data/PB2002_plates.json',
  'https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_plates.json',
];

type Period = 'hour' | 'day' | 'week' | 'month';

const PERIOD_LABEL: Record<Period, string> = {
  hour: 'Última hora',
  day: 'Últimas 24 h',
  week: 'Última semana',
  month: 'Último mes',
};

const POLL_MS = 60_000;
const TOAST_MS = 14_000;
const FRESH_WINDOW_MS = 5 * 60_000;
const PULSE_CAP = 40;
const DEFAULT_VIEW: FlyTo = { lat: 10, lng: -30, altitude: 2.2 };
const COUNTRY_QUAKE_PAD_DEG = 2.5;
const ZOOM_COUNTRY_THRESHOLD = 1.1; // altitude below which we try to detect a country under the camera
const ZOOM_CHECK_MS = 350; // throttle onZoom handling
const FLIGHT_GUARD_MS = 1700; // ignore zoom-based detection while a camera flight (1.2s) finishes

interface SourceState {
  data: EarthquakesResponse | null;
  error: string | null;
  loading: boolean;
}

interface SelectedCountry {
  id: string;
  name: string;
  geometry: any;
  bbox: [number, number, number, number];
  alpha2: string;
  alpha3: string;
}

interface SelectedPlate {
  info: PlateInfo;
  feature: any; // raw PB2002 feature (planar winding as published)
  bbox: [number, number, number, number];
}

interface CountryBbox {
  id: string;
  name: string;
  bbox: [number, number, number, number];
}

export default function GlobeExperience() {
  const [countries, setCountries] = useState<any | null>(null);
  const [boundaries, setBoundaries] = useState<BoundaryPath[]>([]);
  const [platePolygons, setPlatePolygons] = useState<any[]>([]);

  const [period, setPeriod] = useState<Period>('day');
  const [minMag, setMinMag] = useState(0);

  const [usgs, setUsgs] = useState<SourceState>({ data: null, error: null, loading: true });
  const [sgc, setSgc] = useState<SourceState>({ data: null, error: null, loading: false });
  const [sgcEnabled, setSgcEnabled] = useState(false);
  const [emsc, setEmsc] = useState<SourceState>({ data: null, error: null, loading: false });
  const [emscEnabled, setEmscEnabled] = useState(false);

  const [sourcesOpen, setSourcesOpen] = useState(false);

  const [selectedQuake, setSelectedQuake] = useState<QuakeFeature | null>(null);
  const [toastQuake, setToastQuake] = useState<QuakeFeature | null>(null);
  const [alertToastQuake, setAlertToastQuake] = useState<QuakeFeature | null>(null);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());

  const [selectedCountry, setSelectedCountry] = useState<SelectedCountry | null>(null);
  const [flyTo, setFlyTo] = useState<FlyTo | null>(null);
  const [intersectingPlates, setIntersectingPlates] = useState<string[] | null>(null);
  const [subdivisions, setSubdivisions] = useState<any[] | null>(null);
  const [subdivisionsLoading, setSubdivisionsLoading] = useState(false);
  const [subdivisionsUnavailable, setSubdivisionsUnavailable] = useState(false);

  const [selectedPlate, setSelectedPlate] = useState<SelectedPlate | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);

  const [alertsOpen, setAlertsOpen] = useState(false);
  const [alertSettings, setAlertSettings] = useState<AlertSettings>({
    enabled: false,
    countryIds: [],
    browserNotifications: false,
  });
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | 'unsupported'>('default');

  const knownIds = useRef<Set<string>>(new Set());
  const firstLoadUsgs = useRef(true);
  const firstLoadSgc = useRef(true);
  const alertSettingsRef = useRef(alertSettings);
  const countryBboxesRef = useRef<CountryBbox[]>([]);
  const selectedCountryIdRef = useRef<string | null>(null);
  const selectedPlateRef = useRef<SelectedPlate | null>(null);
  const lastZoomCheck = useRef(0);
  // Programmatic camera flights (country picked from the list / globe) fire
  // the same zoom events as user gestures; ignore them until the flight ends
  // so the country the camera merely passes over doesn't hijack the selection.
  const flyingUntilRef = useRef(0);
  // Camera altitude at which the current selection was made; zooming out well
  // beyond it clears the selection.
  const selectedAltitudeRef = useRef(0);

  // Load saved alert preferences once, client-side only.
  useEffect(() => {
    setAlertSettings(loadAlertSettings());
    setNotifPermission(notificationsSupported() ? Notification.permission : 'unsupported');
  }, []);

  alertSettingsRef.current = alertSettings;
  selectedCountryIdRef.current = selectedCountry?.id ?? null;
  selectedPlateRef.current = selectedPlate;

  // Load the geo reference layers once, straight from their public sources.
  // The globe itself renders immediately; these layer in as they arrive.
  useEffect(() => {
    let cancelled = false;

    fetchJsonFirst(COUNTRIES_TOPOJSON_URLS)
      .then(async (topology) => {
        if (cancelled) return;
        const { feature } = await import('topojson-client');
        const fc = feature(topology, topology.objects.countries) as any;
        setCountries(fc);
      })
      .catch(() => {});

    fetchJsonFirst(PLATE_BOUNDARIES_URLS)
      .then((fc) => {
        if (!cancelled) setBoundaries(toBoundaryPaths(fc));
      })
      .catch(() => {
        if (!cancelled) setBoundaries([]);
      });

    fetchJsonFirst(PLATE_POLYGONS_URLS)
      .then((fc) => {
        if (!cancelled) setPlatePolygons(fc.features ?? []);
      })
      .catch(() => {
        if (!cancelled) setPlatePolygons([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Precompute a bbox per country once, reused for zoom-based detection and
  // for matching alert-watched countries — avoids expensive ring tests on
  // every check.
  const countryBboxes = useMemo<CountryBbox[]>(() => {
    return (countries?.features ?? [])
      .filter((f: any) => f.properties?.name !== 'Antarctica')
      .map((f: any) => {
        // Main-landmass box: Russia, Fiji, ... would otherwise span the planet.
        const bbox = getMainBbox(f.geometry);
        return bbox ? { id: String(f.id), name: f.properties?.name ?? '', bbox } : null;
      })
      .filter((x: CountryBbox | null): x is CountryBbox => x !== null);
  }, [countries]);
  countryBboxesRef.current = countryBboxes;

  const checkAlerts = useCallback((fresh: QuakeFeature[]) => {
    const settings = alertSettingsRef.current;
    if (!settings.enabled || fresh.length === 0) return;

    const watchIds = new Set(settings.countryIds);
    let matched: QuakeFeature | null = null;
    let matchedCountryName: string | undefined;

    for (const q of fresh) {
      if (watchIds.size === 0) {
        matched = q; // no specific countries chosen => watch everywhere
        break;
      }
      const hit = countryBboxesRef.current.find(
        (c) => watchIds.has(c.id) && isInBbox(q.lng, q.lat, padBbox(c.bbox, 1.5))
      );
      if (hit) {
        matched = q;
        matchedCountryName = hit.name;
        break;
      }
    }

    if (matched) {
      setAlertToastQuake(matched);
      if (settings.browserNotifications) notifyQuake(matched, matchedCountryName);
    }
  }, []);

  const handleNewQuakes = useCallback(
    (quakes: QuakeFeature[], isFirstLoad: boolean) => {
      if (!isFirstLoad) {
        const fresh = quakes.filter((q) => !knownIds.current.has(q.id) && Date.now() - q.time < FRESH_WINDOW_MS);
        if (fresh.length > 0) {
          setFreshIds((prev) => new Set([...prev, ...fresh.map((q) => q.id)]));
          setToastQuake(fresh[0]);
          checkAlerts(fresh);
        }
      }
      quakes.forEach((q) => knownIds.current.add(q.id));
    },
    [checkAlerts]
  );

  const fetchUsgs = useCallback(
    async (p: Period, mag: number) => {
      try {
        const res = await fetch(`/api/earthquakes?period=${p}&minmag=${mag}`, { cache: 'no-store' });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.message ?? 'Error al obtener sismos del USGS');
        const data = json as EarthquakesResponse;
        handleNewQuakes(data.quakes, firstLoadUsgs.current);
        firstLoadUsgs.current = false;
        setUsgs({ data, error: null, loading: false });
        saveLastQuakes(p, mag, data);
      } catch (err) {
        setUsgs((prev) => ({ ...prev, error: err instanceof Error ? err.message : 'Error desconocido', loading: false }));
      }
    },
    [handleNewQuakes]
  );

  const fetchSgc = useCallback(
    async (p: Period, mag: number) => {
      try {
        const res = await fetch(`/api/earthquakes/sgc?period=${p}&minmag=${mag}`, { cache: 'no-store' });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.message ?? 'Error al obtener sismos del SGC');
        const data = json as EarthquakesResponse;
        handleNewQuakes(data.quakes, firstLoadSgc.current);
        firstLoadSgc.current = false;
        setSgc({ data, error: null, loading: false });
      } catch (err) {
        setSgc((prev) => ({ ...prev, error: err instanceof Error ? err.message : 'Error desconocido', loading: false }));
      }
    },
    [handleNewQuakes]
  );

  // EMSC citizen reports enrich events other networks already published (see
  // lib/citizen.ts), so they never trigger "new quake" toasts or alerts.
  const fetchEmsc = useCallback(async (p: Period, mag: number) => {
    try {
      const res = await fetch(`/api/earthquakes/emsc?period=${p}&minmag=${mag}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message ?? 'Error al obtener reportes ciudadanos del EMSC');
      setEmsc({ data: json as EarthquakesResponse, error: null, loading: false });
    } catch (err) {
      setEmsc((prev) => ({ ...prev, error: err instanceof Error ? err.message : 'Error desconocido', loading: false }));
    }
  }, []);

  // Open with the last live data this browser saw (clearly labelled as saved)
  // while the first live request is in flight, or if it never succeeds.
  useEffect(() => {
    const saved = loadLastQuakes('day', 0);
    if (!saved) return;
    setUsgs((prev) =>
      prev.data
        ? prev
        : {
            data: {
              ...saved.data,
              stale: true,
              staleReason: 'Datos guardados en este navegador; reconectando con el USGS…',
            },
            error: null,
            loading: true,
          }
    );
  }, []);

  useEffect(() => {
    setUsgs((prev) => ({ ...prev, loading: true }));
    firstLoadUsgs.current = true;
    fetchUsgs(period, minMag);
    const id = setInterval(() => fetchUsgs(period, minMag), POLL_MS);
    return () => clearInterval(id);
  }, [period, minMag, fetchUsgs]);

  useEffect(() => {
    if (!sgcEnabled) return;
    setSgc((prev) => ({ ...prev, loading: true }));
    firstLoadSgc.current = true;
    fetchSgc(period, minMag);
    const id = setInterval(() => fetchSgc(period, minMag), POLL_MS);
    return () => clearInterval(id);
  }, [sgcEnabled, period, minMag, fetchSgc]);

  useEffect(() => {
    if (!emscEnabled) return;
    setEmsc((prev) => ({ ...prev, loading: true }));
    fetchEmsc(period, minMag);
    const id = setInterval(() => fetchEmsc(period, minMag), POLL_MS);
    return () => clearInterval(id);
  }, [emscEnabled, period, minMag, fetchEmsc]);

  useEffect(() => {
    if (!toastQuake) return;
    const t = setTimeout(() => setToastQuake(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toastQuake]);

  useEffect(() => {
    if (!alertToastQuake) return;
    const t = setTimeout(() => setAlertToastQuake(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [alertToastQuake]);

  useEffect(() => {
    if (freshIds.size === 0) return;
    const t = setTimeout(() => setFreshIds(new Set()), FRESH_WINDOW_MS);
    return () => clearTimeout(t);
  }, [freshIds]);

  useEffect(() => {
    if (!selectedCountry) {
      setIntersectingPlates(null);
      return;
    }
    if (platePolygons.length === 0) return;
    setIntersectingPlates(findIntersectingPlates(selectedCountry.geometry, platePolygons));
  }, [selectedCountry, platePolygons]);

  useEffect(() => {
    if (!selectedCountry) {
      setSubdivisions(null);
      setSubdivisionsUnavailable(false);
      return;
    }
    if (!selectedCountry.alpha3) {
      setSubdivisionsUnavailable(true);
      setSubdivisionsLoading(false);
      return;
    }
    let cancelled = false;
    setSubdivisionsLoading(true);
    setSubdivisionsUnavailable(false);
    getSubdivisions(selectedCountry.alpha3).then((result) => {
      if (cancelled) return;
      setSubdivisions(result.unavailable ? null : result.features);
      setSubdivisionsUnavailable(result.unavailable);
      setSubdivisionsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedCountry]);

  const selectCountry = useCallback(async (feature: any, opts: { animate: boolean; altitude?: number }) => {
    const id = String(feature.id);
    const name = feature.properties?.name ?? 'País';
    const bbox = getMainBbox(feature.geometry);
    if (!bbox) return;

    setSelectedPlate(null); // country and plate focus are mutually exclusive

    if (opts.animate) {
      const [minLng, minLat, maxLng, maxLat] = bbox;
      const centerLng = (minLng + maxLng) / 2;
      const centerLat = (minLat + maxLat) / 2;
      const span = Math.max(maxLng - minLng, (maxLat - minLat) * 1.3);
      const altitude = Math.min(2.2, Math.max(0.25, span / 40));
      flyingUntilRef.current = Date.now() + FLIGHT_GUARD_MS;
      selectedAltitudeRef.current = altitude;
      setFlyTo({ lat: centerLat, lng: centerLng, altitude });
    } else {
      selectedAltitudeRef.current = opts.altitude ?? 0;
    }

    const codes = await resolveIsoCodes(id);
    setSelectedCountry({
      id,
      name,
      geometry: feature.geometry,
      bbox,
      alpha2: codes?.alpha2 ?? '',
      alpha3: codes?.alpha3 ?? '',
    });
  }, []);

  const clearSelection = useCallback((opts: { resetCamera: boolean }) => {
    setSelectedCountry(null);
    selectedAltitudeRef.current = 0;
    if (opts.resetCamera) {
      flyingUntilRef.current = Date.now() + FLIGHT_GUARD_MS;
      setFlyTo(DEFAULT_VIEW);
    }
  }, []);

  // "Se me acerco a un país" — as the camera zooms in over a country, select
  // it automatically; zooming back out clears it. Throttled + bbox-prefiltered.
  const handleZoomChange = useCallback(
    (pov: Pov) => {
      if (selectedPlateRef.current) return; // a plate is in focus: no country auto-detection
      const now = Date.now();
      if (now < flyingUntilRef.current) return; // camera is being flown programmatically
      if (now - lastZoomCheck.current < ZOOM_CHECK_MS) return;
      lastZoomCheck.current = now;

      const selectedId = selectedCountryIdRef.current;

      // Zoomed out well past where the selection was made -> back to world view.
      const clearAltitude = Math.max(ZOOM_COUNTRY_THRESHOLD, selectedAltitudeRef.current * 1.35);
      if (pov.altitude > clearAltitude) {
        if (selectedId) clearSelection({ resetCamera: false });
        return;
      }

      // Still looking at (or near) the selected country -> keep it.
      if (selectedId) {
        const current = countryBboxesRef.current.find((c) => c.id === selectedId);
        if (current && isInBbox(pov.lng, pov.lat, padBbox(current.bbox, 1.5))) return;
      }

      // Otherwise find the country actually under the camera: cheap bbox
      // prefilter, then a real point-in-polygon check on the candidates.
      if (pov.altitude <= ZOOM_COUNTRY_THRESHOLD) {
        const features: any[] = countries?.features ?? [];
        for (const c of countryBboxesRef.current) {
          if (!isInBbox(pov.lng, pov.lat, c.bbox)) continue;
          const feature = features.find((f: any) => String(f.id) === c.id);
          if (feature && pointInGeometry(pov.lng, pov.lat, feature.geometry)) {
            if (selectedId !== c.id) selectCountry(feature, { animate: false, altitude: pov.altitude });
            return;
          }
        }
      }
      if (selectedId) clearSelection({ resetCamera: false });
    },
    [countries, selectCountry, clearSelection]
  );

  const countryList = useMemo(
    () =>
      countryBboxes.map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name, 'es')),
    [countryBboxes]
  );

  const handleCountrySelectChange = useCallback(
    (id: string) => {
      if (!id) {
        clearSelection({ resetCamera: true });
        return;
      }
      const feature = (countries?.features ?? []).find((f: any) => String(f.id) === id);
      if (feature) selectCountry(feature, { animate: true });
    },
    [countries, selectCountry, clearSelection]
  );

  const clearPlate = useCallback((opts: { resetCamera: boolean }) => {
    setSelectedPlate(null);
    if (opts.resetCamera) {
      flyingUntilRef.current = Date.now() + FLIGHT_GUARD_MS;
      setFlyTo(DEFAULT_VIEW);
    }
  }, []);

  const handlePlateSelectChange = useCallback(
    (code: string) => {
      if (!code) {
        clearPlate({ resetCamera: true });
        return;
      }
      // A plate can come in several features (Kermadec is split at the antimeridian): merge them.
      const parts = platePolygons.filter((f: any) => String(f.properties?.Code ?? '').toUpperCase() === code);
      const feature =
        parts.length > 1 ? { ...parts[0], geometry: mergeToMultiPolygon(parts.map((f: any) => f.geometry)) } : parts[0];
      const bbox = feature ? getBbox(feature.geometry) : null;
      if (!feature || !bbox) return;
      const view = plateCameraView(feature.geometry);

      setSelectedCountry(null);
      selectedAltitudeRef.current = 0;
      setSelectedPlate({ info: plateInfo(feature), feature, bbox });
      if (view) {
        flyingUntilRef.current = Date.now() + FLIGHT_GUARD_MS;
        setFlyTo(view);
      }
    },
    [platePolygons, clearPlate]
  );

  const plateList = useMemo(() => buildPlateList(platePolygons), [platePolygons]);
  const majorPlates = useMemo(() => plateList.filter((p) => p.major), [plateList]);
  const otherPlates = useMemo(() => plateList.filter((p) => !p.major), [plateList]);

  // d3-geo reads a wrongly wound ring as "everything except this shape".
  const plateRenderFeature = useMemo(
    () =>
      selectedPlate
        ? { ...selectedPlate.feature, geometry: normalizeWinding(selectedPlate.feature.geometry) }
        : null,
    [selectedPlate]
  );

  const openStats = useCallback(() => {
    setAlertsOpen(false);
    setStatsOpen(true);
  }, []);

  const handleGlobeCountryClick = useCallback(
    (feature: any) => selectCountry(feature, { animate: true }),
    [selectCountry]
  );

  const handleAlertSettingsChange = useCallback((next: AlertSettings) => {
    setAlertSettings(next);
    saveAlertSettings(next);
  }, []);

  const handleRequestPermission = useCallback(async () => {
    const perm = await requestNotificationPermission();
    setNotifPermission(perm);
  }, []);

  const allQuakes = useMemo(() => {
    const base = [...(usgs.data?.quakes ?? []), ...(sgcEnabled ? sgc.data?.quakes ?? [] : [])];
    return emscEnabled && emsc.data ? mergeCitizenReports(base, emsc.data.quakes) : base;
  }, [usgs.data, sgc.data, sgcEnabled, emsc.data, emscEnabled]);

  // Source problems the person should know about, stacked above one another.
  const banners: string[] = [];
  if (usgs.error && !usgs.data) banners.push('No se pudo contactar al USGS todavía. Reintentando cada minuto…');
  if (usgs.data?.stale) {
    const backup = usgs.data.source.name.startsWith('EMSC');
    const age = usgs.data.source.fetchedAt ? formatRelative(Date.parse(usgs.data.source.fetchedAt)) : null;
    banners.push(
      backup
        ? 'El USGS no responde: se muestra el catálogo del EMSC como respaldo. Reintentando cada minuto…'
        : `Se muestran datos guardados${age ? ` (${age})` : ''} porque el USGS no responde. Reintentando cada minuto…`
    );
  }
  if (sgcEnabled && sgc.error && !sgc.data) {
    banners.push('No se pudo contactar al SGC todavía (fuente no oficial). Reintentando cada minuto…');
  }
  if (emscEnabled && emsc.error && !emsc.data) {
    banners.push('No se pudieron obtener los reportes ciudadanos del EMSC todavía. Reintentando cada minuto…');
  }

  const displayedQuakes = useMemo(() => {
    if (selectedPlate) {
      const { bbox, feature } = selectedPlate;
      return allQuakes.filter((q) => isInBbox(q.lng, q.lat, bbox) && pointInGeometry(q.lng, q.lat, feature.geometry));
    }
    if (!selectedCountry) return allQuakes;
    const padded = padBbox(selectedCountry.bbox, COUNTRY_QUAKE_PAD_DEG);
    return allQuakes.filter((q) => isInBbox(q.lng, q.lat, padded));
  }, [allQuakes, selectedCountry, selectedPlate]);

  // Bounded "seismic pulse" set: fresh events always included, topped up by
  // magnitude so the animation cost never scales with the full dataset.
  const pulseQuakes = useMemo(() => {
    const fresh = displayedQuakes.filter((q) => freshIds.has(q.id));
    const freshIdSet = new Set(fresh.map((q) => q.id));
    const rest = displayedQuakes.filter((q) => !freshIdSet.has(q.id)).sort((a, b) => (b.mag ?? 0) - (a.mag ?? 0));
    return [...fresh, ...rest].slice(0, PULSE_CAP);
  }, [displayedQuakes, freshIds]);

  const statsScope = useMemo<StatsScope>(() => {
    if (selectedPlate) {
      return {
        kind: 'plate',
        label: `🧭 Placa ${selectedPlate.info.name}`,
        bbox: null,
        plateCode: selectedPlate.info.code,
      };
    }
    if (selectedCountry) {
      return {
        kind: 'country',
        label: `${flagEmoji(selectedCountry.alpha2)} ${selectedCountry.name}`.trim(),
        bbox: selectedCountry.bbox,
        plateCode: null,
      };
    }
    return { kind: 'world', label: '🌍 Todo el mundo', bbox: null, plateCode: null };
  }, [selectedPlate, selectedCountry]);

  // Newest first, capped: the arrow layer is DOM-based and must stay tiny.
  const freshQuakes = useMemo(
    () =>
      displayedQuakes
        .filter((q) => freshIds.has(q.id))
        .sort((a, b) => b.time - a.time)
        .slice(0, 6),
    [displayedQuakes, freshIds]
  );

  const locateQuake = useCallback((q: QuakeFeature) => {
    flyingUntilRef.current = Date.now() + FLIGHT_GUARD_MS;
    setFlyTo({ lat: q.lat, lng: q.lng, altitude: 0.9 });
  }, []);

  const maxMag = displayedQuakes.length ? Math.max(...displayedQuakes.map((q) => q.mag ?? 0)) : null;
  const shownToast = alertToastQuake ?? toastQuake;

  return (
    <div className="app-shell">
      <div className="globe-layer">
        <GlobeCanvas
          countries={countries}
          boundaries={boundaries}
          quakes={displayedQuakes}
          pulseQuakes={pulseQuakes}
          freshQuakes={freshQuakes}
          onQuakeClick={setSelectedQuake}
          onCountryClick={handleGlobeCountryClick}
          selectedCountryId={selectedCountry?.id ?? null}
          subdivisions={subdivisions}
          selectedPlate={plateRenderFeature}
          flyTo={flyTo}
          onZoomChange={handleZoomChange}
        />
      </div>

      {usgs.loading && !usgs.data && (
        <div className="globe-loading">
          <div className="spinner" />
          <div>Cargando sismos en vivo…</div>
        </div>
      )}

      <div className="topbar">
        <div className="panel brand">
          <span
            className={`status-dot ${usgs.error ? 'error' : usgs.data?.stale ? 'stale' : ''}`}
            title={
              usgs.error
                ? 'Sin conexión con USGS'
                : usgs.data?.stale
                ? usgs.data.staleReason ?? 'Mostrando datos en caché'
                : 'En vivo'
            }
          />
          <div>
            <div className="brand__title">SeismoGlobe</div>
            <div className="brand__subtitle">Placas tectónicas · sismos en tiempo real</div>
          </div>
        </div>

        <div className="panel controls">
          <select
            className="country-select"
            value={selectedCountry?.id ?? ''}
            onChange={(e) => handleCountrySelectChange(e.target.value)}
          >
            <option value="">🌍 Todo el mundo</option>
            {countryList.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            className="country-select"
            value={selectedPlate?.info.code ?? ''}
            onChange={(e) => handlePlateSelectChange(e.target.value)}
            aria-label="Filtrar por placa tectónica"
            disabled={plateList.length === 0}
          >
            <option value="">🧭 Todas las placas</option>
            <optgroup label="Placas principales">
              {majorPlates.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Secundarias y microplacas">
              {otherPlates.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          </select>
        </div>

        <div className="panel controls">
          {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
            <button key={p} className={`btn ${period === p ? 'active' : ''}`} onClick={() => setPeriod(p)}>
              {PERIOD_LABEL[p]}
            </button>
          ))}
        </div>

        <div className="panel controls">
          {[
            { label: 'Todos', v: 0 },
            { label: 'M2.5+', v: 2.5 },
            { label: 'M4.5+', v: 4.5 },
          ].map((o) => (
            <button key={o.v} className={`btn ${minMag === o.v ? 'active' : ''}`} onClick={() => setMinMag(o.v)}>
              {o.label}
            </button>
          ))}
        </div>

        <div className="panel controls">
          <button
            className={`btn ${sgcEnabled ? 'active' : ''}`}
            onClick={() => setSgcEnabled((v) => !v)}
            title="Fuente comunitaria no oficial — autorización de republicación del SGC pendiente"
          >
            🇨🇴 SGC Colombia (no oficial){sgcEnabled && sgc.data ? ` · ${sgc.data.count}` : ''}
          </button>
          <button
            className={`btn ${emscEnabled ? 'active' : ''}`}
            onClick={() => setEmscEnabled((v) => !v)}
            title="Testimonios «¿lo sentiste?» del EMSC (CC BY 4.0). Preliminares; el número de reportes no mide daños."
          >
            👥 Reportes ciudadanos (EMSC){emscEnabled && emsc.data ? ` · ${emsc.data.count}` : ''}
          </button>
        </div>

        <div className="panel controls">
          <button
            className={`btn ${statsOpen ? 'active' : ''}`}
            onClick={() => (statsOpen ? setStatsOpen(false) : openStats())}
          >
            📊 Estadísticas
          </button>
          <button
            className={`btn ${alertSettings.enabled ? 'active' : ''}`}
            onClick={() => {
              setStatsOpen(false);
              setAlertsOpen((v) => !v);
            }}
          >
            🔔 Alertas
          </button>
        </div>
      </div>

      {alertsOpen && (
        <AlertSettingsPanel
          settings={alertSettings}
          countryList={countryList}
          notificationPermission={notifPermission}
          onChange={handleAlertSettingsChange}
          onRequestPermission={handleRequestPermission}
          onClose={() => setAlertsOpen(false)}
        />
      )}

      {statsOpen && <StatsPanel scope={statsScope} onClose={() => setStatsOpen(false)} />}

      {!alertsOpen && !statsOpen && !selectedCountry && selectedPlate && (
        <PlatePanel
          name={selectedPlate.info.name}
          code={selectedPlate.info.code}
          englishName={selectedPlate.info.englishName}
          major={selectedPlate.info.major}
          quakeCount={displayedQuakes.length}
          maxMag={maxMag}
          onOpenStats={openStats}
          onClose={() => clearPlate({ resetCamera: true })}
        />
      )}

      {!alertsOpen && !statsOpen && selectedCountry && (
        <CountryPanel
          name={selectedCountry.name}
          flag={flagEmoji(selectedCountry.alpha2)}
          plates={intersectingPlates}
          subdivisionsLoading={subdivisionsLoading}
          subdivisionsCount={subdivisions?.length ?? 0}
          subdivisionsUnavailable={subdivisionsUnavailable}
          quakeCount={displayedQuakes.length}
          maxMag={maxMag}
          onOpenStats={openStats}
          onClose={() => clearSelection({ resetCamera: true })}
        />
      )}

      <Legend
        quakeCount={displayedQuakes.length}
        sourceFetchedAt={usgs.data?.source.fetchedAt ?? null}
        sgcEnabled={sgcEnabled}
        emscEnabled={emscEnabled}
        onOpenSources={() => setSourcesOpen(true)}
      />

      {shownToast && (
        <NewQuakeToast
          quake={shownToast}
          isAlert={!!alertToastQuake}
          onLocate={() => {
            locateQuake(shownToast);
            setToastQuake(null);
            setAlertToastQuake(null);
          }}
          onClick={() => {
            setSelectedQuake(shownToast);
            setToastQuake(null);
            setAlertToastQuake(null);
          }}
        />
      )}

      {banners.map((text, i) => (
        <div key={text} className="panel error-banner" style={{ bottom: 16 + i * 62 }}>
          {text}
        </div>
      ))}

      {selectedQuake && <QuakeModal quake={selectedQuake} onClose={() => setSelectedQuake(null)} />}
      {sourcesOpen && <SourcesModal onClose={() => setSourcesOpen(false)} />}
    </div>
  );
}
