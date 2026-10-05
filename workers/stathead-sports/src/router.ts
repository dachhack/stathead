// HTTP routes for the daily-sport service.
//
//   GET  /                                  health (no auth)
//   GET  /v1/meta                           per-sport as_of, seasons, counts
//   GET  /v1/{sport}/teams                  canonical tricodes + aliases
//   GET  /v1/{sport}/games?date=YYYY-MM-DD  the slate (live from the feed, cached 60 s)
//   GET  /v1/{sport}/games?season=YYYY      the stored season calendar
//   GET  /v1/{sport}/games/{id}/lines       box score (stored final, else live from the feed)
//   GET  /v1/{sport}/players?season=YYYY    directory
//   GET  /v1/{sport}/season-lines?season=   season totals
//   GET  /v1/{sport}/adp?season=YYYY        StatHead ADP blend
//   GET  /v1/{sport}/crosswalk              ids
//   PUT  /v1/admin/store/{key}              (admin) write a bundle
//   GET  /v1/admin/store/{key}              (admin) read a bundle
//   GET  /v1/admin/keys?prefix=             (admin) list keys
//
// Every /v1 route needs `Authorization: Bearer <token>`. `?format=jsonl` or
// `?format=csv` streams the rows alone; the default JSON carries an envelope.

import { authenticate, type AuthEnv, type Principal } from './auth.js';
import { ADAPTERS, SEASON_RULE, adapterFor } from './sports/index.js';
import { KvStore, keys, type BoxShard, type Bundle, type KVNamespaceLike, type MetaBundle, type Store } from './store.js';
import type { BoxScore, Game, Sport, SportAdapter } from './types.js';
import { SPORTS } from './types.js';
import { HttpError, addDays, easternDate, nowIso } from './util.js';

export const SERVICE_VERSION = '0.1.0';

export interface Env extends AuthEnv {
  SPORTS?: KVNamespaceLike;
}

export interface Deps {
  store: Store;
  now?: () => Date;
  /** Cache for live upstream reads; the Worker passes caches.default, tests pass nothing. */
  cache?: { match(req: Request): Promise<Response | undefined>; put(req: Request, res: Response): Promise<void> };
}

type Query = URLSearchParams;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

const error = (status: number, message: string, extra: Record<string, unknown> = {}) => json({ error: message, ...extra }, status);

function flatten(row: Record<string, unknown>, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(row)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v as Record<string, unknown>, key, out);
    else out[key] = Array.isArray(v) ? v.join('|') : v;
  }
  return out;
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Envelope JSON by default; jsonl/csv emit the rows alone with the metadata in headers. */
function respond(envelope: { rows: unknown[] } & Record<string, unknown>, q: Query): Response {
  const format = q.get('format') ?? 'json';
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(envelope)) if (k !== 'rows' && (typeof v === 'string' || typeof v === 'number')) meta[`x-stathead-${k.replace(/_/g, '-')}`] = String(v);
  if (format === 'jsonl') {
    const body = envelope.rows.map((r) => JSON.stringify(r)).join('\n') + (envelope.rows.length ? '\n' : '');
    return new Response(body, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', ...meta } });
  }
  if (format === 'csv') {
    const flat = envelope.rows.map((r) => flatten(r as Record<string, unknown>));
    const cols = [...new Set(flat.flatMap((r) => Object.keys(r)))];
    const lines = [cols.join(','), ...flat.map((r) => cols.map((c) => csvEscape(r[c])).join(','))];
    return new Response(lines.join('\n') + '\n', { headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store', ...meta } });
  }
  return json({ ...envelope, count: envelope.rows.length });
}

async function cached<T>(deps: Deps, key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
  if (!deps.cache) return fn();
  const req = new Request(`https://cache.stathead-sports.internal/${encodeURIComponent(key)}`);
  const hit = await deps.cache.match(req);
  if (hit) return (await hit.json()) as T;
  const value = await fn();
  await deps.cache.put(req, new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttlSeconds}` } }));
  return value;
}

async function seasonArg(q: Query, adapter: SportAdapter, deps: Deps): Promise<number> {
  const s = q.get('season');
  if (s) {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1990 || n > 2100) throw new HttpError(400, '', 'season must be a four-digit year');
    return n;
  }
  const meta = await deps.store.get<MetaBundle>(keys.meta(adapter.sport));
  return meta?.current_season ?? adapter.currentSeason((deps.now ?? (() => new Date()))());
}

async function bundleRoute<T>(key: string, q: Query, deps: Deps, describe: string): Promise<Response> {
  const b = await deps.store.get<Bundle<T> & Record<string, unknown>>(key);
  if (!b) return error(404, `${describe} is not loaded yet`, { key });
  return respond(b, q);
}

async function gamesRoute(adapter: SportAdapter, q: Query, deps: Deps): Promise<Response> {
  const date = q.get('date');
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return error(400, 'date must be YYYY-MM-DD');
    const today = easternDate((deps.now ?? (() => new Date()))());
    const near = date >= addDays(today, -1) && date <= addDays(today, 1);
    const rows = await cached(deps, `sched:${adapter.sport}:${date}`, near ? 60 : 3600, () => adapter.schedule(date));
    return respond({ sport: adapter.sport, date, as_of: nowIso(), source: rows[0]?.source ?? adapter.sport, rows }, q);
  }
  const season = await seasonArg(q, adapter, deps);
  return bundleRoute<Game>(keys.calendar(adapter.sport, season), q, deps, `the ${adapter.sport} ${season} calendar`);
}

async function linesRoute(adapter: SportAdapter, gameId: string, q: Query, deps: Deps): Promise<Response> {
  const idx = await deps.store.get<Record<string, string>>(keys.boxIndex(adapter.sport));
  const shardKey = idx?.[gameId];
  let box: BoxScore | null = null;
  let stored = false;
  if (shardKey) {
    const shard = await deps.store.get<BoxShard>(shardKey);
    box = shard?.games[gameId] ?? null;
    stored = box != null;
  }
  if (!box) {
    // Live or not yet materialised: read the feed, cached briefly.
    box = await cached(deps, `box:${adapter.sport}:${gameId}`, 60, () => adapter.boxScore(gameId));
    if (!box) return error(404, 'game not found', { game_id: gameId });
  }
  return respond({ sport: adapter.sport, game_id: gameId, as_of: box.as_of, source: box.game.source, stored, revised_at: box.revised_at, game: box.game, rows: box.lines }, q);
}

async function metaRoute(deps: Deps, q: Query): Promise<Response> {
  const rows: MetaBundle[] = [];
  for (const sport of SPORTS) {
    const m = await deps.store.get<MetaBundle>(keys.meta(sport));
    rows.push(m ?? { sport, as_of: '', current_season: ADAPTERS[sport].currentSeason((deps.now ?? (() => new Date()))()), seasons: [], counts: {} });
  }
  return respond({ service: 'stathead-sports', version: SERVICE_VERSION, season_rule: SEASON_RULE, as_of: nowIso(), rows }, q);
}

async function adminRoute(req: Request, path: string[], q: Query, deps: Deps, who: Principal): Promise<Response> {
  if (!who.admin) return error(403, 'admin token required');
  if (path[0] === 'keys' && req.method === 'GET') return json({ keys: await deps.store.list(q.get('prefix') ?? '') });
  if (path[0] === 'store' && path.length === 2) {
    const key = decodeURIComponent(path[1]);
    if (req.method === 'GET') {
      const v = await deps.store.get(key);
      return v == null ? error(404, 'no such key', { key }) : json(v);
    }
    if (req.method === 'PUT') {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return error(400, 'body must be JSON');
      }
      await deps.store.put(key, body);
      return json({ ok: true, key });
    }
  }
  return error(404, 'no such admin route');
}

export async function handle(req: Request, env: Env, deps?: Partial<Deps>): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (path.length === 0) return json({ ok: true, service: 'stathead-sports', version: SERVICE_VERSION });
  if (path[0] !== 'v1') return error(404, 'not found');
  if (req.method !== 'GET' && req.method !== 'PUT') return error(405, 'method not allowed');

  const who = authenticate(req, env);
  if (!who) return json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer realm="stathead-sports"' });

  const store = deps?.store ?? (env.SPORTS ? new KvStore(env.SPORTS) : null);
  if (!store) return error(500, 'store is not configured');
  const d: Deps = { store, now: deps?.now, cache: deps?.cache };
  const q = url.searchParams;

  try {
    const [, head, ...rest] = path;
    if (head === 'admin') return await adminRoute(req, rest, q, d, who);
    if (req.method !== 'GET') return error(405, 'method not allowed');
    if (head === 'meta') return await metaRoute(d, q);
    const adapter = adapterFor(head);
    if (!adapter) return error(404, 'unknown sport', { sports: SPORTS });
    const sport: Sport = adapter.sport;
    switch (rest[0]) {
      case 'teams':
        return respond({ sport, as_of: nowIso(), source: 'stathead', rows: await adapter.teams() }, q);
      case 'games':
        if (rest.length === 1) return await gamesRoute(adapter, q, d);
        if (rest.length === 3 && rest[2] === 'lines') return await linesRoute(adapter, rest[1], q, d);
        return error(404, 'not found');
      case 'players':
        return await bundleRoute(keys.directory(sport, await seasonArg(q, adapter, d)), q, d, `the ${sport} directory`);
      case 'season-lines':
        return await bundleRoute(keys.seasonLines(sport, await seasonArg(q, adapter, d)), q, d, `${sport} season lines`);
      case 'adp':
        return await bundleRoute(keys.adp(sport, await seasonArg(q, adapter, d)), q, d, `${sport} ADP`);
      case 'crosswalk':
        return await bundleRoute(keys.crosswalk(sport), q, d, `the ${sport} crosswalk`);
      default:
        return error(404, 'not found');
    }
  } catch (e: any) {
    if (e instanceof HttpError && e.status === 400) return error(400, e.message.replace(/^HTTP 400 : /, ''));
    const status = e instanceof HttpError ? 502 : 500;
    return error(status, status === 502 ? 'upstream error' : 'internal error', { detail: String(e?.message ?? e).slice(0, 300) });
  }
}
