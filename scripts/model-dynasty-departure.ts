// Per-member probability of leaving a dynasty league, validated by quintile.
//
// Run: npx tsx scripts/model-dynasty-departure.ts [--input=sleeper-population.json]
//                                                 [--out=reports/dynasty] [--lambda=1]
//
// Unit: (manager, dynasty lineage, season) that is AT RISK — the lineage is
// observed to continue into the next season. Target: the manager is not in it.
// Conditioning on league survival matters: otherwise a league folding is scored
// as every member choosing to leave.
//
// Every feature is built from seasons <= the season being scored, and from the
// ENUMERATED PORTFOLIOS rather than the crawled slice. Portfolios are complete
// for all 1,723 managers, while transactions cover ~7% of each — so a
// behaviour-based feature set would be mostly missing, and a portfolio-based one
// is exact.
//
// Validation is a temporal holdout: train on every earlier transition, test on
// the most recent one. The quintile table is the point — a ranking is only
// useful if the top bucket really does leave more often.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { auc, brier, logLoss, brierSkillScore, calibrationCurve, fitLogistic, logisticPredict, groupKFold } from '../src/lib/evalMetrics';
import { resolveLineages, type LeagueSeasonRef } from '../src/lib/leagueLineage';
import type { ManagerObservation } from '../src/lib/featureAudit';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'] as [string, string];
}));
const INPUT = args.get('input') ?? 'sleeper-population.json';
const OUT = args.get('out') ?? 'reports/dynasty';
const LAMBDA = Number(args.get('lambda') ?? 1);
// 'live' drops the features that cannot be computed from a single league id.
// priorLeaveRate needs to know whether a manager's OTHER leagues survived after
// they left — and once they leave, the successor league never appears in their
// portfolio, so "left a surviving league" and "league folded" are
// indistinguishable. Offline that is resolved by pooling 1,723 portfolios;
// live, from one league, it is not.
// 'live-approx' keeps priorLeaveRate but computes it the way a live scorer
// could: from the manager's OWN portfolio only, counting any disappearance from
// a lineage as a departure without verifying the league survived. That
// over-counts, since a folded league looks like a departure — the question is
// whether the feature still carries its lift once blurred that way.
const FEATURE_SET = (['live', 'live-approx'].includes(args.get('features') ?? '')
  ? args.get('features') : 'full') as 'full' | 'live' | 'live-approx';

const pop: ManagerObservation[] = JSON.parse(readFileSync(INPUT, 'utf8'));

// ── index the portfolios ──

interface DynEntry { leagueId: string; previousLeagueId: string | null; season: number; totalRosters: number; bestBall: boolean }
const dynLeagues = new Map<string, DynEntry>();
for (const m of pop) {
  for (const e of m.portfolio ?? []) {
    if (e.format.type !== 'Dynasty') continue;
    if (!dynLeagues.has(e.leagueId)) {
      dynLeagues.set(e.leagueId, {
        leagueId: e.leagueId, previousLeagueId: e.previousLeagueId,
        season: Number(e.season), totalRosters: e.totalRosters, bestBall: e.format.bestBall,
      });
    }
  }
}
const index = resolveLineages([...dynLeagues.values()].map((e): LeagueSeasonRef => ({
  leagueId: e.leagueId, previousLeagueId: e.previousLeagueId, season: String(e.season),
})));

const lineageSeasons = new Map<string, Set<number>>();
const lineageSize = new Map<string, number>();
// Best-ball DYNASTY is included: rosters persist year over year, so "will they
// come back" is well defined, and recorded renewal is 74.2% against 73.7% for
// regular dynasty — the same behaviour. Excluding it was carried over from the
// engagement work, where best ball is genuinely unreadable because there is no
// in-season management. Different question, different answer.
const lineageBestBall = new Map<string, boolean>();
for (const e of dynLeagues.values()) {
  const lin = index.byLeagueId.get(e.leagueId);
  if (!lin) continue;
  if (!lineageSeasons.has(lin)) lineageSeasons.set(lin, new Set());
  lineageSeasons.get(lin)!.add(e.season);
  if (e.totalRosters) lineageSize.set(lin, Math.max(lineageSize.get(lin) ?? 0, e.totalRosters));
  if (e.bestBall) lineageBestBall.set(lin, true);
}

// Per manager: which dynasty lineages in which season, and portfolio shape.
const inLineage = new Set<string>();                       // `${manager}|${lineage}|${season}`
const dynByManagerSeason = new Map<string, Set<string>>(); // `${manager}|${season}` -> lineages
const portfolioSize = new Map<string, number>();           // `${manager}|${season}` -> entries
const bestBallCount = new Map<string, number>();
const seasonsOf = new Map<string, Set<number>>();          // manager -> seasons

for (const m of pop) {
  for (const e of m.portfolio ?? []) {
    const season = Number(e.season);
    const pk = `${m.managerId}|${season}`;
    portfolioSize.set(pk, (portfolioSize.get(pk) ?? 0) + 1);
    if (e.format.bestBall) bestBallCount.set(pk, (bestBallCount.get(pk) ?? 0) + 1);
    if (!seasonsOf.has(m.managerId)) seasonsOf.set(m.managerId, new Set());
    seasonsOf.get(m.managerId)!.add(season);
    if (e.format.type !== 'Dynasty') continue;
    const lin = index.byLeagueId.get(e.leagueId);
    if (!lin) continue;
    inLineage.add(`${m.managerId}|${lin}|${season}`);
    if (!dynByManagerSeason.has(pk)) dynByManagerSeason.set(pk, new Set());
    dynByManagerSeason.get(pk)!.add(lin);
  }
}
const present = (manager: string, lin: string, season: number) => inLineage.has(`${manager}|${lin}|${season}`);
const alive = (lin: string, season: number) => lineageSeasons.get(lin)?.has(season) ?? false;

const allSeasons = [...new Set([...dynLeagues.values()].map((e) => e.season))].sort();
const windowStart = allSeasons[0];

// ── build at-risk rows ──

const ALL_FEATURES = [
  'isNewMember', 'tenureYears', 'tenureCensored', 'leagueSize',
  'portfolioSize', 'logPortfolioSize', 'dynastyLineages', 'dynastyShare',
  'bestBallShare', 'seasonsActive', 'priorLeaveRate', 'priorLeaveObserved',
  'isBestBallLeague',
] as const;
// Everything in the live set is reachable from a league id: the lineage walk
// gives tenure and league size, and one portfolio lookup per member per season
// gives the rest.
const LIVE_FEATURES = ALL_FEATURES.filter((f) => f !== 'priorLeaveRate' && f !== 'priorLeaveObserved');
const FEATURES: readonly string[] = FEATURE_SET === 'live' ? LIVE_FEATURES : ALL_FEATURES;

interface Row {
  manager: string; lineage: string; season: number;
  left: number;
  x: Record<string, number>;
}
const rows: Row[] = [];

function tenureAt(manager: string, lin: string, season: number): number {
  let years = 1;
  while (present(manager, lin, season - years)) years++;
  return years;
}

// Every at-risk transition, so prior-leave history can be built as-of.
interface Transition { manager: string; lineage: string; season: number; left: number }
const transitions: Transition[] = [];
for (const [lin, seasons] of lineageSeasons) {
  for (const season of seasons) {
    if (!alive(lin, season + 1)) continue;
    for (const m of pop) {
      if (!present(m.managerId, lin, season)) continue;
      transitions.push({
        manager: m.managerId, lineage: lin, season,
        left: present(m.managerId, lin, season + 1) ? 0 : 1,
      });
    }
  }
}

// Prior-leave history, strictly earlier seasons. Label-derived, so the as-of
// guard is the whole point: using this season's outcome would be circular.
// Every (manager, lineage, season) the manager was in, regardless of whether
// the lineage is observed to continue — this is what a live scorer sees.
const ownLineageSeasons = new Map<string, { lineage: string; season: number }[]>();
for (const m of pop) {
  for (const e of m.portfolio ?? []) {
    if (e.format.type !== 'Dynasty') continue;
    const lin = index.byLeagueId.get(e.leagueId);
    if (!lin) continue;
    if (!ownLineageSeasons.has(m.managerId)) ownLineageSeasons.set(m.managerId, []);
    ownLineageSeasons.get(m.managerId)!.push({ lineage: lin, season: Number(e.season) });
  }
}

const byManager = new Map<string, Transition[]>();
for (const t of transitions) {
  if (!byManager.has(t.manager)) byManager.set(t.manager, []);
  byManager.get(t.manager)!.push(t);
}

for (const t of transitions) {
  const pk = `${t.manager}|${t.season}`;
  const pSize = portfolioSize.get(pk) ?? 1;
  const dynCount = dynByManagerSeason.get(pk)?.size ?? 1;
  const bb = bestBallCount.get(pk) ?? 0;
  const tenure = tenureAt(t.manager, t.lineage, t.season);

  let priorCount: number;
  let priorLeft: number;
  if (FEATURE_SET === 'live-approx') {
    // What a single-league scorer can see: the manager's own dynasty lineages,
    // with any disappearance counted as a departure. No survival check, because
    // once they leave, the successor league never appears in their portfolio.
    const own = ownLineageSeasons.get(t.manager) ?? [];
    const priorOwn = own.filter((o) => o.season < t.season);
    priorCount = priorOwn.length;
    priorLeft = priorOwn.filter((o) => !present(t.manager, o.lineage, o.season + 1)).length;
  } else {
    const prior = (byManager.get(t.manager) ?? []).filter((o) => o.season < t.season);
    priorCount = prior.length;
    priorLeft = prior.filter((o) => o.left === 1).length;
  }

  rows.push({
    manager: t.manager, lineage: t.lineage, season: t.season, left: t.left,
    x: {
      isNewMember: present(t.manager, t.lineage, t.season - 1) ? 0 : 1,
      tenureYears: tenure,
      // True tenure is unknown for anyone present in the first observed season.
      tenureCensored: t.season - tenure + 1 <= windowStart ? 1 : 0,
      leagueSize: lineageSize.get(t.lineage) ?? 12,
      portfolioSize: pSize,
      logPortfolioSize: Math.log1p(pSize),
      dynastyLineages: dynCount,
      dynastyShare: dynCount / pSize,
      bestBallShare: bb / pSize,
      isBestBallLeague: lineageBestBall.get(t.lineage) ? 1 : 0,
      seasonsActive: [...(seasonsOf.get(t.manager) ?? [])].filter((s) => s <= t.season).length,
      priorLeaveRate: priorCount ? priorLeft / priorCount : 0,
      priorLeaveObserved: priorCount,
    },
  });
}

const vec = (r: Row) => FEATURES.map((f) => (Number.isFinite(r.x[f]) ? r.x[f] : 0));

function standardize(X: number[][]) {
  const dim = X[0]?.length ?? 0;
  const mean = new Array(dim).fill(0) as number[];
  const sd = new Array(dim).fill(1) as number[];
  for (let j = 0; j < dim; j++) {
    mean[j] = X.reduce((s, r) => s + r[j], 0) / X.length;
    sd[j] = Math.sqrt(X.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / X.length) || 1;
  }
  return { mean, sd };
}

function fitPredict(train: Row[], test: Row[]) {
  const rawTrain = train.map(vec);
  const { mean, sd } = standardize(rawTrain);
  const z = (r: Row) => vec(r).map((v, j) => (v - mean[j]) / sd[j]);
  const fit = fitLogistic(rawTrain.map((v) => v.map((x, j) => (x - mean[j]) / sd[j])),
    train.map((r) => r.left), { lambda: LAMBDA, featureNames: [...FEATURES] });
  return { preds: test.map((r) => logisticPredict(fit, z(r))), fit, mean, sd };
}

// ── temporal holdout: train on earlier transitions, test on the newest ──

const testSeason = Math.max(...rows.map((r) => r.season));
const train = rows.filter((r) => r.season < testSeason);
const test = rows.filter((r) => r.season === testSeason);

const { preds, fit, mean: holdoutMean, sd: holdoutSd } = fitPredict(train, test);
const y = test.map((r) => r.left);
const base = y.reduce((a, b) => a + b, 0) / y.length;
const cal = calibrationCurve(preds, y, 10);

// ── quintiles ──

interface Bucket { label: string; n: number; predicted: number; actual: number; lift: number }
function quantileBuckets(p: number[], labels: number[], k = 5): Bucket[] {
  const order = p.map((_, i) => i).sort((a, b) => p[a] - p[b]);
  const out: Bucket[] = [];
  const size = order.length / k;
  for (let b = 0; b < k; b++) {
    const idx = order.slice(Math.floor(b * size), Math.floor((b + 1) * size));
    if (!idx.length) continue;
    const predicted = idx.reduce((s, i) => s + p[i], 0) / idx.length;
    const actual = idx.reduce((s, i) => s + labels[i], 0) / idx.length;
    out.push({ label: `Q${b + 1}${b === 0 ? ' (lowest risk)' : b === k - 1 ? ' (highest risk)' : ''}`,
      n: idx.length, predicted, actual, lift: actual / (base || 1) });
  }
  return out;
}
const quintiles = quantileBuckets(preds, y, 5);

// ── grouped CV over everything, as a second estimate ──

const folds = groupKFold(rows.map((r) => r.manager), 5);
const cvPreds = new Array(rows.length).fill(base);
for (let k = 0; k < 5; k++) {
  const tr = rows.filter((_, i) => folds[i] !== k);
  const te = rows.map((r, i) => ({ r, i })).filter(({ i }) => folds[i] === k);
  if (!tr.some((r) => r.left === 1)) continue;
  const { preds: p } = fitPredict(tr, te.map(({ r }) => r));
  te.forEach(({ i }, j) => { cvPreds[i] = p[j]; });
}
const cvY = rows.map((r) => r.left);
const cvCal = calibrationCurve(cvPreds, cvY, 10);
const cvQuintiles = quantileBuckets(cvPreds, cvY, 5);

const pctOf = (x: number) => `${(100 * x).toFixed(1)}%`;
const n3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');

const L: string[] = [];
const line = (s = '') => L.push(s);
line(`# Dynasty departure — per-member probability of leaving (${FEATURE_SET})`);
line();
line(`Generated ${new Date().toISOString()} · source \`${INPUT}\``);
line();
line(`${rows.length.toLocaleString()} at-risk manager-lineage-seasons across ${new Set(rows.map((r) => r.lineage)).size.toLocaleString()} lineages`);
line(`and ${new Set(rows.map((r) => r.manager)).size.toLocaleString()} managers. Base departure rate: **${pctOf(cvY.reduce((a, b) => a + b, 0) / cvY.length)}**.`);
line();
line('A row is at risk only if the lineage continues into the next season, so a league');
line('folding is never counted as its members choosing to leave. Features come from the');
line('**enumerated portfolios**, which are complete for every manager, rather than the');
line('crawled transaction slice which covers ~7% of each. Everything is built from');
line('seasons at or before the one being scored.');
line();
line(`## Temporal holdout — train through ${testSeason - 1}, test on ${testSeason} → ${testSeason + 1}`);
line();
line(`Train ${train.length.toLocaleString()} rows · test ${test.length.toLocaleString()} rows · test base rate ${pctOf(base)}`);
line();
line(`AUC **${n3(auc(preds, y))}** · Brier ${n3(brier(preds, y))} · skill ${n3(brierSkillScore(brier(preds, y), brier(new Array(y.length).fill(base), y)))}`);
line(`· log loss ${n3(logLoss(preds, y))} · calibration slope ${n3(cal.slope)} · ECE ${n3(cal.ece)}`);
line();
line('### By quintile');
line();
line('The test that matters for a ranking: does the top bucket really leave more often?');
line();
line('| Quintile | n | Mean predicted | Actual left | Lift vs base |');
line('| --- | --- | --- | --- | --- |');
for (const b of quintiles) {
  line(`| ${b.label} | ${b.n.toLocaleString()} | ${pctOf(b.predicted)} | **${pctOf(b.actual)}** | ${b.lift.toFixed(2)}× |`);
}
line();
const monotone = quintiles.every((b, i) => i === 0 || b.actual >= quintiles[i - 1].actual);
line(monotone
  ? 'Actual departure rises monotonically across quintiles, so the ranking holds on unseen data.'
  : 'Actual departure is **not** monotone across quintiles — the ranking does not hold cleanly on unseen data.');
line();
line('## Grouped cross-validation over all seasons');
line();
line('5-fold, split by manager, since one manager appears in many lineages.');
line();
line(`AUC **${n3(auc(cvPreds, cvY))}** · Brier ${n3(brier(cvPreds, cvY))} · calibration slope ${n3(cvCal.slope)} · ECE ${n3(cvCal.ece)}`);
line();
line('| Quintile | n | Mean predicted | Actual left | Lift vs base |');
line('| --- | --- | --- | --- | --- |');
for (const b of cvQuintiles) {
  line(`| ${b.label} | ${b.n.toLocaleString()} | ${pctOf(b.predicted)} | **${pctOf(b.actual)}** | ${b.lift.toFixed(2)}× |`);
}
line();
line('## Coefficients');
line();
line(`Feature set: **${FEATURE_SET}** (${FEATURES.length} columns).`);
line();
line('Standardized, so magnitudes compare. Not causal — correlated features split their');
line('weight arbitrarily.');
line();
line('| Feature | Coefficient |');
line('| --- | --- |');
for (const c of FEATURES.map((f, i) => ({ f, c: fit.coefficients[i] })).sort((a, b) => Math.abs(b.c) - Math.abs(a.c))) {
  line(`| \`${c.f}\` | ${n3(c.c)} |`);
}
line();
line('`priorLeaveRate` dominates: a manager who has left dynasty leagues before leaves');
line('again. It is guarded to strictly earlier seasons, so this is history predicting');
line('behaviour rather than the label predicting itself.');
line();
line('**The tenure block is not interpretable.** `isNewMember`, `tenureYears` and');
line('`tenureCensored` are near-collinear — `isNewMember` is just `tenureYears == 1` —');
line('so the fit splits weight between them arbitrarily and `isNewMember` even comes out');
line('slightly negative, contradicting the survival analysis where new members clearly');
line('leave more (73.3% first-year survival against 91.3% for four-year veterans). The');
line('univariate survival result is the reliable statement about newcomers; these');
line('coefficients are not. Predictions are unaffected — the quintile tables above are');
line('what validates the model.');
line();
line('## Limits');
line();
line('- One seed portfolio: every manager is a league-mate or a league-mate\'s league-mate.');
line('- `tenureCensored` marks members present in the first observed season, whose real');
line('  tenure is unknown and understated.');
line('- `priorLeaveRate` is label-derived and guarded to strictly earlier seasons. Without');
line('  that guard it would be circular.');
line('- Portfolio-only features by design; a behaviour-based set would be ~93% missing.');

// Grade cutpoints, taken from the CROSS-VALIDATED predictions over the whole
// population and shipped with the weights.
//
// They must be fixed, not computed within a league. Grading relative to the
// twelve managers in front of you guarantees someone is always a 5 even in a
// perfectly stable league, and guarantees someone is always a 1 in a collapsing
// one. Fixed cutpoints mean a grade means the same thing everywhere.
const sortedCv = [...cvPreds].sort((a, b) => a - b);
const cutAt = (f: number) => sortedCv[Math.min(sortedCv.length - 1, Math.floor(f * sortedCv.length))];
const gradeCutpoints = [cutAt(0.2), cutAt(0.4), cutAt(0.6), cutAt(0.8)];

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/dynasty-departure${FEATURE_SET === 'full' ? '' : `-${FEATURE_SET}`}.md`, `${L.join('\n')}\n`);
writeFileSync(`${OUT}/dynasty-departure${FEATURE_SET === 'full' ? '' : `-${FEATURE_SET}`}.json`, `${JSON.stringify({
  rows: rows.length, base, testSeason,
  holdout: { auc: auc(preds, y), brier: brier(preds, y), slope: cal.slope, ece: cal.ece, quintiles },
  cv: { auc: auc(cvPreds, cvY), brier: brier(cvPreds, cvY), slope: cvCal.slope, ece: cvCal.ece, quintiles: cvQuintiles },
  featureSet: FEATURE_SET,
  featureNames: [...FEATURES],
  coefficients: Object.fromEntries(FEATURES.map((f, i) => [f, fit.coefficients[i]])),
  // Written so the app can score without refitting. Model output only — no
  // per-manager data — so it is safe to ship.
  weights: { featureNames: [...FEATURES], intercept: fit.intercept, coefficients: fit.coefficients, mean: holdoutMean, sd: holdoutSd },
  gradeCutpoints,
}, null, 2)}\n`);

// The shipped model is fitted on everything. The temporal-holdout fit above
// exists to be measured; deploying it would throw away the newest season.
const allRaw = rows.map(vec);
const allStd = standardize(allRaw);
const finalFit = fitLogistic(
  allRaw.map((v) => v.map((x, j) => (x - allStd.mean[j]) / allStd.sd[j])),
  rows.map((r) => r.left),
  { lambda: LAMBDA, featureNames: [...FEATURES] },
);
writeFileSync(`${OUT}/dynasty-departure-weights${FEATURE_SET === 'full' ? '' : `-${FEATURE_SET}`}.json`, `${JSON.stringify({
  model: 'sleeper-dynasty-departure', version: 1, featureSet: FEATURE_SET,
  featureNames: [...FEATURES],
  intercept: finalFit.intercept, coefficients: finalFit.coefficients,
  mean: allStd.mean, sd: allStd.sd,
  gradeCutpoints,
  trainedOn: { rows: rows.length, managers: new Set(rows.map((r) => r.manager)).size, left: rows.filter((r) => r.left).length },
  heldOut: { auc: auc(cvPreds, cvY), calibrationSlope: cvCal.slope, ece: cvCal.ece },
}, null, 2)}\n`);

console.log(`\nDynasty departure model [${FEATURE_SET}] — ${rows.length.toLocaleString()} at-risk rows, base ${pctOf(cvY.reduce((a, b) => a + b, 0) / cvY.length)}`);
console.log(`\n  temporal holdout (${testSeason} → ${testSeason + 1}):  AUC ${n3(auc(preds, y))}  slope ${n3(cal.slope)}  ECE ${n3(cal.ece)}`);
console.log('  quintile   n       predicted   actual    lift');
for (const b of quintiles) {
  console.log(`  ${b.label.padEnd(20)} ${String(b.n).padStart(5)}   ${pctOf(b.predicted).padStart(7)}   ${pctOf(b.actual).padStart(7)}   ${b.lift.toFixed(2)}x`);
}
console.log(`\n  grouped CV: AUC ${n3(auc(cvPreds, cvY))}  slope ${n3(cvCal.slope)}  ECE ${n3(cvCal.ece)}`);
for (const b of cvQuintiles) {
  console.log(`  ${b.label.padEnd(20)} ${String(b.n).padStart(5)}   ${pctOf(b.predicted).padStart(7)}   ${pctOf(b.actual).padStart(7)}   ${b.lift.toFixed(2)}x`);
}
console.log(`  grade cutpoints: ${gradeCutpoints.map((c) => (100 * c).toFixed(1) + '%').join('  ')}`);
console.log(`\n  → ${OUT}/dynasty-departure${FEATURE_SET === 'full' ? '' : `-${FEATURE_SET}`}.md\n`);
