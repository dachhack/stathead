#!/usr/bin/env tsx
/**
 * Feature ablation sweep for the rookie career model.
 *
 * For each position (or a single position if passed as an argument),
 * trains the rookie career model once with the full feature list to
 * establish a baseline LOSO R², then retrains with each feature removed
 * one at a time and reports the delta.
 *
 * Features that HURT when removed → valuable, keep.
 * Features that help when removed → dead weight / noise, consider dropping.
 * Features that don't move R² much → marginal, safe to drop if we want to
 * simplify the model.
 *
 * Usage:
 *   npx tsx scripts/feature-ablation.ts            # sweep all positions
 *   npx tsx scripts/feature-ablation.ts RB         # sweep one position
 *   npx tsx scripts/feature-ablation.ts RB --top 5 # sweep top 5 by current importance
 *
 * Runs against the cached training rows, so it needs
 * public/data/training-rows-cache-v*.json to exist. Takes ~30-60 seconds
 * per position per feature.
 */

import { existsSync, readFileSync } from 'fs';
import { PRE_DRAFT_ROOKIE_FEATURES, FEATURES } from '../src/lib/featureTypes';
import { trainRookieCareerModels } from '../src/lib/rookieCareerModel';

// Match the CACHE_PATH used by precompute-features.ts. Bump when that bumps.
const CACHE_PATH = 'public/data/training-rows-cache-v49.json';

const POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const;
type Pos = typeof POSITIONS[number];

function main() {
  const args = process.argv.slice(2);
  const requestedPos = args.find(a => POSITIONS.includes(a as Pos)) as Pos | undefined;
  const positionsToSweep: Pos[] = requestedPos ? [requestedPos] : [...POSITIONS];

  if (!existsSync(CACHE_PATH)) {
    console.error(`Training rows cache not found at ${CACHE_PATH}.`);
    console.error('Run `npm run build:features` first to populate it.');
    process.exit(1);
  }

  console.log(`Loading training rows from ${CACHE_PATH}...`);
  const cached = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
  const rows = cached.rows as Array<{
    name: string; position: string; season: number;
    features: Record<string, number>;
  }>;
  console.log(`  Loaded ${rows.length} training rows\n`);

  // Preserve the original feature lists so we can restore after each swap.
  const originalLists: Record<string, string[]> = {};
  for (const pos of POSITIONS) {
    originalLists[pos] = [...(PRE_DRAFT_ROOKIE_FEATURES[pos] || [])];
  }

  function trainAndScore(pos: Pos, featureList: string[]): number {
    PRE_DRAFT_ROOKIE_FEATURES[pos] = featureList;
    try {
      const models = trainRookieCareerModels(rows as any, { onlyPositions: [pos] });
      return models[pos]?.cvR2 ?? 0;
    } finally {
      PRE_DRAFT_ROOKIE_FEATURES[pos] = originalLists[pos];
    }
  }

  for (const pos of positionsToSweep) {
    const baseline = originalLists[pos];
    if (!baseline || baseline.length === 0) {
      console.log(`\n=== ${pos}: no baseline feature list, skipping ===`);
      continue;
    }

    console.log(`\n=== ${pos} (n features = ${baseline.length}) ===`);
    console.log(`Baseline R² computing...`);
    const baselineR2 = trainAndScore(pos, baseline);
    console.log(`  baseline LOSO R² = ${baselineR2.toFixed(4)}\n`);

    const results: Array<{ feature: string; label: string; r2: number; delta: number }> = [];
    for (const feat of baseline) {
      const pruned = baseline.filter(f => f !== feat);
      const r2 = trainAndScore(pos, pruned);
      const delta = r2 - baselineR2;
      const label = FEATURES.find(f => f.key === feat)?.label || feat;
      results.push({ feature: feat, label, r2, delta });
      const sign = delta >= 0 ? '+' : '';
      console.log(`  − ${feat.padEnd(32)}  R²=${r2.toFixed(4)}  Δ=${sign}${delta.toFixed(4)}`);
    }

    // Sort: most-harmful-to-remove first (these are the most valuable features)
    results.sort((a, b) => a.delta - b.delta);
    console.log(`\nRanked by importance (drop impact on LOSO R²):`);
    console.log(`  VALUABLE (R² falls when removed)`);
    for (const r of results.filter(r => r.delta < -0.001)) {
      console.log(`    ${r.label.padEnd(36)}  Δ=${r.delta.toFixed(4)}`);
    }
    const neutral = results.filter(r => r.delta >= -0.001 && r.delta <= 0.001);
    if (neutral.length > 0) {
      console.log(`  NEUTRAL (within ±0.001)`);
      for (const r of neutral) {
        console.log(`    ${r.label.padEnd(36)}  Δ=${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(4)}`);
      }
    }
    const deadWeight = results.filter(r => r.delta > 0.001);
    if (deadWeight.length > 0) {
      console.log(`  DEAD WEIGHT (R² IMPROVES when removed — consider dropping)`);
      for (const r of deadWeight) {
        console.log(`    ${r.label.padEnd(36)}  Δ=+${r.delta.toFixed(4)}`);
      }
    }
  }

  console.log('\nDone.');
}

main();
