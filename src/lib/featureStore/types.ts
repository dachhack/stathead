/**
 * Feature Store types — defines the core interfaces for modular feature computation.
 *
 * Each feature group declares what it produces (featureKeys), what data it needs
 * (dataDeps), and what other groups it depends on (groupDeps). The store persists
 * each group as a separate JSON shard, enabling incremental rebuilds.
 */

/** Unique key for a player-season observation: "normalized_name::season" */
export type PlayerKey = `${string}::${number}`;

export function makePlayerKey(name: string, season: number): PlayerKey {
  return `${name}::${season}` as PlayerKey;
}

export function parsePlayerKey(key: PlayerKey): { name: string; season: number } {
  const idx = key.lastIndexOf('::');
  return { name: key.slice(0, idx), season: Number(key.slice(idx + 2)) };
}

/**
 * Shared data dependencies that feature groups can request.
 * These map to the lookup maps currently built inside buildFeatureMatrix.
 */
export type DataDep =
  // Static (loaded once, reused across seasons)
  | 'combine'         // combine results + positional averages
  | 'draft'           // NFL draft picks
  | 'college'         // college stats, advanced, best season, ZAP features
  | 'contracts'       // player contracts
  | 'prospects'       // draft prospect grades/rankings
  | 'games'           // game-level data (for Vegas, coaching, SOS)
  // Seasonal (fetched per season)
  | 'adp'             // fantasy ADP data
  | 'currentStats'    // current season totals
  | 'priorStats'      // prior season totals
  | 'priorSnaps'      // prior season snap counts
  | 'injuries'        // prior + preseason injuries
  | 'ngs'             // Next Gen Stats (rec, rush, pass)
  | 'pbp'             // play-by-play data
  | 'participation'   // PBP participation/routes
  | 'rosters'         // current + prior rosters
  | 'depthCharts';    // depth chart data

/**
 * Scope of a feature group:
 * - 'static': Features derived from data that doesn't change per season
 *   (combine, draft, college). Computed once per player.
 * - 'seasonal': Features that depend on per-season data (prior stats,
 *   PBP, injuries, etc.). Must be recomputed when the season changes.
 */
export type FeatureScope = 'static' | 'seasonal';

/**
 * Definition of a feature group — what it produces and needs.
 */
export interface FeatureGroupDef {
  /** Unique group ID, e.g. 'combine', 'priorStats', 'college' */
  id: string;

  /** Human-readable label */
  label: string;

  /** Feature keys this group produces */
  featureKeys: string[];

  /** Data dependencies: which SharedContext data this group reads */
  dataDeps: DataDep[];

  /** Other group IDs whose output this group reads (for derived features) */
  groupDeps?: string[];

  /** Whether features are static (per-player) or seasonal (per-player-season) */
  scope: FeatureScope;

  /** Optional position filter — if set, only computes for these positions */
  positions?: string[];
}

/**
 * Player info available to feature groups during computation.
 * One entry per player that should receive features for this season.
 */
export interface PlayerInfo {
  /** Display name */
  name: string;
  /** Normalized name (for lookups) */
  normalName: string;
  /** Position */
  position: string;
  /** Season */
  season: number;
  /** ADP (fantasy or draft-pick proxy) */
  adp: number;
  /** Team abbreviation (current season) */
  team: string;
}

/**
 * The compute function each group implements.
 * Returns a map of PlayerKey → partial feature record.
 */
export type FeatureGroupCompute = (
  ctx: SharedContext,
  season: number,
) => Map<PlayerKey, Record<string, number>>;

/**
 * A registered feature group: definition + compute function.
 */
export interface FeatureGroup {
  def: FeatureGroupDef;
  compute: FeatureGroupCompute;
}

/**
 * Manifest entry for a single group shard.
 */
export interface ManifestGroupEntry {
  /** Seasons that have been computed */
  seasons: number[];
  /** When this group was last computed */
  computedAt: string;
  /** Number of player-season entries */
  rowCount: number;
}

/**
 * Manifest tracking what has been computed and when.
 * Persisted as feature-store/manifest.json.
 */
export interface StoreManifest {
  version: number;
  createdAt: string;
  lastUpdated: string;
  groups: Record<string, ManifestGroupEntry>;
}

/**
 * SharedContext: the data environment available to all feature groups.
 * Built by the context builder from raw data fetches.
 */
export interface SharedContext {
  /** Player index for the current season: PlayerKey → PlayerInfo */
  players: Map<PlayerKey, PlayerInfo>;

  /** All lookup maps, keyed by DataDep */
  data: SharedContextData;

  /** Features computed by prior groups (for derived groups) */
  priorFeatures: Map<PlayerKey, Record<string, number>>;
}

/**
 * Raw data lookup maps shared across feature groups.
 * This replaces the dozens of local variables in buildFeatureMatrix.
 */
export interface SharedContextData {
  // Static lookups (loaded once)
  combineByName: Map<string, any>;
  combineAvg: Map<string, Record<string, number>>;
  // Roster-listed physicals (height in inches, weight in lbs) by normalized
  // name. Sourced from nflverse rosters when combine data is unavailable.
  rosterPhysicalsByName: Map<string, { weight: number; heightIn: number }>;
  draftByName: Map<string, any>;
  contractByName: Map<string, any>;
  collegeByName: Map<string, Map<string, number>>;
  collegeAdvancedByName: Map<string, any>;
  collegeBestSeasonByName: Map<string, any>;
  collegeZapByName: Map<string, any>;
  collegePerGameByName: Map<string, any>;
  teammateScoreByName: Map<string, number>;
  speedScoreByName: Map<string, number>;
  collegeAvgByPos: Map<string, Record<string, number>>;
  prospectByName: Map<string, any>;
  collegeSOS: Map<string, number>;
  coachBySeasonTeam: Map<string, string>;
  vegasBySeasonTeam: Map<string, any>;
  vegasSeasonProps: Map<string, any>;

  // Seasonal lookups (rebuilt per season)
  currentByName: Map<string, any>;
  priorByName: Map<string, any>;
  advByName: Map<string, any>;
  snapAccum: Map<string, any>;
  injuryByName: Map<string, any>;
  preseasonInjuryByName: Map<string, any>;
  ngsRecByName: Map<string, any>;
  ngsRushByName: Map<string, any>;
  ngsPassByName: Map<string, any>;
  pbpByTeam: Map<string, any>;
  schemeByTeam: Map<string, any>;
  personnelByTeam: Map<string, any>;
  routesByName: Map<string, any>;
  depthChartByName: Map<string, any>;
  rosterByTeam: Map<string, any>;
  priorRosterByTeam: Map<string, any>;
  playerTeamMap: Map<string, string>;
  /** Normalized name → position, built from current + prior rosters.
   *  Broader than priorByName (which is limited to players who played last
   *  season) — use this when looking up positions for PBP targets, route
   *  aggregations, or any play-level data that references players by name. */
  playerPositionMap: Map<string, string>;
  /** gsis_id → position, built from current + prior rosters. PREFERRED
   *  over playerPositionMap when joining on PBP data, because PBP uses
   *  an abbreviated name format (e.g. "Mi.Carter") that doesn't match
   *  rosters' full_name. PBP's receiver_player_id / rusher_player_id
   *  fields ARE the gsis_id and join cleanly. */
  gsisToPositionMap: Map<string, string>;
  vorReplacement: Record<string, number>;

  // Cross-season state
  playerHistoryMap: Map<string, any[]>;
}

/**
 * Options for the feature store builder.
 */
export interface FeatureStoreOptions {
  /** Path to the feature-store directory */
  storePath: string;
  /** Seasons to compute (empty = use existing cache) */
  seasons: number[];
  /** Specific groups to recompute (empty = all) */
  groups?: string[];
  /** Prediction season (for 2026 prospect data) */
  predictSeason: number;
  /** Status callback */
  onStatus?: (msg: string) => void;
}

/**
 * Compute plan: what needs to be rebuilt.
 */
export interface ComputePlan {
  /** Groups to recompute (in dependency order) */
  groups: FeatureGroup[];
  /** Seasons to recompute */
  seasons: number[];
  /** Data deps needed for the plan */
  dataDeps: Set<DataDep>;
}
