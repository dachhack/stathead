// StatHead ADP for a sport: the blend of every market that priced a player,
// keyed to the directory. Third-party policy: a player needs two or more
// providers to get a row, no provider's own number is returned, and the
// response carries the provider count and spread instead.

import type { AdpRow, AdpSource, CrosswalkRow, Player } from './types.js';
import { NameIndex } from './util.js';

export interface AdpBuild {
  rows: AdpRow[];
  providers: string[];
  as_of: string;
  /** Rows per provider that matched no directory player. */
  unmatched: Record<string, number>;
  /** fantasypros slug by player_id, for the crosswalk. */
  fpSlugs: Record<string, string>;
}

/** Providers that are the same market reached two ways: keep the first listed. */
const PROVIDER_DEDUPE: Record<string, string> = { 'fantasypros:espn': 'espn' };

export function blendAdp(directory: Player[], sources: AdpSource[]): AdpBuild {
  const idx = new NameIndex(directory, (p) => p.full_name);
  const byId = new Map(directory.map((p) => [p.player_id, p]));
  const espnById = new Map(directory.filter((p) => p.ids.espn_id).map((p) => [p.ids.espn_id, p]));
  const prices = new Map<string, Map<string, number>>(); // player_id → provider → adp
  const unmatched: Record<string, number> = {};
  const fpSlugs: Record<string, string> = {};
  const providers = new Set<string>();
  let as_of = '';

  const present = new Set(sources.map((s) => s.provider));
  for (const src of sources) {
    const canonical = PROVIDER_DEDUPE[src.provider];
    if (canonical && present.has(canonical)) continue; // the direct feed wins
    providers.add(src.provider);
    if (src.as_of > as_of) as_of = src.as_of;
    for (const r of src.rows) {
      let p: Player | null = null;
      if (src.provider === 'espn' && r.ref) p = espnById.get(r.ref) ?? null;
      if (!p) p = idx.resolve(r.name, r.team);
      if (!p) {
        unmatched[src.provider] = (unmatched[src.provider] ?? 0) + 1;
        continue;
      }
      let m = prices.get(p.player_id);
      if (!m) prices.set(p.player_id, (m = new Map()));
      // Two rows for one player (a two-way MLB player listed twice): keep the earlier pick.
      const cur = m.get(src.provider);
      if (cur == null || r.adp < cur) m.set(src.provider, r.adp);
      if (src.provider.startsWith('fantasypros') && r.ref) {
        const slug = /\/([a-z0-9-]+)\.php$/.exec(r.ref)?.[1];
        if (slug) fpSlugs[p.player_id] = slug;
      }
    }
  }

  const rows: AdpRow[] = [];
  for (const [player_id, m] of prices) {
    if (m.size < 2) continue;
    const vals = [...m.values()];
    const p = byId.get(player_id)!;
    rows.push({
      player_id,
      name: p.full_name,
      team: p.team,
      pos: p.pos,
      adp: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10,
      sources: vals.length,
      spread: Math.round((Math.max(...vals) - Math.min(...vals)) * 10) / 10,
    });
  }
  rows.sort((a, b) => a.adp - b.adp || b.sources - a.sources);
  return { rows, providers: [...providers], as_of, unmatched, fpSlugs };
}

export function buildCrosswalk(directory: Player[], fpSlugs: Record<string, string>): CrosswalkRow[] {
  const keys = new Set<string>();
  for (const p of directory) for (const k of Object.keys(p.ids)) keys.add(k);
  if (Object.keys(fpSlugs).length) keys.add('fantasypros_slug');
  const cols = [...keys].sort();
  return directory.map((p) => {
    const row: CrosswalkRow = { player_id: p.player_id, full_name: p.full_name };
    for (const k of cols) row[k] = k === 'fantasypros_slug' ? fpSlugs[p.player_id] ?? null : p.ids[k] ?? null;
    return row;
  });
}
