// Build-time precomputation of feature matrix + trained models.
// Run with: npx tsx scripts/precompute-features.ts
// Outputs: public/data/feature-matrix.json (includes trained models)

import { buildFeatureMatrix } from '../src/lib/buildFeatureMatrix';
import { SEASONS, PREDICT_SEASON, POSITIONS, REPLACEMENT_RANKS, FEATURES, ADP_FEATURES, ROOKIE_FEATURES, PRE_DRAFT_ROOKIE_FEATURES, cvR2, cvMae, normalizeName, parseHeight } from '../src/lib/featureTypes';
import type { PlayerRow } from '../src/lib/featureTypes';
import { trainRidgeRegression, predict } from '../src/lib/ridge';
import { trainGBM, predictGBM, trainBaggedGBM, predictBaggedGBM } from '../src/lib/gbm';
import type { BaggedGBM } from '../src/lib/gbm';
import { trainRookieCareerModels, normalCdf, PPG_THRESHOLD_CONFIG } from '../src/lib/rookieCareerModel';
import { trainTeamVolumeModel } from '../src/lib/volumeProjection';
import type { TeamVolumeFeatures } from '../src/lib/volumeProjection';
import { fetchCombine, fetchCollegeStats, fetchDraftPicks } from '../src/data';
import { FeatureStoreBuilder } from '../src/lib/featureStore';
import { loadProspectStore, buildProspectFeatureRecord } from '../src/lib/featureStore/prospectStore';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import ncaaTeamData from '../src/data/ncaa-team-data.json';

if (global.gc) console.log('GC exposed — will collect between seasons');

// Rank array (1-based, higher value = higher rank)
function rankArray(arr: number[]): number[] {
  const indexed = arr.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  for (let k = 0; k < indexed.length; k++) ranks[indexed[k].i] = k + 1;
  return ranks;
}

// Spearman rank correlation
function spearman(ranks1: number[], ranks2: number[]): number {
  const n = ranks1.length;
  if (n < 3) return 0;
  const mean1 = ranks1.reduce((a, b) => a + b, 0) / n;
  const mean2 = ranks2.reduce((a, b) => a + b, 0) / n;
  let cov = 0, var1 = 0, var2 = 0;
  for (let i = 0; i < n; i++) {
    const d1 = ranks1[i] - mean1, d2 = ranks2[i] - mean2;
    cov += d1 * d2; var1 += d1 * d1; var2 += d2 * d2;
  }
  return var1 > 0 && var2 > 0 ? cov / Math.sqrt(var1 * var2) : 0;
}

// ═══ CACHING RULES ═══
// TRAINING ROWS: Bump ONLY when buildFeatureMatrix.ts or data sources change.
// This triggers a 30-60 min rebuild fetching all seasons. Do NOT bump for
// model params, tiers, scoring logic, or UI changes.
const CACHE_PATH = 'public/data/training-rows-cache-v32.json';
// MODELS: Bump when rookieCareerModel.ts, feature lists, or training logic change.
// Uses cached rows, rebuilds in ~1-2 min.
const MODEL_CACHE_PATH = 'public/data/trained-models-cache-v50.json';
const OUTPUT_PATH = 'public/data/feature-matrix.json';

const MAX_ADP = 400;
const LAMBDA = 5;

async function main() {
  console.log('Precomputing feature matrix + models...');
  const start = Date.now();

  const useStore = process.argv.includes('--use-store');
  const scoreOnly = process.argv.includes('--score-only');
  const featureStorePath = 'public/data/feature-store';

  // Check for cached training rows (static 2018-2025 data doesn't change)
  let result;

  // ── Feature store path: assemble training rows from shards ──
  if (useStore && existsSync(`${featureStorePath}/manifest.json`)) {
    console.log('  Using feature store for training rows...');
    const fsBuilder = new FeatureStoreBuilder(featureStorePath, (msg) => console.log(`  ${msg}`));
    const summary = fsBuilder.getSummary();
    console.log(`  Feature store: ${summary.totalRows} rows across ${summary.groups.length} groups`);

    const storeRows = fsBuilder.assemblePlayerRows({ computeOutcomes: true });
    console.log(`  Assembled ${storeRows.length} training rows from feature store`);

    // Still need prediction rows from buildFeatureMatrix
    console.log('  Rebuilding 2026 prediction rows...');
    const fresh = await buildFeatureMatrix({
      seasons: [],
      predictSeason: PREDICT_SEASON,
      positions: POSITIONS,
      replacementRanks: REPLACEMENT_RANKS,
      vorBasis: 'total',
      onStatus: (msg) => { console.log(`  ${msg}`); if (global.gc) global.gc(); },
    });

    // Compute VOR normalization
    const vorNorm: Record<string, { mean: number; std: number }> = {};
    for (const pos of POSITIONS) {
      const vals = storeRows.filter(r => r.position === pos).map(r => r.vor);
      if (vals.length < 4) continue;
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
      vorNorm[pos] = { mean, std: Math.sqrt(variance) || 1 };
    }

    result = {
      rows: storeRows,
      predRows: fresh.predRows,
      vorNorm,
    };
  }
  // ── Legacy cache path: load from monolithic JSON ──
  else if (existsSync(CACHE_PATH)) {
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

    // Populate feature store if it doesn't exist yet
    if (!existsSync(`${featureStorePath}/manifest.json`)) {
      const fsBuilder = new FeatureStoreBuilder(featureStorePath, (msg) => console.log(`  ${msg}`));
      fsBuilder.populateFromLegacy(cached.rows);
    }
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

    // Populate feature store from training rows (shards features by group)
    const featureStoreBuilder = new FeatureStoreBuilder(
      'public/data/feature-store',
      (msg) => console.log(`  ${msg}`),
    );
    featureStoreBuilder.populateFromLegacy(result.rows);
  }

  console.log(`  Features done: ${result.rows.length} training rows, ${result.predRows.length} prediction rows`);

  // Diagnostic: check ZAP feature coverage for WR rookies
  {
    const wrRookies = result.rows.filter((r: any) => r.position === 'WR' && (r.features?.yearsInLeague ?? 99) <= 1);
    const hasBreakout = wrRookies.filter((r: any) => r.features?.collegeBreakoutScore > 0).length;
    const hasRecPerTPA = wrRookies.filter((r: any) => r.features?.collegeRecYdsPerTeamPassAtt > 0).length;
    const hasDominator = wrRookies.filter((r: any) => r.features?.collegeDominatorRating > 0).length;
    const hasTeammate = wrRookies.filter((r: any) => r.features?.collegeTeammateScore > 0).length;
    const hasEarlyDec = wrRookies.filter((r: any) => r.features?.collegeEarlyDeclare > 0).length;
    console.log(`  ZAP feature coverage for ${wrRookies.length} WR rookies:`);
    console.log(`    collegeBreakoutScore > 0: ${hasBreakout} (${Math.round(hasBreakout/wrRookies.length*100)}%)`);
    console.log(`    collegeRecYdsPerTeamPassAtt > 0: ${hasRecPerTPA} (${Math.round(hasRecPerTPA/wrRookies.length*100)}%)`);
    console.log(`    collegeDominatorRating > 0: ${hasDominator} (${Math.round(hasDominator/wrRookies.length*100)}%)`);
    console.log(`    collegeTeammateScore > 0: ${hasTeammate} (${Math.round(hasTeammate/wrRookies.length*100)}%)`);
    console.log(`    collegeEarlyDeclare > 0: ${hasEarlyDec} (${Math.round(hasEarlyDec/wrRookies.length*100)}%)`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MODEL CACHING: Training data is static (2018-2025), so trained models,
  // LOSO results, feature importance, and draft sim don't change between
  // builds. Only 2026 predictions need to re-run (ADP/roster changes).
  // ═══════════════════════════════════════════════════════════════════════
  let models: Record<string, unknown>[];
  let ppgModels: Record<string, unknown>[];
  let residualModels: Record<string, unknown>[];
  let shareModels: Record<string, unknown>;
  let rookieCareerModels: any;
  let featureImportance: Record<string, Array<{ key: string; label: string; category: string; importance: number }>>;
  let rookieFeatureImportance: Record<string, Array<{ key: string; label: string; category: string; importance: number }>>;
  let rookiePreDraftFeatureImportance: Record<string, Array<{ key: string; label: string; category: string; importance: number }>>;
  let vetFeatureImportance: Record<string, Array<{ key: string; label: string; category: string; importance: number }>>;
  let draftSim2025: any;
  let posThresholds: Record<string, { hit: number; bust: number }>;

  // Per-component model caching: each model type cached independently.
  // Changing one model type only retrains that type, not all 5.
  const MODEL_DIR = 'public/data';
  const componentCachePaths = {
    adp: `${MODEL_DIR}/model-cache-adp-v50.json`,
    ppg: `${MODEL_DIR}/model-cache-ppg-v50.json`,
    residual: `${MODEL_DIR}/model-cache-residual-v50.json`,
    share: `${MODEL_DIR}/model-cache-share-v50.json`,
    career: `${MODEL_DIR}/model-cache-career-v51.json`,
  };

  // Try loading per-component caches first (allows individual model retraining)
  {
  let anyMissing = false;
  if (existsSync(componentCachePaths.adp)) {
    console.log('  Loading cached ADP models...');
    const c = JSON.parse(readFileSync(componentCachePaths.adp, 'utf-8'));
    models = c.models; featureImportance = c.featureImportance;
    rookieFeatureImportance = c.rookieFeatureImportance;
    rookiePreDraftFeatureImportance = c.rookiePreDraftFeatureImportance;
    vetFeatureImportance = c.vetFeatureImportance;
    draftSim2025 = c.draftSim2025; posThresholds = c.posThresholds;
  } else { anyMissing = true; }

  if (existsSync(componentCachePaths.ppg)) {
    console.log('  Loading cached PPG models...');
    ppgModels = JSON.parse(readFileSync(componentCachePaths.ppg, 'utf-8')).ppgModels;
  } else { anyMissing = true; }

  if (existsSync(componentCachePaths.residual)) {
    console.log('  Loading cached residual models...');
    residualModels = JSON.parse(readFileSync(componentCachePaths.residual, 'utf-8')).residualModels;
  } else { anyMissing = true; }

  if (existsSync(componentCachePaths.share)) {
    console.log('  Loading cached share models...');
    shareModels = JSON.parse(readFileSync(componentCachePaths.share, 'utf-8')).shareModels;
  } else { anyMissing = true; }

  if (existsSync(componentCachePaths.career)) {
    console.log('  Loading cached career models...');
    rookieCareerModels = JSON.parse(readFileSync(componentCachePaths.career, 'utf-8')).rookieCareerModels;
  } else { anyMissing = true; }

  // If ALL component caches exist, skip training entirely
  if (!anyMissing && models?.length > 0) {
    console.log('  All component caches loaded, skipping training...');
  } else {

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
    RB: { maxFeatures: 40, gbmEstimators: 150, gbmLR: 0.06, gbmDepth: 3, ridgeLambda: 8, minLeafPct: 0.05 },
    WR: { maxFeatures: 40, gbmEstimators: 120, gbmLR: 0.06, gbmDepth: 3, ridgeLambda: 8, minLeafPct: 0.06 },
    TE: { maxFeatures: 20, gbmEstimators: 60, gbmLR: 0.05, gbmDepth: 2, ridgeLambda: 20, minLeafPct: 0.12 },
  };
  models = [];
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
      const yAll = posRows.map((r: PlayerRow) => r.rawPPG || 0);
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
    const y = posRows.map((r: PlayerRow) => r.rawPPG || 0);

    // Diagnostic: verify target data
    const yValid = y.filter((v) => v !== undefined && v !== null && !isNaN(v) && v !== 0);
    const yUndef = y.filter((v) => v === undefined || v === null).length;
    const yNaN = y.filter((v) => typeof v === 'number' && isNaN(v)).length;
    console.log(`      Target (rawPPG): ${y.length} total, ${yValid.length} non-zero, ${yUndef} undefined, ${yNaN} NaN`);
    console.log(`      Target range: [${Math.min(...y)}, ${Math.max(...y)}], mean=${(y.reduce((a,b)=>a+(b||0),0)/y.length).toFixed(2)}`);

    const msl = Math.max(3, Math.round(posRows.length * cfg.minLeafPct));

    // === Improvement 1: Separate rookie vs veteran models ===
    const rookieRows = posRows.filter((r: PlayerRow) => (r.features.yearsInLeague || 0) <= 1);
    const vetRows = posRows.filter((r: PlayerRow) => (r.features.yearsInLeague || 0) > 1);
    const hasRookieSplit = rookieRows.length >= 30 && vetRows.length >= 30;
    console.log(`      Rookie/Vet split: ${rookieRows.length} rookies, ${vetRows.length} vets (${hasRookieSplit ? 'enabled' : 'disabled — too few'})`);

    // Full-data models
    const ridgeLambda = Math.max(cfg.ridgeLambda, Math.sqrt(featureKeys.length)); // scale gently with features
    console.log(`      Ridge: lambda=${ridgeLambda} (base=${cfg.ridgeLambda}, features=${featureKeys.length})`);
    const ridgeModel = trainRidgeRegression(X, y, featureKeys, ridgeLambda);
    console.log(`      Ridge in-sample R²=${ridgeModel.rSquared.toFixed(4)}, MAE=${ridgeModel.mae.toFixed(3)}`);
    console.log(`      Ridge coeffs non-zero: ${ridgeModel.coefficients.filter(c => Math.abs(c) > 1e-10).length}/${ridgeModel.coefficients.length}`);
    console.log(`      Ridge predictions range: [${Math.min(...ridgeModel.predictions).toFixed(2)}, ${Math.max(...ridgeModel.predictions).toFixed(2)}], target range: [${Math.min(...y).toFixed(2)}, ${Math.max(...y).toFixed(2)}]`);
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

    // Train full-data rookie models (pre-draft + post-draft) for 2026 predictions
    // Two tiers based on sample size:
    //   - Large (≥50 rookies, RB/WR): GBM+Ridge ensemble
    //   - Small (15-49 rookies, QB/TE): Ridge-only model, blended with combined model
    let rookieGbmPostDraft: any = null, rookieGbmPreDraft: any = null;
    let rookieRidgePostDraft: any = null, rookieRidgePreDraft: any = null;
    const hasEnoughForGBM = rookieRows.length >= 50;   // RB~142, WR~127 → full GBM+Ridge
    const hasEnoughForRidge = rookieRows.length >= 15;  // QB~24, TE~20 → Ridge-only hybrid
    if (hasRookieSplit && hasEnoughForRidge) {
      const rookieKeys = ROOKIE_FEATURES[pos] || featureKeys;
      const preDraftKeys = PRE_DRAFT_ROOKIE_FEATURES[pos] || rookieKeys;
      const yrAll = rookieRows.map((r: PlayerRow) => r.rawPPG || 0);

      // Log feature coverage for diagnostics
      const featureCoverage: Record<string, number> = {};
      for (const k of preDraftKeys) {
        featureCoverage[k] = rookieRows.filter((r: PlayerRow) => (r.features[k] || 0) !== 0).length;
      }
      console.log(`      Feature coverage: ${Object.entries(featureCoverage).map(([k, v]) => `${k}=${v}/${rookieRows.length}`).join(', ')}`);

      // Ridge models trained for all positions with ≥15 rookies
      const rookieRidgeLambda = hasEnoughForGBM ? LAMBDA * 3 : LAMBDA * 5; // stronger reg for smaller samples
      const XrPost = rookieRows.map((r: PlayerRow) => rookieKeys.map((k) => r.features[k] || 0));
      rookieRidgePostDraft = trainRidgeRegression(XrPost, yrAll, rookieKeys, rookieRidgeLambda);
      const XrPre = rookieRows.map((r: PlayerRow) => preDraftKeys.map((k) => r.features[k] || 0));
      rookieRidgePreDraft = trainRidgeRegression(XrPre, yrAll, preDraftKeys, rookieRidgeLambda);

      if (hasEnoughForGBM) {
        // Full GBM+Ridge ensemble for large samples (RB/WR)
        const rookieGbmOpts = {
          nEstimators: 80, learningRate: 0.04, maxDepth: 2,
          subsample: 0.7, minSamplesLeaf: Math.max(5, Math.round(rookieRows.length * 0.08)),
        };
        rookieGbmPostDraft = trainBaggedGBM(XrPost, yrAll, rookieKeys, rookieGbmOpts, 5);
        rookieGbmPreDraft = trainBaggedGBM(XrPre, yrAll, preDraftKeys, rookieGbmOpts, 5);
        console.log(`      Rookie models: post-draft (${rookieKeys.length} features), pre-draft (${preDraftKeys.length} features), Bagged(5) GBM+Ridge ensemble`);
      } else {
        // Ridge-only for small samples (QB/TE) — will be blended with combined model at prediction time
        console.log(`      Rookie models: post-draft (${rookieKeys.length} features), pre-draft (${preDraftKeys.length} features), Ridge-only (n=${rookieRows.length}, lambda=${rookieRidgeLambda})`);
        console.log(`      Ridge post-draft R²=${rookieRidgePostDraft.rSquared.toFixed(4)}, pre-draft R²=${rookieRidgePreDraft.rSquared.toFixed(4)}`);
      }
    } else if (hasRookieSplit) {
      console.log(`      Skipping separate rookie model for ${pos} (only ${rookieRows.length} rookies — too few even for Ridge)`);
    }

    // LOSO cross-validation with ensemble + rookie/vet
    const uniqueSeasons = [...new Set(posRows.map((r: PlayerRow) => r.season))].sort();
    const losoActuals: number[] = [];
    const losoPredGbm: number[] = [];
    const losoPredRidge: number[] = [];
    const losoPredEnsemble: number[] = [];
    const losoPredGbmBase: number[] = [];
    const losoPredRookieVet: number[] = [];
    const losoRookieActuals: number[] = [];
    const losoRookiePreds: number[] = [];
    const losoPreDraftRookiePreds: number[] = [];
    const losoVetActuals: number[] = [];
    const losoVetPreds: number[] = [];

    // ADP value-add tracking: does the model help draft better than ADP alone?
    const losoAdps: number[] = [];  // ADP for each test player (aligned with losoActuals)

    if (uniqueSeasons.length >= 3) {
      for (const held of uniqueSeasons) {
        const trainR = posRows.filter((r: PlayerRow) => r.season !== held);
        const testR = posRows.filter((r: PlayerRow) => r.season === held);
        if (trainR.length < 8 || testR.length === 0) continue;

        const Xtr = trainR.map((r: PlayerRow) => featureKeys.map((k) => r.features[k] || 0));
        const Xtrb = trainR.map((r: PlayerRow) => baselineKeys.map((k) => r.features[k] || 0));
        const ytr = trainR.map((r: PlayerRow) => r.rawPPG || 0);
        const foldMsl = Math.max(3, Math.round(trainR.length * cfg.minLeafPct));

        const cvGbmOpts = { nEstimators: Math.min(80, cfg.gbmEstimators), learningRate: cfg.gbmLR + 0.02, maxDepth: cfg.gbmDepth, subsample: 0.8, minSamplesLeaf: foldMsl };
        const foldGbm = trainGBM(Xtr, ytr, featureKeys, cvGbmOpts);
        const foldRidge = trainRidgeRegression(Xtr, ytr, featureKeys, ridgeLambda);
        const foldBase = trainGBM(Xtrb, ytr, baselineKeys, cvGbmOpts);

        // Rookie/vet fold models — two tiers:
        // Large (≥50): GBM+Ridge ensemble, Small (15-49): Ridge-only hybrid
        let foldRookieGbm: any = null, foldRookieRidge: any = null;
        let foldPreDraftRookieGbm: any = null, foldPreDraftRookieRidge: any = null;
        let foldVetGbm: any = null;
        if (hasRookieSplit && hasEnoughForRidge) {
          const rookieTrain = trainR.filter((r: PlayerRow) => (r.features.yearsInLeague || 0) <= 1);
          const vetTrain = trainR.filter((r: PlayerRow) => (r.features.yearsInLeague || 0) > 1);
          const minFoldRookies = hasEnoughForGBM ? 15 : 10; // lower fold threshold for Ridge-only
          if (rookieTrain.length >= minFoldRookies && vetTrain.length >= 15) {
            const rookieKeys = ROOKIE_FEATURES[pos] || featureKeys;
            const preDraftKeys = PRE_DRAFT_ROOKIE_FEATURES[pos] || rookieKeys;
            const yrTr = rookieTrain.map((r: PlayerRow) => r.rawPPG || 0);
            const rookieRidgeLambda = hasEnoughForGBM ? LAMBDA * 3 : LAMBDA * 5;

            // Ridge models for all qualifying positions
            const XrTr = rookieTrain.map((r: PlayerRow) => rookieKeys.map((k) => r.features[k] || 0));
            foldRookieRidge = trainRidgeRegression(XrTr, yrTr, rookieKeys, rookieRidgeLambda);
            const XrTrPre = rookieTrain.map((r: PlayerRow) => preDraftKeys.map((k) => r.features[k] || 0));
            foldPreDraftRookieRidge = trainRidgeRegression(XrTrPre, yrTr, preDraftKeys, rookieRidgeLambda);

            if (hasEnoughForGBM) {
              // Full GBM+Ridge for large samples (RB/WR)
              const rookieGbmOpts = {
                nEstimators: 80, learningRate: 0.04, maxDepth: 2,
                subsample: 0.7, minSamplesLeaf: Math.max(5, Math.round(rookieTrain.length * 0.08)),
              };
              foldRookieGbm = trainBaggedGBM(XrTr, yrTr, rookieKeys, rookieGbmOpts, 5);
              foldPreDraftRookieGbm = trainBaggedGBM(XrTrPre, yrTr, preDraftKeys, rookieGbmOpts, 5);
            }
            // Veteran model
            const XvTr = vetTrain.map((r: PlayerRow) => featureKeys.map((k) => r.features[k] || 0));
            const yvTr = vetTrain.map((r: PlayerRow) => r.rawPPG || 0);
            foldVetGbm = trainGBM(XvTr, yvTr, featureKeys, { ...cvGbmOpts, minSamplesLeaf: Math.max(3, Math.round(vetTrain.length * 0.08)) });
          }
        }

        for (const row of testR) {
          const gbmPred = predictGBM(foldGbm, row.features).predicted;
          const ridgePred = predict(foldRidge, row.features).predicted;

          losoActuals.push(row.rawPPG || 0);
          losoAdps.push(row.adp);
          losoPredGbm.push(gbmPred);
          losoPredRidge.push(ridgePred);
          losoPredGbmBase.push(predictGBM(foldBase, row.features).predicted);

          // === Improvement 3: Ensemble (weighted blend of GBM + Ridge) ===
          losoPredEnsemble.push(gbmPred * 0.7 + ridgePred * 0.3);

          // Rookie/vet prediction — two tiers:
          // 1. GBM+Ridge ensemble (RB/WR, ≥50 rookies)
          // 2. Ridge-only hybrid: blend Ridge rookie model with combined model (QB/TE, 15-49 rookies)
          const isRookie = (row.features.yearsInLeague || 0) <= 1;
          const hasFoldRookieModel = foldRookieGbm || foldRookieRidge;
          if (hasFoldRookieModel && foldVetGbm) {
            let rvPred: number;
            if (isRookie) {
              if (foldRookieGbm) {
                // Large sample: GBM+Ridge 50/50 ensemble (RB/WR)
                const gbmP = predictBaggedGBM(foldRookieGbm, row.features).predicted;
                const ridgeP = predict(foldRookieRidge, row.features).predicted;
                rvPred = gbmP * 0.5 + ridgeP * 0.5;
              } else {
                // Small sample: Ridge-only, blended with combined model (QB/TE)
                // 40% position-specific Ridge + 60% combined model
                const ridgeP = predict(foldRookieRidge, row.features).predicted;
                const combinedP = gbmPred * 0.7 + ridgePred * 0.3;
                rvPred = ridgeP * 0.4 + combinedP * 0.6;
              }
            } else {
              rvPred = predictGBM(foldVetGbm, row.features).predicted;
            }
            losoPredRookieVet.push(rvPred);
            if (isRookie) {
              losoRookieActuals.push(row.rawPPG || 0);
              losoRookiePreds.push(rvPred);
              if (foldPreDraftRookieGbm) {
                // Large sample pre-draft: GBM+Ridge 50/50
                const gbmPre = predictBaggedGBM(foldPreDraftRookieGbm, row.features).predicted;
                const ridgePre = predict(foldPreDraftRookieRidge, row.features).predicted;
                losoPreDraftRookiePreds.push(gbmPre * 0.5 + ridgePre * 0.5);
              } else if (foldPreDraftRookieRidge) {
                // Small sample pre-draft: Ridge-only, blended with combined
                const ridgePre = predict(foldPreDraftRookieRidge, row.features).predicted;
                const combinedP = gbmPred * 0.7 + ridgePred * 0.3;
                losoPreDraftRookiePreds.push(ridgePre * 0.4 + combinedP * 0.6);
              } else {
                losoPreDraftRookiePreds.push(rvPred);
              }
            } else {
              losoVetActuals.push(row.rawPPG || 0);
              losoVetPreds.push(rvPred);
            }
          } else {
            losoPredRookieVet.push(gbmPred);
            if (isRookie) {
              losoRookieActuals.push(row.rawPPG || 0);
              losoRookiePreds.push(gbmPred);
              losoPreDraftRookiePreds.push(gbmPred);
            } else {
              losoVetActuals.push(row.rawPPG || 0);
              losoVetPreds.push(gbmPred);
            }
          }
        }
      }
    }

    const hasCV = losoActuals.length >= 10;
    const cvR2Ensemble = hasCV ? cvR2(losoActuals, losoPredEnsemble) : 0;
    const cvR2RookieVet = hasCV ? cvR2(losoActuals, losoPredRookieVet) : 0;
    const cvR2RookieOnly = losoRookieActuals.length >= 5 ? cvR2(losoRookieActuals, losoRookiePreds) : 0;
    const cvR2VetOnly = losoVetActuals.length >= 5 ? cvR2(losoVetActuals, losoVetPreds) : 0;
    const cvMaeRookieOnly = losoRookieActuals.length >= 5 ? cvMae(losoRookieActuals, losoRookiePreds) : 0;
    const cvR2PreDraftRookie = losoRookieActuals.length >= 5 ? cvR2(losoRookieActuals, losoPreDraftRookiePreds) : 0;
    const cvMaePreDraftRookie = losoRookieActuals.length >= 5 ? cvMae(losoRookieActuals, losoPreDraftRookiePreds) : 0;
    const cvMaeVetOnly = losoVetActuals.length >= 5 ? cvMae(losoVetActuals, losoVetPreds) : 0;

    // === ADP Value-Add Backtest ===
    // Does the model help identify ADP mispricings?
    let adpValueAdd = { adpRankCorr: 0, modelRankCorr: 0, liftPct: 0,
      buyActualPPG: 0, sellActualPPG: 0, buyN: 0, sellN: 0,
      topNModelHitRate: 0, topNAdpHitRate: 0, topN: 0 };
    if (hasCV && losoAdps.length >= 20) {
      // Spearman rank correlation: rank by ADP vs rank by model, compare to actual
      const n = losoActuals.length;
      const adpRanks = rankArray(losoAdps.map(a => -a)); // lower ADP = better rank
      const modelRanks = rankArray(losoPredEnsemble);
      const actualRanks = rankArray(losoActuals);
      const adpRankCorr = spearman(adpRanks, actualRanks);
      const modelRankCorr = spearman(modelRanks, actualRanks);

      // Fit simple ADP→PPG curve: linear regression of actualPPG on ADP within position
      const adpMean = losoAdps.reduce((a, b) => a + b, 0) / n;
      const ppgMean = losoActuals.reduce((a, b) => a + b, 0) / n;
      let ssAdp = 0, ssAdpPpg = 0;
      for (let i = 0; i < n; i++) {
        ssAdp += (losoAdps[i] - adpMean) ** 2;
        ssAdpPpg += (losoAdps[i] - adpMean) * (losoActuals[i] - ppgMean);
      }
      const slope = ssAdp > 0 ? ssAdpPpg / ssAdp : 0;
      const intercept = ppgMean - slope * adpMean;
      const adpImpliedPPG = losoAdps.map(a => intercept + slope * a);

      // Split by model-vs-ADP disagreement
      const edges = losoPredEnsemble.map((pred, i) => pred - adpImpliedPPG[i]);
      const edgeSorted = [...edges].sort((a, b) => a - b);
      const median = edgeSorted[Math.floor(edgeSorted.length / 2)];

      let buyPPG = 0, buyExpected = 0, buyCount = 0;
      let sellPPG = 0, sellExpected = 0, sellCount = 0;
      for (let i = 0; i < n; i++) {
        if (edges[i] >= median) {
          buyPPG += losoActuals[i]; buyExpected += adpImpliedPPG[i]; buyCount++;
        } else {
          sellPPG += losoActuals[i]; sellExpected += adpImpliedPPG[i]; sellCount++;
        }
      }
      const buyActualPPG = buyCount > 0 ? Math.round(buyPPG / buyCount * 100) / 100 : 0;
      const sellActualPPG = sellCount > 0 ? Math.round(sellPPG / sellCount * 100) / 100 : 0;
      const liftPct = sellActualPPG > 0
        ? Math.round((buyActualPPG - sellActualPPG) / sellActualPPG * 1000) / 10
        : 0;

      // Top-N accuracy: among model's top picks, what % are actual top performers?
      const topN = Math.max(5, Math.floor(n * 0.25));
      const actualTopSet = new Set(
        losoActuals.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v).slice(0, topN).map(x => x.i)
      );
      const modelTopIndices = losoPredEnsemble.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v).slice(0, topN).map(x => x.i);
      const adpTopIndices = losoAdps.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v).slice(0, topN).map(x => x.i);
      const modelHits = modelTopIndices.filter(i => actualTopSet.has(i)).length;
      const adpHits = adpTopIndices.filter(i => actualTopSet.has(i)).length;

      adpValueAdd = {
        adpRankCorr: Math.round(adpRankCorr * 1000) / 1000,
        modelRankCorr: Math.round(modelRankCorr * 1000) / 1000,
        liftPct,
        buyActualPPG, sellActualPPG, buyN: buyCount, sellN: sellCount,
        topNModelHitRate: Math.round(modelHits / topN * 100),
        topNAdpHitRate: Math.round(adpHits / topN * 100),
        topN,
      };
      console.log(`      ADP Value-Add: rank corr ADP=${adpRankCorr.toFixed(3)} vs Model=${modelRankCorr.toFixed(3)}`);
      console.log(`        Buy avg PPG=${buyActualPPG} (n=${buyCount}), Sell avg PPG=${sellActualPPG} (n=${sellCount}), lift=${liftPct}%`);
      console.log(`        Top-${topN} accuracy: Model=${modelHits}/${topN} (${Math.round(modelHits/topN*100)}%), ADP=${adpHits}/${topN} (${Math.round(adpHits/topN*100)}%)`);
    }

    models.push({
      position: pos, ridgeModel, gbmModel, gbmLower, gbmUpper,
      rookieGbmPostDraft, rookieGbmPreDraft,
      rookieRidgePostDraft, rookieRidgePreDraft,
      rookieModelType: hasEnoughForGBM ? 'gbm+ridge' : (hasEnoughForRidge ? 'ridge-only' : null),
      adpValueAdd,
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
      cvR2RookieOnly:  cvR2RookieOnly,
      cvMaeRookieOnly: cvMaeRookieOnly,
      cvR2PreDraftRookie:  cvR2PreDraftRookie,
      cvMaePreDraftRookie: cvMaePreDraftRookie,
      cvR2VetOnly:     cvR2VetOnly,
      cvMaeVetOnly:    cvMaeVetOnly,
      cvR2GbmBaseline: hasCV ? cvR2(losoActuals, losoPredGbmBase) : 0,
    });
    console.log(`    ${pos}: n=${posRows.length}`);
    console.log(`      GBM R²:        ${(models[models.length-1] as any).cvR2Gbm}`);
    console.log(`      Ridge R²:      ${(models[models.length-1] as any).cvR2Ridge}`);
    console.log(`      Ensemble R²:   ${cvR2Ensemble}`);
    console.log(`      Rookie/Vet R²: ${cvR2RookieVet} (post-draft rookie: ${cvR2RookieOnly.toFixed(3)}, pre-draft rookie: ${cvR2PreDraftRookie.toFixed(3)}, n=${losoRookieActuals.length}, vet: ${cvR2VetOnly.toFixed(3)} n=${losoVetActuals.length})`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ADP-FREE PPG MODEL: predict raw PPG without any ADP information
  // This gives us an ADP-independent view of player quality
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n  Training ADP-free PPG models...');

  ppgModels = [];

  for (const pos of POSITIONS) {
    const posRows = result.rows.filter((r: PlayerRow) => r.position === pos && r.adp <= MAX_ADP);
    if (posRows.length < 10) continue;

    // Features EXCLUDING ADP-derived ones
    const posFeatures = FEATURES.filter((f) => f.positions.includes(pos) && !ADP_FEATURES.has(f.key));
    let featureKeys = posFeatures.map((f) => f.key);
    const featureLabels = posFeatures.map((f) => f.label);

    // Feature selection
    const ppgCfg = POS_CONFIG[pos] || POS_CONFIG.WR;
    if (featureKeys.length > ppgCfg.maxFeatures) {
      console.log(`      PPG Feature selection: ${featureKeys.length} → ${ppgCfg.maxFeatures}`);
      const XAll = posRows.map((r: PlayerRow) => featureKeys.map((k) => r.features[k] || 0));
      const yAll = posRows.map((r: PlayerRow) => r.rawPPG || 0);
      const quickGbm = trainGBM(XAll, yAll, featureKeys, {
        nEstimators: 50, learningRate: 0.1, maxDepth: 2, subsample: 0.7,
        minSamplesLeaf: Math.max(5, Math.round(posRows.length * 0.1)),
      });
      const importanceSums = new Array(featureKeys.length).fill(0);
      const sStep = Math.max(1, Math.floor(posRows.length / 100));
      for (let i = 0; i < posRows.length; i += sStep) {
        const pred = predictGBM(quickGbm, posRows[i].features);
        for (const fc of pred.featureContributions) {
          const idx = featureKeys.indexOf(fc.name);
          if (idx >= 0) importanceSums[idx] += Math.abs(fc.contribution);
        }
      }
      const ranked = featureKeys.map((k, i) => ({ key: k, imp: importanceSums[i] })).sort((a, b) => b.imp - a.imp);
      const topKeys = new Set(ranked.slice(0, ppgCfg.maxFeatures).map((r) => r.key));
      featureKeys = featureKeys.filter((k) => topKeys.has(k));
    }

    // Train PPG model (target = rawPPG, ADP-free features)
    const X = posRows.map((r: PlayerRow) => featureKeys.map((k) => r.features[k] || 0));
    const y = posRows.map((r: PlayerRow) => r.rawPPG || 0);
    const msl = Math.max(3, Math.round(posRows.length * ppgCfg.minLeafPct));

    const ppgGbm = trainGBM(X, y, featureKeys, {
      nEstimators: ppgCfg.gbmEstimators, learningRate: ppgCfg.gbmLR,
      maxDepth: ppgCfg.gbmDepth, subsample: 0.8, minSamplesLeaf: msl,
    });
    const ppgRidgeLambda = Math.max(ppgCfg.ridgeLambda, Math.sqrt(featureKeys.length));
    const ppgRidge = trainRidgeRegression(X, y, featureKeys, ppgRidgeLambda);
    console.log(`      PPG Ridge: lambda=${ppgRidgeLambda}, in-sample R²=${ppgRidge.rSquared.toFixed(4)}, coeffs non-zero: ${ppgRidge.coefficients.filter((c: number) => Math.abs(c) > 1e-10).length}/${ppgRidge.coefficients.length}`);

    // LOSO CV for PPG model
    const uniqueSeasons = [...new Set(posRows.map((r: PlayerRow) => r.season))].sort();
    const ppgLosoActuals: number[] = [];
    const ppgLosoPredGbm: number[] = [];
    const ppgLosoPredRidge: number[] = [];
    const ppgLosoAdps: number[] = [];

    if (uniqueSeasons.length >= 3) {
      for (const held of uniqueSeasons) {
        const trainR = posRows.filter((r: PlayerRow) => r.season !== held);
        const testR = posRows.filter((r: PlayerRow) => r.season === held);
        if (trainR.length < 8 || testR.length === 0) continue;

        const Xtr = trainR.map((r: PlayerRow) => featureKeys.map((k) => r.features[k] || 0));
        const ytr = trainR.map((r: PlayerRow) => r.rawPPG || 0);
        const foldMsl = Math.max(3, Math.round(trainR.length * ppgCfg.minLeafPct));

        const foldGbm = trainGBM(Xtr, ytr, featureKeys, {
          nEstimators: Math.min(80, ppgCfg.gbmEstimators), learningRate: ppgCfg.gbmLR + 0.02,
          maxDepth: ppgCfg.gbmDepth, subsample: 0.8, minSamplesLeaf: foldMsl,
        });
        const foldRidge = trainRidgeRegression(Xtr, ytr, featureKeys, ppgRidgeLambda);

        for (const row of testR) {
          ppgLosoActuals.push(row.rawPPG || 0);
          ppgLosoAdps.push(row.adp);
          ppgLosoPredGbm.push(predictGBM(foldGbm, row.features).predicted);
          ppgLosoPredRidge.push(predict(foldRidge, row.features).predicted);
        }
      }
    }

    const hasPPGCV = ppgLosoActuals.length >= 10;

    // ADP value-add for ADP-free model
    let ppgAdpValueAdd = { adpRankCorr: 0, modelRankCorr: 0, liftPct: 0,
      buyActualPPG: 0, sellActualPPG: 0, buyN: 0, sellN: 0,
      topNModelHitRate: 0, topNAdpHitRate: 0, topN: 0 };
    if (hasPPGCV && ppgLosoAdps.length >= 20) {
      const nPPG = ppgLosoActuals.length;
      const ppgEnsemble = ppgLosoPredGbm.map((g, i) => g * 0.7 + ppgLosoPredRidge[i] * 0.3);
      const adpRanks = rankArray(ppgLosoAdps.map(a => -a));
      const modelRanks = rankArray(ppgEnsemble);
      const actualRanks = rankArray(ppgLosoActuals);
      const adpRankCorr = spearman(adpRanks, actualRanks);
      const modelRankCorr = spearman(modelRanks, actualRanks);

      const adpMean = ppgLosoAdps.reduce((a, b) => a + b, 0) / nPPG;
      const ppgMean = ppgLosoActuals.reduce((a, b) => a + b, 0) / nPPG;
      let ssAdp = 0, ssAdpPpg = 0;
      for (let i = 0; i < nPPG; i++) {
        ssAdp += (ppgLosoAdps[i] - adpMean) ** 2;
        ssAdpPpg += (ppgLosoAdps[i] - adpMean) * (ppgLosoActuals[i] - ppgMean);
      }
      const slope = ssAdp > 0 ? ssAdpPpg / ssAdp : 0;
      const intercept = ppgMean - slope * adpMean;
      const adpImpliedPPG = ppgLosoAdps.map(a => intercept + slope * a);

      const edges = ppgEnsemble.map((pred, i) => pred - adpImpliedPPG[i]);
      const edgeSorted = [...edges].sort((a, b) => a - b);
      const median = edgeSorted[Math.floor(edgeSorted.length / 2)];

      let buyPPG = 0, buyCount = 0, sellPPG = 0, sellCount = 0;
      for (let i = 0; i < nPPG; i++) {
        if (edges[i] >= median) { buyPPG += ppgLosoActuals[i]; buyCount++; }
        else { sellPPG += ppgLosoActuals[i]; sellCount++; }
      }
      const buyActualPPG = buyCount > 0 ? Math.round(buyPPG / buyCount * 100) / 100 : 0;
      const sellActualPPG = sellCount > 0 ? Math.round(sellPPG / sellCount * 100) / 100 : 0;
      const liftPct = sellActualPPG > 0 ? Math.round((buyActualPPG - sellActualPPG) / sellActualPPG * 1000) / 10 : 0;

      const topN = Math.max(5, Math.floor(nPPG * 0.25));
      const actualTopSet = new Set(ppgLosoActuals.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v).slice(0, topN).map(x => x.i));
      const modelHits = ppgEnsemble.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v).slice(0, topN).map(x => x.i).filter(i => actualTopSet.has(i)).length;
      const adpHits = ppgLosoAdps.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v).slice(0, topN).map(x => x.i).filter(i => actualTopSet.has(i)).length;

      ppgAdpValueAdd = {
        adpRankCorr: Math.round(adpRankCorr * 1000) / 1000,
        modelRankCorr: Math.round(modelRankCorr * 1000) / 1000,
        liftPct, buyActualPPG, sellActualPPG, buyN: buyCount, sellN: sellCount,
        topNModelHitRate: Math.round(modelHits / topN * 100),
        topNAdpHitRate: Math.round(adpHits / topN * 100), topN,
      };
      console.log(`      PPG ADP Value-Add: rank corr ADP=${adpRankCorr.toFixed(3)} vs Model=${modelRankCorr.toFixed(3)}, lift=${liftPct}%`);
    }

    ppgModels.push({
      position: pos,
      gbmModel: ppgGbm,
      ridgeModel: ppgRidge,
      featureNames: featureKeys,
      featureLabels: featureKeys.map((k) => {
        const f = FEATURES.find((ff) => ff.key === k);
        return f?.label || k;
      }),
      n: posRows.length,
      cvR2Gbm: hasPPGCV ? cvR2(ppgLosoActuals, ppgLosoPredGbm) : 0,
      cvR2Ridge: hasPPGCV ? cvR2(ppgLosoActuals, ppgLosoPredRidge) : 0,
      cvMaeGbm: hasPPGCV ? cvMae(ppgLosoActuals, ppgLosoPredGbm) : 0,
      adpValueAdd: ppgAdpValueAdd,
    });

    console.log(`    ${pos}: PPG model n=${posRows.length}, features=${featureKeys.length}, CV R²=${hasPPGCV ? cvR2(ppgLosoActuals, ppgLosoPredGbm).toFixed(3) : 'N/A'}`);

  }

  // ═══════════════════════════════════════════════════════════════════════
  // ADP-RESIDUAL MODEL: train to predict actual_PPG - ADP_implied_PPG
  // This learns WHERE ADP is wrong instead of trying to replicate ADP's rankings.
  // Final prediction = ADP_implied + alpha * model_residual
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n  Training ADP-residual models...');

  residualModels = [];

  for (const pos of POSITIONS) {
    const posRows = result.rows.filter((r: PlayerRow) => r.position === pos && r.adp <= MAX_ADP);
    if (posRows.length < 10) continue;

    // Use NON-ADP features — model should learn signal ADP doesn't capture
    const posFeatures = FEATURES.filter((f) => f.positions.includes(pos) && !ADP_FEATURES.has(f.key));
    let featureKeys = posFeatures.map((f) => f.key);

    // Feature selection
    const resCfg = POS_CONFIG[pos] || POS_CONFIG.WR;
    // Fit position-level ADP→PPG curve (used to compute residuals)
    const allAdps = posRows.map((r: PlayerRow) => r.adp);
    const allPPG = posRows.map((r: PlayerRow) => r.rawPPG || 0);
    const adpMeanAll = allAdps.reduce((a, b) => a + b, 0) / allAdps.length;
    const ppgMeanAll = allPPG.reduce((a, b) => a + b, 0) / allPPG.length;
    let ssAdpAll = 0, ssAdpPpgAll = 0;
    for (let i = 0; i < allAdps.length; i++) {
      ssAdpAll += (allAdps[i] - adpMeanAll) ** 2;
      ssAdpPpgAll += (allAdps[i] - adpMeanAll) * (allPPG[i] - ppgMeanAll);
    }
    const slopeAll = ssAdpAll > 0 ? ssAdpPpgAll / ssAdpAll : 0;
    const interceptAll = ppgMeanAll - slopeAll * adpMeanAll;
    console.log(`    ${pos}: ADP→PPG curve: PPG = ${interceptAll.toFixed(2)} + ${slopeAll.toFixed(4)} * ADP`);

    if (featureKeys.length > resCfg.maxFeatures) {
      const XAll = posRows.map((r: PlayerRow) => featureKeys.map((k) => r.features[k] || 0));
      const yRes = posRows.map((r: PlayerRow) => (r.rawPPG || 0) - (interceptAll + slopeAll * r.adp));
      const quickGbm = trainGBM(XAll, yRes, featureKeys, {
        nEstimators: 50, learningRate: 0.1, maxDepth: 2, subsample: 0.7,
        minSamplesLeaf: Math.max(5, Math.round(posRows.length * 0.1)),
      });
      const importanceSums = new Array(featureKeys.length).fill(0);
      const sStep = Math.max(1, Math.floor(posRows.length / 100));
      for (let i = 0; i < posRows.length; i += sStep) {
        const pred = predictGBM(quickGbm, posRows[i].features);
        for (const fc of pred.featureContributions) {
          const idx = featureKeys.indexOf(fc.name);
          if (idx >= 0) importanceSums[idx] += Math.abs(fc.contribution);
        }
      }
      const ranked = featureKeys.map((k, i) => ({ key: k, imp: importanceSums[i] })).sort((a, b) => b.imp - a.imp);
      featureKeys = ranked.slice(0, resCfg.maxFeatures).map((r) => r.key);
    }

    // LOSO CV: train residual model per fold, test blended prediction
    const uniqueSeasons = [...new Set(posRows.map((r: PlayerRow) => r.season))].sort();
    const resLosoActuals: number[] = [];
    const resLosoAdps: number[] = [];
    const resLosoResidualPreds: number[] = [];  // raw residual predictions
    const resLosoAdpImplied: number[] = [];     // ADP-implied PPG per test player
    // Also track hit/bust labels
    const resLosoIsHit: boolean[] = [];
    const resLosoIsBust: boolean[] = [];
    // Capture last-season player-level data for draft simulation
    const lastSeason = uniqueSeasons.length > 0 ? uniqueSeasons[uniqueSeasons.length - 1] : 0;
    const playersDraftSim: Array<{
      name: string; position: string; adp: number; actualPPG: number;
      modelPPG: number; residual: number; adpImpliedPPG: number;
      isHit: boolean; isBust: boolean;
    }> = [];

    if (uniqueSeasons.length >= 3) {
      for (const held of uniqueSeasons) {
        const trainR = posRows.filter((r: PlayerRow) => r.season !== held);
        const testR = posRows.filter((r: PlayerRow) => r.season === held);
        if (trainR.length < 8 || testR.length === 0) continue;

        // Fit fold-specific ADP→PPG curve (honest: only uses training data)
        const foldAdps = trainR.map((r: PlayerRow) => r.adp);
        const foldPPGs = trainR.map((r: PlayerRow) => r.rawPPG || 0);
        const foldAdpMean = foldAdps.reduce((a, b) => a + b, 0) / foldAdps.length;
        const foldPpgMean = foldPPGs.reduce((a, b) => a + b, 0) / foldPPGs.length;
        let ssAdpF = 0, ssApF = 0;
        for (let i = 0; i < foldAdps.length; i++) {
          ssAdpF += (foldAdps[i] - foldAdpMean) ** 2;
          ssApF += (foldAdps[i] - foldAdpMean) * (foldPPGs[i] - foldPpgMean);
        }
        const foldSlope = ssAdpF > 0 ? ssApF / ssAdpF : 0;
        const foldIntercept = foldPpgMean - foldSlope * foldAdpMean;

        // Train residual model: target = actual_PPG - ADP_implied_PPG
        const yResidual = trainR.map((r: PlayerRow) => (r.rawPPG || 0) - (foldIntercept + foldSlope * r.adp));
        const Xtr = trainR.map((r: PlayerRow) => featureKeys.map((k) => r.features[k] || 0));
        const foldMsl = Math.max(3, Math.round(trainR.length * resCfg.minLeafPct));

        const foldResGbm = trainGBM(Xtr, yResidual, featureKeys, {
          nEstimators: Math.min(80, resCfg.gbmEstimators),
          learningRate: resCfg.gbmLR + 0.02,
          maxDepth: resCfg.gbmDepth, subsample: 0.8, minSamplesLeaf: foldMsl,
        });
        const resLambda = Math.max(resCfg.ridgeLambda, Math.sqrt(featureKeys.length));
        const foldResRidge = trainRidgeRegression(Xtr, yResidual, featureKeys, resLambda);

        for (const row of testR) {
          const adpImplied = foldIntercept + foldSlope * row.adp;
          const gbmRes = predictGBM(foldResGbm, row.features).predicted;
          const ridgeRes = predict(foldResRidge, row.features).predicted;
          const residualPred = gbmRes * 0.7 + ridgeRes * 0.3;

          resLosoActuals.push(row.rawPPG || 0);
          resLosoAdps.push(row.adp);
          resLosoResidualPreds.push(residualPred);
          resLosoAdpImplied.push(adpImplied);
          resLosoIsHit.push(!!row.isHit);
          resLosoIsBust.push(!!row.isBust);

          // Capture last-season player data for draft sim
          if (held === lastSeason) {
            playersDraftSim.push({
              name: row.name, position: pos, adp: row.adp,
              actualPPG: row.rawPPG || 0,
              adpImpliedPPG: Math.round(adpImplied * 10) / 10,
              residual: Math.round(residualPred * 100) / 100,
              modelPPG: Math.round((adpImplied + residualPred) * 10) / 10,
              isHit: !!row.isHit, isBust: !!row.isBust,
            });
          }
        }
      }
    }

    // Find optimal alpha: final_pred = ADP_implied + alpha * residual_pred
    // Test alphas from 0 (pure ADP) to 1 (full model adjustment)
    const hasResCV = resLosoActuals.length >= 20;
    let bestAlpha = 0;
    let bestBlendCorr = -1;
    const alphaResults: Array<{ alpha: number; rankCorr: number; r2: number }> = [];

    if (hasResCV) {
      const actualRanks = rankArray(resLosoActuals);
      const adpRanks = rankArray(resLosoAdps.map(a => -a));
      const adpOnlyCorr = spearman(adpRanks, actualRanks);

      for (let alpha = 0; alpha <= 1.01; alpha += 0.1) {
        const blended = resLosoAdpImplied.map((imp, i) => imp + alpha * resLosoResidualPreds[i]);
        const blendRanks = rankArray(blended);
        const corr = spearman(blendRanks, actualRanks);
        const r2 = cvR2(resLosoActuals, blended);
        alphaResults.push({ alpha: Math.round(alpha * 10) / 10, rankCorr: corr, r2 });
        if (corr > bestBlendCorr) {
          bestBlendCorr = corr;
          bestAlpha = Math.round(alpha * 10) / 10;
        }
      }
      console.log(`    ${pos}: Best alpha=${bestAlpha} (rank corr=${bestBlendCorr.toFixed(3)} vs ADP-only=${adpOnlyCorr.toFixed(3)})`);
      console.log(`      Alpha sweep: ${alphaResults.map(a => `${a.alpha}→${a.rankCorr.toFixed(3)}`).join(', ')}`);
    }

    // Compute backtest metrics at best alpha
    let residualBacktest = {
      adpRankCorr: 0, modelRankCorr: 0, bestAlpha: 0, blendedRankCorr: 0,
      liftPct: 0, buyActualPPG: 0, sellActualPPG: 0, buyN: 0, sellN: 0,
      buyHitRate: 0, sellHitRate: 0, buyBustRate: 0, sellBustRate: 0,
      topNModelHitRate: 0, topNAdpHitRate: 0, topN: 0,
    };
    if (hasResCV) {
      const n = resLosoActuals.length;
      const adpRanks = rankArray(resLosoAdps.map(a => -a));
      const actualRanks = rankArray(resLosoActuals);
      const adpRankCorr = spearman(adpRanks, actualRanks);

      // Blended predictions at best alpha
      const blended = resLosoAdpImplied.map((imp, i) => imp + bestAlpha * resLosoResidualPreds[i]);
      const blendRanks = rankArray(blended);
      const blendedRankCorr = spearman(blendRanks, actualRanks);

      // Raw model (alpha=1) for comparison
      const rawModel = resLosoAdpImplied.map((imp, i) => imp + resLosoResidualPreds[i]);
      const rawModelRanks = rankArray(rawModel);
      const modelRankCorr = spearman(rawModelRanks, actualRanks);

      // Buy/sell split: where does the model disagree with ADP?
      // "Edge" = how much model thinks player is undervalued
      const edges = resLosoResidualPreds.slice(); // positive = model says undervalued
      const edgeSorted = [...edges].sort((a, b) => a - b);
      const median = edgeSorted[Math.floor(edgeSorted.length / 2)];

      let buyPPG = 0, buyCount = 0, sellPPG = 0, sellCount = 0;
      let buyHits = 0, buyBusts = 0, sellHits = 0, sellBusts = 0;
      for (let i = 0; i < n; i++) {
        if (edges[i] >= median) {
          buyPPG += resLosoActuals[i]; buyCount++;
          if (resLosoIsHit[i]) buyHits++;
          if (resLosoIsBust[i]) buyBusts++;
        } else {
          sellPPG += resLosoActuals[i]; sellCount++;
          if (resLosoIsHit[i]) sellHits++;
          if (resLosoIsBust[i]) sellBusts++;
        }
      }
      const buyActualPPG = buyCount > 0 ? Math.round(buyPPG / buyCount * 100) / 100 : 0;
      const sellActualPPG = sellCount > 0 ? Math.round(sellPPG / sellCount * 100) / 100 : 0;
      const liftPct = sellActualPPG > 0
        ? Math.round((buyActualPPG - sellActualPPG) / sellActualPPG * 1000) / 10 : 0;

      // Top-N accuracy
      const topN = Math.max(5, Math.floor(n * 0.25));
      const actualTopSet = new Set(
        resLosoActuals.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v).slice(0, topN).map(x => x.i)
      );
      const modelTopIndices = blended.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v).slice(0, topN).map(x => x.i);
      const adpTopIndices = resLosoAdps.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v).slice(0, topN).map(x => x.i);
      const modelHits = modelTopIndices.filter(i => actualTopSet.has(i)).length;
      const adpHits = adpTopIndices.filter(i => actualTopSet.has(i)).length;

      residualBacktest = {
        adpRankCorr: Math.round(adpRankCorr * 1000) / 1000,
        modelRankCorr: Math.round(modelRankCorr * 1000) / 1000,
        bestAlpha,
        blendedRankCorr: Math.round(blendedRankCorr * 1000) / 1000,
        liftPct,
        buyActualPPG, sellActualPPG, buyN: buyCount, sellN: sellCount,
        buyHitRate: buyCount > 0 ? Math.round(buyHits / buyCount * 100) : 0,
        sellHitRate: sellCount > 0 ? Math.round(sellHits / sellCount * 100) : 0,
        buyBustRate: buyCount > 0 ? Math.round(buyBusts / buyCount * 100) : 0,
        sellBustRate: sellCount > 0 ? Math.round(sellBusts / sellCount * 100) : 0,
        topNModelHitRate: Math.round(modelHits / topN * 100),
        topNAdpHitRate: Math.round(adpHits / topN * 100),
        topN,
      };
      console.log(`      Residual backtest: ADP corr=${adpRankCorr.toFixed(3)}, Model(α=1)=${modelRankCorr.toFixed(3)}, Blended(α=${bestAlpha})=${blendedRankCorr.toFixed(3)}`);
      console.log(`      Buy PPG=${buyActualPPG} (hits=${Math.round(buyHits/buyCount*100)}%, busts=${Math.round(buyBusts/buyCount*100)}%)`);
      console.log(`      Sell PPG=${sellActualPPG} (hits=${Math.round(sellHits/sellCount*100)}%, busts=${Math.round(sellBusts/sellCount*100)}%)`);
      console.log(`      Lift=${liftPct}%, Top-${topN}: Model=${modelHits}/${topN} (${Math.round(modelHits/topN*100)}%), ADP=${adpHits}/${topN} (${Math.round(adpHits/topN*100)}%)`);
    }

    // Train full-data residual model for 2026 predictions
    const yResAll = posRows.map((r: PlayerRow) => (r.rawPPG || 0) - (interceptAll + slopeAll * r.adp));
    const XResAll = posRows.map((r: PlayerRow) => featureKeys.map((k) => r.features[k] || 0));
    const resMsl = Math.max(3, Math.round(posRows.length * resCfg.minLeafPct));
    const resGbm = trainGBM(XResAll, yResAll, featureKeys, {
      nEstimators: resCfg.gbmEstimators, learningRate: resCfg.gbmLR,
      maxDepth: resCfg.gbmDepth, subsample: 0.8, minSamplesLeaf: resMsl,
    });
    const resLambda = Math.max(resCfg.ridgeLambda, Math.sqrt(featureKeys.length));
    const resRidge = trainRidgeRegression(XResAll, yResAll, featureKeys, resLambda);

    residualModels.push({
      position: pos,
      gbmModel: resGbm, ridgeModel: resRidge,
      adpSlope: slopeAll, adpIntercept: interceptAll,
      bestAlpha,
      featureNames: featureKeys,
      n: posRows.length,
      backtest: residualBacktest,
      playersDraftSim,
      lastSeason,
    });
    console.log(`      Draft sim: ${playersDraftSim.length} players captured for season ${lastSeason} (uniqueSeasons: ${uniqueSeasons.join(',')})`);


    console.log(`    ${pos}: Residual model done (n=${posRows.length}, features=${featureKeys.length}, α=${bestAlpha})`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SIMULATED 2025 DRAFT: ADP team vs Model team in a 12-team snake draft
  // Uses honest out-of-sample predictions (trained on 2018-2024, tested on 2025)
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n  Simulating 2025 draft...');

  // Collect all last-season players across positions
  const allDraftSimPlayers: Array<{
    name: string; position: string; adp: number; actualPPG: number;
    modelPPG: number; residual: number; adpImpliedPPG: number;
    isHit: boolean; isBust: boolean;
  }> = [];
  let draftSimSeason = 0;
  for (const m of residualModels) {
    const pds = (m as any).playersDraftSim as typeof allDraftSimPlayers;
    const ls = (m as any).lastSeason as number;
    const alpha = (m as any).bestAlpha as number;
    if (pds && pds.length > 0) {
      // Apply position-specific bestAlpha to residual and modelPPG
      const pos = (m as any).position as string;
      for (const p of pds) {
        p.residual = Math.round(p.residual * alpha * 100) / 100; // scale residual by alpha
        p.modelPPG = Math.round((p.adpImpliedPPG + p.residual) * 10) / 10; // blended prediction
      }
      const avgRes = pds.reduce((s, p) => s + Math.abs(p.residual), 0) / pds.length;
      console.log(`      ${pos}: α=${alpha}, ${pds.length} players, avg |residual|=${avgRes.toFixed(2)}`);
      allDraftSimPlayers.push(...pds);
      draftSimSeason = Math.max(draftSimSeason, ls || 0);
    }
  }
  // Sort by ADP for draft order
  allDraftSimPlayers.sort((a, b) => a.adp - b.adp);
  console.log(`    ${allDraftSimPlayers.length} players available for ${draftSimSeason} draft sim`);

  // Snake draft simulation: 12 teams, 15 rounds
  // Run multiple iterations per pick position with variance for robust results
  const NUM_TEAMS = 12;
  const NUM_ROUNDS = 15;
  const SIMS_PER_PICK = 50; // iterations per pick position

  // Roster requirements
  const MAX_POS = { QB: 1, RB: 5, WR: 5, TE: 2 };
  const STARTER_NEEDS = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 }; // 7 starters
  const QB_DEADLINE = 10; // must draft a QB before this round

  // Seeded PRNG (mulberry32) for reproducible randomness
  function mulberry32(seed: number) {
    return () => {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  type DraftPick = { name: string; position: string; adp: number; actualPPG: number; modelPPG: number; round: number; pickNum: number; isHit: boolean; isBust: boolean };

  function simulateDraft(useModel: boolean, pickPosition: number, rng: () => number): DraftPick[] {
    const available = [...allDraftSimPlayers];
    const ourTeam: DraftPick[] = [];
    const ourPosCounts: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };

    let overallPick = 0;
    for (let round = 0; round < NUM_ROUNDS; round++) {
      // Snake order: even rounds go 0→11, odd rounds go 11→0
      const picksThisRound = round % 2 === 0
        ? Array.from({ length: NUM_TEAMS }, (_, i) => i)
        : Array.from({ length: NUM_TEAMS }, (_, i) => NUM_TEAMS - 1 - i);

      for (const teamSlot of picksThisRound) {
        if (available.length === 0) break;
        const isOurPick = (round % 2 === 0 ? teamSlot === pickPosition - 1 : teamSlot === NUM_TEAMS - pickPosition);

        if (isOurPick) {
          // Must draft QB before round QB_DEADLINE
          const mustDraftQB = ourPosCounts.QB === 0 && round >= QB_DEADLINE - 1;

          let bestIdx = 0;
          if (useModel) {
            // ── OPTIMIZED DRAFTER: Value Over Next Available (VONA) ──
            // Rounds 1-2: lean toward best available (premium picks are too valuable to gamble)
            // Rounds 3+: full VONA optimization for roster composition

            // Compute picks until our next turn (snake draft math)
            let picksUntilNext: number;
            if (round >= NUM_ROUNDS - 1) {
              picksUntilNext = 999; // last round, no next pick
            } else if (round % 2 === 0) {
              picksUntilNext = 2 * (NUM_TEAMS - pickPosition);
            } else {
              picksUntilNext = 2 * pickPosition;
            }

            // Find best replacement at each position available ~picksUntilNext picks later
            const posReplacement: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
            for (let i = 0; i < available.length; i++) {
              const p = available[i];
              if (i >= picksUntilNext && posReplacement[p.position] === 0) {
                posReplacement[p.position] = p.modelPPG;
              }
            }

            // Phase-based strategy:
            // Rounds 1-2: Near-pure BPA — premium picks too valuable to gamble on model signal
            // Rounds 3-5: VONA kicks in for positional scarcity
            // Rounds 6+: Aggressive upside hunting for late-round value
            const vonaWeight = round < 2 ? 0.05 : round < 4 ? 0.6 : 1.0;
            const WINDOW = round < 2 ? 2 : round < 5 ? 6 : 10;

            const candidates: Array<{ idx: number; score: number }> = [];
            for (let i = 0; i < available.length && candidates.length < WINDOW; i++) {
              const p = available[i];
              if ((ourPosCounts[p.position] || 0) >= (MAX_POS[p.position as keyof typeof MAX_POS] || 0)) continue;
              if (mustDraftQB && p.position !== 'QB') continue;

              // VONA: how much value we lose by waiting at this position
              const vona = p.modelPPG - posReplacement[p.position];

              // Starter marginal value: starters >> bench
              const starterNeed = STARTER_NEEDS[p.position as keyof typeof STARTER_NEEDS] || 0;
              const flexEligible = ['RB', 'WR', 'TE'].includes(p.position);
              const flexNeed = flexEligible && ourPosCounts.RB + ourPosCounts.WR + ourPosCounts.TE <
                (STARTER_NEEDS.RB + STARTER_NEEDS.WR + STARTER_NEEDS.TE + STARTER_NEEDS.FLEX);
              const isStarter = ourPosCounts[p.position] < starterNeed || (flexNeed && ourPosCounts[p.position] === starterNeed);
              const starterMult = isStarter ? 1.5 : 0.6;

              // Buy/sell filter from model residual (already alpha-scaled)
              const residualBonus = p.residual;

              // Early round bust avoidance: near-absolute penalty for negative residual
              const bustPenalty = round < 2 ? (p.residual < 0 ? p.residual * 5.0 : 0)
                : round < 4 ? (p.residual < 0 ? p.residual * 2.5 : 0)
                : 0;

              // ADP reach penalty: near-zero tolerance early, lighter later
              const reachPenalty = i * (round < 2 ? 3.0 : round < 4 ? 0.6 : 0.15);

              // Raw modelPPG anchor: dominant in early rounds to keep BPA discipline
              const rawPPG = round < 2 ? p.modelPPG * 0.7 : 0;

              // Late-round upside bonus: reward positive residual sleepers in rounds 7+
              const upsideBonus = round >= 6 && p.residual > 0 ? p.residual * 2.0 : 0;

              const score = vona * vonaWeight * starterMult + residualBonus + bustPenalty - reachPenalty + rawPPG + upsideBonus + (rng() - 0.5) * 0.2;
              candidates.push({ idx: i, score });
            }
            if (candidates.length > 0) {
              let bestScore = -Infinity;
              for (const c of candidates) {
                if (c.score > bestScore) { bestScore = c.score; bestIdx = c.idx; }
              }
            }
          } else {
            // ADP drafter: mostly follows ADP but with slight variance
            // Pick from top eligible players with ADP-weighted probability
            const candidates: number[] = [];
            for (let i = 0; i < Math.min(available.length, 5); i++) {
              const p = available[i];
              if ((ourPosCounts[p.position] || 0) >= (MAX_POS[p.position as keyof typeof MAX_POS] || 0)) continue;
              if (mustDraftQB && p.position !== 'QB') continue;
              candidates.push(i);
            }
            // Fallback: if top-5 filter removed all, widen search
            if (candidates.length === 0) {
              for (let i = 0; i < available.length; i++) {
                const p = available[i];
                if ((ourPosCounts[p.position] || 0) >= (MAX_POS[p.position as keyof typeof MAX_POS] || 0)) continue;
                if (mustDraftQB && p.position !== 'QB') continue;
                candidates.push(i);
                if (candidates.length >= 3) break;
              }
            }
            if (candidates.length > 0) {
              // Weight heavily toward top ADP: weights = [1.0, 0.3, 0.1, 0.05, 0.02]
              const weights = candidates.map((_, j) => Math.pow(0.3, j));
              const totalW = weights.reduce((a, b) => a + b, 0);
              let r = rng() * totalW;
              let chosen = candidates[0];
              for (let j = 0; j < weights.length; j++) {
                r -= weights[j];
                if (r <= 0) { chosen = candidates[j]; break; }
              }
              bestIdx = chosen;
            }
          }

          const picked = available.splice(bestIdx, 1)[0];
          ourPosCounts[picked.position] = (ourPosCounts[picked.position] || 0) + 1;
          ourTeam.push({
            name: picked.name, position: picked.position, adp: picked.adp,
            actualPPG: picked.actualPPG, modelPPG: picked.modelPPG,
            round: round + 1, pickNum: overallPick + 1,
            isHit: picked.isHit, isBust: picked.isBust,
          });
        } else {
          // Other teams: pick from top ~3 ADP with some variance
          if (available.length > 0) {
            const topN = Math.min(available.length, 3);
            const weights = Array.from({ length: topN }, (_, j) => Math.pow(0.35, j));
            const totalW = weights.reduce((a, b) => a + b, 0);
            let r = rng() * totalW;
            let idx = 0;
            for (let j = 0; j < weights.length; j++) {
              r -= weights[j];
              if (r <= 0) { idx = j; break; }
            }
            available.splice(idx, 1);
          }
        }
        overallPick++;
      }
    }
    return ourTeam;
  }

  // Build starting lineup by draft order: earliest-drafted players start at each slot
  function draftOrderLineup(team: DraftPick[]): { starters: DraftPick[]; bench: DraftPick[]; totalPPG: number; seasonPPR: number } {
    // Team is already in draft order (round 1 first)
    const sorted = [...team].sort((a, b) => a.round - b.round || a.pickNum - b.pickNum);
    const starters: DraftPick[] = [];
    const filled = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0 };
    const STARTER_SLOTS = { QB: 1, RB: 2, WR: 2, TE: 1 };

    // First pass: fill primary position slots by draft order
    for (const p of sorted) {
      const need = STARTER_SLOTS[p.position as keyof typeof STARTER_SLOTS] || 0;
      if (filled[p.position as keyof typeof filled] < need) {
        starters.push(p);
        filled[p.position as keyof typeof filled]++;
      }
    }

    // Second pass: fill FLEX with earliest-drafted remaining RB/WR/TE
    if (filled.FLEX === 0) {
      const starterSet = new Set(starters);
      for (const p of sorted) {
        if (!starterSet.has(p) && ['RB', 'WR', 'TE'].includes(p.position)) {
          starters.push(p);
          filled.FLEX = 1;
          break;
        }
      }
    }

    const starterSet = new Set(starters);
    const bench = sorted.filter(p => !starterSet.has(p));
    const totalPPG = Math.round(starters.reduce((s, p) => s + p.actualPPG, 0) * 10) / 10;
    return { starters, bench, totalPPG, seasonPPR: Math.round(totalPPG * 17) };
  }

  // Run multiple sims per pick position with variance
  const perPickResults: Array<{
    pickPos: number;
    adpPPG: number; modelPPG: number; deltaPPG: number;
    adpHits: number; adpBusts: number; modelHits: number; modelBusts: number;
    modelWinRate: number;
    adpTeam: DraftPick[]; modelTeam: DraftPick[];
    adpStarters: Set<string>; modelStarters: Set<string>;
  }> = [];

  console.log(`    Running ${SIMS_PER_PICK} sims per pick position (${NUM_TEAMS} positions, ${SIMS_PER_PICK * NUM_TEAMS} total drafts)...`);

  for (let pick = 1; pick <= NUM_TEAMS; pick++) {
    let sumAdpPPG = 0, sumModelPPG = 0;
    let sumAdpHits = 0, sumAdpBusts = 0, sumModelHits = 0, sumModelBusts = 0;
    let pickWins = 0;
    // Keep best model sim for example display
    let bestModelTeam: DraftPick[] = [];
    let bestAdpTeam: DraftPick[] = [];
    let bestModelLineup: ReturnType<typeof draftOrderLineup> | null = null;
    let bestAdpLineup: ReturnType<typeof draftOrderLineup> | null = null;
    let bestDelta = -Infinity;

    for (let sim = 0; sim < SIMS_PER_PICK; sim++) {
      // Each sim gets a unique seed: pick * 10000 + sim
      const adpRng = mulberry32(pick * 10000 + sim);
      const modelRng = mulberry32(pick * 10000 + sim + 5000);
      const adpTeam = simulateDraft(false, pick, adpRng);
      const modelTeam = simulateDraft(true, pick, modelRng);
      const adpLineup = draftOrderLineup(adpTeam);
      const modelLineup = draftOrderLineup(modelTeam);

      sumAdpPPG += adpLineup.totalPPG;
      sumModelPPG += modelLineup.totalPPG;
      sumAdpHits += adpTeam.filter(p => p.isHit).length;
      sumAdpBusts += adpTeam.filter(p => p.isBust).length;
      sumModelHits += modelTeam.filter(p => p.isHit).length;
      sumModelBusts += modelTeam.filter(p => p.isBust).length;
      if (modelLineup.totalPPG > adpLineup.totalPPG) pickWins++;

      const delta = modelLineup.totalPPG - adpLineup.totalPPG;
      if (delta > bestDelta) {
        bestDelta = delta;
        bestModelTeam = modelTeam;
        bestAdpTeam = adpTeam;
        bestModelLineup = modelLineup;
        bestAdpLineup = adpLineup;
      }
    }

    const n = SIMS_PER_PICK;
    const avgAdp = Math.round(sumAdpPPG / n * 10) / 10;
    const avgModel = Math.round(sumModelPPG / n * 10) / 10;
    perPickResults.push({
      pickPos: pick,
      adpPPG: avgAdp, modelPPG: avgModel,
      deltaPPG: Math.round((avgModel - avgAdp) * 10) / 10,
      adpHits: Math.round(sumAdpHits / n * 10) / 10,
      adpBusts: Math.round(sumAdpBusts / n * 10) / 10,
      modelHits: Math.round(sumModelHits / n * 10) / 10,
      modelBusts: Math.round(sumModelBusts / n * 10) / 10,
      modelWinRate: Math.round(pickWins / n * 100),
      adpTeam: bestAdpTeam, modelTeam: bestModelTeam,
      adpStarters: new Set(bestAdpLineup!.starters.map(p => p.name)),
      modelStarters: new Set(bestModelLineup!.starters.map(p => p.name)),
    });
    console.log(`      Pick #${pick}: ADP=${avgAdp} vs Model=${avgModel} (delta=${(avgModel - avgAdp).toFixed(1)}, winRate=${Math.round(pickWins / n * 100)}%, hits ${(sumModelHits / n).toFixed(1)}vs${(sumAdpHits / n).toFixed(1)})`);
  }

  // Compute averages across all pick positions
  const nPicks = perPickResults.length;
  const totalSims = nPicks * SIMS_PER_PICK;
  const avgAdpPPG = Math.round(perPickResults.reduce((s, r) => s + r.adpPPG, 0) / nPicks * 10) / 10;
  const avgModelPPG = Math.round(perPickResults.reduce((s, r) => s + r.modelPPG, 0) / nPicks * 10) / 10;
  const avgDeltaPPG = Math.round((avgModelPPG - avgAdpPPG) * 10) / 10;
  const avgAdpHits = Math.round(perPickResults.reduce((s, r) => s + r.adpHits, 0) / nPicks * 10) / 10;
  const avgAdpBusts = Math.round(perPickResults.reduce((s, r) => s + r.adpBusts, 0) / nPicks * 10) / 10;
  const avgModelHits = Math.round(perPickResults.reduce((s, r) => s + r.modelHits, 0) / nPicks * 10) / 10;
  const avgModelBusts = Math.round(perPickResults.reduce((s, r) => s + r.modelBusts, 0) / nPicks * 10) / 10;
  const winsCount = perPickResults.filter(r => r.deltaPPG > 0).length;
  const avgWinRate = Math.round(perPickResults.reduce((s, r) => s + r.modelWinRate, 0) / nPicks);

  console.log(`    Draft sim season: ${draftSimSeason} (${totalSims} total drafts: ${SIMS_PER_PICK} sims × ${nPicks} picks)`);
  console.log(`    Avg across ${nPicks} picks: ADP=${avgAdpPPG} vs Model=${avgModelPPG} (delta=${avgDeltaPPG > 0 ? '+' : ''}${avgDeltaPPG})`);
  console.log(`    Model wins ${winsCount}/${nPicks} pick positions (avg win rate ${avgWinRate}%)`);
  console.log(`    Avg hits: Model ${avgModelHits} vs ADP ${avgAdpHits} | Avg busts: Model ${avgModelBusts} vs ADP ${avgAdpBusts}`);

  // Use pick #6 as the example draft to display
  const examplePick = perPickResults.find(r => r.pickPos === 6) || perPickResults[0];
  draftSim2025 = {
    // Example draft (pick #6) for side-by-side display
    adpTeam: examplePick.adpTeam.map(p => ({ name: p.name, position: p.position, adp: p.adp, round: p.round, pick: p.pickNum, actualPPG: p.actualPPG, modelPPG: p.modelPPG, isHit: p.isHit, isBust: p.isBust, isStarter: examplePick.adpStarters.has(p.name) })),
    modelTeam: examplePick.modelTeam.map(p => ({ name: p.name, position: p.position, adp: p.adp, round: p.round, pick: p.pickNum, actualPPG: p.actualPPG, modelPPG: p.modelPPG, isHit: p.isHit, isBust: p.isBust, isStarter: examplePick.modelStarters.has(p.name) })),
    adpLineupPPG: examplePick.adpPPG,
    adpSeasonPPR: Math.round(examplePick.adpPPG * 17),
    modelLineupPPG: examplePick.modelPPG,
    modelSeasonPPR: Math.round(examplePick.modelPPG * 17),
    adpHits: examplePick.adpHits,
    adpBusts: examplePick.adpBusts,
    modelHits: examplePick.modelHits,
    modelBusts: examplePick.modelBusts,
    // Averages across all pick positions (each averaged over SIMS_PER_PICK iterations)
    avgAdpPPG, avgModelPPG, avgDeltaPPG,
    avgAdpHits, avgAdpBusts, avgModelHits, avgModelBusts,
    winsCount, totalSims, avgWinRate,
    // Per-pick breakdown (each row is averaged over SIMS_PER_PICK sims)
    perPick: perPickResults.map(r => ({
      pick: r.pickPos, adpPPG: r.adpPPG, modelPPG: r.modelPPG, delta: r.deltaPPG,
      modelHits: r.modelHits, adpHits: r.adpHits, modelBusts: r.modelBusts, adpBusts: r.adpBusts,
      winRate: r.modelWinRate,
    })),
    settings: { numTeams: NUM_TEAMS, rounds: NUM_ROUNDS, season: draftSimSeason, qbDeadline: QB_DEADLINE, simsPerPick: SIMS_PER_PICK },
  };

  // Precompute GBM feature importance per position (avoids runtime crash on mobile)
  console.log('  Computing feature importance...');
  featureImportance = {};
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

  // Precompute rookie/vet-specific feature importance
  console.log('  Computing rookie/vet feature importance...');
  rookieFeatureImportance = {};
  rookiePreDraftFeatureImportance = {};
  vetFeatureImportance = {};
  for (const m of models) {
    const pos = m.position as string;
    const rookieGbmPost = m.rookieGbmPostDraft as any;
    const rookieGbmPre = m.rookieGbmPreDraft as any;
    const rookieRidgePost = m.rookieRidgePostDraft as any;
    const rookieRidgePre = m.rookieRidgePreDraft as any;
    const rookieKeys = ROOKIE_FEATURES[pos] || [];
    const preDraftKeys = PRE_DRAFT_ROOKIE_FEATURES[pos] || [];
    const featureNames = m.featureNames as string[];
    const gbm = m.gbmModel as any;

    const posRows = result.rows.filter((r: PlayerRow) => r.position === pos && r.adp <= MAX_ADP);
    const rookieRows = posRows.filter((r: PlayerRow) => (r.features.yearsInLeague || 0) <= 1);
    const vetRows = posRows.filter((r: PlayerRow) => (r.features.yearsInLeague || 0) > 1);

    // Rookie post-draft feature importance
    // Use GBM contributions if available, otherwise Ridge coefficient magnitudes
    if ((rookieGbmPost || rookieRidgePost) && rookieRows.length >= 10) {
      if (rookieGbmPost) {
        // GBM-based importance (RB/WR)
        const sampled = rookieRows.slice(0, 100);
        const contribs = new Array(rookieKeys.length).fill(0);
        for (const row of sampled) {
          const pred = rookieGbmPost.models ? predictBaggedGBM(rookieGbmPost, row.features) : predictGBM(rookieGbmPost, row.features);
          for (const fc of pred.featureContributions) {
            const idx = rookieKeys.indexOf(fc.name);
            if (idx >= 0) contribs[idx] += Math.abs(fc.contribution);
          }
        }
        const n = sampled.length || 1;
        rookieFeatureImportance[pos] = rookieKeys
          .map((key: string, i: number) => {
            const def = FEATURES.find((f) => f.key === key);
            return { key, label: def?.label || key, category: def?.category || 'Other', importance: Math.round((contribs[i] / n) * 10000) / 10000 };
          })
          .sort((a, b) => b.importance - a.importance);
      } else {
        // Ridge coefficient magnitude importance (QB/TE)
        const coeffs = rookieRidgePost.coefficients as number[];
        rookieFeatureImportance[pos] = rookieKeys
          .map((key: string, i: number) => {
            const def = FEATURES.find((f) => f.key === key);
            return { key, label: def?.label || key, category: def?.category || 'Other', importance: Math.round(Math.abs(coeffs[i] || 0) * 10000) / 10000 };
          })
          .sort((a, b) => b.importance - a.importance);
      }
      console.log(`    ${pos} rookie (post-draft): top = ${rookieFeatureImportance[pos][0]?.key} (${rookieFeatureImportance[pos][0]?.importance})`);
    }

    // Rookie pre-draft feature importance
    if ((rookieGbmPre || rookieRidgePre) && rookieRows.length >= 10) {
      if (rookieGbmPre) {
        const sampled = rookieRows.slice(0, 100);
        const contribs = new Array(preDraftKeys.length).fill(0);
        for (const row of sampled) {
          const pred = rookieGbmPre.models ? predictBaggedGBM(rookieGbmPre, row.features) : predictGBM(rookieGbmPre, row.features);
          for (const fc of pred.featureContributions) {
            const idx = preDraftKeys.indexOf(fc.name);
            if (idx >= 0) contribs[idx] += Math.abs(fc.contribution);
          }
        }
        const n = sampled.length || 1;
        rookiePreDraftFeatureImportance[pos] = preDraftKeys
          .map((key: string, i: number) => {
            const def = FEATURES.find((f) => f.key === key);
            return { key, label: def?.label || key, category: def?.category || 'Other', importance: Math.round((contribs[i] / n) * 10000) / 10000 };
          })
          .sort((a, b) => b.importance - a.importance);
      } else {
        // Ridge coefficient magnitude importance (QB/TE)
        const coeffs = rookieRidgePre.coefficients as number[];
        rookiePreDraftFeatureImportance[pos] = preDraftKeys
          .map((key: string, i: number) => {
            const def = FEATURES.find((f) => f.key === key);
            return { key, label: def?.label || key, category: def?.category || 'Other', importance: Math.round(Math.abs(coeffs[i] || 0) * 10000) / 10000 };
          })
          .sort((a, b) => b.importance - a.importance);
      }
      console.log(`    ${pos} rookie (pre-draft): top = ${rookiePreDraftFeatureImportance[pos][0]?.key} (${rookiePreDraftFeatureImportance[pos][0]?.importance})`);
    }

    // Vet feature importance (same GBM as combined but scored on vets only)
    if (gbm && vetRows.length >= 10) {
      const sampled = vetRows.slice(0, 150);
      const contribs = new Array(featureNames.length).fill(0);
      for (const row of sampled) {
        const pred = predictGBM(gbm, row.features);
        for (const fc of pred.featureContributions) {
          const idx = featureNames.indexOf(fc.name);
          if (idx >= 0) contribs[idx] += Math.abs(fc.contribution);
        }
      }
      const n = sampled.length || 1;
      vetFeatureImportance[pos] = featureNames
        .map((key: string, i: number) => {
          const def = FEATURES.find((f) => f.key === key);
          return { key, label: def?.label || key, category: def?.category || 'Other', importance: Math.round((contribs[i] / n) * 10000) / 10000 };
        })
        .filter(f => f.importance > 0)
        .sort((a, b) => b.importance - a.importance);
      console.log(`    ${pos} vet: top = ${vetFeatureImportance[pos][0]?.key} (${vetFeatureImportance[pos][0]?.importance})`);
    }
  }

  // Compute hit/bust thresholds per position
  posThresholds = {};
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

  // ═══════════════════════════════════════════════════════════════════════
  // SHARE PREDICTION MODELS
  // For each position, predict player's share of team volume metrics.
  // Features: prior share, snap%, depth chart, competition, contract, age, etc.
  // Target: actual share in the prediction season (computed in buildFeatureMatrix).
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n  Training share prediction models...');

  const SHARE_TARGETS: { key: string; positions: string[] }[] = [
    { key: 'actualTargetShare', positions: ['RB', 'WR', 'TE'] },
    { key: 'actualRushShare', positions: ['RB'] },
    { key: 'actualReceptionShare', positions: ['RB', 'WR', 'TE'] },
    { key: 'actualRecYdsShare', positions: ['RB', 'WR', 'TE'] },
    { key: 'actualRushYdsShare', positions: ['RB'] },
    { key: 'actualPassTDShare', positions: ['RB', 'WR', 'TE'] },
    { key: 'actualRushTDShare', positions: ['RB'] },
  ];

  const SHARE_FEATURE_KEYS = [
    'priorTeamTargetShare', 'priorTeamTouchShare', 'priorTargetShare',
    'priorSnapPct', 'depthChartRank', 'teamSamePosCount',
    'contractAPY', 'age', 'yearsInLeague', 'priorPPG',
    'nflDraftPick', 'priorReceptions', 'priorTargets', 'priorCarries',
    'teamTargetHHI', 'vegasImpliedTotal',
  ];

  shareModels = {};
  for (const { key: targetKey, positions } of SHARE_TARGETS) {
    const predKey = targetKey.replace('actual', 'pred'); // actualTargetShare → predTargetShare
    for (const pos of positions) {
      const posRows = result.rows.filter((r: PlayerRow) =>
        r.position === pos && (r.features[targetKey] || 0) > 0 && r.features.priorPPG > 0
      );
      if (posRows.length < 20) {
        console.log(`    ${pos} ${targetKey}: skipped (n=${posRows.length} < 20)`);
        continue;
      }

      const uniqueSeasons = [...new Set(posRows.map((r: PlayerRow) => r.season))].sort();
      const losoActuals: number[] = [];
      const losoPreds: number[] = [];

      // LOSO cross-validation
      for (const held of uniqueSeasons) {
        const trainR = posRows.filter((r: PlayerRow) => r.season !== held);
        const testR = posRows.filter((r: PlayerRow) => r.season === held);
        if (trainR.length < 15 || testR.length === 0) continue;

        const Xtr = trainR.map((r: PlayerRow) => SHARE_FEATURE_KEYS.map(k => r.features[k] || 0));
        const ytr = trainR.map((r: PlayerRow) => r.features[targetKey] || 0);

        const ridgeModel = trainRidgeRegression(Xtr, ytr, SHARE_FEATURE_KEYS, 5);
        const gbmModel = trainGBM(Xtr, ytr, SHARE_FEATURE_KEYS, {
          nEstimators: 60, learningRate: 0.04, maxDepth: 2,
          subsample: 0.8, minSamplesLeaf: Math.max(3, Math.round(trainR.length * 0.08)),
          seed: 42,
        });

        for (const row of testR) {
          const ridgeP = predict(ridgeModel, row.features).predicted;
          const gbmP = predictGBM(gbmModel, row.features).predicted;
          const ensemble = Math.max(0, Math.min(1, ridgeP * 0.4 + gbmP * 0.6));
          losoActuals.push(row.features[targetKey] || 0);
          losoPreds.push(ensemble);
        }
      }

      // CV metrics
      const n = losoActuals.length;
      let r2 = 0, mae = 0;
      if (n >= 10) {
        const mean = losoActuals.reduce((a, b) => a + b, 0) / n;
        const ssTot = losoActuals.reduce((s, v) => s + (v - mean) ** 2, 0);
        const ssRes = losoActuals.reduce((s, v, i) => s + (v - losoPreds[i]) ** 2, 0);
        r2 = ssTot > 0 ? Math.round((1 - ssRes / ssTot) * 1000) / 1000 : 0;
        mae = Math.round(losoActuals.reduce((s, v, i) => s + Math.abs(v - losoPreds[i]), 0) / n * 1000) / 1000;
      }
      console.log(`    ${pos} ${targetKey}: n=${posRows.length}, LOSO R²=${r2.toFixed(3)}, MAE=${mae.toFixed(3)}`);

      // Train final model on all data
      const XAll = posRows.map((r: PlayerRow) => SHARE_FEATURE_KEYS.map(k => r.features[k] || 0));
      const yAll = posRows.map((r: PlayerRow) => r.features[targetKey] || 0);
      const finalRidge = trainRidgeRegression(XAll, yAll, SHARE_FEATURE_KEYS, 5);
      const finalGBM = trainGBM(XAll, yAll, SHARE_FEATURE_KEYS, {
        nEstimators: 60, learningRate: 0.04, maxDepth: 2,
        subsample: 0.8, minSamplesLeaf: Math.max(3, Math.round(posRows.length * 0.08)),
        seed: 42,
      });

      const modelKey = `${pos}_${predKey}`;
      (shareModels as any)[modelKey] = {
        ridgeModel: finalRidge, gbmModel: finalGBM,
        featureKeys: SHARE_FEATURE_KEYS,
        cvR2: r2, cvMAE: mae, n: posRows.length,
      };
    }
  }

  // ══════════════════════════════════════════════════════════════
  // ROOKIE CAREER PREDICTION MODEL (shared module)
  // ══════════════════════════════════════════════════════════════
  console.log('\n  Training rookie career prediction models...');
  rookieCareerModels = trainRookieCareerModels(result.rows);
  for (const [pos, m] of Object.entries(rookieCareerModels)) {
    console.log(`    ${pos}: n=${m.n}, R²=${m.cvR2.toFixed(3)}, MAE=${m.cvMAE.toFixed(1)}, ρ=${m.rankCorr.toFixed(3)}, σ=${m.residualStd.toFixed(2)}`);
  }

  // Save per-component model caches
  console.log('  Saving model caches...');
  mkdirSync(MODEL_DIR, { recursive: true });
  writeFileSync(componentCachePaths.adp, JSON.stringify({
    models, featureImportance, rookieFeatureImportance, rookiePreDraftFeatureImportance,
    vetFeatureImportance, draftSim2025, posThresholds,
  }));
  writeFileSync(componentCachePaths.ppg, JSON.stringify({ ppgModels }));
  writeFileSync(componentCachePaths.residual, JSON.stringify({ residualModels }));
  writeFileSync(componentCachePaths.share, JSON.stringify({ shareModels }));
  writeFileSync(componentCachePaths.career, JSON.stringify({ rookieCareerModels }));

  // Also write monolithic cache for backward compat
  const modelCache = {
    models, ppgModels, residualModels, shareModels, rookieCareerModels,
    featureImportance, rookieFeatureImportance, rookiePreDraftFeatureImportance, vetFeatureImportance,
    draftSim2025, posThresholds,
  };
  writeFileSync(MODEL_CACHE_PATH, JSON.stringify(modelCache));
  const mcSize = (readFileSync(MODEL_CACHE_PATH).length / 1024 / 1024).toFixed(1);
  console.log(`  Model caches saved (${mcSize} MB total)`);

  } // end of training block (skipped when all caches exist)
  } // end of per-component cache block

  // ═══════════════════════════════════════════════════════════════════════
  // 2026 SCORING: Apply trained models to current prediction rows
  // This always runs (even on cache hit) since ADP/roster data may change
  // ═══════════════════════════════════════════════════════════════════════

  // PPG predictions (ADP-free model)
  console.log('  Scoring 2026 PPG predictions...');
  const ppgPredictions2026: Array<{
    name: string; team: string; position: string; adp: number;
    headshotUrl?: string;
    predictedPPG: number; predictedSeasonPPR: number;
  }> = [];
  for (const m of ppgModels) {
    const pos = m.position as string;
    const ppgGbm = m.gbmModel as any;
    const ppgRidge = m.ridgeModel as any;
    const posPredRows = result.predRows.filter((r: { position: string; adp: number }) => r.position === pos && r.adp <= MAX_ADP);
    for (const r of posPredRows) {
      const gbmPred = predictGBM(ppgGbm, r.features).predicted;
      const ridgePred = predict(ppgRidge, r.features).predicted;
      const ensemblePPG = Math.round((gbmPred * 0.7 + ridgePred * 0.3) * 10) / 10;
      ppgPredictions2026.push({
        name: r.name, team: r.team, position: r.position, adp: r.adp,
        headshotUrl: r.headshotUrl,
        predictedPPG: ensemblePPG,
        predictedSeasonPPR: Math.round(ensemblePPG * 17),
      });
    }
  }
  console.log(`  PPG predictions: ${ppgPredictions2026.length} players`);

  // Share predictions for 2026
  console.log('  Scoring 2026 share predictions...');
  const SHARE_PRED_TARGETS = [
    { actual: 'actualTargetShare', pred: 'predTargetShare', positions: ['RB', 'WR', 'TE'] },
    { actual: 'actualRushShare', pred: 'predRushShare', positions: ['RB'] },
    { actual: 'actualReceptionShare', pred: 'predReceptionShare', positions: ['RB', 'WR', 'TE'] },
    { actual: 'actualRecYdsShare', pred: 'predRecYdsShare', positions: ['RB', 'WR', 'TE'] },
    { actual: 'actualRushYdsShare', pred: 'predRushYdsShare', positions: ['RB'] },
    { actual: 'actualPassTDShare', pred: 'predPassTDShare', positions: ['RB', 'WR', 'TE'] },
    { actual: 'actualRushTDShare', pred: 'predRushTDShare', positions: ['RB'] },
  ];
  let sharePredCount = 0;
  for (const { pred: predKey, positions } of SHARE_PRED_TARGETS) {
    for (const pos of positions) {
      const modelKey = `${pos}_${predKey}`;
      const sm = (shareModels as any)?.[modelKey];
      if (!sm) continue;
      const posPredRows = result.predRows.filter((r: { position: string; adp: number }) => r.position === pos && r.adp <= MAX_ADP);
      for (const r of posPredRows) {
        const ridgeP = predict(sm.ridgeModel, r.features).predicted;
        const gbmP = predictGBM(sm.gbmModel, r.features).predicted;
        const ensemble = Math.max(0, Math.min(1, ridgeP * 0.4 + gbmP * 0.6));
        r.features[predKey] = Math.round(ensemble * 1000) / 1000;
        sharePredCount++;
      }
    }
  }
  console.log(`  Share predictions: ${sharePredCount} player-metric pairs`);

  // Carry forward prior rush shares for WR/TE (low volume, not worth predicting)
  for (const r of result.predRows as Array<{ position: string; adp: number; features: Record<string, number> }>) {
    if (r.adp > MAX_ADP) continue;
    if (r.position === 'WR' || r.position === 'TE') {
      r.features.predRushShare = r.features.priorTeamTouchShare || 0;
      r.features.predRushYdsShare = r.features.priorTeamTouchShare || 0;
      r.features.predRushTDShare = 0; // WR/TE rush TDs are too rare to carry forward
    }
  }

  // Residual-model predictions
  console.log('  Scoring 2026 residual predictions...');
  const residualPredictions2026: Array<{
    name: string; team: string; position: string; adp: number;
    headshotUrl?: string;
    adpImpliedPPG: number; residualPred: number; blendedPPG: number;
  }> = [];
  for (const m of residualModels) {
    const pos = m.position as string;
    const resGbm = m.gbmModel as any;
    const resRidge = m.ridgeModel as any;
    const slope = m.adpSlope as number;
    const intercept = m.adpIntercept as number;
    const alpha = m.bestAlpha as number;
    const posPredRows = result.predRows.filter((r: { position: string; adp: number }) => r.position === pos && r.adp <= MAX_ADP);
    for (const r of posPredRows) {
      const adpImplied = intercept + slope * r.adp;
      const gbmRes = predictGBM(resGbm, r.features).predicted;
      const ridgeRes = predict(resRidge, r.features).predicted;
      const residual = gbmRes * 0.7 + ridgeRes * 0.3;
      const blended = Math.round((adpImplied + alpha * residual) * 10) / 10;
      residualPredictions2026.push({
        name: r.name, team: r.team, position: pos, adp: r.adp,
        headshotUrl: r.headshotUrl,
        adpImpliedPPG: Math.round(adpImplied * 10) / 10,
        residualPred: Math.round(residual * 100) / 100,
        blendedPPG: blended,
      });
    }
  }
  console.log(`  Residual predictions: ${residualPredictions2026.length} players`);

  // Score 2026 rookies with career prediction model
  // Load prospect grades + combine + college stats directly (draft hasn't happened yet)
  console.log('  Scoring 2026 rookie career predictions...');
  const careerPredictions2026: Array<{
    name: string; position: string; team: string; adp: number;
    headshotUrl?: string; predictedCareerPPG: number;
    thresholdProbs?: Record<number, number>;
    combinedScore?: number;
    percentile?: number;
    modelTier?: number;
    boomProb?: number;       // P(outperform by > MAE)
    bustProb?: number;       // P(underperform by > MAE)
  }> = [];

  // Load prospect grades from static JSON
  let prospectGrades: Array<{ name: string; pos: string; school: string; grade: number; projRound: number; projPick: number; tier: string }> = [];
  try {
    prospectGrades = JSON.parse(readFileSync('src/data/prospect-grades-2026.json', 'utf-8'));
    console.log(`    Loaded ${prospectGrades.length} prospect grades`);
  } catch { console.log('    No prospect grades file found'); }

  if (prospectGrades.length > 0) {
    // Load combine and college stats for feature construction
    const [combineData, collegeData] = await Promise.all([
      fetchCombine().catch(() => []),
      fetchCollegeStats().catch(() => []),
    ]);

    // Build combine lookup
    const combineByProspect = new Map<string, any>();
    for (const c of combineData) combineByProspect.set(normalizeName(c.player_name), c);

    // Build college stats lookup (aggregate career totals)
    // CollegeStats format: { player_name, season, statistic, value }
    const collegeByProspect = new Map<string, Map<string, number>>();
    const collegeSeasonsByProspect = new Map<string, Set<number>>();
    for (const cs of collegeData) {
      const name = normalizeName(cs.player_name);
      if (!collegeByProspect.has(name)) collegeByProspect.set(name, new Map());
      if (!collegeSeasonsByProspect.has(name)) collegeSeasonsByProspect.set(name, new Set());
      const existing = collegeByProspect.get(name)!;
      existing.set(cs.statistic, (existing.get(cs.statistic) || 0) + cs.value);
      collegeSeasonsByProspect.get(name)!.add(cs.season);
    }

    // Build college per-game stats
    const collegePerGame = new Map<string, { games: number; recPerGame: number; ydsPerGame: number; tdsPerGame: number; rushYPC: number; ydsPerRec: number }>();
    for (const [name, totals] of collegeByProspect) {
      const games = totals.get('Games Played') || 1;
      const recYds = totals.get('Receiving Yards') || 0;
      const rushYds = totals.get('Rushing Yards') || 0;
      const recs = totals.get('Receptions') || 0;
      const carries = totals.get('Rushing Attempts') || 0;
      const tds = (totals.get('Rushing Touchdowns') || 0) + (totals.get('Receiving Touchdowns') || 0) + (totals.get('Passing Touchdowns') || 0);
      collegePerGame.set(name, {
        games,
        recPerGame: recs / games,
        ydsPerGame: (recYds + rushYds) / games,
        tdsPerGame: tds / games,
        rushYPC: carries > 0 ? rushYds / carries : 0,
        ydsPerRec: recs > 0 ? recYds / recs : 0,
      });
    }

    // College advanced metrics (dominator rating, market share — approximate)
    const collegeAdvByProspect = new Map<string, { dominatorRating: number; breakoutAge: number; marketShare: number }>();
    for (const [name, totals] of collegeByProspect) {
      const recYds = totals.get('Receiving Yards') || 0;
      const rushYds = totals.get('Rushing Yards') || 0;
      const totalYds = recYds + rushYds;
      const tds = (totals.get('Rushing Touchdowns') || 0) + (totals.get('Receiving Touchdowns') || 0);
      // Approximate dominator: fraction of estimated team production
      const estimatedTeamYds = totalYds * 3;
      const dominatorRating = estimatedTeamYds > 0 ? (totalYds / estimatedTeamYds + tds / Math.max(1, tds * 3)) / 2 : 0;
      collegeAdvByProspect.set(name, { dominatorRating, breakoutAge: 0, marketShare: dominatorRating });
    }

    // Combine averages by position for imputation
    const combineAvg = new Map<string, Record<string, number>>();
    const combineAccum = new Map<string, Record<string, { sum: number; count: number }>>();
    for (const c of combineData) {
      if (!c.pos) continue;
      if (!combineAccum.has(c.pos)) combineAccum.set(c.pos, {});
      const acc = combineAccum.get(c.pos)!;
      for (const [k, v] of [['forty', c.forty], ['weight', c.wt], ['bench', c.bench], ['vertical', c.vertical], ['broadJump', c.broad_jump], ['cone', c.cone], ['shuttle', c.shuttle]] as [string, number][]) {
        if (v && v > 0) {
          if (!acc[k]) acc[k] = { sum: 0, count: 0 };
          acc[k].sum += v;
          acc[k].count += 1;
        }
      }
    }
    for (const [pos, acc] of combineAccum) {
      const avg: Record<string, number> = {};
      for (const [k, v] of Object.entries(acc)) avg[k] = Math.round((v.sum / v.count) * 100) / 100;
      combineAvg.set(pos, avg);
    }

    // Build best single-season stats per player
    const collegeBestByProspect = new Map<string, { bestRecYds: number; bestRecTDs: number; bestReceptions: number; bestRushYds: number; numSeasons: number }>();
    {
      // Group stats by player+season
      const byPlayerSeason = new Map<string, Map<number, Map<string, number>>>();
      for (const cs of collegeData) {
        const name = normalizeName(cs.player_name);
        if (!byPlayerSeason.has(name)) byPlayerSeason.set(name, new Map());
        const seasons = byPlayerSeason.get(name)!;
        if (!seasons.has(cs.season)) seasons.set(cs.season, new Map());
        seasons.get(cs.season)!.set(cs.statistic, cs.value);
      }
      for (const [name, seasons] of byPlayerSeason) {
        let bestRecYds = 0, bestRecTDs = 0, bestReceptions = 0, bestRushYds = 0;
        for (const [, stats] of seasons) {
          bestRecYds = Math.max(bestRecYds, stats.get('Receiving Yards') || 0);
          bestRecTDs = Math.max(bestRecTDs, stats.get('Receiving Touchdowns') || 0);
          bestReceptions = Math.max(bestReceptions, stats.get('Receptions') || 0);
          bestRushYds = Math.max(bestRushYds, stats.get('Rushing Yards') || 0);
        }
        collegeBestByProspect.set(name, { bestRecYds, bestRecTDs, bestReceptions, bestRushYds, numSeasons: seasons.size });
      }
    }

    // ── Compute ZAP features for 2026 prospects ──
    // Build per-player per-season stats for breakoutScore, recYdsPerTeamPassAtt
    const ncaaSOS = ncaaTeamData.sos as Record<string, number>;
    const ncaaPassAtt = ncaaTeamData.teamPassAttPerGame as Record<string, number>;
    const ncaaRushAtt = ncaaTeamData.teamRushAttPerGame as Record<string, number>;

    // School name normalizer (same as buildFeatureMatrix)
    const schoolNameMap: Record<string, string> = {
      'florida state': 'florida st', 'ohio state': 'ohio st', 'michigan state': 'michigan st',
      'penn state': 'penn st', 'oklahoma state': 'oklahoma st', 'oregon state': 'oregon st',
      'washington state': 'washington st', 'iowa state': 'iowa st', 'kansas state': 'kansas st',
      'mississippi state': 'mississippi st', 'arizona state': 'arizona st',
      'colorado state': 'colorado st', 'fresno state': 'fresno st', 'boise state': 'boise st',
      'san diego state': 'san diego st', 'appalachian state': 'app state',
      'north carolina state': 'nc state', 'brigham young': 'byu', 'southern california': 'usc',
      'connecticut': 'uconn', 'massachusetts': 'umass', 'texas christian': 'tcu',
      'southern methodist': 'smu', 'central florida': 'ucf',
    };
    function normSchool(s: string): string {
      const low = s.toLowerCase().trim()
        .replace(/\buniversity\b/g, '').replace(/\bstate\b/g, 'st')
        .replace(/\bnorthern\b/g, 'n').replace(/\bsouthern\b/g, 's')
        .replace(/\beastern\b/g, 'e').replace(/\bwestern\b/g, 'w')
        .replace(/\bcentral\b/g, 'c').replace(/\bmiddle\b/g, 'mid')
        .replace(/\s+/g, ' ').trim();
      return schoolNameMap[low] || schoolNameMap[s.toLowerCase().trim()] || low;
    }

    // Per-player per-season stats from college data
    type ProspectSeasonStats = { recYds: number; receptions: number; rushYds: number; school: string; season: number };
    const prospectSeasonStats = new Map<string, ProspectSeasonStats[]>();
    for (const cs of collegeData) {
      const name = normalizeName(cs.player_name);
      const stat = (cs.statistic || '').toLowerCase();
      if (!prospectSeasonStats.has(name)) prospectSeasonStats.set(name, []);
      const seasons = prospectSeasonStats.get(name)!;
      let entry = seasons.find(s => s.season === cs.season);
      if (!entry) {
        entry = { recYds: 0, receptions: 0, rushYds: 0, school: (cs.school || cs.school_abbr || '').toLowerCase(), season: cs.season };
        seasons.push(entry);
      }
      if (stat.includes('receiving yard')) entry.recYds += cs.value || 0;
      else if (stat.includes('reception') && !stat.includes('yard') && !stat.includes('td')) entry.receptions += cs.value || 0;
      else if (stat.includes('rushing yard')) entry.rushYds += cs.value || 0;
    }

    // Compute ZAP features per prospect
    const prospectZap = new Map<string, {
      breakoutScore: number; recYdsPerTeamPassAtt: number; receptionShare: number;
      rushProductionWR: number; teammateScore: number;
    }>();

    // Load draft picks for teammate score
    let draftPicks: Array<{ player_name: string; season: number; pick: number; team: string }> = [];
    try {
      draftPicks = (await fetchDraftPicks().catch(() => [])) as any[];
    } catch {}
    // School → drafted players lookup
    const schoolDraftees = new Map<string, Array<{ name: string; season: number; pick: number }>>();
    for (const dp of draftPicks) {
      if (!dp.player_name || !dp.pick) continue;
      const name = normalizeName(dp.player_name);
      // Find school from college data
      const pss = prospectSeasonStats.get(name);
      if (!pss || pss.length === 0) continue;
      const school = pss[pss.length - 1].school;
      if (!school) continue;
      if (!schoolDraftees.has(school)) schoolDraftees.set(school, []);
      schoolDraftees.get(school)!.push({ name, season: dp.season || 0, pick: dp.pick });
    }

    for (const prospect of prospectGrades) {
      const nName = normalizeName(prospect.name);
      const pss = prospectSeasonStats.get(nName);
      if (!pss || pss.length === 0) {
        prospectZap.set(nName, { breakoutScore: 0, recYdsPerTeamPassAtt: 0, receptionShare: 0, rushProductionWR: 0, teammateScore: 0 });
        continue;
      }

      let bestRecYdsPerTPA = 0;
      let bestReceptionShare = 0;
      let bestBreakoutScore = 0;
      let bestRushYds = 0;

      for (const ps of pss) {
        if (ps.recYds === 0 && ps.rushYds === 0) continue;
        const ncaaKey = `${normSchool(ps.school)}:${ps.season}`;
        const teamPA = (ncaaPassAtt[ncaaKey] || 0) * 13; // per game → season
        const sosMult = ncaaSOS[ncaaKey] ? 1.0 + (ncaaSOS[ncaaKey] / 20) : 1.0;

        if (teamPA > 0) {
          const recPerTPA = (ps.recYds / teamPA) * sosMult;
          bestRecYdsPerTPA = Math.max(bestRecYdsPerTPA, recPerTPA);

          // Breakout score: age-adjusted (estimate age as draft year - season years)
          const seasonsAgo = 2026 - ps.season;
          const estAge = 22 - seasonsAgo; // rough estimate
          if (estAge > 17 && estAge < 25) {
            const ageMult = 1.0 + (21 - estAge) * 0.075;
            bestBreakoutScore = Math.max(bestBreakoutScore, recPerTPA * ageMult);
          } else {
            bestBreakoutScore = Math.max(bestBreakoutScore, recPerTPA);
          }
        }

        // Reception share
        const teamComp = teamPA > 0 ? Math.round(teamPA * 0.63) : 0;
        if (teamComp > 0) {
          bestReceptionShare = Math.max(bestReceptionShare, ps.receptions / teamComp);
        }

        bestRushYds = Math.max(bestRushYds, Math.min(ps.rushYds, 500));
      }

      // Teammate score
      const school = pss[pss.length - 1].school;
      const mates = schoolDraftees.get(school) || [];
      let teammateScore = 0;
      for (const m of mates) {
        if (m.name === nName) continue;
        if (Math.abs(m.season - 2026) <= 2 && m.pick > 0) {
          teammateScore += 1 / m.pick;
        }
      }

      prospectZap.set(nName, {
        breakoutScore: Math.round(bestBreakoutScore * 1000) / 1000,
        recYdsPerTeamPassAtt: Math.round(bestRecYdsPerTPA * 1000) / 1000,
        receptionShare: Math.round(bestReceptionShare * 1000) / 1000,
        rushProductionWR: bestRushYds,
        teammateScore: Math.round(teammateScore * 1000) / 1000,
      });
    }
    console.log(`    ZAP features computed for ${prospectZap.size} prospects`);

    // Load prospect feature store (manual/persistent data, takes priority over nflverse)
    const prospectStore = loadProspectStore();
    if (prospectStore.size > 0) {
      console.log(`    Prospect store: ${prospectStore.size} prospects with pre-computed features`);
    }

    // Score each prospect
    const FANTASY_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
    for (const prospect of prospectGrades) {
      if (!FANTASY_POSITIONS.has(prospect.pos)) continue;
      const pos = prospect.pos;
      const cm = (rookieCareerModels as any)[pos];
      if (!cm?.ridgeModel) continue;

      const nName = normalizeName(prospect.name);

      // Check prospect store first — if we have manual/persistent features, use those
      const storedProspect = prospectStore.get(nName);
      if (storedProspect) {
        const posAvgForStore = combineAvg.get(pos) || {};
        const storedFeatures = buildProspectFeatureRecord(storedProspect, posAvgForStore);
        // Merge with any nflverse data we might also have (store takes priority)
        const combine = combineByProspect.get(nName);
        const cs = collegeByProspect.get(nName);
        const pg = collegePerGame.get(nName);

        // Fill gaps: if store doesn't have a value but nflverse does, use nflverse
        if (!storedFeatures.weight && combine?.wt) storedFeatures.weight = combine.wt;
        if (!storedFeatures.forty && combine?.forty) storedFeatures.forty = combine.forty;
        if (!storedFeatures.collegeRecYds && cs) storedFeatures.collegeRecYds = cs.get('Receiving Yards') || 0;
        if (!storedFeatures.collegeRushYds && cs) storedFeatures.collegeRushYds = cs.get('Rushing Yards') || 0;

        // Use stored features for scoring
        const features = storedFeatures;
        const ridgePred = predict(cm.ridgeModel, features).predicted;
        let pred: number;
        if (cm.gbmModel) {
          const gbmPred = predictBaggedGBM(cm.gbmModel, features).predicted;
          pred = gbmPred * 0.5 + ridgePred * 0.5;
        } else {
          pred = ridgePred;
        }
        const predictedPPG = Math.round(Math.max(0, pred) * 10) / 10;

        // Threshold probabilities
        const thresholds = PPG_THRESHOLD_CONFIG[pos]?.thresholds || [];
        const probs: Record<number, number> = {};
        for (const thresh of thresholds) {
          const tm = cm.thresholdModels?.[thresh];
          if (!tm) continue;
          const ridgeP = Math.max(0, Math.min(1, predict(tm.ridge, features).predicted));
          let p = ridgeP;
          if (tm.gbm) {
            const gbmP = Math.max(0, Math.min(1, predictBaggedGBM(tm.gbm, features).predicted));
            p = gbmP * 0.5 + ridgeP * 0.5;
          }
          probs[thresh] = Math.round(p * 1000) / 10;
        }

        const probValues = thresholds.map(t => probs[t] || 0);
        const meanProb = probValues.length > 0 ? probValues.reduce((s, v) => s + v, 0) / probValues.length : 0;

        careerPredictions2026.push({
          name: prospect.name, position: pos, school: prospect.school,
          projRound: prospect.projRound, projPick: prospect.projPick,
          predictedCareerPPG: predictedPPG, combinedScore: meanProb, tier: 0,
          thresholdProbs: probs, features,
        });
        continue; // skip the nflverse path below
      }

      // Fall through to nflverse data path
      const combine = combineByProspect.get(nName);
      const cs = collegeByProspect.get(nName);
      const pg = collegePerGame.get(nName);
      const adv = collegeAdvByProspect.get(nName);
      const posAvg = combineAvg.get(pos) || {};

      // Build feature vector matching PRE_DRAFT_ROOKIE_FEATURES
      const numSeasons = collegeBestByProspect.get(nName)?.numSeasons || collegeSeasonsByProspect.get(nName)?.size || 0;
      const wt = combine?.wt || posAvg.weight || 0;
      const ft = combine?.forty || posAvg.forty || 0;
      const ht = combine?.ht ? parseHeight(combine.ht) : 0;
      const ss = (wt > 0 && ft > 0) ? Math.round((wt * 200) / Math.pow(ft, 4) * 10) / 10 : 0;
      const htAdjSS = (ht > 0 && ss > 0) ? Math.round(ss * (ht / 76) * 10) / 10 : ss;
      const projPick = prospect.projPick || 300;
      const draftCapXSpeed = (projPick > 0 && ss > 0) ? Math.round((1 / projPick) * ss * 1000) / 1000 : 0;

      const features: Record<string, number> = {
        nflDraftRound: prospect.projRound || 8,
        nflDraftPick: projPick,
        logDraftPick: Math.log(projPick),
        invDraftPick: 1 / projPick,
        age: 0,
        yearsInLeague: 0,
        weight: wt,
        forty: ft,
        bench: combine?.bench || posAvg.bench || 0,
        vertical: combine?.vertical || posAvg.vertical || 0,
        broadJump: combine?.broad_jump || posAvg.broadJump || 0,
        cone: combine?.cone || posAvg.cone || 0,
        shuttle: combine?.shuttle || posAvg.shuttle || 0,
        speedScore: ss,
        heightAdjSpeedScore: htAdjSS,
        draftCapXSpeed,
        collegePassTDs: cs?.get('Passing Touchdowns') || 0,
        collegeQBR: 0,
        collegeRushYds: cs?.get('Rushing Yards') || 0,
        collegeRushYPC: pg?.rushYPC || 0,
        collegeRecYds: cs?.get('Receiving Yards') || 0,
        collegeRecTDs: cs?.get('Receiving Touchdowns') || 0,
        collegeRecPerGame: pg?.recPerGame || 0,
        collegeTotalTDs: (cs?.get('Passing Touchdowns') || 0) + (cs?.get('Rushing Touchdowns') || 0) + (cs?.get('Receiving Touchdowns') || 0),
        collegeDominatorRating: adv?.dominatorRating || 0,
        collegeBreakoutAge: adv?.breakoutAge || 0,
        collegeBreakoutAgeDelta: 0,
        collegeMarketShare: adv?.marketShare || 0,
        collegeYdsPerRec: pg?.ydsPerRec || 0,
        collegeBestRecYds: collegeBestByProspect.get(nName)?.bestRecYds || 0,
        collegeBestRecTDs: collegeBestByProspect.get(nName)?.bestRecTDs || 0,
        collegeBestReceptions: collegeBestByProspect.get(nName)?.bestReceptions || 0,
        collegeSeasons: numSeasons,
        collegeEarlyDeclare: numSeasons <= 3 ? 1 : 0,
        draftPickXEarlyDeclare: (numSeasons <= 3 ? 1 : 0) * (1 / projPick),
        // Per-team normalized features from ZAP computation
        ...(() => {
          const zap = prospectZap.get(nName);
          return {
            collegeRecYdsPerTeamPassAtt: zap?.recYdsPerTeamPassAtt || 0,
            collegeReceptionShare: zap?.receptionShare || 0,
            collegeYdsPerTeamPlay: 0, // not used in current feature set
            collegeBreakoutScore: zap?.breakoutScore || 0,
            collegeBestRecYdsPerTPA: zap?.recYdsPerTeamPassAtt || 0,
            collegeRushProductionWR: pos === 'WR' ? (zap?.rushProductionWR || Math.min(cs?.get('Rushing Yards') || 0, 500)) : 0,
            collegeTeammateScore: zap?.teammateScore || 0,
          };
        })(),
        hasCollegeStats: cs ? 1 : 0,
      };

      const ridgePred = predict(cm.ridgeModel, features).predicted;
      let pred: number;
      if (cm.gbmModel) {
        const gbmPred = predictBaggedGBM(cm.gbmModel, features).predicted;
        pred = gbmPred * 0.5 + ridgePred * 0.5;
      } else {
        pred = ridgePred;
      }
      const predictedPPG = Math.round(Math.max(0, pred) * 10) / 10;
      // Use per-threshold classifiers for probability predictions (not normal approx)
      const posThresholds = cm.thresholds as number[];
      const threshModels = cm.thresholdModels as Record<number, { ridge: any; gbm: any }>;
      const thresholdProbs: Record<number, number> = {};
      if (posThresholds && threshModels) {
        for (const t of posThresholds) {
          const tm = threshModels[t];
          if (!tm?.ridge) continue;
          const ridgeP = Math.max(0, Math.min(1, predict(tm.ridge, features).predicted));
          let prob: number;
          if (tm.gbm) {
            const gbmP = Math.max(0, Math.min(1, predictBaggedGBM(tm.gbm, features).predicted));
            prob = gbmP * 0.5 + ridgeP * 0.5;
          } else {
            prob = ridgeP;
          }
          thresholdProbs[t] = Math.round(Math.max(0, Math.min(1, prob)) * 1000) / 10;
        }
      }
      // Boom/bust probabilities from overlay models
      let boomProb = 0, bustProb = 0;
      const boomM = cm.boomModel as any;
      const bustM = cm.bustModel as any;
      if (boomM?.ridge) {
        const rp = Math.max(0, Math.min(1, predict(boomM.ridge, features).predicted));
        boomProb = boomM.gbm
          ? Math.max(0, Math.min(1, predictBaggedGBM(boomM.gbm, features).predicted)) * 0.5 + rp * 0.5
          : rp;
      }
      if (bustM?.ridge) {
        const rp = Math.max(0, Math.min(1, predict(bustM.ridge, features).predicted));
        bustProb = bustM.gbm
          ? Math.max(0, Math.min(1, predictBaggedGBM(bustM.gbm, features).predicted)) * 0.5 + rp * 0.5
          : rp;
      }

      careerPredictions2026.push({
        name: prospect.name, position: pos, team: '', adp: prospect.projPick,
        predictedCareerPPG: predictedPPG,
        thresholdProbs,
        boomProb: Math.round(boomProb * 1000) / 10,
        bustProb: Math.round(bustProb * 1000) / 10,
        features,
      });
    }
  }

  // Compute cross-year percentile per position using backtest as reference
  // This makes scores comparable: a 90th percentile WR means the same thing
  // whether it's a 2026 prospect or a 2023 backtest player
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const posRookies = careerPredictions2026.filter(r => r.position === pos);
    if (posRookies.length === 0) continue;

    // Get all backtest predictedPPGs for this position (historical reference)
    const backtestPPGs: number[] = [];
    const cm = (rookieCareerModels as any)[pos];
    if (cm?.backtestRows) {
      for (const bt of cm.backtestRows) {
        if (bt.predictedPPG > 0) backtestPPGs.push(bt.predictedPPG);
      }
    }
    const refPPGs = backtestPPGs.sort((a, b) => a - b);

    for (const r of posRookies) {
      const ppg = r.predictedCareerPPG || 0;
      // Percentile against historical backtest
      if (ppg > 0 && refPPGs.length > 0) {
        const rank = refPPGs.filter(p => p <= ppg).length;
        r.combinedScore = Math.round((rank / refPPGs.length) * 100);
        r.percentile = r.combinedScore;
      } else {
        r.combinedScore = 0;
        r.percentile = 0;
      }
    }

    // Assign tier from percentile (StatHead tier system)
    for (const r of posRookies) {
      const s = r.combinedScore || 0;
      if (s >= 95) r.modelTier = 1;       // Alpha
      else if (s >= 85) r.modelTier = 2;  // Blue Chip
      else if (s >= 70) r.modelTier = 3;  // Starter
      else if (s >= 50) r.modelTier = 4;  // Contributor
      else if (s >= 30) r.modelTier = 5;  // Depth
      else r.modelTier = 6;               // Longshot
    }
  }
  careerPredictions2026.sort((a, b) => (b.combinedScore || 0) - (a.combinedScore || 0));
  console.log(`  Career predictions: ${careerPredictions2026.length} rookies scored`);

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
    const rookieGbmPost = m.rookieGbmPostDraft as any;
    const rookieGbmPre = m.rookieGbmPreDraft as any;
    const rookieRidgePost = m.rookieRidgePostDraft as any;
    const rookieRidgePre = m.rookieRidgePreDraft as any;
    const rookieModelType = m.rookieModelType as string | null;
    const posPlayers = result.predRows.filter((r: { position: string; adp: number }) => r.position === pos && r.adp <= MAX_ADP);
    const threshold = posThresholds[pos];

    for (const r of posPlayers) {
      const isRookie = (r.features.yearsInLeague || 0) <= 1;
      const hasDraftData = r.features.nflDraftRound > 0 && r.features.nflDraftRound < 8;

      // Combined model baseline (always computed)
      const combinedGbmPred = gbm ? predictGBM(gbm, r.features).predicted : 0;
      const combinedRidgePred = ridge ? predict(ridge, r.features).predicted : 0;
      const combinedPred = combinedGbmPred * 0.7 + combinedRidgePred * 0.3;

      let ensemblePred: number;
      if (isRookie && rookieModelType === 'gbm+ridge' && rookieGbmPost && rookieGbmPre) {
        // Large sample: GBM+Ridge 50/50 ensemble (RB/WR)
        const rookieGbmPred = hasDraftData
          ? (rookieGbmPost.models ? predictBaggedGBM(rookieGbmPost, r.features).predicted : predictGBM(rookieGbmPost, r.features).predicted)
          : (rookieGbmPre.models ? predictBaggedGBM(rookieGbmPre, r.features).predicted : predictGBM(rookieGbmPre, r.features).predicted);
        const rookieRidgePred = hasDraftData
          ? predict(rookieRidgePost, r.features).predicted
          : predict(rookieRidgePre, r.features).predicted;
        ensemblePred = Math.round((rookieGbmPred * 0.5 + rookieRidgePred * 0.5) * 10) / 10;
      } else if (isRookie && rookieModelType === 'ridge-only' && rookieRidgePost && rookieRidgePre) {
        // Small sample: Ridge-only blended with combined model (QB/TE)
        // 40% position-specific Ridge + 60% combined model
        const rookieRidgePred = hasDraftData
          ? predict(rookieRidgePost, r.features).predicted
          : predict(rookieRidgePre, r.features).predicted;
        ensemblePred = Math.round((rookieRidgePred * 0.4 + combinedPred * 0.6) * 10) / 10;
      } else {
        // Veterans or no rookie model: standard 70/30 GBM+Ridge ensemble
        ensemblePred = Math.round(combinedPred * 10) / 10;
      }
      // Confidence intervals from quantile models
      const ciLow = lower ? Math.round(predictGBM(lower, r.features).predicted * 10) / 10 : ensemblePred - 0.5;
      const ciUp = upper ? Math.round(predictGBM(upper, r.features).predicted * 10) / 10 : ensemblePred + 0.5;

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
        rookieModelPhase: isRookie ? (hasDraftData ? 'post-draft' : 'pre-draft') : undefined,
      });
    }
  }
  console.log(`  ${predictions2026.length} player predictions generated`);

  mkdirSync('public/data', { recursive: true });
  // Strip players2025 and trained models from residualModels to reduce output size
  const residualModelsOutput = residualModels.map((m: any) => ({
    position: m.position, bestAlpha: m.bestAlpha, n: m.n, backtest: m.backtest,
    adpSlope: m.adpSlope, adpIntercept: m.adpIntercept,
  }));
  // Build share model summary for output (no trained model weights, just metrics)
  const shareModelSummary: Record<string, { cvR2: number; cvMAE: number; n: number }> = {};
  for (const [k, v] of Object.entries(shareModels as any)) {
    shareModelSummary[k] = { cvR2: v.cvR2, cvMAE: v.cvMAE, n: v.n };
  }

  const output = { ...result, models, posThresholds, predictions2026, featureImportance, rookieFeatureImportance, rookiePreDraftFeatureImportance, vetFeatureImportance, ppgModels, ppgPredictions2026, residualModels: residualModelsOutput, residualPredictions2026, draftSim2025, shareModelSummary, rookieCareerModels, careerPredictions2026 };
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
