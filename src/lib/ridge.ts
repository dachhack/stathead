/**
 * Ridge regression (L2 regularized linear regression) in pure TypeScript.
 * Uses conjugate gradient solver for numerical stability with large feature sets.
 * Features are standardized internally so coefficients are comparable.
 */

export interface TrainedModel {
  coefficients: number[];    // standardized coefficients (feature importance)
  intercept: number;
  featureNames: string[];
  featureMeans: number[];
  featureStds: number[];
  targetMean: number;
  targetStd: number;
  rSquared: number;
  adjustedRSquared: number;
  mae: number;
  rmse: number;
  n: number;
  predictions: number[];     // predictions for training data
}

export interface PredictionResult {
  predicted: number;
  featureContributions: { name: string; value: number; contribution: number }[];
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr: number[], m: number): number {
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance) || 1;
}

/**
 * Solve (X'X + λI)β = X'y using conjugate gradient method.
 * Numerically stable for any dimensionality — no matrix inversion needed.
 */
function solveRidgeCG(
  Xs: number[][], // n x p standardized feature matrix
  ys: number[],   // n x 1 standardized target
  lambda: number,
  maxIter = 500,
  tol = 1e-8,
): number[] {
  const n = Xs.length;
  const p = Xs[0]?.length || 0;
  if (p === 0) return [];

  // Compute X'y (p x 1)
  const Xty = new Array(p).fill(0);
  for (let j = 0; j < p; j++) {
    for (let i = 0; i < n; i++) {
      Xty[j] += Xs[i][j] * ys[i];
    }
  }

  // matvec: compute (X'X + λI) * v without forming X'X explicitly
  function matvec(v: number[]): number[] {
    // First compute Xv (n x 1)
    const Xv = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < p; j++) Xv[i] += Xs[i][j] * v[j];
    }
    // Then X'(Xv) + λv
    const result = new Array(p).fill(0);
    for (let j = 0; j < p; j++) {
      for (let i = 0; i < n; i++) result[j] += Xs[i][j] * Xv[i];
      result[j] += lambda * v[j];
    }
    return result;
  }

  function dot(a: number[], b: number[]): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  // CG iteration: solve Aβ = b where A = X'X + λI, b = X'y
  const beta = new Array(p).fill(0);
  let r = Xty.slice(); // r = b - A*0 = b
  let d = r.slice();
  let rsOld = dot(r, r);

  for (let iter = 0; iter < Math.min(maxIter, p); iter++) {
    const Ad = matvec(d);
    const dAd = dot(d, Ad);
    if (dAd < 1e-15) break;

    const alpha = rsOld / dAd;
    for (let j = 0; j < p; j++) {
      beta[j] += alpha * d[j];
      r[j] -= alpha * Ad[j];
    }

    const rsNew = dot(r, r);
    if (rsNew < tol) break;

    const betaCG = rsNew / rsOld;
    for (let j = 0; j < p; j++) d[j] = r[j] + betaCG * d[j];
    rsOld = rsNew;
  }

  return beta;
}

/**
 * Train a Ridge regression model.
 * @param X - Feature matrix (n_samples x n_features), raw values
 * @param y - Target vector (n_samples)
 * @param featureNames - Names of each feature column
 * @param lambda - Regularization strength (default 1.0)
 */
export function trainRidgeRegression(
  X: number[][],
  y: number[],
  featureNames: string[],
  lambda = 1.0
): TrainedModel {
  const n = X.length;
  const p = featureNames.length;

  // Standardize features
  const featureMeans: number[] = [];
  const featureStds: number[] = [];
  for (let j = 0; j < p; j++) {
    const col = X.map((row) => row[j]);
    const m = mean(col);
    const s = std(col, m);
    featureMeans.push(m);
    featureStds.push(s);
  }

  const targetMean = mean(y);
  const targetStd = std(y, targetMean);

  // Drop near-zero-variance features
  const MIN_STD = 1e-6;
  const activeIdx: number[] = [];
  for (let j = 0; j < p; j++) {
    if (featureStds[j] > MIN_STD) activeIdx.push(j);
  }

  // Build standardized X matrix using only active features
  const Xs: number[][] = X.map((row) =>
    activeIdx.map((j) => (row[j] - featureMeans[j]) / featureStds[j])
  );
  const ys = y.map((v) => targetStd > 0 ? (v - targetMean) / targetStd : 0);

  const pActive = activeIdx.length;

  // Solve via conjugate gradient (numerically stable for any dimensionality)
  const activeCoeffs = solveRidgeCG(Xs, ys, lambda);

  // Map active coefficients back to full feature space
  const coefficients = new Array(p).fill(0);
  for (let k = 0; k < activeIdx.length; k++) {
    coefficients[activeIdx[k]] = activeCoeffs[k];
  }

  // Predictions
  const predictions = Xs.map((row) => {
    const predStd = row.reduce((s, v, j) => s + v * activeCoeffs[j], 0);
    return predStd * targetStd + targetMean;
  });

  // Metrics
  const ssRes = y.reduce((s, actual, i) => s + (actual - predictions[i]) ** 2, 0);
  const ssTot = y.reduce((s, actual) => s + (actual - targetMean) ** 2, 0);
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  const adjustedRSquared = n > pActive + 1
    ? 1 - ((1 - rSquared) * (n - 1)) / (n - pActive - 1)
    : rSquared;
  const mae = y.reduce((s, actual, i) => s + Math.abs(actual - predictions[i]), 0) / n;
  const rmse = Math.sqrt(ssRes / n);

  return {
    coefficients,
    intercept: targetMean,
    featureNames,
    featureMeans,
    featureStds,
    targetMean,
    targetStd,
    rSquared,
    adjustedRSquared,
    mae,
    rmse,
    n,
    predictions,
  };
}

/**
 * Predict for a new sample using a trained model.
 */
export function predict(
  model: TrainedModel,
  features: Record<string, number>
): PredictionResult {
  const contributions: PredictionResult['featureContributions'] = [];
  let predStd = 0;

  for (let j = 0; j < model.featureNames.length; j++) {
    const name = model.featureNames[j];
    const raw = features[name] ?? 0;
    const standardized = model.featureStds[j] > MIN_STD_PREDICT
      ? (raw - model.featureMeans[j]) / model.featureStds[j]
      : 0;
    const contrib = standardized * model.coefficients[j] * model.targetStd;
    predStd += standardized * model.coefficients[j];

    contributions.push({ name, value: raw, contribution: contrib });
  }

  const predicted = predStd * model.targetStd + model.targetMean;

  // Sort by absolute contribution
  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  return { predicted, featureContributions: contributions };
}

const MIN_STD_PREDICT = 1e-6;
