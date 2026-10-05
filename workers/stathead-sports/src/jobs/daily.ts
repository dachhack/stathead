// The daily bulk job: directory, calendars, season lines, ADP, crosswalk and
// (basketball) box-score shards per sport, written to the Worker's store.
//
//   tsx src/jobs/daily.ts --sport nhl,nba [--season 2026] [--out ./out] [--upload]
//
// --upload writes through the Worker's admin routes (SPORTS_API_URL and
// SPORTS_ADMIN_TOKEN in the environment); --out writes the same bundles as
// JSON files for a dry run. With neither, bundles are built and summarised.
// Runs under Node (tsx); the adapters themselves are runtime-neutral.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { blendAdp, buildCrosswalk } from '../adp.js';
import { ADAPTERS } from '../sports/index.js';
import { MemoryStore, keys, type AdpBundle, type BoxShard, type Bundle, type MetaBundle, type Store } from '../store.js';
import type { BoxScore, Game, Sport, SportAdapter } from '../types.js';
import { SPORTS } from '../types.js';
import { addDays, easternDate, nowIso, pMap } from '../util.js';

/** Store client over the Worker's admin routes. */
class RemoteStore implements Store {
  constructor(private base: string, private token: string) {}
  private url(key: string) {
    return `${this.base.replace(/\/$/, '')}/v1/admin/store/${encodeURIComponent(key)}`;
  }
  async get<T>(key: string): Promise<T | null> {
    const res = await fetch(this.url(key), { headers: { authorization: `Bearer ${this.token}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`store get ${key}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }
  async put(key: string, value: unknown) {
    const res = await fetch(this.url(key), { method: 'PUT', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: JSON.stringify(value) });
    if (!res.ok) throw new Error(`store put ${key}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  async list(prefix: string) {
    const res = await fetch(`${this.base.replace(/\/$/, '')}/v1/admin/keys?prefix=${encodeURIComponent(prefix)}`, { headers: { authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error(`store list: HTTP ${res.status}`);
    return ((await res.json()) as { keys: string[] }).keys;
  }
}

/** JSON files in a directory; keys become file names. */
class FileStore implements Store {
  constructor(private dir: string) {}
  private file(key: string) {
    return join(this.dir, `${key.replace(/[^a-z0-9_.-]+/gi, '_')}.json`);
  }
  async get<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.file(key), 'utf8')) as T;
    } catch {
      return null;
    }
  }
  async put(key: string, value: unknown) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(key), JSON.stringify(value));
  }
  async list() {
    return [];
  }
}

interface Args {
  sports: Sport[];
  season?: number;
  out?: string;
  upload: boolean;
  skipBox: boolean;
  boxConcurrency: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { sports: [...SPORTS], upload: false, skipBox: false, boxConcurrency: 4 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--sport') ((a.sports = v.split(',').map((s) => s.trim() as Sport)), i++);
    else if (k === '--season') ((a.season = Number(v)), i++);
    else if (k === '--out') ((a.out = v), i++);
    else if (k === '--upload') a.upload = true;
    else if (k === '--skip-box') a.skipBox = true;
    else if (k === '--box-concurrency') ((a.boxConcurrency = Number(v)), i++);
  }
  for (const s of a.sports) if (!SPORTS.includes(s)) throw new Error(`unknown sport ${s}`);
  return a;
}

const log = (...xs: unknown[]) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...xs);

/** `nhl-8478402` → { nhl_id: '8478402' }; NBA and WNBA keys are ESPN ids. */
const idsFromPlayerId = (playerId: string): Record<string, string> => {
  const [sport, id] = playerId.split('-', 2);
  return { [sport === 'nhl' || sport === 'mlb' ? `${sport}_id` : 'espn_id']: id };
};

const bundle = <T>(sport: Sport, source: string, rows: T[], season?: number): Bundle<T> => ({ sport, season, as_of: nowIso(), source, rows });

/**
 * Materialise finals into month shards. Fetches every final in the calendar
 * that is not stored yet, re-reads finals from the last three days for stat
 * corrections (a changed line sets revised_at), and rewrites boxidx.
 */
async function materialiseBoxScores(adapter: SportAdapter, season: number, calendar: Game[], store: Store, concurrency: number): Promise<BoxScore[]> {
  const sport = adapter.sport;
  const today = easternDate(new Date());
  const revisitFrom = addDays(today, -3);
  const finals = calendar.filter((g) => g.status === 'final');
  const byMonth = new Map<string, Game[]>();
  for (const g of finals) {
    const m = g.game_date.slice(0, 7);
    (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push(g);
  }
  const index = (await store.get<Record<string, string>>(keys.boxIndex(sport))) ?? {};
  const all: BoxScore[] = [];
  for (const [month, games] of [...byMonth].sort()) {
    const key = keys.boxShard(sport, season, month);
    const shard: BoxShard = (await store.get<BoxShard>(key)) ?? { sport, season, month, as_of: '', games: {} };
    const todo = games.filter((g) => !shard.games[g.game_id] || g.game_date >= revisitFrom);
    if (todo.length) {
      log(`${sport} ${season} ${month}: ${todo.length} box scores to fetch (${Object.keys(shard.games).length} stored)`);
      let fetched = 0;
      let revised = 0;
      await pMap(todo, concurrency, async (g) => {
        let box: BoxScore | null = null;
        try {
          box = await adapter.boxScore(g.game_id);
        } catch (e: any) {
          log(`  ${g.game_id}: ${e?.message ?? e}`);
          return;
        }
        if (!box || box.game.status !== 'final') return;
        const prev = shard.games[g.game_id];
        if (prev) {
          const same = JSON.stringify(prev.lines) === JSON.stringify(box.lines);
          if (same) return;
          box.revised_at = nowIso();
          revised++;
        }
        shard.games[g.game_id] = box;
        fetched++;
      });
      if (fetched) {
        shard.as_of = nowIso();
        await store.put(key, shard);
        log(`  wrote ${fetched} (${revised} revised)`);
      }
    }
    for (const id of Object.keys(shard.games)) index[id] = key;
    all.push(...Object.values(shard.games));
  }
  await store.put(keys.boxIndex(sport), index);
  return all;
}

async function runSport(sport: Sport, args: Args, store: Store) {
  const adapter = ADAPTERS[sport];
  const season = args.season ?? adapter.currentSeason(new Date());
  const seasons = [season, season - 1];
  const counts: Record<string, number> = {};
  const notes: string[] = [];
  // Sports whose season lines are the sum of stored final box scores.
  const summed = sport === 'nba' || sport === 'wnba' || sport === 'mls' || sport === 'epl';

  log(`${sport}: season ${season}`);
  const directory = await adapter.directory(season);
  counts.injured = directory.filter((p) => p.injury_status).length;
  counts.exp_known = directory.filter((p) => p.exp != null).length;
  log(`  directory ${directory.length} (${counts.injured} with an injury code, ${counts.exp_known} with tenure)`);

  for (const s of seasons) {
    let calendar: Game[] = [];
    try {
      calendar = await adapter.calendar(s);
      await store.put(keys.calendar(sport, s), bundle(sport, calendar[0]?.source ?? sport, calendar, s));
      counts[`calendar_${s}`] = calendar.length;
      log(`  calendar ${s}: ${calendar.length} games, ${calendar.filter((g) => g.status === 'final').length} final`);
    } catch (e: any) {
      notes.push(`calendar ${s} failed: ${e?.message ?? e}`);
      log(`  calendar ${s} failed: ${e?.message ?? e}`);
    }

    let boxes: BoxScore[] = [];
    if (summed && !args.skipBox && calendar.length) {
      boxes = await materialiseBoxScores(adapter, s, calendar, store, args.boxConcurrency);
      counts[`box_scores_${s}`] = boxes.length;
    }
    try {
      const lines = await adapter.seasonLines(s, { boxScores: async () => boxes });
      await store.put(keys.seasonLines(sport, s), bundle(sport, lines[0]?.source ?? sport, lines, s));
      counts[`season_lines_${s}`] = lines.length;
      log(`  season lines ${s}: ${lines.length}`);
      // Anyone with a line this season or last belongs in the directory, as an inactive row.
      const known = new Set(directory.map((p) => p.player_id));
      let added = 0;
      for (const l of lines) {
        if (known.has(l.player_id)) continue;
        known.add(l.player_id);
        added++;
        directory.push({
          player_id: l.player_id,
          full_name: l.name,
          team: s === season ? l.team : '',
          pos: l.pos,
          eligible: l.pos ? [l.pos] : [],
          jersey: null,
          headshot_url: null,
          active: false,
          injury_status: null,
          injury_note: null,
          exp: null,
          debut_season: null,
          birth_date: null,
          ids: idsFromPlayerId(l.player_id),
          source: l.source,
        });
      }
      if (added) log(`  directory +${added} from ${s} season lines`);
    } catch (e: any) {
      notes.push(`season lines ${s} failed: ${e?.message ?? e}`);
      log(`  season lines ${s} failed: ${e?.message ?? e}`);
    }
  }

  directory.sort((a, b) => a.full_name.localeCompare(b.full_name));
  await store.put(keys.directory(sport, season), bundle(sport, directory[0]?.source ?? sport, directory, season));
  counts[`directory_${season}`] = directory.length;

  let providers: string[] = [];
  let unmatched: Record<string, number> = {};
  let fpSlugs: Record<string, string> = {};
  try {
    const sources = await adapter.adpSources(season);
    const adp = blendAdp(directory, sources);
    providers = adp.providers;
    unmatched = adp.unmatched;
    fpSlugs = adp.fpSlugs;
    const b: AdpBundle = { ...bundle(sport, 'stathead', adp.rows, season), as_of: adp.as_of || nowIso(), providers };
    await store.put(keys.adp(sport, season), b);
    counts[`adp_${season}`] = adp.rows.length;
    log(`  adp: ${adp.rows.length} players from ${providers.length} providers [${providers.join(', ')}]; unmatched ${JSON.stringify(unmatched)}`);
    if (providers.length < 2) notes.push(`ADP: only ${providers.length} provider(s) reachable, so no blend is served`);
  } catch (e: any) {
    notes.push(`adp failed: ${e?.message ?? e}`);
    log(`  adp failed: ${e?.message ?? e}`);
  }

  const xw = buildCrosswalk(directory, fpSlugs);
  await store.put(keys.crosswalk(sport), bundle(sport, 'stathead', xw));
  counts.crosswalk = xw.length;
  counts.crosswalk_sleeper = xw.filter((r) => r.sleeper_id).length;

  const meta: MetaBundle = { sport, as_of: nowIso(), current_season: season, seasons, counts, adp_providers: providers, adp_unmatched: unmatched, notes };
  await store.put(keys.meta(sport), meta);
  log(`${sport}: done ${JSON.stringify(counts)}`);
  return meta;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let store: Store;
  if (args.upload) {
    const base = process.env.SPORTS_API_URL;
    const token = process.env.SPORTS_ADMIN_TOKEN;
    if (!base || !token) throw new Error('--upload needs SPORTS_API_URL and SPORTS_ADMIN_TOKEN');
    store = new RemoteStore(base, token);
  } else if (args.out) {
    store = new FileStore(args.out);
  } else {
    store = new MemoryStore();
  }
  const results: MetaBundle[] = [];
  let failed = 0;
  for (const sport of args.sports) {
    try {
      results.push(await runSport(sport, args, store));
    } catch (e: any) {
      failed++;
      log(`${sport}: FAILED ${e?.stack ?? e}`);
    }
  }
  console.log(JSON.stringify(results, null, 1));
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
