#!/usr/bin/env node
/**
 * Regenerate ONLY the slim play-by-play artifacts the MCP serves for
 * get_play_by_play.
 *
 *   node scripts/build-pbp-slim.mjs <season> [season ...]
 *
 * Why a dedicated script (vs. build-metrics-artifacts.mjs): the slim PBP
 * projection (PBP_SLIM_COLS) changes more often than the metric math — e.g.
 * adding the stable passer/rusher/receiver_player_id columns — and we don't
 * want to perturb the deterministic team-/player-metrics artifacts on a
 * PBP-only column change. This pulls the ~99MB nflverse CSV per season,
 * projects PBP_SLIM_COLS, and writes public/data/pbp-slim-<season>.json.gz.
 *
 * The projection is shared with the live handler via fetchPbpSlim exported
 * from the canonical bundle (mcp/dist/server.mjs), so artifact and live path
 * can never drift.
 */
import { writeFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fetchPbpSlim } from '../mcp/dist/server.mjs';

const DATA = path.resolve(import.meta.dirname, '..', 'public/data');

async function run() {
  const seasons = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 1998);
  if (!seasons.length) {
    console.error('usage: node scripts/build-pbp-slim.mjs <season> [season ...]');
    process.exit(1);
  }
  const kb = (p) => { try { return (statSync(p).size / 1024).toFixed(0) + ' KB'; } catch { return '?'; } };
  for (const season of seasons) {
    console.log(`Building pbp-slim for ${season} …`);
    const pbpSlim = await fetchPbpSlim(season);
    const pbpPath = path.join(DATA, `pbp-slim-${season}.json.gz`);
    writeFileSync(pbpPath, gzipSync(Buffer.from(JSON.stringify(pbpSlim))));
    console.log(`  pbpSlim=${pbpSlim.length} plays (${kb(pbpPath)} gz)`);
  }
}

run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
