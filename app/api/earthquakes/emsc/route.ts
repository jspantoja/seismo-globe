import { NextRequest, NextResponse } from 'next/server';
import { debugEmsc, getEmscQuakes } from '@/lib/emsc';
import { parseMinMag, parsePeriod } from '@/lib/usgs';

export const revalidate = 60; // EMSC asks not to cache live data for more than 10 minutes
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const period = parsePeriod(searchParams.get('period'));
  const minMag = parseMinMag(searchParams.get('minmag'));

  // Diagnostics: always HTTP 200 and never cached (see lib/emsc.ts).
  if (searchParams.get('debug') === '1') {
    const report = await debugEmsc(period, minMag);
    return NextResponse.json(report, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const data = await getEmscQuakes(period, minMag);
    return NextResponse.json(data, {
      status: 200,
      headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120' },
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'emsc_source_unavailable',
        message: err instanceof Error ? err.message : 'El servicio del EMSC no está disponible en este momento.',
      },
      { status: 503 }
    );
  }
}
