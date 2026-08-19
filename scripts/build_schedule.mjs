#!/usr/bin/env node
// Build public/data/schedule-2026.json from nflverse (reachable from CI/build).
// Regular season only (nflverse has no preseason); TV network is layered in at
// runtime from ESPN in the browser. Re-run to refresh the committed schedule.
//
//   node scripts/build_schedule.mjs [season]
import fs from 'fs';
import path from 'path';

const SEASON = Number(process.argv[2] || 2026);
const URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const OUT = path.join('public', 'data', `schedule-${SEASON}.json`);

function parseCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// gameday (YYYY-MM-DD) + gametime (HH:MM, ET) → ISO with an ET offset heuristic
// (EDT -04:00 Sep/Oct, EST -05:00 Nov–Feb). Good enough for display.
function toIso(gameday, gametime) {
  if (!gameday) return '';
  const month = Number(gameday.slice(5, 7));
  const off = month >= 11 || month <= 2 ? '-05:00' : '-04:00';
  const time = /^\d{1,2}:\d{2}$/.test(gametime || '') ? gametime.padStart(5, '0') : '00:00';
  return `${gameday}T${time}:00${off}`;
}

const csv = await (await fetch(URL)).text();
const lines = csv.split(/\r?\n/).filter(Boolean);
const header = parseCsvLine(lines[0]);
const ix = (name) => header.indexOf(name);
const [iSeason, iType, iWeek, iDay, iTime, iAway, iHome, iLoc, iStadium] =
  ['season', 'game_type', 'week', 'gameday', 'gametime', 'away_team', 'home_team', 'location', 'stadium'].map(ix);

const games = [];
for (let i = 1; i < lines.length; i++) {
  const r = parseCsvLine(lines[i]);
  if (Number(r[iSeason]) !== SEASON || r[iType] !== 'REG') continue;
  games.push({
    week: Number(r[iWeek]),
    date: toIso(r[iDay], r[iTime]),
    away: r[iAway],
    home: r[iHome],
    venue: r[iStadium] || '',
    neutral: (r[iLoc] || '').toLowerCase() === 'neutral',
  });
}
// Merge committed TV networks (parsed from the NFL division-schedule PDF), keyed
// by week + the sorted team pair. nflverse has no network column.
const netPath = path.join('public', 'data', `schedule-networks-${SEASON}.json`);
let networks = {};
try { networks = JSON.parse(fs.readFileSync(netPath, 'utf8')); } catch { /* optional */ }
for (const g of games) {
  const [a, b] = [g.away, g.home].sort();
  g.network = networks[`${g.week}|${a}|${b}`] || '';
}

games.sort((a, b) => a.week - b.week || a.home.localeCompare(b.home));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
// Keep the previous `updated` stamp when nothing about the games changed, so
// re-running this on a schedule produces an identical file rather than a commit
// whose only content is a new timestamp. Flex scheduling moves dates and
// networks in-season, and those are real changes worth a diff.
let updated = new Date().toISOString();
let unchanged = false;
if (fs.existsSync(OUT)) {
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (JSON.stringify(prev.games) === JSON.stringify(games)) {
      updated = prev.updated || updated;
      unchanged = true;
    }
  } catch {
    // Unreadable previous file — just write a fresh one.
  }
}
fs.writeFileSync(OUT, JSON.stringify({ season: SEASON, source: 'nflverse', updated, games }, null, 0));
console.log(`Wrote ${OUT}: ${games.length} regular-season games for ${SEASON}${unchanged ? ' (unchanged since ' + updated + ')' : ''}`);
