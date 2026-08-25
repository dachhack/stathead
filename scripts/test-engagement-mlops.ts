// Test script: eval metrics + the data-completeness / feature audit.
// Run: npx tsx scripts/test-engagement-mlops.ts
//
// Known-answer tests throughout — every metric is checked against a value
// computed by hand, not against its own output from a previous run. The audit
// is checked by feeding it data that is deliberately broken in one specific way
// and asserting it says so.
import {
  auc, brier, logLoss, brierSkillScore, pearson, psi, driftReport,
  reliabilityBins, calibrationCurve, concordance, groupKFold,
  fitLogistic, logisticPredict, summarize,
} from '../src/lib/evalMetrics';
import { auditEngagement, ENGAGEMENT_FEATURES, type ManagerObservation, type FeatureSpec } from '../src/lib/featureAudit';
import { managerSeasonEngagement } from '../src/lib/engagement';
import type { ManagerSeasonEngagement } from '../src/lib/engagement';
import type { LeagueSeasonRecord, TxnEvent, LeagueFormatInfo } from '../src/lib/sleeper';

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; return; }
  failures.push(`${name}${detail === undefined ? '' : ` — got ${JSON.stringify(detail)}`}`);
}
function near(name: string, actual: number, expected: number, tol = 1e-6) {
  check(name, Number.isFinite(actual) && Math.abs(actual - expected) <= tol, actual);
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), actual);
}

// ── AUC ──
{
  // Hand-computed: positives {0.35, 0.8}, negatives {0.1, 0.4}.
  // Winning pairs: .35>.1, .8>.1, .8>.4 → 3 of 4.
  near('auc: hand-computed case', auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1]), 0.75);
  near('auc: perfect separation', auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  near('auc: perfectly inverted', auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1]), 0);
  // Tie handling is the reason this isn't the trapezoid sweep used elsewhere:
  // a constant predictor must score exactly 0.5, not 1.0.
  near('auc: constant predictor scores 0.5', auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]), 0.5);
  // One tied pair (0.5) plus one clean win (1.0) → 1.5/2.
  near('auc: partial ties get half credit', auc([1, 1, 0], [1, 0, 0]), 0.75);
  check('auc: undefined with no positives', Number.isNaN(auc([0.1, 0.2], [0, 0])));
  check('auc: undefined with no negatives', Number.isNaN(auc([0.1, 0.2], [1, 1])));
}

// ── proper scoring rules ──
{
  near('brier: perfect predictions', brier([1, 0], [1, 0]), 0);
  near('brier: maximally wrong', brier([0, 1], [1, 0]), 1);
  near('brier: coin flip', brier([0.5, 0.5], [1, 0]), 0.25);
  near('logLoss: coin flip is ln 2', logLoss([0.5, 0.5], [1, 0]), Math.LN2);
  near('logLoss: confident and right', logLoss([0.99, 0.01], [1, 0]), -Math.log(0.99));
  check('logLoss: confident and wrong is finite, not Infinity', Number.isFinite(logLoss([0, 1], [1, 0])));
  near('brierSkillScore: half the reference error', brierSkillScore(0.1, 0.2), 0.5);
  near('brierSkillScore: no better than reference', brierSkillScore(0.2, 0.2), 0);
  check('brierSkillScore: worse than reference goes negative', brierSkillScore(0.4, 0.2) < 0);
}

// ── correlation ──
{
  near('pearson: identical series', pearson([1, 2, 3, 4], [1, 2, 3, 4]), 1);
  near('pearson: mirrored series', pearson([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  near('pearson: scale invariant', pearson([1, 2, 3], [10, 20, 30]), 1);
  check('pearson: constant column has no correlation', Number.isNaN(pearson([1, 1, 1], [1, 2, 3])));
}

// ── PSI ──
{
  const ref = Array.from({ length: 200 }, (_, i) => i);
  check('psi: identical samples are stable', psi(ref, [...ref]) < 0.01, psi(ref, [...ref]));
  const shifted = ref.map((x) => x + 200);
  check('psi: disjoint samples are significant', psi(ref, shifted) > 0.25, psi(ref, shifted));

  // Regression guard: a low-cardinality feature where the current sample sits
  // entirely in one bin used to hit the epsilon floor and report double-digit
  // PSI — catastrophic-looking drift that was really just an empty bucket.
  const collapsed = psi(ref, new Array(50).fill(0));
  check('psi: an empty bin stays finite', Number.isFinite(collapsed), collapsed);
  check('psi: an empty bin stays in a plausible range', collapsed < 5, collapsed);

  // Smoothing must scale with sample size: the same shape at a larger n is
  // penalised more, because the emptiness is better evidenced.
  const small = psi(ref, new Array(10).fill(0));
  check('psi: bigger samples give more confident drift', collapsed > small, { collapsed, small });

  const drift = driftReport({ a: ref, b: ref }, { a: [...ref], b: shifted });
  eq('driftReport: sorted worst-first', drift.map((d) => d.feature), ['b', 'a']);
  eq('driftReport: severity labels', drift.map((d) => d.severity), ['significant', 'stable']);
}

// ── calibration ──
{
  // Ten deciles of 100 rows each, where the observed rate exactly equals the
  // predicted probability. A calibrated model must score ECE 0, slope 1.
  const probs: number[] = [];
  const labels: number[] = [];
  for (let d = 0; d < 10; d++) {
    const p = 0.05 + d * 0.1;
    const positives = Math.round(p * 100);
    for (let i = 0; i < 100; i++) { probs.push(p); labels.push(i < positives ? 1 : 0); }
  }
  const bins = reliabilityBins(probs, labels, 10);
  eq('reliabilityBins: equal-count bins', bins.map((b) => b.n), new Array(10).fill(100));
  const cal = calibrationCurve(probs, labels, 10);
  check('calibration: perfectly calibrated data has ~zero ECE', cal.ece < 0.005, cal.ece);
  check('calibration: slope ~1', Math.abs(cal.slope - 1) < 0.05, cal.slope);
  check('calibration: intercept ~0', Math.abs(cal.intercept) < 0.05, cal.intercept);

  // Over-confident: push every prediction toward its extreme, leave the truth
  // alone. Slope must drop below 1, which is the signature of over-fitting.
  const over = probs.map((p) => Math.min(0.999, Math.max(0.001, (p - 0.5) * 2 + 0.5)));
  const overCal = calibrationCurve(over, labels, 10);
  check('calibration: over-confidence shows as slope < 1', overCal.slope < 0.9, overCal.slope);
  check('calibration: over-confidence inflates ECE', overCal.ece > cal.ece, overCal.ece);
}

// ── survival concordance ──
{
  near('concordance: higher risk failed first', concordance([
    { time: 2, event: true, risk: 0.9 },
    { time: 5, event: true, risk: 0.1 },
  ]), 1);
  near('concordance: risks backwards', concordance([
    { time: 2, event: true, risk: 0.1 },
    { time: 5, event: true, risk: 0.9 },
  ]), 0);
  near('concordance: tied risk gets half credit', concordance([
    { time: 2, event: true, risk: 0.5 },
    { time: 5, event: true, risk: 0.5 },
  ]), 0.5);
  // Censored before the other's event: we cannot know who failed first, so the
  // pair is not comparable. This is why plain AUC can't stand in for C.
  check('concordance: censoring makes a pair unorderable', Number.isNaN(concordance([
    { time: 2, event: false, risk: 0.9 },
    { time: 5, event: true, risk: 0.1 },
  ])));
  check('concordance: two censored rows are unorderable', Number.isNaN(concordance([
    { time: 2, event: false, risk: 0.9 },
    { time: 5, event: false, risk: 0.1 },
  ])));
  // Censored AFTER the other's event is orderable: the survivor outlived it.
  near('concordance: censored after an event is comparable', concordance([
    { time: 2, event: true, risk: 0.9 },
    { time: 9, event: false, risk: 0.1 },
  ]), 1);
}

// ── grouped CV ──
{
  const groups = ['m1', 'm1', 'm2', 'm3', 'm2', 'm4'];
  const folds = groupKFold(groups, 2);
  const byGroup = new Map<string, Set<number>>();
  groups.forEach((g, i) => {
    if (!byGroup.has(g)) byGroup.set(g, new Set());
    byGroup.get(g)!.add(folds[i]);
  });
  check('groupKFold: a group never straddles folds', [...byGroup.values()].every((s) => s.size === 1));
  eq('groupKFold: deterministic across calls', groupKFold(groups, 2), folds);
  eq('groupKFold: uses every fold', new Set(folds).size, 2);
}

// ── logistic regression ──
{
  // Intercept-only fit on a known base rate must recover logit(0.25).
  const y = Array.from({ length: 100 }, (_, i) => (i < 25 ? 1 : 0));
  const interceptOnly = fitLogistic(y.map(() => []), y, { lambda: 0 });
  near('fitLogistic: recovers logit of the base rate', interceptOnly.intercept, Math.log(0.25 / 0.75), 1e-4);
  check('fitLogistic: converged', interceptOnly.converged);

  // A monotone feature must get a positive coefficient, and the fitted
  // probability must rise with it.
  const x = Array.from({ length: 200 }, (_, i) => [i / 200]);
  const yMono = x.map(([v]) => (v > 0.5 ? 1 : 0));
  const fit = fitLogistic(x, yMono, { lambda: 1, featureNames: ['v'] });
  check('fitLogistic: positive slope on a positively-associated feature', fit.coefficients[0] > 0, fit.coefficients[0]);
  check('fitLogistic: prediction increases with the feature',
    logisticPredict(fit, [0.9]) > logisticPredict(fit, [0.1]));
  check('fitLogistic: predictions stay probabilities',
    [0, 0.5, 1, 50, -50].every((v) => { const p = logisticPredict(fit, [v]); return p >= 0 && p <= 1; }));
  // Separable data would send coefficients to infinity unpenalised; the L2
  // term and the IRLS weight floor must keep it finite.
  check('fitLogistic: separable data stays finite', Number.isFinite(fit.coefficients[0]));
  eq('fitLogistic: empty input is handled', fitLogistic([], [], {}).n, 0);
}

// ── summarize ──
{
  const s = summarize([1, 2, 3, 4, null, undefined, NaN]);
  eq('summarize: counts every slot', s.n, 7);
  eq('summarize: counts unusable slots', s.nulls, 3);
  near('summarize: coverage', s.coverage, 4 / 7);
  near('summarize: mean over usable values', s.mean, 2.5);
  eq('summarize: min/max', [s.min, s.max], [1, 4]);
  const empty = summarize([null, null]);
  eq('summarize: no usable values gives zero coverage', empty.coverage, 0);
  check('summarize: no usable values gives NaN mean', Number.isNaN(empty.mean));
}

// ── audit fixtures ──

const fmt = (over: Partial<LeagueFormatInfo> = {}): LeagueFormatInfo =>
  ({ type: 'Redraft', qb: '1QB', bestBall: false, idp: false, ...over });

const hist = (over: Partial<LeagueSeasonRecord>): LeagueSeasonRecord => ({
  season: '2025', leagueId: 'L1', previousLeagueId: null, leagueName: 'League', status: 'complete',
  format: fmt(), totalRosters: 12, rosterId: 1, wins: 7, losses: 7, ties: 0, pointsFor: 1500,
  regSeasonRank: 5, champion: false, runnerUp: false, players: [], ...over,
});

const txn = (over: Partial<TxnEvent>): TxnEvent => ({
  leagueId: 'L1', season: '2025', week: 3, created: Date.UTC(2025, 8, 10),
  kind: 'free_agent', status: 'complete', adds: [], drops: [], faabBid: 0, partners: [], ...over,
});

// A manager with a mix of quitters and stayers, so the label is non-degenerate.
function buildManager(id: string, opts: { quits?: boolean; bestBall?: boolean; capped?: boolean; status?: string } = {}): ManagerObservation {
  const history = ['2024', '2025'].map((season, i) => hist({
    season, leagueId: `${id}-${season}`, previousLeagueId: i ? `${id}-2024` : null,
    format: fmt({ bestBall: opts.bestBall }), status: opts.status ?? 'complete',
  }));
  const lastWeek = opts.quits ? 3 : 16;
  const events = history.flatMap((h) =>
    Array.from({ length: lastWeek }, (_, w) => txn({ leagueId: h.leagueId, season: h.season, week: w + 1 })));
  return {
    managerId: id,
    rows: managerSeasonEngagement(history, events, { horizonWeek: 17 }),
    history,
    events,
    sweep: { capped: opts.capped ?? false, weeksScanned: 36 },
  };
}

const healthy: ManagerObservation[] = [
  ...Array.from({ length: 8 }, (_, i) => buildManager(`stay${i}`)),
  ...Array.from({ length: 4 }, (_, i) => buildManager(`quit${i}`, { quits: true })),
];

// ── audit: eligibility is derived, not remembered ──
{
  const report = auditEngagement(healthy);
  const by = new Map(report.features.map((f) => [f.name, f]));

  eq('audit: static features are eligible', by.get('totalRosters')?.eligibility, 'eligible');
  eq('audit: season totals are only conditionally eligible', by.get('txnCount')?.eligibility, 'conditional');
  eq('audit: season-final outcomes are ineligible', by.get('regSeasonRank')?.eligibility, 'ineligible');
  eq('audit: label-derived fields are ineligible', by.get('trailingSilentWeeks')?.eligibility, 'ineligible');
  check('audit: label-derived exclusion names target leakage',
    (by.get('lastActiveWeek')?.eligibilityReason ?? '').includes('target leakage'));
  check('audit: season-final exclusion names prediction-time leakage',
    (by.get('wins')?.eligibilityReason ?? '').includes('prediction-time leakage'));
  check('audit: no eligible feature is label-derived',
    report.features.filter((f) => f.eligibility !== 'ineligible').every((f) => f.kind !== 'label-derived'));

  // The audit must show WHY those columns are tempting: they separate perfectly.
  check('audit: the leaked column has near-perfect signal',
    (by.get('trailingSilentWeeks')?.signalAuc ?? 0) > 0.99, by.get('trailingSilentWeeks')?.signalAuc);

  eq('audit: label is non-degenerate on healthy input', report.blocking, []);
  eq('audit: label counts quitters', report.label.positives, 8);   // 4 managers × 2 seasons
  eq('audit: scorable rows exclude nothing here', report.label.scorableRows, 24);
}

// ── audit: broken best-ball masking is caught ──
{
  const broken = buildManager('bb', { bestBall: true });
  // Simulate the mask breaking downstream.
  broken.rows = broken.rows.map((r) => ({ ...r, emptyStarterSlots: 2, lineupSignalsValid: true }));
  const report = auditEngagement([...healthy, broken]);

  const slots = report.invariants.find((i) => i.name.includes('empty-slot value'))!;
  check('audit: catches an empty-slot value on best ball', !slots.passed && slots.violations === 2, slots);
  const flag = report.invariants.find((i) => i.name.includes('lineup-invalid'))!;
  check('audit: catches a best-ball row flagged lineup-valid', !flag.passed);
  check('audit: a failed invariant blocks the run',
    report.blocking.some((b) => b.includes('empty-slot')), report.blocking);
}

// ── audit: truncated sweep blocks, a little truncation only warns ──
{
  const mostlyCapped = [
    ...Array.from({ length: 6 }, (_, i) => buildManager(`c${i}`, { capped: true })),
    ...Array.from({ length: 6 }, (_, i) => buildManager(`q${i}`, { quits: true })),
  ];
  const bad = auditEngagement(mostlyCapped);
  check('audit: widespread sweep truncation blocks training',
    bad.blocking.some((b) => b.includes('sweep cap')), bad.blocking);

  const oneCapped = [...healthy.slice(0, 11), buildManager('c0', { capped: true })];
  const mild = auditEngagement(oneCapped);
  check('audit: isolated truncation warns but does not block',
    !mild.blocking.some((b) => b.includes('sweep cap'))
    && mild.completeness.warnings.some((w) => w.includes('sweep cap')),
    { blocking: mild.blocking, warnings: mild.completeness.warnings });
  near('audit: truncation share', mild.completeness.cappedSweepShare, 1 / 12, 1e-9);
}

// ── audit: degenerate label blocks ──
{
  const allQuit = Array.from({ length: 6 }, (_, i) => buildManager(`q${i}`, { quits: true }));
  const report = auditEngagement(allQuit);
  check('audit: an all-positive label blocks the run',
    report.blocking.some((b) => b.includes('degenerate')), report.blocking);
}

// ── audit: unlaunched leagues are not counted as idle managers ──
{
  const unlaunched = buildManager('pre', { status: 'pre_draft' });
  unlaunched.rows = unlaunched.rows.map((r) => ({ ...r, txnCount: 0, activeWeeks: [], lastActiveWeek: null, firstActiveWeek: null }));
  const report = auditEngagement([...healthy, unlaunched]);
  eq('audit: zero-transaction rows counted', report.completeness.zeroTxnRows, 2);
  eq('audit: unlaunched leagues are separated out', report.completeness.zeroTxnUnlaunched, 2);
  eq('audit: nothing left unexplained', report.completeness.zeroTxnUnexplained, 0);
}

// ── audit: zero-transaction rows are only suspicious once the expected
//    explanations are stripped out ──
{
  // Best ball has no waivers and no lineup to set, so zero transactions there
  // is normal. Counting it as "live league, no activity" produced a
  // four-figure false alarm on the first real crawl.
  const bb = buildManager('bb', { bestBall: true });
  bb.rows = bb.rows.map((r) => ({ ...r, txnCount: 0, activeWeeks: [], firstActiveWeek: null, lastActiveWeek: null }));
  const withBB = auditEngagement([...healthy, bb]);
  eq('zero-txn: best ball is an expected explanation', withBB.completeness.zeroTxnBestBall, 2);
  eq('zero-txn: and is not counted as unexplained', withBB.completeness.zeroTxnUnexplained, 0);

  // A season that has barely started has had no chance to show activity.
  const fresh = buildManager('fresh');
  fresh.rows = fresh.rows.map((r) => ({ ...r, txnCount: 0, activeWeeks: [], firstActiveWeek: null, lastActiveWeek: null }));
  const inProgress = auditEngagement([...healthy, fresh], undefined, {
    horizonBySeason: { 2024: 17, 2025: 1 },
  });
  eq('zero-txn: an in-progress season is an expected explanation',
    inProgress.completeness.zeroTxnInProgress, 1);
  check('zero-txn: the completed season is still unexplained',
    inProgress.completeness.zeroTxnUnexplained === 1, inProgress.completeness);
  check('zero-txn: unexplained rows raise a warning',
    inProgress.completeness.warnings.some((w) => w.includes('no transactions at all')));
}

// ── audit: a weak association is not a contradicted hypothesis ──
{
  // A feature with a 2-point deviation from 0.5 is noise. Flagging it as
  // "treat as a bug" trains people to ignore the warning that matters, so a
  // direction is only declared past a minimum effect size.
  const specs: FeatureSpec[] = [
    { name: 'noisy', kind: 'static', get: (r) => (r.totalRosters % 2), expect: 'higher-risk' },
  ];
  const strict = auditEngagement(healthy, specs, { minEffectSize: 0.5 });
  eq('effect size: a large floor reports no direction', strict.features[0].direction, 'none');
  eq('effect size: and therefore no contradiction', strict.features[0].directionOk, null);
  check('effect size: no spurious warning',
    !strict.completeness.warnings.some((w) => w.includes('opposite direction')));

  const loose = auditEngagement(healthy, specs, { minEffectSize: 0 });
  check('effect size: a zero floor will call any deviation a direction',
    loose.features[0].direction !== 'none' || loose.features[0].signalAuc === 0.5,
    loose.features[0]);
}

// ── audit: in-progress seasons are excluded from stability ──
{
  // A pre-season snapshot has near-zero transactions, so measured against
  // completed seasons it reports drift on every activity feature at once.
  const many = [
    ...Array.from({ length: 10 }, (_, i) => buildManager(`s${i}`)),
    ...Array.from({ length: 6 }, (_, i) => buildManager(`q${i}`, { quits: true })),
  ];
  const scoped = auditEngagement(many, undefined, { horizonBySeason: { 2024: 17, 2025: 1 } });
  const txn = scoped.features.find((f) => f.name === 'txnCount')!;
  // With only one completed season left there is nothing to compare against,
  // so stability is honestly n/a rather than a number.
  eq('stability: an in-progress season is excluded', txn.stability, 'n/a');
  const composition = scoped.completeness.seasonComposition.find((s) => s.season === '2025')!;
  check('stability: the season is still reported as in progress', composition.inProgress);
  eq('stability: with its horizon shown', composition.horizonWeeks, 1);
  check('composition: rows still counted for the in-progress season', composition.rows > 0);
}

// ── audit: required fields, degeneracy, collinearity, direction ──
{
  const specs: FeatureSpec[] = [
    { name: 'needed', kind: 'static', get: (r) => (r.totalRosters > 0 ? null : 1), required: true },
    { name: 'constant', kind: 'static', get: () => 7 },
    { name: 'twinA', kind: 'time-varying', get: (r) => r.txnCount },
    { name: 'twinB', kind: 'time-varying', get: (r) => r.txnCount * 2 },
    // Deliberately backwards: more transactions cannot mean more abandonment.
    { name: 'backwards', kind: 'time-varying', get: (r) => r.txnCount, expect: 'higher-risk' },
  ];
  const report = auditEngagement(healthy, specs);
  const by = new Map(report.features.map((f) => [f.name, f]));

  check('audit: a null required field blocks the run',
    report.blocking.some((b) => b.includes('"needed"')), report.blocking);
  check('audit: a constant feature is degenerate', by.get('constant')?.degenerate === true);
  eq('audit: degeneracy is explained', by.get('constant')?.degenerateReason, 'Constant across every row.');
  check('audit: perfectly collinear pair is reported',
    report.collinearPairs.some((p) => (p.a === 'twinA' && p.b === 'twinB') || (p.a === 'twinB' && p.b === 'twinA')),
    report.collinearPairs);
  near('audit: collinear r is 1', Math.abs(report.collinearPairs[0]?.r ?? 0), 1, 1e-9);
  check('audit: a degenerate feature is kept out of collinearity screening',
    !report.collinearPairs.some((p) => p.a === 'constant' || p.b === 'constant'));
  eq('audit: contradicted hypothesis is flagged', by.get('backwards')?.directionOk, false);
  check('audit: the contradiction is surfaced as a warning',
    report.completeness.warnings.some((w) => w.includes('backwards') && w.includes('opposite direction')));
}

// ── audit: the report leaks no identifiers ──
{
  const report = auditEngagement(healthy);
  const serialized = JSON.stringify(report);
  check('privacy: no manager ids in the report',
    !healthy.some((m) => serialized.includes(m.managerId)), serialized.slice(0, 200));
  check('privacy: no league ids in the report',
    !healthy.some((m) => m.rows.some((r) => serialized.includes(r.leagueId))));
}

// ── the shipped spec list is internally consistent ──
{
  const names = ENGAGEMENT_FEATURES.map((f) => f.name);
  eq('specs: no duplicate feature names', names.length, new Set(names).size);
  check('specs: every spec declares a kind', ENGAGEMENT_FEATURES.every((f) => !!f.kind));
  check('specs: label-derived specs carry no risk hypothesis',
    ENGAGEMENT_FEATURES.filter((f) => f.kind === 'label-derived').every((f) => !f.expect));
  // A getter that throws on a legitimate row would take down the whole report.
  const probe: ManagerSeasonEngagement = buildManager('probe').rows[0];
  check('specs: every getter tolerates a real row',
    ENGAGEMENT_FEATURES.every((f) => { try { f.get(probe); return true; } catch { return false; } }));
}

// ── report ──

console.log(`\n${passed} checks passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('✓ eval metrics and the completeness / feature audit behave as specified');
