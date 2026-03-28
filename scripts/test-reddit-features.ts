// Test script: compare model performance with and without Reddit sentiment features.
// Run: npx tsx scripts/test-reddit-features.ts

import { buildFeatureMatrix } from '../src/lib/buildFeatureMatrix';
import { SEASONS, PREDICT_SEASON, POSITIONS, REPLACEMENT_RANKS, FEATURES, cvR2, cvMae } from '../src/lib/featureTypes';
import type { PlayerRow } from '../src/lib/featureTypes';
import { trainRidgeRegression, predict } from '../src/lib/ridge';
import { trainGBM, predictGBM } from '../src/lib/gbm';

const MAX_ADP = 150;
const LAMBDA = 5;
const REDDIT_KEYS = [
  'redditMentions1w', 'redditSentiment1w', 'redditHype1w',
  'redditMentions4w', 'redditSentiment4w',
  'redditMentionVelocity', 'redditSentimentVelocity',
];

async function main() {
  console.log('Building feature matrix...\n');
  const result = await buildFeatureMatrix({
    seasons: SEASONS,
    predictSeason: PREDICT_SEASON,
    positions: POSITIONS,
    replacementRanks: REPLACEMENT_RANKS,
    vorBasis: 'total',
    onStatus: (msg) => console.log(`  ${msg}`),
  });

  console.log(`\n${result.rows.length} training rows, ${result.predRows.length} prediction rows\n`);

  // Check if Reddit features have any non-zero data
  let redditNonZero = 0;
  for (const row of result.rows) {
    if (REDDIT_KEYS.some((k) => (row.features[k] || 0) !== 0)) redditNonZero++;
  }
  console.log(`Reddit features populated: ${redditNonZero}/${result.rows.length} rows have non-zero Reddit data\n`);

  // Show some example Reddit feature values
  const sample = result.rows.filter((r) => REDDIT_KEYS.some((k) => (r.features[k] || 0) > 0)).slice(0, 5);
  for (const r of sample) {
    console.log(`  ${r.name} (${r.position}, ${r.season}): mentions4w=${r.features.redditMentions4w}, sentiment4w=${r.features.redditSentiment4w}, hype1w=${r.features.redditHype1w}, velocity=${r.features.redditMentionVelocity}`);
  }
  console.log();

  // Train models with and without Reddit features
  const GBM_OPTS = { nEstimators: 150, learningRate: 0.08, maxDepth: 3, subsample: 0.8 };
  const GBM_OPTS_CV = { nEstimators: 80, learningRate: 0.10, maxDepth: 3, subsample: 0.8 };

  console.log('='.repeat(80));
  console.log('MODEL COMPARISON: WITH vs WITHOUT Reddit Sentiment Features');
  console.log('='.repeat(80));
  console.log();

  for (const pos of POSITIONS) {
    const posRows = result.rows.filter((r: PlayerRow) => r.position === pos && r.adp <= MAX_ADP);
    if (posRows.length < 10) continue;

    const allFeatures = FEATURES.filter((f) => f.positions.includes(pos));
    const allKeys = allFeatures.map((f) => f.key);
    const noRedditKeys = allKeys.filter((k) => !REDDIT_KEYS.includes(k));

    const uniqueSeasons = [...new Set(posRows.map((r: PlayerRow) => r.season))].sort();

    // LOSO CV with all features
    const losoAll: { actual: number[]; pred: number[] } = { actual: [], pred: [] };
    const losoNoReddit: { actual: number[]; pred: number[] } = { actual: [], pred: [] };
    const losoRidgeAll: { actual: number[]; pred: number[] } = { actual: [], pred: [] };
    const losoRidgeNoReddit: { actual: number[]; pred: number[] } = { actual: [], pred: [] };

    if (uniqueSeasons.length >= 3) {
      for (const held of uniqueSeasons) {
        const trainR = posRows.filter((r: PlayerRow) => r.season !== held);
        const testR = posRows.filter((r: PlayerRow) => r.season === held);
        if (trainR.length < 8 || testR.length === 0) continue;

        const msl = Math.max(3, Math.round(trainR.length * 0.05));

        // With all features (including Reddit)
        const XtrAll = trainR.map((r: PlayerRow) => allKeys.map((k) => r.features[k] || 0));
        const ytr = trainR.map((r: PlayerRow) => r.vor);

        const gbmAll = trainGBM(XtrAll, ytr, allKeys, { ...GBM_OPTS_CV, minSamplesLeaf: msl });
        const ridgeAll = trainRidgeRegression(XtrAll, ytr, allKeys, LAMBDA);

        // Without Reddit features
        const XtrNoR = trainR.map((r: PlayerRow) => noRedditKeys.map((k) => r.features[k] || 0));
        const gbmNoR = trainGBM(XtrNoR, ytr, noRedditKeys, { ...GBM_OPTS_CV, minSamplesLeaf: msl });
        const ridgeNoR = trainRidgeRegression(XtrNoR, ytr, noRedditKeys, LAMBDA);

        for (const row of testR) {
          losoAll.actual.push(row.vor);
          losoAll.pred.push(predictGBM(gbmAll, row.features).predicted);

          losoNoReddit.actual.push(row.vor);
          losoNoReddit.pred.push(predictGBM(gbmNoR, row.features).predicted);

          losoRidgeAll.actual.push(row.vor);
          losoRidgeAll.pred.push(predict(ridgeAll, row.features).predicted);

          losoRidgeNoReddit.actual.push(row.vor);
          losoRidgeNoReddit.pred.push(predict(ridgeNoR, row.features).predicted);
        }
      }
    }

    // Full-data model for feature importance
    const XFull = posRows.map((r: PlayerRow) => allKeys.map((k) => r.features[k] || 0));
    const yFull = posRows.map((r: PlayerRow) => r.vor);
    const gbmFull = trainGBM(XFull, yFull, allKeys, {
      ...GBM_OPTS,
      minSamplesLeaf: Math.max(3, Math.round(posRows.length * 0.05)),
    });

    // Feature importance for Reddit features
    const contribSums = new Map<string, number>();
    for (const k of REDDIT_KEYS) contribSums.set(k, 0);
    for (const row of posRows) {
      const result = predictGBM(gbmFull, row.features);
      for (const fc of result.featureContributions) {
        if (REDDIT_KEYS.includes(fc.name)) {
          contribSums.set(fc.name, (contribSums.get(fc.name) || 0) + Math.abs(fc.contribution));
        }
      }
    }
    const n = posRows.length;

    console.log(`── ${pos} (n=${posRows.length}) ${'─'.repeat(60)}`);
    console.log();
    console.log('  GBM LOSO Cross-Validation:');
    console.log(`    With Reddit:    R² = ${cvR2(losoAll.actual, losoAll.pred).toFixed(3)}, MAE = ${cvMae(losoAll.actual, losoAll.pred).toFixed(3)}`);
    console.log(`    Without Reddit: R² = ${cvR2(losoNoReddit.actual, losoNoReddit.pred).toFixed(3)}, MAE = ${cvMae(losoNoReddit.actual, losoNoReddit.pred).toFixed(3)}`);
    const r2Diff = cvR2(losoAll.actual, losoAll.pred) - cvR2(losoNoReddit.actual, losoNoReddit.pred);
    const maeDiff = cvMae(losoAll.actual, losoAll.pred) - cvMae(losoNoReddit.actual, losoNoReddit.pred);
    console.log(`    Delta:          R² ${r2Diff >= 0 ? '+' : ''}${r2Diff.toFixed(3)}, MAE ${maeDiff >= 0 ? '+' : ''}${maeDiff.toFixed(3)} ${r2Diff > 0 ? '✅ IMPROVED' : r2Diff < -0.01 ? '❌ WORSE' : '➖ NEUTRAL'}`);
    console.log();
    console.log('  Ridge LOSO Cross-Validation:');
    console.log(`    With Reddit:    R² = ${cvR2(losoRidgeAll.actual, losoRidgeAll.pred).toFixed(3)}, MAE = ${cvMae(losoRidgeAll.actual, losoRidgeAll.pred).toFixed(3)}`);
    console.log(`    Without Reddit: R² = ${cvR2(losoRidgeNoReddit.actual, losoRidgeNoReddit.pred).toFixed(3)}, MAE = ${cvMae(losoRidgeNoReddit.actual, losoRidgeNoReddit.pred).toFixed(3)}`);
    const r2DiffR = cvR2(losoRidgeAll.actual, losoRidgeAll.pred) - cvR2(losoRidgeNoReddit.actual, losoRidgeNoReddit.pred);
    console.log(`    Delta:          R² ${r2DiffR >= 0 ? '+' : ''}${r2DiffR.toFixed(3)} ${r2DiffR > 0 ? '✅' : r2DiffR < -0.01 ? '❌' : '➖'}`);
    console.log();

    console.log('  Reddit Feature Importance (avg |contribution|):');
    const sorted = [...contribSums.entries()]
      .map(([k, v]) => ({ key: k, avgContrib: v / n }))
      .sort((a, b) => b.avgContrib - a.avgContrib);
    for (const { key, avgContrib } of sorted) {
      const bar = '█'.repeat(Math.min(40, Math.round(avgContrib * 100)));
      console.log(`    ${key.padEnd(28)} ${avgContrib.toFixed(4)} ${bar}`);
    }
    console.log();
  }
}

main().catch((e) => {
  console.error('Test failed:', e.message || e);
  process.exit(1);
});
