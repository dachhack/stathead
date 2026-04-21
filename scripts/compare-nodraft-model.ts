#!/usr/bin/env tsx
/**
 * Ad-hoc comparison: rookie career model WITH vs WITHOUT draft-pick info.
 *
 * Strips the player-specific draft-pick features (logDraftPick,
 * draftPickPct, draftPickPctOverall, collegeDominatorXLateRound) from
 * PRE_DRAFT_ROOKIE_FEATURES and retrains. Reports LOSO regression and
 * boom/bust metrics side-by-side for RB/WR/TE.
 *
 * Run:
 *   NODE_OPTIONS='--max-old-space-size=6144 --expose-gc' \
 *     npx tsx scripts/compare-nodraft-model.ts
 */

import { readFileSync } from 'fs';
import { PRE_DRAFT_ROOKIE_FEATURES } from '../src/lib/featureTypes';
import { trainRookieCareerModels, type RookieCareerBacktestRow, type RookieCareerModelResult } from '../src/lib/rookieCareerModel';

const CACHE_PATH = 'public/data/training-rows-cache-v49.json';
const POSITIONS = ['RB', 'WR', 'TE'] as const;

const DRAFT_KEYS_TO_STRIP = new Set([
  'logDraftPick',
  'draftPickPct',
  'draftPickPctOverall',
  'collegeDominatorXLateRound',
]);

function calibrationBuckets(
  rows: RookieCareerBacktestRow[],
  probOf: (r: RookieCareerBacktestRow) => number,
  hitOf: (r: RookieCareerBacktestRow) => boolean,
): Array<{ band: string; n: number; meanPred: number; actual: number }> {
  const edges = [0, 10, 25, 50, 75, 100];
  const out: Array<{ band: string; n: number; meanPred: number; actual: number }> = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const bucket = rows.filter(r => {
      const p = probOf(r);
      return p >= lo && (i === edges.length - 2 ? p <= hi : p < hi);
    });
    if (bucket.length === 0) {
      out.push({ band: `${lo}-${hi}`, n: 0, meanPred: 0, actual: 0 });
      continue;
    }
    const meanPred = bucket.reduce((s, r) => s + probOf(r), 0) / bucket.length;
    const actual = bucket.filter(hitOf).length / bucket.length * 100;
    out.push({ band: `${lo}-${hi}`, n: bucket.length, meanPred, actual });
  }
  return out;
}

function fmt(n: number | undefined, d = 3): string {
  if (n == null || isNaN(n)) return '   -  ';
  return n.toFixed(d).padStart(6);
}

function reportPos(pos: string, base: RookieCareerModelResult, nod: RookieCareerModelResult) {
  console.log(`\n================  ${pos}  ================`);
  console.log(`  features:  baseline=${base.featureKeys.length}  noDraft=${nod.featureKeys.length}`);
  console.log(`  stripped:  ${base.featureKeys.filter(k => !nod.featureKeys.includes(k)).join(', ')}`);
  console.log();
  console.log(`  Regression (LOSO)        baseline   noDraft    Δ`);
  console.log(`    R²                     ${fmt(base.cvR2)}   ${fmt(nod.cvR2)}   ${fmt(nod.cvR2 - base.cvR2, 3)}`);
  console.log(`    MAE                    ${fmt(base.cvMAE, 2)}   ${fmt(nod.cvMAE, 2)}   ${fmt(nod.cvMAE - base.cvMAE, 2)}`);
  console.log(`    rank corr              ${fmt(base.rankCorr)}   ${fmt(nod.rankCorr)}   ${fmt(nod.rankCorr - base.rankCorr, 3)}`);
  console.log();

  // Boom/bust AUC from metrics if present
  const bm = base.boomMetrics, nm = nod.boomMetrics;
  const bb = base.bustMetrics, nb = nod.bustMetrics;
  console.log(`  Boom classifier          baseline   noDraft    Δ`);
  console.log(`    AUC                    ${fmt(bm?.auc)}   ${fmt(nm?.auc)}   ${fmt((nm?.auc ?? 0) - (bm?.auc ?? 0), 3)}`);
  console.log(`    precision              ${fmt(bm?.precision)}   ${fmt(nm?.precision)}   ${fmt((nm?.precision ?? 0) - (bm?.precision ?? 0), 3)}`);
  console.log(`    recall                 ${fmt(bm?.recall)}   ${fmt(nm?.recall)}   ${fmt((nm?.recall ?? 0) - (bm?.recall ?? 0), 3)}`);
  console.log();
  console.log(`  Bust classifier          baseline   noDraft    Δ`);
  console.log(`    AUC                    ${fmt(bb?.auc)}   ${fmt(nb?.auc)}   ${fmt((nb?.auc ?? 0) - (bb?.auc ?? 0), 3)}`);
  console.log(`    precision              ${fmt(bb?.precision)}   ${fmt(nb?.precision)}   ${fmt((nb?.precision ?? 0) - (bb?.precision ?? 0), 3)}`);
  console.log(`    recall                 ${fmt(bb?.recall)}   ${fmt(nb?.recall)}   ${fmt((nb?.recall ?? 0) - (bb?.recall ?? 0), 3)}`);
  console.log();

  // Empirical calibration of boomProb / bustProb against actuals on the
  // LOSO backtest rows. A "boom" here uses the same threshold the model
  // does internally: actual > predicted + MAE.
  const baseRows = base.backtestRows || [];
  const nodRows = nod.backtestRows || [];
  const mae = base.cvMAE;
  const boomHit = (r: RookieCareerBacktestRow) => r.actualPPG - r.predictedPPG > mae;
  const bustHit = (r: RookieCareerBacktestRow) => r.predictedPPG - r.actualPPG > mae;

  console.log(`  Boom calibration (predicted boomProb% vs actual hit rate)`);
  console.log(`    band        baseline            noDraft`);
  const bcB = calibrationBuckets(baseRows, r => r.boomProb || 0, boomHit);
  const bcN = calibrationBuckets(nodRows, r => r.boomProb || 0, boomHit);
  for (let i = 0; i < bcB.length; i++) {
    const a = bcB[i], b = bcN[i];
    console.log(`    ${a.band.padEnd(8)}  n=${String(a.n).padStart(3)} pred=${a.meanPred.toFixed(1).padStart(4)} act=${a.actual.toFixed(0).padStart(3)}%    n=${String(b.n).padStart(3)} pred=${b.meanPred.toFixed(1).padStart(4)} act=${b.actual.toFixed(0).padStart(3)}%`);
  }
  console.log();
  console.log(`  Bust calibration (predicted bustProb% vs actual hit rate)`);
  console.log(`    band        baseline            noDraft`);
  const buB = calibrationBuckets(baseRows, r => r.bustProb || 0, bustHit);
  const buN = calibrationBuckets(nodRows, r => r.bustProb || 0, bustHit);
  for (let i = 0; i < buB.length; i++) {
    const a = buB[i], b = buN[i];
    console.log(`    ${a.band.padEnd(8)}  n=${String(a.n).padStart(3)} pred=${a.meanPred.toFixed(1).padStart(4)} act=${a.actual.toFixed(0).padStart(3)}%    n=${String(b.n).padStart(3)} pred=${b.meanPred.toFixed(1).padStart(4)} act=${b.actual.toFixed(0).padStart(3)}%`);
  }
}

async function main() {
  console.log(`Loading training rows from ${CACHE_PATH}...`);
  const cached = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
  const rows = cached.rows as any[];
  console.log(`  Loaded ${rows.length} rows\n`);

  // Snapshot originals so we can restore after each noDraft run.
  const originals: Record<string, string[]> = {};
  for (const pos of POSITIONS) originals[pos] = [...(PRE_DRAFT_ROOKIE_FEATURES[pos] || [])];

  const results: Record<string, { base: RookieCareerModelResult; noDraft: RookieCareerModelResult }> = {};

  for (const pos of POSITIONS) {
    console.log(`Training ${pos} BASELINE (${originals[pos].length} features)...`);
    const t0 = Date.now();
    const baseModels = trainRookieCareerModels(rows, { onlyPositions: [pos] });
    console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

    const stripped = originals[pos].filter(k => !DRAFT_KEYS_TO_STRIP.has(k));
    PRE_DRAFT_ROOKIE_FEATURES[pos] = stripped;
    console.log(`Training ${pos} NO-DRAFT (${stripped.length} features)...`);
    const t1 = Date.now();
    const noDraftModels = trainRookieCareerModels(rows, { onlyPositions: [pos] });
    console.log(`  done in ${((Date.now() - t1) / 1000).toFixed(0)}s`);
    PRE_DRAFT_ROOKIE_FEATURES[pos] = originals[pos];

    const b = baseModels[pos], n = noDraftModels[pos];
    if (!b || !n) { console.log(`  skipped ${pos} — missing result`); continue; }
    results[pos] = { base: b, noDraft: n };
  }

  console.log('\n\n============================================');
  console.log('       SUMMARY: baseline  vs  noDraft');
  console.log('============================================');
  for (const pos of POSITIONS) {
    const r = results[pos];
    if (!r) continue;
    reportPos(pos, r.base, r.noDraft);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
