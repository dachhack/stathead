#!/usr/bin/env node
/**
 * Build a slim hosted player id-map: sleeper <-> gsis <-> espn (+ name/pos/team/
 * headshot) so apps can map ids at runtime without downloading Sleeper's full
 * ~5 MB player directory.
 *
 *   node scripts/build-id-map.mjs
 *
 * Source: the canonical player-crosswalk.json (all ids) merged with the latest
 * season rosters (current team/pos + a headshot_url and espn_id that are
 * populated even for fresh rookies the static crosswalk lags). Writes
 * public/data/player-id-map.json — fetch it directly from the hosted data base.
 *
 * Record (compact keys): { gsis, sleeper, espn, name, pos, team, headshot }
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fetchRosters } from '../mcp/dist/server.mjs';

const DATA = path.resolve(import.meta.dirname, '..', 'public/data');
const LATEST = 2025; // current/most-recent season for team/pos/headshot enrichment
const espnShot = (id) => `https://a.espncdn.com/i/headshots/nfl/players/full/${id}.png`;

async function run() {
  const cwRaw = JSON.parse(readFileSync(path.join(DATA, 'player-crosswalk.json'), 'utf8'));
  const players = Array.isArray(cwRaw.players) ? cwRaw.players : cwRaw;

  // Latest two seasons of rosters -> gsis map for current team/pos/headshot/espn.
  const rosterMap = new Map();
  for (const yr of [LATEST - 1, LATEST]) {
    const ros = await fetchRosters(yr).catch(() => []);
    for (const r of ros) if (r.gsis_id) rosterMap.set(r.gsis_id, r);
  }

  const out = [];
  for (const p of players) {
    const ros = rosterMap.get(p.gsis_id);
    const espn = p.espn_id || ros?.espn_id || null;
    const headshot = espn ? espnShot(espn) : ros?.headshot_url || null;
    out.push({
      gsis: p.gsis_id || null,
      sleeper: p.sleeper_id || ros?.sleeper_id || null,
      espn,
      name: p.display_name || ros?.full_name || null,
      pos: ros?.position || p.position || null,
      team: ros?.team || null,
      headshot,
    });
  }

  const fp = path.join(DATA, 'player-id-map.json');
  writeFileSync(fp, JSON.stringify({ generated_at: new Date().toISOString(), count: out.length, players: out }));
  const mb = (statSync(fp).size / 1048576).toFixed(2);
  const withSleeper = out.filter((r) => r.sleeper).length;
  const withEspn = out.filter((r) => r.espn).length;
  const withShot = out.filter((r) => r.headshot).length;
  console.log(`player-id-map.json: ${out.length} players (${mb} MB) — sleeper ${withSleeper}, espn ${withEspn}, headshot ${withShot}`);
}

run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
