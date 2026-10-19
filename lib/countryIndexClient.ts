import { fetchJsonFirst } from './assets';
import { buildCountryIndex, type CountryIndex } from './countryAttribution';

// The 1:50m borders are about 7 times larger than the 1:110m ones the globe draws,
// so they are fetched only once a country is actually in focus.
const DETAILED_COUNTRY_URLS = [
  '/data/countries-50m.json',
  'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json',
];

let pending: Promise<CountryIndex> | null = null;

export function loadDetailedCountryIndex(): Promise<CountryIndex> {
  if (!pending) {
    pending = fetchJsonFirst(DETAILED_COUNTRY_URLS, 20000)
      .then(async (topology) => {
        const { feature } = await import('topojson-client');
        const fc = feature(topology, topology.objects.countries) as any;
        return buildCountryIndex(fc.features ?? []);
      })
      .catch((err) => {
        pending = null; // allow a retry on the next selection
        throw err;
      });
  }
  return pending;
}
