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
import { wentDark, type ManagerSeasonEngagement } from './engagement';
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
  note?: string;
}

// A season needs at least this many usable rows before its drift figure means
// anything. Below it, stability is reported as n/a rather than guessed.
const MIN_SEASON_SAMPLE = 30;

const bool = (b: boolean): number => (b ? 1 : 0);

// The engagement feature surface, declared once so eligibility is derived
// rather than remembered.
export const ENGAGEMENT_FEATURES: FeatureSpec[] = [
  // ── static ──
  { name: 'totalRosters', kind: 'static', get: (r) => r.totalRosters, expect: 'none', required: true },
  { name: 'isDynasty', kind: 'static', get: (r) => bool(r.format.type === 'Dynasty'), expect: 'lower-risk',
    note: 'dynasty managers have standing assets, so less reason to walk away mid-season' },
  { name: 'isBestBall', kind: 'static', get: (r) => bool(r.format.bestBall), expect: 'none',
    note: 'excluded from the abandonment label entirely; kept for slicing' },
  { name: 'isSuperflex', kind: 'static', get: (r) => bool(r.format.qb === 'Superflex'), expect: 'none' },

  // ── time-varying (safe only as running-to-date values) ──
  { name: 'txnCount', kind: 'time-varying', get: (r) => r.txnCount, expect: 'lower-risk', required: true },
  { name: 'waiverCount', kind: 'time-varying', get: (r) => r.waiverCount, expect: 'lower-risk' },
  { name: 'freeAgentCount', kind: 'time-varying', get: (r) => r.freeAgentCount, expect: 'lower-risk' },
  { name: 'tradeCount', kind: 'time-varying', get: (r) => r.tradeCount, expect: 'lower-risk' },
  { name: 'commishCount', kind: 'time-varying', get: (r) => r.commishCount, expect: 'lower-risk' },
  { name: 'failedCount', kind: 'time-varying', get: (r) => r.failedCount, expect: 'lower-risk',
    note: 'a lost bid is still evidence of attention' },
  { name: 'addCount', kind: 'time-varying', get: (r) => r.addCount, expect: 'lower-risk' },
  { name: 'dropCount', kind: 'time-varying', get: (r) => r.dropCount, expect: 'lower-risk' },
  { name: 'faabSpent', kind: 'time-varying', get: (r) => r.faabSpent, expect: 'lower-risk' },
  { name: 'longestSilentRun', kind: 'time-varying', get: (r) => r.longestSilentRun, expect: 'higher-risk',
    note: 'internal gaps only, so this is a behavioural pattern rather than the label' },
  { name: 'emptyStarterSlots', kind: 'time-varying', get: (r) => r.emptyStarterSlots, expect: 'higher-risk',
    note: 'null by design for best ball and when starters were not supplied' },

  // ── season-final: cannot feed a week-w prediction ──
  { name: 'wins', kind: 'season-final', get: (r) => r.wins, expect: 'lower-risk' },
  { name: 'losses', kind: 'season-final', get: (r) => r.losses, expect: 'higher-risk' },
  { name: 'regSeasonRank', kind: 'season-final', get: (r) => r.regSeasonRank, expect: 'higher-risk' },
  { name: 'pointsFor', kind: 'season-final', get: (r) => r.pointsFor, expect: 'lower-risk' },
  { name: 'champion', kind: 'season-final', get: (r) => bool(r.champion), expect: 'lower-risk' },

  // ── label-derived: never features ──
  { name: 'lastActiveWeek', kind: 'label-derived', get: (r) => r.lastActiveWeek },
  { name: 'trailingSilentWeeks', kind: 'label-derived', get: (r) => r.trailingSilentWeeks },
  { name: 'activeWeekCount', kind: 'label-derived', get: (r) => r.activeWeeks.length },
];

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

// One crawled manager. Matches what a league-oriented crawl produces per
// manager, so the audit can run on a single user or a full population.
export interface ManagerObservation {
  managerId: string;
  rows: ManagerSeasonEngagement[];
  history?: LeagueSeasonRecord[];
  events?: TxnEvent[];
  sweep?: { capped: boolean; weeksScanned: number };
  retention?: RetentionEvent[];
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
  zeroTxnLaunched: number;        // a live league with no activity: idle or truncated
  missingRosterIdRows: number;
  missingTimestampShare: number;  // events with created === 0
  startersCoverage: number;       // share of non-best-ball rows with an empty-slot value
  bestBallShare: number;
  retentionCensoredShare: number | null;
  lineageSeasonGaps: number;

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

export interface AuditReport {
  completeness: CompletenessReport;
  features: FeatureAuditRow[];
  invariants: InvariantResult[];
  collinearPairs: CollinearPair[];
  label: { name: string; scorableRows: number; positives: number; baseRate: number };
  blocking: string[];    // problems that should stop a training run
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

function directionOf(a: number): RiskDirection {
  if (!Number.isFinite(a)) return 'none';
  if (a > 0.52) return 'higher-risk';
  if (a < 0.48) return 'lower-risk';
  return 'none';
}

export function auditEngagement(
  population: ManagerObservation[],
  specs: FeatureSpec[] = ENGAGEMENT_FEATURES,
): AuditReport {
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

  const zeroTxn = allRows.filter((r) => r.txnCount === 0);
  const zeroTxnUnlaunched = zeroTxn.filter((r) => unlaunched(r.leagueId)).length;
  const zeroTxnLaunched = zeroTxn.length - zeroTxnUnlaunched;

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
    zeroTxnLaunched,
    missingRosterIdRows,
    missingTimestampShare,
    startersCoverage,
    bestBallShare,
    retentionCensoredShare,
    lineageSeasonGaps,
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

    // Stability: each season against every OTHER season, not against the pooled
    // distribution — a pooled reference contains the season being tested, which
    // shrinks the apparent drift of the largest seasons and hides real shifts.
    //
    // MIN_SEASON_SAMPLE keeps this honest: a PSI computed on a handful of rows
    // is noise, and reporting it as "significant drift" trains people to ignore
    // the whole column.
    let maxSeasonPsi = NaN;
    if (seasons.length > 1 && present.length >= 2 * MIN_SEASON_SAMPLE) {
      const valueFor = (predicate: (season: string) => boolean) => allRows
        .filter((r) => predicate(r.season))
        .map((r) => spec.get(r))
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

      const perSeason: number[] = [];
      for (const s of seasons) {
        const inSeason = valueFor((x) => x === s);
        const others = valueFor((x) => x !== s);
        if (inSeason.length < MIN_SEASON_SAMPLE || others.length < MIN_SEASON_SAMPLE) continue;
        const value = psi(others, inSeason);
        if (Number.isFinite(value)) perSeason.push(value);
      }
      if (perSeason.length) maxSeasonPsi = Math.max(...perSeason);
    }
    const stability: FeatureAuditRow['stability'] = !Number.isFinite(maxSeasonPsi)
      ? 'n/a'
      : maxSeasonPsi > 0.25 ? 'significant' : maxSeasonPsi > 0.1 ? 'moderate' : 'stable';

    const direction = directionOf(signalAuc);
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
      signalAuc,
      direction,
      expected,
      directionOk,
      maxSeasonPsi,
      stability,
    };
  });

  for (const f of features) {
    if (f.directionOk === false) {
      warnings.push(`Feature "${f.name}" is associated with abandonment in the opposite direction to the documented hypothesis (AUC ${f.signalAuc.toFixed(3)}, expected ${f.expected}). Treat as a bug until explained.`);
    }
    if (f.degenerate && f.eligibility !== 'ineligible') {
      warnings.push(`Feature "${f.name}" is degenerate: ${f.degenerateReason}`);
    }
    // Drift on a column the model cannot use is not actionable, so it is
    // recorded in the table but does not raise a warning.
    if (f.stability === 'significant' && f.eligibility !== 'ineligible') {
      warnings.push(`Feature "${f.name}" shifts significantly between seasons (PSI ${f.maxSeasonPsi.toFixed(2)}).`);
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

  return {
    completeness: { ...completeness, warnings },
    features,
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
