/**
 * SharedContext builder — constructs the data environment for feature groups.
 *
 * Extracts the data-fetching and map-construction logic from buildFeatureMatrix
 * so feature groups can compute independently. Fetches only the data deps
 * needed by the requested groups.
 */

import type { SharedContext, SharedContextData, DataDep, PlayerKey, PlayerInfo } from './types';
import { makePlayerKey } from './types';
import {
  fetchPlayerStats, fetchFfcADP, fetchSnapCounts,
  fetchInjuries, fetchNextGenStats, fetchPlayByPlay,
  fetchPbpParticipation, fetchRosters, fetchDepthCharts,
  fetchGames, fetchContracts, fetchDraftProspects,
  aggregateToSeasonTotals,
  fetchCombine, fetchCollegeStats, fetchDraftPicks,
  fetchCollegeQBR,
} from '../../data';
import { normalizeName, parseHeight, POSITIONS } from '../featureTypes';

// ── Types for intermediate aggregations ─────────────────────────────

interface AdvAgg {
  targetShare: number; airYardsShare: number; wopr: number; racr: number;
  airYards: number; yac: number; receptions: number; targets: number;
  recEPA: number; rushEPA: number; weeks: number;
}

interface SchemeAgg {
  passes: number; rushes: number; plays: number; games: number;
  neutralPasses: number; neutralPlays: number;
  firstDownRuns: number; firstDownPlays: number;
  shotgunPlays: number; noHuddlePlays: number;
  rbTargets: number; teTargets: number; wrTargets: number; totalTargets: number;
}

interface PersonnelAgg {
  p11: number; p12: number; p13: number; p21: number; p22: number; p10: number;
  total: number; wr3plus: number; te2plus: number;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Build a SharedContext for a single season, fetching only the required data.
 */
export async function buildSharedContext(opts: {
  season: number;
  dataDeps: Set<DataDep>;
  staticData?: Partial<SharedContextData>;
  onStatus?: (msg: string) => void;
}): Promise<SharedContext> {
  const { season, dataDeps, onStatus } = opts;
  const log = onStatus || (() => {});

  // Start with static data if provided, otherwise empty maps
  const data: SharedContextData = {
    combineByName: opts.staticData?.combineByName || new Map(),
    combineAvg: opts.staticData?.combineAvg || new Map(),
    draftByName: opts.staticData?.draftByName || new Map(),
    contractByName: opts.staticData?.contractByName || new Map(),
    collegeByName: opts.staticData?.collegeByName || new Map(),
    collegeAdvancedByName: opts.staticData?.collegeAdvancedByName || new Map(),
    collegeBestSeasonByName: opts.staticData?.collegeBestSeasonByName || new Map(),
    collegeZapByName: opts.staticData?.collegeZapByName || new Map(),
    collegePerGameByName: opts.staticData?.collegePerGameByName || new Map(),
    teammateScoreByName: opts.staticData?.teammateScoreByName || new Map(),
    speedScoreByName: opts.staticData?.speedScoreByName || new Map(),
    collegeAvgByPos: opts.staticData?.collegeAvgByPos || new Map(),
    prospectByName: opts.staticData?.prospectByName || new Map(),
    collegeSOS: opts.staticData?.collegeSOS || new Map(),
    coachBySeasonTeam: opts.staticData?.coachBySeasonTeam || new Map(),
    vegasBySeasonTeam: opts.staticData?.vegasBySeasonTeam || new Map(),
    vegasSeasonProps: opts.staticData?.vegasSeasonProps || new Map(),

    currentByName: new Map(),
    priorByName: new Map(),
    advByName: new Map(),
    snapAccum: new Map(),
    injuryByName: new Map(),
    preseasonInjuryByName: new Map(),
    ngsRecByName: new Map(),
    ngsRushByName: new Map(),
    ngsPassByName: new Map(),
    pbpByTeam: new Map(),
    schemeByTeam: new Map(),
    personnelByTeam: new Map(),
    routesByName: new Map(),
    depthChartByName: new Map(),
    rosterByTeam: new Map(),
    priorRosterByTeam: new Map(),
    playerTeamMap: new Map(),
    vorReplacement: {},
    playerHistoryMap: opts.staticData?.playerHistoryMap || new Map(),
  };

  // ── Fetch seasonal data sources in parallel ──────────────────────
  log(`  Fetching data for season ${season}...`);

  // Build fetch plan based on required data deps
  const needStats = dataDeps.has('currentStats') || dataDeps.has('priorStats');
  const needSnaps = dataDeps.has('priorSnaps');
  const needInj = dataDeps.has('injuries');
  const needNgs = dataDeps.has('ngs');
  const needPbp = dataDeps.has('pbp');
  const needPart = dataDeps.has('participation');
  const needRosters = dataDeps.has('rosters') || dataDeps.has('depthCharts');
  const needAdp = dataDeps.has('adp');
  const needGames = dataDeps.has('games');

  const [
    adpData,
    currentStatsRaw, priorStatsRaw,
    priorSnapsRaw,
    priorInjuriesRaw, preseasonInjuriesRaw,
    ngsRecRaw, ngsRushRaw, ngsPassRaw,
    pbpRaw, participationRaw,
    rostersRaw, priorRostersRaw, depthChartsRaw,
    gamesRaw,
  ] = await Promise.all([
    needAdp ? fetchFfcADP(season, 'ppr', 12).catch(() => []) : [],
    needStats ? fetchPlayerStats(season).catch(() => []) : [],
    needStats ? fetchPlayerStats(season - 1).catch(() => []) : [],
    needSnaps ? fetchSnapCounts(season - 1).catch(() => []) : [],
    needInj ? fetchInjuries(season - 1).catch(() => []) : [],
    needInj ? fetchInjuries(season).catch(() => []) : [],
    needNgs ? fetchNextGenStats(season - 1, 'receiving').catch(() => []) : [],
    needNgs ? fetchNextGenStats(season - 1, 'rushing').catch(() => []) : [],
    needNgs ? fetchNextGenStats(season - 1, 'passing').catch(() => []) : [],
    needPbp ? fetchPlayByPlay(season - 1).catch(() => []) : [],
    needPart ? fetchPbpParticipation(season - 1).catch(() => []) : [],
    needRosters ? fetchRosters(season).catch(() => []) : [],
    needRosters ? fetchRosters(season - 1).catch(() => []) : [],
    needRosters ? fetchDepthCharts(season).catch(() => []) : [],
    needGames ? fetchGames().catch(() => []) : [],
  ]);

  let fetchCount = 0;
  if (needAdp) fetchCount++; if (needStats) fetchCount += 2; if (needSnaps) fetchCount++;
  if (needInj) fetchCount += 2; if (needNgs) fetchCount += 3; if (needPbp) fetchCount++;
  if (needPart) fetchCount++; if (needRosters) fetchCount += 3; if (needGames) fetchCount++;
  log(`  Fetched ${fetchCount} data sources`);

  // ── Build intermediate lookup maps ────────────────────────────────

  const currentStats = currentStatsRaw as any[];
  const priorStats = priorStatsRaw as any[];
  const priorSnaps = priorSnapsRaw as any[];

  // Current/prior totals
  if (currentStats.length > 0) {
    const currentTotals = aggregateToSeasonTotals(currentStats);
    for (const p of currentTotals) {
      if (POSITIONS.includes(p.position)) {
        data.currentByName.set(normalizeName(p.player_display_name), p);
      }
    }
  }
  if (priorStats.length > 0) {
    const priorTotals = aggregateToSeasonTotals(priorStats);
    for (const p of priorTotals) {
      if (POSITIONS.includes(p.position)) {
        data.priorByName.set(normalizeName(p.player_display_name), p);
      }
    }
  }

  // Snap accumulation
  for (const snap of priorSnaps) {
    const name = normalizeName(snap.player);
    if (!data.snapAccum.has(name)) data.snapAccum.set(name, { total: 0, count: 0 });
    const acc = data.snapAccum.get(name)!;
    const pct = snap.offense_pct || 0;
    if (pct > 0) { acc.total += pct; acc.count += 1; }
  }

  // Advanced weekly stats aggregation
  if (priorStats.length > 0) {
    const weeklyPrior = priorStats.filter((r: any) => r.season_type === 'REG');
    for (const w of weeklyPrior) {
      const name = normalizeName(w.player_display_name);
      if (!data.advByName.has(name)) {
        data.advByName.set(name, {
          targetShare: 0, airYardsShare: 0, wopr: 0, racr: 0,
          airYards: 0, yac: 0, receptions: 0, targets: 0,
          recEPA: 0, rushEPA: 0, weeks: 0,
        });
      }
      const a = data.advByName.get(name)! as AdvAgg;
      a.targetShare += w.target_share || 0;
      a.airYardsShare += w.air_yards_share || 0;
      a.wopr += w.wopr || 0;
      a.racr += w.racr || 0;
      a.airYards += w.receiving_air_yards || 0;
      a.yac += w.receiving_yards_after_catch || 0;
      a.receptions += w.receptions || 0;
      a.targets += w.targets || 0;
      a.recEPA += w.receiving_epa || 0;
      a.rushEPA += w.rushing_epa || 0;
      a.weeks += 1;
    }
  }

  // NGS lookups
  const ngsRec = ngsRecRaw as any[];
  const ngsRush = ngsRushRaw as any[];
  const ngsPass = ngsPassRaw as any[];
  for (const r of ngsRec) {
    if (r.week === 0 && r.season_type === 'REG') {
      data.ngsRecByName.set(normalizeName(r.player_display_name), r);
    }
  }
  for (const r of ngsRush) {
    if (r.week === 0) data.ngsRushByName.set(normalizeName(r.player_display_name), r);
  }
  for (const r of ngsPass) {
    if (r.week === 0) data.ngsPassByName.set(normalizeName(r.player_display_name), r);
  }

  // Injury maps
  const priorInjuries = priorInjuriesRaw as any[];
  const preseasonInjuries = preseasonInjuriesRaw as any[];
  const SOFT_TISSUE = /hamstring|groin|calf|quad|hip|ankle|achilles|foot|toe/i;
  const KNEE = /knee|acl|mcl|pcl/i;
  for (const inj of priorInjuries) {
    const name = normalizeName(inj.full_name || inj.gsis_id);
    if (!data.injuryByName.has(name)) {
      data.injuryByName.set(name, { weeks: 0, gamesOut: 0, softTissue: false, knee: false });
    }
    const a = data.injuryByName.get(name)!;
    a.weeks += 1;
    if (inj.report_status === 'Out' || inj.report_status === 'Doubtful') a.gamesOut += 1;
    if (SOFT_TISSUE.test(inj.report_primary_injury || '')) a.softTissue = true;
    if (KNEE.test(inj.report_primary_injury || '')) a.knee = true;
  }
  for (const inj of preseasonInjuries) {
    if (inj.game_type !== 'PRE' && (inj.week || 99) > 0) continue;
    const name = normalizeName(inj.full_name || inj.gsis_id);
    if (!data.preseasonInjuryByName.has(name)) {
      data.preseasonInjuryByName.set(name, { injured: false, weeks: 0 });
    }
    const a = data.preseasonInjuryByName.get(name)!;
    a.injured = true;
    a.weeks += 1;
  }

  // Roster maps
  const rosters = rostersRaw as any[];
  const priorRosters = priorRostersRaw as any[];
  for (const r of rosters) {
    if (!POSITIONS.includes(r.position)) continue;
    const name = normalizeName(r.player_name || r.full_name);
    data.playerTeamMap.set(name, r.team);
    const posKey = `${r.team}:${r.position}`;
    if (!data.rosterByTeam.has(posKey)) data.rosterByTeam.set(posKey, new Set());
    data.rosterByTeam.get(posKey)!.add(name);
  }
  for (const r of priorRosters) {
    if (!POSITIONS.includes(r.position)) continue;
    const name = normalizeName(r.player_name || r.full_name);
    const posKey = `${r.team}:${r.position}`;
    if (!data.priorRosterByTeam.has(posKey)) data.priorRosterByTeam.set(posKey, new Set());
    data.priorRosterByTeam.get(posKey)!.add(name);
  }

  // Depth chart ranks
  const depthCharts = depthChartsRaw as any[];
  const dcLatest = new Map<string, number>();
  for (const dc of depthCharts) {
    if (!POSITIONS.includes(dc.position)) continue;
    const name = normalizeName(dc.full_name);
    const key = `${dc.club_code}:${dc.position}:${name}`;
    const existing = dcLatest.get(key + ':week') || 0;
    if ((dc.week || 0) >= existing) {
      dcLatest.set(key + ':week', dc.week || 0);
      data.depthChartByName.set(name, dc.depth_team || 99);
    }
  }

  // Games data: Vegas lines, coach tracking
  const games = gamesRaw as any[];
  if (games.length > 0) {
    // Build Vegas by season-team from game lines
    for (const g of games) {
      if (g.game_type !== 'REG') continue;
      const tl = g.total_line || 0;
      const sl = g.spread_line || 0;
      for (const [team, implied, spread, score, isWin] of [
        [g.home_team, tl > 0 ? (tl - sl) / 2 : 0, sl, g.home_score || 0, (g.home_score || 0) > (g.away_score || 0)],
        [g.away_team, tl > 0 ? (tl + sl) / 2 : 0, -sl, g.away_score || 0, (g.away_score || 0) > (g.home_score || 0)],
      ] as [string, number, number, number, boolean][]) {
        const key = `${g.season}:${team}`;
        if (!data.vegasBySeasonTeam.has(key)) {
          data.vegasBySeasonTeam.set(key, { impliedTotal: 0, spread: 0, gameTotal: 0, actualPts: 0, games: 0, wins: 0 });
        }
        const v = data.vegasBySeasonTeam.get(key)!;
        v.impliedTotal += implied;
        v.gameTotal += tl;
        v.spread += spread;
        v.actualPts += score;
        v.games += 1;
        if (isWin) v.wins += 1;
      }
      // Coach tracking
      if (g.home_coach) data.coachBySeasonTeam.set(`${g.season}:${g.home_team}`, g.home_coach);
      if (g.away_coach) data.coachBySeasonTeam.set(`${g.season}:${g.away_team}`, g.away_coach);
    }
  }

  // PBP-derived scheme and personnel maps
  const pbp = pbpRaw as any[];
  if (pbp.length > 0) {
    buildSchemeAndPersonnel(pbp, data, season);
  }

  // Routes from participation
  const participation = participationRaw as any[];
  if (participation.length > 0 && pbp.length > 0) {
    buildRoutes(participation, pbp, priorStats, data);
  }

  // Build player index
  const players = new Map<PlayerKey, PlayerInfo>();
  for (const adp of (adpData as any[])) {
    if (!POSITIONS.includes(adp.position)) continue;
    if (adp.adp > 400) continue;
    const normalName = normalizeName(adp.name);
    const pk = makePlayerKey(normalName, season);
    const team = data.playerTeamMap.get(normalName) || adp.team || '';
    players.set(pk, {
      name: adp.name,
      normalName,
      position: adp.position,
      season,
      adp: adp.adp,
      team,
    });
  }

  return {
    players,
    data,
    priorFeatures: new Map(),
  };
}

// ── Internal helpers ────────────────────────────────────────────────

function buildSchemeAndPersonnel(pbp: any[], data: SharedContextData, _season: number): void {
  const schemeByTeam = new Map<string, SchemeAgg>();
  const personnelByTeam = new Map<string, PersonnelAgg>();
  const priorGamesByTeam = new Map<string, Set<string>>();

  for (const play of pbp) {
    if (play.play_type !== 'pass' && play.play_type !== 'run') continue;
    const team = play.posteam;
    if (!team) continue;

    // Scheme
    if (!schemeByTeam.has(team)) {
      schemeByTeam.set(team, {
        passes: 0, rushes: 0, plays: 0, games: 0,
        neutralPasses: 0, neutralPlays: 0,
        firstDownRuns: 0, firstDownPlays: 0,
        shotgunPlays: 0, noHuddlePlays: 0,
        rbTargets: 0, teTargets: 0, wrTargets: 0, totalTargets: 0,
      });
    }
    const s = schemeByTeam.get(team)!;

    if (!priorGamesByTeam.has(team)) priorGamesByTeam.set(team, new Set());
    priorGamesByTeam.get(team)!.add(play.game_id || '');

    s.plays += 1;
    if (play.play_type === 'pass') s.passes += 1;
    else s.rushes += 1;

    // Neutral game script
    const diff = Math.abs(play.score_differential || 0);
    const qtr = play.qtr || 0;
    if (diff <= 7 && qtr <= 3) {
      s.neutralPlays += 1;
      if (play.play_type === 'pass') s.neutralPasses += 1;
    }

    // First down
    if (play.down === 1) {
      s.firstDownPlays += 1;
      if (play.play_type === 'run') s.firstDownRuns += 1;
    }

    // Formation
    if (play.shotgun) s.shotgunPlays += 1;
    if (play.no_huddle) s.noHuddlePlays += 1;

    // Positional targets
    if (play.play_type === 'pass' && play.receiver_player_name) {
      const recName = normalizeName(play.receiver_player_name);
      const recPos = data.priorByName.get(recName)?.position;
      s.totalTargets += 1;
      if (recPos === 'RB') s.rbTargets += 1;
      else if (recPos === 'TE') s.teTargets += 1;
      else if (recPos === 'WR') s.wrTargets += 1;
    }

    // Personnel groupings
    const personnel = play.offense_personnel || '';
    if (personnel) {
      if (!personnelByTeam.has(team)) {
        personnelByTeam.set(team, {
          p11: 0, p12: 0, p13: 0, p21: 0, p22: 0, p10: 0,
          total: 0, wr3plus: 0, te2plus: 0,
        });
      }
      const p = personnelByTeam.get(team)!;
      p.total += 1;

      const rbMatch = personnel.match(/(\d+)\s*RB/);
      const teMatch = personnel.match(/(\d+)\s*TE/);
      const wrMatch = personnel.match(/(\d+)\s*WR/);
      const rb = rbMatch ? parseInt(rbMatch[1]) : 0;
      const te = teMatch ? parseInt(teMatch[1]) : 0;
      const wr = wrMatch ? parseInt(wrMatch[1]) : 0;

      const code = `${rb}${te}`;
      if (code === '11') p.p11 += 1;
      else if (code === '12') p.p12 += 1;
      else if (code === '13') p.p13 += 1;
      else if (code === '21') p.p21 += 1;
      else if (code === '22') p.p22 += 1;
      else if (code === '10') p.p10 += 1;

      if (wr >= 3) p.wr3plus += 1;
      if (te >= 2) p.te2plus += 1;
    }
  }

  // Set game counts
  for (const [team, games] of priorGamesByTeam) {
    const s = schemeByTeam.get(team);
    if (s) s.games = games.size;
  }

  data.schemeByTeam = schemeByTeam;
  data.personnelByTeam = personnelByTeam;
}

function buildRoutes(
  participation: any[], pbp: any[], priorStats: any[],
  data: SharedContextData,
): void {
  // Build pass play key set
  const passPlayKeys = new Set<string>();
  for (const play of pbp) {
    if (play.play_type === 'pass') {
      passPlayKeys.add(`${play.game_id}:${play.play_id}`);
    }
  }

  // GSIS → name mapping
  const gsisToName = new Map<string, string>();
  for (const w of priorStats) {
    if (w.player_id) {
      gsisToName.set(w.player_id, normalizeName(w.player_display_name));
    }
  }

  // Aggregate routes
  const routes = new Map<string, { routesRun: number; snaps11: number; snaps12: number; totalSnaps: number }>();
  for (const p of participation) {
    const key = `${p.nflverse_game_id || p.old_game_id}:${p.play_id}`;
    const isPass = passPlayKeys.has(key);
    const gsisIds = (p.offense_players || '').split(';').filter(Boolean);

    for (const gsis of gsisIds) {
      const name = gsisToName.get(gsis);
      if (!name) continue;
      if (!routes.has(name)) routes.set(name, { routesRun: 0, snaps11: 0, snaps12: 0, totalSnaps: 0 });
      const r = routes.get(name)!;
      r.totalSnaps += 1;
      if (isPass) r.routesRun += 1;

      // Personnel grouping
      const pers = p.offense_personnel || '';
      const rbM = pers.match(/(\d+)\s*RB/);
      const teM = pers.match(/(\d+)\s*TE/);
      const code = `${rbM ? rbM[1] : 0}${teM ? teM[1] : 0}`;
      if (code === '11') r.snaps11 += 1;
      else if (code === '12') r.snaps12 += 1;
    }
  }

  data.routesByName = routes;
}

/**
 * Load static data sources (combine, draft, college, etc.).
 * These are loaded once and reused across all seasons.
 */
export async function loadStaticData(onStatus?: (msg: string) => void): Promise<Partial<SharedContextData>> {
  const log = onStatus || (() => {});
  log('  Loading static data sources...');

  const [combineData, collegeStatsData, draftData] = await Promise.all([
    fetchCombine().catch(() => []),
    fetchCollegeStats().catch(() => []),
    fetchDraftPicks().catch(() => []),
  ]);

  // Combine lookups
  const combineByName = new Map<string, any>();
  const combineAvg = new Map<string, Record<string, number>>();
  for (const c of combineData) {
    combineByName.set(normalizeName(c.pfr_player_name || c.player_name), c);
  }
  // Position averages
  for (const pos of POSITIONS) {
    const posEntries = combineData.filter((c: any) => c.pos === pos);
    if (posEntries.length === 0) continue;
    const avg = (field: string) => {
      const vals = posEntries.map((c: any) => Number(c[field]) || 0).filter((v: number) => v > 0);
      return vals.length > 0 ? Math.round(vals.reduce((a: number, b: number) => a + b, 0) / vals.length * 100) / 100 : 0;
    };
    combineAvg.set(pos, {
      forty: avg('forty'), bench: avg('bench'), vertical: avg('vertical'),
      broadJump: avg('broad_jump'), cone: avg('cone'), shuttle: avg('shuttle'),
      weight: avg('wt'),
    });
  }

  // Draft lookups
  const draftByName = new Map<string, any>();
  for (const d of draftData) {
    draftByName.set(normalizeName(d.pfr_player_name), d);
  }

  // College stats
  const collegeByName = new Map<string, Map<string, number>>();
  for (const cs of collegeStatsData) {
    const name = normalizeName(cs.player_name);
    if (!collegeByName.has(name)) collegeByName.set(name, new Map());
    const existing = collegeByName.get(name)!;
    const existingKey = `${cs.statistic}:latest`;
    const existingSeason = existing.get(existingKey) || 0;
    if (cs.season >= existingSeason) {
      existing.set(cs.statistic, cs.value || 0);
      existing.set(existingKey, cs.season);
    }
  }

  // Speed scores
  const speedScoreByName = new Map<string, number>();
  for (const [name, combine] of combineByName) {
    const wt = combine.wt || 0;
    const forty = combine.forty || 0;
    if (wt > 0 && forty > 0) {
      speedScoreByName.set(name, Math.round((wt * 200) / (forty ** 4) * 10) / 10);
    }
  }

  log(`  Static: ${combineByName.size} combine, ${draftByName.size} draft, ${collegeByName.size} college`);

  return {
    combineByName,
    combineAvg,
    draftByName,
    collegeByName,
    collegeAdvancedByName: new Map(), // populated from NCAA data
    collegeBestSeasonByName: new Map(),
    collegeZapByName: new Map(),
    collegePerGameByName: new Map(),
    teammateScoreByName: new Map(),
    speedScoreByName,
    collegeAvgByPos: new Map(),
    prospectByName: new Map(),
    collegeSOS: new Map(),
    playerHistoryMap: new Map(),
  };
}
