/**
 * Shared helpers for reading a prospect's model scores — the direction of
 * each feature (is a higher raw value good or bad for the player?), which
 * zeros mean "no data", and the percentile colour ramp the Prospects board,
 * the prospect card and the player-detail scores card all use.
 */

// Features where a HIGH raw value is WORSE for projection (late draft pick,
// older rookie, slower 40, more red flags). Bars + colours invert for these so
// "longer green bar = better for the player" reads consistently everywhere.
//
// The score store stores RAW percentiles (higher percentile = higher value)
// and this set is the ONLY place direction is decided — precompute-features
// must not invert anything, or a feature flips twice and reads backwards.
// scripts/test-feature-direction.ts checks both halves of that contract and
// compares this list with the career model's own coefficient signs.
export const LOWER_IS_BETTER = new Set<string>([
  // Draft capital: a small pick / round / percentile is a high pick.
  'nflDraftPick', 'nflDraftRound', 'logDraftPick',
  'draftPickPct', 'draftPickPctOverall',
  'adp', 'adpRound',
  // Youth: a younger rookie and an earlier breakout are better.
  'age', 'collegeBreakoutAge',
  // Timed drills: faster is a smaller number.
  'forty', 'cone', 'shuttle',
  // Guide ranks and rounds: 1 is the top. Weaknesses and red flags count against.
  'pdfNWeaknesses', 'pdfNRedFlags', 'pdfRankOverallMean', 'pdfRankOverallMin', 'pdfRankOverallMax', 'pdfProjectedRound',
  // Landing spot: more same-position teammates is more competition.
  'teamSamePosCount',
  // Veteran / injury history.
  'priorINTs', 'priorBustGameRate', 'teamSackRate', 'injuryRecurrence',
  'priorGamesMissed', 'priorInjuryWeeks', 'priorGamesOut',
  'preseasonInjured', 'preseasonInjWeeks',
  'priorSoftTissue', 'priorKneeInjury',
]);

// Indicator flags and class-wide constants read as "100th percentile" for
// everyone and say nothing about the player: never a bar.
export const HIDE_FROM_BARS = /^(has|pdfHas|rspHas)|^draftClassDepth$/;

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

/** A value the card should show as "no data" rather than as a zero: a
 *  no-data zero for combine / college features, and every guide (pdf*) or
 *  scout (rsp*) feature when that source has no profile for the player —
 *  otherwise "0 red flags" and "0 strengths" both read as 100th percentile. */
export function isMissing(key: string, val: number | undefined | null, features?: Record<string, number | undefined>): boolean {
  if (val == null) return true;
  if (features) {
    if (key.startsWith('pdf') && (features.pdfHasData ?? features.pdfHasRank ?? 1) === 0) return true;
    if (key.startsWith('rsp') && (features.rspHasData ?? 1) === 0) return true;
  }
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
