/**
 * Feature group registry — manages all registered groups and dependency ordering.
 *
 * Groups are registered at import time. The registry provides:
 * - Topological ordering based on groupDeps
 * - Lookup by ID or feature key
 * - Dependency-aware invalidation (changing one group invalidates dependents)
 */

import type { FeatureGroup, DataDep, ComputePlan } from './types';

const groups = new Map<string, FeatureGroup>();

/** Register a feature group */
export function registerGroup(group: FeatureGroup): void {
  if (groups.has(group.def.id)) {
    throw new Error(`Feature group '${group.def.id}' is already registered`);
  }
  groups.set(group.def.id, group);
}

/** Get a group by ID */
export function getGroup(id: string): FeatureGroup {
  const g = groups.get(id);
  if (!g) throw new Error(`Feature group '${id}' not found`);
  return g;
}

/** Get all registered groups */
export function getAllGroups(): FeatureGroup[] {
  return [...groups.values()];
}

/** Get all registered group IDs */
export function getAllGroupIds(): string[] {
  return [...groups.keys()];
}

/**
 * Topological sort: returns groups in dependency order.
 * Groups with no dependencies come first; derived groups come after
 * the groups they depend on.
 */
export function getComputeOrder(groupIds?: string[]): FeatureGroup[] {
  const ids = groupIds ? new Set(groupIds) : new Set(groups.keys());

  // If specific groups are requested, add their transitive dependencies
  if (groupIds) {
    const addDeps = (id: string) => {
      const g = groups.get(id);
      if (!g) return;
      for (const dep of g.def.groupDeps || []) {
        if (!ids.has(dep)) {
          ids.add(dep);
          addDeps(dep);
        }
      }
    };
    for (const id of groupIds) addDeps(id);
  }

  const visited = new Set<string>();
  const result: FeatureGroup[] = [];

  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const g = groups.get(id);
    if (!g) return;
    for (const dep of g.def.groupDeps || []) {
      if (ids.has(dep)) visit(dep);
    }
    result.push(g);
  };

  for (const id of ids) visit(id);
  return result;
}

/**
 * Find all groups that transitively depend on the given group IDs.
 * Used for invalidation: if group X changes, all groups depending on X
 * must also be recomputed.
 */
export function getDependents(groupIds: string[]): string[] {
  const dirty = new Set(groupIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, g] of groups) {
      if (dirty.has(id)) continue;
      const deps = g.def.groupDeps || [];
      if (deps.some(d => dirty.has(d))) {
        dirty.add(id);
        changed = true;
      }
    }
  }
  // Return only the dependents, not the original groups
  return [...dirty].filter(id => !groupIds.includes(id));
}

/**
 * Collect all DataDeps needed by a set of groups.
 */
export function collectDataDeps(groupIds: string[]): Set<DataDep> {
  const deps = new Set<DataDep>();
  for (const id of groupIds) {
    const g = groups.get(id);
    if (!g) continue;
    for (const d of g.def.dataDeps) deps.add(d);
  }
  return deps;
}

/**
 * Build a compute plan: determine which groups and seasons need recomputation.
 */
export function buildComputePlan(opts: {
  requestedGroups?: string[];
  requestedSeasons: number[];
  existingSeasons: (groupId: string) => number[];
}): ComputePlan {
  // Determine which groups to compute
  let groupIds: string[];
  if (opts.requestedGroups && opts.requestedGroups.length > 0) {
    // Specific groups + their dependents
    const dependents = getDependents(opts.requestedGroups);
    groupIds = [...opts.requestedGroups, ...dependents];
  } else {
    // All groups
    groupIds = getAllGroupIds();
  }

  const ordered = getComputeOrder(groupIds);
  const dataDeps = collectDataDeps(groupIds);

  return {
    groups: ordered,
    seasons: opts.requestedSeasons,
    dataDeps,
  };
}

/**
 * Reverse lookup: which group produces a given feature key?
 */
export function getGroupForFeatureKey(key: string): string | undefined {
  for (const [id, g] of groups) {
    if (g.def.featureKeys.includes(key)) return id;
  }
  return undefined;
}
