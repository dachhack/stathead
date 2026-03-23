#!/usr/bin/env tsx
/**
 * Pre-builds all ADP Hit/Bust features from the pre-downloaded CSVs in public/data/.
 * Outputs public/data/prebuilt-features.json.
 *
 * Prerequisites: run scripts/download-data.sh first to populate public/data/.
 *
 * Run manually:  tsx scripts/build-features.ts
 * Wired into the build:  npm run build:features
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';

const DATA_DIR = resolve(process.cwd(), 'public/data');
const OUT_FILE = resolve(DATA_DIR, 'prebuilt-features.json');
const PORT = 7891;

// ── 0. Guard: skip if CSVs haven't been downloaded yet ────────────────────
if (!existsSync(resolve(DATA_DIR, 'combine.csv'))) {
  console.log('[build-features] public/data/combine.csv not found — skipping pre-build.');
  console.log('[build-features] Run scripts/download-data.sh first to enable pre-building.');
  process.exit(0);
}

// ── 1. Start a local HTTP server serving public/data/ ──────────────────────
const server = createServer(async (req, res) => {
  const filename = decodeURIComponent((req.url ?? '/').replace(/^\//, ''));
  try {
    const data = await readFile(resolve(DATA_DIR, filename));
    const ext = extname(filename);
    const ct = ext === '.json' ? 'application/json' : 'text/csv; charset=utf-8';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});
await new Promise<void>((resolve) => server.listen(PORT, resolve));
process.env['NODE_HTTP_PORT'] = String(PORT);
console.log(`[build-features] Serving public/data/ on http://localhost:${PORT}/`);

try {
  // ── 2. Dynamic import AFTER setting NODE_HTTP_PORT ──────────────────────
  //    (data.ts reads NODE_HTTP_PORT at call-time, but importing after ensures
  //     any module-level side effects see the correct env)
  const [
    {
      fetchCombine, fetchDraftPicks, fetchGames, fetchFfcADP, fetchPlayerStats,
      fetchSnapCounts, fetchInjuries, fetchNextGenStats, fetchPlayByPlay,
      fetchPbpParticipation, fetchRosters, fetchDepthCharts,
    },
    { buildFeatures },
  ] = await Promise.all([
    import('../src/data.js'),
    import('../src/lib/featureBuilder.js'),
  ]);

  const SEASONS = [2021, 2022, 2023, 2024, 2025];
  const PREDICT_SEASON = 2026;

  // ── 3. Load static data ────────────────────────────────────────────────
  console.log('[build-features] Loading combine, draft & games...');
  const [combineData, draftData, gamesData] = await Promise.all([
    fetchCombine(),
    fetchDraftPicks(),
    fetchGames(),
  ]);

  // ── 4. Load per-season data ────────────────────────────────────────────
  const seasonDataArr = [];
  for (const season of SEASONS) {
    console.log(`[build-features] Loading season ${season}...`);
    const [
      adpData, currentStats, priorStats, priorSnaps,
      priorInjuries, preseasonInjuries,
      priorNgsRec, priorNgsRush, priorNgsPass,
      priorPbp, priorParticipation,
      seasonRosters, priorRosters, seasonDepthCharts,
    ] = await Promise.all([
      fetchFfcADP(season, 'ppr', 12).catch(() => []),
      fetchPlayerStats(season).catch(() => []),
      fetchPlayerStats(season - 1).catch(() => []),
      fetchSnapCounts(season - 1).catch(() => []),
      fetchInjuries(season - 1).catch(() => []),
      fetchInjuries(season).catch(() => []),
      fetchNextGenStats(season - 1, 'receiving').catch(() => []),
      fetchNextGenStats(season - 1, 'rushing').catch(() => []),
      fetchNextGenStats(season - 1, 'passing').catch(() => []),
      fetchPlayByPlay(season - 1).catch(() => []),
      fetchPbpParticipation(season - 1).catch(() => []),
      fetchRosters(season).catch(() => []),
      fetchRosters(season - 1).catch(() => []),
      fetchDepthCharts(season).catch(() => []),
    ]);
    seasonDataArr.push({
      season, adpData, currentStats, priorStats, priorSnaps,
      priorInjuries, preseasonInjuries,
      priorNgsRec, priorNgsRush, priorNgsPass,
      priorPbp, priorParticipation,
      seasonRosters, priorRosters, seasonDepthCharts,
    });
  }

  // ── 5. Load prediction season data ─────────────────────────────────────
  console.log(`[build-features] Loading ${PREDICT_SEASON} prediction data...`);
  const priorSeason = PREDICT_SEASON - 1;
  const [
    predAdpData, predPriorStats, predPriorSnaps,
    predPriorInjuries, predPreseasonInjuries,
    predPriorNgsRec, predPriorNgsRush, predPriorNgsPass,
    predPriorPbp, predPriorParticipation,
    predSeasonRosters, predPriorRosters, predSeasonDepthCharts,
  ] = await Promise.all([
    fetchFfcADP(PREDICT_SEASON, 'ppr', 12).catch(() => []),
    fetchPlayerStats(priorSeason).catch(() => []),
    fetchSnapCounts(priorSeason).catch(() => []),
    fetchInjuries(priorSeason).catch(() => []),
    fetchInjuries(PREDICT_SEASON).catch(() => []),
    fetchNextGenStats(priorSeason, 'receiving').catch(() => []),
    fetchNextGenStats(priorSeason, 'rushing').catch(() => []),
    fetchNextGenStats(priorSeason, 'passing').catch(() => []),
    fetchPlayByPlay(priorSeason).catch(() => []),
    fetchPbpParticipation(priorSeason).catch(() => []),
    fetchRosters(PREDICT_SEASON).catch(() => []),
    fetchRosters(priorSeason).catch(() => []),
    fetchDepthCharts(PREDICT_SEASON).catch(() => []),
  ]);

  const predData = {
    predictSeason: PREDICT_SEASON,
    adpData: predAdpData,
    priorStats: predPriorStats,
    priorSnaps: predPriorSnaps,
    priorInjuries: predPriorInjuries,
    preseasonInjuries: predPreseasonInjuries,
    priorNgsRec: predPriorNgsRec,
    priorNgsRush: predPriorNgsRush,
    priorNgsPass: predPriorNgsPass,
    priorPbp: predPriorPbp,
    priorParticipation: predPriorParticipation,
    seasonRosters: predSeasonRosters,
    priorRosters: predPriorRosters,
    seasonDepthCharts: predSeasonDepthCharts,
  };

  // ── 6. Build features ──────────────────────────────────────────────────
  console.log('[build-features] Building feature rows...');
  const result = await buildFeatures(
    seasonDataArr,
    combineData,
    draftData,
    gamesData,
    predData,
    (msg) => console.log(`[build-features] ${msg}`),
  );

  // ── 7. Write output ────────────────────────────────────────────────────
  writeFileSync(OUT_FILE, JSON.stringify(result));
  console.log(`[build-features] Written ${OUT_FILE}`);
  console.log(`[build-features] ${result.allRows.length} historical rows, ${result.predictionRows.length} prediction rows`);

} finally {
  server.close();
  process.env['NODE_HTTP_PORT'] = '';
}
