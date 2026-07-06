import { useEffect, useMemo, useState } from 'react'
import { Crown, ExternalLink, Loader2, Music2, Sparkles, TrendingUp, UsersRound } from 'lucide-react'
import './RisingDiscovery.css'
import { formatCount, formatNumberForLocale, pick, type Locale } from './i18n'

type SnapshotOption = {
  date: string
  countries: number
  tracks: number
}

type RisingTrackStat = {
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
}

type RisingArtistStat = {
  rank: number
  artistId: string
  artist: string
  color: string
  trackIds: string[]
  weightedScore: number
  appearances: number
  topOnes: number
  topTens: number
}

export type RisingAnalysisSnapshot = {
  schemaVersion: 1
  sourceSnapshotDate: string
  generatedAt?: string
  trackStats: RisingTrackStat[]
  artistStats: RisingArtistStat[]
}

type HistoryPoint = {
  date: string
  rank: number
  score: number
  appearances: number
  topOnes: number
  topTens: number
}

type RisingTrackRow = {
  id: string
  title: string
  artist: string
  artistId: string
  genre: string
  color: string
  url?: string
  rank: number
  score: number
  appearances: number
  topOnes: number
  topTens: number
  firstRank: number
  firstScore: number
  firstAppearances: number
  rankDelta: number
  scoreDelta: number
  appDelta: number
  scoreSlope: number
  rankSlope: number
  consistency: number
  weeks: number
  risingScore: number
  points: Array<HistoryPoint | null>
}

type RisingArtistRow = {
  id: string
  artist: string
  color: string
  rank: number
  score: number
  appearances: number
  topOnes: number
  topTens: number
  firstRank: number
  firstScore: number
  firstAppearances: number
  rankDelta: number
  scoreDelta: number
  appDelta: number
  scoreSlope: number
  rankSlope: number
  consistency: number
  weeks: number
  risingScore: number
  points: Array<HistoryPoint | null>
  tracks: RisingTrackRow[]
}

type ArtistProfile = {
  id: string
  name: string
  imageUrl?: string
  spotifyUrl?: string
  popularity?: number | null
  followersTotal?: number | null
  genres?: string[]
}

type PlaylistCreateStatus =
  | { type: 'idle'; message: string }
  | { type: 'working'; message: string }
  | { type: 'success'; message: string; url: string }
  | { type: 'error'; message: string }

type RisingDiscoveryProps = {
  analysisHistory: RisingAnalysisSnapshot[]
  analysisHistoryLoading: boolean
  snapshotIndex?: SnapshotOption[]
  selectedDate?: string
  onSelectedDateChange?: (date: string) => void
  locale: Locale
}

const APP_BASE_URL =
  import.meta.env.BASE_URL === '/' ? '' : import.meta.env.BASE_URL.replace(/\/$/, '')

function apiUrl(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${APP_BASE_URL}${normalizedPath}`
}

function formatNumber(locale: Locale, value: number) {
  return formatNumberForLocale(locale, value)
}

function formatSigned(locale: Locale, value: number) {
  if (value > 0) return `+${formatNumber(locale, value)}`
  return formatNumber(locale, value)
}

function regressionSlope(values: number[]) {
  const points = values
    .map((value, index) => (Number.isFinite(value) ? { x: index, y: value } : null))
    .filter((point): point is { x: number; y: number } => Boolean(point))

  if (points.length < 3) {
    return 0
  }

  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length
  const numerator = points.reduce(
    (sum, point) => sum + (point.x - meanX) * (point.y - meanY),
    0,
  )
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0)

  return denominator ? numerator / denominator : 0
}

function risingScoreFor({
  scoreSlope,
  rankSlope,
  scoreDelta,
  rankDelta,
  appDelta,
  consistency,
  rank,
}: {
  scoreSlope: number
  rankSlope: number
  scoreDelta: number
  rankDelta: number
  appDelta: number
  consistency: number
  rank: number
}) {
  const latestTopBonus = Math.max(0, 160 - rank) / 16

  return (
    scoreSlope * 2.6 +
    rankSlope * 0.9 +
    Math.max(0, scoreDelta) * 0.32 +
    Math.max(0, rankDelta) * 0.42 +
    Math.max(0, appDelta) * 18 +
    consistency * 42 +
    latestTopBonus
  )
}

function isStrongRiser(row: RisingArtistRow | RisingTrackRow) {
  return (
    row.weeks >= 4 &&
    row.rank <= 150 &&
    row.score >= 140 &&
    row.scoreDelta > 40 &&
    row.rankDelta > 10 &&
    row.scoreSlope > 0 &&
    row.consistency >= 0.4
  )
}

function pointFromTrack(stat: RisingTrackStat): HistoryPoint {
  return {
    date: '',
    rank: stat.rank,
    score: stat.weightedScore,
    appearances: stat.appearances,
    topOnes: stat.topOnes,
    topTens: stat.topTens,
  }
}

function pointFromArtist(stat: RisingArtistStat): HistoryPoint {
  return {
    date: '',
    rank: stat.rank,
    score: stat.weightedScore,
    appearances: stat.appearances,
    topOnes: stat.topOnes,
    topTens: stat.topTens,
  }
}

function metricsFromPoints(points: Array<HistoryPoint | null>) {
  const existing = points.filter((point): point is HistoryPoint => Boolean(point))
  const first = existing[0]
  const latest = existing.at(-1)

  if (!first || !latest) {
    return null
  }

  const scoreSlope = regressionSlope(points.map((point) => point?.score ?? Number.NaN))
  const rankSlope = regressionSlope(points.map((point) => (point ? 1001 - point.rank : Number.NaN)))
  const scoreUpWeeks = existing
    .slice(1)
    .filter((point, index) => point.score > existing[index].score).length
  const consistency = existing.length > 1 ? scoreUpWeeks / (existing.length - 1) : 0
  const scoreDelta = latest.score - first.score
  const rankDelta = first.rank - latest.rank
  const appDelta = latest.appearances - first.appearances
  const risingScore = risingScoreFor({
    scoreSlope,
    rankSlope,
    scoreDelta,
    rankDelta,
    appDelta,
    consistency,
    rank: latest.rank,
  })

  return {
    latest,
    first,
    scoreSlope,
    rankSlope,
    scoreDelta,
    rankDelta,
    appDelta,
    consistency,
    risingScore,
    weeks: existing.length,
  }
}

function buildTrackRows(analyses: RisingAnalysisSnapshot[]): RisingTrackRow[] {
  const latest = analyses.at(-1)
  if (!latest) return []

  const dates = analyses.map((analysis) => analysis.sourceSnapshotDate)
  const maps = analyses.map(
    (analysis) => new Map(analysis.trackStats.map((stat) => [stat.trackId, stat])),
  )

  return latest.trackStats.flatMap((current) => {
    const points = maps.map((map, index) => {
      const stat = map.get(current.trackId)
      if (!stat) return null

      return { ...pointFromTrack(stat), date: dates[index] }
    })
    const metrics = metricsFromPoints(points)

    if (!metrics) {
      return []
    }

    return [
      {
        id: current.trackId,
        title: current.title,
        artist: current.artist,
        artistId: current.artistId,
        genre: current.genre,
        color: current.color,
        url: current.url,
        rank: metrics.latest.rank,
        score: metrics.latest.score,
        appearances: metrics.latest.appearances,
        topOnes: metrics.latest.topOnes,
        topTens: metrics.latest.topTens,
        firstRank: metrics.first.rank,
        firstScore: metrics.first.score,
        firstAppearances: metrics.first.appearances,
        rankDelta: metrics.rankDelta,
        scoreDelta: metrics.scoreDelta,
        appDelta: metrics.appDelta,
        scoreSlope: metrics.scoreSlope,
        rankSlope: metrics.rankSlope,
        consistency: metrics.consistency,
        weeks: metrics.weeks,
        risingScore: metrics.risingScore,
        points,
      },
    ]
  })
}

function buildArtistRows(
  analyses: RisingAnalysisSnapshot[],
  trackRows: RisingTrackRow[],
): RisingArtistRow[] {
  const latest = analyses.at(-1)
  if (!latest) return []

  const dates = analyses.map((analysis) => analysis.sourceSnapshotDate)
  const maps = analyses.map(
    (analysis) => new Map(analysis.artistStats.map((stat) => [stat.artistId, stat])),
  )
  const tracksByArtist = new Map<string, RisingTrackRow[]>()

  for (const track of trackRows) {
    const tracks = tracksByArtist.get(track.artistId) ?? []
    tracks.push(track)
    tracksByArtist.set(track.artistId, tracks)
  }

  return latest.artistStats.flatMap((current) => {
    const points = maps.map((map, index) => {
      const stat = map.get(current.artistId)
      if (!stat) return null

      return { ...pointFromArtist(stat), date: dates[index] }
    })
    const metrics = metricsFromPoints(points)

    if (!metrics) {
      return []
    }

    const tracks = (tracksByArtist.get(current.artistId) ?? [])
      .sort((a, b) => {
        const strongDelta = b.risingScore - a.risingScore
        return Math.abs(strongDelta) > 0.001 ? strongDelta : a.rank - b.rank
      })
      .slice(0, 5)

    return [
      {
        id: current.artistId,
        artist: current.artist,
        color: current.color,
        rank: metrics.latest.rank,
        score: metrics.latest.score,
        appearances: metrics.latest.appearances,
        topOnes: metrics.latest.topOnes,
        topTens: metrics.latest.topTens,
        firstRank: metrics.first.rank,
        firstScore: metrics.first.score,
        firstAppearances: metrics.first.appearances,
        rankDelta: metrics.rankDelta,
        scoreDelta: metrics.scoreDelta,
        appDelta: metrics.appDelta,
        scoreSlope: metrics.scoreSlope,
        rankSlope: metrics.rankSlope,
        consistency: metrics.consistency,
        weeks: metrics.weeks,
        risingScore: metrics.risingScore,
        points,
        tracks,
      },
    ]
  })
}

function spotifyTrackUri(trackId: string) {
  return /^[A-Za-z0-9]{22}$/.test(trackId) ? `spotify:track:${trackId}` : ''
}

function uniqueTracks(tracks: RisingTrackRow[], limit: number) {
  const seen = new Set<string>()
  const result: RisingTrackRow[] = []

  for (const track of tracks) {
    const uri = spotifyTrackUri(track.id)
    if (!uri || seen.has(track.id)) continue
    seen.add(track.id)
    result.push(track)
    if (result.length >= limit) break
  }

  return result
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
}

function RisingMiniChart({
  points,
  color,
  locale,
}: {
  points: Array<HistoryPoint | null>
  color: string
  locale: Locale
}) {
  const width = 260
  const height = 96
  const padding = { top: 12, right: 10, bottom: 16, left: 28 }
  const observed = points.filter((point): point is HistoryPoint => Boolean(point))
  const maxRank = Math.max(10, ...observed.map((point) => point.rank))
  const denominator = Math.max(points.length - 1, 1)
  const xForIndex = (index: number) =>
    padding.left + (index / denominator) * (width - padding.left - padding.right)
  const yForRank = (rank: number) =>
    padding.top +
    ((rank - 1) / Math.max(maxRank - 1, 1)) * (height - padding.top - padding.bottom)
  const pathData = points
    .map((point, index) => (point ? { point, index } : null))
    .filter((item): item is { point: HistoryPoint; index: number } => Boolean(item))
    .map(({ point, index }, pathIndex) => {
      const command = pathIndex === 0 ? 'M' : 'L'
      return `${command} ${xForIndex(index).toFixed(1)} ${yForRank(point.rank).toFixed(1)}`
    })
    .join(' ')

  return (
    <svg className="rising-mini-chart" viewBox={`0 0 ${width} ${height}`} role="img">
      <line x1={padding.left} x2={width - padding.right} y1={padding.top} y2={padding.top} />
      <line
        x1={padding.left}
        x2={width - padding.right}
        y1={height - padding.bottom}
        y2={height - padding.bottom}
      />
      <text x={padding.left - 8} y={padding.top + 4} textAnchor="end">
        #1
      </text>
      <text x={padding.left - 8} y={height - padding.bottom + 4} textAnchor="end">
        #{maxRank}
      </text>
      <path d={pathData} stroke={color} />
      {points.map((point, index) =>
        point ? (
          <circle key={`${point.date}-${index}`} cx={xForIndex(index)} cy={yForRank(point.rank)} r="3.4">
            <title>{`${point.date} #${point.rank} · ${formatNumber(locale, point.score)}${pick(locale, ' pts', '점')}`}</title>
          </circle>
        ) : null,
      )}
    </svg>
  )
}

function RisingDiscovery({
  analysisHistory,
  analysisHistoryLoading,
  snapshotIndex = [],
  selectedDate,
  onSelectedDateChange,
  locale,
}: RisingDiscoveryProps) {
  const [profiles, setProfiles] = useState<Map<string, ArtistProfile>>(new Map())
  const [playlistStatus, setPlaylistStatus] = useState<PlaylistCreateStatus>({
    type: 'idle',
    message: pick(locale, 'Create a public Spotify playlist from rising tracks.', '라이징 곡으로 공개 Spotify 플레이리스트를 만들 수 있습니다.'),
  })

  const availableAnalyses = useMemo(
    () =>
      analysisHistory
        .filter((analysis) => !selectedDate || analysis.sourceSnapshotDate <= selectedDate)
        .sort((a, b) => a.sourceSnapshotDate.localeCompare(b.sourceSnapshotDate)),
    [analysisHistory, selectedDate],
  )
  const dates = availableAnalyses.map((analysis) => analysis.sourceSnapshotDate)
  const trackRows = useMemo(() => buildTrackRows(availableAnalyses), [availableAnalyses])
  const artistRows = useMemo(
    () =>
      buildArtistRows(availableAnalyses, trackRows)
        .filter(isStrongRiser)
        .sort((a, b) => b.risingScore - a.risingScore)
        .slice(0, 18),
    [availableAnalyses, trackRows],
  )
  const fallbackArtistRows = useMemo(
    () =>
      buildArtistRows(availableAnalyses, trackRows)
        .sort((a, b) => b.risingScore - a.risingScore)
        .slice(0, 12),
    [availableAnalyses, trackRows],
  )
  const visibleArtists = artistRows.length > 0 ? artistRows : fallbackArtistRows
  const risingTracks = useMemo(
    () =>
      trackRows
        .filter(isStrongRiser)
        .sort((a, b) => b.risingScore - a.risingScore)
        .slice(0, 32),
    [trackRows],
  )
  const playlistTracks = useMemo(() => {
    const artistTracks = visibleArtists.flatMap((artist) => artist.tracks)
    return uniqueTracks([...risingTracks, ...artistTracks], 45)
  }, [risingTracks, visibleArtists])

  useEffect(() => {
    const artists = visibleArtists.slice(0, 18).map((artist) => ({
      id: artist.id,
      name: artist.artist,
    }))

    if (artists.length === 0) {
      queueMicrotask(() => setProfiles(new Map()))
      return
    }

    let ignore = false

    async function loadProfiles() {
      try {
        const response = await fetch(apiUrl('/api/rising/artist-profiles'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ artists }),
        })
        const payload: unknown = await response.json()

        if (!response.ok || !payload || typeof payload !== 'object') {
          return
        }

        const nextProfiles = new Map<string, ArtistProfile>()
        for (const profile of (payload as { profiles?: ArtistProfile[] }).profiles || []) {
          nextProfiles.set(profile.id, profile)
        }

        if (!ignore) {
          setProfiles(nextProfiles)
        }
      } catch {
        if (!ignore) {
          setProfiles(new Map())
        }
      }
    }

    void loadProfiles()

    return () => {
      ignore = true
    }
  }, [visibleArtists])

  async function createPlaylist(tracks: RisingTrackRow[], name: string, description: string) {
    const trackUris = uniqueTracks(tracks, 80)
      .map((track) => spotifyTrackUri(track.id))
      .filter(Boolean)

    if (trackUris.length === 0) {
      setPlaylistStatus({
        type: 'error',
        message: pick(locale, 'No Spotify track IDs are available for a playlist.', '플레이리스트로 만들 Spotify 곡 ID가 없습니다.'),
      })
      return
    }

    setPlaylistStatus({
      type: 'working',
      message: pick(
        locale,
        `Creating a rising playlist with ${trackUris.length} tracks.`,
        `${trackUris.length}곡으로 라이징 플레이리스트를 생성하는 중입니다.`,
      ),
    })

    try {
      const response = await fetch(apiUrl('/api/playlists/create-from-tracks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description,
          trackUris,
          public: true,
        }),
      })
      const payload: unknown = await response.json()

      if (!response.ok || !payload || typeof payload !== 'object') {
        const error =
          payload && typeof payload === 'object' && 'error' in payload
            ? String((payload as { error?: unknown }).error)
            : pick(locale, 'Failed to create the Spotify playlist.', 'Spotify 플레이리스트 생성에 실패했습니다.')
        throw new Error(error)
      }

      const playlist = (payload as { playlist?: { name?: string; openUrl?: string } }).playlist
      if (!playlist?.openUrl) {
        throw new Error(pick(locale, 'Spotify playlist URL was not returned.', 'Spotify 플레이리스트 URL을 받지 못했습니다.'))
      }

      setPlaylistStatus({
        type: 'success',
        message: pick(
          locale,
          `${playlist.name ?? 'Rising playlist'} created`,
          `${playlist.name ?? '라이징 플레이리스트'} 생성 완료`,
        ),
        url: playlist.openUrl,
      })
      window.open(playlist.openUrl, '_blank', 'noopener,noreferrer')
    } catch (error) {
      setPlaylistStatus({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (analysisHistoryLoading && availableAnalyses.length === 0) {
    return (
      <section className="rising-page rising-loading">
        <Loader2 size={22} />
        {pick(locale, 'Loading rising analysis data.', '라이징 분석 데이터를 불러오는 중입니다.')}
      </section>
    )
  }

  if (availableAnalyses.length < 3) {
    return (
      <section className="rising-page rising-empty">
        <h2>{pick(locale, 'Rising Discovery', '라이징 발굴')}</h2>
        <p>
          {pick(
            locale,
            'At least three weekly analysis snapshots are required to calculate multi-week rising signals.',
            '최소 3개 이상의 주차별 분석 스냅샷이 있어야 멀티위크 라이징을 계산할 수 있습니다.',
          )}
        </p>
      </section>
    )
  }

  const latestDate = dates.at(-1) ?? selectedDate ?? ''
  const firstDate = dates[0] ?? latestDate
  const displayedPlaylistStatus: PlaylistCreateStatus =
    playlistStatus.type === 'idle'
      ? {
          type: 'idle',
          message: pick(locale, 'Create a public Spotify playlist from rising tracks.', '라이징 곡으로 공개 Spotify 플레이리스트를 만들 수 있습니다.'),
        }
      : playlistStatus

  return (
    <section className="rising-page">
      <header className="rising-hero">
        <div>
          <span className="rising-kicker">
            <Sparkles size={15} />
            {pick(locale, 'Multi-week signal', '멀티위크 신호')}
          </span>
          <h2>{pick(locale, 'Rising Discovery', '라이징 발굴')}</h2>
          <p>
            {pick(
              locale,
              `Candidates are ranked from ${firstDate} to ${latestDate} using analysis rank, score slope, and country reach growth to reduce one-week noise.`,
              `${firstDate}부터 ${latestDate}까지의 분석 랭크, 종합점수 기울기, 노출국 증가를 합쳐 한 주짜리 노이즈를 줄인 라이징 후보입니다.`,
            )}
          </p>
        </div>
        <div className="rising-controls">
          <label>
            {pick(locale, 'Snapshot', '기준 주차')}
            <select
              value={selectedDate ?? latestDate}
              onChange={(event) => onSelectedDateChange?.(event.target.value)}
            >
              {snapshotIndex.map((entry) => (
                <option key={entry.date} value={entry.date}>
                  {entry.date} · {formatCount(locale, entry.countries, 'country', 'countries', '개국')}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="rising-playlist-button"
            disabled={playlistStatus.type === 'working' || playlistTracks.length === 0}
            onClick={() =>
              createPlaylist(
                playlistTracks,
                `Chart Atlas Rising ${latestDate}`,
                `Chart Atlas multi-week rising tracks. ${firstDate} to ${latestDate}.`,
              )
            }
          >
            {playlistStatus.type === 'working' ? <Loader2 size={16} /> : <Crown size={16} />}
            {pick(locale, 'Top Rising Playlist', '상위 라이징 플레이리스트')}
          </button>
        </div>
      </header>

      <div className="rising-status">
        <span className={displayedPlaylistStatus.type}>
          {displayedPlaylistStatus.type === 'success' ? (
            <a href={displayedPlaylistStatus.url} target="_blank" rel="noreferrer">
              {displayedPlaylistStatus.message}
            </a>
          ) : (
            displayedPlaylistStatus.message
          )}
        </span>
        <span>
          {formatCount(locale, visibleArtists.length, 'candidate', 'candidates', '명 후보')} · {formatCount(locale, playlistTracks.length, 'playlist track', 'playlist tracks', '곡 플레이리스트 후보')}
        </span>
      </div>

      <section className="rising-layout">
        <div className="rising-card-grid">
          {visibleArtists.map((artist, index) => {
            const profile = profiles.get(artist.id)
            const imageUrl = profile?.imageUrl
            const cardTracks = uniqueTracks(artist.tracks, 8)

            return (
              <article key={artist.id} className="rising-card">
                <div className="rising-card-image" style={{ backgroundColor: artist.color }}>
                  {imageUrl ? (
                    <img src={imageUrl} alt={`${artist.artist} artist`} loading="lazy" />
                  ) : (
                    <span>{initials(artist.artist)}</span>
                  )}
                  <div className="rising-card-rank">#{index + 1}</div>
                </div>
                <div className="rising-card-body">
                  <div className="rising-card-title">
                    <div>
                      <h3>{artist.artist}</h3>
                      <p>
                        {pick(locale, 'Analysis', '분석')} #{artist.firstRank} → #{artist.rank} · {formatCount(locale, artist.weeks, 'week observed', 'weeks observed', '주 관측')}
                      </p>
                    </div>
                    {profile?.spotifyUrl ? (
                      <a href={profile.spotifyUrl} target="_blank" rel="noreferrer" aria-label={pick(locale, 'Spotify artist', 'Spotify 아티스트')}>
                        <ExternalLink size={16} />
                      </a>
                    ) : null}
                  </div>

                  <RisingMiniChart points={artist.points} color={artist.color} locale={locale} />

                  <div className="rising-metrics">
                    <span>
                      <strong>{formatNumber(locale, artist.risingScore)}</strong>
                      {pick(locale, 'Rising', '라이징')}
                    </span>
                    <span>
                      <strong>{formatSigned(locale, artist.scoreDelta)}</strong>
                      {pick(locale, 'Score', '점수')}
                    </span>
                    <span>
                      <strong>{formatSigned(locale, artist.appDelta)}</strong>
                      {pick(locale, 'Countries', '국가')}
                    </span>
                    <span>
                      <strong>{Math.round(artist.consistency * 100)}%</strong>
                      {pick(locale, 'Consistency', '지속성')}
                    </span>
                  </div>

                  <div className="rising-track-list">
                    {cardTracks.slice(0, 4).map((track) => (
                      <a
                        key={track.id}
                        href={track.url || `https://open.spotify.com/track/${track.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Music2 size={13} />
                        <span>{track.title}</span>
                        <small>#{track.rank}</small>
                      </a>
                    ))}
                  </div>

                  <button
                    type="button"
                    className="rising-card-action"
                    disabled={playlistStatus.type === 'working' || cardTracks.length === 0}
                    onClick={() =>
                      createPlaylist(
                        cardTracks,
                        `Chart Atlas Rising: ${artist.artist}`,
                        pick(
                          locale,
                          `Chart Atlas multi-week rising tracks centered on ${artist.artist}. ${latestDate}.`,
                          `${artist.artist} 중심 Chart Atlas 멀티위크 라이징 트랙. ${latestDate}.`,
                        ),
                      )
                    }
                  >
                    <Crown size={15} />
                    {pick(locale, 'Create from this artist', '이 아티스트 곡으로 생성')}
                  </button>
                </div>
              </article>
            )
          })}
        </div>

        <aside className="rising-chart-panel">
          <div className="rising-panel-heading">
            <h3>
              <TrendingUp size={17} />
              {pick(locale, 'Rising Chart', '라이징 차트')}
            </h3>
            <p>{pick(locale, 'Ranked by score slope and country reach expansion.', '점수 기울기와 노출국 확장을 합산한 순위입니다.')}</p>
          </div>

          <div className="rising-ranking-list">
            {visibleArtists.slice(0, 12).map((artist, index) => (
              <div key={`rank-${artist.id}`} className="rising-ranking-row">
                <strong>{index + 1}</strong>
                <span style={{ background: artist.color }} />
                <div>
                  <b>{artist.artist}</b>
                  <small>
                    #{artist.firstRank} → #{artist.rank} · {formatSigned(locale, artist.scoreDelta)}{pick(locale, ' pts', '점')}
                  </small>
                </div>
                <em>{formatNumber(locale, artist.risingScore)}</em>
              </div>
            ))}
          </div>

          <div className="rising-panel-heading track-heading">
            <h3>
              <Music2 size={17} />
              {pick(locale, 'Track Candidates', '곡 후보')}
            </h3>
          </div>
          <div className="rising-track-chart">
            {risingTracks.slice(0, 12).map((track, index) => (
              <a
                key={`track-${track.id}`}
                href={track.url || `https://open.spotify.com/track/${track.id}`}
                target="_blank"
                rel="noreferrer"
              >
                <strong>{index + 1}</strong>
                <div>
                  <b>{track.title}</b>
                  <small>{track.artist} · #{track.firstRank} → #{track.rank}</small>
                </div>
                <span>{formatSigned(locale, track.scoreDelta)}</span>
              </a>
            ))}
          </div>
        </aside>
      </section>

      <footer className="rising-footnote">
        <UsersRound size={15} />
        {pick(
          locale,
          'Artist images and Spotify links are fetched live from the Spotify API and are not stored. If lookup fails, the card uses color and initials as fallback.',
          '이미지와 Spotify 링크는 저장하지 않고 접속 시점에 Spotify API에서 조회합니다. 조회 실패 시 카드의 색상/이니셜 fallback을 사용합니다.',
        )}
      </footer>
    </section>
  )
}

export default RisingDiscovery
