/**
 * Feature Store core — load/save/merge JSON shards + manifest.
 *
 * Each feature group is persisted as a separate JSON file in the store directory.
 * The manifest tracks which groups/seasons have been computed.
 * All files are committed to the repo for full git history.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type {
  StoreManifest,
  ManifestGroupEntry,
  PlayerKey,
} from './types';

const MANIFEST_VERSION = 1;

/**
 * A feature shard: per-group JSON file mapping PlayerKey → features.
 */
export type FeatureShard = Record<PlayerKey, Record<string, number>>;

export class FeatureStore {
  private storePath: string;
  private manifest: StoreManifest;
  private shards: Map<string, FeatureShard> = new Map();

  constructor(storePath: string) {
    this.storePath = storePath;
    this.manifest = this.loadManifest();
  }

  // ── Manifest ────────────────────────────────────────────────────────

  private manifestPath(): string {
    return join(this.storePath, 'manifest.json');
  }

  private loadManifest(): StoreManifest {
    const path = this.manifestPath();
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
    return {
      version: MANIFEST_VERSION,
      createdAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      groups: {},
    };
  }

  getManifest(): StoreManifest {
    return this.manifest;
  }

  /** Which seasons have been computed for a given group */
  getGroupSeasons(groupId: string): number[] {
    return this.manifest.groups[groupId]?.seasons ?? [];
  }

  /** Whether a group has been computed for all the requested seasons */
  isGroupComplete(groupId: string, seasons: number[]): boolean {
    const computed = new Set(this.getGroupSeasons(groupId));
    return seasons.every(s => computed.has(s));
  }

  // ── Shard I/O ───────────────────────────────────────────────────────

  private shardPath(groupId: string): string {
    return join(this.storePath, `${groupId}.json`);
  }

  /** Load a shard from disk (cached in memory after first load) */
  loadShard(groupId: string): FeatureShard {
    if (this.shards.has(groupId)) return this.shards.get(groupId)!;

    const path = this.shardPath(groupId);
    let shard: FeatureShard = {};
    if (existsSync(path)) {
      shard = JSON.parse(readFileSync(path, 'utf-8'));
    }
    this.shards.set(groupId, shard);
    return shard;
  }

  /** Merge new features into a shard (overwrites per-key) */
  mergeShard(groupId: string, newData: Map<PlayerKey, Record<string, number>>): void {
    const shard = this.loadShard(groupId);
    for (const [key, features] of newData) {
      shard[key] = features;
    }
    this.shards.set(groupId, shard);
  }

  /** Remove entries for specific seasons from a shard */
  removeSeasons(groupId: string, seasons: number[]): void {
    const seasonSet = new Set(seasons);
    const shard = this.loadShard(groupId);
    for (const key of Object.keys(shard)) {
      const seasonStr = key.split('::').pop();
      if (seasonStr && seasonSet.has(Number(seasonStr))) {
        delete shard[key as PlayerKey];
      }
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────

  /** Ensure the store directory exists */
  ensureDir(): void {
    if (!existsSync(this.storePath)) {
      mkdirSync(this.storePath, { recursive: true });
    }
  }

  /** Save a single shard and update its manifest entry */
  saveShard(groupId: string, seasons: number[]): void {
    this.ensureDir();
    const shard = this.shards.get(groupId);
    if (!shard) return;

    // Write shard
    writeFileSync(this.shardPath(groupId), JSON.stringify(shard));

    // Update manifest
    const existing = this.manifest.groups[groupId];
    const allSeasons = new Set([...(existing?.seasons ?? []), ...seasons]);
    this.manifest.groups[groupId] = {
      seasons: [...allSeasons].sort(),
      computedAt: new Date().toISOString(),
      rowCount: Object.keys(shard).length,
    };
  }

  /** Save the manifest to disk */
  saveManifest(): void {
    this.ensureDir();
    this.manifest.lastUpdated = new Date().toISOString();
    writeFileSync(this.manifestPath(), JSON.stringify(this.manifest, null, 2));
  }

  /** Save all dirty shards + manifest */
  saveAll(computedGroups: string[], seasons: number[]): void {
    for (const groupId of computedGroups) {
      this.saveShard(groupId, seasons);
    }
    this.saveManifest();
  }

  // ── Assembly ────────────────────────────────────────────────────────

  /**
   * Merge all loaded shards into a single features map per player-season.
   * Returns Map<PlayerKey, Record<string, number>> with all features combined.
   */
  assembleFeatures(groupIds: string[]): Map<PlayerKey, Record<string, number>> {
    const merged = new Map<PlayerKey, Record<string, number>>();

    for (const groupId of groupIds) {
      const shard = this.loadShard(groupId);
      for (const [key, features] of Object.entries(shard)) {
        const pk = key as PlayerKey;
        const existing = merged.get(pk) || {};
        merged.set(pk, { ...existing, ...features });
      }
    }

    return merged;
  }

  /**
   * Get all features for a specific player-season across all loaded groups.
   */
  getPlayerFeatures(playerKey: PlayerKey, groupIds: string[]): Record<string, number> {
    const features: Record<string, number> = {};
    for (const groupId of groupIds) {
      const shard = this.loadShard(groupId);
      const playerFeatures = shard[playerKey];
      if (playerFeatures) {
        Object.assign(features, playerFeatures);
      }
    }
    return features;
  }

  /** List all group IDs that have shards on disk */
  listGroups(): string[] {
    return Object.keys(this.manifest.groups);
  }
}
