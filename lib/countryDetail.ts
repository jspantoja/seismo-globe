import { fetchJsonFirst } from './assets';
import { countryIdOf } from './countryAttribution';

// The 1:50m borders are about 7 times larger than the 1:110m ones the globe starts with, so they are
// fetched only when they are needed: the camera comes close, or a country is in focus.
const DETAILED_COUNTRY_URLS = [
  '/data/countries-50m.json',
  'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json',
];

let pending: Promise<any[]> | null = null;

/**
 * The 1:50m country features (Natural Earth through world-atlas), loaded once and shared by the
 * globe's detailed borders and the exact country attribution. Features without an ISO id
 * (Kosovo, Somaliland...) get the same synthetic id the rest of the app uses.
 */
export function loadDetailedCountryFeatures(): Promise<any[]> {
  if (!pending) {
    pending = fetchJsonFirst(DETAILED_COUNTRY_URLS, 20000)
      .then(async (topology) => {
        const { feature } = await import('topojson-client');
        const fc = feature(topology, topology.objects.countries) as any;
        const features: any[] = fc.features ?? [];
        for (const f of features) if (f.id === undefined || f.id === null) f.id = countryIdOf(f);
        return features;
      })
      .catch((err) => {
        pending = null; // allow a retry later
        throw err;
      });
  }
  return pending;
}
