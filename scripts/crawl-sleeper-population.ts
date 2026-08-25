// League-oriented crawler for the Sleeper manager-engagement population.
//
// Run:  npx tsx scripts/crawl-sleeper-population.ts --seed=<leagueId>[,<id>...]
//                                                   [--seedUser=<username>]
//                                                   [--seasons=2023,2024,2025,2026]
//                                                   [--maxRequests=20000]
//                                                   [--maxLeagueSeasons=400]
//                                                   [--expandPerLeague=3]
//                                                   [--rpm=600] [--concurrency=8]
//                                                   [--out=sleeper-population.json]
//                                                   [--cache=.cache/sleeper-crawl]
//                                                   [--no-brackets] [--reveal-ids]
//                                                   [--plan]
//
// WHY LEAGUE-ORIENTED. One league-season costs ~21 requests (league + rosters +
// 18 transaction weeks + winners bracket) and yields labeled rows for EVERY
// manager in it — under 2 requests per manager-season. Crawling user-first
// re-fetches the same league-weeks once per manager and costs hundreds of
// requests per row: identical data, ~100x the budget.
//
// TWO EXPANSION MECHANISMS, priced very differently:
//   vertical   — follow previous_league_id back through a league's own history.
//                One more league-season per hop, no user lookups, and it builds
//                exactly the lineages the retention labels need. Always on.
//   horizontal — sample managers and enumerate their other leagues. Costs one
//                request per (manager, season), so a 12-team league would cost
//                48 requests to expand fully — more than the league itself.
//                Sampled, not exhaustive (--expandPerLeague).
//
// ALL-OR-NOTHING LEAGUE-SEASONS. A league-season whose transaction weeks are
// only partly fetched looks exactly like a league where managers stopped
// transacting — the precise pattern the abandonment label detects. So budget is
// reserved for a whole league-season before it starts, and a league-season that
// cannot be completed is dropped rather than emitted partially.
//
// PRIVACY. Sleeper is a public API but these are named real people. Manager ids
// are salted-hashed by default (--reveal-ids opts out for debugging); the output
// and the HTTP cache are gitignored; nothing per-manager is ever committed.
// Politeness: paced well under Sleeper's ~1000 req/min guidance, read-through
// cached so a re-run costs nothing, and backs off on 429.
//
// These endpoints 403 from the dev sandbox, so real crawls run from CI or a
// developer machine. The crawl logic takes its fetcher by injection, so
// scripts/test-sleeper-crawler.ts drives the whole thing offline.
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import {
  leagueFormatInfo, txnEventFor,
  type SleeperRawTransaction, type TxnEvent, type LeagueSeasonRecord, type TxnContext,
} from '../src/lib/sleeper';
import { managerSeasonEngagement } from '../src/lib/engagement';
import { retentionEvents, type LeagueSeasonRef } from '../src/lib/leagueLineage';
import type { ManagerObservation } from '../src/lib/featureAudit';

const SLEEPER = 'https://api.sleeper.app/v1';
const WEEKS = 18;

// ── shapes we read back from Sleeper ──

interface RawLeague {
  league_id: string;
  previous_league_id?: string | null;
  name?: string;
  season: string;
  status?: string;
  total_rosters?: number;
  roster_positions?: string[];
  settings?: { type?: number; best_ball?: number };
  sport?: string;
}

interface RawRoster {
  roster_id: number;
  owner_id: string | null;
  players?: string[] | null;
  starters?: string[] | null;
  settings?: { wins?: number; losses?: number; ties?: number; fpts?: number; fpts_decimal?: number };
}

interface RawBracketMatch { p?: number; w?: number | null; l?: number | null }

// ── options ──

export interface CrawlOptions {
  seedLeagueIds: string[];
  seasons: string[];            // seasons of interest, ascending or not
  maxRequests: number;
  maxLeagueSeasons: number;
  expandPerLeague: number;      // managers sampled per league for horizontal expansion
  weeks: number;
  brackets: boolean;
  pseudonymize: boolean;
  salt: string;
}

export interface CrawlStats {
  requests: number;
  leagueSeasonsCrawled: number;
  leagueSeasonsDropped: number;   // could not be completed within budget
  leagueSeasonsSkipped: number;   // outside the season window, or not NFL
  managersDiscovered: number;
  portfoliosResolved: number;
  frontierRemaining: number;
  budgetExhausted: boolean;
  errors: number;
}

export interface CrawlResult {
  population: ManagerObservation[];
  stats: CrawlStats;
  horizonBySeason: Record<string, number>;
}

export interface CrawlDeps {
  // Resolves a Sleeper path (e.g. "/league/123/rosters") to parsed JSON, or
  // null when the resource is absent. Throwing is treated as an error and the
  // league-season is dropped rather than half-recorded.
  getJson: (path: string) => Promise<unknown>;
  onProgress?: (stats: CrawlStats) => void;
}

// ── pure helpers (exported for the offline test) ──

export function pseudonymizeId(userId: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${userId}`).digest('hex').slice(0, 16);
}

// Cost of one league-season, so budget can be reserved before starting it.
export function leagueSeasonCost(opts: Pick<CrawlOptions, 'weeks' | 'brackets'>): number {
  return 2 + opts.weeks + (opts.brackets ? 1 : 0);
}

// Sleeper stores points as an integer part plus hundredths (1802 + 8 → 1802.08).
const toPoints = (whole?: number, dec?: number) => (whole ?? 0) + (dec ?? 0) / 100;

// One fully-fetched league-season. Only complete ones reach this shape.
interface CrawledLeagueSeason {
  leagueId: string;
  previousLeagueId: string | null;
  name: string;
  season: string;
  status: string;
  totalRosters: number;
  rosterPositions: string[];
  settings: { type?: number; best_ball?: number };
  rosters: RawRoster[];
  transactions: { week: number; txns: SleeperRawTransaction[] }[];
  champion: number | null;   // winning roster id, when the bracket was fetched
  runnerUp: number | null;
}

// ── the crawl ──

export async function crawl(opts: CrawlOptions, deps: CrawlDeps): Promise<CrawlResult> {
  const seasonSet = new Set(opts.seasons);
  const perLeagueSeason = leagueSeasonCost(opts);

  const stats: CrawlStats = {
    requests: 0, leagueSeasonsCrawled: 0, leagueSeasonsDropped: 0, leagueSeasonsSkipped: 0,
    managersDiscovered: 0, portfoliosResolved: 0, frontierRemaining: 0, budgetExhausted: false, errors: 0,
  };

  const crawled: CrawledLeagueSeason[] = [];
  const visited = new Set<string>();
  const frontier: string[] = [...new Set(opts.seedLeagueIds)];
  // Managers whose full league list we enumerated, and the size of that list.
  const portfolio = new Map<string, number>();

  const get = async <T>(path: string): Promise<T | null> => {
    stats.requests++;
    return (await deps.getJson(path)) as T | null;
  };
  const canSpend = (n: number) => stats.requests + n <= opts.maxRequests;

  while (frontier.length) {
    if (crawled.length >= opts.maxLeagueSeasons) break;
    // Reserve the whole league-season up front. Starting one we cannot finish
    // would emit fake inactivity, so we stop instead.
    if (!canSpend(perLeagueSeason)) { stats.budgetExhausted = true; break; }

    const leagueId = frontier.shift()!;
    if (visited.has(leagueId)) continue;
    visited.add(leagueId);

    const outcome = await fetchLeagueSeason(leagueId, opts, get, seasonSet, stats);

    // Vertical expansion runs on a DROPPED league-season too. If the league
    // document was readable, we know its previous_league_id even when a later
    // request failed — and letting one transient error sever a lineage would
    // silently cost every retention label behind it.
    if (outcome.kind !== 'skipped' && outcome.previousLeagueId && !visited.has(outcome.previousLeagueId)) {
      const prevSeason = String(Number(outcome.season) - 1);
      if (seasonSet.has(prevSeason)) frontier.push(outcome.previousLeagueId);
    }
    if (outcome.kind !== 'ok') { stats.frontierRemaining = frontier.length; continue; }

    const ls = outcome.ls;
    crawled.push(ls);
    stats.leagueSeasonsCrawled++;

    // Horizontal expansion: sample managers and enumerate their other leagues.
    // Deterministic sample (roster order) so a re-run walks the same graph.
    const owners = ls.rosters
      .map((r) => r.owner_id)
      .filter((id): id is string => !!id && !portfolio.has(id))
      .slice(0, opts.expandPerLeague);

    for (const ownerId of owners) {
      if (!canSpend(opts.seasons.length)) { stats.budgetExhausted = true; break; }
      let known = 0;
      for (const season of opts.seasons) {
        const leagues = await get<RawLeague[]>(`/user/${ownerId}/leagues/nfl/${season}`);
        for (const lg of leagues ?? []) {
          if (lg.sport && lg.sport !== 'nfl') continue;
          known++;
          if (!visited.has(lg.league_id)) frontier.push(lg.league_id);
        }
      }
      portfolio.set(ownerId, known);
      stats.portfoliosResolved++;
    }

    stats.frontierRemaining = frontier.length;
    deps.onProgress?.(stats);
  }
  stats.frontierRemaining = frontier.length;

  const { population, horizonBySeason } = assemble(crawled, portfolio, opts);
  stats.managersDiscovered = population.length;
  return { population, stats, horizonBySeason };
}

// Outcome of one league-season attempt. `dropped` still carries the chain
// pointer so the caller can keep walking the lineage.
type LeagueSeasonOutcome =
  | { kind: 'ok'; ls: CrawledLeagueSeason; previousLeagueId: string | null; season: string }
  | { kind: 'dropped'; previousLeagueId: string | null; season: string }
  | { kind: 'skipped' };

async function fetchLeagueSeason(
  leagueId: string,
  opts: CrawlOptions,
  get: <T>(path: string) => Promise<T | null>,
  seasonSet: Set<string>,
  stats: CrawlStats,
): Promise<LeagueSeasonOutcome> {
  let league: RawLeague | null;
  try {
    league = await get<RawLeague>(`/league/${leagueId}`);
  } catch {
    // Nothing readable, so nothing recoverable — not even the chain pointer.
    stats.errors++;
    stats.leagueSeasonsDropped++;
    return { kind: 'skipped' };
  }
  if (!league?.league_id) { stats.leagueSeasonsSkipped++; return { kind: 'skipped' }; }
  if (league.sport && league.sport !== 'nfl') { stats.leagueSeasonsSkipped++; return { kind: 'skipped' }; }
  if (!seasonSet.has(league.season)) { stats.leagueSeasonsSkipped++; return { kind: 'skipped' }; }

  const previousLeagueId = league.previous_league_id && league.previous_league_id !== '0'
    ? league.previous_league_id : null;
  const dropped: LeagueSeasonOutcome = { kind: 'dropped', previousLeagueId, season: league.season };

  try {
    const rosters = await get<RawRoster[]>(`/league/${leagueId}/rosters`);
    if (!rosters?.length) { stats.leagueSeasonsDropped++; return dropped; }

    // Every week or none: a partial transaction log is indistinguishable from
    // managers who went quiet.
    const transactions: { week: number; txns: SleeperRawTransaction[] }[] = [];
    for (let week = 1; week <= opts.weeks; week++) {
      const txns = await get<SleeperRawTransaction[]>(`/league/${leagueId}/transactions/${week}`);
      transactions.push({ week, txns: txns ?? [] });
    }

    let champion: number | null = null;
    let runnerUp: number | null = null;
    if (opts.brackets && league.status === 'complete') {
      const bracket = await get<RawBracketMatch[]>(`/league/${leagueId}/winners_bracket`);
      const final = (bracket ?? []).find((b) => b.p === 1);
      if (final) { champion = final.w ?? null; runnerUp = final.l ?? null; }
    }

    return {
      kind: 'ok',
      previousLeagueId,
      season: league.season,
      ls: {
        leagueId: league.league_id,
        previousLeagueId,
        name: league.name ?? '',
        season: league.season,
        status: league.status ?? 'unknown',
        totalRosters: league.total_rosters ?? rosters.length,
        rosterPositions: league.roster_positions ?? [],
        settings: league.settings ?? {},
        rosters,
        transactions,
        champion,
        runnerUp,
      },
    };
  } catch {
    stats.errors++;
    stats.leagueSeasonsDropped++;
    return dropped;
  }
}

// ── assembly ──

// The horizon is the last week a season could plausibly have had activity.
// Assuming 17 for an in-progress season would credit every manager with weeks
// of trailing silence and label the whole league abandoned, so it is derived
// from the data: the latest week anything happened anywhere in that season.
export function deriveHorizons(crawled: { season: string; transactions: { week: number; txns: unknown[] }[] }[]): Record<string, number> {
  const horizon: Record<string, number> = {};
  for (const ls of crawled) {
    for (const { week, txns } of ls.transactions) {
      if (!txns.length) continue;
      horizon[ls.season] = Math.max(horizon[ls.season] ?? 1, week);
    }
  }
  return horizon;
}

function assemble(
  crawled: CrawledLeagueSeason[],
  portfolio: Map<string, number>,
  opts: CrawlOptions,
): { population: ManagerObservation[]; horizonBySeason: Record<string, number> } {
  const horizonBySeason = deriveHorizons(crawled);
  const horizonFor = (season: string) => Math.min(17, horizonBySeason[season] ?? 17);

  // Population-wide refs, so retentionEvents can tell an individual exit apart
  // from a league that folded.
  const populationRefs: LeagueSeasonRef[] = crawled.map((ls) => ({
    leagueId: ls.leagueId, previousLeagueId: ls.previousLeagueId, season: ls.season, name: ls.name,
  }));

  interface Bucket {
    history: LeagueSeasonRecord[];
    events: TxnEvent[];
    starters: Map<string, string[]>;
    weeksScanned: number;
  }
  const byManager = new Map<string, Bucket>();

  for (const ls of crawled) {
    const format = leagueFormatInfo({
      settings: ls.settings, roster_positions: ls.rosterPositions,
    } as Parameters<typeof leagueFormatInfo>[0]);

    // Standings rank, computed once per league-season rather than per manager.
    const ranked = [...ls.rosters].sort((a, b) =>
      (b.settings?.wins ?? 0) - (a.settings?.wins ?? 0) ||
      toPoints(b.settings?.fpts, b.settings?.fpts_decimal) - toPoints(a.settings?.fpts, a.settings?.fpts_decimal));

    for (const roster of ls.rosters) {
      if (!roster.owner_id) continue;   // orphan team: no manager to attribute
      const key = roster.owner_id;
      if (!byManager.has(key)) {
        byManager.set(key, { history: [], events: [], starters: new Map(), weeksScanned: 0 });
      }
      const bucket = byManager.get(key)!;

      bucket.history.push({
        season: ls.season,
        leagueId: ls.leagueId,
        previousLeagueId: ls.previousLeagueId,
        leagueName: ls.name,
        status: ls.status,
        format,
        totalRosters: ls.totalRosters,
        rosterId: roster.roster_id,
        wins: roster.settings?.wins ?? 0,
        losses: roster.settings?.losses ?? 0,
        ties: roster.settings?.ties ?? 0,
        pointsFor: toPoints(roster.settings?.fpts, roster.settings?.fpts_decimal),
        regSeasonRank: ranked.findIndex((r) => r.roster_id === roster.roster_id) + 1,
        champion: ls.champion === roster.roster_id,
        runnerUp: ls.runnerUp === roster.roster_id,
        players: roster.players ?? [],
      });

      if (roster.starters) bucket.starters.set(ls.leagueId, roster.starters);
      bucket.weeksScanned += ls.transactions.length;

      for (const { week, txns } of ls.transactions) {
        const ctx: TxnContext = { leagueId: ls.leagueId, leagueName: ls.name, season: ls.season, week };
        for (const t of txns) {
          const ev = txnEventFor(t, roster.roster_id, ctx);
          if (ev) bucket.events.push(ev);
        }
      }
    }
  }

  const population: ManagerObservation[] = [];
  for (const [ownerId, bucket] of byManager) {
    const rows = managerSeasonEngagement(bucket.history, bucket.events, {
      horizonWeek: horizonFor,
      startersByLeague: bucket.starters,
    });
    const refs: LeagueSeasonRef[] = bucket.history.map((h) => ({
      leagueId: h.leagueId, previousLeagueId: h.previousLeagueId, season: h.season, name: h.leagueName,
    }));
    const knownLeagueSeasons = portfolio.get(ownerId);

    population.push({
      managerId: opts.pseudonymize ? pseudonymizeId(ownerId, opts.salt) : ownerId,
      rows,
      history: bucket.history,
      events: bucket.events,
      // Every emitted league-season had all its weeks fetched, so the sweep
      // itself is not truncated. Portfolio completeness is a separate axis,
      // reported below.
      sweep: { capped: false, weeksScanned: bucket.weeksScanned },
      retention: retentionEvents(refs, populationRefs),
      coverage: {
        portfolioKnown: knownLeagueSeasons !== undefined,
        knownLeagueSeasons: knownLeagueSeasons ?? rows.length,
        crawledLeagueSeasons: rows.length,
      },
    });
  }

  // Deterministic order so two runs of the same crawl diff cleanly.
  population.sort((a, b) => a.managerId.localeCompare(b.managerId));
  return { population, horizonBySeason };
}

// ── live fetcher: cached, paced, retrying ──

export interface FetcherOptions {
  cacheDir: string | null;
  rpm: number;
  concurrency: number;
  userAgent: string;
}

// Paces requests to a target rate and bounds concurrency. Sleeper's guidance is
// to stay under ~1000 calls/minute; the default here is well below that,
// because a crawl is a background job and there is nothing to gain from
// crowding a free public API.
export class Pacer {
  private minIntervalMs: number;
  private nextSlot = 0;
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(rpm: number, private concurrency: number) {
    this.minIntervalMs = rpm > 0 ? 60_000 / rpm : 0;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Re-check after waking: releasing a slot resolves a waiter but does not
    // reserve the slot for it, so another caller can take it synchronously in
    // between. A single `if` would let concurrency drift above the cap.
    while (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      const now = Date.now();
      const slot = Math.max(now, this.nextSlot);
      this.nextSlot = slot + this.minIntervalMs;
      const wait = slot - now;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const cachePath = (dir: string, path: string) =>
  `${dir}/${path.replace(/^\//, '').replace(/[^A-Za-z0-9._-]/g, '_')}.json`;

export function makeFetcher(o: FetcherOptions): (path: string) => Promise<unknown> {
  const pacer = new Pacer(o.rpm, o.concurrency);
  if (o.cacheDir) mkdirSync(o.cacheDir, { recursive: true });

  return async (path: string): Promise<unknown> => {
    const file = o.cacheDir ? cachePath(o.cacheDir, path) : null;
    if (file && existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, 'utf8')).data;
      } catch { /* corrupt cache entry: refetch */ }
    }

    const data = await pacer.run(async () => {
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await fetch(`${SLEEPER}${path}`, { headers: { 'User-Agent': o.userAgent } });
          if (res.status === 404) return null;
          if (res.status === 429 || res.status >= 500) {
            // Honour Retry-After when Sleeper sends it, else back off.
            const retryAfter = Number(res.headers.get('retry-after'));
            const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : 1000 * 2 ** attempt;
            await new Promise((r) => setTimeout(r, waitMs));
            lastError = new Error(`HTTP ${res.status}`);
            continue;
          }
          if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
          return await res.json();
        } catch (err) {
          lastError = err;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        }
      }
      throw lastError instanceof Error ? lastError : new Error(`Failed: ${path}`);
    });

    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ path, data }));
    }
    return data;
  };
}

// ── CLI ──

function parseArgs() {
  const args = new Map(
    process.argv.slice(2).map((a) => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v ?? 'true'] as [string, string];
    }),
  );
  const list = (key: string) => (args.get(key) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const int = (key: string, dflt: number) => {
    const v = Number(args.get(key));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
  };
  const thisYear = new Date().getUTCFullYear();
  return {
    seeds: list('seed'),
    seedUser: args.get('seedUser'),
    seasons: list('seasons').length
      ? list('seasons')
      : Array.from({ length: 4 }, (_, i) => String(thisYear - 3 + i)),
    maxRequests: int('maxRequests', 20_000),
    maxLeagueSeasons: int('maxLeagueSeasons', 400),
    expandPerLeague: int('expandPerLeague', 3),
    rpm: int('rpm', 600),
    concurrency: int('concurrency', 8),
    out: args.get('out') ?? 'sleeper-population.json',
    cacheDir: args.get('cache') === 'false' ? null : (args.get('cache') ?? '.cache/sleeper-crawl'),
    brackets: args.get('no-brackets') !== 'true',
    pseudonymize: args.get('reveal-ids') !== 'true',
    salt: args.get('salt') ?? process.env.SLEEPER_CRAWL_SALT ?? 'stathead-engagement-v1',
    plan: args.get('plan') === 'true',
  };
}

async function main() {
  const a = parseArgs();
  const opts: CrawlOptions = {
    seedLeagueIds: a.seeds,
    seasons: a.seasons,
    maxRequests: a.maxRequests,
    maxLeagueSeasons: a.maxLeagueSeasons,
    expandPerLeague: a.expandPerLeague,
    weeks: WEEKS,
    brackets: a.brackets,
    pseudonymize: a.pseudonymize,
    salt: a.salt,
  };

  const perLeague = leagueSeasonCost(opts);
  console.log(`\nSleeper population crawl`);
  console.log(`  seasons          ${opts.seasons.join(', ')}`);
  console.log(`  cost/league-szn  ${perLeague} requests (2 + ${opts.weeks} weeks${opts.brackets ? ' + bracket' : ''})`);
  console.log(`  caps             ${opts.maxLeagueSeasons} league-seasons, ${opts.maxRequests} requests`);
  console.log(`  worst case       ~${(opts.maxLeagueSeasons * (perLeague + opts.expandPerLeague * opts.seasons.length)).toLocaleString()} requests`);
  console.log(`  pace             ${a.rpm}/min, ${a.concurrency} concurrent`);
  console.log(`  ids              ${opts.pseudonymize ? 'salted hash' : 'RAW — do not share this file'}`);
  console.log(`  cache            ${a.cacheDir ?? 'disabled'}\n`);

  if (a.plan) { console.log('  --plan: no requests made.\n'); return; }

  const getJson = makeFetcher({
    cacheDir: a.cacheDir, rpm: a.rpm, concurrency: a.concurrency,
    userAgent: 'stathead-engagement-crawl/1.0 (+https://github.com/dachhack/stathead)',
  });

  // Seeding from a username is a convenience: resolve them, then take their
  // leagues as seed leagues. The crawl itself is league-oriented from there.
  if (a.seedUser) {
    const user = await getJson(`/user/${a.seedUser}`) as { user_id?: string } | null;
    if (!user?.user_id) throw new Error(`No Sleeper user found for "${a.seedUser}".`);
    for (const season of opts.seasons) {
      const leagues = await getJson(`/user/${user.user_id}/leagues/nfl/${season}`) as { league_id: string }[] | null;
      for (const lg of leagues ?? []) opts.seedLeagueIds.push(lg.league_id);
    }
    console.log(`  seeded ${opts.seedLeagueIds.length} leagues from --seedUser\n`);
  }

  if (!opts.seedLeagueIds.length) {
    console.error('No seeds. Pass --seed=<leagueId>[,<id>...] or --seedUser=<username>.');
    process.exit(2);
  }

  let lastLog = 0;
  const result = await crawl(opts, {
    getJson,
    onProgress: (s) => {
      if (s.leagueSeasonsCrawled === lastLog) return;
      lastLog = s.leagueSeasonsCrawled;
      if (s.leagueSeasonsCrawled % 10 === 0) {
        console.log(`  ${s.leagueSeasonsCrawled} league-seasons · ${s.requests} requests · ${s.frontierRemaining} queued`);
      }
    },
  });

  const s = result.stats;
  mkdirSync(dirname(a.out) === '.' ? '.' : dirname(a.out), { recursive: true });
  writeFileSync(a.out, `${JSON.stringify(result.population, null, 2)}\n`);
  writeFileSync(`${a.out.replace(/\.json$/, '')}-manifest.json`, `${JSON.stringify({
    crawledAt: new Date().toISOString(), options: { ...opts, salt: opts.pseudonymize ? '<redacted>' : undefined },
    stats: s, horizonBySeason: result.horizonBySeason,
  }, null, 2)}\n`);

  console.log(`\n  league-seasons   ${s.leagueSeasonsCrawled} crawled, ${s.leagueSeasonsDropped} dropped, ${s.leagueSeasonsSkipped} skipped`);
  console.log(`  managers         ${s.managersDiscovered} (${s.portfoliosResolved} portfolios resolved)`);
  console.log(`  requests         ${s.requests}${s.budgetExhausted ? ' — BUDGET EXHAUSTED' : ''}`);
  console.log(`  frontier left    ${s.frontierRemaining}`);
  console.log(`  horizons         ${JSON.stringify(result.horizonBySeason)}`);
  console.log(`\n  → ${a.out}\n`);
  if (s.budgetExhausted) {
    console.log('  Budget ran out mid-crawl. No partial league-season was emitted, so the');
    console.log('  population is smaller but not corrupted. Raise --maxRequests to go further.\n');
  }
  console.log('  Next: npm run report:engagement-audit -- --input=' + a.out + '\n');
}

// Only run the CLI when invoked directly, so the test can import the crawl.
if (process.argv[1] && /crawl-sleeper-population/.test(process.argv[1])) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
