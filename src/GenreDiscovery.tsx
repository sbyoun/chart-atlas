import { useEffect, useMemo, useState } from 'react'
import { Crown, Music2, Search } from 'lucide-react'
import './GenreDiscovery.css'
import { localGenres, type LocalGenreDefinition, type LocalGenreTrackSeed } from './data/localGenres'
import type { ChartEntry, ChartSnapshotData, Country, Track } from './data/chartSnapshot'
import { formatCount, pick, type Locale } from './i18n'

type GenreMatch = {
  track: Track
  country: Country
  entry: ChartEntry
  reasons: string[]
  scope: 'target' | 'regional' | 'global'
  weightedScore: number
}

type GenreContextTrack = {
  track: Track
  country: Country
  entry: ChartEntry
}

type ArtistMetadata = {
  id: string
  name: string
  genres: string[]
  tags: string[]
  descriptions: string[]
  sources: string[]
  popularity?: number | null
}

type TrackMetadata = {
  id: string
  inputTitle?: string
  inputArtist?: string
  title: string
  artist: string
  genres: string[]
  tags: string[]
  descriptions: string[]
  sources: string[]
  countryCode?: string
  matchScore?: number
}

type GenreSignal = {
  genre: LocalGenreDefinition
  rank: number
  chartPopularityScore: number
  targetChartScore: number
  expandedChartScore: number
  confidence: 'chart' | 'coverage' | 'curated'
  availableCountries: Country[]
  missingCountryCodes: string[]
  matchedTracks: GenreMatch[]
  contextTracks: GenreContextTrack[]
}

type PlaylistCreateStatus =
  | { type: 'idle'; message: string }
  | { type: 'working'; message: string }
  | { type: 'success'; message: string; url: string }
  | { type: 'error'; message: string }

type GenreMetadataState = {
  status: 'loading' | 'ready'
  artistById: Map<string, ArtistMetadata>
  trackById: Map<string, TrackMetadata>
}

type PrecomputedGenreDiscoveryPayload = {
  snapshotDate?: string
  scoreMode?: string
  signals?: GenreSignal[]
}

type SnapshotOption = {
  date: string
  countries: number
  tracks: number
}

type GenreDiscoveryProps = {
  snapshot: ChartSnapshotData
  snapshotIndex?: SnapshotOption[]
  selectedDate?: string
  snapshotLoading?: boolean
  onSelectedDateChange?: (date: string) => void
  locale: Locale
}

const APP_BASE_URL =
  import.meta.env.BASE_URL === '/' ? '' : import.meta.env.BASE_URL.replace(/\/$/, '')

function apiUrl(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${APP_BASE_URL}${normalizedPath}`
}

type GenreLocalizedCopy = {
  summary: string
  whyLocal: string
}

const GENRE_COPY_EN: Record<string, GenreLocalizedCopy> = {
  'hip-hop-rap': {
    summary: 'One of the strongest mainstream genre families in current global streaming charts.',
    whyLocal: 'It is used as a mainstream baseline for local genre discovery because many countries have domestic rap scenes near the top of their charts.',
  },
  pop: {
    summary: 'A global pop category that acts as a core reference point for country-level charts.',
    whyLocal: 'Large genres such as pop need to sit in the same ranking table so local genres can be compared against mainstream demand.',
  },
  'k-pop': {
    summary: 'A Korean idol and pop industry genre that now enters charts worldwide.',
    whyLocal: 'It is local inside Korea but imported elsewhere, which makes it useful for tracking regional spread.',
  },
  'r-and-b': {
    summary: 'A vocal-led global popular music category.',
    whyLocal: 'It often overlaps with hip-hop and pop, so chart-based genre comparison benefits from keeping it as a separate axis.',
  },
  'dance-electronic': {
    summary: 'A global electronic music family rooted in clubs, festivals, and dance-pop crossover.',
    whyLocal: 'It can look blended into pop on country charts, but it is a useful baseline for regional club sounds.',
  },
  'rock-alternative': {
    summary: 'A band-oriented rock and alternative genre family.',
    whyLocal: 'Different local band scenes in Japan, Europe, the United States, and elsewhere show up differently on charts.',
  },
  country: {
    summary: 'A country and country-pop genre with strong streaming chart impact in North America.',
    whyLocal: 'It is powerful in the United States but still behaves like a strongly local genre outside its core markets.',
  },
  'reggaeton-latin-urbano': {
    summary: 'A core urban music family across Latin America and Spanish-language charts.',
    whyLocal: 'It is both global and locally variant, so it matters for chart-based regional comparison.',
  },
  'latin-pop-musica-latina': {
    summary: 'A broad Latin mainstream category covering Spanish-language pop, urbano, tropical, and related chart music.',
    whyLocal: 'Before metadata splits into genres such as reggaeton or corridos, global services often group tracks under Musica Latina.',
  },
  'corridos-tumbados-musica-mexicana': {
    summary: 'A Musica Mexicana style combining corridos traditions with trap, hip-hop attitude, and streaming-era songwriting.',
    whyLocal: 'It can dominate Mexico and the U.S. Latin market while remaining distinct from global pop and Latin urbano in instrumentation and identity.',
  },
  'salsa-tropical': {
    summary: 'A Latin dance and party music family covering salsa, cumbia, merengue, and tropical styles.',
    whyLocal: 'Older regional dance genres keep re-entering Latin charts through new songs and remakes, but they are often hidden inside urbano metadata.',
  },
  'afrobeats-afropop': {
    summary: 'A modern African pop family centered on Nigeria and now spreading through global charts.',
    whyLocal: 'The genre is globalizing, but country charts still reveal concrete local scene movements.',
  },
  bollywood: {
    summary: 'A huge popular music category rooted in the Hindi film industry.',
    whyLocal: 'It is central in South Asian and diaspora charts, but global metadata can flatten it into generic film music.',
  },
  'tamil-pop-kollywood': {
    summary: 'A South Indian popular music axis combining Tamil film songs and independent pop.',
    whyLocal: 'It has a separate language and film industry from Bollywood, but global charts often group it broadly as Indian music.',
  },
  opm: {
    summary: 'A broad category for Original Pilipino Music across pop, bands, ballads, and idol pop.',
    whyLocal: 'Philippine charts are rich in local bands, ballads, and pop acts that can be scattered into generic Pop/Rock metadata.',
  },
  'dangdut-koplo': {
    summary: 'A large live, dance, and event-centered Indonesian popular music genre.',
    whyLocal: 'Its drum patterns, melodies, and Javanese or Indonesian sentiment differ from Western pop chart grammar, so it can feel invisible outside the region.',
  },
  mahraganat: {
    summary: 'A rough, fast Egyptian street-party style that grew out of urban neighborhoods.',
    whyLocal: 'Local social context, club and wedding culture, and Arabic hooks make it harder to discover through global pop categories.',
  },
  'arabic-pop': {
    summary: 'A mainstream Arabic-language pop family across Egypt, Lebanon, the Gulf, and the wider diaspora.',
    whyLocal: 'It is needed as a broad axis when metadata is Arabic rather than specific subgenres such as Mahraganat, Khaliji, or Shilat.',
  },
  arabesque: {
    summary: 'A Turkish popular genre combining melodramatic vocals with folk and Middle Eastern feeling.',
    whyLocal: 'It appears strongly alongside modern Turkish pop and rap, but global services can flatten it into Turkish pop.',
  },
  manele: {
    summary: 'A highly popular Balkan pop-related genre in Romania.',
    whyLocal: 'It has a large wedding and party market locally, but taste politics and language barriers keep it less visible outside the region.',
  },
  chalga: {
    summary: 'Bulgarian pop-folk and club-oriented popular music.',
    whyLocal: 'Its Balkan rhythms and glossy club-pop aesthetic are often not recognized as a separate genre outside Bulgaria.',
  },
  'disco-polo': {
    summary: 'A direct Polish dance-pop style tied to weddings, festivals, and TV entertainment.',
    whyLocal: 'It is widely recognized locally but is rarely covered by global music media, making it a classic local mega-genre.',
  },
  barnmusik: {
    summary: 'A children and family music category that repeatedly appears on Swedish charts.',
    whyLocal: 'Family listening and kids content consumption can affect charts directly, so it is useful to split it from ordinary pop taste.',
  },
  'levenslied-nederlandstalige-pop': {
    summary: 'A Dutch-language singalong pop family spanning levenslied, volkspop, and related local styles.',
    whyLocal: 'It is emotionally close to German-language Schlager, but Dutch charts move through a separate language market and star system.',
  },
  'luk-thung-mor-lam': {
    summary: 'A crucial Thai country and regional folk-pop genre family.',
    whyLocal: 'It carries Isan language, folk feeling, and working-class sentiment distinct from Bangkok-centered pop.',
  },
  'khaliji-pop': {
    summary: 'A Gulf-centered local pop and ballad genre family.',
    whyLocal: 'It is powerful inside Arabic-language markets but often gets collapsed into Arabic Pop on global charts.',
  },
  shilat: {
    summary: 'A Saudi and Gulf chant or celebration-based local popular genre.',
    whyLocal: 'Its chant vocals and event context make it hard to surface through generic Arabic Pop recommendations.',
  },
  gqom: {
    summary: 'A minimal, heavy South African club sound associated with Durban.',
    whyLocal: 'It is rougher and more local-club oriented than Amapiano, so external genre classification often underrepresents it.',
  },
  fuji: {
    summary: 'A percussion and chant-driven Yoruba popular genre from Nigeria.',
    whyLocal: 'It is overshadowed by global Afrobeats, but it remains important in local events and long-form performance culture.',
  },
  chicha: {
    summary: 'A Peruvian popular style combining psychedelic guitar with cumbia.',
    whyLocal: 'Within Latin music it is exported far less than reggaeton or salsa, so it has strong locality but higher discovery friction.',
  },
  vallenato: {
    summary: 'A Colombian accordion-based storytelling popular music genre.',
    whyLocal: 'It overlaps with Latin pop stars, but the genre’s long-form regional identity is often underrecognized outside Colombia.',
  },
  pimba: {
    summary: 'A humorous, blunt Portuguese festival pop and folk-pop genre.',
    whyLocal: 'Lyrics and local festival context matter heavily, so its popularity is hard to understand without translation and cultural context.',
  },
  neomelodico: {
    summary: 'A Neapolitan local pop style with strong melodramatic emotion.',
    whyLocal: 'Outside Italy it can be grouped as mainstream Italian pop, making the regional genre harder to discover.',
  },
  enka: {
    summary: 'A Japanese genre combining traditional vocal style with popular song structures.',
    whyLocal: 'It has a large generational, broadcast, and karaoke culture separate from J-pop but is less surfaced by global algorithms.',
  },
  trot: {
    summary: 'A Korean popular genre closely tied to broadcast, events, and karaoke culture.',
    whyLocal: 'It is a separate domestic market with generational fandoms and TV ecosystems, unlike Korea’s export-facing K-pop image.',
  },
  sertanejo: {
    summary: 'One of Brazil’s largest popular genres, broadly related to country and country-pop.',
    whyLocal: 'It is extremely strong on Brazilian domestic charts but less visible in global Latin music discourse than reggaeton or urbano.',
  },
  'forro-pisadinha': {
    summary: 'A dance-oriented popular music family rooted in Northeast Brazil.',
    whyLocal: 'It has a large party and festival market within Brazil but is often hidden abroad by samba and bossa nova stereotypes.',
  },
  'brega-funk': {
    summary: 'A street dance-pop style combining Northeast Brazilian brega with funk.',
    whyLocal: 'Outside Brazil it can be grouped under Brazilian funk, which hides the distinct regional scene.',
  },
  'campursari-pop-jawa': {
    summary: 'An Indonesian local pop axis mixing Javanese song, campursari, and koplo feeling.',
    whyLocal: 'It has a large language market inside Indonesia but is often flattened into Indonesian pop externally.',
  },
  schlager: {
    summary: 'A massive German-language singalong and festival pop genre.',
    whyLocal: 'It has a large generational and broadcast market in German-speaking countries but is rarely surfaced in English-language recommendations.',
  },
  turbofolk: {
    summary: 'A Serbian and Balkan pop-folk nightlife genre.',
    whyLocal: 'The Balkans have a major star system, but the currently collected chart countries do not cover that market, so curated seeds fill the gap.',
  },
  maskandi: {
    summary: 'A South African genre combining Zulu guitar traditions with modern popular music.',
    whyLocal: 'It can be strong in South African charts, but global South African music discovery is often centered on Amapiano.',
  },
  'bongo-flava': {
    summary: 'A Tanzanian Swahili pop, hip-hop, and dancehall hybrid.',
    whyLocal: 'It is huge in East Africa, but Tanzania is not currently in the collected chart set, so seed-based discovery is needed.',
  },
  rai: {
    summary: 'A North African popular genre from Oran, Algeria that spread internationally.',
    whyLocal: 'It is influential in North Africa and the French-speaking diaspora, but current global charts often mix it into Arabic or French pop.',
  },
  'vietnamese-bolero': {
    summary: 'A Vietnamese bolero ballad and karaoke-centered popular genre.',
    whyLocal: 'It is familiar in Vietnam and the diaspora but rarely appears in K-pop or J-pop-centered Asian pop recommendations.',
  },
}

function localizeGenreCopy(genre: LocalGenreDefinition, locale: Locale): GenreLocalizedCopy {
  if (locale === 'ko') {
    return {
      summary: genre.summary,
      whyLocal: genre.whyLocal,
    }
  }

  return (
    GENRE_COPY_EN[genre.id] || {
      summary: genre.summary,
      whyLocal: genre.whyLocal,
    }
  )
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function rankScore(rank: number) {
  return Math.max(0, 101 - rank)
}

function peakRankBonus(rank: number) {
  if (rank <= 3) return 900
  if (rank <= 5) return 700
  if (rank <= 10) return 450
  if (rank <= 20) return 220
  if (rank <= 50) return 80
  return 0
}

function formatScore(value: number) {
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 }).format(value)
}

function textTokens(value: string) {
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2)
}

function normalizedTokens(value: string) {
  return normalizeText(value)
    .split(/\s+/)
    .filter(Boolean)
}

function normalizedTermMatchesText(term: string, text: string) {
  const termTokens = normalizedTokens(term)
  const searchableTokens = normalizedTokens(text)
  if (termTokens.length === 0 || searchableTokens.length === 0) return false

  if (termTokens.length === 1) {
    return searchableTokens.includes(termTokens[0])
  }

  for (let index = 0; index <= searchableTokens.length - termTokens.length; index += 1) {
    const matches = termTokens.every(
      (token, offset) => searchableTokens[index + offset] === token,
    )
    if (matches) return true
  }

  return false
}

function isSameArtistName(seedArtist: string, chartArtist: string) {
  const seed = normalizeText(seedArtist)
  const chart = normalizeText(chartArtist)
  if (!seed || !chart) return false
  if (seed === chart) return true

  const seedTokens = textTokens(seedArtist)
  const chartTokens = textTokens(chartArtist)
  if (seedTokens.length === 0 || chartTokens.length === 0) return false

  if (seedTokens.length === 1 || chartTokens.length === 1) {
    return false
  }

  const chartTokenSet = new Set(chartTokens)
  const seedTokenSet = new Set(seedTokens)
  const seedHits = seedTokens.filter((token) => chartTokenSet.has(token)).length
  const chartHits = chartTokens.filter((token) => seedTokenSet.has(token)).length
  const seedCoverage = seedHits / seedTokens.length
  const chartCoverage = chartHits / chartTokens.length

  return seedCoverage >= 0.8 && chartCoverage >= 0.8
}

function scopeLabel(scope: GenreMatch['scope'], locale: Locale) {
  if (scope === 'target') return pick(locale, 'Target country', '타깃 국가')
  if (scope === 'regional') return pick(locale, 'Same region', '같은 지역')
  return pick(locale, 'Global support', '글로벌 보조')
}

const GENERIC_GENRE_TERMS = new Set([
  'pop',
  'folk',
  'dance',
  'club',
  'party',
  'ballad',
  'guitar',
  'country',
  'regional',
  'local',
  'music',
  'brazil',
  'brazilian',
  'arabic',
  'latin',
  'african',
  'asian',
  'european',
  'japan',
  'japanese',
  'korea',
  'korean',
  'idol',
  'thai',
  'indonesia',
  'indonesian',
  'nigeria',
  'nigerian',
])

const BROAD_MAINSTREAM_GENRE_IDS = new Set([
  'hip-hop-rap',
  'pop',
  'r-and-b',
  'dance-electronic',
  'rock-alternative',
  'latin-pop-musica-latina',
  'arabic-pop',
])

const ARTIST_LEVEL_BROAD_GENRE_IDS = new Set([
  'hip-hop-rap',
  'rock-alternative',
  'r-and-b',
  'dance-electronic',
])

function isAllowedStructuredGenericTerm(genre: LocalGenreDefinition, normalized: string) {
  if (genre.id === 'dance-electronic') return normalized === 'dance' || normalized === 'club'
  if (genre.id === 'pop') return normalized === 'pop'
  if (genre.id === 'country') return normalized === 'country'
  if (genre.id === 'afrobeats-afropop') return normalized === 'african'
  if (genre.id === 'arabic-pop') return normalized === 'arabic'
  return false
}

function isGenericPhrase(normalized: string) {
  const tokens = normalized.split(/\s+/).filter(Boolean)
  return tokens.length > 1 && tokens.every((token) => GENERIC_GENRE_TERMS.has(token))
}

function countryContextTerms(genre: LocalGenreDefinition) {
  return new Set(
    genre.countries
      .split(/[,/]/)
      .map((term) => normalizeText(term))
      .filter(Boolean),
  )
}

function genreEvidenceTerms(
  genre: LocalGenreDefinition,
  { structured = false }: { structured?: boolean } = {},
) {
  const countryTerms = countryContextTerms(genre)

  return [genre.name, genre.nativeName || '', ...genre.keywords]
    .map((term) => term.trim())
    .filter(Boolean)
    .filter((term) => {
      const normalized = normalizeText(term)
      if (!normalized) return false
      if (normalizeText(genre.name) === normalized) return true
      if (genre.nativeName && normalizeText(genre.nativeName) === normalized) return true
      if (countryTerms.has(normalized)) return false
      if (isGenericPhrase(normalized)) return false
      if (GENERIC_GENRE_TERMS.has(normalized)) {
        return structured && isAllowedStructuredGenericTerm(genre, normalized)
      }
      return normalized.length >= 5 || normalized.split(/\s+/).length > 1
    })
}

function structuredGenreEvidenceTerms(genre: LocalGenreDefinition) {
  return genreEvidenceTerms(genre, { structured: true })
}

function canUseDescriptionEvidence(term: string) {
  const normalized = normalizeText(term)
  return Boolean(normalized && !GENERIC_GENRE_TERMS.has(normalized))
}

function evidenceWeight(reasons: string[]) {
  if (reasons.some((reason) => reason.startsWith('Apple/iTunes:'))) return 1
  if (reasons.some((reason) => reason.includes('artist genre propagation'))) return 0.82
  if (reasons.some((reason) => /MusicBrainz|Wikidata|Wikipedia|Viberate/.test(reason))) return 0.88
  if (reasons.some((reason) => reason.startsWith('curated artist fallback:'))) return 0.58
  if (reasons.some((reason) => reason.startsWith('chart text:'))) return 0.55
  return 0.75
}

function isGenericGenreTerm(term: string) {
  return GENERIC_GENRE_TERMS.has(normalizeText(term))
}

function structuredTermMatchesValues(term: string, values: string[]) {
  const normalizedTerm = normalizeText(term)
  if (!normalizedTerm) return false

  const normalizedValues = values.map((value) => normalizeText(value)).filter(Boolean)
  if (isGenericGenreTerm(term)) {
    return normalizedValues.includes(normalizedTerm)
  }

  return normalizedTermMatchesText(term, normalizedValues.join(' '))
}

function hasSpecificTrackGenreConflict(genre: LocalGenreDefinition, trackGenreTerms: string[]) {
  if (!BROAD_MAINSTREAM_GENRE_IDS.has(genre.id)) return false

  return localGenres.some((otherGenre) => {
    if (otherGenre.id === genre.id || BROAD_MAINSTREAM_GENRE_IDS.has(otherGenre.id)) return false
    return structuredGenreEvidenceTerms(otherGenre).some((term) =>
      structuredTermMatchesValues(term, trackGenreTerms),
    )
  })
}

function matchGenreTrack(
  track: Track,
  genre: LocalGenreDefinition,
  artistMetadata: ArtistMetadata | undefined,
  trackMetadata: TrackMetadata | undefined,
) {
  const trackGenreTerms = [
    ...(trackMetadata?.genres || []),
    ...(trackMetadata?.tags || []),
  ]
  const trackDescriptionTerms = trackMetadata?.descriptions || []
  const artistGenreTerms = [
    ...(artistMetadata?.genres || []),
    ...(artistMetadata?.tags || []),
  ]
  const artistDescriptionTerms = artistMetadata?.descriptions || []
  const chartSearchable = normalizeText(`${track.title} ${track.artist} ${track.genre}`)
  const trackDescriptionSearchable = normalizeText(trackDescriptionTerms.join(' '))
  const artistDescriptionSearchable = normalizeText(artistDescriptionTerms.join(' '))
  const evidenceTerms = genreEvidenceTerms(genre)
  const structuredEvidenceTerms = structuredGenreEvidenceTerms(genre)
  const trackSources = trackMetadata?.sources || []
  const artistSources = artistMetadata?.sources || []
  const trackSourceLabel = trackSources.length > 0 ? trackSources.join('/') : 'track metadata'
  const artistSourceLabel = artistSources.length > 0 ? artistSources.join('/') : 'artist metadata'
  const reasons: string[] = []
  const isBroadGenre = BROAD_MAINSTREAM_GENRE_IDS.has(genre.id)
  const hasTrustedArtistSource = artistSources.includes('Viberate')
  const canUseArtistLevelBroad =
    ARTIST_LEVEL_BROAD_GENRE_IDS.has(genre.id) &&
    hasTrustedArtistSource &&
    !hasSpecificTrackGenreConflict(genre, trackGenreTerms)
  let hasStructuredTrackReason = false

  for (const term of structuredEvidenceTerms) {
    if (structuredTermMatchesValues(term, trackGenreTerms)) {
      reasons.push(`${trackSourceLabel}: ${term}`)
      hasStructuredTrackReason = true
      break
    }
  }

  if (
    isBroadGenre &&
    !hasStructuredTrackReason &&
    !ARTIST_LEVEL_BROAD_GENRE_IDS.has(genre.id)
  ) {
    return []
  }
  const canUseArtistEvidence =
    hasStructuredTrackReason || canUseArtistLevelBroad || (!isBroadGenre && hasTrustedArtistSource)

  for (const term of evidenceTerms) {
    if (
      canUseDescriptionEvidence(term) &&
      normalizedTermMatchesText(term, trackDescriptionSearchable)
    ) {
      reasons.push(`${trackSourceLabel} description: ${term}`)
      break
    }
  }

  if (canUseArtistEvidence) {
    for (const term of structuredEvidenceTerms) {
      if (structuredTermMatchesValues(term, artistGenreTerms)) {
        reasons.push(`${artistSourceLabel}: ${term}`)
        break
      }
    }
  }

  if (!isBroadGenre || hasStructuredTrackReason) {
    for (const artist of genre.seedArtists) {
      if (isSameArtistName(artist, track.artist)) {
        reasons.push(`curated artist fallback: ${artist}`)
        break
      }
    }
  }

  if (canUseArtistEvidence) {
    for (const term of evidenceTerms) {
      if (
        canUseDescriptionEvidence(term) &&
        normalizedTermMatchesText(term, artistDescriptionSearchable)
      ) {
        reasons.push(`${artistSourceLabel} description: ${term}`)
        break
      }
    }
  }

  for (const term of evidenceTerms) {
    if (normalizedTermMatchesText(term, chartSearchable)) {
      reasons.push(`chart text: ${term}`)
      break
    }
  }

  return reasons
}

function topArtistsForMetadata(snapshot: ChartSnapshotData) {
  const trackById = new Map(snapshot.tracks.map((track) => [track.id, track]))
  const artistScores = new Map<
    string,
    { id: string; name: string; score: number; bestRank: number }
  >()
  const countryArtistScores = new Map<
    string,
    Map<string, { id: string; name: string; score: number; bestRank: number }>
  >()

  for (const chart of snapshot.countryCharts) {
    const currentCountryScores =
      countryArtistScores.get(chart.countryCode) ||
      new Map<string, { id: string; name: string; score: number; bestRank: number }>()

    for (const entry of chart.entries.slice(0, 50)) {
      const track = trackById.get(entry.trackId)
      if (!track?.artistId || !track.artist) continue
      const entryScore = rankScore(entry.rank)

      const current = artistScores.get(track.artistId) || {
        id: track.artistId,
        name: track.artist,
        score: 0,
        bestRank: entry.rank,
      }
      current.score += entryScore
      current.bestRank = Math.min(current.bestRank, entry.rank)
      artistScores.set(track.artistId, current)

      const countryCurrent = currentCountryScores.get(track.artistId) || {
        id: track.artistId,
        name: track.artist,
        score: 0,
        bestRank: entry.rank,
      }
      countryCurrent.score += entryScore
      countryCurrent.bestRank = Math.min(countryCurrent.bestRank, entry.rank)
      currentCountryScores.set(track.artistId, countryCurrent)
    }

    countryArtistScores.set(chart.countryCode, currentCountryScores)
  }

  const globalArtists = [...artistScores.values()]
    .sort((a, b) => {
      const scoreA = a.score + peakRankBonus(a.bestRank)
      const scoreB = b.score + peakRankBonus(b.bestRank)
      if (scoreB !== scoreA) return scoreB - scoreA
      return a.bestRank - b.bestRank
    })
    .slice(0, 90)

  const countryArtists = [...countryArtistScores.values()].flatMap((scores) =>
    [...scores.values()]
      .sort((a, b) => {
        const scoreA = a.score + peakRankBonus(a.bestRank)
        const scoreB = b.score + peakRankBonus(b.bestRank)
        if (scoreB !== scoreA) return scoreB - scoreA
        return a.bestRank - b.bestRank
      })
      .slice(0, 12),
  )

  return [...new Map([...countryArtists, ...globalArtists].map((artist) => [artist.id, artist])).values()]
    .slice(0, 220)
    .map(({ id, name }) => ({ id, name }))
}

function topTracksForMetadata(snapshot: ChartSnapshotData) {
  const trackById = new Map(snapshot.tracks.map((track) => [track.id, track]))
  const trackScores = new Map<
    string,
    {
      id: string
      title: string
      artist: string
      score: number
      bestRank: number
      countryScores: Map<string, { score: number; bestRank: number }>
    }
  >()

  for (const chart of snapshot.countryCharts) {
    for (const entry of chart.entries.slice(0, 50)) {
      const track = trackById.get(entry.trackId)
      if (!track?.id || !track.title || !track.artist) continue

      const current = trackScores.get(track.id) || {
        id: track.id,
        title: track.title,
        artist: track.artist,
        score: 0,
        bestRank: entry.rank,
        countryScores: new Map<string, { score: number; bestRank: number }>(),
      }
      const entryScore = rankScore(entry.rank)
      const countryScore = current.countryScores.get(chart.countryCode) || {
        score: 0,
        bestRank: entry.rank,
      }
      current.score += entryScore
      current.bestRank = Math.min(current.bestRank, entry.rank)
      countryScore.score += entryScore
      countryScore.bestRank = Math.min(countryScore.bestRank, entry.rank)
      current.countryScores.set(chart.countryCode, countryScore)
      trackScores.set(track.id, current)
    }
  }

  const globalTracks = [...trackScores.values()]
    .sort((a, b) => {
      const scoreA = a.score + peakRankBonus(a.bestRank)
      const scoreB = b.score + peakRankBonus(b.bestRank)
      if (scoreB !== scoreA) return scoreB - scoreA
      return a.bestRank - b.bestRank
    })
    .slice(0, 70)

  const countryTracks = snapshot.countryCharts.flatMap((chart) =>
    chart.entries.slice(0, 6).flatMap((entry) => {
      const track = trackById.get(entry.trackId)
      return track ? [trackScores.get(track.id)].filter(Boolean) : []
    }),
  ) as Array<NonNullable<ReturnType<typeof trackScores.get>>>

  return [...new Map([...countryTracks, ...globalTracks].map((track) => [track.id, track])).values()]
    .slice(0, 140)
    .map(({ id, title, artist, countryScores }) => ({
      id,
      title,
      artist,
      countryCodes: [...countryScores.entries()]
        .sort((a, b) => {
          if (b[1].score !== a[1].score) return b[1].score - a[1].score
          return a[1].bestRank - b[1].bestRank
        })
        .map(([countryCode]) => countryCode),
    }))
}

function buildGenreSignals(
  snapshot: ChartSnapshotData,
  artistMetadataById: Map<string, ArtistMetadata>,
  trackMetadataById: Map<string, TrackMetadata>,
): GenreSignal[] {
  const countryByCode = new Map(snapshot.countries.map((country) => [country.code, country]))
  const trackById = new Map(snapshot.tracks.map((track) => [track.id, track]))

  const scoredSignals = localGenres
    .map((genre) => {
      const targetCountryCodes = new Set(genre.countryCodes)
      const availableCountries = genre.countryCodes.flatMap((code) => {
        const country = countryByCode.get(code)
        return country ? [country] : []
      })
      const targetRegions = new Set(availableCountries.map((country) => country.region))
      const missingCountryCodes = genre.countryCodes.filter((code) => !countryByCode.has(code))
      const matchedTracks: GenreMatch[] = []
      const contextTracks: GenreContextTrack[] = []
      const seenContextTrackIds = new Set<string>()

      for (const chart of snapshot.countryCharts) {
        const country = countryByCode.get(chart.countryCode)
        if (!country) continue
        const isTargetCountry = targetCountryCodes.has(chart.countryCode)
        const isTargetRegion = targetRegions.has(country.region)

        if (isTargetCountry) {
          for (const entry of chart.entries.slice(0, 8)) {
            const track = trackById.get(entry.trackId)
            if (!track || seenContextTrackIds.has(track.id)) continue
            seenContextTrackIds.add(track.id)
            contextTracks.push({ track, country, entry })
          }
        }

        for (const entry of chart.entries.slice(0, 50)) {
          const track = trackById.get(entry.trackId)
          if (!track) continue

          const reasons = matchGenreTrack(
            track,
            genre,
            artistMetadataById.get(track.artistId),
            trackMetadataById.get(track.id),
          )
          if (reasons.length > 0) {
            const scope: GenreMatch['scope'] = isTargetCountry
              ? 'target'
              : isTargetRegion
                ? 'regional'
                : 'global'
            matchedTracks.push({
              track,
              country,
              entry,
              reasons,
              scope,
              weightedScore: rankScore(entry.rank) * evidenceWeight(reasons),
            })
          }
        }
      }

      const targetChartScore = matchedTracks
        .filter((match) => match.scope === 'target')
        .reduce((sum, match) => sum + match.weightedScore, 0)
      const expandedChartScore = matchedTracks
        .filter((match) => match.scope !== 'target')
        .reduce((sum, match) => sum + match.weightedScore, 0)
      const chartPopularityScore = targetChartScore + expandedChartScore
      const confidence: GenreSignal['confidence'] =
        chartPopularityScore > 0 ? 'chart' : availableCountries.length > 0 ? 'coverage' : 'curated'

      return {
        genre,
        rank: 0,
        chartPopularityScore,
        targetChartScore,
        expandedChartScore,
        confidence,
        availableCountries,
        missingCountryCodes,
        matchedTracks: matchedTracks.sort((a, b) => b.weightedScore - a.weightedScore),
        contextTracks: contextTracks.slice(0, 8),
      }
    })
    .sort((a, b) => {
      if (b.chartPopularityScore !== a.chartPopularityScore) {
        return b.chartPopularityScore - a.chartPopularityScore
      }

      return b.genre.priority - a.genre.priority
    })

  return scoredSignals.map((signal, index) => ({ ...signal, rank: index + 1 }))
}

function confidenceLabel(signal: GenreSignal, locale: Locale) {
  if (signal.confidence === 'chart') return pick(locale, 'Direct chart match', '차트 직접 매칭')
  if (signal.confidence === 'coverage') return pick(locale, 'Country chart context', '국가 차트 맥락')
  return pick(locale, 'Curated seed', '큐레이션 기반')
}

function createSeedKey(seed: LocalGenreTrackSeed) {
  return `${normalizeText(seed.artist)}::${normalizeText(seed.track)}`
}

function matchedTrackUris(matches: GenreMatch[], limit: number) {
  return [
    ...new Set(
      matches
        .sort((a, b) => b.weightedScore - a.weightedScore)
        .map((match) => `spotify:track:${match.track.id}`),
    ),
  ].slice(0, limit)
}

function GenreDiscovery({
  snapshot,
  snapshotIndex = [],
  selectedDate = snapshot.snapshotDate,
  snapshotLoading = false,
  onSelectedDateChange,
  locale,
}: GenreDiscoveryProps) {
  const [selectedGenreId, setSelectedGenreId] = useState(localGenres[0]?.id || '')
  const [query, setQuery] = useState('')
  const [region, setRegion] = useState('all')
  const [genreMetadata, setGenreMetadata] = useState<GenreMetadataState>(() => ({
    status: 'loading',
    artistById: new Map(),
    trackById: new Map(),
  }))
  const [precomputedStatus, setPrecomputedStatus] = useState<'loading' | 'ready' | 'missing'>(
    'loading',
  )
  const [precomputedSignals, setPrecomputedSignals] = useState<GenreSignal[] | null>(null)
  const [playlistStatus, setPlaylistStatus] = useState<PlaylistCreateStatus>({
    type: 'idle',
    message: pick(
      locale,
      'Current chart tracks are prioritized with external genre metadata; seed tracks fill playlist gaps.',
      '현재 차트 곡의 외부 장르 메타데이터를 우선 사용하고, 플레이리스트 부족분만 대표곡 seed로 보강합니다.',
    ),
  })

  useEffect(() => {
    let ignore = false

    async function loadPrecomputedSignals() {
      setPrecomputedStatus('loading')
      setPrecomputedSignals(null)

      try {
        const candidates = [
          `/data/genre-discovery/${snapshot.snapshotDate}.json`,
          '/data/genre-discovery.json',
        ]
        let payload: PrecomputedGenreDiscoveryPayload | null = null

        for (const candidate of candidates) {
          const response = await fetch(apiUrl(`${candidate}?v=${snapshot.snapshotDate}`))
          if (!response.ok) {
            continue
          }
          payload = (await response.json()) as PrecomputedGenreDiscoveryPayload
          if (payload.snapshotDate === snapshot.snapshotDate && Array.isArray(payload.signals)) {
            break
          }
          payload = null
        }

        if (
          !payload ||
          payload.snapshotDate !== snapshot.snapshotDate ||
          !Array.isArray(payload.signals)
        ) {
          throw new Error('precomputed genre discovery does not match current snapshot')
        }
        if (!ignore) {
          setPrecomputedSignals(payload.signals)
          setPrecomputedStatus('ready')
        }
      } catch {
        if (!ignore) {
          setPrecomputedSignals(null)
          setPrecomputedStatus('missing')
        }
      }
    }

    void loadPrecomputedSignals()

    return () => {
      ignore = true
    }
  }, [snapshot.snapshotDate])

  useEffect(() => {
    if (precomputedStatus !== 'missing') {
      return
    }

    const artists = topArtistsForMetadata(snapshot)
    const tracks = topTracksForMetadata(snapshot)
    let ignore = false

    async function fetchArtistMetadata() {
      try {
        const response = await fetch(apiUrl('/api/genre-discovery/external-metadata'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ artists }),
        })
        const payload: unknown = await response.json()

        if (!response.ok || !payload || typeof payload !== 'object') {
          return new Map<string, ArtistMetadata>()
        }

        const enrichedArtists = (payload as { artists?: ArtistMetadata[] }).artists || []
        return new Map(enrichedArtists.map((artist) => [artist.id, artist]))
      } catch {
        return new Map<string, ArtistMetadata>()
      }
    }

    async function fetchTrackMetadata() {
      try {
        const response = await fetch(apiUrl('/api/genre-discovery/track-metadata'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tracks }),
        })
        const payload: unknown = await response.json()

        if (!response.ok || !payload || typeof payload !== 'object') {
          return new Map<string, TrackMetadata>()
        }

        const enrichedTracks = (payload as { tracks?: TrackMetadata[] }).tracks || []
        return new Map(enrichedTracks.map((track) => [track.id, track]))
      } catch {
        return new Map<string, TrackMetadata>()
      }
    }

    async function loadGenreMetadata() {
      setGenreMetadata({
        status: 'loading',
        artistById: new Map(),
        trackById: new Map(),
      })

      if (artists.length === 0 && tracks.length === 0) {
        if (!ignore) {
          setGenreMetadata({
            status: 'ready',
            artistById: new Map(),
            trackById: new Map(),
          })
        }
        return
      }

      const [artistResult, trackResult] = await Promise.allSettled([
        artists.length > 0 ? fetchArtistMetadata() : Promise.resolve(new Map<string, ArtistMetadata>()),
        tracks.length > 0 ? fetchTrackMetadata() : Promise.resolve(new Map<string, TrackMetadata>()),
      ])

      if (ignore) {
        return
      }

      setGenreMetadata({
        status: 'ready',
        artistById:
          artistResult.status === 'fulfilled' ? artistResult.value : new Map<string, ArtistMetadata>(),
        trackById:
          trackResult.status === 'fulfilled' ? trackResult.value : new Map<string, TrackMetadata>(),
      })
    }

    void loadGenreMetadata()

    return () => {
      ignore = true
    }
  }, [precomputedStatus, snapshot])

  const signals = useMemo(
    () => {
      if (precomputedSignals) {
        return precomputedSignals
      }

      if (precomputedStatus === 'missing' && genreMetadata.status === 'ready') {
        return buildGenreSignals(snapshot, genreMetadata.artistById, genreMetadata.trackById)
      }

      return []
    },
    [
      genreMetadata.artistById,
      genreMetadata.status,
      genreMetadata.trackById,
      precomputedSignals,
      precomputedStatus,
      snapshot,
    ],
  )
  const regionOptions = useMemo(() => {
    return ['all', ...Array.from(new Set(localGenres.map((genre) => genre.region))).sort()]
  }, [])
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
  const normalizedQuery = normalizeText(query)

  const visibleSignals = useMemo(() => {
    return signals.filter((signal) => {
      if (region !== 'all' && signal.genre.region !== region) return false
      if (!normalizedQuery) return true

      const localizedCopy = localizeGenreCopy(signal.genre, locale)
      const englishCopy = GENRE_COPY_EN[signal.genre.id]

      return normalizeText(
        [
          signal.genre.name,
          signal.genre.nativeName || '',
          signal.genre.region,
          signal.genre.countries,
          signal.genre.summary,
          signal.genre.whyLocal,
          localizedCopy.summary,
          localizedCopy.whyLocal,
          englishCopy?.summary || '',
          englishCopy?.whyLocal || '',
          signal.genre.tags.join(' '),
          signal.genre.seedArtists.join(' '),
        ].join(' '),
      ).includes(normalizedQuery)
    })
  }, [locale, normalizedQuery, region, signals])

  const selectedSignal =
    visibleSignals.find((signal) => signal.genre.id === selectedGenreId) ||
    visibleSignals[0] ||
    signals.find((signal) => signal.genre.id === selectedGenreId) ||
    signals[0]
  const selectedGenreCopy = selectedSignal
    ? localizeGenreCopy(selectedSignal.genre, locale)
    : null

  async function createPlaylist({
    name,
    description,
    seeds,
    trackUris,
  }: {
    name: string
    description: string
    seeds: LocalGenreTrackSeed[]
    trackUris?: string[]
  }) {
    const uniqueSeeds = Array.from(new Map(seeds.map((seed) => [createSeedKey(seed), seed])).values())
    const uniqueTrackUris = [...new Set(trackUris || [])]

    if (uniqueSeeds.length === 0 && uniqueTrackUris.length === 0) {
      setPlaylistStatus({
        type: 'error',
        message: pick(locale, 'No current chart tracks or seed tracks are available for a playlist.', '플레이리스트로 만들 현재 차트 곡이나 대표곡 seed가 없습니다.'),
      })
      return
    }

    setPlaylistStatus({
      type: 'working',
      message: pick(
        locale,
        `Creating a public playlist with ${uniqueTrackUris.length} current chart tracks and ${uniqueSeeds.length} seed tracks.`,
        `${uniqueTrackUris.length}개 현재 차트 곡과 ${uniqueSeeds.length}개 대표곡 seed로 공개 플레이리스트를 만드는 중입니다.`,
      ),
    })

    try {
      const response = await fetch(apiUrl('/api/genre-discovery/create-playlist'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description,
          public: true,
          trackUris: uniqueTrackUris,
          seeds: uniqueSeeds,
        }),
      })
      const payload: unknown = await response.json()

      if (!response.ok || !payload || typeof payload !== 'object') {
        const error =
          payload && typeof payload === 'object' && 'error' in payload
            ? String((payload as { error?: unknown }).error)
            : pick(locale, 'Failed to create the genre playlist.', '장르 플레이리스트 생성에 실패했습니다.')
        throw new Error(error)
      }

      const result = payload as {
        playlist?: { openUrl?: string; name?: string }
        matchedCount?: number
        missedCount?: number
        chartTrackCount?: number
        seedMatchedCount?: number
      }
      const url = result.playlist?.openUrl
      if (!url) {
        throw new Error(pick(locale, 'Spotify playlist URL was not returned.', 'Spotify 플레이리스트 URL을 받지 못했습니다.'))
      }

      const missedText = result.missedCount
        ? pick(locale, `, ${result.missedCount} missed`, `, 미매칭 ${result.missedCount}곡`)
        : ''
      // No auto-open: fresh playlists can 404 in the Spotify web player for a
      // couple of minutes, which reads as a failed creation.
      setPlaylistStatus({
        type: 'success',
        message: pick(
          locale,
          `${result.playlist?.name || name} created: ${result.chartTrackCount || 0} chart tracks + ${result.seedMatchedCount || 0} seed tracks${missedText} — click to open in Spotify`,
          `${result.playlist?.name || name} 생성 완료: 현재 차트 ${result.chartTrackCount || 0}곡 + 대표곡 ${result.seedMatchedCount || 0}곡${missedText} — 눌러서 Spotify에서 열기`,
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

  function createSelectedGenrePlaylist() {
    if (!selectedSignal) return

    const chartTrackUris = matchedTrackUris(selectedSignal.matchedTracks, 50)
    const seedLimit = chartTrackUris.length > 0 ? Math.max(0, 30 - chartTrackUris.length) : 12

    void createPlaylist({
      name: `Genre Atlas: ${selectedSignal.genre.name}`,
      description: pick(
        locale,
        `${selectedSignal.genre.name} chart-classified tracks first, backed by seed tracks where needed. Chart Atlas ${snapshot.snapshotDate}.`,
        `${selectedSignal.genre.name} 차트 분류곡 우선, 부족분은 대표곡 seed로 보강. Chart Atlas ${snapshot.snapshotDate}.`,
      ),
      trackUris: chartTrackUris,
      seeds: selectedSignal.genre.seedTracks.slice(0, seedLimit),
    })
  }

  const metadataStatusMessage =
    precomputedStatus === 'ready'
      ? pick(locale, 'Using precomputed genre results', '고정 장르 결과 사용 중')
      : precomputedStatus === 'loading'
        ? pick(locale, 'Loading precomputed genre results', '고정 장르 결과 로딩 중')
        : genreMetadata.status === 'loading'
          ? pick(locale, 'Calculating fallback genres', 'fallback 장르 계산 중')
          : pick(locale, 'Fallback genre calculation ready', 'fallback 장르 계산 완료')
  const displayedPlaylistStatus: PlaylistCreateStatus =
    playlistStatus.type === 'idle'
      ? {
          type: 'idle',
          message: pick(
            locale,
            'Current chart tracks are prioritized with external genre metadata; seed tracks fill playlist gaps.',
            '현재 차트 곡의 외부 장르 메타데이터를 우선 사용하고, 플레이리스트 부족분만 대표곡 seed로 보강합니다.',
          ),
        }
      : playlistStatus

  return (
    <section className="genre-discovery">
      <div className="genre-toolbar">
        <label>
          <Search size={16} />
          <input
            value={query}
            placeholder={pick(locale, 'Search genres, countries, or artists', '장르, 국가, 아티스트 검색')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <select value={region} onChange={(event) => setRegion(event.target.value)}>
          {regionOptions.map((option) => (
            <option key={option} value={option}>
              {option === 'all' ? pick(locale, 'All regions', '전체 지역') : option}
            </option>
          ))}
        </select>
        <select
          value={selectedDate}
          disabled={!onSelectedDateChange || snapshotLoading}
          onChange={(event) => onSelectedDateChange?.(event.target.value)}
          aria-label={pick(locale, 'Chart snapshot date', '차트 스냅샷 날짜')}
        >
          {snapshotOptions.map((option) => (
            <option key={option.date} value={option.date}>
              {option.date} · {formatCount(locale, option.countries, 'country', 'countries', '개국')} · {formatCount(locale, option.tracks, 'track', 'tracks', '곡')}
            </option>
          ))}
        </select>
        <span className={`genre-playlist-status ${displayedPlaylistStatus.type}`}>
          {displayedPlaylistStatus.type === 'success' ? (
            <a href={displayedPlaylistStatus.url} target="_blank" rel="noreferrer">
              {metadataStatusMessage} · {displayedPlaylistStatus.message}
            </a>
          ) : (
            `${metadataStatusMessage} · ${displayedPlaylistStatus.message}`
          )}
        </span>
      </div>

      <div className="genre-layout">
        <div className="genre-card-grid" aria-label={pick(locale, 'local genre candidates', '로컬 장르 후보')}>
          {visibleSignals.map((signal) => (
            <button
              key={signal.genre.id}
              type="button"
              className={signal.genre.id === selectedSignal?.genre.id ? 'active' : ''}
              onClick={() => setSelectedGenreId(signal.genre.id)}
            >
              <span className="genre-card-accent" style={{ background: signal.genre.color }} />
              <span className="genre-rank">#{signal.rank}</span>
              <span className="genre-card-kicker">{signal.genre.region}</span>
              <strong>{signal.genre.name}</strong>
              {signal.genre.nativeName ? <small>{signal.genre.nativeName}</small> : null}
              <span>{signal.genre.countries}</span>
              <span className="genre-card-meta">
                <b>{formatScore(signal.chartPopularityScore)}</b>
                {pick(locale, 'rank-weighted count', '순위 가중 카운트')} · {confidenceLabel(signal, locale)}
              </span>
            </button>
          ))}
        </div>

        {selectedSignal ? (
          <aside className="genre-detail">
            <div className="genre-detail-head">
              <span style={{ background: selectedSignal.genre.color }} />
              <div>
                <p>{selectedSignal.genre.region}</p>
                <h2>{selectedSignal.genre.name}</h2>
                <small>{selectedSignal.genre.countries}</small>
              </div>
            </div>

            <div className="genre-score-strip">
              <span>
                <strong>{formatScore(selectedSignal.chartPopularityScore)}</strong>
                {pick(locale, 'Rank-weighted count', '순위 가중 카운트')}
              </span>
              <span>
                <strong>{formatScore(selectedSignal.targetChartScore)}</strong>
                {pick(locale, 'Target country signal', '타깃 국가 신호')}
              </span>
              <span>
                <strong>{formatScore(selectedSignal.expandedChartScore)}</strong>
                {pick(locale, 'Expanded chart signal', '확장 차트 신호')}
              </span>
            </div>

            <p className="genre-summary">{selectedGenreCopy?.summary}</p>
            <p className="genre-why">{selectedGenreCopy?.whyLocal}</p>

            <div className="genre-tags">
              {selectedSignal.genre.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>

            <section className="genre-detail-section">
              <div className="genre-section-title">
                <Music2 size={15} />
                {pick(locale, 'Seed Tracks', '대표곡 seed')}
              </div>
              <div className="genre-seed-list">
                {selectedSignal.genre.seedTracks.map((seed) => (
                  <span key={createSeedKey(seed)}>
                    <strong>{seed.track}</strong>
                    <small>{seed.artist}</small>
                  </span>
                ))}
              </div>
            </section>

            <section className="genre-detail-section">
              <div className="genre-section-title">
                <Crown size={15} />
                {pick(locale, 'Current Chart Tracks Classified as This Genre', '장르로 분류된 현재 차트 곡')}
              </div>
              {selectedSignal.matchedTracks.length > 0 ? (
                <div className="genre-chart-list">
                  {selectedSignal.matchedTracks.slice(0, 6).map((match) => (
                    <span key={`${match.country.code}-${match.track.id}-${match.entry.rank}`}>
                      <strong>{match.track.title}</strong>
                      <small>
                        {match.track.artist} · {match.country.code} #{match.entry.rank} ·{' '}
                        {scopeLabel(match.scope, locale)} · +{formatScore(match.weightedScore)} ·{' '}
                        {match.reasons[0]}
                      </small>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="genre-empty-note">
                  {pick(
                    locale,
                    'No current chart tracks were classified into this genre in this snapshot using external metadata or seed artists.',
                    '이번 스냅샷에서는 외부 메타데이터나 seed artist 기준으로 이 장르에 분류된 차트 곡이 없습니다.',
                  )}
                </p>
              )}
            </section>

            <section className="genre-detail-section">
              <div className="genre-section-title">{pick(locale, 'Target Country Top Tracks · Not Scored', '타깃 국가 상위곡 참고 · 점수 미반영')}</div>
              <div className="genre-chart-list compact">
                {selectedSignal.contextTracks.length > 0 ? (
                  selectedSignal.contextTracks.map((item) => (
                    <span key={`${item.country.code}-${item.track.id}`}>
                      <strong>{item.track.title}</strong>
                      <small>
                        {item.track.artist} · {item.country.code} #{item.entry.rank}
                      </small>
                    </span>
                  ))
                ) : (
                  <p className="genre-empty-note">
                    {pick(
                      locale,
                      `No collected chart is available for ${selectedSignal.genre.countryCodes.join(', ')}, so curated seeds are used only.`,
                      `현재 수집 국가에 ${selectedSignal.genre.countryCodes.join(', ')} 차트가 없어 큐레이션 seed만 사용합니다.`,
                    )}
                  </p>
                )}
              </div>
            </section>

            <button
              type="button"
              className="genre-create-button"
              disabled={playlistStatus.type === 'working'}
              onClick={createSelectedGenrePlaylist}
            >
              {pick(locale, 'Create public playlist from this genre', '이 장르 차트곡 우선으로 공개 플레이리스트 생성')}
            </button>
          </aside>
        ) : null}
      </div>
    </section>
  )
}

export default GenreDiscovery
