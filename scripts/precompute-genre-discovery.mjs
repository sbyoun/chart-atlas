#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fetchExternalArtistMetadata, fetchExternalTrackMetadata } from '../server.mjs'

const SNAPSHOT_FILE = process.env.CHART_SNAPSHOT_FILE ?? 'public/data/chart-snapshot.json'
const LOCAL_GENRES_FILE = process.env.LOCAL_GENRES_FILE ?? 'src/data/localGenres.ts'
const LEGACY_OUTFILE = process.env.GENRE_DISCOVERY_OUTFILE ?? 'public/data/genre-discovery.json'
const GENRE_DISCOVERY_DIR = process.env.GENRE_DISCOVERY_DIR ?? 'public/data/genre-discovery'
const GENRE_DISCOVERY_DEBUG_DIR =
  process.env.GENRE_DISCOVERY_DEBUG_DIR ?? 'data/genre-discovery-debug'
const GENRE_METADATA_CACHE_FILE =
  process.env.GENRE_METADATA_CACHE_FILE ?? 'data/genre-metadata-cache.json'
const TRACK_CHART_DEPTH = readPositiveIntegerEnv('GENRE_TRACK_CHART_DEPTH', 50)
const TRACK_CANDIDATE_LIMIT = readPositiveIntegerEnv('GENRE_TRACK_CANDIDATE_LIMIT', 1200)
const PUBLIC_MATCHED_TRACK_LIMIT = readPositiveIntegerEnv('GENRE_PUBLIC_MATCHED_TRACK_LIMIT', 60)
const EMPTY_TRACK_CACHE_TTL_MS = readPositiveIntegerEnv(
  'GENRE_EMPTY_TRACK_CACHE_TTL_HOURS',
  168,
) * 60 * 60 * 1000

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
const SPECIFIC_GENRE_CONFLICT_KINDS = new Set([
  'trackGenre',
  'trackDescription',
  'artistGenre',
  'artistDescription',
  'curatedArtist',
])

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function readPositiveIntegerEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function elapsedSeconds(startedAt) {
  return ((Date.now() - startedAt) / 1000).toFixed(1)
}

function rankScore(rank) {
  return Math.max(0, 101 - rank)
}

function peakRankBonus(rank) {
  if (rank <= 3) return 900
  if (rank <= 5) return 700
  if (rank <= 10) return 450
  if (rank <= 20) return 220
  if (rank <= 50) return 80
  return 0
}

function textTokens(value) {
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2)
}

function normalizedTokens(value) {
  return normalizeText(value)
    .split(/\s+/)
    .filter(Boolean)
}

function normalizedTermMatchesText(term, text) {
  const termTokens = normalizedTokens(term)
  const textTokens = normalizedTokens(text)
  if (termTokens.length === 0 || textTokens.length === 0) return false

  if (termTokens.length === 1) {
    return textTokens.includes(termTokens[0])
  }

  for (let index = 0; index <= textTokens.length - termTokens.length; index += 1) {
    const matches = termTokens.every((token, offset) => textTokens[index + offset] === token)
    if (matches) return true
  }

  return false
}

function isSameArtistName(seedArtist, chartArtist) {
  const seed = normalizeText(seedArtist)
  const chart = normalizeText(chartArtist)
  if (!seed || !chart) return false
  if (seed === chart) return true

  const seedTokens = textTokens(seedArtist)
  const chartTokens = textTokens(chartArtist)
  if (seedTokens.length === 0 || chartTokens.length === 0) return false
  if (seedTokens.length === 1 || chartTokens.length === 1) return false

  const chartTokenSet = new Set(chartTokens)
  const seedTokenSet = new Set(seedTokens)
  const seedHits = seedTokens.filter((token) => chartTokenSet.has(token)).length
  const chartHits = chartTokens.filter((token) => seedTokenSet.has(token)).length

  return seedHits / seedTokens.length >= 0.8 && chartHits / chartTokens.length >= 0.8
}

function isAllowedStructuredGenericTerm(genre, normalized) {
  if (genre.id === 'dance-electronic') return normalized === 'dance' || normalized === 'club'
  if (genre.id === 'pop') return normalized === 'pop'
  if (genre.id === 'country') return normalized === 'country'
  if (genre.id === 'afrobeats-afropop') return normalized === 'african'
  if (genre.id === 'arabic-pop') return normalized === 'arabic'
  return false
}

function isGenericPhrase(normalized) {
  const tokens = normalized.split(/\s+/).filter(Boolean)
  return tokens.length > 1 && tokens.every((token) => GENERIC_GENRE_TERMS.has(token))
}

function countryContextTerms(genre) {
  return new Set(
    String(genre.countries || '')
      .split(/[,/]/)
      .map((term) => normalizeText(term))
      .filter(Boolean),
  )
}

function genreEvidenceTerms(genre, { structured = false } = {}) {
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

function structuredGenreEvidenceTerms(genre) {
  return genreEvidenceTerms(genre, { structured: true })
}

function canUseDescriptionEvidence(term) {
  const normalized = normalizeText(term)
  return Boolean(normalized && !GENERIC_GENRE_TERMS.has(normalized))
}

function isGenericGenreTerm(term) {
  return GENERIC_GENRE_TERMS.has(normalizeText(term))
}

const EVIDENCE_CONFIG = {
  trackGenre: { baseScore: 100, weight: 1 },
  trackDescription: { baseScore: 76, weight: 0.88 },
  artistGenre: { baseScore: 86, weight: 0.88 },
  artistDescription: { baseScore: 62, weight: 0.72 },
  curatedArtist: { baseScore: 50, weight: 0.58 },
  chartText: { baseScore: 36, weight: 0.55 },
}

function genreSpecificityScore(genre) {
  return BROAD_MAINSTREAM_GENRE_IDS.has(genre.id) ? 0 : 26
}

function candidateSortScore(candidate) {
  return candidate.baseScore + genreSpecificityScore(candidate.genre)
}

function sourceLabel(sources, fallback) {
  return sources?.length ? sources.join('/') : fallback
}

function hasReliableArtistIdentity(track, artistMetadata, trackMetadata) {
  const artistTokens = textTokens(track.artist)
  if (artistTokens.length > 1) return true
  if ((trackMetadata?.genres || []).length > 0 || (trackMetadata?.tags || []).length > 0) return true

  const sources = new Set(artistMetadata?.sources || [])
  return sources.has('MusicBrainz') || sources.has('Wikidata') || sources.has('Wikipedia')
}

function addCandidate(candidates, genre, kind, reason) {
  const config = EVIDENCE_CONFIG[kind]
  const current = candidates.get(genre.id)
  const currentBaseScore = current?.baseScore || 0
  const kinds = [...new Set([...(current?.kinds || []), kind])]
  const next = {
    genre,
    kind: config.baseScore >= currentBaseScore ? kind : current.kind,
    kinds,
    reason,
    reasons: current ? [...current.reasons, reason] : [reason],
    baseScore: Math.max(currentBaseScore, config.baseScore),
    weight: Math.max(current?.weight || 0, config.weight),
  }
  candidates.set(genre.id, next)
}

function hasTermMatch(terms, searchable, { descriptions = false } = {}) {
  return terms.find((term) => {
    if (!normalizeText(term)) return false
    if (descriptions && !canUseDescriptionEvidence(term)) return false
    return normalizedTermMatchesText(term, searchable)
  })
}

function hasStructuredTermMatch(terms, values) {
  const normalizedValues = values.map((value) => normalizeText(value)).filter(Boolean)
  const searchable = normalizedValues.join(' ')

  return terms.find((term) => {
    const normalizedTerm = normalizeText(term)
    if (!normalizedTerm) return false
    if (isGenericGenreTerm(term)) {
      return normalizedValues.includes(normalizedTerm)
    }
    return normalizedTermMatchesText(term, searchable)
  })
}

function extractGenreCandidates(track, artistMetadata, trackMetadata, localGenres) {
  const candidates = new Map()
  const trackGenreTerms = [...(trackMetadata?.genres || []), ...(trackMetadata?.tags || [])]
  const trackDescriptionSearchable = normalizeText((trackMetadata?.descriptions || []).join(' '))
  const artistGenreTerms = [...(artistMetadata?.genres || []), ...(artistMetadata?.tags || [])]
  const artistDescriptionSearchable = normalizeText((artistMetadata?.descriptions || []).join(' '))
  const canUseArtistMetadata = hasReliableArtistIdentity(track, artistMetadata, trackMetadata)
  const chartSearchable = normalizeText(`${track.title} ${track.artist} ${track.genre}`)
  const trackSourceLabel = sourceLabel(trackMetadata?.sources, 'track metadata')
  const artistSourceLabel = sourceLabel(artistMetadata?.sources, 'artist metadata')

  for (const genre of localGenres) {
    const evidenceTerms = genreEvidenceTerms(genre)
    const structuredEvidenceTerms = structuredGenreEvidenceTerms(genre)
    const trackGenreTerm = hasStructuredTermMatch(structuredEvidenceTerms, trackGenreTerms)
    if (trackGenreTerm) {
      addCandidate(candidates, genre, 'trackGenre', `${trackSourceLabel}: ${trackGenreTerm}`)
    }

    const trackDescriptionTerm = hasTermMatch(evidenceTerms, trackDescriptionSearchable, {
      descriptions: true,
    })
    if (trackDescriptionTerm) {
      addCandidate(
        candidates,
        genre,
        'trackDescription',
        `${trackSourceLabel} description: ${trackDescriptionTerm}`,
      )
    }

    const artistGenreTerm = canUseArtistMetadata
      ? hasStructuredTermMatch(structuredEvidenceTerms, artistGenreTerms)
      : null
    if (artistGenreTerm) {
      addCandidate(candidates, genre, 'artistGenre', `${artistSourceLabel}: ${artistGenreTerm}`)
    }

    const artistDescriptionTerm = canUseArtistMetadata
      ? hasTermMatch(evidenceTerms, artistDescriptionSearchable, {
          descriptions: true,
        })
      : null
    if (artistDescriptionTerm) {
      addCandidate(
        candidates,
        genre,
        'artistDescription',
        `${artistSourceLabel} description: ${artistDescriptionTerm}`,
      )
    }

    if (genre.seedArtists.some((artist) => isSameArtistName(artist, track.artist))) {
      addCandidate(candidates, genre, 'curatedArtist', `curated artist fallback: ${track.artist}`)
    }

    const chartTextTerm = hasTermMatch(evidenceTerms, chartSearchable)
    if (chartTextTerm) {
      addCandidate(candidates, genre, 'chartText', `chart text: ${chartTextTerm}`)
    }
  }

  return [...candidates.values()]
    .map((candidate) => ({
      ...candidate,
      score: candidateSortScore(candidate),
      isBroad: BROAD_MAINSTREAM_GENRE_IDS.has(candidate.genre.id),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return b.genre.priority - a.genre.priority
    })
}

function hasViberateReason(candidate) {
  return candidate.reasons.some((reason) => /Viberate/.test(reason))
}

function hasDominantSpecificGenreCandidate(candidate, candidates) {
  return candidates.some((other) => {
    if (other.genre.id === candidate.genre.id || other.isBroad) return false
    if (other.score < candidate.score - 10) return false
    if (!other.kinds.some((kind) => SPECIFIC_GENRE_CONFLICT_KINDS.has(kind))) return false
    if (other.kinds.some((kind) => ['trackGenre', 'trackDescription', 'curatedArtist'].includes(kind))) {
      return true
    }
    return (
      other.kinds.some((kind) => ['artistGenre', 'artistDescription'].includes(kind)) &&
      hasViberateReason(other)
    )
  })
}

function candidateIsGenreLabel(candidate, _index, candidates) {
  if (candidate.kinds.includes('trackGenre')) return true
  if (
    !candidate.isBroad &&
    candidate.kinds.some((kind) => ['trackDescription', 'curatedArtist'].includes(kind))
  ) {
    return candidate.score >= EVIDENCE_CONFIG.trackDescription.baseScore
  }

  if (candidate.isBroad) {
    return (
      ARTIST_LEVEL_BROAD_GENRE_IDS.has(candidate.genre.id) &&
      candidate.kinds.includes('artistGenre') &&
      candidate.baseScore >= EVIDENCE_CONFIG.artistGenre.baseScore &&
      hasViberateReason(candidate) &&
      !hasDominantSpecificGenreCandidate(candidate, candidates)
    )
  }

  return (
    candidate.score >= EVIDENCE_CONFIG.trackDescription.baseScore &&
    candidate.kinds.some((kind) => ['artistGenre', 'artistDescription'].includes(kind)) &&
    hasViberateReason(candidate)
  )
}

function labelWeight(candidate, primaryScore) {
  if (candidate.score >= primaryScore) {
    return candidate.weight
  }

  const relativeWeight = Math.max(0.45, Math.min(0.85, candidate.score / primaryScore))
  return Number((candidate.weight * relativeWeight).toFixed(4))
}

function classifyTrackGenres(track, artistMetadata, trackMetadata, localGenres) {
  const candidates = extractGenreCandidates(track, artistMetadata, trackMetadata, localGenres)
  if (candidates.length === 0) {
    return null
  }

  const primary = candidates[0]
  const labels = candidates
    .filter(candidateIsGenreLabel)
    .map((candidate) => ({
      genreId: candidate.genre.id,
      genreName: candidate.genre.name,
      reasons: candidate.reasons,
      confidenceScore: candidate.score,
      weight: labelWeight(candidate, primary.score),
      primary: candidate.genre.id === primary.genre.id,
    }))

  if (labels.length === 0) {
    return null
  }

  const primaryLabel = labels[0]
  return {
    genreId: primaryLabel.genreId,
    genreName: primaryLabel.genreName,
    reasons: primaryLabel.reasons,
    confidenceScore: primaryLabel.confidenceScore,
    weight: primaryLabel.weight,
    labels,
    candidates: candidates.slice(0, 8).map((candidate) => ({
      genreId: candidate.genre.id,
      genreName: candidate.genre.name,
      score: candidate.score,
      kinds: candidate.kinds,
      reasons: candidate.reasons,
    })),
  }
}

async function loadLocalGenres() {
  let source = await readFile(LOCAL_GENRES_FILE, 'utf8')
  source = source
    .replace(/export type LocalGenreTrackSeed[\s\S]*?\n}\n\n/, '')
    .replace(/export type LocalGenreDefinition[\s\S]*?\n}\n\n/, '')
    .replace('export const localGenres: LocalGenreDefinition[] =', 'const localGenres =')

  return Function(`${source}\nreturn localGenres`)()
}

async function loadMetadataCache() {
  try {
    const payload = JSON.parse(await readFile(GENRE_METADATA_CACHE_FILE, 'utf8'))
    return {
      schemaVersion: 1,
      artists: payload?.artists && typeof payload.artists === 'object' ? payload.artists : {},
      tracks: payload?.tracks && typeof payload.tracks === 'object' ? payload.tracks : {},
    }
  } catch {
    return { schemaVersion: 1, artists: {}, tracks: {} }
  }
}

async function saveMetadataCache(cache) {
  await mkdir(path.dirname(GENRE_METADATA_CACHE_FILE), { recursive: true })
  await writeFile(
    GENRE_METADATA_CACHE_FILE,
    `${JSON.stringify({ ...cache, updatedAt: new Date().toISOString() }, null, 2)}\n`,
  )
}

function cacheKeyFromCandidate(candidate) {
  return String(candidate.id || '').trim()
}

function hasUsefulArtistMetadata(metadata) {
  return Boolean(
    metadata &&
      ((metadata.genres || []).length > 0 ||
        (metadata.tags || []).length > 0 ||
        (metadata.descriptions || []).length > 0 ||
        (metadata.sources || []).length > 0),
  )
}

function hasUsefulTrackMetadata(metadata) {
  return Boolean(
    metadata &&
      ((metadata.genres || []).length > 0 ||
        (metadata.tags || []).length > 0 ||
        (metadata.descriptions || []).length > 0 ||
        (metadata.sources || []).length > 0),
  )
}

function hasFreshEmptyTrackMetadata(metadata) {
  if (!metadata || hasUsefulTrackMetadata(metadata)) return false
  const cachedAt = Date.parse(metadata.emptyCachedAt || '')
  return Number.isFinite(cachedAt) && Date.now() - cachedAt < EMPTY_TRACK_CACHE_TTL_MS
}

function emptyTrackMetadata(track) {
  return {
    id: track.id,
    inputTitle: track.title,
    inputArtist: track.artist,
    title: track.title,
    artist: track.artist,
    genres: [],
    tags: [],
    descriptions: [],
    sources: [],
    links: [],
    countryCode: '',
    matchScore: 0,
    emptyCachedAt: new Date().toISOString(),
  }
}

function artistCacheKey(value) {
  return normalizeText(value)
}

function applyTrackArtistGenrePropagation(trackMetadata, candidates) {
  const inputById = new Map(candidates.map((candidate) => [candidate.id, candidate]))
  const hintsByArtist = new Map()

  for (const metadata of trackMetadata) {
    if (!hasUsefulTrackMetadata(metadata)) continue
    const input = inputById.get(metadata.id)
    const artist = input?.artist || metadata.inputArtist || metadata.artist
    const key = artistCacheKey(artist)
    if (!key || hintsByArtist.has(key)) continue
    hintsByArtist.set(key, {
      genres: metadata.genres,
      tags: metadata.tags || metadata.genres,
      countryCode: metadata.countryCode || '',
    })
  }

  return trackMetadata.map((metadata) => {
    if (hasUsefulTrackMetadata(metadata)) return metadata
    const input = inputById.get(metadata.id)
    const key = artistCacheKey(input?.artist || metadata.inputArtist || metadata.artist)
    const hint = key ? hintsByArtist.get(key) : null
    if (!hint?.genres?.length) return metadata

    return {
      ...metadata,
      genres: hint.genres,
      tags: hint.tags || hint.genres,
      descriptions: ['cached current-snapshot artist genre propagation'],
      sources: ['Cached track metadata'],
      countryCode: hint.countryCode,
      matchScore: 8,
    }
  })
}

function publicSignal(signal) {
  return {
    ...signal,
    matchedTrackCount: signal.matchedTracks.length,
    matchedTracks: signal.matchedTracks.slice(0, PUBLIC_MATCHED_TRACK_LIMIT),
  }
}

function publicPayload(payload) {
  const {
    classifications,
    ...rest
  } = payload

  return {
    ...rest,
    debugClassificationsOmitted: Array.isArray(classifications) ? classifications.length : 0,
    publicMatchedTrackLimit: PUBLIC_MATCHED_TRACK_LIMIT,
    signals: payload.signals.map(publicSignal),
  }
}

async function getCachedArtistMetadata(candidates, cache) {
  const cached = []
  const missing = []

  for (const candidate of candidates) {
    const key = cacheKeyFromCandidate(candidate)
    if (key && hasUsefulArtistMetadata(cache.artists[key])) {
      cached.push(cache.artists[key])
    } else {
      missing.push(candidate)
    }
  }

  const startedAt = Date.now()
  const fetched = missing.length > 0 ? await fetchExternalArtistMetadata(missing) : []
  for (const artist of fetched) {
    if (artist?.id && hasUsefulArtistMetadata(artist)) {
      cache.artists[artist.id] = artist
    } else if (artist?.id) {
      delete cache.artists[artist.id]
    }
  }

  console.log(
    `Artist metadata cache: ${cached.length} hit, ${missing.length} miss, fetched ${fetched.length} in ${elapsedSeconds(startedAt)}s`,
  )

  return [...cached, ...fetched]
}

async function getCachedTrackMetadata(candidates, cache) {
  const cached = []
  const missing = []

  for (const candidate of candidates) {
    const key = cacheKeyFromCandidate(candidate)
    if (
      key &&
      (hasUsefulTrackMetadata(cache.tracks[key]) || hasFreshEmptyTrackMetadata(cache.tracks[key]))
    ) {
      cached.push(cache.tracks[key])
    } else {
      missing.push(candidate)
    }
  }

  const startedAt = Date.now()
  const fetched = missing.length > 0 ? await fetchExternalTrackMetadata(missing) : []
  for (const track of fetched) {
    if (track?.id && hasUsefulTrackMetadata(track)) {
      cache.tracks[track.id] = track
    } else if (track?.id) {
      const input = missing.find((candidate) => candidate.id === track.id)
      cache.tracks[track.id] = emptyTrackMetadata(input || track)
    }
  }

  console.log(
    `Track metadata cache: ${cached.length} hit, ${missing.length} miss, fetched ${fetched.length} in ${elapsedSeconds(startedAt)}s`,
  )

  const merged = applyTrackArtistGenrePropagation([...cached, ...fetched], candidates)
  for (const track of merged) {
    if (track?.id && hasUsefulTrackMetadata(track)) {
      cache.tracks[track.id] = track
    }
  }

  return merged
}

function collectArtistCandidates(snapshot) {
  const trackById = new Map(snapshot.tracks.map((track) => [track.id, track]))
  const artistScores = new Map()
  const countryArtistScores = new Map()

  for (const chart of snapshot.countryCharts) {
    const currentCountryScores = countryArtistScores.get(chart.countryCode) || new Map()

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

  const sortArtists = (artists) =>
    [...artists].sort((a, b) => {
      const scoreA = a.score + peakRankBonus(a.bestRank)
      const scoreB = b.score + peakRankBonus(b.bestRank)
      if (scoreB !== scoreA) return scoreB - scoreA
      return a.bestRank - b.bestRank
    })

  const globalArtists = sortArtists(artistScores.values()).slice(0, 90)
  const countryArtists = [...countryArtistScores.values()].flatMap((scores) =>
    sortArtists(scores.values()).slice(0, 12),
  )

  return [...new Map([...countryArtists, ...globalArtists].map((artist) => [artist.id, artist])).values()]
    .slice(0, 220)
    .map(({ id, name }) => ({ id, name }))
}

function collectTrackCandidates(snapshot) {
  const trackById = new Map(snapshot.tracks.map((track) => [track.id, track]))
  const trackScores = new Map()

  for (const chart of snapshot.countryCharts) {
    for (const entry of chart.entries.slice(0, TRACK_CHART_DEPTH)) {
      const track = trackById.get(entry.trackId)
      if (!track?.id || !track.title || !track.artist) continue
      const current = trackScores.get(track.id) || {
        id: track.id,
        title: track.title,
        artist: track.artist,
        score: 0,
        bestRank: entry.rank,
        countryScores: new Map(),
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

  return [...trackScores.values()]
    .sort((a, b) => {
      const scoreA = a.score + peakRankBonus(a.bestRank)
      const scoreB = b.score + peakRankBonus(b.bestRank)
      if (scoreB !== scoreA) return scoreB - scoreA
      return a.bestRank - b.bestRank
    })
    .slice(0, TRACK_CANDIDATE_LIMIT)
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

function buildTrackClassifications(snapshot, localGenres, artistMetadataById, trackMetadataById) {
  const trackById = new Map(snapshot.tracks.map((track) => [track.id, track]))
  const classifications = new Map()

  for (const chart of snapshot.countryCharts) {
    for (const entry of chart.entries.slice(0, 50)) {
      const track = trackById.get(entry.trackId)
      if (!track || classifications.has(track.id)) continue

      const classification = classifyTrackGenres(
        track,
        artistMetadataById.get(track.artistId),
        trackMetadataById.get(track.id),
        localGenres,
      )
      if (classification) {
        classifications.set(track.id, classification)
      }
    }
  }

  return classifications
}

function buildGenreSignals(snapshot, localGenres, classificationsByTrackId) {
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
      const matchedTracks = []
      const contextTracks = []
      const seenContextTrackIds = new Set()

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
          const classification = classificationsByTrackId.get(track.id)
          const label =
            classification?.labels?.find((candidate) => candidate.genreId === genre.id) ||
            (classification?.genreId === genre.id ? classification : null)
          if (!label) continue

          const scope = isTargetCountry ? 'target' : isTargetRegion ? 'regional' : 'global'
          matchedTracks.push({
            track,
            country,
            entry,
            reasons: label.reasons,
            scope,
            weightedScore: rankScore(entry.rank) * label.weight,
          })
        }
      }

      const targetChartScore = matchedTracks
        .filter((match) => match.scope === 'target')
        .reduce((sum, match) => sum + match.weightedScore, 0)
      const expandedChartScore = matchedTracks
        .filter((match) => match.scope !== 'target')
        .reduce((sum, match) => sum + match.weightedScore, 0)
      const chartPopularityScore = targetChartScore + expandedChartScore

      return {
        genre,
        rank: 0,
        chartPopularityScore,
        targetChartScore,
        expandedChartScore,
        confidence: chartPopularityScore > 0 ? 'chart' : availableCountries.length > 0 ? 'coverage' : 'curated',
        availableCountries,
        missingCountryCodes,
        matchedTracks: matchedTracks.sort((a, b) => b.weightedScore - a.weightedScore),
        contextTracks: contextTracks.slice(0, 8),
      }
    })
    .sort((a, b) => {
      if (b.chartPopularityScore !== a.chartPopularityScore) return b.chartPopularityScore - a.chartPopularityScore
      return b.genre.priority - a.genre.priority
    })

  return scoredSignals.map((signal, index) => ({ ...signal, rank: index + 1 }))
}

async function main() {
  const startedAt = Date.now()
  const snapshot = JSON.parse(await readFile(SNAPSHOT_FILE, 'utf8'))
  const localGenres = await loadLocalGenres()
  const artistCandidates = collectArtistCandidates(snapshot)
  const trackCandidates = collectTrackCandidates(snapshot)
  const metadataCache = await loadMetadataCache()

  console.log(`Genre precompute: ${artistCandidates.length} artists, ${trackCandidates.length} tracks`)

  const [artistMetadata, trackMetadata] = await Promise.all([
    getCachedArtistMetadata(artistCandidates, metadataCache),
    getCachedTrackMetadata(trackCandidates, metadataCache),
  ])
  await saveMetadataCache(metadataCache)

  const artistMetadataById = new Map(artistMetadata.map((artist) => [artist.id, artist]))
  const trackMetadataById = new Map(trackMetadata.map((track) => [track.id, track]))
  const classificationsByTrackId = buildTrackClassifications(
    snapshot,
    localGenres,
    artistMetadataById,
    trackMetadataById,
  )
  const signals = buildGenreSignals(snapshot, localGenres, classificationsByTrackId)
  const payload = {
    schemaVersion: 2,
    snapshotDate: snapshot.snapshotDate,
    generatedAt: new Date().toISOString(),
    sourceSnapshot: SNAPSHOT_FILE,
    scoreMode: 'rank-weighted-chart-count',
    artistMetadataCount: artistMetadata.length,
    trackMetadataCount: trackMetadata.length,
    artistMetadataCacheSize: Object.keys(metadataCache.artists).length,
    trackMetadataCacheSize: Object.keys(metadataCache.tracks).length,
    elapsedSeconds: Number(elapsedSeconds(startedAt)),
    classifications: [...classificationsByTrackId.entries()].map(([trackId, classification]) => ({
      trackId,
      ...classification,
    })),
    signals,
  }

  const slimPayload = publicPayload(payload)
  const datedOutfile = path.join(GENRE_DISCOVERY_DIR, `${snapshot.snapshotDate}.json`)
  const debugOutfile = path.join(GENRE_DISCOVERY_DEBUG_DIR, `${snapshot.snapshotDate}.json`)
  const outfiles = [...new Set([LEGACY_OUTFILE, datedOutfile])]
  for (const outfile of outfiles) {
    await mkdir(path.dirname(outfile), { recursive: true })
    await writeFile(outfile, `${JSON.stringify(slimPayload, null, 2)}\n`)
    console.log(`Wrote ${outfile}`)
  }
  await mkdir(path.dirname(debugOutfile), { recursive: true })
  await writeFile(debugOutfile, `${JSON.stringify(payload, null, 2)}\n`)
  console.log(`Wrote ${debugOutfile}`)
  console.log(`Genre precompute finished in ${elapsedSeconds(startedAt)}s`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
