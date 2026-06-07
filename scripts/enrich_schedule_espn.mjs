#!/usr/bin/env node
// Reproducible, server-side mirror of overlayEspn() in src/lib/nflSchedule.ts.
// Overlays ESPN's public scoreboard onto the committed schedule files:
//   • fills *missing* TV networks on regular-season games
//     (public/data/schedule-networks-<season>.json), then regenerates
//     public/data/schedule-<season>.json via build_schedule.mjs;
//   • fills network + venue on preseason games
//     (public/data/schedule-preseason-<season>.json).
//
// The regular-season gaps are weeks 16-18 flex games that ESPN itself still
// lists as TBD; re-run this once ESPN finalizes them and they'll fill in.
// Requires site.api.espn.com to be reachable.
//
//   node scripts/enrich_schedule_espn.mjs [season]
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const SEASON = Number(process.argv[2] || 2026);
const SB = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

// ESPN uses a couple of abbreviations that differ from our team codes.
const ESPN_TO_OURS = { LAR: 'LA', WSH: 'WAS' };
const fixTeam = (a) => ESPN_TO_OURS[a] ?? a;

function networkOf(comp) {
  const fromB = (comp.broadcasts ?? []).flatMap((b) => b.names ?? []);
  if (fromB.length) return [...new Set(fromB)].join('/');
  const fromGeo = (comp.geoBroadcasts ?? []).map((g) => g.media?.shortName).filter(Boolean);
  return [...new Set(fromGeo)].join('/');
}

async function fetchWeek(seasonType, week) {
  const url = `${SB}?seasontype=${seasonType}&week=${week}&dates=${SEASON}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ESPN ${seasonType}/${week} -> HTTP ${r.status} (is site.api.espn.com on the allowlist?)`);
  const d = await r.json();
  return d.events ?? [];
}

function infoOf(ev) {
  const comp = ev.competitions?.[0];
  if (!comp) return null;
  const ht = comp.competitors?.find((c) => c.homeAway === 'home')?.team?.abbreviation;
  const at = comp.competitors?.find((c) => c.homeAway === 'away')?.team?.abbreviation;
  if (!ht || !at) return null;
  return {
    week: ev.week?.number ?? 0,
    home: fixTeam(ht),
    away: fixTeam(at),
    network: networkOf(comp),
    venue: comp.venue?.fullName ?? '',
  };
}

// ── Regular season: fill *missing* TV networks (never overwrite committed) ──
async function enrichRegular() {
  const netPath = path.join('public', 'data', `schedule-networks-${SEASON}.json`);
  const networks = JSON.parse(fs.readFileSync(netPath, 'utf8'));
  let filled = 0;
  let stillTbd = 0;
  for (let w = 1; w <= 18; w++) {
    for (const ev of await fetchWeek(2, w)) {
      const g = infoOf(ev);
      if (!g) continue;
      const [a, b] = [g.away, g.home].sort();
      const key = `${g.week}|${a}|${b}`;
      if (networks[key]) continue; // keep the committed (PDF-sourced) value
      if (g.network) { networks[key] = g.network; filled++; }
      else stillTbd++;
    }
  }
  if (filled > 0) {
    // Match the Python json.dumps() formatting of the existing file ("k": v, ...).
    const body = Object.entries(networks).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ');
    fs.writeFileSync(netPath, `{${body}}`);
    spawnSync('node', ['scripts/build_schedule.mjs', String(SEASON)], { stdio: 'inherit' });
  }
  console.log(`Regular season: filled ${filled} missing network(s); ${stillTbd} still TBD on ESPN.`);
}

// ── Preseason: fill network + venue, matching committed games by week + pair ──
async function enrichPreseason() {
  const prePath = path.join('public', 'data', `schedule-preseason-${SEASON}.json`);
  const pre = JSON.parse(fs.readFileSync(prePath, 'utf8'));
  const byKey = new Map(pre.games.map((g) => [`${g.week}|${[g.away, g.home].sort().join('|')}`, g]));
  let netFilled = 0;
  let venFilled = 0;
  for (let w = 1; w <= 4; w++) {
    for (const ev of await fetchWeek(1, w)) {
      const g = infoOf(ev);
      if (!g) continue;
      const target = byKey.get(`${g.week}|${[g.away, g.home].sort().join('|')}`);
      if (!target) continue;
      if (g.network && target.network !== g.network) { target.network = g.network; netFilled++; }
      if (g.venue && !target.venue) { target.venue = g.venue; venFilled++; }
    }
  }
  if (netFilled || venFilled) {
    pre.updated = new Date().toISOString();
    fs.writeFileSync(prePath, JSON.stringify(pre, null, 0));
  }
  console.log(`Preseason: filled ${venFilled} venue(s) and ${netFilled} network(s).`);
}

await enrichRegular();
await enrichPreseason();
