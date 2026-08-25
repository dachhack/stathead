// Discrete-time survival model for manager abandonment.
//
// FRAMING. Failure time T is L+1, the first week after a manager's last
// transaction. The model is the discrete hazard h(w) = P(T = w | T >= w), fitted
// as a pooled logistic over person-period rows — the standard equivalence, and
// it means the whole thing is one weighted logistic regression rather than a
// bespoke likelihood.
//
// THE STRUCTURAL ZERO, and why it is not a hack. Under this failure definition
// a manager can only die the week after transacting, so any row where they were
// already silent has hazard exactly 0. Those rows are real members of the risk
// set — the manager had not failed yet — so they belong in the likelihood and
// are kept. But they are trivially separable, and scoring over them inflates
// AUC from 0.767 to 0.873 without the model having learned anything. So:
//   fit on every at-risk row, report on the feasible ones.
//
// CLUSTERING, AND WHY WEIGHTING IS NOT THE ANSWER. Rows from one manager are the
// same person's habits repeated: 67% of rows come from managers with more than
// one, and a single manager holds 111 — 7% of the training set. The obvious fix
// is to weight each manager equally. Measured on the real population, it makes
// the model worse on every metric:
//
//   weighting   AUC     Brier    skill    calib. slope
//   none        0.766   0.0386    0.050   0.998
//   manager     0.651   0.0466   -0.146   0.196
//
// The reason is structural, not a tuning problem. A manager who quits in week 3
// has two person-period rows; one who plays the whole season has sixteen.
// Equalising per manager therefore up-weights early quitters by ~8x, inflating
// the effective event rate far above the true weekly hazard. The intercept
// follows it up, calibration collapses, and the coefficients are fitted to a
// population that does not exist.
//
// In survival analysis each person-period row is a genuine observation of "at
// risk this week", and discarding the long survivors' rows discards exactly
// what makes the baseline hazard right. Clustering is a problem of INFERENCE
// and EVALUATION, not of the point estimate:
//   - evaluation: cross-validate grouped by manager (never split a person)
//   - inference: cluster-robust standard errors, below
//
// So the default is unweighted. The weighting option is kept because it is the
// obvious thing to reach for, and leaving it in with the numbers attached is
// more useful than removing it and letting someone rediscover this.
//
// Class weighting is also not offered. It would balance a 4% event rate and
// destroy calibration, and a calibrated probability is what the UI needs —
// "38% likely to be done" has to mean 38%.
import { fitLogistic, logisticPredict, type LogisticFit } from './evalMetrics';
import { hazardVector, HAZARD_FEATURE_NAMES, type PersonPeriodRow } from './hazardFeatures';

export type Weighting = 'none' | 'manager';

export interface AbandonmentModel {
  featureNames: string[];
  mean: number[];
  sd: number[];
  intercept: number;
  coefficients: number[];
  weighting: Weighting;
  lambda: number;
  converged: boolean;
  trainedOn: { rows: number; managers: number; events: number; effectiveRows: number };
}

export interface FitOptions {
  featureNames?: readonly string[];
  weighting?: Weighting;
  lambda?: number;
}

// One unit of weight per manager, spread across their rows. A manager with 111
// rows contributes as much as one with a single row, which is the point.
export function managerWeights(rows: PersonPeriodRow[]): number[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.managerId, (counts.get(r.managerId) ?? 0) + 1);
  const raw = rows.map((r) => 1 / (counts.get(r.managerId) ?? 1));
  // Rescale to mean 1 so lambda means the same thing whether or not weighting
  // is on — otherwise turning weights on silently multiplies the penalty.
  const total = raw.reduce((a, b) => a + b, 0);
  const scale = raw.length / (total || 1);
  return raw.map((w) => w * scale);
}

function standardize(X: number[][]): { mean: number[]; sd: number[] } {
  const dim = X[0]?.length ?? 0;
  const mean = new Array(dim).fill(0) as number[];
  const sd = new Array(dim).fill(1) as number[];
  if (!X.length) return { mean, sd };
  for (let j = 0; j < dim; j++) {
    mean[j] = X.reduce((s, r) => s + r[j], 0) / X.length;
    const v = X.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / X.length;
    // A constant column would divide by zero; leaving sd at 1 turns it into an
    // all-zero column, which the L2 penalty then shrinks away harmlessly.
    sd[j] = Math.sqrt(v) || 1;
  }
  return { mean, sd };
}

export function fitAbandonmentModel(rows: PersonPeriodRow[], opts: FitOptions = {}): AbandonmentModel {
  const featureNames = [...(opts.featureNames ?? HAZARD_FEATURE_NAMES)];
  const weighting = opts.weighting ?? 'none';
  const lambda = opts.lambda ?? 1;

  const raw = rows.map((r) => hazardVector(r, featureNames));
  const { mean, sd } = standardize(raw);
  const X = raw.map((v) => v.map((x, j) => (x - mean[j]) / sd[j]));
  const y = rows.map((r) => r.event);
  const weights = weighting === 'manager' ? managerWeights(rows) : undefined;

  const fit: LogisticFit = fitLogistic(X, y, { lambda, weights, featureNames });
  const managers = new Set(rows.map((r) => r.managerId)).size;

  return {
    featureNames,
    mean,
    sd,
    intercept: fit.intercept,
    coefficients: fit.coefficients,
    weighting,
    lambda,
    converged: fit.converged,
    trainedOn: {
      rows: rows.length,
      managers,
      events: y.reduce((a, b) => a + b, 0),
      // With manager weighting the model effectively sees one observation per
      // manager, not one per row. Reporting it keeps the sample size honest.
      effectiveRows: weighting === 'manager' ? managers : rows.length,
    },
  };
}

// P(the terminal silence begins at this week | it has not begun yet).
export function hazard(model: AbandonmentModel, row: PersonPeriodRow): number {
  const v = hazardVector(row, model.featureNames).map((x, j) => (x - model.mean[j]) / model.sd[j]);
  return logisticPredict(
    { intercept: model.intercept, coefficients: model.coefficients, featureNames: model.featureNames, iterations: 0, converged: true, n: 0 },
    v,
  );
}

export interface SurvivalPoint {
  week: number;
  hazard: number;
  survival: number;   // P(still active through this week)
}

// Chained survival across a manager-season's weeks. S(w) = prod(1 - h(k)) for
// k <= w, which is what turns a per-week hazard into "will they last the
// season" — the number a league-health panel actually wants.
export function survivalCurve(model: AbandonmentModel, rows: PersonPeriodRow[]): SurvivalPoint[] {
  const ordered = [...rows].sort((a, b) => a.week - b.week);
  let survival = 1;
  return ordered.map((r) => {
    const h = hazard(model, r);
    survival *= 1 - h;
    return { week: r.week, hazard: h, survival };
  });
}

// P(this manager-season ends in abandonment), from the chained hazards.
export function abandonmentRisk(model: AbandonmentModel, rows: PersonPeriodRow[]): number {
  const curve = survivalCurve(model, rows);
  return curve.length ? 1 - curve[curve.length - 1].survival : NaN;
}

// Rows where the hazard is not structurally zero — the manager transacted last
// week, so this week could genuinely be their last. Metrics computed over the
// other rows measure the failure definition, not the model.
export function feasibleRows(rows: PersonPeriodRow[]): PersonPeriodRow[] {
  return rows.filter((r) => r.feasible);
}

// ── cluster-robust inference ──

// Gauss-Jordan inverse. The design here is a couple of dozen columns, so the
// cubic cost is irrelevant and an explicit inverse is clearer than a solve.
function invert(A: number[][]): number[][] | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const d = M[col][col];
    for (let c = 0; c < 2 * n; c++) M[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (!f) continue;
      for (let c = 0; c < 2 * n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row.slice(n));
}

export interface CoefficientInference {
  name: string;
  coefficient: number;
  naiveSE: number;       // assumes every row is independent
  robustSE: number;      // clustered by manager
  inflation: number;     // robustSE / naiveSE — how much independence overstated certainty
  z: number;             // coefficient / robustSE
}

// Cluster-robust (sandwich) covariance, clustered by manager.
//
// The naive standard errors assume 17,621 independent observations. They are
// not: they are 747 managers observed repeatedly, and treating repeats as new
// evidence overstates certainty. The sandwich sums the score contributions
// WITHIN each manager before taking the outer product, which is exactly the
// correction — and the inflation factor it reports is a direct measure of how
// much the clustering was costing.
export function clusterRobustInference(
  model: AbandonmentModel,
  rows: PersonPeriodRow[],
): CoefficientInference[] {
  const dim = model.coefficients.length + 1;   // + intercept
  const X = rows.map((r) => {
    const v = hazardVector(r, model.featureNames).map((x, j) => (x - model.mean[j]) / model.sd[j]);
    return [1, ...v];
  });
  const p = rows.map((r) => hazard(model, r));

  // Bread: (X' W X + lambda I)^-1, matching the penalised fit.
  const bread = Array.from({ length: dim }, () => new Array(dim).fill(0) as number[]);
  for (let i = 0; i < rows.length; i++) {
    const w = Math.max(p[i] * (1 - p[i]), 1e-10);
    for (let a = 0; a < dim; a++) for (let b = 0; b < dim; b++) bread[a][b] += w * X[i][a] * X[i][b];
  }
  for (let a = 1; a < dim; a++) bread[a][a] += model.lambda;
  const breadInv = invert(bread);
  if (!breadInv) {
    return model.featureNames.map((name, i) => ({
      name, coefficient: model.coefficients[i], naiveSE: NaN, robustSE: NaN, inflation: NaN, z: NaN,
    }));
  }

  // Meat: sum over clusters of the summed score, outer-producted.
  const byCluster = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const resid = rows[i].event - p[i];
    const key = rows[i].managerId;
    let acc = byCluster.get(key);
    if (!acc) { acc = new Array(dim).fill(0); byCluster.set(key, acc); }
    for (let a = 0; a < dim; a++) acc[a] += resid * X[i][a];
  }
  const meat = Array.from({ length: dim }, () => new Array(dim).fill(0) as number[]);
  for (const acc of byCluster.values()) {
    for (let a = 0; a < dim; a++) for (let b = 0; b < dim; b++) meat[a][b] += acc[a] * acc[b];
  }

  const cov = Array.from({ length: dim }, () => new Array(dim).fill(0) as number[]);
  for (let a = 0; a < dim; a++) {
    for (let b = 0; b < dim; b++) {
      let s = 0;
      for (let u = 0; u < dim; u++) for (let v = 0; v < dim; v++) s += breadInv[a][u] * meat[u][v] * breadInv[v][b];
      cov[a][b] = s;
    }
  }

  return model.featureNames.map((name, i) => {
    const k = i + 1;   // skip the intercept
    const naiveSE = Math.sqrt(Math.max(breadInv[k][k], 0));
    const robustSE = Math.sqrt(Math.max(cov[k][k], 0));
    return {
      name,
      coefficient: model.coefficients[i],
      naiveSE,
      robustSE,
      inflation: naiveSE > 0 ? robustSE / naiveSE : NaN,
      z: robustSE > 0 ? model.coefficients[i] / robustSE : NaN,
    };
  }).sort((a, b) => {
    // A column with no variation in the training data has no curvature, so its
    // standard error is undefined rather than large. Sort those last instead of
    // letting NaN scramble the ordering.
    const az = Number.isFinite(a.z) ? Math.abs(a.z) : -Infinity;
    const bz = Number.isFinite(b.z) ? Math.abs(b.z) : -Infinity;
    return bz - az;
  });
}

// Coefficients on the standardized scale, so magnitudes are comparable across
// features. Not causal — a correlated pair splits its weight arbitrarily.
export function coefficientTable(model: AbandonmentModel): { name: string; coefficient: number }[] {
  return model.featureNames
    .map((name, i) => ({ name, coefficient: model.coefficients[i] }))
    .sort((a, b) => Math.abs(b.coefficient) - Math.abs(a.coefficient));
}
