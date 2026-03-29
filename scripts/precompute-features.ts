// Build-time precomputation of feature matrix + trained models.
// Run with: npx tsx scripts/precompute-features.ts
// Outputs: public/data/feature-matrix.json (includes trained models)

import { buildFeatureMatrix } from '../src/lib/buildFeatureMatrix';
import { SEASONS, PREDICT_SEASON, POSITIONS, REPLACEMENT_RANKS, FEATURES, cvR2, cvMae } from '../src/lib/featureTypes';
import type { PlayerRow } from '../src/lib/featureTypes';
import { trainRidgeRegression, predict } from '../src/lib/ridge';
import { trainGBM, predictGBM } from '../src/lib/gbm';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';

if (global.gc) console.log('GC exposed — will collect between seasons');

const CACHE_PATH = 'public/data/training-rows-cache-v3.json'; // v3: momentum + interaction features
const OUTPUT_PATH = 'public/data/feature-matrix.json';

const MAX_ADP = 150;
const LAMBDA = 5;

async function main() {
  console.log('Precomputing feature matrix + models...');
  const start = Date.now();

  // Check for cached training rows (static 2018-2025 data doesn't change)
  let result;
  if (existsSync(CACHE_PATH)) {
    console.log('  Loading cached training rows...');
    const cached = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
    console.log(`  Cached: ${cached.rows.length} training rows`);

    // Only rebuild prediction rows (2026 data changes with ADP/rosters)
    console.log('  Rebuilding 2026 prediction rows only...');
    const fresh = await buildFeatureMatrix({
      seasons: [],  // skip training seasons — use cache
      predictSeason: PREDICT_SEASON,
      positions: POSITIONS,
      replacementRanks: REPLACEMENT_RANKS,
      vorBasis: 'total',
      onStatus: (msg) => { console.log(`  ${msg}`); if (global.gc) global.gc(); },
    });

    result = {
      rows: cached.rows,
      predRows: fresh.predRows,
      vorNorm: cached.vorNorm,
    };
  } else {
    console.log('  No cache — building full feature matrix...');
    result = await buildFeatureMatrix({
      seasons: SEASONS,
      predictSeason: PREDICT_SEASON,
      positions: POSITIONS,
      replacementRanks: REPLACEMENT_RANKS,
      vorBasis: 'total',
      onStatus: (msg) => { console.log(`  ${msg}`); if (global.gc) global.gc(); },
    });

    // Cache training rows for next build
    console.log('  Caching training rows...');
    mkdirSync('public/data', { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify({ rows: result.rows, vorNorm: result.vorNorm }));
    const cacheSize = (readFileSync(CACHE_PATH).length / 1024 / 1024).toFixed(1);
    console.log(`  Training cache saved (${cacheSize} MB)`);
  }

  console.log(`  Features done: ${result.rows.length} training rows, ${result.predRows.length} prediction rows`);

  // Train models with position-specific tuning
  // QB (N≈140) and TE (N≈106) need fewer features and more regularization
  // to avoid overfitting. RB (N≈367) and WR (N≈408) can handle more features.
  console.log('  Training models...');
  const PROJ_KEYS = ['projTeamPassAtt','projTeamPassVolChg','projPlayerPPR','projPlayerVsExpected','projTargetShare'];

  // Position-specific hyperparameters
  const POS_CONFIG: Record<string, {
    maxFeatures: number;  // max features to use (feature selection via initial importance)
    gbmEstimators: number;
    gbmLR: number;
    gbmDepth: number;
    ridgeLambda: number;
    minLeafPct: number;
  }> = {
    QB: { maxFeatures: 20, gbmEstimators: 80, gbmLR: 0.05, gbmDepth: 2, ridgeLambda: 15, minLeafPct: 0.10 },
    RB: { maxFeatures: 50, gbmEstimators: 150, gbmLR: 0.08, gbmDepth: 3, ridgeLambda: 5, minLeafPct: 0.05 },
    WR: { maxFeatures: 40, gbmEstimators: 150, gbmLR: 0.08, gbmDepth: 3, ridgeLambda: 5, minLeafPct: 0.05 },
    TE: { maxFeatures: 15, gbmEstimators: 60, gbmLR: 0.05, gbmDepth: 2, ridgeLambda: 20, minLeafPct: 0.12 },
  };
  const models: Record<string, unknown>[] = [];
  for (const pos of POSITIONS) {
    console.log(`    Training ${pos}...`);
    const posRows = result.rows.filter((r: PlayerRow) => r.position === pos && r.adp <= MAX_ADP);
    if (posRows.length < 10) continue;

    const cfg = POS_CONFIG[pos] || POS_CONFIG.WR;
    let posFeatures = FEATURES.filter((f) => f.positions.includes(pos));
    let featureKeys = posFeatures.map((f) => f.key);

    // Feature selection for small-sample positions:
    // Train a quick GBM on all features, rank by importance, keep top K
    if (featureKeys.length > cfg.maxFeatures) {
      console.log(`      Feature selection: ${featureKeys.length} → ${cfg.maxFeatures} (N=${posRows.length})`);
      const XAll = posRows.map((r: PlayerRow) => featureKeys.map((k) => r.features[k] || 0));
      const yAll = posRows.map((r: PlayerRow) => r.vor);
      const quickGbm = trainGBM(XAll, yAll, featureKeys, {
        nEstimators: 50, learningRate: 0.1, maxDepth: 2, subsample: 0.7,
        minSamplesLeaf: Math.max(5, Math.round(posRows.length * 0.1)),
      });
      // Rank features by importance
      const importanceSums = new Array(featureKeys.length).fill(0);
      const sampleN = Math.min(100, posRows.length);
      const sampleStep = Math.max(1, Math.floor(posRows.length / sampleN));
      for (let i = 0; i < posRows.length; i += sampleStep) {
        const pred = predictGBM(quickGbm, posRows[i].features);
        for (const fc of pred.featureContributions) {
          const idx = featureKeys.indexOf(fc.name);
          if (idx >= 0) importanceSums[idx] += Math.abs(fc.contribution);
        }
      }
      const ranked = featureKeys
        .map((k, i) => ({ key: k, imp: importanceSums[i] }))
        .sort((a, b) => b.imp - a.imp);
      const topKeys = new Set(ranked.slice(0, cfg.maxFeatures).map((r) => r.key));
      // Always keep projection keys if applicable
      for (const pk of PROJ_KEYS) if (featureKeys.includes(pk)) topKeys.add(pk);
      featureKeys = featureKeys.filter((k) => topKeys.has(k));
      posFeatures = posFeatures.filter((f) => topKeys.has(f.key));
      console.log(`      Selected: ${featureKeys.slice(0, 8).join(', ')}...`);
    }

    const featureLabels = posFeatures.map((f) => f.label);
    const baselineKeys = featureKeys.filter((k) => !PROJ_KEYS.includes(k));

    const X = posRows.map((r: PlayerRow) => featureKeys.map((k) => r.features[k] || 0));
    const y = posRows.map((r: PlayerRow) => r.vor);

    const msl = Math.max(3, Math.round(posRows.length * cfg.minLeafPct));

    // === Improvement 1: Separate rookie vs veteran models ===
    const rookieRows = posRows.filter((r: PlayerRow) => (r.features.yearsInLeague || 0) <= 1);
    const vetRows = posRows.filter((r: PlayerRow) => (r.features.yearsInLeague || 0) > 1);
    const hasRookieSplit = rookieRows.length >= 15 && vetRows.length >= 15;
    console.log(`      Rookie/Vet split: ${rookieRows.length} rookies, ${vetRows.length} vets (${hasRookieSplit ? 'enabled' : 'disabled — too few'})`);

    // Full-data models
    const ridgeModel = trainRidgeRegression(X, y, featureKeys, cfg.ridgeLambda);
    const gbmModel = trainGBM(X, y, featureKeys, {
      nEstimators: cfg.gbmEstimators, learningRate: cfg.gbmLR,
      maxDepth: cfg.gbmDepth, subsample: 0.8, minSamplesLeaf: msl,
    });

    // === Improvement 2: Quantile regression for confidence intervals ===
    console.log(`      Training quantile models (10th/90th)...`);
    const gbmLower = trainGBM(X, y, featureKeys, {
      nEstimators: cfg.gbmEstimators, learningRate: cfg.gbmLR,
      maxDepth: cfg.gbmDepth, subsample: 0.8, minSamplesLeaf: msl,
      loss: 'quantile', quantile: 0.10,
    });
    const gbmUpper = trainGBM(X, y, featureKeys, {
      nEstimators: cfg.gbmEstimators, learningRate: cfg.gbmLR,
      maxDepth: cfg.gbmDepth, subsample: 0.8, minSamplesLeaf: msl,
      loss: 'quantile', quantile: 0.90,
    });

    // LOSO cross-validation with ensemble + rookie/vet
    const uniqueSeasons = [...new Set(posRows.map((r: PlayerRow) => r.season))].sort();
    const losoActuals: number[] = [];
    const losoPredGbm: number[] = [];
    const losoPredRidge: number[] = [];
    const losoPredEnsemble: number[] = [];
    const losoPredGbmBase: number[] = [];
    const losoPredRookieVet: number[] = [];

    if (uniqueSeasons.length >= 3) {
      for (const held of uniqueSeasons) {
        const trainR = posRows.filter((r: PlayerRow) => r.season !== held);
        const testR = posRows.filter((r: PlayerRow) => r.season === held);
        if (trainR.length < 8 || testR.length === 0) continue;

        const Xtr = trainR.map((r: PlayerRow) => featureKeys.map((k) => r.features[k] || 0));
        const Xtrb = trainR.map((r: PlayerRow) => baselineKeys.map((k) => r.features[k] || 0));
        const ytr = trainR.map((r: PlayerRow) => r.vor);
        const foldMsl = Math.max(3, Math.round(trainR.length * cfg.minLeafPct));

        const cvGbmOpts = { nEstimators: Math.min(80, cfg.gbmEstimators), learningRate: cfg.gbmLR + 0.02, maxDepth: cfg.gbmDepth, subsample: 0.8, minSamplesLeaf: foldMsl };
        const foldGbm = trainGBM(Xtr, ytr, featureKeys, cvGbmOpts);
        const foldRidge = trainRidgeRegression(Xtr, ytr, featureKeys, cfg.ridgeLambda);
        const foldBase = trainGBM(Xtrb, ytr, baselineKeys, cvGbmOpts);

        // Rookie/vet fold models
        let foldRookieGbm: any = null, foldVetGbm: any = null;
        if (hasRookieSplit) {
          const rookieTrain = trainR.filter((r: PlayerRow) => (r.features.yearsInLeague || 0) <= 1);
          const vetTrain = trainR.filter((r: PlayerRow) => (r.features.yearsInLeague || 0) > 1);
          if (rookieTrain.length >= 10 && vetTrain.length >= 10) {
            const XrTr = rookieTrain.map((r: PlayerRow) => featureKeys.map((k) => r.features[k] || 0));
            const yrTr = rookieTrain.map((r: PlayerRow) => r.vor);
            const XvTr = vetTrain.map((r: PlayerRow) => featureKeys.map((k) => r.features[k] || 0));
            const yvTr = vetTrain.map((r: PlayerRow) => r.vor);
            foldRookieGbm = trainGBM(XrTr, yrTr, featureKeys, { ...cvGbmOpts, minSamplesLeaf: Math.max(3, Math.round(rookieTrain.length * 0.12)) });
            foldVetGbm = trainGBM(XvTr, yvTr, featureKeys, { ...cvGbmOpts, minSamplesLeaf: Math.max(3, Math.round(vetTrain.length * 0.08)) });
          }
        }

        for (const row of testR) {
          const gbmPred = predictGBM(foldGbm, row.features).predicted;
          const ridgePred = predict(foldRidge, row.features).predicted;

          losoActuals.push(row.vor);
          losoPredGbm.push(gbmPred);
          losoPredRidge.push(ridgePred);
          losoPredGbmBase.push(predictGBM(foldBase, row.features).predicted);

          // === Improvement 3: Ensemble (weighted blend of GBM + Ridge) ===
          losoPredEnsemble.push(gbmPred * 0.7 + ridgePred * 0.3);

          // Rookie/vet prediction
          if (foldRookieGbm && foldVetGbm) {
            const isRookie = (row.features.yearsInLeague || 0) <= 1;
            const rvPred = isRookie
              ? predictGBM(foldRookieGbm, row.features).predicted
              : predictGBM(foldVetGbm, row.features).predicted;
            losoPredRookieVet.push(rvPred);
          } else {
            losoPredRookieVet.push(gbmPred);
          }
        }
      }
    }

    const hasCV = losoActuals.length >= 10;
    const cvR2Ensemble = hasCV ? cvR2(losoActuals, losoPredEnsemble) : 0;
    const cvR2RookieVet = hasCV ? cvR2(losoActuals, losoPredRookieVet) : 0;

    models.push({
      position: pos, ridgeModel, gbmModel, gbmLower, gbmUpper,
      featureNames: featureKeys, featureLabels,
      n: posRows.length,
      nRookies: rookieRows.length,
      nVets: vetRows.length,
      hitRate: Math.round(posRows.filter((r: PlayerRow) => r.isHit).length / posRows.length * 100),
      bustRate: Math.round(posRows.filter((r: PlayerRow) => r.isBust).length / posRows.length * 100),
      rSquared: 0, mae: 0,
      cvR2Gbm:         hasCV ? cvR2(losoActuals, losoPredGbm) : gbmModel.rSquared,
      cvMaeGbm:        hasCV ? cvMae(losoActuals, losoPredGbm) : gbmModel.mae,
      cvR2Ridge:       hasCV ? cvR2(losoActuals, losoPredRidge) : ridgeModel.rSquared,
      cvMaeRidge:      hasCV ? cvMae(losoActuals, losoPredRidge) : ridgeModel.mae,
      cvR2Ensemble:    cvR2Ensemble,
      cvR2RookieVet:   cvR2RookieVet,
      cvR2GbmBaseline: hasCV ? cvR2(losoActuals, losoPredGbmBase) : 0,
    });
    console.log(`    ${pos}: n=${posRows.length}`);
    console.log(`      GBM R²:        ${(models[models.length-1] as any).cvR2Gbm}`);
    console.log(`      Ridge R²:      ${(models[models.length-1] as any).cvR2Ridge}`);
    console.log(`      Ensemble R²:   ${cvR2Ensemble}`);
    console.log(`      Rookie/Vet R²: ${cvR2RookieVet}`);
  }

  // Precompute GBM feature importance per position (avoids runtime crash on mobile)
  console.log('  Computing feature importance...');
  const featureImportance: Record<string, Array<{ key: string; label: string; category: string; importance: number }>> = {};
  for (const m of models) {
    const pos = m.position as string;
    const gbm = m.gbmModel as any;
    const featureNames = m.featureNames as string[];
    const featureLabels = m.featureLabels as string[];
    if (!gbm) continue;

    const posRows = result.rows.filter((r: PlayerRow) => r.position === pos && r.adp <= MAX_ADP);
    // Subsample for speed (150 rows is enough for stable estimates)
    const sampleSize = Math.min(150, posRows.length);
    const step = Math.max(1, Math.floor(posRows.length / sampleSize));
    const sampled = posRows.filter((_: PlayerRow, i: number) => i % step === 0).slice(0, sampleSize);

    const contribSums = new Array(featureNames.length).fill(0);
    for (const row of sampled) {
      const pred = predictGBM(gbm, row.features);
      for (const fc of pred.featureContributions) {
        const idx = featureNames.indexOf(fc.name);
        if (idx >= 0) contribSums[idx] += Math.abs(fc.contribution);
      }
    }
    const n = sampled.length || 1;
    featureImportance[pos] = featureNames
      .map((key: string, i: number) => {
        const def = FEATURES.find((f) => f.key === key);
        return {
          key,
          label: featureLabels[i],
          category: def?.category || 'Other',
          importance: Math.round((contribSums[i] / n) * 10000) / 10000,
        };
      })
      .sort((a, b) => b.importance - a.importance);
    console.log(`    ${pos}: top feature = ${featureImportance[pos][0]?.key} (${featureImportance[pos][0]?.importance})`);
  }

  // Compute hit/bust thresholds per position
  const posThresholds: Record<string, { hit: number; bust: number }> = {};
  for (const pos of POSITIONS) {
    const deltas = result.rows
      .filter((r: PlayerRow) => r.position === pos)
      .map((r: PlayerRow) => r.vor)
      .sort((a: number, b: number) => a - b);
    if (deltas.length < 6) continue;
    posThresholds[pos] = {
      hit:  deltas[Math.floor(deltas.length * 0.67)],
      bust: deltas[Math.floor(deltas.length * 0.33)],
    };
  }

  // Generate 2026 predictions with ensemble + confidence intervals
  console.log('  Generating 2026 predictions (ensemble + CI)...');
  const predictions2026: Array<{
    name: string; team: string; adp: number; position: string;
    headshotUrl?: string; predictedVor: number; hitProb: string;
    ciLower: number; ciUpper: number; isRookie: boolean;
  }> = [];

  for (const m of models) {
    const pos = m.position as string;
    const gbm = m.gbmModel as any;
    const ridge = m.ridgeModel as any;
    const lower = m.gbmLower as any;
    const upper = m.gbmUpper as any;
    const posPlayers = result.predRows.filter((r: { position: string; adp: number }) => r.position === pos && r.adp <= MAX_ADP);
    const threshold = posThresholds[pos];

    for (const r of posPlayers) {
      const gbmPred = gbm ? predictGBM(gbm, r.features).predicted : 0;
      const ridgePred = ridge ? predict(ridge, r.features).predicted : 0;
      // Ensemble: 70% GBM + 30% Ridge
      const ensemblePred = Math.round((gbmPred * 0.7 + ridgePred * 0.3) * 10) / 10;
      // Confidence intervals from quantile models
      const ciLow = lower ? Math.round(predictGBM(lower, r.features).predicted * 10) / 10 : ensemblePred - 0.5;
      const ciUp = upper ? Math.round(predictGBM(upper, r.features).predicted * 10) / 10 : ensemblePred + 0.5;
      const isRookie = (r.features.yearsInLeague || 0) <= 1;

      const pred = ensemblePred;
      const hitProb = threshold
        ? pred >= threshold.hit ? 'Likely Hit'
        : pred < threshold.bust ? 'Likely Bust'
        : 'Middle'
        : 'Middle';
      predictions2026.push({
        name: r.name, team: r.team, adp: r.adp, position: r.position,
        headshotUrl: r.headshotUrl, predictedVor: pred, hitProb,
        ciLower: ciLow, ciUpper: ciUp, isRookie,
      });
    }
  }
  console.log(`  ${predictions2026.length} player predictions generated`);

  mkdirSync('public/data', { recursive: true });
  const output = { ...result, models, posThresholds, predictions2026, featureImportance };
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
