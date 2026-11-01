// Hourly injury refresh. Re-reads each sport's availability feed and patches
// the injury fields of the stored directory in place, keyed by the platform
// ids the daily job already resolved (sleeper_id, fpl_id, mls_fantasy_id), so
// no name matching happens here. Runs from the Worker's cron (src/index.ts)
// and from `PUT /v1/admin/refresh-injuries`; runtime-neutral.

import * as fpl from '../sources/fpl.js';
import * as mlsf from '../sources/mlsfantasy.js';
import * as sleeper from '../sources/sleeper.js';
import { keys, type DirectoryBundle, type MetaBundle, type Store } from '../store.js';
import type { Player, Sport } from '../types.js';
import { SPORTS } from '../types.js';
import { nowIso } from '../util.js';

export interface InjuryRefreshResult {
  sport: Sport;
  season: number | null;
  matched: number;
  changed: number;
  injured: number;
  error?: string;
}

type Patch = { status: string | null; note: string | null };

/** For each sport: the ids key the feed is joined on, and a loader returning id → patch. */
const FEEDS: Record<Sport, { idField: string; load: () => Promise<Map<string, Patch>> }> = {
  nhl: { idField: 'sleeper_id', load: () => sleeperPatches('nhl') },
  mlb: { idField: 'sleeper_id', load: () => sleeperPatches('mlb') },
  nba: { idField: 'sleeper_id', load: () => sleeperPatches('nba') },
  wnba: { idField: 'sleeper_id', load: () => sleeperPatches('wnba') },
  epl: {
    idField: 'fpl_id',
    load: async () => {
      const b = await fpl.bootstrap();
      return new Map(b.elements.map((e) => [String(e.id), { status: fpl.injuryCode(e), note: e.news || null }]));
    },
  },
  mls: {
    idField: 'mls_fantasy_id',
    load: async () => {
      const ps = await mlsf.players();
      return new Map(ps.map((p) => [String(p.id), { status: mlsf.injuryCode(p), note: null }]));
    },
  },
};

async function sleeperPatches(sport: sleeper.SleeperSport): Promise<Map<string, Patch>> {
  const ps = await sleeper.players(sport);
  const out = new Map<string, Patch>();
  for (const p of ps) {
    let status = sleeper.injuryCode(p);
    if (!status && p.status === 'IR') status = 'IR';
    out.set(String(p.player_id), { status, note: p.injury_notes ?? null });
  }
  return out;
}

export async function refreshInjuries(store: Store, sports: Sport[] = SPORTS): Promise<InjuryRefreshResult[]> {
  const results: InjuryRefreshResult[] = [];
  for (const sport of sports) {
    const r: InjuryRefreshResult = { sport, season: null, matched: 0, changed: 0, injured: 0 };
    results.push(r);
    try {
      const meta = await store.get<MetaBundle>(keys.meta(sport));
      if (!meta) {
        r.error = 'no directory loaded yet';
        continue;
      }
      r.season = meta.current_season;
      const key = keys.directory(sport, meta.current_season);
      const bundle = await store.get<DirectoryBundle & { injuries_as_of?: string }>(key);
      if (!bundle) {
        r.error = 'no directory loaded yet';
        continue;
      }
      const feed = FEEDS[sport];
      const patches = await feed.load();
      for (const p of bundle.rows as Player[]) {
        const id = p.ids[feed.idField];
        const patch = id ? patches.get(id) : undefined;
        if (!patch) continue;
        r.matched++;
        // MLB IL stints come from the 40-man rosters in the daily job; the hourly
        // feed only adds or clears a day-to-day flag, never overrides an IL code.
        if (sport === 'mlb' && p.injury_status && /^IL\d+$/.test(p.injury_status) && (!patch.status || !/^IL\d+$/.test(patch.status))) continue;
        if (p.injury_status !== patch.status || (patch.note && p.injury_note !== patch.note)) {
          p.injury_status = patch.status;
          if (patch.note || !patch.status) p.injury_note = patch.note;
          r.changed++;
        }
      }
      r.injured = (bundle.rows as Player[]).filter((p) => p.injury_status).length;
      bundle.injuries_as_of = nowIso();
      await store.put(key, bundle);
      meta.injuries_as_of = bundle.injuries_as_of;
      await store.put(keys.meta(sport), meta);
    } catch (e: any) {
      r.error = String(e?.message ?? e).slice(0, 200);
    }
  }
  return results;
}
