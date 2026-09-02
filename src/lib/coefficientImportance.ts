// Feature importance for the logistic models StatHead fits itself — the
// abandonment hazard and the dynasty departure scorers.
//
// These are fitted on standardised inputs, so |coefficient| IS the importance:
// each is the change in log-odds per one standard deviation of that feature,
// directly comparable across features on different scales. No cohort or
// permutation pass is needed.
//
// The relationship's shape is different in kind from a tree model's, and the
// docs must not blur them. A gradient-boosted model's shape is MEASURED — bin
// the cohort and look. A logistic model is linear in the standardised feature
// by construction, so its monotonicity is an ASSUMPTION OF THE FUNCTIONAL FORM,
// true whatever the data did. Reporting "rises throughout" for both without
// that distinction would present a modelling choice as an empirical finding.
import type { ImportanceRow } from '../components/FeatureImportancePanel';

export interface CoefficientModel {
  featureNames: string[];
  coefficients: number[];
  intercept?: number;
  mean?: number[];
  sd?: number[];
}

/** Human labels for the departure / abandonment feature names. */
const LABELS: Record<string, string> = {
  isNewMember: 'First season in the league',
  tenureYears: 'Seasons in this league',
  tenureCensored: 'Tenure is a lower bound',
  leagueSize: 'League size',
  portfolioSize: 'Leagues in their portfolio',
  logPortfolioSize: 'Portfolio size (log)',
  dynastyLineages: 'Dynasty leagues held',
  dynastyShare: 'Share of portfolio that is dynasty',
  bestBallShare: 'Share of portfolio that is best ball',
  seasonsActive: 'Seasons active on Sleeper',
  priorLeaveRate: 'Rate they left past leagues',
  priorLeaveObserved: 'Past leagues resolved',
  isBestBallLeague: 'This league is best ball',
  // In-season abandonment hazard: a different feature set, all measured
  // strictly to-date so no row can see the rest of the season.
  weekIndex: 'Week of the season',
  weeksSinceStart: 'Weeks since their first activity',
  weeksSinceLastTxn: 'Weeks since their last transaction',
  txnToDate: 'Transactions so far',
  txnPerWeekToDate: 'Transactions per week so far',
  waiverToDate: 'Waiver claims so far',
  freeAgentToDate: 'Free-agent adds so far',
  tradeToDate: 'Trades so far',
  failedToDate: 'Failed claims so far',
  addToDate: 'Adds so far',
  dropToDate: 'Drops so far',
  activeWeeksToDate: 'Active weeks so far',
  longestGapToDate: 'Longest quiet run so far',
  totalRosters: 'League size',
  isDynasty: 'League is dynasty',
  isSuperflex: 'League is superflex',
  priorSeasonWentDark: 'Went dark in a prior season',
  priorSeasonsObserved: 'Prior seasons observed',
};

const CATEGORIES: Record<string, string> = {
  isNewMember: 'Tenure', tenureYears: 'Tenure', tenureCensored: 'Tenure',
  leagueSize: 'League', isBestBallLeague: 'League',
  portfolioSize: 'Portfolio', logPortfolioSize: 'Portfolio',
  dynastyLineages: 'Portfolio', dynastyShare: 'Portfolio', bestBallShare: 'Portfolio',
  seasonsActive: 'Portfolio',
  priorLeaveRate: 'History', priorLeaveObserved: 'History',
  weekIndex: 'Timing', weeksSinceStart: 'Timing', weeksSinceLastTxn: 'Recency',
  txnToDate: 'Volume', txnPerWeekToDate: 'Volume', waiverToDate: 'Volume',
  freeAgentToDate: 'Volume', tradeToDate: 'Volume', failedToDate: 'Volume',
  addToDate: 'Volume', dropToDate: 'Volume', activeWeeksToDate: 'Cadence',
  longestGapToDate: 'Cadence', totalRosters: 'League',
  isDynasty: 'League', isSuperflex: 'League',
  priorSeasonWentDark: 'History', priorSeasonsObserved: 'History',
};

export function coefficientImportance(
  model: CoefficientModel,
  /** What the target is, for the sentence: e.g. "the chance of leaving". */
  target: string,
): ImportanceRow[] {
  const rows: ImportanceRow[] = [];
  model.featureNames.forEach((name, i) => {
    const coef = model.coefficients[i];
    if (!Number.isFinite(coef)) return;
    const label = LABELS[name] ?? name;
    // A zero coefficient is a feature the fit discarded; say so rather than
    // implying a direction from a rounding artefact.
    const shape = Math.abs(coef) < 1e-6 ? 'flat' : coef > 0 ? 'increasing' : 'decreasing';
    const shapeText = shape === 'flat'
      ? `The fit gave this no weight, so it does not move ${target}.`
      : `Each standard deviation more ${label.toLowerCase()} ${coef > 0 ? 'raises' : 'lowers'} `
        + `${target} by ${Math.abs(coef).toFixed(3)} in log-odds. Linear by construction, `
        + `so the direction holds across the whole range.`;
    rows.push({
      label,
      category: CATEGORIES[name] ?? '',
      importance: Math.round(Math.abs(coef) * 1000) / 1000,
      direction: Math.round(coef * 1000) / 1000,
      rankCorrelation: null,
      shape,
      shapeText,
    });
  });
  return rows.sort((a, b) => b.importance - a.importance);
}
