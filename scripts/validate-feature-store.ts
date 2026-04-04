/**
 * Validate feature store output matches legacy training cache.
 *
 * Usage: npx tsx scripts/validate-feature-store.ts
 *
 * Loads both the legacy training-rows-cache and the feature store,
 * assembles PlayerRow[] from the store, and compares feature-by-feature.
 */

import { existsSync, readFileSync } from 'fs';
import { FeatureStoreBuilder } from '../src/lib/featureStore';
import { normalizeName } from '../src/lib/featureTypes';
import type { PlayerRow } from '../src/lib/featureTypes';

const STORE_PATH = 'public/data/feature-store';
const CACHE_PATH = existsSync('public/data/training-rows-cache-v32.json')
  ? 'public/data/training-rows-cache-v32.json'
  : 'public/data/training-rows-cache-v31.json';

function main() {
  if (!existsSync(CACHE_PATH)) {
    console.error(`Legacy cache not found: ${CACHE_PATH}`);
    process.exit(1);
  }
  if (!existsSync(`${STORE_PATH}/manifest.json`)) {
    console.error(`Feature store not found: ${STORE_PATH}/manifest.json`);
    console.error('Run: npx tsx scripts/rebuild-features.ts --from-legacy');
    process.exit(1);
  }

  console.log('Loading legacy cache...');
  const legacy = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
  const legacyRows: PlayerRow[] = legacy.rows;
  console.log(`  ${legacyRows.length} legacy rows`);

  console.log('Loading feature store...');
  const builder = new FeatureStoreBuilder(STORE_PATH);
  const storeRows = builder.assemblePlayerRows();
  console.log(`  ${storeRows.length} store rows`);

  // Build lookup maps
  const legacyByKey = new Map<string, PlayerRow>();
  for (const row of legacyRows) {
    const key = `${normalizeName(row.name)}::${row.season}`;
    legacyByKey.set(key, row);
  }

  const storeByKey = new Map<string, PlayerRow>();
  for (const row of storeRows) {
    const key = `${normalizeName(row.name)}::${row.season}`;
    storeByKey.set(key, row);
  }

  // Compare
  let matched = 0;
  let missingInStore = 0;
  let missingInLegacy = 0;
  const featureDiffs: Record<string, { mismatches: number; maxDiff: number; examples: string[] }> = {};
  let totalFeatureDiffs = 0;

  for (const [key, legacyRow] of legacyByKey) {
    const storeRow = storeByKey.get(key);
    if (!storeRow) {
      missingInStore++;
      continue;
    }
    matched++;

    // Compare features
    for (const [featureKey, legacyVal] of Object.entries(legacyRow.features)) {
      const storeVal = storeRow.features[featureKey];
      if (storeVal === undefined) {
        // Feature not in store — track it
        if (!featureDiffs[featureKey]) {
          featureDiffs[featureKey] = { mismatches: 0, maxDiff: 0, examples: [] };
        }
        featureDiffs[featureKey].mismatches++;
        totalFeatureDiffs++;
        continue;
      }

      const diff = Math.abs(legacyVal - storeVal);
      if (diff > 0.01) {
        if (!featureDiffs[featureKey]) {
          featureDiffs[featureKey] = { mismatches: 0, maxDiff: 0, examples: [] };
        }
        featureDiffs[featureKey].mismatches++;
        featureDiffs[featureKey].maxDiff = Math.max(featureDiffs[featureKey].maxDiff, diff);
        if (featureDiffs[featureKey].examples.length < 3) {
          const [name] = key.split('::');
          featureDiffs[featureKey].examples.push(
            `${name}: legacy=${legacyVal.toFixed(2)} store=${storeVal.toFixed(2)}`
          );
        }
        totalFeatureDiffs++;
      }
    }
  }

  for (const key of storeByKey.keys()) {
    if (!legacyByKey.has(key)) missingInLegacy++;
  }

  // Report
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('Feature Store Validation Report');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`Players matched:      ${matched}`);
  console.log(`Missing in store:     ${missingInStore}`);
  console.log(`Extra in store:       ${missingInLegacy}`);
  console.log(`Total feature diffs:  ${totalFeatureDiffs}`);
  console.log();

  const sortedDiffs = Object.entries(featureDiffs)
    .sort(([, a], [, b]) => b.mismatches - a.mismatches);

  if (sortedDiffs.length > 0) {
    console.log('Feature Differences (>0.01 tolerance):');
    console.log('─'.repeat(60));
    for (const [key, info] of sortedDiffs.slice(0, 30)) {
      console.log(`  ${key.padEnd(35)} ${String(info.mismatches).padStart(5)} mismatches  max diff: ${info.maxDiff.toFixed(3)}`);
      for (const ex of info.examples) {
        console.log(`    └ ${ex}`);
      }
    }
    if (sortedDiffs.length > 30) {
      console.log(`  ... and ${sortedDiffs.length - 30} more features with differences`);
    }
  } else {
    console.log('✅ All features match within tolerance!');
  }

  // Summary by category
  console.log('\nDifferences by Category:');
  const categories = new Map<string, number>();
  for (const [key, info] of sortedDiffs) {
    // Infer category from feature name prefix
    let cat = 'unknown';
    if (key.startsWith('prior')) cat = 'Prior Stats';
    else if (key.startsWith('college')) cat = 'College';
    else if (key.startsWith('team')) cat = 'Team/Coaching';
    else if (key.startsWith('vegas')) cat = 'Vegas';
    else if (key.startsWith('scheme')) cat = 'Scheme';
    else if (key.startsWith('actual') || key.startsWith('pred') || key.startsWith('proj') || key.startsWith('ml')) cat = 'Projection/Share';
    else if (key.startsWith('reddit')) cat = 'Sentiment';
    else if (key.startsWith('qb')) cat = 'QB Impact';
    else if (key.includes('Injury') || key.includes('injury')) cat = 'Injury';
    categories.set(cat, (categories.get(cat) || 0) + info.mismatches);
  }
  for (const [cat, count] of [...categories].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat.padEnd(20)} ${count} diffs`);
  }
}

main();
