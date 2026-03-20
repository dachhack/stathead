import { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Label, Legend,
  ScatterChart, Scatter,
} from 'recharts';
import {
  fetchFfcADP, fetchPlayerStats, aggregateToSeasonTotals,
  fetchCombine, fetchDraftPicks, fetchSnapCounts, fetchInjuries,
  fetchNextGenStats, fetchPlayByPlay,
} from '../data';
import type { SeasonTotals, CombineResult, DraftPick, PlayerStats, NextGenStats, PlayByPlay } from '../types';
import { trainRidgeRegression, type TrainedModel } from '../lib/ridge';

// ── Config ──

// Need prior-season data, so training starts at 2021
const SEASONS = [2021, 2022, 2023, 2024, 2025];
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const POS_COLORS: Record<string, string> = {
  QB: '#6366f1', RB: '#10b981', WR: '#f59e0b', TE: '#ef4444',
};

// ── Feature definitions by position ──

interface FeatureDef {
  key: string;
  label: string;
  category: string;
  positions: string[]; // which positions use this feature
}

const FEATURES: FeatureDef[] = [
  // ADP context
  { key: 'adp', label: 'ADP', category: 'Draft', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'adpRound', label: 'ADP Round', category: 'Draft', positions: ['QB', 'RB', 'WR', 'TE'] },

  // Player profile
  { key: 'age', label: 'Age', category: 'Profile', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'yearsInLeague', label: 'Years in League', category: 'Profile', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'nflDraftRound', label: 'NFL Draft Round', category: 'Profile', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'nflDraftPick', label: 'NFL Draft Pick', category: 'Profile', positions: ['QB', 'RB', 'WR', 'TE'] },

  // Physical
  { key: 'weight', label: 'Weight', category: 'Physical', positions: ['RB', 'WR', 'TE'] },
  { key: 'forty', label: '40-Yard Dash', category: 'Physical', positions: ['RB', 'WR', 'TE'] },
  { key: 'bmi', label: 'BMI', category: 'Physical', positions: ['RB', 'WR', 'TE'] },

  // Prior season — passing
  { key: 'priorPassYards', label: 'Prior Pass Yards', category: 'Prior Stats', positions: ['QB'] },
  { key: 'priorPassTDs', label: 'Prior Pass TDs', category: 'Prior Stats', positions: ['QB'] },
  { key: 'priorINTs', label: 'Prior INTs', category: 'Prior Stats', positions: ['QB'] },
  { key: 'priorPassYPA', label: 'Prior Yards/Attempt', category: 'Prior Stats', positions: ['QB'] },
  { key: 'priorQBRating', label: 'Prior Passer Rating', category: 'Prior Stats', positions: ['QB'] },

  // Prior season — rushing
  { key: 'priorRushYards', label: 'Prior Rush Yards', category: 'Prior Stats', positions: ['QB', 'RB'] },
  { key: 'priorRushTDs', label: 'Prior Rush TDs', category: 'Prior Stats', positions: ['QB', 'RB'] },
  { key: 'priorYPC', label: 'Prior Yards/Carry', category: 'Prior Stats', positions: ['RB'] },
  { key: 'priorCarries', label: 'Prior Carries', category: 'Prior Stats', positions: ['RB'] },

  // Prior season — receiving
  { key: 'priorTargets', label: 'Prior Targets', category: 'Prior Stats', positions: ['RB', 'WR', 'TE'] },
  { key: 'priorReceptions', label: 'Prior Receptions', category: 'Prior Stats', positions: ['RB', 'WR', 'TE'] },
  { key: 'priorRecYards', label: 'Prior Rec Yards', category: 'Prior Stats', positions: ['RB', 'WR', 'TE'] },
  { key: 'priorRecTDs', label: 'Prior Rec TDs', category: 'Prior Stats', positions: ['WR', 'TE'] },
  { key: 'priorYPR', label: 'Prior Yards/Reception', category: 'Prior Stats', positions: ['WR', 'TE'] },

  // Advanced receiving (from weekly stats)
  { key: 'priorTargetShare', label: 'Prior Target Share', category: 'Advanced', positions: ['RB', 'WR', 'TE'] },
  { key: 'priorAirYardsShare', label: 'Prior Air Yards Share', category: 'Advanced', positions: ['WR', 'TE'] },
  { key: 'priorWOPR', label: 'Prior WOPR', category: 'Advanced', positions: ['WR', 'TE'] },
  { key: 'priorRACR', label: 'Prior RACR', category: 'Advanced', positions: ['WR', 'TE'] },
  { key: 'priorYACperRec', label: 'Prior YAC/Reception', category: 'Advanced', positions: ['RB', 'WR', 'TE'] },
  { key: 'priorAirYardsPerTarget', label: 'Prior Air Yards/Target', category: 'Advanced', positions: ['WR', 'TE'] },
  { key: 'priorRecEPA', label: 'Prior Receiving EPA', category: 'Advanced', positions: ['RB', 'WR', 'TE'] },
  { key: 'priorRushEPA', label: 'Prior Rushing EPA', category: 'Advanced', positions: ['QB', 'RB'] },

  // PBP-derived (aDOT, deep targets, red zone)
  { key: 'priorADOT', label: 'Prior aDOT', category: 'Advanced', positions: ['WR', 'TE'] },
  { key: 'priorDeepTargetPct', label: 'Prior Deep Target %', category: 'Advanced', positions: ['WR', 'TE'] },
  { key: 'priorRZTargetShare', label: 'Prior RZ Target Share', category: 'Advanced', positions: ['RB', 'WR', 'TE'] },

  // Next Gen Stats — receiving
  { key: 'priorSeparation', label: 'Prior Avg Separation', category: 'NGS', positions: ['WR', 'TE'] },
  { key: 'priorCushion', label: 'Prior Avg Cushion', category: 'NGS', positions: ['WR', 'TE'] },
  { key: 'priorYACAboveExp', label: 'Prior YAC Above Expected', category: 'NGS', positions: ['WR', 'TE'] },
  { key: 'priorCatchPct', label: 'Prior Catch %', category: 'NGS', positions: ['WR', 'TE'] },
  { key: 'priorIntendedAirYardShare', label: 'Prior Intended Air Yard Share', category: 'NGS', positions: ['WR', 'TE'] },

  // Next Gen Stats — rushing
  { key: 'priorRYOEperAtt', label: 'Prior RYOE/Attempt', category: 'NGS', positions: ['RB'] },
  { key: 'priorRushEfficiency', label: 'Prior Rush Efficiency', category: 'NGS', positions: ['RB'] },
  { key: 'priorPctVs8Defenders', label: 'Prior % vs 8+ Box', category: 'NGS', positions: ['RB'] },

  // Next Gen Stats — passing
  { key: 'priorCPOE', label: 'Prior CPOE', category: 'NGS', positions: ['QB'] },
  { key: 'priorTimeToThrow', label: 'Prior Time to Throw', category: 'NGS', positions: ['QB'] },
  { key: 'priorAggressiveness', label: 'Prior Aggressiveness', category: 'NGS', positions: ['QB'] },

  // Prior season — fantasy totals
  { key: 'priorPPR', label: 'Prior PPR Points', category: 'Prior Fantasy', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'priorPPG', label: 'Prior PPG', category: 'Prior Fantasy', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'priorGames', label: 'Prior Games Played', category: 'Prior Fantasy', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'priorGamesMissed', label: 'Prior Games Missed', category: 'Prior Fantasy', positions: ['QB', 'RB', 'WR', 'TE'] },

  // Workload
  { key: 'priorTotalTouches', label: 'Prior Total Touches', category: 'Workload', positions: ['RB'] },
  { key: 'priorSnapPct', label: 'Prior Snap %', category: 'Workload', positions: ['QB', 'RB', 'WR', 'TE'] },

  // Injury history
  { key: 'priorInjuryWeeks', label: 'Prior Injury Report Weeks', category: 'Injury', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'priorGamesOut', label: 'Prior Games Out/Doubtful', category: 'Injury', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'preseasonInjured', label: 'Preseason Injured', category: 'Injury', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'preseasonInjWeeks', label: 'Preseason Injury Weeks', category: 'Injury', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'priorSoftTissue', label: 'Prior Soft Tissue Injury', category: 'Injury', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'priorKneeInjury', label: 'Prior Knee Injury', category: 'Injury', positions: ['QB', 'RB', 'WR', 'TE'] },
];

const CATEGORY_COLORS: Record<string, string> = {
  Draft: '#8b5cf6',
  Profile: '#6366f1',
  Physical: '#ec4899',
  'Prior Stats': '#f59e0b',
  'Prior Fantasy': '#10b981',
  Workload: '#3b82f6',
  Advanced: '#14b8a6',
  NGS: '#8b5cf6',
  Injury: '#f43f5e',
};

// ── Helpers ──

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[.']/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').replace(/\s+/g, ' ').trim();
}

function parseHeight(ht: string | number): number {
  if (typeof ht === 'number') return ht;
  const parts = String(ht).split('-');
  return parts.length === 2 ? Number(parts[0]) * 12 + Number(parts[1]) : 0;
}

// ── Types ──

interface PlayerRow {
  name: string;
  position: string;
  season: number;
  adp: number;
  adpDelta: number; // positive = outperformed
  isHit: boolean;
  isBust: boolean;
  features: Record<string, number>;
}

interface PositionModel {
  position: string;
  model: TrainedModel;
  featureNames: string[];
  featureLabels: string[];
  n: number;
  hitRate: number;
  bustRate: number;
}

// ── Component ──

export function ADPFactorAnalysis() {
  const [models, setModels] = useState<PositionModel[]>([]);
  const [allRows, setAllRows] = useState<PlayerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selectedPos, setSelectedPos] = useState('RB');
  const [lambda, setLambda] = useState(5);
  const [maxADP, setMaxADP] = useState(150);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        // Load combine + draft once (static)
        setLoadingStatus('Loading combine & draft data...');
        const [combineData, draftData] = await Promise.all([
          fetchCombine(),
          fetchDraftPicks(),
        ]);
        if (cancelled) return;

        // Build lookup maps
        const combineByName = new Map<string, CombineResult>();
        for (const c of combineData) combineByName.set(normalizeName(c.player_name), c);

        const draftByName = new Map<string, DraftPick>();
        for (const d of draftData) draftByName.set(normalizeName(d.pfr_player_name), d);

        const rows: PlayerRow[] = [];

        for (const season of SEASONS) {
          setLoadingStatus(`Building features for ${season}...`);

          // Fetch current + prior in parallel (including injuries, NGS, PBP)
          const [
            adpData, currentStats, priorStats, priorSnaps,
            priorInjuries, preseasonInjuries,
            priorNgsRec, priorNgsRush, priorNgsPass,
            priorPbp,
          ] = await Promise.all([
            fetchFfcADP(season, 'ppr', 12).catch(() => []),
            fetchPlayerStats(season).catch(() => []),
            fetchPlayerStats(season - 1).catch(() => []),
            fetchSnapCounts(season - 1).catch(() => []),
            fetchInjuries(season - 1).catch(() => []),
            fetchInjuries(season).catch(() => []),
            fetchNextGenStats(season - 1, 'receiving').catch(() => [] as NextGenStats[]),
            fetchNextGenStats(season - 1, 'rushing').catch(() => [] as NextGenStats[]),
            fetchNextGenStats(season - 1, 'passing').catch(() => [] as NextGenStats[]),
            fetchPlayByPlay(season - 1).catch(() => [] as PlayByPlay[]),
          ]);
          if (cancelled) return;

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

          // Advanced weekly stats aggregation (target share, WOPR, RACR, air yards, YAC, EPA)
          interface AdvAgg {
            targetShare: number; airYardsShare: number; wopr: number;
            racr: number; recAirYards: number; yac: number;
            receptions: number; targets: number;
            recEPA: number; rushEPA: number;
            weeks: number;
          }
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
            // Sum accumulating stats, average rates later
            acc.targetShare += w.target_share || 0;
            acc.airYardsShare += w.air_yards_share || 0;
            acc.wopr += w.wopr || 0;
            acc.recAirYards += w.receiving_air_yards || 0;
            acc.yac += w.receiving_yards_after_catch || 0;
            acc.receptions += w.receptions || 0;
            acc.targets += w.targets || 0;
            acc.recEPA += w.receiving_epa || 0;
            acc.rushEPA += w.rushing_epa || 0;
            // racr is a ratio, accumulate for averaging
            if (w.racr && w.racr > 0) acc.racr += w.racr;
            acc.weeks += 1;
            advByName.set(name, acc);
          }

          // NGS season-level summaries (week 0 = full season)
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
          interface PbpAgg {
            totalAirYards: number; targets: number;
            deepTargets: number; rzTargets: number;
          }
          const pbpByReceiver = new Map<string, PbpAgg>();
          // Count total RZ targets per team for share calculation
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

          // Prior-season injury aggregation
          const SOFT_TISSUE = /hamstring|groin|calf|quad|hip|thigh|achilles|ankle|foot|toe/i;
          const KNEE = /knee|acl|mcl|pcl|meniscus/i;

          interface InjAgg { weeks: number; gamesOut: number; softTissue: boolean; knee: boolean }
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

          // Preseason injury status (game_type PRE or first 4 weeks of current season before REG)
          const preseasonInjByName = new Map<string, { injured: boolean; weeks: number }>();
          for (const inj of preseasonInjuries) {
            if (!POSITIONS.includes(inj.position)) continue;
            // Preseason reports: game_type PRE, or week <= 0, or early weeks before regular season
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

          // Current stats lookup for position verification
          const currentByName = new Map<string, SeasonTotals>();
          for (const p of currentTotals) {
            if (POSITIONS.includes(p.position)) {
              currentByName.set(normalizeName(p.player_display_name), p);
            }
          }

          // Join ADP with outcomes
          for (const adpPlayer of adpData) {
            if (!POSITIONS.includes(adpPlayer.position)) continue;
            if (adpPlayer.adp > 200) continue;

            const normalName = normalizeName(adpPlayer.name);
            const current = currentByName.get(normalName);
            if (!current || current.position !== adpPlayer.position) continue;

            const overallRank = overallRankMap.get(normalName) || 999;
            const adpDelta = Math.round(adpPlayer.adp - overallRank);

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

            // Estimate age from draft data
            const draftAge = draft?.age || 0;
            const draftYear = draft?.season || 0;
            const age = draftAge > 0 && draftYear > 0 ? draftAge + (season - draftYear) : 0;

            // Advanced stats from weekly aggregation
            const adv = advByName.get(normalName);
            const advWeeks = adv?.weeks || 1;
            const avgTargetShare = adv ? adv.targetShare / advWeeks : 0;
            const avgAirYardsShare = adv ? adv.airYardsShare / advWeeks : 0;
            const avgWOPR = adv ? adv.wopr / advWeeks : 0;
            const avgRACR = adv && advWeeks > 0 ? adv.racr / advWeeks : 0;
            const yacPerRec = adv && adv.receptions > 0 ? adv.yac / adv.receptions : 0;
            const airYardsPerTarget = adv && adv.targets > 0 ? adv.recAirYards / adv.targets : 0;

            // PBP-derived
            const pbp = pbpByReceiver.get(normalName);
            const adot = pbp && pbp.targets > 0 ? pbp.totalAirYards / pbp.targets : 0;
            const deepPct = pbp && pbp.targets > 0 ? pbp.deepTargets / pbp.targets : 0;
            // RZ target share: player RZ targets / team RZ targets (need team lookup)
            const playerTeam = prior?.recent_team || '';
            const teamRZ = teamRZTargets.get(playerTeam) || 1;
            const rzTargetShare = pbp ? pbp.rzTargets / teamRZ : 0;

            // NGS lookups
            const ngsRec = ngsRecByName.get(normalName);
            const ngsRush = ngsRushByName.get(normalName);
            const ngsPass = ngsPassByName.get(normalName);

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

              // Advanced weekly stats
              priorTargetShare: Math.round(avgTargetShare * 1000) / 1000,
              priorAirYardsShare: Math.round(avgAirYardsShare * 1000) / 1000,
              priorWOPR: Math.round(avgWOPR * 1000) / 1000,
              priorRACR: Math.round(avgRACR * 100) / 100,
              priorYACperRec: Math.round(yacPerRec * 10) / 10,
              priorAirYardsPerTarget: Math.round(airYardsPerTarget * 10) / 10,
              priorRecEPA: Math.round((adv?.recEPA || 0) * 10) / 10,
              priorRushEPA: Math.round((adv?.rushEPA || 0) * 10) / 10,

              // PBP-derived
              priorADOT: Math.round(adot * 10) / 10,
              priorDeepTargetPct: Math.round(deepPct * 1000) / 1000,
              priorRZTargetShare: Math.round(rzTargetShare * 1000) / 1000,

              // Next Gen Stats — receiving
              priorSeparation: ngsRec?.avg_separation || 0,
              priorCushion: ngsRec?.avg_cushion || 0,
              priorYACAboveExp: ngsRec?.avg_yac_above_expectation || 0,
              priorCatchPct: ngsRec?.catch_percentage || 0,
              priorIntendedAirYardShare: ngsRec?.percent_share_of_intended_air_yards || 0,

              // Next Gen Stats — rushing
              priorRYOEperAtt: ngsRush?.rush_yards_over_expected_per_att || 0,
              priorRushEfficiency: ngsRush?.efficiency || 0,
              priorPctVs8Defenders: ngsRush?.percent_attempts_gte_eight_defenders || 0,

              // Next Gen Stats — passing
              priorCPOE: ngsPass?.completion_percentage_above_expectation || 0,
              priorTimeToThrow: ngsPass?.avg_time_to_throw || 0,
              priorAggressiveness: ngsPass?.aggressiveness || 0,

              // Fantasy totals
              priorPPR: Math.round(priorPPR * 10) / 10,
              priorPPG: priorGames > 0 ? Math.round(priorPPR / priorGames * 10) / 10 : 0,
              priorGames,
              priorGamesMissed: prior ? Math.max(0, 17 - priorGames) : 0,
              priorTotalTouches: priorCarries + (prior?.receptions || 0),
              priorSnapPct: Math.round(snapPct * 10) / 10,

              // Injury features
              priorInjuryWeeks: priorInjByName.get(normalName)?.weeks || 0,
              priorGamesOut: priorInjByName.get(normalName)?.gamesOut || 0,
              preseasonInjured: preseasonInjByName.get(normalName)?.injured ? 1 : 0,
              preseasonInjWeeks: preseasonInjByName.get(normalName)?.weeks || 0,
              priorSoftTissue: priorInjByName.get(normalName)?.softTissue ? 1 : 0,
              priorKneeInjury: priorInjByName.get(normalName)?.knee ? 1 : 0,
            };

            rows.push({
              name: adpPlayer.name,
              position: adpPlayer.position,
              season,
              adp: adpPlayer.adp,
              adpDelta,
              isHit: adpDelta >= -12,
              isBust: adpDelta < -24,
              features,
            });
          }
        }

        if (cancelled) return;
        setAllRows(rows);

        // Train per-position models
        const posModels: PositionModel[] = [];
        for (const pos of POSITIONS) {
          const posRows = rows.filter((r) => r.position === pos && r.adp <= maxADP);
          if (posRows.length < 10) continue;

          const posFeatures = FEATURES.filter((f) => f.positions.includes(pos));
          const featureKeys = posFeatures.map((f) => f.key);
          const featureLabels = posFeatures.map((f) => f.label);

          const X = posRows.map((r) => featureKeys.map((k) => r.features[k] || 0));
          const y = posRows.map((r) => r.adpDelta);

          const model = trainRidgeRegression(X, y, featureKeys, lambda);

          posModels.push({
            position: pos,
            model,
            featureNames: featureKeys,
            featureLabels,
            n: posRows.length,
            hitRate: Math.round(posRows.filter((r) => r.isHit).length / posRows.length * 100),
            bustRate: Math.round(posRows.filter((r) => r.isBust).length / posRows.length * 100),
          });
        }

        setModels(posModels);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to build models');
      } finally {
        setLoading(false);
      }
    }

    run();
    return () => { cancelled = true; };
  }, [lambda, maxADP]);

  const currentModel = useMemo(
    () => models.find((m) => m.position === selectedPos),
    [models, selectedPos]
  );

  // Feature importance sorted by absolute coefficient
  const featureImportance = useMemo(() => {
    if (!currentModel) return [];
    return currentModel.featureNames
      .map((key, i) => {
        const def = FEATURES.find((f) => f.key === key);
        return {
          key,
          label: currentModel.featureLabels[i],
          category: def?.category || 'Other',
          coefficient: currentModel.model.coefficients[i],
          absCoeff: Math.abs(currentModel.model.coefficients[i]),
        };
      })
      .sort((a, b) => b.absCoeff - a.absCoeff);
  }, [currentModel]);

  // Cross-position comparison: top 5 features per position
  const crossPositionData = useMemo(() => {
    const commonFeatures = FEATURES.filter((f) => f.positions.length === 4);
    return commonFeatures.map((feat) => {
      const row: Record<string, unknown> = { label: feat.label };
      for (const m of models) {
        const idx = m.featureNames.indexOf(feat.key);
        row[m.position] = idx >= 0 ? Math.round(m.model.coefficients[idx] * 1000) / 1000 : 0;
      }
      return row;
    }).sort((a, b) => {
      const maxA = Math.max(...POSITIONS.map((p) => Math.abs((a[p] as number) || 0)));
      const maxB = Math.max(...POSITIONS.map((p) => Math.abs((b[p] as number) || 0)));
      return maxB - maxA;
    });
  }, [models]);

  // Scatter data for selected position
  const scatterData = useMemo(() => {
    if (!currentModel) return [];
    const posRows = allRows.filter((r) => r.position === selectedPos && r.adp <= maxADP);
    return posRows.map((r) => ({
      name: r.name,
      season: r.season,
      adp: r.adp,
      delta: r.adpDelta,
      isHit: r.isHit,
      isBust: r.isBust,
      fill: r.isHit ? '#10b981' : r.isBust ? '#ef4444' : '#6b7280',
    }));
  }, [allRows, selectedPos, maxADP, currentModel]);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">
          {loadingStatus}
          <br />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Joining ADP + stats + combine + draft + snaps + NGS + PBP for {SEASONS.length} seasons
          </span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <h3>Error</h3>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <>
      <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 12 }}>
        Ridge regression models trained per position on {allRows.length} player-seasons ({SEASONS[0]}-{SEASONS[SEASONS.length - 1]}).
        Predicts ADP Delta (positive = outperformed draft position).
        Features from prior-season stats, advanced metrics (WOPR, RACR, aDOT), Next Gen Stats (separation, RYOE, CPOE), combine, draft capital, injuries, and workload.
      </p>

      {/* Controls */}
      <div className="controls" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="control-group">
          <label className="control-label">Position</label>
          <div style={{ display: 'flex', gap: 4 }}>
            {POSITIONS.map((pos) => (
              <button
                key={pos}
                className={`pos-filter ${selectedPos === pos ? 'active' : ''}`}
                onClick={() => setSelectedPos(pos)}
                style={{ borderColor: POS_COLORS[pos] }}
              >
                {pos}
              </button>
            ))}
          </div>
        </div>

        <div className="control-group">
          <label className="control-label">Max ADP</label>
          <select value={maxADP} onChange={(e) => setMaxADP(Number(e.target.value))}>
            <option value={60}>Top 60</option>
            <option value={96}>Top 96</option>
            <option value={150}>Top 150</option>
            <option value={200}>Top 200</option>
          </select>
        </div>

        <div className="control-group">
          <label className="control-label">Lambda</label>
          <select value={lambda} onChange={(e) => setLambda(Number(e.target.value))}>
            <option value={1}>1 (low)</option>
            <option value={5}>5 (default)</option>
            <option value={10}>10</option>
            <option value={25}>25 (high)</option>
          </select>
        </div>
      </div>

      {/* Model performance cards */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        {models.map((m) => (
          <div
            key={m.position}
            onClick={() => setSelectedPos(m.position)}
            style={{
              background: selectedPos === m.position ? 'var(--bg-tertiary)' : 'var(--bg-secondary)',
              border: `2px solid ${selectedPos === m.position ? POS_COLORS[m.position] : 'var(--border)'}`,
              borderRadius: 8,
              padding: '12px 16px',
              cursor: 'pointer',
              minWidth: 140,
              transition: 'border-color 0.15s',
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, color: POS_COLORS[m.position], marginBottom: 4 }}>
              {m.position}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              <div>R² = <strong style={{ color: 'var(--text-primary)' }}>{m.model.rSquared.toFixed(3)}</strong></div>
              <div>MAE = <strong style={{ color: 'var(--text-primary)' }}>{Math.round(m.model.mae)}</strong></div>
              <div>N = {m.n} &middot; Hits {m.hitRate}% &middot; Busts {m.bustRate}%</div>
            </div>
          </div>
        ))}
      </div>

      {currentModel && (
        <>
          {/* Feature Importance Bar Chart */}
          <h4 style={{ marginBottom: 8 }}>
            {selectedPos} Hit/Bust Predictors
            <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>
              (positive coefficient = predicts outperformance)
            </span>
          </h4>
          <div style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: '16px 12px 8px 0',
            marginBottom: 20,
          }}>
            <ResponsiveContainer width="100%" height={Math.max(300, featureImportance.length * 26 + 40)}>
              <BarChart
                data={featureImportance.map((f) => ({
                  name: f.label,
                  value: Math.round(f.coefficient * 1000) / 1000,
                  fill: CATEGORY_COLORS[f.category] || '#6366f1',
                }))}
                layout="vertical"
                margin={{ top: 5, right: 20, bottom: 5, left: 150 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.3} />
                <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                  width={140}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--bg-card, #1e1e2e)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  formatter={(value) => [Number(value).toFixed(4), 'Coefficient']}
                />
                <ReferenceLine x={0} stroke="var(--text-muted)" />
                <Bar dataKey="value" radius={[0, 3, 3, 0]} maxBarSize={18} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Interpretation table */}
          <h4 style={{ marginBottom: 8 }}>Feature Interpretation ({selectedPos})</h4>
          <div className="table-container" style={{ marginBottom: 20 }}>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Feature</th>
                  <th>Category</th>
                  <th>Coefficient</th>
                  <th>Interpretation</th>
                </tr>
              </thead>
              <tbody>
                {featureImportance.map((f, i) => (
                  <tr key={f.key}>
                    <td className="rank-cell">{i + 1}</td>
                    <td><strong>{f.label}</strong></td>
                    <td>
                      <span style={{ color: CATEGORY_COLORS[f.category], fontSize: 12 }}>
                        {f.category}
                      </span>
                    </td>
                    <td style={{ fontFamily: 'monospace', fontWeight: 700 }}>
                      <span style={{ color: f.coefficient >= 0 ? '#10b981' : '#ef4444' }}>
                        {f.coefficient >= 0 ? '+' : ''}{f.coefficient.toFixed(4)}
                      </span>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 300 }}>
                      {f.coefficient > 0.01
                        ? `Higher ${f.label.toLowerCase()} predicts beating ADP`
                        : f.coefficient < -0.01
                        ? `Higher ${f.label.toLowerCase()} predicts underperforming ADP`
                        : 'Minimal predictive value'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Hit/Bust scatter */}
          <h4 style={{ marginBottom: 8 }}>
            {selectedPos} Hit/Bust Distribution
            <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>
              Green = hit (within 12 of ADP), Red = bust (24+ worse), Gray = middle
            </span>
          </h4>
          <div style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: '20px 12px 12px 0',
            marginBottom: 20,
          }}>
            <ResponsiveContainer width="100%" height={360}>
              <ScatterChart margin={{ top: 10, right: 20, bottom: 40, left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} />
                <XAxis type="number" dataKey="adp" domain={[0, maxADP]}
                  tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}>
                  <Label value="ADP" position="bottom" offset={20}
                    style={{ fill: 'var(--text-secondary)', fontSize: 13 }} />
                </XAxis>
                <YAxis type="number" dataKey="delta"
                  tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}>
                  <Label value="ADP Delta (+ = outperformed)" angle={-90} position="insideLeft" offset={10}
                    style={{ fill: 'var(--text-secondary)', fontSize: 13 }} />
                </YAxis>
                <ReferenceLine y={0} stroke="var(--text-muted)" strokeDasharray="5 5" />
                <ReferenceLine y={-12} stroke="#f59e0b" strokeDasharray="3 3" opacity={0.5} />
                <ReferenceLine y={-24} stroke="#ef4444" strokeDasharray="3 3" opacity={0.5} />
                <Tooltip
                  content={({ payload }) => {
                    if (!payload?.length) return null;
                    const d = payload[0].payload;
                    return (
                      <div style={{
                        background: 'var(--bg-tertiary)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius)',
                        padding: '8px 12px',
                        fontSize: 12,
                      }}>
                        <strong>{d.name}</strong> ({d.season})
                        <br />ADP: {d.adp.toFixed(1)}
                        <br />Delta: <span style={{ color: d.delta >= 0 ? '#10b981' : '#ef4444' }}>
                          {d.delta >= 0 ? '+' : ''}{d.delta}
                        </span>
                        <br />
                        <span style={{
                          fontWeight: 700,
                          color: d.isHit ? '#10b981' : d.isBust ? '#ef4444' : '#6b7280',
                        }}>
                          {d.isHit ? 'HIT' : d.isBust ? 'BUST' : 'MIDDLE'}
                        </span>
                      </div>
                    );
                  }}
                />
                <Scatter data={scatterData} fillOpacity={0.6} r={4} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      {/* Cross-position comparison */}
      <h4 style={{ marginBottom: 8 }}>
        Cross-Position Factor Comparison
        <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>
          Same features, different weights by position
        </span>
      </h4>
      <div style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '20px 12px 12px 0',
        marginBottom: 20,
      }}>
        <ResponsiveContainer width="100%" height={Math.max(300, crossPositionData.length * 30 + 60)}>
          <BarChart
            data={crossPositionData}
            layout="vertical"
            margin={{ top: 5, right: 20, bottom: 5, left: 150 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.3} />
            <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
            <YAxis
              type="category"
              dataKey="label"
              tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
              width={140}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--bg-card, #1e1e2e)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                fontSize: 12,
              }}
            />
            <Legend />
            <ReferenceLine x={0} stroke="var(--text-muted)" />
            <Bar dataKey="QB" fill={POS_COLORS.QB} maxBarSize={12} />
            <Bar dataKey="RB" fill={POS_COLORS.RB} maxBarSize={12} />
            <Bar dataKey="WR" fill={POS_COLORS.WR} maxBarSize={12} />
            <Bar dataKey="TE" fill={POS_COLORS.TE} maxBarSize={12} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Key insights summary */}
      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13 }}>
          All coefficients by position
        </summary>
        <div className="table-container" style={{ marginTop: 8 }}>
          <table>
            <thead>
              <tr>
                <th>Feature</th>
                <th>Category</th>
                {models.map((m) => (
                  <th key={m.position} style={{ color: POS_COLORS[m.position] }}>{m.position}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {FEATURES.map((feat) => {
                const values = models.map((m) => {
                  const idx = m.featureNames.indexOf(feat.key);
                  return idx >= 0 ? m.model.coefficients[idx] : null;
                });
                if (values.every((v) => v === null)) return null;

                return (
                  <tr key={feat.key}>
                    <td><strong>{feat.label}</strong></td>
                    <td>
                      <span style={{ color: CATEGORY_COLORS[feat.category], fontSize: 12 }}>
                        {feat.category}
                      </span>
                    </td>
                    {values.map((v, i) => (
                      <td key={i} style={{
                        fontFamily: 'monospace',
                        fontSize: 12,
                        color: v === null ? 'var(--text-muted)' : v >= 0 ? '#10b981' : '#ef4444',
                      }}>
                        {v === null ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(3)}`}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
