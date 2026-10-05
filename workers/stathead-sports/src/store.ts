// The store: one KV namespace of JSON bundles written by the daily job and
// read by the router. A Node in-memory implementation backs tests and the job.

import type { AdpRow, BoxScore, CrosswalkRow, Game, Player, SeasonLine, Sport } from './types.js';

export interface Store {
  get<T = unknown>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface KVNamespaceLike {
  get(key: string, type: 'text'): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  list(opts: { prefix: string; cursor?: string }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }>;
}

export class KvStore implements Store {
  constructor(private kv: KVNamespaceLike) {}
  async get<T>(key: string): Promise<T | null> {
    const s = await this.kv.get(key, 'text');
    return s == null ? null : (JSON.parse(s) as T);
  }
  put(key: string, value: unknown) {
    return this.kv.put(key, JSON.stringify(value));
  }
  async list(prefix: string) {
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({ prefix, cursor });
      out.push(...page.keys.map((k) => k.name));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return out;
  }
}

export class MemoryStore implements Store {
  data = new Map<string, string>();
  async get<T>(key: string): Promise<T | null> {
    const s = this.data.get(key);
    return s == null ? null : (JSON.parse(s) as T);
  }
  async put(key: string, value: unknown) {
    this.data.set(key, JSON.stringify(value));
  }
  async list(prefix: string) {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
}

export interface Bundle<T> {
  sport: Sport;
  season?: number;
  as_of: string;
  source: string;
  rows: T[];
}

export interface MetaBundle {
  sport: Sport;
  as_of: string;
  current_season: number;
  seasons: number[];
  counts: Record<string, number>;
  adp_providers?: string[];
  adp_unmatched?: Record<string, number>;
  notes?: string[];
}

export interface BoxShard {
  sport: Sport;
  season: number;
  month: string;
  as_of: string;
  games: Record<string, BoxScore>;
}

export const keys = {
  meta: (sport: Sport) => `meta:${sport}`,
  directory: (sport: Sport, season: number) => `dir:${sport}:${season}`,
  seasonLines: (sport: Sport, season: number) => `sl:${sport}:${season}`,
  calendar: (sport: Sport, season: number) => `cal:${sport}:${season}`,
  adp: (sport: Sport, season: number) => `adp:${sport}:${season}`,
  crosswalk: (sport: Sport) => `xw:${sport}`,
  /** player_id → debut season, carried across runs so only new players need a bio read. */
  tenure: (sport: Sport) => `tenure:${sport}`,
  boxShard: (sport: Sport, season: number, month: string) => `box:${sport}:${season}:${month}`,
  /** game_id → shard key, so a lines request is one KV read plus one shard read. */
  boxIndex: (sport: Sport) => `boxidx:${sport}`,
};

export type DirectoryBundle = Bundle<Player>;
export type SeasonLinesBundle = Bundle<SeasonLine>;
export type CalendarBundle = Bundle<Game>;
export type AdpBundle = Bundle<AdpRow> & { providers: string[] };
export type CrosswalkBundle = Bundle<CrosswalkRow>;
