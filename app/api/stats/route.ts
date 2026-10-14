import { NextRequest, NextResponse } from 'next/server';
import { getStats, parseStatsQuery, StatsError } from '@/lib/stats';

// One cold request downloads up to ~20,000 events from the USGS catalogue.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    const query = parseStatsQuery(new URL(req.url).searchParams);
    const data = await getStats(query);
    return NextResponse.json(data, {
      status: 200,
      headers: {
        // Historical statistics move slowly: let the CDN absorb repeat requests.
        'Cache-Control': 'public, max-age=300, s-maxage=21600, stale-while-revalidate=86400',
      },
    });
  } catch (err) {
    if (err instanceof StatsError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: 'stats_unavailable', message: err instanceof Error ? err.message : 'Estadísticas no disponibles.' },
      { status: 503 }
    );
  }
}
