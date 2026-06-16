/**
 * Headless builder for the season projection base pool. Runs the EXACT same
 * pure function the Projections tab uses (src/lib/buildProjectionPool.ts), so
 * the committed pool is byte-identical to the site's. Run with tsx:
 *
 *   npx tsx scripts/build-projection-pool.ts
 *
 * Output: public/data/projection-base-<season>.json
 *   { season, generatedAt, qbs, rbs, wrs, tes, meta: [ {key, isRookie, yearsExp, age, priorGames} ] }
 *
 * This is the shape scripts/precompute-projection-presets.ts consumes to run
 * the scenario-engine presets over the site's exact pool (zero numeric drift).
 *
 * Data loading mirrors the component's fetch phase:
 *  - nflverse-style feeds (player stats, rosters, draft picks, games, FFC ADP,
 *    odds) come from src/data.ts fetchers, which read public/data/ locally in
 *    Node and otherwise fetch the committed GitHub-raw snapshots.
 *  - committed local JSON (score-store shards, redraft, depth-order,
 *    feature-matrix, consensus, team-projections) is read directly with fs.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  fetchFfcADP, fetchPlayerStats,
  fetchDraftPicks, fetchRosters, fetchGames,
  fetchOddsGameLines,
} from '../src/data';
import type { DraftPick, FfcADPPlayer, Roster, Game } from '../src/types';
import { buildProjectionPool, type FeatureMatrixDoc, type ConsensusDoc } from '../src/lib/buildProjectionPool';
import { PREDICT_SEASON } from '../src/lib/projectionPoolConsts';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'public/data');
const GEN = path.join(ROOT, 'src/generated');

function loadJson<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function main() {
  const season = PREDICT_SEASON;

  // nflverse-style feeds via the shared data.ts fetchers (same calls/fallbacks
  // as the component). These run in Node — they read public/data locally and
  // fall back to GitHub-raw snapshots.
  const [adpData, priorStats, draftData, rosters, gamesData, oddsLines] = await Promise.all([
    fetchFfcADP(PREDICT_SEASON, 'ppr', 12).catch(() => [] as FfcADPPlayer[]),
    fetchPlayerStats(PREDICT_SEASON - 1).catch(() => []),
    fetchDraftPicks().catch(() => [] as DraftPick[]),
    fetchRosters(PREDICT_SEASON).catch(() => [] as Roster[]),
    fetchGames().catch(() => [] as Game[]),
    fetchOddsGameLines().catch(() => []),
  ]);

  // Committed local JSON read straight from disk (same files the component
  // fetch()es from /data/).
  const shareScoresData = loadJson(path.join(DATA, 'score-store/shares.json'), [] as Array<{ name: string; predTargetShare: number; predRushShare: number }>);
  const ppgScoresData = loadJson(path.join(DATA, 'score-store/ppg.json'), [] as Array<{ name: string; predictedPPG: number }>);
  const adpScoresData = loadJson(path.join(DATA, 'score-store/adp.json'), [] as Array<{ name: string; adp: number; predictedVor: number; ciLower: number; ciUpper: number }>);
  const redraftData = loadJson(path.join(DATA, 'redraft-projections.json'), { players: [] } as { players?: Array<{ name: string; position: string; ppg: number }> });
  const depthOrderData = loadJson(path.join(DATA, 'depth-order-2026.json'), { players: [] } as { players?: Array<{ name: string; team: string; pos: string; teamRank: number }> });
  const featureMatrix = loadJson<FeatureMatrixDoc | null>(path.join(DATA, 'feature-matrix.json'), null);
  const consensusDoc = loadJson<ConsensusDoc | null>(path.join(DATA, `clay-projections-${PREDICT_SEASON}.json`), null);
  const teamProjectionsEnsemble = loadJson(path.join(GEN, 'team-projections.json'), { season: 0, teams: {} } as { season: number; teams: Record<string, Record<string, number>> });

  const pool = buildProjectionPool({
    adpData, priorStats, draftData, rosters, gamesData, oddsLines,
    shareScoresData, ppgScoresData, adpScoresData, redraftData, depthOrderData,
    featureMatrix, consensusDoc, teamProjectionsEnsemble, season,
  });

  if (pool.error) {
    console.error(`buildProjectionPool error: ${pool.error}`);
    process.exit(1);
  }

  // Serialize the PresetMeta map as the array shape precompute-projection-presets
  // consumes.
  const meta = [...pool.meta.entries()].map(([key, m]) => ({
    key, isRookie: m.isRookie, yearsExp: m.yearsExp, age: m.age, priorGames: m.priorGames,
  }));

  const out = {
    season,
    generatedAt: new Date().toISOString(),
    qbs: pool.qbs, rbs: pool.rbs, wrs: pool.wrs, tes: pool.tes,
    meta,
  };

  const outPath = path.join(DATA, `projection-base-${season}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out) + '\n');

  const sample = (arr: { name: string; pprPts: number }[]) =>
    arr.slice(0, 3).map((p) => `${p.name} (${p.pprPts})`).join(', ');
  console.log(`Wrote ${outPath}`);
  console.log(`  QB: ${pool.qbs.length}  RB: ${pool.rbs.length}  WR: ${pool.wrs.length}  TE: ${pool.tes.length}  meta: ${meta.length}`);
  console.log(`  sample QB: ${sample(pool.qbs)}`);
  console.log(`  sample RB: ${sample(pool.rbs)}`);
  console.log(`  sample WR: ${sample(pool.wrs)}`);
  console.log(`  sample TE: ${sample(pool.tes)}`);
}

main();
