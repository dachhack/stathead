/**
 * Runs a parameter sweep across projection configurations to find the optimal
 * team-weight / Vegas blend / Vegas cap settings.
 *
 * Reads nflverse CSVs (downloads if not present), tests all configs across
 * multiple backtest seasons, and writes the winner to src/generated/projection-config.json.
 *
 * Run: node scripts/sweep-projection-config.js
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import Papa from 'papaparse';

const ROOT = join(import.meta.dirname, '..');
const DATA_DIR = join(ROOT, 'public', 'data');
const OUTPUT_DIR = join(ROOT, 'src', 'generated');
const OUTPUT_FILE = join(OUTPUT_DIR, 'projection-config.json');

const NFLVERSE = 'https://github.com/nflverse/nflverse-data/releases/download';
const TEST_SEASONS = [2025, 2024, 2023, 2022, 2021, 2020];
const STAT_KEYS = [
  'passAtt', 'passComp', 'passYds', 'passTD', 'int',
  'rushAtt', 'rushYds', 'rushTD',
  'targets', 'receptions', 'recYds', 'recTD',
];

// ── CSV helpers ──

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function downloadIfMissing(filename, url) {
  const path = join(DATA_DIR, filename);
  if (existsSync(path)) return;
  console.log(`  Downloading ${filename}...`);
  try {
    execSync(`curl -sfL "${url}" -o "${path}"`, { stdio: 'pipe' });
  } catch {
    console.warn(`  Warning: could not download ${filename}`);
  }
}

function parseCsvFile(filepath) {
  if (!existsSync(filepath)) return [];
  const text = readFileSync(filepath, 'utf-8');
  const result = Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true });
  return result.data;
}

// ── Data loading ──

function loadPlayerStats(season) {
  const filename = `player_stats_${season}.csv`;
  const url = season >= 2025
    ? `${NFLVERSE}/stats_player/stats_player_week_${season}.csv`
    : `${NFLVERSE}/player_stats/player_stats_${season}.csv`;
  downloadIfMissing(filename, url);
  return parseCsvFile(join(DATA_DIR, filename));
}

function loadGames() {
  downloadIfMissing('games.csv', `${NFLVERSE}/schedules/games.csv`);
  return parseCsvFile(join(DATA_DIR, 'games.csv'));
}

// ── Aggregation (mirrors data.ts logic) ──

function aggregateToSeasonTotals(weeklyStats) {
  const playerMap = new Map();
  for (const w of weeklyStats) {
    if (w.season_type !== 'REG') continue;
    const key = `${w.player_id}-${w.season}`;
    const e = playerMap.get(key);
    if (!e) {
      playerMap.set(key, {
        player_id: w.player_id,
        position: w.position,
        recent_team: w.recent_team,
        games: 1,
        completions: w.completions || 0,
        attempts: w.attempts || 0,
        passing_yards: w.passing_yards || 0,
        passing_tds: w.passing_tds || 0,
        interceptions: w.interceptions || 0,
        carries: w.carries || 0,
        rushing_yards: w.rushing_yards || 0,
        rushing_tds: w.rushing_tds || 0,
        receptions: w.receptions || 0,
        targets: w.targets || 0,
        receiving_yards: w.receiving_yards || 0,
        receiving_tds: w.receiving_tds || 0,
      });
    } else {
      e.games += 1;
      e.completions += w.completions || 0;
      e.attempts += w.attempts || 0;
      e.passing_yards += w.passing_yards || 0;
      e.passing_tds += w.passing_tds || 0;
      e.interceptions += w.interceptions || 0;
      e.carries += w.carries || 0;
      e.rushing_yards += w.rushing_yards || 0;
      e.rushing_tds += w.rushing_tds || 0;
      e.receptions += w.receptions || 0;
      e.targets += w.targets || 0;
      e.receiving_yards += w.receiving_yards || 0;
      e.receiving_tds += w.receiving_tds || 0;
      e.recent_team = w.recent_team;
    }
  }
  return Array.from(playerMap.values());
}

function aggregateTeamTotals(playerTotals) {
  const byTeam = new Map();
  for (const p of playerTotals) {
    if (!p.recent_team || !['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
    if (!byTeam.has(p.recent_team)) {
      byTeam.set(p.recent_team, {
        team: p.recent_team,
        passAtt: 0, passComp: 0, passYds: 0, passTD: 0, int: 0,
        rushAtt: 0, rushYds: 0, rushTD: 0,
        targets: 0, receptions: 0, recYds: 0, recTD: 0,
      });
    }
    const t = byTeam.get(p.recent_team);
    t.passAtt += p.attempts || 0;
    t.passComp += p.completions || 0;
    t.passYds += p.passing_yards || 0;
    t.passTD += p.passing_tds || 0;
    t.int += p.interceptions || 0;
    t.rushAtt += p.carries || 0;
    t.rushYds += p.rushing_yards || 0;
    t.rushTD += p.rushing_tds || 0;
    t.targets += p.targets || 0;
    t.receptions += p.receptions || 0;
    t.recYds += p.receiving_yards || 0;
    t.recTD += p.receiving_tds || 0;
  }
  return byTeam;
}

function computeLeagueAvg(teams) {
  const avg = {
    team: 'AVG', passAtt: 0, passComp: 0, passYds: 0, passTD: 0, int: 0,
    rushAtt: 0, rushYds: 0, rushTD: 0, targets: 0, receptions: 0, recYds: 0, recTD: 0,
  };
  const n = teams.size || 1;
  for (const t of teams.values()) {
    for (const k of STAT_KEYS) avg[k] += t[k];
  }
  for (const k of STAT_KEYS) avg[k] = Math.round(avg[k] / n);
  return avg;
}

// ── Vegas multiplier ──

function buildImpliedTotals(games, priorSeason) {
  const seasonGames = games.filter(
    (g) => g.season === priorSeason && g.game_type === 'REG' && g.total_line > 0
  );
  const teamImplied = {};
  for (const g of seasonGames) {
    const homeImpl = (g.total_line - g.spread_line) / 2;
    const awayImpl = (g.total_line + g.spread_line) / 2;
    if (!teamImplied[g.home_team]) teamImplied[g.home_team] = { sum: 0, count: 0 };
    if (!teamImplied[g.away_team]) teamImplied[g.away_team] = { sum: 0, count: 0 };
    teamImplied[g.home_team].sum += homeImpl;
    teamImplied[g.home_team].count += 1;
    teamImplied[g.away_team].sum += awayImpl;
    teamImplied[g.away_team].count += 1;
  }
  let leagueSum = 0, leagueCount = 0;
  for (const v of Object.values(teamImplied)) {
    leagueSum += v.sum; leagueCount += v.count;
  }
  return { teamImplied, leagueAvg: leagueCount > 0 ? leagueSum / leagueCount : 23 };
}

function projectTeamTotals(priorTeams, leagueAvg, games, targetSeason, config) {
  const implied = config.useVegas ? buildImpliedTotals(games, targetSeason - 1) : null;
  const projected = new Map();
  const leagueWeight = 1 - config.teamWeight;
  for (const [team, prior] of priorTeams) {
    let vm = 1;
    if (implied) {
      const t = implied.teamImplied[team];
      if (t && t.count > 0) {
        const teamAvg = t.sum / t.count;
        const blended = teamAvg * config.vegasBlend + implied.leagueAvg * (1 - config.vegasBlend);
        vm = Math.max(1 - config.vegasCap, Math.min(1 + config.vegasCap, blended / implied.leagueAvg));
      }
    }
    const proj = { team };
    for (const k of STAT_KEYS) {
      proj[k] = Math.round((prior[k] * config.teamWeight + leagueAvg[k] * leagueWeight) * vm);
    }
    projected.set(team, proj);
  }
  return projected;
}

function computeErrors(rows) {
  const errors = {};
  for (const k of STAT_KEYS) {
    let sumAE = 0, sumSE = 0, sumActual = 0, n = 0;
    for (const r of rows) {
      const diff = r.projected[k] - r.actual[k];
      sumAE += Math.abs(diff);
      sumSE += diff * diff;
      sumActual += r.actual[k];
      n++;
    }
    const mae = n > 0 ? sumAE / n : 0;
    const rmse = n > 0 ? Math.sqrt(sumSE / n) : 0;
    const meanActual = n > 0 ? sumActual / n : 0;
    const pctError = meanActual > 0 ? (mae / meanActual) * 100 : 0;
    errors[k] = { mae: Math.round(mae), rmse: Math.round(rmse), meanActual: Math.round(meanActual), pctError: Math.round(pctError * 10) / 10 };
  }
  return errors;
}

// ── Sweep ──

function generateConfigs() {
  const configs = [];
  const teamWeights = [0.40, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.90, 1.00];
  const vegasBlends = [0.4, 0.6, 0.8, 1.0];
  const vegasCaps = [0.10, 0.15, 0.20, 0.25];

  // No-vegas configs
  for (const tw of teamWeights) {
    configs.push({ teamWeight: tw, useVegas: false, vegasBlend: 0, vegasCap: 0 });
  }
  // Vegas configs
  for (const tw of teamWeights) {
    for (const vb of vegasBlends) {
      for (const vc of vegasCaps) {
        configs.push({ teamWeight: tw, useVegas: true, vegasBlend: vb, vegasCap: vc });
      }
    }
  }
  return configs;
}

// ── Main ──

async function main() {
  console.log('Projection Config Sweep');
  console.log('=======================\n');

  ensureDataDir();

  // Load all data
  console.log('Loading data...');
  const games = loadGames();
  console.log(`  ${games.length} games loaded`);

  const seasonData = [];
  for (const season of TEST_SEASONS) {
    const priorYear = season - 1;
    console.log(`  Loading ${priorYear} → ${season}...`);
    const priorStats = loadPlayerStats(priorYear);
    const actualStats = loadPlayerStats(season);

    const priorTotals = aggregateToSeasonTotals(priorStats);
    const actualTotals = aggregateToSeasonTotals(actualStats);

    const priorTeams = aggregateTeamTotals(priorTotals);
    const actualTeams = aggregateTeamTotals(actualTotals);
    const leagueAvg = computeLeagueAvg(priorTeams);

    seasonData.push({ season, priorTeams, actualTeams, leagueAvg });
  }

  // Run sweep
  const configs = generateConfigs();
  console.log(`\nRunning sweep across ${configs.length} configs × ${TEST_SEASONS.length} seasons...\n`);

  const results = [];
  for (const config of configs) {
    const allRows = [];
    for (const sd of seasonData) {
      const projected = projectTeamTotals(sd.priorTeams, sd.leagueAvg, games, sd.season, config);
      for (const [team, proj] of projected) {
        const actual = sd.actualTeams.get(team);
        if (!actual) continue;
        allRows.push({ team, actual, projected: proj });
      }
    }
    const errors = computeErrors(allRows);
    let totalPct = 0;
    const statErrors = {};
    for (const k of STAT_KEYS) {
      statErrors[k] = errors[k].pctError;
      totalPct += errors[k].pctError;
    }
    const avgPctError = Math.round((totalPct / STAT_KEYS.length) * 100) / 100;
    results.push({ config, avgPctError, statErrors, errors });
  }

  results.sort((a, b) => a.avgPctError - b.avgPctError);

  // Print top 10
  console.log('Top 10 Configurations:');
  console.log('─'.repeat(80));
  console.log(`${'#'.padStart(3)}  ${'Team%'.padEnd(6)} ${'Vegas'.padEnd(16)} ${'Avg Err%'.padStart(8)}  ${'PassYds'.padStart(8)} ${'RushYds'.padStart(8)} ${'RecYds'.padStart(8)} ${'PassTD'.padStart(8)} ${'RushTD'.padStart(8)} ${'RecTD'.padStart(8)}`);
  console.log('─'.repeat(80));
  for (let i = 0; i < Math.min(10, results.length); i++) {
    const r = results[i];
    const c = r.config;
    const vegas = c.useVegas ? `b${Math.round(c.vegasBlend * 100)} c±${Math.round(c.vegasCap * 100)}%` : 'none';
    console.log(
      `${(i + 1).toString().padStart(3)}  ${(Math.round(c.teamWeight * 100) + '/' + Math.round((1 - c.teamWeight) * 100)).padEnd(6)} ${vegas.padEnd(16)} ${r.avgPctError.toFixed(2).padStart(8)}  ${(r.statErrors.passYds + '%').padStart(8)} ${(r.statErrors.rushYds + '%').padStart(8)} ${(r.statErrors.recYds + '%').padStart(8)} ${(r.statErrors.passTD + '%').padStart(8)} ${(r.statErrors.rushTD + '%').padStart(8)} ${(r.statErrors.recTD + '%').padStart(8)}`
    );
  }

  // Find the old default for comparison
  const oldDefault = results.find(
    (r) => r.config.teamWeight === 0.60 && r.config.useVegas && r.config.vegasBlend === 0.6 && r.config.vegasCap === 0.15
  );
  const oldRank = oldDefault ? results.indexOf(oldDefault) + 1 : null;
  if (oldDefault) {
    console.log(`\nPrevious default (60/40 vb60 vc15): rank #${oldRank}, ${oldDefault.avgPctError}% avg error`);
  }

  // Winner
  const winner = results[0];
  console.log(`\nWinner: ${Math.round(winner.config.teamWeight * 100)}/${Math.round((1 - winner.config.teamWeight) * 100)}${winner.config.useVegas ? ` + Vegas (blend ${Math.round(winner.config.vegasBlend * 100)}%, cap ±${Math.round(winner.config.vegasCap * 100)}%)` : ' no Vegas'}`);
  console.log(`Avg error: ${winner.avgPctError}%`);
  if (oldDefault) {
    console.log(`Improvement over default: ${(oldDefault.avgPctError - winner.avgPctError).toFixed(2)} percentage points`);
  }

  // Write output
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const output = {
    generatedAt: new Date().toISOString(),
    testSeasons: TEST_SEASONS,
    configsTested: configs.length,
    winner: {
      teamWeight: winner.config.teamWeight,
      leagueWeight: Math.round((1 - winner.config.teamWeight) * 100) / 100,
      useVegas: winner.config.useVegas,
      vegasBlend: winner.config.vegasBlend,
      vegasCap: winner.config.vegasCap,
    },
    avgPctError: winner.avgPctError,
    perStatErrors: winner.statErrors,
    perStatDetail: winner.errors,
    top10: results.slice(0, 10).map((r, i) => ({
      rank: i + 1,
      teamWeight: r.config.teamWeight,
      useVegas: r.config.useVegas,
      vegasBlend: r.config.vegasBlend,
      vegasCap: r.config.vegasCap,
      avgPctError: r.avgPctError,
      statErrors: r.statErrors,
    })),
  };

  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2) + '\n');
  console.log(`\nWrote ${OUTPUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
