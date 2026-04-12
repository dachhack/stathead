// Feature evaluation: find optimal feature subsets per position.
// Tests different feature counts and reports LOSO CV R² for each.
// Run: NODE_OPTIONS='--max-old-space-size=6144' npx tsx scripts/evaluate-features.ts

import { buildFeatureMatrix } from '../src/lib/buildFeatureMatrix';
import { SEASONS, PREDICT_SEASON, POSITIONS, FEATURES, cvR2, cvMae } from '../src/lib/featureTypes';
import type { PlayerRow } from '../src/lib/featureTypes';
import { trainGBM, predictGBM } from '../src/lib/gbm';
import { trainRidgeRegression, predict } from '../src/lib/ridge';

const MAX_ADP = 150;

async function main() {
  console.log('Building feature matrix...\n');
  const result = await buildFeatureMatrix({
    seasons: SEASONS,
    predictSeason: PREDICT_SEASON,
    positions: POSITIONS,
    replacementRanks: {},
    vorBasis: 'total',
    onStatus: (msg) => console.log(`  ${msg}`),
  });

  console.log(`\n${result.rows.length} training rows\n`);

  for (const pos of POSITIONS) {
    const posRows = result.rows.filter((r: PlayerRow) => r.position === pos && r.adp <= MAX_ADP);
    if (posRows.length < 20) continue;

    const allFeatures = FEATURES.filter((f) => f.positions.includes(pos));
    const allKeys = allFeatures.map((f) => f.key);
    const uniqueSeasons = [...new Set(posRows.map((r: PlayerRow) => r.season))].sort();

    console.log(`${'='.repeat(80)}`);
    console.log(`${pos} (N=${posRows.length}, ${uniqueSeasons.length} seasons, ${allKeys.length} total features)`);
    console.log(`${'='.repeat(80)}\n`);

    // Step 1: Rank all features by importance using a full GBM
    console.log(`  Ranking all ${allKeys.length} features...`);
    const X = posRows.map((r: PlayerRow) => allKeys.map((k) => r.features[k] || 0));
    const y = posRows.map((r: PlayerRow) => r.vor);
    const fullGbm = trainGBM(X, y, allKeys, {
      nEstimators: 100, learningRate: 0.08, maxDepth: 2, subsample: 0.8,
      minSamplesLeaf: Math.max(5, Math.round(posRows.length * 0.08)),
    });

    // Get feature importance
    const importanceSums = new Array(allKeys.length).fill(0);
    const sampleN = Math.min(150, posRows.length);
    const sampleStep = Math.max(1, Math.floor(posRows.length / sampleN));
    for (let i = 0; i < posRows.length; i += sampleStep) {
      const pred = predictGBM(fullGbm, posRows[i].features);
      for (const fc of pred.featureContributions) {
        const idx = allKeys.indexOf(fc.name);
        if (idx >= 0) importanceSums[idx] += Math.abs(fc.contribution);
      }
    }

    const ranked = allKeys
      .map((k, i) => ({ key: k, imp: importanceSums[i], label: allFeatures[i].label, cat: allFeatures[i].category }))
      .sort((a, b) => b.imp - a.imp);

    // Print top 30 features
    console.log(`\n  Top 30 features by importance:`);
    for (let i = 0; i < Math.min(30, ranked.length); i++) {
      const f = ranked[i];
      const bar = '█'.repeat(Math.min(30, Math.round(f.imp * 50)));
      console.log(`    ${String(i + 1).padStart(2)}. ${f.label.padEnd(35)} ${f.cat.padEnd(15)} ${f.imp.toFixed(4)} ${bar}`);
    }

    // Step 2: Test different feature counts
    const featureCounts = [5, 8, 10, 12, 15, 20, 25, 30, 40, 50, allKeys.length];
    console.log(`\n  LOSO CV R² by feature count:`);
    console.log(`  ${'Count'.padEnd(8)} ${'GBM R²'.padEnd(10)} ${'Ridge R²'.padEnd(10)} ${'GBM MAE'.padEnd(10)} ${'Best?'}`);

    let bestR2 = -Infinity;
    let bestCount = 0;

    for (const count of featureCounts) {
      if (count > allKeys.length) continue;

      const selectedKeys = ranked.slice(0, count).map((r) => r.key);

      // LOSO CV
      const losoActuals: number[] = [];
      const losoPredGbm: number[] = [];
      const losoPredRidge: number[] = [];

      if (uniqueSeasons.length >= 3) {
        for (const held of uniqueSeasons) {
          const trainR = posRows.filter((r: PlayerRow) => r.season !== held);
          const testR = posRows.filter((r: PlayerRow) => r.season === held);
          if (trainR.length < 8 || testR.length === 0) continue;

          const Xtr = trainR.map((r: PlayerRow) => selectedKeys.map((k) => r.features[k] || 0));
          const ytr = trainR.map((r: PlayerRow) => r.vor);
          const msl = Math.max(3, Math.round(trainR.length * 0.08));

          const depth = count <= 15 ? 2 : 3;
          const nEst = count <= 15 ? 60 : 80;
          const lr = count <= 15 ? 0.05 : 0.08;
          const lambda = count <= 15 ? 15 : 5;

          const foldGbm = trainGBM(Xtr, ytr, selectedKeys, {
            nEstimators: nEst, learningRate: lr, maxDepth: depth,
            subsample: 0.8, minSamplesLeaf: msl,
          });
          const foldRidge = trainRidgeRegression(Xtr, ytr, selectedKeys, lambda);

          for (const row of testR) {
            losoActuals.push(row.vor);
            losoPredGbm.push(predictGBM(foldGbm, row.features).predicted);
            losoPredRidge.push(predict(foldRidge, row.features).predicted);
          }
        }
      }

      const r2 = cvR2(losoActuals, losoPredGbm);
      const r2r = cvR2(losoActuals, losoPredRidge);
      const mae = cvMae(losoActuals, losoPredGbm);
      const isBest = r2 > bestR2;
      if (isBest) { bestR2 = r2; bestCount = count; }

      console.log(`  ${String(count).padEnd(8)} ${r2.toFixed(3).padEnd(10)} ${r2r.toFixed(3).padEnd(10)} ${mae.toFixed(3).padEnd(10)} ${isBest ? '⭐' : ''}`);
    }

    console.log(`\n  ➤ Best: ${bestCount} features, R² = ${bestR2.toFixed(3)}`);

    // Print the optimal feature set
    console.log(`\n  Optimal ${bestCount}-feature set:`);
    for (let i = 0; i < Math.min(bestCount, ranked.length); i++) {
      console.log(`    ${ranked[i].key}`);
    }
    console.log();
  }
}

main().catch((e) => {
  console.error('Evaluation failed:', e.message || e);
  process.exit(1);
});
