import { NextRequest, NextResponse } from 'next/server';
import { debugSgc, getSgcQuakes } from '@/lib/sgc';
import { parseMinMag, parsePeriod } from '@/lib/usgs';

export const revalidate = 60;
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  // Diagnostics: always HTTP 200 and never cached, so a failing upstream can be
  // inspected from production (status codes, timings, a snippet of the body).
  if (searchParams.get('debug') === '1') {
    const report = await debugSgc();
    return NextResponse.json(report, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  }

  const period = parsePeriod(searchParams.get('period'));
  const minMag = parseMinMag(searchParams.get('minmag'));

  try {
    const data = await getSgcQuakes(period, minMag);
    return NextResponse.json(data, {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=30, stale-while-revalidate=180',
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'sgc_source_unavailable',
        message:
          err instanceof Error ? err.message : 'El servicio del SGC no está disponible en este momento.',
      },
      { status: 503 }
    );
  }
}
