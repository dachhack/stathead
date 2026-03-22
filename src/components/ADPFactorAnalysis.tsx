import { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Label, Legend,
  ScatterChart, Scatter,
} from 'recharts';
import {
  fetchFfcADP, fetchPlayerStats, aggregateToSeasonTotals,
  fetchCombine, fetchDraftPicks, fetchSnapCounts, fetchInjuries,
  fetchNextGenStats, fetchPlayByPlay, fetchPbpParticipation,
  fetchRosters, fetchDepthCharts, fetchGames,
} from '../data';
import type { SeasonTotals, CombineResult, DraftPick, PlayerStats, NextGenStats, PlayByPlay, PbpParticipation, Roster, DepthChart } from '../types';
import { trainRidgeRegression, predict, type TrainedModel } from '../lib/ridge';
import { trainGBM, predictGBM, type TrainedGBM } from '../lib/gbm';

type ModelType = 'ridge' | 'gbm';

// ── Config ──

// Need prior-season data, so training starts at 2021
const SEASONS = [2021, 2022, 2023, 2024, 2025];
const PREDICT_SEASON = 2026; // upcoming season to predict
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

  // Participation-derived (YPRR, personnel)
  { key: 'priorYPRR', label: 'Prior YPRR', category: 'Route', positions: ['WR', 'TE'] },
  { key: 'priorRoutesRun', label: 'Prior Routes Run', category: 'Route', positions: ['WR', 'TE'] },
  { key: 'priorTargetsPerRoute', label: 'Prior Targets/Route', category: 'Route', positions: ['WR', 'TE'] },
  { key: 'priorPct11Personnel', label: 'Prior % 11 Personnel', category: 'Route', positions: ['RB', 'WR', 'TE'] },
  { key: 'priorPct12Personnel', label: 'Prior % 12 Personnel', category: 'Route', positions: ['RB', 'WR', 'TE'] },
  { key: 'priorPassLocationLeft', label: 'Prior % Targets Left', category: 'Route', positions: ['WR', 'TE'] },
  { key: 'priorPassLocationMiddle', label: 'Prior % Targets Middle', category: 'Route', positions: ['WR', 'TE'] },

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

  // Roster competition — basic
  { key: 'teamSamePosCount', label: 'Same-Pos Teammates', category: 'Competition', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'depthChartRank', label: 'Depth Chart Rank', category: 'Competition', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'priorTeamTouchShare', label: 'Prior Team Touch Share', category: 'Competition', positions: ['RB', 'WR', 'TE'] },
  { key: 'priorTeamTargetShare', label: 'Prior Team Target Share', category: 'Competition', positions: ['RB', 'WR', 'TE'] },
  { key: 'newSamePosAdded', label: 'New Same-Pos Arrivals', category: 'Competition', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'teamDraftedSamePos', label: 'Team Drafted Same Pos', category: 'Competition', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'draftCapitalSamePos', label: 'Draft Capital at Pos', category: 'Competition', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'teammatePriorPPR', label: 'Best Teammate PPR', category: 'Competition', positions: ['RB', 'WR', 'TE'] },

  // Roster competition — quality-aware (cross-position)
  { key: 'teamWRElitePPR', label: 'Team Best WR PPR', category: 'Competition', positions: ['WR', 'TE', 'RB'] },
  { key: 'teamWRTop12', label: 'Team Has Top-12 WR', category: 'Competition', positions: ['WR', 'TE', 'RB'] },
  { key: 'teamWRTotalPPR', label: 'Team WR Total PPR', category: 'Competition', positions: ['WR', 'TE'] },
  { key: 'teamTEElitePPR', label: 'Team Best TE PPR', category: 'Competition', positions: ['WR', 'TE'] },
  { key: 'teamRBElitePPR', label: 'Team Best RB PPR', category: 'Competition', positions: ['RB'] },
  { key: 'teamRBTop12', label: 'Team Has Top-12 RB', category: 'Competition', positions: ['RB'] },
  { key: 'teamPassCatcherPPR', label: 'Team Pass Catcher PPR', category: 'Competition', positions: ['RB', 'WR', 'TE'] },
  { key: 'teamElitePassCatchers', label: 'Team Elite Pass Catchers', category: 'Competition', positions: ['WR', 'TE'] },
  { key: 'teamTargetHHI', label: 'Team Target Concentration', category: 'Competition', positions: ['RB', 'WR', 'TE'] },
  { key: 'newArrivalBestPPR', label: 'Best New Arrival PPR', category: 'Competition', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'newArrivalBestADP', label: 'Best New Arrival ADP', category: 'Competition', positions: ['QB', 'RB', 'WR', 'TE'] },

  // Coaching & scheme
  { key: 'newHeadCoach', label: 'New Head Coach', category: 'Coaching', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'coachPriorTeamPPR', label: 'Coach Prior Team PPR', category: 'Coaching', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'teamPassRate', label: 'Team Pass Rate', category: 'Coaching', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'teamNeutralPassRate', label: 'Team Neutral Pass Rate', category: 'Coaching', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'teamPace', label: 'Team Pace (Plays/Game)', category: 'Coaching', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'teamFirstDownRunRate', label: 'Team 1st Down Run Rate', category: 'Coaching', positions: ['RB', 'WR', 'TE'] },
  { key: 'teamShotgunRate', label: 'Team Shotgun Rate', category: 'Coaching', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'teamNoHuddleRate', label: 'Team No-Huddle Rate', category: 'Coaching', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'teamRBTargetRate', label: 'Team RB Target Rate', category: 'Coaching', positions: ['RB', 'WR', 'TE'] },

  // Personnel & positional usage (team-level)
  { key: 'team11Rate', label: 'Team 11 Personnel Rate', category: 'Personnel', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'team12Rate', label: 'Team 12 Personnel Rate', category: 'Personnel', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'team13Rate', label: 'Team 13 Personnel Rate', category: 'Personnel', positions: ['RB', 'TE'] },
  { key: 'team21Rate', label: 'Team 21 Personnel Rate', category: 'Personnel', positions: ['RB', 'TE'] },
  { key: 'team22Rate', label: 'Team 22 Personnel Rate', category: 'Personnel', positions: ['RB'] },
  { key: 'team10Rate', label: 'Team 10 Personnel Rate', category: 'Personnel', positions: ['QB', 'WR'] },
  { key: 'teamTETargetRate', label: 'Team TE Target Rate', category: 'Personnel', positions: ['TE', 'WR'] },
  { key: 'teamWRTargetRate', label: 'Team WR Target Rate', category: 'Personnel', positions: ['WR', 'TE'] },
  { key: 'teamTETargetsPerGame', label: 'Team TE Targets/Game', category: 'Personnel', positions: ['TE'] },
  { key: 'teamRBTargetsPerGame', label: 'Team RB Targets/Game', category: 'Personnel', positions: ['RB'] },
  { key: 'teamWR3PlusOnField', label: 'Team 3+ WR on Field Rate', category: 'Personnel', positions: ['WR', 'TE'] },
  { key: 'team2PlusTEOnField', label: 'Team 2+ TE on Field Rate', category: 'Personnel', positions: ['WR', 'TE'] },
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
  Route: '#06b6d4',
  Injury: '#f43f5e',
  Competition: '#f97316',
  Coaching: '#a855f7',
  Personnel: '#0ea5e9',
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
  ridgeModel?: TrainedModel;
  gbmModel?: TrainedGBM;
  featureNames: string[];
  featureLabels: string[];
  n: number;
  hitRate: number;
  bustRate: number;
  rSquared: number;
  mae: number;
}

interface PredictionRow {
  name: string;
  position: string;
  team: string;
  adp: number;
  features: Record<string, number>;
}

// ── Component ──

export function ADPFactorAnalysis() {
  const [models, setModels] = useState<PositionModel[]>([]);
  const [allRows, setAllRows] = useState<PlayerRow[]>([]);
  const [predictionRows, setPredictionRows] = useState<PredictionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selectedPos, setSelectedPos] = useState('RB');
  const [lambda, setLambda] = useState(5);
  const [maxADP, setMaxADP] = useState(150);
  const [modelType, setModelType] = useState<ModelType>('gbm');
  const [selectedPlayerName, setSelectedPlayerName] = useState<string | null>(null);
  const [selected2026Player, setSelected2026Player] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        // Load combine + draft + games once (static)
        setLoadingStatus('Loading combine, draft & games data...');
        const [combineData, draftData, gamesData] = await Promise.all([
          fetchCombine(),
          fetchDraftPicks(),
          fetchGames(),
        ]);
        if (cancelled) return;

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

        const rows: PlayerRow[] = [];

        for (const season of SEASONS) {
          setLoadingStatus(`Building features for ${season}...`);

          // Fetch current + prior in parallel (including injuries, NGS, PBP)
          const [
            adpData, currentStats, priorStats, priorSnaps,
            priorInjuries, preseasonInjuries,
            priorNgsRec, priorNgsRush, priorNgsPass,
            priorPbp, priorParticipation,
            seasonRosters, priorRosters, seasonDepthCharts,
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
            fetchPbpParticipation(season - 1).catch(() => [] as PbpParticipation[]),
            fetchRosters(season).catch(() => [] as Roster[]),
            fetchRosters(season - 1).catch(() => [] as Roster[]),
            fetchDepthCharts(season).catch(() => [] as DepthChart[]),
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

          // Build GSIS ID → normalized name map from weekly stats
          const gsisToName = new Map<string, string>();
          for (const w of priorWeekly) {
            if (w.player_id && w.player_display_name) {
              gsisToName.set(w.player_id, normalizeName(w.player_display_name));
            }
          }

          // Participation-derived: routes run, YPRR, personnel splits
          // Join participation with PBP pass plays to count routes per player
          interface RouteAgg {
            routesRun: number;
            snaps11: number; // 11 personnel (1 RB, 1 TE, 3 WR)
            snaps12: number; // 12 personnel (1 RB, 2 TE, 2 WR)
            totalSnaps: number;
          }
          const routesByName = new Map<string, RouteAgg>();

          // Build a set of pass play keys for quick lookup
          const passPlayKeys = new Set<string>();
          for (const play of priorPbp) {
            if (play.qb_dropback === 1 || play.play_type === 'pass') {
              passPlayKeys.add(`${play.game_id}:${play.play_id}`);
            }
          }

          // Parse personnel string to get grouping (e.g., "1 RB, 1 TE, 3 WR" → "11")
          function parsePersonnel(personnel: string): string {
            if (!personnel) return '';
            const rbMatch = personnel.match(/(\d+)\s*RB/i);
            const teMatch = personnel.match(/(\d+)\s*TE/i);
            const rb = rbMatch ? rbMatch[1] : '0';
            const te = teMatch ? teMatch[1] : '0';
            return `${rb}${te}`;
          }

          for (const part of priorParticipation) {
            if (!part.offense_players) continue;

            const gamePlayKey = `${part.nflverse_game_id}:${part.play_id}`;
            // Also check old_game_id format since PBP might use different ID
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
          interface LocAgg { left: number; middle: number; right: number; total: number }
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

          // ── Team scheme features from prior PBP ──
          interface SchemeAgg {
            passes: number; rushes: number; plays: number; games: number;
            neutralPasses: number; neutralPlays: number;
            firstDownRuns: number; firstDownPlays: number;
            shotgunPlays: number; noHuddlePlays: number;
            rbTargets: number; teTargets: number; wrTargets: number; totalTargets: number;
          }
          const schemeByTeam = new Map<string, SchemeAgg>();
          // Count games per team for pace calculation
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

            // Neutral game script: score diff within 7, 1st-3rd quarter
            const isNeutral = Math.abs(play.score_differential || 0) <= 7 && (play.qtr || 0) <= 3;
            if (isNeutral) {
              acc.neutralPlays += 1;
              if (play.play_type === 'pass' || play.qb_dropback === 1) acc.neutralPasses += 1;
            }

            // First down tendencies
            if (play.down === 1) {
              acc.firstDownPlays += 1;
              if (play.play_type === 'run' && play.qb_dropback !== 1) acc.firstDownRuns += 1;
            }

            if (play.shotgun === 1) acc.shotgunPlays += 1;
            if (play.no_huddle === 1) acc.noHuddlePlays += 1;

            // Positional target breakdown
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
          // Set games count
          for (const [team, gameSet] of priorGamesByTeam) {
            const acc = schemeByTeam.get(team);
            if (acc) acc.games = gameSet.size;
          }

          // ── Team personnel grouping rates from PBP ──
          // Parse offense_personnel from PBP plays (e.g. "1 RB, 1 TE, 3 WR")
          interface PersonnelAgg {
            p11: number; p12: number; p13: number; p21: number;
            p22: number; p10: number; total: number;
            wr3plus: number; te2plus: number;
          }
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

          // Coach change detection: compare prior season coach to current season coach
          const coachChangeTeams = new Set<string>();
          for (const [key, coach] of coachBySeasonTeam) {
            const [szn, team] = key.split(':');
            if (Number(szn) === season) {
              const priorCoach = coachBySeasonTeam.get(`${season - 1}:${team}`);
              if (priorCoach && priorCoach !== coach) coachChangeTeams.add(team);
            }
          }

          // Coach's prior-season total team PPR (how productive was the offense)
          const coachPriorTeamPPR = new Map<string, number>();
          for (const p of priorTotals) {
            if (!POSITIONS.includes(p.position)) continue;
            const team = p.recent_team || '';
            coachPriorTeamPPR.set(team, (coachPriorTeamPPR.get(team) || 0) + (p.fantasy_points_ppr || 0));
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

          // ── Roster competition features ──

          // Current-season roster: players per team-position
          // Use latest week snapshot (highest week number)
          const rosterByTeamPos = new Map<string, Set<string>>();
          const playerTeamMap = new Map<string, string>(); // name → team
          for (const r of seasonRosters) {
            if (!POSITIONS.includes(r.position) || r.status === 'Inactive') continue;
            const key = `${r.team}:${r.position}`;
            if (!rosterByTeamPos.has(key)) rosterByTeamPos.set(key, new Set());
            const name = normalizeName(r.full_name);
            rosterByTeamPos.get(key)!.add(name);
            playerTeamMap.set(name, r.team);
          }

          // Prior-season roster for detecting new arrivals
          const priorRosterByTeamPos = new Map<string, Set<string>>();
          for (const r of priorRosters) {
            if (!POSITIONS.includes(r.position)) continue;
            const key = `${r.team}:${r.position}`;
            if (!priorRosterByTeamPos.has(key)) priorRosterByTeamPos.set(key, new Set());
            priorRosterByTeamPos.get(key)!.add(normalizeName(r.full_name));
          }

          // Depth chart rank (use latest available depth chart)
          const depthRankByName = new Map<string, number>();
          const dcLatest = new Map<string, DepthChart>(); // key: team:pos:name → latest entry
          for (const dc of seasonDepthCharts) {
            const name = normalizeName(dc.player_name);
            const key = `${dc.team}:${dc.pos_abb}:${name}`;
            const existing = dcLatest.get(key);
            if (!existing || dc.dt > existing.dt) dcLatest.set(key, dc);
          }
          for (const dc of dcLatest.values()) {
            depthRankByName.set(normalizeName(dc.player_name), dc.pos_rank || dc.pos_slot || 99);
          }

          // Prior team touch totals for share calculation
          const teamTotalCarries = new Map<string, number>();
          const teamTotalTargets = new Map<string, number>();
          for (const p of priorTotals) {
            if (!POSITIONS.includes(p.position)) continue;
            const team = p.recent_team || '';
            if (!team) continue;
            teamTotalCarries.set(team, (teamTotalCarries.get(team) || 0) + (p.carries || 0));
            teamTotalTargets.set(team, (teamTotalTargets.get(team) || 0) + (p.targets || 0));
          }

          // Prior season PPR by name + position (for quality-aware competition)
          const priorPPRByName = new Map<string, number>();
          const priorPosByName = new Map<string, string>();
          for (const p of priorTotals) {
            if (POSITIONS.includes(p.position)) {
              const name = normalizeName(p.player_display_name);
              priorPPRByName.set(name, p.fantasy_points_ppr || 0);
              priorPosByName.set(name, p.position);
            }
          }

          // Positional rankings from prior season (for top-12 detection)
          const posPriorRanks = new Map<string, Map<string, number>>(); // pos → name → rank
          for (const pos of POSITIONS) {
            const posPlayers = priorTotals
              .filter((p) => p.position === pos)
              .sort((a, b) => (b.fantasy_points_ppr || 0) - (a.fantasy_points_ppr || 0));
            const rankMap = new Map<string, number>();
            posPlayers.forEach((p, i) => rankMap.set(normalizeName(p.player_display_name), i + 1));
            posPriorRanks.set(pos, rankMap);
          }

          // Team-level PPR aggregations by position (from prior season, mapped to current team)
          // We need to know what each team's roster looks like NOW and how those players did LAST year
          interface TeamPosAgg {
            bestPPR: number;
            totalPPR: number;
            hasTop12: boolean;
            playerTargets: number[]; // for HHI calc
          }
          const teamPosAgg = new Map<string, TeamPosAgg>(); // "team:pos" → agg

          // Build team-pos aggregations using current roster + prior stats
          for (const [key, names] of rosterByTeamPos) {
            const [, pos] = key.split(':');
            const agg: TeamPosAgg = { bestPPR: 0, totalPPR: 0, hasTop12: false, playerTargets: [] };
            for (const name of names) {
              const ppr = priorPPRByName.get(name) || 0;
              if (ppr > agg.bestPPR) agg.bestPPR = ppr;
              agg.totalPPR += ppr;
              const rank = posPriorRanks.get(pos)?.get(name) || 999;
              if (rank <= 12) agg.hasTop12 = true;
              // Get targets for HHI
              const priorP = priorTotals.find((p) => normalizeName(p.player_display_name) === name && p.position === pos);
              if (priorP) agg.playerTargets.push(priorP.targets || 0);
            }
            teamPosAgg.set(key, agg);
          }

          // Team-level pass catcher aggregation (WR + TE combined PPR)
          const teamPassCatcherPPR = new Map<string, number>();
          const teamElitePassCatchers = new Map<string, number>(); // count of top-24 WR/TE
          for (const [key, names] of rosterByTeamPos) {
            const [, pos] = key.split(':');
            if (pos !== 'WR' && pos !== 'TE') continue;
            for (const name of names) {
              const ppr = priorPPRByName.get(name) || 0;
              teamPassCatcherPPR.set(team, (teamPassCatcherPPR.get(team) || 0) + ppr);
              const rank = posPriorRanks.get(pos)?.get(name) || 999;
              if (rank <= 24) teamElitePassCatchers.set(team, (teamElitePassCatchers.get(team) || 0) + 1);
            }
          }

          // Target HHI (Herfindahl-Hirschman Index) per team — higher = more concentrated
          const teamTargetHHI = new Map<string, number>();
          for (const team of new Set([...teamTotalTargets.keys()])) {
            const totalTgts = teamTotalTargets.get(team) || 1;
            // Collect all player target shares on the team
            let hhi = 0;
            for (const p of priorTotals) {
              if ((p.recent_team || '') !== team || !POSITIONS.includes(p.position)) continue;
              const share = (p.targets || 0) / totalTgts;
              hhi += share * share;
            }
            teamTargetHHI.set(team, Math.round(hhi * 1000) / 1000);
          }

          // New arrival quality: for each team-pos, best PPR among new arrivals
          const newArrivalBestPPR = new Map<string, number>(); // "team:pos" → best PPR
          for (const [key, names] of rosterByTeamPos) {
            const priorNames = priorRosterByTeamPos.get(key);
            let best = 0;
            for (const name of names) {
              if (priorNames && priorNames.has(name)) continue; // not new
              const ppr = priorPPRByName.get(name) || 0;
              if (ppr > best) best = ppr;
            }
            newArrivalBestPPR.set(key, Math.round(best * 10) / 10);
          }

          // New arrival ADP: for each team-pos, best (lowest) ADP among new arrivals
          const adpByName = new Map<string, number>();
          for (const a of adpData) adpByName.set(normalizeName(a.name), a.adp);
          const newArrivalBestADP = new Map<string, number>(); // lower = better
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

          // Draft picks for this season (team drafted same position)
          const draftPicksBySeason = draftData.filter((d) => d.season === season);
          const teamDraftedPos = new Map<string, { count: number; bestPick: number }>();
          for (const d of draftPicksBySeason) {
            // Match draft position to fantasy positions
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

              // Participation-derived: YPRR, routes, personnel
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

              // Roster competition features
              ...(() => {
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

                // Best same-pos teammate PPR (excluding self)
                let bestTeammatePPR = 0;
                if (teammates) {
                  for (const tmName of teammates) {
                    if (tmName === normalName) continue;
                    const tmPPR = priorPPRByName.get(tmName) || 0;
                    if (tmPPR > bestTeammatePPR) bestTeammatePPR = tmPPR;
                  }
                }

                return {
                  teamSamePosCount: samePosCount,
                  depthChartRank: depthRankByName.get(normalName) || 99,
                  priorTeamTouchShare: Math.round(playerTouchShare * 1000) / 1000,
                  priorTeamTargetShare: Math.round(playerTargetShareTeam * 1000) / 1000,
                  newSamePosAdded: newArrivals,
                  teamDraftedSamePos: draftedInfo ? draftedInfo.count : 0,
                  draftCapitalSamePos: draftedInfo ? Math.max(0, 8 - Math.ceil(draftedInfo.bestPick / 32)) : 0,
                  teammatePriorPPR: Math.round(bestTeammatePPR * 10) / 10,

                  // Quality-aware cross-position competition
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
                };
              })(),

              // Coaching & scheme features
              ...(() => {
                const pTeam = playerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                const scheme = schemeByTeam.get(pTeam);
                const totalPlays = scheme?.plays || 1;
                const totalGames = scheme?.games || 1;
                return {
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
                };
              })(),

              // Personnel & positional usage features
              ...(() => {
                const pTeam2 = playerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                const pers = personnelByTeam.get(pTeam2);
                const persTotal = pers?.total || 1;
                const sch = schemeByTeam.get(pTeam2);
                const schGames = sch?.games || 1;
                const schTotalTgts = sch?.totalTargets || 1;
                return {
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
                };
              })(),
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

        // ── Build 2026 prediction rows ──
        setLoadingStatus(`Building ${PREDICT_SEASON} prediction features...`);
        const predRows: PredictionRow[] = [];
        {
          const predSeason = PREDICT_SEASON;
          const priorSeason = predSeason - 1;

          const [
            predAdpData, predPriorStats, predPriorSnaps,
            predPriorInjuries, predPreseasonInjuries,
            predPriorNgsRec, predPriorNgsRush, predPriorNgsPass,
            predPriorPbp, predPriorParticipation,
            predSeasonRosters, predPriorRosters, predSeasonDepthCharts,
          ] = await Promise.all([
            fetchFfcADP(predSeason, 'ppr', 12).catch(() => []),
            fetchPlayerStats(priorSeason).catch(() => []),
            fetchSnapCounts(priorSeason).catch(() => []),
            fetchInjuries(priorSeason).catch(() => []),
            fetchInjuries(predSeason).catch(() => []),
            fetchNextGenStats(priorSeason, 'receiving').catch(() => [] as NextGenStats[]),
            fetchNextGenStats(priorSeason, 'rushing').catch(() => [] as NextGenStats[]),
            fetchNextGenStats(priorSeason, 'passing').catch(() => [] as NextGenStats[]),
            fetchPlayByPlay(priorSeason).catch(() => [] as PlayByPlay[]),
            fetchPbpParticipation(priorSeason).catch(() => [] as PbpParticipation[]),
            fetchRosters(predSeason).catch(() => [] as Roster[]),
            fetchRosters(priorSeason).catch(() => [] as Roster[]),
            fetchDepthCharts(predSeason).catch(() => [] as DepthChart[]),
          ]);
          if (cancelled) return;

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
            interface PredAdvAgg {
              targetShare: number; airYardsShare: number; wopr: number;
              racr: number; recAirYards: number; yac: number;
              receptions: number; targets: number;
              recEPA: number; rushEPA: number;
              weeks: number;
            }
            const predAdvByName = new Map<string, PredAdvAgg>();
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
            interface PredPbpAgg {
              totalAirYards: number; targets: number; deepTargets: number; rzTargets: number;
            }
            const predPbpByReceiver = new Map<string, PredPbpAgg>();
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
            interface PredRouteAgg { routesRun: number; snaps11: number; snaps12: number; totalSnaps: number }
            const predRoutesByName = new Map<string, PredRouteAgg>();
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
            interface PredLocAgg { left: number; middle: number; right: number; total: number }
            const predLocByReceiver = new Map<string, PredLocAgg>();
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
            interface PredInjAgg { weeks: number; gamesOut: number; softTissue: boolean; knee: boolean }
            const predPriorInjByName = new Map<string, PredInjAgg>();
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

            // ── Roster competition for predictions ──
            const predRosterByTeamPos = new Map<string, Set<string>>();
            const predPlayerTeamMap = new Map<string, string>();
            for (const r of predSeasonRosters) {
              if (!POSITIONS.includes(r.position) || r.status === 'Inactive') continue;
              const key = `${r.team}:${r.position}`;
              if (!predRosterByTeamPos.has(key)) predRosterByTeamPos.set(key, new Set());
              const name = normalizeName(r.full_name);
              predRosterByTeamPos.get(key)!.add(name);
              predPlayerTeamMap.set(name, r.team);
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
            const predPriorPosByName = new Map<string, string>();
            for (const p of predPriorTotals) {
              if (POSITIONS.includes(p.position)) predPriorPosByName.set(normalizeName(p.player_display_name), p.position);
            }
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
              const [, pos] = key.split(':');
              if (pos !== 'WR' && pos !== 'TE') continue;
              for (const name of names) {
                const ppr = predPriorPPRByName.get(name) || 0;
                predTeamPassCatcherPPR2.set(team, (predTeamPassCatcherPPR2.get(team) || 0) + ppr);
                const rank = predPosPriorRanks.get(pos)?.get(name) || 999;
                if (rank <= 24) predTeamElitePassCatchers2.set(team, (predTeamElitePassCatchers2.get(team) || 0) + 1);
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

            // ── Scheme features for predictions ──
            interface PredSchemeAgg {
              passes: number; rushes: number; plays: number; games: number;
              neutralPasses: number; neutralPlays: number;
              firstDownRuns: number; firstDownPlays: number;
              shotgunPlays: number; noHuddlePlays: number;
              rbTargets: number; teTargets: number; wrTargets: number; totalTargets: number;
            }
            const predSchemeByTeam = new Map<string, PredSchemeAgg>();
            const predPriorGamesByTeam = new Map<string, Set<string>>();
            // Personnel aggregation for predictions
            interface PredPersonnelAgg {
              p11: number; p12: number; p13: number; p21: number;
              p22: number; p10: number; total: number;
              wr3plus: number; te2plus: number;
            }
            const predPersonnelByTeam = new Map<string, PredPersonnelAgg>();

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

              // Personnel grouping
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
                const priorCoach = coachBySeasonTeam.get(`${priorSeason}:${team}`);
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

                // Roster competition features
                ...(() => {
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

                  return {
                    teamSamePosCount: samePosCount,
                    depthChartRank: predDepthRankByName.get(normalName) || 99,
                    priorTeamTouchShare: Math.round(playerTouchShare * 1000) / 1000,
                    priorTeamTargetShare: Math.round(playerTargetShareTeam * 1000) / 1000,
                    newSamePosAdded: newArrivals,
                    teamDraftedSamePos: draftedInfo ? draftedInfo.count : 0,
                    draftCapitalSamePos: draftedInfo ? Math.max(0, 8 - Math.ceil(draftedInfo.bestPick / 32)) : 0,
                    teammatePriorPPR: Math.round(bestTeammatePPR * 10) / 10,

                    // Quality-aware cross-position competition
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
                  };
                })(),

                // Coaching & scheme features
                ...(() => {
                  const pTeam = predPlayerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                  const scheme = predSchemeByTeam.get(pTeam);
                  const totalPlays = scheme?.plays || 1;
                  const totalGames = scheme?.games || 1;
                  return {
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
                  };
                })(),

                // Personnel & positional usage features
                ...(() => {
                  const pTeam2 = predPlayerTeamMap.get(normalName) || adpPlayer.team || prior?.recent_team || '';
                  const pers = predPersonnelByTeam.get(pTeam2);
                  const persTotal = pers?.total || 1;
                  const sch = predSchemeByTeam.get(pTeam2);
                  const schGames = sch?.games || 1;
                  const schTotalTgts = sch?.totalTargets || 1;
                  return {
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
                  };
                })(),
              };

              predRows.push({
                name: adpPlayer.name,
                position: adpPlayer.position,
                team: adpPlayer.team || '',
                adp: adpPlayer.adp,
                features,
              });
            }
          }
        }
        setPredictionRows(predRows);

        // Train per-position models (both Ridge and GBM)
        const posModels: PositionModel[] = [];
        for (const pos of POSITIONS) {
          const posRows = rows.filter((r) => r.position === pos && r.adp <= maxADP);
          if (posRows.length < 10) continue;

          const posFeatures = FEATURES.filter((f) => f.positions.includes(pos));
          const featureKeys = posFeatures.map((f) => f.key);
          const featureLabels = posFeatures.map((f) => f.label);

          const X = posRows.map((r) => featureKeys.map((k) => r.features[k] || 0));
          const y = posRows.map((r) => r.adpDelta);

          const ridgeModel = trainRidgeRegression(X, y, featureKeys, lambda);
          const gbmModel = trainGBM(X, y, featureKeys, {
            nEstimators: 150,
            learningRate: 0.08,
            maxDepth: 3,
            minSamplesLeaf: Math.max(3, Math.round(posRows.length * 0.05)),
            subsample: 0.8,
          });

          posModels.push({
            position: pos,
            ridgeModel,
            gbmModel,
            featureNames: featureKeys,
            featureLabels,
            n: posRows.length,
            hitRate: Math.round(posRows.filter((r) => r.isHit).length / posRows.length * 100),
            bustRate: Math.round(posRows.filter((r) => r.isBust).length / posRows.length * 100),
            rSquared: 0,
            mae: 0,
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

  // Feature importance sorted by absolute value
  const featureImportance = useMemo(() => {
    if (!currentModel) return [];

    if (modelType === 'gbm' && currentModel.gbmModel) {
      // For GBM: compute average feature contribution across training data
      const gbm = currentModel.gbmModel;
      const posRows = allRows.filter((r) => r.position === selectedPos && r.adp <= maxADP);
      const contribSums = new Array(currentModel.featureNames.length).fill(0);
      for (const row of posRows) {
        const result = predictGBM(gbm, row.features);
        for (const fc of result.featureContributions) {
          const idx = currentModel.featureNames.indexOf(fc.name);
          if (idx >= 0) contribSums[idx] += fc.contribution;
        }
      }
      const n = posRows.length || 1;
      return currentModel.featureNames
        .map((key, i) => {
          const def = FEATURES.find((f) => f.key === key);
          const avgContrib = contribSums[i] / n;
          return {
            key,
            label: currentModel.featureLabels[i],
            category: def?.category || 'Other',
            coefficient: avgContrib,
            absCoeff: Math.abs(avgContrib),
          };
        })
        .sort((a, b) => b.absCoeff - a.absCoeff);
    }

    // Ridge: use coefficients directly
    if (!currentModel.ridgeModel) return [];
    return currentModel.featureNames
      .map((key, i) => {
        const def = FEATURES.find((f) => f.key === key);
        return {
          key,
          label: currentModel.featureLabels[i],
          category: def?.category || 'Other',
          coefficient: currentModel.ridgeModel!.coefficients[i],
          absCoeff: Math.abs(currentModel.ridgeModel!.coefficients[i]),
        };
      })
      .sort((a, b) => b.absCoeff - a.absCoeff);
  }, [currentModel, modelType, allRows, selectedPos, maxADP]);

  // Per-player predictions for selected position
  const playerPredictions = useMemo(() => {
    if (!currentModel) return [];
    const posRows = allRows.filter((r) => r.position === selectedPos && r.adp <= maxADP);
    return posRows.map((r) => {
      const result = modelType === 'gbm' && currentModel.gbmModel
        ? predictGBM(currentModel.gbmModel, r.features)
        : currentModel.ridgeModel
          ? predict(currentModel.ridgeModel, r.features)
          : { predicted: 0, featureContributions: [] };
      const factors = result.featureContributions.map((fc) => {
        const idx = currentModel.featureNames.indexOf(fc.name);
        return {
          key: fc.name,
          label: idx >= 0 ? currentModel.featureLabels[idx] : fc.name,
          raw: fc.value,
          contribution: fc.contribution,
        };
      });
      return {
        name: r.name,
        season: r.season,
        adp: r.adp,
        actualDelta: r.adpDelta,
        predictedDelta: Math.round(result.predicted * 10) / 10,
        isHit: r.isHit,
        isBust: r.isBust,
        factors,
      };
    }).sort((a, b) => b.predictedDelta - a.predictedDelta);
  }, [currentModel, allRows, selectedPos, maxADP, modelType]);

  const selectedPrediction = useMemo(
    () => playerPredictions.find((p) => p.name === selectedPlayerName) || null,
    [playerPredictions, selectedPlayerName]
  );

  // 2026 predictions for selected position
  const predictions2026 = useMemo(() => {
    const model = models.find((m) => m.position === selectedPos);
    if (!model) return [];
    const posPlayers = predictionRows.filter((r) => r.position === selectedPos && r.adp <= maxADP);
    return posPlayers.map((r) => {
      const result = modelType === 'gbm' && model.gbmModel
        ? predictGBM(model.gbmModel, r.features)
        : model.ridgeModel
          ? predict(model.ridgeModel, r.features)
          : { predicted: 0, featureContributions: [] };
      const factors = result.featureContributions.map((fc) => {
        const idx = model.featureNames.indexOf(fc.name);
        return {
          key: fc.name,
          label: idx >= 0 ? model.featureLabels[idx] : fc.name,
          raw: fc.value,
          contribution: fc.contribution,
        };
      });
      return {
        name: r.name,
        team: r.team,
        adp: r.adp,
        predictedDelta: Math.round(result.predicted * 10) / 10,
        hitProb: result.predicted >= -12 ? 'Likely Hit' : result.predicted < -24 ? 'Likely Bust' : 'Middle',
        factors,
      };
    }).sort((a, b) => b.predictedDelta - a.predictedDelta);
  }, [models, predictionRows, selectedPos, maxADP, modelType]);

  const selected2026Prediction = useMemo(
    () => predictions2026.find((p) => p.name === selected2026Player) || null,
    [predictions2026, selected2026Player]
  );

  // Cross-position comparison: top features per position
  const crossPositionData = useMemo(() => {
    const commonFeatures = FEATURES.filter((f) => f.positions.length === 4);

    // For GBM, compute average contributions per feature per position
    const gbmContribsByPos = new Map<string, Map<string, number>>();
    if (modelType === 'gbm') {
      for (const m of models) {
        if (!m.gbmModel) continue;
        const posRows = allRows.filter((r) => r.position === m.position && r.adp <= maxADP);
        const contribs = new Map<string, number>();
        for (const row of posRows) {
          const result = predictGBM(m.gbmModel, row.features);
          for (const fc of result.featureContributions) {
            contribs.set(fc.name, (contribs.get(fc.name) || 0) + fc.contribution);
          }
        }
        const n = posRows.length || 1;
        for (const [k, v] of contribs) contribs.set(k, v / n);
        gbmContribsByPos.set(m.position, contribs);
      }
    }

    return commonFeatures.map((feat) => {
      const row: Record<string, unknown> = { label: feat.label };
      for (const m of models) {
        if (modelType === 'gbm') {
          row[m.position] = Math.round((gbmContribsByPos.get(m.position)?.get(feat.key) || 0) * 1000) / 1000;
        } else {
          const idx = m.featureNames.indexOf(feat.key);
          row[m.position] = idx >= 0 && m.ridgeModel ? Math.round(m.ridgeModel.coefficients[idx] * 1000) / 1000 : 0;
        }
      }
      return row;
    }).sort((a, b) => {
      const maxA = Math.max(...POSITIONS.map((p) => Math.abs((a[p] as number) || 0)));
      const maxB = Math.max(...POSITIONS.map((p) => Math.abs((b[p] as number) || 0)));
      return maxB - maxA;
    });
  }, [models, modelType, allRows, maxADP]);

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
        {modelType === 'gbm' ? 'Gradient boosting' : 'Ridge regression'} models trained per position on {allRows.length} player-seasons ({SEASONS[0]}-{SEASONS[SEASONS.length - 1]}).
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
          <label className="control-label">Model</label>
          <select value={modelType} onChange={(e) => setModelType(e.target.value as ModelType)}>
            <option value="gbm">Gradient Boosting</option>
            <option value="ridge">Ridge Regression</option>
          </select>
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

        {modelType === 'ridge' && (
          <div className="control-group">
            <label className="control-label">Lambda</label>
            <select value={lambda} onChange={(e) => setLambda(Number(e.target.value))}>
              <option value={1}>1 (low)</option>
              <option value={5}>5 (default)</option>
              <option value={10}>10</option>
              <option value={25}>25 (high)</option>
            </select>
          </div>
        )}
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
              <div>R² = <strong style={{ color: 'var(--text-primary)' }}>{(modelType === 'gbm' ? m.gbmModel?.rSquared ?? 0 : m.ridgeModel?.rSquared ?? 0).toFixed(3)}</strong></div>
              <div>MAE = <strong style={{ color: 'var(--text-primary)' }}>{Math.round(modelType === 'gbm' ? m.gbmModel?.mae ?? 0 : m.ridgeModel?.mae ?? 0)}</strong></div>
              <div>N = {m.n} &middot; Hits {m.hitRate}% &middot; Busts {m.bustRate}%</div>
            </div>
          </div>
        ))}
      </div>

      {/* ── 2026 Predictions ── */}
      {currentModel && predictions2026.length > 0 && (
        <>
          <h4 style={{ marginBottom: 4, marginTop: 8 }}>
            <span style={{ color: '#f59e0b', fontSize: 18 }}>{PREDICT_SEASON}</span>{' '}
            {selectedPos} Predictions
            <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>
              Model-predicted ADP delta &middot; {predictions2026.length} players
            </span>
          </h4>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 12 }}>
            Trained on {SEASONS[0]}-{SEASONS[SEASONS.length - 1]} outcomes, applied to {PREDICT_SEASON} preseason ADP + {PREDICT_SEASON - 1} stats. Positive = predicted to outperform ADP.
          </p>
          <div className="table-container" style={{ marginBottom: 20, maxHeight: 500, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>Team</th>
                  <th>ADP</th>
                  <th>Predicted Delta</th>
                  <th>Outlook</th>
                </tr>
              </thead>
              <tbody>
                {predictions2026.map((p, i) => (
                  <tr
                    key={p.name}
                    style={{ background: selected2026Player === p.name ? 'var(--bg-tertiary)' : undefined }}
                  >
                    <td className="rank-cell">{i + 1}</td>
                    <td>
                      <strong
                        style={{
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          textDecorationColor: 'var(--border)',
                          color: selected2026Player === p.name ? 'var(--accent)' : undefined,
                        }}
                        onClick={() => setSelected2026Player(selected2026Player === p.name ? null : p.name)}
                      >
                        {p.name}
                      </strong>
                    </td>
                    <td style={{ color: 'var(--text-muted)' }}>{p.team}</td>
                    <td>{p.adp.toFixed(1)}</td>
                    <td style={{
                      fontWeight: 700,
                      color: p.predictedDelta >= 0 ? '#10b981' : '#ef4444',
                    }}>
                      {p.predictedDelta >= 0 ? '+' : ''}{p.predictedDelta}
                    </td>
                    <td>
                      <span style={{
                        fontSize: 11,
                        fontWeight: 700,
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: p.hitProb === 'Likely Hit' ? 'rgba(16,185,129,0.15)'
                          : p.hitProb === 'Likely Bust' ? 'rgba(239,68,68,0.15)' : 'rgba(107,114,128,0.15)',
                        color: p.hitProb === 'Likely Hit' ? '#10b981'
                          : p.hitProb === 'Likely Bust' ? '#ef4444' : '#6b7280',
                      }}>
                        {p.hitProb === 'Likely Hit' ? 'HIT' : p.hitProb === 'Likely Bust' ? 'BUST' : 'MID'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Factor breakdown for selected 2026 player */}
          {selected2026Prediction && (
            <div style={{
              background: 'var(--bg-secondary)',
              border: '2px solid #f59e0b',
              borderRadius: 'var(--radius)',
              padding: 16,
              marginBottom: 20,
            }}>
              <h4 style={{ marginBottom: 4 }}>
                {selected2026Prediction.name}
                <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>
                  {PREDICT_SEASON} &middot; ADP {selected2026Prediction.adp.toFixed(1)} &middot;
                  Predicted: <span style={{ color: selected2026Prediction.predictedDelta >= 0 ? '#10b981' : '#ef4444' }}>
                    {selected2026Prediction.predictedDelta >= 0 ? '+' : ''}{selected2026Prediction.predictedDelta}
                  </span>
                </span>
              </h4>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                Top factors driving this {PREDICT_SEASON} prediction:
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {selected2026Prediction.factors.slice(0, 10).map((f) => {
                  const maxContrib = Math.max(
                    ...selected2026Prediction.factors.slice(0, 10).map((x) => Math.abs(x.contribution))
                  ) || 1;
                  const pct = (Math.abs(f.contribution) / maxContrib) * 100;
                  return (
                    <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                      <span style={{ width: 140, textAlign: 'right', color: 'var(--text-secondary)', flexShrink: 0 }}>
                        {f.label}
                      </span>
                      <span style={{ width: 60, textAlign: 'right', fontFamily: 'monospace', color: 'var(--text-muted)', flexShrink: 0 }}>
                        {typeof f.raw === 'number' ? (Number.isInteger(f.raw) ? f.raw : f.raw.toFixed(1)) : f.raw}
                      </span>
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', height: 16 }}>
                        {f.contribution >= 0 ? (
                          <div style={{
                            width: `${pct}%`,
                            height: 12,
                            borderRadius: 3,
                            background: '#10b981',
                            opacity: 0.7,
                          }} />
                        ) : (
                          <div style={{
                            width: `${pct}%`,
                            height: 12,
                            borderRadius: 3,
                            background: '#ef4444',
                            opacity: 0.7,
                            marginLeft: 'auto',
                          }} />
                        )}
                      </div>
                      <span style={{
                        width: 60,
                        textAlign: 'right',
                        fontWeight: 700,
                        fontFamily: 'monospace',
                        color: f.contribution >= 0 ? '#10b981' : '#ef4444',
                        flexShrink: 0,
                      }}>
                        {f.contribution >= 0 ? '+' : ''}{f.contribution.toFixed(1)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {currentModel && (
        <>
          {/* Feature Importance Bar Chart */}
          <h4 style={{ marginBottom: 8 }}>
            {selectedPos} Hit/Bust Predictors
            <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>
              ({modelType === 'gbm' ? 'positive = predicts outperformance' : 'positive coefficient = predicts outperformance'})
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
                  formatter={(value) => [Number(value).toFixed(4), modelType === 'gbm' ? 'Avg Contribution' : 'Coefficient']}
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
                  <th>{modelType === 'gbm' ? 'Avg Contribution' : 'Coefficient'}</th>
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

      {/* Player predictions list */}
      {currentModel && playerPredictions.length > 0 && (
        <>
          <h4 style={{ marginBottom: 8 }}>
            {selectedPos} Player Predictions
            <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>
              Click a player name to see their factor breakdown
            </span>
          </h4>
          <div className="table-container" style={{ marginBottom: 20, maxHeight: 420, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>Season</th>
                  <th>ADP</th>
                  <th>Predicted Delta</th>
                  <th>Actual Delta</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {playerPredictions.map((p, i) => (
                  <tr
                    key={`${p.name}-${p.season}`}
                    style={{
                      background: selectedPlayerName === p.name ? 'var(--bg-tertiary)' : undefined,
                    }}
                  >
                    <td className="rank-cell">{i + 1}</td>
                    <td>
                      <strong
                        style={{
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          textDecorationColor: 'var(--border)',
                          color: selectedPlayerName === p.name ? 'var(--accent)' : undefined,
                        }}
                        onClick={() => setSelectedPlayerName(selectedPlayerName === p.name ? null : p.name)}
                      >
                        {p.name}
                      </strong>
                    </td>
                    <td style={{ color: 'var(--text-muted)' }}>{p.season}</td>
                    <td>{p.adp.toFixed(1)}</td>
                    <td style={{
                      fontWeight: 700,
                      color: p.predictedDelta >= 0 ? '#10b981' : '#ef4444',
                    }}>
                      {p.predictedDelta >= 0 ? '+' : ''}{p.predictedDelta}
                    </td>
                    <td style={{
                      fontWeight: 700,
                      color: p.actualDelta >= 0 ? '#10b981' : '#ef4444',
                    }}>
                      {p.actualDelta >= 0 ? '+' : ''}{p.actualDelta}
                    </td>
                    <td>
                      <span style={{
                        fontSize: 11,
                        fontWeight: 700,
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: p.isHit ? 'rgba(16,185,129,0.15)' : p.isBust ? 'rgba(239,68,68,0.15)' : 'rgba(107,114,128,0.15)',
                        color: p.isHit ? '#10b981' : p.isBust ? '#ef4444' : '#6b7280',
                      }}>
                        {p.isHit ? 'HIT' : p.isBust ? 'BUST' : 'MID'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Factor breakdown for selected player */}
          {selectedPrediction && (
            <div style={{
              background: 'var(--bg-secondary)',
              border: '2px solid var(--accent)',
              borderRadius: 'var(--radius)',
              padding: 16,
              marginBottom: 20,
            }}>
              <h4 style={{ marginBottom: 4 }}>
                {selectedPrediction.name}
                <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>
                  {selectedPrediction.season} &middot; ADP {selectedPrediction.adp.toFixed(1)} &middot;
                  Predicted: <span style={{ color: selectedPrediction.predictedDelta >= 0 ? '#10b981' : '#ef4444' }}>
                    {selectedPrediction.predictedDelta >= 0 ? '+' : ''}{selectedPrediction.predictedDelta}
                  </span> &middot;
                  Actual: <span style={{ color: selectedPrediction.actualDelta >= 0 ? '#10b981' : '#ef4444' }}>
                    {selectedPrediction.actualDelta >= 0 ? '+' : ''}{selectedPrediction.actualDelta}
                  </span>
                </span>
              </h4>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                Top factors driving this prediction (contribution to predicted ADP delta):
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {selectedPrediction.factors.slice(0, 10).map((f) => {
                  const maxContrib = Math.max(
                    ...selectedPrediction.factors.slice(0, 10).map((x) => Math.abs(x.contribution))
                  ) || 1;
                  const pct = (Math.abs(f.contribution) / maxContrib) * 100;
                  return (
                    <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                      <span style={{ width: 140, textAlign: 'right', color: 'var(--text-secondary)', flexShrink: 0 }}>
                        {f.label}
                      </span>
                      <span style={{ width: 60, textAlign: 'right', fontFamily: 'monospace', color: 'var(--text-muted)', flexShrink: 0 }}>
                        {typeof f.raw === 'number' ? (Number.isInteger(f.raw) ? f.raw : f.raw.toFixed(1)) : f.raw}
                      </span>
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', height: 16 }}>
                        {f.contribution >= 0 ? (
                          <div style={{
                            width: `${pct}%`,
                            height: 12,
                            borderRadius: 3,
                            background: '#10b981',
                            opacity: 0.7,
                          }} />
                        ) : (
                          <div style={{
                            width: `${pct}%`,
                            height: 12,
                            borderRadius: 3,
                            background: '#ef4444',
                            opacity: 0.7,
                            marginLeft: 'auto',
                          }} />
                        )}
                      </div>
                      <span style={{
                        width: 60,
                        textAlign: 'right',
                        fontWeight: 700,
                        fontFamily: 'monospace',
                        color: f.contribution >= 0 ? '#10b981' : '#ef4444',
                        flexShrink: 0,
                      }}>
                        {f.contribution >= 0 ? '+' : ''}{f.contribution.toFixed(1)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
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
          All {modelType === 'gbm' ? 'contributions' : 'coefficients'} by position
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
                  if (idx < 0) return null;
                  if (modelType === 'ridge' && m.ridgeModel) {
                    return m.ridgeModel.coefficients[idx];
                  }
                  // For GBM, look up precomputed cross-position data
                  const cpRow = crossPositionData.find((r) => r.label === feat.label);
                  return cpRow ? (cpRow[m.position] as number) ?? null : null;
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
