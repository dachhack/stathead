#!/usr/bin/env node
/**
 * Precompute the metrics artifacts that the MCP serves for get_team_metrics,
 * get_player_metrics, and get_play_by_play.
 *
 *   node scripts/build-metrics-artifacts.mjs <season> [season ...]
 *
 * Why: the full-season nflverse play-by-play CSV is ~99 MB. Fetching + parsing
 * it inside a request blows the hosted Cloudflare Worker's limits (the three
 * tools above failed 100% there). These computations are heavy but bounded, so
 * we run them offline (CI / a dev box, no memory cap) and commit small JSON the
 * Worker can serve instantly. The handlers fall back to live compute when an
 * artifact is missing (the npm/stdio build, which has no such limits).
 *
 * Writes to public/data/:
 *   team-metrics-<season>.json        (32 teams; small)
 *   player-metrics-<season>.json      (all scored skill players; ~few hundred KB)
 *   pbp-slim-<season>.json.gz         (every play, ~20 columns; gzipped)
 *
 * The compute itself is shared with the live handlers via buildMetricsArtifacts
 * exported from the canonical bundle (mcp/dist/server.mjs), so the artifact and
 * the live path can never drift.
 */
import { writeFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { buildMetricsArtifacts, computeTeamMetricsForSeason } from '../mcp/dist/server.mjs';

const DATA = path.resolve(import.meta.dirname, '..', 'public/data');

async function run() {
  const seasons = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 1998);
  if (!seasons.length) {
    console.error('usage: node scripts/build-metrics-artifacts.mjs <season> [season ...]');
    process.exit(1);
  }
  // METRICS_KINDS=team builds only team-metrics (PBP-only; robust back to 1999) —
  // used to backfill the seasons coach-tendencies needs without the heavier,
  // older-season-fragile player-metrics / pbp-slim artifacts.
  const teamOnly = (process.env.METRICS_KINDS || '').toLowerCase() === 'team';
  const kb = (p) => { try { return (statSync(p).size / 1024).toFixed(0) + ' KB'; } catch { return '?'; } };
  for (const season of seasons) {
    if (teamOnly) {
      console.log(`Building team-metrics for ${season} …`);
      const team = await computeTeamMetricsForSeason(season);
      const teamPath = path.join(DATA, `team-metrics-${season}.json`);
      writeFileSync(teamPath, JSON.stringify(team));
      console.log(`  team=${team.length} (${kb(teamPath)})`);
      continue;
    }
    console.log(`Building metrics artifacts for ${season} …`);
    const { team, players, pbpSlim } = await buildMetricsArtifacts(season);
    const teamPath = path.join(DATA, `team-metrics-${season}.json`);
    const playerPath = path.join(DATA, `player-metrics-${season}.json`);
    const pbpPath = path.join(DATA, `pbp-slim-${season}.json.gz`);
    writeFileSync(teamPath, JSON.stringify(team));
    writeFileSync(playerPath, JSON.stringify(players));
    writeFileSync(pbpPath, gzipSync(Buffer.from(JSON.stringify(pbpSlim))));
    console.log(`  team=${team.length} (${kb(teamPath)})  players=${players.length} (${kb(playerPath)})  pbpSlim=${pbpSlim.length} plays (${kb(pbpPath)} gz)`);
  }
}

run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
