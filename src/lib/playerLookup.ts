import { normalizeName } from './featureTypes';
import { bust } from './buildHash';

export interface CrosswalkRec {
  player_key: string;
  display_name: string;
  position: string;
  all_positions?: string[];
  all_names?: string[];
  birth_date?: string;
  college?: string;
  gsis_id?: string;
  pfr_id?: string;
  sleeper_id?: string;
  espn_id?: string;
  pff_id?: string;
  yahoo_id?: string;
  sportradar_id?: string;
  rotowire_id?: string;
  fantasy_data_id?: string;
  esb_id?: string;
  ktc_id?: number;
  is_college_only?: boolean;
  draft_class?: number;
  earliest_season?: number;
  latest_season?: number;
  aliases?: Array<{ source: string; name: string; position?: string; year?: number; via?: string }>;
  // Post-draft rookie promotion back-references: if this NFL canonical
  // record absorbed a previously-synthetic COL player, the old COL key
  // is listed here so stale downstream lookups still resolve.
  alias_keys?: string[];
}

export interface CrosswalkIndex {
  byKey: Map<string, CrosswalkRec>;      // player_key → rec (+ alias_keys fan-out)
  byNamePos: Map<string, CrosswalkRec>;  // `${norm}|${position}` → rec
  byName: Map<string, CrosswalkRec[]>;   // norm → [rec, ...] for position-agnostic lookup
  bySleeperId: Map<string, CrosswalkRec>; // sleeper_id → rec
}

let crosswalkPromise: Promise<CrosswalkIndex> | null = null;

export function loadCrosswalk(): Promise<CrosswalkIndex> {
  if (crosswalkPromise) return crosswalkPromise;
  crosswalkPromise = (async () => {
    const url = bust(`${import.meta.env.BASE_URL}data/player-crosswalk.json`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`crosswalk fetch ${resp.status}`);
    const doc = (await resp.json()) as { players?: CrosswalkRec[] };
    return buildIndex(doc.players || []);
  })();
  return crosswalkPromise;
}

function buildIndex(players: CrosswalkRec[]): CrosswalkIndex {
  const byKey = new Map<string, CrosswalkRec>();
  const byNamePos = new Map<string, CrosswalkRec>();
  const byName = new Map<string, CrosswalkRec[]>();
  const bySleeperId = new Map<string, CrosswalkRec>();
  for (const rec of players) {
    byKey.set(rec.player_key, rec);
    for (const ak of rec.alias_keys || []) byKey.set(ak, rec);
    if (rec.sleeper_id) bySleeperId.set(String(rec.sleeper_id), rec);
    const names = new Set<string>(rec.all_names || []);
    names.add(rec.display_name);
    for (const a of rec.aliases || []) if (a.name) names.add(a.name);
    const positions = new Set<string>(rec.all_positions || []);
    positions.add(rec.position);
    for (const nm of names) {
      const n = normalizeName(nm);
      if (!n) continue;
      const bucket = byName.get(n) || [];
      if (!bucket.includes(rec)) bucket.push(rec);
      byName.set(n, bucket);
      for (const p of positions) {
        const k = `${n}|${p}`;
        if (!byNamePos.has(k)) byNamePos.set(k, rec);
      }
    }
  }
  return { byKey, byNamePos, byName, bySleeperId };
}

/** Resolve a Sleeper player_id to the canonical record (exact id match). */
export function lookupBySleeperId(
  index: CrosswalkIndex,
  sleeperId: string | null | undefined,
): CrosswalkRec | null {
  if (!sleeperId) return null;
  return index.bySleeperId.get(String(sleeperId)) || null;
}

/** Resolve a player_key (or old alias_key) to the canonical record. */
export function lookupByKey(
  index: CrosswalkIndex,
  key: string | null | undefined,
): CrosswalkRec | null {
  if (!key) return null;
  return index.byKey.get(key) || null;
}

/** Resolve a (name, position) pair to a canonical record. Falls back
 *  to position-agnostic match if no position-scoped hit and the name is
 *  unambiguous across positions. Returns null on ambiguity. */
export function lookupByNamePos(
  index: CrosswalkIndex,
  name: string,
  position?: string | null,
): CrosswalkRec | null {
  const n = normalizeName(name);
  if (!n) return null;
  if (position) {
    const hit = index.byNamePos.get(`${n}|${position}`);
    if (hit) return hit;
  }
  const any = index.byName.get(n);
  if (any && any.length === 1) return any[0];
  return null;
}
