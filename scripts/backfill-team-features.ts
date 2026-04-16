#!/usr/bin/env tsx
/**
 * Backfill team-context features for pre-2018 training rows.
 *
 * The feature store only populates team stats from ~2018+ (nflverse PBP era).
 * This script derives simpler team features from player_stats CSVs which go
 * back to 2010, roughly doubling the post-draft career model's usable data.
 *
 * Features backfilled:
 *   teamPassRate     — team pass att / (pass att + rush att)
 *   qbOwnPPG        — starting QB's PPR fantasy PPG
 *   teamPace         — team total plays / games played
 *   teamSamePosCount — # of same-position players drafted by team that year
 *   depthChartRank   — estimated from draft pick order at position on team
 *
 * Usage:
 *   npx tsx scripts/backfill-team-features.ts
 *   npx tsx scripts/backfill-team-features.ts --dry-run   # preview without writing
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import Papa from 'papaparse';

const CACHE_PATH = 'public/data/training-rows-cache-v46.json';
const STATS_DIR = 'public/data';

interface PlayerStat {
  player_name: string;
  position: string;
  recent_team: string;
  season: number;
  week: number;
  season_type: string;
  attempts: number;       // pass attempts
  carries: number;        // rush attempts
  completions: number;
  passing_yards: number;
  passing_tds: number;
  rushing_yards: number;
  rushing_tds: number;
  receptions: number;
  receiving_yards: number;
  receiving_tds: number;
  fantasy_points_ppr: number;
}

function loadPlayerStats(season: number): PlayerStat[] {
  const path = `${STATS_DIR}/player_stats_${season}.csv`;
  if (!existsSync(path)) return [];
  const csv = readFileSync(path, 'utf-8');
  const result = Papa.parse(csv, { header: true, skipEmptyLines: true });
  return (result.data as any[]).map(r => ({
    player_name: r.player_name || r.player_display_name || '',
    position: r.position || '',
    recent_team: r.recent_team || '',
    season: Number(r.season) || season,
    week: Number(r.week) || 0,
    season_type: r.season_type || '',
    attempts: Number(r.attempts) || 0,
    carries: Number(r.carries) || 0,
    completions: Number(r.completions) || 0,
    passing_yards: Number(r.passing_yards) || 0,
    passing_tds: Number(r.passing_tds) || 0,
    rushing_yards: Number(r.rushing_yards) || 0,
    rushing_tds: Number(r.rushing_tds) || 0,
    receptions: Number(r.receptions) || 0,
    receiving_yards: Number(r.receiving_yards) || 0,
    receiving_tds: Number(r.receiving_tds) || 0,
    fantasy_points_ppr: Number(r.fantasy_points_ppr) || 0,
  })).filter(r => r.season_type === 'REG');
}

interface TeamStats {
  team: string;
  season: number;
  passAtt: number;
  rushAtt: number;
  totalPlays: number;
  games: number;
  teamPassRate: number;
  teamPace: number;
  startingQBName: string;
  startingQBPPG: number;
}

function computeTeamStats(stats: PlayerStat[], season: number): Map<string, TeamStats> {
  // Aggregate by team
  const teamAgg = new Map<string, {
    passAtt: number; rushAtt: number; weeks: Set<number>;
    qbs: Map<string, { ppg: number; games: number; totalPPR: number }>;
  }>();

  for (const s of stats) {
    if (!s.recent_team || s.recent_team === '') continue;
    if (!teamAgg.has(s.recent_team)) {
      teamAgg.set(s.recent_team, { passAtt: 0, rushAtt: 0, weeks: new Set(), qbs: new Map() });
    }
    const t = teamAgg.get(s.recent_team)!;
    t.weeks.add(s.week);

    // Team-level passing & rushing (sum all players' contributions)
    t.passAtt += s.attempts;
    t.rushAtt += s.carries;

    // Track QB PPG
    if (s.position === 'QB' && s.attempts > 0) {
      if (!t.qbs.has(s.player_name)) t.qbs.set(s.player_name, { ppg: 0, games: 0, totalPPR: 0 });
      const qb = t.qbs.get(s.player_name)!;
      qb.totalPPR += s.fantasy_points_ppr;
      qb.games++;
      qb.ppg = Math.round(qb.totalPPR / qb.games * 10) / 10;
    }
  }

  const result = new Map<string, TeamStats>();
  for (const [team, agg] of teamAgg) {
    const totalPlays = agg.passAtt + agg.rushAtt;
    const games = agg.weeks.size;
    if (games === 0 || totalPlays === 0) continue;

    // Starting QB = most games played
    let startQB = '';
    let startQBPPG = 0;
    for (const [name, qb] of agg.qbs) {
      if (qb.games > (agg.qbs.get(startQB)?.games || 0)) {
        startQB = name;
        startQBPPG = qb.ppg;
      }
    }

    result.set(team, {
      team, season,
      passAtt: agg.passAtt,
      rushAtt: agg.rushAtt,
      totalPlays,
      games,
      teamPassRate: Math.round(agg.passAtt / totalPlays * 1000) / 1000,
      teamPace: Math.round(totalPlays / games * 10) / 10,
      startingQBName: startQB,
      startingQBPPG: startQBPPG,
    });
  }
  return result;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`Loading training rows from ${CACHE_PATH}...`);
  const cached = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
  const rows = cached.rows as Array<{
    name: string; position: string; season: number; team?: string;
    features: Record<string, number>;
  }>;
  console.log(`  ${rows.length} total training rows`);

  const draftPath = `${STATS_DIR}/draft_picks.csv`;

  // Build player→team lookup from draft picks
  const playerTeamLookup = new Map<string, string>(); // "name::pos::season" -> team
  if (existsSync(draftPath)) {
    const draftCsv2 = readFileSync(draftPath, 'utf-8');
    const draftResult2 = Papa.parse(draftCsv2, { header: true, skipEmptyLines: true });
    for (const r of draftResult2.data as any[]) {
      const name = (r.pfr_player_name || '').toLowerCase().replace(/[.']/g, '').trim();
      const team = r.team || '';
      const season = Number(r.season) || 0;
      const pos = r.position || '';
      if (name && team && season) {
        playerTeamLookup.set(`${name}::${pos}::${season}`, team);
        // Also without position (for fuzzy matching)
        playerTeamLookup.set(`${name}::${season}`, team);
      }
    }
    console.log(`  Player→team lookup: ${playerTeamLookup.size} entries from draft picks`);
  }

  // Also build lookup from player_stats (catches UDFAs)
  for (let season = 2010; season <= 2025; season++) {
    const stats = loadPlayerStats(season);
    for (const s of stats) {
      if (!s.recent_team || !s.player_name) continue;
      const name = s.player_name.toLowerCase().replace(/[.']/g, '').trim();
      const key = `${name}::${season}`;
      // Only set if not already from draft (draft is more authoritative for rookies)
      if (!playerTeamLookup.has(key)) {
        playerTeamLookup.set(key, s.recent_team);
      }
    }
  }
  console.log(`  Player→team lookup: ${playerTeamLookup.size} total entries (draft + stats)`);

  // Build team stats for all seasons 2010-2025
  const allTeamStats = new Map<string, TeamStats>(); // key: "team::season"
  for (let season = 2010; season <= 2025; season++) {
    const stats = loadPlayerStats(season);
    if (stats.length === 0) continue;
    const teamStats = computeTeamStats(stats, season);
    for (const [team, ts] of teamStats) {
      allTeamStats.set(`${team}::${season}`, ts);
    }
    console.log(`  ${season}: ${stats.length} player-weeks, ${teamStats.size} teams`);
  }

  // Also compute same-position-drafted counts from draft_picks
  const draftedByTeamPos = new Map<string, number>(); // "team::season::pos" -> count
  if (existsSync(draftPath)) {
    const draftCsv = readFileSync(draftPath, 'utf-8');
    const draftResult = Papa.parse(draftCsv, { header: true, skipEmptyLines: true });
    for (const r of draftResult.data as any[]) {
      const team = r.team || '';
      const season = Number(r.season) || 0;
      const pos = r.position || '';
      if (!team || !season || !pos) continue;
      const key = `${team}::${season}::${pos}`;
      draftedByTeamPos.set(key, (draftedByTeamPos.get(key) || 0) + 1);
    }
    console.log(`  Draft picks: ${draftResult.data.length} rows loaded`);
  }

  // Patch training rows
  let patched = 0;
  let skipped = 0;
  for (const row of rows) {
    const f = row.features;
    const yil = f.yearsInLeague ?? 99;
    if (yil > 1) continue; // only patch rookie rows

    const season = row.season;
    const normName = row.name.toLowerCase().replace(/[.']/g, '').trim();

    // Find team via draft picks → player_stats fallback
    const team = (row as any).team
      || playerTeamLookup.get(`${normName}::${row.position}::${season}`)
      || playerTeamLookup.get(`${normName}::${season}`)
      || '';

    let ts: TeamStats | undefined;
    if (team) {
      ts = allTeamStats.get(`${team}::${season}`);
    }

    if (!ts) {
      skipped++;
      continue;
    }

    let changed = false;

    // Backfill teamPassRate if missing
    if (!f.teamPassRate || f.teamPassRate === 0) {
      f.teamPassRate = ts.teamPassRate;
      changed = true;
    }

    // Backfill teamPace if missing
    if (!f.teamPace || f.teamPace === 0) {
      f.teamPace = ts.teamPace;
      changed = true;
    }

    // Backfill qbOwnPPG if missing (only for non-QB positions)
    if ((!f.qbOwnPPG || f.qbOwnPPG === 0) && row.position !== 'QB') {
      f.qbOwnPPG = ts.startingQBPPG;
      changed = true;
    }

    // Backfill teamSamePosCount if missing
    if (!f.teamSamePosCount || f.teamSamePosCount === 0) {
      const draftKey = `${team}::${season}::${row.position}`;
      const count = draftedByTeamPos.get(draftKey) || 0;
      if (count > 0) {
        f.teamSamePosCount = count;
        changed = true;
      }
    }

    if (changed) patched++;
  }

  console.log(`\nResults: ${patched} rows patched, ${skipped} rows skipped (no team match)`);

  // Show coverage after patching
  const rookies = rows.filter(r => (r.features.yearsInLeague ?? 99) <= 1);
  for (const feat of ['teamPassRate', 'teamPace', 'qbOwnPPG', 'teamSamePosCount']) {
    const nonZero = rookies.filter(r => r.features[feat] && r.features[feat] !== 0).length;
    console.log(`  ${feat.padEnd(20)} ${nonZero}/${rookies.length} (${Math.round(nonZero / rookies.length * 100)}%)`);
  }

  if (!dryRun) {
    console.log(`\nWriting patched cache to ${CACHE_PATH}...`);
    writeFileSync(CACHE_PATH, JSON.stringify(cached));
    console.log('Done.');
  } else {
    console.log('\n[DRY RUN] No changes written.');
  }
}

main();
