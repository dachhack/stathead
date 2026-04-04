/**
 * Browser-side feature store loader.
 *
 * Loads pre-computed feature shards from the build output.
 * Components can request specific groups or all features for a player.
 */

import { normalizeName } from './featureTypes';
import type { PlayerRow } from './featureTypes';

type PlayerKey = string; // "normalized_name::season"

/** In-memory cache of loaded shards */
const shardCache = new Map<string, Record<string, Record<string, number>>>();
const playerMetaCache = new Map<string, { displayName: string; position: string }>();
let metaLoaded = false;

function makeKey(name: string, season: number): PlayerKey {
  return `${normalizeName(name)}::${season}`;
}

/**
 * Get the base URL for feature store files.
 */
function storeBaseUrl(): string {
  const base = typeof import.meta !== 'undefined' ? import.meta.env?.BASE_URL || '/' : '/';
  return `${base}data/feature-store`;
}

/**
 * Load a single shard by group ID. Cached after first load.
 */
export async function loadShard(groupId: string): Promise<Record<string, Record<string, number>>> {
  if (shardCache.has(groupId)) return shardCache.get(groupId)!;

  const url = `${storeBaseUrl()}/${groupId}.json`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return {};
    const data = await resp.json();
    shardCache.set(groupId, data);
    return data;
  } catch {
    return {};
  }
}

/**
 * Load player metadata (display names + positions).
 */
async function loadPlayerMeta(): Promise<void> {
  if (metaLoaded) return;
  try {
    const resp = await fetch(`${storeBaseUrl()}/players.json`);
    if (resp.ok) {
      const data = await resp.json();
      for (const [key, value] of Object.entries(data)) {
        playerMetaCache.set(key, value as { displayName: string; position: string });
      }
    }
  } catch {}
  metaLoaded = true;
}

/**
 * Load multiple shards and merge features for all players.
 */
export async function loadShards(groupIds: string[]): Promise<Map<PlayerKey, Record<string, number>>> {
  const shards = await Promise.all(groupIds.map(id => loadShard(id)));
  const merged = new Map<PlayerKey, Record<string, number>>();

  for (const shard of shards) {
    for (const [key, features] of Object.entries(shard)) {
      const existing = merged.get(key) || {};
      merged.set(key, { ...existing, ...features });
    }
  }
  return merged;
}

/**
 * Get all features for a specific player-season.
 */
export async function getPlayerFeatures(
  name: string,
  season: number,
  groupIds: string[],
): Promise<Record<string, number>> {
  const key = makeKey(name, season);
  const features: Record<string, number> = {};
  for (const groupId of groupIds) {
    const shard = await loadShard(groupId);
    const playerFeatures = shard[key];
    if (playerFeatures) Object.assign(features, playerFeatures);
  }
  return features;
}

/**
 * All available feature group IDs.
 */
export const ALL_GROUPS = [
  'profile', 'combine', 'college', 'contract', 'aging',
  'priorStats', 'advanced', 'ngs', 'injuries', 'routes',
  'competition', 'coaching', 'vegas', 'momentum', 'interaction',
  'qbImpact', 'consistency', 'environment', 'projection', 'sentiment',
] as const;

/** Groups used by the ADP hit/bust model */
export const ADP_MODEL_GROUPS = ALL_GROUPS;

/** Groups used by the rookie career model */
export const ROOKIE_CAREER_GROUPS = ['profile', 'combine', 'college'] as const;

/** Groups used by the KTC dynasty model */
export const KTC_MODEL_GROUPS = [
  'profile', 'combine', 'priorStats', 'injuries', 'competition',
  'coaching', 'projection',
] as const;

/**
 * Assemble PlayerRow[] from feature store shards.
 * This is the browser equivalent of FeatureStoreBuilder.assemblePlayerRows().
 */
export async function assemblePlayerRows(groupIds?: string[]): Promise<PlayerRow[]> {
  const groups = groupIds || [...ALL_GROUPS];
  await loadPlayerMeta();
  const [allFeatures, metaShard] = await Promise.all([
    loadShards(groups),
    loadShard('_meta'),
  ]);

  const rows: PlayerRow[] = [];
  for (const [pk, features] of allFeatures) {
    const idx = pk.lastIndexOf('::');
    const name = pk.slice(0, idx);
    const season = Number(pk.slice(idx + 2));
    const meta = metaShard[pk] || {};
    const pm = playerMetaCache.get(pk);

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
 * Get features for a specific player across all their seasons.
 */
export async function getPlayerHistory(
  name: string,
  groupIds: string[],
): Promise<Array<{ season: number; features: Record<string, number> }>> {
  const normalName = normalizeName(name);
  const merged = await loadShards(groupIds);
  const results: Array<{ season: number; features: Record<string, number> }> = [];

  for (const [key, features] of merged) {
    if (key.startsWith(`${normalName}::`)) {
      const season = Number(key.split('::')[1]);
      results.push({ season, features });
    }
  }

  return results.sort((a, b) => a.season - b.season);
}

/**
 * Invalidate the shard cache (e.g., after a rebuild).
 */
export function clearShardCache(): void {
  shardCache.clear();
  playerMetaCache.clear();
  metaLoaded = false;
}
