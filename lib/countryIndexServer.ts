import { feature } from 'topojson-client';
import { fetchJsonFirst } from './assets';
import { buildCountryIndex, type CountryIndex } from './countryAttribution';

/**
 * Country borders for server-side work (Natural Earth 1:50m).
 *
 * Read first from the world-atlas package bundled with the app, so normally there
 * is no network dependency; if that copy cannot be loaded, the same pinned version
 * is requested from public CDNs. Loaded on first use and kept for the life of the
 * instance.
 */
const CDN_URLS = [
  'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json',
  'https://unpkg.com/world-atlas@2.0.2/countries-50m.json',
];

let pending: Promise<CountryIndex> | null = null;

async function loadTopology(): Promise<any> {
  try {
    return (await import('world-atlas/countries-50m.json')).default;
  } catch {
    return fetchJsonFirst(CDN_URLS, 20000);
  }
}

export function getCountryIndex(): Promise<CountryIndex> {
  if (!pending) {
    pending = loadTopology()
      .then((topology) => {
        const fc = feature(topology, topology.objects.countries) as any;
        return buildCountryIndex(fc.features ?? []);
      })
      .catch((err) => {
        pending = null;
        throw err;
      });
  }
  return pending;
}
