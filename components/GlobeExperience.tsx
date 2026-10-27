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
  defaultAlertSettings,
  loadAlertSettings,
  saveAlertSettings,
  requestNotificationPermission,
  notifyQuake,
  notificationsSupported,
  pickAlert,
  type AlertSettings,
} from '@/lib/alerts';
import { mergeCitizenReports } from '@/lib/citizen';
import { fetchJsonFirst } from '@/lib/assets';
import { buildCountryIndex, countryIdOf, countryOf, queryBoxesFor, type CountryIndex } from '@/lib/countryAttribution';
import { loadDetailedCountryIndex } from '@/lib/countryIndexClient';
import { loadDetailedCountryFeatures } from '@/lib/countryDetail';
import { DEFAULT_RADIUS_KM, flightAltitudeFor, nearbyQuakes, radiusPath, type LatLng } from '@/lib/nearby';
import { describeLocateError, getPosition } from '@/lib/geolocate';
import { loadLastQuakes, saveLastQuakes } from '@/lib/localCache';
import { formatRelative } from '@/lib/format';
import SourcesModal from './SourcesModal';
import QuakeList from './QuakeList';
import NearbyPanel, { type NearCenter } from './NearbyPanel';
import { parseUrlState, buildSearch, periodCovering, minMagFor } from '@/lib/urlState';
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
  // Detailed borders (1:50m), loaded when a country is first selected; until then the globe's own 1:110m ones are used.
  const [detailedIndex, setDetailedIndex] = useState<CountryIndex | null>(null);
  // The 1:50m country outlines the globe draws when the camera is close (loaded on demand).
  const [detailFeatures, setDetailFeatures] = useState<any[] | null>(null);
  const [wantDetail, setWantDetail] = useState(false);
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
  const [listOpen, setListOpen] = useState(false);
  // "Cerca de mí": the position lives only in this component's memory — never stored, sent or put in a link.
  const [nearOpen, setNearOpen] = useState(false);
  const [nearCenter, setNearCenter] = useState<NearCenter | null>(null);
  const [nearRadius, setNearRadius] = useState<number>(DEFAULT_RADIUS_KM);
  const [nearLocating, setNearLocating] = useState(false);
  const [nearError, setNearError] = useState<string | null>(null);
  const nearOpenRef = useRef(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  // The page address is read once, after mount (not in the initial state, so the
  // server-rendered HTML and the first client render stay identical). Nothing is
  // fetched, and nothing is written back to the address, until that has happened.
  const [urlReady, setUrlReady] = useState(false);
  const [globeReady, setGlobeReady] = useState(false);
  const pendingUrlRef = useRef<{ country: string | null; plate: string | null; quake: string | null }>({
    country: null,
    plate: null,
    quake: null,
  });

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
  const [alertSettings, setAlertSettings] = useState<AlertSettings>(defaultAlertSettings);
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | 'unsupported'>('default');

  const knownIds = useRef<Set<string>>(new Set());
  const firstLoadUsgs = useRef(true);
  const firstLoadSgc = useRef(true);
  // Identifies the period/magnitude a source is currently being polled for, so a
  // slow response for a previous selection never overwrites a newer one.
  const usgsKeyRef = useRef('');
  const sgcKeyRef = useRef('');
  const emscKeyRef = useRef('');
  const alertSettingsRef = useRef(alertSettings);
  const countryBboxesRef = useRef<CountryBbox[]>([]);
  const alertIndexRef = useRef<CountryIndex | null>(null);
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
  nearOpenRef.current = nearOpen;
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
        // A few disputed territories (Kosovo, Somaliland, N. Cyprus) carry no ISO id:
        // give them the same stable id the country index uses so keys never collide.
        for (const f of fc.features ?? []) if (f.id === undefined || f.id === null) f.id = countryIdOf(f);
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

  // Alerts use the same country rule as the statistics and the list (territory, or
  // the nearest coast within 200 km at sea), with the detailed borders once loaded.
  const checkAlerts = useCallback((fresh: QuakeFeature[]) => {
    const settings = alertSettingsRef.current;
    const hit = pickAlert(
      fresh,
      settings,
      (q) => {
        const index = alertIndexRef.current;
        if (!index) return null;
        const id = countryOf(index, q.lng, q.lat);
        if (id === null) return null;
        return { id, name: countryBboxesRef.current.find((c) => c.id === id)?.name ?? id };
      },
      new Date()
    );
    if (!hit) return;
    setAlertToastQuake(hit.quake);
    if (settings.browserNotifications) notifyQuake(hit.quake, hit.countryName);
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
        if (usgsKeyRef.current !== `${p}_${mag}`) return; // the selection changed while this was in flight
        const data = json as EarthquakesResponse;
        handleNewQuakes(data.quakes, firstLoadUsgs.current);
        firstLoadUsgs.current = false;
        setUsgs({ data, error: null, loading: false });
        saveLastQuakes(p, mag, data);
      } catch (err) {
        if (usgsKeyRef.current !== `${p}_${mag}`) return;
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
        if (sgcKeyRef.current !== `${p}_${mag}`) return;
        const data = json as EarthquakesResponse;
        handleNewQuakes(data.quakes, firstLoadSgc.current);
        firstLoadSgc.current = false;
        setSgc({ data, error: null, loading: false });
      } catch (err) {
        if (sgcKeyRef.current !== `${p}_${mag}`) return;
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
      if (emscKeyRef.current !== `${p}_${mag}`) return;
      setEmsc({ data: json as EarthquakesResponse, error: null, loading: false });
    } catch (err) {
      if (emscKeyRef.current !== `${p}_${mag}`) return;
      setEmsc((prev) => ({ ...prev, error: err instanceof Error ? err.message : 'Error desconocido', loading: false }));
    }
  }, []);

  // Once, after mount: take the shareable state from the page address, then
  // open with the last live data this browser saw for that selection (clearly
  // labelled as saved) while the first live request is in flight, or if it
  // never succeeds.
  useEffect(() => {
    const url = parseUrlState(window.location.search);
    if (url.period) setPeriod(url.period);
    if (url.minMag !== null) setMinMag(url.minMag);
    if (url.sgc) setSgcEnabled(true);
    if (url.emsc) setEmscEnabled(true);
    if (url.list) setListOpen(true);
    pendingUrlRef.current = { country: url.country, plate: url.plate, quake: url.quake };

    const saved = loadLastQuakes(url.period ?? 'day', url.minMag ?? 0);
    if (saved) {
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
    }
    setUrlReady(true);
  }, []);

  useEffect(() => {
    if (!urlReady) return;
    usgsKeyRef.current = `${period}_${minMag}`;
    setUsgs((prev) => ({ ...prev, loading: true }));
    firstLoadUsgs.current = true;
    fetchUsgs(period, minMag);
    const id = setInterval(() => fetchUsgs(period, minMag), POLL_MS);
    return () => clearInterval(id);
  }, [urlReady, period, minMag, fetchUsgs]);

  useEffect(() => {
    if (!urlReady || !sgcEnabled) return;
    sgcKeyRef.current = `${period}_${minMag}`;
    setSgc((prev) => ({ ...prev, loading: true }));
    firstLoadSgc.current = true;
    fetchSgc(period, minMag);
    const id = setInterval(() => fetchSgc(period, minMag), POLL_MS);
    return () => clearInterval(id);
  }, [urlReady, sgcEnabled, period, minMag, fetchSgc]);

  useEffect(() => {
    if (!urlReady || !emscEnabled) return;
    emscKeyRef.current = `${period}_${minMag}`;
    setEmsc((prev) => ({ ...prev, loading: true }));
    fetchEmsc(period, minMag);
    const id = setInterval(() => fetchEmsc(period, minMag), POLL_MS);
    return () => clearInterval(id);
  }, [urlReady, emscEnabled, period, minMag, fetchEmsc]);

  // Keep the page address in step with the view, so copying it from the
  // browser shares what is on screen (the one-time `sismo` link is not kept).
  useEffect(() => {
    if (!urlReady) return;
    const search = buildSearch({
      period,
      minMag,
      sgc: sgcEnabled,
      emsc: emscEnabled,
      // A selection taken from the link that is still waiting for the globe stays in the address.
      country: selectedCountry?.id ?? pendingUrlRef.current.country,
      plate: selectedPlate?.info.code ?? pendingUrlRef.current.plate,
      list: listOpen,
    });
    try {
      if (search !== window.location.search) {
        window.history.replaceState(null, '', `${window.location.pathname}${search}`);
      }
    } catch {
      /* some embedded browsers do not allow it: the app works the same without */
    }
  }, [urlReady, period, minMag, sgcEnabled, emscEnabled, selectedCountry?.id, selectedPlate?.info.code, listOpen]);

  useEffect(() => {
    if (!linkCopied) return;
    const t = setTimeout(() => setLinkCopied(false), 2000);
    return () => clearTimeout(t);
  }, [linkCopied]);

  useEffect(() => {
    if (!linkNotice) return;
    const t = setTimeout(() => setLinkNotice(null), 10_000);
    return () => clearTimeout(t);
  }, [linkNotice]);

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

  // The detailed borders are needed once a country is in focus, and also for alerts
  // on specific countries (so a quake is attributed exactly as the statistics do).
  const needsDetailedBorders = !!selectedCountry || (alertSettings.enabled && alertSettings.countryIds.length > 0);
  useEffect(() => {
    if (!needsDetailedBorders || detailedIndex) return;
    let cancelled = false;
    loadDetailedCountryIndex()
      .then((index) => {
        if (!cancelled) setDetailedIndex(index);
      })
      .catch(() => {}); // keep using the coarse borders
    return () => {
      cancelled = true;
    };
  }, [needsDetailedBorders, detailedIndex]);

  const coarseIndex = useMemo(() => (countries ? buildCountryIndex(countries.features ?? []) : null), [countries]);
  alertIndexRef.current = detailedIndex ?? coarseIndex;

  // The globe's detailed borders: when the camera comes close, or a country is in focus.
  useEffect(() => {
    if (!(wantDetail || selectedCountry) || detailFeatures) return;
    let cancelled = false;
    loadDetailedCountryFeatures()
      .then((features) => {
        if (!cancelled) setDetailFeatures(features);
      })
      .catch(() => {}); // the light borders keep working
    return () => {
      cancelled = true;
    };
  }, [wantDetail, selectedCountry, detailFeatures]);
  const handleNeedDetail = useCallback(() => setWantDetail(true), []);

  const selectCountry = useCallback(async (feature: any, opts: { animate: boolean; altitude?: number }) => {
    const id = String(feature.id);
    const name = feature.properties?.name ?? 'País';
    const bbox = getMainBbox(feature.geometry);
    if (!bbox) return;

    setSelectedPlate(null); // country and plate focus are mutually exclusive
    setNearOpen(false);

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

  // Camera events fired by a programmatic flight must not be mistaken for the user zooming
  // over a country. The window is re-based when the flight actually starts.
  const handleFlightStart = useCallback((durationMs: number) => {
    flyingUntilRef.current = Math.max(flyingUntilRef.current, Date.now() + durationMs + 500);
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
      if (nearOpenRef.current) return; // "near me" is in focus: the camera is framing the user's circle
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
      setNearOpen(false);
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

  // The stats, alerts and list drawers share the right-hand side: one at a time.
  const openStats = useCallback(() => {
    setAlertsOpen(false);
    setListOpen(false);
    setNearOpen(false);
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
  if (linkNotice) banners.push(linkNotice);

  const nearItems = useMemo(
    () => (nearOpen && nearCenter ? nearbyQuakes(allQuakes, nearCenter, nearRadius) : []),
    [nearOpen, nearCenter, nearRadius, allQuakes]
  );
  const nearMarker = useMemo(
    () => (nearOpen && nearCenter ? { lat: nearCenter.lat, lng: nearCenter.lng, label: nearCenter.source === 'gps' ? 'Tú (aprox.)' : 'Punto elegido' } : null),
    [nearOpen, nearCenter]
  );
  const nearRing = useMemo(
    () => (nearOpen && nearCenter ? radiusPath(nearCenter, nearRadius) : null),
    [nearOpen, nearCenter, nearRadius]
  );

  const displayedQuakes = useMemo(() => {
    if (nearOpen && nearCenter) return nearItems.map((n) => n.quake);
    if (selectedPlate) {
      const { bbox, feature } = selectedPlate;
      return allQuakes.filter((q) => isInBbox(q.lng, q.lat, bbox) && pointInGeometry(q.lng, q.lat, feature.geometry));
    }
    if (!selectedCountry) return allQuakes;
    // A quake belongs to the country it is in, or (at sea) to the nearest one within
    // OFFSHORE_KM of its coast — the same rule the statistics use (lib/countryAttribution.ts).
    const index = detailedIndex ?? coarseIndex;
    const entry = index?.byId.get(selectedCountry.id);
    if (index && entry) {
      const boxes = queryBoxesFor(entry);
      const id = selectedCountry.id;
      return allQuakes.filter(
        (q) => boxes.some((b) => isInBbox(q.lng, q.lat, b)) && countryOf(index, q.lng, q.lat) === id
      );
    }
    // Borders not available (yet): fall back to a rectangle around the country.
    const padded = padBbox(selectedCountry.bbox, COUNTRY_QUAKE_PAD_DEG);
    return allQuakes.filter((q) => isInBbox(q.lng, q.lat, padded));
  }, [allQuakes, selectedCountry, selectedPlate, detailedIndex, coarseIndex, nearOpen, nearCenter, nearItems]);

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
        countryId: null,
      };
    }
    if (selectedCountry) {
      return {
        kind: 'country',
        label: `${flagEmoji(selectedCountry.alpha2)} ${selectedCountry.name}`.trim(),
        bbox: selectedCountry.bbox,
        plateCode: null,
        // The server resolves the real borders from this code (3-digit ISO numeric);
        // territories without one fall back to the rectangle.
        countryId: /^\d{3}$/.test(selectedCountry.id) ? selectedCountry.id : null,
      };
    }
    return { kind: 'world', label: '🌍 Todo el mundo', bbox: null, plateCode: null, countryId: null };
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

  const handleGlobeReady = useCallback(() => setGlobeReady(true), []);

  // ---- shareable links ----
  const copyLink = useCallback(async (url: string) => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      try {
        // Older browsers, or a page where the async clipboard is not allowed.
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (ok) setLinkCopied(true);
    else window.prompt('Copia este enlace:', url);
  }, []);

  const viewLink = () =>
    `${window.location.origin}${window.location.pathname}${buildSearch({
      period,
      minMag,
      sgc: sgcEnabled,
      emsc: emscEnabled,
      country: selectedCountry?.id ?? null,
      plate: selectedPlate?.info.code ?? null,
      list: true,
    })}`;

  // A link to one quake carries just what is needed to find it again.
  const quakeLink = (q: QuakeFeature) => {
    const p = periodCovering(Date.now() - q.time);
    return `${window.location.origin}${window.location.pathname}${buildSearch({
      period: p,
      minMag: minMagFor(q.mag, p),
      sgc: q.source === 'SGC',
      emsc: q.source === 'EMSC' || !!q.citizen,
      quake: q.id,
    })}`;
  };

  // ---- earthquakes near me ----
  const locateMe = useCallback(async () => {
    setNearLocating(true);
    setNearError(null);
    try {
      const p = await getPosition();
      setNearCenter({ lat: p.lat, lng: p.lng, source: 'gps' });
    } catch (err) {
      setNearError(describeLocateError(err));
    } finally {
      setNearLocating(false);
    }
  }, []);

  const toggleNear = useCallback(() => {
    if (nearOpen) {
      setNearOpen(false);
      return;
    }
    setStatsOpen(false);
    setAlertsOpen(false);
    setListOpen(false);
    // The circle replaces any country or plate focus (and its link parameters).
    setSelectedCountry(null);
    setSelectedPlate(null);
    selectedAltitudeRef.current = 0;
    setNearOpen(true);
    if (!nearCenter && !nearLocating) void locateMe();
  }, [nearOpen, nearCenter, nearLocating, locateMe]);

  const chooseNearPoint = useCallback((p: LatLng) => {
    setNearError(null);
    setNearCenter({ lat: p.lat, lng: p.lng, source: 'manual' });
  }, []);

  // Frame the circle whenever the point or the radius changes while the panel is open.
  useEffect(() => {
    if (!nearOpen || !nearCenter) return;
    setFlyTo({ lat: nearCenter.lat, lng: nearCenter.lng, altitude: flightAltitudeFor(nearRadius) });
  }, [nearOpen, nearCenter, nearRadius]);

  const handleListSelect = useCallback(
    (q: QuakeFeature) => {
      setSelectedQuake(q);
      locateQuake(q);
    },
    [locateQuake]
  );

  // Apply what the page address asked for as soon as the data it refers to exists.
  useEffect(() => {
    // Wait for the globe too: the camera flight that comes with a selection
    // would otherwise be lost, and zooming back out would then clear it.
    const id = pendingUrlRef.current.country;
    if (!id || !countries || !globeReady) return;
    pendingUrlRef.current.country = null;
    const feature = (countries.features ?? []).find(
      (f: any) => String(f.id).padStart(3, '0') === id.padStart(3, '0')
    );
    if (feature) selectCountry(feature, { animate: true });
  }, [countries, globeReady, selectCountry]);

  useEffect(() => {
    const code = pendingUrlRef.current.plate;
    if (!code || platePolygons.length === 0 || !globeReady) return;
    pendingUrlRef.current.plate = null;
    handlePlateSelectChange(code);
  }, [platePolygons, globeReady, handlePlateSelectChange]);

  useEffect(() => {
    const id = pendingUrlRef.current.quake;
    if (!id) return;
    const found = allQuakes.find((q) => q.id === id);
    if (found) {
      pendingUrlRef.current.quake = null;
      setSelectedQuake(found);
      locateQuake(found);
      return;
    }
    // Not there: wait until every enabled source has answered before giving up.
    const settled =
      !usgs.loading &&
      !!usgs.data &&
      (!sgcEnabled || !!sgc.data || !!sgc.error) &&
      (!emscEnabled || !!emsc.data || !!emsc.error);
    if (settled) {
      pendingUrlRef.current.quake = null;
      setLinkNotice('El sismo del enlace ya no está en el período mostrado. Prueba con un período más largo.');
    }
  }, [allQuakes, usgs, sgc, emsc, sgcEnabled, emscEnabled, locateQuake]);

  const maxMag = displayedQuakes.length ? Math.max(...displayedQuakes.map((q) => q.mag ?? 0)) : null;
  const shownToast = alertToastQuake ?? toastQuake;

  return (
    <div className="app-shell">
      <div className="globe-layer">
        <GlobeCanvas
          countries={countries}
          detailedCountries={detailFeatures}
          onNeedDetail={handleNeedDetail}
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
          onReady={handleGlobeReady}
          onFlightStart={handleFlightStart}
          userMarker={nearMarker}
          radiusRing={nearRing}
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
            className={`btn ${listOpen ? 'active' : ''}`}
            onClick={() => {
              setStatsOpen(false);
              setAlertsOpen(false);
              setNearOpen(false);
              setListOpen((v) => !v);
            }}
          >
            📋 Lista
          </button>
          <button className={`btn ${nearOpen ? 'active' : ''}`} onClick={toggleNear} aria-pressed={nearOpen}>
            📍 Cerca de mí
          </button>
          <button
            className={`btn ${alertSettings.enabled ? 'active' : ''}`}
            onClick={() => {
              setStatsOpen(false);
              setListOpen(false);
              setNearOpen(false);
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

      {listOpen && (
        <QuakeList
          quakes={displayedQuakes}
          scopeLabel={statsScope.label}
          linkCopied={linkCopied}
          onSelect={handleListSelect}
          onCopyLink={() => copyLink(viewLink())}
          onClose={() => setListOpen(false)}
        />
      )}

      {nearOpen && (
        <NearbyPanel
          center={nearCenter}
          locating={nearLocating}
          error={nearError}
          radiusKm={nearRadius}
          items={nearItems}
          periodLabel={`${PERIOD_LABEL[period]}${minMag > 0 ? ` · M${minMag}+` : ''}`}
          onRadius={setNearRadius}
          onLocate={locateMe}
          onManual={chooseNearPoint}
          onSelect={handleListSelect}
          onClose={() => setNearOpen(false)}
        />
      )}

      {!alertsOpen && !statsOpen && !listOpen && !nearOpen && !selectedCountry && selectedPlate && (
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

      {!alertsOpen && !statsOpen && !listOpen && !nearOpen && selectedCountry && (
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

      {selectedQuake && (
        <QuakeModal
          quake={selectedQuake}
          onClose={() => setSelectedQuake(null)}
          onCopyLink={() => copyLink(quakeLink(selectedQuake))}
          linkCopied={linkCopied}
        />
      )}
      {sourcesOpen && <SourcesModal onClose={() => setSourcesOpen(false)} />}
    </div>
  );
}
