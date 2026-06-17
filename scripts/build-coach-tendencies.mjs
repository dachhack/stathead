#!/usr/bin/env node
/**
 * Build coach-tendencies.json — per-head-coach scheme + usage tendencies, so the
 * MCP can answer "what does this coach do" and "how was this player used under
 * this coach" without anyone hand-reconstructing it from team/player stats (the
 * exact gap the feedback report hit with Vrabel/Brown).
 *
 *   node scripts/build-coach-tendencies.mjs
 *
 * Sources (all already committed / cheap):
 *   - team-metrics-<season>.json  → team scheme tendencies (neutral pass rate,
 *     pace, shotgun, RZ TD rate, PPG). Built by build-metrics-artifacts.mjs;
 *     this script covers whatever seasons have an artifact.
 *   - nflverse games            → head coach per (season, team).
 *   - nflverse player stats     → per-team target HHI / WR1 share / RB-TE target
 *     share, and each skill player's usage under that coach (the reunion signal).
 *
 * "Head coach" is nflverse's credited game coach (HC) — a play-caller proxy.
 * Output is small (~few hundred KB) and served by the get_coach_tendencies tool.
 * Model integration (feeding these into the trained share model) is a separate,
 * retrain-dependent step.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetchPlayerStats, aggregateToSeasonTotals } from '../mcp/dist/server.mjs';

// Quote-aware CSV → objects (small files only). Used for the games schedule so
// we get the UPCOMING season's coach assignments too (the bundle's cached
// fetchGames stops at the last completed season).
function parseCsv(text) {
  const rows = [];
  let field = '', rec = [], inQ = false, pend = false;
  const endF = () => { rec.push(field); field = ''; };
  const endR = () => { endF(); rows.push(rec); rec = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (pend) { pend = false; if (c === '"') { field += '"'; continue; } inQ = false; }
      else if (c === '"') { pend = true; continue; }
      else { field += c; continue; }
    }
    if (c === '"') inQ = true; else if (c === ',') endF(); else if (c === '\n') endR(); else if (c === '\r') { /* skip */ } else field += c;
  }
  if (field.length || rec.length) endR();
  const header = rows.shift() || [];
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}
async function fetchGamesDirect() {
  const url = 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`games.csv ${res.status}`);
  return parseCsv(await res.text());
}

const DATA = path.resolve(import.meta.dirname, '..', 'public/data');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const round = (v, d = 3) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const push = (m, k, v) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };

async function run() {
  const seasons = fs.readdirSync(DATA)
    .map((f) => f.match(/^team-metrics-(\d{4})\.json$/)).filter(Boolean)
    .map((m) => Number(m[1])).sort((a, b) => a - b);
  if (!seasons.length) { console.error('No team-metrics-<season>.json artifacts found — run build-metrics-artifacts first.'); process.exit(1); }

  const games = await fetchGamesDirect();
  const coachByTeamSeason = new Map();
  for (const g of games) {
    if (g.home_coach && g.home_team) coachByTeamSeason.set(`${g.season}:${g.home_team}`, g.home_coach);
    if (g.away_coach && g.away_team) coachByTeamSeason.set(`${g.season}:${g.away_team}`, g.away_coach);
  }

  const coachRecords = new Map();      // coach -> [season record]
  const reunionsByPlayer = new Map();  // normPlayer -> [{coach, season, team, ...}]

  for (const season of seasons) {
    const teamMetrics = JSON.parse(fs.readFileSync(path.join(DATA, `team-metrics-${season}.json`), 'utf8'));
    let totals = [];
    try {
      const weekly = await fetchPlayerStats(season);
      totals = aggregateToSeasonTotals(weekly.filter((s) => s.season_type === 'REG'));
    } catch (e) { console.warn(`  [warn] player stats ${season}: ${e.message}`); }

    // Per-team skill-player usage.
    const byTeam = new Map();
    for (const p of totals) {
      if (!['QB', 'RB', 'WR', 'TE'].includes(p.position) || !p.recent_team) continue;
      push(byTeam, p.recent_team, p);
    }
    const teamUsage = new Map();
    for (const [team, players] of byTeam) {
      const teamTargets = players.reduce((a, p) => a + (p.targets || 0), 0) || 1;
      const shares = players.map((p) => ({ p, share: (p.targets || 0) / teamTargets }));
      teamUsage.set(team, {
        targetHHI: shares.reduce((a, s) => a + s.share * s.share, 0),
        wr: shares.filter((s) => s.p.position === 'WR').sort((a, b) => b.share - a.share),
        rbShare: shares.filter((s) => s.p.position === 'RB').reduce((a, s) => a + s.share, 0),
        teShare: shares.filter((s) => s.p.position === 'TE').reduce((a, s) => a + s.share, 0),
        shares,
      });
    }

    for (const tm of teamMetrics) {
      const coach = coachByTeamSeason.get(`${season}:${tm.team}`);
      if (!coach) continue;
      const u = teamUsage.get(tm.team);
      push(coachRecords, coach, {
        season, team: tm.team,
        neutralPassRate: round(tm.neutral_pass_rate, 1), passRate: round(tm.pass_rate, 1),
        playsPerGame: round(tm.plays_per_game, 1), shotgunRate: round(tm.shotgun_rate, 1),
        noHuddleRate: round(tm.no_huddle_rate, 1), rzTdRate: round(tm.rz_td_rate, 1), ppg: round(tm.ppg, 1),
        targetHHI: u ? round(u.targetHHI) : null,
        wr1TargetShare: u?.wr[0] ? round(u.wr[0].share * 100, 1) : null,
        wr1: u?.wr[0]?.p.player_display_name ?? null,
        rbTargetShare: u ? round(u.rbShare * 100, 1) : null,
        teTargetShare: u ? round(u.teShare * 100, 1) : null,
      });
      if (u) for (const s of u.shares) {
        if ((s.p.games || 0) < 1) continue;
        push(reunionsByPlayer, norm(s.p.player_display_name), {
          coach, season, team: tm.team, name: s.p.player_display_name, position: s.p.position,
          targetShare: round(s.share * 100, 1), ppg: s.p.games ? round(s.p.fantasy_points_ppr / s.p.games, 1) : null, games: s.p.games || 0,
        });
      }
    }
  }

  const KEYS = ['neutralPassRate', 'passRate', 'playsPerGame', 'shotgunRate', 'noHuddleRate', 'rzTdRate', 'ppg', 'targetHHI', 'wr1TargetShare', 'rbTargetShare', 'teTargetShare'];
  const meanOf = (recs, k) => { const v = recs.map((r) => r[k]).filter((x) => typeof x === 'number'); return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length, 3) : null; };
  const agg = (recs) => Object.fromEntries(KEYS.map((k) => [k, meanOf(recs, k)]));
  const coaches = {};
  for (const [coach, recs] of coachRecords) {
    recs.sort((a, b) => a.season - b.season);
    coaches[coach] = {
      seasonsCount: recs.length, teams: [...new Set(recs.map((r) => r.team))],
      seasonRange: [recs[0].season, recs[recs.length - 1].season],
      career: agg(recs), recent: agg(recs.slice(-3)), seasons: recs,
    };
  }

  const out = {
    generatedAt: new Date().toISOString(), seasons,
    note: 'Per-head-coach scheme + usage tendencies from team-metrics artifacts + nflverse game coaches + player target shares. Head coach = nflverse credited game coach (a play-caller proxy). Career = mean over all covered seasons; recent = last 3.',
    byTeamSeason: Object.fromEntries(coachByTeamSeason),
    coaches,
    reunionsByPlayer: Object.fromEntries(reunionsByPlayer),
  };
  const outPath = path.join(DATA, 'coach-tendencies.json');
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`Wrote coach-tendencies.json — ${Object.keys(coaches).length} coaches, ${seasons[0]}-${seasons[seasons.length - 1]}, ${Object.keys(out.reunionsByPlayer).length} players (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
}
run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
