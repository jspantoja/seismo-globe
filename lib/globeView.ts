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
