#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const SNAPSHOT_FILE = process.env.CHART_SNAPSHOT_FILE ?? 'public/data/chart-snapshot.json'
const INDEX_FILE = process.env.CHART_INDEX_FILE ?? 'public/data/snapshot-index.json'
const LEGACY_OUTFILE = process.env.CHART_ANALYSIS_OUTFILE ?? 'public/data/analysis.json'
const ANALYSIS_DIR = process.env.CHART_ANALYSIS_DIR ?? 'public/data/analysis'
const SHOULD_PRECOMPUTE_ALL = process.env.CHART_ANALYSIS_ALL === '1'

function rankScore(rank) {
  return Math.max(0, 101 - rank)
}

function regionSignal(countryRanks, countries) {
  const regionCountryCounts = new Map()
  const regionScores = new Map()

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
  ])
  const total = normalizedScores.reduce((sum, [, score]) => sum + score, 0)
  const strongest = normalizedScores.sort((a, b) => b[1] - a[1])[0]

  return {
    strongestRegion: strongest?.[0] ?? 'N/A',
    locality: strongest && total > 0 ? Math.round((strongest[1] / total) * 100) : 0,
  }
}

function buildTrackStats(snapshot) {
  const countryByCode = new Map(snapshot.countries.map((country) => [country.code, country]))

  return snapshot.tracks
    .map((track) => {
      const countryRanks = snapshot.countryCharts.flatMap((chart) => {
        const country = countryByCode.get(chart.countryCode)
        const entry = chart.entries.find((item) => item.trackId === track.id)

        return country && entry ? [{ country, entry }] : []
      })
      const { locality, strongestRegion } = regionSignal(countryRanks, snapshot.countries)
      const score = countryRanks.reduce((sum, { entry }) => sum + rankScore(entry.rank), 0)
      const weightedScore = score

      return {
        trackId: track.id,
        title: track.title,
        artist: track.artist,
        artistId: track.artistId,
        genre: track.genre,
        color: track.color,
        url: track.url,
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
        countryRanks: countryRanks
          .sort((a, b) => a.entry.rank - b.entry.rank)
          .map(({ country, entry }) => ({
            countryCode: country.code,
            rank: entry.rank,
            score: rankScore(entry.rank),
          })),
      }
    })
    .sort((a, b) => b.weightedScore - a.weightedScore)
    .map((stat, index) => ({ rank: index + 1, ...stat }))
}

function buildArtistStats(snapshot, trackStats) {
  const artistIds = [...new Set(snapshot.tracks.map((track) => track.artistId))]
  const chartByCountry = new Map(
    snapshot.countryCharts.map((chart) => [chart.countryCode, chart.entries]),
  )
  const trackById = new Map(snapshot.tracks.map((track) => [track.id, track]))

  return artistIds
    .map((artistId) => {
      const artistTracks = snapshot.tracks.filter((track) => track.artistId === artistId)
      const countryRanks = snapshot.countries.flatMap((country) => {
        const entries = chartByCountry.get(country.code) ?? []
        const matchingEntries = entries
          .map((entry) => ({ entry, track: trackById.get(entry.trackId) }))
          .filter((item) => item.track?.artistId === artistId)

        if (matchingEntries.length === 0) {
          return []
        }

        const best = matchingEntries.sort((a, b) => a.entry.rank - b.entry.rank)[0]
        const countryScore = rankScore(best.entry.rank)

        return [{ country, entry: best.entry, track: best.track, countryScore }]
      })
      const { locality, strongestRegion } = regionSignal(countryRanks, snapshot.countries)
      const trackScore = trackStats
        .filter((stat) => stat.artistId === artistId)
        .reduce((sum, stat) => sum + stat.score, 0)
      const weightedScore = countryRanks.reduce((sum, item) => sum + item.countryScore, 0)

      return {
        artistId,
        artist: artistTracks[0]?.artist ?? artistId,
        color: artistTracks[0]?.color ?? '#64748b',
        trackIds: artistTracks.map((track) => track.id),
        score: trackScore,
        weightedScore,
        appearances: countryRanks.length,
        topOnes: countryRanks.filter(({ entry }) => entry.rank === 1).length,
        topTens: countryRanks.filter(({ entry }) => entry.rank <= 10).length,
        locality,
        strongestRegion,
        countryRanks: countryRanks
          .sort((a, b) => b.countryScore - a.countryScore)
          .map(({ country, entry, track, countryScore }) => ({
            countryCode: country.code,
            trackId: track.id,
            rank: entry.rank,
            countryScore,
          })),
      }
    })
    .sort((a, b) => b.weightedScore - a.weightedScore)
    .map((stat, index) => ({ rank: index + 1, ...stat }))
}

function buildAnalysis(snapshot) {
  const trackStats = buildTrackStats(snapshot)
  const artistStats = buildArtistStats(snapshot, trackStats)

  return {
    schemaVersion: 1,
    sourceSnapshotDate: snapshot.snapshotDate,
    sourceName: snapshot.sourceName,
    sourceUrl: snapshot.sourceUrl,
    generatedAt: new Date().toISOString(),
    countries: snapshot.countries.length,
    tracks: snapshot.tracks.length,
    artists: artistStats.length,
    scoring: {
      rankScore: 'max(0, 101 - country chart rank)',
      trackWeightedScore: 'sum rankScore across charting countries',
      artistWeightedScore: 'sum best per-country rankScore across artist tracks',
    },
    trackStats,
    artistStats,
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function writeJson(file, payload) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`)
}

function publicAnalysisPath(date) {
  return `/data/analysis/${date}.json`
}

async function writeAnalysisForSnapshot(snapshotFile, { writeLegacy = false } = {}) {
  const snapshot = await readJson(snapshotFile)
  const analysis = buildAnalysis(snapshot)
  const datedOutfile = path.join(ANALYSIS_DIR, `${snapshot.snapshotDate}.json`)

  await writeJson(datedOutfile, analysis)

  if (writeLegacy) {
    await writeJson(LEGACY_OUTFILE, analysis)
  }

  return {
    date: snapshot.snapshotDate,
    file: publicAnalysisPath(snapshot.snapshotDate),
    localFile: datedOutfile,
    analysis,
  }
}

async function updateSnapshotIndex(analysisEntries) {
  let index

  try {
    index = await readJson(INDEX_FILE)
  } catch {
    return
  }

  const analysisByDate = new Map(analysisEntries.map((entry) => [entry.date, entry]))
  const snapshots = (index.snapshots ?? []).map((snapshotEntry) => {
    const analysisEntry = analysisByDate.get(snapshotEntry.date)

    return analysisEntry
      ? { ...snapshotEntry, analysisFile: analysisEntry.file }
      : snapshotEntry
  })

  await writeJson(INDEX_FILE, { ...index, snapshots })
}

async function main() {
  if (!SHOULD_PRECOMPUTE_ALL) {
    const entry = await writeAnalysisForSnapshot(SNAPSHOT_FILE, { writeLegacy: true })
    await updateSnapshotIndex([entry])
    console.log(`Wrote ${entry.localFile}`)
    console.log(`Wrote ${LEGACY_OUTFILE}`)
    console.log(`Updated ${INDEX_FILE}`)
    console.log(`${entry.analysis.artists} artists, ${entry.analysis.tracks} tracks`)
    return
  }

  const index = await readJson(INDEX_FILE)
  const snapshots = Array.isArray(index?.snapshots) ? [...index.snapshots].reverse() : []
  const entries = []

  for (const snapshot of snapshots) {
    if (!snapshot?.file || !snapshot?.date) continue

    const snapshotFile = `public${snapshot.file}`
    console.log(`\n=== Analysis precompute ${snapshot.date} ===`)
    entries.push(await writeAnalysisForSnapshot(snapshotFile, {
      writeLegacy: snapshot.date === index.latestDate,
    }))
  }

  await updateSnapshotIndex(entries)
  console.log(`\nUpdated ${INDEX_FILE}`)
  console.log(`Wrote ${entries.length} analysis snapshots`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
