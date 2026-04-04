/**
 * Incremental feature store rebuild.
 *
 * Usage:
 *   npx tsx scripts/rebuild-features.ts                          # Full rebuild from legacy cache
 *   npx tsx scripts/rebuild-features.ts --seasons 2025           # Rebuild only 2025
 *   npx tsx scripts/rebuild-features.ts --groups college,combine # Rebuild specific groups
 *   npx tsx scripts/rebuild-features.ts --seasons 2024,2025 --groups priorStats,advanced
 *   npx tsx scripts/rebuild-features.ts --status                 # Show feature store status
 */

import { existsSync, readFileSync } from 'fs';
import {
  FeatureStoreBuilder,
  getAllGroupIds,
  getComputeOrder,
  collectDataDeps,
  getDependents,
} from '../src/lib/featureStore';
import { buildSharedContext, loadStaticData } from '../src/lib/featureStore/contextBuilder';
import { SEASONS } from '../src/lib/featureTypes';
import type { PlayerRow } from '../src/lib/featureTypes';

const STORE_PATH = 'public/data/feature-store';
const CACHE_PATH = 'public/data/training-rows-cache-v32.json';

async function main() {
  const args = process.argv.slice(2);

  // Parse CLI flags
  const flagSeasons = getFlag(args, '--seasons');
  const flagGroups = getFlag(args, '--groups');
  const showStatus = args.includes('--status');
  const fromLegacy = args.includes('--from-legacy');

  const builder = new FeatureStoreBuilder(STORE_PATH, (msg) => console.log(msg));

  // ── Status mode ──
  if (showStatus) {
    const summary = builder.getSummary();
    console.log('\nFeature Store Status');
    console.log('═'.repeat(60));
    console.log(`Total rows: ${summary.totalRows}`);
    console.log(`Groups: ${summary.groups.length}`);
    console.log();
    for (const g of summary.groups.sort((a, b) => a.id.localeCompare(b.id))) {
      console.log(`  ${g.id.padEnd(20)} ${String(g.rows).padStart(6)} rows  seasons: [${g.seasons.join(',')}]`);
    }
    return;
  }

  const start = Date.now();

  // ── From-legacy mode: populate store from existing training cache ──
  if (fromLegacy || !existsSync(`${STORE_PATH}/manifest.json`)) {
    if (!existsSync(CACHE_PATH)) {
      console.error(`No training cache at ${CACHE_PATH}. Run full build first: npx tsx scripts/precompute-features.ts`);
      process.exit(1);
    }
    console.log('Populating feature store from legacy training cache...');
    const cached = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
    builder.populateFromLegacy(cached.rows as PlayerRow[]);
    console.log(`Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);

    const summary = builder.getSummary();
    console.log(`\nFeature store: ${summary.totalRows} rows across ${summary.groups.length} groups`);
    return;
  }

  // ── Incremental rebuild mode ──
  const seasons = flagSeasons
    ? flagSeasons.split(',').map(Number).filter(n => !isNaN(n))
    : SEASONS;

  const requestedGroupIds = flagGroups
    ? flagGroups.split(',')
    : getAllGroupIds();

  // Add transitive dependents
  const dependents = getDependents(requestedGroupIds);
  const allGroupIds = [...new Set([...requestedGroupIds, ...dependents])];
  const ordered = getComputeOrder(allGroupIds);
  const dataDeps = collectDataDeps(allGroupIds);

  console.log(`\nIncremental rebuild:`);
  console.log(`  Seasons: ${seasons.join(', ')}`);
  console.log(`  Groups: ${ordered.map(g => g.def.id).join(' → ')}`);
  console.log(`  Data deps: ${[...dataDeps].join(', ')}`);
  console.log();

  // Load static data once (combine, draft, college)
  const staticData = await loadStaticData((msg) => console.log(msg));

  const store = builder.getStore();

  // Rebuild each season
  for (const season of seasons) {
    console.log(`\n── Season ${season} ──`);

    // Build full context for this season
    const ctx = await buildSharedContext({
      season,
      dataDeps,
      staticData,
      onStatus: (msg) => console.log(msg),
    });

    console.log(`  Player index: ${ctx.players.size} players`);

    // Remove old data for this season
    for (const group of ordered) {
      store.removeSeasons(group.def.id, [season]);
    }

    // Compute groups in dependency order
    for (const group of ordered) {
      // Load prior group features for derived groups
      if (group.def.groupDeps && group.def.groupDeps.length > 0) {
        const assembled = store.assembleFeatures(group.def.groupDeps);
        for (const [pk, features] of assembled) {
          const existing = ctx.priorFeatures.get(pk) || {};
          ctx.priorFeatures.set(pk, { ...existing, ...features });
        }
      }

      const result = group.compute(ctx, season);
      store.mergeShard(group.def.id, result);
      console.log(`  ${group.def.id}: ${result.size} players`);
    }

    // Save shards for this season
    for (const group of ordered) {
      store.saveShard(group.def.id, [season]);
    }

    // GC between seasons
    if (global.gc) global.gc();
  }

  store.saveManifest();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);

  const summary = builder.getSummary();
  console.log(`Feature store: ${summary.totalRows} rows across ${summary.groups.length} groups`);
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0 || idx >= args.length - 1) return undefined;
  return args[idx + 1];
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
