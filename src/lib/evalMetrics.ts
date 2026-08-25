// Evaluation metrics for the manager-behavior models.
//
// Pure functions, no data loading — so every metric below is covered by a
// known-answer test in scripts/test-engagement-mlops.ts rather than being
// trusted by inspection.
//
// Scope note: these are *probability* metrics. The manager-behavior models are
// surfaced as percentages ("this manager is 70% likely to go dark"), so
// calibration matters more than discrimination — a model that ranks perfectly
// but reports 0.9 where the truth is 0.3 is useless in the UI and dangerous in
// a league-health report. AUC is reported alongside, never alone.

export interface ReliabilityBin {
  lo: number;          // bin lower edge (predicted probability)
  hi: number;
  n: number;
  meanPredicted: number;
  meanActual: number;
}

export interface CalibrationReport {
  bins: ReliabilityBin[];
  ece: number;          // expected calibration error — n-weighted mean |gap|
  mce: number;          // maximum calibration error — worst single bin
  slope: number;        // logistic recalibration slope; 1.0 = calibrated
  intercept: number;    // 0.0 = calibrated
}

export interface BinaryReport {
  n: number;
  positives: number;
  baseRate: number;
  auc: number;
  brier: number;
  logLoss: number;
  calibration: CalibrationReport;
}

const clampProb = (p: number) => Math.min(1 - 1e-9, Math.max(1e-9, p));

// ── discrimination ──

// Rank-based (Mann-Whitney) AUC with proper tie handling: tied scores get their
// average rank, so a model that outputs one constant scores exactly 0.5.
// The trapezoid sweep used elsewhere in the repo silently rewards ties.
export function auc(probs: number[], labels: number[]): number {
  const n = probs.length;
  if (n === 0 || n !== labels.length) return NaN;
  const pos = labels.reduce((s, y) => s + (y > 0 ? 1 : 0), 0);
  const neg = n - pos;
  if (pos === 0 || neg === 0) return NaN;   // undefined, not 0.5

  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => probs[a] - probs[b]);
  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && probs[order[j + 1]] === probs[order[i]]) j++;
    const avg = (i + j + 2) / 2;   // ranks are 1-based
    for (let k = i; k <= j; k++) ranks[order[k]] = avg;
    i = j + 1;
  }
  let rankSum = 0;
  for (let k = 0; k < n; k++) if (labels[k] > 0) rankSum += ranks[k];
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

// ── proper scoring rules ──

export function brier(probs: number[], labels: number[]): number {
  if (!probs.length) return NaN;
  return probs.reduce((s, p, i) => s + (p - (labels[i] > 0 ? 1 : 0)) ** 2, 0) / probs.length;
}

export function logLoss(probs: number[], labels: number[]): number {
  if (!probs.length) return NaN;
  return -probs.reduce((s, p, i) => {
    const q = clampProb(p);
    return s + (labels[i] > 0 ? Math.log(q) : Math.log(1 - q));
  }, 0) / probs.length;
}

// Brier Skill Score against a reference model. Positive = better than the
// reference; 0 = no better. Reported instead of raw Brier because a rare-event
// Brier looks impressive on its own no matter how useless the model is.
export function brierSkillScore(modelBrier: number, referenceBrier: number): number {
  if (!(referenceBrier > 0)) return NaN;
  return 1 - modelBrier / referenceBrier;
}

// ── calibration ──

// Quantile ("equal-count") bins rather than equal-width. Hazard predictions
// pile up near zero, and equal-width bins put ~everything in bin 0, which
// hides exactly the miscalibration worth catching.
export function reliabilityBins(probs: number[], labels: number[], nBins = 10): ReliabilityBin[] {
  const n = probs.length;
  if (!n) return [];
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => probs[a] - probs[b]);
  const bins: ReliabilityBin[] = [];
  const size = n / nBins;
  for (let b = 0; b < nBins; b++) {
    const start = Math.floor(b * size);
    const end = Math.floor((b + 1) * size);
    if (end <= start) continue;
    const idx = order.slice(start, end);
    const sumP = idx.reduce((s, i) => s + probs[i], 0);
    const sumY = idx.reduce((s, i) => s + (labels[i] > 0 ? 1 : 0), 0);
    bins.push({
      lo: probs[idx[0]],
      hi: probs[idx[idx.length - 1]],
      n: idx.length,
      meanPredicted: sumP / idx.length,
      meanActual: sumY / idx.length,
    });
  }
  return bins;
}

const logit = (p: number) => { const q = clampProb(p); return Math.log(q / (1 - q)); };

// Calibration slope/intercept: refit y ~ logit(p). A well-calibrated model
// gives slope 1, intercept 0. Slope < 1 means over-confident predictions
// (spread too wide) — the usual failure mode of an over-fit hazard model.
export function calibrationCurve(probs: number[], labels: number[], nBins = 10): CalibrationReport {
  const bins = reliabilityBins(probs, labels, nBins);
  const total = bins.reduce((s, b) => s + b.n, 0) || 1;
  const ece = bins.reduce((s, b) => s + (b.n / total) * Math.abs(b.meanPredicted - b.meanActual), 0);
  const mce = bins.reduce((m, b) => Math.max(m, Math.abs(b.meanPredicted - b.meanActual)), 0);

  const fit = fitLogistic(probs.map((p) => [logit(p)]), labels.map((y) => (y > 0 ? 1 : 0)), { lambda: 0 });
  return { bins, ece, mce, slope: fit.coefficients[0], intercept: fit.intercept };
}

export function binaryReport(probs: number[], labels: number[], nBins = 10): BinaryReport {
  const positives = labels.reduce((s, y) => s + (y > 0 ? 1 : 0), 0);
  return {
    n: probs.length,
    positives,
    baseRate: probs.length ? positives / probs.length : NaN,
    auc: auc(probs, labels),
    brier: brier(probs, labels),
    logLoss: logLoss(probs, labels),
    calibration: calibrationCurve(probs, labels, nBins),
  };
}

// ── association ──

// Pearson correlation. Used by the feature audit for collinearity screening;
// pairs above |0.9| mean the model is being handed the same column twice.
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return NaN;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  if (va <= 0 || vb <= 0) return NaN;   // a constant column has no correlation
  return cov / Math.sqrt(va * vb);
}

// ── survival concordance ──

export interface SurvivalObservation {
  time: number;        // event or censoring time
  event: boolean;      // true = event observed, false = right-censored
  risk: number;        // predicted risk (higher = expected to fail sooner)
}

// Harrell's C: over all orderable pairs, how often the higher-risk subject
// failed first. Censored pairs are only orderable when the censoring time
// exceeds the other's event time; everything else is skipped, which is why
// this cannot be replaced by plain AUC on a binary label.
export function concordance(obs: SurvivalObservation[]): number {
  let comparable = 0;
  let concordant = 0;
  for (let i = 0; i < obs.length; i++) {
    for (let j = i + 1; j < obs.length; j++) {
      const a = obs[i], b = obs[j];
      let earlier: SurvivalObservation | null = null;
      let later: SurvivalObservation | null = null;
      if (a.event && a.time < b.time) { earlier = a; later = b; }
      else if (b.event && b.time < a.time) { earlier = b; later = a; }
      else if (a.event && b.event && a.time === b.time) { comparable++; concordant += 0.5; continue; }
      if (!earlier || !later) continue;   // both censored, or the earlier one is censored
      comparable++;
      if (earlier.risk > later.risk) concordant += 1;
      else if (earlier.risk === later.risk) concordant += 0.5;
    }
  }
  return comparable ? concordant / comparable : NaN;
}

// ── drift ──

export interface DriftReport {
  feature: string;
  psi: number;
  severity: 'stable' | 'moderate' | 'significant';
}

// Population Stability Index against a reference sample. Conventional reading:
// < 0.1 stable, 0.1-0.25 moderate, > 0.25 significant. Bins come from the
// REFERENCE quantiles so the comparison is against a fixed yardstick.
//
// Bin proportions are Laplace-smoothed rather than floored at a tiny epsilon.
// Many features here are low-cardinality integers (league size, trade counts),
// so a bin that is legitimately empty in one sample would otherwise take
// log(1e-12 / p) and produce a PSI in the double digits — a number that looks
// like catastrophic drift and is really just a sparse bucket.
export function psi(reference: number[], current: number[], nBins = 10): number {
  if (!reference.length || !current.length) return NaN;
  const sorted = [...reference].sort((a, b) => a - b);
  const edges: number[] = [];
  for (let b = 1; b < nBins; b++) {
    edges.push(sorted[Math.min(sorted.length - 1, Math.floor((b / nBins) * sorted.length))]);
  }
  // Collapse duplicate edges — a feature that is mostly one value (many of
  // these are) would otherwise produce empty bins and an infinite PSI.
  const uniq = [...new Set(edges)];

  const nBuckets = uniq.length + 1;
  const bucket = (xs: number[]) => {
    const counts = new Array(nBuckets).fill(0) as number[];
    for (const x of xs) {
      let b = 0;
      while (b < uniq.length && x > uniq[b]) b++;
      counts[b]++;
    }
    // Laplace (add-half) smoothing: keeps an empty bucket finite and scales
    // its penalty with sample size instead of exploding.
    return counts.map((c) => (c + 0.5) / (xs.length + 0.5 * nBuckets));
  };

  const r = bucket(reference);
  const c = bucket(current);
  let total = 0;
  for (let b = 0; b < r.length; b++) {
    total += (c[b] - r[b]) * Math.log(c[b] / r[b]);
  }
  return total;
}

export function driftReport(
  reference: Record<string, number[]>,
  current: Record<string, number[]>,
  nBins = 10,
): DriftReport[] {
  return Object.keys(reference)
    .filter((k) => current[k]?.length)
    .map((feature) => {
      const value = psi(reference[feature], current[feature], nBins);
      const severity: DriftReport['severity'] = value > 0.25 ? 'significant' : value > 0.1 ? 'moderate' : 'stable';
      return { feature, psi: value, severity };
    })
    .sort((a, b) => b.psi - a.psi);
}

// ── cross-validation ──

// Deterministic grouped k-fold: unique group keys are sorted then dealt
// round-robin into folds. No RNG, so a report re-run on the same population
// produces byte-identical metrics.
//
// Grouping matters more than the fold count here: rows from one manager across
// leagues and seasons are heavily correlated, so row-level shuffling leaks the
// manager between train and test and inflates every metric.
export function groupKFold(groups: string[], k = 5): number[] {
  const unique = [...new Set(groups)].sort();
  const foldOf = new Map<string, number>();
  unique.forEach((g, i) => foldOf.set(g, i % k));
  return groups.map((g) => foldOf.get(g)!);
}

// ── logistic regression (IRLS) ──

export interface LogisticFit {
  intercept: number;
  coefficients: number[];
  featureNames: string[];
  iterations: number;
  converged: boolean;
  n: number;
}

export interface LogisticOptions {
  lambda?: number;        // L2 penalty; the intercept is never penalized
  maxIterations?: number;
  tolerance?: number;
  featureNames?: string[];
  weights?: number[];     // per-row observation weights
}

const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

export function logisticPredict(fit: LogisticFit, x: number[]): number {
  let z = fit.intercept;
  for (let j = 0; j < fit.coefficients.length; j++) z += fit.coefficients[j] * x[j];
  return sigmoid(z);
}

// Iteratively reweighted least squares. Chosen over gradient descent because
// it has no learning rate to tune and converges in a handful of iterations,
// which keeps the report reproducible without a tuning step.
//
// Solves the weighted normal equations by Gaussian elimination with partial
// pivoting; the design here is a handful of columns, so the O(p³) cost is
// irrelevant and it is far more robust than an iterative solver.
export function fitLogistic(X: number[][], y: number[], opts: LogisticOptions = {}): LogisticFit {
  const lambda = opts.lambda ?? 1;
  const maxIterations = opts.maxIterations ?? 25;
  const tolerance = opts.tolerance ?? 1e-8;
  const n = X.length;
  const p = n ? X[0].length : 0;
  const featureNames = opts.featureNames ?? Array.from({ length: p }, (_, j) => `x${j}`);
  const w0 = opts.weights;

  // Column 0 is the intercept.
  const dim = p + 1;
  const beta = new Array(dim).fill(0) as number[];
  if (!n) return { intercept: 0, coefficients: new Array(p).fill(0), featureNames, iterations: 0, converged: false, n };

  let converged = false;
  let iter = 0;
  for (; iter < maxIterations; iter++) {
    const A = Array.from({ length: dim }, () => new Array(dim).fill(0) as number[]);
    const b = new Array(dim).fill(0) as number[];

    for (let i = 0; i < n; i++) {
      let z = beta[0];
      for (let j = 0; j < p; j++) z += beta[j + 1] * X[i][j];
      const mu = sigmoid(z);
      // Floor the IRLS weight: a saturated fit drives mu(1-mu) to 0 and the
      // normal equations become singular.
      const wI = Math.max(mu * (1 - mu), 1e-8) * (w0 ? w0[i] : 1);
      const resid = y[i] - mu;
      const zAdj = z + resid / Math.max(mu * (1 - mu), 1e-8);

      const row = [1, ...X[i]];
      for (let a = 0; a < dim; a++) {
        b[a] += wI * row[a] * zAdj;
        for (let c = a; c < dim; c++) A[a][c] += wI * row[a] * row[c];
      }
    }
    for (let a = 0; a < dim; a++) for (let c = 0; c < a; c++) A[a][c] = A[c][a];
    for (let a = 1; a < dim; a++) A[a][a] += lambda;   // intercept unpenalized

    const next = solveSymmetric(A, b);
    if (!next) break;
    const delta = next.reduce((m, v, i) => Math.max(m, Math.abs(v - beta[i])), 0);
    for (let i = 0; i < dim; i++) beta[i] = next[i];
    if (delta < tolerance) { converged = true; iter++; break; }
  }

  return { intercept: beta[0], coefficients: beta.slice(1), featureNames, iterations: iter, converged, n };
}

// Gaussian elimination with partial pivoting. Returns null on a singular
// system so callers keep the previous iterate rather than propagating NaNs.
function solveSymmetric(A: number[][], b: number[]): number[] | null {
  const dim = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < dim; col++) {
    let pivot = col;
    for (let r = col + 1; r < dim; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-14) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < dim; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      if (!factor) continue;
      for (let c = col; c <= dim; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[dim] / M[i][i]);
}

// ── summary helpers used by the report ──

export interface NumericSummary {
  n: number;
  nulls: number;
  coverage: number;   // share of rows with a usable (non-null, finite) value
  mean: number;
  sd: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
}

export function summarize(values: (number | null | undefined)[]): NumericSummary {
  const ok = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const n = values.length;
  const nulls = n - ok.length;
  if (!ok.length) {
    return { n, nulls, coverage: 0, mean: NaN, sd: NaN, min: NaN, p25: NaN, median: NaN, p75: NaN, max: NaN };
  }
  const sorted = [...ok].sort((a, b) => a - b);
  const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(f * (sorted.length - 1))))];
  const mean = ok.reduce((s, v) => s + v, 0) / ok.length;
  const sd = Math.sqrt(ok.reduce((s, v) => s + (v - mean) ** 2, 0) / ok.length);
  return {
    n, nulls, coverage: ok.length / n, mean, sd,
    min: sorted[0], p25: q(0.25), median: q(0.5), p75: q(0.75), max: sorted[sorted.length - 1],
  };
}
