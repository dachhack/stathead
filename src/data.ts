import Papa from 'papaparse';
import { ROSTER_OVERRIDES_2026, ROSTER_OVERRIDES_2026_SEASON } from './rosterOverrides';
import { normalizeNameSimple as normalizeName } from './lib/nameMatch';
import type {
  PlayerStats,
  SeasonTotals,
  Game,
  SnapCount,
  CombineResult,
  DraftPick,
  Injury,
  AdvancedStats,
  PlayByPlay,
  FantasyRanking,
  FantasySeasonResult,
  EspnADPPlayer,
  FfcADPPlayer,
  SleeperTrendingPlayer,
  SleeperPlayer,
  SleeperTrendingRow,
  SleeperProjection,
  DynastyPlayer,
  DynastyPlayerHistory,
  FantasyCalcPlayer,
  NextGenStats,
  Roster,
  Contract,
  DepthChart,
  FTNCharting,
  Trade,
  QBRSeason,
  QBRWeek,
  DraftProspect,
  DraftProfile,
  CollegeStats,
  CollegeQBR,
} from './types';

const NFLVERSE_REMOTE =
  'https://github.com/nflverse/nflverse-data/releases/download';

// ── Fetch timeout wrapper ──
// All network requests use this to avoid hanging indefinitely.
const DEFAULT_TIMEOUT = 30_000;  // 30s for API calls
const LARGE_CSV_TIMEOUT = 60_000; // 60s for large CSVs (PBP, stats)

async function fetchWithTimeout(
  url: string,
  options?: RequestInit & { timeout?: number },
): Promise<Response> {
  const ms = options?.timeout ?? DEFAULT_TIMEOUT;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const { timeout: _, ...fetchOpts } = options ?? {};
    return await fetch(url, { ...fetchOpts, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${ms}ms: ${url.slice(0, 120)}`);
    }
    throw err;
  } finally {
    clearTimeout(id);
  }
}

// In production, nflverse CSVs are pre-downloaded into /data/ at build time
// as a flat directory. Locally, fetch directly from GitHub releases.
const IS_PROD = typeof window !== 'undefined' && window.location.hostname !== 'localhost';

// In Node.js (build scripts), check if local files exist in public/data/
const IS_NODE = typeof window === 'undefined';

// Base URL for committed `/data/` snapshots. In the Vite bundle this is
// `import.meta.env.BASE_URL`. Outside Vite (the MCP server / standalone scripts
// run via tsx, with no local public/data) we fetch the committed snapshots
// from GitHub raw — it serves every file uncompressed and reliably, unlike the
// Cloudflare/Pages host which gzips files over its 25 MiB asset cap (e.g. the
// ~38 MB cfbd-college-stats.json), a `.gz` path Node's fetch can't decode
// reliably. Pinned to the data branch so daily snapshot commits flow through.
// Override with STATHEAD_DATA_BASE (must end in `/` and expose `data/<file>`).
const GITHUB_RAW_DATA_BASE =
  'https://raw.githubusercontent.com/dachhack/stathead/refs/heads/claude/nfl-fantasy-workbench-6D1yd/public/';
const HOSTED_DATA_BASE =
  (IS_NODE && typeof process !== 'undefined'
    ? process.env.STATHEAD_DATA_BASE
    : undefined) ?? GITHUB_RAW_DATA_BASE;

function dataBase(): string {
  return import.meta.env?.BASE_URL ?? HOSTED_DATA_BASE;
}

/** Read a local file in Node, returns null if not found. Transparently
 *  decompresses a sibling .gz variant — the raw CSV sources are committed
 *  compressed (see scripts/pull-all-data-sources.sh). */
async function readLocalFile(filename: string): Promise<string | null> {
  if (!IS_NODE) return null;
  try {
    const fs = await import('fs');
    const path = `public/data/${filename}`;
    if (fs.existsSync(path)) {
      return fs.readFileSync(path, 'utf-8');
    }
    const gzPath = `${path}.gz`;
    if (fs.existsSync(gzPath)) {
      const zlib = await import('zlib');
      const buf = fs.readFileSync(gzPath);
      return zlib.gunzipSync(buf).toString('utf-8');
    }
  } catch {}
  return null;
}

/** Node-only committed-snapshot JSON reader (always null in the browser).
 *  The training pipeline uses this to read public/data files directly —
 *  the deterministic, immutable inputs the snapshot regime guarantees. */
export async function readLocalJson<T>(filename: string): Promise<T | null> {
  const text = await readLocalFile(filename);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// CORS proxy for KeepTradeCut (Cloudflare Worker). Deploy workers/ktc-proxy/// and set VITE_KTC_PROXY to your worker URL; defaults to the project's worker.
// NB: `import.meta.env` is undefined outside Vite (e.g. when tsx runs
// precompute-features.ts), so optional-chain it before reading the override.
const KTC_PROXY = import.meta.env?.VITE_KTC_PROXY ?? 'https://ktc-proxy.dachhack.workers.dev';

// CORS / allowlist proxy for FantasyCalc (Cloudflare Worker).
// api.fantasycalc.com returns 403 host_not_allowed to most direct browser
// requests; the worker fronts the call. Deploy workers/fc-proxy/ and set
// VITE_FC_PROXY to your worker URL; defaults to the project's worker.
const FC_PROXY = import.meta.env?.VITE_FC_PROXY ?? 'https://fc-proxy.dachhack.workers.dev';
const FC_BASE = IS_PROD ? FC_PROXY : 'https://api.fantasycalc.com';

// CORS proxy for ESPN per-player overview/news (Cloudflare Worker). Deploy
// workers/espn-news-proxy/ and set VITE_ESPN_NEWS_PROXY to your worker URL;
// defaults to the project's worker. Returns empty data if the worker is down.
const ESPN_NEWS_PROXY = import.meta.env?.VITE_ESPN_NEWS_PROXY ?? 'https://espn-news-proxy.dachhack.workers.dev';

export interface PlayerNewsItem {
  headline: string;
  description: string;
  published: string;
  link: string;
}

export interface PlayerRotowire {
  headline: string;
  story: string;
  published: string;
}

export interface PlayerFantasy {
  draftRank?: string;
  positionRank?: string;
  percentOwned?: string;
  projection?: string;
}

export interface PlayerAward {
  name: string;
  displayCount?: string;
  seasons?: string[];
}

/** A stat table: `labels`/`displayNames` are columns; each split (e.g. Regular
 *  Season / Postseason / Career) is a row of `stats` aligned to the labels. */
export interface PlayerStatistics {
  displayName?: string;
  labels: string[];
  displayNames?: string[];
  splits: { displayName: string; stats: string[] }[];
}

export interface PlayerOverview {
  news: PlayerNewsItem[];
  rotowire?: PlayerRotowire;
  fantasy?: PlayerFantasy;
  awards: PlayerAward[];
  statistics?: PlayerStatistics;
}

const optStr = (v: unknown): string | undefined => (v == null ? undefined : String(v));

function parseNews(raw: unknown): PlayerNewsItem[] {
  const arr = (Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
  return arr
    .map((a) => {
      const links = a.links as { web?: { href?: string } } | undefined;
      return {
        headline: String(a.headline ?? a.title ?? a.shortHeadline ?? ''),
        description: String(a.description ?? a.story ?? a.content ?? ''),
        published: String(a.published ?? a.lastModified ?? a.date ?? ''),
        link: String(links?.web?.href ?? a.link ?? a.url ?? ''),
      };
    })
    .filter((x) => x.headline);
}

function parseRotowire(raw: unknown): PlayerRotowire | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const headline = String(r.headline ?? '');
  const story = String(r.story ?? r.description ?? '');
  if (!headline && !story) return undefined;
  return { headline, story, published: String(r.published ?? '') };
}

function parseFantasy(raw: unknown): PlayerFantasy | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const f = raw as Record<string, unknown>;
  const out: PlayerFantasy = {
    draftRank: optStr(f.draftRank),
    positionRank: optStr(f.positionRank),
    percentOwned: optStr(f.percentOwned),
    projection: optStr(f.projection),
  };
  return Object.values(out).some((v) => v != null) ? out : undefined;
}

function parseAwards(raw: unknown): PlayerAward[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[])
    .map((a) => ({
      name: String(a.name ?? ''),
      displayCount: optStr(a.displayCount),
      seasons: Array.isArray(a.seasons) ? (a.seasons as unknown[]).map(String) : undefined,
    }))
    .filter((a) => a.name);
}

function parseStatistics(raw: unknown): PlayerStatistics | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  if (!Array.isArray(s.labels) || !Array.isArray(s.splits)) return undefined;
  const labels = (s.labels as unknown[]).map(String);
  const splits = (s.splits as Record<string, unknown>[])
    .map((sp) => ({
      displayName: String(sp.displayName ?? ''),
      stats: Array.isArray(sp.stats) ? (sp.stats as unknown[]).map(String) : [],
    }))
    .filter((sp) => sp.stats.length);
  if (!labels.length || !splits.length) return undefined;
  return {
    displayName: optStr(s.displayName),
    labels,
    displayNames: Array.isArray(s.displayNames) ? (s.displayNames as unknown[]).map(String) : undefined,
    splits,
  };
}

const EMPTY_OVERVIEW: PlayerOverview = { news: [], awards: [] };

/** ESPN player overview (recent news, latest status, fantasy outlook, awards,
 *  season/career stat splits) by ESPN athlete id, via the CORS-proxy worker.
 *  Parses defensively; returns empty data on any failure (e.g. worker not
 *  deployed). */
export async function fetchPlayerOverview(espnId: string, limit = 8): Promise<PlayerOverview> {
  try {
    const r = await fetch(`${ESPN_NEWS_PROXY}/news/${espnId}?limit=${limit}`);
    if (!r.ok) return EMPTY_OVERVIEW;
    const d = (await r.json()) as Record<string, unknown>;
    return {
      news: parseNews(d.articles ?? d.news ?? d.headlines ?? d.items),
      rotowire: parseRotowire(d.rotowire),
      fantasy: parseFantasy(d.fantasy),
      awards: parseAwards(d.awards),
      statistics: parseStatistics(d.statistics),
    };
  } catch {
    return EMPTY_OVERVIEW;
  }
}

/**
 * Inflate a `.gz` sibling's body — but only if the bytes really are still
 * gzipped.
 *
 * Hosts disagree on how they serve a file whose name ends in `.gz`. Some
 * hand back the raw gzip bytes as an opaque `application/gzip` body; others
 * tag the response `Content-Encoding: gzip`, in which case the fetch layer
 * has already inflated it by the time `response.body` is readable. Piping
 * an already-inflated body through DecompressionStream throws ("incorrect
 * header check"), and every call site here swallows the error into a
 * null/empty result — which is how a whole board's worth of model scores
 * can silently disappear on one host while working on another. Reproduced
 * end-to-end: with a host that sets Content-Encoding on the `.gz`, the
 * prospects board rendered '-' in every model column.
 *
 * So sniff the gzip magic number (0x1f 0x8b) on the first chunk and only
 * decompress when it's there. Streaming is preserved: the peeked chunk is
 * pushed back in front of the rest of the body rather than buffering the
 * whole (up to ~95 MiB inflated) file.
 */
export async function maybeGunzipStream(
  body: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader();
  const first = await reader.read();
  const head = first.value;
  const isGzip = !!head && head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
  const rest = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head && head.length) controller.enqueue(head);
      if (first.done) controller.close();
    },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close();
      else if (value) controller.enqueue(value);
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });
  if (!isGzip) return rest;
  // DecompressionStream's lib.dom writable is WritableStream<BufferSource>,
  // which doesn't unify with our ReadableStream<Uint8Array> chunk type.
  const gunzip = new DecompressionStream('gzip') as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;
  return rest.pipeThrough(gunzip);
}

/** Read a `.gz` sibling as text, inflating only when the body is still gzipped. */
export async function readMaybeGzText(body: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(await maybeGunzipStream(body)).text();
}

/**
 * True when a "successful" response is actually a host's SPA-fallback page.
 * Cloudflare Pages (and any static host without a top-level 404.html) answers
 * EVERY unmatched path with index.html and HTTP 200 — so a data file that
 * postbuild dropped (raw feature-matrix.json, the oversized CSVs) "loads"
 * as HTML, the .gz sibling is never tried, and .json()/Papa.parse fail or
 * produce garbage inside a silent catch. A real data response is never
 * text/html, so the content type is the discriminator.
 */
export function isHtmlFallback(r: Response): boolean {
  return (r.headers.get('content-type') || '').includes('text/html');
}

/** Try loading a pre-fetched JSON file from /data/. Returns null on failure. */
async function tryPreFetched<T>(filename: string): Promise<T | null> {
  // In Node, try local file first
  const localText = await readLocalFile(filename);
  if (localText) {
    try { return JSON.parse(localText) as T; } catch { return null; }
  }
  // Browser dev server (localhost) has no hosted snapshots to hit; Node and
  // prod both fetch from the resolved data base.
  if (!IS_PROD && !IS_NODE) return null;
  try {
    const base = dataBase();
    const resp = await fetchWithTimeout(`${base}data/${filename}`, { timeout: LARGE_CSV_TIMEOUT });
    if (resp.ok && !isHtmlFallback(resp)) return await resp.json();
    // Oversized files are shipped gzipped (Cloudflare Pages caps assets at
    // 25 MiB; see scripts/postbuild-pages.mjs). When the raw file is absent,
    // fall back to the .gz sibling and inflate it.
    const gz = await fetchWithTimeout(`${base}data/${filename}.gz`);
    if (gz.ok && gz.body && !isHtmlFallback(gz)) {
      return JSON.parse(await readMaybeGzText(gz.body)) as T;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch a static asset, transparently falling back to a gzipped `.gz` sibling.
 * postbuild-pages gzips oversized JSON (e.g. feature-matrix.json, ~24 MiB) and
 * drops the raw to stay under the 25 MiB host cap, so in production the raw path
 * 404s and we inflate the `.gz`. In dev the raw file is served and used directly.
 * Returns a Response so callers keep their existing `.ok` / `.json()` handling.
 */
export async function fetchMaybeGz(url: string): Promise<Response> {
  const r = await fetch(url);
  if (r.ok && !isHtmlFallback(r)) return r;
  const gz = await fetch(`${url}.gz`);
  if (gz.ok && gz.body && !isHtmlFallback(gz)) {
    const text = await readMaybeGzText(gz.body);
    return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (r.ok) {
    // Raw AND .gz both came back as the SPA fallback page — surface a real
    // miss so callers' `.ok` checks fail instead of parsing HTML.
    return new Response(null, { status: 404, statusText: 'SPA fallback (data file absent)' });
  }
  return r; // propagate the original non-OK response; callers handle !ok
}

/** Build a URL for an nflverse CSV file. In prod, serves from local /data/filename.csv */
function nflUrl(releaseSubpath: string): string {
  if (IS_PROD) {
    // Extract just the filename from paths like "player_stats/player_stats_2024.csv"
    const filename = releaseSubpath.split('/').pop()!;
    return `${import.meta.env.BASE_URL}data/${filename}`;
  }
  return `${NFLVERSE_REMOTE}/${releaseSubpath}`;
}

// nflverse renamed the player_stats release to stats_player starting ~2025
// with column renames: recent_team→team, interceptions→passing_interceptions,
// sacks→sacks_suffered, sack_yards→sack_yards_lost, dakota removed
// `dakota` is deliberately absent: it was aliased to passing_cpoe, which is a
// DIFFERENT statistic (dakota was an EPA+CPOE composite; cpoe is completion
// percentage over expected alone), so readers of `dakota` got a plausible
// number meaning something else. The unified table does not publish dakota;
// passing_cpoe is available under its own name.
const NEW_COL_MAP: Record<string, string> = {
  team: 'recent_team',
  passing_interceptions: 'interceptions',
  sacks_suffered: 'sacks',
  sack_yards_lost: 'sack_yards',
};

function normalizePlayerRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const [newCol, oldCol] of Object.entries(NEW_COL_MAP)) {
    if (newCol in row && !(oldCol in row)) {
      row[oldCol] = row[newCol];
    }
  }
  // sack_yards_lost is signed the other way round: nflverse reports it as a
  // negative (Caleb Williams 2024 = -466) where the old sack_yards was positive
  // (+466). Aliasing it straight through flipped the sign of every season we
  // serve from the new table, which silently inverts any sort on the field.
  if (typeof row.sack_yards === 'number' && row.sack_yards < 0) {
    row.sack_yards = -row.sack_yards;
  }
  return row;
}

export async function fetchPlayerStats(season: number): Promise<PlayerStats[]> {
  // In Node, try local file first
  const localText = await readLocalFile(`player_stats_${season}.csv`);
  if (localText) {
    const result = Papa.parse<PlayerStats>(localText, {
      header: true, dynamicTyping: true, skipEmptyLines: true,
    });
    const data = (result.data as unknown as Record<string, unknown>[])
      .map(normalizePlayerRow) as unknown as PlayerStats[];
    return data.filter((row) => row.season_type === 'REG');
  }

  // Try legacy release first then new stats_player release
  const urls = IS_NODE
    ? [
        `${NFLVERSE_REMOTE}/player_stats/player_stats_${season}.csv`,
        `${NFLVERSE_REMOTE}/stats_player/stats_player_week_${season}.csv`,
      ]
    : IS_PROD
    ? [
        nflUrl(`player_stats/player_stats_${season}.csv`),
        nflUrl(`stats_player/stats_player_week_${season}.csv`),
      ]
    : [
        `${NFLVERSE_REMOTE}/player_stats/player_stats_${season}.csv`,
        `${NFLVERSE_REMOTE}/stats_player/stats_player_week_${season}.csv`,
      ];

  let text = '';
  for (const url of urls) {
    const response = await fetchWithTimeout(url, { timeout: LARGE_CSV_TIMEOUT });
    if (response.ok) {
      text = await response.text();
      if (text.trim()) break;
    }
  }
  if (!text.trim()) return [];

  const result = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
  });

  // Detect new nflverse schema by column name and normalize
  if (result.data.length > 0 && 'passing_interceptions' in result.data[0]) {
    result.data.forEach(normalizePlayerRow);
  }

  // Filter to regular season only
  return (result.data as unknown as PlayerStats[]).filter((row) => row.season_type === 'REG');
}

export function aggregateToSeasonTotals(
  weeklyStats: PlayerStats[]
): SeasonTotals[] {
  const playerMap = new Map<string, SeasonTotals>();

  for (const week of weeklyStats) {
    const key = `${week.player_id}-${week.season}`;
    const existing = playerMap.get(key);

    // Milestone-game flags for bonus scoring (SFB16) — counted per weekly
    // row here because season totals can't recover them later.
    const weekPassYds = week.passing_yards || 0;
    const weekScrimYds = (week.rushing_yards || 0) + (week.receiving_yards || 0);
    const w300 = weekPassYds >= 300 ? 1 : 0;
    const w400 = weekPassYds >= 400 ? 1 : 0;
    const w100 = weekScrimYds >= 100 ? 1 : 0;
    const w200 = weekScrimYds >= 200 ? 1 : 0;

    if (!existing) {
      playerMap.set(key, {
        player_id: week.player_id,
        player_name: week.player_name,
        player_display_name: week.player_display_name,
        position: week.position,
        headshot_url: week.headshot_url,
        recent_team: week.recent_team,
        season: week.season,
        games: 1,
        completions: week.completions || 0,
        attempts: week.attempts || 0,
        passing_yards: week.passing_yards || 0,
        passing_tds: week.passing_tds || 0,
        interceptions: week.interceptions || 0,
        carries: week.carries || 0,
        rushing_yards: week.rushing_yards || 0,
        rushing_tds: week.rushing_tds || 0,
        receptions: week.receptions || 0,
        targets: week.targets || 0,
        receiving_yards: week.receiving_yards || 0,
        receiving_tds: week.receiving_tds || 0,
        fantasy_points: week.fantasy_points || 0,
        fantasy_points_ppr: week.fantasy_points_ppr || 0,
        fantasy_points_half_ppr: 0,
        rushing_fumbles_lost: week.rushing_fumbles_lost || 0,
        receiving_fumbles_lost: week.receiving_fumbles_lost || 0,
        sack_fumbles_lost: week.sack_fumbles_lost || 0,
        passing_2pt_conversions: week.passing_2pt_conversions || 0,
        rushing_2pt_conversions: week.rushing_2pt_conversions || 0,
        receiving_2pt_conversions: week.receiving_2pt_conversions || 0,
        special_teams_tds: week.special_teams_tds || 0,
        rushing_first_downs: week.rushing_first_downs || 0,
        receiving_first_downs: week.receiving_first_downs || 0,
        games_300_pass: w300,
        games_400_pass: w400,
        games_100_scrim: w100,
        games_200_scrim: w200,
      });
    } else {
      existing.games += 1;
      existing.completions += week.completions || 0;
      existing.attempts += week.attempts || 0;
      existing.passing_yards += week.passing_yards || 0;
      existing.passing_tds += week.passing_tds || 0;
      existing.interceptions += week.interceptions || 0;
      existing.carries += week.carries || 0;
      existing.rushing_yards += week.rushing_yards || 0;
      existing.rushing_tds += week.rushing_tds || 0;
      existing.receptions += week.receptions || 0;
      existing.targets += week.targets || 0;
      existing.receiving_yards += week.receiving_yards || 0;
      existing.receiving_tds += week.receiving_tds || 0;
      existing.fantasy_points += week.fantasy_points || 0;
      existing.fantasy_points_ppr += week.fantasy_points_ppr || 0;
      existing.rushing_fumbles_lost += week.rushing_fumbles_lost || 0;
      existing.receiving_fumbles_lost += week.receiving_fumbles_lost || 0;
      existing.sack_fumbles_lost += week.sack_fumbles_lost || 0;
      existing.passing_2pt_conversions += week.passing_2pt_conversions || 0;
      existing.rushing_2pt_conversions += week.rushing_2pt_conversions || 0;
      existing.receiving_2pt_conversions += week.receiving_2pt_conversions || 0;
      existing.special_teams_tds += week.special_teams_tds || 0;
      existing.rushing_first_downs = (existing.rushing_first_downs || 0) + (week.rushing_first_downs || 0);
      existing.receiving_first_downs = (existing.receiving_first_downs || 0) + (week.receiving_first_downs || 0);
      existing.games_300_pass = (existing.games_300_pass || 0) + w300;
      existing.games_400_pass = (existing.games_400_pass || 0) + w400;
      existing.games_100_scrim = (existing.games_100_scrim || 0) + w100;
      existing.games_200_scrim = (existing.games_200_scrim || 0) + w200;
      // Update team to most recent
      existing.recent_team = week.recent_team;
    }
  }

  // Calculate half PPR
  for (const player of playerMap.values()) {
    player.fantasy_points_half_ppr =
      player.fantasy_points + player.receptions * 0.5;
  }

  return Array.from(playerMap.values());
}

const FANTASY_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K'];

export function filterFantasyRelevant(players: SeasonTotals[]): SeasonTotals[] {
  return players.filter(
    (p) => FANTASY_POSITIONS.includes(p.position) && p.games >= 1
  );
}

// --- Generic CSV fetcher with caching ---
const csvCache = new Map<string, unknown[]>();

async function fetchCsv<T>(url: string): Promise<T[]> {
  const cached = csvCache.get(url);
  if (cached) return cached as T[];

  // In Node, try local file first (from public/data/)
  const filename = url.split('/').pop()!;
  const localText = await readLocalFile(filename);
  if (localText) {
    const result = Papa.parse<T>(localText, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
    });
    csvCache.set(url, result.data);
    return result.data;
  }

  const response = await fetchWithTimeout(url, { timeout: LARGE_CSV_TIMEOUT });
  let text: string;
  if (response.ok && !isHtmlFallback(response)) {
    text = await response.text();
  } else {
    // Large CSVs are shipped gzipped (Cloudflare Pages caps assets at
    // 25 MiB; see scripts/postbuild-pages.mjs). When the raw file is
    // absent, fall back to the .csv.gz sibling and inflate it here.
    const gz = await fetchWithTimeout(`${url}.gz`, { timeout: LARGE_CSV_TIMEOUT });
    if (!gz.ok || !gz.body || isHtmlFallback(gz)) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }
    text = await readMaybeGzText(gz.body);
  }
  const result = Papa.parse<T>(text, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
  });
  csvCache.set(url, result.data as unknown[]);
  return result.data;
}

// --- Games / Schedules ---
export async function fetchGames(): Promise<Game[]> {
  return fetchCsv<Game>(nflUrl(`schedules/games.csv`));
}

// --- Snap Counts ---
export async function fetchSnapCounts(season: number): Promise<SnapCount[]> {
  return fetchCsv<SnapCount>(nflUrl(`snap_counts/snap_counts_${season}.csv`));
}

// --- Combine ---
export async function fetchCombine(): Promise<CombineResult[]> {
  return fetchCsv<CombineResult>(nflUrl(`combine/combine.csv`));
}

// --- Draft Picks ---
export async function fetchDraftPicks(): Promise<DraftPick[]> {
  return fetchCsv<DraftPick>(nflUrl(`draft_picks/draft_picks.csv`));
}

// --- Injuries ---
export async function fetchInjuries(season: number): Promise<Injury[]> {
  return fetchCsv<Injury>(nflUrl(`injuries/injuries_${season}.csv`));
}

// --- PFR Advanced Stats ---
export async function fetchAdvancedStats(
  season: number,
  type: 'pass' | 'rush' | 'rec' | 'def' = 'pass'
): Promise<AdvancedStats[]> {
  return fetchCsv<AdvancedStats>(nflUrl(`pfr_advstats/advstats_week_${type}_${season}.csv`));
}

// PFR's own season-level advanced-stats aggregates (one file, all seasons,
// correct rate stats — and carries a canonical pfr_id). Filtered by season.
export async function fetchAdvancedStatsSeason(
  season: number,
  type: 'pass' | 'rush' | 'rec' | 'def' = 'pass'
): Promise<AdvancedStats[]> {
  const all = await fetchCsv<AdvancedStats>(nflUrl(`pfr_advstats/advstats_season_${type}.csv`));
  return all.filter((s) => (s as unknown as Record<string, unknown>).season === season);
}

// --- Play-by-Play ---
export async function fetchPlayByPlay(season: number): Promise<PlayByPlay[]> {
  const url = nflUrl(`pbp/play_by_play_${season}.csv`);
  // PBP files are large, so we parse with specific columns to save memory
  const response = await fetchWithTimeout(url, { timeout: LARGE_CSV_TIMEOUT });
  if (!response.ok) {
    throw new Error(`Failed to fetch PBP for ${season}: ${response.status}`);
  }
  const text = await response.text();
  const result = Papa.parse<PlayByPlay>(text, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
  });
  // Filter out rows without a valid play_type to reduce noise
  return result.data.filter(
    (row) => row.play_type && row.play_type !== 'no_play'
  );
}

// --- PBP Participation (NGS-sourced per-play participation data) ---
export async function fetchPbpParticipation(
  season: number
): Promise<import('./types').PbpParticipation[]> {
  return fetchCsv<import('./types').PbpParticipation>(nflUrl(`pbp_participation/pbp_participation_${season}.csv`));
}

// --- Fantasy Rankings (FantasyPros ECR via dynastyprocess) ---
const DYNASTYPROCESS =
  'https://github.com/dynastyprocess/data/raw/master/files';

export async function fetchFantasyRankings(): Promise<FantasyRanking[]> {
  const url = IS_PROD
    ? `${import.meta.env.BASE_URL}data/db_fpecr_latest.csv`
    : `${DYNASTYPROCESS}/db_fpecr_latest.csv`;
  return fetchCsv<FantasyRanking>(url);
}

// --- Fantasy Season Results: merge ADP with actual production ---
export function buildSeasonResults(
  seasonTotals: SeasonTotals[],
  rankings: FantasyRanking[]
): FantasySeasonResult[] {
  // Filter to redraft-overall rankings for ADP comparison
  const adpMap = new Map<string, FantasyRanking>();
  const redraftOverall = rankings.filter(
    (r) =>
      r.page_type === 'redraft-overall' ||
      r.page_type === 'best-overall'
  );
  for (const r of redraftOverall) {
    // Match by normalized player name
    const key = normalizeName(r.player);
    if (!adpMap.has(key)) adpMap.set(key, r);
  }

  // Sort players by standard fantasy points for overall ranking
  const sortedStd = [...seasonTotals].sort(
    (a, b) => b.fantasy_points - a.fantasy_points
  );
  const sortedPpr = [...seasonTotals].sort(
    (a, b) => b.fantasy_points_ppr - a.fantasy_points_ppr
  );

  // Build position ranks
  const posRankStd = new Map<string, number>();
  const posRankPpr = new Map<string, number>();
  const posCountersStd: Record<string, number> = {};
  const posCountersPpr: Record<string, number> = {};

  for (const p of sortedStd) {
    posCountersStd[p.position] = (posCountersStd[p.position] || 0) + 1;
    posRankStd.set(p.player_id, posCountersStd[p.position]);
  }
  for (const p of sortedPpr) {
    posCountersPpr[p.position] = (posCountersPpr[p.position] || 0) + 1;
    posRankPpr.set(p.player_id, posCountersPpr[p.position]);
  }

  return sortedPpr.map((p, i) => {
    const nameKey = normalizeName(p.player_display_name);
    const adp = adpMap.get(nameKey);
    const overallRankPpr = i + 1;
    const overallRankStd =
      sortedStd.findIndex((s) => s.player_id === p.player_id) + 1;

    return {
      player_display_name: p.player_display_name,
      player_id: p.player_id,
      position: p.position,
      team: p.recent_team,
      headshot_url: p.headshot_url,
      games: p.games,
      fantasy_points: p.fantasy_points,
      fantasy_points_ppr: p.fantasy_points_ppr,
      fantasy_points_half_ppr: p.fantasy_points_half_ppr,
      overall_rank_std: overallRankStd,
      overall_rank_ppr: overallRankPpr,
      pos_rank_std: posRankStd.get(p.player_id) || 0,
      pos_rank_ppr: posRankPpr.get(p.player_id) || 0,
      adp_ecr: adp ? adp.ecr : null,
      adp_pos: adp ? adp.pos : null,
      adp_delta: adp ? adp.ecr - overallRankPpr : null,
    };
  });
}


// --- Fantasy Football Calculator ADP (free REST API) ---

// FFC uses different team abbreviations than nflverse for some franchises
const FFC_TEAM_TO_NFLVERSE: Record<string, string> = {
  LAR: 'LA', // Rams: FFC uses 'LAR', nflverse uses 'LA'
};

function normalizeFfcTeam(team: string): string {
  return FFC_TEAM_TO_NFLVERSE[team] ?? team;
}

const ffcAdpCache = new Map<string, FfcADPPlayer[]>();

// The current FFC draft season. Seasons before this are immutable committed
// snapshots (scripts/fetch-ffc-adp.sh) — the live API must never be hit for
// them: FFC drops old seasons from its year-keyed endpoint (year=2025 returns
// an empty players array as of June 2026), so a live call for a missing
// historic file is a guaranteed-dead request that stalls page loads and, if
// FFC ever re-served different data, would silently drift research inputs.
const FFC_CURRENT_SEASON = 2026;

// FFC's `year=N` endpoint frequently returns a thin slice (≤ ~150 rows) for
// the upcoming draft season until the league fills out. Anything under this
// threshold triggers a fallback to the season-1 committed snapshot (when one
// exists) to avoid silently truncating the rankings UI.
const FFC_THIN_THRESHOLD = 200;

function mapFfcPlayers(raw: Array<Record<string, unknown>>): FfcADPPlayer[] {
  return raw.map((p) => ({
    name: String(p.name || ''),
    position: String(p.position || ''),
    team: normalizeFfcTeam(String(p.team || '')),
    adp: Number(p.adp) || 0,
    high: Number(p.high) || 0,
    low: Number(p.low) || 0,
    stdev: Number(p.stdev) || 0,
    timesDrafted: Number(p.times_drafted) || 0,
    bye: Number(p.bye) || 0,
  }));
}

async function fetchFfcADPRaw(
  season: number,
  scoring: 'standard' | 'ppr' | 'half-ppr' | '2qb',
  teams: number,
): Promise<FfcADPPlayer[]> {
  const cacheKey = `${season}-${scoring}-${teams}`;
  const cached = ffcAdpCache.get(cacheKey);
  if (cached) return cached;

  const preFetched = await tryPreFetched<{ players?: Array<Record<string, unknown>> }>(`ffc_adp_${scoring}_${season}.json`);
  if (preFetched?.players && preFetched.players.length > 0) {
    const players = mapFfcPlayers(preFetched.players);
    ffcAdpCache.set(cacheKey, players);
    return players;
  }

  // Historic seasons are snapshot-only in production (see
  // FFC_CURRENT_SEASON above) — a missing committed file means "no data",
  // never a live request. Dev (localhost) keeps the live path since it
  // never reads the committed snapshots.
  if (IS_PROD && season < FFC_CURRENT_SEASON) {
    ffcAdpCache.set(cacheKey, []);
    return [];
  }

  const url = `https://fantasyfootballcalculator.com/api/v1/adp/${scoring}?teams=${teams}&year=${season}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`FFC API returned ${response.status}`);
  }
  const json = await response.json();
  const players = mapFfcPlayers(json.players || []);
  ffcAdpCache.set(cacheKey, players);
  return players;
}

export async function fetchFfcADP(
  season: number,
  scoring: 'standard' | 'ppr' | 'half-ppr' | '2qb' = 'ppr',
  teams: number = 12,
): Promise<FfcADPPlayer[]> {
  const primary = await fetchFfcADPRaw(season, scoring, teams);
  // The thin-season fallback exists ONLY to deepen the upcoming season's
  // sparse early board — it must never substitute a different year's
  // prices for a completed historic season. (It silently did exactly
  // that for years: season 2022's committed file has 157 players, under
  // the threshold, so 2022 consumers — including the model training
  // rows — received 2021 ADP. Jonathan Taylor's 2022 training row said
  // 13.8, his 2021 price, when he was the consensus 1.01 at 1.3.)
  if (primary.length >= FFC_THIN_THRESHOLD || season < FFC_CURRENT_SEASON) return primary;

  // Fall back to the prior season's COMMITTED SNAPSHOT when it is
  // meaningfully larger than the thin primary. Snapshot-only by the
  // historic guard above — FFC no longer serves old seasons live, so
  // this can never fire a network request in production. Swallow
  // fallback errors so a sparse-but-valid primary still wins.
  // Placeholder guard: real FFC rows always carry market signal
  // (timesDrafted/stdev). A committed placeholder file with zeroed
  // fields once leaked phantom deep ADPs (e.g. Al Riles at "363") into
  // the ADP-model pool through this fallback — drop signal-less rows so
  // it can never happen again.
  const fallbackRaw = await fetchFfcADPRaw(season - 1, scoring, teams).catch(() => [] as FfcADPPlayer[]);
  const fallback = fallbackRaw.filter((p) => p.timesDrafted > 0 || p.stdev > 0);
  return fallback.length > primary.length ? fallback : primary;
}

// --- ESPN Fantasy ADP (undocumented v3 API) ---

const ESPN_POSITION_MAP: Record<number, string> = {
  1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DST',
};

const ESPN_TEAM_MAP: Record<number, string> = {
  0: 'FA', 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE',
  6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB', 10: 'TEN', 11: 'IND',
  12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE',
  18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT',
  24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WSH', 29: 'CAR',
  30: 'JAX', 33: 'BAL', 34: 'HOU',
};

interface EspnPlayerRaw {
  id: number;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  defaultPositionId: number;
  proTeamId: number;
  ownership?: {
    averageDraftPosition?: number;
    percentOwned?: number;
  };
  draftRanksByRankType?: {
    STANDARD?: { rank: number; auctionValue: number };
    PPR?: { rank: number; auctionValue: number };
  };
}

interface EspnPlayersResponse {
  players: Array<{
    id: number;
    player: EspnPlayerRaw;
  }>;
}

function parseEspnResponse(raw: unknown): EspnADPPlayer[] {
  const playerEntries: Array<{ id: number; player?: EspnPlayerRaw } & EspnPlayerRaw> =
    Array.isArray(raw) ? raw : (raw as EspnPlayersResponse).players || [];

  const players: EspnADPPlayer[] = [];
  for (const entry of playerEntries) {
    const p = entry.player || entry;
    const pos = ESPN_POSITION_MAP[p.defaultPositionId];
    if (!pos) continue;

    const name = p.fullName || `${p.firstName || ''} ${p.lastName || ''}`.trim();
    if (!name) continue;

    const stdRank = p.draftRanksByRankType?.STANDARD;
    const pprRank = p.draftRanksByRankType?.PPR;

    players.push({
      espnId: p.id || entry.id,
      name,
      position: pos,
      team: ESPN_TEAM_MAP[p.proTeamId] || 'FA',
      adp: p.ownership?.averageDraftPosition || 0,
      percentOwned: p.ownership?.percentOwned || 0,
      draftRankStd: stdRank?.rank || 0,
      draftRankPpr: pprRank?.rank || 0,
      auctionValueStd: stdRank?.auctionValue || 0,
      auctionValuePpr: pprRank?.auctionValue || 0,
    });
  }

  players.sort((a, b) => (a.draftRankPpr || 999) - (b.draftRankPpr || 999));
  return players;
}

const espnAdpCache = new Map<number, EspnADPPlayer[]>();

export async function fetchEspnADP(season: number): Promise<EspnADPPlayer[]> {
  const cached = espnAdpCache.get(season);
  if (cached) return cached;

  // Try pre-fetched raw ESPN data
  const preFetchedRaw = await tryPreFetched<unknown>(`espn_adp_${season}.json`);
  if (preFetchedRaw) {
    const players = parseEspnResponse(preFetchedRaw);
    if (players.length > 0) {
      espnAdpCache.set(season, players);
      return players;
    }
  }

  // Use the league-free players endpoint with kona_player_info view
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/players?scoringPeriodId=0&view=players_wl`;

  const filter = {
    players: {
      limit: 500,
      sortDraftRanks: {
        sortPriority: 100,
        sortAsc: true,
        value: 'PPR',
      },
    },
  };

  const response = await fetchWithTimeout(url, {
    headers: {
      'x-fantasy-filter': JSON.stringify(filter),
    },
  });

  if (!response.ok) {
    throw new Error(`ESPN API returned ${response.status}`);
  }

  const raw = await response.json();
  const players = parseEspnResponse(raw);

  espnAdpCache.set(season, players);
  return players;
}

// --- Sleeper API ---

const SLEEPER = 'https://api.sleeper.app/v1';

let sleeperPlayersCache: Map<string, SleeperPlayer> | null = null;

export async function fetchSleeperPlayers(): Promise<Map<string, SleeperPlayer>> {
  if (sleeperPlayersCache) return sleeperPlayersCache;

  const response = await fetchWithTimeout(`${SLEEPER}/players/nfl`);
  if (!response.ok) throw new Error(`Sleeper players API returned ${response.status}`);

  const raw: Record<string, Record<string, unknown>> = await response.json();
  const map = new Map<string, SleeperPlayer>();

  for (const [id, p] of Object.entries(raw)) {
    if (!p.position || !p.full_name) continue;
    map.set(id, {
      player_id: id,
      full_name: String(p.full_name || ''),
      first_name: String(p.first_name || ''),
      last_name: String(p.last_name || ''),
      position: String(p.position || ''),
      team: String(p.team || ''),
      age: Number(p.age) || 0,
      years_exp: Number(p.years_exp) || 0,
      number: Number(p.number) || 0,
      status: String(p.status || ''),
      sport: String(p.sport || 'nfl'),
      fantasy_positions: Array.isArray(p.fantasy_positions) ? p.fantasy_positions.map(String) : [],
      depth_chart_order: p.depth_chart_order != null ? Number(p.depth_chart_order) : null,
      search_rank: p.search_rank != null ? Number(p.search_rank) : null,
    });
  }

  sleeperPlayersCache = map;
  return map;
}

export async function fetchSleeperTrending(
  type: 'add' | 'drop' = 'add',
  hours: number = 24,
  limit: number = 50
): Promise<SleeperTrendingRow[]> {
  const [trendingRes, players] = await Promise.all([
    fetchWithTimeout(`${SLEEPER}/players/nfl/trending/${type}?lookback_hours=${hours}&limit=${limit}`),
    fetchSleeperPlayers(),
  ]);

  if (!trendingRes.ok) throw new Error(`Sleeper trending API returned ${trendingRes.status}`);
  const trending: SleeperTrendingPlayer[] = await trendingRes.json();

  return trending
    .map((t) => {
      const p = players.get(t.player_id);
      if (!p) return null;
      return {
        player_id: t.player_id,
        full_name: p.full_name,
        position: p.position,
        team: p.team || 'FA',
        age: p.age,
        count: t.count,
      };
    })
    .filter((r): r is SleeperTrendingRow => r !== null);
}

const sleeperProjectionCache = new Map<string, SleeperProjection[]>();

export async function fetchSleeperProjections(
  season: number,
  week?: number
): Promise<SleeperProjection[]> {
  const cacheKey = `${season}-${week ?? 'full'}`;
  const cached = sleeperProjectionCache.get(cacheKey);
  if (cached) return cached;

  const url = week
    ? `${SLEEPER}/projections/nfl/${season}/${week}?season_type=regular`
    : `${SLEEPER}/projections/nfl/${season}`;

  const [projRes, players] = await Promise.all([
    fetchWithTimeout(url),
    fetchSleeperPlayers(),
  ]);

  if (!projRes.ok) throw new Error(`Sleeper projections API returned ${projRes.status}`);
  const raw: Record<string, Record<string, number>> = await projRes.json();

  const projections: SleeperProjection[] = [];
  for (const [pid, stats] of Object.entries(raw)) {
    const p = players.get(pid);
    if (!p || !['QB', 'RB', 'WR', 'TE', 'K'].includes(p.position)) continue;

    const passYd = stats.pass_yd || 0;
    const passTd = stats.pass_td || 0;
    const passInt = stats.pass_int || 0;
    const rushYd = stats.rush_yd || 0;
    const rushTd = stats.rush_td || 0;
    const rec = stats.rec || 0;
    const recYd = stats.rec_yd || 0;
    const recTd = stats.rec_td || 0;
    const fum = stats.fum_lost || 0;

    // Calculate projected fantasy points
    const ptsStd = passYd * 0.04 + passTd * 4 - passInt * 2 +
      rushYd * 0.1 + rushTd * 6 + recYd * 0.1 + recTd * 6 - fum * 2;
    const ptsPpr = ptsStd + rec;
    const ptsHalfPpr = ptsStd + rec * 0.5;

    projections.push({
      player_id: pid,
      full_name: p.full_name,
      position: p.position,
      team: p.team || 'FA',
      pts_std: Math.round(ptsStd * 10) / 10,
      pts_half_ppr: Math.round(ptsHalfPpr * 10) / 10,
      pts_ppr: Math.round(ptsPpr * 10) / 10,
      pass_yd: passYd,
      pass_td: passTd,
      pass_int: passInt,
      rush_yd: rushYd,
      rush_td: rushTd,
      rec,
      rec_yd: recYd,
      rec_td: recTd,
    });
  }

  projections.sort((a, b) => b.pts_ppr - a.pts_ppr);
  sleeperProjectionCache.set(cacheKey, projections);
  return projections;
}

// --- KeepTradeCut (scrapes embedded playersArray from HTML) ---

const dynastyCache = new Map<string, DynastyPlayer[]>();

export async function fetchDynastyRankings(
  format: '1qb' | 'superflex' = '1qb'
): Promise<DynastyPlayer[]> {
  const cached = dynastyCache.get(format);
  if (cached) return cached;

  // Try pre-fetched data first
  const preFetched = await tryPreFetched<DynastyPlayer[]>(`ktc_rankings_${format}.json`);
  if (preFetched && preFetched.length > 0) {
    preFetched.sort((a, b) => b.value - a.value);
    dynastyCache.set(format, preFetched);
    return preFetched;
  }

  const allPlayers: DynastyPlayer[] = [];
  const seen = new Set<number>(); // deduplicate playerIDs across pages
  const formatParam = format === '1qb' ? '1' : '0';

  // Dynasty paginates across 10 pages
  for (let page = 0; page < 10; page++) {
    const dynastyPath = `/dynasty-rankings?page=${page}&filters=QB|WR|RB|TE|RDP&format=${formatParam}`;
    const url = IS_PROD
      ? `${KTC_PROXY}${dynastyPath}`
      : `https://keeptradecut.com${dynastyPath}`;
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      if (page === 0) throw new Error(`Dynasty returned ${response.status}`);
      break; // Later pages may not exist
    }

    const html = await response.text();

    // Extract the playersArray variable embedded in the page's script tags
    const match = html.match(/var\s+playersArray\s*=\s*(\[[\s\S]*?\]);/);
    if (!match) {
      if (page === 0) throw new Error('Could not find player data in Dynasty page');
      break;
    }

    try {
      const players: Array<Record<string, unknown>> = JSON.parse(match[1]);
      let added = 0;
      for (const p of players) {
        const id = Number(p.playerID) || 0;
        if (seen.has(id)) continue; // deduplicate across pages
        seen.add(id);
        // Dynasty moved values into nested objects: oneQBValues.value / superflexValues.value
        // Support both old flat shape (p.value) and new nested shape for resilience
        const oneQB = p.oneQBValues as Record<string, unknown> | undefined;
        const sf    = p.superflexValues as Record<string, unknown> | undefined;
        const value1qb = Number(oneQB?.value ?? p.value) || 0;
        const valueSF  = Number(sf?.value ?? p.superflexValue) || 0;
        const posRank  = Number(oneQB?.positionalRank ?? p.positionRank) || 0;
        allPlayers.push({
          playerID: id,
          playerName: String(p.playerName || ''),
          position: String(p.position || ''),
          positionRank: posRank,
          team: String(p.team || ''),
          age: Number(p.age) || 0,
          value: value1qb,
          superflexValue: valueSF,
          isRookie: Boolean(p.isRookie ?? p.rookie),
          slug: String(p.slug || ''),
        });
        added++;
      }
      if (added === 0) break; // no new players on this page — stop early
    } catch {
      if (page === 0) throw new Error('Failed to parse Dynasty player data');
      break;
    }
  }

  // Sort by value descending
  allPlayers.sort((a, b) => b.value - a.value);
  dynastyCache.set(format, allPlayers);
  return allPlayers;
}

// --- Dynasty Player History (POST endpoint) ---

const dynastyHistoryCache = new Map<number, DynastyPlayerHistory>();

export async function fetchDynastyHistory(
  playerIDs: number[]
): Promise<DynastyPlayerHistory[]> {
  // Try loading pre-fetched history (already parsed into {d,v} objects)
  if (dynastyHistoryCache.size === 0) {
    const preFetched = await tryPreFetched<DynastyPlayerHistory[]>('ktc_history.json');
    if (preFetched) {
      for (const entry of preFetched) {
        dynastyHistoryCache.set(entry.playerID, entry);
      }
    }
  }

  // Return cached entries where available, fetch the rest
  const results: DynastyPlayerHistory[] = [];
  const toFetch: number[] = [];

  for (const id of playerIDs) {
    const cached = dynastyHistoryCache.get(id);
    if (cached) {
      results.push(cached);
    } else {
      toFetch.push(id);
    }
  }

  if (toFetch.length > 0) {
    const historyUrl = IS_PROD
      ? `${KTC_PROXY}/dynasty-rankings/histories`
      : 'https://keeptradecut.com/dynasty-rankings/histories';
    const response = await fetchWithTimeout(historyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toFetch),
    });

    if (!response.ok) {
      throw new Error(`Dynasty history API returned ${response.status}`);
    }

    const raw = await response.json();
    for (const entry of raw) {
      // Dynasty returns valueHistory as packed strings "YYMMDDVVVV..."
      // Convert to { d: "YYYY-MM-DD", v: number } objects
      const parseHistory = (arr: (string | { d: string; v: number })[]) =>
        arr.map((item) => {
          if (typeof item === 'object') return item;
          const s = String(item);
          const yy = s.slice(0, 2);
          const mm = s.slice(2, 4);
          const dd = s.slice(4, 6);
          const v = Number(s.slice(6));
          return { d: `20${yy}-${mm}-${dd}`, v };
        });
      const parsed: DynastyPlayerHistory = {
        playerID: entry.playerID,
        oneQB: { valueHistory: parseHistory(entry.oneQB.valueHistory) },
        superflex: { valueHistory: parseHistory(entry.superflex.valueHistory) },
      };
      dynastyHistoryCache.set(parsed.playerID, parsed);
      results.push(parsed);
    }
  }

  return results;
}

// --- Dynasty → FantasyCalc value rescaling (for display) ---
//
// The site shows FC values everywhere but uses a Dynasty-trained forecast model.
// These wrappers apply a per-player ratio (see scripts/build-rescale-snapshot.cjs)
// to Dynasty values so they appear in FC's scale. Raw fetchers above stay
// untouched because the ML training pipeline expects native Dynasty scale.

import {
  makeRescaler,
  rescaleDynastyPlayer,
  rescaleDynastyHistory,
  type Rescaler,
  type RescaleSnapshot,
} from './lib/valueRescale';

let _rescalerPromise: Promise<Rescaler | null> | null = null;

export function loadRescaler(): Promise<Rescaler | null> {
  if (_rescalerPromise) return _rescalerPromise;
  _rescalerPromise = tryPreFetched<RescaleSnapshot>('dynasty-fc-rescale.json')
    .then(snap => snap ? makeRescaler(snap) : null);
  return _rescalerPromise;
}

export async function fetchDynastyRankingsForDisplay(
  format: '1qb' | 'superflex' = '1qb',
): Promise<DynastyPlayer[]> {
  const [raw, rescaler] = await Promise.all([
    fetchDynastyRankings(format),
    loadRescaler(),
  ]);
  if (!rescaler) return raw;
  const out = raw.map(p => rescaleDynastyPlayer(p, rescaler));
  // Re-sort by rescaled value since per-player ratios can change order
  out.sort((a, b) => (format === '1qb' ? b.value - a.value : b.superflexValue - a.superflexValue));
  return out;
}

export async function fetchDynastyHistoryForDisplay(
  playerIDs: number[],
  positionByID: Map<number, string>,
): Promise<DynastyPlayerHistory[]> {
  const [raw, rescaler] = await Promise.all([
    fetchDynastyHistory(playerIDs),
    loadRescaler(),
  ]);
  if (!rescaler) return raw;
  return raw.map(h => rescaleDynastyHistory(h, positionByID.get(h.playerID) ?? '', rescaler));
}

// --- FantasyCalc Rankings (normalized to DynastyPlayer shape) ---

const fcCache = new Map<string, DynastyPlayer[]>();

export async function fetchFantasyCalcRankings(
  format: '1qb' | 'superflex' = '1qb'
): Promise<DynastyPlayer[]> {
  const cacheKey = format;
  const cached = fcCache.get(cacheKey);
  if (cached) return cached;

  const url1qb =
    `${FC_BASE}/values/current?isDynasty=true&numQbs=1&numTeams=12&ppr=1`;
  const urlSf =
    `${FC_BASE}/values/current?isDynasty=true&numQbs=2&numTeams=12&ppr=1`;

  // Fetch both in parallel so we can populate both value fields
  const [oneQbData, sfData] = await Promise.all([
    fetchWithTimeout(url1qb).then((r) => {
      if (!r.ok) throw new Error(`FantasyCalc API returned ${r.status}`);
      return r.json() as Promise<Array<{
        player: { id: number; name: string; position: string; maybeTeam?: string; maybeAge?: number; maybeYoe?: number };
        value: number;
        overallRank: number;
        positionRank: number;
        trend30Day?: number;
        maybeTier?: number;
      }>>;
    }),
    fetchWithTimeout(urlSf).then((r) => {
      if (!r.ok) throw new Error(`FantasyCalc SF API returned ${r.status}`);
      return r.json() as Promise<Array<{
        player: { id: number; name: string };
        value: number;
      }>>;
    }),
  ]);

  // Build SF value lookup by player id
  const sfMap = new Map<number, number>();
  for (const item of sfData) {
    sfMap.set(item.player.id, item.value);
  }

  const results: DynastyPlayer[] = oneQbData
    .filter((item) => item.player.position !== 'PICK')
    .map((item) => ({
      playerID: item.player.id,
      playerName: item.player.name,
      position: item.player.position,
      positionRank: item.positionRank,
      team: item.player.maybeTeam ?? '',
      age: item.player.maybeAge ?? 0,
      value: item.value,
      superflexValue: sfMap.get(item.player.id) ?? 0,
      isRookie: item.player.maybeYoe === 0,
      slug: '',
      trend30Day: item.trend30Day ?? 0,
    }));

  // Sort by value descending (1QB value)
  results.sort((a, b) => b.value - a.value);

  fcCache.set(cacheKey, results);
  return results;
}

// --- FantasyCalc API ---

const fantasyCalcCache = new Map<string, FantasyCalcPlayer[]>();

export async function fetchFantasyCalcValues(
  isDynasty: boolean = true,
  numQbs: 1 | 2 = 1,
  numTeams: number = 12,
  ppr: 0 | 0.5 | 1 = 1
): Promise<FantasyCalcPlayer[]> {
  const cacheKey = `${isDynasty}-${numQbs}-${numTeams}-${ppr}`;
  const cached = fantasyCalcCache.get(cacheKey);
  if (cached) return cached;

  // Try pre-fetched data
  const sfx = isDynasty
    ? (numQbs === 2 ? 'dynasty_sf' : 'dynasty_1qb')
    : (numQbs === 2 ? 'redraft_sf' : 'redraft_1qb');
  const preFetched = await tryPreFetched<FantasyCalcPlayer[]>(`fantasycalc_${sfx}.json`);
  if (preFetched && preFetched.length > 0) {
    preFetched.sort((a, b) => b.value - a.value);
    fantasyCalcCache.set(cacheKey, preFetched);
    return preFetched;
  }

  const url = `${FC_BASE}/values/current?isDynasty=${isDynasty}&numQbs=${numQbs}&numTeams=${numTeams}&ppr=${ppr}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`FantasyCalc API returned ${response.status}`);
  }

  const data: FantasyCalcPlayer[] = await response.json();

  // Sort by value descending
  data.sort((a, b) => b.value - a.value);
  fantasyCalcCache.set(cacheKey, data);
  return data;
}

// --- Next Gen Stats ---
// nflverse only shards NGS per season once a season is closed out (through
// 2024 as of 2026-08); the current and previous season live solely in the
// un-suffixed ngs_<type>.csv.gz, which holds every season from 2016 on. The
// build splits that file per season into data/ngs_<season>_<type>.csv
// (scripts/download-data.sh), but the remote fallback below still resolves
// recent seasons to the whole multi-season file — so every path is filtered to
// the season that was asked for. Without it a request for the season that
// matters most returns a decade of rows, and any caller that keys by player
// name silently picks up whichever season happens to land last.
function ngsForSeason(rows: NextGenStats[], season: number): NextGenStats[] {
  // Season-sharded files hold nothing else, so this is a no-op there. Rows with
  // no season column at all are kept rather than dropped — an unparsed header
  // should degrade to the old behaviour, not to an empty table.
  return rows.filter((r) => r.season == null || Number(r.season) === season);
}

export async function fetchNextGenStats(
  season: number,
  type: 'passing' | 'rushing' | 'receiving' = 'passing'
): Promise<NextGenStats[]> {
  if (IS_PROD) {
    return ngsForSeason(
      await fetchCsv<NextGenStats>(nflUrl(`nextgen_stats/ngs_${season}_${type}.csv`)),
      season,
    );
  }
  // Try year-specific first, then the all-seasons (no year) filename
  const urls = [
    `${NFLVERSE_REMOTE}/nextgen_stats/ngs_${season}_${type}.csv.gz`,
    `${NFLVERSE_REMOTE}/nextgen_stats/ngs_${type}.csv.gz`,
  ];
  for (const url of urls) {
    const cached = csvCache.get(url);
    if (cached) {
      const hit = ngsForSeason(cached as NextGenStats[], season);
      if (hit.length) return hit;
      continue;
    }
    const response = await fetchWithTimeout(url, { timeout: LARGE_CSV_TIMEOUT });
    if (!response.ok || isHtmlFallback(response)) continue;
    const decompressed = response.body
      ? await readMaybeGzText(response.body)
      : '';
    const result = Papa.parse<NextGenStats>(decompressed, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
    });
    // Cache the parsed file, not the filtered view — the same download serves
    // every season, so a later request for a different year is a cache hit.
    csvCache.set(url, result.data as unknown[]);
    const rows = ngsForSeason(result.data, season);
    // The all-seasons file legitimately has no rows for a season that hasn't
    // been charted yet; fall through rather than returning an empty array as
    // if it were the answer.
    if (rows.length) return rows;
  }
  return [];
}

// --- Rosters ---
export async function fetchRosters(season: number): Promise<Roster[]> {
  const rosters = await fetchCsv<Roster>(nflUrl(`rosters/roster_${season}.csv`));
  if (season >= ROSTER_OVERRIDES_2026_SEASON) {
    for (const r of rosters) {
      const nn = r.full_name
        .toLowerCase()
        .replace(/[^a-z ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const override = ROSTER_OVERRIDES_2026[nn];
      if (override) r.team = override.team;
    }
  }
  return rosters;
}

// --- Contracts ---
export async function fetchContracts(): Promise<Contract[]> {
  return fetchCsv<Contract>(nflUrl(`contracts/historical_contracts.csv`));
}

// --- Depth Charts ---
export async function fetchDepthCharts(season: number): Promise<DepthChart[]> {
  // nflverse renamed the depth-chart schema (2024+): club_code, depth_team,
  // position, full_name, depth_position, week … Normalize back to the shape
  // every consumer (tools + Dynasty/feature-store pipeline) already expects.
  // `??` fallbacks keep older-season files (old column names) working too.
  const raw = await fetchCsv<Record<string, unknown>>(
    nflUrl(`depth_charts/depth_charts_${season}.csv`),
  );
  return raw.map((r): DepthChart => ({
    // Old files carry a real `dt` date; new ones only a week — zero-pad so the
    // "most recent snapshot" string sort stays correct either way.
    dt: String(r.dt ?? (r.week != null ? String(r.week).padStart(3, '0') : '')),
    team: String(r.team ?? r.club_code ?? ''),
    player_name: String(
      r.player_name ?? r.full_name ?? r.football_name ??
      `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
    ),
    gsis_id: String(r.gsis_id ?? ''),
    pos_grp: String(r.pos_grp ?? r.depth_position ?? r.formation ?? ''),
    pos_name: String(r.pos_name ?? r.depth_position ?? ''),
    pos_abb: String(r.pos_abb ?? r.position ?? ''),
    pos_slot: Number(r.pos_slot ?? 0),
    pos_rank: Number(r.pos_rank ?? r.depth_team ?? 0),
  }));
}

// --- FTN Charting ---
export async function fetchFTNCharting(season: number): Promise<FTNCharting[]> {
  return fetchCsv<FTNCharting>(nflUrl(`ftn_charting/ftn_charting_${season}.csv`));
}

// --- Trades ---
export async function fetchTrades(): Promise<Trade[]> {
  return fetchCsv<Trade>(nflUrl(`trades/trades.csv`));
}

// --- ESPN QBR ---
export async function fetchQBRSeason(): Promise<QBRSeason[]> {
  return fetchCsv<QBRSeason>(nflUrl(`espn_data/qbr_season_level.csv`));
}

export async function fetchQBRWeek(): Promise<QBRWeek[]> {
  return fetchCsv<QBRWeek>(nflUrl(`espn_data/qbr_week_level.csv`));
}

// --- Draft Prospect Data (JackLich10/nfl-draft-data) ---
const DRAFT_DATA = 'https://raw.githubusercontent.com/JackLich10/nfl-draft-data/main';

export async function fetchDraftProspects(): Promise<DraftProspect[]> {
  return fetchCsv<DraftProspect>(`${DRAFT_DATA}/nfl_draft_prospects.csv`);
}

export async function fetchDraftProfiles(): Promise<DraftProfile[]> {
  return fetchCsv<DraftProfile>(`${DRAFT_DATA}/nfl_draft_profiles.csv`);
}

// StatHead's own prospect model outputs (committed snapshots).
export interface ProspectBoomBust {
  name: string; position: string;
  boomProb: number; bustProb: number;
  boomZ: number; bustZ: number; outperfPctile: number;
}
export async function fetchProspectBoomBust(): Promise<ProspectBoomBust[]> {
  return (await tryPreFetched<ProspectBoomBust[]>('prospect-boom-bust.json')) ?? [];
}

export interface ProspectGrade {
  name: string; pos: string; school: string;
  grade: number; projRound: number; projPick: number; tier: string;
  team?: string; actualRound?: number; actualPick?: number;
  consensusRank?: number; pffRank?: number; tankathonPick?: number;
}
export async function fetchProspectGrades(year: number): Promise<ProspectGrade[]> {
  return (await tryPreFetched<ProspectGrade[]>(`prospect-grades-${year}.json`)) ?? [];
}

export async function fetchCollegeStats(): Promise<CollegeStats[]> {
  return fetchCsv<CollegeStats>(`${DRAFT_DATA}/college_statistics.csv`);
}

// College football game results (cfbfastR) — for deriving strength of schedule
export interface CollegeGame {
  game_id: number;
  season: number;
  home_team: string;
  home_conference: string;
  home_points: number;
  away_team: string;
  away_conference: string;
  away_points: number;
}
const CFB_DATA = 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules';
export async function fetchCollegeGames(): Promise<CollegeGame[]> {
  return fetchCsv<CollegeGame>(`${CFB_DATA}/cfb_games_info.csv`);
}

export async function fetchCollegeQBR(): Promise<CollegeQBR[]> {
  return fetchCsv<CollegeQBR>(`${DRAFT_DATA}/college_qbr.csv`);
}

// --- CollegeFootballData.com supplement ---
// Pulled by .github/workflows/fetch-cfbd-college.yml and committed to
// public/data/. Backfills historical college stats the JackLich10 source
// is missing (~80% of pre-2017 rookies).

export interface CfbdSpRating {
  rating: number;
  offense_rating?: number | null;
  defense_rating?: number | null;
  sos?: number | null;
  second_order_wins?: number | null;
}

export interface CfbdRecruit {
  stars?: number | null;
  rank?: number | null;
  class_year: number;
  position?: string | null;
  committed_to?: string | null;
  composite_rating?: number | null;
  height?: number | null;
  weight?: number | null;
}

export async function fetchCfbdCollegeStats(): Promise<CollegeStats[]> {
  const data = await tryPreFetched<CollegeStats[]>('cfbd-college-stats.json');
  return data || [];
}

export async function fetchCfbdSpRatings(): Promise<Record<string, CfbdSpRating>> {
  return (await tryPreFetched<Record<string, CfbdSpRating>>('cfbd-sp-ratings.json')) || {};
}

export async function fetchCfbdRecruiting(): Promise<Record<string, CfbdRecruit>> {
  return (await tryPreFetched<Record<string, CfbdRecruit>>('cfbd-recruiting.json')) || {};
}

export interface CfbdPlayerUsage {
  overall?: number | null;
  pass?: number | null;
  rush?: number | null;
  first_down?: number | null;
  second_down?: number | null;
  third_down?: number | null;
  standard_downs?: number | null;
  passing_downs?: number | null;
  team?: string | null;
  position?: string | null;
}

export async function fetchCfbdGames(): Promise<Record<string, number>> {
  return (await tryPreFetched<Record<string, number>>('cfbd-games.json')) || {};
}

export async function fetchCfbdTeamTalent(): Promise<Record<string, number>> {
  return (await tryPreFetched<Record<string, number>>('cfbd-team-talent.json')) || {};
}

export async function fetchCfbdPlayerUsage(): Promise<Record<string, CfbdPlayerUsage>> {
  return (await tryPreFetched<Record<string, CfbdPlayerUsage>>('cfbd-player-usage.json')) || {};
}

// --- The Odds API (free tier: 500 credits/month) ---
// Fetches NFL game lines and player props from https://the-odds-api.com

export interface OddsGameLine {
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  spread: number;       // home spread (negative = home favored)
  totalLine: number;    // over/under
  homeImplied: number;  // derived: (total - spread) / 2
  awayImplied: number;  // derived: (total + spread) / 2
  bookmaker: string;
}

export interface OddsPlayerProp {
  gameId: string;
  playerName: string;
  market: string;       // e.g. 'player_pass_yds', 'player_rush_yds'
  line: number;         // over/under line (e.g. 249.5)
  overPrice: number;    // American odds for over
  underPrice: number;   // American odds for under
  bookmaker: string;
}

export interface OddsTeamImpliedTotal {
  team: string;
  avgImplied: number;
  gameCount: number;
  avgSpread: number;
  avgTotal: number;
}

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const ODDS_SPORT = 'americanfootball_nfl';

// Try to get API key from environment or pre-fetched config
function getOddsApiKey(): string | null {
  // Check for pre-configured key (set via .env or config)
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ODDS_API_KEY) {
    return import.meta.env.VITE_ODDS_API_KEY;
  }
  return null;
}

/**
 * Fetch NFL game lines (spreads + totals) from The Odds API.
 * Returns game lines with derived implied totals per team.
 * Uses ~1-2 credits per call.
 */
export async function fetchOddsGameLines(): Promise<OddsGameLine[]> {
  // Try pre-fetched data first
  const preFetched = await tryPreFetched<OddsGameLine[]>('odds_nfl_lines.json');
  if (preFetched && preFetched.length > 0) return preFetched;

  const apiKey = getOddsApiKey();
  if (!apiKey) return [];

  const url = `${ODDS_API_BASE}/sports/${ODDS_SPORT}/odds?regions=us&markets=spreads,totals&oddsFormat=american&apiKey=${apiKey}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) return [];

  const data: Array<{
    id: string;
    home_team: string;
    away_team: string;
    commence_time: string;
    bookmakers: Array<{
      key: string;
      markets: Array<{
        key: string;
        outcomes: Array<{ name: string; price: number; point?: number }>;
      }>;
    }>;
  }> = await response.json();

  const lines: OddsGameLine[] = [];
  for (const game of data) {
    // Use first bookmaker with both spreads and totals
    for (const bk of game.bookmakers) {
      const spreadMkt = bk.markets.find((m) => m.key === 'spreads');
      const totalMkt = bk.markets.find((m) => m.key === 'totals');
      if (!spreadMkt || !totalMkt) continue;

      const homeSpreadOutcome = spreadMkt.outcomes.find((o) => o.name === game.home_team);
      const totalOverOutcome = totalMkt.outcomes.find((o) => o.name === 'Over');
      if (!homeSpreadOutcome?.point || !totalOverOutcome?.point) continue;

      const spread = homeSpreadOutcome.point;
      const total = totalOverOutcome.point;
      lines.push({
        gameId: game.id,
        homeTeam: game.home_team,
        awayTeam: game.away_team,
        commenceTime: game.commence_time,
        spread,
        totalLine: total,
        homeImplied: (total - spread) / 2,
        awayImplied: (total + spread) / 2,
        bookmaker: bk.key,
      });
      break; // Only use first valid bookmaker per game
    }
  }

  return lines;
}

/**
 * Aggregate game lines into per-team average implied totals.
 * Useful for projecting team offensive environment.
 */
export function aggregateOddsToTeamImplied(lines: OddsGameLine[]): OddsTeamImpliedTotal[] {
  const teamMap = new Map<string, { implied: number[]; spreads: number[]; totals: number[] }>();

  for (const line of lines) {
    if (!teamMap.has(line.homeTeam)) teamMap.set(line.homeTeam, { implied: [], spreads: [], totals: [] });
    if (!teamMap.has(line.awayTeam)) teamMap.set(line.awayTeam, { implied: [], spreads: [], totals: [] });
    teamMap.get(line.homeTeam)!.implied.push(line.homeImplied);
    teamMap.get(line.homeTeam)!.spreads.push(-line.spread); // negate for home perspective
    teamMap.get(line.homeTeam)!.totals.push(line.totalLine);
    teamMap.get(line.awayTeam)!.implied.push(line.awayImplied);
    teamMap.get(line.awayTeam)!.spreads.push(line.spread);
    teamMap.get(line.awayTeam)!.totals.push(line.totalLine);
  }

  const result: OddsTeamImpliedTotal[] = [];
  for (const [team, data] of teamMap) {
    const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
    result.push({
      team,
      avgImplied: Math.round(avg(data.implied) * 10) / 10,
      gameCount: data.implied.length,
      avgSpread: Math.round(avg(data.spreads) * 10) / 10,
      avgTotal: Math.round(avg(data.totals) * 10) / 10,
    });
  }

  result.sort((a, b) => b.avgImplied - a.avgImplied);
  return result;
}

/**
 * Fetch per-game player props from The Odds API for a specific event.
 * Markets: player_pass_yds, player_rush_yds, player_reception_yds, player_pass_tds, etc.
 * Uses ~1 credit per market per region.
 */
export async function fetchOddsPlayerProps(
  eventId: string,
  markets: string[] = ['player_pass_yds', 'player_rush_yds', 'player_reception_yds']
): Promise<OddsPlayerProp[]> {
  const apiKey = getOddsApiKey();
  if (!apiKey) return [];

  const marketsParam = markets.join(',');
  const url = `${ODDS_API_BASE}/sports/${ODDS_SPORT}/events/${eventId}/odds?regions=us&markets=${marketsParam}&oddsFormat=american&apiKey=${apiKey}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) return [];

  const data: {
    id: string;
    bookmakers: Array<{
      key: string;
      markets: Array<{
        key: string;
        outcomes: Array<{ name: string; description: string; price: number; point?: number }>;
      }>;
    }>;
  } = await response.json();

  const props: OddsPlayerProp[] = [];
  // Use first bookmaker with each market
  const seenMarkets = new Set<string>();
  for (const bk of data.bookmakers) {
    for (const mkt of bk.markets) {
      if (seenMarkets.has(mkt.key)) continue;
      seenMarkets.add(mkt.key);
      // Props come in pairs (Over/Under) grouped by player description
      const playerLines = new Map<string, { over: number; under: number; line: number }>();
      for (const outcome of mkt.outcomes) {
        const player = outcome.description;
        if (!playerLines.has(player)) playerLines.set(player, { over: 0, under: 0, line: 0 });
        const entry = playerLines.get(player)!;
        if (outcome.name === 'Over') {
          entry.over = outcome.price;
          entry.line = outcome.point || 0;
        } else {
          entry.under = outcome.price;
        }
      }
      for (const [player, entry] of playerLines) {
        props.push({
          gameId: data.id,
          playerName: player,
          market: mkt.key,
          line: entry.line,
          overPrice: entry.over,
          underPrice: entry.under,
          bookmaker: bk.key,
        });
      }
    }
  }

  return props;
}
