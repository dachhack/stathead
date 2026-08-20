// Pure, headless builder for the season projection "pool".
//
// Extracted VERBATIM from StatProjections.tsx's projections-mode effect so the
// exact same construction runs in the browser AND in a Node script (CI). The
// #1 rule: byte-identical numeric output to the component. This function does
// NO fetching and NO React state — all fetched/imported data comes in via
// `inputs`, all computed artifacts come out via the return value.
//
// The two fetches that used to be inline in the effect (feature-matrix.json and
// clay-projections-<season>.json) are now hoisted into the caller's fetch phase
// and passed in as `featureMatrix` / `consensusDoc`.

import {
  computePPR,
  normalizeProjName as normalizeName,
  type QBProjection, type RBProjection, type WRProjection, type TEProjection,
} from './projectionsTabEngine';
import type { PresetMeta, PlayerMeta, ConsensusStats } from './scenarioPresets';
import type {
  SeasonTotals, DraftPick, FfcADPPlayer, Roster, Game, FreeAgentPlayer, PlayerStats,
} from '../types';
import type { OddsGameLine } from '../data';
import { aggregateToSeasonTotals, aggregateOddsToTeamImplied } from '../data';
import projectionConfig from '../generated/projection-config.json';
import {
  PREDICT_SEASON, POSITIONS, type Position, normTeam, TEAM_POS_LIMITS,
} from './projectionPoolConsts';

// ── Types surfaced to / consumed by the React component ──

export interface TeamTotalRow {
  team: string;
  passAtt: number; passComp: number; passYds: number; passTD: number; int: number;
  rushAtt: number; rushYds: number; rushTD: number;
  tgt: number; rec: number; recYds: number; recTD: number;
  pprPts: number;
}

export interface AdpModelEntry { adp: number; predictedVor: number; ciLower: number; ciUpper: number }

// Shapes of the two formerly-inline-fetched documents.
export interface FeatureMatrixDoc {
  ppgPredictions2026?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}
export interface ConsensusDoc {
  players?: Array<Record<string, number | string>>;
  [k: string]: unknown;
}

export interface BuildProjectionPoolInputs {
  adpData: FfcADPPlayer[];
  priorStats: PlayerStats[];
  /**
   * The CURRENT season's weekly stats, empty until Week 1 is played. When
   * present, every projected stat line is blended toward what the player is
   * actually doing this season (see IN_SEASON_K). Optional so existing callers
   * keep working; a caller that omits it gets the preseason projection all year.
   */
  currentStats?: PlayerStats[];
  draftData: DraftPick[];
  rosters: Roster[];
  gamesData: Game[];
  oddsLines: OddsGameLine[];
  shareScoresData: Array<{ name: string; predTargetShare: number; predRushShare: number }>;
  ppgScoresData: Array<{ name: string; predictedPPG: number }>;
  adpScoresData: Array<{ name: string; adp: number; predictedVor: number; ciLower: number; ciUpper: number }>;
  redraftData: { players?: Array<{ name: string; position: string; ppg: number }> };
  depthOrderData: { players?: Array<{ name: string; team: string; pos: string; teamRank: number }> };
  // Hoisted out of the effect: feature-matrix.json (the PPG fallback source)
  // and clay-projections-<season>.json (the Consensus preset source).
  featureMatrix: FeatureMatrixDoc | null;
  consensusDoc: ConsensusDoc | null;
  // team-projections.json ensemble (imported in the browser, read from fs in Node).
  teamProjectionsEnsemble: { season: number; teams: Record<string, Record<string, number>> };
  season: number;
}

export interface BuildProjectionPoolResult {
  // Early-error sentinel — the component calls setError on this (no setState here).
  error?: string;
  qbs: QBProjection[];
  rbs: RBProjection[];
  wrs: WRProjection[];
  tes: TEProjection[];
  meta: PresetMeta;
  depthChart: Record<string, Record<string, string[]>>;
  projAdpMap: Map<string, AdpModelEntry>;
  projPPGMap: Map<string, number>;
  freeAgents: FreeAgentPlayer[] | null;
  teamRosterMap: Record<string, { name: string; position: string; jersey: number; yearsExp: number; status: string }[]>;
  consensusPprMap: Map<string, number>;
  consensusStatsMap: Map<string, ConsensusStats>;
  projTeamTotals: Map<string, TeamTotalRow>;
  oddsSource: 'live' | 'historical';
}

// Empirical-Bayes shrinkage (moved verbatim from StatProjections module scope —
// these are read by the construction below).
function shrinkRate(num: number, den: number, prior: number, k: number): number {
  return (num + k * prior) / (den + k);
}
const CATCH_RATE_K = 40;
const YPR_K = 18;

// In-season blend. Once a player has games this season, his projected rate is
// w * (what he has actually done) + (1 - w) * the preseason projection, with
// w = games / (games + K). Each K is the RMSE-minimising value against
// REST-OF-SEASON PPR per game over 2017-2025, measured per position at every
// week cutoff — not chosen:
//
//   pos   K    blend RMSE   prior-only   current-only   n
//   QB   5.5      4.139        4.801        5.264      2,244
//   RB   3.5      4.057        4.859        4.794      5,417
//   WR   4.5      3.510        4.165        4.416      8,869
//   TE   5.0      2.971        3.406        3.670      4,250
//
// Skill positions move about twice as fast as kickers (K=9.5) and team
// defenses (K=10.5) because role changes are real and show up quickly: an RB
// is already 53% current-season by week 4. Ignoring the season in progress
// costs 16-17% of RMSE for RB and WR by midseason.
const IN_SEASON_K: Record<string, number> = { QB: 5.5, RB: 3.5, WR: 4.5, TE: 5.0 };
// Availability, re-estimated from what has actually happened. Games missed so
// far predict games missed later: over 61,479 player-week cutoffs (2016-2025),
// a beta-binomial with pseudo-count 5.5 scores RMSE 0.295 against the rate of
// remaining weeks played, versus 0.336 for a flat league rate and 0.343 for
// taking games/weeks at face value. The prior here is the player's own
// preseason games projection rather than the league base the constant was
// fitted against — better-informed, and the same shrinkage.
//   played 3 of 3 -> 74% of remaining weeks   played 1 of 3 -> 51%
//   played 2 of 3 -> 62%                      played 0 of 3 -> 39%
const AVAILABILITY_PSEUDO_COUNT = 5.5;
// Components blended per position. Everything else on the row (games, adp,
// team) is left to the preseason model.
const IN_SEASON_FIELDS: Record<string, string[]> = {
  QB: ['passAtt', 'passComp', 'passYds', 'passTD', 'int', 'rushAtt', 'rushYds', 'rushTD'],
  RB: ['rushAtt', 'rushYds', 'rushTD', 'tgt', 'rec', 'recYds', 'recTD'],
  WR: ['tgt', 'rec', 'recYds', 'recTD', 'rushAtt', 'rushYds', 'rushTD'],
  TE: ['tgt', 'rec', 'recYds', 'recTD'],
};

export function buildProjectionPool(inputs: BuildProjectionPoolInputs): BuildProjectionPoolResult {
  const {
    adpData, priorStats, currentStats, draftData, rosters, gamesData, oddsLines,
    shareScoresData, ppgScoresData, adpScoresData, redraftData, depthOrderData,
    featureMatrix, consensusDoc, teamProjectionsEnsemble,
  } = inputs;

  // ── Projections mode: current/future season ──

  // Per-team / per-position depth chart from our own public-data
  // depth-order model (scripts/train_depth_order_model.py ->
  // depth-order-2026.json). Used as the primary sort key so the modeled
  // starter wins over community ADP — handles rookies without ADP and
  // offseason role changes ADP lags. Replaces the prior Consensus-derived
  // depth chart; teams/players the model misses fall back to ADP order.
  // LOSO top-1 hit rate: QB 69.5% / RB 69.1% / WR 63.4% / TE 69.8%.
  const depthChart: Record<string, Record<string, string[]>> = {};
  {
    const players = (depthOrderData as { players?: Array<{ name: string; team: string; pos: string; teamRank: number }> }).players || [];
    const byTeamPos: Record<string, Record<string, { name: string; teamRank: number }[]>> = {};
    for (const p of players) {
      const t = normTeam(p.team);
      ((byTeamPos[t] ??= {})[p.pos] ??= []).push({ name: p.name, teamRank: p.teamRank });
    }
    for (const t of Object.keys(byTeamPos)) {
      for (const pos of Object.keys(byTeamPos[t])) {
        const lst = byTeamPos[t][pos];
        (depthChart[t] ??= {})[pos] = lst.sort((a, b) => a.teamRank - b.teamRank).map((x) => x.name);
      }
    }
  }
  function depthRank(team: string, pos: string, name: string): number {
    const list = depthChart?.[team]?.[pos];
    if (!list) return 9999;
    const idx = list.findIndex((n) => normalizeName(n) === normalizeName(name));
    return idx >= 0 ? idx : 9999;
  }
  const redraftFallback = (redraftData as { players?: Array<{ name: string; position: string; ppg: number }> }).players ?? [];

  // ADP-model lookup (score-store/adp.json). Populates ADP for
  // players FFC misses and exposes the CI bounds we use for the
  // boom/bust z-score columns.
  const adpModelMap = new Map<string, AdpModelEntry>();
  for (const a of adpScoresData as Array<{ name: string; adp: number; predictedVor: number; ciLower: number; ciUpper: number }>) {
    if (!a?.name) continue;
    adpModelMap.set(normalizeName(a.name), {
      adp: Number(a.adp) || 0,
      predictedVor: Number(a.predictedVor) || 0,
      ciLower: Number(a.ciLower) || 0,
      ciUpper: Number(a.ciUpper) || 0,
    });
  }
  const projAdpMap = adpModelMap;

  // ML share predictions lookup: name → { predTargetShare, predRushShare }
  const mlShares = new Map<string, { predTargetShare: number; predRushShare: number }>();
  for (const s of shareScoresData as Array<{ name: string; predTargetShare: number; predRushShare: number }>) {
    mlShares.set(normalizeName(s.name), { predTargetShare: s.predTargetShare || 0, predRushShare: s.predRushShare || 0 });
  }
  // ML PPG predictions lookup: name → predictedPPG. Fall back to
  // feature-matrix.json if the shard is empty (same pattern as MyRankings).
  let mlPPGEntries = ppgScoresData as Array<{ name: string; predictedPPG: number }>;
  if (!mlPPGEntries.length) {
    const fm = featureMatrix;
    if (fm?.ppgPredictions2026) {
      mlPPGEntries = fm.ppgPredictions2026.map((p: Record<string, unknown>) => ({
        name: String(p.name ?? ''),
        predictedPPG: Number(p.predictedPPG) || 0,
      }));
    }
  }
  const mlPPG = new Map<string, number>();
  for (const s of mlPPGEntries) {
    if (s.predictedPPG > 0) mlPPG.set(normalizeName(s.name), s.predictedPPG);
  }
  // Fill from the redraft-projections shard for players the ML
  // model doesn't list (depth pieces beyond the model's coverage)
  // so the Proj PPG column isn't a sea of em-dashes.
  for (const p of redraftFallback) {
    const k = normalizeName(p.name);
    if (!mlPPG.has(k) && p.ppg > 0) mlPPG.set(k, p.ppg);
  }
  const projPPGMap = mlPPG;

  if (adpData.length === 0) {
    return {
      error: `No ${PREDICT_SEASON} ADP data available yet`,
      qbs: [], rbs: [], wrs: [], tes: [],
      meta: new Map(), depthChart, projAdpMap, projPPGMap,
      freeAgents: null, teamRosterMap: {},
      consensusPprMap: new Map(), consensusStatsMap: new Map(),
      projTeamTotals: new Map(), oddsSource: 'historical',
    };
  }

  // ── Step 1: Prior season player totals ──
  const priorTotals = aggregateToSeasonTotals(
    priorStats.filter((s) => s.season_type === 'REG')
  );
  const priorByName = new Map<string, SeasonTotals>();
  for (const p of priorTotals) {
    if (['QB', 'RB', 'WR', 'TE'].includes(p.position)) {
      priorByName.set(normalizeName(p.player_display_name), p);
    }
  }

  // Roster: player → current team
  const rosterTeam = new Map<string, string>();
  for (const r of rosters) {
    if (['QB', 'RB', 'WR', 'TE'].includes(r.position)) {
      rosterTeam.set(normalizeName(r.full_name), normTeam(r.team));
    }
  }

  // ── Free agent list: prior-season players not on current rosters ──
  // Only built when roster data is substantial enough to be meaningful
  let freeAgents: FreeAgentPlayer[] | null = null;
  if (rosters.length >= 50) {
    const fas: FreeAgentPlayer[] = [];
    for (const p of priorTotals) {
      if (!['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
      if ((p.games || 0) < 3) continue;
      if ((p.fantasy_points_ppr || 0) < 25) continue;
      const nn = normalizeName(p.player_display_name);
      if (rosterTeam.has(nn)) continue; // already on a team
      fas.push({
        name: p.player_display_name,
        position: p.position,
        priorGames: p.games,
        priorPPR: Math.round(p.fantasy_points_ppr),
        passAtt: p.attempts || 0,
        passComp: p.completions || 0,
        passYds: p.passing_yards || 0,
        passTD: p.passing_tds || 0,
        int: p.interceptions || 0,
        rushAtt: p.carries || 0,
        rushYds: p.rushing_yards || 0,
        rushTD: p.rushing_tds || 0,
        tgt: p.targets || 0,
        rec: p.receptions || 0,
        recYds: p.receiving_yards || 0,
        recTD: p.receiving_tds || 0,
      });
    }
    // Sort by prior PPR descending
    fas.sort((a, b) => b.priorPPR - a.priorPPR);
    freeAgents = fas;
  }

  // Vegas implied totals (kept for future sweeps that may re-enable it)
  const oddsTeamImplied = oddsLines.length > 0 ? aggregateOddsToTeamImplied(oddsLines) : [];
  const usingLiveOdds = oddsTeamImplied.length > 0;

  // Draft data for age/experience
  const draftByName = new Map<string, DraftPick>();
  for (const d of draftData) draftByName.set(normalizeName(d.pfr_player_name), d);

  // ── Per-player metadata for Scenario Builder presets ──
  // Combines roster experience/age, draft age/class, and prior-season
  // games played into a single map the preset factories consult.
  const meta = new Map<string, PlayerMeta>();
  const teamRosterMap: Record<string, { name: string; position: string; jersey: number; yearsExp: number; status: string }[]> = {};
  {
    const ensure = (nn: string): PlayerMeta => {
      let m = meta.get(nn);
      if (!m) { m = { isRookie: false, yearsExp: null, age: null, priorGames: null }; meta.set(nn, m); }
      return m;
    };
    for (const r of rosters) {
      if (!['QB', 'RB', 'WR', 'TE'].includes(r.position)) continue;
      const m = ensure(normalizeName(r.full_name));
      if (typeof r.years_exp === 'number') m.yearsExp = r.years_exp;
      if (r.years_exp === 0 || r.entry_year === PREDICT_SEASON || r.rookie_year === PREDICT_SEASON) m.isRookie = true;
      if (r.birth_date) {
        const by = new Date(r.birth_date).getFullYear();
        if (by > 1950) m.age = PREDICT_SEASON - by;
      }
    }
    for (const [nn, d] of draftByName) {
      const m = ensure(nn);
      if (d.season === PREDICT_SEASON) m.isRookie = true;
      if (m.age == null && d.age) m.age = (d.age || 0) + (PREDICT_SEASON - d.season);
      if (m.yearsExp == null) m.yearsExp = Math.max(0, PREDICT_SEASON - d.season);
    }
    for (const [nn, p] of priorByName) {
      const m = ensure(nn);
      if (typeof p.games === 'number') m.priorGames = p.games;
    }

    // Per-team current roster for the Scenario Builder's collapsible view.
    for (const r of rosters) {
      if (!r.full_name || !r.team) continue;
      const t = normTeam(r.team);
      (teamRosterMap[t] ??= []).push({
        name: r.full_name, position: r.position || '',
        jersey: r.jersey_number || 0,
        yearsExp: typeof r.years_exp === 'number' ? r.years_exp : -1,
        status: r.status || '',
      });
    }
  }

  // ── Consensus projections for the "Consensus" preset ──
  // Committed at public/data/clay-projections-<season>.json (extracted by
  // scripts/extract_consensus_projections.py; surfaced only as "Consensus").
  // PPR is recomputed from the stat line with our scoring so it's
  // consistent with our projections and format-agnostic to the source's
  // own points column.
  const consensusPprMap = new Map<string, number>();
  const consensusStatsMap = new Map<string, ConsensusStats>();
  {
    const consensusRaw = consensusDoc?.players;
    if (Array.isArray(consensusRaw)) {
      const consensusMap = consensusPprMap;
      const csMap = consensusStatsMap;
      for (const c of consensusRaw as Array<Record<string, number | string>>) {
        const name = String(c.name ?? '');
        if (!name) continue;
        const ppr = computePPR({
          passYds: Number(c.pass_yds) || 0, passTD: Number(c.pass_td) || 0, int: Number(c.pass_int) || 0,
          rushYds: Number(c.rush_yds) || 0, rushTD: Number(c.rush_td) || 0,
          rec: Number(c.rec) || 0, recYds: Number(c.rec_yds) || 0, recTD: Number(c.rec_td) || 0,
        });
        const nk = normalizeName(name);
        if (ppr > 0) {
          consensusMap.set(nk, Math.round(ppr));
          csMap.set(nk, {
            position: String(c.position ?? ''),
            pos_rk: Number(c.pos_rk) || 999,
            ...(c.pass_yds != null && { pass_yds: Number(c.pass_yds) || 0 }),
            ...(c.pass_td != null && { pass_td: Number(c.pass_td) || 0 }),
            ...(c.pass_int != null && { pass_int: Number(c.pass_int) || 0 }),
            ...(c.rush_yds != null && { rush_yds: Number(c.rush_yds) || 0 }),
            ...(c.rush_td != null && { rush_td: Number(c.rush_td) || 0 }),
            ...(c.rec != null && { rec: Number(c.rec) || 0 }),
            ...(c.rec_yds != null && { rec_yds: Number(c.rec_yds) || 0 }),
            ...(c.rec_td != null && { rec_td: Number(c.rec_td) || 0 }),
            ppr: Math.round(ppr),
          });
        }
      }
    }
  }

  // Rookie workload share by draft pick + position. Used by the no-
  // prior projection branches so a recently-drafted rookie like
  // Jeremiyah Love (R1 #3 ARI) gets a starter-level share of his
  // team's RB pool instead of the generic `1 / (players.length * 4)`
  // depth-piece fallback. Returns 0 for non-2026-rookies (vets without
  // prior stats) so the existing depth-piece fallback still kicks in.
  // Numbers are heuristic typical Y1 workload shares — RBs ramp fast,
  // TEs slow, QBs binary on starter status.
  function rookieShare(name: string, pos: string): number {
    const draft = draftByName.get(name);
    if (!draft || draft.season !== PREDICT_SEASON) return 0;
    const pick = draft.pick || 999;
    // Calibrated against the consensus 2026 projection set — at the
    // prior shares we were ~4 PPG below Consensus on top rookie WRs/TEs
    // (Tate, Tyson, Sadiq) and ~1.5 PPG too high on R3+ RB depth.
    // These are workload shares (target/rush share of position
    // pool); R1 WRs see WR1-level targets, R1 RBs lead-back carry
    // share, R1 TEs full TE1 target share.
    if (pos === 'RB') {
      if (pick <= 32)  return 0.55;
      if (pick <= 64)  return 0.30;
      if (pick <= 100) return 0.15;
      if (pick <= 150) return 0.08;
      return 0.03;
    }
    if (pos === 'WR') {
      if (pick <= 16)  return 0.35;
      if (pick <= 32)  return 0.28;
      if (pick <= 64)  return 0.18;
      if (pick <= 100) return 0.12;
      if (pick <= 150) return 0.08;
      return 0.05;
    }
    if (pos === 'TE') {
      if (pick <= 16)  return 0.40;
      if (pick <= 32)  return 0.30;
      if (pick <= 64)  return 0.20;
      if (pick <= 100) return 0.12;
      if (pick <= 150) return 0.08;
      return 0.05;
    }
    if (pos === 'QB') {
      if (pick <= 3)   return 0.85;
      if (pick <= 15)  return 0.50;
      if (pick <= 32)  return 0.25;
      if (pick <= 100) return 0.10;
      return 0.05;
    }
    return 0;
  }

  // Age-based regression factor
  function ageFactor(name: string, pos: string): number {
    const draft = draftByName.get(name);
    if (!draft) return 1;
    const age = (draft.age || 0) + (PREDICT_SEASON - draft.season);
    if (pos === 'RB') {
      if (age >= 30) return 0.80;
      if (age >= 28) return 0.90;
      if (age >= 26) return 0.95;
    } else if (pos === 'WR') {
      if (age >= 32) return 0.85;
      if (age >= 30) return 0.92;
    } else if (pos === 'QB') {
      if (age >= 38) return 0.90;
      if (age >= 36) return 0.95;
    } else if (pos === 'TE') {
      if (age >= 32) return 0.88;
      if (age >= 30) return 0.94;
    }
    return 1;
  }

  // Threshold below which a player is considered to have missed significant time
  const INJURY_GAMES = 13;
  const FULL_SEASON_GAMES = 16;

  // Scale a stat to full-season equivalent for an injured player.
  // Only applied to the primary starter (index 0 in ADP-sorted list) so that
  // backups who filled in don't get projected for the same usage in 2026.
  function healthAdjust(value: number, games: number): number {
    if (games >= INJURY_GAMES) return value;
    return value * (FULL_SEASON_GAMES / Math.max(games, 1));
  }

  // Projected games: regress toward 16.
  // Primary starters who missed significant time regress more strongly (assume health).
  function projectGames(prior: SeasonTotals | undefined, isPrimary = false): number {
    if (!prior) return 14;
    if (isPrimary && prior.games < INJURY_GAMES) {
      // Injured primary starter: regress 80% toward full season
      return Math.min(17, Math.round((prior.games * 0.2 + 16 * 0.8) * 10) / 10);
    }
    return Math.min(17, Math.round((prior.games * 0.6 + 16 * 0.4) * 10) / 10);
  }

  // ── Step 2: Aggregate prior-season TEAM totals ──
  interface TeamStats {
    passAtt: number; passComp: number; passYds: number; passTD: number; int: number;
    rushAtt: number; rushYds: number; rushTD: number;
    targets: number; receptions: number; recYds: number; recTD: number;
  }
  const priorTeamTotals = new Map<string, TeamStats>();
  for (const p of priorTotals) {
    if (!p.recent_team || !['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
    const pteam = normTeam(p.recent_team);
    if (!priorTeamTotals.has(pteam)) {
      priorTeamTotals.set(pteam, {
        passAtt: 0, passComp: 0, passYds: 0, passTD: 0, int: 0,
        rushAtt: 0, rushYds: 0, rushTD: 0,
        targets: 0, receptions: 0, recYds: 0, recTD: 0,
      });
    }
    const t = priorTeamTotals.get(pteam)!;
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

  // League average team totals
  const leagueAvg: TeamStats = {
    passAtt: 0, passComp: 0, passYds: 0, passTD: 0, int: 0,
    rushAtt: 0, rushYds: 0, rushTD: 0,
    targets: 0, receptions: 0, recYds: 0, recTD: 0,
  };
  const nTeams = priorTeamTotals.size || 1;
  for (const t of priorTeamTotals.values()) {
    for (const k of Object.keys(leagueAvg) as (keyof TeamStats)[]) leagueAvg[k] += t[k];
  }
  for (const k of Object.keys(leagueAvg) as (keyof TeamStats)[]) leagueAvg[k] = Math.round(leagueAvg[k] / nTeams);

  // ── Step 3: Project team totals ──
  // Use ensemble projections (Ridge delta + LightGBM) when available,
  // with blend fallback for stats/teams not covered.
  const { teamWeight } = projectionConfig.winner;
  const leagueWeight = 1 - teamWeight;
  const ensembleTeams = (teamProjectionsEnsemble.season === PREDICT_SEASON
    ? teamProjectionsEnsemble.teams : null) as Record<string, Record<string, number>> | null;

  const projectedTeamTotals = new Map<string, TeamStats>();
  for (const [team, prior] of priorTeamTotals) {
    const blend: TeamStats = {} as TeamStats;
    for (const k of Object.keys(leagueAvg) as (keyof TeamStats)[]) {
      blend[k] = Math.round(prior[k] * teamWeight + leagueAvg[k] * leagueWeight);
    }
    const ep = ensembleTeams?.[team];
    if (ep) {
      // Use ensemble for volume stats, blend for the rest
      blend.passAtt    = ep.passAtt    ?? blend.passAtt;
      blend.rushAtt    = ep.rushAtt    ?? blend.rushAtt;
      blend.targets    = ep.targets    ?? blend.targets;
      blend.receptions = ep.receptions ?? blend.receptions;
      blend.passTD     = ep.passTD     ?? blend.passTD;
      blend.rushTD     = ep.rushTD     ?? blend.rushTD;
      blend.passYds    = ep.passYds    ?? blend.passYds;
      blend.rushYds    = ep.rushYds    ?? blend.rushYds;
      blend.recYds     = ep.recYds     ?? blend.recYds;
    }
    projectedTeamTotals.set(team, blend);
  }

  // Build projected team totals map for share display in team view
  const ptmMap = new Map<string, TeamTotalRow>();
  for (const [team, t] of projectedTeamTotals) {
    ptmMap.set(team, {
      team, passAtt: t.passAtt, passComp: t.passComp, passYds: t.passYds, passTD: t.passTD, int: t.int,
      rushAtt: t.rushAtt, rushYds: t.rushYds, rushTD: t.rushTD,
      tgt: t.targets, rec: t.receptions, recYds: t.recYds, recTD: t.recTD,
      pprPts: 0,
    });
  }

  // ── Step 3b: Compute per-team position pool shares from prior season ──
  // Instead of hardcoded "RBs get 88% of rush att", compute actual shares
  interface PosPoolShares {
    qbPassAtt: number; qbRushAtt: number; qbRushYds: number; qbRushTD: number;
    rbRushAtt: number; rbRushYds: number; rbRushTD: number; rbTgt: number; rbRecTD: number;
    wrTgt: number; wrRecTD: number; wrRushAtt: number; wrRushYds: number; wrRushTD: number;
    teTgt: number; teRecTD: number;
  }

  // Compute actual shares from prior-season player stats grouped by team+position
  function computePoolShares(team: string): PosPoolShares {
    const teamPlayers = priorTotals.filter(
      (p) => normTeam(p.recent_team) === team && ['QB', 'RB', 'WR', 'TE'].includes(p.position)
    );
    const teamRushAtt = teamPlayers.reduce((s, p) => s + (p.carries || 0), 0) || 1;
    const teamRushYds = teamPlayers.reduce((s, p) => s + (p.rushing_yards || 0), 0) || 1;
    const teamRushTD = teamPlayers.reduce((s, p) => s + (p.rushing_tds || 0), 0) || 1;
    const teamTgt = teamPlayers.reduce((s, p) => s + (p.targets || 0), 0) || 1;
    const teamRecTD = teamPlayers.reduce((s, p) => s + (p.receiving_tds || 0), 0) || 1;
    const teamPassAtt = teamPlayers.reduce((s, p) => s + (p.attempts || 0), 0) || 1;

    const byPos = (pos: string) => teamPlayers.filter((p) => p.position === pos);

    const qbs = byPos('QB');
    const rbPlayers = byPos('RB');
    const wrPlayers = byPos('WR');
    const tePlayers = byPos('TE');

    return {
      qbPassAtt: qbs.reduce((s, p) => s + (p.attempts || 0), 0) / teamPassAtt,
      qbRushAtt: qbs.reduce((s, p) => s + (p.carries || 0), 0) / teamRushAtt,
      qbRushYds: qbs.reduce((s, p) => s + (p.rushing_yards || 0), 0) / teamRushYds,
      qbRushTD: qbs.reduce((s, p) => s + (p.rushing_tds || 0), 0) / teamRushTD,
      rbRushAtt: rbPlayers.reduce((s, p) => s + (p.carries || 0), 0) / teamRushAtt,
      rbRushYds: rbPlayers.reduce((s, p) => s + (p.rushing_yards || 0), 0) / teamRushYds,
      rbRushTD: rbPlayers.reduce((s, p) => s + (p.rushing_tds || 0), 0) / teamRushTD,
      rbTgt: rbPlayers.reduce((s, p) => s + (p.targets || 0), 0) / teamTgt,
      rbRecTD: rbPlayers.reduce((s, p) => s + (p.receiving_tds || 0), 0) / teamRecTD,
      wrTgt: wrPlayers.reduce((s, p) => s + (p.targets || 0), 0) / teamTgt,
      wrRecTD: wrPlayers.reduce((s, p) => s + (p.receiving_tds || 0), 0) / teamRecTD,
      wrRushAtt: wrPlayers.reduce((s, p) => s + (p.carries || 0), 0) / teamRushAtt,
      wrRushYds: wrPlayers.reduce((s, p) => s + (p.rushing_yards || 0), 0) / teamRushYds,
      wrRushTD: wrPlayers.reduce((s, p) => s + (p.rushing_tds || 0), 0) / teamRushTD,
      teTgt: tePlayers.reduce((s, p) => s + (p.targets || 0), 0) / teamTgt,
      teRecTD: tePlayers.reduce((s, p) => s + (p.receiving_tds || 0), 0) / teamRecTD,
    };
  }

  // League-average position pool shares (fallback / regression target)
  const leaguePoolShares: PosPoolShares = {
    qbPassAtt: 0, qbRushAtt: 0, qbRushYds: 0, qbRushTD: 0,
    rbRushAtt: 0, rbRushYds: 0, rbRushTD: 0, rbTgt: 0, rbRecTD: 0,
    wrTgt: 0, wrRecTD: 0, wrRushAtt: 0, wrRushYds: 0, wrRushTD: 0,
    teTgt: 0, teRecTD: 0,
  };
  const teamsWithShares: PosPoolShares[] = [];
  for (const team of priorTeamTotals.keys()) {
    const shares = computePoolShares(team);
    teamsWithShares.push(shares);
  }
  if (teamsWithShares.length > 0) {
    for (const k of Object.keys(leaguePoolShares) as (keyof PosPoolShares)[]) {
      leaguePoolShares[k] = teamsWithShares.reduce((s, t) => s + t[k], 0) / teamsWithShares.length;
    }
  }

  // ── Step 3c: Detect coaching changes & carry over coach tendencies ──
  // Build team ↔ coach maps for prior and current seasons
  const priorSeasonGames = gamesData.filter(
    (g) => g.season === PREDICT_SEASON - 1 && g.game_type === 'REG'
  );
  const currentSeasonGames = gamesData.filter(
    (g) => g.season === PREDICT_SEASON && g.game_type === 'REG'
  );
  const priorCoach = new Map<string, string>(); // team → coach last season
  const coachPriorTeam = new Map<string, string>(); // coach → team last season
  for (const g of priorSeasonGames) {
    if (g.home_coach) {
      priorCoach.set(g.home_team, g.home_coach);
      coachPriorTeam.set(g.home_coach, g.home_team);
    }
    if (g.away_coach) {
      priorCoach.set(g.away_team, g.away_coach);
      coachPriorTeam.set(g.away_coach, g.away_team);
    }
  }
  const currentCoach = new Map<string, string>(); // team → coach this season
  for (const g of currentSeasonGames) {
    if (g.home_coach) currentCoach.set(g.home_team, g.home_coach);
    if (g.away_coach) currentCoach.set(g.away_team, g.away_coach);
  }

  // Identify coaching changes and where the new coach came from
  // coachOriginTeam: for teams with new HC, the team that coach ran last year
  const coachChangedTeams = new Set<string>();
  const coachOriginTeam = new Map<string, string>(); // new team → coach's old team
  for (const [team, coach] of currentCoach) {
    const prev = priorCoach.get(team);
    if (prev && prev !== coach) {
      coachChangedTeams.add(team);
      // Where did this coach come from?
      const origin = coachPriorTeam.get(coach);
      if (origin && origin !== team) {
        coachOriginTeam.set(team, origin);
      }
    }
  }

  // Blend pool shares:
  // Same coach:  75% team + 25% league
  // New coach (promoted/first-time): 35% team + 65% league
  // New coach from another team: 30% team + 40% coach's old team + 30% league
  function getTeamPools(team: string): PosPoolShares {
    const teamShares = computePoolShares(team);

    if (!coachChangedTeams.has(team)) {
      // Same coach — mostly preserve team tendencies
      const blended: PosPoolShares = {} as PosPoolShares;
      for (const k of Object.keys(leaguePoolShares) as (keyof PosPoolShares)[]) {
        blended[k] = teamShares[k] * 0.75 + leaguePoolShares[k] * 0.25;
      }
      return blended;
    }

    const origin = coachOriginTeam.get(team);
    if (origin) {
      // New coach from another team — blend in his old team's tendencies
      const coachShares = computePoolShares(origin);
      const blended: PosPoolShares = {} as PosPoolShares;
      for (const k of Object.keys(leaguePoolShares) as (keyof PosPoolShares)[]) {
        blended[k] = teamShares[k] * 0.30 + coachShares[k] * 0.40 + leaguePoolShares[k] * 0.30;
      }
      return blended;
    }

    // New coach but no prior HC record (promoted coordinator / first-time HC)
    const blended: PosPoolShares = {} as PosPoolShares;
    for (const k of Object.keys(leaguePoolShares) as (keyof PosPoolShares)[]) {
      blended[k] = teamShares[k] * 0.35 + leaguePoolShares[k] * 0.65;
    }
    return blended;
  }

  // ── Step 4: Build player roster for each team ──
  // Collect all players we'll project: ADP players + roster fill-ins
  interface PlayerCandidate {
    name: string; team: string; position: Position; adp: number;
    prior: SeasonTotals | undefined;
  }

  const candidatesByTeamPos = new Map<string, PlayerCandidate[]>();
  function tpKey(team: string, pos: string) { return `${team}:${pos}`; }
  function ensureList(key: string) {
    if (!candidatesByTeamPos.has(key)) candidatesByTeamPos.set(key, []);
    return candidatesByTeamPos.get(key)!;
  }

  const addedNames = new Set<string>();

  // First pass: ADP players (have draft capital / expected starters).
  // Cap matches MAX_ADP=400 from precompute-features so every player we
  // publish predictions for also appears in the projection tables.
  for (const adp of adpData) {
    if (!POSITIONS.includes(adp.position as Position)) continue;
    if (adp.adp > 400) continue;
    const nn = normalizeName(adp.name);
    const team = normTeam(rosterTeam.get(nn) || adp.team || '');
    if (!team) continue;
    const prior = priorByName.get(nn);
    ensureList(tpKey(team, adp.position)).push({
      name: adp.name, team, position: adp.position as Position,
      adp: adp.adp, prior,
    });
    addedNames.add(nn);
  }

  // Second pass: rostered players not in ADP. Rookies land here
  // because community ADP doesn't price them yet — assign a synthetic
  // ADP based on draft pick + position so high-pick rookies sort
  // ahead of vet bench pieces (Mendoza R1 #1 LV ahead of Aidan O'Connell,
  // Jeremiyah Love R1 #3 ARI ahead of Trey Benson, etc.). Without
  // this, every drafted rookie sorts to ADP 999 and gets the depth-
  // piece projection branch downstream.
  function syntheticRookieAdp(name: string, pos: string): number {
    const draft = draftByName.get(name);
    if (!draft || draft.season !== PREDICT_SEASON) return 999;
    const pick = draft.pick || 999;
    if (pos === 'RB') {
      if (pick <= 32)  return 50;
      if (pick <= 64)  return 100;
      if (pick <= 100) return 150;
      return 200;
    }
    if (pos === 'WR') {
      if (pick <= 16)  return 30;
      if (pick <= 32)  return 70;
      if (pick <= 64)  return 130;
      if (pick <= 100) return 180;
      return 230;
    }
    if (pos === 'TE') {
      if (pick <= 16)  return 60;
      if (pick <= 32)  return 110;
      if (pick <= 64)  return 170;
      return 220;
    }
    if (pos === 'QB') {
      if (pick <= 3)   return 80;
      if (pick <= 15)  return 150;
      if (pick <= 32)  return 220;
      return 280;
    }
    return 999;
  }
  for (const r of rosters) {
    if (!POSITIONS.includes(r.position as Position)) continue;
    const nn = normalizeName(r.full_name);
    if (addedNames.has(nn)) continue;
    const prior = priorByName.get(nn);
    ensureList(tpKey(normTeam(r.team), r.position)).push({
      name: r.full_name, team: normTeam(r.team), position: r.position as Position,
      adp: syntheticRookieAdp(nn, r.position), prior,
    });
    addedNames.add(nn);
  }

  // Third pass: prior-season players not yet captured
  for (const p of priorTotals) {
    if (!POSITIONS.includes(p.position as Position)) continue;
    const nn = normalizeName(p.player_display_name);
    if (addedNames.has(nn)) continue;
    const team = normTeam(rosterTeam.get(nn) || p.recent_team || '');
    if (!team) continue;
    ensureList(tpKey(team, p.position)).push({
      name: p.player_display_name, team, position: p.position as Position,
      adp: 999, prior: p,
    });
    addedNames.add(nn);
  }

  // Sort each team+pos group. Primary: Consensus's depth chart (lower
  // index = starter). Secondary: ADP. Tertiary: prior PPR. Players
  // not in Consensus's depth chart get rank 9999 and fall through to
  // ADP-based ordering — same as before for that subset.
  for (const [key, list] of candidatesByTeamPos) {
    const [team, pos] = key.split(':');
    list.sort((a, b) => {
      const aDepth = depthRank(team, pos, a.name);
      const bDepth = depthRank(team, pos, b.name);
      if (aDepth !== bDepth) return aDepth - bDepth;
      if (a.adp !== b.adp) return a.adp - b.adp;
      const aPPR = a.prior ? (a.prior.fantasy_points_ppr || 0) : 0;
      const bPPR = b.prior ? (b.prior.fantasy_points_ppr || 0) : 0;
      return bPPR - aPPR;
    });
  }

  // ── Step 5: Compute shares & split the team pie ──
  const qbs: QBProjection[] = [];
  const rbs: RBProjection[] = [];
  const wrs: WRProjection[] = [];
  const tes: TEProjection[] = [];

  const allTeams = new Set<string>();
  for (const r of rosters) { if (r.team && POSITIONS.includes(r.position as Position)) allTeams.add(normTeam(r.team)); }
  for (const [team] of priorTeamTotals) allTeams.add(team);

  for (const team of allTeams) {
    const projTeam = projectedTeamTotals.get(team);
    if (!projTeam) continue;

    // Per-team position pool shares (computed from prior season + coach regression)
    const pools = getTeamPools(team);

    for (const pos of POSITIONS) {
      const players = (candidatesByTeamPos.get(tpKey(team, pos)) || []).slice(0, TEAM_POS_LIMITS[pos]);

      if (pos === 'QB') {
        // Rush share still uses prior-season tendencies (scrambling style varies by QB).
        const priorRushAttTotal = players.reduce((s, p, i) => {
          const car = p.prior?.carries || 0;
          const g = p.prior?.games ?? 17;
          return s + (i === 0 ? healthAdjust(car, g) : car);
        }, 0);
        const qbPassPool = projTeam.passAtt * pools.qbPassAtt;
        const qbRushPool = projTeam.rushAtt * pools.qbRushAtt;
        const qbRushTDPool = projTeam.rushTD * pools.qbRushTD;

        // Zero-sum QB games: starter gets projected games (health-adjusted), backup gets remainder to 17.
        // Players are sorted by ADP ascending, so players[0] is the starter.
        const starterProjected = players.length > 0 ? Math.round(projectGames(players[0].prior, true)) : 17;
        const starterGames = players.length === 1 ? 17 : Math.min(16, Math.max(1, starterProjected));

        // Track allocated pool so each subsequent QB fills the remainder,
        // guaranteeing QB totals always equal the team's projected passing budget.
        let allocatedPassAtt = 0;
        let allocatedPassTD = 0;
        let allocatedPassYds = 0;
        let allocatedRushAtt = 0;

        for (let idx = 0; idx < players.length; idx++) {
          const player = players[idx];
          const isPrimary = idx === 0;
          const prior = player.prior;
          const games = idx === 0 ? starterGames : 17 - starterGames;
          const gamesScale = games / 17;
          const sp = players[0]?.prior; // starter's prior — used for backup rate reference

          let passAtt: number, passComp: number, passYds: number, passTD: number, ints: number;
          let rushAtt: number, rushYds: number, rushTD: number;

          // High-pick rookie QBs (top 15) project as starters even
          // without prior NFL stats — Mendoza R1 #1 LV starts week 1
          // by every reasonable expectation. Treat them like the
          // starter branch but use rookie-typical efficiency rates.
          const rookieQbShare = rookieShare(normalizeName(player.name), 'QB');
          const isRookieStarter = isPrimary && (!prior || prior.games < 3) && rookieQbShare >= 0.5;
          if ((isPrimary && prior && prior.games >= 3) || isRookieStarter) {
            // Starter throws ALL team passes in their games (no intra-game sharing with backup).
            // Game allocation already encodes the time split, so no passShare multiplier needed.
            passAtt = Math.round(qbPassPool * gamesScale);
            const compRate = (prior?.attempts || 0) > 0 ? (prior!.completions || 0) / prior!.attempts : 0.62;
            passComp = Math.round(passAtt * compRate);
            // Anchor passYds to the team's projected passing yards so QB passYds
            // reconcile with receiver recYds (same pool, gamesScale applied like receivers)
            passYds = Math.round(projTeam.passYds * gamesScale);
            // Anchor TDs to the team's projected receiving TD budget so QB passTDs
            // reconcile with receiver recTDs (same pool, gamesScale applied like receivers)
            passTD = Math.round(projTeam.recTD * gamesScale);
            const intRate = (prior?.attempts || 0) > 0 ? (prior!.interceptions || 0) / prior!.attempts : 0.028;
            ints = Math.round(passAtt * intRate);

            const adjCar = prior ? healthAdjust(prior.carries || 0, prior.games) : 0;
            // Rookie starters: assume moderate rush share (0.5 of QB rush
            // pool) — rookies are often more mobile than vets but we
            // don't want to overcommit without a usage signal.
            const rushShare = priorRushAttTotal > 0
              ? adjCar / priorRushAttTotal
              : (isRookieStarter ? 0.5 : 0.5);
            rushAtt = Math.round(qbRushPool * rushShare * gamesScale);
            const ypc = (prior?.carries || 0) > 0 ? (prior!.rushing_yards || 0) / prior!.carries : 5.0;
            rushYds = Math.round(rushAtt * ypc);
            rushTD = Math.round(qbRushTDPool * rushShare * gamesScale);
          } else {
            // Backup QB: fill remaining pool for exact reconciliation with team totals.
            // Use starter's per-play efficiency rates (slightly discounted).
            const compRate = sp && sp.attempts > 0 ? Math.min(0.68, (sp.completions || 0) / sp.attempts) : 0.60;
            const intRate = sp && sp.attempts > 0 ? Math.max(0.025, ((sp.interceptions || 0) / sp.attempts) * 1.15) : 0.032;

            passAtt = Math.max(0, Math.round(qbPassPool) - allocatedPassAtt);
            passComp = Math.round(passAtt * compRate);
            passYds = Math.max(0, Math.round(projTeam.passYds) - allocatedPassYds);
            passTD = Math.max(0, Math.round(projTeam.recTD) - allocatedPassTD);
            ints = Math.round(passAtt * intRate);

            rushAtt = Math.max(0, Math.round(qbRushPool) - allocatedRushAtt);
            rushYds = Math.round(rushAtt * 3.8);
            rushTD = 0;
          }

          allocatedPassAtt += passAtt;
          allocatedPassTD += passTD;
          allocatedPassYds += passYds;
          allocatedRushAtt += rushAtt;

          const pts = computePPR({ passYds, passTD, int: ints, rushYds, rushTD });
          qbs.push({
            name: player.name, team, adp: player.adp, games: Math.round(games),
            passAtt, passComp, passYds, passTD, int: ints,
            rushAtt, rushYds, rushTD, pprPts: Math.round(pts),
          });
        }
      } else if (pos === 'RB') {
        // Reserve pool space for top rookies first, then let vets
        // split the residual. Without this, vets divide 100% of
        // the RB pool among themselves *and* a rookie like Love
        // (R1 #3, rookieShare=0.55) gets another 55% on top —
        // double-allocating the team's RB volume and leaving Bam
        // Knight with starter carries even when Love is RB1.
        const rookieRushShareSum = players.reduce((s, p) => {
          const isRookie = !p.prior || p.prior.games < 3;
          if (!isRookie) return s;
          return s + rookieShare(normalizeName(p.name), 'RB');
        }, 0);
        const vetShareScaler = Math.max(0, 1 - rookieRushShareSum);
        const priorRushTotal = players.reduce((s, p, i) => {
          const car = p.prior?.carries || 0;
          const g = p.prior?.games ?? 17;
          return s + (i === 0 ? healthAdjust(car, g) : car);
        }, 0);
        const priorTgtTotal = players.reduce((s, p, i) => {
          const tgt = p.prior?.targets || 0;
          const g = p.prior?.games ?? 17;
          return s + (i === 0 ? healthAdjust(tgt, g) : tgt);
        }, 0);
        // ML shares are team-wide fractions — use directly from team totals
        // Fall back to position-pool allocation when ML shares unavailable
        const rbRushPool = projTeam.rushAtt * pools.rbRushAtt;
        const rbTgtPool = projTeam.targets * pools.rbTgt;
        const rbRushTDPool = projTeam.rushTD * pools.rbRushTD;
        const rbRecTDPool = projTeam.recTD * pools.rbRecTD;

        // Prior-year within-group sums (for fallback allocation)
        const priorRushTotal2 = priorRushTotal;
        const priorTgtTotal2 = priorTgtTotal;

        const rbStart = rbs.length;

        for (let idx = 0; idx < players.length; idx++) {
          const player = players[idx];
          const isPrimary = idx === 0;
          const prior = player.prior;
          const games = projectGames(prior, isPrimary);
          const af = ageFactor(normalizeName(player.name), 'RB');
          const gamesScale = games / 17;

          let rushAtt: number, rushYds: number, rushTD: number;
          let tgt: number, rec: number, recYds: number, recTD: number;

          const ml = mlShares.get(normalizeName(player.name));

          if (prior && prior.games >= 3) {
            // Rush: ML share directly from team totals, or fall back to pool
            if (ml && ml.predRushShare > 0) {
              rushAtt = Math.round(projTeam.rushAtt * ml.predRushShare * gamesScale);
              rushTD = Math.max(0, Math.round(projTeam.rushTD * ml.predRushShare * gamesScale));
            } else {
              const adjCar = isPrimary ? healthAdjust(prior.carries || 0, prior.games) : (prior.carries || 0);
              const rushShare = priorRushTotal2 > 0 ? adjCar / priorRushTotal2 : 1 / players.length;
              rushAtt = Math.round(rbRushPool * rushShare * vetShareScaler * af * gamesScale);
              rushTD = Math.max(0, Math.round(rbRushTDPool * rushShare * vetShareScaler * gamesScale));
            }
            const ypc = (prior.carries || 0) > 0 ? (prior.rushing_yards || 0) / prior.carries : 4.0;
            rushYds = Math.round(rushAtt * ypc);

            // Targets: ML share directly from team totals, or fall back to pool
            if (ml && ml.predTargetShare > 0) {
              tgt = Math.round(projTeam.targets * ml.predTargetShare * gamesScale);
              recTD = Math.max(0, Math.round(projTeam.recTD * ml.predTargetShare));
            } else {
              const adjTgt = isPrimary ? healthAdjust(prior.targets || 0, prior.games) : (prior.targets || 0);
              const tgtShare = priorTgtTotal2 > 0 ? adjTgt / priorTgtTotal2 : 1 / players.length;
              tgt = Math.round(rbTgtPool * tgtShare * vetShareScaler * af * gamesScale);
              recTD = Math.max(0, Math.round(rbRecTDPool * tgtShare * vetShareScaler));
            }
            const catchRate = shrinkRate(prior.receptions || 0, prior.targets || 0, 0.75, CATCH_RATE_K);
            rec = Math.round(tgt * catchRate);
            const ypr = shrinkRate(prior.receiving_yards || 0, prior.receptions || 0, 7.5, YPR_K);
            recYds = Math.round(rec * ypr);
          } else {
            // No prior NFL stats: 2026 rookies use draft-pick-based
            // share; everyone else falls back to the depth-piece
            // share. Rookie ypc is positional-typical (4.3); rookie
            // ypr ~7.5 from college reception data.
            const rs = rookieShare(normalizeName(player.name), 'RB');
            const share = rs > 0 ? rs : 1 / (players.length * 4);
            rushAtt = Math.round(rbRushPool * share * gamesScale);
            const ypc = rs > 0 ? 4.3 : 3.8;
            rushYds = Math.round(rushAtt * ypc);
            rushTD = Math.max(0, Math.round(rbRushTDPool * share * gamesScale));
            // Rookie target share scales down since RBs catch fewer
            // passes than they run early in their careers.
            const tgtShare = rs > 0 ? rs * 0.7 : share;
            tgt = Math.round(rbTgtPool * tgtShare * gamesScale);
            rec = Math.round(tgt * 0.72);
            const ypr = rs > 0 ? 7.5 : 6.5;
            recYds = Math.round(rec * ypr);
            recTD = Math.max(0, Math.round(rbRecTDPool * tgtShare));
          }

          const pts = computePPR({ rushYds, rushTD, rec, recYds, recTD });
          rbs.push({
            name: player.name, team, adp: player.adp, games: Math.round(games),
            rushAtt, rushYds, rushTD, tgt, rec, recYds, recTD, pprPts: Math.round(pts),
          });
        }

        // Reconcile RB rushing to the projected pool. Per-player allocations
        // are shrunk by gamesScale and ageFactor without redistribution, which
        // consistently under-allocates team rushing. Also, per-player yards use
        // prior-year ypc which can fall below the team's projected ypc, so yards
        // must be scaled against the team's projected rushYds (not the attempts
        // ratio) to keep team totals in sync.
        const rbSlice = rbs.slice(rbStart);
        const rbAllocRushAtt = rbSlice.reduce((s, p) => s + p.rushAtt, 0);
        if (rbAllocRushAtt > 0 && rbAllocRushAtt < rbRushPool) {
          const attScale = rbRushPool / rbAllocRushAtt;
          for (const p of rbSlice) {
            p.rushAtt = Math.round(p.rushAtt * attScale);
            p.rushTD = Math.max(0, Math.round(p.rushTD * attScale));
          }
        }
        const rbRushYdsPool = projTeam.rushYds * pools.rbRushYds;
        const rbAllocRushYds = rbSlice.reduce((s, p) => s + p.rushYds, 0);
        if (rbAllocRushYds > 0 && rbAllocRushYds < rbRushYdsPool) {
          const ydsScale = rbRushYdsPool / rbAllocRushYds;
          for (const p of rbSlice) p.rushYds = Math.round(p.rushYds * ydsScale);
        }
        for (const p of rbSlice) {
          p.pprPts = Math.round(computePPR({
            rushYds: p.rushYds, rushTD: p.rushTD,
            rec: p.rec, recYds: p.recYds, recTD: p.recTD,
          }));
        }
      } else if (pos === 'WR') {
        // Same vet/rookie pool composition as RB — top rookie WRs
        // claim a fixed share, vets split the residual.
        const rookieTgtShareSum = players.reduce((s, p) => {
          const isRookie = !p.prior || p.prior.games < 3;
          if (!isRookie) return s;
          return s + rookieShare(normalizeName(p.name), 'WR');
        }, 0);
        const vetShareScaler = Math.max(0, 1 - rookieTgtShareSum);
        const priorTgtTotal = players.reduce((s, p, i) => {
          const tgt = p.prior?.targets || 0;
          const g = p.prior?.games ?? 17;
          return s + (i === 0 ? healthAdjust(tgt, g) : tgt);
        }, 0);
        const priorRushTotal = players.reduce((s, p, i) => {
          const car = p.prior?.carries || 0;
          const g = p.prior?.games ?? 17;
          return s + (i === 0 ? healthAdjust(car, g) : car);
        }, 0);
        // Fallback pools (used when ML shares unavailable)
        const wrTgtPool = projTeam.targets * pools.wrTgt;
        const wrRushPool = projTeam.rushAtt * pools.wrRushAtt;
        const wrRecTDPool = projTeam.recTD * pools.wrRecTD;
        const wrRushTDPool = projTeam.rushTD * pools.wrRushTD;

        const wrStart = wrs.length;

        for (let idx = 0; idx < players.length; idx++) {
          const player = players[idx];
          const isPrimary = idx === 0;
          const prior = player.prior;
          const games = projectGames(prior, isPrimary);
          const af = ageFactor(normalizeName(player.name), 'WR');
          const gamesScale = games / 17;

          let tgt: number, rec: number, recYds: number, recTD: number;
          let rushAtt: number, rushYds: number, rushTD: number;

          const ml = mlShares.get(normalizeName(player.name));

          if (prior && prior.games >= 3) {
            // Targets: ML share directly from team totals, or fall back to pool
            if (ml && ml.predTargetShare > 0) {
              tgt = Math.round(projTeam.targets * ml.predTargetShare * gamesScale);
              recTD = Math.max(0, Math.round(projTeam.recTD * ml.predTargetShare));
            } else {
              const adjTgt = isPrimary ? healthAdjust(prior.targets || 0, prior.games) : (prior.targets || 0);
              const tgtShare = priorTgtTotal > 0 ? adjTgt / priorTgtTotal : 1 / players.length;
              tgt = Math.round(wrTgtPool * tgtShare * vetShareScaler * af * gamesScale);
              recTD = Math.max(0, Math.round(wrRecTDPool * tgtShare * vetShareScaler));
            }
            const catchRate = shrinkRate(prior.receptions || 0, prior.targets || 0, 0.65, CATCH_RATE_K);
            rec = Math.round(tgt * catchRate);
            const ypr = shrinkRate(prior.receiving_yards || 0, prior.receptions || 0, 12.5, YPR_K);
            recYds = Math.round(rec * ypr);

            // Rush: WR rush shares are negligible, use prior-year pool allocation
            const adjCar = isPrimary ? healthAdjust(prior.carries || 0, prior.games) : (prior.carries || 0);
            const rushShare = priorRushTotal > 0 ? adjCar / priorRushTotal : 0;
            rushAtt = Math.round(wrRushPool * rushShare * af * gamesScale);
            const ypc = (prior.carries || 0) > 0 ? (prior.rushing_yards || 0) / prior.carries : 5.0;
            rushYds = Math.round(rushAtt * ypc);
            rushTD = Math.max(0, Math.round(wrRushTDPool * rushShare * gamesScale));
          } else {
            // No prior NFL stats: 2026 rookies use draft-pick-based
            // target share; vets without prior fall back to depth.
            const rs = rookieShare(normalizeName(player.name), 'WR');
            const share = rs > 0 ? rs : 1 / (players.length * 4);
            tgt = Math.round(wrTgtPool * share * gamesScale);
            rec = Math.round(tgt * 0.62);
            const ypr = rs > 0 ? 12.0 : 11.0;
            recYds = Math.round(rec * ypr);
            recTD = Math.max(0, Math.round(wrRecTDPool * share));
            rushAtt = 0; rushYds = 0; rushTD = 0;
          }

          const pts = computePPR({ rushYds, rushTD, rec, recYds, recTD });
          wrs.push({
            name: player.name, team, adp: player.adp, games: Math.round(games),
            tgt, rec, recYds, recTD, rushAtt, rushYds, rushTD, pprPts: Math.round(pts),
          });
        }

        // Reconcile WR rushing to the projected pool (same issue as RBs).
        const wrSlice = wrs.slice(wrStart);
        const wrAllocRushAtt = wrSlice.reduce((s, p) => s + p.rushAtt, 0);
        if (wrAllocRushAtt > 0 && wrAllocRushAtt < wrRushPool) {
          const attScale = wrRushPool / wrAllocRushAtt;
          for (const p of wrSlice) {
            p.rushAtt = Math.round(p.rushAtt * attScale);
            p.rushTD = Math.max(0, Math.round(p.rushTD * attScale));
          }
        }
        const wrRushYdsPool = projTeam.rushYds * pools.wrRushYds;
        const wrAllocRushYds = wrSlice.reduce((s, p) => s + p.rushYds, 0);
        if (wrAllocRushYds > 0 && wrAllocRushYds < wrRushYdsPool) {
          const ydsScale = wrRushYdsPool / wrAllocRushYds;
          for (const p of wrSlice) p.rushYds = Math.round(p.rushYds * ydsScale);
        }
        for (const p of wrSlice) {
          p.pprPts = Math.round(computePPR({
            rushYds: p.rushYds, rushTD: p.rushTD,
            rec: p.rec, recYds: p.recYds, recTD: p.recTD,
          }));
        }
      } else if (pos === 'TE') {
        // Same vet/rookie pool composition as RB/WR.
        const rookieTgtShareSum = players.reduce((s, p) => {
          const isRookie = !p.prior || p.prior.games < 3;
          if (!isRookie) return s;
          return s + rookieShare(normalizeName(p.name), 'TE');
        }, 0);
        const vetShareScaler = Math.max(0, 1 - rookieTgtShareSum);
        const priorTgtTotal = players.reduce((s, p, i) => {
          const tgt = p.prior?.targets || 0;
          const g = p.prior?.games ?? 17;
          return s + (i === 0 ? healthAdjust(tgt, g) : tgt);
        }, 0);
        // Fallback pools
        const teTgtPool = projTeam.targets * pools.teTgt;
        const teRecTDPool = projTeam.recTD * pools.teRecTD;

        for (let idx = 0; idx < players.length; idx++) {
          const player = players[idx];
          const isPrimary = idx === 0;
          const prior = player.prior;
          const games = projectGames(prior, isPrimary);
          const af = ageFactor(normalizeName(player.name), 'TE');
          const gamesScale = games / 17;

          let tgt: number, rec: number, recYds: number, recTD: number;

          const ml = mlShares.get(normalizeName(player.name));

          if (prior && prior.games >= 3) {
            // Targets: ML share directly from team totals, or fall back to pool
            if (ml && ml.predTargetShare > 0) {
              tgt = Math.round(projTeam.targets * ml.predTargetShare * gamesScale);
              recTD = Math.max(0, Math.round(projTeam.recTD * ml.predTargetShare));
            } else {
              const adjTgt = isPrimary ? healthAdjust(prior.targets || 0, prior.games) : (prior.targets || 0);
              const tgtShare = priorTgtTotal > 0 ? adjTgt / priorTgtTotal : 1 / players.length;
              tgt = Math.round(teTgtPool * tgtShare * vetShareScaler * af * gamesScale);
              recTD = Math.max(0, Math.round(teRecTDPool * tgtShare * vetShareScaler));
            }
            const catchRate = shrinkRate(prior.receptions || 0, prior.targets || 0, 0.68, CATCH_RATE_K);
            rec = Math.round(tgt * catchRate);
            const ypr = shrinkRate(prior.receiving_yards || 0, prior.receptions || 0, 11.0, YPR_K);
            recYds = Math.round(rec * ypr);
          } else {
            // No prior NFL stats: 2026 rookies use draft-pick-based
            // target share; vets without prior fall back to depth.
            const rs = rookieShare(normalizeName(player.name), 'TE');
            const share = rs > 0 ? rs : 1 / (players.length * 4);
            tgt = Math.round(teTgtPool * share * gamesScale);
            rec = Math.round(tgt * 0.65);
            const ypr = rs > 0 ? 10.5 : 9.5;
            recYds = Math.round(rec * ypr);
            recTD = Math.max(0, Math.round(teRecTDPool * share));
          }

          const pts = computePPR({ rec, recYds, recTD });
          tes.push({
            name: player.name, team, adp: player.adp, games: Math.round(games),
            tgt, rec, recYds, recTD, pprPts: Math.round(pts),
          });
        }
      }
    }
  }

  // Team-level reconciliation: normalize each team's rushing and receiving
  // totals across all its players to match the projected team totals.
  // Per-position pool reconciliation handles most of the gap, but
  // (a) pool shares can sum to slightly <1 due to blending, (b) some stats
  // are derived from per-player rates (ypc / ypr / catchRate) and never
  // tied to a team pool, (c) rounding drift compounds. This final pass
  // guarantees team totals match projections within rounding.
  for (const team of allTeams) {
    const projTeam = projectedTeamTotals.get(team);
    if (!projTeam) continue;

    const teamQbs = qbs.filter((p) => p.team === team);
    const teamRbs = rbs.filter((p) => p.team === team);
    const teamWrs = wrs.filter((p) => p.team === team);
    const teamTes = tes.filter((p) => p.team === team);
    const rushers = [...teamQbs, ...teamRbs, ...teamWrs];
    const receivers = [...teamRbs, ...teamWrs, ...teamTes];

    const scaleUpToMatch = <T extends object>(
      items: T[], key: keyof T, target: number,
    ) => {
      const total = items.reduce((s, p) => s + ((p[key] as unknown as number) || 0), 0);
      if (total <= 0 || Math.abs(total - target) <= 1) return;
      const scale = target / total;
      for (const p of items) {
        (p[key] as unknown as number) = Math.round(((p[key] as unknown as number) || 0) * scale);
      }
    };

    if (rushers.length > 0) {
      scaleUpToMatch(rushers, 'rushAtt', projTeam.rushAtt);
      scaleUpToMatch(rushers, 'rushYds', projTeam.rushYds);
    }
    if (receivers.length > 0) {
      scaleUpToMatch(receivers, 'tgt', projTeam.targets);
      scaleUpToMatch(receivers, 'rec', projTeam.receptions);
      scaleUpToMatch(receivers, 'recYds', projTeam.recYds);
    }

    // Refresh PPR points for everyone touched.
    for (const p of teamRbs) {
      p.pprPts = Math.round(computePPR({
        rushYds: p.rushYds, rushTD: p.rushTD,
        rec: p.rec, recYds: p.recYds, recTD: p.recTD,
      }));
    }
    for (const p of teamWrs) {
      p.pprPts = Math.round(computePPR({
        rushYds: p.rushYds, rushTD: p.rushTD,
        rec: p.rec, recYds: p.recYds, recTD: p.recTD,
      }));
    }
    for (const p of teamTes) {
      p.pprPts = Math.round(computePPR({
        rec: p.rec, recYds: p.recYds, recTD: p.recTD,
      }));
    }
    for (const p of teamQbs) {
      p.pprPts = Math.round(computePPR({
        passYds: p.passYds, passTD: p.passTD, int: p.int,
        rushYds: p.rushYds, rushTD: p.rushTD,
      }));
    }
  }

  // ── Anchor receiver projections to the validated ML PPG model ──
  // The team-volume model compresses the WR/TE distribution: it under-
  // rates true alphas (it splits a team's targets too evenly) and over-
  // rates the lone receiver left on a team whose starter departed (he
  // inherits the vacated pool via the team-total reconciliation). The
  // in-repo ML PPG model (score-store/ppg.json → `mlPPG`) tracks
  // consensus far better, so anchor each modeled receiver's PPG to it
  // and rescale the stat line to match. Receivers the ML model doesn't
  // cover are non-featured by construction, so haircut them toward depth.
  // Weights are calibrated against a 2026 consensus projection set and
  // live here (not in committed data).
  const ML_ANCHOR = 0.8;          // weight on ML PPG for modeled receivers
  const NONMODELED_HAIRCUT = 0.7; // scale for receivers absent from the ML model
  const anchorReceiver = (p: WRProjection | TEProjection) => {
    const games = p.games || 16;
    const volPPG = games > 0 ? p.pprPts / games : 0;
    const ml = mlPPG.get(normalizeName(p.name)) || 0;
    const finalPPG = ml > 0
      ? ML_ANCHOR * ml + (1 - ML_ANCHOR) * volPPG
      : volPPG * NONMODELED_HAIRCUT;
    const scale = volPPG > 0 ? finalPPG / volPPG : 1;
    const w = p as WRProjection;
    w.tgt = Math.round((w.tgt || 0) * scale);
    w.rec = Math.round((w.rec || 0) * scale);
    w.recYds = Math.round((w.recYds || 0) * scale);
    w.recTD = Math.round(((w.recTD || 0) * scale) * 10) / 10;
    if (w.rushYds) w.rushYds = Math.round(w.rushYds * scale);
    if (w.rushTD) w.rushTD = Math.round((w.rushTD * scale) * 10) / 10;
    p.pprPts = Math.round(finalPPG * games);
  };
  wrs.forEach(anchorReceiver);
  tes.forEach(anchorReceiver);

  // "Depth-order wins ordering": within each team, assign the WR/TE point
  // values in the depth-order model's rank order, so the modeled #1 is
  // the projected #1 even when the ML-PPG anchor would rank a teammate
  // higher — e.g. injury-year returnees the PPG model under-rates
  // (Marvin Harrison Jr. over Michael Wilson on ARI). Same point values,
  // reassigned by rank, so team totals are unchanged. No-op where the
  // anchor order already matches the model, and skipped when the model
  // has no opinion for a team/position.
  for (const [arr, pos] of [[wrs, 'WR'], [tes, 'TE']] as const) {
    const byTeam = new Map<string, typeof arr>();
    for (const p of arr) (byTeam.get(p.team) ?? byTeam.set(p.team, []).get(p.team)!).push(p);
    for (const [team, group] of byTeam) {
      if (group.length < 2) continue;
      if (group.every((p) => depthRank(team, pos, p.name) >= 9999)) continue;
      const byRank = [...group].sort((a, b) => depthRank(team, pos, a.name) - depthRank(team, pos, b.name));
      const byPts = [...group].sort((a, b) => b.pprPts - a.pprPts);
      const fields = ['tgt', 'rec', 'recYds', 'recTD', 'rushAtt', 'rushYds', 'rushTD', 'pprPts'] as const;
      const slots = byPts.map((s) => Object.fromEntries(fields.map((f) => [f, (s as unknown as Record<string, number>)[f] ?? 0])));
      byRank.forEach((p, i) => { for (const f of fields) (p as unknown as Record<string, number>)[f] = slots[i][f]; });
    }
  }

  // Sort by PPR points descending
  qbs.sort((a, b) => b.pprPts - a.pprPts);
  rbs.sort((a, b) => b.pprPts - a.pprPts);
  wrs.sort((a, b) => b.pprPts - a.pprPts);
  tes.sort((a, b) => b.pprPts - a.pprPts);

  // ── In-season: blend every stat line toward what is actually happening ──
  // Runs LAST, after team reconciliation and the ML anchor, so it is the final
  // word: by week 5 a player's own four games say more about his role than any
  // preseason model does. Blended per COMPONENT and then re-scored, so the
  // published stat line still adds up to pprPts.
  //
  // The weight uses the PLAYER's games, not the league's week number: someone
  // who has played one game in four weeks gets one game's worth of weight,
  // which is the honest reading of a small sample.
  if (currentStats && currentStats.length > 0) {
    // League weeks elapsed — the denominator for availability. A player with 2
    // games in 4 weeks is a different projection from one with 2 games in 2.
    let weeksElapsed = 0;
    for (const r of currentStats) {
      if (r.season_type === 'REG') weeksElapsed = Math.max(weeksElapsed, Number(r.week) || 0);
    }
    const actualByName = new Map<string, { games: number; pg: Record<string, number> }>();
    for (const t of aggregateToSeasonTotals(
      currentStats.filter((r) => r.season_type === 'REG')
    ) as unknown as Array<Record<string, unknown>>) {
      const games = Number(t.games) || 0;
      const name = String(t.player_display_name || '');
      if (!games || !name) continue;
      const n = (key: string) => (Number(t[key]) || 0) / games;
      actualByName.set(normalizeName(name), {
        games,
        pg: {
          passAtt: n('attempts'), passComp: n('completions'), passYds: n('passing_yards'),
          passTD: n('passing_tds'), int: n('interceptions'),
          rushAtt: n('carries'), rushYds: n('rushing_yards'), rushTD: n('rushing_tds'),
          tgt: n('targets'), rec: n('receptions'), recYds: n('receiving_yards'),
          recTD: n('receiving_tds'),
        },
      });
    }
    for (const [pos, list] of [['QB', qbs], ['RB', rbs], ['WR', wrs], ['TE', tes]] as const) {
      const k = IN_SEASON_K[pos];
      const fields = IN_SEASON_FIELDS[pos];
      for (const row of list as unknown as Array<Record<string, number | string>>) {
        const actual = actualByName.get(normalizeName(String(row.name || '')));
        const projGames = Number(row.games) || 0;
        if (!actual || !projGames) continue;
        const w = actual.games / (actual.games + k);
        // Availability first, because every component below is a season total
        // = per-game rate x games. A player who has missed two of four weeks
        // should not be projected for a full slate of the remaining ones.
        let games = projGames;
        if (weeksElapsed > 0) {
          const priorRate = Math.min(1, projGames / 17);
          const rate = (actual.games + AVAILABILITY_PSEUDO_COUNT * priorRate)
            / (weeksElapsed + AVAILABILITY_PSEUDO_COUNT);
          games = Math.min(17, actual.games + Math.max(0, 17 - weeksElapsed) * rate);
          row.games = Math.round(games * 10) / 10;
        }
        for (const f of fields) {
          const projPg = (Number(row[f]) || 0) / projGames;
          const val = ((1 - w) * projPg + w * (actual.pg[f] ?? projPg)) * games;
          row[f] = Math.round(val * 10) / 10;
        }
        row.pprPts = Math.round(computePPR({
          passYds: Number(row.passYds) || 0, passTD: Number(row.passTD) || 0,
          int: Number(row.int) || 0,
          rushYds: Number(row.rushYds) || 0, rushTD: Number(row.rushTD) || 0,
          rec: Number(row.rec) || 0, recYds: Number(row.recYds) || 0,
          recTD: Number(row.recTD) || 0,
        }));
        row.inSeasonGames = actual.games;
        row.inSeasonWeight = Math.round(w * 100) / 100;
      }
    }
    // No summary field here: `meta` is a Map keyed by player, and a stray
    // property on it would not survive serialization. The rows carry
    // inSeasonGames / inSeasonWeight, and scripts/build-projection-pool.ts
    // rolls those up into the artifact's own inSeason block.
  }

  return {
    qbs, rbs, wrs, tes,
    meta,
    depthChart,
    projAdpMap,
    projPPGMap,
    freeAgents,
    teamRosterMap,
    consensusPprMap,
    consensusStatsMap,
    projTeamTotals: ptmMap,
    oddsSource: usingLiveOdds ? 'live' : 'historical',
  };
}
