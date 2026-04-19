// Build-time precomputation of feature matrix + trained models.
// Run with: npx tsx scripts/precompute-features.ts
// Outputs: public/data/feature-matrix.json (includes trained models)

import { buildFeatureMatrix } from '../src/lib/buildFeatureMatrix';
import { SEASONS, PREDICT_SEASON, POSITIONS, REPLACEMENT_RANKS, FEATURES, ADP_FEATURES, ROOKIE_FEATURES, PRE_DRAFT_ROOKIE_FEATURES, cvR2, cvMae, normalizeName, parseHeight } from '../src/lib/featureTypes';
import type { PlayerRow } from '../src/lib/featureTypes';
import { predict } from '../src/lib/ridge';
import { predictGBM, predictBaggedGBM } from '../src/lib/gbm';
import { normalCdf, PPG_THRESHOLD_CONFIG, predictRookieCareerPPG, bootstrapThresholdProb } from '../src/lib/rookieCareerModel';
import { fetchCombine, fetchCollegeStats, fetchDraftPicks, fetchCollegeQBR,
  fetchCfbdRecruiting, fetchCfbdTeamTalent, fetchCfbdPlayerUsage } from '../src/data';
import { FeatureStoreBuilder } from '../src/lib/featureStore';
import { loadProspectStore, buildProspectFeatureRecord } from '../src/lib/featureStore/prospectStore';
import { writeCareerScores, writeADPScores, writePPGScores, writeShareScores, writeScoreManifest, tierFromPercentile } from '../src/lib/modelScoreStore';
import type { ShareScore } from '../src/lib/modelScoreStore';
import type { CareerScore, ADPScore, PPGScore } from '../src/lib/modelScoreStore';
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
const CACHE_PATH = 'public/data/training-rows-cache-v48.json';
// MODELS: Bump when rookieCareerModel.ts, feature lists, or training logic change.
// Uses cached rows, rebuilds in ~1-2 min.
const MODEL_CACHE_PATH = 'public/data/trained-models-cache-v59.json';
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
      vorBasis: 'ppg',
      onStatus: (msg) => { console.log(`  ${msg}`); if (global.gc) global.gc(); },
    });

    // Compute VOR normalization from raw PPG VOR (before z-scoring)
    const REPLACEMENT_RANKS: Record<string, number> = { QB: 12, RB: 24, WR: 24, TE: 12 };
    const vorNorm: Record<string, { mean: number; std: number }> = {};
    for (const pos of POSITIONS) {
      const posRows = storeRows.filter(r => r.position === pos);
      if (posRows.length < 4) continue;
      // PPG-based replacement level per position
      const sorted = [...posRows].sort((a, b) => b.rawPPG - a.rawPPG);
      const repPPG = sorted[(REPLACEMENT_RANKS[pos] ?? 24) - 1]?.rawPPG ?? 0;
      const rawVals = posRows.map(r => r.rawPPG - repPPG);
      const mean = rawVals.reduce((a, b) => a + b, 0) / rawVals.length;
      const variance = rawVals.reduce((s, v) => s + (v - mean) ** 2, 0) / rawVals.length;
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
      vorBasis: 'ppg',
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
      vorBasis: 'ppg',
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

  // Write ::2026 entries to feature store from prediction row features
  // so MyRankings can display 2025 prior stats (targets, PPG, shares)
  if (result.predRows.length > 0) {
    const priorPath = `${featureStorePath}/priorStats.json`;
    const compPath = `${featureStorePath}/competition.json`;
    const priorShard = existsSync(priorPath) ? JSON.parse(readFileSync(priorPath, 'utf-8')) : {};
    const compShard = existsSync(compPath) ? JSON.parse(readFileSync(compPath, 'utf-8')) : {};

    let priorCount = 0;
    let compCount = 0;
    for (const r of result.predRows as Array<{ name: string; position: string; features: Record<string, number> }>) {
      const key = `${normalizeName(r.name)}::${PREDICT_SEASON}`;
      const f = r.features;

      // Write prior stats entry (2025 actuals as "prior" for 2026)
      priorShard[key] = {
        priorPassYards: f.priorPassYards || 0,
        priorPassTDs: f.priorPassTDs || 0,
        priorINTs: f.priorINTs || 0,
        priorPassYPA: f.priorPassYPA || 0,
        priorQBRating: f.priorQBRating || 0,
        priorRushYards: f.priorRushYards || 0,
        priorRushTDs: f.priorRushTDs || 0,
        priorYPC: f.priorYPC || 0,
        priorCarries: f.priorCarries || 0,
        priorTargets: f.priorTargets || 0,
        priorReceptions: f.priorReceptions || 0,
        priorRecYards: f.priorRecYards || 0,
        priorRecTDs: f.priorRecTDs || 0,
        priorYPR: f.priorYPR || 0,
        priorPPR: f.priorPPR || 0,
        priorPPG: f.priorPPG || 0,
        priorGames: f.priorGames || 0,
        priorGamesMissed: f.priorGamesMissed || 0,
        priorTotalTouches: f.priorTotalTouches || 0,
        priorSnapPct: f.priorSnapPct || 0,
      };
      priorCount++;

      // Write competition entry
      compShard[key] = {
        teamSamePosCount: f.teamSamePosCount || 0,
        depthChartRank: f.depthChartRank || 0,
        priorTeamTouchShare: f.priorTeamTouchShare || 0,
        priorTeamTargetShare: f.priorTeamTargetShare || 0,
        newSamePosAdded: f.newSamePosAdded || 0,
        teamDraftedSamePos: f.teamDraftedSamePos || 0,
        draftCapitalSamePos: f.draftCapitalSamePos || 0,
        teammatePriorPPR: f.teammatePriorPPR || 0,
        teamRosterTurnover: f.teamRosterTurnover || 0,
      };
      compCount++;
    }

    writeFileSync(priorPath, JSON.stringify(priorShard));
    writeFileSync(compPath, JSON.stringify(compShard));
    console.log(`  Feature store updated: ${priorCount} priorStats + ${compCount} competition ::${PREDICT_SEASON} entries`);
  }

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
  let rookieCareerModelsPostDraft: any;
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
    adp: `${MODEL_DIR}/model-cache-adp-v56.json`,
    ppg: `${MODEL_DIR}/model-cache-ppg-v56.json`,
    residual: `${MODEL_DIR}/model-cache-residual-v56.json`,
    share: `${MODEL_DIR}/model-cache-share-v56.json`,
    career: `${MODEL_DIR}/model-cache-career-v72.json`,
    careerPostDraft: `${MODEL_DIR}/model-cache-career-postdraft-v4.json`,
    lateBoom: `${MODEL_DIR}/model-cache-late-boom-v1.json`,
  };

  // Late-boom classifier: (position, normalized name, season) → LOSO boom probability.
  // Populated from model-cache-late-boom-v1.json written by scripts/train_late_boom_model.py.
  // Only late picks (past positional ADP threshold) have entries; others resolve to 0.
  const lateBoomLookup = new Map<string, number>();

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

  if (existsSync(componentCachePaths.careerPostDraft)) {
    console.log('  Loading cached post-draft career models...');
    rookieCareerModelsPostDraft = JSON.parse(readFileSync(componentCachePaths.careerPostDraft, 'utf-8')).rookieCareerModels;
  } else { anyMissing = true; }

  if (existsSync(componentCachePaths.lateBoom)) {
    console.log('  Loading cached late-boom scores...');
    const lb = JSON.parse(readFileSync(componentCachePaths.lateBoom, 'utf-8'));
    const scores = lb.scores || {};
    let total = 0;
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      const arr: Array<{ name: string; season: number; lateBoomProb: number }> = scores[pos] || [];
      for (const s of arr) {
        const nn = (s.name || '').toLowerCase().replace(/[.']/g, '').trim();
        lateBoomLookup.set(`${pos}|${nn}|${s.season}`, s.lateBoomProb);
        total++;
      }
    }
    console.log(`    ${total} late-boom LOSO scores loaded (${Object.keys(scores).join(', ')})`);
  }
  // Note: late-boom cache is optional — sim gracefully degrades if missing.

  // All model caches MUST exist by the time this script runs.
  //
  // JS-side training fallbacks were removed after the residual bagging PR. The
  // authoritative training path is the Python scripts — see the commit that
  // deletes this block for the full rationale. Re-enabling JS training would
  // silently ship models with different features, different hyperparameters,
  // and a GBM implementation that doesn't match the Python LightGBM one.
  //
  // If a cache is missing, run the Python scripts in order:
  //   python3 scripts/train_projection_models.py    # ADP, PPG, Share, Residual
  //   python3 scripts/train_career_models.py        # rookie career (pre/post draft)
  //   python3 scripts/train_late_boom_model.py      # late-boom classifier
  if (anyMissing) {
    throw new Error(
      'Precompute requires all model caches to exist (public/data/model-cache-*.json). ' +
      'Run: python3 scripts/train_projection_models.py && ' +
      'python3 scripts/train_career_models.py && ' +
      'python3 scripts/train_late_boom_model.py'
    );
  }
  console.log('  All component caches loaded.');
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

  // WR/TE rush shares are negligible — zero them out so they don't leak
  // target share (priorTeamTouchShare for WR/TE is targets/teamTargets, not rushes)
  for (const r of result.predRows as Array<{ position: string; adp: number; features: Record<string, number> }>) {
    if (r.adp > MAX_ADP) continue;
    if (r.position === 'WR' || r.position === 'TE') {
      r.features.predRushShare = 0;
      r.features.predRushYdsShare = 0;
      r.features.predRushTDShare = 0;
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
    boomProb?: number;       // P(outperform by > MAE) — kept for back-compat
    bustProb?: number;       // P(underperform by > MAE) — kept for back-compat
    boomZ?: number;          // Z-score vs historical NFL rookie distribution
    bustZ?: number;          // Z-score vs historical NFL rookie distribution
  }> = [];

  // Load prospect grades from static JSON
  let prospectGrades: Array<{ name: string; pos: string; school: string; grade: number; projRound: number; projPick: number; tier: string }> = [];
  try {
    prospectGrades = JSON.parse(readFileSync('src/data/prospect-grades-2026.json', 'utf-8'));
    console.log(`    Loaded ${prospectGrades.length} prospect grades`);
  } catch { console.log('    No prospect grades file found'); }

  if (prospectGrades.length > 0) {
    // Load combine and college stats for feature construction
    const [combineData, collegeData, collegeQBRData] = await Promise.all([
      fetchCombine().catch(() => []),
      fetchCollegeStats().catch(() => []),
      fetchCollegeQBR().catch(() => []),
    ]);

    // College QBR per-season → finalYr and 2yr avg maps for 2026 prospects.
    const prospectQBRSeasons = new Map<string, Array<{ season: number; qbr: number }>>();
    for (const q of collegeQBRData) {
      const name = normalizeName(q.player_name);
      if (!prospectQBRSeasons.has(name)) prospectQBRSeasons.set(name, []);
      prospectQBRSeasons.get(name)!.push({ season: q.season, qbr: q.total_qbr || 0 });
    }
    for (const list of prospectQBRSeasons.values()) list.sort((a, b) => b.season - a.season);
    const prospectQBRLatest = new Map<string, number>();
    const prospectQBR2yr = new Map<string, number>();
    for (const [name, list] of prospectQBRSeasons) {
      if (list.length === 0) continue;
      prospectQBRLatest.set(name, list[0].qbr);
      const lastTwo = list.slice(0, 2);
      prospectQBR2yr.set(name, Math.round((lastTwo.reduce((s, x) => s + x.qbr, 0) / lastTwo.length) * 10) / 10);
    }

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

    // Combine averages + per-position stds (for RAS) by position
    const combineAvg = new Map<string, Record<string, number>>();
    // Store raw values per metric for mean/std
    const combineAccumRaw = new Map<string, Record<string, number[]>>();
    for (const c of combineData) {
      if (!c.pos) continue;
      if (!combineAccumRaw.has(c.pos)) combineAccumRaw.set(c.pos, {});
      const acc = combineAccumRaw.get(c.pos)!;
      for (const [k, v] of [['forty', c.forty], ['weight', c.wt], ['bench', c.bench], ['vertical', c.vertical], ['broadJump', c.broad_jump], ['cone', c.cone], ['shuttle', c.shuttle]] as [string, number][]) {
        if (v && v > 0) {
          if (!acc[k]) acc[k] = [];
          acc[k].push(v);
        }
      }
    }
    const combineStds = new Map<string, Record<string, number>>();
    for (const [pos, acc] of combineAccumRaw) {
      const avg: Record<string, number> = {};
      const stds: Record<string, number> = {};
      for (const [k, vals] of Object.entries(acc)) {
        const m = vals.reduce((a, b) => a + b, 0) / vals.length;
        const v = vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length;
        avg[k] = Math.round(m * 100) / 100;
        stds[k] = Math.max(0.01, Math.sqrt(v));
      }
      combineAvg.set(pos, avg);
      combineStds.set(pos, stds);
    }
    // Compute RAS from a prospect's combine record (raw values) + position.
    function computeProspectRAS(combine: any | undefined, pos: string): number {
      if (!combine) return 0;
      const avg = combineAvg.get(pos);
      const stds = combineStds.get(pos);
      if (!avg || !stds) return 0;
      const metrics: Array<[string, string, boolean]> = [
        ['weight', 'wt', true], ['forty', 'forty', false],
        ['bench', 'bench', true], ['vertical', 'vertical', true],
        ['broadJump', 'broad_jump', true], ['cone', 'cone', false],
        ['shuttle', 'shuttle', false],
      ];
      const zs: number[] = [];
      for (const [statKey, combineKey, higherBetter] of metrics) {
        const raw = Number(combine[combineKey]) || 0;
        if (raw <= 0) continue;
        const m = avg[statKey] || 0;
        const s = stds[statKey] || 0;
        if (!m || !s) continue;
        const z = (raw - m) / s;
        zs.push(higherBetter ? z : -z);
      }
      if (zs.length === 0) return 0;
      const avgZ = zs.reduce((a, b) => a + b, 0) / zs.length;
      const clamped = Math.max(-2.5, Math.min(2.5, avgZ));
      return Math.round((5 + clamped * 2) * 10) / 10;
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
    const ncaaPredictiveRanking = (ncaaTeamData as Record<string, unknown>).predictiveRanking as Record<string, number> | undefined;

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
    type ProspectSeasonStats = {
      recYds: number; receptions: number; rushYds: number; rushAtt: number;
      rushTDs: number; recTDs: number;
      passAtt: number; passYds: number; passCompletions: number;
      games: number; school: string; season: number;
    };
    const prospectSeasonStats = new Map<string, ProspectSeasonStats[]>();
    // Per-school-season team totals — used for RB goal-line / YPC-over-team
    // and QB completion-rate-over-team features.
    type ProspectTeamStats = {
      rushYds: number; rushAtt: number; rushTDs: number; recTDs: number;
      passAtt: number; passCompletions: number;
    };
    const prospectTeamSeasonStats = new Map<string, ProspectTeamStats>();
    for (const cs of collegeData) {
      const name = normalizeName(cs.player_name);
      const stat = (cs.statistic || '').toLowerCase();
      if (!prospectSeasonStats.has(name)) prospectSeasonStats.set(name, []);
      const seasons = prospectSeasonStats.get(name)!;
      let entry = seasons.find(s => s.season === cs.season);
      if (!entry) {
        entry = {
          recYds: 0, receptions: 0, rushYds: 0, rushAtt: 0,
          rushTDs: 0, recTDs: 0,
          passAtt: 0, passYds: 0, passCompletions: 0,
          games: 0, school: (cs.school || cs.school_abbr || '').toLowerCase(), season: cs.season,
        };
        seasons.push(entry);
      }
      if (stat.includes('receiving yard')) entry.recYds += cs.value || 0;
      else if (stat.includes('receiving touchdown')) entry.recTDs += cs.value || 0;
      else if (stat.includes('reception') && !stat.includes('yard') && !stat.includes('td')) entry.receptions += cs.value || 0;
      else if (stat.includes('rushing yard')) entry.rushYds += cs.value || 0;
      else if (stat.includes('rushing attempt') || stat === 'rushing attempts') entry.rushAtt += cs.value || 0;
      else if (stat.includes('rushing touchdown')) entry.rushTDs += cs.value || 0;
      else if (stat.includes('passing attempt') || stat === 'pass attempts') entry.passAtt += cs.value || 0;
      else if (stat.includes('passing yard')) entry.passYds += cs.value || 0;
      else if (stat.includes('completion') && !stat.includes('pct') && !stat.includes('%')) entry.passCompletions += cs.value || 0;
      else if (stat === 'games played' || stat.includes('games played')) entry.games = Math.max(entry.games, cs.value || 0);

      // Team totals (sum across all players at same school+season).
      const school = (cs.school || cs.school_abbr || '').toLowerCase();
      if (school) {
        const tkey = `${school}:${cs.season}`;
        if (!prospectTeamSeasonStats.has(tkey)) {
          prospectTeamSeasonStats.set(tkey, { rushYds: 0, rushAtt: 0, rushTDs: 0, recTDs: 0, passAtt: 0, passCompletions: 0 });
        }
        const team = prospectTeamSeasonStats.get(tkey)!;
        if (stat.includes('rushing yard')) team.rushYds += cs.value || 0;
        else if (stat.includes('rushing attempt') || stat === 'rushing attempts') team.rushAtt += cs.value || 0;
        else if (stat.includes('rushing touchdown')) team.rushTDs += cs.value || 0;
        else if (stat.includes('receiving touchdown')) team.recTDs += cs.value || 0;
        else if (stat.includes('passing attempt') || stat === 'pass attempts') team.passAtt += cs.value || 0;
        else if (stat.includes('completion') && !stat.includes('pct') && !stat.includes('%')) team.passCompletions += cs.value || 0;
      }
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

    // Load CFBD lookups for prospect scoring. buildFeatureMatrix uses these
    // for training rows already; this block mirrors the same data into the
    // separate prospect-scoring path that populates careerPredictions2026
    // so player-card feature bars in the Prospects / ZAP Compare UIs pick
    // up recruitStars, recruitRating, collegeTeamTalent, and usage rates
    // alongside the rest of the college features.
    const [cfbdRecruits, cfbdTalent, cfbdUsage] = await Promise.all([
      fetchCfbdRecruiting().catch(() => ({})),
      fetchCfbdTeamTalent().catch(() => ({})),
      fetchCfbdPlayerUsage().catch(() => ({})),
    ]);
    const cfbdKey = (name: string) => name.replace(/[^a-z0-9]+/g, '');

    // PDF scouting index (The Beast / RSP / Late-Round Guide) mirroring
    // train_career_models.py::_load_pdf_index. Ships the same numeric
    // features used in the RB/WR pre-draft feature lists so prospect
    // scoring uses the same inputs as the LOSO backtest.
    const pdfIndex: Record<string, {
      rank_overall_mean?: number | null;
      strengths?: string[];
      weaknesses?: string[];
      red_flags?: string[];
      position?: string;
    }> = {};
    try {
      const pdfRaw = JSON.parse(readFileSync('public/data/pdf-prospect-features-merged.json', 'utf-8'));
      const normPdfName = (n: string) => n.toLowerCase().trim()
        .replace(/\./g, '').replace(/'/g, '').replace(/-/g, ' ').replace(/`/g, '')
        .replace(/\s+(sr|jr|iii|ii|iv)$/i, '').replace(/\s+/g, ' ');
      for (const p of pdfRaw) {
        const k = `${normPdfName(p.player_name)}::${p.position}`;
        pdfIndex[k] = p;
        // Position-agnostic fallback for scouting/fantasy TE/OL mismatches.
        const nameOnly = normPdfName(p.player_name);
        if (!pdfIndex[nameOnly]) pdfIndex[nameOnly] = p;
      }
    } catch {
      // PDF file is optional — prospects just get zero-filled features.
    }
    const lookupPdf = (name: string, position: string) => {
      const norm = name.toLowerCase().trim()
        .replace(/\./g, '').replace(/'/g, '').replace(/-/g, ' ').replace(/`/g, '')
        .replace(/\s+(sr|jr|iii|ii|iv)$/i, '').replace(/\s+/g, ' ');
      return pdfIndex[`${norm}::${position}`] || pdfIndex[norm];
    };
    // Mirror train_career_models.py::_derive_pdf_features. Must stay in
    // lock-step so the PlayerCard, feature-matrix JSON, and career model
    // cache all agree on every pdf* key. Disagreement features that
    // depend on per-position cohort moments (recruit_production_gap,
    // athletic_production_gap) are computed on the Python side inside
    // score_prospect_boom_bust and left zero here.
    interface PdfEntry {
      rank_overall_mean?: number | null;
      rank_overall_min?: number | null;
      rank_overall_max?: number | null;
      projected_round_mean?: number | null;
      strengths?: string[];
      weaknesses?: string[];
      red_flags?: string[];
      position?: string;
    }
    const derivePdfFeatures = (name: string, position: string): Record<string, number> => {
      const p = lookupPdf(name, position) as PdfEntry | undefined;
      if (!p) {
        return {
          pdfHasData: 0,
          pdfRankOverallMean: 0, pdfRankOverallMin: 0, pdfRankOverallMax: 0,
          pdfRankSpread: 0, pdfProjectedRound: 0,
          pdfHasRank: 0, pdfHasRound: 0,
          pdfNStrengths: 0, pdfNWeaknesses: 0, pdfNRedFlags: 0,
          pdfSentimentNet: 0,
        };
      }
      const nStr = (p.strengths || []).length;
      const nWk = (p.weaknesses || []).length;
      const nRf = (p.red_flags || []).length;
      const mean = p.rank_overall_mean ?? 0;
      const min = p.rank_overall_min ?? 0;
      const max = p.rank_overall_max ?? 0;
      const round = p.projected_round_mean ?? 0;
      return {
        pdfHasData: 1,
        pdfRankOverallMean: mean,
        pdfRankOverallMin: min,
        pdfRankOverallMax: max,
        pdfRankSpread: (max != null && min != null) ? max - min : 0,
        pdfProjectedRound: round,
        pdfHasRank: p.rank_overall_mean != null ? 1 : 0,
        pdfHasRound: p.projected_round_mean != null ? 1 : 0,
        pdfNStrengths: nStr,
        pdfNWeaknesses: nWk,
        pdfNRedFlags: nRf,
        pdfSentimentNet: nStr - nWk - 2 * nRf,
      };
    };
    // Disagreement features derivable from PDF + draft inputs alone (no
    // cohort moments needed). Attached to every prospect record so the
    // PlayerCard can surface the same disagreement signal the boom/bust
    // model uses. recruit_production_gap / athletic_production_gap are
    // set by score_prospect_boom_bust during the Python scoring pass.
    const computeDisagreementFromPdf = (
      pdfF: Record<string, number>, pick: number, round: number,
    ): Record<string, number> => {
      const safePick = Math.max(1, pick || 300);
      const safeRound = round || 7;
      const pdfRank = pdfF.pdfRankOverallMean || 0;
      const projRound = pdfF.pdfProjectedRound || 0;
      return {
        pdfRankXPick: pdfRank > 0 ? Math.log(pdfRank) - Math.log(safePick) : 0,
        pdfRoundXActual: projRound > 0 ? projRound - safeRound : 0,
      };
    };
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

    // Draft-pick context lookups for the 2026 prospect class (projected
    // picks, since real picks don't exist yet). Same semantics as the
    // historical buildFeatureMatrix equivalents.
    const prospectDraftPctByName = new Map<string, number>();
    const prospectDraftPctOverallByName = new Map<string, number>();
    const prospectDraftClassDepthByName = new Map<string, number>();
    {
      const byPos = new Map<string, typeof prospectGrades>();
      const allProspects: typeof prospectGrades = [];
      for (const p of prospectGrades) {
        if (!p.pos) continue;
        if (['QB', 'RB', 'WR', 'TE'].includes(p.pos)) {
          if (!byPos.has(p.pos)) byPos.set(p.pos, []);
          byPos.get(p.pos)!.push(p);
        }
        allProspects.push(p);
      }
      // Per-position percentile + class depth
      for (const list of byPos.values()) {
        const sorted = [...list].sort((a, b) => (a.projPick || 300) - (b.projPick || 300));
        const n = sorted.length;
        for (let i = 0; i < n; i++) {
          const name = normalizeName(sorted[i].name);
          prospectDraftPctByName.set(name, n > 1 ? i / (n - 1) : 0);
          prospectDraftClassDepthByName.set(name, n);
        }
      }
      // Overall percentile (against the whole prospect class across positions)
      const sortedAll = [...allProspects].sort((a, b) => (a.projPick || 300) - (b.projPick || 300));
      const nAll = sortedAll.length;
      for (let i = 0; i < nAll; i++) {
        const name = normalizeName(sortedAll[i].name);
        prospectDraftPctOverallByName.set(name, nAll > 1 ? i / (nAll - 1) : 0);
      }
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
        if (storedFeatures.draftPickPct == null) storedFeatures.draftPickPct = prospectDraftPctByName.get(nName) ?? 1;
        if (storedFeatures.draftPickPctOverall == null) storedFeatures.draftPickPctOverall = prospectDraftPctOverallByName.get(nName) ?? 1;
        if (storedFeatures.draftClassDepth == null) storedFeatures.draftClassDepth = prospectDraftClassDepthByName.get(nName) ?? 0;

        // Augment stored features with CFBD-sourced signals (recruit rating,
        // college usage, team talent) + the RB interaction feature the pre-draft
        // model actually trains on. Without this, graded prospects land on the
        // stored path and the PlayerCard popover shows 0 for everything past
        // logDraftPick because buildProspectFeatureRecord doesn't know about
        // CFBD rollups or the late-round interaction term. Same signals as the
        // nflverse path below.
        {
          const projPick = storedProspect.projPick || 300;
          const cfbdK = cfbdKey(nName);
          const seasons = prospectSeasonStats.get(nName) || [];
          let lastSeason: { season: number; school: string } | null =
            seasons.length ? seasons.reduce((a, b) => a.season > b.season ? a : b) : null;
          // Fallback: current college juniors (like Carnell Tate) aren't in
          // the nflverse college-stats source, so prospectSeasonStats is empty
          // for them. Use CFBD usage keys (`cfbdKey:season`) as a secondary
          // source — the team name is in the entry's `team` field.
          if (!lastSeason) {
            const prefix = `${cfbdK}:`;
            let maxYr = 0, maxSchool = '';
            for (const [key, val] of Object.entries(cfbdUsage)) {
              if (!key.startsWith(prefix)) continue;
              const yr = parseInt(key.split(':')[1]);
              if (yr > maxYr) { maxYr = yr; maxSchool = ((val as any).team || '').toLowerCase(); }
            }
            if (maxYr) lastSeason = { season: maxYr, school: maxSchool };
          }
          if (!storedFeatures.collegeDominatorXLateRound) {
            storedFeatures.collegeDominatorXLateRound = (storedFeatures.collegeDominatorRating || 0) *
              Math.max(0, Math.log(projPick + 1) - 4.0);
          }
          if (!storedFeatures.recruitStars) storedFeatures.recruitStars = cfbdRecruits[cfbdK]?.stars || 0;
          if (!storedFeatures.recruitRating) storedFeatures.recruitRating = cfbdRecruits[cfbdK]?.composite_rating || 0;
          if (!storedFeatures.collegeTeamTalent && lastSeason) {
            storedFeatures.collegeTeamTalent = cfbdTalent[`${(lastSeason.school || '').toLowerCase()}:${lastSeason.season}`] || 0;
          }
          if (!storedFeatures.collegeUsageOverall && lastSeason) {
            storedFeatures.collegeUsageOverall = cfbdUsage[`${cfbdK}:${lastSeason.season}`]?.overall || 0;
          }
          if (!storedFeatures.collegeUsagePass && lastSeason) {
            storedFeatures.collegeUsagePass = cfbdUsage[`${cfbdK}:${lastSeason.season}`]?.pass || 0;
          }
          if (!storedFeatures.collegeUsageRush && lastSeason) {
            storedFeatures.collegeUsageRush = cfbdUsage[`${cfbdK}:${lastSeason.season}`]?.rush || 0;
          }
          if (!storedFeatures.collegeQBR) storedFeatures.collegeQBR = prospectQBRLatest.get(nName) || 0;
          if (!storedFeatures.collegeQBR2yr) storedFeatures.collegeQBR2yr = prospectQBR2yr.get(nName) || prospectQBRLatest.get(nName) || 0;

          // PDF scouting features — mirrors attach in train_career_models.py
          // load_career_rows. Per-position feature lists decide which keys
          // the model uses (see PRE_DRAFT_ROOKIE_FEATURES in featureTypes.ts
          // / PRE_DRAFT_FEATURES in train_career_models.py); we populate
          // every key so the PlayerCard popover surfaces them consistently.
          const pdfF = derivePdfFeatures(prospect.name, pos);
          for (const [k, v] of Object.entries(pdfF)) {
            if (storedFeatures[k] === undefined) storedFeatures[k] = v as number;
          }
          // Disagreement features that are computable from PDF + draft inputs
          // alone. recruit_production_gap / athletic_production_gap need
          // cohort moments and are attached by the Python scorer.
          const disag = computeDisagreementFromPdf(
            pdfF,
            (storedFeatures.nflDraftPick as number) || (storedProspect.projPick || 300),
            (storedFeatures.nflDraftRound as number) || (storedProspect.projRound || 7),
          );
          for (const [k, v] of Object.entries(disag)) {
            if (storedFeatures[k] === undefined) storedFeatures[k] = v as number;
          }

          // RAS + combine-data flags. buildProspectFeatureRecord doesn't
          // compute these (only the nflverse path did), so graded prospects
          // always showed "RAS 0" and missing combine flags. Compute RAS by
          // feeding real combine fields (stored prospect wins, nflverse
          // combine fills gaps) into the same z-score function the nflverse
          // path uses. Flags track whether the underlying values are real
          // (not positional-average imputations from buildProspectFeatureRecord).
          const nvCombine = combineByProspect.get(nName);
          const realWt = (storedProspect.weight || 0) > 0 ? storedProspect.weight! : (nvCombine?.wt || 0);
          const realForty = (storedProspect.forty || 0) > 0 ? storedProspect.forty! : (nvCombine?.forty || 0);
          const combineForRas = {
            wt: realWt,
            forty: realForty,
            bench: (storedProspect.bench || 0) > 0 ? storedProspect.bench! : (nvCombine?.bench || 0),
            vertical: (storedProspect.vertical || 0) > 0 ? storedProspect.vertical! : (nvCombine?.vertical || 0),
            broad_jump: (storedProspect.broadJump || 0) > 0 ? storedProspect.broadJump! : (nvCombine?.broad_jump || 0),
            cone: (storedProspect.cone || 0) > 0 ? storedProspect.cone! : (nvCombine?.cone || 0),
            shuttle: (storedProspect.shuttle || 0) > 0 ? storedProspect.shuttle! : (nvCombine?.shuttle || 0),
          };
          if (!storedFeatures.relativeAthleticScore) {
            storedFeatures.relativeAthleticScore = computeProspectRAS(combineForRas, pos);
          }
          if (storedFeatures.hasPhysicalData == null) {
            storedFeatures.hasPhysicalData = realWt > 0 ? 1 : 0;
          }
          if (storedFeatures.hasCombineData == null) {
            storedFeatures.hasCombineData = realWt > 0 && realForty > 0 ? 1 : 0;
          }
        }

        // Use stored features for scoring
        const features = storedFeatures;
        const pred = predictRookieCareerPPG(cm, features);
        const predictedPPG = Math.round(pred * 10) / 10;

        // Threshold probabilities. Use the per-threshold binary classifier
        // when it exists; fall back to empirical bootstrap from the LOSO
        // residual distribution when the classifier was skipped (imbalanced
        // class case). Bootstrap is non-parametric so it respects residual
        // skew that the normal approximation would miss.
        const thresholds = PPG_THRESHOLD_CONFIG[pos]?.thresholds || [];
        const probs: Record<number, number> = {};
        for (const thresh of thresholds) {
          const tm = cm.thresholdModels?.[thresh];
          let p: number;
          if (tm?.ridge) {
            const ridgeP = Math.max(0, Math.min(1, predict(tm.ridge, features).predicted));
            p = ridgeP;
            if (tm.gbm) {
              const gbmP = Math.max(0, Math.min(1, predictBaggedGBM(tm.gbm, features).predicted));
              p = gbmP * 0.5 + ridgeP * 0.5;
            }
          } else {
            p = bootstrapThresholdProb(predictedPPG, thresh, cm);
          }
          probs[thresh] = Math.round(p * 1000) / 10;
        }

        const probValues = thresholds.map(t => probs[t] || 0);
        const meanProb = probValues.length > 0 ? probValues.reduce((s, v) => s + v, 0) / probValues.length : 0;

        // Boom/bust from Python talent-gap model (per-player), fallback to bins
        let prospBoom = 0;
        let prospBust = 0;
        let prospBoomZ: number | undefined;
        let prospBustZ: number | undefined;
        try {
          const bbPath = 'public/data/prospect-boom-bust.json';
          if (existsSync(bbPath)) {
            const bbData = JSON.parse(readFileSync(bbPath, 'utf-8')) as Array<{ name: string; position: string; boomProb: number; bustProb: number; boomZ?: number; bustZ?: number }>;
            const nn = normalizeName(prospect.name);
            const match = bbData.find((b: any) => normalizeName(b.name) === nn && b.position === pos);
            if (match) {
              prospBoom = match.boomProb / 100;
              prospBust = match.bustProb / 100;
              prospBoomZ = match.boomZ;
              prospBustZ = match.bustZ;
            }
          }
        } catch {}
        // Fallback to conditional bins if no Python score
        if (prospBoom === 0 && prospBust === 0) {
          prospBoom = (cm.boomRate || 0) / 100;
          prospBust = (cm.bustRate || 0) / 100;
          const prospCondBins = (cm as any).conditionalResiduals?.bins;
          if (prospCondBins && prospCondBins.length > 0) {
            const prospBin = prospCondBins.find((b: any) => predictedPPG >= b.predMin && predictedPPG <= b.predMax)
              || prospCondBins.find((b: any) => b.label === (predictedPPG > (prospCondBins[0]?.predMax || 999) ? 'high' : 'mid'));
            if (prospBin) {
              prospBoom = prospBin.boomRate / 100;
              prospBust = prospBin.bustRate / 100;
            }
          }
        }

        careerPredictions2026.push({
          name: prospect.name, position: pos, school: prospect.school,
          projRound: prospect.projRound, projPick: prospect.projPick,
          predictedCareerPPG: predictedPPG, combinedScore: meanProb, tier: 0,
          thresholdProbs: probs, features,
          boomProb: Math.round(prospBoom * 1000) / 10,
          bustProb: Math.round(prospBust * 1000) / 10,
          boomZ: prospBoomZ,
          bustZ: prospBustZ,
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
        logDraftPick: Math.log(projPick + 1),
        invDraftPick: 1 / projPick,
        draftPickPct: prospectDraftPctByName.get(nName) ?? 1,
        draftPickPctOverall: prospectDraftPctOverallByName.get(nName) ?? 1,
        draftClassDepth: prospectDraftClassDepthByName.get(nName) ?? 0,
        // Position-median draft age fallback. Prospects without a stored age
        // (e.g. Lindenwood transfers, small-school UDFAs) would land at 0,
        // which the WR model reads as "implausibly young" through its
        // negative `age` coefficient and inflates the prediction. Keep in
        // sync with prospectStore.buildProspectFeatureRecord and the 2026
        // nflverse prediction path (buildFeatureMatrix.ts line ~3770).
        age: prospect.age || 22,
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
        relativeAthleticScore: computeProspectRAS(combine, pos),
        draftCapXSpeed,
        collegePassTDs: cs?.get('Passing Touchdowns') || 0,
        collegeQBR: prospectQBRLatest.get(nName) || 0,
        collegeQBR2yr: prospectQBR2yr.get(nName) || prospectQBRLatest.get(nName) || 0,
        // CFBD-sourced features: ensure prospect cards surface the same
        // recruit + team-talent + usage signals the model now trains on.
        // Loaded above from the committed cfbd-* rollups so no extra API calls.
        recruitStars: cfbdRecruits[cfbdKey(nName)]?.stars || 0,
        recruitRating: cfbdRecruits[cfbdKey(nName)]?.composite_rating || 0,
        collegeTeamTalent: (() => {
          const seasons = prospectSeasonStats.get(nName) || [];
          if (seasons.length === 0) return 0;
          const last = seasons.reduce((a, b) => a.season > b.season ? a : b);
          return cfbdTalent[`${(last.school || '').toLowerCase()}:${last.season}`] || 0;
        })(),
        collegeUsageOverall: (() => {
          const seasons = prospectSeasonStats.get(nName) || [];
          if (seasons.length === 0) return 0;
          const last = seasons.reduce((a, b) => a.season > b.season ? a : b);
          return cfbdUsage[`${cfbdKey(nName)}:${last.season}`]?.overall || 0;
        })(),
        collegeUsagePass: (() => {
          const seasons = prospectSeasonStats.get(nName) || [];
          if (seasons.length === 0) return 0;
          const last = seasons.reduce((a, b) => a.season > b.season ? a : b);
          return cfbdUsage[`${cfbdKey(nName)}:${last.season}`]?.pass || 0;
        })(),
        collegeUsageRush: (() => {
          const seasons = prospectSeasonStats.get(nName) || [];
          if (seasons.length === 0) return 0;
          const last = seasons.reduce((a, b) => a.season > b.season ? a : b);
          return cfbdUsage[`${cfbdKey(nName)}:${last.season}`]?.rush || 0;
        })(),
        // PDF scouting features — see PRE/POST_DRAFT_FEATURES in
        // train_career_models.py. Zero-filled for unmatched prospects.
        // Disagreement pair (pdfRankXPick, pdfRoundXActual) is computed
        // inline because it only needs PDF + draft inputs; the
        // production-gap disagreements are filled by the Python scorer.
        ...(() => {
          const pdfF = derivePdfFeatures(prospect.name, pos);
          const disag = computeDisagreementFromPdf(pdfF, projPick, prospect.projRound || 8);
          return { ...pdfF, ...disag };
        })(),
        ...(() => {
          // Career aggregates used for QB context features AND the new
          // RB dual-threat / elusiveness / goal-line features. Cheap to
          // compute for every prospect; Ridge will zero them out for
          // irrelevant positions via the per-position feature list.
          const seasons = prospectSeasonStats.get(nName) || [];
          let careerPassAtt = 0, careerPassYds = 0, careerPassComp = 0;
          let careerRushYds = 0, careerRushAtt = 0, careerRushTDs = 0;
          let careerRecYds = 0, careerRecTDs = 0;
          let careerGames = 0;
          let tRushYds = 0, tRushAtt = 0, tRushTDs = 0, tRecTDs = 0;
          let tPassAtt = 0, tPassComp = 0;
          let lastSchool = '', lastSeason = 0;
          for (const s of seasons) {
            careerPassAtt += s.passAtt || 0;
            careerPassYds += s.passYds || 0;
            careerPassComp += s.passCompletions || 0;
            careerRushYds += s.rushYds || 0;
            careerRushAtt += s.rushAtt || 0;
            careerRushTDs += s.rushTDs || 0;
            careerRecYds += s.recYds || 0;
            careerRecTDs += s.recTDs || 0;
            careerGames += s.games || 0;
            if (s.season > lastSeason) { lastSeason = s.season; lastSchool = s.school || lastSchool; }
            const tkey = `${s.school}:${s.season}`;
            const team = prospectTeamSeasonStats.get(tkey);
            if (team) {
              tRushYds += team.rushYds || 0;
              tRushAtt += team.rushAtt || 0;
              tRushTDs += team.rushTDs || 0;
              tRecTDs += team.recTDs || 0;
              tPassAtt += team.passAtt || 0;
              tPassComp += team.passCompletions || 0;
            }
          }
          const totalGames = careerGames || (seasons.length * 13);
          const teamKey1 = lastSchool ? `${normSchool(lastSchool)}:${lastSeason}` : '';
          const teamKey2 = lastSchool ? `${lastSchool.toLowerCase().trim()}:${lastSeason}` : '';
          const teamRating = (teamKey1 && ncaaPredictiveRanking?.[teamKey1])
            || (teamKey2 && ncaaPredictiveRanking?.[teamKey2])
            || 0;
          const sosRaw = (teamKey1 && ncaaSOS[teamKey1])
            || (teamKey2 && ncaaSOS[teamKey2])
            || 0;
          const sosMult = sosRaw ? 1 + sosRaw / 20 : 1;
          const careerRushYpg = totalGames > 0 ? careerRushYds / totalGames : 0;
          const careerPassYpg = totalGames > 0 ? careerPassYds / totalGames : 0;
          const prospectAge = prospect.age || 0;
          // RB rate features
          const rbRecYdsPerGame = totalGames > 0
            ? Math.round((careerRecYds / totalGames) * 10) / 10
            : 0;
          const playerYPC = careerRushAtt > 0 ? careerRushYds / careerRushAtt : 0;
          const teamYPC = tRushAtt > 0 ? tRushYds / tRushAtt : 0;
          const rbYpcOverTeam = (playerYPC > 0 && teamYPC > 0)
            ? Math.round((playerYPC - teamYPC) * 100) / 100
            : 0;
          const teamScrimmageTDs = tRushTDs + tRecTDs;
          const rbGoalLineShare = teamScrimmageTDs > 0
            ? Math.round((careerRushTDs / teamScrimmageTDs) * 1000) / 1000
            : 0;
          // QB accuracy features (mirror the rookieCareerModel derivations).
          const qbCompletionPct = careerPassAtt > 0
            ? Math.round((careerPassComp / careerPassAtt) * 1000) / 1000
            : 0;
          const qbTeamCompPct = tPassAtt > 0 ? tPassComp / tPassAtt : 0;
          const qbCompletionPctOverTeam = (qbCompletionPct > 0 && qbTeamCompPct > 0)
            ? Math.round((qbCompletionPct - qbTeamCompPct) * 1000) / 1000
            : 0;
          const qbYdsPerCompletion = careerPassComp > 0
            ? Math.round((careerPassYds / careerPassComp) * 100) / 100
            : 0;
          return {
            collegeRushYpgPerAge: (careerRushYpg > 0 && prospectAge > 0)
              ? Math.round((careerRushYpg / prospectAge) * 100) / 100
              : 0,
            collegeYdsPerPassAtt: careerPassAtt > 0
              ? Math.round((careerPassYds / careerPassAtt) * 100) / 100
              : 0,
            collegeSosFinalYr: Math.round(sosMult * 100) / 100,
            collegeSosXPassAtt: Math.round(teamRating * careerPassAtt),
            collegePassAttPerRushYd: careerRushYds > 0
              ? Math.round((careerPassAtt / careerRushYds) * 100) / 100
              : 0,
            collegeQbContextScore: Math.round(
              careerPassYpg * Math.max(0, teamRating + 40) * sosMult
            ),
            collegeRecYdsPerGame: rbRecYdsPerGame,
            collegeRushYpcOverTeam: rbYpcOverTeam,
            collegeGoalLineShare: rbGoalLineShare,
            collegeCompletionPct: qbCompletionPct,
            collegeCompletionPctOverTeam: qbCompletionPctOverTeam,
            collegeYdsPerCompletion: qbYdsPerCompletion,
          };
        })(),
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
        collegeExperiencePerAge: (prospect.age && prospect.age > 0 && numSeasons > 0)
          ? Math.round(((numSeasons * 13) / prospect.age) * 100) / 100
          : 0,
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

      const pred = predictRookieCareerPPG(cm, features);
      const predictedPPG = Math.round(pred * 10) / 10;
      // Per-threshold classifier is primary; empirical bootstrap is the
      // fallback for thresholds where no classifier was trained.
      const posThresholds = cm.thresholds as number[];
      const threshModels = cm.thresholdModels as Record<number, { ridge: any; gbm: any }>;
      const thresholdProbs: Record<number, number> = {};
      if (posThresholds) {
        for (const t of posThresholds) {
          const tm = threshModels?.[t];
          let prob: number;
          if (tm?.ridge) {
            const ridgeP = Math.max(0, Math.min(1, predict(tm.ridge, features).predicted));
            prob = ridgeP;
            if (tm.gbm) {
              const gbmP = Math.max(0, Math.min(1, predictBaggedGBM(tm.gbm, features).predicted));
              prob = gbmP * 0.5 + ridgeP * 0.5;
            }
          } else {
            prob = bootstrapThresholdProb(predictedPPG, t, cm);
          }
          thresholdProbs[t] = Math.round(Math.max(0, Math.min(1, prob)) * 1000) / 10;
        }
      }
      // Boom/bust probabilities from conditional residual distributions.
      // Find the bin matching this player's predicted PPG and use that
      // bin's empirical boom/bust rates.
      let boomProb = cm.boomRate / 100;
      let bustProb = cm.bustRate / 100;
      const condBins = (cm as any).conditionalResiduals?.bins;
      if (condBins && condBins.length > 0) {
        const bin = condBins.find((b: any) => predictedPPG >= b.predMin && predictedPPG <= b.predMax)
          || condBins.find((b: any) => b.label === 'mid');
        if (bin) {
          boomProb = bin.boomRate / 100;
          bustProb = bin.bustRate / 100;
        }
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

  // ═══════════════════════════════════════════════════════════════════════
  // MODEL SCORE STORE: persist per-model outputs as separate shards
  // All UI pages read from these for consistent scores
  // ═══════════════════════════════════════════════════════════════════════
  console.log('  Writing model score store...');
  {
    // Career scores: backtest + 2026 prospects
    const careerScores: CareerScore[] = [];

    // Backtest rows from all positions (with cross-year percentile)
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      const cm = (rookieCareerModels as any)[pos];
      if (!cm?.backtestRows) continue;
      const allPPGs = cm.backtestRows.map((r: any) => r.predictedPPG).sort((a: number, b: number) => a - b);
      for (const r of cm.backtestRows) {
        const rank = allPPGs.filter((p: number) => p <= r.predictedPPG).length;
        const pctl = Math.round((rank / allPPGs.length) * 100);
        const t = tierFromPercentile(pctl);
        careerScores.push({
          name: r.name, position: pos, draftSeason: r.draftSeason,
          predictedPPG: r.predictedPPG, actualPPG: r.actualPPG,
          percentile: pctl, tier: t.tier, tierLabel: t.label,
          thresholdProbs: r.thresholdProbs,
          boomProb: r.boomProb || 0,
          bustProb: r.bustProb || 0,
          features: r.features,
        });
      }
    }

    // 2026 prospects
    for (const p of careerPredictions2026) {
      const t = tierFromPercentile(p.percentile || p.combinedScore || 0);
      careerScores.push({
        name: p.name, position: p.position, draftSeason: 2026,
        predictedPPG: p.predictedCareerPPG || 0,
        percentile: p.percentile || p.combinedScore || 0,
        tier: t.tier, tierLabel: t.label,
        thresholdProbs: p.thresholdProbs || {},
        boomProb: p.boomProb || 0,
        bustProb: p.bustProb || 0,
        features: p.features,
        school: p.school, projPick: p.projPick || p.adp,
      });
    }

    // Compute feature percentiles per position
    // For each numeric feature, rank values across all rookies at the position.
    // Higher percentile = higher value (we don't invert for "lower is better"
    // features like draft pick — caller can interpret).
    {
      const byPos = new Map<string, CareerScore[]>();
      for (const s of careerScores) {
        if (!byPos.has(s.position)) byPos.set(s.position, []);
        byPos.get(s.position)!.push(s);
      }

      for (const [, posScores] of byPos) {
        // Collect all feature keys present in this position's scores
        const featureKeys = new Set<string>();
        for (const s of posScores) {
          if (!s.features) continue;
          for (const k of Object.keys(s.features)) featureKeys.add(k);
        }

        // For each feature, build sorted array and compute percentiles
        for (const key of featureKeys) {
          const vals = posScores
            .map(s => s.features?.[key])
            .filter((v): v is number => typeof v === 'number' && !isNaN(v))
            .sort((a, b) => a - b);
          if (vals.length < 3) continue;

          // Some features are "lower is better" — invert percentile
          const lowerIsBetter = key === 'logDraftPick' || key === 'nflDraftPick' ||
            key === 'nflDraftRound' || key === 'forty' || key === 'cone' ||
            key === 'shuttle' || key === 'collegeBreakoutAge' || key === 'age';

          for (const s of posScores) {
            const v = s.features?.[key];
            if (typeof v !== 'number' || isNaN(v)) continue;
            const rank = vals.filter(x => x <= v).length;
            let pctl = Math.round((rank / vals.length) * 100);
            if (lowerIsBetter) pctl = 100 - pctl;
            if (!s.featurePercentiles) s.featurePercentiles = {};
            s.featurePercentiles[key] = pctl;
          }
        }
      }
    }

    writeCareerScores(careerScores);
    console.log(`    career: ${careerScores.length} scores (${careerScores.filter(s => s.draftSeason === 2026).length} prospects + ${careerScores.filter(s => s.draftSeason < 2026).length} backtest)`);

    // ADP scores
    const adpScores: ADPScore[] = predictions2026.map((p: any) => ({
      name: p.name, position: p.position, team: p.team,
      adp: p.adp, predictedVor: p.predictedVor, hitProb: p.hitProb,
      ciLower: p.ciLower, ciUpper: p.ciUpper, isRookie: p.isRookie,
      headshotUrl: p.headshotUrl,
    }));
    writeADPScores(adpScores);
    console.log(`    adp: ${adpScores.length} predictions`);

    // PPG scores
    const ppgScores: PPGScore[] = (ppgPredictions2026 || []).map((p: any) => ({
      name: p.name, position: p.position, predictedPPG: p.predictedPPG,
    }));
    writePPGScores(ppgScores);
    console.log(`    ppg: ${ppgScores.length} predictions`);

    // Share scores — predicted target and rush shares from share models
    const shareScores: ShareScore[] = [];
    for (const r of (result.predRows as Array<{ name: string; position: string; team: string; adp: number; features: Record<string, number> }>)) {
      if (r.adp > MAX_ADP) continue;
      const f = r.features;
      if ((f.predTargetShare ?? 0) > 0 || (f.predRushShare ?? 0) > 0) {
        shareScores.push({
          name: r.name,
          position: r.position,
          team: r.team || '',
          predTargetShare: Math.round((f.predTargetShare || 0) * 1000) / 1000,
          predRushShare: Math.round((f.predRushShare || 0) * 1000) / 1000,
        });
      }
    }
    writeShareScores(shareScores);
    console.log(`    shares: ${shareScores.length} predictions`);

    // Manifest
    writeScoreManifest({
      version: 1,
      updatedAt: new Date().toISOString(),
      models: {
        career: { version: 'v51', count: careerScores.filter(s => s.draftSeason === 2026).length, backtestCount: careerScores.filter(s => s.draftSeason < 2026).length },
        adp: { version: 'v50', count: adpScores.length },
        ppg: { version: 'v50', count: ppgScores.length },
      },
    });
    console.log('    manifest written');
  }

  const output = { ...result, models, posThresholds, predictions2026, featureImportance, rookieFeatureImportance, rookiePreDraftFeatureImportance, vetFeatureImportance, ppgModels, ppgPredictions2026, residualModels: residualModelsOutput, residualPredictions2026, draftSim2025, shareModelSummary, rookieCareerModels, rookieCareerModelsPostDraft, careerPredictions2026 };
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
