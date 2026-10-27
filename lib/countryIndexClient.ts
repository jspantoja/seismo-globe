import { buildCountryIndex, type CountryIndex } from './countryAttribution';
import { loadDetailedCountryFeatures } from './countryDetail';

let pending: Promise<CountryIndex> | null = null;

/** The exact (1:50m) country index, built once. */
export function loadDetailedCountryIndex(): Promise<CountryIndex> {
  if (!pending) {
    pending = loadDetailedCountryFeatures()
      .then((features) => buildCountryIndex(features))
      .catch((err) => {
        pending = null; // allow a retry on the next selection
        throw err;
      });
  }
  return pending;
}
