// Shared types, constants, and helpers for the feature engineering pipeline.
// Used by both the browser component (ADPFactorAnalysis) and the
// build-time precomputation script (scripts/precompute-features.ts).

import type { ScenarioConfig } from '../types';

// ── Types ──

export interface FeatureDef {
  key: string;
  label: string;
  category: string;
  positions: string[];
}

export interface PlayerRow {
  name: string;
  position: string;
  season: number;
  adp: number;
  vor: number;        // VOR (z-scored after all seasons built)
  rawPPG: number;     // raw fantasy PPG (never z-scored, for PPG model)
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

export interface FeatureMatrixConfig {
  seasons: number[];
  predictSeason: number;
  positions: string[];
  replacementRanks: Record<string, number>;
  vorBasis: 'total' | 'ppg';
  scenario?: ScenarioConfig;
  onStatus?: (msg: string) => void;
}

export interface FeatureMatrixResult {
  rows: PlayerRow[];
  predRows: PredictionRow[];
  vorNorm: Record<string, { mean: number; std: number }>;
}

// ── Constants ──

export const SEASONS = [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
export const PREDICT_SEASON = 2026;
export const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
export const REPLACEMENT_RANKS: Record<string, number> = { QB: 12, RB: 24, WR: 24, TE: 12 };

export const POS_COLORS: Record<string, string> = {
  QB: '#6366f1', RB: '#10b981', WR: '#f59e0b', TE: '#ef4444',
};

// Expected PPG at replacement level (used to convert VOR z-scores back to season PPR)
// estPPR ≈ (REP_PPG + vorZ * std) * 17
export const REP_PPG: Record<string, number> = { QB: 16.8, RB: 6.8, WR: 6.8, TE: 5.3 };
// Legacy alias for backward compat
export const REP_PPR: Record<string, number> = { QB: 285, RB: 115, WR: 115, TE: 90 };

export const CATEGORY_COLORS: Record<string, string> = {
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
  Sentiment: '#e879f9',
  SOS: '#f472b6',
  Scheme: '#38bdf8',
  College: '#a78bfa',
  Contract: '#34d399',
  Aging: '#fbbf24',
  Momentum: '#fb923c',
  Interaction: '#94a3b8',
  'QB Impact': '#818cf8',
  Consistency: '#c084fc',
  Environment: '#67e8f9',
};

export const FEATURES: FeatureDef[] = [
  { key: 'adp', label: 'ADP', category: 'Draft', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'adpRound', label: 'ADP Round', category: 'Draft', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'age', label: 'Age', category: 'Profile', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'yearsInLeague', label: 'Years in League', category: 'Profile', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'nflDraftRound', label: 'NFL Draft Round', category: 'Profile', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'nflDraftPick', label: 'NFL Draft Pick', category: 'Profile', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'logDraftPick', label: 'Log(Draft Pick)', category: 'Profile', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'invDraftPick', label: '1/Draft Pick (capital)', category: 'Profile', positions: ['QB', 'RB', 'WR', 'TE'] },
  // Draft pick percentile within (season, position). 0 = top pick at position,
  // 1 = latest. Normalizes across draft years so "pick 100" is comparable.
  { key: 'draftPickPct', label: 'Draft Pick Pctile (position)', category: 'Profile', positions: ['QB', 'RB', 'WR', 'TE'] },
  // Draft pick percentile within the whole draft class that season. 0 =
  // top overall, 1 = last overall. Catches cross-position context a
  // within-position percentile misses.
  { key: 'draftPickPctOverall', label: 'Draft Pick Pctile (overall)', category: 'Profile', positions: ['QB', 'RB', 'WR', 'TE'] },
  // Count of drafted players at (season, position). "How deep was this
  // class at my position?" — shallow classes mean less competition for
  // opportunity; deep classes mean the player had to beat out more peers.
  { key: 'draftClassDepth', label: 'Draft Class Depth (position)', category: 'Profile', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'draftPickXEarlyDeclare', label: 'Draft Capital × Early Declare', category: 'Profile', positions: ['RB', 'WR', 'TE'] },
  { key: 'weight', label: 'Weight', category: 'Physical', positions: ['RB', 'WR', 'TE'] },
  { key: 'forty', label: '40-Yard Dash', category: 'Physical', positions: ['RB', 'WR', 'TE'] },
  { key: 'bench', label: 'Bench Press Reps', category: 'Physical', positions: ['RB', 'WR', 'TE'] },
  { key: 'vertical', label: 'Vertical Jump', category: 'Physical', positions: ['RB', 'WR', 'TE'] },
  { key: 'broadJump', label: 'Broad Jump', category: 'Physical', positions: ['RB', 'WR', 'TE'] },
  { key: 'cone', label: '3-Cone Drill', category: 'Physical', positions: ['RB', 'WR', 'TE'] },
  { key: 'shuttle', label: '20-Yard Shuttle', category: 'Physical', positions: ['RB', 'WR', 'TE'] },
  { key: 'bmi', label: 'BMI', category: 'Physical', positions: ['RB', 'WR', 'TE'] },
  { key: 'priorPassYards', label: 'Prior Pass Yards', category: 'Prior Stats', positions: ['QB'] },
  { key: 'priorPassTDs', label: 'Prior Pass TDs', category: 'Prior Stats', positions: ['QB'] },
  { key: 'priorINTs', label: 'Prior INTs', category: 'Prior Stats', positions: ['QB'] },
  { key: 'priorPassYPA', label: 'Prior Yards/Attempt', category: 'Prior Stats', positions: ['QB'] },
  { key: 'priorQBRating', label: 'Prior Passer Rating', category: 'Prior Stats', positions: ['QB'] },
  { key: 'priorRushYards', label: 'Prior Rush Yards', category: 'Prior Stats', positions: ['QB', 'RB'] },
  { key: 'priorRushTDs', label: 'Prior Rush TDs', category: 'Prior Stats', positions: ['QB', 'RB'] },
  { key: 'priorYPC', label: 'Prior Yards/Carry', category: 'Prior Stats', positions: ['RB'] },
  { key: 'priorCarries', label: 'Prior Carries', category: 'Prior Stats', positions: ['RB'] },
  { key: 'priorTargets', label: 'Prior Targets', category: 'Prior Stats', positions: ['RB', 'WR', 'TE'] },
  { key: 'priorReceptions', label: 'Prior Receptions', category: 'Prior Stats', positions: ['RB', 'WR', 'TE'] },
  { key: 'priorRecYards', label: 'Prior Rec Yards', category: 'Prior Stats', positions: ['RB', 'WR', 'TE'] },
  { key: 'priorRecTDs', label: 'Prior Rec TDs', category: 'Prior Stats', positions: ['WR', 'TE'] },
  { key: 'priorYPR', label: 'Prior Yards/Reception', category: 'Prior Stats', positions: ['WR', 'TE'] },
  { key: 'priorTargetShare', label: 'Prior Target Share', category: 'Advanced', positions: ['RB', 'WR', 'TE'] },
  { key: 'priorAirYardsShare', label: 'Prior Air Yards Share', category: 'Advanced', positions: ['WR', 'TE'] },
  { key: 'priorWOPR', label: 'Prior WOPR', category: 'Advanced', positions: ['WR', 'TE'] },
  { key: 'priorRACR', label: 'Prior RACR', category: 'Advanced', positions: ['WR', 'TE'] },
  { key: 'priorYACperRec', label: 'Prior YAC/Reception', category: 'Advanced', positions: ['RB', 'WR', 'TE'] },
  { key: 'priorAirYardsPerTarget', label: 'Prior Air Yards/Target', category: 'Advanced', positions: ['WR', 'TE'] },
  { key: 'priorRecEPA', label: 'Prior Receiving EPA', category: 'Advanced', positions: ['RB', 'WR', 'TE'] },
  { key: 'priorRushEPA', label: 'Prior Rushing EPA', category: 'Advanced', positions: ['QB', 'RB'] },
  { key: 'priorADOT', label: 'Prior aDOT', category: 'Advanced', positions: ['WR', 'TE'] },
  { key: 'priorDeepTargetPct', label: 'Prior Deep Target %', category: 'Advanced', positions: ['WR', 'TE'] },
  { key: 'priorRZTargetShare', label: 'Prior RZ Target Share', category: 'Advanced', positions: ['RB', 'WR', 'TE'] },
  { key: 'priorSeparation', label: 'Prior Avg Separation', category: 'NGS', positions: ['WR', 'TE'] },
  { key: 'priorCushion', label: 'Prior Avg Cushion', category: 'NGS', positions: ['WR', 'TE'] },
  { key: 'priorYACAboveExp', label: 'Prior YAC Above Expected', category: 'NGS', positions: ['WR', 'TE'] },
  { key: 'priorCatchPct', label: 'Prior Catch %', category: 'NGS', positions: ['WR', 'TE'] },
  { key: 'priorIntendedAirYardShare', label: 'Prior Intended Air Yard Share', category: 'NGS', positions: ['WR', 'TE'] },
  { key: 'priorRYOEperAtt', label: 'Prior RYOE/Attempt', category: 'NGS', positions: ['RB'] },
  { key: 'priorRushEfficiency', label: 'Prior Rush Efficiency', category: 'NGS', positions: ['RB'] },
  { key: 'priorPctVs8Defenders', label: 'Prior % vs 8+ Box', category: 'NGS', positions: ['RB'] },
  { key: 'priorCPOE', label: 'Prior CPOE', category: 'NGS', positions: ['QB'] },
  { key: 'priorTimeToThrow', label: 'Prior Time to Throw', category: 'NGS', positions: ['QB'] },
  { key: 'priorAggressiveness', label: 'Prior Aggressiveness', category: 'NGS', positions: ['QB'] },
  { key: 'priorYPRR', label: 'Prior YPRR', category: 'Route', positions: ['WR', 'TE'] },
  { key: 'priorRoutesRun', label: 'Prior Routes Run', category: 'Route', positions: ['WR', 'TE'] },
  { key: 'priorTargetsPerRoute', label: 'Prior Targets/Route', category: 'Route', positions: ['WR', 'TE'] },
  { key: 'priorPct11Personnel', label: 'Prior % 11 Personnel', category: 'Route', positions: ['RB', 'WR', 'TE'] },
  { key: 'priorPct12Personnel', label: 'Prior % 12 Personnel', category: 'Route', positions: ['RB', 'WR', 'TE'] },
  { key: 'priorPassLocationLeft', label: 'Prior % Targets Left', category: 'Route', positions: ['WR', 'TE'] },
  { key: 'priorPassLocationMiddle', label: 'Prior % Targets Middle', category: 'Route', positions: ['WR', 'TE'] },
  { key: 'priorPPR', label: 'Prior PPR Points', category: 'Prior Fantasy', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'priorPPG', label: 'Prior PPG', category: 'Prior Fantasy', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'priorGames', label: 'Prior Games Played', category: 'Prior Fantasy', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'priorGamesMissed', label: 'Prior Games Missed', category: 'Prior Fantasy', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'priorTotalTouches', label: 'Prior Total Touches', category: 'Workload', positions: ['RB'] },
  { key: 'priorSnapPct', label: 'Prior Snap %', category: 'Workload', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'priorInjuryWeeks', label: 'Prior Injury Report Weeks', category: 'Injury', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'priorGamesOut', label: 'Prior Games Out/Doubtful', category: 'Injury', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'preseasonInjured', label: 'Preseason Injured', category: 'Injury', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'preseasonInjWeeks', label: 'Preseason Injury Weeks', category: 'Injury', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'priorSoftTissue', label: 'Prior Soft Tissue Injury', category: 'Injury', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'priorKneeInjury', label: 'Prior Knee Injury', category: 'Injury', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'teamSamePosCount', label: 'Same-Pos Teammates', category: 'Competition', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'depthChartRank', label: 'Depth Chart Rank', category: 'Competition', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'priorTeamTouchShare', label: 'Prior Team Touch Share', category: 'Competition', positions: ['RB', 'WR', 'TE'] },
  { key: 'priorTeamTargetShare', label: 'Prior Team Target Share', category: 'Competition', positions: ['RB', 'WR', 'TE'] },
  { key: 'newSamePosAdded', label: 'New Same-Pos Arrivals', category: 'Competition', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'teamDraftedSamePos', label: 'Team Drafted Same Pos', category: 'Competition', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'draftCapitalSamePos', label: 'Draft Capital at Pos', category: 'Competition', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'teammatePriorPPR', label: 'Best Teammate PPR', category: 'Competition', positions: ['RB', 'WR', 'TE'] },
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
  { key: 'newHeadCoach', label: 'New Head Coach', category: 'Coaching', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'coachPriorTeamPPR', label: 'Coach Prior Team PPR', category: 'Coaching', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'teamPassRate', label: 'Team Pass Rate', category: 'Coaching', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'teamNeutralPassRate', label: 'Team Neutral Pass Rate', category: 'Coaching', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'teamPace', label: 'Team Pace (Plays/Game)', category: 'Coaching', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'teamFirstDownRunRate', label: 'Team 1st Down Run Rate', category: 'Coaching', positions: ['RB', 'WR', 'TE'] },
  { key: 'teamShotgunRate', label: 'Team Shotgun Rate', category: 'Coaching', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'teamNoHuddleRate', label: 'Team No-Huddle Rate', category: 'Coaching', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'teamRBTargetRate', label: 'Team RB Target Rate', category: 'Coaching', positions: ['RB', 'WR', 'TE'] },
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
  { key: 'vegasImpliedTotal', label: 'Vegas Implied Team Total', category: 'Vegas', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'vegasImpliedSpread', label: 'Vegas Avg Spread', category: 'Vegas', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'vegasGameTotal', label: 'Vegas Avg Game Total', category: 'Vegas', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'vegasWinPct', label: 'Vegas Implied Win %', category: 'Vegas', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'vegasActualPtsPerGame', label: 'Prior Actual Pts/Game', category: 'Vegas', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'projTeamPassAtt', label: 'Proj Team Pass Att', category: 'Projection', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'projTeamPassVolChg', label: 'Proj Team Pass Vol Chg', category: 'Projection', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'projPlayerPPR', label: 'Proj Player PPR', category: 'Projection', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'projPlayerVsExpected', label: 'Proj Player vs Expected', category: 'Projection', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'projTargetShare', label: 'Proj Target Share', category: 'Projection', positions: ['RB', 'WR', 'TE'] },
  // ML-enhanced volume projections (from two-stage model)
  { key: 'mlProjTeamPassAtt', label: 'ML Proj Team Pass Att', category: 'Projection', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'mlProjTeamRushAtt', label: 'ML Proj Team Rush Att', category: 'Projection', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'mlProjTeamTargets', label: 'ML Proj Team Targets', category: 'Projection', positions: ['RB', 'WR', 'TE'] },
  { key: 'mlProjPlayerPPG', label: 'ML Proj Player PPG', category: 'Projection', positions: ['QB', 'RB', 'WR', 'TE'] },
  // Actual share targets (training data — predicted for 2026)
  { key: 'actualTargetShare', label: 'Actual Target Share', category: 'Share', positions: ['RB', 'WR', 'TE'] },
  { key: 'actualRushShare', label: 'Actual Rush Share', category: 'Share', positions: ['RB'] },
  { key: 'actualReceptionShare', label: 'Actual Reception Share', category: 'Share', positions: ['RB', 'WR', 'TE'] },
  { key: 'actualRecYdsShare', label: 'Actual Rec Yds Share', category: 'Share', positions: ['RB', 'WR', 'TE'] },
  { key: 'actualRushYdsShare', label: 'Actual Rush Yds Share', category: 'Share', positions: ['RB'] },
  { key: 'actualPassTDShare', label: 'Actual Pass TD Share', category: 'Share', positions: ['RB', 'WR', 'TE'] },
  { key: 'actualRushTDShare', label: 'Actual Rush TD Share', category: 'Share', positions: ['RB'] },
  // ML predicted shares (for 2026 projections)
  { key: 'predTargetShare', label: 'Pred Target Share', category: 'Share', positions: ['RB', 'WR', 'TE'] },
  { key: 'predRushShare', label: 'Pred Rush Share', category: 'Share', positions: ['RB'] },
  { key: 'predReceptionShare', label: 'Pred Reception Share', category: 'Share', positions: ['RB', 'WR', 'TE'] },
  { key: 'predRecYdsShare', label: 'Pred Rec Yds Share', category: 'Share', positions: ['RB', 'WR', 'TE'] },
  { key: 'predRushYdsShare', label: 'Pred Rush Yds Share', category: 'Share', positions: ['RB'] },
  { key: 'predPassTDShare', label: 'Pred Pass TD Share', category: 'Share', positions: ['RB', 'WR', 'TE'] },
  { key: 'predRushTDShare', label: 'Pred Rush TD Share', category: 'Share', positions: ['RB'] },

  // Reddit sentiment features (from r/fantasyfootball)
  { key: 'redditMentions1w', label: 'Reddit Mentions (1wk)', category: 'Sentiment', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'redditSentiment1w', label: 'Reddit Sentiment (1wk)', category: 'Sentiment', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'redditHype1w', label: 'Reddit Hype (1wk)', category: 'Sentiment', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'redditMentions4w', label: 'Reddit Mentions (4wk)', category: 'Sentiment', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'redditSentiment4w', label: 'Reddit Sentiment (4wk)', category: 'Sentiment', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'redditMentionVelocity', label: 'Reddit Mention Velocity', category: 'Sentiment', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'redditSentimentVelocity', label: 'Reddit Sentiment Velocity', category: 'Sentiment', positions: ['QB', 'RB', 'WR', 'TE'] },

  // Strength of Schedule
  { key: 'sosDefPassYdg', label: 'SOS: Opp Pass Yd/Game', category: 'SOS', positions: ['QB', 'WR', 'TE'] },
  { key: 'sosDefRushYdg', label: 'SOS: Opp Rush Yd/Game', category: 'SOS', positions: ['RB'] },
  { key: 'sosDefPPG', label: 'SOS: Opp Fantasy Pts Allowed/Game', category: 'SOS', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'sosAvgSpread', label: 'SOS: Avg Expected Spread', category: 'SOS', positions: ['QB', 'RB', 'WR', 'TE'] },

  // Coaching scheme clusters (derived from PBP tendencies)
  { key: 'schemePassHeavy', label: 'Scheme: Pass-Heavy (>58%)', category: 'Scheme', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'schemeRunHeavy', label: 'Scheme: Run-Heavy (<48%)', category: 'Scheme', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'schemeUptempo', label: 'Scheme: Uptempo (>67 plays/g)', category: 'Scheme', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'schemeShotgunHeavy', label: 'Scheme: Shotgun-Heavy (>70%)', category: 'Scheme', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'schemeRBReceiving', label: 'Scheme: RB Pass-Catching (>18% tgt)', category: 'Scheme', positions: ['RB', 'WR', 'TE'] },
  { key: 'schemeTEHeavy', label: 'Scheme: TE-Heavy (>22% tgt)', category: 'Scheme', positions: ['TE', 'WR'] },

  // Vegas season-level props
  { key: 'vegasSeasonWinTotal', label: 'Vegas Season Win Total', category: 'Vegas', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'vegasSeasonOverUnder', label: 'Vegas Season O/U (avg)', category: 'Vegas', positions: ['QB', 'RB', 'WR', 'TE'] },

  // College production (rookie prediction)
  { key: 'collegePassYds', label: 'College Pass Yards (final yr)', category: 'College', positions: ['QB'] },
  { key: 'collegePassTDs', label: 'College Pass TDs (final yr)', category: 'College', positions: ['QB'] },
  { key: 'collegeRushYds', label: 'College Rush Yards (final yr)', category: 'College', positions: ['QB', 'RB'] },
  { key: 'collegeRecYds', label: 'College Rec Yards (final yr)', category: 'College', positions: ['RB', 'WR', 'TE'] },
  { key: 'collegeRecTDs', label: 'College Rec TDs (final yr)', category: 'College', positions: ['RB', 'WR', 'TE'] },
  { key: 'collegeTotalTDs', label: 'College Total TDs (final yr)', category: 'College', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'collegeQBR', label: 'College QBR (final yr)', category: 'College', positions: ['QB'] },
  // Last-2-year average QBR — smoother signal than single-year for QBs.
  { key: 'collegeQBR2yr', label: 'College QBR (2yr avg)', category: 'College', positions: ['QB'] },
  // Career rushing yards / game divided by draft age — captures dual-threat
  // upside while penalising older "running QB" prospects.
  { key: 'collegeRushYpgPerAge', label: 'Rush Yds/Game / Age', category: 'College', positions: ['QB'] },
  // Career yards per pass attempt — proxy for aDOT (no college air-yards data).
  { key: 'collegeYdsPerPassAtt', label: 'Yards / Pass Attempt (career)', category: 'College', positions: ['QB'] },
  // TeamRankings predictive rating × career pass attempts — volume thrown
  // for a competitive program. Uses NCAA predictive rankings as the team-
  // competitiveness measure (kept the legacy `Sos` key name to avoid a
  // cache version churn).
  { key: 'collegeSosXPassAtt', label: 'Team Rating × Pass Attempts', category: 'College', positions: ['QB'] },
  // Final-year strength of schedule on its own (raw multiplier, ~0.65-1.35).
  // Distinct from team rating: SOS measures opponent quality, team rating
  // measures the player's own program. Both matter independently.
  { key: 'collegeSosFinalYr', label: 'SOS (final year)', category: 'College', positions: ['QB', 'RB', 'WR', 'TE'] },
  // QB-only composite: career production × team competitiveness × SOS.
  // Talented passers who rose to the top of good programs and produced
  // against tough opponents — strongest signal of NFL-readiness.
  { key: 'collegeQbContextScore', label: 'Production × Team × SOS', category: 'College', positions: ['QB'] },
  // Pass-heaviness ratio. Lower means more rushing leverage, higher =
  // pure pocket passer.
  { key: 'collegePassAttPerRushYd', label: 'Pass Att / Rush Yds', category: 'College', positions: ['QB'] },
  // Career completion percentage (0-1 range).
  { key: 'collegeCompletionPct', label: 'Completion % (career)', category: 'College', positions: ['QB'] },
  // Completion rate over team completion rate across same seasons —
  // scheme-independent accuracy signal. Positive = completed at a
  // higher rate than his own program's baseline, which isolates
  // individual accuracy from dink-and-dunk scheme context.
  { key: 'collegeCompletionPctOverTeam', label: 'Completion % Above Team', category: 'College', positions: ['QB'] },
  // Yards per completion (not per attempt). Completions capture
  // "successful pass" volume better than attempts, so this splits
  // dink-and-dunkers from big-play passers more cleanly than YPA.
  { key: 'collegeYdsPerCompletion', label: 'Yards / Completion (career)', category: 'College', positions: ['QB'] },
  // Additional college metrics for rookie prediction
  { key: 'collegeGames', label: 'College Games Played', category: 'College', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'collegeRecPerGame', label: 'College Rec/Game', category: 'College', positions: ['RB', 'WR', 'TE'] },
  { key: 'collegeYdsPerGame', label: 'College Yards/Game', category: 'College', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'collegeTDsPerGame', label: 'College TDs/Game', category: 'College', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'collegeRushYPC', label: 'College Rush YPC', category: 'College', positions: ['QB', 'RB'] },
  { key: 'collegeYdsPerRec', label: 'College Yards/Reception', category: 'College', positions: ['WR', 'TE'] },
  // Career-best single-season stats (peak production across all college seasons)
  { key: 'collegeBestRecYds', label: 'College Best Season Rec Yards', category: 'College', positions: ['WR', 'TE'] },
  { key: 'collegeBestRecTDs', label: 'College Best Season Rec TDs', category: 'College', positions: ['WR', 'TE'] },
  { key: 'collegeBestReceptions', label: 'College Best Season Receptions', category: 'College', positions: ['WR', 'TE'] },
  { key: 'collegeBestRushYds', label: 'College Best Season Rush Yards', category: 'College', positions: ['RB'] },
  { key: 'collegeSeasons', label: 'College Seasons Played', category: 'College', positions: ['QB', 'RB', 'WR', 'TE'] },
  // Advanced college analytics
  { key: 'collegeDominatorRating', label: 'College Dominator Rating (%)', category: 'College', positions: ['RB', 'WR', 'TE'] },
  // RB dual-threat signal: career receiving yards per game. Splits
  // pure bell-cows from pass-catching backs (Kamara / CMC profile).
  { key: 'collegeRecYdsPerGame', label: 'Rec Yards / Game (career)', category: 'College', positions: ['RB', 'WR', 'TE'] },
  // Elusiveness proxy: career rush YPC minus the player's team rush
  // YPC over the same seasons. Positive = player ran above his own
  // o-line's baseline. (True broken-tackle data would be PFF-only.)
  { key: 'collegeRushYpcOverTeam', label: 'Rush YPC Above Team', category: 'College', positions: ['RB'] },
  // Goal-line usage proxy: career rush TDs divided by team scrimmage
  // TDs (rush + rec) over the same seasons. Approximates the share
  // of short-yardage / red-zone work the RB was trusted with.
  { key: 'collegeGoalLineShare', label: 'Goal-Line Share (career)', category: 'College', positions: ['RB'] },
  // Late-round breakout signal: college dominator × (logDraftPick − ~pick 55)+
  // Fires for picks outside ~round 2, lifting prospects like Tyreek Hill / Puka
  // Nacua who had elite college production but fell in the draft.
  { key: 'collegeDominatorXLateRound', label: 'Dominator × Late Round', category: 'College', positions: ['RB', 'WR', 'TE'] },
  { key: 'collegeBreakoutAge', label: 'College Breakout Age', category: 'College', positions: ['RB', 'WR', 'TE'] },
  { key: 'collegeBreakoutAgeDelta', label: 'Draft Age − Breakout Age', category: 'College', positions: ['RB', 'WR', 'TE'] },
  { key: 'collegeMarketShare', label: 'College Receiving/Rushing Share (%)', category: 'College', positions: ['RB', 'WR', 'TE'] },
  { key: 'speedScore', label: 'Speed Score (weight-adj 40)', category: 'College', positions: ['RB', 'WR', 'TE'] },
  // ZAP-inspired per-team-normalized features
  { key: 'collegeRecYdsPerTeamPassAtt', label: 'Rec Yds / Team Pass Att', category: 'College', positions: ['RB', 'WR', 'TE'] },
  { key: 'collegeReceptionShare', label: 'Reception Share (% team)', category: 'College', positions: ['RB', 'WR', 'TE'] },
  { key: 'collegeYdsPerTeamPlay', label: 'Yards / Team Play', category: 'College', positions: ['RB', 'WR', 'TE'] },
  { key: 'collegeBreakoutScore', label: 'Breakout Score (age-adj)', category: 'College', positions: ['WR', 'TE'] },
  { key: 'collegeBestRecYdsPerTPA', label: 'Best Szn Rec Yds / Team PA', category: 'College', positions: ['WR', 'TE'] },
  { key: 'collegeRushProductionWR', label: 'Rush Production (WR, capped)', category: 'College', positions: ['WR'] },
  { key: 'collegeEarlyDeclare', label: 'Early Declare (≤3 yr)', category: 'College', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'collegeExperiencePerAge', label: 'College Games / Age (experience)', category: 'College', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'collegeTeammateScore', label: 'Teammate Score (draft cap)', category: 'College', positions: ['RB', 'WR', 'TE'] },
  { key: 'heightAdjSpeedScore', label: 'Height-Adj Speed Score', category: 'College', positions: ['TE'] },
  { key: 'draftCapXSpeed', label: 'Draft Capital × Speed', category: 'College', positions: ['TE'] },
  // Draft prospect grade/ranking
  { key: 'prospectGrade', label: 'Prospect Grade', category: 'College', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'prospectPosRank', label: 'Prospect Position Rank', category: 'College', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'prospectOvlRank', label: 'Prospect Overall Rank', category: 'College', positions: ['QB', 'RB', 'WR', 'TE'] },
  // 247 composite recruiting profile from CFBD — much wider coverage
  // than the prospect-grade source (covers ~99% of drafted players).
  { key: 'recruitStars', label: 'Recruit Stars (247 composite, 1-5)', category: 'College', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'recruitRating', label: 'Recruit Composite Rating', category: 'College', positions: ['QB', 'RB', 'WR', 'TE'] },
  // CFBD team talent composite — aggregate 247 talent of the player's
  // college team. Captures program quality (Alabama vs Sun Belt) directly.
  { key: 'collegeTeamTalent', label: 'College Team Talent (247 composite)', category: 'College', positions: ['QB', 'RB', 'WR', 'TE'] },
  // CFBD player usage rate — % of team plays the player was involved in.
  // Direct measure of how featured the player was on offense.
  { key: 'collegeUsageOverall', label: 'College Usage Rate (overall)', category: 'College', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'collegeUsagePass', label: 'College Usage Rate (pass plays)', category: 'College', positions: ['QB', 'WR', 'TE'] },
  { key: 'collegeUsageRush', label: 'College Usage Rate (rush plays)', category: 'College', positions: ['RB'] },
  // Missing-data indicators (let models distinguish missing vs truly zero)
  { key: 'hasCollegeStats', label: 'Has College Stats', category: 'College', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'hasProspectGrade', label: 'Has Prospect Grade', category: 'College', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'hasCombineData', label: 'Has Combine Data', category: 'College', positions: ['RB', 'WR', 'TE'] },
  { key: 'hasPhysicalData', label: 'Has Physical Data', category: 'College', positions: ['RB', 'WR', 'TE'] },
  // Relative Athletic Score: 0-10 composite of position-normalized combine
  // z-scores (weight, forty, bench, vertical, broad jump, cone, shuttle).
  // 5.0 = positional average, higher = better athlete. Only counts metrics
  // the player actually ran. 0 = no combine data.
  { key: 'relativeAthleticScore', label: 'RAS (0-10)', category: 'College', positions: ['RB', 'WR', 'TE'] },

  // Contract data (team investment signal)
  { key: 'contractAPY', label: 'Contract APY ($M)', category: 'Contract', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'contractGuaranteed', label: 'Contract Guaranteed ($M)', category: 'Contract', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'contractAPYCapPct', label: 'Contract APY % of Cap', category: 'Contract', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'contractYearsRemaining', label: 'Contract Years Remaining', category: 'Contract', positions: ['QB', 'RB', 'WR', 'TE'] },

  // Player aging curves
  { key: 'ageCurveDelta', label: 'Age Curve Expected Delta', category: 'Aging', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'isPeakAge', label: 'Is Peak Age Window', category: 'Aging', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'isDeclineAge', label: 'Is Decline Age', category: 'Aging', positions: ['QB', 'RB', 'WR', 'TE'] },

  // Momentum features (2-year trends)
  { key: 'ppgTrend', label: 'PPG 2-Year Trend', category: 'Momentum', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'targetTrend', label: 'Target 2-Year Trend', category: 'Momentum', positions: ['RB', 'WR', 'TE'] },
  { key: 'touchTrend', label: 'Touch 2-Year Trend', category: 'Momentum', positions: ['RB'] },
  { key: 'adpTrend', label: 'ADP 2-Year Trend', category: 'Momentum', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'snapPctTrend', label: 'Snap % 2-Year Trend', category: 'Momentum', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'targetShareTrend', label: 'Target Share 2-Year Trend', category: 'Momentum', positions: ['RB', 'WR', 'TE'] },

  // Interaction features (combinations that capture non-linear relationships)
  { key: 'adpXage', label: 'ADP × Age', category: 'Interaction', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'adpXyearsInLeague', label: 'ADP × Years in League', category: 'Interaction', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'contractXdepthRank', label: 'Contract APY × Depth Rank', category: 'Interaction', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'priorPPGXage', label: 'Prior PPG × Age', category: 'Interaction', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'adpXteamPassRate', label: 'ADP × Team Pass Rate', category: 'Interaction', positions: ['QB', 'WR', 'TE'] },
  { key: 'adpXschemeShotgun', label: 'ADP × Shotgun Rate', category: 'Interaction', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'priorPPGXsnapPct', label: 'Prior PPG × Snap %', category: 'Interaction', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'ageXcontractYears', label: 'Age × Contract Years Left', category: 'Interaction', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'targetShareXteamPassRate', label: 'Target Share × Team Pass Rate', category: 'Interaction', positions: ['RB', 'WR', 'TE'] },
  { key: 'rushAttXageDecline', label: 'Rush Att × Age Decline', category: 'Interaction', positions: ['RB'] },

  // Team QB rushing impact — QB's own tendencies (follows the player)
  { key: 'qbOwnRushAtt', label: 'QB Own Rush Attempts', category: 'QB Impact', positions: ['RB', 'WR', 'TE'] },
  { key: 'qbOwnRushYds', label: 'QB Own Rush Yards', category: 'QB Impact', positions: ['RB', 'WR', 'TE'] },
  { key: 'qbOwnRushTDs', label: 'QB Own Rush TDs', category: 'QB Impact', positions: ['RB'] },
  { key: 'qbOwnRushShare', label: 'QB Own Rush Att Share', category: 'QB Impact', positions: ['RB'] },
  { key: 'qbOwnScrambleRate', label: 'QB Own Scramble Rate', category: 'QB Impact', positions: ['RB', 'WR', 'TE'] },
  { key: 'qbOwnPPG', label: 'QB Own Fantasy PPG', category: 'QB Impact', positions: ['WR', 'TE'] },
  // Team QB rushing impact — team's coaching tendency (stays with the team)
  { key: 'teamPriorQBRushAtt', label: 'Team Prior QB Rush Att', category: 'QB Impact', positions: ['RB', 'WR', 'TE'] },
  { key: 'teamPriorQBRushShare', label: 'Team Prior QB Rush Share', category: 'QB Impact', positions: ['RB'] },
  { key: 'teamPriorQBScrambleRate', label: 'Team Prior QB Scramble Rate', category: 'QB Impact', positions: ['RB', 'WR', 'TE'] },

  // Weekly consistency (boom/bust profile)
  { key: 'priorPPGStdDev', label: 'Prior PPG Std Dev', category: 'Consistency', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'priorBoomRate', label: 'Prior Boom Game Rate (>20pts)', category: 'Consistency', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'priorBustGameRate', label: 'Prior Dud Game Rate (<5pts)', category: 'Consistency', positions: ['QB', 'RB', 'WR', 'TE'] },

  // Dome/weather team
  { key: 'teamDomeGames', label: 'Team Home Dome Games', category: 'Environment', positions: ['QB', 'RB', 'WR', 'TE'] },

  // Bye week timing
  { key: 'byeWeek', label: 'Bye Week Number', category: 'Environment', positions: ['QB', 'RB', 'WR', 'TE'] },

  // Team offensive line quality (from PBP)
  { key: 'teamSackRate', label: 'Team Sack Rate Allowed', category: 'Environment', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'teamRushYPC', label: 'Team Rush Yards Per Carry', category: 'Environment', positions: ['RB'] },

  // QB quality for receivers
  { key: 'teamQBPassRating', label: 'Team QB Passer Rating', category: 'QB Impact', positions: ['WR', 'TE'] },

  // Injury recurrence (same body part in consecutive years)
  { key: 'injuryRecurrence', label: 'Injury Recurrence Risk', category: 'Injury', positions: ['QB', 'RB', 'WR', 'TE'] },

  // Team offensive turnover rate
  { key: 'teamRosterTurnover', label: 'Team Roster Turnover Rate', category: 'Competition', positions: ['QB', 'RB', 'WR', 'TE'] },

  // PDF scouting features (The Beast / RSP / Late-Round Guide). Populated
  // for 2022+ rookies by _derive_pdf_features in train_career_models.py
  // and mirrored in scripts/precompute-features.ts for prospect cards.
  { key: 'pdfRankOverallMean', label: 'Scout Rank (Beast mean)', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'pdfHasRank', label: 'Has Scout Rank', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'pdfRankOverallMin', label: 'Scout Rank (best)', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'pdfRankOverallMax', label: 'Scout Rank (worst)', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'pdfRankSpread', label: 'Scout Rank Spread', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'pdfProjectedRound', label: 'Scout Projected Round', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'pdfNStrengths', label: 'Scout # Strengths', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'pdfNWeaknesses', label: 'Scout # Weaknesses', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'pdfNRedFlags', label: 'Scout # Red Flags', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'pdfSentimentNet', label: 'Scout Sentiment Net', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },

  // Disagreement features — cross-signal gaps that only light up when two
  // channels that should agree don't. Computed in _attach_disagreement_features.
  { key: 'pdfRankXPick', label: 'Scout Rank vs Draft Pick', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'pdfRoundXActual', label: 'Proj Round vs Actual Round', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'recruit_production_gap', label: 'Recruit-vs-Production Gap', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'athletic_production_gap', label: 'Athletic-vs-Production Gap', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },

  // RSP-specific features (Matt Waldman's Rookie Scouting Portfolio). DOT =
  // "Depth of Talent" numeric grade parsed from tier strings like
  // "Starter (87.4)". Cross-year trajectory (draft-year DOT vs latest
  // appearance) from rsp-historical-rankings.json. Shipped for RB/WR pre-draft
  // rookie career models 2026-04 (see docs/pdf-career-feature-test.md).
  { key: 'rspDotMax', label: 'RSP DOT (best)', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'rspDotDraft', label: 'RSP DOT (draft year)', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'rspDotLatest', label: 'RSP DOT (latest)', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'rspDotDelta', label: 'RSP DOT Trajectory', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'rspBreadthDraft', label: 'RSP Breadth (draft year)', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'rspBreadthLatest', label: 'RSP Breadth (latest)', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'rspTierOrdinal', label: 'RSP Tier Class', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'rspAppearances', label: 'RSP Guide Appearances', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'rspNComps', label: 'RSP # NFL Comps', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },
  { key: 'rspHasData', label: 'Has RSP Data', category: 'Scouting', positions: ['QB', 'RB', 'WR', 'TE'] },
];

// ── Helpers ──

// First-name aliases for name-based lookups across data sources. CFBD often
// stores the legal first name ("Cameron", "Joshua", "Patrick") while
// nflverse / FFC / prospect feeds use the commonly-known short form ("Cam",
// "Josh", "Pat"). Without this, college features for Cam Ward (= Cameron
// Ward in CFBD) come through as 0, which is how a #1 overall pick ended up
// with NO college data in the training cache.
//
// Each entry maps the short form to the full legal form. normalizeName()
// applies the forward mapping; matchesName() below tries both directions
// so a lookup table built from either source can find the other.
const FIRST_NAME_ALIASES: Record<string, string> = {
  cam: 'cameron',
  mitch: 'mitchell',
  josh: 'joshua',
  pat: 'patrick',
  dan: 'daniel',
  jeff: 'jeffrey',
  chig: 'chigoziem',
};

/**
 * Normalize a player name for cross-source lookup.
 *
 * Steps, in order:
 *   1. Lowercase, strip apostrophes + periods
 *   2. Strip generational suffix (Jr, Sr, II-V)
 *   3. Collapse whitespace
 *   4. Strip middle names: 3+ token names drop the middle token(s).
 *      Handles CFBD entries like "skylar john thompson" vs nflverse
 *      "Skylar Thompson" — without this, the lookup misses.
 *   5. Apply FIRST_NAME_ALIASES forward (short → long) so both sources
 *      canonicalize to the full legal first name.
 */
export function normalizeName(name: string | null | undefined): string {
  if (!name) return '';
  let n = name.toLowerCase().replace(/[.']/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').replace(/\s+/g, ' ').trim();
  // Collapse middle names to first + last
  const parts = n.split(' ');
  if (parts.length >= 3) {
    n = `${parts[0]} ${parts[parts.length - 1]}`;
  }
  // Expand short-form first name to legal form
  const [first, ...rest] = n.split(' ');
  if (first && rest.length > 0 && FIRST_NAME_ALIASES[first]) {
    n = `${FIRST_NAME_ALIASES[first]} ${rest.join(' ')}`;
  }
  return n;
}

export function parseHeight(ht: string | number): number {
  if (typeof ht === 'number') return ht;
  const parts = String(ht).split('-');
  return parts.length === 2 ? Number(parts[0]) * 12 + Number(parts[1]) : 0;
}

// Pre-draft rookie features: college + combine + prospect grade only (no team context)
// Used before the NFL draft when landing spot is unknown
// Feature count kept proportional to sample size (~1 feature per 10-15 samples)
// Missing-data indicators (hasCollegeStats, hasCombineData) added where useful
// — binary flags are cheap and help models distinguish missing vs zero
export const PRE_DRAFT_ROOKIE_FEATURES: Record<string, string[]> = {
  // QB: n=134. Base 6 features from the 2026-04 CFBD pass. 2026-04 round 3
  // added pdfRankOverallMean + pdfHasRank (paired with the missing-data
  // indicator): +0.077 R² in the 2022-25 era, flat all-yrs.
  // Source of truth: scripts/train_career_models.py::PRE_DRAFT_FEATURES.
  QB: ['logDraftPick', 'draftClassDepth', 'collegeQBR2yr',
       'collegeRushYpgPerAge', 'collegeSosFinalYr', 'collegeQbContextScore',
       'pdfRankOverallMean', 'pdfHasRank'],
  // RB: n=315. collegeUsageOverall (PPA-based share of team plays, +0.029 R²)
  // and recruitRating (247 composite, +0.008 R²) shipped in the 2026-04
  // CFBD pass. pdfRankOverallMean + pdfHasRank added later: +0.008 all-yrs,
  // +0.028 in the PDF era. Paired with DRAFT_CAPITAL_KEYS so the companion
  // model ignores them. RSP bundle (draft_snapshot: DOT + breadth + tier
  // ord + comps + has flag) shipped 2026-04 round 4: R² +0.042 in the PDF era.
  RB: ['logDraftPick', 'collegeDominatorXLateRound',
       'collegeUsageOverall', 'recruitRating',
       'pdfRankOverallMean', 'pdfHasRank',
       'rspDotDraft', 'rspBreadthDraft', 'rspTierOrdinal',
       'rspNComps', 'rspHasData'],
  // WR: n=456. recruitStars (+0.011 R²) shipped in the CFBD pass. PDF
  // sentiment family (strengths/weaknesses/red_flags/net, red flags 2×)
  // added later: +0.006 all-yrs, +0.021 PDF-era. Rank features already
  // captured by existing draft capital + college production for WR.
  // rspNComps + rspHasData shipped 2026-04 round 4: R² +0.071 in the PDF era.
  WR: ['logDraftPick', 'draftPickPct', 'draftPickPctOverall', 'draftClassDepth', 'age',
       'collegeBreakoutScore', 'collegeRecYdsPerTeamPassAtt',
       'collegeBestRecYds',
       'weight', 'collegeTeammateScore',
       'relativeAthleticScore', 'recruitStars',
       'pdfNStrengths', 'pdfNWeaknesses', 'pdfNRedFlags', 'pdfSentimentNet',
       'rspNComps', 'rspHasData'],
  // TE: n=207. recruitStars (+0.015 R²). 2026-04 production ablation
  // (scripts/ablate_te_features.py) added collegeBreakoutScore +0.026 R²
  // and collegeRecYdsPerTeamPassAtt +0.024 R² — combined ΔR² +0.029.
  // PDF/RSP scout signals remain a wash for TE at n=207.
  TE: ['logDraftPick', 'draftPickPct', 'draftPickPctOverall', 'draftClassDepth',
       'age', 'recruitStars',
       'collegeBreakoutScore', 'collegeRecYdsPerTeamPassAtt'],
};

// Post-draft rookie features: adds team context once landing spot is known.
// Matches scripts/train_career_models.py::POST_DRAFT_FEATURES. The 2026-04
// forward-selection ablation pruned down from the broader post-draft list
// (contractAPY was 0% coverage; teamPace hurt RB; depthChartRank hurt QB/RB).
export const ROOKIE_FEATURES: Record<string, string[]> = {
  // QB: PRE + teamSamePosCount + PDF scout-vs-NFL disagreement pair.
  // Disagreement features lifted R² +0.002 all-yrs, ρ +0.042 in the PDF era.
  QB: [...PRE_DRAFT_ROOKIE_FEATURES.QB,
       'teamSamePosCount', 'pdfRankXPick', 'pdfRoundXActual'],
  // RB: PRE + team context. PDF rank stays from pre-draft.
  RB: [...PRE_DRAFT_ROOKIE_FEATURES.RB,
       'teamSamePosCount', 'vegasImpliedTotal', 'teamPassRate', 'qbOwnPPG'],
  // WR: PRE minus the PDF sentiment pair (once team-context features land,
  // sentiment loses its marginal value: Δ-0.0003 all-yrs, -0.009 score≥22).
  // rspNComps/rspHasData also dropped post-draft — landing spot subsumes
  // the scout-archetype-count signal once pick is known.
  // Keeping landing-spot features instead.
  WR: [...PRE_DRAFT_ROOKIE_FEATURES.WR.filter(f =>
        !['pdfNStrengths', 'pdfNWeaknesses', 'pdfNRedFlags', 'pdfSentimentNet',
          'rspNComps', 'rspHasData'].includes(f)),
       'depthChartRank', 'teamSamePosCount',
       'vegasImpliedTotal', 'teamPassRate', 'qbOwnPPG', 'projTeamPassAtt'],
  // TE: PRE + team context.
  TE: [...PRE_DRAFT_ROOKIE_FEATURES.TE,
       'depthChartRank', 'vegasImpliedTotal', 'teamPassRate', 'qbOwnPPG'],
};

// Features that are ADP-derived (excluded from ADP-independent models)
export const ADP_FEATURES = new Set([
  'adp', 'adpRound', 'adpTrend',
  'adpXage', 'adpXyearsInLeague', 'adpXteamPassRate', 'adpXschemeShotgun',
  'newArrivalBestADP',
]);
export function cvR2(actuals: number[], preds: number[]): number {
  if (actuals.length < 4) return 0;
  const mean = actuals.reduce((s, v) => s + v, 0) / actuals.length;
  const ssTot = actuals.reduce((s, v) => s + (v - mean) ** 2, 0);
  const ssRes = actuals.reduce((s, v, i) => s + (v - preds[i]) ** 2, 0);
  return ssTot === 0 ? 0 : Math.round((1 - ssRes / ssTot) * 1000) / 1000;
}

export function cvMae(actuals: number[], preds: number[]): number {
  if (actuals.length === 0) return 0;
  return Math.round(actuals.reduce((s, v, i) => s + Math.abs(v - preds[i]), 0) / actuals.length * 100) / 100;
}
