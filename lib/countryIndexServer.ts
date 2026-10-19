import { feature } from 'topojson-client';
import { buildCountryIndex, type CountryIndex } from './countryAttribution';

/**
 * Country borders for server-side work, read from the world-atlas package
 * bundled with the app (Natural Earth 1:50m), so there is no network
 * dependency. Loaded on first use only and kept for the life of the instance.
 */
let pending: Promise<CountryIndex> | null = null;

export function getCountryIndex(): Promise<CountryIndex> {
  if (!pending) {
    pending = import('world-atlas/countries-50m.json')
      .then((m) => {
        const topology = m.default;
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
