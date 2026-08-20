#!/usr/bin/env node
// Build public/data/odds_nfl_lines.json from nflverse's schedule file.
//
// Why this exists: the projection pool takes an `oddsLines` input and uses the
// implied team totals to shape team-level volume, but nothing ever populated
// it. fetchOddsGameLines() falls back to The Odds API, which needs a paid key
// that isn't configured, so every build has run on `oddsSource: historical`
// with market expectations absent entirely.
//
// nflverse's games.csv already carries spread_line and total_line for every
// game a book has posted — 112 of 272 for 2026 as of late August, growing week
// by week — and download-data.sh force-refreshes that file on every run. So the
// market data was already on disk; it just had no path into the model.
//
// SIGN CONVENTION, verified rather than assumed: nflverse's spread_line is
// positive when the HOME team is favoured (checked against 272 completed 2025
// games — the home margin agrees with the sign 65% of the time, which is what
// favourites covering at a normal rate looks like). The OddsGameLine interface
// in src/data.ts uses the opposite convention (negative = home favoured), so
// the sign is flipped on the way through.
//
//   node scripts/build-odds-from-schedule.mjs [season]
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const SEASON = String(process.argv[2] || 2026);
const DATA = path.join('public', 'data');
const OUT = path.join(DATA, 'odds_nfl_lines.json');

function readGames() {
  const plain = path.join(DATA, 'games.csv');
  if (fs.existsSync(plain)) return fs.readFileSync(plain, 'utf8');
  const gz = path.join(DATA, 'games.csv.gz');
  if (fs.existsSync(gz)) return zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8');
  return null;
}

// Quote-aware: the schedule carries quoted fields (stadium and referee names
// contain commas), and a naive split shifts every column after them. The first
// cut of this script did exactly that and produced 272 "games with a line"
// where only 112 have one, plus implied totals of 13 points a game.
function parseCsvLine(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const [head, ...lines] = text.trim().split('\n');
  const cols = parseCsvLine(head);
  return lines.map((line) => {
    const vals = parseCsvLine(line);
    const row = {};
    cols.forEach((c, i) => { row[c] = vals[i]; });
    return row;
  });
}

const text = readGames();
if (!text) {
  console.log('  WARNING: no games.csv — skipping odds build (keeping any existing snapshot)');
  process.exit(0);
}

// Number('') is 0, not NaN — so an empty spread_line parsed as a pick'em with a
// total of zero, which is how the first run reported all 272 games as having a
// market line and implied totals of 13 points a game.
const num = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const lines = [];
for (const g of parseCsv(text)) {
  if (g.season !== SEASON || g.game_type !== 'REG') continue;
  const spreadLine = num(g.spread_line);
  const totalLine = num(g.total_line);
  if (spreadLine === null || totalLine === null) continue;   // no book has posted it yet
  // Flip to the interface's convention: negative = home favoured.
  const spread = -spreadLine;
  lines.push({
    gameId: g.game_id,
    homeTeam: g.home_team,
    awayTeam: g.away_team,
    commenceTime: g.gameday ? `${g.gameday}T${(g.gametime || '00:00')}:00Z` : '',
    spread,
    totalLine,
    homeImplied: Math.round(((totalLine - spread) / 2) * 100) / 100,
    awayImplied: Math.round(((totalLine + spread) / 2) * 100) / 100,
    bookmaker: 'nflverse-schedule',
  });
}

if (!lines.length) {
  console.log(`  No ${SEASON} games carry a spread/total yet — leaving any existing snapshot alone.`);
  process.exit(0);
}

fs.writeFileSync(OUT, JSON.stringify(lines));
const weeks = new Set(parseCsv(text).filter((g) => g.season === SEASON && g.spread_line).map((g) => g.week));
const teams = new Map();
for (const l of lines) {
  teams.set(l.homeTeam, (teams.get(l.homeTeam) || 0) + 1);
  teams.set(l.awayTeam, (teams.get(l.awayTeam) || 0) + 1);
}
const implied = [...teams.keys()].map((t) => {
  const own = lines.flatMap((l) => (l.homeTeam === t ? [l.homeImplied] : l.awayTeam === t ? [l.awayImplied] : []));
  return [t, own.reduce((a, b) => a + b, 0) / own.length];
}).sort((a, b) => b[1] - a[1]);
console.log(`  Wrote ${OUT} — ${lines.length} ${SEASON} games with a market line `
  + `(weeks ${[...weeks].sort((a, b) => a - b).join(',')}), ${teams.size} teams`);
console.log(`  implied points/game: best ${implied[0][0]} ${implied[0][1].toFixed(1)}, `
  + `worst ${implied[implied.length - 1][0]} ${implied[implied.length - 1][1].toFixed(1)}`);
