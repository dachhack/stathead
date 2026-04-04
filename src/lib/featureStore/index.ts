/**
 * Feature Store — modular, incremental feature computation and persistence.
 *
 * Usage:
 *   import { FeatureStoreBuilder } from './featureStore';
 *
 *   // Populate from existing buildFeatureMatrix output:
 *   builder.populateFromLegacy(rows);
 *   builder.save();
 *
 *   // Incremental rebuild:
 *   builder.rebuildGroups(['college'], [2023, 2024, 2025]);
 *
 *   // Assemble back to PlayerRow[]:
 *   const rows = builder.assemblePlayerRows();
 */

// Register all feature groups (side-effect imports)
import './groups/profile';
import './groups/combine';
import './groups/college';
import './groups/priorStats';
import './groups/advanced';
import './groups/ngs';
import './groups/injuries';
import './groups/routes';
import './groups/competition';
import './groups/coaching';
import './groups/vegas';
import './groups/contract';
import './groups/aging';
import './groups/momentum';
import './groups/interaction';
import './groups/qbImpact';
import './groups/consistency';
import './groups/environment';
import './groups/projection';
import './groups/sentiment';

export { FeatureStore } from './store';
export { buildSharedContext, loadStaticData } from './contextBuilder';
export type { FeatureShard } from './store';
export {
  registerGroup,
  getGroup,
  getAllGroups,
  getAllGroupIds,
  getComputeOrder,
  getDependents,
  collectDataDeps,
  buildComputePlan,
  getGroupForFeatureKey,
} from './registry';
export type {
  PlayerKey,
  FeatureGroup,
  FeatureGroupDef,
  FeatureGroupCompute,
  SharedContext,
  SharedContextData,
  StoreManifest,
  FeatureStoreOptions,
  ComputePlan,
  DataDep,
  PlayerInfo,
} from './types';
export { makePlayerKey, parsePlayerKey } from './types';

import { FeatureStore } from './store';
import { getAllGroups, getAllGroupIds, getComputeOrder, getDependents } from './registry';
import type { PlayerKey, SharedContext } from './types';
import { makePlayerKey, parsePlayerKey } from './types';
import type { PlayerRow } from '../featureTypes';
import { normalizeName, FEATURES } from '../featureTypes';

/**
 * Player metadata stored alongside numeric feature shards.
 * Persisted as feature-store/players.json.
 */
interface PlayerMeta {
  displayName: string;
  position: string;
}

/**
 * High-level builder that orchestrates feature store operations.
 */
export class FeatureStoreBuilder {
  private store: FeatureStore;
  private onStatus: (msg: string) => void;
  private playerMeta: Map<PlayerKey, PlayerMeta> = new Map();

  constructor(storePath: string, onStatus?: (msg: string) => void) {
    this.store = new FeatureStore(storePath);
    this.onStatus = onStatus || (() => {});
    this.loadPlayerMeta();
  }

  getStore(): FeatureStore {
    return this.store;
  }

  // ── Player metadata persistence ─────────────────────────────────────

  private playerMetaPath(): string {
    const { join } = require('path');
    return join(this.store['storePath'], 'players.json');
  }

  private loadPlayerMeta(): void {
    const { existsSync, readFileSync } = require('fs');
    const path = this.playerMetaPath();
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      for (const [key, value] of Object.entries(data)) {
        this.playerMeta.set(key as PlayerKey, value as PlayerMeta);
      }
    }
  }

  private savePlayerMeta(): void {
    const { writeFileSync, mkdirSync, existsSync } = require('fs');
    const { dirname } = require('path');
    const path = this.playerMetaPath();
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    const obj: Record<string, PlayerMeta> = {};
    for (const [key, value] of this.playerMeta) {
      obj[key] = value;
    }
    writeFileSync(path, JSON.stringify(obj));
  }

  /**
   * Populate the feature store from existing PlayerRow[] output.
   * This is the migration bridge — takes output from the legacy
   * buildFeatureMatrix pipeline and shards it into the feature store.
   */
  populateFromLegacy(rows: PlayerRow[]): void {
    this.onStatus('Populating feature store from legacy training rows...');

    // Build a reverse lookup: feature key → group ID
    const keyToGroup = new Map<string, string>();
    for (const group of getAllGroups()) {
      for (const key of group.def.featureKeys) {
        keyToGroup.set(key, group.def.id);
      }
    }

    // Track feature keys not assigned to any group
    const unassigned = new Set<string>();

    // Shard features by group
    const shardData = new Map<string, Map<PlayerKey, Record<string, number>>>();
    for (const groupId of getAllGroupIds()) {
      shardData.set(groupId, new Map());
    }

    const seasons = new Set<number>();

    for (const row of rows) {
      const normalName = normalizeName(row.name);
      const pk = makePlayerKey(normalName, row.season);
      seasons.add(row.season);

      // Store outcome metadata in '_meta' shard
      if (!shardData.has('_meta')) shardData.set('_meta', new Map());
      shardData.get('_meta')!.set(pk, {
        adp: row.adp,
        vor: row.vor,
        rawPPG: row.rawPPG,
        isHit: row.isHit ? 1 : 0,
        isBust: row.isBust ? 1 : 0,
      });

      // Store position and display name in player metadata
      this.playerMeta.set(pk, { position: row.position, displayName: row.name });

      // Distribute features to their respective group shards
      for (const [key, value] of Object.entries(row.features)) {
        const groupId = keyToGroup.get(key);
        if (!groupId) {
          unassigned.add(key);
          continue;
        }
        const shard = shardData.get(groupId)!;
        if (!shard.has(pk)) shard.set(pk, {});
        shard.get(pk)![key] = value;
      }
    }

    // Write all shards
    for (const [groupId, data] of shardData) {
      if (data.size === 0) continue;
      this.store.mergeShard(groupId as any, data);
      this.store.saveShard(groupId, [...seasons]);
    }

    this.savePlayerMeta();
    this.store.saveManifest();

    this.onStatus(`  Feature store populated: ${rows.length} rows → ${shardData.size} shards`);
    if (unassigned.size > 0) {
      this.onStatus(`  ⚠ ${unassigned.size} feature keys not assigned to any group: ${[...unassigned].slice(0, 10).join(', ')}${unassigned.size > 10 ? '...' : ''}`);
    }
  }

  /**
   * Rebuild specific groups for specific seasons.
   * Requires a SharedContext with the necessary data loaded.
   */
  rebuildGroups(
    groupIds: string[],
    seasons: number[],
    buildContext: (season: number) => SharedContext,
  ): void {
    // Add transitive dependents
    const dependents = getDependents(groupIds);
    const allIds = [...new Set([...groupIds, ...dependents])];
    const ordered = getComputeOrder(allIds);

    this.onStatus(`Rebuilding ${ordered.length} groups for ${seasons.length} seasons...`);

    for (const season of seasons) {
      this.onStatus(`  Season ${season}...`);
      const ctx = buildContext(season);

      // Remove old data for these seasons
      for (const group of ordered) {
        this.store.removeSeasons(group.def.id, [season]);
      }

      // Compute in dependency order
      for (const group of ordered) {
        // Make prior features available for derived groups
        if (group.def.groupDeps && group.def.groupDeps.length > 0) {
          const priorGroupIds = group.def.groupDeps;
          const assembled = this.store.assembleFeatures(priorGroupIds);
          for (const [pk, features] of assembled) {
            const existing = ctx.priorFeatures.get(pk) || {};
            ctx.priorFeatures.set(pk, { ...existing, ...features });
          }
        }

        const result = group.compute(ctx, season);
        this.store.mergeShard(group.def.id, result);
        this.onStatus(`    ${group.def.id}: ${result.size} players`);
      }
    }

    // Save all updated shards
    for (const group of ordered) {
      this.store.saveShard(group.def.id, seasons);
    }
    this.store.saveManifest();
  }

  /**
   * Assemble all shards back into PlayerRow[] format.
   * This produces the same structure that downstream consumers
   * (model training, UI components) expect.
   */
  assemblePlayerRows(): PlayerRow[] {
    const groupIds = getAllGroupIds();
    const allFeatures = this.store.assembleFeatures(groupIds);
    const metaShard = this.store.loadShard('_meta');

    const rows: PlayerRow[] = [];
    for (const [pk, features] of allFeatures) {
      const { name, season } = parsePlayerKey(pk);
      const meta = metaShard[pk] || {};
      const pm = this.playerMeta.get(pk);

      rows.push({
        name: pm?.displayName || name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        position: pm?.position || (features.priorPassYards > 0 ? 'QB' : features.priorCarries > 50 ? 'RB' : 'WR'),
        season,
        adp: meta.adp || features.adp || 999,
        vor: meta.vor || 0,
        rawPPG: meta.rawPPG || 0,
        isHit: (meta.isHit || 0) === 1,
        isBust: (meta.isBust || 0) === 1,
        features,
      });
    }

    return rows;
  }

  /**
   * Get summary stats about the feature store.
   */
  getSummary(): {
    totalRows: number;
    groups: Array<{ id: string; rows: number; seasons: number[]; computedAt: string }>;
  } {
    const manifest = this.store.getManifest();
    const groups = Object.entries(manifest.groups).map(([id, entry]) => ({
      id,
      rows: entry.rowCount,
      seasons: entry.seasons,
      computedAt: entry.computedAt,
    }));
    const totalRows = Math.max(...groups.map(g => g.rows), 0);
    return { totalRows, groups };
  }
}
