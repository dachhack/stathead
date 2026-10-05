// The daily bulk job: directory, calendars, season lines, ADP, crosswalk and
// box-score shards per sport, written to the Worker's store.
//
//   tsx src/jobs/daily.ts --sport nhl,nba [--season 2026] [--seasons 3] [--out ./out] [--upload] [--force]
//
// --upload writes through the Worker's admin routes (SPORTS_API_URL and
// SPORTS_ADMIN_TOKEN in the environment); --out writes the same bundles as
// JSON files for a dry run. With neither, bundles are built and summarised.
//
// History: season lines go back LINES_SEASONS per sport (five for NHL and
// MLB, whose REST reports serve them in one call; three for the box-summed
// sports), calendars and box scores back BOX_SEASONS (three), unless
// --seasons overrides both.
//
// Box scores: every final of the box-summed sports (NBA, WNBA, MLS, EPL) and
// of the NHL is materialised into monthly shards; MLB finals are 800 KB each,
// so only the last MLB_RECENT_DAYS are stored and older games are read from
// the feed on request. Stored finals are re-read for REVISIT_DAYS and a
// changed line sets revised_at.
//
// Alerting: a bundle that would shrink by more than its threshold against
// the stored one is not written, the sport is marked failed and the process
// exits 1, which turns the Actions job red. --force writes anyway.
//
// Runs under Node (tsx); the adapters themselves are runtime-neutral.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { blendAdp, buildCrosswalk } from '../adp.js';
import { ADAPTERS } from '../sports/index.js';
import { MemoryStore, keys, type AdpBundle, type BoxShard, type Bundle, type MetaBundle, type Store } from '../store.js';
import type { BoxScore, Game, Player, Sport, SportAdapter } from '../types.js';
import { SPORTS } from '../types.js';
import { addDays, easternDate, nowIso, pMap } from '../util.js';

const LINES_SEASONS: Record<Sport, number> = { nhl: 5, mlb: 5, nba: 3, wnba: 3, mls: 3, epl: 3 };
const BOX_SEASONS = 3;
const REVISIT_DAYS = 3;
const MLB_RECENT_DAYS = 30;
/** Sports whose season lines are the sum of stored final box scores. */
const SUMMED = new Set<Sport>(['nba', 'wnba', 'mls', 'epl']);
/** How much a bundle may shrink against the stored one before the job refuses to write it. */
const SHRINK_LIMIT: Record<string, number> = { directory: 0.1, calendar: 0.1, season_lines: 0.1, crosswalk: 0.1, adp: 0.3 };
/** Owner decision 2026-10-05: this partner-only feed may serve a single market's board. */
const MIN_ADP_SOURCES = 1;

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
  seasons?: number;
  out?: string;
  upload: boolean;
  skipBox: boolean;
  force: boolean;
  boxConcurrency: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { sports: [...SPORTS], upload: false, skipBox: false, force: false, boxConcurrency: 4 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--sport') ((a.sports = v.split(',').map((s) => s.trim() as Sport)), i++);
    else if (k === '--season') ((a.season = Number(v)), i++);
    else if (k === '--seasons') ((a.seasons = Number(v)), i++);
    else if (k === '--out') ((a.out = v), i++);
    else if (k === '--upload') a.upload = true;
    else if (k === '--skip-box') a.skipBox = true;
    else if (k === '--force') a.force = true;
    else if (k === '--box-concurrency') ((a.boxConcurrency = Number(v)), i++);
  }
  for (const s of a.sports) if (!SPORTS.includes(s)) throw new Error(`unknown sport ${s}`);
  return a;
}

const log = (...xs: unknown[]) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...xs);

const bundle = <T>(sport: Sport, source: string, rows: T[], season?: number): Bundle<T> => ({ sport, season, as_of: nowIso(), source, rows });

/** `nhl-8478402` → { nhl_id: '8478402' }; every other sport keys on ESPN ids. */
const idsFromPlayerId = (playerId: string): Record<string, string> => {
  const [sport, id] = playerId.split('-', 2);
  return { [sport === 'nhl' || sport === 'mlb' ? `${sport}_id` : 'espn_id']: id };
};

class ShrinkError extends Error {}

/**
 * Write a bundle unless it shrank past its threshold against the stored one.
 * A refused write keeps the old bundle in place and fails the sport.
 */
async function guardedPut<T>(store: Store, key: string, kind: string, b: Bundle<T>, force: boolean, notes: string[]): Promise<void> {
  const prev = await store.get<Bundle<unknown>>(key);
  const limit = SHRINK_LIMIT[kind] ?? 0.1;
  if (prev && Array.isArray(prev.rows) && prev.rows.length > 0) {
    const shrink = 1 - b.rows.length / prev.rows.length;
    if (shrink > limit) {
      const msg = `${kind} ${key}: ${b.rows.length} rows would replace ${prev.rows.length} (${Math.round(shrink * 100)}% fewer, limit ${Math.round(limit * 100)}%)`;
      if (!force) {
        notes.push(`REFUSED ${msg}`);
        throw new ShrinkError(msg);
      }
      notes.push(`forced ${msg}`);
    }
  }
  await store.put(key, b);
}

/**
 * Materialise finals into month shards. Fetches every eligible final in the
 * calendar that is not stored yet, re-reads finals from the last REVISIT_DAYS
 * for stat corrections (a changed line sets revised_at), and extends the
 * game → shard index.
 */
async function materialiseBoxScores(adapter: SportAdapter, season: number, calendar: Game[], store: Store, concurrency: number, index: Record<string, string>): Promise<BoxScore[]> {
  const sport = adapter.sport;
  const today = easternDate(new Date());
  const revisitFrom = addDays(today, -REVISIT_DAYS);
  const recentFrom = sport === 'mlb' ? addDays(today, -MLB_RECENT_DAYS) : null;
  const finals = calendar.filter((g) => g.status === 'final' && (recentFrom === null || g.game_date >= recentFrom));
  const byMonth = new Map<string, Game[]>();
  for (const g of finals) {
    const m = g.game_date.slice(0, 7);
    (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push(g);
  }
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
          if (JSON.stringify(prev.lines) === JSON.stringify(box.lines)) return;
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
  return all;
}

/** Anyone with a line in a season belongs in the directory, as an inactive row. */
function addLinePlayers(directory: Player[], lines: Array<{ player_id: string; name: string; team: string; pos: string; source: string }>, currentSeason: boolean): number {
  const known = new Set(directory.map((p) => p.player_id));
  let added = 0;
  for (const l of lines) {
    if (known.has(l.player_id)) continue;
    known.add(l.player_id);
    added++;
    directory.push({
      player_id: l.player_id,
      full_name: l.name,
      team: currentSeason ? l.team : '',
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
  return added;
}

async function runSport(sport: Sport, args: Args, store: Store): Promise<MetaBundle> {
  const adapter = ADAPTERS[sport];
  const season = args.season ?? adapter.currentSeason(new Date());
  const linesDepth = args.seasons ?? LINES_SEASONS[sport];
  const boxDepth = args.seasons ?? BOX_SEASONS;
  const seasons = Array.from({ length: Math.max(linesDepth, boxDepth) }, (_, i) => season - i);
  const counts: Record<string, number> = {};
  const notes: string[] = [];
  const summed = SUMMED.has(sport);
  const storesBoxes = summed || sport === 'nhl' || sport === 'mlb';
  let failed = false;

  log(`${sport}: season ${season}, lines back ${linesDepth}, boxes back ${boxDepth}`);
  const knownDebuts = (await store.get<Record<string, number>>(keys.tenure(sport))) ?? {};
  const directory = await adapter.directory(season, { debutSeasons: knownDebuts });
  const debuts: Record<string, number> = { ...knownDebuts };
  for (const p of directory) if (p.debut_season != null) debuts[p.player_id] = p.debut_season;
  if (Object.keys(debuts).length) await store.put(keys.tenure(sport), debuts);
  counts.injured = directory.filter((p) => p.injury_status).length;
  counts.exp_known = directory.filter((p) => p.exp != null).length;
  log(`  directory ${directory.length} (${counts.injured} with an injury code, ${counts.exp_known} with tenure)`);

  const boxIndex = (await store.get<Record<string, string>>(keys.boxIndex(sport))) ?? {};
  for (const s of seasons) {
    const wantBoxes = storesBoxes && !args.skipBox && season - s < boxDepth;
    const wantLines = season - s < linesDepth;
    let calendar: Game[] = [];
    if (season - s < boxDepth) {
      try {
        calendar = await adapter.calendar(s);
        await guardedPut(store, keys.calendar(sport, s), 'calendar', bundle(sport, calendar[0]?.source ?? sport, calendar, s), args.force, notes);
        counts[`calendar_${s}`] = calendar.length;
        log(`  calendar ${s}: ${calendar.length} games, ${calendar.filter((g) => g.status === 'final').length} final`);
      } catch (e: any) {
        failed = failed || e instanceof ShrinkError;
        notes.push(`calendar ${s} failed: ${e?.message ?? e}`);
        log(`  calendar ${s} failed: ${e?.message ?? e}`);
      }
    }

    let boxes: BoxScore[] = [];
    if (wantBoxes && calendar.length) {
      boxes = await materialiseBoxScores(adapter, s, calendar, store, args.boxConcurrency, boxIndex);
      counts[`box_scores_${s}`] = boxes.length;
    }
    if (!wantLines) continue;
    if (summed && !boxes.length) {
      notes.push(`season lines ${s}: no stored box scores to sum`);
      continue;
    }
    try {
      const lines = await adapter.seasonLines(s, { boxScores: async () => boxes });
      await guardedPut(store, keys.seasonLines(sport, s), 'season_lines', bundle(sport, lines[0]?.source ?? sport, lines, s), args.force, notes);
      counts[`season_lines_${s}`] = lines.length;
      log(`  season lines ${s}: ${lines.length}`);
      if (season - s <= 1) {
        const added = addLinePlayers(directory, lines, s === season);
        if (added) log(`  directory +${added} from ${s} season lines`);
      }
    } catch (e: any) {
      failed = failed || e instanceof ShrinkError;
      notes.push(`season lines ${s} failed: ${e?.message ?? e}`);
      log(`  season lines ${s} failed: ${e?.message ?? e}`);
    }
  }
  if (storesBoxes && !args.skipBox) await store.put(keys.boxIndex(sport), boxIndex);

  directory.sort((a, b) => a.full_name.localeCompare(b.full_name));
  try {
    await guardedPut(store, keys.directory(sport, season), 'directory', bundle(sport, directory[0]?.source ?? sport, directory, season), args.force, notes);
    counts[`directory_${season}`] = directory.length;
  } catch (e: any) {
    failed = true;
    log(`  directory refused: ${e?.message ?? e}`);
  }

  let providers: string[] = [];
  let unmatched: Record<string, number> = {};
  let fpSlugs: Record<string, string> = {};
  try {
    const sources = await adapter.adpSources(season);
    const adp = blendAdp(directory, sources, MIN_ADP_SOURCES);
    providers = adp.providers;
    unmatched = adp.unmatched;
    fpSlugs = adp.fpSlugs;
    const b: AdpBundle = { ...bundle(sport, 'stathead', adp.rows, season), as_of: adp.as_of || nowIso(), providers };
    if (adp.rows.length || !(await store.get(keys.adp(sport, season)))) {
      await guardedPut(store, keys.adp(sport, season), 'adp', b, args.force, notes);
    } else {
      notes.push('ADP: no market reachable today; the stored board is kept');
    }
    counts[`adp_${season}`] = adp.rows.length;
    const single = adp.rows.filter((r) => r.sources === 1).length;
    log(`  adp: ${adp.rows.length} players from ${providers.length} providers [${providers.join(', ')}], ${single} priced by one; unmatched ${JSON.stringify(unmatched)}`);
    if (providers.length === 0) notes.push('ADP: no market reachable for this sport');
    else if (providers.length === 1) notes.push(`ADP: single market (${providers[0]}); served to partners only`);
  } catch (e: any) {
    failed = failed || e instanceof ShrinkError;
    notes.push(`adp failed: ${e?.message ?? e}`);
    log(`  adp failed: ${e?.message ?? e}`);
  }

  const xw = buildCrosswalk(directory, fpSlugs);
  try {
    await guardedPut(store, keys.crosswalk(sport), 'crosswalk', bundle(sport, 'stathead', xw), args.force, notes);
    counts.crosswalk = xw.length;
    counts.crosswalk_sleeper = xw.filter((r) => r.sleeper_id).length;
  } catch (e: any) {
    failed = true;
    log(`  crosswalk refused: ${e?.message ?? e}`);
  }

  const prevMeta = await store.get<MetaBundle>(keys.meta(sport));
  const meta: MetaBundle = {
    sport,
    as_of: nowIso(),
    current_season: season,
    seasons: seasons.filter((s) => season - s < linesDepth),
    counts,
    adp_providers: providers,
    adp_unmatched: unmatched,
    injuries_as_of: prevMeta?.injuries_as_of,
    notes,
    failed,
  };
  await store.put(keys.meta(sport), meta);
  log(`${sport}: ${failed ? 'FAILED (see notes)' : 'done'} ${JSON.stringify(counts)}`);
  if (notes.length) log(`  notes: ${notes.join(' | ')}`);
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
      const m = await runSport(sport, args, store);
      results.push(m);
      if (m.failed) failed++;
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
