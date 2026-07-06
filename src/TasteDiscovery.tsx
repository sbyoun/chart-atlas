import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  ExternalLink,
  Heart,
  Loader2,
  Music2,
  RotateCcw,
  Sparkles,
  ThumbsDown,
  Trophy,
} from 'lucide-react'
import './TasteDiscovery.css'
import { formatCount, formatNumberForLocale, pick, type Locale } from './i18n'
import type { ChartEntry, ChartSnapshotData, Country, Track } from './data/chartSnapshot'

type SnapshotOption = {
  date: string
  countries: number
  tracks: number
}

type TasteDiscoveryProps = {
  snapshot: ChartSnapshotData
  snapshotIndex?: SnapshotOption[]
  selectedDate?: string
  snapshotLoading?: boolean
  onSelectedDateChange?: (date: string) => void
  locale: Locale
}

type GenreSignal = {
  genre: {
    id: string
    name: string
    nativeName?: string
    region: string
    countries: string
    color: string
    tags: string[]
  }
  rank: number
  chartPopularityScore: number
  matchedTracks: Array<{
    track: Track
    country: Country
    entry: ChartEntry & { streams?: number }
    reasons: string[]
    weightedScore: number
  }>
}

type GenreDiscoveryPayload = {
  snapshotDate?: string
  signals?: GenreSignal[]
}

type TasteCandidate = {
  id: string
  genreId: string
  genreName: string
  nativeName?: string
  genreColor: string
  genreRank: number
  genreScore: number
  region: string
  tags: string[]
  track: Track
  country: Country
  entry: ChartEntry & { streams?: number }
  reasons: string[]
  weightedScore: number
}

type TrackProfile = {
  id: string
  title: string
  artist: string
  imageUrl: string
  previewUrl: string
  sourceUrl: string
  embedUrl: string
  provider: string
  providerLabel: string
  playable: boolean
}

type TasteAction = 'like' | 'dislike' | 'skip'

type TasteRating = {
  candidateId: string
  trackId: string
  genreId: string
  genreName: string
  action: TasteAction
  at: string
}

type PlaylistStatus =
  | { type: 'idle'; message: string }
  | { type: 'working'; message: string }
  | { type: 'success'; message: string; url: string }
  | { type: 'error'; message: string }

type TasteResult = {
  topGenre?: {
    id: string
    name: string
    score: number
    likes: number
    dislikes: number
    skips: number
  }
  rankedGenres: Array<{
    id: string
    name: string
    score: number
    likes: number
    dislikes: number
    skips: number
  }>
  likedCandidates: TasteCandidate[]
}

const APP_BASE_URL =
  import.meta.env.BASE_URL === '/' ? '' : import.meta.env.BASE_URL.replace(/\/$/, '')
const TASTE_HISTORY_STORAGE_KEY = 'chart-atlas-taste-history-v1'
const MAX_DECK_SIZE = 18

function apiUrl(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${APP_BASE_URL}${normalizedPath}`
}

function rankScore(rank: number) {
  return Math.max(0, 101 - rank)
}

function createSpotifyTrackUri(trackId: string) {
  return /^[A-Za-z0-9]{22}$/.test(trackId) ? `spotify:track:${trackId}` : ''
}

function appendTasteHistory(rating: TasteRating) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TASTE_HISTORY_STORAGE_KEY) || '[]')
    const history = Array.isArray(parsed) ? parsed : []
    history.push(rating)
    window.localStorage.setItem(TASTE_HISTORY_STORAGE_KEY, JSON.stringify(history.slice(-500)))
  } catch {
    window.localStorage.setItem(TASTE_HISTORY_STORAGE_KEY, JSON.stringify([rating]))
  }
}

function createRandom(seed: number) {
  let state = Math.floor(seed) || 1

  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function shuffleWithRandom<T>(items: T[], random: () => number) {
  const shuffled = [...items]

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const nextIndex = Math.floor(random() * (index + 1))
    ;[shuffled[index], shuffled[nextIndex]] = [shuffled[nextIndex], shuffled[index]]
  }

  return shuffled
}

function pickRandomMatch(signal: GenreSignal, seenTrackIds: Set<string>, random: () => number) {
  const matches = [...(signal.matchedTracks || [])]
    .sort(
      (a, b) =>
        b.weightedScore + rankScore(b.entry.rank) - (a.weightedScore + rankScore(a.entry.rank)),
    )
    .slice(0, 12)
    .filter((match) => !seenTrackIds.has(match.track.id))

  return matches[Math.floor(random() * matches.length)]
}

function buildTasteDeck(signals: GenreSignal[], seed: number) {
  const seenTrackIds = new Set<string>()
  const candidates: TasteCandidate[] = []
  const random = createRandom(seed)
  const shuffledSignals = shuffleWithRandom(
    signals.filter((signal) => signal.matchedTracks?.length),
    random,
  )

  for (const signal of shuffledSignals) {
    const match = pickRandomMatch(signal, seenTrackIds, random)
    if (!match) continue

    seenTrackIds.add(match.track.id)
    candidates.push({
      id: `${signal.genre.id}:${match.track.id}`,
      genreId: signal.genre.id,
      genreName: signal.genre.name,
      nativeName: signal.genre.nativeName,
      genreColor: signal.genre.color,
      genreRank: signal.rank,
      genreScore: signal.chartPopularityScore,
      region: signal.genre.region,
      tags: signal.genre.tags || [],
      track: match.track,
      country: match.country,
      entry: match.entry,
      reasons: match.reasons || [],
      weightedScore: match.weightedScore,
    })

    if (candidates.length >= MAX_DECK_SIZE) break
  }

  return candidates
}

function buildFallbackDeck(snapshot: ChartSnapshotData, seed: number) {
  const trackById = new Map(snapshot.tracks.map((track) => [track.id, track]))
  const bestEntryByTrack = new Map<
    string,
    { track: Track; country: Country; entry: ChartEntry & { streams?: number } }
  >()

  for (const chart of snapshot.countryCharts) {
    const country = snapshot.countries.find((item) => item.code === chart.countryCode)
    if (!country) continue

    for (const entry of chart.entries.slice(0, 20)) {
      const track = trackById.get(entry.trackId)
      if (!track) continue
      const current = bestEntryByTrack.get(track.id)

      if (!current || entry.rank < current.entry.rank) {
        bestEntryByTrack.set(track.id, { track, country, entry })
      }
    }
  }

  const random = createRandom(seed)

  return shuffleWithRandom(
    [...bestEntryByTrack.values()].sort((a, b) => a.entry.rank - b.entry.rank).slice(0, 40),
    random,
  )
    .slice(0, Math.min(MAX_DECK_SIZE, 10))
    .map<TasteCandidate>((item, index) => ({
      id: `chart:${item.track.id}`,
      genreId: item.track.genre || 'chart-hit',
      genreName: item.track.genre || 'Chart Hit',
      genreColor: item.track.color,
      genreRank: index + 1,
      genreScore: rankScore(item.entry.rank),
      region: item.country.region,
      tags: ['chart'],
      track: item.track,
      country: item.country,
      entry: item.entry,
      reasons: [item.track.genre || 'Current chart track'],
      weightedScore: rankScore(item.entry.rank),
    }))
}

function calculateTasteResult(ratings: TasteRating[], candidates: TasteCandidate[]): TasteResult {
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]))
  const stats = new Map<
    string,
    { id: string; name: string; score: number; likes: number; dislikes: number; skips: number }
  >()
  const likedCandidates: TasteCandidate[] = []

  for (const rating of ratings) {
    const candidate = candidatesById.get(rating.candidateId)
    if (!candidate) continue

    const stat =
      stats.get(candidate.genreId) ||
      {
        id: candidate.genreId,
        name: candidate.genreName,
        score: 0,
        likes: 0,
        dislikes: 0,
        skips: 0,
      }

    if (rating.action === 'like') {
      stat.score += 3
      stat.likes += 1
      likedCandidates.push(candidate)
    } else if (rating.action === 'dislike') {
      stat.score -= 1.5
      stat.dislikes += 1
    } else {
      stat.skips += 1
    }

    stats.set(candidate.genreId, stat)
  }

  const rankedGenres = [...stats.values()].sort(
    (a, b) => b.score - a.score || b.likes - a.likes || a.dislikes - b.dislikes,
  )

  return {
    topGenre: rankedGenres[0],
    rankedGenres,
    likedCandidates,
  }
}

function playlistUrisForResult(result: TasteResult, candidates: TasteCandidate[]) {
  if (result.likedCandidates.length === 0) {
    return []
  }

  const targetGenres = new Set(result.rankedGenres.slice(0, 3).map((genre) => genre.id))
  const likedTrackIds = new Set(result.likedCandidates.map((candidate) => candidate.track.id))
  const uriCandidates = [
    ...result.likedCandidates,
    ...candidates.filter((candidate) => targetGenres.has(candidate.genreId)),
    ...candidates.filter((candidate) => likedTrackIds.has(candidate.track.id)),
  ]

  return [
    ...new Set(
      uriCandidates
        .map((candidate) => createSpotifyTrackUri(candidate.track.id))
        .filter(Boolean),
    ),
  ].slice(0, 60)
}

function sourceLabel(profile: TrackProfile | undefined, locale: Locale) {
  if (!profile) return pick(locale, 'Source loading', '소스 로딩 중')
  if (profile.provider === 'apple' && profile.previewUrl) {
    return pick(locale, 'Apple preview', 'Apple 미리듣기')
  }
  return pick(locale, 'Preview unavailable', '미리듣기 없음')
}

function hasApplePreview(profile: TrackProfile | undefined) {
  return Boolean(profile?.provider === 'apple' && profile.previewUrl)
}

function describeTasteResult(result: TasteResult, locale: Locale) {
  const topGenre = result.topGenre
  const positiveGenres = result.rankedGenres
    .filter((genre) => genre.likes > 0 || genre.score > 0)
    .slice(0, 3)
  const likedTracks = result.likedCandidates.slice(0, 3)
  const likedTrackNames = likedTracks.map((candidate) => candidate.track.title)

  if (!topGenre || topGenre.likes <= 0) {
    return {
      title: pick(locale, 'Your taste is still in explorer mode.', '아직 취향이 탐험 모드입니다.'),
      body: pick(
        locale,
        'You skipped around more than you committed, which usually means your ear is still scanning the room. Try another round and give a few tracks a decisive like or dislike.',
        '아직은 한 장르에 꽂혔다기보다 방 안을 천천히 둘러보는 귀에 가깝습니다. 한 번 더 돌면서 몇 곡에 확실히 좋아요나 싫어요를 눌러보면 취향 윤곽이 훨씬 선명해집니다.',
      ),
      chips: [pick(locale, 'Open-ended', '열린 취향'), pick(locale, 'Still scanning', '탐색 중')],
    }
  }

  const supportLine =
    positiveGenres.length >= 3
      ? pick(
          locale,
          `Your main lane is ${positiveGenres[0].name}, with ${positiveGenres[1].name} and ${positiveGenres[2].name} adding color around the edges.`,
          `중심축은 ${positiveGenres[0].name}이고, 주변부에 ${positiveGenres[1].name}와 ${positiveGenres[2].name}가 색을 더합니다.`,
        )
      : positiveGenres.length === 2
        ? pick(
            locale,
            `${positiveGenres[0].name} leads, but ${positiveGenres[1].name} keeps pulling your ear sideways.`,
            `${positiveGenres[0].name}이 앞서지만 ${positiveGenres[1].name}도 계속 귀를 잡아끕니다.`,
          )
        : pick(
            locale,
            `${positiveGenres[0].name} is clearly the strongest signal in this run.`,
            `이번 라운드에서는 ${positiveGenres[0].name} 신호가 가장 뚜렷합니다.`,
          )

  const trackLine =
    likedTrackNames.length > 0
      ? pick(
          locale,
          `The tracks that gave it away: ${likedTrackNames.join(', ')}.`,
          `취향을 들킨 곡들: ${likedTrackNames.join(', ')}.`,
        )
      : pick(
          locale,
          'Your likes were sparse, so this result is reading the strongest genre signal rather than a full personality map.',
          '좋아요가 많지는 않아서, 전체 성격표라기보다 가장 강한 장르 신호를 읽은 결과에 가깝습니다.',
        )

  const confidence = result.likedCandidates.length >= 5
    ? pick(locale, 'high-confidence', '확신 높은')
    : result.likedCandidates.length >= 3
      ? pick(locale, 'promising', '꽤 선명한')
      : pick(locale, 'early signal', '초기 신호')

  return {
    title: pick(
      locale,
      `You have a ${confidence} ${topGenre.name} streak.`,
      `당신에게는 ${confidence} ${topGenre.name} 결이 있습니다.`,
    ),
    body: `${supportLine} ${trackLine} ${pick(
      locale,
      'This is the kind of taste profile that works best as a short, high-contrast playlist rather than a safe background mix.',
      '이 취향은 무난한 배경음악보다, 색이 분명한 짧은 플레이리스트로 만들 때 더 잘 살아납니다.',
    )}`,
    chips: [
      topGenre.name,
      pick(locale, `${topGenre.likes} likes`, `좋아요 ${topGenre.likes}개`),
      pick(locale, confidence, confidence),
    ],
  }
}

function TasteDiscovery({
  snapshot,
  snapshotIndex = [],
  selectedDate = snapshot.snapshotDate,
  snapshotLoading = false,
  onSelectedDateChange,
  locale,
}: TasteDiscoveryProps) {
  const [signals, setSignals] = useState<GenreSignal[]>([])
  const [signalsStatus, setSignalsStatus] = useState<'loading' | 'ready' | 'missing'>('loading')
  const [profiles, setProfiles] = useState<Map<string, TrackProfile>>(new Map())
  const [ratings, setRatings] = useState<TasteRating[]>([])
  const [sessionSeed, setSessionSeed] = useState(() => Date.now() + Math.random() * 100000)
  const [soundUnlocked, setSoundUnlocked] = useState(false)
  const [autoplayBlockedFor, setAutoplayBlockedFor] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const pendingProfileIdsRef = useRef<Set<string>>(new Set())
  const [playlistStatus, setPlaylistStatus] = useState<PlaylistStatus>({
    type: 'idle',
    message: pick(locale, 'Rate genres to build a taste playlist.', '장르별 곡을 평가하면 취향 플레이리스트를 만들 수 있습니다.'),
  })

  useEffect(() => {
    let ignore = false

    async function loadSignals() {
      setSignalsStatus('loading')

      try {
        const candidates = [
          `/data/genre-discovery/${snapshot.snapshotDate}.json`,
          '/data/genre-discovery.json',
        ]
        let payload: GenreDiscoveryPayload | null = null

        for (const candidate of candidates) {
          const response = await fetch(apiUrl(`${candidate}?v=${snapshot.snapshotDate}`))
          if (!response.ok) continue
          payload = (await response.json()) as GenreDiscoveryPayload
          break
        }

        if (!ignore && payload?.signals?.length) {
          setSignals(payload.signals)
          setSignalsStatus('ready')
        } else if (!ignore) {
          setSignals([])
          setSignalsStatus('missing')
        }
      } catch {
        if (!ignore) {
          setSignals([])
          setSignalsStatus('missing')
        }
      }
    }

    void loadSignals()

    return () => {
      ignore = true
    }
  }, [snapshot.snapshotDate])

  const candidates = useMemo(() => {
    const deck = buildTasteDeck(signals, sessionSeed)
    return deck.length > 0 ? deck : buildFallbackDeck(snapshot, sessionSeed)
  }, [sessionSeed, signals, snapshot])
  const applePreviewCandidates = useMemo(
    () =>
      candidates.filter((candidate) => {
        const profile = profiles.get(candidate.track.id)
        return !profile || hasApplePreview(profile)
      }),
    [candidates, profiles],
  )
  const unresolvedProfileCount = candidates.filter(
    (candidate) => !profiles.has(candidate.track.id),
  ).length
  const noApplePreviewCandidates =
    candidates.length > 0 && applePreviewCandidates.length === 0 && unresolvedProfileCount === 0
  const currentIndex = Math.min(ratings.length, applePreviewCandidates.length)
  const currentCandidate = applePreviewCandidates[currentIndex]
  const finished =
    applePreviewCandidates.length > 0 && currentIndex >= applePreviewCandidates.length
  const progressPercent =
    applePreviewCandidates.length > 0
      ? Math.round((currentIndex / applePreviewCandidates.length) * 100)
      : 0
  const result = useMemo(
    () => calculateTasteResult(ratings, applePreviewCandidates),
    [ratings, applePreviewCandidates],
  )
  const currentProfile = currentCandidate ? profiles.get(currentCandidate.track.id) : undefined
  const resultSummary = useMemo(() => describeTasteResult(result, locale), [locale, result])
  const resultArtworkUrls = useMemo(() => {
    const topGenreIds = new Set(result.rankedGenres.slice(0, 3).map((genre) => genre.id))
    const artworkCandidates = [
      ...result.likedCandidates,
      ...applePreviewCandidates.filter((candidate) => topGenreIds.has(candidate.genreId)),
    ]

    return [
      ...new Set(
        artworkCandidates
          .map((candidate) => profiles.get(candidate.track.id)?.imageUrl || '')
          .filter(Boolean),
      ),
    ].slice(0, 5)
  }, [applePreviewCandidates, profiles, result.likedCandidates, result.rankedGenres])
  const autoplayBlocked = Boolean(currentCandidate && autoplayBlockedFor === currentCandidate.id)
  const displayedPlaylistStatus: PlaylistStatus =
    playlistStatus.type === 'idle'
      ? {
          type: 'idle',
          message: pick(locale, 'Rate genres to build a taste playlist.', '장르별 곡을 평가하면 취향 플레이리스트를 만들 수 있습니다.'),
        }
      : playlistStatus
  const snapshotOptions =
    snapshotIndex.length > 0
      ? snapshotIndex
      : [
          {
            date: snapshot.snapshotDate,
            countries: snapshot.countries.length,
            tracks: snapshot.tracks.length,
          },
        ]

  useEffect(() => {
    pendingProfileIdsRef.current.clear()
  }, [sessionSeed, snapshot.snapshotDate])

  useEffect(() => {
    const tracks = applePreviewCandidates
      .slice(currentIndex, Math.min(applePreviewCandidates.length, currentIndex + 3))
      .filter((candidate) => !profiles.has(candidate.track.id))
      .filter((candidate) => !pendingProfileIdsRef.current.has(candidate.track.id))
      .map((candidate) => ({
        ...candidate.track,
        countryCode: candidate.country.code,
      }))

    for (const track of tracks) {
      pendingProfileIdsRef.current.add(track.id)
    }

    async function loadProfiles() {
      if (tracks.length === 0) {
        return
      }

      try {
        const response = await fetch(apiUrl('/api/taste/track-profiles'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tracks }),
        })
        const payload = (await response.json()) as { profiles?: TrackProfile[] }

        if (!response.ok) {
          throw new Error('Failed to load taste track profiles.')
        }

        setProfiles((current) => {
          const next = new Map(current)
          for (const profile of payload.profiles || []) {
            next.set(profile.id, profile)
          }
          return next
        })
      } catch {
        for (const track of tracks) {
          pendingProfileIdsRef.current.delete(track.id)
        }
      } finally {
        for (const track of tracks) {
          pendingProfileIdsRef.current.delete(track.id)
        }
      }
    }

    void loadProfiles()
  }, [applePreviewCandidates, currentIndex, profiles])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !currentProfile?.previewUrl || finished) {
      return
    }

    audio.currentTime = 0
    const candidateId = currentCandidate?.id || ''
    setAutoplayBlockedFor('')
    const timeoutId = window.setTimeout(() => {
      void audio.play().catch(() => setAutoplayBlockedFor(candidateId))
    }, 120)

    return () => {
      window.clearTimeout(timeoutId)
      audio.pause()
    }
  }, [currentCandidate?.id, currentProfile?.previewUrl, finished])

  function rateCurrent(action: TasteAction) {
    if (!currentCandidate) return

    const rating: TasteRating = {
      candidateId: currentCandidate.id,
      trackId: currentCandidate.track.id,
      genreId: currentCandidate.genreId,
      genreName: currentCandidate.genreName,
      action,
      at: new Date().toISOString(),
    }

    appendTasteHistory(rating)
    setRatings((items) => [...items, rating])
    setPlaylistStatus({
      type: 'idle',
      message: pick(locale, 'Rate genres to build a taste playlist.', '장르별 곡을 평가하면 취향 플레이리스트를 만들 수 있습니다.'),
    })
  }

  function resetSession() {
    setRatings([])
    setSessionSeed(Date.now() + Math.random() * 100000)
    setSoundUnlocked(false)
    setAutoplayBlockedFor('')
    setPlaylistStatus({
      type: 'idle',
      message: pick(locale, 'Rate genres to build a taste playlist.', '장르별 곡을 평가하면 취향 플레이리스트를 만들 수 있습니다.'),
    })
  }

  async function enableSound() {
    const audio = audioRef.current
    if (!audio || !currentCandidate || !currentProfile?.previewUrl) return

    try {
      audio.currentTime = 0
      await audio.play()
      setSoundUnlocked(true)
      setAutoplayBlockedFor('')
    } catch {
      setAutoplayBlockedFor(currentCandidate.id)
    }
  }

  async function createTastePlaylist() {
    const trackUris = playlistUrisForResult(result, applePreviewCandidates)

    if (trackUris.length === 0) {
      setPlaylistStatus({
        type: 'error',
        message: pick(locale, 'There are no liked or matching tracks to export.', '내보낼 좋아요 또는 매칭 곡이 없습니다.'),
      })
      return
    }

    setPlaylistStatus({
      type: 'working',
      message: pick(
        locale,
        `Creating a taste playlist with ${trackUris.length} tracks.`,
        `${trackUris.length}곡으로 취향 플레이리스트를 생성하는 중입니다.`,
      ),
    })

    try {
      const topGenreName = result.topGenre?.name || pick(locale, 'Taste Mix', '취향 믹스')
      const response = await fetch(apiUrl('/api/playlists/create-from-tracks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Chart Atlas Taste: ${topGenreName}`,
          description: pick(
            locale,
            `Taste sampler playlist based on liked tracks and ${topGenreName} signals. Chart Atlas ${snapshot.snapshotDate}.`,
            `좋아요한 곡과 ${topGenreName} 신호를 기반으로 만든 취향 샘플러 플레이리스트. Chart Atlas ${snapshot.snapshotDate}.`,
          ),
          trackUris,
          public: true,
        }),
      })
      const payload = (await response.json()) as {
        playlist?: { openUrl?: string; name?: string }
        error?: string
      }

      if (!response.ok || !payload.playlist?.openUrl) {
        throw new Error(payload.error || pick(locale, 'Failed to create the playlist.', '플레이리스트 생성에 실패했습니다.'))
      }

      setPlaylistStatus({
        type: 'success',
        message: pick(
          locale,
          `${payload.playlist.name || 'Taste playlist'} created`,
          `${payload.playlist.name || '취향 플레이리스트'} 생성 완료`,
        ),
        url: payload.playlist.openUrl,
      })
      window.open(payload.playlist.openUrl, '_blank', 'noopener,noreferrer')
    } catch (error) {
      setPlaylistStatus({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if ((signalsStatus === 'loading' || snapshotLoading) && candidates.length === 0) {
    return (
      <section className="taste-page taste-loading">
        <Loader2 size={22} />
        {pick(locale, 'Loading taste sampler.', '취향 샘플러를 불러오는 중입니다.')}
      </section>
    )
  }

  if (candidates.length === 0 || noApplePreviewCandidates) {
    return (
      <section className="taste-page taste-loading">
        <Sparkles size={22} />
        {noApplePreviewCandidates
          ? pick(
              locale,
              'No Apple preview candidates are available for this sampler.',
              '이 샘플러에 사용할 수 있는 Apple 미리듣기 후보가 없습니다.',
            )
          : pick(locale, 'No taste candidates are available for this snapshot.', '이 스냅샷에는 취향 후보가 없습니다.')}
      </section>
    )
  }

  return (
    <section className="taste-page">
      <header className="taste-hero">
        <div>
          <span className="taste-kicker">
            <Sparkles size={15} />
            {pick(locale, 'Interactive sampler', '참여형 샘플러')}
          </span>
          <h2>{pick(locale, 'Taste Discovery', '취향 발견')}</h2>
          <p>
            {pick(
              locale,
              'Sample one current chart track per genre, rate it, and get a taste profile with a playlist export.',
              '장르별 현재 인기곡을 하나씩 짧게 들어보고 평가하면 취향 장르와 플레이리스트를 만들어줍니다.',
            )}
          </p>
        </div>
        <div className="taste-controls">
          <label>
            {pick(locale, 'Snapshot', '기준 주차')}
            <select
              value={selectedDate ?? snapshot.snapshotDate}
              disabled={!onSelectedDateChange || snapshotLoading}
              onChange={(event) => {
                resetSession()
                onSelectedDateChange?.(event.target.value)
              }}
            >
              {snapshotOptions.map((entry) => (
                <option key={entry.date} value={entry.date}>
                  {entry.date} · {formatCount(locale, entry.countries, 'country', 'countries', '개국')}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="taste-reset" onClick={resetSession}>
            <RotateCcw size={15} />
            {pick(locale, 'Restart', '다시 시작')}
          </button>
        </div>
      </header>

      <div className="taste-progress">
        <div>
          <span style={{ width: `${progressPercent}%` }} />
        </div>
        <p>
          {formatCount(locale, currentIndex, 'rated card', 'rated cards', '개 평가')} /{' '}
          {formatCount(locale, applePreviewCandidates.length, 'Apple preview card', 'Apple preview cards', '개 Apple 미리듣기 카드')}
        </p>
      </div>

      {!finished && currentCandidate ? (
        <section className="taste-stage">
          <article
            className="taste-card"
            style={{ '--genre-color': currentCandidate.genreColor } as CSSProperties}
          >
            <div className="taste-cover">
              {currentProfile?.imageUrl ? (
                <img src={currentProfile.imageUrl} alt="" />
              ) : (
                <span>{currentCandidate.genreName.slice(0, 2).toUpperCase()}</span>
              )}
              <div className="taste-cover-badge">
                #{currentCandidate.genreRank} {currentCandidate.genreName}
              </div>
            </div>

            <div className="taste-card-body">
              <div className="taste-genre-row">
                <span>{currentCandidate.region}</span>
                <small>{sourceLabel(currentProfile, locale)}</small>
              </div>
              <h3>{currentProfile?.title || currentCandidate.track.title}</h3>
              <p>{currentProfile?.artist || currentCandidate.track.artist}</p>

              <div className="taste-context">
                <span>
                  {currentCandidate.country.name} #{currentCandidate.entry.rank}
                </span>
                <span>
                  {pick(locale, 'score', '점수')} {formatNumberForLocale(locale, Math.round(currentCandidate.weightedScore))}
                </span>
                {currentCandidate.entry.streams ? (
                  <span>
                    {formatNumberForLocale(locale, currentCandidate.entry.streams)}{' '}
                    {pick(locale, 'streams', '스트림')}
                  </span>
                ) : null}
              </div>

              <div className="taste-tags">
                {currentCandidate.tags.slice(0, 4).map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>

              <div className="taste-player">
                {!currentProfile ? (
                  <div className="taste-player-loading">
                    <Loader2 size={17} />
                    {pick(locale, 'Loading playable source.', '재생 소스를 불러오는 중입니다.')}
                  </div>
                ) : hasApplePreview(currentProfile) ? (
                  <>
                    <audio
                      key={currentProfile.id}
                      ref={audioRef}
                      src={currentProfile.previewUrl}
                      controls
                      autoPlay
                      preload="auto"
                      playsInline
                    />
                    {autoplayBlocked ? (
                      <div className="taste-autoplay-note">
                        <span>
                          {pick(
                            locale,
                            'Autoplay was blocked by the browser. Tap once to enable sound.',
                            '브라우저가 자동 재생을 막았습니다. 한 번 탭해서 소리를 켜주세요.',
                          )}
                        </span>
                        <button type="button" onClick={() => void enableSound()}>
                          {pick(locale, 'Start audio', '소리 켜기')}
                        </button>
                      </div>
                    ) : !soundUnlocked ? (
                      <p className="taste-autoplay-note">
                        {pick(
                          locale,
                          'If this stays silent, tap play once. The next preview can continue automatically.',
                          '소리가 안 나면 한 번만 재생을 눌러주세요. 이후 프리뷰는 이어서 자동 재생될 수 있습니다.',
                        )}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <div className="taste-no-preview">
                    {pick(locale, 'Skipping tracks without Apple preview.', 'Apple 미리듣기가 없는 곡은 제외합니다.')}
                  </div>
                )}
              </div>

              <div className="taste-actions">
                <button type="button" className="dislike" onClick={() => rateCurrent('dislike')}>
                  <ThumbsDown size={18} />
                  {pick(locale, 'Dislike', '싫어요')}
                </button>
                <button type="button" className="skip" onClick={() => rateCurrent('skip')}>
                  {pick(locale, 'Skip', '넘기기')}
                </button>
                <button type="button" className="like" onClick={() => rateCurrent('like')}>
                  <Heart size={18} />
                  {pick(locale, 'Like', '좋아요')}
                </button>
              </div>

              {currentProfile?.sourceUrl ? (
                <a className="taste-source-link" href={currentProfile.sourceUrl} target="_blank" rel="noreferrer">
                  <ExternalLink size={14} />
                  {pick(locale, 'Open source', '소스 열기')}
                </a>
              ) : null}
            </div>
          </article>
        </section>
      ) : (
        <section className="taste-result">
          <div className="taste-result-card taste-result-card-rich">
            <div className="taste-result-copy">
              <span>
                <Trophy size={17} />
                {pick(locale, 'Your taste result', '나의 취향 결과')}
              </span>
              <h3>{resultSummary.title}</h3>
              <p>{resultSummary.body}</p>
              <div className="taste-result-chips">
                {resultSummary.chips.map((chip) => (
                  <small key={chip}>{chip}</small>
                ))}
              </div>
            </div>

            <div className="taste-result-art" aria-hidden="true">
              {resultArtworkUrls.length > 0 ? (
                resultArtworkUrls.map((url, index) => (
                  <img key={`${url}-${index}`} src={url} alt="" />
                ))
              ) : (
                resultSummary.chips.slice(0, 3).map((chip, index) => (
                  <div key={`${chip}-${index}`}>{chip.slice(0, 2).toUpperCase()}</div>
                ))
              )}
            </div>
          </div>

          <div className="taste-result-grid">
            <div className="taste-result-panel">
              <h3>{pick(locale, 'Genre Ranking', '장르 순위')}</h3>
              {result.rankedGenres.length > 0 ? (
                result.rankedGenres.slice(0, 6).map((genre, index) => (
                  <div key={genre.id} className="taste-result-row">
                    <strong>#{index + 1}</strong>
                    <div>
                      <b>{genre.name}</b>
                      <small>
                        {pick(locale, 'score', '점수')} {genre.score.toFixed(1)} · {genre.likes} LIKE
                      </small>
                    </div>
                  </div>
                ))
              ) : (
                <p>{pick(locale, 'No ratings yet.', '아직 평가가 없습니다.')}</p>
              )}
            </div>

            <div className="taste-result-panel">
              <h3>{pick(locale, 'Liked Tracks', '좋아요한 곡')}</h3>
              {result.likedCandidates.length > 0 ? (
                result.likedCandidates.slice(0, 8).map((candidate) => (
                  <div key={`liked-${candidate.id}`} className="taste-result-row">
                    <span style={{ background: candidate.genreColor }} />
                    <div>
                      <b>{candidate.track.title}</b>
                      <small>
                        {candidate.track.artist} · {candidate.genreName}
                      </small>
                    </div>
                  </div>
                ))
              ) : (
                <p>{pick(locale, 'No liked tracks in this session.', '이번 세션에서 좋아요한 곡이 없습니다.')}</p>
              )}
            </div>
          </div>

          <div className="taste-playlist-box">
            <span className={displayedPlaylistStatus.type}>
              {displayedPlaylistStatus.type === 'success' ? (
                <a href={displayedPlaylistStatus.url} target="_blank" rel="noreferrer">
                  {displayedPlaylistStatus.message}
                </a>
              ) : (
                displayedPlaylistStatus.message
              )}
            </span>
            <button
              type="button"
              disabled={playlistStatus.type === 'working' || result.likedCandidates.length === 0}
              onClick={() => void createTastePlaylist()}
            >
              {playlistStatus.type === 'working' ? <Loader2 size={16} /> : <Music2 size={16} />}
              {pick(locale, 'Create playlist from this taste', '이 취향으로 플레이리스트 만들기')}
            </button>
            <button type="button" className="secondary" onClick={resetSession}>
              <RotateCcw size={15} />
              {pick(locale, 'Try again', '다시 해보기')}
            </button>
          </div>
        </section>
      )}
    </section>
  )
}

export default TasteDiscovery
