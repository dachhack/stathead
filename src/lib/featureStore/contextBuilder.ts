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
  fetchGames, fetchDraftProspects,
  aggregateToSeasonTotals,
  fetchCombine, fetchCollegeStats, fetchDraftPicks,
} from '../../data';
import { normalizeName, POSITIONS } from '../featureTypes';
import { buildCollegeAnalytics } from '../collegeAnalytics';

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

  // Player history for momentum features (cross-season tracking)
  // Add prior season data to the history map
  const playerHistoryMap = data.playerHistoryMap;
  for (const [name, prior] of data.priorByName) {
    if (!POSITIONS.includes(prior.position)) continue;
    if (!playerHistoryMap.has(name)) playerHistoryMap.set(name, []);
    const hist = playerHistoryMap.get(name)!;
    if (!hist.some((h: any) => h.season === season - 1)) {
      const priorGames = prior.games || 1;
      const snapAcc = data.snapAccum.get(name);
      const snapPct = snapAcc && snapAcc.count > 0 ? snapAcc.total / snapAcc.count : 0;
      // Get ADP for this player in this season
      const adpEntry = (adpData as any[]).find((a: any) => normalizeName(a.name) === name);
      // Get target share from advByName
      const adv = data.advByName.get(name);
      const advWeeks = adv?.weeks || 1;

      hist.push({
        season: season - 1,
        ppg: priorGames > 0 ? (prior.fantasy_points_ppr || 0) / priorGames : 0,
        targets: prior.targets || 0,
        touches: (prior.carries || 0) + (prior.receptions || 0),
        snapPct,
        targetShare: adv ? adv.targetShare / advWeeks : 0,
        adp: adpEntry?.adp || 0,
      });
    }
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

    // Weekly PPR for consistency features (boom/bust/stddev)
    const weeklyPPRByName = new Map<string, number[]>();
    for (const w of weeklyPrior) {
      if (!POSITIONS.includes(w.position)) continue;
      const name = normalizeName(w.player_display_name);
      if (!weeklyPPRByName.has(name)) weeklyPPRByName.set(name, []);
      weeklyPPRByName.get(name)!.push(w.fantasy_points_ppr || 0);
    }
    (data as any).weeklyPPRByName = weeklyPPRByName;
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

  // Injury recurrence (proxy from soft tissue + knee flags)
  const injuryRecurrence = new Map<string, number>();
  for (const [name, inj] of data.injuryByName) {
    let risk = 0;
    if (inj.softTissue) risk += 0.5;
    if (inj.knee) risk += 0.5;
    if (inj.gamesOut >= 4) risk += 0.5;
    injuryRecurrence.set(name, Math.min(1, risk));
  }
  (data as any).injuryRecurrence = injuryRecurrence;

  // SOS (strength of schedule) from game schedule + prior season Vegas
  const games = gamesRaw as any[];
  if (games.length > 0) {
    const teamOpponents = new Map<string, string[]>();
    for (const g of games) {
      if (g.game_type !== 'REG' || g.season !== season) continue;
      if (!teamOpponents.has(g.home_team)) teamOpponents.set(g.home_team, []);
      if (!teamOpponents.has(g.away_team)) teamOpponents.set(g.away_team, []);
      teamOpponents.get(g.home_team)!.push(g.away_team);
      teamOpponents.get(g.away_team)!.push(g.home_team);
    }
    const sosDefPPG = new Map<string, number>();
    const sosAvgSpread = new Map<string, number>();
    for (const [team, opponents] of teamOpponents) {
      let totalPPG = 0, totalSpread = 0, count = 0;
      for (const opp of opponents) {
        const vKey = `${season - 1}:${opp}`;
        const v = data.vegasBySeasonTeam.get(vKey);
        if (v) {
          const vGames = (v as any).games || 1;
          totalPPG += (v as any).actualPts / vGames;
          totalSpread += (v as any).spread / vGames;
          count++;
        }
      }
      if (count > 0) {
        sosDefPPG.set(team, Math.round(totalPPG / count * 10) / 10);
        sosAvgSpread.set(team, Math.round(totalSpread / count * 10) / 10);
      }
    }
    (data as any).sosDefPPG = sosDefPPG;
    (data as any).sosAvgSpread = sosAvgSpread;
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

    // PBP player-level aggregation: deep targets, RZ targets, pass location
    const pbpByReceiver = new Map<string, { airYards: number; targets: number; deepTargets: number; rzTargets: number }>();
    const locByReceiver = new Map<string, { left: number; middle: number; right: number; total: number }>();
    const teamRZTargets = new Map<string, number>();

    for (const play of pbp) {
      if (play.play_type !== 'pass') continue;
      const recName = play.receiver_player_name ? normalizeName(play.receiver_player_name) : '';
      if (!recName) continue;

      if (!pbpByReceiver.has(recName)) pbpByReceiver.set(recName, { airYards: 0, targets: 0, deepTargets: 0, rzTargets: 0 });
      const r = pbpByReceiver.get(recName)!;
      r.targets += 1;
      r.airYards += play.air_yards || 0;
      if ((play.air_yards || 0) >= 15) r.deepTargets += 1;
      if ((play.yardline_100 || 100) <= 20) {
        r.rzTargets += 1;
        const team = play.posteam || '';
        teamRZTargets.set(team, (teamRZTargets.get(team) || 0) + 1);
      }

      // Pass location tracking
      const loc = play.pass_location;
      if (loc) {
        if (!locByReceiver.has(recName)) locByReceiver.set(recName, { left: 0, middle: 0, right: 0, total: 0 });
        const l = locByReceiver.get(recName)!;
        l.total += 1;
        if (loc === 'left') l.left += 1;
        else if (loc === 'middle') l.middle += 1;
        else if (loc === 'right') l.right += 1;
      }
    }
    (data as any).pbpByReceiver = pbpByReceiver;
    (data as any).locByReceiver = locByReceiver;
    (data as any).teamRZTargets = teamRZTargets;

    // Environment maps from PBP: sack rate, rush YPC
    const teamSacks = new Map<string, { sacks: number; dropbacks: number }>();
    const teamRush = new Map<string, { yards: number; attempts: number }>();
    for (const play of pbp) {
      if (!play.posteam) continue;
      if (play.play_type === 'pass' || play.qb_dropback === 1) {
        const acc = teamSacks.get(play.posteam) || { sacks: 0, dropbacks: 0 };
        acc.dropbacks += 1;
        if (play.sack === 1) acc.sacks += 1;
        teamSacks.set(play.posteam, acc);
      }
      if (play.play_type === 'run' && play.rushing_yards != null) {
        const acc = teamRush.get(play.posteam) || { yards: 0, attempts: 0 };
        acc.yards += play.rushing_yards;
        acc.attempts += 1;
        teamRush.set(play.posteam, acc);
      }
    }
    const teamSackRate = new Map<string, number>();
    const teamRushYPC = new Map<string, number>();
    for (const [team, s] of teamSacks) {
      teamSackRate.set(team, s.dropbacks > 0 ? Math.round((s.sacks / s.dropbacks) * 1000) / 1000 : 0);
    }
    for (const [team, r] of teamRush) {
      teamRushYPC.set(team, r.attempts > 0 ? Math.round((r.yards / r.attempts) * 10) / 10 : 0);
    }

    // Dome games and bye weeks from games data
    const teamDomeGames = new Map<string, number>();
    const teamByeWeek = new Map<string, number>();
    const teamWeeksPlayed = new Map<string, number[]>();
    for (const g of (gamesRaw as any[])) {
      if (g.game_type !== 'REG' || g.season !== season) continue;
      if (g.roof === 'dome' || g.roof === 'closed') {
        teamDomeGames.set(g.home_team, (teamDomeGames.get(g.home_team) || 0) + 1);
      }
      for (const team of [g.home_team, g.away_team]) {
        if (!teamWeeksPlayed.has(team)) teamWeeksPlayed.set(team, []);
        teamWeeksPlayed.get(team)!.push(g.week);
      }
    }
    for (const [team, weeks] of teamWeeksPlayed) {
      const sorted = weeks.sort((a: number, b: number) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] - sorted[i - 1] > 1) {
          teamByeWeek.set(team, sorted[i - 1] + 1);
          break;
        }
      }
    }

    (data as any).environmentMaps = { teamDomeGames, teamByeWeek, teamSackRate, teamRushYPC };
  }

  // Routes from participation
  const participation = participationRaw as any[];
  if (participation.length > 0 && pbp.length > 0) {
    buildRoutes(participation, pbp, priorStats, data);
  }

  // Reddit sentiment data
  try {
    const fs = await import('fs');
    if (fs.existsSync('public/data/reddit_sentiment.json')) {
      const sentimentData = JSON.parse(fs.readFileSync('public/data/reddit_sentiment.json', 'utf-8'));
      const redditBuzz = new Map<string, any>();
      const redditWindowed = new Map<string, any>();
      for (const b of (sentimentData.preseasonBuzz || [])) {
        redditBuzz.set(`${normalizeName(b.player)}:${b.season}`, b);
      }
      for (const w of (sentimentData.windowedSentiment || [])) {
        if (w.week <= 4) {
          const key = `${normalizeName(w.player)}:${w.season}`;
          const existing = redditWindowed.get(key);
          if (!existing || w.week > (existing as any)._week) {
            redditWindowed.set(key, { ...w, _week: w.week });
          }
        }
      }
      (data as any).redditBuzz = redditBuzz;
      (data as any).redditWindowed = redditWindowed;
      log(`  Reddit sentiment: ${redditBuzz.size} buzz, ${redditWindowed.size} windowed`);
    }
  } catch { /* Reddit data not available */ }

  // Build player index — primary pass (ADP players)
  const players = new Map<PlayerKey, PlayerInfo>();
  const indexedNames = new Set<string>();
  for (const adp of (adpData as any[])) {
    if (!POSITIONS.includes(adp.position)) continue;
    if (adp.adp > 400) continue;
    const normalName = normalizeName(adp.name);
    const pk = makePlayerKey(normalName, season);
    const team = data.playerTeamMap.get(normalName) || adp.team || '';
    players.set(pk, {
      name: adp.name, normalName, position: adp.position,
      season, adp: adp.adp, team,
    });
    indexedNames.add(normalName);
  }

  // Second pass: drafted players without ADP (for career model completeness)
  if (data.draftByName.size > 0 && data.currentByName.size > 0) {
    for (const [draftName, draft] of data.draftByName) {
      if (!draft.pick) continue;
      const yearsFromDraft = season - (draft.season || season);
      if (yearsFromDraft < 0 || yearsFromDraft > 2) continue;
      if (!POSITIONS.includes(draft.position || '')) continue;
      if (indexedNames.has(draftName)) continue;
      const current = data.currentByName.get(draftName);
      if (!current || current.position !== draft.position) continue;

      const pk = makePlayerKey(draftName, season);
      const team = data.playerTeamMap.get(draftName) || current.recent_team || '';
      players.set(pk, {
        name: current.player_display_name || draftName,
        normalName: draftName,
        position: draft.position,
        season,
        adp: draft.pick, // proxy ADP
        team,
      });
      indexedNames.add(draftName);
    }
  }

  log(`  Player index: ${players.size} players (${indexedNames.size} unique)`);

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
    combineByName.set(normalizeName(c.player_name), c);
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

  // Prospect data
  const [prospectData] = await Promise.all([
    fetchDraftProspects().catch(() => []),
  ]);
  const prospectByName = new Map<string, any>();
  for (const p of prospectData) {
    const name = normalizeName(p.player_name);
    if (!prospectByName.has(name)) prospectByName.set(name, p);
  }

  // College analytics: dominator, breakout age, ZAP, teammate scores, etc.
  log('  Building college analytics...');
  const college = buildCollegeAnalytics(
    collegeStatsData, draftByName, collegeByName, prospectByName,
  );

  log(`  Static: ${combineByName.size} combine, ${draftByName.size} draft, ${collegeByName.size} college, ${college.collegeZapByName.size} ZAP`);

  return {
    combineByName,
    combineAvg,
    draftByName,
    collegeByName,
    collegeAdvancedByName: college.collegeAdvancedByName,
    collegeBestSeasonByName: college.collegeBestSeasonByName,
    collegeZapByName: college.collegeZapByName,
    collegePerGameByName: college.collegePerGameByName,
    teammateScoreByName: college.teammateScoreByName,
    speedScoreByName,
    collegeAvgByPos: college.collegeAvgByPos,
    prospectByName,
    collegeSOS: college.collegeSOS,
    playerHistoryMap: new Map(),
  };
}
