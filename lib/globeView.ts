/**
 * Quake points are drawn with a radius in degrees of arc: fine for the whole-planet view,
 * but a magnitude 5 dot would cover ~80 km of map when the camera is close. The size is
 * scaled with the camera altitude, in steps so the point layer is rebuilt only a few times.
 */
export const ALTITUDE_FAR = 2.2; // the default view: full size
export const ALTITUDE_NEAR = 0.15; // closest the app flies: a quarter of the size

export function pointScaleFor(altitude: number): number {
  const t = Math.min(1, Math.max(0, (altitude - ALTITUDE_NEAR) / (ALTITUDE_FAR - ALTITUDE_NEAR)));
  return Math.round((0.25 + 0.75 * t) * 10) / 10;
}

/**
 * Level of detail of the country borders. The globe starts with the light 1:110m set; once the camera
 * is close enough for its simplification to show (a pixel is about 13 km at altitude 1), it switches to
 * the 1:50m set. The switch has some hysteresis so a camera resting at the threshold does not flip.
 */
export const DETAIL_PRELOAD_ALTITUDE = 1.8; // start fetching and preparing the detailed set
export const DETAIL_ENTER_ALTITUDE = 1.0; // show it below this when coming in
export const DETAIL_LEAVE_ALTITUDE = 1.3; // go back to the light set above this when going out

export function wantsDetail(altitude: number, showingDetail: boolean): boolean {
  return showingDetail ? altitude < DETAIL_LEAVE_ALTITUDE : altitude < DETAIL_ENTER_ALTITUDE;
}

/** How close the camera is, in words (for people who cannot see the globe). */
export function distanceWords(altitude: number): string {
  if (altitude < 0.25) return 'muy cerca';
  if (altitude < 0.8) return 'cerca';
  if (altitude < 1.8) return 'a media distancia';
  return 'vista completa';
}

/** What a screen reader says after the view was moved with the keyboard. */
export function describeView(place: string | null, altitude: number, lat: number, lng: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'O';
  const coords = `${Math.abs(lat).toFixed(1)}° ${ns}, ${Math.abs(lng).toFixed(1)}° ${ew}`;
  return `Centro de la vista: ${place && place.trim() ? place.trim() : 'mar o zona sin país'} (${coords}), ${distanceWords(altitude)}.`;
}
