#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const LIMIT = Number.parseInt(process.env.CHART_LIMIT ?? '50', 10)
const OUTFILE = process.env.CHART_OUTFILE ?? 'public/data/chart-snapshot.json'
const SNAPSHOT_DIR = process.env.CHART_SNAPSHOT_DIR ?? 'public/data/snapshots'
const INDEX_FILE = process.env.CHART_INDEX_FILE ?? 'public/data/snapshot-index.json'
const SOURCE_NAME = 'Kworb Spotify Daily'
const SOURCE_URL = 'https://kworb.net/spotify/country/{country}_daily.html'

const COUNTRIES = [
  { code: 'US', storefront: 'us', mapId: '840', name: 'United States', region: 'North America', marketWeight: 1, lon: -98, lat: 39 },
  { code: 'CA', storefront: 'ca', mapId: '124', name: 'Canada', region: 'North America', marketWeight: 0.45, lon: -106, lat: 57 },
  { code: 'MX', storefront: 'mx', mapId: '484', name: 'Mexico', region: 'Latin America', marketWeight: 0.65, lon: -102, lat: 23 },
  { code: 'BR', storefront: 'br', mapId: '076', name: 'Brazil', region: 'Latin America', marketWeight: 0.75, lon: -52, lat: -10 },
  { code: 'AR', storefront: 'ar', mapId: '032', name: 'Argentina', region: 'Latin America', marketWeight: 0.38, lon: -64, lat: -34 },
  { code: 'CO', storefront: 'co', mapId: '170', name: 'Colombia', region: 'Latin America', marketWeight: 0.36, lon: -74, lat: 4 },
  { code: 'CL', storefront: 'cl', mapId: '152', name: 'Chile', region: 'Latin America', marketWeight: 0.28, lon: -71, lat: -30 },
  { code: 'PE', storefront: 'pe', mapId: '604', name: 'Peru', region: 'Latin America', marketWeight: 0.26, lon: -75, lat: -9 },
  { code: 'GB', storefront: 'gb', mapId: '826', name: 'United Kingdom', region: 'Europe', marketWeight: 0.7, lon: -2, lat: 54 },
  { code: 'FR', storefront: 'fr', mapId: '250', name: 'France', region: 'Europe', marketWeight: 0.6, lon: 2, lat: 46 },
  { code: 'DE', storefront: 'de', mapId: '276', name: 'Germany', region: 'Europe', marketWeight: 0.75, lon: 10, lat: 51 },
  { code: 'ES', storefront: 'es', mapId: '724', name: 'Spain', region: 'Europe', marketWeight: 0.48, lon: -4, lat: 40 },
  { code: 'IT', storefront: 'it', mapId: '380', name: 'Italy', region: 'Europe', marketWeight: 0.5, lon: 12, lat: 43 },
  { code: 'NL', storefront: 'nl', mapId: '528', name: 'Netherlands', region: 'Europe', marketWeight: 0.32, lon: 5, lat: 52 },
  { code: 'SE', storefront: 'se', mapId: '752', name: 'Sweden', region: 'Europe', marketWeight: 0.28, lon: 15, lat: 62 },
  { code: 'NO', storefront: 'no', mapId: '578', name: 'Norway', region: 'Europe', marketWeight: 0.22, lon: 8, lat: 61 },
  { code: 'FI', storefront: 'fi', mapId: '246', name: 'Finland', region: 'Europe', marketWeight: 0.2, lon: 26, lat: 64 },
  { code: 'PL', storefront: 'pl', mapId: '616', name: 'Poland', region: 'Europe', marketWeight: 0.34, lon: 19, lat: 52 },
  { code: 'TR', storefront: 'tr', mapId: '792', name: 'Turkey', region: 'MENA', marketWeight: 0.42, lon: 35, lat: 39 },
  { code: 'SA', storefront: 'sa', mapId: '682', name: 'Saudi Arabia', region: 'MENA', marketWeight: 0.32, lon: 45, lat: 24 },
  { code: 'AE', storefront: 'ae', mapId: '784', name: 'United Arab Emirates', region: 'MENA', marketWeight: 0.22, lon: 54, lat: 24 },
  { code: 'EG', storefront: 'eg', mapId: '818', name: 'Egypt', region: 'MENA', marketWeight: 0.36, lon: 30, lat: 27 },
  { code: 'NG', storefront: 'ng', mapId: '566', name: 'Nigeria', region: 'Africa', marketWeight: 0.42, lon: 8, lat: 9 },
  { code: 'ZA', storefront: 'za', mapId: '710', name: 'South Africa', region: 'Africa', marketWeight: 0.34, lon: 24, lat: -29 },
  { code: 'IN', storefront: 'in', mapId: '356', name: 'India', region: 'Asia', marketWeight: 0.9, lon: 78, lat: 22 },
  { code: 'ID', storefront: 'id', mapId: '360', name: 'Indonesia', region: 'Asia', marketWeight: 0.62, lon: 118, lat: -2 },
  { code: 'PH', storefront: 'ph', mapId: '608', name: 'Philippines', region: 'Asia', marketWeight: 0.38, lon: 122, lat: 13 },
  { code: 'TH', storefront: 'th', mapId: '764', name: 'Thailand', region: 'Asia', marketWeight: 0.36, lon: 101, lat: 15 },
  { code: 'VN', storefront: 'vn', mapId: '704', name: 'Vietnam', region: 'Asia', marketWeight: 0.34, lon: 106, lat: 16 },
  { code: 'MY', storefront: 'my', mapId: '458', name: 'Malaysia', region: 'Asia', marketWeight: 0.26, lon: 102, lat: 4 },
  { code: 'KR', storefront: 'kr', mapId: '410', name: 'South Korea', region: 'Asia', marketWeight: 0.55, lon: 128, lat: 36 },
  { code: 'JP', storefront: 'jp', mapId: '392', name: 'Japan', region: 'Asia', marketWeight: 0.8, lon: 138, lat: 37 },
  { code: 'AU', storefront: 'au', mapId: '036', name: 'Australia', region: 'Oceania', marketWeight: 0.42, lon: 134, lat: -25 },
  { code: 'NZ', storefront: 'nz', mapId: '554', name: 'New Zealand', region: 'Oceania', marketWeight: 0.16, lon: 172, lat: -41 },
  { code: 'SG', storefront: 'sg', name: 'Singapore', region: 'Asia', marketWeight: 0.18, lon: 104, lat: 1.35 },
]

const COLORS = [
  '#2563eb',
  '#d946ef',
  '#f59e0b',
  '#10b981',
  '#ef4444',
  '#ec4899',
  '#14b8a6',
  '#7c3aed',
  '#64748b',
  '#84cc16',
  '#f97316',
  '#06b6d4',
  '#22c55e',
  '#38bdf8',
  '#8b5cf6',
  '#dc2626',
  '#0ea5e9',
  '#65a30d',
]

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function stripTags(value) {
  return decodeHtml(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
}

function slugify(value) {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9가-힣ぁ-んァ-ン一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function hash(value) {
  let result = 0

  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) >>> 0
  }

  return result
}

function parseNumber(value) {
  const normalized = stripTags(value).replace(/[,+]/g, '')
  const parsed = Number.parseInt(normalized, 10)

  return Number.isFinite(parsed) ? parsed : 0
}

function parseChange(value) {
  const label = stripTags(value)

  if (label === '=' || label === 'NEW' || label === 'RE') {
    return 0
  }

  return Number.parseInt(label, 10) || 0
}

function parseRows(html) {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
  const parsedRows = []

  for (const row of rows) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1])

    if (cells.length < 7) {
      continue
    }

    const rank = parseNumber(cells[0])
    const artistTitleCell = cells[2]
    const anchors = [...artistTitleCell.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    const primaryArtist = anchors.find((anchor) => anchor[1].includes('/artist/'))
    const trackAnchor = anchors.find((anchor) => anchor[1].includes('/track/'))

    if (!rank || !primaryArtist || !trackAnchor) {
      continue
    }

    const artist = stripTags(primaryArtist[2])
    const title = stripTags(trackAnchor[2])
    const spotifyTrackId = trackAnchor[1].match(/track\/([^./]+)\.html/)?.[1]
    const spotifyArtistId = primaryArtist[1].match(/artist\/([^./]+)\.html/)?.[1]
    const trackId = spotifyTrackId ?? slugify(`${title}-${artist}`)
    const artistId = spotifyArtistId ?? slugify(artist)

    parsedRows.push({
      track: {
        id: trackId,
        title,
        artist,
        artistId,
        genre: 'Spotify',
        color: COLORS[hash(trackId) % COLORS.length],
        url: spotifyTrackId ? `https://open.spotify.com/track/${spotifyTrackId}` : undefined,
      },
      chartEntry: {
        trackId,
        rank,
        change: parseChange(cells[1]),
        peak: parseNumber(cells[4]) || rank,
        days: parseNumber(cells[3]) || 1,
        streams: parseNumber(cells[6]),
      },
    })

    if (parsedRows.length >= LIMIT) {
      break
    }
  }

  return parsedRows
}

async function fetchCountry(country) {
  const kworbCode = country.storefront.toLowerCase()
  const url = `https://kworb.net/spotify/country/${kworbCode}_daily.html`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)

  try {
    const response = await fetch(url, {
      headers: {
        accept: 'text/html',
        'user-agent': 'ChartAtlasMVP/0.1',
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`)
    }

    const html = await response.text()
    const date = html.match(/Spotify Daily Chart - .*? - ([0-9]{4}\/[0-9]{2}\/[0-9]{2})/)?.[1]
    const entries = parseRows(html)

    if (entries.length === 0) {
      throw new Error('empty chart')
    }

    return {
      country,
      date: date?.replaceAll('/', '-'),
      entries,
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function readSnapshotIndex() {
  try {
    return JSON.parse(await readFile(INDEX_FILE, 'utf8'))
  } catch {
    return { schemaVersion: 1, latestDate: '', snapshots: [] }
  }
}

async function writeSnapshotIndex(snapshot) {
  const current = await readSnapshotIndex()
  const file = `/data/snapshots/${snapshot.snapshotDate}.json`
  const entry = {
    date: snapshot.snapshotDate,
    file,
    sourceName: snapshot.sourceName,
    generatedAt: snapshot.generatedAt,
    countries: snapshot.countries.length,
    tracks: snapshot.tracks.length,
  }
  const byDate = new Map(
    [...(current.snapshots ?? []), entry].map((item) => [item.date, item]),
  )
  const snapshots = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date))
  const nextIndex = {
    schemaVersion: 1,
    latestDate: snapshots[0]?.date ?? snapshot.snapshotDate,
    snapshots,
  }

  await mkdir(path.dirname(INDEX_FILE), { recursive: true })
  await writeFile(INDEX_FILE, `${JSON.stringify(nextIndex, null, 2)}\n`)
}

async function main() {
  const trackById = new Map()
  const successfulCountries = []
  const countryCharts = []
  const failures = []
  const dates = new Map()

  for (const country of COUNTRIES) {
    try {
      const result = await fetchCountry(country)
      successfulCountries.push(country)
      countryCharts.push({
        countryCode: country.code,
        entries: result.entries.map((entry) => entry.chartEntry),
      })

      if (result.date) {
        dates.set(result.date, (dates.get(result.date) ?? 0) + 1)
      }

      for (const { track } of result.entries) {
        if (!trackById.has(track.id)) {
          trackById.set(track.id, track)
        }
      }

      console.log(`${country.code}: ${result.entries[0].track.title} - ${result.entries[0].track.artist}`)
    } catch (error) {
      failures.push({ countryCode: country.code, message: error.message })
      console.warn(`${country.code}: ${error.message}`)
    }
  }

  if (successfulCountries.length === 0) {
    throw new Error('No country charts could be collected.')
  }

  const now = new Date()
  const dominantDate = [...dates.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const snapshot = {
    schemaVersion: 1,
    sourceName: SOURCE_NAME,
    sourceUrl: SOURCE_URL,
    snapshotDate: dominantDate ?? now.toISOString().slice(0, 10),
    generatedAt: now.toISOString(),
    note: 'Kworb republishes Spotify country daily chart tables. This is a third-party source, but it tracks Spotify streaming charts much better than iTunes Store RSS.',
    countries: successfulCountries,
    tracks: [...trackById.values()],
    countryCharts,
    failures,
  }

  const datedOutfile = path.join(SNAPSHOT_DIR, `${snapshot.snapshotDate}.json`)

  await mkdir(path.dirname(OUTFILE), { recursive: true })
  await mkdir(SNAPSHOT_DIR, { recursive: true })
  await writeFile(OUTFILE, `${JSON.stringify(snapshot, null, 2)}\n`)
  await writeFile(datedOutfile, `${JSON.stringify(snapshot, null, 2)}\n`)
  await writeSnapshotIndex(snapshot)

  console.log(`\nWrote ${OUTFILE}`)
  console.log(`Wrote ${datedOutfile}`)
  console.log(`Updated ${INDEX_FILE}`)
  console.log(`${successfulCountries.length} countries, ${trackById.size} unique tracks`)

  if (failures.length > 0) {
    console.log(`${failures.length} failed countries`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
