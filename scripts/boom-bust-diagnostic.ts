#!/usr/bin/env tsx
/**
 * Boom/bust diagnostic: check if residual variance differs by prediction tier.
 *
 * If higher-predicted players have different residual shapes than lower-predicted
 * players, we can use conditional residual distributions for player-specific
 * boom/bust probabilities instead of the current homoscedastic assumption.
 */

import { readFileSync } from 'fs';

const CAREER_CACHE = 'public/data/model-cache-career-v68.json';

interface BacktestRow {
  name: string;
  position: string;
  draftSeason: number;
  actualPPG: number;
  predictedPPG: number;
  combinedScore: number;
  percentile: number;
  modelTier: number;
  features?: Record<string, number>;
}

interface CareerModelResult {
  n: number;
  cvR2: number;
  cvMAE: number;
  residualStd: number;
  backtestRows: BacktestRow[];
  losoResiduals: number[];
}

function main() {
  console.log(`Loading career model from ${CAREER_CACHE}...`);
  const cache = JSON.parse(readFileSync(CAREER_CACHE, 'utf-8'));
  const models = cache.rookieCareerModels as Record<string, CareerModelResult>;

  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const m = models[pos];
    if (!m) continue;
    const rows = m.backtestRows;
    if (!rows || rows.length === 0) continue;

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`${pos}: n=${rows.length}, overall σ=${m.residualStd}`);
    console.log(`${'═'.repeat(60)}`);

    // Compute residuals
    const withResidual = rows.map(r => ({
      ...r,
      residual: r.actualPPG - r.predictedPPG,
      absResidual: Math.abs(r.actualPPG - r.predictedPPG),
    }));

    // Sort by predicted PPG
    withResidual.sort((a, b) => b.predictedPPG - a.predictedPPG);

    // Bin into tiers by predicted PPG
    const n = withResidual.length;
    const bins = [
      { label: 'Top 20% (high pred)', rows: withResidual.slice(0, Math.round(n * 0.2)) },
      { label: 'Mid 60%', rows: withResidual.slice(Math.round(n * 0.2), Math.round(n * 0.8)) },
      { label: 'Bot 20% (low pred)', rows: withResidual.slice(Math.round(n * 0.8)) },
    ];

    console.log(`\n  Residual stats by prediction tier:`);
    console.log(`  ${'Tier'.padEnd(25)} ${'N'.padStart(5)} ${'σ'.padStart(6)} ${'MAE'.padStart(6)} ${'Boom%'.padStart(7)} ${'Bust%'.padStart(7)} ${'AvgPred'.padStart(8)} ${'AvgAct'.padStart(8)}`);

    const boomThresh = m.cvMAE * 0.75;

    for (const bin of bins) {
      const residuals = bin.rows.map(r => r.residual);
      const mean = residuals.reduce((s, r) => s + r, 0) / residuals.length;
      const std = Math.sqrt(residuals.reduce((s, r) => s + (r - mean) ** 2, 0) / residuals.length);
      const mae = residuals.reduce((s, r) => s + Math.abs(r), 0) / residuals.length;
      const booms = bin.rows.filter(r => r.residual > boomThresh).length;
      const busts = bin.rows.filter(r => r.residual < -boomThresh).length;
      const avgPred = bin.rows.reduce((s, r) => s + r.predictedPPG, 0) / bin.rows.length;
      const avgAct = bin.rows.reduce((s, r) => s + r.actualPPG, 0) / bin.rows.length;

      console.log(`  ${bin.label.padEnd(25)} ${String(bin.rows.length).padStart(5)} ${std.toFixed(2).padStart(6)} ${mae.toFixed(2).padStart(6)} ${(booms / bin.rows.length * 100).toFixed(1).padStart(6)}% ${(busts / bin.rows.length * 100).toFixed(1).padStart(6)}% ${avgPred.toFixed(1).padStart(8)} ${avgAct.toFixed(1).padStart(8)}`);
    }

    // Also try 5 bins for more granularity
    const quintiles = [
      { label: 'Q1 (highest pred)', start: 0, end: 0.2 },
      { label: 'Q2', start: 0.2, end: 0.4 },
      { label: 'Q3', start: 0.4, end: 0.6 },
      { label: 'Q4', start: 0.6, end: 0.8 },
      { label: 'Q5 (lowest pred)', start: 0.8, end: 1.0 },
    ];

    console.log(`\n  Quintile breakdown:`);
    console.log(`  ${'Quintile'.padEnd(25)} ${'N'.padStart(5)} ${'σ'.padStart(6)} ${'Boom%'.padStart(7)} ${'Bust%'.padStart(7)} ${'PredRange'.padStart(14)}`);

    for (const q of quintiles) {
      const qRows = withResidual.slice(Math.round(n * q.start), Math.round(n * q.end));
      if (qRows.length === 0) continue;
      const residuals = qRows.map(r => r.residual);
      const mean = residuals.reduce((s, r) => s + r, 0) / residuals.length;
      const std = Math.sqrt(residuals.reduce((s, r) => s + (r - mean) ** 2, 0) / residuals.length);
      const booms = qRows.filter(r => r.residual > boomThresh).length;
      const busts = qRows.filter(r => r.residual < -boomThresh).length;
      const minPred = Math.min(...qRows.map(r => r.predictedPPG));
      const maxPred = Math.max(...qRows.map(r => r.predictedPPG));

      console.log(`  ${q.label.padEnd(25)} ${String(qRows.length).padStart(5)} ${std.toFixed(2).padStart(6)} ${(booms / qRows.length * 100).toFixed(1).padStart(6)}% ${(busts / qRows.length * 100).toFixed(1).padStart(6)}% ${`${minPred.toFixed(1)}-${maxPred.toFixed(1)}`.padStart(14)}`);
    }

    // Draft capital analysis: do late-round picks have higher variance?
    console.log(`\n  By draft capital (logDraftPick):`);
    const withDraft = withResidual.filter(r => r.features?.logDraftPick);
    if (withDraft.length > 0) {
      withDraft.sort((a, b) => (a.features!.logDraftPick || 0) - (b.features!.logDraftPick || 0));
      const draftBins = [
        { label: 'Rd 1 (pick 1-32)', rows: withDraft.filter(r => Math.exp(r.features!.logDraftPick || 0) <= 32) },
        { label: 'Rd 2-3 (33-100)', rows: withDraft.filter(r => { const p = Math.exp(r.features!.logDraftPick || 0); return p > 32 && p <= 100; }) },
        { label: 'Rd 4-7 (101+)', rows: withDraft.filter(r => Math.exp(r.features!.logDraftPick || 0) > 100) },
      ];

      console.log(`  ${'Draft Tier'.padEnd(25)} ${'N'.padStart(5)} ${'σ'.padStart(6)} ${'Boom%'.padStart(7)} ${'Bust%'.padStart(7)} ${'AvgPred'.padStart(8)} ${'AvgAct'.padStart(8)}`);
      for (const bin of draftBins) {
        if (bin.rows.length < 5) continue;
        const residuals = bin.rows.map(r => r.residual);
        const mean = residuals.reduce((s, r) => s + r, 0) / residuals.length;
        const std = Math.sqrt(residuals.reduce((s, r) => s + (r - mean) ** 2, 0) / residuals.length);
        const booms = bin.rows.filter(r => r.residual > boomThresh).length;
        const busts = bin.rows.filter(r => r.residual < -boomThresh).length;
        const avgPred = bin.rows.reduce((s, r) => s + r.predictedPPG, 0) / bin.rows.length;
        const avgAct = bin.rows.reduce((s, r) => s + r.actualPPG, 0) / bin.rows.length;

        console.log(`  ${bin.label.padEnd(25)} ${String(bin.rows.length).padStart(5)} ${std.toFixed(2).padStart(6)} ${(booms / bin.rows.length * 100).toFixed(1).padStart(6)}% ${(busts / bin.rows.length * 100).toFixed(1).padStart(6)}% ${avgPred.toFixed(1).padStart(8)} ${avgAct.toFixed(1).padStart(8)}`);
      }
    }

    // Skewness check: are residuals symmetric or do booms/busts have different tails?
    const allResiduals = withResidual.map(r => r.residual);
    const rMean = allResiduals.reduce((s, r) => s + r, 0) / allResiduals.length;
    const rStd = Math.sqrt(allResiduals.reduce((s, r) => s + (r - rMean) ** 2, 0) / allResiduals.length);
    const skewness = allResiduals.reduce((s, r) => s + ((r - rMean) / rStd) ** 3, 0) / allResiduals.length;
    const kurtosis = allResiduals.reduce((s, r) => s + ((r - rMean) / rStd) ** 4, 0) / allResiduals.length - 3;

    console.log(`\n  Distribution shape: skewness=${skewness.toFixed(3)}, excess kurtosis=${kurtosis.toFixed(3)}`);
    console.log(`  (skew>0 = right-tailed booms, skew<0 = left-tailed busts)`);
    console.log(`  (kurtosis>0 = fat tails, more extreme outcomes than normal)`);
  }

  console.log('\nDone.');
}

main();
