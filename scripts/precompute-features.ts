// Build-time precomputation of the feature matrix.
// Run with: npx tsx scripts/precompute-features.ts
// Outputs: public/data/feature-matrix.json

import { buildFeatureMatrix } from '../src/lib/buildFeatureMatrix';
import { SEASONS, PREDICT_SEASON, POSITIONS, REPLACEMENT_RANKS } from '../src/lib/featureTypes';
import { writeFileSync, mkdirSync } from 'fs';

async function main() {
  console.log('Precomputing feature matrix...');
  const start = Date.now();

  const result = await buildFeatureMatrix({
    seasons: SEASONS,
    predictSeason: PREDICT_SEASON,
    positions: POSITIONS,
    replacementRanks: REPLACEMENT_RANKS,
    vorBasis: 'total',
    onStatus: (msg) => console.log(`  ${msg}`),
  });

  mkdirSync('public/data', { recursive: true });
  const json = JSON.stringify(result);
  writeFileSync('public/data/feature-matrix.json', json);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const sizeMB = (json.length / 1024 / 1024).toFixed(1);
  console.log(`Done in ${elapsed}s — ${result.rows.length} training rows, ${result.predRows.length} prediction rows (${sizeMB} MB)`);
}

main().catch((e) => {
  console.error('Precomputation failed:', e);
  // Don't fail the build — the app falls back to runtime computation
  process.exit(0);
});
