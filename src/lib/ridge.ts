/**
 * Ridge regression (L2 regularized linear regression) in pure TypeScript.
 * Solves: β = (X'X + λI)^(-1) X'y
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

// Matrix operations
function matMul(a: number[][], b: number[][]): number[][] {
  const rows = a.length;
  const cols = b[0].length;
  const k = b.length;
  const result: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      let sum = 0;
      for (let l = 0; l < k; l++) sum += a[i][l] * b[l][j];
      result[i][j] = sum;
    }
  }
  return result;
}

function transpose(m: number[][]): number[][] {
  const rows = m.length;
  const cols = m[0].length;
  const result: number[][] = Array.from({ length: cols }, () => new Array(rows));
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) result[j][i] = m[i][j];
  }
  return result;
}

// Gaussian elimination with partial pivoting for matrix inversion
function invert(matrix: number[][]): number[][] | null {
  const n = matrix.length;
  // Augmented matrix [A | I]
  const aug: number[][] = matrix.map((row, i) => {
    const extended = new Array(2 * n).fill(0);
    for (let j = 0; j < n; j++) extended[j] = row[j];
    extended[n + i] = 1;
    return extended;
  });

  for (let col = 0; col < n; col++) {
    // Partial pivoting
    let maxRow = col;
    let maxVal = Math.abs(aug[col][col]);
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > maxVal) {
        maxVal = Math.abs(aug[row][col]);
        maxRow = row;
      }
    }
    if (maxVal < 1e-12) return null; // Singular

    if (maxRow !== col) {
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    }

    // Eliminate column
    const pivot = aug[col][col];
    for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivot;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row][col];
      for (let j = 0; j < 2 * n; j++) aug[row][j] -= factor * aug[col][j];
    }
  }

  // Extract inverse
  return aug.map((row) => row.slice(n));
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr: number[], m: number): number {
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance) || 1; // avoid division by zero
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

  // Drop near-zero-variance features to prevent numerical instability
  // in large feature matrices (e.g. 80+ features for RB/WR)
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

  // X'X + λI (pActive x pActive)
  const Xt = transpose(Xs);
  const XtX = matMul(Xt, Xs.map((row) => [...row]));

  // Add regularization
  for (let i = 0; i < pActive; i++) XtX[i][i] += lambda;

  // Invert (X'X + λI)
  const XtXinv = invert(XtX);
  if (!XtXinv) {
    throw new Error('Matrix is singular, cannot train model');
  }

  // X'y
  const Xty: number[][] = Xt.map((row) => [row.reduce((s, v, i) => s + v * ys[i], 0)]);

  // β = (X'X + λI)^(-1) X'y
  const betaMatrix = matMul(XtXinv, Xty);
  const activeCoeffs = betaMatrix.map((row) => row[0]);

  // Map active coefficients back to full feature space (0 for dropped features)
  const coefficients = new Array(p).fill(0);
  for (let k = 0; k < activeIdx.length; k++) {
    coefficients[activeIdx[k]] = activeCoeffs[k];
  }

  // Intercept in standardized space is 0 (since we centered)
  // Convert back: for each sample, predict in standardized space then unstandardize
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
    const standardized = model.featureStds[j] > 0 ? (raw - model.featureMeans[j]) / model.featureStds[j] : 0;
    const contrib = standardized * model.coefficients[j] * model.targetStd;
    predStd += standardized * model.coefficients[j];

    contributions.push({ name, value: raw, contribution: contrib });
  }

  const predicted = predStd * model.targetStd + model.targetMean;

  // Sort by absolute contribution
  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  return { predicted, featureContributions: contributions };
}
