// Build-time precomputation of feature matrix + trained models.
// Run with: npx tsx scripts/precompute-features.ts
// Outputs: public/data/feature-matrix.json (includes trained models)

import { buildFeatureMatrix } from '../src/lib/buildFeatureMatrix';
import { SEASONS, PREDICT_SEASON, POSITIONS, REPLACEMENT_RANKS, FEATURES, cvR2, cvMae } from '../src/lib/featureTypes';
import type { PlayerRow } from '../src/lib/featureTypes';
import { trainRidgeRegression, predict } from '../src/lib/ridge';
import { trainGBM, predictGBM } from '../src/lib/gbm';
import { writeFileSync, mkdirSync } from 'fs';

if (global.gc) console.log('GC exposed — will collect between seasons');

const MAX_ADP = 150;
const LAMBDA = 5;

async function main() {
  console.log('Precomputing feature matrix + models...');
  const start = Date.now();

  const result = await buildFeatureMatrix({
    seasons: SEASONS,
    predictSeason: PREDICT_SEASON,
    positions: POSITIONS,
    replacementRanks: REPLACEMENT_RANKS,
    vorBasis: 'total',
    onStatus: (msg) => {
      console.log(`  ${msg}`);
      if (global.gc) global.gc();
    },
  });

  console.log(`  Features done: ${result.rows.length} training rows, ${result.predRows.length} prediction rows`);

  // Train models (same logic as trainModelsOnly in ADPFactorAnalysis)
  console.log('  Training models...');
  const PROJ_KEYS = ['projTeamPassAtt','projTeamPassVolChg','projPlayerPPR','projPlayerVsExpected','projTargetShare'];
  const GBM_OPTS_FULL = { nEstimators: 150, learningRate: 0.08, maxDepth: 3, subsample: 0.8 };
  const GBM_OPTS_CV   = { nEstimators: 80,  learningRate: 0.10, maxDepth: 3, subsample: 0.8 };

  const models: Record<string, unknown>[] = [];
  for (const pos of POSITIONS) {
    console.log(`    Training ${pos}...`);
    const posRows = result.rows.filter((r: PlayerRow) => r.position === pos && r.adp <= MAX_ADP);
    if (posRows.length < 10) continue;

    const posFeatures = FEATURES.filter((f) => f.positions.includes(pos));
    const featureKeys = posFeatures.map((f) => f.key);
    const featureLabels = posFeatures.map((f) => f.label);
    const baselineKeys = featureKeys.filter((k) => !PROJ_KEYS.includes(k));

    const X = posRows.map((r: PlayerRow) => featureKeys.map((k) => r.features[k] || 0));
    const y = posRows.map((r: PlayerRow) => r.vor);

    const ridgeModel = trainRidgeRegression(X, y, featureKeys, LAMBDA);
    const gbmModel = trainGBM(X, y, featureKeys, {
      ...GBM_OPTS_FULL,
      minSamplesLeaf: Math.max(3, Math.round(posRows.length * 0.05)),
    });

    // LOSO cross-validation
    const uniqueSeasons = [...new Set(posRows.map((r: PlayerRow) => r.season))].sort();
    const losoActuals: number[] = [];
    const losoPredGbm: number[] = [];
    const losoPredRidge: number[] = [];
    const losoPredGbmBase: number[] = [];

    if (uniqueSeasons.length >= 3) {
      for (const held of uniqueSeasons) {
        const trainR = posRows.filter((r: PlayerRow) => r.season !== held);
        const testR = posRows.filter((r: PlayerRow) => r.season === held);
        if (trainR.length < 8 || testR.length === 0) continue;

        const Xtr = trainR.map((r: PlayerRow) => featureKeys.map((k) => r.features[k] || 0));
        const Xtrb = trainR.map((r: PlayerRow) => baselineKeys.map((k) => r.features[k] || 0));
        const ytr = trainR.map((r: PlayerRow) => r.vor);
        const msl = Math.max(3, Math.round(trainR.length * 0.05));

        const foldGbm = trainGBM(Xtr, ytr, featureKeys, { ...GBM_OPTS_CV, minSamplesLeaf: msl });
        const foldRidge = trainRidgeRegression(Xtr, ytr, featureKeys, LAMBDA);
        const foldBase = trainGBM(Xtrb, ytr, baselineKeys, { ...GBM_OPTS_CV, minSamplesLeaf: msl });

        for (const row of testR) {
          losoActuals.push(row.vor);
          losoPredGbm.push(predictGBM(foldGbm, row.features).predicted);
          losoPredRidge.push(predict(foldRidge, row.features).predicted);
          losoPredGbmBase.push(predictGBM(foldBase, row.features).predicted);
        }
      }
    }

    const hasCV = losoActuals.length >= 10;
    models.push({
      position: pos, ridgeModel, gbmModel,
      featureNames: featureKeys, featureLabels,
      n: posRows.length,
      hitRate: Math.round(posRows.filter((r: PlayerRow) => r.isHit).length / posRows.length * 100),
      bustRate: Math.round(posRows.filter((r: PlayerRow) => r.isBust).length / posRows.length * 100),
      rSquared: 0, mae: 0,
      cvR2Gbm:         hasCV ? cvR2(losoActuals, losoPredGbm) : gbmModel.rSquared,
      cvMaeGbm:        hasCV ? cvMae(losoActuals, losoPredGbm) : gbmModel.mae,
      cvR2Ridge:       hasCV ? cvR2(losoActuals, losoPredRidge) : ridgeModel.rSquared,
      cvMaeRidge:      hasCV ? cvMae(losoActuals, losoPredRidge) : ridgeModel.mae,
      cvR2GbmBaseline: hasCV ? cvR2(losoActuals, losoPredGbmBase) : 0,
    });
    console.log(`    ${pos}: n=${posRows.length}, CV R²=${models[models.length-1].cvR2Gbm}`);
  }

  mkdirSync('public/data', { recursive: true });
  const output = { ...result, models };
  const json = JSON.stringify(output);
  writeFileSync('public/data/feature-matrix.json', json);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const sizeMB = (json.length / 1024 / 1024).toFixed(1);
  console.log(`Done in ${elapsed}s — ${result.rows.length} rows, ${result.predRows.length} pred rows, ${models.length} models (${sizeMB} MB)`);
}

main().catch((e) => {
  console.error('Precomputation failed:', e.message || e);
  process.exit(0);
});
