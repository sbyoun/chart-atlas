import { useEffect, useMemo, useRef, useState } from 'react'
import { geoGraticule10, geoNaturalEarth1, geoPath } from 'd3-geo'
import type { Feature, FeatureCollection, Geometry } from 'geojson'
import {
  Crown,
  Globe2,
  Heart,
  Loader2,
  MapPin,
  Moon,
  Music2,
  Radio,
  Search,
  Sun,
  TrendingUp,
  UsersRound,
} from 'lucide-react'
import { feature } from 'topojson-client'
import type { GeometryCollection, Topology } from 'topojson-specification'
import worldAtlas from 'world-atlas/countries-110m.json'
import './App.css'
import AdSlot from './AdSlot'
import GenreDiscovery from './GenreDiscovery'
import PlaylistStudio from './PlaylistStudio'
import RisingDiscovery, { type RisingAnalysisSnapshot } from './RisingDiscovery'
import TasteDiscovery from './TasteDiscovery'
import { formatCount, pick, type Locale } from './i18n'
import {
  demoSnapshot,
  type ChartEntry,
  type ChartSnapshotData,
  type Country,
  type CountryChart,
  type Track,
} from './data/chartSnapshot'

type MainTab =
  | 'atlas'
  | 'genres'
  | 'rising'
  | 'taste'
  | 'playlists'
  | 'about'
  | 'privacy'
  | 'contact'
  | 'terms'
  | 'methodology'
type AnalysisTab = 'artist' | 'song'
type ThemeMode = 'light' | 'dark'

type SnapshotIndexEntry = {
  date: string
  file: string
  analysisFile?: string
  sourceName: string
  generatedAt?: string
  countries: number
  tracks: number
}

type SnapshotIndexData = {
  schemaVersion: 1
  latestDate: string
  snapshots: SnapshotIndexEntry[]
}

type AnalysisSnapshotData = {
  schemaVersion: 1
  sourceSnapshotDate: string
  generatedAt?: string
  trackStats: Array<{
    rank: number
    trackId: string
    title: string
    artist: string
    artistId: string
    genre: string
    color: string
    url?: string
    weightedScore: number
    appearances: number
    topOnes: number
    topTens: number
    bestRank: number
  }>
  artistStats: Array<{
    rank: number
    artistId: string
    artist: string
    color: string
    trackIds: string[]
    weightedScore: number
    appearances: number
    topOnes: number
    topTens: number
  }>
}

type InitialChartAtlasData = {
  schemaVersion: 1
  snapshotIndex: SnapshotIndexData
  latestSnapshot: ChartSnapshotData
}

type PlaylistStatus =
  | { type: 'idle'; message: string }
  | { type: 'working'; message: string }
  | { type: 'success'; message: string; url?: string }
  | { type: 'error'; message: string }

const CONTACT_EMAIL = import.meta.env.VITE_CONTACT_EMAIL || 'team@foldalpha.com'
const LOCALE_STORAGE_KEY = 'chart-atlas-locale'
const THEME_STORAGE_KEY = 'chart-atlas-theme'
const AUDIT_VISIT_STORAGE_KEY = 'chart-atlas-visit-id'
const FOOTER_PAGE_TABS = new Set<MainTab>(['about', 'privacy', 'contact', 'terms', 'methodology'])
const APP_BASE_PATH =
  import.meta.env.BASE_URL === '/' ? '' : import.meta.env.BASE_URL.replace(/\/$/, '')
const FOOTER_PAGE_PATHS: Record<
  Extract<MainTab, 'about' | 'privacy' | 'contact' | 'terms' | 'methodology'>,
  string
> = {
  about: 'about',
  privacy: 'privacy',
  contact: 'contact',
  terms: 'terms',
  methodology: 'methodology',
}

declare global {
  interface Window {
    __CHART_ATLAS_INITIAL_DATA__?: unknown
  }
}

function appPath(path = '') {
  return `${APP_BASE_PATH}/${path}`.replace(/\/+$/, '/') || '/'
}

function footerTabPath(tab: MainTab) {
  return FOOTER_PAGE_TABS.has(tab) ? appPath(FOOTER_PAGE_PATHS[tab as keyof typeof FOOTER_PAGE_PATHS]) : appPath()
}

function mainTabFromLocation(): MainTab {
  const hashTab = window.location.hash.replace('#', '')
  if (FOOTER_PAGE_TABS.has(hashTab as MainTab)) {
    return hashTab as MainTab
  }

  const relativePath = window.location.pathname
    .replace(new RegExp(`^${APP_BASE_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '')
    .replace(/^\/+|\/+$/g, '')
  const footerEntry = Object.entries(FOOTER_PAGE_PATHS).find(([, path]) => path === relativePath)
  return footerEntry ? (footerEntry[0] as MainTab) : 'atlas'
}

function initialLocale(): Locale {
  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
  return stored === 'ko' ? 'ko' : 'en'
}

function initialTheme(): ThemeMode {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  return stored === 'dark' ? 'dark' : 'light'
}

function initialMainTab(): MainTab {
  return mainTabFromLocation()
}

type RankedCountry = {
  country: Country
  entry: ChartEntry
}

type ChartMovement = {
  status: 'new' | 'up' | 'down' | 'same' | 'unknown' | 'loading'
  previousDate?: string
  previousRank?: number
  delta: number
}

type CountryChartEntry = ChartEntry & {
  movement: ChartMovement
}

type RankHistoryPoint = {
  date: string
  rank: number
}

type CountryRankSeries = {
  country: Country
  points: RankHistoryPoint[]
  bestRank: number
  latestRank?: number
  color: string
}

type ArtistRankHistoryPoint = RankHistoryPoint & {
  weightedScore: number
  appearances: number
  topOnes: number
  topTens: number
}

type TrackStat = {
  track: Track
  score: number
  weightedScore: number
  appearances: number
  topOnes: number
  topTens: number
  bestRank: number
  locality: number
  strongestRegion: string
  countryRanks: RankedCountry[]
}

type ArtistStat = {
  artistId: string
  artist: string
  color: string
  tracks: Track[]
  score: number
  weightedScore: number
  appearances: number
  topOnes: number
  topTens: number
  locality: number
  strongestRegion: string
  countryRanks: Array<RankedCountry & { track: Track; countryScore: number }>
}

type CountryRow = {
  country: Country
  chart: CountryChartEntry[]
  leadEntry?: CountryChartEntry
  leadTrack?: Track
}

type ChartModel = ChartSnapshotData & {
  countryByCode: Map<string, Country>
  countryByMapId: Map<string, Country>
  trackById: Map<string, Track>
  chartByCountry: Map<string, ChartEntry[]>
  trackStats: TrackStat[]
  artistStats: ArtistStat[]
  topTrack: TrackStat
  topArtist: ArtistStat
}

type MapFocus = {
  kind: AnalysisTab
  label: string
  color: string
  ranks: RankedCountry[]
}

type CountriesTopology = Topology<{
  countries: GeometryCollection<{ name: string }>
}>

const topology = worldAtlas as unknown as CountriesTopology
const worldFeatures = feature<{ name: string }>(
  topology,
  topology.objects.countries,
) as FeatureCollection<Geometry, { name: string }>

const APP_BASE_URL = import.meta.env.BASE_URL === '/' ? '' : import.meta.env.BASE_URL.replace(/\/$/, '')
const PLAYLIST_API_URL =
  import.meta.env.VITE_PLAYLIST_API_URL?.replace(/\/$/, '') ?? APP_BASE_URL
const RANK_SERIES_COLORS = [
  '#0f766e',
  '#2563eb',
  '#db2777',
  '#f97316',
  '#7c3aed',
  '#0891b2',
  '#65a30d',
  '#dc2626',
  '#4f46e5',
  '#c2410c',
  '#047857',
  '#9333ea',
]

function appUrl(path: string) {
  if (/^https?:\/\//.test(path)) {
    return path
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${APP_BASE_URL}${normalizedPath}`
}

function auditPath() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

function auditVisitId() {
  try {
    const existing = window.sessionStorage.getItem(AUDIT_VISIT_STORAGE_KEY)
    if (existing) {
      return existing
    }

    const next =
      window.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    window.sessionStorage.setItem(AUDIT_VISIT_STORAGE_KEY, next)
    return next
  } catch {
    return ''
  }
}

function sendAuditEvent(payload: {
  event: string
  tab?: MainTab
  locale?: Locale
  theme?: ThemeMode
  snapshotDate?: string
}) {
  const body = JSON.stringify({
    visitId: auditVisitId(),
    path: auditPath(),
    ...payload,
  })
  const url = appUrl('/api/audit/event')

  if (navigator.sendBeacon) {
    const sent = navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))
    if (sent) {
      return
    }
  }

  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {})
}

function rankScore(rank: number) {
  return Math.max(0, 101 - rank)
}

function formatScore(score: number) {
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 }).format(score)
}

function colorWithOpacity(hex: string, opacity: number) {
  const value = hex.replace('#', '')
  const red = Number.parseInt(value.slice(0, 2), 16)
  const green = Number.parseInt(value.slice(2, 4), 16)
  const blue = Number.parseInt(value.slice(4, 6), 16)

  return `rgba(${red}, ${green}, ${blue}, ${opacity})`
}

function regionSignal(countryRanks: RankedCountry[], countries: Country[]) {
  const regionCountryCounts = new Map<string, number>()
  const regionScores = new Map<string, number>()

  for (const country of countries) {
    regionCountryCounts.set(country.region, (regionCountryCounts.get(country.region) ?? 0) + 1)
  }

  for (const { country, entry } of countryRanks) {
    const score = rankScore(entry.rank)
    regionScores.set(country.region, (regionScores.get(country.region) ?? 0) + score)
  }

  const normalizedScores = [...regionScores.entries()].map(([region, score]) => [
    region,
    score / (regionCountryCounts.get(region) ?? 1),
  ]) as Array<[string, number]>
  const total = normalizedScores.reduce((sum, [, score]) => sum + score, 0)
  const strongest = normalizedScores.sort((a, b) => b[1] - a[1])[0]

  return {
    strongestRegion: strongest?.[0] ?? 'N/A',
    locality: strongest && total > 0 ? Math.round((strongest[1] / total) * 100) : 0,
  }
}

function buildTrackStats({
  countries,
  countryByCode,
  countryCharts,
  tracks,
}: {
  countries: Country[]
  countryByCode: Map<string, Country>
  countryCharts: CountryChart[]
  tracks: Track[]
}): TrackStat[] {
  return tracks
    .map((track) => {
      const countryRanks = countryCharts.flatMap((chart) => {
        const country = countryByCode.get(chart.countryCode)
        const entry = chart.entries.find((item) => item.trackId === track.id)

        return country && entry ? [{ country, entry }] : []
      })
      const { locality, strongestRegion } = regionSignal(countryRanks, countries)
      const score = countryRanks.reduce((sum, { entry }) => sum + rankScore(entry.rank), 0)
      const weightedScore = score

      return {
        track,
        score,
        weightedScore,
        appearances: countryRanks.length,
        topOnes: countryRanks.filter(({ entry }) => entry.rank === 1).length,
        topTens: countryRanks.filter(({ entry }) => entry.rank <= 10).length,
        bestRank: countryRanks.length
          ? Math.min(...countryRanks.map(({ entry }) => entry.rank))
          : 0,
        locality,
        strongestRegion,
        countryRanks: countryRanks.sort((a, b) => a.entry.rank - b.entry.rank),
      }
    })
    .sort((a, b) => b.weightedScore - a.weightedScore)
}

function buildArtistStats({
  chartByCountry,
  countries,
  trackById,
  tracks,
  trackStats,
}: {
  chartByCountry: Map<string, ChartEntry[]>
  countries: Country[]
  trackById: Map<string, Track>
  tracks: Track[]
  trackStats: TrackStat[]
}): ArtistStat[] {
  const artistIds = [...new Set(tracks.map((track) => track.artistId))]

  return artistIds
    .map((artistId) => {
      const artistTracks = tracks.filter((track) => track.artistId === artistId)
      const countryRanks = countries.flatMap((country) => {
        const entries = chartByCountry.get(country.code) ?? []
        const matchingEntries = entries
          .map((entry) => ({ entry, track: trackById.get(entry.trackId) }))
          .filter(
            (item): item is { entry: ChartEntry; track: Track } =>
              item.track?.artistId === artistId,
          )

        if (matchingEntries.length === 0) {
          return []
        }

        const best = matchingEntries.sort((a, b) => a.entry.rank - b.entry.rank)[0]
        const countryScore = rankScore(best.entry.rank)

        return [{ country, entry: best.entry, track: best.track, countryScore }]
      })
      const { locality, strongestRegion } = regionSignal(countryRanks, countries)
      const trackScore = trackStats
        .filter((stat) => stat.track.artistId === artistId)
        .reduce((sum, stat) => sum + stat.score, 0)
      const weightedScore = countryRanks.reduce((sum, item) => sum + item.countryScore, 0)

      return {
        artistId,
        artist: artistTracks[0].artist,
        color: artistTracks[0].color,
        tracks: artistTracks,
        score: trackScore,
        weightedScore,
        appearances: countryRanks.length,
        topOnes: countryRanks.filter(({ entry }) => entry.rank === 1).length,
        topTens: countryRanks.filter(({ entry }) => entry.rank <= 10).length,
        locality,
        strongestRegion,
        countryRanks: countryRanks.sort((a, b) => b.countryScore - a.countryScore),
      }
    })
    .sort((a, b) => b.weightedScore - a.weightedScore)
}

function isChartSnapshotData(value: unknown): value is ChartSnapshotData {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<ChartSnapshotData>

  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.sourceName === 'string' &&
    typeof candidate.snapshotDate === 'string' &&
    Array.isArray(candidate.countries) &&
    Array.isArray(candidate.tracks) &&
    Array.isArray(candidate.countryCharts) &&
    candidate.countries.length > 0 &&
    candidate.tracks.length > 0 &&
    candidate.countryCharts.length > 0
  )
}

function isSnapshotIndexData(value: unknown): value is SnapshotIndexData {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<SnapshotIndexData>

  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.latestDate === 'string' &&
    Array.isArray(candidate.snapshots)
  )
}

function isAnalysisSnapshotData(value: unknown): value is AnalysisSnapshotData {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<AnalysisSnapshotData>

  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.sourceSnapshotDate === 'string' &&
    Array.isArray(candidate.trackStats) &&
    Array.isArray(candidate.artistStats)
  )
}

function isInitialChartAtlasData(value: unknown): value is InitialChartAtlasData {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<InitialChartAtlasData>

  return (
    candidate.schemaVersion === 1 &&
    isSnapshotIndexData(candidate.snapshotIndex) &&
    isChartSnapshotData(candidate.latestSnapshot)
  )
}

function readInitialChartAtlasData() {
  if (typeof window === 'undefined' || !isInitialChartAtlasData(window.__CHART_ATLAS_INITIAL_DATA__)) {
    return null
  }

  const payload = window.__CHART_ATLAS_INITIAL_DATA__
  const latestDate = payload.snapshotIndex.latestDate || payload.latestSnapshot.snapshotDate
  const selectedDate =
    payload.latestSnapshot.snapshotDate === latestDate
      ? latestDate
      : payload.latestSnapshot.snapshotDate

  return {
    snapshot: payload.latestSnapshot,
    snapshotIndex: payload.snapshotIndex.snapshots,
    selectedDate,
  }
}

function previousSnapshotEntryForDate(
  snapshotIndex: SnapshotIndexEntry[],
  selectedDate: string,
) {
  const sortedEntries = [...snapshotIndex].sort((a, b) => b.date.localeCompare(a.date))
  const currentIndex = sortedEntries.findIndex((entry) => entry.date === selectedDate)

  return currentIndex >= 0 ? sortedEntries[currentIndex + 1] : undefined
}

function buildPreviousRankLookup(snapshot: ChartSnapshotData | null) {
  const ranksByCountry = new Map<string, Map<string, number>>()

  if (!snapshot) {
    return ranksByCountry
  }

  for (const chart of snapshot.countryCharts) {
    ranksByCountry.set(
      chart.countryCode,
      new Map(chart.entries.map((entry) => [entry.trackId, entry.rank])),
    )
  }

  return ranksByCountry
}

function movementForEntry({
  countryCode,
  entry,
  previousDate,
  previousLoading,
  previousRankLookup,
}: {
  countryCode: string
  entry: ChartEntry
  previousDate?: string
  previousLoading: boolean
  previousRankLookup: Map<string, Map<string, number>>
}): ChartMovement {
  if (!previousDate) {
    // While the previous week is still on its way, "no previous snapshot"
    // would be a false statement — keep the badge in a loading state instead.
    return { status: previousLoading ? 'loading' : 'unknown', delta: 0 }
  }

  const previousRank = previousRankLookup.get(countryCode)?.get(entry.trackId)

  if (!previousRank) {
    return { status: 'new', previousDate, delta: 0 }
  }

  const delta = previousRank - entry.rank

  if (delta > 0) {
    return { status: 'up', previousDate, previousRank, delta }
  }

  if (delta < 0) {
    return { status: 'down', previousDate, previousRank, delta }
  }

  return { status: 'same', previousDate, previousRank, delta }
}

function buildTrackRankHistory({
  snapshots,
  trackId,
  countries,
}: {
  snapshots: ChartSnapshotData[]
  trackId: string
  countries: Country[]
}): CountryRankSeries[] {
  const sortedSnapshots = [...snapshots].sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate))
  const countryByCode = new Map(countries.map((country) => [country.code, country]))
  const seriesByCountry = new Map<string, { country: Country; points: RankHistoryPoint[] }>()

  for (const historySnapshot of sortedSnapshots) {
    for (const chart of historySnapshot.countryCharts) {
      const entry = chart.entries.find((item) => item.trackId === trackId)
      const country =
        countryByCode.get(chart.countryCode) ||
        historySnapshot.countries.find((candidate) => candidate.code === chart.countryCode)

      if (!entry || !country) {
        continue
      }

      const current = seriesByCountry.get(country.code) || { country, points: [] }
      current.points.push({ date: historySnapshot.snapshotDate, rank: entry.rank })
      seriesByCountry.set(country.code, current)
    }
  }

  return [...seriesByCountry.values()]
    .map((series) => ({
      ...series,
      bestRank: Math.min(...series.points.map((point) => point.rank)),
      latestRank: series.points.at(-1)?.rank,
      color: '#0f766e',
    }))
    .sort((a, b) => {
      const latestRankA = a.latestRank ?? Number.POSITIVE_INFINITY
      const latestRankB = b.latestRank ?? Number.POSITIVE_INFINITY

      if (latestRankA !== latestRankB) {
        return latestRankA - latestRankB
      }

      if (a.bestRank !== b.bestRank) {
        return a.bestRank - b.bestRank
      }

      return a.country.code.localeCompare(b.country.code)
    })
    .map((series, index) => ({
      ...series,
      color: RANK_SERIES_COLORS[index % RANK_SERIES_COLORS.length],
    }))
}

function buildArtistRankHistory({
  snapshots,
  artistId,
}: {
  snapshots: ChartSnapshotData[]
  artistId: string
}): ArtistRankHistoryPoint[] {
  return [...snapshots]
    .sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate))
    .flatMap((historySnapshot) => {
      const model = buildModel(historySnapshot)
      const artistIndex = model.artistStats.findIndex((stat) => stat.artistId === artistId)

      if (artistIndex < 0) {
        return []
      }

      const artist = model.artistStats[artistIndex]

      if (artist.appearances === 0) {
        return []
      }

      return [
        {
          date: historySnapshot.snapshotDate,
          rank: artistIndex + 1,
          weightedScore: artist.weightedScore,
          appearances: artist.appearances,
          topOnes: artist.topOnes,
          topTens: artist.topTens,
        },
      ]
    })
}

function buildArtistRankHistoryFromAnalysis({
  analyses,
  artistId,
}: {
  analyses: AnalysisSnapshotData[]
  artistId: string
}): ArtistRankHistoryPoint[] {
  return [...analyses]
    .sort((a, b) => a.sourceSnapshotDate.localeCompare(b.sourceSnapshotDate))
    .flatMap((analysis) => {
      const artist = analysis.artistStats.find((stat) => stat.artistId === artistId)

      if (!artist || artist.appearances === 0) {
        return []
      }

      return [
        {
          date: analysis.sourceSnapshotDate,
          rank: artist.rank,
          weightedScore: artist.weightedScore,
          appearances: artist.appearances,
          topOnes: artist.topOnes,
          topTens: artist.topTens,
        },
      ]
    })
}

function buildModel(snapshot: ChartSnapshotData): ChartModel {
  const countryByCode = new Map(snapshot.countries.map((country) => [country.code, country]))
  const countryByMapId = new Map(
    snapshot.countries
      .filter((country) => country.mapId)
      .map((country) => [country.mapId as string, country]),
  )
  const trackById = new Map(snapshot.tracks.map((track) => [track.id, track]))
  const chartByCountry = new Map(
    snapshot.countryCharts.map((chart) => [chart.countryCode, chart.entries]),
  )
  const trackStats = buildTrackStats({
    countries: snapshot.countries,
    countryByCode,
    countryCharts: snapshot.countryCharts,
    tracks: snapshot.tracks,
  })
  const artistStats = buildArtistStats({
    chartByCountry,
    countries: snapshot.countries,
    trackById,
    tracks: snapshot.tracks,
    trackStats,
  })

  return {
    ...snapshot,
    countryByCode,
    countryByMapId,
    trackById,
    chartByCountry,
    trackStats,
    artistStats,
    topTrack: trackStats[0],
    topArtist: artistStats[0],
  }
}

function TrackName({ track }: { track: Track }) {
  return (
    <span className="track-name">
      <span className="track-dot" style={{ background: track.color }} />
      <span>
        <strong>{track.title}</strong>
        <small>{track.artist}</small>
      </span>
    </span>
  )
}

function RankTokens({
  ranks,
  onSelectCountry,
}: {
  ranks: RankedCountry[]
  onSelectCountry: (countryCode: string) => void
}) {
  return (
    <div className="rank-tokens">
      {ranks.slice(0, 4).map(({ country, entry }) => (
        <button
          key={`${country.code}-${entry.rank}`}
          type="button"
          onClick={() => onSelectCountry(country.code)}
          title={`${country.name} #${entry.rank}`}
        >
          {country.code} #{entry.rank}
        </button>
      ))}
      {ranks.length > 4 ? <span>+{ranks.length - 4}</span> : null}
    </div>
  )
}

const initialChartAtlasData = readInitialChartAtlasData()
const initialSnapshot = initialChartAtlasData?.snapshot ?? demoSnapshot
const initialSnapshotIndex = initialChartAtlasData?.snapshotIndex ?? []
const initialSelectedDate = initialChartAtlasData?.selectedDate ?? initialSnapshot.snapshotDate

function App() {
  const [mainTab, setMainTab] = useState<MainTab>(initialMainTab)
  const [locale, setLocale] = useState<Locale>(initialLocale)
  const [theme, setTheme] = useState<ThemeMode>(initialTheme)
  const [snapshot, setSnapshot] = useState<ChartSnapshotData>(initialSnapshot)
  const [snapshotIndex, setSnapshotIndex] = useState<SnapshotIndexEntry[]>(initialSnapshotIndex)
  const [selectedDate, setSelectedDate] = useState(initialSelectedDate)
  const [snapshotLoading, setSnapshotLoading] = useState(!initialChartAtlasData)
  const [snapshotFetchFailed, setSnapshotFetchFailed] = useState(false)
  const [previousSnapshot, setPreviousSnapshot] = useState<ChartSnapshotData | null>(null)
  // Start in the loading state whenever a previous week exists, so the very
  // first paint never claims "no previous snapshot" before the fetch effect runs.
  const [previousSnapshotLoading, setPreviousSnapshotLoading] = useState(() =>
    Boolean(previousSnapshotEntryForDate(initialSnapshotIndex, initialSelectedDate)),
  )
  const [snapshotHistory, setSnapshotHistory] = useState<ChartSnapshotData[]>([])
  const [snapshotHistoryLoading, setSnapshotHistoryLoading] = useState(false)
  const analysisWorkspaceRef = useRef<HTMLElement | null>(null)
  const [analysisHistory, setAnalysisHistory] = useState<AnalysisSnapshotData[]>([])
  const [analysisHistoryLoading, setAnalysisHistoryLoading] = useState(false)
  const [selectedCountryCode, setSelectedCountryCode] = useState('US')
  const [selectedTrackId, setSelectedTrackId] = useState(initialSnapshot.tracks[0].id)
  const [selectedArtistId, setSelectedArtistId] = useState(initialSnapshot.tracks[0].artistId)
  const [hoveredCountryCode, setHoveredCountryCode] = useState<string | null>(null)
  const [analysisTab, setAnalysisTab] = useState<AnalysisTab>('artist')
  const [query, setQuery] = useState('')
  const [playlistStatus, setPlaylistStatus] = useState<PlaylistStatus>({
    type: 'idle',
    message: pick(locale, 'Create a Spotify playlist from each country #1.', '국가별 1위 곡을 Spotify 플레이리스트로 생성합니다.'),
  })

  function changeLocale(nextLocale: Locale) {
    setLocale(nextLocale)
    window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale)
    document.documentElement.lang = nextLocale === 'ko' ? 'ko' : 'en'
  }

  function changeTheme(nextTheme: ThemeMode) {
    setTheme(nextTheme)
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme)
    document.documentElement.dataset.theme = nextTheme
  }

  function selectMainTab(tab: MainTab) {
    setMainTab(tab)
    if (FOOTER_PAGE_TABS.has(tab)) {
      window.history.pushState(null, '', footerTabPath(tab))
    } else if (window.location.pathname !== appPath() || window.location.hash) {
      window.history.pushState(null, '', appPath())
    }
  }

  useEffect(() => {
    document.documentElement.lang = locale === 'ko' ? 'ko' : 'en'
  }, [locale])

  useEffect(() => {
    function syncTabFromLocation() {
      setMainTab(mainTabFromLocation())
    }

    window.addEventListener('popstate', syncTabFromLocation)
    return () => window.removeEventListener('popstate', syncTabFromLocation)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    sendAuditEvent({
      event: 'tab.view',
      tab: mainTab,
      locale,
      theme,
      snapshotDate: selectedDate,
    })
  }, [locale, mainTab, selectedDate, theme])

  useEffect(() => {
    if (initialChartAtlasData) {
      return
    }

    let ignore = false

    async function loadInitialSnapshot() {
      try {
        const indexResponse = await fetch(`${appUrl('/data/snapshot-index.json')}?v=${Date.now()}`)

        if (indexResponse.ok) {
          const indexPayload: unknown = await indexResponse.json()

          if (isSnapshotIndexData(indexPayload) && indexPayload.snapshots.length > 0) {
            const latestDate = indexPayload.latestDate || indexPayload.snapshots[0].date
            const latestEntry =
              indexPayload.snapshots.find((item) => item.date === latestDate) ||
              indexPayload.snapshots[0]
            // Load the latest snapshot before the first paint so visitors never see
            // the bundled demo dataset flash in as if it were real chart data.
            const snapshotResponse = await fetch(`${appUrl(latestEntry.file)}?v=${Date.now()}`)
            const snapshotPayload: unknown = snapshotResponse.ok
              ? await snapshotResponse.json()
              : null

            if (!ignore) {
              setSnapshotIndex(indexPayload.snapshots)

              if (snapshotPayload && isChartSnapshotData(snapshotPayload)) {
                setSnapshot(snapshotPayload)
                setSelectedDate(snapshotPayload.snapshotDate)
              } else {
                // The selected-date effect retries the snapshot fetch.
                setSelectedDate(latestEntry.date)
              }
            }
            return
          }
        }

        const response = await fetch(`${appUrl('/data/chart-snapshot.json')}?v=${Date.now()}`)

        if (response.ok) {
          const payload: unknown = await response.json()

          if (!ignore && isChartSnapshotData(payload)) {
            setSnapshot(payload)
            setSelectedDate(payload.snapshotDate)
            setSnapshotIndex([
              {
                date: payload.snapshotDate,
                file: '/data/chart-snapshot.json',
                sourceName: payload.sourceName,
                generatedAt: payload.generatedAt,
                countries: payload.countries.length,
                tracks: payload.tracks.length,
              },
            ])
            return
          }
        }

        if (!ignore) {
          // The checked-in demo snapshot is the fallback when no collected data exists.
          setSnapshotFetchFailed(true)
        }
      } catch {
        if (!ignore) {
          setSnapshotFetchFailed(true)
        }
      } finally {
        if (!ignore) {
          setSnapshotLoading(false)
        }
      }
    }

    void loadInitialSnapshot()

    return () => {
      ignore = true
    }
  }, [])

  useEffect(() => {
    if (selectedDate === snapshot.snapshotDate) {
      return
    }

    const entry = snapshotIndex.find((item) => item.date === selectedDate)

    if (!entry) {
      return
    }

    const snapshotEntry = entry
    let ignore = false

    async function loadSelectedSnapshot() {
      setSnapshotLoading(true)

      try {
        const response = await fetch(`${appUrl(snapshotEntry.file)}?v=${Date.now()}`)

        if (!response.ok) {
          throw new Error(`snapshot fetch failed: ${response.status}`)
        }

        const payload: unknown = await response.json()

        if (!ignore && isChartSnapshotData(payload)) {
          setSnapshot(payload)
        }
      } catch {
        if (!ignore) {
          setSnapshotFetchFailed(true)
        }
      } finally {
        if (!ignore) {
          setSnapshotLoading(false)
        }
      }
    }

    void loadSelectedSnapshot()

    return () => {
      ignore = true
    }
  }, [selectedDate, snapshot.snapshotDate, snapshotIndex])

  useEffect(() => {
    const previousEntry = previousSnapshotEntryForDate(snapshotIndex, selectedDate)

    if (!previousEntry) {
      queueMicrotask(() => {
        setPreviousSnapshot(null)
        setPreviousSnapshotLoading(false)
      })
      return
    }

    const snapshotEntry = previousEntry
    let ignore = false

    async function loadPreviousSnapshot() {
      setPreviousSnapshotLoading(true)

      try {
        // Deterministic version param (not Date.now()) so the server-emitted
        // <link rel="preload"> for the previous week matches this request.
        const response = await fetch(
          `${appUrl(snapshotEntry.file)}?v=${encodeURIComponent(snapshotEntry.generatedAt || snapshotEntry.date)}`,
        )

        if (!response.ok) {
          throw new Error(`previous snapshot fetch failed: ${response.status}`)
        }

        const payload: unknown = await response.json()

        if (!ignore && isChartSnapshotData(payload)) {
          setPreviousSnapshot(payload)
        }
      } catch {
        if (!ignore) {
          setPreviousSnapshot(null)
        }
      } finally {
        if (!ignore) {
          setPreviousSnapshotLoading(false)
        }
      }
    }

    void loadPreviousSnapshot()

    return () => {
      ignore = true
    }
  }, [selectedDate, snapshotIndex])

  useEffect(() => {
    if (snapshotIndex.length === 0) {
      return
    }

    let ignore = false

    async function loadSnapshotHistory() {
      setSnapshotHistoryLoading(true)

      try {
        const snapshots = await Promise.all(
          snapshotIndex.map(async (entry) => {
            const response = await fetch(`${appUrl(entry.file)}?v=${Date.now()}`)

            if (!response.ok) {
              return null
            }

            const payload: unknown = await response.json()

            return isChartSnapshotData(payload) ? payload : null
          }),
        )

        if (!ignore) {
          setSnapshotHistory(snapshots.filter((item): item is ChartSnapshotData => Boolean(item)))
        }
      } catch {
        if (!ignore) {
          setSnapshotHistory([])
        }
      } finally {
        if (!ignore) {
          setSnapshotHistoryLoading(false)
        }
      }
    }

    void loadSnapshotHistory()

    return () => {
      ignore = true
    }
  }, [snapshotIndex])

  useEffect(() => {
    if (snapshotIndex.length === 0) {
      return
    }

    let ignore = false

    async function loadAnalysisHistory() {
      setAnalysisHistoryLoading(true)

      try {
        const analyses = await Promise.all(
          snapshotIndex.map(async (entry) => {
            const analysisFile = entry.analysisFile ?? `/data/analysis/${entry.date}.json`
            const response = await fetch(`${appUrl(analysisFile)}?v=${Date.now()}`)

            if (!response.ok) {
              return null
            }

            const payload: unknown = await response.json()

            return isAnalysisSnapshotData(payload) ? payload : null
          }),
        )

        if (!ignore) {
          setAnalysisHistory(analyses.filter((item): item is AnalysisSnapshotData => Boolean(item)))
        }
      } catch {
        if (!ignore) {
          setAnalysisHistory([])
        }
      } finally {
        if (!ignore) {
          setAnalysisHistoryLoading(false)
        }
      }
    }

    void loadAnalysisHistory()

    return () => {
      ignore = true
    }
  }, [snapshotIndex])

  const model = useMemo(() => buildModel(snapshot), [snapshot])
  // While the real snapshot is on its way, keep the demo dataset off screen; it
  // is only shown once every fetch path has failed.
  const initialDataPending = snapshot === demoSnapshot && !snapshotFetchFailed
  const {
    countries,
    chartByCountry,
    countryByCode,
    countryByMapId,
    trackById,
    tracks,
    trackStats,
    artistStats,
    topTrack,
  } = model
  const selectedCountry = countryByCode.get(selectedCountryCode) ?? countries[0]
  const selectedTrack = trackById.get(selectedTrackId) ?? topTrack.track
  const selectedTrackStat =
    trackStats.find((stat) => stat.track.id === selectedTrack.id) ?? topTrack
  const selectedArtist =
    artistStats.find((stat) => stat.artistId === selectedArtistId) ?? artistStats[0]
  const mapFocus: MapFocus =
    analysisTab === 'artist'
      ? {
          kind: 'artist',
          label: selectedArtist.artist,
          color: selectedArtist.color,
          ranks: selectedArtist.countryRanks,
        }
      : {
          kind: 'song',
          label: selectedTrack.title,
          color: selectedTrack.color,
          ranks: selectedTrackStat.countryRanks,
        }
  const hoveredCountry = hoveredCountryCode ? countryByCode.get(hoveredCountryCode) : undefined
  const normalizedQuery = query.trim().toLowerCase()
  const previousRankLookup = useMemo(
    () => buildPreviousRankLookup(previousSnapshot),
    [previousSnapshot],
  )
  const previousSnapshotDate = previousSnapshot?.snapshotDate
  const historicalSnapshots = useMemo(
    () =>
      (snapshotHistory.length > 0 ? snapshotHistory : [snapshot])
        .filter((item) => item.snapshotDate <= selectedDate)
        .sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate)),
    [selectedDate, snapshot, snapshotHistory],
  )
  const historicalAnalyses = useMemo(
    () =>
      analysisHistory
        .filter((item) => item.sourceSnapshotDate <= selectedDate)
        .sort((a, b) => a.sourceSnapshotDate.localeCompare(b.sourceSnapshotDate)),
    [analysisHistory, selectedDate],
  )
  const selectedTrackHistory = useMemo(
    () =>
      buildTrackRankHistory({
        snapshots: historicalSnapshots,
        trackId: selectedTrack.id,
        countries,
      }),
    [countries, historicalSnapshots, selectedTrack.id],
  )
  const selectedArtistHistory = useMemo(
    () => {
      if (historicalAnalyses.length > 0) {
        return buildArtistRankHistoryFromAnalysis({
          analyses: historicalAnalyses,
          artistId: selectedArtist.artistId,
        })
      }

      return buildArtistRankHistory({
        snapshots: historicalSnapshots,
        artistId: selectedArtist.artistId,
      })
    },
    [historicalAnalyses, historicalSnapshots, selectedArtist.artistId],
  )
  const rankHistoryDates = useMemo(
    () =>
      [
        ...new Set([
          ...historicalSnapshots.map((item) => item.snapshotDate),
          ...historicalAnalyses.map((item) => item.sourceSnapshotDate),
        ]),
      ].sort(),
    [historicalAnalyses, historicalSnapshots],
  )

  const countryRows = useMemo<CountryRow[]>(() => {
    return countries.map((country) => {
      const chart = (chartByCountry.get(country.code) ?? []).map((entry) => ({
        ...entry,
        movement: movementForEntry({
          countryCode: country.code,
          entry,
          previousDate: previousSnapshotDate,
          previousLoading: previousSnapshotLoading,
          previousRankLookup,
        }),
      }))
      const leadEntry = chart[0]
      const leadTrack = leadEntry ? trackById.get(leadEntry.trackId) : undefined

      return { country, chart, leadEntry, leadTrack }
    })
  }, [chartByCountry, countries, previousRankLookup, previousSnapshotDate, previousSnapshotLoading, trackById])

  const songRows = useMemo(() => {
    return trackStats.filter((stat) => {
      if (!normalizedQuery) {
        return true
      }

      return [stat.track.title, stat.track.artist, stat.track.genre, stat.strongestRegion].some(
        (value) => value.toLowerCase().includes(normalizedQuery),
      )
    })
  }, [normalizedQuery, trackStats])

  const artistRows = useMemo(() => {
    return artistStats.filter((stat) => {
      if (!normalizedQuery) {
        return true
      }

      return [stat.artist, stat.strongestRegion, ...stat.tracks.map((track) => track.title)].some(
        (value) => value.toLowerCase().includes(normalizedQuery),
      )
    })
  }, [artistStats, normalizedQuery])

  function selectCountry(countryCode: string) {
    setSelectedCountryCode(countryCode)
  }

  function selectTrack(trackId: string) {
    const track = trackById.get(trackId)

    setSelectedTrackId(trackId)
    setAnalysisTab('song')

    if (track) {
      setSelectedArtistId(track.artistId)
    }
  }

  function selectTrackFromBoard(trackId: string) {
    setQuery('')
    selectTrack(trackId)
  }

  // The insight pill promises a map story; clicking it selects the top track
  // (map highlight + song panel) and brings the below-the-fold map into view.
  function focusTopTrackOnMap() {
    selectTrackFromBoard(topTrack.track.id)
    // Deferred past the commit so the analysis table's own selected-row
    // scroll (block: 'nearest') cannot override this page-level scroll.
    window.setTimeout(() => {
      analysisWorkspaceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 150)
  }

  function selectArtist(artistId: string) {
    setSelectedArtistId(artistId)
    setAnalysisTab('artist')
  }

  async function createTopOnesPlaylist() {
    const trackUris = [
      ...new Set(
        countryRows.flatMap((row) => {
          const track = row.leadTrack

          if (!track) {
            return []
          }

          return [`spotify:track:${track.id}`]
        }),
      ),
    ]

    if (trackUris.length === 0) {
      setPlaylistStatus({
        type: 'error',
        message: pick(locale, 'There are no #1 tracks to add to a playlist.', '플레이리스트로 만들 1위 곡이 없습니다.'),
      })
      return
    }

    setPlaylistStatus({
      type: 'working',
      message: pick(
        locale,
        `Creating a Spotify playlist with ${trackUris.length} tracks.`,
        `${trackUris.length}곡으로 Spotify 플레이리스트를 생성하는 중입니다.`,
      ),
    })

    try {
      const response = await fetch(`${PLAYLIST_API_URL}/api/playlists/create-from-tracks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Chart Atlas #1s ${snapshot.snapshotDate}`,
          description: pick(
            locale,
            `${snapshot.sourceName} ${snapshot.snapshotDate} country #1 tracks.`,
            `${snapshot.sourceName} ${snapshot.snapshotDate} 국가별 1위 곡 모음`,
          ),
          trackUris,
          public: false,
        }),
      })
      const payload: unknown = await response.json()

      if (!response.ok || !payload || typeof payload !== 'object') {
        const message =
          payload && typeof payload === 'object' && 'error' in payload
            ? String((payload as { error?: unknown }).error)
            : pick(locale, 'Failed to create the Spotify playlist.', 'Spotify 플레이리스트 생성에 실패했습니다.')

        throw new Error(message)
      }

      const playlist = (payload as { playlist?: { openUrl?: string; name?: string } }).playlist
      const url = playlist?.openUrl

      if (!url) {
        throw new Error(pick(locale, 'Spotify playlist URL was not returned.', 'Spotify 플레이리스트 URL을 받지 못했습니다.'))
      }

      // Spotify can take a couple of minutes to expose a fresh playlist in the
      // web player, so opening it automatically often lands on a 404. Leave a
      // link the visitor clicks when ready instead.
      setPlaylistStatus({
        type: 'success',
        message: pick(
          locale,
          `${playlist.name ?? 'Playlist'} created — click to open in Spotify`,
          `${playlist.name ?? '플레이리스트'} 생성 완료 — 눌러서 Spotify에서 열기`,
        ),
        url,
      })
    } catch (error) {
      setPlaylistStatus({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const displayedPlaylistStatus: PlaylistStatus =
    playlistStatus.type === 'idle'
      ? {
          type: 'idle',
          message: pick(
            locale,
            'Create a Spotify playlist from each country #1.',
            '국가별 1위 곡을 Spotify 플레이리스트로 생성합니다.',
          ),
        }
      : playlistStatus
  const contentAdEligible =
    snapshot !== demoSnapshot &&
    !snapshotLoading &&
    !initialDataPending &&
    (mainTab === 'atlas' || mainTab === 'genres' || mainTab === 'rising')

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Globe2 size={22} />
          </span>
          <div>
            <h1>Chart Atlas</h1>
            <p>{pick(locale, 'Global music chart atlas', '국가별 차트 지형도')}</p>
          </div>
        </div>

        <div className="topbar-actions">
          <nav className="main-tabs" aria-label={pick(locale, 'main sections', '주요 섹션')}>
            <button
              type="button"
              className={mainTab === 'atlas' ? 'active' : ''}
              onClick={() => selectMainTab('atlas')}
            >
              <Globe2 size={16} />
              {pick(locale, 'Chart Map', '차트 지도')}
            </button>
            <button
              type="button"
              className={mainTab === 'genres' ? 'active' : ''}
              onClick={() => selectMainTab('genres')}
            >
              <Radio size={16} />
              {pick(locale, 'Genre Discovery', '장르 발굴')}
            </button>
            <button
              type="button"
              className={mainTab === 'rising' ? 'active' : ''}
              onClick={() => selectMainTab('rising')}
            >
              <TrendingUp size={16} />
              {pick(locale, 'Rising Discovery', '라이징 발굴')}
            </button>
            <button
              type="button"
              className={mainTab === 'taste' ? 'active' : ''}
              onClick={() => selectMainTab('taste')}
            >
              <Heart size={16} />
              {pick(locale, 'Taste Discovery', '취향 발견')}
            </button>
            <button
              type="button"
              className={mainTab === 'playlists' ? 'active' : ''}
              onClick={() => selectMainTab('playlists')}
            >
              <Music2 size={16} />
              {pick(locale, 'Playlist Studio', '플레이리스트 스튜디오')}
            </button>
          </nav>
          <div className="topbar-toggles">
            <ThemeToggle locale={locale} theme={theme} onChange={changeTheme} />
            <LocaleToggle locale={locale} onChange={changeLocale} />
          </div>
        </div>
      </header>

      <div
        className={`app-content app-content-${mainTab}${contentAdEligible ? ' app-content-with-ad' : ''}`}
      >
      {contentAdEligible ? <AdSlot placement="header" className="content-leaderboard-ad" /> : null}
      {initialDataPending && (mainTab === 'atlas' || mainTab === 'genres' || mainTab === 'taste') ? (
        <section className="app-data-loading" role="status">
          <Loader2 size={22} />
          {pick(locale, 'Loading the latest chart snapshot.', '최신 차트 스냅샷을 불러오는 중입니다.')}
        </section>
      ) : mainTab === 'genres' ? (
        <GenreDiscovery
          snapshot={snapshot}
          snapshotIndex={snapshotIndex}
          selectedDate={selectedDate}
          snapshotLoading={snapshotLoading}
          onSelectedDateChange={setSelectedDate}
          locale={locale}
        />
      ) : mainTab === 'rising' ? (
        <RisingDiscovery
          analysisHistory={analysisHistory as RisingAnalysisSnapshot[]}
          analysisHistoryLoading={analysisHistoryLoading}
          snapshotIndex={snapshotIndex}
          selectedDate={selectedDate}
          onSelectedDateChange={setSelectedDate}
          locale={locale}
        />
      ) : mainTab === 'taste' ? (
        <TasteDiscovery
          snapshot={snapshot}
          snapshotIndex={snapshotIndex}
          selectedDate={selectedDate}
          snapshotLoading={snapshotLoading}
          onSelectedDateChange={setSelectedDate}
          locale={locale}
        />
      ) : mainTab === 'playlists' ? (
        <PlaylistStudio locale={locale} />
      ) : mainTab === 'about' ? (
        <AboutPage locale={locale} onBack={() => selectMainTab('atlas')} />
      ) : mainTab === 'privacy' ? (
        <PrivacyPolicy locale={locale} onBack={() => selectMainTab('atlas')} />
      ) : mainTab === 'contact' ? (
        <ContactPage locale={locale} onBack={() => selectMainTab('atlas')} />
      ) : mainTab === 'terms' ? (
        <TermsPage locale={locale} onBack={() => selectMainTab('atlas')} />
      ) : mainTab === 'methodology' ? (
        <MethodologyPage locale={locale} onBack={() => selectMainTab('atlas')} />
      ) : (
        <>
          <section className="status-strip">
            <span>
              <Radio size={15} />
              {model.sourceName} {model.snapshotDate}
            </span>
            <span>
              <MapPin size={15} />
              {formatCount(locale, countries.length, 'country', 'countries', '개 국가')}
            </span>
            <span>
              <Music2 size={15} />
              {formatCount(locale, tracks.length, 'track', 'tracks', '개 곡')}
            </span>
            <span>
              <Crown size={15} />
              {topTrack.track.title} · {topTrack.track.artist}
            </span>
            <button
              type="button"
              className="status-insight"
              title={pick(
                locale,
                `Show ${topTrack.track.title} on the map`,
                `${topTrack.track.title} 차트인 국가를 지도에서 보기`,
              )}
              onClick={focusTopTrackOnMap}
            >
              {topTrack.topOnes > 0
                ? pick(
                    locale,
                    `#1 in ${topTrack.topOnes} ${topTrack.topOnes === 1 ? 'country' : 'countries'} · charting in ${topTrack.appearances}`,
                    `${topTrack.topOnes}개국 1위 · ${topTrack.appearances}개국 차트인`,
                  )
                : pick(
                    locale,
                    `#1 nowhere, yet charting in ${topTrack.appearances} countries — the most evenly loved song this week`,
                    `0개국 1위, 그러나 ${topTrack.appearances}개국 차트인 — 이번 주 가장 고르게 사랑받는 곡`,
                  )}
              <span aria-hidden="true"> ↓</span>
            </button>
            {snapshotLoading ? <span>{pick(locale, 'Loading data', '데이터 로딩 중')}</span> : null}
          </section>

          <section className="date-strip">
            <label className="date-picker">
              {pick(locale, 'Date', '날짜')}
              <select value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)}>
                {snapshotIndex.map((entry) => (
                  <option key={entry.date} value={entry.date}>
                    {entry.date} · {formatCount(locale, entry.countries, 'country', 'countries', '개국')} · {formatCount(locale, entry.tracks, 'track', 'tracks', '곡')}
                  </option>
                ))}
              </select>
            </label>

            <label className="search-box chart-search-box">
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={pick(locale, 'Search artists or songs', '아티스트, 곡 검색')}
              />
            </label>
          </section>

          <CountryTopBoard
            rows={countryRows}
            selectedCountry={selectedCountry}
            trackById={trackById}
            previousSnapshotDate={previousSnapshotDate}
            previousSnapshotLoading={previousSnapshotLoading}
            playlistStatus={displayedPlaylistStatus}
            locale={locale}
            onCreatePlaylist={createTopOnesPlaylist}
            onSelectCountry={selectCountry}
            onSelectTrack={selectTrackFromBoard}
          />

          <section className="analysis-workspace" ref={analysisWorkspaceRef}>
            <section className="analysis-panel">
              <div className="section-heading table-heading">
                <div>
                  <h2>{pick(locale, 'Analysis Table', '분석 테이블')}</h2>
                  <p>
                    {pick(
                      locale,
                      'Select a row to highlight charting countries on the map.',
                      '행을 선택하면 오른쪽 지도에 차트인 국가가 표시됩니다.',
                    )}
                  </p>
                </div>
                <div className="tabs" aria-label={pick(locale, 'analysis tabs', '분석 탭')}>
                  <button
                    type="button"
                    className={analysisTab === 'artist' ? 'active' : ''}
                    onClick={() => setAnalysisTab('artist')}
                  >
                    <UsersRound size={16} />
                    {pick(locale, 'Artists', '아티스트별')}
                  </button>
                  <button
                    type="button"
                    className={analysisTab === 'song' ? 'active' : ''}
                    onClick={() => setAnalysisTab('song')}
                  >
                    <Music2 size={16} />
                    {pick(locale, 'Songs', '곡별')}
                  </button>
                </div>
              </div>

              <div className="formula-note">
                {pick(
                  locale,
                  'Score = Σ(101 - country rank). Strongest region = max(region score / collected countries in region).',
                  '종합 점수 = Σ(101 - 국가별 순위). 강한 지역 = max(지역 점수 합계 / 해당 지역 수집 국가 수).',
                )}
              </div>

              {analysisTab === 'artist' ? (
                <ArtistAnalysisTable
                  rows={artistRows}
                  selectedArtist={selectedArtist}
                  locale={locale}
                  onSelectArtist={selectArtist}
                  onSelectCountry={selectCountry}
                />
              ) : (
                <SongAnalysisTable
                  rows={songRows}
                  selectedTrack={selectedTrack}
                  locale={locale}
                  onSelectTrack={selectTrack}
                  onSelectCountry={selectCountry}
                />
              )}
            </section>

            <aside className="map-column">
              <div className="map-panel">
                <div className="section-heading">
                  <div>
                    <h2>{pick(locale, 'Charting Countries Map', '차트인 국가 지도')}</h2>
                    <p>
                      {hoveredCountry
                        ? `${hoveredCountry.name} · ${hoveredCountry.region}`
                        : pick(
                            locale,
                            `Highlighting countries where ${mapFocus.label} is charting.`,
                            `${mapFocus.label} 기준으로 차트인 국가를 강조합니다.`,
                          )}
                    </p>
                  </div>
                  <span className="focus-pill">
                    <strong>{selectedCountry.code}</strong>
                    {selectedCountry.name}
                  </span>
                </div>

                <WorldMap
                  countries={countries}
                  countryByMapId={countryByMapId}
                  mapFocus={mapFocus}
                  selectedCountryCode={selectedCountry.code}
                  locale={locale}
                  onCountrySelect={selectCountry}
                  onCountryHover={setHoveredCountryCode}
                />
              </div>

              {analysisTab === 'artist' ? (
                <ArtistRankTrendPanel
                  artist={selectedArtist}
                  points={selectedArtistHistory}
                  dates={rankHistoryDates}
                  loading={analysisHistoryLoading || (analysisHistory.length === 0 && snapshotHistoryLoading)}
                  locale={locale}
                />
              ) : (
                <TrackRankTrendPanel
                  track={selectedTrack}
                  series={selectedTrackHistory}
                  dates={rankHistoryDates}
                  selectedCountryCode={selectedCountry.code}
                  loading={snapshotHistoryLoading}
                  locale={locale}
                  onSelectCountry={selectCountry}
                />
              )}
            </aside>
          </section>
        </>
      )}
      </div>

      <footer className="site-footer">
        <span>
          {pick(
            locale,
            'Chart Atlas is not affiliated with or endorsed by Spotify.',
            'Chart Atlas는 Spotify와 제휴 또는 보증 관계가 없습니다.',
          )}
        </span>
        <nav className="footer-links" aria-label={pick(locale, 'site information links', '사이트 정보 링크')}>
          <a href={appPath('weekly')}>
            {pick(locale, 'Reports', '리포트')}
          </a>
          <a href={appPath('countries')}>
            {pick(locale, 'Countries', '국가 리포트')}
          </a>
          <a href={appPath('genres')}>
            {pick(locale, 'Genres', '장르 리포트')}
          </a>
          <a href={footerTabPath('about')} onClick={(event) => { event.preventDefault(); selectMainTab('about') }}>
            {pick(locale, 'About', '서비스 정보')}
          </a>
          <a href={footerTabPath('privacy')} onClick={(event) => { event.preventDefault(); selectMainTab('privacy') }}>
            {pick(locale, 'Privacy Policy', '개인정보처리방침')}
          </a>
          <a href={footerTabPath('contact')} onClick={(event) => { event.preventDefault(); selectMainTab('contact') }}>
            {pick(locale, 'Contact', '문의')}
          </a>
          <a href={footerTabPath('terms')} onClick={(event) => { event.preventDefault(); selectMainTab('terms') }}>
            {pick(locale, 'Terms', '이용 안내')}
          </a>
          <a href={footerTabPath('methodology')} onClick={(event) => { event.preventDefault(); selectMainTab('methodology') }}>
            {pick(locale, 'Methodology', '방법론')}
          </a>
        </nav>
      </footer>
    </main>
  )
}

function LocaleToggle({
  locale,
  onChange,
}: {
  locale: Locale
  onChange: (locale: Locale) => void
}) {
  return (
    <div className="locale-toggle" aria-label={pick(locale, 'language selector', '언어 선택')}>
      <button
        type="button"
        className={locale === 'en' ? 'active' : ''}
        onClick={() => onChange('en')}
      >
        EN
      </button>
      <button
        type="button"
        className={locale === 'ko' ? 'active' : ''}
        onClick={() => onChange('ko')}
      >
        KO
      </button>
    </div>
  )
}

function ThemeToggle({
  locale,
  theme,
  onChange,
}: {
  locale: Locale
  theme: ThemeMode
  onChange: (theme: ThemeMode) => void
}) {
  return (
    <div className="theme-toggle" aria-label={pick(locale, 'theme selector', '테마 선택')}>
      <button
        type="button"
        className={theme === 'light' ? 'active' : ''}
        onClick={() => onChange('light')}
        aria-pressed={theme === 'light'}
      >
        <Sun size={14} />
        {pick(locale, 'Light', '라이트')}
      </button>
      <button
        type="button"
        className={theme === 'dark' ? 'active' : ''}
        onClick={() => onChange('dark')}
        aria-pressed={theme === 'dark'}
      >
        <Moon size={14} />
        {pick(locale, 'Dark', '다크')}
      </button>
    </div>
  )
}

function AboutPage({ locale, onBack }: { locale: Locale; onBack: () => void }) {
  return (
    <section className="privacy-page">
      <div className="privacy-card">
        <p className="privacy-kicker">Chart Atlas</p>
        <h2>{pick(locale, 'About Chart Atlas', 'Chart Atlas 서비스 정보')}</h2>
        <p>
          {pick(
            locale,
            'Chart Atlas is a music discovery lab for exploring country charts, regional genre signals, rising artists, and public Spotify playlists.',
            'Chart Atlas는 국가별 차트, 지역 장르 신호, 라이징 아티스트, 공개 Spotify 플레이리스트를 탐색하기 위한 음악 발견 실험실입니다.',
          )}
        </p>

        <h3>{pick(locale, 'What We Provide', '제공 기능')}</h3>
        <ul>
          <li>{pick(locale, 'Country chart map and top 10 board for comparing tracks across markets.', '국가별 차트 지도와 Top 10 보드로 시장별 곡 흐름을 비교합니다.')}</li>
          <li>{pick(locale, 'Genre discovery based on chart snapshots and music metadata signals.', '차트 스냅샷과 음악 메타데이터 신호를 기반으로 장르를 발굴합니다.')}</li>
          <li>{pick(locale, 'Rising discovery that compares multiple weekly snapshots to surface artists and tracks gaining momentum.', '여러 주차 스냅샷을 비교해 상승세가 있는 아티스트와 곡을 보여줍니다.')}</li>
          <li>{pick(locale, 'Playlist Studio for browsing and creating public Spotify playlists through connected tools.', '연동 도구를 통해 공개 Spotify 플레이리스트를 탐색하고 생성하는 Playlist Studio를 제공합니다.')}</li>
        </ul>

        <h3>{pick(locale, 'Data and Independence', '데이터와 독립성')}</h3>
        <p>
          {pick(
            locale,
            'The service uses collected chart snapshots, external music metadata, and Spotify API responses where available. Chart Atlas is not affiliated with or endorsed by Spotify.',
            '이 서비스는 수집된 차트 스냅샷, 외부 음악 메타데이터, 가능한 경우 Spotify API 응답을 사용합니다. Chart Atlas는 Spotify와 제휴 또는 보증 관계가 없습니다.',
          )}
        </p>

        <h3>{pick(locale, 'Contact', '문의')}</h3>
        <p>
          {pick(locale, 'Questions and feedback can be sent to', '질문과 피드백은 다음 이메일로 보내주세요')}{' '}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </p>

        <button type="button" className="privacy-back" onClick={onBack}>
          {pick(locale, 'Back to Chart Map', '차트 지도로 돌아가기')}
        </button>
      </div>
    </section>
  )
}

function PrivacyPolicy({ locale, onBack }: { locale: Locale; onBack: () => void }) {
  return (
    <section className="privacy-page">
      <div className="privacy-card">
        <p className="privacy-kicker">Chart Atlas</p>
        <h2>{pick(locale, 'Privacy Policy', '개인정보처리방침')}</h2>
        <p className="privacy-updated">
          {pick(locale, 'Effective date: June 26, 2026', '시행일: 2026년 6월 26일')}
        </p>

        <p>
          {pick(
            locale,
            'Chart Atlas provides country music charts, genre discovery, public Spotify playlist browsing, and playlist creation assistance. We process only the information needed to operate the service.',
            'Chart Atlas는 국가별 음악 차트, 장르 발굴, 공개 Spotify 플레이리스트 탐색과 생성 보조 기능을 제공하는 웹 서비스입니다. 서비스 운영에 필요한 최소한의 정보만 처리합니다.',
          )}
        </p>

        <h3>{pick(locale, 'Information We Process', '처리하는 정보')}</h3>
        <ul>
          <li>{pick(locale, 'Charts and genre screens: country chart data, track/artist metadata, and selected UI state.', '차트/장르 화면: 국가별 차트 데이터, 곡/아티스트 메타데이터, 사용자가 선택한 화면 상태를 처리합니다.')}</li>
          <li>{pick(locale, 'Playlist Studio: chat messages and playlist task requests entered by the user.', 'Playlist Studio: 사용자가 입력한 채팅 메시지와 플레이리스트 작업 요청을 처리합니다.')}</li>
          <li>{pick(locale, 'Spotify integration: public playlist lists and Spotify API responses needed for playlist creation or editing.', 'Spotify 연동: 공개 플레이리스트 목록, 플레이리스트 생성/수정에 필요한 Spotify API 응답을 처리할 수 있습니다.')}</li>
          <li>{pick(locale, 'Ads: if ads are enabled, providers such as Google AdSense may use cookies, device data, and advertising identifiers.', '광고: 광고가 활성화된 경우 Google AdSense 등 광고 제공자가 쿠키, 기기 정보, 광고 식별자 등을 사용할 수 있습니다.')}</li>
        </ul>

        <h3>{pick(locale, 'Purpose', '이용 목적')}</h3>
        <ul>
          <li>{pick(locale, 'Display chart and genre analysis results.', '차트 및 장르 분석 결과 표시')}</li>
          <li>{pick(locale, 'Handle Spotify playlist creation, browsing, and organization requests.', 'Spotify 플레이리스트 생성, 조회, 정리 요청 처리')}</li>
          <li>{pick(locale, 'Analyze service errors and improve features.', '서비스 오류 분석과 기능 개선')}</li>
          <li>{pick(locale, 'Serve ads and measure ad performance.', '광고 노출 및 광고 성과 측정')}</li>
        </ul>

        <h3>{pick(locale, 'Retention', '보관')}</h3>
        <p>
          {pick(
            locale,
            'Playlist Studio chat sessions are reset when the service initializes. Server logs and cache data may be retained for the period needed to operate the service and respond to incidents.',
            'Playlist Studio의 채팅 세션은 접속 시 초기화되며, 사용자가 새 세션을 시작한 경우에도 다음 초기화 시 이전 기록이 삭제됩니다. 서버 로그와 캐시 데이터는 서비스 운영과 장애 대응에 필요한 기간 동안 보관될 수 있습니다.',
          )}
        </p>

        <h3>{pick(locale, 'Advertising and Cookies', '광고 및 쿠키')}</h3>
        <p>
          {pick(
            locale,
            'If advertising is enabled, Google AdSense and other advertising partners may use cookies, device information, and advertising identifiers to serve and measure ads. Users in regions that require consent may be shown a consent message before personalized ads are used.',
            '광고가 활성화된 경우 Google AdSense 및 기타 광고 파트너가 광고 제공과 성과 측정을 위해 쿠키, 기기 정보, 광고 식별자를 사용할 수 있습니다. 동의가 필요한 지역의 사용자는 개인화 광고 사용 전에 동의 메시지를 볼 수 있습니다.',
          )}
        </p>

        <h3>{pick(locale, 'Third Parties and External Services', '제3자 제공 및 외부 서비스')}</h3>
        <p>
          {pick(
            locale,
            'We may use external services such as the Spotify API, OpenAI/Codex execution environment, and Google AdSense. Data handling by those services follows their own terms and privacy policies.',
            '서비스 제공을 위해 Spotify API, OpenAI/Codex 실행 환경, Google AdSense 같은 외부 서비스를 사용할 수 있습니다. 각 외부 서비스의 데이터 처리는 해당 서비스의 약관과 개인정보처리방침을 따릅니다.',
          )}
        </p>

        <h3>{pick(locale, 'Contact', '문의')}</h3>
        <p>
          {pick(locale, 'For privacy questions, contact the site operator.', '개인정보 관련 문의는 사이트 운영자에게 연락해 주세요.')}
          {' '}
          {pick(locale, 'Contact:', '연락처:')} <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </p>

        <button type="button" className="privacy-back" onClick={onBack}>
          {pick(locale, 'Back to Chart Map', '차트 지도로 돌아가기')}
        </button>
      </div>
    </section>
  )
}

function ContactPage({ locale, onBack }: { locale: Locale; onBack: () => void }) {
  return (
    <section className="privacy-page">
      <div className="privacy-card">
        <p className="privacy-kicker">Chart Atlas</p>
        <h2>{pick(locale, 'Contact', '문의')}</h2>
        <p>
          {pick(
            locale,
            'For service questions, playlist issues, privacy requests, advertising questions, or data feedback, contact the Chart Atlas team by email.',
            '서비스 질문, 플레이리스트 문제, 개인정보 요청, 광고 관련 문의, 데이터 피드백은 Chart Atlas 팀 이메일로 연락해 주세요.',
          )}
        </p>

        <h3>{pick(locale, 'Email', '이메일')}</h3>
        <p>
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </p>

        <h3>{pick(locale, 'What To Include', '포함하면 좋은 내용')}</h3>
        <ul>
          <li>{pick(locale, 'The page or feature where the issue happened.', '문제가 발생한 페이지 또는 기능')}</li>
          <li>{pick(locale, 'The chart date, country, genre, playlist, or track involved if relevant.', '관련된 차트 날짜, 국가, 장르, 플레이리스트 또는 곡 정보')}</li>
          <li>{pick(locale, 'A short description of what you expected and what happened instead.', '기대한 동작과 실제 발생한 동작에 대한 짧은 설명')}</li>
        </ul>

        <button type="button" className="privacy-back" onClick={onBack}>
          {pick(locale, 'Back to Chart Map', '차트 지도로 돌아가기')}
        </button>
      </div>
    </section>
  )
}

function TermsPage({ locale, onBack }: { locale: Locale; onBack: () => void }) {
  return (
    <section className="privacy-page">
      <div className="privacy-card">
        <p className="privacy-kicker">Chart Atlas</p>
        <h2>{pick(locale, 'Terms and Usage Notes', '이용 안내')}</h2>
        <p className="privacy-updated">
          {pick(locale, 'Effective date: June 26, 2026', '시행일: 2026년 6월 26일')}
        </p>

        <h3>{pick(locale, 'Use of the Service', '서비스 이용')}</h3>
        <p>
          {pick(
            locale,
            'Chart Atlas is provided as an informational and experimental music discovery service. Chart rankings, genre classifications, and rising signals are generated from available snapshots and metadata and may contain errors or omissions.',
            'Chart Atlas는 정보 제공과 실험적 음악 발견을 위한 서비스입니다. 차트 순위, 장르 분류, 라이징 신호는 사용 가능한 스냅샷과 메타데이터를 기반으로 생성되며 오류나 누락이 있을 수 있습니다.',
          )}
        </p>

        <h3>{pick(locale, 'Spotify and External Services', 'Spotify 및 외부 서비스')}</h3>
        <p>
          {pick(
            locale,
            'Playlist features may use Spotify API responses and links. Spotify content, embeds, and account actions are governed by Spotify’s own terms and policies.',
            '플레이리스트 기능은 Spotify API 응답과 링크를 사용할 수 있습니다. Spotify 콘텐츠, 임베드, 계정 작업은 Spotify의 약관과 정책을 따릅니다.',
          )}
        </p>

        <h3>{pick(locale, 'No Professional Advice', '전문적 조언 아님')}</h3>
        <p>
          {pick(
            locale,
            'The service does not provide legal, financial, advertising, or professional advice. Users should verify important information independently before relying on it.',
            '이 서비스는 법률, 금융, 광고 또는 기타 전문적 조언을 제공하지 않습니다. 중요한 정보는 사용자가 독립적으로 확인해야 합니다.',
          )}
        </p>

        <h3>{pick(locale, 'Contact', '문의')}</h3>
        <p>
          {pick(locale, 'Questions about these usage notes can be sent to', '이용 안내 관련 문의는 다음 이메일로 보내주세요')}{' '}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </p>

        <button type="button" className="privacy-back" onClick={onBack}>
          {pick(locale, 'Back to Chart Map', '차트 지도로 돌아가기')}
        </button>
      </div>
    </section>
  )
}

function MethodologyPage({ locale, onBack }: { locale: Locale; onBack: () => void }) {
  return (
    <section className="privacy-page">
      <div className="privacy-card">
        <p className="privacy-kicker">Chart Atlas</p>
        <h2>{pick(locale, 'Data and Methodology', '데이터와 방법론')}</h2>
        <p className="privacy-updated">
          {pick(locale, 'Last updated: June 28, 2026', '마지막 업데이트: 2026년 6월 28일')}
        </p>

        <p>
          {pick(
            locale,
            'Chart Atlas is built as an editorial music-discovery tool. It does not simply mirror one ranking table. The service combines weekly country chart snapshots, track metadata, country-level appearances, rank movement, and genre evidence to help readers understand which songs, artists, and regional genres are gaining attention.',
            'Chart Atlas는 단순 순위표 복제가 아니라 음악 발견을 위한 에디토리얼 도구로 구성됩니다. 주차별 국가 차트 스냅샷, 곡 메타데이터, 국가별 등장 횟수, 순위 변동, 장르 근거를 결합해 어떤 곡과 아티스트, 지역 장르가 주목받는지 이해할 수 있게 합니다.',
          )}
        </p>

        <h3>{pick(locale, 'Chart Snapshots', '차트 스냅샷')}</h3>
        <p>
          {pick(
            locale,
            'The app stores dated chart snapshots so readers can compare the current week with previous weeks. Each snapshot includes countries, tracks, chart positions, movement data, and metadata used by the map, top-ten board, and analysis table.',
            '이 앱은 날짜별 차트 스냅샷을 저장해 현재 주차와 이전 주차를 비교할 수 있게 합니다. 각 스냅샷에는 국가, 곡, 차트 순위, 변동 정보, 지도와 Top 10 보드 및 분석 테이블에 쓰이는 메타데이터가 포함됩니다.',
          )}
        </p>

        <h3>{pick(locale, 'Ranking Signals', '순위 신호')}</h3>
        <ul>
          <li>{pick(locale, 'A track gains more weight when it appears in more countries and ranks closer to #1.', '곡은 더 많은 국가에 등장하고 1위에 가까울수록 더 큰 가중치를 받습니다.')}</li>
          <li>{pick(locale, 'A country board shows local rank movement, including new entries and week-over-week changes.', '국가별 보드는 신규 진입과 전주 대비 변동을 포함한 로컬 순위 흐름을 보여줍니다.')}</li>
          <li>{pick(locale, 'Artist rankings aggregate the chart performance of tracks connected to the same artist identity.', '아티스트 순위는 같은 아티스트로 연결된 곡들의 차트 성과를 합산합니다.')}</li>
          <li>{pick(locale, 'Rising discovery emphasizes multi-week movement rather than a single-week spike.', '라이징 발굴은 한 주의 급등보다 여러 주에 걸친 움직임을 더 중요하게 봅니다.')}</li>
        </ul>

        <h3>{pick(locale, 'Genre Discovery', '장르 발굴')}</h3>
        <p>
          {pick(
            locale,
            'Genre discovery uses charting tracks as the starting point. The system checks track titles, artists, external music metadata, local genre dictionaries, and chart-country context. This is designed to highlight both global categories such as hip-hop, pop, dance, and R&B and local genres such as sertanejo, OPM, schlager, corridos tumbados, gqom, and mahraganat.',
            '장르 발굴은 현재 차트에 오른 곡을 출발점으로 합니다. 시스템은 곡명, 아티스트, 외부 음악 메타데이터, 로컬 장르 사전, 차트 국가 맥락을 함께 확인합니다. 이를 통해 힙합, 팝, 댄스, R&B 같은 글로벌 장르와 세르타네주, OPM, 슐라거, 코리도스 툼바도스, gqom, 마흐라가나트 같은 지역 장르를 함께 보여주도록 설계했습니다.',
          )}
        </p>

        <h3>{pick(locale, 'Taste Discovery', '취향 발견')}</h3>
        <p>
          {pick(
            locale,
            'Taste Discovery selects playable Apple preview tracks from chart-driven genre candidates. Tracks without an Apple preview are excluded from the sampler so the experience stays focused on playable music rather than empty embeds or broken previews.',
            '취향 발견은 차트 기반 장르 후보 중 Apple 미리듣기가 가능한 곡을 골라 샘플러를 구성합니다. Apple 미리듣기가 없는 곡은 제외해 빈 임베드나 끊긴 프리뷰가 아니라 실제 재생 가능한 음악 중심의 경험을 유지합니다.',
          )}
        </p>

        <h3>{pick(locale, 'Limitations', '한계')}</h3>
        <p>
          {pick(
            locale,
            'Music metadata is imperfect. Artist aliases, remixes, local spelling, featured artists, unavailable previews, and genre overlap can cause omissions or misclassification. Chart Atlas treats the output as a discovery signal, not as an official industry chart or definitive genre authority.',
            '음악 메타데이터는 완벽하지 않습니다. 아티스트 별칭, 리믹스, 지역 표기, 피처링 아티스트, 제공되지 않는 미리듣기, 장르 중첩으로 인해 누락이나 오분류가 발생할 수 있습니다. Chart Atlas의 결과는 공식 산업 차트나 최종 장르 판정이 아니라 발견을 위한 신호로 봐야 합니다.',
          )}
        </p>

        <h3>{pick(locale, 'Contact and Corrections', '문의와 정정')}</h3>
        <p>
          {pick(
            locale,
            'If you notice a chart issue, genre mismatch, missing credit, or playlist problem, send the details to',
            '차트 문제, 장르 불일치, 누락된 크레딧, 플레이리스트 문제가 보이면 자세한 내용을 다음 주소로 보내주세요:',
          )}{' '}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </p>

        <button type="button" className="privacy-back" onClick={onBack}>
          {pick(locale, 'Back to Chart Map', '차트 지도로 돌아가기')}
        </button>
      </div>
    </section>
  )
}

function WorldMap({
  countries,
  countryByMapId,
  mapFocus,
  selectedCountryCode,
  locale,
  onCountrySelect,
  onCountryHover,
}: {
  countries: Country[]
  countryByMapId: Map<string, Country>
  mapFocus: MapFocus
  selectedCountryCode: string
  locale: Locale
  onCountrySelect: (countryCode: string) => void
  onCountryHover: (countryCode: string | null) => void
}) {
  const width = 960
  const height = 510
  const projection = useMemo(
    () => geoNaturalEarth1().translate([width / 2, height / 2 + 18]).scale(170),
    [],
  )
  const path = useMemo(() => geoPath(projection), [projection])
  const graticule = useMemo(() => geoGraticule10(), [])
  const focusRankByCountry = useMemo(
    () => new Map(mapFocus.ranks.map((rank) => [rank.country.code, rank])),
    [mapFocus],
  )

  function countryVisual(country: Country | undefined) {
    if (!country) {
      return { fill: 'rgba(148, 163, 184, 0.12)', stroke: 'rgba(100, 116, 139, 0.3)' }
    }

    const focusRank = focusRankByCountry.get(country.code)

    if (focusRank) {
      const strength = Math.max(0.28, rankScore(focusRank.entry.rank) / 100)

      return {
        fill: colorWithOpacity(mapFocus.color, strength),
        stroke: colorWithOpacity(mapFocus.color, 0.95),
      }
    }

    return {
      fill: 'rgba(148, 163, 184, 0.12)',
      stroke: 'rgba(100, 116, 139, 0.28)',
    }
  }

  return (
    <svg className="world-map" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={pick(locale, 'world chart map', '세계 차트 지도')}>
      <path className="graticule" d={path(graticule) ?? undefined} />
      {worldFeatures.features.map((geoFeature: Feature<Geometry, { name: string }>) => {
        const id = geoFeature.id ? String(geoFeature.id).padStart(3, '0') : ''
        const country = countryByMapId.get(id)
        const visual = countryVisual(country)
        const isSelected = country?.code === selectedCountryCode

        return (
          <path
            key={id || geoFeature.properties.name}
            d={path(geoFeature) ?? undefined}
            className={country ? `country-shape tracked${isSelected ? ' selected' : ''}` : 'country-shape'}
            fill={visual.fill}
            stroke={isSelected ? '#111827' : visual.stroke}
            strokeWidth={isSelected ? 2 : 0.7}
            onClick={() => {
              if (country) {
                onCountrySelect(country.code)
              }
            }}
            onMouseEnter={() => onCountryHover(country?.code ?? null)}
            onMouseLeave={() => onCountryHover(null)}
          />
        )
      })}
      {countries.map((country) => {
        const point = projection([country.lon, country.lat])
        const focusRank = focusRankByCountry.get(country.code)

        if (!point) {
          return null
        }

        return (
          <circle
            key={`${country.code}-pin`}
            className={country.code === selectedCountryCode ? 'map-pin selected' : 'map-pin'}
            cx={point[0]}
            cy={point[1]}
            r={country.code === selectedCountryCode ? 4.8 : 2.9}
            fill={focusRank ? mapFocus.color : '#94a3b8'}
            onClick={() => onCountrySelect(country.code)}
            onMouseEnter={() => onCountryHover(country.code)}
            onMouseLeave={() => onCountryHover(null)}
          />
        )
      })}
    </svg>
  )
}

function ArtistAnalysisTable({
  rows,
  selectedArtist,
  locale,
  onSelectArtist,
  onSelectCountry,
}: {
  rows: ArtistStat[]
  selectedArtist: ArtistStat
  locale: Locale
  onSelectArtist: (artistId: string) => void
  onSelectCountry: (countryCode: string) => void
}) {
  return (
    <div className="table-wrap">
      <table className="analysis-table">
        <thead>
          <tr>
            <th className="rank-col">#</th>
            <th>{pick(locale, 'Artist', '아티스트')}</th>
            <th>{pick(locale, 'Score', '종합 점수')}</th>
            <th>{pick(locale, 'Country Ranks', '국가별 순위')}</th>
            <th>{pick(locale, 'Strong Region', '강한 지역')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((stat, index) => (
            <tr
              key={stat.artistId}
              className={selectedArtist.artistId === stat.artistId ? 'selected' : ''}
              onClick={() => onSelectArtist(stat.artistId)}
            >
              <td className="rank-col">{index + 1}</td>
              <td>
                <span className="artist-label">
                  <span className="track-dot" style={{ background: stat.color }} />
                  <strong>{stat.artist}</strong>
                </span>
                <small>{stat.tracks.slice(0, 3).map((track) => track.title).join(', ')}</small>
              </td>
              <td>{formatScore(stat.weightedScore)}</td>
              <td>
                <RankTokens ranks={stat.countryRanks} onSelectCountry={onSelectCountry} />
              </td>
              <td>
                <strong>{stat.strongestRegion}</strong>
                <small>{stat.locality}% · {formatCount(locale, stat.appearances, 'country', 'countries', '개국')}</small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SongAnalysisTable({
  rows,
  selectedTrack,
  locale,
  onSelectTrack,
  onSelectCountry,
}: {
  rows: TrackStat[]
  selectedTrack: Track
  locale: Locale
  onSelectTrack: (trackId: string) => void
  onSelectCountry: (countryCode: string) => void
}) {
  const selectedRowRef = useRef<HTMLTableRowElement | null>(null)

  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [selectedTrack.id])

  return (
    <div className="table-wrap">
      <table className="analysis-table">
        <thead>
          <tr>
            <th className="rank-col">#</th>
            <th>{pick(locale, 'Song', '곡')}</th>
            <th>{pick(locale, 'Score', '종합 점수')}</th>
            <th>{pick(locale, 'Country Ranks', '국가별 순위')}</th>
            <th>{pick(locale, 'Strong Region', '강한 지역')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((stat, index) => (
            <tr
              key={stat.track.id}
              ref={selectedTrack.id === stat.track.id ? selectedRowRef : undefined}
              className={selectedTrack.id === stat.track.id ? 'selected' : ''}
              onClick={() => onSelectTrack(stat.track.id)}
            >
              <td className="rank-col">{index + 1}</td>
              <td><TrackName track={stat.track} /></td>
              <td>{formatScore(stat.weightedScore)}</td>
              <td>
                <RankTokens ranks={stat.countryRanks} onSelectCountry={onSelectCountry} />
              </td>
              <td>
                <strong>{stat.strongestRegion}</strong>
                <small>{stat.locality}% · {formatCount(locale, stat.appearances, 'country', 'countries', '개국')}</small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ChartMovementBadge({ movement, locale }: { movement: ChartMovement; locale: Locale }) {
  if (movement.status === 'loading') {
    const loadingLabel = pick(locale, 'Loading week-over-week movement.', '전주 대비 변동 로딩 중')

    return (
      <span className="chart-movement loading" title={loadingLabel} aria-label={loadingLabel}>
        …
      </span>
    )
  }

  if (movement.status === 'unknown') {
    return (
      <span
        className="chart-movement unknown"
        title={pick(locale, 'No previous snapshot is available for comparison.', '비교할 전주 스냅샷이 없습니다')}
      >
        {pick(locale, 'No prev', '전주 없음')}
      </span>
    )
  }

  if (movement.status === 'new') {
    const newLabel = pick(
      locale,
      `This track was not in the ${movement.previousDate} chart snapshot.`,
      `${movement.previousDate} 수집 차트에는 없던 곡입니다`,
    )

    return (
      <span className="chart-movement new" title={newLabel} aria-label={newLabel}>
        {pick(locale, 'NEW', '신규')}
      </span>
    )
  }

  const previousRankText = movement.previousRank
    ? pick(locale, `previous #${movement.previousRank}`, `전주 #${movement.previousRank}`)
    : pick(locale, 'no previous rank', '전주 순위 없음')
  const title = pick(
    locale,
    `${movement.previousDate} ${previousRankText} -> now ${
      movement.delta === 0
        ? 'same'
        : `${Math.abs(movement.delta)} places ${movement.delta > 0 ? 'up' : 'down'}`
    }`,
    `${movement.previousDate} ${previousRankText} -> 현재 ${
      movement.delta === 0
        ? '동일'
        : `${Math.abs(movement.delta)}계단 ${movement.delta > 0 ? '상승' : '하락'}`
    }`,
  )

  if (movement.status === 'up') {
    return <span className="chart-movement up" title={title} aria-label={title}>▲{movement.delta}</span>
  }

  if (movement.status === 'down') {
    return <span className="chart-movement down" title={title} aria-label={title}>▼{Math.abs(movement.delta)}</span>
  }

  return <span className="chart-movement same" title={title} aria-label={title}>-</span>
}

function ArtistRankTrendPanel({
  artist,
  points,
  dates,
  loading,
  locale,
}: {
  artist: ArtistStat
  points: ArtistRankHistoryPoint[]
  dates: string[]
  loading: boolean
  locale: Locale
}) {
  const width = 720
  const height = 310
  const padding = { top: 24, right: 18, bottom: 48, left: 44 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const dateIndex = new Map(dates.map((date, index) => [date, index]))
  const visiblePoints = points.filter((point) => dateIndex.has(point.date))
  const maxObservedRank = Math.max(10, ...visiblePoints.map((point) => point.rank))
  const maxRank = Math.min(100, Math.max(10, Math.ceil(maxObservedRank / 10) * 10))
  const yTicks = [...new Set([1, 5, 10, 20, 30, 50, maxRank].filter((rank) => rank <= maxRank))]
  const xForDate = (date: string) => {
    const index = dateIndex.get(date) ?? 0
    const denominator = Math.max(dates.length - 1, 1)

    return padding.left + (index / denominator) * plotWidth
  }
  const yForRank = (rank: number) => padding.top + ((rank - 1) / Math.max(maxRank - 1, 1)) * plotHeight
  const pathData = visiblePoints
    .map((point, index) => {
      const command = index === 0 ? 'M' : 'L'

      return `${command} ${xForDate(point.date).toFixed(2)} ${yForRank(point.rank).toFixed(2)}`
    })
    .join(' ')
  const latestPoint = visiblePoints.at(-1)
  const bestPoint = visiblePoints.reduce<ArtistRankHistoryPoint | null>(
    (best, point) => (!best || point.rank < best.rank ? point : best),
    null,
  )

  return (
    <div className="trend-panel">
      <div className="section-heading trend-heading">
        <div>
          <h2>{pick(locale, 'Selected Artist Weekly Analysis Rank', '선택 아티스트 주차별 분석 랭크')}</h2>
          <p>
            {artist.artist} · {pick(locale, 'score-based', '종합점수 기준')}
            {latestPoint ? ` · ${pick(locale, 'latest', '최신')} #${latestPoint.rank} · ${formatScore(latestPoint.weightedScore)}${pick(locale, ' pts', '점')}` : ''}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="trend-empty">{pick(locale, 'Loading artist analysis history.', '아티스트 분석 히스토리를 불러오는 중입니다.')}</div>
      ) : visiblePoints.length === 0 ? (
        <div className="trend-empty">{pick(locale, 'No cumulative analysis rank for this artist.', '선택 아티스트의 누적 분석 랭크가 없습니다.')}</div>
      ) : (
        <>
          <svg className="rank-trend-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${artist.artist} weekly analysis rank trend`}>
            <rect
              x={padding.left}
              y={padding.top}
              width={plotWidth}
              height={plotHeight}
              rx="8"
              fill="#f8fbff"
            />
            {yTicks.map((rank) => {
              const y = yForRank(rank)

              return (
                <g key={`artist-y-${rank}`}>
                  <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} className="trend-grid-line" />
                  <text x={padding.left - 10} y={y + 4} className="trend-axis-label" textAnchor="end">
                    #{rank}
                  </text>
                </g>
              )
            })}
            {dates.map((date) => {
              const x = xForDate(date)

              return (
                <g key={`artist-x-${date}`}>
                  <line x1={x} x2={x} y1={padding.top} y2={height - padding.bottom} className="trend-grid-line vertical" />
                  <text x={x} y={height - 22} className="trend-date-label" textAnchor="middle">
                    {date.slice(5)}
                  </text>
                </g>
              )
            })}
            <path
              d={pathData}
              className="trend-line"
              stroke={artist.color}
              strokeWidth="3"
            />
            {visiblePoints.map((point) => (
              <circle
                key={`artist-${artist.artistId}-${point.date}`}
                cx={xForDate(point.date)}
                cy={yForRank(point.rank)}
                r="4.4"
                fill={artist.color}
              >
                <title>
                  {`${point.date} · #${point.rank} · ${formatScore(point.weightedScore)}${pick(locale, ' pts', '점')} · ${formatCount(locale, point.appearances, 'country', 'countries', '개국')}`}
                </title>
              </circle>
            ))}
          </svg>

          <div className="trend-summary">
            {latestPoint ? (
              <span>
                <strong>{pick(locale, 'Latest', '최신')}</strong>
                #{latestPoint.rank} · {formatScore(latestPoint.weightedScore)}{pick(locale, ' pts', '점')}
              </span>
            ) : null}
            {bestPoint ? (
              <span>
                <strong>{pick(locale, 'Best', '최고')}</strong>
                #{bestPoint.rank} · {bestPoint.date.slice(5)}
              </span>
            ) : null}
            <span>
              <strong>{pick(locale, 'Current Reach', '현재 노출')}</strong>
              {formatCount(locale, artist.appearances, 'country', 'countries', '개국')} · {pick(locale, '#1', '1위')} {artist.topOnes} · Top10 {artist.topTens}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

function TrackRankTrendPanel({
  track,
  series,
  dates,
  selectedCountryCode,
  loading,
  locale,
  onSelectCountry,
}: {
  track: Track
  series: CountryRankSeries[]
  dates: string[]
  selectedCountryCode: string
  loading: boolean
  locale: Locale
  onSelectCountry: (countryCode: string) => void
}) {
  const width = 720
  const height = 310
  const padding = { top: 24, right: 18, bottom: 48, left: 44 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const dateIndex = new Map(dates.map((date, index) => [date, index]))
  const maxObservedRank = Math.max(10, ...series.flatMap((item) => item.points.map((point) => point.rank)))
  const maxRank = Math.min(100, Math.max(10, Math.ceil(maxObservedRank / 10) * 10))
  const yTicks = [...new Set([1, 10, 20, 30, 40, 50, maxRank].filter((rank) => rank <= maxRank))]
  const xForDate = (date: string) => {
    const index = dateIndex.get(date) ?? 0
    const denominator = Math.max(dates.length - 1, 1)

    return padding.left + (index / denominator) * plotWidth
  }
  const yForRank = (rank: number) => padding.top + ((rank - 1) / Math.max(maxRank - 1, 1)) * plotHeight
  const selectedSeries = series.find((item) => item.country.code === selectedCountryCode)

  function pathForSeries(countrySeries: CountryRankSeries) {
    return countrySeries.points
      .filter((point) => dateIndex.has(point.date))
      .map((point, index) => {
        const command = index === 0 ? 'M' : 'L'

        return `${command} ${xForDate(point.date).toFixed(2)} ${yForRank(point.rank).toFixed(2)}`
      })
      .join(' ')
  }

  return (
    <div className="trend-panel">
      <div className="section-heading trend-heading">
        <div>
          <h2>{pick(locale, 'Selected Song Weekly Rank', '선택 곡 주차별 순위')}</h2>
          <p>
            {track.title} · {track.artist}
            {selectedSeries ? ` · ${selectedSeries.country.name} ${pick(locale, 'latest', '최신')} #${selectedSeries.latestRank}` : ''}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="trend-empty">{pick(locale, 'Loading weekly rank history.', '주차별 순위 히스토리를 불러오는 중입니다.')}</div>
      ) : series.length === 0 ? (
        <div className="trend-empty">{pick(locale, 'No cumulative chart history for this song.', '선택 곡의 누적 차트 이력이 없습니다.')}</div>
      ) : (
        <>
          <svg className="rank-trend-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${track.title} weekly country rank trend`}>
            <rect
              x={padding.left}
              y={padding.top}
              width={plotWidth}
              height={plotHeight}
              rx="8"
              fill="#f8fbff"
            />
            {yTicks.map((rank) => {
              const y = yForRank(rank)

              return (
                <g key={`y-${rank}`}>
                  <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} className="trend-grid-line" />
                  <text x={padding.left - 10} y={y + 4} className="trend-axis-label" textAnchor="end">
                    #{rank}
                  </text>
                </g>
              )
            })}
            {dates.map((date) => {
              const x = xForDate(date)

              return (
                <g key={`x-${date}`}>
                  <line x1={x} x2={x} y1={padding.top} y2={height - padding.bottom} className="trend-grid-line vertical" />
                  <text x={x} y={height - 22} className="trend-date-label" textAnchor="middle">
                    {date.slice(5)}
                  </text>
                </g>
              )
            })}
            {series.map((countrySeries) => {
              const isSelected = countrySeries.country.code === selectedCountryCode

              return (
                <g key={countrySeries.country.code}>
                  <path
                    d={pathForSeries(countrySeries)}
                    className="trend-line"
                    stroke={countrySeries.color}
                    strokeWidth={isSelected ? 3 : 1.45}
                    opacity={isSelected ? 1 : 0.42}
                  />
                  {countrySeries.points.map((point) => (
                    <circle
                      key={`${countrySeries.country.code}-${point.date}`}
                      cx={xForDate(point.date)}
                      cy={yForRank(point.rank)}
                      r={isSelected ? 4.4 : 2.8}
                      fill={countrySeries.color}
                      opacity={isSelected ? 1 : 0.72}
                    >
                      <title>{`${countrySeries.country.name} · ${point.date} · #${point.rank}`}</title>
                    </circle>
                  ))}
                </g>
              )
            })}
          </svg>

          <div className="trend-legend" aria-label={pick(locale, 'country rank trend legend', '국가별 순위 추이 범례')}>
            {series.map((countrySeries) => (
              <button
                key={countrySeries.country.code}
                type="button"
                className={countrySeries.country.code === selectedCountryCode ? 'active' : ''}
                onClick={() => onSelectCountry(countrySeries.country.code)}
              >
                <span style={{ background: countrySeries.color }} />
                {countrySeries.country.code}
                <small>
                  {pick(locale, 'Latest', '최신')} #{countrySeries.latestRank ?? '-'} · {pick(locale, 'Best', '최고')} #{countrySeries.bestRank}
                </small>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function CountryTopBoard({
  rows,
  selectedCountry,
  trackById,
  previousSnapshotDate,
  previousSnapshotLoading,
  playlistStatus,
  locale,
  onCreatePlaylist,
  onSelectCountry,
  onSelectTrack,
}: {
  rows: CountryRow[]
  selectedCountry: Country
  trackById: Map<string, Track>
  previousSnapshotDate?: string
  previousSnapshotLoading: boolean
  playlistStatus: PlaylistStatus
  locale: Locale
  onCreatePlaylist: () => void
  onSelectCountry: (countryCode: string) => void
  onSelectTrack: (trackId: string) => void
}) {
  return (
    <section className="board-panel">
      <div className="section-heading table-heading">
        <div>
          <h2>{pick(locale, 'Country Top 10 Board', '국가별 Top 10 보드')}</h2>
          <p>
            {pick(locale, 'Compare ranks #1 through #10 for each country.', '국가별 1위부터 10위까지 비교합니다.')}
            {' '}
            {previousSnapshotLoading
              ? pick(locale, 'Loading week-over-week movement.', '전주 대비 변동 로딩 중.')
              : previousSnapshotDate
                ? pick(locale, `Movement versus ${previousSnapshotDate}.`, `${previousSnapshotDate} 대비 변동 표시.`)
                : pick(locale, 'No previous snapshot for comparison.', '비교할 이전 스냅샷 없음.')}
          </p>
        </div>
        <div className="playlist-control">
          <button
            type="button"
            className="playlist-action"
            disabled={playlistStatus.type === 'working'}
            onClick={onCreatePlaylist}
          >
            <Crown size={16} />
            {pick(locale, 'Create #1s Playlist', '1위 곡 플레이리스트 추출')}
          </button>
          <span className={`playlist-status ${playlistStatus.type}`}>
            {playlistStatus.type === 'success' && playlistStatus.url ? (
              <a href={playlistStatus.url} target="_blank" rel="noreferrer">
                {playlistStatus.message}
              </a>
            ) : (
              playlistStatus.message
            )}
          </span>
        </div>
      </div>

      <div className="board-wrap">
        <table className="board-table">
          <thead>
            <tr>
              <th className="country-sticky">{pick(locale, 'Country', '국가')}</th>
              {Array.from({ length: 10 }, (_, index) => (
                <th key={`rank-${index + 1}`}>#{index + 1}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.country.code}
                className={row.country.code === selectedCountry.code ? 'selected' : ''}
              >
                <td className="country-sticky">
                  <button type="button" className="country-cell" onClick={() => onSelectCountry(row.country.code)}>
                    <strong>{row.country.name}</strong>
                    <small>{row.country.code} · {row.country.region}</small>
                  </button>
                </td>
                {Array.from({ length: 10 }, (_, index) => {
                  const entry = row.chart[index]
                  const track = entry ? trackById.get(entry.trackId) : undefined

                  return (
                    <td key={`${row.country.code}-${index + 1}`}>
                      {track ? (
                        <button
                          type="button"
                          className="board-track"
                          onClick={() => onSelectTrack(track.id)}
                          title={`${row.country.name} #${entry.rank} ${track.title}`}
                        >
                          <span className="track-dot" style={{ background: track.color }} />
                          <strong>{track.title}</strong>
                          <span className="board-track-meta">
                            <small>{track.artist}</small>
                            <ChartMovementBadge movement={entry.movement} locale={locale} />
                          </span>
                        </button>
                      ) : (
                        <span className="empty-cell">-</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default App
