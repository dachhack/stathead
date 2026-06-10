#!/usr/bin/env node
/**
 * Distill depth_charts_<season>.csv.gz into a tiny JSON of offensive
 * depth-chart starters (pos_rank === 1 in the latest snapshot) for the
 * Taxi Squad Advisor's "projected #1 on his NFL depth chart" flag.
 *
 * Usage: node scripts/build-depth-starters.mjs [season]   (default 2026)
 * Output: public/data/depth-starters-<season>.json
 *   [{ name, team, pos, slot }]  — slot is the depth-chart slot label
 *   (QB/RB/TE single slots; WRs appear once per starting WR slot).
 */
import { readFileSync, writeFileSync } from 'fs';
import { gunzipSync } from 'zlib';

const season = process.argv[2] || '2026';
const src = `public/data/depth_charts_${season}.csv.gz`;
const out = `public/data/depth-starters-${season}.json`;

const csv = gunzipSync(readFileSync(src)).toString('utf-8');
const lines = csv.split('\n');
const header = lines[0].split(',');
const col = (name) => header.indexOf(name);
const iDt = col('dt'); const iTeam = col('team'); const iName = col('player_name');
const iGrp = col('pos_grp'); const iAbb = col('pos_abb'); const iRank = col('pos_rank');
if ([iDt, iTeam, iName, iGrp, iAbb, iRank].some((i) => i < 0)) {
  console.error('unexpected depth chart schema:', header.join(','));
  process.exit(1);
}

// Minimal CSV field splitter (handles quoted fields; depth chart values
// are simple but player names can contain commas in theory).
function fields(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// Latest snapshot date only — the file accumulates daily snapshots.
let latest = '';
for (let i = 1; i < lines.length; i++) {
  const dt = lines[i].slice(0, lines[i].indexOf(','));
  if (dt > latest) latest = dt;
}

const POS = new Set(['QB', 'RB', 'WR', 'TE']);
const starters = [];
const seen = new Set();
for (let i = 1; i < lines.length; i++) {
  if (!lines[i].startsWith(latest)) continue;
  const f = fields(lines[i]);
  // Offensive groups are formation labels ('3WR 1TE'); defensive and ST
  // slots never use the plain QB/RB/WR/TE abbreviations, so the slot
  // abbreviation IS the offense filter.
  const pos = f[iAbb];
  if (!POS.has(pos) || Number(f[iRank]) !== 1) continue;
  const key = `${f[iTeam]}::${pos}::${f[iName]}`;
  if (seen.has(key)) continue; // formations can repeat a player
  seen.add(key);
  starters.push({ name: f[iName], team: f[iTeam], pos });
}

writeFileSync(out, JSON.stringify({ snapshot: latest, starters }, null, 0) + '\n');
console.log(`${out}: ${starters.length} offensive starters from snapshot ${latest}`);
