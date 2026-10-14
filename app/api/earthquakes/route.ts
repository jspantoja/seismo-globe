import { NextRequest, NextResponse } from 'next/server';
import { getEarthquakes, parseMinMag, parsePeriod } from '@/lib/usgs';
import { debugEmscCatalog } from '@/lib/emsc';

export const revalidate = 45;
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const period = parsePeriod(searchParams.get('period'));
  const minMag = parseMinMag(searchParams.get('minmag'));

  // Diagnostics for the backup catalogue (always HTTP 200, never cached).
  if (searchParams.get('debug') === 'backup') {
    const report = await debugEmscCatalog(period, minMag);
    return NextResponse.json(report, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const data = await getEarthquakes(period, minMag);
    return NextResponse.json(data, {
      status: 200,
      headers: {
        // A backup response must not be pinned in shared caches for long.
        'Cache-Control': data.stale
          ? 'public, max-age=15, stale-while-revalidate=30'
          : 'public, max-age=30, stale-while-revalidate=180',
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'seismic_source_unavailable',
        message:
          err instanceof Error ? err.message : 'El servicio sísmico no está disponible en este momento.',
      },
      { status: 503 }
    );
  }
}
