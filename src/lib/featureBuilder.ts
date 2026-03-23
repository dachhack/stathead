/**
 * featureBuilder.ts
 *
 * Standalone (no React) extraction of the ADP feature-building logic from
 * ADPFactorAnalysis.tsx. Used both at build time (scripts/build-features.ts)
 * and at runtime as a fallback when prebuilt-features.json is unavailable.
 */

import type {
  CombineResult, DraftPick, FfcADPPlayer, PlayerStats, SnapCount, Injury,
  NextGenStats, PlayByPlay, PbpParticipation, Roster, DepthChart, Game,
} from '../types';
import { aggregateToSeasonTotals } from '../data';
import { computePlayerProjectionFeatures } from './playerProjection';
import type { ScenarioConfig } from '../types';
import type { SeasonTotals } from '../types';

// ── Module-level constants ──────────────────────────────────────────────────

const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const REPLACEMENT_RANKS: Record<string, number> = { QB: 12, RB: 24, WR: 24, TE: 12 };

// ── Interfaces moved from component scope ───────────────────────────────────

interface VegasTeamAgg {
  impliedTotal: number; spread: number; gameTotal: number;
  actualPts: number; games: number; wins: number;
}

interface AdvAgg {
  targetShare: number; airYardsShare: number; wopr: number;
  racr: number; recAirYards: number; yac: number;
  receptions: number; targets: number;
  recEPA: number; rushEPA: number;
  weeks: number;
}

interface PbpAgg {
  totalAirYards: number; targets: number;
  deepTargets: number; rzTargets: number;
}

interface RouteAgg {
  routesRun: number;
  snaps11: number;
  snaps12: number;
  totalSnaps: number;
}

interface LocAgg { left: number; middle: number; right: number; total: number }

interface SchemeAgg {
  passes: number; rushes: number; plays: number; games: number;
  neutralPasses: number; neutralPlays: number;
  firstDownRuns: number; firstDownPlays: number;
  shotgunPlays: number; noHuddlePlays: number;
  rbTargets: number; teTargets: number; wrTargets: number; totalTargets: number;
}

interface PersonnelAgg {
  p11: number; p12: number; p13: number; p21: number;
  p22: number; p10: number; total: number;
  wr3plus: number; te2plus: number;
}

interface InjAgg { weeks: number; gamesOut: number; softTissue: boolean; knee: boolean }

interface TeamPosAgg {
  bestPPR: number;
  totalPPR: number;
  hasTop12: boolean;
  playerTargets: number[];
}

// ── Exported interfaces ─────────────────────────────────────────────────────

export interface PlayerRow {
  name: string;
  position: string;
  season: number;
  adp: number;
  vor: number;
  isHit: boolean;
  isBust: boolean;
  features: Record<string, number>;
}

export interface PredictionRow {
  name: string;
  position: string;
  team: string;
  adp: number;
  headshotUrl?: string;
  features: Record<string, number>;
}

export interface HistoricalSeasonData {
  season: number;
  adpData: FfcADPPlayer[];
  currentStats: PlayerStats[];
  priorStats: PlayerStats[];
  priorSnaps: SnapCount[];
  priorInjuries: Injury[];
  preseasonInjuries: Injury[];
  priorNgsRec: NextGenStats[];
  priorNgsRush: NextGenStats[];
  priorNgsPass: NextGenStats[];
  priorPbp: PlayByPlay[];
  priorParticipation: PbpParticipation[];
  seasonRosters: Roster[];
  priorRosters: Roster[];
  seasonDepthCharts: DepthChart[];
}

export interface PredictionSeasonData {
  /** The upcoming season year being predicted (e.g. 2026). */
  predictSeason?: number;
  adpData: FfcADPPlayer[];
  priorStats: PlayerStats[];
  priorSnaps: SnapCount[];
  priorInjuries: Injury[];
  preseasonInjuries: Injury[];
  priorNgsRec: NextGenStats[];
  priorNgsRush: NextGenStats[];
  priorNgsPass: NextGenStats[];
  priorPbp: PlayByPlay[];
  priorParticipation: PbpParticipation[];
  seasonRosters: Roster[];
  priorRosters: Roster[];
  seasonDepthCharts: DepthChart[];
  activeScenario?: ScenarioConfig;
}

export interface BuiltFeatures {
  allRows: PlayerRow[];
  vorNormParams: Record<string, { mean: number; std: number }>;
  predictionRows: PredictionRow[];
}

// ── Helper functions ────────────────────────────────────────────────────────

function normalizeName(name: string | null | undefined): string {
  if (!name) return '';
  return name.toLowerCase().replace(/[.']/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').replace(/\s+/g, ' ').trim();
}

function parseHeight(ht: string | number): number {
  if (typeof ht === 'number') return ht;
  const parts = String(ht).split('-');
  return parts.length === 2 ? Number(parts[0]) * 12 + Number(parts[1]) : 0;
}

function parsePersonnel(personnel: string): string {
  if (!personnel) return '';
  const rbMatch = personnel.match(/(\d+)\s*RB/i);
  const teMatch = personnel.match(/(\d+)\s*TE/i);
  const rb = rbMatch ? rbMatch[1] : '0';
  const te = teMatch ? teMatch[1] : '0';
  return `${rb}${te}`;
}

// ── Main exported function ──────────────────────────────────────────────────

export async function buildFeatures(
  seasons: HistoricalSeasonData[],
  combineData: CombineResult[],
  draftData: DraftPick[],
  gamesData: Game[],
  predData: PredictionSeasonData,
  onProgress?: (msg: string) => void,
): Promise<BuiltFeatures> {

  // Build lookup maps
  const combineByName = new Map<string, CombineResult>();
  for (const c of combineData) combineByName.set(normalizeName(c.player_name), c);

  const draftByName = new Map<string, DraftPick>();
  for (const d of draftData) draftByName.set(normalizeName(d.pfr_player_name), d);

  // Coach lookup: season → team → head coach name
  const coachBySeasonTeam = new Map<string, string>();
  for (const g of gamesData) {
    if (g.game_type !== 'REG') continue;
    if (g.home_coach) coachBySeasonTeam.set(`${g.season}:${g.home_team}`, g.home_coach);
    if (g.away_coach) coachBySeasonTeam.set(`${g.season}:${g.away_team}`, g.away_coach);
  }

  // Build Vegas implied totals per team-season from game lines
  const vegasBySeasonTeam = new Map<string, VegasTeamAgg>();
  for (const g of gamesData) {
    if (g.game_type !== 'REG') continue;
    const tl = g.total_line || 0;
    const sl = g.spread_line || 0;

    // Home team
    const homeKey = `${g.season}:${g.home_team}`;
    const homeAcc = vegasBySeasonTeam.get(homeKey) || {
      impliedTotal: 0, spread: 0, gameTotal: 0, actualPts: 0, games: 0, wins: 0,
    };
    if (tl > 0) {
      homeAcc.impliedTotal += (tl - sl) / 2;
      homeAcc.gameTotal += tl;
    }
    homeAcc.spread += sl;
    homeAcc.actualPts += g.home_score || 0;
    homeAcc.games += 1;
    if ((g.home_score || 0) > (g.away_score || 0)) homeAcc.wins += 1;
    vegasBySeasonTeam.set(homeKey, homeAcc);

    // Away team
    const awayKey = `${g.season}:${g.away_team}`;
    const awayAcc = vegasBySeasonTeam.get(awayKey) || {
      impliedTotal: 0, spread: 0, gameTotal: 0, actualPts: 0, games: 0, wins: 0,
    };
    if (tl > 0) {
      awayAcc.impliedTotal += (tl + sl) / 2;
      awayAcc.gameTotal += tl;
    }
    awayAcc.spread += -sl;
    awayAcc.actualPts += g.away_score || 0;
    awayAcc.games += 1;
    if ((g.away_score || 0) > (g.home_score || 0)) awayAcc.wins += 1;
    vegasBySeasonTeam.set(awayKey, awayAcc);
  }

  const rows: PlayerRow[] = [];

  // ── Per-season historical feature building ──────────────────────────────

  for (const seasonData of seasons) {
    const {
      season,
      adpData, currentStats, priorStats, priorSnaps,
      priorInjuries, preseasonInjuries,
      priorNgsRec, priorNgsRush, priorNgsPass,
      priorPbp, priorParticipation,
      seasonRosters, priorRosters, seasonDepthCharts,
    } = seasonData;

    onProgress?.(`Building features for ${season}...`);

    if (adpData.length === 0 || currentStats.length === 0) continue;

    // Current season totals + ranks
    const currentTotals = aggregateToSeasonTotals(
      currentStats.filter((s) => s.season_type === 'REG')
    );
    const allFantasy = currentTotals
      .filter((p) => POSITIONS.includes(p.position))
      .sort((a, b) => b.fantasy_points_ppr - a.fantasy_points_ppr);
    const overallRankMap = new Map<string, number>();
    allFantasy.forEach((p, i) => overallRankMap.set(normalizeName(p.player_display_name), i + 1));

    // Per-position replacement levels for VOR
    const vorReplacement: Record<string, number> = {};
    for (const pos of POSITIONS) {
      const sorted = currentTotals
        .filter((p) => p.position === pos)
        .sort((a, b) => (b.fantasy_points_ppr || 0) - (a.fantasy_points_ppr || 0));
      const idx = (REPLACEMENT_RANKS[pos] ?? 24) - 1;
      vorReplacement[pos] = Math.round((sorted[idx]?.fantasy_points_ppr ?? 0) * 10) / 10;
    }

    // Prior season totals
    const priorTotals = aggregateToSeasonTotals(
      priorStats.filter((s) => s.season_type === 'REG')
    );
    const priorByName = new Map<string, SeasonTotals>();
    for (const p of priorTotals) {
      if (POSITIONS.includes(p.position)) {
        priorByName.set(normalizeName(p.player_display_name), p);
      }
    }

    // Projection features
    const projFeatures = computePlayerProjectionFeatures(priorStats);

    // Prior snap %
    const snapAccum = new Map<string, { total: number; count: number }>();
    for (const s of priorSnaps) {
      if (!POSITIONS.includes(s.position)) continue;
      const name = normalizeName(s.player);
      const acc = snapAccum.get(name) || { total: 0, count: 0 };
      acc.total += s.offense_pct || 0;
      acc.count += 1;
      snapAccum.set(name, acc);
    }

    // Advanced weekly stats aggregation
    const advByName = new Map<string, AdvAgg>();
    const priorWeekly = priorStats.filter((s) => s.season_type === 'REG') as PlayerStats[];
    for (const w of priorWeekly) {
      if (!POSITIONS.includes(w.position)) continue;
      const name = normalizeName(w.player_display_name);
      const acc = advByName.get(name) || {
        targetShare: 0, airYardsShare: 0, wopr: 0, racr: 0,
        recAirYards: 0, yac: 0, receptions: 0, targets: 0,
        recEPA: 0, rushEPA: 0, weeks: 0,
      };
      acc.targetShare += w.target_share || 0;
      acc.airYardsShare += w.air_yards_share || 0;
      acc.wopr += w.wopr || 0;
      acc.recAirYards += w.receiving_air_yards || 0;
      acc.yac += w.receiving_yards_after_catch || 0;
      acc.receptions += w.receptions || 0;
      acc.targets += w.targets || 0;
      acc.recEPA += w.receiving_epa || 0;
      acc.rushEPA += w.rushing_epa || 0;
      if (w.racr && w.racr > 0) acc.racr += w.racr;
      acc.weeks += 1;
      advByName.set(name, acc);
    }

    // NGS season-level summaries
    const ngsRecByName = new Map<string, NextGenStats>();
    for (const n of priorNgsRec) {
      if (n.week === 0 && n.season_type === 'REG') {
        ngsRecByName.set(normalizeName(n.player_display_name), n);
      }
    }
    const ngsRushByName = new Map<string, NextGenStats>();
    for (const n of priorNgsRush) {
      if (n.week === 0 && n.season_type === 'REG') {
        ngsRushByName.set(normalizeName(n.player_display_name), n);
      }
    }
    const ngsPassByName = new Map<string, NextGenStats>();
    for (const n of priorNgsPass) {
      if (n.week === 0 && n.season_type === 'REG') {
        ngsPassByName.set(normalizeName(n.player_display_name), n);
      }
    }

    // PBP-derived: aDOT, deep target %, red zone target share
    const pbpByReceiver = new Map<string, PbpAgg>();
    const teamRZTargets = new Map<string, number>();

    for (const play of priorPbp) {
      if (play.play_type !== 'pass' || !play.receiver_player_name) continue;
      const recName = normalizeName(play.receiver_player_name);
      const acc = pbpByReceiver.get(recName) || {
        totalAirYards: 0, targets: 0, deepTargets: 0, rzTargets: 0,
      };
      acc.targets += 1;
      if (typeof play.air_yards === 'number' && !isNaN(play.air_yards)) {
        acc.totalAirYards += play.air_yards;
        if (play.air_yards >= 15) acc.deepTargets += 1;
      }
      if (play.yardline_100 <= 20) {
        acc.rzTargets += 1;
        const team = play.posteam || '';
        teamRZTargets.set(team, (teamRZTargets.get(team) || 0) + 1);
      }
      pbpByReceiver.set(recName, acc);
    }

    // Build GSIS ID → normalized name map from weekly stats
    const gsisToName = new Map<string, string>();
    for (const w of priorWeekly) {
      if (w.player_id && w.player_display_name) {
        gsisToName.set(w.player_id, normalizeName(w.player_display_name));
      }
    }

    // Participation-derived: routes run, YPRR, personnel splits
    const routesByName = new Map<string, RouteAgg>();
    const passPlayKeys = new Set<string>();
    for (const play of priorPbp) {
      if (play.qb_dropback === 1 || play.play_type === 'pass') {
        passPlayKeys.add(`${play.game_id}:${play.play_id}`);
      }
    }

    for (const part of priorParticipation) {
      if (!part.offense_players) continue;
      const gamePlayKey = `${part.nflverse_game_id}:${part.play_id}`;
      const altKey = `${part.old_game_id}:${part.play_id}`;
      const isPassPlay = passPlayKeys.has(gamePlayKey) || passPlayKeys.has(altKey);
      const personnel = parsePersonnel(part.offense_personnel || '');
      const offenseIds = part.offense_players.split(';');

      for (const gsisId of offenseIds) {
        const id = gsisId.trim();
        const name = gsisToName.get(id);
        if (!name) continue;
        const acc = routesByName.get(name) || {
          routesRun: 0, snaps11: 0, snaps12: 0, totalSnaps: 0,
        };
        acc.totalSnaps += 1;
        if (isPassPlay) acc.routesRun += 1;
        if (personnel === '11') acc.snaps11 += 1;
        else if (personnel === '12') acc.snaps12 += 1;
        routesByName.set(name, acc);
      }
    }

    // Pass location distribution per receiver from PBP
    const locByReceiver = new Map<string, LocAgg>();
    for (const play of priorPbp) {
      if (play.play_type !== 'pass' || !play.receiver_player_name || !play.pass_location) continue;
      const recName = normalizeName(play.receiver_player_name);
      const acc = locByReceiver.get(recName) || { left: 0, middle: 0, right: 0, total: 0 };
      acc.total += 1;
      if (play.pass_location === 'left') acc.left += 1;
      else if (play.pass_location === 'middle') acc.middle += 1;
      else if (play.pass_location === 'right') acc.right += 1;
      locByReceiver.set(recName, acc);
    }

    // Team scheme features from prior PBP
    const schemeByTeam = new Map<string, SchemeAgg>();
    const priorGamesByTeam = new Map<string, Set<string>>();
    for (const play of priorPbp) {
      if (!play.posteam || play.play_type === 'no_play') continue;
      const team = play.posteam;
      if (!priorGamesByTeam.has(team)) priorGamesByTeam.set(team, new Set());
      priorGamesByTeam.get(team)!.add(play.game_id);

      if (play.play_type !== 'pass' && play.play_type !== 'run') continue;
      const acc = schemeByTeam.get(team) || {
        passes: 0, rushes: 0, plays: 0, games: 0,
        neutralPasses: 0, neutralPlays: 0,
        firstDownRuns: 0, firstDownPlays: 0,
        shotgunPlays: 0, noHuddlePlays: 0,
        rbTargets: 0, teTargets: 0, wrTargets: 0, totalTargets: 0,
      };
      acc.plays += 1;
      if (play.play_type === 'pass' || play.qb_dropback === 1) acc.passes += 1;
      else acc.rushes += 1;

      const isNeutral = Math.abs(play.score_differential || 0) <= 7 && (play.qtr || 0) <= 3;
      if (isNeutral) {
        acc.neutralPlays += 1;
        if (play.play_type === 'pass' || play.qb_dropback === 1) acc.neutralPasses += 1;
      }
      if (play.down === 1) {
        acc.firstDownPlays += 1;
        if (play.play_type === 'run' && play.qb_dropback !== 1) acc.firstDownRuns += 1;
      }
      if (play.shotgun === 1) acc.shotgunPlays += 1;
      if (play.no_huddle === 1) acc.noHuddlePlays += 1;

      if (play.play_type === 'pass' && play.receiver_player_name) {
        acc.totalTargets += 1;
        const recName = normalizeName(play.receiver_player_name);
        const recPrior = priorByName.get(recName);
        if (recPrior?.position === 'RB') acc.rbTargets += 1;
        else if (recPrior?.position === 'TE') acc.teTargets += 1;
        else if (recPrior?.position === 'WR') acc.wrTargets += 1;
      }

      schemeByTeam.set(team, acc);
    }
    for (const [team, gameSet] of priorGamesByTeam) {
      const acc = schemeByTeam.get(team);
      if (acc) acc.games = gameSet.size;
    }

    // Team personnel grouping rates from PBP
    const personnelByTeam = new Map<string, PersonnelAgg>();
    for (const play of priorPbp) {
      if (!play.posteam || !play.offense_personnel) continue;
      if (play.play_type !== 'pass' && play.play_type !== 'run') continue;
      const team = play.posteam;
      const acc = personnelByTeam.get(team) || {
        p11: 0, p12: 0, p13: 0, p21: 0, p22: 0, p10: 0, total: 0,
        wr3plus: 0, te2plus: 0,
      };
      acc.total += 1;

      const pers = play.offense_personnel;
      const rbMatch = pers.match(/(\d+)\s*RB/i);
      const teMatch = pers.match(/(\d+)\s*TE/i);
      const wrMatch = pers.match(/(\d+)\s*WR/i);
      const rb = rbMatch ? Number(rbMatch[1]) : 0;
      const te = teMatch ? Number(teMatch[1]) : 0;
      const wr = wrMatch ? Number(wrMatch[1]) : 0;

      const grouping = `${rb}${te}`;
      if (grouping === '11') acc.p11 += 1;
      else if (grouping === '12') acc.p12 += 1;
      else if (grouping === '13') acc.p13 += 1;
      else if (grouping === '21') acc.p21 += 1;
      else if (grouping === '22') acc.p22 += 1;
      else if (grouping === '10') acc.p10 += 1;

      if (wr >= 3) acc.wr3plus += 1;
      if (te >= 2) acc.te2plus += 1;

      personnelByTeam.set(team, acc);
    }

    // Coach change detection
    const coachChangeTeams = new Set<string>();
    for (const [key, coach] of coachBySeasonTeam) {
      const [szn, team] = key.split(':');
      if (Number(szn) === season) {
        const priorCoach = coachBySeasonTeam.get(`${season - 1}:${team}`);
        if (priorCoach && priorCoach !== coach) coachChangeTeams.add(team);
      }
    }

    const coachPriorTeamPPR = new Map<string, number>();
    for (const p of priorTotals) {
      if (!POSITIONS.includes(p.position)) continue;
      const team = p.recent_team || '';
      coachPriorTeamPPR.set(team, (coachPriorTeamPPR.get(team) || 0) + (p.fantasy_points_ppr || 0));
    }

    // Prior-season injury aggregation
    const SOFT_TISSUE = /hamstring|groin|calf|quad|hip|thigh|achilles|ankle|foot|toe/i;
    const KNEE = /knee|acl|mcl|pcl|meniscus/i;

    const priorInjByName = new Map<string, InjAgg>();
    for (const inj of priorInjuries) {
      if (!POSITIONS.includes(inj.position)) continue;
      const name = normalizeName(inj.full_name);
      const acc = priorInjByName.get(name) || { weeks: 0, gamesOut: 0, softTissue: false, knee: false };
      acc.weeks += 1;
      if (inj.report_status === 'Out' || inj.report_status === 'Doubtful') acc.gamesOut += 1;
      const allInjText = `${inj.report_primary_injury || ''} ${inj.report_secondary_injury || ''} ${inj.practice_primary_injury || ''} ${inj.practice_secondary_injury || ''}`;
      if (SOFT_TISSUE.test(allInjText)) acc.softTissue = true;
      if (KNEE.test(allInjText)) acc.knee = true;
      priorInjByName.set(name, acc);
    }

    const preseasonInjByName = new Map<string, { injured: boolean; weeks: number }>();
    for (const inj of preseasonInjuries) {
      if (!POSITIONS.includes(inj.position)) continue;
      const isPre = inj.game_type === 'PRE' || inj.week <= 0;
      if (!isPre) continue;
      const name = normalizeName(inj.full_name);
      const acc = preseasonInjByName.get(name) || { injured: false, weeks: 0 };
      acc.weeks += 1;
      if (inj.report_status === 'Out' || inj.report_status === 'Doubtful' || inj.report_status === 'Questionable') {
        acc.injured = true;
      }
      preseasonInjByName.set(name, acc);
    }

    // Current stats lookup
    const currentByName = new Map<string, SeasonTotals>();
    for (const p of currentTotals) {
      if (POSITIONS.includes(p.position)) {
        currentByName.set(normalizeName(p.player_display_name), p);
      }
    }

    // Roster competition features
    const rosterByTeamPos = new Map<string, Set<string>>();
    const playerTeamMap = new Map<string, string>();
    for (const r of seasonRosters) {
      if (!POSITIONS.includes(r.position) || r.status === 'Inactive') continue;
      const key = `${r.team}:${r.position}`;
      if (!rosterByTeamPos.has(key)) rosterByTeamPos.set(key, new Set());
      const name = normalizeName(r.full_name);
      rosterByTeamPos.get(key)!.add(name);
      playerTeamMap.set(name, r.team);
    }

    const priorRosterByTeamPos = new Map<string, Set<string>>();
    for (const r of priorRosters) {
      if (!POSITIONS.includes(r.position)) continue;
      const key = `${r.team}:${r.position}`;
      if (!priorRosterByTeamPos.has(key)) priorRosterByTeamPos.set(key, new Set());
      priorRosterByTeamPos.get(key)!.add(normalizeName(r.full_name));
    }

    // Depth chart rank
    const depthRankByName = new Map<string, number>();
    const dcLatest = new Map<string, DepthChart>();
    for (const dc of seasonDepthCharts) {
      const name = normalizeName(dc.player_name);
      const key = `${dc.team}:${dc.pos_abb}:${name}`;
      const existing = dcLatest.get(key);
      if (!existing || dc.dt > existing.dt) dcLatest.set(key, dc);
    }
    for (const dc of dcLatest.values()) {
      depthRankByName.set(normalizeName(dc.player_name), dc.pos_rank || dc.pos_slot || 99);
    }

    // Prior team touch totals
    const teamTotalCarries = new Map<string, number>();
    const teamTotalTargets = new Map<string, number>();
    for (const p of priorTotals) {
      if (!POSITIONS.includes(p.position)) continue;
      const team = p.recent_team || '';
      if (!team) continue;
      teamTotalCarries.set(team, (teamTotalCarries.get(team) || 0) + (p.carries || 0));
      teamTotalTargets.set(team, (teamTotalTargets.get(team) || 0) + (p.targets || 0));
    }

    // Prior season PPR by name + position
    const priorPPRByName = new Map<string, number>();
    const priorPosByName = new Map<string, string>();
    for (const p of priorTotals) {
      if (POSITIONS.includes(p.position)) {
        const name = normalizeName(p.player_display_name);
        priorPPRByName.set(name, p.fantasy_points_ppr || 0);
        priorPosByName.set(name, p.position);
      }
    }

    // Positional rankings from prior season
    const posPriorRanks = new Map<string, Map<string, number>>();
    for (const pos of POSITIONS) {
      const posPlayers = priorTotals
        .filter((p) => p.position === pos)
        .sort((a, b) => (b.fantasy_points_ppr || 0) - (a.fantasy_points_ppr || 0));
      const rankMap = new Map<string, number>();
      posPlayers.forEach((p, i) => rankMap.set(normalizeName(p.player_display_name), i + 1));
      posPriorRanks.set(pos, rankMap);
    }

    // Team-level PPR aggregations by position
    const teamPosAgg = new Map<string, TeamPosAgg>();
    for (const [key, names] of rosterByTeamPos) {
      const [, pos] = key.split(':');
      const agg: TeamPosAgg = { bestPPR: 0, totalPPR: 0, hasTop12: false, playerTargets: [] };
      for (const name of names) {
        const ppr = priorPPRByName.get(name) || 0;
        if (ppr > agg.bestPPR) agg.bestPPR = ppr;
        agg.totalPPR += ppr;
        const rank = posPriorRanks.get(pos)?.get(name) || 999;
        if (rank <= 12) agg.hasTop12 = true;
        const priorP = priorTotals.find((p) => normalizeName(p.player_display_name) === name && p.position === pos);
        if (priorP) agg.playerTargets.push(priorP.targets || 0);
      }
      teamPosAgg.set(key, agg);
    }

    // Team-level pass catcher aggregation
    const teamPassCatcherPPR = new Map<string, number>();
    const teamElitePassCatchers = new Map<string, number>();
    for (const [key, names] of rosterByTeamPos) {
      const [pcTeam, pos] = key.split(':');
      if (pos !== 'WR' && pos !== 'TE') continue;
      for (const name of names) {
        const ppr = priorPPRByName.get(name) || 0;
        teamPassCatcherPPR.set(pcTeam, (teamPassCatcherPPR.get(pcTeam) || 0) + ppr);
        const rank = posPriorRanks.get(pos)?.get(name) || 999;
        if (rank <= 24) teamElitePassCatchers.set(pcTeam, (teamElitePassCatchers.get(pcTeam) || 0) + 1);
      }
    }

    // Target HHI per team
    const teamTargetHHI = new Map<string, number>();
    for (const team of new Set([...teamTotalTargets.keys()])) {
      const totalTgts = teamTotalTargets.get(team) || 1;
      let hhi = 0;
      for (const p of priorTotals) {
        if ((p.recent_team || '') !== team || !POSITIONS.includes(p.position)) continue;
        const share = (p.targets || 0) / totalTgts;
        hhi += share * share;
      }
      teamTargetHHI.set(team, Math.round(hhi * 1000) / 1000);
    }

    // New arrival quality
    const newArrivalBestPPR = new Map<string, number>();
    for (const [key, names] of rosterByTeamPos) {
      const priorNames = priorRosterByTeamPos.get(key);
      let best = 0;
      for (const name of names) {
        if (priorNames && priorNames.has(name)) continue;
        const ppr = priorPPRByName.get(name) || 0;
        if (ppr > best) best = ppr;
      }
      newArrivalBestPPR.set(key, Math.round(best * 10) / 10);
    }

    // New arrival ADP
    const adpByName = new Map<string, number>();
    for (const a of adpData) adpByName.set(normalizeName(a.name), a.adp);
    const newArrivalBestADP = new Map<string, number>();
    for (const [key, names] of rosterByTeamPos) {
      const priorNames = priorRosterByTeamPos.get(key);
      let bestAdp = 999;
      for (const name of names) {
        if (priorNames && priorNames.has(name)) continue;
        const adp2 = adpByName.get(name) || 999;
        if (adp2 < bestAdp) bestAdp = adp2;
      }
      newArrivalBestADP.set(key, bestAdp < 999 ? bestAdp : 0);
    }

    // Draft picks for this season
    const draftPicksBySeason = draftData.filter((d) => d.season === season);
    const teamDraftedPos = new Map<string, { count: number; bestPick: number }>();
    for (const d of draftPicksBySeason) {
      const pos = d.position || '';
      if (!POSITIONS.includes(pos)) continue;
      const key = `${d.team}:${pos}`;
      const existing = teamDraftedPos.get(key) || { count: 0, bestPick: 300 };
      existing.count += 1;
      existing.bestPick = Math.min(existing.bestPick, d.pick || 300);
      teamDraftedPos.set(key, existing);
    }

    // Join ADP with outcomes
    for (const adpPlayer of adpData) {
      if (!POSITIONS.includes(adpPlayer.position)) continue;
      if (adpPlayer.adp > 200) continue;

      const normalName = normalizeName(adpPlayer.name);
      const current = currentByName.get(normalName);
      if (!current || current.position !== adpPlayer.position) continue;

      const playerPPR = current.fantasy_points_ppr || 0;
      const repLevel  = vorReplacement[adpPlayer.position] ?? 0;
      const vor  = Math.round((playerPPR - repLevel) * 10) / 10;

      const prior = priorByName.get(normalName);
      const combine = combineByName.get(normalName);
      const draft = draftByName.get(normalName);
      const snapAcc = snapAccum.get(normalName);
      const snapPct = snapAcc && snapAcc.count > 0 ? snapAcc.total / snapAcc.count : 0;

      const heightIn = combine?.ht ? parseHeight(combine.ht) : 0;
      const wt = combine?.wt || 0;
      const bmi = heightIn > 0 && wt > 0 ? (703 * wt) / (heightIn * heightIn) : 0;

      const priorGames = prior?.games || 0;
      const priorPPR = prior?.fantasy_points_ppr || 0;
      const priorAttempts = prior?.attempts || 0;
      const priorCarries = prior?.carries || 0;

      const draftAge = draft?.age || 0;
      const draftYear = draft?.season || 0;
      const age = draftAge > 0 && draftYear > 0 ? draftAge + (season - draftYear) : 0;

      const adv = advByName.get(normalName);
      const advWeeks = adv?.weeks || 1;
      const avgTargetShare = adv ? adv.targetShare / advWeeks : 0;
      const avgAirYardsShare = adv ? adv.airYardsShare / advWeeks : 0;
      const avgWOPR = adv ? adv.wopr / advWeeks : 0;
      const avgRACR = adv && advWeeks > 0 ? adv.racr / advWeeks : 0;
      const yacPerRec = adv && adv.receptions > 0 ? adv.yac / adv.receptions : 0;
      const airYardsPerTarget = adv && adv.targets > 0 ? adv.recAirYards / adv.targets : 0;

      const pbp = pbpByReceiver.get(normalName);
      const adot = pbp && pbp.targets > 0 ? pbp.totalAirYards / pbp.targets : 0;
      const deepPct = pbp && pbp.targets > 0 ? pbp.deepTargets / pbp.targets : 0;
      const playerTeam = prior?.recent_team || '';
      const teamRZ = teamRZTargets.get(playerTeam) || 1;
      const rzTargetShare = pbp ? pbp.rzTargets / teamRZ : 0;

      const ngsRec = ngsRecByName.get(normalName);
      const ngsRush = ngsRushByName.get(normalName);
      const ngsPass = ngsPassByName.get(normalName);

      // Roster competition features
      const playerTeam2 = playerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
      const posKey = `${playerTeam2}:${adpPlayer.position}`;
      const teammates = rosterByTeamPos.get(posKey);
      const samePosCount = teammates ? teammates.size - (teammates.has(normalName) ? 1 : 0) : 0;
      const priorTeammates = priorRosterByTeamPos.get(posKey);
      const newArrivals = teammates && priorTeammates
        ? [...teammates].filter((n) => n !== normalName && !priorTeammates.has(n)).length
        : 0;
      const draftedInfo = teamDraftedPos.get(posKey);
      const priorTeamCarries = teamTotalCarries.get(playerTeam2) || 1;
      const priorTeamTargets2 = teamTotalTargets.get(playerTeam2) || 1;
      const playerTouchShare = adpPlayer.position === 'RB'
        ? (prior?.carries || 0) / priorTeamCarries
        : (prior?.targets || 0) / priorTeamTargets2;
      const playerTargetShareTeam = (prior?.targets || 0) / priorTeamTargets2;
      let bestTeammatePPR = 0;
      if (teammates) {
        for (const tmName of teammates) {
          if (tmName === normalName) continue;
          const tmPPR = priorPPRByName.get(tmName) || 0;
          if (tmPPR > bestTeammatePPR) bestTeammatePPR = tmPPR;
        }
      }

      // Coaching & scheme features
      const pTeam = playerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
      const scheme = schemeByTeam.get(pTeam);
      const totalPlays = scheme?.plays || 1;
      const totalGames = scheme?.games || 1;

      // Personnel & positional usage features
      const pTeam2 = playerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
      const pers = personnelByTeam.get(pTeam2);
      const persTotal = pers?.total || 1;
      const sch = schemeByTeam.get(pTeam2);
      const schGames = sch?.games || 1;
      const schTotalTgts = sch?.totalTargets || 1;

      // Vegas features
      const vTeam = playerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
      const vKey = `${season - 1}:${vTeam}`;
      const v = vegasBySeasonTeam.get(vKey);
      const vGames = v?.games || 1;

      // Projection features
      const pf = projFeatures.get(normalName);

      const features: Record<string, number> = {
        adp: adpPlayer.adp,
        adpRound: Math.ceil(adpPlayer.adp / 12),
        age,
        yearsInLeague: draft ? season - draft.season : 0,
        nflDraftRound: draft?.round || 8,
        nflDraftPick: draft?.pick || 300,
        weight: wt,
        forty: combine?.forty || 0,
        bmi: Math.round(bmi * 10) / 10,
        priorPassYards: prior?.passing_yards || 0,
        priorPassTDs: prior?.passing_tds || 0,
        priorINTs: prior?.interceptions || 0,
        priorPassYPA: priorAttempts > 0 ? Math.round((prior?.passing_yards || 0) / priorAttempts * 10) / 10 : 0,
        priorQBRating: 0,
        priorRushYards: prior?.rushing_yards || 0,
        priorRushTDs: prior?.rushing_tds || 0,
        priorYPC: priorCarries > 0 ? Math.round((prior?.rushing_yards || 0) / priorCarries * 10) / 10 : 0,
        priorCarries: priorCarries,
        priorTargets: prior?.targets || 0,
        priorReceptions: prior?.receptions || 0,
        priorRecYards: prior?.receiving_yards || 0,
        priorRecTDs: prior?.receiving_tds || 0,
        priorYPR: (prior?.receptions || 0) > 0
          ? Math.round((prior?.receiving_yards || 0) / (prior?.receptions || 1) * 10) / 10
          : 0,
        priorTargetShare: Math.round(avgTargetShare * 1000) / 1000,
        priorAirYardsShare: Math.round(avgAirYardsShare * 1000) / 1000,
        priorWOPR: Math.round(avgWOPR * 1000) / 1000,
        priorRACR: Math.round(avgRACR * 100) / 100,
        priorYACperRec: Math.round(yacPerRec * 10) / 10,
        priorAirYardsPerTarget: Math.round(airYardsPerTarget * 10) / 10,
        priorRecEPA: Math.round((adv?.recEPA || 0) * 10) / 10,
        priorRushEPA: Math.round((adv?.rushEPA || 0) * 10) / 10,
        priorADOT: Math.round(adot * 10) / 10,
        priorDeepTargetPct: Math.round(deepPct * 1000) / 1000,
        priorRZTargetShare: Math.round(rzTargetShare * 1000) / 1000,
        priorSeparation: ngsRec?.avg_separation || 0,
        priorCushion: ngsRec?.avg_cushion || 0,
        priorYACAboveExp: ngsRec?.avg_yac_above_expectation || 0,
        priorCatchPct: ngsRec?.catch_percentage || 0,
        priorIntendedAirYardShare: ngsRec?.percent_share_of_intended_air_yards || 0,
        priorRYOEperAtt: ngsRush?.rush_yards_over_expected_per_att || 0,
        priorRushEfficiency: ngsRush?.efficiency || 0,
        priorPctVs8Defenders: ngsRush?.percent_attempts_gte_eight_defenders || 0,
        priorCPOE: ngsPass?.completion_percentage_above_expectation || 0,
        priorTimeToThrow: ngsPass?.avg_time_to_throw || 0,
        priorAggressiveness: ngsPass?.aggressiveness || 0,
        priorYPRR: (() => {
          const rt = routesByName.get(normalName);
          return rt && rt.routesRun > 0
            ? Math.round(((prior?.receiving_yards || 0) / rt.routesRun) * 100) / 100
            : 0;
        })(),
        priorRoutesRun: routesByName.get(normalName)?.routesRun || 0,
        priorTargetsPerRoute: (() => {
          const rt = routesByName.get(normalName);
          return rt && rt.routesRun > 0
            ? Math.round(((prior?.targets || 0) / rt.routesRun) * 1000) / 1000
            : 0;
        })(),
        priorPct11Personnel: (() => {
          const rt = routesByName.get(normalName);
          return rt && rt.totalSnaps > 0
            ? Math.round((rt.snaps11 / rt.totalSnaps) * 1000) / 1000
            : 0;
        })(),
        priorPct12Personnel: (() => {
          const rt = routesByName.get(normalName);
          return rt && rt.totalSnaps > 0
            ? Math.round((rt.snaps12 / rt.totalSnaps) * 1000) / 1000
            : 0;
        })(),
        priorPassLocationLeft: (() => {
          const loc = locByReceiver.get(normalName);
          return loc && loc.total > 0 ? Math.round((loc.left / loc.total) * 1000) / 1000 : 0;
        })(),
        priorPassLocationMiddle: (() => {
          const loc = locByReceiver.get(normalName);
          return loc && loc.total > 0 ? Math.round((loc.middle / loc.total) * 1000) / 1000 : 0;
        })(),
        priorPPR: Math.round(priorPPR * 10) / 10,
        priorPPG: priorGames > 0 ? Math.round(priorPPR / priorGames * 10) / 10 : 0,
        priorGames,
        priorGamesMissed: prior ? Math.max(0, 17 - priorGames) : 0,
        priorTotalTouches: priorCarries + (prior?.receptions || 0),
        priorSnapPct: Math.round(snapPct * 10) / 10,
        priorInjuryWeeks: priorInjByName.get(normalName)?.weeks || 0,
        priorGamesOut: priorInjByName.get(normalName)?.gamesOut || 0,
        preseasonInjured: preseasonInjByName.get(normalName)?.injured ? 1 : 0,
        preseasonInjWeeks: preseasonInjByName.get(normalName)?.weeks || 0,
        priorSoftTissue: priorInjByName.get(normalName)?.softTissue ? 1 : 0,
        priorKneeInjury: priorInjByName.get(normalName)?.knee ? 1 : 0,
        // Roster competition
        teamSamePosCount: samePosCount,
        depthChartRank: depthRankByName.get(normalName) || 99,
        priorTeamTouchShare: Math.round(playerTouchShare * 1000) / 1000,
        priorTeamTargetShare: Math.round(playerTargetShareTeam * 1000) / 1000,
        newSamePosAdded: newArrivals,
        teamDraftedSamePos: draftedInfo ? draftedInfo.count : 0,
        draftCapitalSamePos: draftedInfo ? Math.max(0, 8 - Math.ceil(draftedInfo.bestPick / 32)) : 0,
        teammatePriorPPR: Math.round(bestTeammatePPR * 10) / 10,
        teamWRElitePPR: Math.round((teamPosAgg.get(`${playerTeam2}:WR`)?.bestPPR || 0) * 10) / 10,
        teamWRTop12: (teamPosAgg.get(`${playerTeam2}:WR`)?.hasTop12 || false) ? 1 : 0,
        teamWRTotalPPR: Math.round((teamPosAgg.get(`${playerTeam2}:WR`)?.totalPPR || 0) * 10) / 10,
        teamTEElitePPR: Math.round((teamPosAgg.get(`${playerTeam2}:TE`)?.bestPPR || 0) * 10) / 10,
        teamRBElitePPR: Math.round((teamPosAgg.get(`${playerTeam2}:RB`)?.bestPPR || 0) * 10) / 10,
        teamRBTop12: (teamPosAgg.get(`${playerTeam2}:RB`)?.hasTop12 || false) ? 1 : 0,
        teamPassCatcherPPR: Math.round((teamPassCatcherPPR.get(playerTeam2) || 0) * 10) / 10,
        teamElitePassCatchers: teamElitePassCatchers.get(playerTeam2) || 0,
        teamTargetHHI: teamTargetHHI.get(playerTeam2) || 0,
        newArrivalBestPPR: newArrivalBestPPR.get(posKey) || 0,
        newArrivalBestADP: newArrivalBestADP.get(posKey) || 0,
        // Coaching & scheme
        newHeadCoach: coachChangeTeams.has(pTeam) ? 1 : 0,
        coachPriorTeamPPR: Math.round((coachPriorTeamPPR.get(pTeam) || 0) * 10) / 10,
        teamPassRate: scheme ? Math.round((scheme.passes / totalPlays) * 1000) / 1000 : 0,
        teamNeutralPassRate: scheme && scheme.neutralPlays > 0
          ? Math.round((scheme.neutralPasses / scheme.neutralPlays) * 1000) / 1000 : 0,
        teamPace: scheme ? Math.round((totalPlays / totalGames) * 10) / 10 : 0,
        teamFirstDownRunRate: scheme && scheme.firstDownPlays > 0
          ? Math.round((scheme.firstDownRuns / scheme.firstDownPlays) * 1000) / 1000 : 0,
        teamShotgunRate: scheme ? Math.round((scheme.shotgunPlays / totalPlays) * 1000) / 1000 : 0,
        teamNoHuddleRate: scheme ? Math.round((scheme.noHuddlePlays / totalPlays) * 1000) / 1000 : 0,
        teamRBTargetRate: scheme && scheme.totalTargets > 0
          ? Math.round((scheme.rbTargets / scheme.totalTargets) * 1000) / 1000 : 0,
        // Personnel & positional usage
        team11Rate: pers ? Math.round((pers.p11 / persTotal) * 1000) / 1000 : 0,
        team12Rate: pers ? Math.round((pers.p12 / persTotal) * 1000) / 1000 : 0,
        team13Rate: pers ? Math.round((pers.p13 / persTotal) * 1000) / 1000 : 0,
        team21Rate: pers ? Math.round((pers.p21 / persTotal) * 1000) / 1000 : 0,
        team22Rate: pers ? Math.round((pers.p22 / persTotal) * 1000) / 1000 : 0,
        team10Rate: pers ? Math.round((pers.p10 / persTotal) * 1000) / 1000 : 0,
        teamTETargetRate: sch ? Math.round((sch.teTargets / schTotalTgts) * 1000) / 1000 : 0,
        teamWRTargetRate: sch ? Math.round((sch.wrTargets / schTotalTgts) * 1000) / 1000 : 0,
        teamTETargetsPerGame: sch ? Math.round((sch.teTargets / schGames) * 10) / 10 : 0,
        teamRBTargetsPerGame: sch ? Math.round((sch.rbTargets / schGames) * 10) / 10 : 0,
        teamWR3PlusOnField: pers ? Math.round((pers.wr3plus / persTotal) * 1000) / 1000 : 0,
        team2PlusTEOnField: pers ? Math.round((pers.te2plus / persTotal) * 1000) / 1000 : 0,
        // Vegas
        vegasImpliedTotal: v ? Math.round((v.impliedTotal / vGames) * 10) / 10 : 0,
        vegasImpliedSpread: v ? Math.round((v.spread / vGames) * 10) / 10 : 0,
        vegasGameTotal: v ? Math.round((v.gameTotal / vGames) * 10) / 10 : 0,
        vegasWinPct: v ? Math.round((v.wins / vGames) * 1000) / 1000 : 0,
        vegasActualPtsPerGame: v ? Math.round((v.actualPts / vGames) * 10) / 10 : 0,
        // Projection
        projTeamPassAtt:      pf?.projTeamPassAtt      ?? 0,
        projTeamPassVolChg:   pf?.projTeamPassVolChg    ?? 0,
        projPlayerPPR:        pf?.projPlayerPPR         ?? 0,
        projPlayerVsExpected: pf?.projPlayerVsExpected  ?? 0,
        projTargetShare:      pf?.projTargetShare        ?? 0,
      };

      rows.push({
        name: adpPlayer.name,
        position: adpPlayer.position,
        season,
        adp: adpPlayer.adp,
        vor,
        isHit: vor >= 0,
        isBust: vor < -50,
        features,
      });
    }
  }

  // ── Standardize VOR per position (z-score) ──────────────────────────────
  const vorNorm = new Map<string, { mean: number; std: number }>();
  for (const pos of POSITIONS) {
    const vals = rows.filter((r) => r.position === pos).map((r) => r.vor);
    if (vals.length < 4) continue;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
    const std = Math.sqrt(variance) || 1;
    vorNorm.set(pos, { mean, std });
    for (const row of rows) {
      if (row.position === pos) {
        row.vor = Math.round((row.vor - mean) / std * 100) / 100;
      }
    }
  }

  // ── Build prediction rows ────────────────────────────────────────────────

  const predRows: PredictionRow[] = [];

  const {
    adpData: predAdpData,
    priorStats: predPriorStats,
    priorSnaps: predPriorSnaps,
    priorInjuries: predPriorInjuries,
    preseasonInjuries: predPreseasonInjuries,
    priorNgsRec: predPriorNgsRec,
    priorNgsRush: predPriorNgsRush,
    priorNgsPass: predPriorNgsPass,
    priorPbp: predPriorPbp,
    priorParticipation: predPriorParticipation,
    seasonRosters: predSeasonRosters,
    priorRosters: predPriorRosters,
    seasonDepthCharts: predSeasonDepthCharts,
    activeScenario,
  } = predData;

  // Use explicitly provided season, or fall back to next calendar year
  const predSeason = predData.predictSeason || new Date().getFullYear() + 1;
  const priorSeasonPred = predSeason - 1;

  onProgress?.(`Building ${predSeason} prediction features...`);

  if (predAdpData.length > 0) {
    // Prior season totals
    const predPriorTotals = aggregateToSeasonTotals(
      predPriorStats.filter((s) => s.season_type === 'REG')
    );
    const predPriorByName = new Map<string, SeasonTotals>();
    for (const p of predPriorTotals) {
      if (POSITIONS.includes(p.position)) {
        predPriorByName.set(normalizeName(p.player_display_name), p);
      }
    }

    // Projection features for prediction season
    const predProjFeatures = computePlayerProjectionFeatures(predPriorStats, activeScenario);

    // Snap %
    const predSnapAccum = new Map<string, { total: number; count: number }>();
    for (const s of predPriorSnaps) {
      if (!POSITIONS.includes(s.position)) continue;
      const name = normalizeName(s.player);
      const acc = predSnapAccum.get(name) || { total: 0, count: 0 };
      acc.total += s.offense_pct || 0;
      acc.count += 1;
      predSnapAccum.set(name, acc);
    }

    // Advanced weekly stats
    const predAdvByName = new Map<string, AdvAgg>();
    const predPriorWeekly = predPriorStats.filter((s) => s.season_type === 'REG') as PlayerStats[];
    for (const w of predPriorWeekly) {
      if (!POSITIONS.includes(w.position)) continue;
      const name = normalizeName(w.player_display_name);
      const acc = predAdvByName.get(name) || {
        targetShare: 0, airYardsShare: 0, wopr: 0, racr: 0,
        recAirYards: 0, yac: 0, receptions: 0, targets: 0,
        recEPA: 0, rushEPA: 0, weeks: 0,
      };
      acc.targetShare += w.target_share || 0;
      acc.airYardsShare += w.air_yards_share || 0;
      acc.wopr += w.wopr || 0;
      acc.recAirYards += w.receiving_air_yards || 0;
      acc.yac += w.receiving_yards_after_catch || 0;
      acc.receptions += w.receptions || 0;
      acc.targets += w.targets || 0;
      acc.recEPA += w.receiving_epa || 0;
      acc.rushEPA += w.rushing_epa || 0;
      if (w.racr && w.racr > 0) acc.racr += w.racr;
      acc.weeks += 1;
      predAdvByName.set(name, acc);
    }

    // NGS season-level
    const predNgsRecByName = new Map<string, NextGenStats>();
    for (const n of predPriorNgsRec) {
      if (n.week === 0 && n.season_type === 'REG') predNgsRecByName.set(normalizeName(n.player_display_name), n);
    }
    const predNgsRushByName = new Map<string, NextGenStats>();
    for (const n of predPriorNgsRush) {
      if (n.week === 0 && n.season_type === 'REG') predNgsRushByName.set(normalizeName(n.player_display_name), n);
    }
    const predNgsPassByName = new Map<string, NextGenStats>();
    for (const n of predPriorNgsPass) {
      if (n.week === 0 && n.season_type === 'REG') predNgsPassByName.set(normalizeName(n.player_display_name), n);
    }

    // PBP-derived
    const predPbpByReceiver = new Map<string, PbpAgg>();
    const predTeamRZTargets = new Map<string, number>();
    for (const play of predPriorPbp) {
      if (play.play_type !== 'pass' || !play.receiver_player_name) continue;
      const recName = normalizeName(play.receiver_player_name);
      const acc = predPbpByReceiver.get(recName) || { totalAirYards: 0, targets: 0, deepTargets: 0, rzTargets: 0 };
      acc.targets += 1;
      if (typeof play.air_yards === 'number' && !isNaN(play.air_yards)) {
        acc.totalAirYards += play.air_yards;
        if (play.air_yards >= 15) acc.deepTargets += 1;
      }
      if (play.yardline_100 <= 20) {
        acc.rzTargets += 1;
        const team = play.posteam || '';
        predTeamRZTargets.set(team, (predTeamRZTargets.get(team) || 0) + 1);
      }
      predPbpByReceiver.set(recName, acc);
    }

    // Participation-derived
    const predGsisToName = new Map<string, string>();
    for (const w of predPriorWeekly) {
      if (w.player_id && w.player_display_name) predGsisToName.set(w.player_id, normalizeName(w.player_display_name));
    }
    const predRoutesByName = new Map<string, RouteAgg>();
    const predPassPlayKeys = new Set<string>();
    for (const play of predPriorPbp) {
      if (play.qb_dropback === 1 || play.play_type === 'pass') predPassPlayKeys.add(`${play.game_id}:${play.play_id}`);
    }
    for (const part of predPriorParticipation) {
      if (!part.offense_players) continue;
      const gamePlayKey = `${part.nflverse_game_id}:${part.play_id}`;
      const altKey = `${part.old_game_id}:${part.play_id}`;
      const isPassPlay = predPassPlayKeys.has(gamePlayKey) || predPassPlayKeys.has(altKey);
      const personnel = (() => {
        const p = part.offense_personnel || '';
        const rbMatch = p.match(/(\d+)\s*RB/i);
        const teMatch = p.match(/(\d+)\s*TE/i);
        return `${rbMatch ? rbMatch[1] : '0'}${teMatch ? teMatch[1] : '0'}`;
      })();
      const offenseIds = part.offense_players.split(';');
      for (const gsisId of offenseIds) {
        const id = gsisId.trim();
        const name = predGsisToName.get(id);
        if (!name) continue;
        const acc = predRoutesByName.get(name) || { routesRun: 0, snaps11: 0, snaps12: 0, totalSnaps: 0 };
        acc.totalSnaps += 1;
        if (isPassPlay) acc.routesRun += 1;
        if (personnel === '11') acc.snaps11 += 1;
        else if (personnel === '12') acc.snaps12 += 1;
        predRoutesByName.set(name, acc);
      }
    }

    // Pass location
    const predLocByReceiver = new Map<string, LocAgg>();
    for (const play of predPriorPbp) {
      if (play.play_type !== 'pass' || !play.receiver_player_name || !play.pass_location) continue;
      const recName = normalizeName(play.receiver_player_name);
      const acc = predLocByReceiver.get(recName) || { left: 0, middle: 0, right: 0, total: 0 };
      acc.total += 1;
      if (play.pass_location === 'left') acc.left += 1;
      else if (play.pass_location === 'middle') acc.middle += 1;
      else if (play.pass_location === 'right') acc.right += 1;
      predLocByReceiver.set(recName, acc);
    }

    // Injury
    const SOFT_TISSUE_PRED = /hamstring|groin|calf|quad|hip|thigh|achilles|ankle|foot|toe/i;
    const KNEE_PRED = /knee|acl|mcl|pcl|meniscus/i;
    const predPriorInjByName = new Map<string, InjAgg>();
    for (const inj of predPriorInjuries) {
      if (!POSITIONS.includes(inj.position)) continue;
      const name = normalizeName(inj.full_name);
      const acc = predPriorInjByName.get(name) || { weeks: 0, gamesOut: 0, softTissue: false, knee: false };
      acc.weeks += 1;
      if (inj.report_status === 'Out' || inj.report_status === 'Doubtful') acc.gamesOut += 1;
      const allInjText = `${inj.report_primary_injury || ''} ${inj.report_secondary_injury || ''} ${inj.practice_primary_injury || ''} ${inj.practice_secondary_injury || ''}`;
      if (SOFT_TISSUE_PRED.test(allInjText)) acc.softTissue = true;
      if (KNEE_PRED.test(allInjText)) acc.knee = true;
      predPriorInjByName.set(name, acc);
    }
    const predPreseasonInjByName = new Map<string, { injured: boolean; weeks: number }>();
    for (const inj of predPreseasonInjuries) {
      if (!POSITIONS.includes(inj.position)) continue;
      const isPre = inj.game_type === 'PRE' || inj.week <= 0;
      if (!isPre) continue;
      const name = normalizeName(inj.full_name);
      const acc = predPreseasonInjByName.get(name) || { injured: false, weeks: 0 };
      acc.weeks += 1;
      if (inj.report_status === 'Out' || inj.report_status === 'Doubtful' || inj.report_status === 'Questionable') acc.injured = true;
      predPreseasonInjByName.set(name, acc);
    }

    // Roster competition for predictions
    const predRosterByTeamPos = new Map<string, Set<string>>();
    const predPlayerTeamMap = new Map<string, string>();
    const predHeadshotByName = new Map<string, string>();
    for (const r of predSeasonRosters) {
      if (!POSITIONS.includes(r.position) || r.status === 'Inactive') continue;
      const key = `${r.team}:${r.position}`;
      if (!predRosterByTeamPos.has(key)) predRosterByTeamPos.set(key, new Set());
      const name = normalizeName(r.full_name);
      predRosterByTeamPos.get(key)!.add(name);
      predPlayerTeamMap.set(name, r.team);
      if (r.headshot_url) predHeadshotByName.set(name, r.headshot_url);
    }
    const predPriorRosterByTeamPos = new Map<string, Set<string>>();
    for (const r of predPriorRosters) {
      if (!POSITIONS.includes(r.position)) continue;
      const key = `${r.team}:${r.position}`;
      if (!predPriorRosterByTeamPos.has(key)) predPriorRosterByTeamPos.set(key, new Set());
      predPriorRosterByTeamPos.get(key)!.add(normalizeName(r.full_name));
    }
    const predDepthRankByName = new Map<string, number>();
    const predDcLatest = new Map<string, DepthChart>();
    for (const dc of predSeasonDepthCharts) {
      const name = normalizeName(dc.player_name);
      const key = `${dc.team}:${dc.pos_abb}:${name}`;
      const existing = predDcLatest.get(key);
      if (!existing || dc.dt > existing.dt) predDcLatest.set(key, dc);
    }
    for (const dc of predDcLatest.values()) {
      predDepthRankByName.set(normalizeName(dc.player_name), dc.pos_rank || dc.pos_slot || 99);
    }
    const predTeamTotalCarries = new Map<string, number>();
    const predTeamTotalTargets = new Map<string, number>();
    const predPriorPPRByName = new Map<string, number>();
    for (const p of predPriorTotals) {
      if (!POSITIONS.includes(p.position)) continue;
      const team = p.recent_team || '';
      if (team) {
        predTeamTotalCarries.set(team, (predTeamTotalCarries.get(team) || 0) + (p.carries || 0));
        predTeamTotalTargets.set(team, (predTeamTotalTargets.get(team) || 0) + (p.targets || 0));
      }
      predPriorPPRByName.set(normalizeName(p.player_display_name), p.fantasy_points_ppr || 0);
    }
    const predDraftPicksBySeason = draftData.filter((d) => d.season === predSeason);
    const predTeamDraftedPos = new Map<string, { count: number; bestPick: number }>();
    for (const d of predDraftPicksBySeason) {
      const pos = d.position || '';
      if (!POSITIONS.includes(pos)) continue;
      const key = `${d.team}:${pos}`;
      const existing = predTeamDraftedPos.get(key) || { count: 0, bestPick: 300 };
      existing.count += 1;
      existing.bestPick = Math.min(existing.bestPick, d.pick || 300);
      predTeamDraftedPos.set(key, existing);
    }

    // Quality-aware competition aggregations for predictions
    const predPosPriorRanks = new Map<string, Map<string, number>>();
    for (const pos of POSITIONS) {
      const posPlayers = predPriorTotals
        .filter((p) => p.position === pos)
        .sort((a, b) => (b.fantasy_points_ppr || 0) - (a.fantasy_points_ppr || 0));
      const rankMap = new Map<string, number>();
      posPlayers.forEach((p, i) => rankMap.set(normalizeName(p.player_display_name), i + 1));
      predPosPriorRanks.set(pos, rankMap);
    }
    interface PredTeamPosAgg { bestPPR: number; totalPPR: number; hasTop12: boolean }
    const predTeamPosAgg = new Map<string, PredTeamPosAgg>();
    for (const [key, names] of predRosterByTeamPos) {
      const [, pos] = key.split(':');
      const agg: PredTeamPosAgg = { bestPPR: 0, totalPPR: 0, hasTop12: false };
      for (const name of names) {
        const ppr = predPriorPPRByName.get(name) || 0;
        if (ppr > agg.bestPPR) agg.bestPPR = ppr;
        agg.totalPPR += ppr;
        const rank = predPosPriorRanks.get(pos)?.get(name) || 999;
        if (rank <= 12) agg.hasTop12 = true;
      }
      predTeamPosAgg.set(key, agg);
    }
    const predTeamPassCatcherPPR2 = new Map<string, number>();
    const predTeamElitePassCatchers2 = new Map<string, number>();
    for (const [key, names] of predRosterByTeamPos) {
      const [pcTeam, pos] = key.split(':');
      if (pos !== 'WR' && pos !== 'TE') continue;
      for (const name of names) {
        const ppr = predPriorPPRByName.get(name) || 0;
        predTeamPassCatcherPPR2.set(pcTeam, (predTeamPassCatcherPPR2.get(pcTeam) || 0) + ppr);
        const rank = predPosPriorRanks.get(pos)?.get(name) || 999;
        if (rank <= 24) predTeamElitePassCatchers2.set(pcTeam, (predTeamElitePassCatchers2.get(pcTeam) || 0) + 1);
      }
    }
    const predTeamTargetHHI2 = new Map<string, number>();
    for (const team of new Set([...predTeamTotalTargets.keys()])) {
      const totalTgts = predTeamTotalTargets.get(team) || 1;
      let hhi = 0;
      for (const p of predPriorTotals) {
        if ((p.recent_team || '') !== team || !POSITIONS.includes(p.position)) continue;
        const share = (p.targets || 0) / totalTgts;
        hhi += share * share;
      }
      predTeamTargetHHI2.set(team, Math.round(hhi * 1000) / 1000);
    }
    const predNewArrivalBestPPR2 = new Map<string, number>();
    for (const [key, names] of predRosterByTeamPos) {
      const priorNames = predPriorRosterByTeamPos.get(key);
      let best = 0;
      for (const name of names) {
        if (priorNames && priorNames.has(name)) continue;
        const ppr = predPriorPPRByName.get(name) || 0;
        if (ppr > best) best = ppr;
      }
      predNewArrivalBestPPR2.set(key, Math.round(best * 10) / 10);
    }
    const predAdpByName = new Map<string, number>();
    for (const a of predAdpData) predAdpByName.set(normalizeName(a.name), a.adp);
    const predNewArrivalBestADP2 = new Map<string, number>();
    for (const [key, names] of predRosterByTeamPos) {
      const priorNames = predPriorRosterByTeamPos.get(key);
      let bestAdp = 999;
      for (const name of names) {
        if (priorNames && priorNames.has(name)) continue;
        const adp2 = predAdpByName.get(name) || 999;
        if (adp2 < bestAdp) bestAdp = adp2;
      }
      predNewArrivalBestADP2.set(key, bestAdp < 999 ? bestAdp : 0);
    }

    // Scheme features for predictions
    const predSchemeByTeam = new Map<string, SchemeAgg>();
    const predPriorGamesByTeam = new Map<string, Set<string>>();
    const predPersonnelByTeam = new Map<string, PersonnelAgg>();

    for (const play of predPriorPbp) {
      if (!play.posteam || play.play_type === 'no_play') continue;
      const team = play.posteam;
      if (!predPriorGamesByTeam.has(team)) predPriorGamesByTeam.set(team, new Set());
      predPriorGamesByTeam.get(team)!.add(play.game_id);

      if (play.play_type !== 'pass' && play.play_type !== 'run') continue;
      const acc = predSchemeByTeam.get(team) || {
        passes: 0, rushes: 0, plays: 0, games: 0,
        neutralPasses: 0, neutralPlays: 0,
        firstDownRuns: 0, firstDownPlays: 0,
        shotgunPlays: 0, noHuddlePlays: 0,
        rbTargets: 0, teTargets: 0, wrTargets: 0, totalTargets: 0,
      };
      acc.plays += 1;
      if (play.play_type === 'pass' || play.qb_dropback === 1) acc.passes += 1;
      else acc.rushes += 1;
      const isNeutral = Math.abs(play.score_differential || 0) <= 7 && (play.qtr || 0) <= 3;
      if (isNeutral) {
        acc.neutralPlays += 1;
        if (play.play_type === 'pass' || play.qb_dropback === 1) acc.neutralPasses += 1;
      }
      if (play.down === 1) {
        acc.firstDownPlays += 1;
        if (play.play_type === 'run' && play.qb_dropback !== 1) acc.firstDownRuns += 1;
      }
      if (play.shotgun === 1) acc.shotgunPlays += 1;
      if (play.no_huddle === 1) acc.noHuddlePlays += 1;
      if (play.play_type === 'pass' && play.receiver_player_name) {
        acc.totalTargets += 1;
        const recName = normalizeName(play.receiver_player_name);
        const recPrior = predPriorByName.get(recName);
        if (recPrior?.position === 'RB') acc.rbTargets += 1;
        else if (recPrior?.position === 'TE') acc.teTargets += 1;
        else if (recPrior?.position === 'WR') acc.wrTargets += 1;
      }
      predSchemeByTeam.set(team, acc);

      if (play.offense_personnel) {
        const persAcc = predPersonnelByTeam.get(team) || {
          p11: 0, p12: 0, p13: 0, p21: 0, p22: 0, p10: 0, total: 0,
          wr3plus: 0, te2plus: 0,
        };
        persAcc.total += 1;
        const pers = play.offense_personnel;
        const rbM = pers.match(/(\d+)\s*RB/i);
        const teM = pers.match(/(\d+)\s*TE/i);
        const wrM = pers.match(/(\d+)\s*WR/i);
        const rb = rbM ? Number(rbM[1]) : 0;
        const te = teM ? Number(teM[1]) : 0;
        const wr = wrM ? Number(wrM[1]) : 0;
        const grouping = `${rb}${te}`;
        if (grouping === '11') persAcc.p11 += 1;
        else if (grouping === '12') persAcc.p12 += 1;
        else if (grouping === '13') persAcc.p13 += 1;
        else if (grouping === '21') persAcc.p21 += 1;
        else if (grouping === '22') persAcc.p22 += 1;
        else if (grouping === '10') persAcc.p10 += 1;
        if (wr >= 3) persAcc.wr3plus += 1;
        if (te >= 2) persAcc.te2plus += 1;
        predPersonnelByTeam.set(team, persAcc);
      }
    }
    for (const [team, gameSet] of predPriorGamesByTeam) {
      const acc = predSchemeByTeam.get(team);
      if (acc) acc.games = gameSet.size;
    }

    // Coach change detection for prediction season
    const predCoachChangeTeams = new Set<string>();
    for (const [key, coach] of coachBySeasonTeam) {
      const [szn, team] = key.split(':');
      if (Number(szn) === predSeason) {
        const priorCoach = coachBySeasonTeam.get(`${priorSeasonPred}:${team}`);
        if (priorCoach && priorCoach !== coach) predCoachChangeTeams.add(team);
      }
    }
    const predCoachPriorTeamPPR = new Map<string, number>();
    for (const p of predPriorTotals) {
      if (!POSITIONS.includes(p.position)) continue;
      const team = p.recent_team || '';
      predCoachPriorTeamPPR.set(team, (predCoachPriorTeamPPR.get(team) || 0) + (p.fantasy_points_ppr || 0));
    }

    // Build prediction features for each ADP player
    for (const adpPlayer of predAdpData) {
      if (!POSITIONS.includes(adpPlayer.position)) continue;
      if (adpPlayer.adp > 200) continue;

      const normalName = normalizeName(adpPlayer.name);
      const prior = predPriorByName.get(normalName);
      const combine = combineByName.get(normalName);
      const draft = draftByName.get(normalName);
      const snapAcc = predSnapAccum.get(normalName);
      const snapPct = snapAcc && snapAcc.count > 0 ? snapAcc.total / snapAcc.count : 0;

      const heightIn = combine?.ht ? parseHeight(combine.ht) : 0;
      const wt = combine?.wt || 0;
      const bmi = heightIn > 0 && wt > 0 ? (703 * wt) / (heightIn * heightIn) : 0;

      const priorGames = prior?.games || 0;
      const priorPPR = prior?.fantasy_points_ppr || 0;
      const priorAttempts = prior?.attempts || 0;
      const priorCarries = prior?.carries || 0;

      const draftAge = draft?.age || 0;
      const draftYear = draft?.season || 0;
      const age = draftAge > 0 && draftYear > 0 ? draftAge + (predSeason - draftYear) : 0;

      const adv = predAdvByName.get(normalName);
      const advWeeks = adv?.weeks || 1;
      const avgTargetShare = adv ? adv.targetShare / advWeeks : 0;
      const avgAirYardsShare = adv ? adv.airYardsShare / advWeeks : 0;
      const avgWOPR = adv ? adv.wopr / advWeeks : 0;
      const avgRACR = adv && advWeeks > 0 ? adv.racr / advWeeks : 0;
      const yacPerRec = adv && adv.receptions > 0 ? adv.yac / adv.receptions : 0;
      const airYardsPerTarget = adv && adv.targets > 0 ? adv.recAirYards / adv.targets : 0;

      const pbp = predPbpByReceiver.get(normalName);
      const adot = pbp && pbp.targets > 0 ? pbp.totalAirYards / pbp.targets : 0;
      const deepPct = pbp && pbp.targets > 0 ? pbp.deepTargets / pbp.targets : 0;
      const playerTeam = prior?.recent_team || '';
      const teamRZ = predTeamRZTargets.get(playerTeam) || 1;
      const rzTargetShare = pbp ? pbp.rzTargets / teamRZ : 0;

      const ngsRec = predNgsRecByName.get(normalName);
      const ngsRush = predNgsRushByName.get(normalName);
      const ngsPass = predNgsPassByName.get(normalName);

      // Roster competition features
      const playerTeam2 = predPlayerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
      const posKey = `${playerTeam2}:${adpPlayer.position}`;
      const teammates = predRosterByTeamPos.get(posKey);
      const samePosCount = teammates ? teammates.size - (teammates.has(normalName) ? 1 : 0) : 0;
      const priorTeammates2 = predPriorRosterByTeamPos.get(posKey);
      const newArrivals = teammates && priorTeammates2
        ? [...teammates].filter((n) => n !== normalName && !priorTeammates2.has(n)).length
        : 0;
      const draftedInfo = predTeamDraftedPos.get(posKey);
      const priorTeamCarries = predTeamTotalCarries.get(playerTeam2) || 1;
      const priorTeamTargets2 = predTeamTotalTargets.get(playerTeam2) || 1;
      const playerTouchShare = adpPlayer.position === 'RB'
        ? (prior?.carries || 0) / priorTeamCarries
        : (prior?.targets || 0) / priorTeamTargets2;
      const playerTargetShareTeam = (prior?.targets || 0) / priorTeamTargets2;
      let bestTeammatePPR = 0;
      if (teammates) {
        for (const tmName of teammates) {
          if (tmName === normalName) continue;
          const tmPPR = predPriorPPRByName.get(tmName) || 0;
          if (tmPPR > bestTeammatePPR) bestTeammatePPR = tmPPR;
        }
      }

      // Coaching & scheme features
      const pTeam = predPlayerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
      const scheme = predSchemeByTeam.get(pTeam);
      const totalPlays = scheme?.plays || 1;
      const totalGames = scheme?.games || 1;

      // Personnel & positional usage features
      const pTeam2 = predPlayerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
      const pers = predPersonnelByTeam.get(pTeam2);
      const persTotal = pers?.total || 1;
      const sch = predSchemeByTeam.get(pTeam2);
      const schGames = sch?.games || 1;
      const schTotalTgts = sch?.totalTargets || 1;

      // Vegas features
      const vTeam = predPlayerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
      const vKey = `${predSeason - 1}:${vTeam}`;
      const v = vegasBySeasonTeam.get(vKey);
      const vGames = v?.games || 1;

      // Projection features
      const pf = predProjFeatures.get(normalName);

      const features: Record<string, number> = {
        adp: adpPlayer.adp,
        adpRound: Math.ceil(adpPlayer.adp / 12),
        age,
        yearsInLeague: draft ? predSeason - draft.season : 0,
        nflDraftRound: draft?.round || 8,
        nflDraftPick: draft?.pick || 300,
        weight: wt,
        forty: combine?.forty || 0,
        bmi: Math.round(bmi * 10) / 10,
        priorPassYards: prior?.passing_yards || 0,
        priorPassTDs: prior?.passing_tds || 0,
        priorINTs: prior?.interceptions || 0,
        priorPassYPA: priorAttempts > 0 ? Math.round((prior?.passing_yards || 0) / priorAttempts * 10) / 10 : 0,
        priorQBRating: 0,
        priorRushYards: prior?.rushing_yards || 0,
        priorRushTDs: prior?.rushing_tds || 0,
        priorYPC: priorCarries > 0 ? Math.round((prior?.rushing_yards || 0) / priorCarries * 10) / 10 : 0,
        priorCarries: priorCarries,
        priorTargets: prior?.targets || 0,
        priorReceptions: prior?.receptions || 0,
        priorRecYards: prior?.receiving_yards || 0,
        priorRecTDs: prior?.receiving_tds || 0,
        priorYPR: (prior?.receptions || 0) > 0
          ? Math.round((prior?.receiving_yards || 0) / (prior?.receptions || 1) * 10) / 10 : 0,
        priorTargetShare: Math.round(avgTargetShare * 1000) / 1000,
        priorAirYardsShare: Math.round(avgAirYardsShare * 1000) / 1000,
        priorWOPR: Math.round(avgWOPR * 1000) / 1000,
        priorRACR: Math.round(avgRACR * 100) / 100,
        priorYACperRec: Math.round(yacPerRec * 10) / 10,
        priorAirYardsPerTarget: Math.round(airYardsPerTarget * 10) / 10,
        priorRecEPA: Math.round((adv?.recEPA || 0) * 10) / 10,
        priorRushEPA: Math.round((adv?.rushEPA || 0) * 10) / 10,
        priorADOT: Math.round(adot * 10) / 10,
        priorDeepTargetPct: Math.round(deepPct * 1000) / 1000,
        priorRZTargetShare: Math.round(rzTargetShare * 1000) / 1000,
        priorSeparation: ngsRec?.avg_separation || 0,
        priorCushion: ngsRec?.avg_cushion || 0,
        priorYACAboveExp: ngsRec?.avg_yac_above_expectation || 0,
        priorCatchPct: ngsRec?.catch_percentage || 0,
        priorIntendedAirYardShare: ngsRec?.percent_share_of_intended_air_yards || 0,
        priorRYOEperAtt: ngsRush?.rush_yards_over_expected_per_att || 0,
        priorRushEfficiency: ngsRush?.efficiency || 0,
        priorPctVs8Defenders: ngsRush?.percent_attempts_gte_eight_defenders || 0,
        priorCPOE: ngsPass?.completion_percentage_above_expectation || 0,
        priorTimeToThrow: ngsPass?.avg_time_to_throw || 0,
        priorAggressiveness: ngsPass?.aggressiveness || 0,
        priorYPRR: (() => {
          const rt = predRoutesByName.get(normalName);
          return rt && rt.routesRun > 0
            ? Math.round(((prior?.receiving_yards || 0) / rt.routesRun) * 100) / 100 : 0;
        })(),
        priorRoutesRun: predRoutesByName.get(normalName)?.routesRun || 0,
        priorTargetsPerRoute: (() => {
          const rt = predRoutesByName.get(normalName);
          return rt && rt.routesRun > 0
            ? Math.round(((prior?.targets || 0) / rt.routesRun) * 1000) / 1000 : 0;
        })(),
        priorPct11Personnel: (() => {
          const rt = predRoutesByName.get(normalName);
          return rt && rt.totalSnaps > 0
            ? Math.round((rt.snaps11 / rt.totalSnaps) * 1000) / 1000 : 0;
        })(),
        priorPct12Personnel: (() => {
          const rt = predRoutesByName.get(normalName);
          return rt && rt.totalSnaps > 0
            ? Math.round((rt.snaps12 / rt.totalSnaps) * 1000) / 1000 : 0;
        })(),
        priorPassLocationLeft: (() => {
          const loc = predLocByReceiver.get(normalName);
          return loc && loc.total > 0 ? Math.round((loc.left / loc.total) * 1000) / 1000 : 0;
        })(),
        priorPassLocationMiddle: (() => {
          const loc = predLocByReceiver.get(normalName);
          return loc && loc.total > 0 ? Math.round((loc.middle / loc.total) * 1000) / 1000 : 0;
        })(),
        priorPPR: Math.round(priorPPR * 10) / 10,
        priorPPG: priorGames > 0 ? Math.round(priorPPR / priorGames * 10) / 10 : 0,
        priorGames,
        priorGamesMissed: prior ? Math.max(0, 17 - priorGames) : 0,
        priorTotalTouches: priorCarries + (prior?.receptions || 0),
        priorSnapPct: Math.round(snapPct * 10) / 10,
        priorInjuryWeeks: predPriorInjByName.get(normalName)?.weeks || 0,
        priorGamesOut: predPriorInjByName.get(normalName)?.gamesOut || 0,
        preseasonInjured: predPreseasonInjByName.get(normalName)?.injured ? 1 : 0,
        preseasonInjWeeks: predPreseasonInjByName.get(normalName)?.weeks || 0,
        priorSoftTissue: predPriorInjByName.get(normalName)?.softTissue ? 1 : 0,
        priorKneeInjury: predPriorInjByName.get(normalName)?.knee ? 1 : 0,
        // Roster competition
        teamSamePosCount: samePosCount,
        depthChartRank: predDepthRankByName.get(normalName) || 99,
        priorTeamTouchShare: Math.round(playerTouchShare * 1000) / 1000,
        priorTeamTargetShare: Math.round(playerTargetShareTeam * 1000) / 1000,
        newSamePosAdded: newArrivals,
        teamDraftedSamePos: draftedInfo ? draftedInfo.count : 0,
        draftCapitalSamePos: draftedInfo ? Math.max(0, 8 - Math.ceil(draftedInfo.bestPick / 32)) : 0,
        teammatePriorPPR: Math.round(bestTeammatePPR * 10) / 10,
        teamWRElitePPR: Math.round((predTeamPosAgg.get(`${playerTeam2}:WR`)?.bestPPR || 0) * 10) / 10,
        teamWRTop12: (predTeamPosAgg.get(`${playerTeam2}:WR`)?.hasTop12 || false) ? 1 : 0,
        teamWRTotalPPR: Math.round((predTeamPosAgg.get(`${playerTeam2}:WR`)?.totalPPR || 0) * 10) / 10,
        teamTEElitePPR: Math.round((predTeamPosAgg.get(`${playerTeam2}:TE`)?.bestPPR || 0) * 10) / 10,
        teamRBElitePPR: Math.round((predTeamPosAgg.get(`${playerTeam2}:RB`)?.bestPPR || 0) * 10) / 10,
        teamRBTop12: (predTeamPosAgg.get(`${playerTeam2}:RB`)?.hasTop12 || false) ? 1 : 0,
        teamPassCatcherPPR: Math.round((predTeamPassCatcherPPR2.get(playerTeam2) || 0) * 10) / 10,
        teamElitePassCatchers: predTeamElitePassCatchers2.get(playerTeam2) || 0,
        teamTargetHHI: predTeamTargetHHI2.get(playerTeam2) || 0,
        newArrivalBestPPR: predNewArrivalBestPPR2.get(posKey) || 0,
        newArrivalBestADP: predNewArrivalBestADP2.get(posKey) || 0,
        // Coaching & scheme
        newHeadCoach: predCoachChangeTeams.has(pTeam) ? 1 : 0,
        coachPriorTeamPPR: Math.round((predCoachPriorTeamPPR.get(pTeam) || 0) * 10) / 10,
        teamPassRate: scheme ? Math.round((scheme.passes / totalPlays) * 1000) / 1000 : 0,
        teamNeutralPassRate: scheme && scheme.neutralPlays > 0
          ? Math.round((scheme.neutralPasses / scheme.neutralPlays) * 1000) / 1000 : 0,
        teamPace: scheme ? Math.round((totalPlays / totalGames) * 10) / 10 : 0,
        teamFirstDownRunRate: scheme && scheme.firstDownPlays > 0
          ? Math.round((scheme.firstDownRuns / scheme.firstDownPlays) * 1000) / 1000 : 0,
        teamShotgunRate: scheme ? Math.round((scheme.shotgunPlays / totalPlays) * 1000) / 1000 : 0,
        teamNoHuddleRate: scheme ? Math.round((scheme.noHuddlePlays / totalPlays) * 1000) / 1000 : 0,
        teamRBTargetRate: scheme && scheme.totalTargets > 0
          ? Math.round((scheme.rbTargets / scheme.totalTargets) * 1000) / 1000 : 0,
        // Personnel & positional usage
        team11Rate: pers ? Math.round((pers.p11 / persTotal) * 1000) / 1000 : 0,
        team12Rate: pers ? Math.round((pers.p12 / persTotal) * 1000) / 1000 : 0,
        team13Rate: pers ? Math.round((pers.p13 / persTotal) * 1000) / 1000 : 0,
        team21Rate: pers ? Math.round((pers.p21 / persTotal) * 1000) / 1000 : 0,
        team22Rate: pers ? Math.round((pers.p22 / persTotal) * 1000) / 1000 : 0,
        team10Rate: pers ? Math.round((pers.p10 / persTotal) * 1000) / 1000 : 0,
        teamTETargetRate: sch ? Math.round((sch.teTargets / schTotalTgts) * 1000) / 1000 : 0,
        teamWRTargetRate: sch ? Math.round((sch.wrTargets / schTotalTgts) * 1000) / 1000 : 0,
        teamTETargetsPerGame: sch ? Math.round((sch.teTargets / schGames) * 10) / 10 : 0,
        teamRBTargetsPerGame: sch ? Math.round((sch.rbTargets / schGames) * 10) / 10 : 0,
        teamWR3PlusOnField: pers ? Math.round((pers.wr3plus / persTotal) * 1000) / 1000 : 0,
        team2PlusTEOnField: pers ? Math.round((pers.te2plus / persTotal) * 1000) / 1000 : 0,
        // Vegas
        vegasImpliedTotal: v ? Math.round((v.impliedTotal / vGames) * 10) / 10 : 0,
        vegasImpliedSpread: v ? Math.round((v.spread / vGames) * 10) / 10 : 0,
        vegasGameTotal: v ? Math.round((v.gameTotal / vGames) * 10) / 10 : 0,
        vegasWinPct: v ? Math.round((v.wins / vGames) * 1000) / 1000 : 0,
        vegasActualPtsPerGame: v ? Math.round((v.actualPts / vGames) * 10) / 10 : 0,
        // Projection
        projTeamPassAtt:      pf?.projTeamPassAtt      ?? 0,
        projTeamPassVolChg:   pf?.projTeamPassVolChg    ?? 0,
        projPlayerPPR:        pf?.projPlayerPPR         ?? 0,
        projPlayerVsExpected: pf?.projPlayerVsExpected  ?? 0,
        projTargetShare:      pf?.projTargetShare        ?? 0,
      };

      predRows.push({
        name: adpPlayer.name,
        position: adpPlayer.position,
        team: adpPlayer.team || '',
        adp: adpPlayer.adp,
        headshotUrl: predHeadshotByName.get(normalName) || predHeadshotByName.get(normalizeName(adpPlayer.name)) || undefined,
        features,
      });
    }
  }

  return {
    allRows: rows,
    vorNormParams: Object.fromEntries(vorNorm),
    predictionRows: predRows,
  };
}
