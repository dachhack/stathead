// Test script: the discrete-time survival model for manager abandonment.
// Run: npx tsx scripts/test-abandonment-model.ts
import {
  fitAbandonmentModel, managerWeights, hazard, survivalCurve, abandonmentRisk,
  feasibleRows, coefficientTable, clusterRobustInference,
} from '../src/lib/abandonmentModel';
import { personPeriods, HAZARD_FEATURE_NAMES, type PersonPeriodRow, type ManagerInput } from '../src/lib/hazardFeatures';
import { managerSeasonEngagement } from '../src/lib/engagement';
import { fitLogistic, logisticPredict } from '../src/lib/evalMetrics';
import type { LeagueSeasonRecord, TxnEvent, LeagueFormatInfo } from '../src/lib/sleeper';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; return; }
  failures.push(`${name}${detail === undefined ? '' : ` — got ${JSON.stringify(detail)}`}`);
}
function eq(name: string, a: unknown, b: unknown) { check(name, JSON.stringify(a) === JSON.stringify(b), a); }
function near(name: string, a: number, b: number, tol = 1e-6) {
  check(name, Number.isFinite(a) && Math.abs(a - b) <= tol, a);
}

const FMT = (o: Partial<LeagueFormatInfo> = {}): LeagueFormatInfo =>
  ({ type: 'Redraft', qb: '1QB', bestBall: false, idp: false, ...o });
const hist = (o: Partial<LeagueSeasonRecord>): LeagueSeasonRecord => ({
  season: '2024', leagueId: 'L1', previousLeagueId: null, leagueName: 'L', status: 'complete',
  format: FMT(), totalRosters: 12, rosterId: 1, wins: 7, losses: 7, ties: 0, pointsFor: 1500,
  regSeasonRank: 5, champion: false, runnerUp: false, players: [], ...o,
});
const ev = (o: Partial<TxnEvent>): TxnEvent => ({
  leagueId: 'L1', season: '2024', week: 1, created: 0, kind: 'free_agent',
  status: 'complete', adds: [], drops: [], faabBid: 0, partners: [], ...o,
});

// A population: quitters stop early, stayers run to the end.
function makeRows(nManagers: number, rowsPerManager = 1): PersonPeriodRow[] {
  const out: PersonPeriodRow[] = [];
  for (let i = 0; i < nManagers; i++) {
    const history: LeagueSeasonRecord[] = [];
    const events: TxnEvent[] = [];
    for (let s = 0; s < rowsPerManager; s++) {
      const leagueId = `L${i}_${s}`;
      const quits = i % 3 === 0;
      const lastWeek = quits ? 3 + (i % 4) : 15;
      history.push(hist({
        leagueId, season: String(2023 + s), totalRosters: 10 + (i % 3) * 2,
        format: FMT({ type: i % 4 === 0 ? 'Dynasty' : 'Redraft', qb: i % 5 === 0 ? 'Superflex' : '1QB' }),
      }));
      for (let w = 1; w <= lastWeek; w++) {
        if (w > 1 && (w + i) % 4 === 0) continue;   // irregular gaps
        events.push(ev({ leagueId, season: String(2023 + s), week: w }));
      }
    }
    const input: ManagerInput = {
      managerId: `m${i}`,
      rows: managerSeasonEngagement(history, events, { horizonWeek: 17 }),
      events,
    };
    out.push(...personPeriods(input, { horizonWeek: 17, target: 'stops-this-week' }));
  }
  return out;
}

// ── 1. manager weighting ──
{
  const rows = [
    ...Array.from({ length: 10 }, () => ({ managerId: 'heavy' } as PersonPeriodRow)),
    { managerId: 'light' } as PersonPeriodRow,
  ];
  const w = managerWeights(rows);
  near('weights: mean is 1, so lambda means the same either way',
    w.reduce((a, b) => a + b, 0) / w.length, 1);
  const heavyTotal = w.slice(0, 10).reduce((a, b) => a + b, 0);
  near('weights: each manager carries equal total weight', heavyTotal, w[10]);
  check('weights: the 10-row manager is down-weighted per row', w[0] < w[10], [w[0], w[10]]);

  const even = managerWeights([{ managerId: 'a' }, { managerId: 'b' }] as PersonPeriodRow[]);
  eq('weights: one row each means uniform weights', even, [1, 1]);
}

// ── 2. weighting actually changes the fit, in the direction intended ──
{
  // One manager with many rows, all events; many managers with one row, none.
  // Unweighted, the loud manager dominates the intercept.
  const loud: PersonPeriodRow[] = Array.from({ length: 60 }, (_, i) => ({
    ...makeRows(1)[0], managerId: 'loud', week: i + 2, event: 1, weeksSinceLastTxn: 0,
  }));
  const quiet: PersonPeriodRow[] = Array.from({ length: 20 }, (_, i) => ({
    ...makeRows(1)[0], managerId: `q${i}`, week: 2, event: 0, weeksSinceLastTxn: 0,
  }));
  const all = [...loud, ...quiet];

  const unweighted = fitAbandonmentModel(all, { weighting: 'none', featureNames: ['weekIndex'] });
  const weighted = fitAbandonmentModel(all, { weighting: 'manager', featureNames: ['weekIndex'] });
  const pUn = hazard(unweighted, quiet[0]);
  const pW = hazard(weighted, quiet[0]);
  check('weighting: one loud manager pulls the unweighted fit toward their outcome', pUn > 0.5, pUn);
  check('weighting: manager weights pull it back toward the majority of people', pW < pUn, [pW, pUn]);
  eq('weighting: effective sample size is people, not rows',
    weighted.trainedOn.effectiveRows, weighted.trainedOn.managers);
  eq('weighting: unweighted reports rows', unweighted.trainedOn.effectiveRows, all.length);
}

// ── 3. weights match duplicated rows ──
{
  // A row at weight 2 must fit identically to that row present twice at weight 1.
  const X = [[0], [1], [1]];
  const y = [0, 1, 1];
  const dup = fitLogistic(X, y, { lambda: 0.5 });
  const wt = fitLogistic([[0], [1]], [0, 1], { lambda: 0.5, weights: [1, 2] });
  near('weights: weight 2 equals the row twice (intercept)', wt.intercept, dup.intercept, 1e-6);
  near('weights: weight 2 equals the row twice (slope)', wt.coefficients[0], dup.coefficients[0], 1e-6);
}

// ── 4. the fit itself ──
{
  const rows = makeRows(60);
  const model = fitAbandonmentModel(rows);
  check('fit: converged', model.converged);
  eq('fit: one coefficient per feature', model.coefficients.length, HAZARD_FEATURE_NAMES.length);
  check('fit: coefficients are finite', model.coefficients.every(Number.isFinite));
  eq('fit: training counts recorded', model.trainedOn.rows, rows.length);
  eq('fit: managers counted', model.trainedOn.managers, 60);

  // Standardization must be stored, or predictions on new rows are nonsense.
  eq('fit: standardization is stored', model.mean.length, HAZARD_FEATURE_NAMES.length);
  check('fit: no zero standard deviations survive', model.sd.every((s) => s > 0), model.sd);

  const probs = rows.map((r) => hazard(model, r));
  check('fit: every hazard is a probability', probs.every((p) => p >= 0 && p <= 1));
  check('fit: hazards are not all identical', new Set(probs.map((p) => p.toFixed(6))).size > 1);

  const table = coefficientTable(model);
  eq('fit: coefficient table covers every feature', table.length, HAZARD_FEATURE_NAMES.length);
  check('fit: table is sorted by magnitude',
    table.every((c, i) => i === 0 || Math.abs(table[i - 1].coefficient) >= Math.abs(c.coefficient)));
}

// ── 5. survival curves ──
{
  const rows = makeRows(40);
  const model = fitAbandonmentModel(rows);
  const one = rows.filter((r) => r.managerId === 'm1' && r.leagueId === 'L1_0');
  const curve = survivalCurve(model, one);

  eq('survival: one point per week', curve.length, one.length);
  check('survival: weeks ascend', curve.every((p, i) => i === 0 || p.week > curve[i - 1].week));
  check('survival: never increases', curve.every((p, i) => i === 0 || p.survival <= curve[i - 1].survival + 1e-12));
  check('survival: stays a probability', curve.every((p) => p.survival >= 0 && p.survival <= 1));

  const risk = abandonmentRisk(model, one);
  near('survival: risk is one minus final survival', risk, 1 - curve[curve.length - 1].survival, 1e-12);
  check('survival: risk is a probability', risk >= 0 && risk <= 1, risk);

  // Order must not matter — the curve sorts internally.
  const shuffled = [...one].reverse();
  near('survival: input order is irrelevant', abandonmentRisk(model, shuffled), risk, 1e-12);
  check('survival: an empty season yields no curve', survivalCurve(model, []).length === 0);
  check('survival: and NaN risk rather than a false zero', Number.isNaN(abandonmentRisk(model, [])));
}

// ── 6. the feasible set ──
{
  const rows = makeRows(50);
  const feasible = feasibleRows(rows);
  check('feasible: a strict subset', feasible.length > 0 && feasible.length < rows.length,
    [feasible.length, rows.length]);
  eq('feasible: every event is in it', rows.filter((r) => r.event === 1).every((r) => r.feasible), true);
  eq('feasible: the excluded rows carry no events',
    rows.filter((r) => !r.feasible).filter((r) => r.event === 1).length, 0);
  // Which is exactly why they are excluded from the metric: a model scored over
  // them separates them for free.
  eq('feasible: excluded rows are structurally zero-hazard',
    rows.filter((r) => !r.feasible).every((r) => r.weeksSinceLastTxn > 0), true);
}

// ── 7. prediction is reproducible and standardization round-trips ──
{
  const rows = makeRows(40);
  const model = fitAbandonmentModel(rows);
  const a = rows.map((r) => hazard(model, r));
  const b = rows.map((r) => hazard(model, r));
  eq('predict: deterministic', a, b);

  // Hand-check the standardization path against a raw logistic evaluation.
  const row = rows[5];
  const v = HAZARD_FEATURE_NAMES.map((n, j) => {
    const x = (row as unknown as Record<string, number | null>)[n];
    const num = typeof x === 'number' && Number.isFinite(x) ? x : 0;
    return (num - model.mean[j]) / model.sd[j];
  });
  const manual = logisticPredict(
    { intercept: model.intercept, coefficients: model.coefficients, featureNames: model.featureNames, iterations: 0, converged: true, n: 0 },
    v,
  );
  near('predict: matches an explicit standardize-then-score', hazard(model, row), manual, 1e-12);
}

// ── 8. cluster-robust inference ──
{
  // Two seasons each, so the prior-season columns vary rather than being
  // constant zero — a single-season fixture leaves half the design with no
  // curvature and nothing to estimate.
  const base = makeRows(80, 2);
  const model = fitAbandonmentModel(base, { lambda: 1 });
  const inf = clusterRobustInference(model, base);

  eq('inference: one row per feature', inf.length, model.featureNames.length);
  const finite = inf.filter((c) => Number.isFinite(c.z));
  check('inference: the varying features get usable errors',
    Number.isFinite(inf.find((c) => c.name === 'weeksSinceLastTxn')!.robustSE)
    && Number.isFinite(inf.find((c) => c.name === 'txnToDate')!.robustSE), finite.length);
  check('inference: sorted by |z|', finite.every((c, i) => i === 0 || Math.abs(finite[i - 1].z) >= Math.abs(c.z)));
  // A column with no variation has no curvature: its error is undefined, not
  // large, and it must not be ordered as if it were significant.
  const firstUndefined = inf.findIndex((c) => !Number.isFinite(c.z));
  check('inference: undefined errors sort last',
    firstUndefined === -1 || inf.slice(firstUndefined).every((c) => !Number.isFinite(c.z)),
    inf.map((c) => c.name));
  check('inference: standard errors are finite and positive where defined',
    finite.every((c) => Number.isFinite(c.robustSE) && c.robustSE > 0));
  check('inference: coefficients match the model',
    inf.every((c) => model.coefficients[model.featureNames.indexOf(c.name)] === c.coefficient));

  // KNOWN ANSWER. Duplicate every row four times inside the SAME manager. The
  // data carries no new information — the same people, recorded four times —
  // so:
  //   the fit is unchanged (the likelihood is just scaled),
  //   the naive SE halves, because it counts 4x as many "independent" rows,
  //   the robust SE is unchanged, because there are no new clusters.
  // Inflation must therefore roughly double. This is the whole point of the
  // correction, and it is checked rather than asserted.
  const K = 4;
  const dup = base.flatMap((r) => Array.from({ length: K }, () => r));
  const dupModel = fitAbandonmentModel(dup, { lambda: 1 * K });
  const dupInf = clusterRobustInference(dupModel, dup);

  const pick = 'weeksSinceLastTxn';
  const a = inf.find((c) => c.name === pick)!;
  const b = dupInf.find((c) => c.name === pick)!;
  check('inference: duplication leaves the coefficient alone',
    Math.abs(a.coefficient - b.coefficient) < 0.05 * Math.abs(a.coefficient), [a.coefficient, b.coefficient]);
  check('inference: naive SE shrinks by ~sqrt(K) on duplicated rows',
    Math.abs(b.naiveSE / a.naiveSE - 1 / Math.sqrt(K)) < 0.1, [a.naiveSE, b.naiveSE]);
  check('inference: robust SE barely moves — no new clusters',
    Math.abs(b.robustSE / a.robustSE - 1) < 0.15, [a.robustSE, b.robustSE]);
  check('inference: so inflation roughly doubles',
    Math.abs(b.inflation / a.inflation - Math.sqrt(K)) < 0.5, [a.inflation, b.inflation]);

  // z is the coefficient over the ROBUST error, so it must not move under
  // duplication either — fake replication cannot manufacture significance.
  check('inference: duplication does not manufacture significance',
    Math.abs(b.z / a.z - 1) < 0.2, [a.z, b.z]);
}

console.log(`\n${passed} checks passed, ${failures.length} failed\n`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
console.log('✓ weighted survival fit, hazards and survival curves behave as specified');
