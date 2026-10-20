import type { LatLng } from './nearby';

export type LocateErrorCode = 'unsupported' | 'denied' | 'unavailable' | 'timeout';

export class LocateError extends Error {
  constructor(public code: LocateErrorCode) {
    super(code);
  }
}

/**
 * Asks the browser for the device's position. It stays in this browser: nothing is
 * sent to a server or stored. Low accuracy is enough (and faster) for a radius of
 * tens of kilometres.
 */
export function getPosition(timeoutMs = 12000): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new LocateError('unsupported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new LocateError(err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable')),
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 5 * 60_000 }
    );
  });
}

export function describeLocateError(err: unknown): string {
  const code = err instanceof LocateError ? err.code : 'unavailable';
  switch (code) {
    case 'denied':
      return 'No diste permiso para usar tu ubicación. Puedes activarlo en los ajustes del sitio de tu navegador o escribir unas coordenadas.';
    case 'timeout':
      return 'Tu dispositivo tardó demasiado en dar la ubicación. Reintenta o escribe unas coordenadas.';
    case 'unsupported':
      return 'Este navegador no ofrece ubicación. Escribe unas coordenadas.';
    default:
      return 'No se pudo obtener tu ubicación. Reintenta o escribe unas coordenadas.';
  }
}
