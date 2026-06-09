#!/usr/bin/env node
// Fetches every current NFL team roster from ESPN and writes a name -> ESPN
// athlete-id index: public/data/espn-nfl-ids.json.
//
// Why: nflverse rosters only carry an espn_id for ~42% of players and none for
// pre-draft rookies, and Sleeper's espn_id field misses many newcomers too. But
// ESPN's own team-roster endpoint lists every current player (rookies included)
// with their athlete id. build-player-crosswalk.py reads this file to backfill
// espn_id, which is what powers the Recent News + headshot on player-detail
// pages. Only site.api.espn.com is reachable from the dev sandbox (search /
// core-api hosts 403), and the per-team roster endpoint lives there.
//
//   node scripts/fetch-espn-nfl-ids.mjs [outDir]
import fs from 'fs';
import path from 'path';

const OUT_DIR = process.argv[2] || 'public/data';
const OUT = path.join(OUT_DIR, 'espn-nfl-ids.json');
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';

const TEAMS = [
  'ari', 'atl', 'bal', 'buf', 'car', 'chi', 'cin', 'cle', 'dal', 'den',
  'det', 'gb', 'hou', 'ind', 'jax', 'kc', 'lv', 'lac', 'lar', 'mia',
  'min', 'ne', 'no', 'nyg', 'nyj', 'phi', 'pit', 'sf', 'sea', 'tb',
  'ten', 'wsh',
];

// ESPN team abbreviations -> the codes used elsewhere in this repo.
const ESPN_TO_OURS = { LAR: 'LA', WSH: 'WAS' };
const fixTeam = (a) => ESPN_TO_OURS[a?.toUpperCase()] ?? a?.toUpperCase() ?? '';

async function fetchJson(url) {
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// The roster payload nests athletes under position groups (offense/defense/...);
// each group has an `items` array. Flatten to leaf athletes.
function* walkAthletes(athletes) {
  for (const node of athletes || []) {
    if (Array.isArray(node.items)) yield* walkAthletes(node.items);
    else yield node;
  }
}

async function main() {
  const players = [];
  let teamsOk = 0;
  for (const abbr of TEAMS) {
    try {
      const data = await fetchJson(`${BASE}/teams/${abbr}/roster`);
      const teamCode = fixTeam(data?.team?.abbreviation || abbr);
      let n = 0;
      for (const a of walkAthletes(data?.athletes)) {
        const id = a?.id;
        const name = a?.displayName || a?.fullName;
        const pos = a?.position?.abbreviation || '';
        if (!id || !name) continue;
        players.push({ name, position: pos, team: teamCode, espn_id: String(id) });
        n++;
      }
      teamsOk++;
      console.log(`  ${abbr}: ${n} athletes`);
    } catch (err) {
      console.warn(`  WARN ${abbr}: ${err.message} — skipping`);
    }
  }

  if (teamsOk === 0) {
    console.error('No ESPN rosters fetched — leaving existing file untouched.');
    process.exit(1);
  }

  // No volatile timestamp: the file is committed and regenerated every refresh,
  // so a wall-clock field would churn a 234KB diff every run even when rosters
  // are unchanged. Keeping it deterministic lets the commit guard skip no-ops.
  const doc = {
    _about:
      'Name -> ESPN NFL athlete id index, scraped from ESPN team rosters. '
      + 'Source for build-player-crosswalk.py espn_id backfill. Regenerate with '
      + 'scripts/fetch-espn-nfl-ids.mjs.',
    teams: teamsOk,
    count: players.length,
    players,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc));
  console.log(`Wrote ${OUT} — ${players.length} athletes across ${teamsOk}/${TEAMS.length} teams`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
