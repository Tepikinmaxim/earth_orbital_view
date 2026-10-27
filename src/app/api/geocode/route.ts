import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

interface OmResult {
  name?: string
  country?: string
  latitude?: number
  longitude?: number
  population?: number
}

export interface GeoHit {
  id: string
  name: string
  country: string
  lat: number
  lon: number
  source: 'api'
}

/**
 * Прокси к бесплатному геокодеру Open-Meteo (без ключа, поддержка русского языка).
 * GET /api/geocode?q=Москва → { results: GeoHit[] }
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') ?? '').trim()
  if (q.length < 2) return NextResponse.json({ results: [] })

  const url =
    'https://geocoding-api.open-meteo.com/v1/search?name=' +
    encodeURIComponent(q) +
    '&count=8&language=ru&format=json'

  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 3500)
    const res = await fetch(url, { signal: ac.signal, cache: 'no-store' })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`status ${res.status}`)
    const data = (await res.json()) as { results?: OmResult[] }
    const results: GeoHit[] = (data.results ?? [])
      .filter((r) => typeof r.latitude === 'number' && typeof r.longitude === 'number')
      .map((r, i) => ({
        id: `api-${i}-${(r.latitude ?? 0).toFixed(2)}_${(r.longitude ?? 0).toFixed(2)}`,
        name: r.name ?? q,
        country: r.country ?? '',
        lat: r.latitude as number,
        lon: r.longitude as number,
        source: 'api' as const,
      }))
    return NextResponse.json({ results })
  } catch {
    // без интернета просто возвращаем пусто — работает офлайн-база
    return NextResponse.json({ results: [] })
  }
}
