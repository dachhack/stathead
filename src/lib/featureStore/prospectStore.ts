/**
 * Prospect feature store — persistent pre-draft features for prospects.
 *
 * Stores college stats, combine data, and computed features (ZAP, dominator, etc.)
 * per prospect. Persisted as public/data/feature-store/prospects.json.
 *
 * Data priority: prospect shard > nflverse college stats > zeros
 * This allows manual entry for prospects not in nflverse data.
 */

export interface ProspectFeatures {
  // Identity
  name: string;
  pos: string;
  school: string;
  age?: number;

  // Draft projection
  projRound?: number;
  projPick?: number;

  // Combine
  weight?: number;
  forty?: number;
  height?: number; // inches
  bench?: number;
  vertical?: number;
  broadJump?: number;
  cone?: number;
  shuttle?: number;

  // College career stats
  collegeRecYds?: number;
  collegeRecTDs?: number;
  collegeRushYds?: number;
  collegeRushTDs?: number;
  collegeReceptions?: number;
  collegeRushAtt?: number;
  collegePassYds?: number;
  collegePassTDs?: number;
  collegeTotalTDs?: number;
  collegeGames?: number;
  collegeSeasons?: number;

  // Per-game stats (computed if raw stats + games provided)
  collegeRecPerGame?: number;
  collegeYdsPerGame?: number;
  collegeTDsPerGame?: number;
  collegeRushYPC?: number;
  collegeYdsPerRec?: number;

  // Advanced (computed or manual)
  collegeDominatorRating?: number;
  collegeBreakoutAge?: number;
  collegeMarketShare?: number;
  collegeBestRecYds?: number;
  collegeBestRushYds?: number;

  // ZAP-style (computed or manual)
  collegeRecYdsPerTeamPassAtt?: number;
  collegeReceptionShare?: number;
  collegeBreakoutScore?: number;
  collegeRushProductionWR?: number;
  collegeTeammateScore?: number;
  collegeEarlyDeclare?: number;

  // Speed score (computed from weight + forty)
  speedScore?: number;
  heightAdjSpeedScore?: number;

  // Pre-draft Top-30 visits (populated from public/data/feature-store/visits.json).
  // numTop30Visits is the count of NFL teams that visited/interviewed this
  // prospect pre-draft. visitTeams lists the abbreviations so consumers can
  // check landing-spot fit. See src/lib/featureStore/groups/visits.ts.
  numTop30Visits?: number;
  visitTeams?: string[];
  visitsYear?: number;

  // Source tracking
  source?: string; // 'nflverse', 'manual', 'scraped'
  updatedAt?: string;
}

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { normalizeName } from '../featureTypes';

const STORE_DIR = 'public/data/feature-store';
const PROSPECT_FILE = join(STORE_DIR, 'prospects.json');

/**
 * Load the prospect feature store.
 */
export function loadProspectStore(): Map<string, ProspectFeatures> {
  const map = new Map<string, ProspectFeatures>();
  if (existsSync(PROSPECT_FILE)) {
    const data = JSON.parse(readFileSync(PROSPECT_FILE, 'utf-8'));
    for (const [key, value] of Object.entries(data)) {
      map.set(key, value as ProspectFeatures);
    }
  }
  return map;
}

/**
 * Save the prospect feature store.
 */
export function saveProspectStore(store: Map<string, ProspectFeatures>): void {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });
  const obj: Record<string, ProspectFeatures> = {};
  for (const [key, value] of store) {
    obj[key] = value;
  }
  writeFileSync(PROSPECT_FILE, JSON.stringify(obj, null, 2));
}

/**
 * Add or update a prospect in the store.
 * Computes derived features (per-game, speed score, early declare) from raw stats.
 */
export function upsertProspect(
  store: Map<string, ProspectFeatures>,
  prospect: ProspectFeatures,
): void {
  const key = normalizeName(prospect.name);
  const existing = store.get(key) || {} as ProspectFeatures;
  const merged = { ...existing, ...prospect };

  // Compute derived features from raw stats
  const games = merged.collegeGames || 1;
  const recYds = merged.collegeRecYds || 0;
  const rushYds = merged.collegeRushYds || 0;
  const recs = merged.collegeReceptions || 0;
  const rushAtt = merged.collegeRushAtt || 0;
  const totalTDs = merged.collegeTotalTDs ||
    ((merged.collegeRecTDs || 0) + (merged.collegeRushTDs || 0) + (merged.collegePassTDs || 0));

  if (merged.collegeGames && merged.collegeGames > 0) {
    merged.collegeRecPerGame = merged.collegeRecPerGame || Math.round(recs / games * 10) / 10;
    merged.collegeYdsPerGame = merged.collegeYdsPerGame || Math.round((recYds + rushYds) / games * 10) / 10;
    merged.collegeTDsPerGame = merged.collegeTDsPerGame || Math.round(totalTDs / games * 10) / 10;
    merged.collegeRushYPC = merged.collegeRushYPC || (rushAtt > 0 ? Math.round(rushYds / rushAtt * 10) / 10 : 0);
    merged.collegeYdsPerRec = merged.collegeYdsPerRec || (recs > 0 ? Math.round(recYds / recs * 10) / 10 : 0);
  }

  merged.collegeTotalTDs = totalTDs;

  // Speed score
  const wt = merged.weight || 0;
  const ft = merged.forty || 0;
  if (wt > 0 && ft > 0 && !merged.speedScore) {
    merged.speedScore = Math.round((wt * 200) / Math.pow(ft, 4) * 10) / 10;
  }
  // Height-adjusted speed score (for TEs)
  const ht = merged.height || 0;
  const ss = merged.speedScore || 0;
  if (ht > 0 && ss > 0 && !merged.heightAdjSpeedScore) {
    merged.heightAdjSpeedScore = Math.round(ss * (ht / 76) * 10) / 10;
  }

  // Early declare
  if (merged.collegeSeasons !== undefined && merged.collegeEarlyDeclare === undefined) {
    merged.collegeEarlyDeclare = merged.collegeSeasons <= 3 ? 1 : 0;
  }

  merged.updatedAt = new Date().toISOString();
  store.set(key, merged);
}

/**
 * Build the feature record used by the career model from prospect data.
 * Returns the same feature keys that precompute-features.ts builds.
 */
export function buildProspectFeatureRecord(
  prospect: ProspectFeatures,
  posAvg?: Record<string, number>,
): Record<string, number> {
  const projPick = prospect.projPick || 300;
  const wt = prospect.weight || posAvg?.weight || 0;
  const ft = prospect.forty || posAvg?.forty || 0;
  const ht = prospect.height || 0;
  const ss = prospect.speedScore || (wt > 0 && ft > 0 ? Math.round((wt * 200) / Math.pow(ft, 4) * 10) / 10 : 0);
  const htAdjSS = (ht > 0 && ss > 0) ? Math.round(ss * (ht / 76) * 10) / 10 : ss;
  const numSeasons = prospect.collegeSeasons || 0;
  const earlyDeclare = prospect.collegeEarlyDeclare ?? (numSeasons > 0 && numSeasons <= 3 ? 1 : 0);

  return {
    nflDraftRound: prospect.projRound || 8,
    nflDraftPick: projPick,
    logDraftPick: Math.log(projPick),
    invDraftPick: 1 / projPick,
    age: prospect.age || 0,
    yearsInLeague: 0,
    weight: wt,
    forty: ft,
    bench: prospect.bench || posAvg?.bench || 0,
    vertical: prospect.vertical || posAvg?.vertical || 0,
    broadJump: prospect.broadJump || posAvg?.broadJump || 0,
    cone: prospect.cone || posAvg?.cone || 0,
    shuttle: prospect.shuttle || posAvg?.shuttle || 0,
    speedScore: ss,
    heightAdjSpeedScore: htAdjSS,
    draftCapXSpeed: (projPick > 0 && ss > 0) ? Math.round((1 / projPick) * ss * 1000) / 1000 : 0,
    collegePassTDs: prospect.collegePassTDs || 0,
    collegeRushYds: prospect.collegeRushYds || 0,
    collegeRecYds: prospect.collegeRecYds || 0,
    collegeRecTDs: prospect.collegeRecTDs || 0,
    collegeTotalTDs: prospect.collegeTotalTDs || 0,
    collegeRecPerGame: prospect.collegeRecPerGame || 0,
    collegeRushYPC: prospect.collegeRushYPC || 0,
    collegeYdsPerRec: prospect.collegeYdsPerRec || 0,
    collegeBestRecYds: prospect.collegeBestRecYds || 0,
    collegeBestRushYds: prospect.collegeBestRushYds || 0,
    collegeSeasons: numSeasons,
    collegeEarlyDeclare: earlyDeclare,
    draftPickXEarlyDeclare: earlyDeclare * (1 / projPick),
    collegeExperiencePerAge: (prospect.age && prospect.age > 0 && (prospect.collegeGames || 0) > 0)
      ? Math.round(((prospect.collegeGames || 0) / prospect.age) * 100) / 100
      : (prospect.age && prospect.age > 0 && numSeasons > 0)
      ? Math.round(((numSeasons * 13) / prospect.age) * 100) / 100
      : 0,
    collegeDominatorRating: prospect.collegeDominatorRating || 0,
    collegeBreakoutAge: prospect.collegeBreakoutAge || 0,
    collegeMarketShare: prospect.collegeMarketShare || 0,
    collegeRecYdsPerTeamPassAtt: prospect.collegeRecYdsPerTeamPassAtt || 0,
    collegeReceptionShare: prospect.collegeReceptionShare || 0,
    collegeBreakoutScore: prospect.collegeBreakoutScore || 0,
    collegeRushProductionWR: prospect.collegeRushProductionWR || 0,
    collegeTeammateScore: prospect.collegeTeammateScore || 0,
    hasCollegeStats: (prospect.collegeRecYds || prospect.collegeRushYds || prospect.collegePassYds) ? 1 : 0,
    numTop30Visits: prospect.numTop30Visits || 0,
    hasVisitData: (prospect.numTop30Visits !== undefined && prospect.numTop30Visits > 0) ? 1 : 0,
    visitedByDraftTeam: 0, // unknown pre-draft; filled in post-draft by the visits feature group
  };
}
