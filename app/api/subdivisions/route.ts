import { NextRequest, NextResponse } from 'next/server';
import { getSubdivisionsForCountry } from '@/lib/subdivisions';

// The very first request on a cold instance downloads + parses the ~60MB
// Natural Earth admin-1 dataset; give it room beyond the 10s default.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const iso3 = (searchParams.get('iso3') ?? '').toUpperCase();

  if (!/^[A-Z]{3}$/.test(iso3)) {
    return NextResponse.json({ error: 'invalid_iso3', message: 'Código de país ISO3 inválido.' }, { status: 400 });
  }

  try {
    const features = await getSubdivisionsForCountry(iso3);
    return NextResponse.json(
      { iso3, features, unavailable: features.length === 0 },
      {
        status: 200,
        headers: {
          // s-maxage lets Vercel's CDN serve each country from the edge after the first hit.
          'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
        },
      }
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: 'subdivisions_unavailable',
        message: err instanceof Error ? err.message : 'No se pudieron obtener las divisiones administrativas.',
      },
      { status: 503 }
    );
  }
}
