// Fit and evaluate the discrete-time survival model for manager abandonment.
//
// Run: npx tsx scripts/train-abandonment-model.ts --input=sleeper-population.json
//                                                 [--out=reports/abandonment]
//                                                 [--folds=5] [--lambda=1]
//
// Reports out-of-fold metrics only, grouped by manager: rows from one person are
// the same habits repeated, so a random row split trains and tests on them both.
//
// Discrimination is reported on the FEASIBLE rows. Under this failure definition
// a manager can only die the week after transacting, so already-silent rows have
// hazard exactly 0 — real members of the risk set, kept in the likelihood, but
// trivially separable and therefore excluded from the headline metric.
//
// Writes a model card and the fitted weights. The weights contain no per-manager
// data and are safe to publish; the population they came from is not.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import {
  fitAbandonmentModel, hazard, feasibleRows, clusterRobustInference,
  type AbandonmentModel, type Weighting,
} from '../src/lib/abandonmentModel';
import { personPeriods, type PersonPeriodRow } from '../src/lib/hazardFeatures';
import {
  auc, brier, logLoss, brierSkillScore, calibrationCurve, concordance, groupKFold,
  type SurvivalObservation,
} from '../src/lib/evalMetrics';
import type { ManagerObservation } from '../src/lib/featureAudit';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'] as [string, string];
}));
const INPUT = args.get('input') ?? 'sleeper-population.json';
const OUT = args.get('out') ?? 'reports/abandonment';
const FOLDS = Number(args.get('folds') ?? 5);
const LAMBDA = Number(args.get('lambda') ?? 1);

const pop: ManagerObservation[] = JSON.parse(readFileSync(INPUT, 'utf8'));
let horizons: Record<string, number> = {};
try {
  horizons = JSON.parse(readFileSync(`${INPUT.replace(/\.json$/, '')}-manifest.json`, 'utf8')).horizonBySeason ?? {};
} catch { /* no manifest: fall back to a full season */ }
const horizonWeek = (s: string) => Math.min(17, horizons[s] ?? 17);

const rows = pop.flatMap((m) => personPeriods(
  { managerId: m.managerId, rows: m.rows, events: m.events ?? [] },
  { horizonWeek, target: 'stops-this-week' },
));
if (!rows.length) { console.error('No person-period rows. Is the population empty?'); process.exit(2); }

const folds = groupKFold(rows.map((r) => r.managerId), FOLDS);

// Out-of-fold hazards for one weighting scheme.
function crossValidate(weighting: Weighting): number[] {
  const preds = new Array(rows.length).fill(NaN);
  for (let k = 0; k < FOLDS; k++) {
    const train = rows.filter((_, i) => folds[i] !== k);
    if (!train.some((r) => r.event === 1)) continue;
    const model = fitAbandonmentModel(train, { weighting, lambda: LAMBDA });
    rows.forEach((r, i) => { if (folds[i] === k) preds[i] = hazard(model, r); });
  }
  return preds;
}

interface Scored {
  weighting: Weighting;
  n: number; events: number; baseRate: number;
  auc: number; brier: number; logLoss: number; skill: number;
  slope: number; intercept: number; ece: number;
  concordance: number;
}

function score(weighting: Weighting, preds: number[]): Scored {
  // Headline metrics on the feasible rows only.
  const idx = rows.map((_, i) => i).filter((i) => rows[i].feasible && Number.isFinite(preds[i]));
  const p = idx.map((i) => preds[i]);
  const y = idx.map((i) => rows[i].event);
  const pos = y.reduce((a, b) => a + b, 0);
  const base = new Array(y.length).fill(pos / y.length);
  const cal = calibrationCurve(p, y, 10);

  // Manager-season concordance: does a higher predicted risk correspond to
  // failing sooner? Chained from the out-of-fold hazards, so it is the same
  // held-out prediction the discrimination metrics use.
  const bySeason = new Map<string, { rows: PersonPeriodRow[]; preds: number[] }>();
  rows.forEach((r, i) => {
    if (!Number.isFinite(preds[i])) return;
    const key = `${r.managerId}|${r.leagueId}`;
    if (!bySeason.has(key)) bySeason.set(key, { rows: [], preds: [] });
    bySeason.get(key)!.rows.push(r);
    bySeason.get(key)!.preds.push(preds[i]);
  });
  // Risk score = the hazard at the subject's FIRST at-risk week.
  //
  // Chaining survival across all of a subject's weeks looks natural and is
  // wrong here: a manager who fails in week 4 has three rows and one who lasts
  // the season has fifteen, so the chained product is dominated by how many
  // weeks each was observed — inversely related to failing early. Scored that
  // way concordance came out at 0.401, below chance, purely from follow-up
  // length. A baseline hazard is comparable across subjects, which is what the
  // C-index needs.
  const obs: SurvivalObservation[] = [];
  for (const { rows: rs, preds: ps } of bySeason.values()) {
    const order = rs.map((_, i) => i).sort((a, b) => rs[a].week - rs[b].week);
    const eventRow = rs.find((r) => r.event === 1);
    obs.push({
      time: eventRow ? eventRow.week : Math.max(...rs.map((r) => r.week)),
      event: !!eventRow,
      risk: ps[order[0]],
    });
  }

  return {
    weighting,
    n: y.length, events: pos, baseRate: pos / y.length,
    auc: auc(p, y), brier: brier(p, y), logLoss: logLoss(p, y),
    skill: brierSkillScore(brier(p, y), brier(base, y)),
    slope: cal.slope, intercept: cal.intercept, ece: cal.ece,
    concordance: concordance(obs),
  };
}

// Both weighting schemes are evaluated, because "weight each manager equally"
// is the obvious thing to reach for and the numbers are the argument against it.
const results = (['none', 'manager'] as Weighting[]).map((w) => score(w, crossValidate(w)));
const final: AbandonmentModel = fitAbandonmentModel(rows, { weighting: 'none', lambda: LAMBDA });
const inference = clusterRobustInference(final, rows);

const managers = new Set(rows.map((r) => r.managerId)).size;
const seasons = new Set(rows.map((r) => `${r.managerId}|${r.leagueId}`)).size;
const feasible = feasibleRows(rows).length;

const n = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
console.log(`\nAbandonment survival model`);
console.log(`  ${rows.length} person-periods · ${seasons} manager-seasons · ${managers} managers`);
console.log(`  feasible rows ${feasible} (${(100 * feasible / rows.length).toFixed(0)}%) · events ${rows.reduce((a, r) => a + r.event, 0)}`);
console.log(`  ${FOLDS}-fold CV grouped by manager, lambda ${LAMBDA}\n`);
console.log(`  weighting   AUC    Brier    skill   slope   ECE      C`);
for (const r of results) {
  console.log(`  ${r.weighting.padEnd(10)}  ${n(r.auc)}  ${n(r.brier, 4)}  ${n(r.skill)}  ${n(r.slope)}  ${n(r.ece, 4)}  ${n(r.concordance)}`);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/abandonment-weights.json`, `${JSON.stringify({
  model: 'sleeper-abandonment-hazard', version: 1, target: 'stops-this-week',
  featureNames: final.featureNames, mean: final.mean, sd: final.sd,
  intercept: final.intercept, coefficients: final.coefficients,
  weighting: final.weighting, lambda: final.lambda, trainedOn: final.trainedOn,
}, null, 2)}\n`);

const L: string[] = [];
L.push('# Abandonment hazard — model card', '');
L.push(`Generated ${new Date().toISOString()} · source \`${INPUT}\``, '');
L.push('## What it predicts', '');
L.push('The discrete hazard `h(w) = P(T = w | T >= w)`, where failure time `T` is the');
L.push('first week after a manager\'s last transaction in a league-season. Chained');
L.push('across weeks it gives a survival curve and a season-level abandonment risk.', '');
L.push('Not a judgement of the manager. Best ball is excluded (no in-season management');
L.push('is expected), as are seasons that never started.', '');
L.push('## Training data', '');
L.push(`| | |`, `| --- | --- |`);
L.push(`| person-periods | ${rows.length} |`);
L.push(`| manager-seasons | ${seasons} |`);
L.push(`| managers | ${managers} |`);
L.push(`| events | ${rows.reduce((a, r) => a + r.event, 0)} |`);
L.push(`| feasible rows | ${feasible} (${(100 * feasible / rows.length).toFixed(0)}%) |`);
L.push(`| effective sample under manager weighting | ${final.trainedOn.effectiveRows} |`, '');
L.push('## Held-out performance', '');
L.push(`${FOLDS}-fold cross-validation grouped by manager. Discrimination is measured on`);
L.push('feasible rows: already-silent rows have hazard exactly zero by construction, so');
L.push('scoring over them measures the failure definition rather than the model.', '');
L.push('Manager weighting is shown because it is the obvious response to the clustering');
L.push('and it is wrong: a manager who quits in week 3 has two rows and one who plays the');
L.push('season has sixteen, so equalising per manager up-weights early quitters ~8x and');
L.push('inflates the effective event rate. Clustering is handled by grouped CV and robust');
L.push('standard errors instead, leaving the point estimates alone.', '');
L.push('| Weighting | AUC | Brier | Skill | Calib. slope | ECE | Concordance |');
L.push('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of results) {
  L.push(`| ${r.weighting} | ${n(r.auc)} | ${n(r.brier, 4)} | ${n(r.skill)} | ${n(r.slope)} | ${n(r.ece, 4)} | ${n(r.concordance)} |`);
}
L.push('');
L.push('Calibration slope 1.0 and ECE near 0 mean the probabilities can be shown as');
L.push('percentages. That matters more here than discrimination — a league-health panel');
L.push('quotes the number, it does not just rank.', '');
L.push('## Coefficients, with cluster-robust inference', '');
L.push('Standardized scale, so magnitudes compare. Not causal: correlated features split');
L.push('their weight arbitrarily between them.', '');
L.push('The naive standard error assumes every row is independent. They are not — they');
L.push(`are ${managers} managers observed repeatedly — so the errors are clustered by manager.`);
L.push('**Inflation** is how much treating rows as independent overstated certainty.', '');
L.push('');
L.push('Inflation below 1 is not an error. A manager fails at most once per season, so a');
L.push('positive score contribution at the failure week is offset by negatives in their');
L.push('other weeks. Those within-cluster contributions partly cancel, and for the');
L.push('dominant feature the clustered error is genuinely *smaller* than the naive one —');
L.push('the repeated rows are constrained rather than redundant.', '');
L.push('| Feature | Coefficient | Naive SE | Robust SE | Inflation | z |');
L.push('| --- | --- | --- | --- | --- | --- |');
for (const c of inference) {
  L.push(`| \`${c.name}\` | ${n(c.coefficient)} | ${n(c.naiveSE, 4)} | ${n(c.robustSE, 4)} | ${n(c.inflation, 2)}x | ${n(c.z, 2)} |`);
}
L.push('');
const weak = inference.filter((c) => Math.abs(c.z) < 2);
if (weak.length) {
  L.push(`${weak.length} of ${inference.length} coefficients are within 2 robust standard errors of zero: ` +
    weak.map((c) => `\`${c.name}\``).join(', ') + '.', '');
}
L.push('## Known limits', '');
L.push('- One seed portfolio: every manager is a league-mate or a league-mate\'s');
L.push('  league-mate. A neighbourhood, not a sample of Sleeper.');
L.push('- Weakest for managers whose teams finish well, where going dark is rarest.');
L.push('- `faabSpent` is excluded: budgets vary and the crawl does not capture');
L.push('  `settings.waiver_budget`, so the column is not comparable across leagues.');
L.push('- Scoring stops once fewer than `minTrailing` weeks remain, so late-season');
L.push('  checkout is censored rather than predicted.');
writeFileSync(`${OUT}/abandonment-model-card.md`, `${L.join('\n')}\n`);

console.log(`\n  → ${OUT}/abandonment-model-card.md`);
console.log(`  → ${OUT}/abandonment-weights.json\n`);
