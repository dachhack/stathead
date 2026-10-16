// Sleeper trade-market crawler: every completed trade (players, draft picks,
// FAAB) in as many leagues as the budget reaches, with the league context
// needed to value it, plus every FAAB waiver bid (won and lost).
//
// Run:  npx tsx scripts/crawl-sleeper-trades.ts --seedUser=<name>[,<name>...]
//                                               [--seed=<leagueId>,...]
//                                               [--dir=data-private/sleeper-trades]
//                                               [--seasons=2019-2026]
//                                               [--hours=5.5] [--maxRequests=300000]
//                                               [--maxLeagueSeasons=100000]
//                                               [--rpm=800] [--workers=8]
//                                               [--expandPerLeague=1] [--maxFrontier=20000]
//                                               [--refreshCurrent] [--allMoves] [--plan]
//
// WHAT IT WRITES (all under --dir, gitignored; docs/sleeper-trade-db.md):
//   shards/<run>-leagues.jsonl.gz  one row per league-season: full settings and
//                                  scoring, roster slots, every roster (record,
//                                  points, players, taxi, IR), weekly matchups up
//                                  to the last in-season trade, playoff result,
//                                  every draft with its order and selections
//   shards/<run>-trades.jsonl.gz   one row per trade: each side's players, picks
//                                  (season, round, original owner) and FAAB,
//                                  players cut to make room, each team's record
//                                  at the time, and a league-format summary
//   shards/<run>-waivers.jsonl.gz  FAAB claims, won and lost, with the bid
//   state.json.gz                  frontier and visited set, so the next run
//                                  continues where this one stopped
// scripts/build-sleeper-trade-db.py merges the shards into one SQLite database
// and resolves picks to draft slots and selected players across seasons.
//
// DISCOVERY. Sleeper has no league search, so the crawl snowballs: seed leagues
// → their managers' other leagues (horizontal, sampled) and each league's
// previous seasons (vertical, always). Dynasty leagues are crawled first (the
// trade market that matters most and the one that trades most), then keeper,
// then redraft; newest seasons first within each. Leagues with trading
// disabled are never fetched.
//
// PRIVACY. Sleeper is public, but these are real people. League, user and
// transaction ids are salted hashes (salt from SLEEPER_CRAWL_SALT; keep it
// stable or ids stop joining across runs); league names, team names, display
// names and chat text are never stored. The output stays out of git: CI keeps
// it in an encrypted release asset (sleeper-trade-crawl.yml).
import { createHash } from 'crypto';
import { gunzipSync, gzipSync } from 'zlib';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { makeFetcher } from './crawl-sleeper-population';

// ── raw Sleeper shapes (only what we read) ──

export interface RawLeague {
  league_id: string;
  previous_league_id?: string | null;
  season: string;
  season_type?: string;
  status?: string;
  sport?: string;
  total_rosters?: number;
  roster_positions?: string[];
  settings?: Record<string, number | null | undefined>;
  scoring_settings?: Record<string, number>;
}

export interface RawRoster {
  roster_id: number;
  owner_id: string | null;
  co_owners?: string[] | null;
  players?: string[] | null;
  starters?: string[] | null;
  taxi?: string[] | null;
  reserve?: string[] | null;
  keepers?: string[] | null;
  settings?: Record<string, number | undefined>;
}

export interface RawTxn {
  transaction_id: string;
  type: string;
  status: string;
  leg?: number;
  created?: number;
  status_updated?: number;
  creator?: string;
  roster_ids?: number[];
  consenter_ids?: number[];
  adds?: Record<string, number> | null;
  drops?: Record<string, number> | null;
  draft_picks?: { season: string; round: number; roster_id: number; previous_owner_id: number; owner_id: number }[] | null;
  waiver_budget?: { sender: number; receiver: number; amount: number }[] | null;
  settings?: { waiver_bid?: number; seq?: number; priority?: number } | null;
  metadata?: { notes?: string } | null;
}

export interface RawDraft {
  draft_id: string;
  type?: string;
  status?: string;
  season?: string;
  season_type?: string;
  start_time?: number | null;
  settings?: Record<string, number>;
  slot_to_roster_id?: Record<string, number> | null;
  metadata?: { scoring_type?: string } | null;
}

export interface RawDraftPick {
  pick_no: number;
  round: number;
  draft_slot: number;
  roster_id: number | null;
  player_id: string;
  is_keeper?: boolean | null;
  metadata?: { amount?: string; position?: string } | null;
}

interface RawMatchup { roster_id: number; matchup_id: number | null; points?: number }
interface RawBracketMatch { r?: number; p?: number; w?: number | null; l?: number | null }

// ── options and output ──

export interface TradeCrawlOptions {
  seedLeagueIds: string[];
  seasons: string[];
  currentSeason: string;
  currentLeg: number;           // NFL state leg: the last leg worth fetching this season
  maxRequests: number;
  maxLeagueSeasons: number;
  deadline: number;             // epoch ms; stop starting new league-seasons after it
  workers: number;
  expandPerLeague: number;
  expansionSeasons: string[];   // seasons listed when expanding a manager
  maxFrontier: number;          // stop expanding horizontally above this many queued
  allMoves: boolean;            // also keep free-agent and commissioner moves
  salt: string;
}

export interface Sink {
  league(row: object): void;
  trade(row: object): void;
  waiver(row: object): void;
}

export interface CrawlState {
  version: 1;
  saltCheck: string;
  // Queued league ids with their priority (higher first).
  frontier: [string, number][];
  // league id → leg it was crawled through (99 = season complete).
  visited: Record<string, number>;
  expandedUsers: string[];
  totals: { leagueSeasons: number; trades: number; waivers: number; requests: number; runs: number };
}

export interface TradeCrawlStats {
  requests: number;
  leagueSeasons: number;
  leaguesSkipped: number;
  leaguesFailed: number;
  trades: number;
  waivers: number;
  managersExpanded: number;
  frontier: number;
  stoppedBy: 'frontier' | 'requests' | 'leagueSeasons' | 'deadline' | null;
}

// ── pure helpers (exported for the offline test) ──

export const hashId = (salt: string, kind: string, id: string): string =>
  createHash('sha256').update(`${salt}:${kind}:${id}`).digest('hex').slice(0, 16);

export const saltCheck = (salt: string) => hashId(salt, 'check', 'stathead');

// Crawl order: dynasty, then keeper, then redraft; newest season first within
// each. Format matters more than recency: a 2019 dynasty trade prices a pick
// against players, which no redraft trade ever does.
export function leaguePriority(lg: Pick<RawLeague, 'season' | 'settings'>): number {
  const type = Number(lg.settings?.type ?? 0);
  const typeRank = type === 2 ? 3 : type === 1 ? 2 : 1;
  return typeRank * 100 + (Number(lg.season) - 2000);
}

// Priority offsets: lineage hops first, then seeds, then discovered leagues.
const VERTICAL = 2000;
const SEED = 1000;

export const tradesDisabled = (lg: Pick<RawLeague, 'settings'>) => Number(lg.settings?.disable_trades ?? 0) === 1;

const toPts = (whole?: number, dec?: number) =>
  Math.round(((whole ?? 0) + (dec ?? 0) / 100) * 100) / 100;

// The handful of facts a trade is valued against, derived once per league so
// every trade row can carry them without the leagues table.
export function formatSummary(lg: RawLeague) {
  const pos = lg.roster_positions ?? [];
  const count = (p: string) => pos.filter((x) => x === p).length;
  const s = lg.settings ?? {};
  const sc = lg.scoring_settings ?? {};
  const type = Number(s.type ?? 0);
  const starters = pos.filter((p) => p !== 'BN' && p !== 'IR' && p !== 'TAXI').length;
  const idp = pos.some((p) => ['DL', 'LB', 'DB', 'IDP_FLEX', 'DE', 'DT', 'CB', 'S'].includes(p));
  return {
    type: type === 2 ? 'dynasty' : type === 1 ? 'keeper' : 'redraft',
    teams: lg.total_rosters ?? Number(s.num_teams ?? 0),
    qb: count('QB'),
    superflex: count('SUPER_FLEX'),
    sf: count('SUPER_FLEX') > 0 || count('QB') >= 2,
    rb: count('RB'), wr: count('WR'), te: count('TE'),
    flex: count('FLEX') + count('REC_FLEX') + count('WRRB_FLEX'),
    starters,
    bench: count('BN'),
    taxi: Number(s.taxi_slots ?? 0),
    ir: Number(s.reserve_slots ?? 0),
    idp,
    ppr: sc.rec ?? 0,
    tep: sc.bonus_rec_te ?? 0,
    passTd: sc.pass_td ?? 4,
    ppc: sc.rush_att ?? 0,
    pprFirstDown: (sc.rec_fd ?? 0) || (sc.rush_fd ?? 0) ? 1 : 0,
    bestBall: Number(s.best_ball ?? 0) === 1,
    faabBudget: Number(s.waiver_type ?? 0) === 2 ? Number(s.waiver_budget ?? 100) : 0,
    tradeDeadline: Number(s.trade_deadline ?? 99),
    playoffTeams: Number(s.playoff_teams ?? 0),
    playoffWeekStart: Number(s.playoff_week_start ?? 0),
    draftRounds: Number(s.draft_rounds ?? 0),
    pickTrading: Number(s.pick_trading ?? 1) === 1,
  };
}

// Running record per roster BEFORE a given leg, from weekly matchups. A trade
// in leg L is made with weeks 1..L-1 decided.
export function recordsBefore(
  matchups: Record<string, [number, number | null, number][]>,
  leg: number,
): Map<number, { w: number; l: number; t: number; pf: number; pa: number; rank: number }> {
  const rec = new Map<number, { w: number; l: number; t: number; pf: number; pa: number; rank: number }>();
  for (const [wk, rows] of Object.entries(matchups)) {
    if (Number(wk) >= leg) continue;
    const byMatch = new Map<number, [number, number][]>();
    for (const [rid, mid, pts] of rows) {
      const r = rec.get(rid) ?? { w: 0, l: 0, t: 0, pf: 0, pa: 0, rank: 0 };
      r.pf = Math.round((r.pf + pts) * 100) / 100;
      rec.set(rid, r);
      if (mid == null) continue;
      if (!byMatch.has(mid)) byMatch.set(mid, []);
      byMatch.get(mid)!.push([rid, pts]);
    }
    for (const pair of byMatch.values()) {
      if (pair.length !== 2) continue;
      const [[a, pa], [b, pb]] = pair;
      const ra = rec.get(a)!, rb = rec.get(b)!;
      ra.pa = Math.round((ra.pa + pb) * 100) / 100;
      rb.pa = Math.round((rb.pa + pa) * 100) / 100;
      if (pa > pb) { ra.w++; rb.l++; } else if (pb > pa) { rb.w++; ra.l++; } else { ra.t++; rb.t++; }
    }
  }
  const order = [...rec.entries()].sort(([, x], [, y]) => (y.w + y.t / 2) - (x.w + x.t / 2) || y.pf - x.pf);
  order.forEach(([, r], i) => { r.rank = i + 1; });
  return rec;
}

export interface TradeSideOut {
  rid: number;
  owner: string | null;
  gets: { players: string[]; picks: { season: string; round: number; orig: number }[]; faab: number };
  gives: { players: string[]; picks: { season: string; round: number; orig: number }[]; faab: number };
  cut: string[];        // dropped in the same transaction without going to a partner
  added: string[];      // added from free agency in the same transaction
  record?: { w: number; l: number; t: number; pf: number; pa: number; rank: number };
}

// One Sleeper trade → one side per roster. Sleeper encodes a trade as adds
// (player → receiving roster) and drops (player → giving roster); a player in
// drops but not in adds was released, one in adds but not in drops was picked
// up from free agency as part of the deal.
export function tradeSides(t: RawTxn, ownerOf: (rid: number) => string | null): TradeSideOut[] {
  const rids = [...new Set([
    ...(t.roster_ids ?? []),
    ...Object.values(t.adds ?? {}), ...Object.values(t.drops ?? {}),
    ...(t.draft_picks ?? []).flatMap((p) => [p.owner_id, p.previous_owner_id]),
    ...(t.waiver_budget ?? []).flatMap((w) => [w.sender, w.receiver]),
  ])].sort((a, b) => a - b);
  const empty = () => ({ players: [] as string[], picks: [] as { season: string; round: number; orig: number }[], faab: 0 });
  const sides = new Map<number, TradeSideOut>(rids.map((rid) => [rid, {
    rid, owner: ownerOf(rid), gets: empty(), gives: empty(), cut: [], added: [],
  }]));
  const adds = t.adds ?? {}, drops = t.drops ?? {};
  for (const [pid, to] of Object.entries(adds)) {
    const from = drops[pid];
    if (from === undefined) sides.get(to)!.added.push(pid);
    else { sides.get(to)!.gets.players.push(pid); sides.get(from)!.gives.players.push(pid); }
  }
  for (const [pid, from] of Object.entries(drops)) {
    if (adds[pid] === undefined) sides.get(from)!.cut.push(pid);
  }
  for (const p of t.draft_picks ?? []) {
    const pick = { season: String(p.season), round: p.round, orig: p.roster_id };
    sides.get(p.owner_id)!.gets.picks.push(pick);
    sides.get(p.previous_owner_id)!.gives.picks.push(pick);
  }
  for (const w of t.waiver_budget ?? []) {
    sides.get(w.receiver)!.gets.faab += w.amount;
    sides.get(w.sender)!.gives.faab += w.amount;
  }
  for (const s of sides.values()) {
    for (const k of ['gets', 'gives'] as const) {
      s[k].players.sort();
      s[k].picks.sort((a, b) => a.season.localeCompare(b.season) || a.round - b.round || a.orig - b.orig);
    }
    s.cut.sort(); s.added.sort();
  }
  return [...sides.values()];
}

// ── the crawl ──

export interface CrawlDeps {
  getJson: (path: string) => Promise<unknown>;
  sink: Sink;
  now?: () => number;
  onProgress?: (s: TradeCrawlStats) => void;
}

export function emptyState(salt: string): CrawlState {
  return {
    version: 1, saltCheck: saltCheck(salt), frontier: [], visited: {}, expandedUsers: [],
    totals: { leagueSeasons: 0, trades: 0, waivers: 0, requests: 0, runs: 0 },
  };
}

// Max-priority queue as priority buckets: priorities are small integers
// (type x 100 + season), so a sorted key list beats a heap and keeps FIFO order
// within a bucket, which makes a re-run walk the same graph.
class Frontier {
  private buckets = new Map<number, string[]>();
  private keys: number[] = [];
  private queued = new Set<string>();
  get size() { return this.queued.size; }
  has(id: string) { return this.queued.has(id); }
  push(id: string, prio: number) {
    if (this.queued.has(id)) return;
    this.queued.add(id);
    let b = this.buckets.get(prio);
    if (!b) {
      b = [];
      this.buckets.set(prio, b);
      this.keys.push(prio);
      this.keys.sort((a, c) => c - a);
    }
    b.push(id);
  }
  pop(): [string, number] | undefined {
    while (this.keys.length) {
      const k = this.keys[0];
      const b = this.buckets.get(k)!;
      const id = b.shift();
      if (id !== undefined) { this.queued.delete(id); return [id, k]; }
      this.buckets.delete(k);
      this.keys.shift();
    }
    return undefined;
  }
  dump(): [string, number][] {
    return this.keys.flatMap((k) => this.buckets.get(k)!.map((id) => [id, k] as [string, number]));
  }
}

export async function crawlTrades(
  opts: TradeCrawlOptions,
  state: CrawlState,
  deps: CrawlDeps,
): Promise<TradeCrawlStats> {
  if (state.saltCheck !== saltCheck(opts.salt)) {
    throw new Error('Salt differs from the one this state was built with: ids would stop joining. Use the original SLEEPER_CRAWL_SALT.');
  }
  const now = deps.now ?? Date.now;
  const seasonSet = new Set(opts.seasons);
  const H = (kind: string, id: string) => hashId(opts.salt, kind, id);
  const stats: TradeCrawlStats = {
    requests: 0, leagueSeasons: 0, leaguesSkipped: 0, leaguesFailed: 0, trades: 0, waivers: 0,
    managersExpanded: 0, frontier: 0, stoppedBy: null,
  };

  const frontier = new Frontier();
  for (const [id, prio] of state.frontier) frontier.push(id, prio);
  for (const id of opts.seedLeagueIds) if (!(id in state.visited)) frontier.push(id, SEED);
  const expanded = new Set(state.expandedUsers);
  // Leagues in flight count as visited, so two workers never take the same one.
  const claimed = new Set<string>();

  const get = async <T>(path: string): Promise<T | null> => {
    stats.requests++;
    return (await deps.getJson(path)) as T | null;
  };
  // A league-season costs at most this many requests; reserve it before starting.
  const worstCase = 2 + 18 + 18 + 2 + 6;
  const canStart = () => {
    if (now() >= opts.deadline) { stats.stoppedBy = 'deadline'; return false; }
    if (stats.requests + worstCase > opts.maxRequests) { stats.stoppedBy = 'requests'; return false; }
    if (stats.leagueSeasons >= opts.maxLeagueSeasons) { stats.stoppedBy = 'leagueSeasons'; return false; }
    return true;
  };

  const enqueue = (lg: Pick<RawLeague, 'league_id' | 'season' | 'settings' | 'sport'>) => {
    if (!lg?.league_id || (lg.sport && lg.sport !== 'nfl')) return;
    if (!seasonSet.has(String(lg.season)) || tradesDisabled(lg)) return;
    if (lg.league_id in state.visited || claimed.has(lg.league_id)) return;
    frontier.push(lg.league_id, leaguePriority(lg));
  };

  const expandManager = async (userId: string) => {
    if (expanded.has(userId)) return;
    expanded.add(userId);
    stats.managersExpanded++;
    for (const season of opts.expansionSeasons) {
      const leagues = await get<RawLeague[]>(`/user/${userId}/leagues/nfl/${season}`);
      for (const lg of leagues ?? []) enqueue(lg);
    }
  };

  const crawlLeague = async (leagueId: string): Promise<void> => {
    const lg = await get<RawLeague>(`/league/${leagueId}`);
    if (!lg?.league_id || (lg.sport && lg.sport !== 'nfl') || !seasonSet.has(String(lg.season))) {
      stats.leaguesSkipped++;
      state.visited[leagueId] = 99;
      return;
    }
    const prev = lg.previous_league_id && lg.previous_league_id !== '0' ? lg.previous_league_id : null;
    // Vertical: the league's own earlier seasons, ahead of every new league.
    // Newest-first would otherwise drain the current season's frontier forever
    // and never reach history, and a lineage is what resolves a traded pick to
    // the player it became and gives each team last season's finish.
    if (prev && !(prev in state.visited) && seasonSet.has(String(Number(lg.season) - 1))) {
      frontier.push(prev, VERTICAL + leaguePriority({ ...lg, season: String(Number(lg.season) - 1) }));
    }
    if (tradesDisabled(lg)) { stats.leaguesSkipped++; state.visited[leagueId] = 99; return; }

    const current = String(lg.season) === opts.currentSeason && lg.status !== 'complete';
    const lastLeg = current ? Math.max(1, Math.min(18, opts.currentLeg)) : 18;

    const [rosters, drafts, ...weeks] = await Promise.all([
      get<RawRoster[]>(`/league/${leagueId}/rosters`),
      get<RawDraft[]>(`/league/${leagueId}/drafts`),
      ...Array.from({ length: lastLeg }, (_, i) => get<RawTxn[]>(`/league/${leagueId}/transactions/${i + 1}`)),
    ]);
    if (!rosters?.length) { stats.leaguesSkipped++; state.visited[leagueId] = 99; return; }

    const ownerOf = new Map<number, string | null>(rosters.map((r) => [r.roster_id, r.owner_id ? H('user', r.owner_id) : null]));
    const rosterOfUser = new Map<string, number>();
    for (const r of rosters) {
      if (r.owner_id) rosterOfUser.set(r.owner_id, r.roster_id);
      for (const c of r.co_owners ?? []) rosterOfUser.set(c, r.roster_id);
    }

    // Transactions: dedupe by id (Sleeper occasionally repeats one across legs).
    const seen = new Set<string>();
    const txns: RawTxn[] = [];
    weeks.forEach((list, i) => {
      for (const t of list ?? []) {
        if (!t?.transaction_id || seen.has(t.transaction_id)) continue;
        seen.add(t.transaction_id);
        txns.push({ ...t, leg: t.leg ?? i + 1 });
      }
    });
    const trades = txns.filter((t) => t.type === 'trade' && t.status === 'complete');

    // Weekly matchups up to the last in-season trade, so each trade carries
    // both teams' records at the time. Leg-1 trades need none.
    const matchups: Record<string, [number, number | null, number][]> = {};
    const maxTradeLeg = Math.max(0, ...trades.map((t) => t.leg ?? 1));
    const scored = current ? Math.max(0, opts.currentLeg - 1) : 17;
    const mWeeks = Math.min(maxTradeLeg - 1, scored);
    if (mWeeks > 0) {
      const res = await Promise.all(Array.from({ length: mWeeks }, (_, i) =>
        get<RawMatchup[]>(`/league/${leagueId}/matchups/${i + 1}`)));
      res.forEach((rows, i) => {
        if (rows?.length) matchups[String(i + 1)] = rows.map((m) => [m.roster_id, m.matchup_id ?? null, Math.round((m.points ?? 0) * 100) / 100]);
      });
    }

    let champion: number | null = null, runnerUp: number | null = null;
    if (lg.status === 'complete') {
      const bracket = await get<RawBracketMatch[]>(`/league/${leagueId}/winners_bracket`);
      const final = (bracket ?? []).find((b) => b.p === 1);
      if (final) { champion = final.w ?? null; runnerUp = final.l ?? null; }
    }

    // Drafts with their selections: startup drafts price the whole player pool,
    // rookie drafts turn the picks traded here into players.
    const draftRows = [];
    for (const listed of drafts ?? []) {
      // The league's draft list omits slot_to_roster_id, which ties a draft slot
      // to the roster that owned it originally; the draft's own document has it.
      const [doc, picks] = await Promise.all([
        get<RawDraft>(`/draft/${listed.draft_id}`),
        listed.status === 'complete' || listed.status === 'drafting'
          ? get<RawDraftPick[]>(`/draft/${listed.draft_id}/picks`) : Promise.resolve(null),
      ]);
      const d = { ...listed, ...(doc ?? {}) };
      draftRows.push({
        draft: H('draft', d.draft_id),
        type: d.type ?? null, status: d.status ?? null, season: d.season ?? null,
        seasonType: d.season_type ?? null, startTime: d.start_time ?? null,
        scoringType: d.metadata?.scoring_type ?? null,
        settings: d.settings ?? {},
        slotToRoster: d.slot_to_roster_id ?? null,
        picks: (picks ?? []).map((p) => [p.pick_no, p.round, p.draft_slot, p.roster_id, p.player_id,
          p.is_keeper ? 1 : 0, p.metadata?.amount ? Number(p.metadata.amount) : null]),
      });
    }

    const fmt = formatSummary(lg);
    const lgHash = H('league', lg.league_id);
    const ranked = [...rosters].sort((a, b) =>
      (b.settings?.wins ?? 0) - (a.settings?.wins ?? 0) ||
      toPts(b.settings?.fpts, b.settings?.fpts_decimal) - toPts(a.settings?.fpts, a.settings?.fpts_decimal));
    const counts: Record<string, number> = {};
    for (const t of txns) counts[t.type] = (counts[t.type] ?? 0) + 1;

    deps.sink.league({
      lg: lgHash,
      prev: prev ? H('league', prev) : null,
      season: String(lg.season),
      seasonType: lg.season_type ?? null,
      status: lg.status ?? null,
      throughLeg: current ? lastLeg : 99,
      crawledAt: new Date(now()).toISOString(),
      format: fmt,
      totalRosters: lg.total_rosters ?? rosters.length,
      rosterPositions: lg.roster_positions ?? [],
      settings: lg.settings ?? {},
      scoring: lg.scoring_settings ?? {},
      txnCounts: counts,
      champion, runnerUp,
      rosters: rosters.map((r) => ({
        rid: r.roster_id,
        owner: ownerOf.get(r.roster_id) ?? null,
        coOwners: (r.co_owners ?? []).map((c) => H('user', c)),
        w: r.settings?.wins ?? 0, l: r.settings?.losses ?? 0, t: r.settings?.ties ?? 0,
        pf: toPts(r.settings?.fpts, r.settings?.fpts_decimal),
        pa: toPts(r.settings?.fpts_against, r.settings?.fpts_against_decimal),
        maxPf: toPts(r.settings?.ppts, r.settings?.ppts_decimal),
        rank: ranked.findIndex((x) => x.roster_id === r.roster_id) + 1,
        faabUsed: r.settings?.waiver_budget_used ?? 0,
        moves: r.settings?.total_moves ?? 0,
        players: r.players ?? [], starters: r.starters ?? [],
        taxi: r.taxi ?? [], reserve: r.reserve ?? [], keepers: r.keepers ?? [],
      })),
      matchups,
      drafts: draftRows,
    });

    for (const t of trades) {
      const leg = t.leg ?? 1;
      const recs = leg > 1 ? recordsBefore(matchups, leg) : null;
      const sides = tradeSides(t, (rid) => ownerOf.get(rid) ?? null).map((s) => ({
        ...s, ...(recs?.get(s.rid) ? { record: recs.get(s.rid) } : {}),
      }));
      const creatorRid = t.creator ? rosterOfUser.get(t.creator) ?? null : null;
      deps.sink.trade({
        id: H('txn', t.transaction_id),
        lg: lgHash,
        season: String(lg.season),
        leg,
        created: t.created ?? null,
        completed: t.status_updated ?? null,
        creatorRid,
        nSides: sides.length,
        sides,
        format: fmt,
        // Raw Sleeper encoding too, so nothing is lost to the parsing above.
        raw: { adds: t.adds ?? null, drops: t.drops ?? null, draft_picks: t.draft_picks ?? null, waiver_budget: t.waiver_budget ?? null, roster_ids: t.roster_ids ?? null },
      });
      stats.trades++;
    }

    for (const t of txns) {
      const isWaiver = t.type === 'waiver';
      if (!isWaiver && !(opts.allMoves && (t.type === 'free_agent' || t.type === 'commissioner'))) continue;
      const rid = t.roster_ids?.[0] ?? null;
      deps.sink.waiver({
        id: H('txn', t.transaction_id),
        lg: lgHash,
        season: String(lg.season),
        leg: t.leg ?? null,
        type: t.type,
        status: t.status,
        created: t.created ?? null,
        rid,
        owner: rid != null ? ownerOf.get(rid) ?? null : null,
        adds: Object.keys(t.adds ?? {}).sort(),
        drops: Object.keys(t.drops ?? {}).sort(),
        bid: t.settings?.waiver_bid ?? null,
        faabBudget: fmt.faabBudget,
        teams: fmt.teams,
        leagueType: fmt.type,
        sf: fmt.sf,
      });
      stats.waivers++;
    }

    state.visited[leagueId] = current ? lastLeg : 99;
    stats.leagueSeasons++;

    // Horizontal: sample managers and queue their leagues, while the frontier
    // is small enough to need it. Deterministic (roster order).
    if (frontier.size < opts.maxFrontier) {
      const owners = rosters.map((r) => r.owner_id).filter((id): id is string => !!id && !expanded.has(id))
        .slice(0, opts.expandPerLeague);
      // A failed listing only costs discovery; the league itself is recorded.
      for (const u of owners) await expandManager(u).catch(() => undefined);
    }
  };

  const worker = async () => {
    for (;;) {
      if (!canStart()) return;
      const next = frontier.pop();
      if (!next) {
        // Others may still add to the frontier; wait for them before quitting.
        if (claimed.size === 0) return;
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      const [id] = next;
      if (id in state.visited || claimed.has(id)) continue;
      claimed.add(id);
      try {
        await crawlLeague(id);
      } catch {
        // Not marked visited: a transient failure is retried next run. Its
        // partial rows were never written (everything is emitted at the end).
        stats.leaguesFailed++;
      } finally {
        claimed.delete(id);
      }
      stats.frontier = frontier.size;
      deps.onProgress?.(stats);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, opts.workers) }, worker));
  if (!stats.stoppedBy && frontier.size === 0) stats.stoppedBy = 'frontier';

  state.frontier = frontier.dump();
  state.expandedUsers = [...expanded];
  state.totals.leagueSeasons += stats.leagueSeasons;
  state.totals.trades += stats.trades;
  state.totals.waivers += stats.waivers;
  state.totals.requests += stats.requests;
  state.totals.runs += 1;
  stats.frontier = frontier.size;
  return stats;
}

// ── file sink: gzipped JSONL shards, written as they come ──

export function fileSink(dir: string, run: string): Sink & { close(): void } {
  mkdirSync(`${dir}/shards`, { recursive: true });
  const parts = { leagues: [] as string[], trades: [] as string[], waivers: [] as string[] };
  const paths = {
    leagues: `${dir}/shards/${run}-leagues.jsonl.gz`,
    trades: `${dir}/shards/${run}-trades.jsonl.gz`,
    waivers: `${dir}/shards/${run}-waivers.jsonl.gz`,
  };
  // Gzip members concatenate into a valid gzip stream, so flushing in blocks
  // keeps memory flat and loses at most one block on a crash.
  const flush = (k: keyof typeof parts, force = false) => {
    if (!parts[k].length || (!force && parts[k].length < 2000)) return;
    appendFileSync(paths[k], gzipSync(parts[k].join('')));
    parts[k] = [];
  };
  return {
    league: (r) => { parts.leagues.push(`${JSON.stringify(r)}\n`); flush('leagues'); },
    trade: (r) => { parts.trades.push(`${JSON.stringify(r)}\n`); flush('trades'); },
    waiver: (r) => { parts.waivers.push(`${JSON.stringify(r)}\n`); flush('waivers'); },
    close: () => { flush('leagues', true); flush('trades', true); flush('waivers', true); },
  };
}

export function loadState(dir: string, salt: string): CrawlState {
  const p = `${dir}/state.json.gz`;
  if (!existsSync(p)) return emptyState(salt);
  return JSON.parse(gunzipSync(readFileSync(p)).toString('utf8')) as CrawlState;
}

export function saveState(dir: string, state: CrawlState) {
  mkdirSync(dir, { recursive: true });
  const tmp = `${dir}/state.json.gz.tmp`;
  writeFileSync(tmp, gzipSync(JSON.stringify(state)));
  renameSync(tmp, `${dir}/state.json.gz`);
}

// ── CLI ──

function parseSeasons(spec: string | undefined, current: number): string[] {
  if (!spec) return Array.from({ length: current - 2019 + 1 }, (_, i) => String(current - i));
  const out: string[] = [];
  for (const part of spec.split(',')) {
    const m = /^(\d{4})-(\d{4})$/.exec(part.trim());
    if (m) for (let y = Number(m[2]); y >= Number(m[1]); y--) out.push(String(y));
    else if (part.trim()) out.push(part.trim());
  }
  return out;
}

async function main() {
  const args = new Map(process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : 'true'] as [string, string];
  }));
  const list = (k: string) => (args.get(k) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const num = (k: string, d: number) => { const v = Number(args.get(k)); return Number.isFinite(v) && v > 0 ? v : d; };

  const dir = args.get('dir') ?? 'data-private/sleeper-trades';
  const salt = args.get('salt') ?? process.env.SLEEPER_CRAWL_SALT ?? '';
  if (!salt) {
    console.error('Set SLEEPER_CRAWL_SALT (or --salt): ids are hashed with it and must stay stable across runs.');
    process.exit(2);
  }
  const rpm = num('rpm', 800);
  const getJson = makeFetcher({
    cacheDir: args.get('cache') ?? null, rpm, concurrency: num('concurrency', 16),
    userAgent: 'stathead-trade-crawl/1.0 (+https://github.com/dachhack/stathead)',
  });

  const nfl = await getJson('/state/nfl') as { season?: string; leg?: number; season_type?: string } | null;
  const currentSeason = Number(nfl?.season ?? new Date().getUTCFullYear());
  const currentLeg = nfl?.season_type === 'regular' ? Number(nfl?.leg ?? 1) : 18;
  const seasons = parseSeasons(args.get('seasons'), currentSeason);

  const state = loadState(dir, salt);
  // --refreshCurrent: re-queue this season's leagues crawled before the current leg.
  if (args.get('refreshCurrent') === 'true') {
    let n = 0;
    for (const [id, leg] of Object.entries(state.visited)) {
      if (leg !== 99 && leg < currentLeg) { delete state.visited[id]; state.frontier.unshift([id, SEED - 1]); n++; }
    }
    console.log(`  re-queued ${n} current-season leagues for new legs`);
  }

  const seedLeagueIds = list('seed');
  for (const name of list('seedUser')) {
    const u = await getJson(`/user/${name}`) as { user_id?: string } | null;
    if (!u?.user_id) { console.warn(`  no Sleeper user "${name}"`); continue; }
    for (const s of seasons.slice(0, 2)) {
      const leagues = await getJson(`/user/${u.user_id}/leagues/nfl/${s}`) as RawLeague[] | null;
      for (const lg of leagues ?? []) if (!tradesDisabled(lg)) seedLeagueIds.push(lg.league_id);
    }
  }

  const hours = num('hours', 5.5);
  const opts: TradeCrawlOptions = {
    seedLeagueIds,
    seasons,
    currentSeason: String(currentSeason),
    currentLeg,
    maxRequests: num('maxRequests', 300_000),
    maxLeagueSeasons: num('maxLeagueSeasons', 100_000),
    deadline: Date.now() + hours * 3600_000,
    workers: num('workers', 8),
    expandPerLeague: num('expandPerLeague', 1),
    expansionSeasons: seasons.slice(0, 2),
    maxFrontier: num('maxFrontier', 20_000),
    allMoves: args.get('allMoves') === 'true',
    salt,
  };

  console.log('\nSleeper trade crawl');
  console.log(`  dir              ${dir}`);
  console.log(`  seasons          ${seasons[seasons.length - 1]}-${seasons[0]} (current ${currentSeason}, leg ${currentLeg})`);
  console.log(`  state            ${Object.keys(state.visited).length} league-seasons visited, ${state.frontier.length} queued, ${state.totals.trades} trades so far`);
  console.log(`  seeds            ${seedLeagueIds.length} leagues`);
  console.log(`  budget           ${hours}h, ${opts.maxRequests} requests, ${opts.maxLeagueSeasons} league-seasons`);
  console.log(`  pace             ${rpm}/min, ${opts.workers} league workers\n`);
  if (args.get('plan') === 'true') return;

  const run = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const sink = fileSink(dir, run);
  let last = 0;
  const started = Date.now();
  const stats = await crawlTrades(opts, state, {
    getJson, sink,
    onProgress: (s) => {
      if (s.leagueSeasons - last < 25) return;
      last = s.leagueSeasons;
      const min = (Date.now() - started) / 60000;
      console.log(`  ${s.leagueSeasons} league-seasons · ${s.trades} trades · ${s.waivers} waiver claims · ${s.requests} req (${Math.round(s.requests / Math.max(min, 0.01))}/min) · ${s.frontier} queued`);
    },
  });
  sink.close();
  saveState(dir, state);

  console.log(`\n  this run         ${stats.leagueSeasons} league-seasons, ${stats.trades} trades, ${stats.waivers} waiver claims`);
  console.log(`                   ${stats.leaguesSkipped} skipped, ${stats.leaguesFailed} failed (retried next run), ${stats.managersExpanded} managers expanded`);
  console.log(`  requests         ${stats.requests}`);
  console.log(`  stopped by       ${stats.stoppedBy}`);
  console.log(`  frontier left    ${stats.frontier}`);
  console.log(`  all runs         ${state.totals.leagueSeasons} league-seasons, ${state.totals.trades} trades, ${state.totals.waivers} waiver claims, ${state.totals.runs} runs\n`);
  console.log(`  Next: python3 scripts/build-sleeper-trade-db.py ${dir}\n`);
}

if (process.argv[1] && /crawl-sleeper-trades/.test(process.argv[1])) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
