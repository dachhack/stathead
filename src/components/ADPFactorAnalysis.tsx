import React, { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Label, Legend,
  ScatterChart, Scatter,
} from 'recharts';
import {
  fetchFfcADP, fetchPlayerStats,
  fetchCombine, fetchDraftPicks, fetchSnapCounts, fetchInjuries,
  fetchNextGenStats, fetchPlayByPlay, fetchPbpParticipation,
  fetchRosters, fetchDepthCharts, fetchGames,
} from '../data';
import type { ScenarioConfig } from '../types';
import { trainRidgeRegression, predict, type TrainedModel } from '../lib/ridge';
import { trainGBM, predictGBM, type TrainedGBM } from '../lib/gbm';
import { loadAllScenarios } from '../lib/scenarioEngine';
import {
  buildFeatures,
  type PlayerRow, type PredictionRow,
  type HistoricalSeasonData, type PredictionSeasonData,
} from '../lib/featureBuilder';

type ModelType = 'ridge' | 'gbm';

// ── Config ──

// Need prior-season data, so training starts at 2021
const SEASONS = [2021, 2022, 2023, 2024, 2025];
const PREDICT_SEASON = 2026; // upcoming season to predict
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const REPLACEMENT_RANKS: Record<string, number> = { QB: 12, RB: 24, WR: 24, TE: 12 };
const POS_COLORS: Record<string, string> = {
  QB: '#6366f1', RB: '#10b981', WR: '#f59e0b', TE: '#ef4444',
};

// ── Draft optimizer helpers ──
const FLEX_POS  = new Set(['RB', 'WR', 'TE']);
const SF_POS    = new Set(['QB', 'RB', 'WR', 'TE']);
const ALL_DRAFT_SLOTS = ['QB', 'RB', 'WR', 'TE', 'Flex', 'SuperFlex', 'K', 'DEF'];

function canFillSlot(slot: string, pos: string): boolean {
  if (slot === pos) return true;
  if (slot === 'Flex'      && FLEX_POS.has(pos)) return true;
  if (slot === 'SuperFlex' && SF_POS.has(pos))   return true;
  return false;
}

function findSlotIndex(remaining: string[], pos: string): number {
  const exact = remaining.findIndex((s) => s === pos);
  if (exact !== -1) return exact;
  return remaining.findIndex((s) => canFillSlot(s, pos) && s !== pos);
}

interface RosterPreset { starters: string[]; bench: string[] }
const ROSTER_PRESETS: Record<string, RosterPreset> = {
  'Standard':      { starters: ['QB','RB','RB','WR','WR','TE','Flex'],          bench: ['RB','WR','WR','WR','QB'] },
  '2-Flex':        { starters: ['QB','RB','RB','WR','WR','TE','Flex','Flex'],   bench: ['RB','WR','WR','QB'] },
  'Superflex':     { starters: ['QB','RB','RB','WR','WR','TE','SuperFlex','Flex'], bench: ['RB','WR','WR','QB'] },
  'Starters only': { starters: ['QB','RB','RB','WR','WR','TE','Flex'],          bench: [] },
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

  // Vegas / implied totals
  { key: 'vegasImpliedTotal', label: 'Vegas Implied Team Total', category: 'Vegas', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'vegasImpliedSpread', label: 'Vegas Avg Spread', category: 'Vegas', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'vegasGameTotal', label: 'Vegas Avg Game Total', category: 'Vegas', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'vegasWinPct', label: 'Vegas Implied Win %', category: 'Vegas', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'vegasActualPtsPerGame', label: 'Prior Actual Pts/Game', category: 'Vegas', positions: ['QB', 'RB', 'WR', 'TE'] },

  // ── Projection model features (from our team-projection methodology) ──
  { key: 'projTeamPassAtt',     label: 'Proj Team Pass Att',       category: 'Projection', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'projTeamPassVolChg',  label: 'Proj Team Pass Vol Chg',   category: 'Projection', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'projPlayerPPR',       label: 'Proj Player PPR',          category: 'Projection', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'projPlayerVsExpected',label: 'Proj Player vs Expected',  category: 'Projection', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'projTargetShare',     label: 'Proj Target Share',        category: 'Projection', positions: ['RB', 'WR', 'TE'] },
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
  Vegas: '#22c55e',
  Projection: '#f97316',
};

// ── Types ──

interface PositionModel {
  position: string;
  ridgeModel?: TrainedModel;
  gbmModel?: TrainedGBM;
  featureNames: string[];
  featureLabels: string[];
  n: number;
  hitRate: number;
  bustRate: number;
  rSquared: number;     // unused legacy field
  mae: number;          // unused legacy field
  // Leave-one-season-out cross-validated metrics (honest out-of-sample)
  cvR2Gbm: number;
  cvMaeGbm: number;
  cvR2Ridge: number;
  cvMaeRidge: number;
  cvR2GbmBaseline: number;  // CV R² without projection features
}

// ── CV metric helpers ──
function cvR2(actuals: number[], preds: number[]): number {
  if (actuals.length < 4) return 0;
  const mean = actuals.reduce((s, v) => s + v, 0) / actuals.length;
  const ssTot = actuals.reduce((s, v) => s + (v - mean) ** 2, 0);
  const ssRes = actuals.reduce((s, v, i) => s + (v - preds[i]) ** 2, 0);
  return ssTot === 0 ? 0 : Math.round((1 - ssRes / ssTot) * 1000) / 1000;
}
function cvMae(actuals: number[], preds: number[]): number {
  if (actuals.length === 0) return 0;
  return Math.round(actuals.reduce((s, v, i) => s + Math.abs(v - preds[i]), 0) / actuals.length * 100) / 100;
}

// ── Component ──

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function ADPFactorAnalysis({ scenario: _scenarioProp }: { scenario?: ScenarioConfig }) {
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
  const [hitBustPos, setHitBustPos] = useState<string>('ALL');
  const [adpView, setAdpView] = useState<'model' | 'strategy'>('model');
  const [leagueSize, setLeagueSize] = useState(12);
  const [strategyMetric, setStrategyMetric] = useState<'hitbust' | 'vor'>('hitbust');
  const [halfRounds, setHalfRounds] = useState(false);
  const [pickNumber, setPickNumber] = useState(1);
  const [starterSlots, setStarterSlots] = useState<string[]>(['QB','RB','RB','WR','WR','TE','Flex']);
  const [benchSlots,  setBenchSlots]  = useState<string[]>(['RB','WR','WR','WR','QB']);
  const [optimizerMetric, setOptimizerMetric] = useState<'vor' | 'hitbust'>('vor');
  const [actualPicks, setActualPicks] = useState<Record<number, { name: string; position: string }>>({});
  const [roundPositions, setRoundPositions] = useState<Record<number, string>>({}); // per-round position override for suggestions
  const [vorNormParams, setVorNormParams] = useState<Map<string, { mean: number; std: number }>>(new Map());

  // ── Scenario selection (loaded from saved localStorage scenarios) ──
  const [savedScenarios, setSavedScenarios] = useState<ScenarioConfig[]>(() => loadAllScenarios());
  const [activeScenarioId, setActiveScenarioId] = useState<string>('none');
  const activeScenario = useMemo(
    () => activeScenarioId === 'none' ? undefined : savedScenarios.find((s) => s.id === activeScenarioId),
    [activeScenarioId, savedScenarios],
  );

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        let resolvedRows: PlayerRow[] | null = null;
        let resolvedVorNorm: Map<string, { mean: number; std: number }> | null = null;
        let resolvedPredRows: PredictionRow[] | null = null;

        // ── Fast path: try pre-built features JSON (generated at build time) ──
        try {
          const prebuiltResp = await fetch(`${import.meta.env.BASE_URL}data/prebuilt-features.json`);
          if (prebuiltResp.ok) {
            const pb: { allRows: PlayerRow[]; vorNormParams: Record<string, { mean: number; std: number }>; predictionRows: PredictionRow[] } = await prebuiltResp.json();
            resolvedRows = pb.allRows;
            resolvedVorNorm = new Map(Object.entries(pb.vorNormParams));
            resolvedPredRows = pb.predictionRows;
            if (!cancelled) setLoadingStatus('Training models...');
          }
        } catch { /* fall through to full computation */ }

        if (!resolvedRows) {
          // ── Full computation path ──
          setLoadingStatus('Loading combine, draft & games data...');
          const [combineData, draftData, gamesData] = await Promise.all([
            fetchCombine(),
            fetchDraftPicks(),
            fetchGames(),
          ]);
          if (cancelled) return;

          const seasonDataArr: HistoricalSeasonData[] = [];
          for (const season of SEASONS) {
            setLoadingStatus(`Loading season ${season}...`);
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
              fetchNextGenStats(season - 1, 'receiving').catch(() => []),
              fetchNextGenStats(season - 1, 'rushing').catch(() => []),
              fetchNextGenStats(season - 1, 'passing').catch(() => []),
              fetchPlayByPlay(season - 1).catch(() => []),
              fetchPbpParticipation(season - 1).catch(() => []),
              fetchRosters(season).catch(() => []),
              fetchRosters(season - 1).catch(() => []),
              fetchDepthCharts(season).catch(() => []),
            ]);
            if (cancelled) return;
            seasonDataArr.push({
              season, adpData, currentStats, priorStats, priorSnaps,
              priorInjuries, preseasonInjuries,
              priorNgsRec, priorNgsRush, priorNgsPass,
              priorPbp, priorParticipation,
              seasonRosters, priorRosters, seasonDepthCharts,
            });
          }

          // Build prediction season data
          const predSeasonYear = PREDICT_SEASON;
          const priorSeasonYear = predSeasonYear - 1;
          const [
            predAdpData, predPriorStats, predPriorSnaps,
            predPriorInjuries, predPreseasonInjuries,
            predPriorNgsRec, predPriorNgsRush, predPriorNgsPass,
            predPriorPbp, predPriorParticipation,
            predSeasonRosters, predPriorRosters, predSeasonDepthCharts,
          ] = await Promise.all([
            fetchFfcADP(predSeasonYear, 'ppr', 12).catch(() => []),
            fetchPlayerStats(priorSeasonYear).catch(() => []),
            fetchSnapCounts(priorSeasonYear).catch(() => []),
            fetchInjuries(priorSeasonYear).catch(() => []),
            fetchInjuries(predSeasonYear).catch(() => []),
            fetchNextGenStats(priorSeasonYear, 'receiving').catch(() => []),
            fetchNextGenStats(priorSeasonYear, 'rushing').catch(() => []),
            fetchNextGenStats(priorSeasonYear, 'passing').catch(() => []),
            fetchPlayByPlay(priorSeasonYear).catch(() => []),
            fetchPbpParticipation(priorSeasonYear).catch(() => []),
            fetchRosters(predSeasonYear).catch(() => []),
            fetchRosters(priorSeasonYear).catch(() => []),
            fetchDepthCharts(predSeasonYear).catch(() => []),
          ]);
          if (cancelled) return;

          const predData: PredictionSeasonData = {
            predictSeason: predSeasonYear,
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
          };

          const result = await buildFeatures(
            seasonDataArr, combineData, draftData, gamesData, predData,
            (msg) => { if (!cancelled) setLoadingStatus(msg); },
          );
          if (cancelled) return;

          resolvedRows = result.allRows;
          resolvedVorNorm = new Map(Object.entries(result.vorNormParams));
          resolvedPredRows = result.predictionRows;
        }

        if (cancelled) return;
        setAllRows(resolvedRows);
        setVorNormParams(resolvedVorNorm!);
        setPredictionRows(resolvedPredRows!);

        // ── Local vars for model training (use resolved values, not stale state) ──
        const rows = resolvedRows;


        // Train per-position models (both Ridge and GBM)
        // Then compute leave-one-season-out cross-validated R² and MAE for
        // honest out-of-sample performance estimates.
        const PROJ_KEYS = ['projTeamPassAtt','projTeamPassVolChg','projPlayerPPR','projPlayerVsExpected','projTargetShare'];
        const GBM_OPTS_FULL = { nEstimators: 150, learningRate: 0.08, maxDepth: 3, subsample: 0.8 };
        const GBM_OPTS_CV   = { nEstimators: 80,  learningRate: 0.10, maxDepth: 3, subsample: 0.8 };

        const posModels: PositionModel[] = [];
        for (const pos of POSITIONS) {
          const posRows = rows.filter((r) => r.position === pos && r.adp <= maxADP);
          if (posRows.length < 10) continue;

          const posFeatures  = FEATURES.filter((f) => f.positions.includes(pos));
          const featureKeys  = posFeatures.map((f) => f.key);
          const featureLabels = posFeatures.map((f) => f.label);
          const baselineKeys = featureKeys.filter((k) => !PROJ_KEYS.includes(k));

          const X = posRows.map((r) => featureKeys.map((k) => r.features[k] || 0));
          const y = posRows.map((r) => r.vor);

          // Full-data models (used for 2026 predictions and factor attributions)
          const ridgeModel = trainRidgeRegression(X, y, featureKeys, lambda);
          const gbmModel = trainGBM(X, y, featureKeys, {
            ...GBM_OPTS_FULL,
            minSamplesLeaf: Math.max(3, Math.round(posRows.length * 0.05)),
          });

          // ── Leave-one-season-out cross-validation ─────────────────────────
          // For each held-out season, train on the remaining seasons and
          // predict the held-out samples. Aggregate to get honest R² / MAE.
          const uniqueSeasons = [...new Set(posRows.map((r) => r.season))].sort();
          const losoActuals: number[] = [];
          const losoPredGbm: number[] = [];
          const losoPredRidge: number[] = [];
          const losoPredGbmBase: number[] = [];

          if (uniqueSeasons.length >= 3) {
            for (const held of uniqueSeasons) {
              const trainR = posRows.filter((r) => r.season !== held);
              const testR  = posRows.filter((r) => r.season === held);
              if (trainR.length < 8 || testR.length === 0) continue;

              const Xtr  = trainR.map((r) => featureKeys.map((k)  => r.features[k] || 0));
              const Xtrb = trainR.map((r) => baselineKeys.map((k) => r.features[k] || 0));
              const ytr  = trainR.map((r) => r.vor);
              const msl  = Math.max(3, Math.round(trainR.length * 0.05));

              const foldGbm   = trainGBM(Xtr,  ytr, featureKeys,  { ...GBM_OPTS_CV,  minSamplesLeaf: msl });
              const foldRidge = trainRidgeRegression(Xtr, ytr, featureKeys, lambda);
              const foldBase  = trainGBM(Xtrb, ytr, baselineKeys, { ...GBM_OPTS_CV,  minSamplesLeaf: msl });

              for (const row of testR) {
                losoActuals.push(row.vor);
                // predictGBM / predict take Record<string, number> feature maps
                losoPredGbm.push(predictGBM(foldGbm, row.features).predicted);
                losoPredRidge.push(predict(foldRidge, row.features).predicted);
                losoPredGbmBase.push(predictGBM(foldBase, row.features).predicted);
              }
            }
          }

          const hasCV = losoActuals.length >= 10;
          posModels.push({
            position: pos,
            ridgeModel,
            gbmModel,
            featureNames: featureKeys,
            featureLabels,
            n: posRows.length,
            hitRate:  Math.round(posRows.filter((r) => r.isHit).length  / posRows.length * 100),
            bustRate: Math.round(posRows.filter((r) => r.isBust).length / posRows.length * 100),
            rSquared: 0,
            mae: 0,
            cvR2Gbm:          hasCV ? cvR2(losoActuals, losoPredGbm)   : gbmModel.rSquared,
            cvMaeGbm:         hasCV ? cvMae(losoActuals, losoPredGbm)  : gbmModel.mae,
            cvR2Ridge:        hasCV ? cvR2(losoActuals, losoPredRidge) : ridgeModel.rSquared,
            cvMaeRidge:       hasCV ? cvMae(losoActuals, losoPredRidge): ridgeModel.mae,
            cvR2GbmBaseline:  hasCV ? cvR2(losoActuals, losoPredGbmBase) : 0,
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
  }, [lambda, maxADP, activeScenario]);

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

  // ── Per-position hit/bust thresholds ──────────────────────────────────────
  // Fixed thresholds (-12 / -24) are position-agnostic and biased: QBs are
  // systematically undervalued at ADP so they nearly all "hit" by that rule.
  // Instead, compute the 67th / 33rd percentile of actual VOR within
  // each position so that roughly the top-third are hits and bottom-third
  // are busts for EVERY position equally.
  const posThresholds = useMemo(() => {
    const map = new Map<string, { hit: number; bust: number }>();
    for (const pos of POSITIONS) {
      const deltas = allRows
        .filter((r) => r.position === pos)
        .map((r) => r.vor)
        .sort((a, b) => a - b);
      if (deltas.length < 6) continue;
      map.set(pos, {
        hit:  deltas[Math.floor(deltas.length * 0.67)],
        bust: deltas[Math.floor(deltas.length * 0.33)],
      });
    }
    return map;
  }, [allRows]);

  const isHitForPos  = (pos: string, delta: number) => delta >= (posThresholds.get(pos)?.hit  ?? 0);
  const isBustForPos = (pos: string, delta: number) => delta <  (posThresholds.get(pos)?.bust ?? -50);

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
        actualVor: r.vor,
        predictedVor: Math.round(result.predicted * 10) / 10,
        isHit: isHitForPos(r.position, r.vor),
        isBust: isBustForPos(r.position, r.vor),
        factors,
      };
    }).sort((a, b) => b.predictedVor - a.predictedVor);
  }, [currentModel, allRows, selectedPos, maxADP, modelType, posThresholds]);

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
      const pred = Math.round(result.predicted * 10) / 10;
      return {
        name: r.name,
        team: r.team,
        adp: r.adp,
        position: r.position,
        headshotUrl: r.headshotUrl,
        predictedVor: pred,
        hitProb: isHitForPos(r.position, pred) ? 'Likely Hit'
               : isBustForPos(r.position, pred) ? 'Likely Bust'
               : 'Middle',
        factors,
      };
    }).sort((a, b) => b.predictedVor - a.predictedVor);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, predictionRows, selectedPos, maxADP, modelType, posThresholds]);

  // All-position 2026 predictions (for the optimizer player suggestions)
  const allPredictions2026 = useMemo(() => {
    return models.flatMap((m) => {
      const posPlayers = predictionRows.filter((r) => r.position === m.position && r.adp <= maxADP);
      const model = m.gbmModel ?? m.ridgeModel;
      if (!model) return [];
      return posPlayers.map((r) => {
        const result = m.gbmModel
          ? predictGBM(m.gbmModel, r.features)
          : predict(m.ridgeModel!, r.features);
        const pred = Math.round(result.predicted * 10) / 10;
        return {
          name: r.name,
          team: r.team,
          adp: r.adp,
          position: r.position,
          headshotUrl: r.headshotUrl,
          predictedVor: pred,
          hitProb: isHitForPos(r.position, pred) ? 'Likely Hit'
                 : isBustForPos(r.position, pred) ? 'Likely Bust'
                 : 'Middle' as const,
        };
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, predictionRows, maxADP, posThresholds]);

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

  // Scatter data — filtered by hitBustPos (independent of model position selector)
  const scatterData = useMemo(() => {
    const rows = allRows.filter((r) =>
      (hitBustPos === 'ALL' || r.position === hitBustPos) && r.adp <= maxADP
    );
    return rows.map((r) => {
      const hit  = isHitForPos(r.position, r.vor);
      const bust = isBustForPos(r.position, r.vor);
      return {
        name: r.name,
        season: r.season,
        adp: r.adp,
        vor: r.vor,
        isHit: hit,
        isBust: bust,
        position: r.position,
        fill: hitBustPos === 'ALL'
          ? POS_COLORS[r.position] ?? '#6b7280'
          : hit ? '#10b981' : bust ? '#ef4444' : '#6b7280',
      };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRows, hitBustPos, maxADP, posThresholds]);

  // ── Draft strategy: hit/bust rates by round × position ──────────────────
  const strategyData = useMemo(() => {
    const MAX_ROUND = 15;
    const bucketSize = halfRounds ? Math.max(1, Math.floor(leagueSize / 2)) : leagueSize;
    const totalBuckets = halfRounds ? MAX_ROUND * 2 : MAX_ROUND;

    type CellStats = {
      hits: number; busts: number; total: number;
      hitRate: number; bustRate: number; score: number;
      avgVor: number; medianVor: number;
    };
    const matrix: Array<{
      round: number;
      half?: 'a' | 'b';
      label: string;
      picks: string;
      pickStart: number;
      pickEnd: number;
      byPos: Record<string, CellStats>;
      bestPos: string;
      bestPosVor: string;
    }> = [];

    for (let bucket = 0; bucket < totalBuckets; bucket++) {
      const pickStart = bucket * bucketSize + 1;
      const pickEnd   = (bucket + 1) * bucketSize;
      const roundNum  = halfRounds ? Math.floor(bucket / 2) + 1 : bucket + 1;
      const half      = halfRounds ? (bucket % 2 === 0 ? 'a' as const : 'b' as const) : undefined;
      const label     = halfRounds ? `Rd ${roundNum}${half}` : `Rd ${roundNum}`;

      const roundRows = allRows.filter((r) => r.adp >= pickStart && r.adp <= pickEnd);
      if (roundRows.length === 0) continue;

      const byPos: Record<string, CellStats> = {};
      let bestScore  = -Infinity, bestPos    = '';
      let bestAvgVor = -Infinity, bestPosVor = '';

      for (const pos of POSITIONS) {
        const posRows = roundRows.filter((r) => r.position === pos);
        const total   = posRows.length;
        const empty: CellStats = { hits: 0, busts: 0, total, hitRate: 0, bustRate: 0, score: 0, avgVor: 0, medianVor: 0 };
        if (total < 3) { byPos[pos] = empty; continue; }

        const hits     = posRows.filter((r) => isHitForPos(r.position, r.vor)).length;
        const busts    = posRows.filter((r) => isBustForPos(r.position, r.vor)).length;
        const hitRate  = hits / total;
        const bustRate = busts / total;
        const score    = hitRate - bustRate;
        const vors     = posRows.map((r) => r.vor).sort((a, b) => a - b);
        const avgVor   = Math.round((vors.reduce((s, v) => s + v, 0) / vors.length) * 100) / 100;
        const mid = Math.floor(vors.length / 2);
        const medianVor = vors.length % 2 === 0
          ? Math.round(((vors[mid - 1] + vors[mid]) / 2) * 100) / 100
          : Math.round(vors[mid] * 100) / 100;

        byPos[pos] = { hits, busts, total, hitRate, bustRate, score, avgVor, medianVor };
        if (total >= 5 && score   > bestScore)  { bestScore  = score;  bestPos    = pos; }
        if (total >= 5 && avgVor  > bestAvgVor) { bestAvgVor = avgVor; bestPosVor = pos; }
      }

      matrix.push({ round: roundNum, half, label, picks: `${pickStart}–${pickEnd}`, pickStart, pickEnd, byPos, bestPos, bestPosVor });
    }
    return matrix;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRows, leagueSize, halfRounds, posThresholds]);

  // ── Draft Optimizer ──────────────────────────────────────────────────────
  // Approximate PPR replacement levels (historical averages) for expected-pts conversion
  const REP_PPR: Record<string, number> = { QB: 285, RB: 115, WR: 115, TE: 90 };

  const optimizerPlan = useMemo(() => {
    // Only plan for starting roster spots so VOR / total points reflect the starting lineup
    const allSlots = [...starterSlots];
    if (allSlots.length === 0 || strategyData.length === 0) return [];

    const starterCount = starterSlots.length;
    const remaining = [...allSlots]; // mutable copy – starters only

    type PlayerSuggestion = {
      name: string; team: string; adp: number;
      predictedVor: number; hitProb: string; headshotUrl?: string;
      estPPR: number;
    };
    type PlanRow = {
      round: number; label: string; yourPick: number;
      isBench: boolean;
      recPos: string; slotFilled: string;
      displayPos: string;                   // position shown in suggestion (may differ from recPos if user overrode)
      vorScore: number; hitPct: number; bustPct: number; score: number; n: number;
      bucketLabel: string;
      alternatives: Array<{ pos: string; metric: number }>;
      suggestion?: PlayerSuggestion;        // single top suggestion for displayPos (deduplicated across rounds)
      nearbyPlayers: PlayerSuggestion[];    // all positions near this pick (for actual-pick selector)
      // Actual pick fields (set when user overrides)
      isActualPick: boolean;
      actualPlayer?: PlayerSuggestion;      // the player the user said they actually drafted
      actualVsRec?: number;                 // predictedVor of actual − vorScore of rec (>0 = beat rec)
    };
    const plan: PlanRow[] = [];
    let picksUsed = 0;
    // Track already-suggested & already-drafted player names to avoid repeating across rounds
    const shownNames = new Set<string>(Object.values(actualPicks).map((ap) => ap.name));

    // Helper to build a PlayerSuggestion from a 2026 prediction entry
    const makeSuggestion = (p: typeof allPredictions2026[0]): PlayerSuggestion => {
      const norm = vorNormParams.get(p.position);
      const rep  = REP_PPR[p.position] ?? 120;
      return {
        name:         p.name,
        team:         p.team,
        adp:          p.adp,
        predictedVor: p.predictedVor,
        hitProb:      p.hitProb,
        headshotUrl:  p.headshotUrl,
        estPPR:       norm ? Math.round(rep + norm.mean + p.predictedVor * norm.std) : 0,
      };
    };

    for (let r = 1; r <= 25 && remaining.length > 0; r++) {
      const posWithinRound = r % 2 === 1 ? pickNumber : (leagueSize + 1 - pickNumber);
      const yourPick = (r - 1) * leagueSize + posWithinRound;
      const label = halfRounds
        ? `Rd ${r}${posWithinRound <= Math.floor(leagueSize / 2) ? 'a' : 'b'}`
        : `Rd ${r}`;

      const bucket = strategyData.find((b) => yourPick >= b.pickStart && yourPick <= b.pickEnd);
      if (!bucket) continue;

      const adpWindow = leagueSize * 1.5;

      // All players near this pick (for actual-pick dropdown, all positions)
      const nearbyPlayers: PlayerSuggestion[] = allPredictions2026
        .filter((p) => p.adp >= yourPick - adpWindow && p.adp <= yourPick + adpWindow)
        .sort((a, b) => a.adp - b.adp)
        .map(makeSuggestion);

      // ── Determine which position to use (actual pick or greedy) ──
      const actual = actualPicks[r];
      let chosenPos: string;
      let isActualPick = false;
      let actualPlayer: PlayerSuggestion | undefined;

      if (actual) {
        // User stated what they actually picked
        chosenPos    = actual.position;
        isActualPick = true;
        const found  = allPredictions2026.find((p) => p.name === actual.name);
        actualPlayer = found ? makeSuggestion(found) : undefined;
      } else {
        // Greedy: pick the eligible position with the best metric
        const seen = new Set<string>();
        const candidates: Array<{ pos: string; metric: number; vorScore: number; hitPct: number; bustPct: number; score: number; n: number }> = [];
        for (const slot of remaining) {
          for (const pos of POSITIONS) {
            if (seen.has(pos)) continue;
            if (!canFillSlot(slot, pos)) continue;
            const cell = bucket.byPos[pos];
            if (!cell || cell.total < 3) continue;
            seen.add(pos);
            candidates.push({
              pos,
              metric:   optimizerMetric === 'vor' ? cell.avgVor : cell.score,
              vorScore: cell.avgVor,
              hitPct:   Math.round(cell.hitRate  * 100),
              bustPct:  Math.round(cell.bustRate * 100),
              score:    cell.score,
              n:        cell.total,
            });
          }
        }
        if (candidates.length === 0) { remaining.shift(); picksUsed++; continue; }
        candidates.sort((a, b) => b.metric - a.metric);
        chosenPos = candidates[0].pos;
        // store full candidates for alternatives display (also used below)
        // we'll recompute below — store them on a temp var
        (plan as unknown as { _candidates?: typeof candidates })._candidates = candidates;
      }

      // Stats for the chosen position
      const chosenCell = bucket.byPos[chosenPos];
      const vorScore   = chosenCell?.avgVor ?? 0;
      const hitPct     = chosenCell ? Math.round(chosenCell.hitRate  * 100) : 0;
      const bustPct    = chosenCell ? Math.round(chosenCell.bustRate * 100) : 0;
      const score      = chosenCell?.score ?? 0;
      const n          = chosenCell?.total ?? 0;

      // Fill the appropriate remaining slot
      const slotIdx    = findSlotIndex(remaining, chosenPos);
      const slotFilled = slotIdx !== -1 ? remaining[slotIdx] : chosenPos;
      if (slotIdx !== -1) remaining.splice(slotIdx, 1);

      // Single top suggestion — use per-round position override if set, else greedy position
      const displayPos = roundPositions[r] || chosenPos;
      const suggestion: PlayerSuggestion | undefined = allPredictions2026
        .filter((p) => p.position === displayPos
          && p.adp >= yourPick - adpWindow && p.adp <= yourPick + adpWindow
          && !shownNames.has(p.name))
        .sort((a, b) => b.predictedVor - a.predictedVor)[0]
        ? makeSuggestion(
            allPredictions2026
              .filter((p) => p.position === displayPos
                && p.adp >= yourPick - adpWindow && p.adp <= yourPick + adpWindow
                && !shownNames.has(p.name))
              .sort((a, b) => b.predictedVor - a.predictedVor)[0]
          )
        : undefined;
      if (suggestion) shownNames.add(suggestion.name);

      // Alternatives from greedy candidates (empty if actual pick overrode)
      const rawCandidates = isActualPick
        ? (() => {
            const seen2 = new Set<string>();
            const cands: Array<{ pos: string; metric: number }> = [];
            for (const slot of [...remaining, slotFilled]) {
              for (const pos of POSITIONS) {
                if (seen2.has(pos) || pos === chosenPos) continue;
                if (!canFillSlot(slot, pos)) continue;
                const cell = bucket.byPos[pos];
                if (!cell || cell.total < 3) continue;
                seen2.add(pos);
                cands.push({ pos, metric: optimizerMetric === 'vor' ? cell.avgVor : cell.score });
              }
            }
            return cands.sort((a, b) => b.metric - a.metric).slice(0, 3);
          })()
        : (() => {
            const stored = (plan as unknown as { _candidates?: Array<{ pos: string; metric: number }> })._candidates ?? [];
            delete (plan as unknown as { _candidates?: unknown })._candidates;
            return stored.filter((c) => c.pos !== chosenPos).slice(0, 3);
          })();

      plan.push({
        round: r, label, yourPick,
        isBench:      picksUsed >= starterCount,
        recPos:       chosenPos,
        displayPos,
        slotFilled,
        vorScore, hitPct, bustPct, score, n,
        bucketLabel:  bucket.label,
        alternatives: rawCandidates,
        suggestion,
        nearbyPlayers,
        isActualPick,
        actualPlayer,
        actualVsRec:  isActualPick && actualPlayer
          ? Math.round((actualPlayer.predictedVor - vorScore) * 100) / 100
          : undefined,
      });
      picksUsed++;
    }
    return plan;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickNumber, leagueSize, starterSlots, strategyData, optimizerMetric, halfRounds, allPredictions2026, vorNormParams, actualPicks, roundPositions]);

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
        Predicts VOR Score — a standardised (z-score) measure of Value Over Replacement, comparable across all positions (+1.0 = 1 std dev above the positional mean).
        Features from prior-season stats, advanced metrics (WOPR, RACR, aDOT), Next Gen Stats (separation, RYOE, CPOE), combine, draft capital, injuries, and workload.
      </p>

      {/* View toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {([['model', '📊 Model Analysis'], ['strategy', '🏈 Draft Strategy']] as const).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setAdpView(v)}
            style={{
              padding: '6px 16px', borderRadius: 6, fontWeight: 600, fontSize: 13,
              border: `2px solid ${adpView === v ? '#f97316' : 'var(--border)'}`,
              background: adpView === v ? 'rgba(249,115,22,0.12)' : 'var(--bg-secondary)',
              color: adpView === v ? '#f97316' : 'var(--text-secondary)',
              cursor: 'pointer',
            }}
          >
            {label}
          </button>
        ))}
      </div>

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

        <div className="control-group" style={{ marginLeft: 'auto' }}>
          <label className="control-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Scenario
            <button
              onClick={() => setSavedScenarios(loadAllScenarios())}
              title="Reload saved scenarios"
              style={{ fontSize: 11, padding: '1px 6px', cursor: 'pointer', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-secondary)' }}
            >↺</button>
          </label>
          <select
            value={activeScenarioId}
            onChange={(e) => setActiveScenarioId(e.target.value)}
            style={{ minWidth: 160, borderColor: activeScenarioId !== 'none' ? '#f97316' : undefined }}
          >
            <option value="none">None</option>
            {savedScenarios.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Draft Strategy View ── */}
      {adpView === 'strategy' && (() => {
        const isVor = strategyMetric === 'vor';

        // Colour helpers
        const heatColorHitBust = (score: number, total: number): string => {
          if (total < 3) return 'var(--bg-tertiary)';
          const c = Math.max(-0.5, Math.min(0.5, score));
          if (c > 0.05)  return `rgba(16,185,129,${Math.min(0.85, c * 1.8)})`;
          if (c < -0.05) return `rgba(239,68,68,${Math.min(0.85, -c * 1.8)})`;
          return 'rgba(107,114,128,0.15)';
        };
        const heatColorVor = (avgVor: number, total: number): string => {
          if (total < 3) return 'var(--bg-tertiary)';
          // Scale: ±1σ covers the full green/red range
          const c = Math.max(-1, Math.min(1, avgVor));
          if (c > 0.08)  return `rgba(16,185,129,${Math.min(0.85, c * 0.85)})`;
          if (c < -0.08) return `rgba(239,68,68,${Math.min(0.85, -c * 0.85)})`;
          return 'rgba(107,114,128,0.15)';
        };

        // Column-level best round per position (for footer)
        const bestRoundByPos: Record<string, { round: number; val: number }> = {};
        for (const pos of POSITIONS) {
          let best = { round: 0, val: -Infinity };
          for (const row of strategyData) {
            const cell = row.byPos[pos];
            if (!cell || cell.total < 5) continue;
            const val = isVor ? cell.avgVor : cell.score;
            if (val > best.val) best = { round: row.round, val };
          }
          bestRoundByPos[pos] = best;
        }

        return (
          <div>
            {/* Controls row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 12, flexWrap: 'wrap' }}>
              {/* Metric toggle */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Metric</span>
                {([
                  ['hitbust', 'Hit/Bust Rate'],
                  ['vor',     'Avg VOR Score (σ)'],
                ] as const).map(([m, label]) => (
                  <button
                    key={m}
                    onClick={() => setStrategyMetric(m)}
                    style={{
                      padding: '4px 12px', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      border: `2px solid ${strategyMetric === m ? '#6366f1' : 'var(--border)'}`,
                      background: strategyMetric === m ? 'rgba(99,102,241,0.12)' : 'var(--bg-secondary)',
                      color: strategyMetric === m ? '#6366f1' : 'var(--text-secondary)',
                    }}
                  >{label}</button>
                ))}
              </div>
              {/* League size */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>League Size</span>
                {[8, 10, 12, 14].map((n) => (
                  <button
                    key={n}
                    onClick={() => setLeagueSize(n)}
                    style={{
                      padding: '4px 10px', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      border: `2px solid ${leagueSize === n ? '#f97316' : 'var(--border)'}`,
                      background: leagueSize === n ? 'rgba(249,115,22,0.12)' : 'var(--bg-secondary)',
                      color: leagueSize === n ? '#f97316' : 'var(--text-secondary)',
                    }}
                  >{n}</button>
                ))}
              </div>
              {/* Granularity toggle */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Granularity</span>
                {([
                  [false, 'Full rounds'],
                  [true,  'Half rounds'],
                ] as const).map(([val, lbl]) => (
                  <button key={String(val)} onClick={() => setHalfRounds(val)}
                    style={{
                      padding: '4px 10px', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      border: `2px solid ${halfRounds === val ? '#f97316' : 'var(--border)'}`,
                      background: halfRounds === val ? 'rgba(249,115,22,0.12)' : 'var(--bg-secondary)',
                      color: halfRounds === val ? '#f97316' : 'var(--text-secondary)',
                    }}
                  >{lbl}</button>
                ))}
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {allRows.length} historical player-seasons · thresholds calibrated per position (≈33% hit / 33% bust)
              </span>
            </div>

            {/* Legend */}
            <div style={{ display: 'flex', gap: 16, marginBottom: 12, alignItems: 'center', fontSize: 11, color: 'var(--text-muted)' }}>
              {isVor ? (
                <>
                  <span style={{ fontWeight: 700 }}>Cell = Avg VOR Score (σ)</span>
                  <span>🟢 &gt; +0.1σ</span><span>⬜ ≈ 0σ</span><span>🔴 &lt; −0.1σ</span>
                  <span>⭐ Best position in round</span>
                </>
              ) : (
                <>
                  <span style={{ fontWeight: 700 }}>Cell = Hit% − Bust%</span>
                  <span>🟢 &gt; +10%</span><span>⬜ ≈ 0%</span><span>🔴 &lt; −10%</span>
                  <span>⭐ Best position in round</span>
                </>
              )}
            </div>

            {/* Heatmap table */}
            <div className="table-container" style={{ marginBottom: 24 }}>
              <table style={{ tableLayout: 'fixed' }}>
                <thead>
                  <tr>
                    <th style={{ width: 70 }}>Round</th>
                    <th style={{ width: 90, fontSize: 11 }}>Picks</th>
                    {POSITIONS.map((pos) => (
                      <th key={pos} style={{ color: POS_COLORS[pos], textAlign: 'center' }}>{pos}</th>
                    ))}
                    <th style={{ width: 100, fontSize: 11 }}>Best Pick</th>
                  </tr>
                </thead>
                <tbody>
                  {strategyData.map((row) => {
                    const activeBest = isVor ? row.bestPosVor : row.bestPos;
                    return (
                      <tr key={row.label}>
                        <td style={{ fontWeight: 700 }}>{row.label}</td>
                        <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{row.picks}</td>
                        {POSITIONS.map((pos) => {
                          const cell = row.byPos[pos];
                          const total    = cell?.total ?? 0;
                          const score    = cell?.score ?? 0;
                          const avgVor   = cell?.avgVor ?? 0;
                          const medVor   = cell?.medianVor ?? 0;
                          const hitPct   = cell ? Math.round(cell.hitRate * 100) : 0;
                          const bustPct  = cell ? Math.round(cell.bustRate * 100) : 0;
                          const isBest   = activeBest === pos && total >= 5;
                          const bg = isVor
                            ? heatColorVor(avgVor, total)
                            : heatColorHitBust(score, total);
                          const tipText  = total >= 3
                            ? isVor
                              ? `Avg VOR: ${avgVor >= 0 ? '+' : ''}${avgVor}σ · Median: ${medVor >= 0 ? '+' : ''}${medVor}σ · Hit: ${hitPct}% · Bust: ${bustPct}% · n=${total}`
                              : `Hit: ${hitPct}% · Bust: ${bustPct}% · Score: ${score >= 0 ? '+' : ''}${Math.round(score * 100)}% · Avg VOR: ${avgVor >= 0 ? '+' : ''}${avgVor}σ · n=${total}`
                            : `Too few samples (n=${total})`;
                          return (
                            <td
                              key={pos}
                              title={tipText}
                              style={{
                                background: bg,
                                textAlign: 'center',
                                padding: '8px 4px',
                                position: 'relative',
                                cursor: total >= 3 ? 'help' : 'default',
                              }}
                            >
                              {total >= 3 ? (
                                <>
                                  {isBest && <span style={{ position: 'absolute', top: 2, right: 4, fontSize: 10 }}>⭐</span>}
                                  {isVor ? (
                                    <>
                                      <div style={{ fontWeight: 700, fontSize: 14 }}>
                                        {avgVor >= 0 ? '+' : ''}{avgVor}σ
                                      </div>
                                      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', marginTop: 1 }}>
                                        med {medVor >= 0 ? '+' : ''}{medVor}σ
                                      </div>
                                      <div style={{ fontSize: 10, opacity: 0.55 }}>n={total}</div>
                                    </>
                                  ) : (
                                    <>
                                      <div style={{ fontWeight: 700, fontSize: 14 }}>
                                        {score >= 0 ? '+' : ''}{Math.round(score * 100)}%
                                      </div>
                                      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', marginTop: 1 }}>
                                        {hitPct}%↑ {bustPct}%↓
                                      </div>
                                      <div style={{ fontSize: 10, opacity: 0.55 }}>n={total}</div>
                                    </>
                                  )}
                                </>
                              ) : (
                                <span style={{ fontSize: 12, opacity: 0.4 }}>–</span>
                              )}
                            </td>
                          );
                        })}
                        <td style={{ fontWeight: 700, color: activeBest ? POS_COLORS[activeBest] : 'var(--text-muted)', fontSize: 13 }}>
                          {activeBest || '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid var(--border)' }}>
                    <td colSpan={2} style={{ fontWeight: 700, fontSize: 12, color: 'var(--text-muted)' }}>Best Round</td>
                    {POSITIONS.map((pos) => {
                      const best = bestRoundByPos[pos];
                      return (
                        <td key={pos} style={{ textAlign: 'center', fontWeight: 700, fontSize: 12, color: POS_COLORS[pos] }}>
                          {best?.round ? `Rd ${best.round}` : '—'}
                        </td>
                      );
                    })}
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Explanation */}
            <p style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 740 }}>
              {isVor ? (
                <>
                  <strong>Avg VOR Score (σ):</strong> Average standardised Value Over Replacement for players drafted in each round/position.
                  Values are in z-score units (0 = positional average, +1.0 = 1 std dev above) so QBs, RBs, WRs and TEs are directly comparable.
                  Green cells = positions that tend to return above-average value at that pick range; red cells = below average.
                  Median is also shown as a robustness check against outliers.
                </>
              ) : (
                <>
                  <strong>Hit/Bust Rate:</strong> Historical rate of hitting (top-33% VOR for position) minus busting (bottom-33%) per round.
                  Thresholds calibrated per position so each position targets ~33% hits and ~33% busts overall — differences reflect genuine round variation.
                  Hover a cell for the full breakdown. Sample sizes (n) vary; treat low-n cells cautiously.
                </>
              )}
            </p>

            {/* ── Draft Optimizer ── */}
            <div style={{ marginTop: 32, borderTop: '2px solid var(--border)', paddingTop: 24 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
                <h4 style={{ margin: 0, fontSize: 15 }}>🎯 Draft Optimizer</h4>
                {halfRounds && (
                  <span style={{ fontSize: 11, background: 'rgba(249,115,22,0.12)', color: '#f97316',
                    border: '1px solid #f97316', borderRadius: 4, padding: '1px 6px', fontWeight: 600 }}>
                    Using half-round data
                  </span>
                )}
              </div>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, maxWidth: 700 }}>
                Enter your pick number and roster. The optimizer runs a greedy snake-draft algorithm round by round,
                recommending the best-available position for each slot using {halfRounds ? 'half-round' : 'full-round'} historical data.
              </p>

              {/* Optimizer controls */}
              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 16, alignItems: 'flex-start' }}>
                <div className="control-group">
                  <label className="control-label">Your Pick #</label>
                  <select value={pickNumber} onChange={(e) => setPickNumber(Number(e.target.value))} style={{ width: 76 }}>
                    {Array.from({ length: leagueSize }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>Pick {n}</option>
                    ))}
                  </select>
                </div>
                <div className="control-group">
                  <label className="control-label">Optimize by</label>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {([['vor','VOR Score (σ)'],['hitbust','Hit/Bust Rate']] as const).map(([m, lbl]) => (
                      <button key={m} onClick={() => setOptimizerMetric(m)} style={{
                        padding: '4px 10px', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                        border: `2px solid ${optimizerMetric === m ? '#6366f1' : 'var(--border)'}`,
                        background: optimizerMetric === m ? 'rgba(99,102,241,0.12)' : 'var(--bg-secondary)',
                        color: optimizerMetric === m ? '#6366f1' : 'var(--text-secondary)',
                      }}>{lbl}</button>
                    ))}
                  </div>
                </div>
                <div className="control-group">
                  <label className="control-label">Roster Preset</label>
                  <select onChange={(e) => {
                    const p = ROSTER_PRESETS[e.target.value];
                    if (p) { setStarterSlots([...p.starters]); setBenchSlots([...p.bench]); }
                  }} defaultValue="">
                    <option value="" disabled>Select preset…</option>
                    {Object.keys(ROSTER_PRESETS).map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </div>
              </div>

              {/* ── Roster slot editor: Starters + Bench ── */}
              {([
                ['Starters', starterSlots, setStarterSlots] as const,
                ['Bench',    benchSlots,  setBenchSlots]  as const,
              ] as const).map(([section, slots, setSlots]) => (
                <div key={section} style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: section === 'Bench' ? 'var(--text-muted)' : 'var(--text-primary)' }}>
                      {section} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>({slots.length} {slots.length === 1 ? 'slot' : 'slots'})</span>
                    </span>
                    {section === 'Bench' && (
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                        drafted after starters; optimizer picks best available regardless of position
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    {slots.map((slot, i) => (
                      <span key={i} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        background: section === 'Bench' ? 'var(--bg-tertiary)' : 'var(--bg-secondary)',
                        border: `1px solid ${POS_COLORS[slot] || 'var(--border)'}`,
                        borderRadius: 4, padding: '3px 8px', fontSize: 12, fontWeight: 600,
                        color: POS_COLORS[slot] || 'var(--text-secondary)',
                        opacity: section === 'Bench' ? 0.8 : 1,
                      }}>
                        {slot}
                        <button
                          onClick={() => setSlots((prev: string[]) => prev.filter((_, j) => j !== i))}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                            fontSize: 11, color: 'var(--text-muted)', lineHeight: 1 }}>×</button>
                      </span>
                    ))}
                    <select
                      onChange={(e) => { if (e.target.value) { setSlots((prev: string[]) => [...prev, e.target.value]); e.target.value = ''; }}}
                      style={{ fontSize: 12, padding: '3px 6px', borderRadius: 4 }}>
                      <option value="">+ Add</option>
                      {ALL_DRAFT_SLOTS.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
              ))}

              {/* Optimizer results */}
              {optimizerPlan.length > 0 ? (
                <>
                  {/* Expected total points summary (starters only) */}
                  {(() => {
                    const starterRows = optimizerPlan.filter((r) => !r.isBench);
                    const totalEstPPR  = starterRows.reduce((s, r) => s + (r.suggestion?.estPPR ?? 0), 0);
                    const totalVor     = starterRows.reduce((s, r) => s + r.vorScore, 0);
                    return (
                      <div style={{
                        display: 'flex', gap: 20, marginBottom: 16, marginTop: 4,
                        padding: '10px 16px', borderRadius: 8,
                        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                        flexWrap: 'wrap', alignItems: 'center',
                      }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>
                          📊 Starting Lineup Projection
                        </span>
                        <span style={{ fontSize: 13 }}>
                          Est. PPR:{' '}
                          <strong style={{ color: '#10b981', fontSize: 15 }}>{totalEstPPR.toLocaleString()}</strong>
                          <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>pts/season (approx)</span>
                        </span>
                        <span style={{ fontSize: 13 }}>
                          Cumulative VOR:{' '}
                          <strong style={{ color: totalVor >= 0 ? '#10b981' : '#ef4444' }}>
                            {totalVor >= 0 ? '+' : ''}{Math.round(totalVor * 100) / 100}σ
                          </strong>
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {starterRows.length} starter slots · based on top suggestion per round
                        </span>
                      </div>
                    );
                  })()}

                  {/* Round cards */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
                    {optimizerPlan.map((row, idx) => {
                      const isFirstBench = row.isBench && (idx === 0 || !optimizerPlan[idx - 1].isBench);
                      const posColor = POS_COLORS[row.recPos] || '#6b7280';
                      return (
                        <React.Fragment key={row.round}>
                          {isFirstBench && (
                            <div style={{
                              fontSize: 11, fontWeight: 700, color: 'var(--text-muted)',
                              borderTop: '2px dashed var(--border)', paddingTop: 10, marginTop: 4,
                            }}>── BENCH ({benchSlots.length} spots) ──</div>
                          )}
                          <div style={{
                            background: 'var(--bg-secondary)',
                            border: `1px solid ${row.isBench ? 'var(--border)' : posColor + '55'}`,
                            borderLeft: `4px solid ${posColor}`,
                            borderRadius: 8, padding: '10px 14px',
                            opacity: row.isBench ? 0.8 : 1,
                          }}>
                            {/* Round header row */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
                              <span style={{ fontWeight: 700, fontSize: 13, minWidth: 48 }}>
                                {row.label}
                                {halfRounds && row.label !== row.bucketLabel && (
                                  <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 3 }}>({row.bucketLabel})</span>
                                )}
                              </span>
                              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Pick #{row.yourPick}</span>
                              <span style={{
                                fontWeight: 700, fontSize: 12, padding: '2px 8px', borderRadius: 4,
                                background: posColor + '22', color: posColor,
                              }}>{row.recPos}</span>
                              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>→ {row.slotFilled}</span>
                              <span style={{ fontSize: 12, fontWeight: 700, color: (optimizerMetric === 'vor' ? row.vorScore : row.score) >= 0 ? '#10b981' : '#ef4444' }}>
                                {optimizerMetric === 'vor'
                                  ? `${row.vorScore >= 0 ? '+' : ''}${row.vorScore}σ avg`
                                  : `${row.score >= 0 ? '+' : ''}${Math.round(row.score * 100)}% hit-bust`}
                              </span>
                              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                {row.hitPct}%↑ {row.bustPct}%↓
                              </span>
                              {row.alternatives.length > 0 && (
                                <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                                  Alt: {row.alternatives.map((a) => (
                                    <span key={a.pos} style={{ marginRight: 8 }}>
                                      <span style={{ fontWeight: 600, color: POS_COLORS[a.pos] || 'inherit' }}>{a.pos}</span>
                                      {' '}{optimizerMetric === 'vor' ? `${a.metric >= 0 ? '+' : ''}${a.metric}σ` : `${a.metric >= 0 ? '+' : ''}${Math.round(a.metric * 100)}%`}
                                    </span>
                                  ))}
                                </span>
                              )}
                            </div>
                            {/* Suggestion + actual pick row */}
                            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>

                              {/* Position selector + single player card */}
                              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: '1 1 220px', minWidth: 0 }}>
                                {/* Position dropdown */}
                                <select
                                  value={row.displayPos}
                                  onChange={(e) => {
                                    const pos = e.target.value;
                                    setRoundPositions((prev) => ({ ...prev, [row.round]: pos }));
                                  }}
                                  style={{ fontSize: 11, padding: '3px 6px', borderRadius: 4, flexShrink: 0, fontWeight: 700, color: posColor }}
                                >
                                  {POSITIONS.map((pos) => (
                                    <option key={pos} value={pos}>{pos}</option>
                                  ))}
                                </select>

                                {/* Single suggestion card */}
                                {row.suggestion ? (() => {
                                  const p = row.suggestion;
                                  const isActual = row.actualPlayer?.name === p.name;
                                  const cardColor = isActual ? '#6366f1' : POS_COLORS[row.displayPos] || posColor;
                                  return (
                                    <div style={{
                                      display: 'flex', alignItems: 'center', gap: 8,
                                      background: cardColor + '18',
                                      border: `1px solid ${isActual ? '#6366f1' : cardColor + '66'}`,
                                      borderRadius: 8, padding: '6px 10px', flex: '1 1 0', minWidth: 0,
                                      outline: isActual ? '2px solid #6366f1' : undefined,
                                    }}>
                                      {p.headshotUrl ? (
                                        <img src={p.headshotUrl} alt={p.name}
                                          style={{ width: 38, height: 38, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                                      ) : (
                                        <div style={{
                                          width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
                                          background: cardColor + '33', display: 'flex', alignItems: 'center',
                                          justifyContent: 'center', fontSize: 13, fontWeight: 700, color: cardColor,
                                        }}>{p.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}</div>
                                      )}
                                      <div style={{ minWidth: 0 }}>
                                        <div style={{ fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                          {isActual && <span style={{ fontSize: 10, marginRight: 3 }}>✓</span>}
                                          {p.name}
                                        </div>
                                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{p.team} · ADP {p.adp.toFixed(1)}</div>
                                        <div style={{ display: 'flex', gap: 5, marginTop: 2, alignItems: 'center' }}>
                                          <span style={{ fontSize: 10, fontWeight: 700, color: p.predictedVor >= 0 ? '#10b981' : '#ef4444' }}>
                                            {p.predictedVor >= 0 ? '+' : ''}{p.predictedVor}σ
                                          </span>
                                          {p.estPPR > 0 && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>~{p.estPPR} PPR</span>}
                                          <span style={{
                                            fontSize: 9, fontWeight: 700, padding: '1px 4px', borderRadius: 3,
                                            background: p.hitProb === 'Likely Hit' ? 'rgba(16,185,129,0.15)' : p.hitProb === 'Likely Bust' ? 'rgba(239,68,68,0.15)' : 'rgba(107,114,128,0.1)',
                                            color: p.hitProb === 'Likely Hit' ? '#10b981' : p.hitProb === 'Likely Bust' ? '#ef4444' : '#6b7280',
                                          }}>{p.hitProb === 'Likely Hit' ? 'HIT' : p.hitProb === 'Likely Bust' ? 'BUST' : '~'}</span>
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })() : (
                                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>No player available</div>
                                )}
                              </div>

                              {/* Actual pick selector */}
                              <div style={{
                                background: row.isActualPick ? 'rgba(99,102,241,0.08)' : 'var(--bg-tertiary)',
                                border: `1px solid ${row.isActualPick ? '#6366f155' : 'var(--border)'}`,
                                borderRadius: 8, padding: '8px 12px', minWidth: 200, flexShrink: 0,
                              }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>
                                  Actual Pick
                                </div>
                                <select
                                  value={actualPicks[row.round]?.name ?? ''}
                                  onChange={(e) => {
                                    const name = e.target.value;
                                    if (!name) {
                                      setActualPicks((prev) => { const n = { ...prev }; delete n[row.round]; return n; });
                                    } else {
                                      const found = row.nearbyPlayers.find((p) => p.name === name);
                                      if (found) setActualPicks((prev) => ({
                                        ...prev,
                                        [row.round]: { name: found.name, position: allPredictions2026.find((p) => p.name === name)?.position ?? row.recPos },
                                      }));
                                    }
                                  }}
                                  style={{ width: '100%', fontSize: 12, padding: '4px 6px', borderRadius: 4, marginBottom: 6 }}
                                >
                                  <option value="">— Not yet —</option>
                                  {row.nearbyPlayers.map((p) => {
                                    const pPos = allPredictions2026.find((x) => x.name === p.name)?.position ?? '';
                                    return (
                                      <option key={p.name} value={p.name}>
                                        [{pPos}] {p.name} ({p.team}, ADP {p.adp.toFixed(1)})
                                      </option>
                                    );
                                  })}
                                </select>
                                {row.actualPlayer && (() => {
                                  const ap = row.actualPlayer;
                                  const apColor = POS_COLORS[allPredictions2026.find((p) => p.name === ap.name)?.position ?? ''] || '#6366f1';
                                  const diff = row.actualVsRec ?? 0;
                                  return (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                      {ap.headshotUrl ? (
                                        <img src={ap.headshotUrl} alt={ap.name}
                                          style={{ width: 34, height: 34, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                                      ) : (
                                        <div style={{ width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
                                          background: apColor + '33', display: 'flex', alignItems: 'center',
                                          justifyContent: 'center', fontSize: 11, fontWeight: 700, color: apColor,
                                        }}>{ap.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}</div>
                                      )}
                                      <div style={{ minWidth: 0 }}>
                                        <div style={{ fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ap.name}</div>
                                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{ap.team} · {ap.predictedVor >= 0 ? '+' : ''}{ap.predictedVor}σ</div>
                                        <div style={{ fontSize: 10, fontWeight: 700, color: diff >= 0 ? '#10b981' : '#ef4444' }}>
                                          {diff >= 0 ? `✓ +${diff}σ vs rec` : `✗ ${diff}σ vs rec`}
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })()}
                              </div>

                            </div>
                          </div>
                        </React.Fragment>
                      );
                    })}
                  </div>

                  <p style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 720 }}>
                    Greedy snake-draft algorithm using{' '}
                    {optimizerMetric === 'vor' ? 'avg VOR (σ)' : 'hit/bust rate'} from{' '}
                    {halfRounds ? 'half-round' : 'full-round'} historical buckets. ⭐ = top suggestion per round.
                    Est. PPR = replacement level + historical mean VOR + predicted VOR in raw pts (approximation).
                    Based on {allRows.length} historical player-seasons.
                  </p>
                </>
              ) : (
                <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>
                  Add starter or bench slots above to generate a draft plan.
                </p>
              )}
            </div>
          </div>
        );
      })()}

      {/* Model content */}
      {adpView === 'model' && <>

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
              {(() => {
                const cvR2Val  = modelType === 'gbm' ? m.cvR2Gbm   : m.cvR2Ridge;
                const cvMaeVal = modelType === 'gbm' ? m.cvMaeGbm  : m.cvMaeRidge;
                const baseCV   = m.cvR2GbmBaseline;
                const gain     = cvR2Val - baseCV;
                return (
                  <>
                    <div>
                      CV R² = <strong style={{ color: cvR2Val > 0.15 ? '#10b981' : cvR2Val > 0 ? '#f59e0b' : '#ef4444' }}>
                        {cvR2Val.toFixed(3)}
                      </strong>
                      {modelType === 'gbm' && (
                        <span style={{ marginLeft: 6, fontSize: 10, color: gain > 0.02 ? '#10b981' : gain > 0 ? '#f59e0b' : 'var(--text-muted)' }}>
                          {gain >= 0 ? '+' : ''}{gain.toFixed(3)} proj
                        </span>
                      )}
                    </div>
                    <div>CV MAE = <strong style={{ color: 'var(--text-primary)' }}>{cvMaeVal.toFixed(2)}σ</strong></div>
                    {(() => {
                      const t = posThresholds.get(m.position);
                      const posR = allRows.filter((r) => r.position === m.position);
                      const hits  = t ? posR.filter((r) => isHitForPos(m.position,  r.vor)).length : 0;
                      const busts = t ? posR.filter((r) => isBustForPos(m.position, r.vor)).length : 0;
                      const n = posR.length || 1;
                      return (
                        <div title={t ? `Hit threshold: ≥${t.hit.toFixed(2)}σ · Bust threshold: <${t.bust.toFixed(2)}σ` : ''}>
                          N = {m.n} · Hits {Math.round(hits/n*100)}% · Busts {Math.round(busts/n*100)}%
                          {t && <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>
                            (≥{t.hit.toFixed(1)} / &lt;{t.bust.toFixed(1)})
                          </span>}
                        </div>
                      );
                    })()}
                  </>
                );
              })()}
            </div>
          </div>
        ))}
      </div>

      {/* Projection accuracy comparison banner (CV-based) */}
      {currentModel && (() => {
        const r2   = currentModel.cvR2Gbm;
        const base = currentModel.cvR2GbmBaseline;
        const gain = r2 - base;
        const pct  = base !== 0 ? (gain / Math.abs(base)) * 100 : 0;
        return (
          <div style={{
            background: 'var(--bg-secondary)', border: `1px solid ${gain > 0.02 ? '#f97316' : 'var(--border)'}`,
            borderRadius: 8, padding: '10px 16px', marginBottom: 16,
            display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap',
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#f97316' }}>
              📐 Projection Features Impact ({selectedPos})
              <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6 }}>LOSO CV</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Baseline CV R² (no projections): <strong>{base.toFixed(3)}</strong>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              With projections: <strong>{r2.toFixed(3)}</strong>
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: gain > 0.02 ? '#10b981' : gain > 0 ? '#f59e0b' : '#ef4444' }}>
              {gain >= 0 ? '+' : ''}{gain.toFixed(3)} CV R² ({pct >= 0 ? '+' : ''}{pct.toFixed(1)}%
              {gain > 0.02 ? ' ✓ meaningful gain' : gain > 0 ? ' marginal gain' : ' no gain'})
            </div>
          </div>
        );
      })()}

      {/* ── 2026 Predictions ── */}
      {currentModel && predictions2026.length > 0 && (
        <>
          <h4 style={{ marginBottom: 4, marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: '#f59e0b', fontSize: 18 }}>{PREDICT_SEASON}</span>{' '}
            {selectedPos} Predictions
            <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>
              Model-predicted VOR Score (σ from positional mean) &middot; {predictions2026.length} players
            </span>
            {activeScenario && (
              <span style={{
                fontSize: 11, fontWeight: 700, background: '#f97316', color: '#fff',
                borderRadius: 4, padding: '2px 7px', marginLeft: 4,
              }}>⚙ {activeScenario.name}</span>
            )}
          </h4>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>
            Trained on {SEASONS[0]}–{SEASONS[SEASONS.length - 1]} outcomes, applied to {PREDICT_SEASON} preseason ADP + {PREDICT_SEASON - 1} stats. VOR Score is standardised per position: 0 = positional average, +1.0 = 1 std dev above.
          </p>
          {vorNormParams.size > 0 && (
            <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
              {POSITIONS.map((pos) => {
                const np = vorNormParams.get(pos);
                if (!np) return null;
                const repRank = REPLACEMENT_RANKS[pos];
                return (
                  <div key={pos} style={{
                    background: 'var(--bg-secondary)', border: `1px solid ${POS_COLORS[pos]}44`,
                    borderRadius: 6, padding: '5px 10px', fontSize: 11,
                  }}>
                    <span style={{ fontWeight: 700, color: POS_COLORS[pos] }}>{pos}</span>
                    <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>
                      avg VOR <strong style={{ color: 'var(--text-primary)' }}>{np.mean >= 0 ? '+' : ''}{Math.round(np.mean)} pts</strong>
                      {' · '}σ = <strong style={{ color: 'var(--text-primary)' }}>{Math.round(np.std)} pts</strong>
                      {' · '}baseline = {repRank}th {pos}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="table-container" style={{ marginBottom: 20, maxHeight: 500, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>Team</th>
                  <th>ADP</th>
                  <th>Predicted VOR (σ)</th>
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
                      color: p.predictedVor >= 0 ? '#10b981' : '#ef4444',
                    }}>
                      {p.predictedVor >= 0 ? '+' : ''}{p.predictedVor}σ
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
                  Predicted: <span style={{ color: selected2026Prediction.predictedVor >= 0 ? '#10b981' : '#ef4444' }}>
                    {selected2026Prediction.predictedVor >= 0 ? '+' : ''}{selected2026Prediction.predictedVor}σ
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
            <h4 style={{ margin: 0 }}>Hit/Bust Distribution</h4>
            <div style={{ display: 'flex', gap: 4 }}>
              {(['ALL', ...POSITIONS] as string[]).map((pos) => (
                <button
                  key={pos}
                  className={`pos-filter ${hitBustPos === pos ? 'active' : ''}`}
                  onClick={() => setHitBustPos(pos)}
                  style={{ fontSize: 11, padding: '3px 8px', borderColor: pos !== 'ALL' ? POS_COLORS[pos] : undefined }}
                >
                  {pos}
                </button>
              ))}
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {hitBustPos === 'ALL'
                ? `Colors = position · ${scatterData.length} player-seasons · thresholds calibrated per position`
                : (() => {
                    const t = posThresholds.get(hitBustPos);
                    return `Green = hit (delta ≥ ${t ? t.hit.toFixed(0) : '−12'}) · Red = bust (< ${t ? t.bust.toFixed(0) : '−24'}) · ${scatterData.length} player-seasons`;
                  })()
              }
            </span>
          </div>
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
                <YAxis type="number" dataKey="vor"
                  tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}>
                  <Label value="VOR Score (σ, pos-adjusted)" angle={-90} position="insideLeft" offset={10}
                    style={{ fill: 'var(--text-secondary)', fontSize: 13 }} />
                </YAxis>
                <ReferenceLine y={0} stroke="var(--text-muted)" strokeDasharray="5 5" />
                <ReferenceLine y={1} stroke="#10b981" strokeDasharray="3 3" opacity={0.4} />
                <ReferenceLine y={-1} stroke="#ef4444" strokeDasharray="3 3" opacity={0.4} />
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
                        <strong>{d.name}</strong> ({d.season}){d.position ? ` · ${d.position}` : ''}
                        <br />ADP: {d.adp.toFixed(1)}
                        <br />VOR Score: <span style={{ color: d.vor >= 0 ? '#10b981' : '#ef4444' }}>
                          {d.vor >= 0 ? '+' : ''}{d.vor}σ
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
                  <th>Predicted VOR (σ)</th>
                  <th>Actual VOR (σ)</th>
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
                      color: p.predictedVor >= 0 ? '#10b981' : '#ef4444',
                    }}>
                      {p.predictedVor >= 0 ? '+' : ''}{p.predictedVor}σ
                    </td>
                    <td style={{
                      fontWeight: 700,
                      color: p.actualVor >= 0 ? '#10b981' : '#ef4444',
                    }}>
                      {p.actualVor >= 0 ? '+' : ''}{p.actualVor}σ
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
                  Predicted: <span style={{ color: selectedPrediction.predictedVor >= 0 ? '#10b981' : '#ef4444' }}>
                    {selectedPrediction.predictedVor >= 0 ? '+' : ''}{selectedPrediction.predictedVor}σ
                  </span> &middot;
                  Actual: <span style={{ color: selectedPrediction.actualVor >= 0 ? '#10b981' : '#ef4444' }}>
                    {selectedPrediction.actualVor >= 0 ? '+' : ''}{selectedPrediction.actualVor}σ
                  </span>
                </span>
              </h4>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                Top factors driving this prediction (contribution to predicted VOR Score):
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

      </>} {/* end adpView === 'model' */}
    </>
  );
}
