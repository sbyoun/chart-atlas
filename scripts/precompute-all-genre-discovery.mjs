#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

const INDEX_FILE = process.env.CHART_INDEX_FILE ?? 'public/data/snapshot-index.json'

function runPrecompute(snapshotFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['scripts/precompute-genre-discovery.mjs'],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          CHART_SNAPSHOT_FILE: snapshotFile,
          TRACK_METADATA_LOOKUP_LIMIT: process.env.TRACK_METADATA_LOOKUP_LIMIT || '1200',
          GENRE_TRACK_CANDIDATE_LIMIT: process.env.GENRE_TRACK_CANDIDATE_LIMIT || '1200',
        },
      },
    )

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`precompute failed for ${snapshotFile}: exit ${code}`))
      }
    })
  })
}

async function main() {
  const index = JSON.parse(await readFile(INDEX_FILE, 'utf8'))
  const snapshots = Array.isArray(index?.snapshots) ? [...index.snapshots].reverse() : []

  for (const snapshot of snapshots) {
    if (!snapshot?.file || !snapshot?.date) continue
    const snapshotFile = `public${snapshot.file}`
    console.log(`\n=== Genre precompute ${snapshot.date} ===`)
    await runPrecompute(snapshotFile)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
