// Data-completeness and feature audits for the manager-engagement pipeline.
//
// This is the input-side half of the reporting suite. It runs BEFORE any model
// is fit, and its job is to catch the failure modes that make a model look good
// while being worthless:
//
//   1. Silent truncation. The transaction sweep is capped at 700 league-weeks
//      (src/lib/sleeper.ts). When the cap bites, the OLDEST seasons come back
//      with no transactions — indistinguishable from a manager who did nothing.
//      Every engagement feature then reads "inactive" for those rows. Nothing
//      in the data announces this; only the `capped` flag does.
//   2. Target leakage. `trailingSilentWeeks` and `lastActiveWeek` are what the
//      abandonment label is COMPUTED FROM. Handing either to the model gives
//      near-perfect scores that mean nothing.
//   3. Prediction-time leakage. `wins`, `regSeasonRank`, `pointsFor` and
//      `champion` are known only at season end, so they cannot feed a model
//      that scores a manager at week 7.
//   4. Broken masking. Best-ball rows must carry null lineup features. If the
//      mask breaks, "everyone in best-ball abandoned" gets learned as signal.
//
// So features here are declared with a `kind`, and the audit derives model
// eligibility from it rather than trusting the caller to remember.
//
// See docs/sleeper-engagement-model.md.
import { summarize, auc, pearson, psi, type NumericSummary } from './evalMetrics';
import {
  wentDark, engagementProfile, tradesFromEvents,
  type ManagerSeasonEngagement, type PortfolioEntry, type EngagementProfile, type AxisSource,
} from './engagement';
import type { LeagueSeasonRecord, TxnEvent } from './sleeper';
import type { RetentionEvent } from './leagueLineage';

// How a feature relates to prediction time.
//   static        — fixed for the whole season; always safe
//   time-varying  — safe only when recomputed as-of the scored week
//   season-final  — not knowable until the season ends
//   label-derived — the label is computed from it; never a feature
export type FeatureKind = 'static' | 'time-varying' | 'season-final' | 'label-derived';

export type RiskDirection = 'higher-risk' | 'lower-risk' | 'none';

export interface FeatureSpec {
  name: string;
  kind: FeatureKind;
  get: (row: ManagerSeasonEngagement) => number | null;
  // The documented hypothesis. The audit compares it to the measured
  // association and flags disagreement — a flipped sign is a bug signal, not
  // an interesting finding.
  expect?: RiskDirection;
  // A null in a required field is a completeness defect, not a valid absence.
  required?: boolean;
  // Physically possible bounds. A value outside them is a parsing or upstream
  // fault, not an outlier, and is reported as a validity violation.
  range?: [number, number];
  // False when the value's scale depends on a league setting we do not capture,
  // so the same number means different things in different leagues. Such a
  // feature is not usable as-is however clean it looks.
  comparableAcrossLeagues?: boolean;
  // True when the value is a point-in-time snapshot rather than a season
  // aggregate — it describes one moment, usually the latest, and reads as a
  // season-level behavioural measure only by accident.
  pointInTime?: boolean;
  note?: string;
}

// A season needs at least this many usable rows before its drift figure means
// anything. Below it, stability is reported as n/a rather than guessed.
const MIN_SEASON_SAMPLE = 30;

const bool = (b: boolean): number => (b ? 1 : 0);
const share = (n: number, d: number) => (d > 0 ? n / d : 0);

// The engagement feature surface, declared once so eligibility is derived
// rather than remembered.
export const ENGAGEMENT_FEATURES: FeatureSpec[] = [
  // ── static ──
  { name: 'totalRosters', kind: 'static', get: (r) => r.totalRosters, expect: 'none', required: true, range: [2, 64] },
  { name: 'isDynasty', kind: 'static', get: (r) => bool(r.format.type === 'Dynasty'), expect: 'lower-risk',
    note: 'dynasty managers have standing assets, so less reason to walk away mid-season' },
  { name: 'isBestBall', kind: 'static', get: (r) => bool(r.format.bestBall), expect: 'none',
    note: 'excluded from the abandonment label entirely; kept for slicing' },
  { name: 'isSuperflex', kind: 'static', get: (r) => bool(r.format.qb === 'Superflex'), expect: 'none' },

  // ── time-varying (safe only as running-to-date values) ──
  { name: 'txnCount', kind: 'time-varying', get: (r) => r.txnCount, expect: 'lower-risk', required: true, range: [0, 5000] },
  { name: 'waiverCount', kind: 'time-varying', get: (r) => r.waiverCount, expect: 'lower-risk' },
  { name: 'freeAgentCount', kind: 'time-varying', get: (r) => r.freeAgentCount, expect: 'lower-risk' },
  { name: 'tradeCount', kind: 'time-varying', get: (r) => r.tradeCount, expect: 'lower-risk' },
  { name: 'commishCount', kind: 'time-varying', get: (r) => r.commishCount, expect: 'lower-risk' },
  { name: 'failedCount', kind: 'time-varying', get: (r) => r.failedCount, expect: 'lower-risk',
    note: 'a lost bid is still evidence of attention' },
  { name: 'addCount', kind: 'time-varying', get: (r) => r.addCount, expect: 'lower-risk' },
  { name: 'dropCount', kind: 'time-varying', get: (r) => r.dropCount, expect: 'lower-risk' },
  // Not comparable across leagues: budgets range from $100 to $1000+ and the
  // crawler does not capture settings.waiver_budget, so "spent 100" is
  // everything in one league and a tenth of it in another. Observed range in
  // the real population is 0-4595 in a single column.
  { name: 'faabSpent', kind: 'time-varying', get: (r) => r.faabSpent, expect: 'lower-risk',
    comparableAcrossLeagues: false, range: [0, 100000],
    note: 'needs settings.waiver_budget to become a share of budget' },
  // Hypothesis corrected against real data (AUC 0.424, n=1491): as a SEASON
  // SUMMARY this is confounded by engagement span. It counts gaps BETWEEN the
  // first and last active week, so a manager who quits in week 3 has almost no
  // room for internal gaps while one active all season has sixteen weeks of
  // opportunity. Longer silent runs therefore mark longer-engaged managers.
  // The actual hazard term is weeks-since-last-transaction as of the scored
  // week, which is a to-date quantity — the 'time-varying' kind, not this.
  { name: 'longestSilentRun', kind: 'time-varying', get: (r) => r.longestSilentRun, expect: 'lower-risk', range: [0, 18],
    note: 'season summary is span-confounded; use the to-date gap as the hazard term' },
  // A point-in-time snapshot, not a season measure: /league/<id>/rosters returns
  // the CURRENT starters, so for a completed season this is the final week's
  // lineup and says nothing about the weeks that mattered. Measured signal on
  // real data is 0.502 — noise, which is what the snapshot problem predicts.
  // Per-week lineups need /league/<id>/matchups/<week>.
  { name: 'emptyStarterSlots', kind: 'time-varying', get: (r) => r.emptyStarterSlots, expect: 'higher-risk',
    pointInTime: true, range: [0, 40],
    note: 'snapshot of the latest lineup, not a season aggregate' },

  // ── season-final: cannot feed a week-w prediction ──
  // Multi-matchup leagues play more than one head-to-head per week, so games
  // played runs to 36 in a 17-week season and a raw win count is not comparable
  // between leagues. 19% of rows in the real population exceed 18 games.
  { name: 'wins', kind: 'season-final', get: (r) => r.wins, expect: 'lower-risk',
    comparableAcrossLeagues: false, range: [0, 40] },
  { name: 'losses', kind: 'season-final', get: (r) => r.losses, expect: 'higher-risk',
    comparableAcrossLeagues: false, range: [0, 40] },
  // 0 is a "roster not found" sentinel from fetchUserHistory, and 0 sorts as a
  // better rank than 1. It does not occur in the current population; the range
  // check keeps it from passing silently if it ever does.
  { name: 'regSeasonRank', kind: 'season-final', get: (r) => r.regSeasonRank, expect: 'higher-risk', range: [1, 64] },
  { name: 'pointsFor', kind: 'season-final', get: (r) => r.pointsFor, expect: 'lower-risk' },
  { name: 'champion', kind: 'season-final', get: (r) => bool(r.champion), expect: 'lower-risk' },

  // ── label-derived: never features ──
  { name: 'lastActiveWeek', kind: 'label-derived', get: (r) => r.lastActiveWeek },
  { name: 'trailingSilentWeeks', kind: 'label-derived', get: (r) => r.trailingSilentWeeks },
  { name: 'activeWeekCount', kind: 'label-derived', get: (r) => r.activeWeeks.length },
];

export interface AuditOptions {
  // Last week each season could plausibly have had activity, as the crawler
  // derives it. A season still in progress is structurally unlike a completed
  // one — a pre-season snapshot has near-zero transactions — so including it in
  // stability reports drift on every activity feature at once.
  horizonBySeason?: Record<string, number>;
  // Below this horizon a season counts as in-progress and is excluded from
  // stability (but still reported, and still audited for completeness).
  minHorizonWeeks?: number;
  // Minimum |AUC - 0.5| before a single-feature association is called a
  // direction at all. Below it the measurement is noise, and flagging a
  // "contradicted hypothesis" on a 2-point deviation trains people to ignore
  // the warning that matters.
  minEffectSize?: number;
}

const DEFAULT_MIN_HORIZON = 8;
const DEFAULT_MIN_EFFECT = 0.05;

export type Eligibility = 'eligible' | 'conditional' | 'ineligible';

const ELIGIBILITY: Record<FeatureKind, { eligibility: Eligibility; reason: string }> = {
  static: { eligibility: 'eligible', reason: 'Fixed for the season; known at prediction time.' },
  'time-varying': {
    eligibility: 'conditional',
    reason: 'Usable only when recomputed as-of the scored week. The season total shown here is NOT safe as-is.',
  },
  'season-final': {
    eligibility: 'ineligible',
    reason: 'Known only after the season ends; using it to score week w is prediction-time leakage.',
  },
  'label-derived': {
    eligibility: 'ineligible',
    reason: 'The abandonment label is computed from this field; using it is target leakage.',
  },
};

// ── input shape ──

// How much of a manager's league portfolio the crawl actually saw.
//
// A league-oriented crawl finds managers INSIDE leagues it visited, so by
// default it sees only the slice of each manager's portfolio that overlaps the
// crawl. Row-level (manager-season) features are unaffected — each crawled
// league-season is complete. Profile-level features are not: league count,
// retention rate and historical abandonment rate are all computed over the
// portfolio, and a partial portfolio biases every one of them.
//
// The crawler resolves the full portfolio only for the managers it expands
// through, so this records which ones those are.
export interface ManagerCoverage {
  portfolioKnown: boolean;       // was the manager's full league list enumerated?
  knownLeagueSeasons: number;    // league-seasons known to exist for them
  crawledLeagueSeasons: number;  // league-seasons crawled in full
}

// One crawled manager. Matches what a league-oriented crawl produces per
// manager, so the audit can run on a single user or a full population.
export interface ManagerObservation {
  managerId: string;
  rows: ManagerSeasonEngagement[];
  history?: LeagueSeasonRecord[];
  events?: TxnEvent[];
  sweep?: { capped: boolean; weeksScanned: number };
  retention?: RetentionEvent[];
  coverage?: ManagerCoverage;
  // The manager's enumerated league list. Present when the crawl ran its
  // enumeration pass; portfolio-level features are exact where it is, and a 2%
  // sample of the true portfolio where it is not.
  portfolio?: PortfolioEntry[];
}

// ── reports ──

export interface CompletenessReport {
  managers: number;
  managerSeasons: number;
  lineages: number;
  seasons: string[];
  rowsBySeason: Record<string, number>;
  rowsByFormat: Record<string, number>;

  // Truncation and missingness — the checks that catch silently bad inputs.
  managersWithCappedSweep: number;
  cappedSweepShare: number;
  zeroTxnRows: number;
  zeroTxnUnlaunched: number;      // league never drafted: expected, not a defect
  zeroTxnBestBall: number;        // best ball has no waivers or lineups: expected
  zeroTxnInProgress: number;      // season has barely started: expected
  zeroTxnUnexplained: number;     // a live, managed league with no activity at all
  missingRosterIdRows: number;
  missingTimestampShare: number;  // events with created === 0
  startersCoverage: number;       // share of non-best-ball rows with an empty-slot value
  portfolioKnownShare: number;    // share of managers whose full league list was enumerated
  meanPortfolioCoverage: number | null;  // crawled/known league-seasons, among those
  bestBallShare: number;
  retentionCensoredShare: number | null;
  lineageSeasonGaps: number;

  // Population shape per season. A crawl that samples different kinds of league
  // in different seasons will show "drift" on every activity feature at once;
  // that is a property of the sample, not of the features, and it belongs here
  // rather than in the feature table.
  seasonComposition: {
    season: string;
    rows: number;
    leagueSeasons: number;
    bestBallShare: number;
    horizonWeeks: number | null;
    inProgress: boolean;
  }[];

  requiredFieldViolations: { field: string; rows: number }[];
  warnings: string[];
}

export interface FeatureAuditRow {
  name: string;
  kind: FeatureKind;
  eligibility: Eligibility;
  eligibilityReason: string;
  note?: string;
  summary: NumericSummary;
  degenerate: boolean;
  degenerateReason: string | null;
  dominantValueShare: number;
  // Degeneracy measured on the SCORABLE rows — the population a model actually
  // trains on. A feature can vary across the dataset and be constant there:
  // isBestBall is the standard case, since best ball is excluded from the label.
  degenerateInTraining: boolean;
  outOfRange: number;                    // values outside the declared bounds
  comparableAcrossLeagues: boolean;
  pointInTime: boolean;
  signalAuc: number;                     // vs the wentDark label
  direction: RiskDirection;
  expected: RiskDirection | null;
  directionOk: boolean | null;           // null when there is no hypothesis
  maxSeasonPsi: number;                  // worst season-vs-pooled drift
  stability: 'stable' | 'moderate' | 'significant' | 'n/a';
}

export interface InvariantResult {
  name: string;
  passed: boolean;
  violations: number;
  detail: string;
}

export interface CollinearPair {
  a: string;
  b: string;
  r: number;
}

export interface GroupConcentration {
  rows: number;
  groups: number;                  // distinct managers in the scorable set
  rowsInMultiRowGroups: number;
  multiRowShare: number;
  largestGroupRows: number;
  largestGroupShare: number;
}

export interface AuditReport {
  completeness: CompletenessReport;
  features: FeatureAuditRow[];
  managerLevel: ManagerAuditReport;
  // Rows from one manager are correlated, so a random row split puts the same
  // person in train and test. Reported so the split strategy is a decision
  // rather than an accident.
  groupConcentration: GroupConcentration;
  // Features declared safe that nonetheless separate the label strongly. The
  // declaration is a claim; this tests it.
  suspectedLeakage: { name: string; kind: FeatureKind; signalAuc: number }[];
  invariants: InvariantResult[];
  collinearPairs: CollinearPair[];
  label: { name: string; scorableRows: number; positives: number; baseRate: number };
  blocking: string[];    // problems that should stop a training run
}

// ── user-level (per-manager) features ──
//
// A separate surface from the manager-season rows above, with its own label and
// its own way of going wrong. The row-level features describe one team in one
// season; these describe a person across their whole portfolio, and they fail
// differently: not through leakage from a season's outcome, but through being
// computed on a 2% sample of the portfolio they claim to summarise.

export type ProfileAxis = 'volume' | 'mode' | 'persistence' | 'intensity' | 'sociality' | 'reliability' | 'evidence';

export interface ManagerFeatureSpec {
  name: string;
  kind: FeatureKind;
  axis: ProfileAxis;
  get: (p: EngagementProfile) => number | null;
  expect?: RiskDirection;
  note?: string;
}

export const MANAGER_FEATURES: ManagerFeatureSpec[] = [
  // Volume / mode / persistence are exact wherever the portfolio was
  // enumerated, and a sample of it where it was not. The provenance column in
  // the report says which, per population.
  { name: 'leagueSeasons', kind: 'static', axis: 'volume', get: (p) => p.leagueSeasons, expect: 'none' },
  { name: 'leaguesCurrentSeason', kind: 'static', axis: 'volume', get: (p) => p.leaguesCurrentSeason, expect: 'none' },
  { name: 'seasonsActive', kind: 'static', axis: 'volume', get: (p) => p.seasonsActive, expect: 'lower-risk' },
  { name: 'dynastyShare', kind: 'static', axis: 'mode', get: (p) => p.dynastyShare, expect: 'lower-risk' },
  { name: 'bestBallShare', kind: 'static', axis: 'mode', get: (p) => p.bestBallShare, expect: 'none' },
  { name: 'maxTenureSeasons', kind: 'static', axis: 'persistence', get: (p) => p.maxTenureSeasons, expect: 'lower-risk' },
  { name: 'retentionRate', kind: 'static', axis: 'persistence', get: (p) => p.retentionRate, expect: 'lower-risk' },

  // Intensity and sociality need transactions, so they are always computed on
  // the swept slice — never exact, however complete the enumeration is.
  { name: 'txnPerLeagueWeek', kind: 'time-varying', axis: 'intensity', get: (p) => p.txnPerLeagueWeek, expect: 'lower-risk' },
  { name: 'waiverShare', kind: 'time-varying', axis: 'intensity', get: (p) => p.waiverShare, expect: 'lower-risk' },
  { name: 'faabPerWaiver', kind: 'time-varying', axis: 'intensity', get: (p) => p.faabPerWaiver, expect: 'lower-risk' },
  { name: 'preseasonShare', kind: 'time-varying', axis: 'intensity', get: (p) => p.preseasonShare, expect: 'higher-risk',
    note: 'activity concentrated at the draft is the Draft-Day Enthusiast signature' },
  { name: 'lateSeasonShare', kind: 'time-varying', axis: 'intensity', get: (p) => p.lateSeasonShare, expect: 'lower-risk' },
  { name: 'tradesPerLeagueSeason', kind: 'time-varying', axis: 'sociality', get: (p) => p.tradesPerLeagueSeason, expect: 'lower-risk' },
  { name: 'partnerConcentration', kind: 'time-varying', axis: 'sociality', get: (p) => p.partnerConcentration, expect: 'none' },
  { name: 'commishShare', kind: 'time-varying', axis: 'intensity', get: (p) => p.commishShare, expect: 'lower-risk' },

  // Derived from the abandonment label. Legitimate as a prior-seasons feature
  // under an as-of guard; straight target leakage without one, and circular
  // against the everWentDark label used to screen signal here.
  { name: 'historicalAbandonmentRate', kind: 'label-derived', axis: 'reliability', get: (p) => p.historicalAbandonmentRate,
    note: 'requires asOfSeason; otherwise it sees the outcome it is meant to predict' },

  { name: 'evidenceWeight', kind: 'static', axis: 'evidence', get: (p) => p.evidenceWeight, expect: 'none',
    note: 'a shrinkage weight, not a behavioural feature' },
];

export interface ManagerFeatureAuditRow {
  name: string;
  kind: FeatureKind;
  axis: ProfileAxis;
  eligibility: Eligibility;
  eligibilityReason: string;
  note?: string;
  source: AxisSource | 'mixed';   // where this axis came from across the population
  summary: NumericSummary;
  degenerate: boolean;
  degenerateReason: string | null;
  signalAuc: number;              // vs everWentDark
  direction: RiskDirection;
  expected: RiskDirection | null;
  directionOk: boolean | null;
}

export interface ManagerAuditReport {
  managers: number;
  labelled: number;               // managers with at least one scorable season
  positives: number;              // managers who went dark at least once
  baseRate: number;
  portfolioEnumerated: number;    // managers whose full league list is known
  meanPortfolioSampled: number | null;   // swept share of the enumerated portfolio
  features: ManagerFeatureAuditRow[];
  warnings: string[];
}

// Association is only meaningful where the label is defined, so best-ball and
// never-started seasons are excluded — the same exclusions wentDark applies.
function scorable(rows: ManagerSeasonEngagement[]): ManagerSeasonEngagement[] {
  return rows.filter((r) => !r.format.bestBall && r.lastActiveWeek != null);
}

function dominantShare(values: number[]): number {
  if (!values.length) return 0;
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return Math.max(...counts.values()) / values.length;
}

function directionOf(a: number, minEffect: number): RiskDirection {
  if (!Number.isFinite(a)) return 'none';
  if (a > 0.5 + minEffect) return 'higher-risk';
  if (a < 0.5 - minEffect) return 'lower-risk';
  return 'none';
}

// Audit the per-manager profile surface.
//
// Profiles are built here rather than taken as input, so the audit measures
// exactly what a consumer would get from the same population — including the
// provenance of each axis, which is the thing most likely to be misread.
export function auditManagerFeatures(
  population: ManagerObservation[],
  specs: ManagerFeatureSpec[] = MANAGER_FEATURES,
  auditOpts: AuditOptions = {},
): ManagerAuditReport {
  const minEffect = auditOpts.minEffectSize ?? DEFAULT_MIN_EFFECT;
  const horizonWeek = (season: string) => auditOpts.horizonBySeason?.[season] ?? 17;
  const warnings: string[] = [];

  const built = population.map((m) => {
    const events = m.events ?? [];
    return {
      profile: engagementProfile(m.managerId, m.history ?? [], m.rows, events,
        tradesFromEvents(events), { horizonWeek, portfolio: m.portfolio }),
      // A manager is labelled only if at least one of their seasons is scorable.
      scorable: scorable(m.rows),
    };
  });

  const labelled = built.filter((b) => b.scorable.length > 0);
  // User-level label: did this manager go dark in ANY scorable season. Coarser
  // than the row-level label on purpose — it is what the documented plan needs
  // to validate segments against behaviour.
  const labels = labelled.map((b) => bool(b.scorable.some((r) => wentDark(r))));
  const positives = labels.reduce((s, v) => s + v, 0);

  const enumerated = built.filter((b) => b.profile.provenance.volume === 'portfolio');
  const sampledShares = enumerated
    .map((b) => b.profile.portfolioSampled)
    .filter((v): v is number => v !== null);
  const meanPortfolioSampled = sampledShares.length
    ? sampledShares.reduce((a, b) => a + b, 0) / sampledShares.length
    : null;

  if (!enumerated.length && population.length) {
    warnings.push('No manager has an enumerated portfolio, so every volume, mode and persistence figure below is computed from the crawled slice — typically a small fraction of the real portfolio. Run the crawl with portfolio enumeration before trusting them.');
  } else if (enumerated.length < population.length) {
    warnings.push(`Portfolio enumerated for ${enumerated.length}/${population.length} managers; the rest have volume, mode and persistence sampled from the crawled slice. Do not pool the two groups.`);
  }
  if (meanPortfolioSampled !== null && meanPortfolioSampled < 0.25) {
    warnings.push(`Only ${(meanPortfolioSampled * 100).toFixed(1)}% of the enumerated portfolios were actually swept, so intensity and sociality describe a small, non-random slice of each manager's play.`);
  }

  const features: ManagerFeatureAuditRow[] = specs.map((spec) => {
    const values = built.map((b) => spec.get(b.profile));
    const summary = summarize(values);
    const present = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

    const paired = labelled
      .map((b, i) => ({ v: spec.get(b.profile), y: labels[i] }))
      .filter((d): d is { v: number; y: number } => typeof d.v === 'number' && Number.isFinite(d.v));
    const signalAuc = paired.length >= 2 ? auc(paired.map((d) => d.v), paired.map((d) => d.y)) : NaN;

    const dominant = dominantShare(present);
    let degenerateReason: string | null = null;
    if (!present.length) degenerateReason = 'No usable values.';
    else if (summary.sd === 0) degenerateReason = 'Constant across every manager.';
    else if (dominant > 0.98) degenerateReason = `One value covers ${(dominant * 100).toFixed(1)}% of managers.`;

    const direction = directionOf(signalAuc, minEffect);
    const expected = spec.expect ?? null;
    const directionOk = expected === null || expected === 'none' || direction === 'none'
      ? null
      : direction === expected;

    // Axis provenance across the population: 'mixed' when some managers were
    // enumerated and others were not, which is the case worth flagging.
    const axisIsPortfolio = spec.axis === 'volume' || spec.axis === 'mode' || spec.axis === 'persistence';
    const source: AxisSource | 'mixed' = !axisIsPortfolio
      ? 'crawled'
      : enumerated.length === population.length ? 'portfolio'
        : enumerated.length === 0 ? 'crawled' : 'mixed';

    const el = ELIGIBILITY[spec.kind];
    return {
      name: spec.name,
      kind: spec.kind,
      axis: spec.axis,
      eligibility: el.eligibility,
      eligibilityReason: el.reason,
      note: spec.note,
      source,
      summary,
      degenerate: degenerateReason !== null,
      degenerateReason,
      signalAuc,
      direction,
      expected,
      directionOk,
    };
  });

  for (const f of features) {
    if (f.directionOk === false) {
      warnings.push(`Manager feature "${f.name}" is associated with abandonment in the opposite direction to the documented hypothesis (AUC ${f.signalAuc.toFixed(3)}, expected ${f.expected}). Treat as a bug until explained.`);
    }
    if (f.degenerate && f.eligibility !== 'ineligible') {
      warnings.push(`Manager feature "${f.name}" is degenerate: ${f.degenerateReason}`);
    }
  }

  return {
    managers: population.length,
    labelled: labelled.length,
    positives,
    baseRate: labelled.length ? positives / labelled.length : NaN,
    portfolioEnumerated: enumerated.length,
    meanPortfolioSampled,
    features,
    warnings,
  };
}

export function auditEngagement(
  population: ManagerObservation[],
  specs: FeatureSpec[] = ENGAGEMENT_FEATURES,
  auditOpts: AuditOptions = {},
): AuditReport {
  const minHorizon = auditOpts.minHorizonWeeks ?? DEFAULT_MIN_HORIZON;
  const minEffect = auditOpts.minEffectSize ?? DEFAULT_MIN_EFFECT;
  const horizonOf = (season: string) => auditOpts.horizonBySeason?.[season] ?? null;
  const inProgress = (season: string) => {
    const h = horizonOf(season);
    return h !== null && h < minHorizon;
  };
  const allRows = population.flatMap((m) => m.rows);
  const warnings: string[] = [];
  const blocking: string[] = [];

  // ── completeness ──

  const seasons = [...new Set(allRows.map((r) => r.season))].sort();
  const rowsBySeason: Record<string, number> = {};
  for (const r of allRows) rowsBySeason[r.season] = (rowsBySeason[r.season] ?? 0) + 1;

  const rowsByFormat: Record<string, number> = {};
  for (const r of allRows) {
    const key = r.format.bestBall ? 'Best Ball' : r.format.type;
    rowsByFormat[key] = (rowsByFormat[key] ?? 0) + 1;
  }

  const seasonComposition = seasons.map((season) => {
    const rs = allRows.filter((r) => r.season === season);
    return {
      season,
      rows: rs.length,
      leagueSeasons: new Set(rs.map((r) => r.leagueId)).size,
      bestBallShare: share(rs.filter((r) => r.format.bestBall).length, rs.length),
      horizonWeeks: horizonOf(season),
      inProgress: inProgress(season),
    };
  });

  // Composition shift is a sampling property, not feature drift — but it drives
  // apparent drift on every activity feature, so it is called out once here
  // instead of once per feature.
  const bbShares = seasonComposition.filter((s) => s.rows >= 30).map((s) => s.bestBallShare);
  const compositionShift = bbShares.length > 1 && Math.max(...bbShares) - Math.min(...bbShares) > 0.3;
  if (compositionShift) {
    warnings.push(`Best-ball share swings from ${(Math.min(...bbShares) * 100).toFixed(0)}% to ${(Math.max(...bbShares) * 100).toFixed(0)}% across seasons. The crawl sampled structurally different leagues per season, which will surface as apparent drift on activity features. Fix the sample, not the features.`);
  }

  const cappedManagers = population.filter((m) => m.sweep?.capped).length;
  if (cappedManagers > 0) {
    const msg = `${cappedManagers}/${population.length} managers hit the 700-week sweep cap — their oldest league-seasons are missing transactions and will read as inactive.`;
    warnings.push(msg);
    // Truncation is not a "maybe": it manufactures the exact pattern the
    // abandonment label looks for, so it blocks training rather than warning.
    if (cappedManagers / Math.max(1, population.length) > 0.1) blocking.push(msg);
  }

  const history = population.flatMap((m) => m.history ?? []);
  const statusByLeague = new Map(history.map((h) => [h.leagueId, h.status]));
  const unlaunched = (leagueId: string) => {
    const s = statusByLeague.get(leagueId);
    return s === 'pre_draft' || s === 'drafting';
  };

  // A zero-transaction row is only suspicious once the expected explanations
  // are stripped out. Best ball has no waivers and no lineups to set, and a
  // season that has barely started has had no chance yet — lumping either in
  // with "live league, no activity" produced a four-figure false alarm on the
  // first real crawl.
  const zeroTxn = allRows.filter((r) => r.txnCount === 0);
  const zeroTxnUnlaunched = zeroTxn.filter((r) => unlaunched(r.leagueId)).length;
  const zeroTxnBestBall = zeroTxn.filter((r) => !unlaunched(r.leagueId) && r.format.bestBall).length;
  const zeroTxnInProgress = zeroTxn.filter((r) =>
    !unlaunched(r.leagueId) && !r.format.bestBall && inProgress(r.season)).length;
  const zeroTxnUnexplained = zeroTxn.length - zeroTxnUnlaunched - zeroTxnBestBall - zeroTxnInProgress;
  if (zeroTxnUnexplained > 0) {
    warnings.push(`${zeroTxnUnexplained} row(s) are in a live, managed league in a completed season with no transactions at all — either genuinely dead teams or missing data.`);
  }

  const missingRosterIdRows = history.filter((h) => h.rosterId == null).length;

  const events = population.flatMap((m) => m.events ?? []);
  const missingTimestampShare = events.length
    ? events.filter((e) => !e.created).length / events.length
    : 0;
  if (missingTimestampShare > 0.05) {
    warnings.push(`${(missingTimestampShare * 100).toFixed(1)}% of transactions have no timestamp — weekday and attention-shape features are unreliable.`);
  }

  const nonBestBall = allRows.filter((r) => !r.format.bestBall);
  const startersCoverage = nonBestBall.length
    ? nonBestBall.filter((r) => r.emptyStarterSlots != null).length / nonBestBall.length
    : 0;
  if (startersCoverage < 1) {
    warnings.push(`Empty-slot coverage is ${(startersCoverage * 100).toFixed(0)}% — starters were not supplied for every league-season, so that feature is partly absent (not zero).`);
  }

  // Portfolio coverage. Absent coverage metadata is treated as unknown rather
  // than complete: assuming completeness is how biased profile features get
  // shipped as if they were sound.
  const known = population.filter((m) => m.coverage?.portfolioKnown);
  const portfolioKnownShare = population.length ? known.length / population.length : 0;
  const ratios = known
    .map((m) => (m.coverage!.knownLeagueSeasons > 0
      ? m.coverage!.crawledLeagueSeasons / m.coverage!.knownLeagueSeasons
      : null))
    .filter((v): v is number => v !== null);
  const meanPortfolioCoverage = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null;

  if (portfolioKnownShare < 1) {
    warnings.push(`Portfolio known for ${(portfolioKnownShare * 100).toFixed(0)}% of managers — profile-level features (league count, retention rate, historical abandonment rate) are biased for the rest and should be restricted to managers with a known portfolio. Manager-season features are unaffected.`);
  }
  if (meanPortfolioCoverage != null && meanPortfolioCoverage < 0.8) {
    warnings.push(`Even among managers with a known portfolio, only ${(meanPortfolioCoverage * 100).toFixed(0)}% of their league-seasons were crawled.`);
  }

  const retention = population.flatMap((m) => m.retention ?? []);
  const retentionCensoredShare = retention.length
    ? retention.filter((e) => e.returnedNextSeason === null).length / retention.length
    : null;

  // A lineage whose observed seasons skip a year: legitimate (a manager sat one
  // out) but it must not be read as two separate leagues.
  let lineageSeasonGaps = 0;
  const byLineage = new Map<string, number[]>();
  for (const r of allRows) {
    if (!byLineage.has(r.lineageId)) byLineage.set(r.lineageId, []);
    byLineage.get(r.lineageId)!.push(Number(r.season));
  }
  for (const yrs of byLineage.values()) {
    const sorted = [...new Set(yrs)].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) if (sorted[i] - sorted[i - 1] > 1) lineageSeasonGaps++;
  }

  const requiredFieldViolations = specs
    .filter((s) => s.required)
    .map((s) => ({ field: s.name, rows: allRows.filter((r) => s.get(r) == null).length }))
    .filter((v) => v.rows > 0);
  for (const v of requiredFieldViolations) {
    blocking.push(`Required feature "${v.field}" is null on ${v.rows} row(s).`);
  }

  const bestBallShare = allRows.length
    ? allRows.filter((r) => r.format.bestBall).length / allRows.length
    : 0;

  const completeness: CompletenessReport = {
    managers: population.length,
    managerSeasons: allRows.length,
    lineages: byLineage.size,
    seasons,
    rowsBySeason,
    rowsByFormat,
    managersWithCappedSweep: cappedManagers,
    cappedSweepShare: population.length ? cappedManagers / population.length : 0,
    zeroTxnRows: zeroTxn.length,
    zeroTxnUnlaunched,
    zeroTxnBestBall,
    zeroTxnInProgress,
    zeroTxnUnexplained,
    missingRosterIdRows,
    missingTimestampShare,
    startersCoverage,
    portfolioKnownShare,
    meanPortfolioCoverage,
    bestBallShare,
    retentionCensoredShare,
    lineageSeasonGaps,
    seasonComposition,
    requiredFieldViolations,
    warnings,
  };

  // ── label ──

  const labelRows = scorable(allRows);
  const labels = labelRows.map((r) => bool(wentDark(r)));
  const positives = labels.reduce((s, v) => s + v, 0);
  if (labelRows.length && (positives === 0 || positives === labelRows.length)) {
    blocking.push(`The abandonment label is degenerate: ${positives}/${labelRows.length} positives. Nothing can be learned or measured.`);
  }

  // ── per-feature audit ──

  const features: FeatureAuditRow[] = specs.map((spec) => {
    const raw = allRows.map((r) => spec.get(r));
    const summary = summarize(raw);
    const present = raw.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

    // Signal is measured only on rows where BOTH the feature and the label
    // exist, so a partly-absent feature isn't penalised for the gap.
    const paired = labelRows
      .map((r, i) => ({ v: spec.get(r), y: labels[i] }))
      .filter((d): d is { v: number; y: number } => typeof d.v === 'number' && Number.isFinite(d.v));
    const signalAuc = paired.length >= 2 ? auc(paired.map((d) => d.v), paired.map((d) => d.y)) : NaN;

    const dominantValueShare = dominantShare(present);
    let degenerateReason: string | null = null;
    if (!present.length) degenerateReason = 'No usable values.';
    else if (summary.sd === 0) degenerateReason = 'Constant across every row.';
    else if (dominantValueShare > 0.98) degenerateReason = `One value covers ${(dominantValueShare * 100).toFixed(1)}% of rows.`;

    // The same test, restricted to the rows a model would train on. A feature
    // can vary across the dataset and be constant there — best-ball flags are
    // the obvious case, since best ball is excluded from the label.
    const trainingValues = labelRows
      .map((r) => spec.get(r))
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const degenerateInTraining = trainingValues.length > 0
      && trainingValues.every((v) => v === trainingValues[0]);

    const outOfRange = spec.range
      ? present.filter((v) => v < spec.range![0] || v > spec.range![1]).length
      : 0;

    // Stability: each season against every OTHER season, not against the pooled
    // distribution — a pooled reference contains the season being tested, which
    // shrinks the apparent drift of the largest seasons and hides real shifts.
    //
    // MIN_SEASON_SAMPLE keeps this honest: a PSI computed on a handful of rows
    // is noise, and reporting it as "significant drift" trains people to ignore
    // the whole column.
    // Stability is measured on the SCORABLE rows — the population a model
    // would actually train on — and skips seasons still in progress. Measured
    // over all rows instead, a crawl whose format mix shifts by season reports
    // significant drift on nearly every feature at once, which is composition
    // shift wearing a feature-drift costume.
    let maxSeasonPsi = NaN;
    const stableSeasons = seasons.filter((s) => !inProgress(s));
    if (stableSeasons.length > 1) {
      const valueFor = (predicate: (season: string) => boolean) => labelRows
        .filter((r) => predicate(r.season))
        .map((r) => spec.get(r))
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

      const perSeason: number[] = [];
      for (const s of stableSeasons) {
        const inSeason = valueFor((x) => x === s);
        const others = valueFor((x) => x !== s && !inProgress(x));
        if (inSeason.length < MIN_SEASON_SAMPLE || others.length < MIN_SEASON_SAMPLE) continue;
        const value = psi(others, inSeason);
        if (Number.isFinite(value)) perSeason.push(value);
      }
      if (perSeason.length) maxSeasonPsi = Math.max(...perSeason);
    }
    const stability: FeatureAuditRow['stability'] = !Number.isFinite(maxSeasonPsi)
      ? 'n/a'
      : maxSeasonPsi > 0.25 ? 'significant' : maxSeasonPsi > 0.1 ? 'moderate' : 'stable';

    const direction = directionOf(signalAuc, minEffect);
    const expected = spec.expect ?? null;
    // Only a genuine contradiction counts. "Expected an effect, measured none"
    // is weak evidence, not a bug, so it does not fail the check.
    const directionOk = expected === null || expected === 'none' || direction === 'none'
      ? null
      : direction === expected;

    const el = ELIGIBILITY[spec.kind];
    return {
      name: spec.name,
      kind: spec.kind,
      eligibility: el.eligibility,
      eligibilityReason: el.reason,
      note: spec.note,
      summary,
      degenerate: degenerateReason !== null,
      degenerateReason,
      dominantValueShare,
      degenerateInTraining,
      outOfRange,
      comparableAcrossLeagues: spec.comparableAcrossLeagues !== false,
      pointInTime: spec.pointInTime === true,
      signalAuc,
      direction,
      expected,
      directionOk,
      maxSeasonPsi,
      stability,
    };
  });

  const drifting: string[] = [];
  for (const f of features) {
    if (f.directionOk === false) {
      warnings.push(`Feature "${f.name}" is associated with abandonment in the opposite direction to the documented hypothesis (AUC ${f.signalAuc.toFixed(3)}, expected ${f.expected}). Treat as a bug until explained.`);
    }
    if (f.degenerate && f.eligibility !== 'ineligible') {
      warnings.push(`Feature "${f.name}" is degenerate: ${f.degenerateReason}`);
    }
    if (f.degenerateInTraining && !f.degenerate && f.eligibility !== 'ineligible') {
      blocking.push(`Feature "${f.name}" varies across the dataset but is CONSTANT on the scorable rows a model would train on — it carries no information for this label.`);
    }
    if (f.outOfRange > 0) {
      blocking.push(`Feature "${f.name}" has ${f.outOfRange} value(s) outside its declared range — a parsing or upstream fault, not an outlier.`);
    }
    if (!f.comparableAcrossLeagues && f.eligibility !== 'ineligible') {
      warnings.push(`Feature "${f.name}" is not comparable across leagues: its scale depends on a league setting the crawl does not capture, so the same number means different things in different leagues.${f.note ? ` ${f.note}.` : ''}`);
    }
    if (f.pointInTime && f.eligibility !== 'ineligible') {
      warnings.push(`Feature "${f.name}" is a point-in-time snapshot being used as a season-level measure.${f.note ? ` ${f.note}.` : ''}`);
    }
    // Drift on a column the model cannot use is not actionable, so it is
    // recorded in the table but does not raise a warning.
    if (f.stability === 'significant' && f.eligibility !== 'ineligible') drifting.push(f.name);
  }

  // When the sample composition already shifts by season, per-feature drift is
  // that one cause restated once per column. Thirteen warnings saying the same
  // thing is how a report stops being read, so it collapses to one line that
  // names the likely cause and points at the table for detail.
  if (drifting.length) {
    if (compositionShift) {
      warnings.push(`${drifting.length} model-usable feature(s) shift significantly between seasons (${drifting.join(', ')}). The season-composition shift above is the likely cause — check it before treating these as feature problems.`);
    } else {
      for (const name of drifting) {
        const f = features.find((x) => x.name === name)!;
        warnings.push(`Feature "${name}" shifts significantly between seasons (PSI ${f.maxSeasonPsi.toFixed(2)}).`);
      }
    }
  }

  // ── invariants ──

  const bb = allRows.filter((r) => r.format.bestBall);
  const invariant = (name: string, violations: number, detail: string): InvariantResult =>
    ({ name, passed: violations === 0, violations, detail });

  const invariants: InvariantResult[] = [
    invariant('best-ball rows carry no empty-slot value',
      bb.filter((r) => r.emptyStarterSlots !== null).length,
      'Best ball auto-starts lineups, so an empty-slot count there is meaningless and would be learned as signal.'),
    invariant('best-ball rows are flagged lineup-invalid',
      bb.filter((r) => r.lineupSignalsValid).length,
      'lineupSignalsValid must be false for best ball so downstream code can mask lineup features.'),
    invariant('best-ball rows are never labelled abandoned',
      bb.filter((r) => wentDark(r)).length,
      'No in-season management is expected in best ball, so the label does not apply.'),
    invariant('active weeks are sorted and unique',
      allRows.filter((r) => r.activeWeeks.some((w, i) => i > 0 && w <= r.activeWeeks[i - 1])).length,
      'Downstream gap arithmetic assumes ascending, de-duplicated weeks.'),
    invariant('last active week is not before the first',
      allRows.filter((r) => r.firstActiveWeek != null && r.lastActiveWeek != null && r.lastActiveWeek < r.firstActiveWeek).length,
      'A reversed span means the week bucketing broke.'),
    invariant('typed transaction counts do not exceed the total',
      allRows.filter((r) => r.waiverCount + r.freeAgentCount + r.tradeCount + r.commishCount > r.txnCount).length,
      'Typed counts partition txnCount (plus an untyped remainder), so they can never sum above it.'),
    invariant('no negative counts',
      allRows.filter((r) => r.txnCount < 0 || r.addCount < 0 || r.dropCount < 0 || r.faabSpent < 0).length,
      'Negative volume means a parsing fault in the sweep.'),
    invariant('every row resolves to a lineage',
      allRows.filter((r) => !r.lineageId).length,
      'A missing lineage id breaks tenure and retention labelling.'),
  ];

  for (const inv of invariants) {
    if (!inv.passed) blocking.push(`Invariant failed — ${inv.name} (${inv.violations} row(s)). ${inv.detail}`);
  }

  // ── collinearity, over model-usable features only ──

  const usable = features.filter((f) => f.eligibility !== 'ineligible' && !f.degenerate);
  const bySpec = new Map(specs.map((s) => [s.name, s]));
  const collinearPairs: CollinearPair[] = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const sa = bySpec.get(usable[i].name)!;
      const sb = bySpec.get(usable[j].name)!;
      const pairs = allRows
        .map((r) => [sa.get(r), sb.get(r)] as [number | null, number | null])
        .filter((d): d is [number, number] => typeof d[0] === 'number' && typeof d[1] === 'number');
      if (pairs.length < 3) continue;
      const r = pearson(pairs.map((d) => d[0]), pairs.map((d) => d[1]));
      if (Number.isFinite(r) && Math.abs(r) >= 0.9) {
        collinearPairs.push({ a: usable[i].name, b: usable[j].name, r });
      }
    }
  }
  collinearPairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));

  // Group concentration. Rows from one manager are correlated — same person,
  // same habits — so a random row split trains and tests on them both.
  const managerOfRow = new Map<ManagerSeasonEngagement, string>();
  for (const m of population) for (const r of m.rows) managerOfRow.set(r, m.managerId);
  const groupCounts = new Map<string, number>();
  for (const r of labelRows) {
    const g = managerOfRow.get(r) ?? '';
    groupCounts.set(g, (groupCounts.get(g) ?? 0) + 1);
  }
  const counts = [...groupCounts.values()];
  const rowsInMultiRowGroups = counts.filter((n) => n > 1).reduce((a, b) => a + b, 0);
  const largestGroupRows = counts.length ? Math.max(...counts) : 0;
  const groupConcentration: GroupConcentration = {
    rows: labelRows.length,
    groups: groupCounts.size,
    rowsInMultiRowGroups,
    multiRowShare: share(rowsInMultiRowGroups, labelRows.length),
    largestGroupRows,
    largestGroupShare: share(largestGroupRows, labelRows.length),
  };
  if (groupConcentration.multiRowShare > 0.2) {
    warnings.push(`${(groupConcentration.multiRowShare * 100).toFixed(0)}% of scorable rows come from managers with more than one row. Split by manager (groupKFold), not by row, or the same person appears in train and test.`);
  }
  if (groupConcentration.largestGroupShare > 0.02) {
    warnings.push(`One manager accounts for ${(groupConcentration.largestGroupShare * 100).toFixed(1)}% of scorable rows (${groupConcentration.largestGroupRows}). A single person's habits can move a headline metric on their own.`);
  }

  // Empirical leakage screen. Eligibility is a declaration; this tests it. A
  // feature claimed knowable at prediction time that separates the label this
  // strongly is far more likely to be mislabelled than to be a great feature.
  const LEAKAGE_AUC = 0.75;
  const suspectedLeakage = features
    .filter((f) => f.eligibility === 'eligible'
      && Number.isFinite(f.signalAuc) && Math.abs(f.signalAuc - 0.5) >= LEAKAGE_AUC - 0.5)
    .map((f) => ({ name: f.name, kind: f.kind, signalAuc: f.signalAuc }));
  for (const s of suspectedLeakage) {
    blocking.push(`Feature "${s.name}" is declared eligible but separates the label at AUC ${s.signalAuc.toFixed(3)}. Verify it is genuinely knowable at prediction time before using it — a declaration is a claim, not evidence.`);
  }

  return {
    completeness: { ...completeness, warnings },
    features,
    managerLevel: auditManagerFeatures(population, MANAGER_FEATURES, auditOpts),
    groupConcentration,
    suspectedLeakage,
    invariants,
    collinearPairs,
    label: {
      name: 'wentDark',
      scorableRows: labelRows.length,
      positives,
      baseRate: labelRows.length ? positives / labelRows.length : NaN,
    },
    blocking,
  };
}
