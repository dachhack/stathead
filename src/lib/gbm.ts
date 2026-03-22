/**
 * Gradient Boosting Machine (GBM) for regression in pure TypeScript.
 * Supports squared-error loss (mean) and quantile loss (for confidence intervals).
 * Uses decision stumps (single-split trees) as weak learners for simplicity.
 */

export interface GBMParams {
  nEstimators?: number;       // number of boosting rounds (default 100)
  learningRate?: number;      // shrinkage factor (default 0.1)
  maxDepth?: number;          // max tree depth (default 3)
  minSamplesLeaf?: number;    // minimum samples per leaf (default 5)
  subsample?: number;         // fraction of samples per tree (default 0.8)
  loss?: 'squared' | 'quantile';
  quantile?: number;          // quantile for quantile loss (e.g. 0.1, 0.9)
}

export interface TrainedGBM {
  trees: DecisionTree[];
  initialPrediction: number;
  learningRate: number;
  featureNames: string[];
  rSquared: number;
  adjustedRSquared: number;
  mae: number;
  rmse: number;
  n: number;
  predictions: number[];
  loss: 'squared' | 'quantile';
  quantile?: number;
}

export interface GBMPredictionResult {
  predicted: number;
  featureContributions: { name: string; value: number; contribution: number }[];
}

// ── Decision Tree ──

interface TreeNode {
  featureIndex: number;  // -1 for leaf
  threshold: number;
  value: number;         // prediction value (for leaves)
  left: TreeNode | null;
  right: TreeNode | null;
}

type DecisionTree = TreeNode;

function createLeaf(value: number): TreeNode {
  return { featureIndex: -1, threshold: 0, value, left: null, right: null };
}

// Compute quantile of an array
function quantileValue(arr: number[], q: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// For squared loss, optimal leaf value is the mean
// For quantile loss, optimal leaf value is the quantile
function optimalLeafValue(residuals: number[], loss: 'squared' | 'quantile', q: number): number {
  if (loss === 'quantile') return quantileValue(residuals, q);
  return residuals.reduce((a, b) => a + b, 0) / residuals.length;
}

// Compute loss reduction for a split
function splitGain(
  leftResiduals: number[],
  rightResiduals: number[],
  loss: 'squared' | 'quantile',
  q: number
): number {
  if (loss === 'quantile') {
    // For quantile loss, use pinball loss reduction
    const pinball = (r: number[], qv: number) => {
      const pred = quantileValue(r, qv);
      return r.reduce((s, v) => s + (v >= pred ? qv * (v - pred) : (1 - qv) * (pred - v)), 0);
    };
    const all = [...leftResiduals, ...rightResiduals];
    return pinball(all, q) - pinball(leftResiduals, q) - pinball(rightResiduals, q);
  }
  // Squared error: variance reduction
  const variance = (arr: number[]) => {
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return arr.reduce((s, v) => s + (v - m) ** 2, 0);
  };
  const all = [...leftResiduals, ...rightResiduals];
  return variance(all) - variance(leftResiduals) - variance(rightResiduals);
}

function buildTree(
  X: number[][],
  residuals: number[],
  indices: number[],
  depth: number,
  maxDepth: number,
  minSamplesLeaf: number,
  nFeatures: number,
  loss: 'squared' | 'quantile',
  q: number
): TreeNode {
  const leafResiduals = indices.map(i => residuals[i]);

  // Base case: make a leaf
  if (depth >= maxDepth || indices.length < minSamplesLeaf * 2) {
    return createLeaf(optimalLeafValue(leafResiduals, loss, q));
  }

  let bestGain = 0;
  let bestFeature = -1;
  let bestThreshold = 0;
  let bestLeftIdx: number[] = [];
  let bestRightIdx: number[] = [];

  for (let f = 0; f < nFeatures; f++) {
    // Get unique values for this feature
    const vals = [...new Set(indices.map(i => X[i][f]))].sort((a, b) => a - b);
    if (vals.length < 2) continue;

    // Try midpoints between unique values (sample if too many)
    const thresholds: number[] = [];
    const step = Math.max(1, Math.floor(vals.length / 20));
    for (let i = 0; i < vals.length - 1; i += step) {
      thresholds.push((vals[i] + vals[i + 1]) / 2);
    }

    for (const thr of thresholds) {
      const leftIdx = indices.filter(i => X[i][f] <= thr);
      const rightIdx = indices.filter(i => X[i][f] > thr);

      if (leftIdx.length < minSamplesLeaf || rightIdx.length < minSamplesLeaf) continue;

      const gain = splitGain(
        leftIdx.map(i => residuals[i]),
        rightIdx.map(i => residuals[i]),
        loss,
        q
      );

      if (gain > bestGain) {
        bestGain = gain;
        bestFeature = f;
        bestThreshold = thr;
        bestLeftIdx = leftIdx;
        bestRightIdx = rightIdx;
      }
    }
  }

  if (bestFeature === -1) {
    return createLeaf(optimalLeafValue(leafResiduals, loss, q));
  }

  return {
    featureIndex: bestFeature,
    threshold: bestThreshold,
    value: 0,
    left: buildTree(X, residuals, bestLeftIdx, depth + 1, maxDepth, minSamplesLeaf, nFeatures, loss, q),
    right: buildTree(X, residuals, bestRightIdx, depth + 1, maxDepth, minSamplesLeaf, nFeatures, loss, q),
  };
}

function predictTree(tree: TreeNode, sample: number[]): number {
  if (tree.featureIndex === -1) return tree.value;
  if (sample[tree.featureIndex] <= tree.threshold) {
    return predictTree(tree.left!, sample);
  }
  return predictTree(tree.right!, sample);
}

// Subsample indices
function subsampleIndices(n: number, fraction: number): number[] {
  const size = Math.max(1, Math.round(n * fraction));
  const indices = Array.from({ length: n }, (_, i) => i);
  // Fisher-Yates shuffle then take first `size`
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, size);
}

/**
 * Train a Gradient Boosting model.
 */
export function trainGBM(
  X: number[][],
  y: number[],
  featureNames: string[],
  params: GBMParams = {}
): TrainedGBM {
  const {
    nEstimators = 100,
    learningRate = 0.1,
    maxDepth = 3,
    minSamplesLeaf = 5,
    subsample = 0.8,
    loss = 'squared',
    quantile = 0.5,
  } = params;

  const n = X.length;
  const nFeatures = featureNames.length;
  const q = loss === 'quantile' ? quantile : 0.5;

  // Initial prediction
  const initialPrediction = loss === 'quantile'
    ? quantileValue(y, q)
    : y.reduce((a, b) => a + b, 0) / n;

  const predictions = new Array(n).fill(initialPrediction);
  const trees: DecisionTree[] = [];

  for (let iter = 0; iter < nEstimators; iter++) {
    // Compute pseudo-residuals
    const residuals = y.map((yi, i) => {
      if (loss === 'quantile') {
        // Gradient of pinball loss
        return yi >= predictions[i] ? q : -(1 - q);
      }
      return yi - predictions[i];
    });

    // Subsample
    const sampleIdx = subsample < 1 ? subsampleIndices(n, subsample) : Array.from({ length: n }, (_, i) => i);

    // Fit tree to residuals
    const tree = buildTree(X, residuals, sampleIdx, 0, maxDepth, minSamplesLeaf, nFeatures, loss, q);
    trees.push(tree);

    // Update predictions
    for (let i = 0; i < n; i++) {
      predictions[i] += learningRate * predictTree(tree, X[i]);
    }
  }

  // Metrics
  const targetMean = y.reduce((a, b) => a + b, 0) / n;
  const ssRes = y.reduce((s, actual, i) => s + (actual - predictions[i]) ** 2, 0);
  const ssTot = y.reduce((s, actual) => s + (actual - targetMean) ** 2, 0);
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  const p = featureNames.length;
  const adjustedRSquared = n > p + 1
    ? 1 - ((1 - rSquared) * (n - 1)) / (n - p - 1)
    : rSquared;
  const mae = y.reduce((s, actual, i) => s + Math.abs(actual - predictions[i]), 0) / n;
  const rmse = Math.sqrt(ssRes / n);

  return {
    trees,
    initialPrediction,
    learningRate,
    featureNames,
    rSquared,
    adjustedRSquared,
    mae,
    rmse,
    n,
    predictions: [...predictions],
    loss,
    quantile: loss === 'quantile' ? quantile : undefined,
  };
}

/**
 * Predict for a new sample using a trained GBM.
 */
export function predictGBM(
  model: TrainedGBM,
  features: Record<string, number>
): GBMPredictionResult {
  const sample = model.featureNames.map(name => features[name] ?? 0);
  let pred = model.initialPrediction;

  // Track per-tree predictions to estimate feature importance via permutation
  for (const tree of model.trees) {
    pred += model.learningRate * predictTree(tree, sample);
  }

  // Estimate feature contributions by zeroing out each feature
  const contributions: GBMPredictionResult['featureContributions'] = [];
  for (let j = 0; j < model.featureNames.length; j++) {
    const name = model.featureNames[j];
    const raw = features[name] ?? 0;

    // Predict with this feature zeroed out
    const modifiedSample = [...sample];
    modifiedSample[j] = 0;
    let predWithout = model.initialPrediction;
    for (const tree of model.trees) {
      predWithout += model.learningRate * predictTree(tree, modifiedSample);
    }

    contributions.push({
      name,
      value: raw,
      contribution: pred - predWithout,
    });
  }

  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  return { predicted: pred, featureContributions: contributions };
}

/**
 * Train a GBM ensemble that returns median + confidence interval.
 * Returns three models: lower bound, median, upper bound.
 */
export function trainGBMWithCI(
  X: number[][],
  y: number[],
  featureNames: string[],
  params: GBMParams = {},
  ciLevel = 0.80
): { median: TrainedGBM; lower: TrainedGBM; upper: TrainedGBM } {
  const alpha = (1 - ciLevel) / 2; // e.g. 0.10 for 80% CI

  const baseParams = { ...params, loss: 'squared' as const };
  const median = trainGBM(X, y, featureNames, baseParams);

  const lowerParams: GBMParams = {
    ...params,
    loss: 'quantile',
    quantile: alpha,
    nEstimators: params.nEstimators ?? 100,
  };
  const lower = trainGBM(X, y, featureNames, lowerParams);

  const upperParams: GBMParams = {
    ...params,
    loss: 'quantile',
    quantile: 1 - alpha,
    nEstimators: params.nEstimators ?? 100,
  };
  const upper = trainGBM(X, y, featureNames, upperParams);

  return { median, lower, upper };
}
