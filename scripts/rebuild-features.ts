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
import { FeatureStoreBuilder, getAllGroupIds, getComputeOrder, collectDataDeps } from '../src/lib/featureStore';
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

    // Show summary
    const summary = builder.getSummary();
    console.log(`\nFeature store: ${summary.totalRows} rows across ${summary.groups.length} groups`);
    return;
  }

  // ── Incremental rebuild mode ──
  const seasons = flagSeasons
    ? flagSeasons.split(',').map(Number).filter(n => !isNaN(n))
    : SEASONS;

  const groupIds = flagGroups
    ? flagGroups.split(',')
    : undefined;

  console.log(`\nIncremental rebuild:`);
  console.log(`  Seasons: ${seasons.join(', ')}`);
  console.log(`  Groups: ${groupIds ? groupIds.join(', ') : 'all'}`);
  console.log();

  // Determine compute order and data deps
  const ordered = getComputeOrder(groupIds);
  const dataDeps = collectDataDeps(ordered.map(g => g.def.id));

  console.log(`Compute order: ${ordered.map(g => g.def.id).join(' → ')}`);
  console.log(`Data deps: ${[...dataDeps].join(', ')}`);
  console.log();

  // Load static data once
  const staticData = await loadStaticData((msg) => console.log(msg));

  // Rebuild for each season
  builder.rebuildGroups(
    groupIds || getAllGroupIds(),
    seasons,
    (season) => {
      // Build context synchronously from cached data
      // For full async context building, use buildSharedContext
      console.log(`  Building context for season ${season}...`);
      return {
        players: new Map(), // populated by the context builder
        data: {
          ...staticData,
          // Seasonal maps would be populated here
          currentByName: new Map(),
          priorByName: new Map(),
          advByName: new Map(),
          snapAccum: new Map(),
          injuryByName: new Map(),
          preseasonInjuryByName: new Map(),
          ngsRecByName: new Map(),
          ngsRushByName: new Map(),
          ngsPassByName: new Map(),
          pbpByTeam: new Map(),
          schemeByTeam: new Map(),
          personnelByTeam: new Map(),
          routesByName: new Map(),
          depthChartByName: new Map(),
          rosterByTeam: new Map(),
          priorRosterByTeam: new Map(),
          playerTeamMap: new Map(),
          vorReplacement: {},
        } as any,
        priorFeatures: new Map(),
      };
    },
  );

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);

  // Show summary
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
