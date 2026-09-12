/**
 * Shared helpers for reading a prospect's model scores — the direction of
 * each feature (is a higher raw value good or bad for the player?), which
 * zeros mean "no data", and the percentile colour ramp the Prospects board,
 * the prospect card and the player-detail scores card all use.
 */

// Features where a HIGH raw value is WORSE for projection (late draft pick,
// older rookie, slower 40, more red flags). Bars + colours invert for these so
// "longer green bar = better for the player" reads consistently everywhere.
export const LOWER_IS_BETTER = new Set<string>([
  'nflDraftPick', 'nflDraftRound', 'logDraftPick',
  'draftPickPct', 'draftPickPctOverall',
  'adp', 'adpRound',
  'age',
  'forty', 'cone', 'shuttle',
  'pdfNWeaknesses', 'pdfNRedFlags', 'pdfRankOverallMean',
  'priorINTs', 'priorBustGameRate', 'teamSackRate', 'injuryRecurrence',
  'priorGamesMissed', 'priorInjuryWeeks', 'priorGamesOut',
  'preseasonInjured', 'preseasonInjWeeks',
  'priorSoftTissue', 'priorKneeInjury',
]);

/** "Goodness" percentile — high = better for the player — regardless of the
 *  feature's natural direction. */
export function goodnessPctl(key: string, pctl: number): number {
  return LOWER_IS_BETTER.has(key) ? 100 - pctl : pctl;
}

// Features where a value of exactly 0 means "no data captured" rather than a
// real zero: combine / college-production / CFBD features, because the
// upstream pipeline writes 0 when a lookup whiffs. Binary flags, interaction
// terms and derived draft-pick features stay out of this set.
export const ZERO_MEANS_MISSING = new Set<string>([
  'relativeAthleticScore', 'speedScore', 'heightAdjSpeedScore',
  'forty', 'weight', 'bmi', 'cone', 'shuttle', 'bench', 'vertical', 'broadJump',
  'collegeDominatorRating', 'collegeBestRecYds', 'collegeBestRushYds',
  'collegeBreakoutScore', 'collegeBreakoutAge', 'collegeMarketShare',
  'collegeReceptionShare', 'collegeTotalTDs', 'collegeRushYPC',
  'collegeYdsPerRec', 'collegeRecPerGame', 'collegeRecTDs',
  'collegeRecYds', 'collegeRushYds', 'collegePassTDs',
  'collegeSeasons', 'collegeGames', 'collegeExperiencePerAge',
  'collegeTeammateScore', 'collegeRushProductionWR',
  'recruitRating', 'recruitStars',
  'collegeUsageOverall', 'collegeUsagePass', 'collegeUsageRush',
  'collegeTeamTalent',
  'collegeQBR', 'collegeQBR2yr', 'collegeYdsPerPassAtt', 'collegeQbContextScore',
  'collegeRushYpgPerAge', 'collegeSosFinalYr',
  'age', 'nflDraftPick', 'nflDraftRound',
]);

export function isMissing(key: string, val: number | undefined | null): boolean {
  if (val == null) return true;
  return ZERO_MEANS_MISSING.has(key) && val === 0;
}

/** Colour for a goodness percentile: green at the top, red at the bottom. */
export function pctlColor(pctl: number): string {
  if (pctl >= 90) return '#22c55e';
  if (pctl >= 75) return '#4ade80';
  if (pctl >= 60) return '#a3e635';
  if (pctl >= 40) return '#facc15';
  if (pctl >= 20) return '#fb923c';
  return '#ef4444';
}

/** One row of public/data/score-store/career.json — the rookie career model's
 *  full record for a scored prospect, including every input feature and its
 *  percentile against all historical rookies at the position. */
export interface CareerScoreRec {
  name: string;
  position: string;
  draftSeason?: number;
  school?: string;
  projPick?: number;
  predictedPPG: number;
  percentile?: number;
  tier?: number;
  tierLabel?: string;
  thresholdProbs?: Record<string, number>;
  boomProb?: number;
  bustProb?: number;
  boomZ?: number;
  bustZ?: number;
  features?: Record<string, number>;
  featurePercentiles?: Record<string, number>;
}

/** The prospect's own record plus the rest of the same position's draft class,
 *  so the card can place him against his peers. */
export interface ProspectScores {
  me: CareerScoreRec;
  classmates: CareerScoreRec[];   // same position + draft season, excluding `me`
}
