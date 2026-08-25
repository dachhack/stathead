// Test script: the league-oriented Sleeper crawler, driven offline.
// Run: npx tsx scripts/test-sleeper-crawler.ts
//
// The crawl takes its fetcher by injection, so the whole graph walk runs here
// against a fabricated Sleeper — no network, no rate limit, and the awkward
// cases (budget exhaustion, orphan rosters, a league outside the season window,
// a failing endpoint) can be constructed on demand instead of hunted for.
import {
  crawl, leagueSeasonCost, pseudonymizeId, deriveHorizons, Pacer,
  type CrawlOptions, type CrawlResult,
} from './crawl-sleeper-population';
import { auditEngagement } from '../src/lib/featureAudit';
import type { SleeperRawTransaction } from '../src/lib/sleeper';

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; return; }
  failures.push(`${name}${detail === undefined ? '' : ` — got ${JSON.stringify(detail)}`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), actual);
}

// ── a fabricated Sleeper ──

interface FakeLeague {
  leagueId: string;
  season: string;
  previousLeagueId?: string | null;
  owners: (string | null)[];       // by roster; null = orphan team
  lastActiveWeek?: number;         // transactions run weeks 1..lastActiveWeek
  bestBall?: boolean;
}

interface FakeWorld {
  leagues: FakeLeague[];
  // userId → season → league ids that user's portfolio lookup returns
  portfolios?: Record<string, Record<string, string[]>>;
  failPaths?: Set<string>;
}

function makeGetJson(world: FakeWorld) {
  const calls: string[] = [];
  const byId = new Map(world.leagues.map((l) => [l.leagueId, l]));

  const getJson = async (path: string): Promise<unknown> => {
    calls.push(path);
    if (world.failPaths?.has(path)) throw new Error(`boom: ${path}`);

    let m = /^\/league\/([^/]+)$/.exec(path);
    if (m) {
      const l = byId.get(m[1]);
      if (!l) return null;
      return {
        league_id: l.leagueId, season: l.season, previous_league_id: l.previousLeagueId ?? null,
        name: `League ${l.leagueId}`, status: 'complete', total_rosters: l.owners.length,
        roster_positions: ['QB', 'RB', 'WR', 'TE', 'FLEX'],
        settings: { type: 0, best_ball: l.bestBall ? 1 : 0 },
      };
    }

    m = /^\/league\/([^/]+)\/rosters$/.exec(path);
    if (m) {
      const l = byId.get(m[1]);
      if (!l) return null;
      return l.owners.map((owner, i) => ({
        roster_id: i + 1, owner_id: owner,
        players: ['p1', 'p2'], starters: ['p1', '0'],
        settings: { wins: 8 - i, losses: 6 + i, ties: 0, fpts: 1500 - i * 10, fpts_decimal: 25 },
      }));
    }

    m = /^\/league\/([^/]+)\/transactions\/(\d+)$/.exec(path);
    if (m) {
      const l = byId.get(m[1]);
      if (!l) return null;
      const week = Number(m[2]);
      if (week > (l.lastActiveWeek ?? 16)) return [];
      // Roster 1 transacts every week; roster 2 trades with roster 1 in week 5.
      const txns: SleeperRawTransaction[] = [
        { type: 'free_agent', status: 'complete', roster_ids: [1], adds: { [`a${week}`]: 1 }, drops: null, created: 1_700_000_000_000 + week * 86_400_000 },
      ];
      if (week === 5) {
        txns.push({
          type: 'trade', status: 'complete', roster_ids: [1, 2],
          adds: { tr1: 1 }, drops: { tr2: 1 },
          waiver_budget: [{ sender: 2, receiver: 1, amount: 7 }],
          created: 1_700_000_000_000,
        });
        txns.push({ type: 'waiver', status: 'failed', roster_ids: [2], adds: null, drops: null, settings: { waiver_bid: 13 }, created: 1_700_000_000_000 });
      }
      return txns;
    }

    m = /^\/league\/([^/]+)\/winners_bracket$/.exec(path);
    if (m) return [{ p: 1, w: 1, l: 2 }];

    m = /^\/user\/([^/]+)\/leagues\/nfl\/(\d+)$/.exec(path);
    if (m) {
      const ids = world.portfolios?.[m[1]]?.[m[2]] ?? [];
      return ids.map((id) => ({ league_id: id, sport: 'nfl' }));
    }

    return null;
  };

  return { getJson, calls };
}

const OPTS = (over: Partial<CrawlOptions> = {}): CrawlOptions => ({
  seedLeagueIds: ['L2025'],
  seasons: ['2023', '2024', '2025'],
  maxRequests: 100_000,
  maxLeagueSeasons: 100,
  expandPerLeague: 0,
  weeks: 18,
  brackets: true,
  enumeratePortfolios: false,
  pseudonymize: true,
  salt: 'test-salt',
  ...over,
});

// A three-season lineage plus one unrelated league for horizontal expansion.
const CHAIN: FakeLeague[] = [
  { leagueId: 'L2023', season: '2023', previousLeagueId: 'L2022', owners: ['u1', 'u2', 'u3'], lastActiveWeek: 16 },
  { leagueId: 'L2024', season: '2024', previousLeagueId: 'L2023', owners: ['u1', 'u2', 'u3'], lastActiveWeek: 16 },
  { leagueId: 'L2025', season: '2025', previousLeagueId: 'L2024', owners: ['u1', 'u2', null], lastActiveWeek: 9 },
  { leagueId: 'OTHER', season: '2025', previousLeagueId: null, owners: ['u1', 'u9'], lastActiveWeek: 16 },
  { leagueId: 'L2022', season: '2022', previousLeagueId: null, owners: ['u1'], lastActiveWeek: 16 },
];

const run = (world: FakeWorld, opts: CrawlOptions): Promise<CrawlResult> =>
  crawl(opts, makeGetJson(world).getJson ? { getJson: makeGetJson(world).getJson } : { getJson: async () => null });

// ── 1. vertical expansion follows previous_league_id ──
{
  const { getJson, calls } = makeGetJson({ leagues: CHAIN });
  const result = await crawl(OPTS(), { getJson });

  eq('vertical: crawls the seed plus its two prior seasons', result.stats.leagueSeasonsCrawled, 3);
  // L2022 is reachable by pointer but outside the season window, so the chain
  // stops there rather than walking back forever.
  check('vertical: does not walk past the season window', !calls.includes('/league/L2022'), calls.filter((c) => c.includes('L2022')));
  eq('vertical: nothing dropped', result.stats.leagueSeasonsDropped, 0);

  // All three league-seasons must collapse to one lineage, which is the whole
  // point of walking the chain.
  const u1 = result.population.find((m) => m.rows.length === 3)!;
  check('vertical: manager present in all three seasons', !!u1, result.population.map((m) => m.rows.length));
  eq('vertical: three seasons, one lineage', new Set(u1.rows.map((r) => r.lineageId)).size, 1);
  eq('vertical: lineage keyed on the earliest observed season', u1.rows[0].lineageId, 'L2023');
}

// ── 2. request accounting matches the published cost ──
{
  const { getJson } = makeGetJson({ leagues: [CHAIN[3]] });   // OTHER: no prior season
  const result = await crawl(OPTS({ seedLeagueIds: ['OTHER'] }), { getJson });
  eq('cost: one league-season costs exactly the reserved amount',
    result.stats.requests, leagueSeasonCost({ weeks: 18, brackets: true }));
  eq('cost: bracket can be switched off', leagueSeasonCost({ weeks: 18, brackets: false }), 20);
}

// ── 3. all-or-nothing: a league-season is never emitted half-fetched ──
{
  const perLeague = leagueSeasonCost({ weeks: 18, brackets: true });
  const { getJson } = makeGetJson({ leagues: CHAIN });
  // Room for one league-season and a few requests over — not enough for two.
  const result = await crawl(OPTS({ maxRequests: perLeague + 5 }), { getJson });

  eq('budget: only complete league-seasons are crawled', result.stats.leagueSeasonsCrawled, 1);
  check('budget: flagged as exhausted', result.stats.budgetExhausted);
  check('budget: never overspends the cap', result.stats.requests <= perLeague + 5, result.stats.requests);
  check('budget: unfinished work is left on the frontier, not emitted',
    result.stats.frontierRemaining > 0, result.stats.frontierRemaining);
  // The surviving rows must be whole: 18 weeks scanned for the one league.
  const anyManager = result.population[0];
  eq('budget: the emitted league-season has every week', anyManager.sweep?.weeksScanned, 18);
  check('budget: emitted rows are not marked truncated', anyManager.sweep?.capped === false);
}

// ── 4. maxLeagueSeasons is respected independently of the request budget ──
{
  const { getJson } = makeGetJson({ leagues: CHAIN });
  const result = await crawl(OPTS({ maxLeagueSeasons: 2 }), { getJson });
  eq('caps: league-season cap honoured', result.stats.leagueSeasonsCrawled, 2);
  check('caps: not reported as a budget problem', !result.stats.budgetExhausted);
}

// ── 5. horizontal expansion, sampled and recorded as coverage ──
{
  // One season only, so the manager pool outruns the sampling budget and some
  // managers are left unexpanded — which is the normal state of a real crawl.
  const world: FakeWorld = {
    leagues: CHAIN,
    portfolios: { u1: { 2025: ['L2025', 'OTHER'] } },
  };
  const { getJson, calls } = makeGetJson(world);
  const result = await crawl(OPTS({ seasons: ['2025'], expandPerLeague: 1, pseudonymize: false }), { getJson });

  check('horizontal: discovers a league outside the seed lineage',
    calls.includes('/league/OTHER'), calls.filter((c) => c.startsWith('/league/OTHER')));
  eq('horizontal: one manager sampled per crawled league-season', result.stats.portfoliosResolved, 2);

  const resolved = result.population.filter((m) => m.coverage?.portfolioKnown);
  const unresolved = result.population.filter((m) => !m.coverage?.portfolioKnown);
  eq('coverage: expanded managers have a known portfolio', resolved.map((m) => m.managerId).sort(), ['u1', 'u9']);
  // The distinction matters: profile-level features (league count, retention
  // rate) are biased for the second group, and the audit warns on this share.
  eq('coverage: managers seen only inside a league do not', unresolved.map((m) => m.managerId), ['u2']);
  const u1 = resolved.find((m) => m.managerId === 'u1')!;
  eq('coverage: known portfolio size recorded', u1.coverage!.knownLeagueSeasons, 2);
  eq('coverage: crawled count recorded separately', u1.coverage!.crawledLeagueSeasons, 2);
  eq('coverage: an unexpanded manager falls back to what was crawled',
    unresolved[0].coverage!.knownLeagueSeasons, unresolved[0].coverage!.crawledLeagueSeasons);
}

// ── 6. season window and non-matching leagues are skipped, not dropped ──
{
  const { getJson } = makeGetJson({ leagues: CHAIN });
  const result = await crawl(OPTS({ seedLeagueIds: ['L2022'], seasons: ['2024', '2025'] }), { getJson });
  eq('window: a league outside the window is skipped', result.stats.leagueSeasonsSkipped, 1);
  eq('window: skipping is not dropping', result.stats.leagueSeasonsDropped, 0);
  eq('window: nothing emitted', result.population.length, 0);
}

// ── 7. a failing endpoint drops that league-season and the crawl continues ──
{
  const { getJson } = makeGetJson({ leagues: CHAIN, failPaths: new Set(['/league/L2024/rosters']) });
  const result = await crawl(OPTS(), { getJson });
  eq('errors: the failing league-season is dropped', result.stats.leagueSeasonsDropped, 1);
  eq('errors: counted', result.stats.errors, 1);
  // The league document was readable, so previous_league_id is known and the
  // chain keeps walking. One transient failure must not cost every retention
  // label behind it.
  eq('errors: the lineage is still walked past the failure', result.stats.leagueSeasonsCrawled, 2);
  check('errors: the season behind the failure is reached',
    result.population.some((m) => m.rows.some((r) => r.leagueId === 'L2023')));
  check('errors: no row survives from the dropped league-season',
    !result.population.some((m) => m.rows.some((r) => r.leagueId === 'L2024')));
}

// ── 8. orphan rosters produce no manager ──
{
  const { getJson } = makeGetJson({ leagues: [CHAIN[2]] });
  const result = await crawl(OPTS({ seedLeagueIds: ['L2025'], seasons: ['2025'] }), { getJson });
  // L2025 has owners ['u1','u2',null] — three rosters, two managers.
  eq('orphans: an unowned roster yields no manager', result.population.length, 2);
}

// ── 9. transactions are attributed to the right roster ──
{
  const { getJson } = makeGetJson({ leagues: [CHAIN[2]] });
  const result = await crawl(OPTS({ seedLeagueIds: ['L2025'], seasons: ['2025'], pseudonymize: false }), { getJson });
  const u1 = result.population.find((m) => m.managerId === 'u1')!;
  const u2 = result.population.find((m) => m.managerId === 'u2')!;

  // Roster 1 adds every week to week 9, plus the week-5 trade.
  eq('attribution: roster 1 gets its own adds and the trade', u1.rows[0].freeAgentCount, 9);
  eq('attribution: roster 1 sees the trade', u1.rows[0].tradeCount, 1);
  // Roster 2 only appears in the week-5 trade and its own failed claim.
  eq('attribution: roster 2 gets only its two week-5 events', u2.rows[0].txnCount, 2);
  eq('attribution: roster 2 has no free-agent moves', u2.rows[0].freeAgentCount, 0);
  eq('attribution: the failed claim is retained as engagement', u2.rows[0].failedCount, 1);
  // waiver_bid on the failed claim, not the trade's waiver_budget.
  eq('attribution: FAAB comes from the bid, not the traded budget', u2.rows[0].faabSpent, 13);
  eq('attribution: starters carried through for empty-slot detection', u1.rows[0].emptyStarterSlots, 1);
}

// ── 10. the season horizon is derived, not assumed ──
{
  const horizons = deriveHorizons([
    { season: '2025', transactions: [{ week: 1, txns: [1] }, { week: 9, txns: [1] }, { week: 12, txns: [] }] },
    { season: '2024', transactions: [{ week: 16, txns: [1] }] },
  ]);
  eq('horizon: last week with activity, per season', horizons, { 2025: 9, 2024: 16 });

  // An in-progress season must not be scored against week 17, or every manager
  // in it looks abandoned. L2025 stops at week 9, so its horizon is 9.
  const { getJson } = makeGetJson({ leagues: CHAIN });
  const result = await crawl(OPTS(), { getJson });
  eq('horizon: derived from the crawl', result.horizonBySeason['2025'], 9);
  const row2025 = result.population.flatMap((m) => m.rows).find((r) => r.season === '2025' && r.txnCount > 0)!;
  eq('horizon: no phantom trailing silence in the newest season', row2025.trailingSilentWeeks, 0);
}

// ── 11. pseudonymization ──
{
  eq('privacy: hash is stable for a salt', pseudonymizeId('u1', 's'), pseudonymizeId('u1', 's'));
  check('privacy: different salts give different ids', pseudonymizeId('u1', 's1') !== pseudonymizeId('u1', 's2'));
  check('privacy: different users give different ids', pseudonymizeId('u1', 's') !== pseudonymizeId('u2', 's'));
  check('privacy: the raw id is not recoverable from the hash', !pseudonymizeId('u1', 's').includes('u1'));

  const { getJson } = makeGetJson({ leagues: CHAIN });
  const hashed = await crawl(OPTS(), { getJson });
  check('privacy: pseudonymized by default',
    hashed.population.every((m) => !['u1', 'u2', 'u3', 'u9'].includes(m.managerId)),
    hashed.population.map((m) => m.managerId));

  const { getJson: g2 } = makeGetJson({ leagues: CHAIN });
  const raw = await crawl(OPTS({ pseudonymize: false }), { getJson: g2 });
  check('privacy: opt-out yields raw ids', raw.population.some((m) => m.managerId === 'u1'));
  eq('privacy: same managers either way', hashed.population.length, raw.population.length);
}

// ── 12. determinism ──
{
  const a = await crawl(OPTS({ expandPerLeague: 1 }), { getJson: makeGetJson({ leagues: CHAIN, portfolios: { u1: { 2025: ['OTHER'] } } }).getJson });
  const b = await crawl(OPTS({ expandPerLeague: 1 }), { getJson: makeGetJson({ leagues: CHAIN, portfolios: { u1: { 2025: ['OTHER'] } } }).getJson });
  eq('determinism: identical population across runs', JSON.stringify(a.population), JSON.stringify(b.population));
  eq('determinism: identical stats across runs', a.stats, b.stats);
  eq('determinism: population is sorted by manager id',
    a.population.map((m) => m.managerId), [...a.population.map((m) => m.managerId)].sort());
}

// ── 13. retention labels come out of the crawl usable ──
{
  const { getJson } = makeGetJson({ leagues: CHAIN });
  const result = await crawl(OPTS({ pseudonymize: false }), { getJson });
  const u1 = result.population.find((m) => m.managerId === 'u1')!;
  const events = u1.retention ?? [];
  eq('retention: one row per crawled season', events.length, 3);
  eq('retention: returned in the first two seasons', events.slice(0, 2).map((e) => e.returnedNextSeason), [true, true]);
  eq('retention: newest season is censored', events[2].returnedNextSeason, null);
  // u3 leaves after 2024 (L2025 has no u3), and the league itself survives —
  // which is what separates an individual exit from a league folding.
  const u3 = result.population.find((m) => m.managerId === 'u3')!;
  const last = (u3.retention ?? []).find((e) => e.season === '2024')!;
  eq('retention: an individual exit is visible', last.returnedNextSeason, false);
  check('retention: and is not confused with the league dying', last.lineageAbsentNextSeason === false);
}

// ── 14. the pacer ──
{
  const pacer = new Pacer(6000, 4);   // 10ms between starts
  const started = Date.now();
  await Promise.all(Array.from({ length: 5 }, () => pacer.run(async () => 1)));
  const elapsed = Date.now() - started;
  check('pacer: spaces requests to the target rate', elapsed >= 35, elapsed);

  const serial = new Pacer(600_000, 1);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 6 }, () => serial.run(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 2));
    active--;
  })));
  eq('pacer: concurrency of 1 runs strictly serially', peak, 1);

  const parallel = new Pacer(600_000, 3);
  let active2 = 0;
  let peak2 = 0;
  await Promise.all(Array.from({ length: 12 }, () => parallel.run(async () => {
    active2++;
    peak2 = Math.max(peak2, active2);
    await new Promise((r) => setTimeout(r, 5));
    active2--;
  })));
  check('pacer: never exceeds the concurrency cap', peak2 <= 3, peak2);
  check('pacer: actually uses the concurrency it is given', peak2 > 1, peak2);
}

// ── 14b. vertical expansion outranks horizontal ──
//
// Horizontal discovery outruns the league-season cap by orders of magnitude, so
// on a single FIFO queue the vertical hops starve behind it — and vertical hops
// are the only source of lineages, tenure and retention labels. Depth per
// league beats an ever-wider layer of single-season rows.
{
  // A three-season chain, plus a horizontally-reachable league that would be
  // queued first under FIFO (it is discovered while crawling the seed).
  const world: FakeWorld = {
    leagues: CHAIN,
    portfolios: { u1: { 2023: [], 2024: [], 2025: ['OTHER'] } },
  };
  const { getJson } = makeGetJson(world);
  // Room for the seed plus one more: the crawler must choose.
  const result = await crawl(OPTS({ expandPerLeague: 1, maxLeagueSeasons: 2, pseudonymize: false }), { getJson });

  const crawledLeagues = new Set(result.population.flatMap((m) => m.rows.map((r) => r.leagueId)));
  check('priority: the prior season is taken before a newly-discovered league',
    crawledLeagues.has('L2024') && !crawledLeagues.has('OTHER'), [...crawledLeagues]);

  // With room for the whole chain, the horizontal find is still reached — the
  // priority only reorders, it does not discard.
  const { getJson: g2 } = makeGetJson(world);
  const full = await crawl(OPTS({ expandPerLeague: 1, maxLeagueSeasons: 10, pseudonymize: false }), { getJson: g2 });
  const all = new Set(full.population.flatMap((m) => m.rows.map((r) => r.leagueId)));
  check('priority: horizontal finds are still crawled when there is room',
    all.has('OTHER') && all.has('L2023'), [...all]);
  eq('priority: chain depth achieved', new Set(full.population.flatMap((m) => m.rows.filter((r) => r.lineageId === 'L2023').map((r) => r.season))).size, 3);
}

// ── 14c. the portfolio enumeration pass ──
{
  const world: FakeWorld = {
    leagues: CHAIN,
    portfolios: {
      // u2 really plays four league-seasons; the crawl only ever sweeps its own.
      u2: { 2023: ['X1', 'X2'], 2024: ['X3'], 2025: ['X4'] },
      u3: { 2025: ['Y1'] },
    },
  };
  const { getJson, calls } = makeGetJson(world);
  const result = await crawl(OPTS({ enumeratePortfolios: true, expandPerLeague: 0, pseudonymize: false }), { getJson });

  const u2 = result.population.find((m) => m.managerId === 'u2')!;
  eq('enumerate: the full league list is attached', u2.portfolio?.length, 4);
  eq('enumerate: it carries the season', new Set(u2.portfolio!.map((e) => e.season)).size, 3);
  check('enumerate: and the prior-season link', u2.portfolio!.every((e) => 'previousLeagueId' in e));
  eq('enumerate: coverage now knows the true portfolio size', u2.coverage?.knownLeagueSeasons, 4);
  check('enumerate: coverage is flagged known', u2.coverage?.portfolioKnown === true);
  eq('enumerate: crawled count is unchanged', u2.coverage?.crawledLeagueSeasons, u2.rows.length);

  // Enumeration measures portfolios; it must not grow the sample, or the pass
  // would keep discovering work after the crawl was supposed to stop.
  check('enumerate: discovered leagues are not crawled',
    !result.population.some((m) => m.rows.some((r) => ['X1', 'X2', 'X3', 'X4', 'Y1'].includes(r.leagueId))),
    result.stats);
  check('enumerate: no league document is fetched for them',
    !calls.some((c) => /^\/league\/(X\d|Y1)$/.test(c)), calls.filter((c) => /X\d|Y1/.test(c)));
  // Three managers appear across the crawled chain (u1, u2, u3), so three
  // portfolios are enumerated — one per manager, not one per league found.
  eq('enumerate: one enumeration per discovered manager', result.stats.portfoliosEnumerated, 3);

  // Off by default in these tests, and then nothing is attached.
  const { getJson: g2 } = makeGetJson(world);
  const without = await crawl(OPTS({ enumeratePortfolios: false, expandPerLeague: 0, pseudonymize: false }), { getJson: g2 });
  check('enumerate: absent when the pass is off',
    without.population.every((m) => m.portfolio === undefined));
  eq('enumerate: and no portfolios are counted', without.stats.portfoliosEnumerated, 0);
}

// ── 14d. enumeration runs after the crawl and cannot starve it ──
{
  const world: FakeWorld = { leagues: CHAIN, portfolios: { u1: { 2025: ['OTHER'] } } };
  const perLeague = leagueSeasonCost({ weeks: 18, brackets: true });
  // Exactly enough for the three chain league-seasons and nothing more.
  const { getJson } = makeGetJson(world);
  const result = await crawl(OPTS({
    enumeratePortfolios: true, expandPerLeague: 0, maxRequests: perLeague * 3,
  }), { getJson });

  eq('enumerate: the crawl still gets its full budget', result.stats.leagueSeasonsCrawled, 3);
  eq('enumerate: enumeration is skipped when nothing is left', result.stats.portfoliosEnumerated, 0);
  check('enumerate: and the shortfall is reported', result.stats.budgetExhausted);
  check('enumerate: never overspends', result.stats.requests <= perLeague * 3, result.stats.requests);
}

// ── 15. the crawler's output is consumable by the audit ──
//
// The contract between the two halves is the only thing that makes the pipeline
// work end to end, so it is asserted rather than assumed.
{
  // A wider world: enough managers and seasons for the audit to have something
  // to say, with a mix of early-quitting and full-season leagues.
  const leagues: FakeLeague[] = [];
  for (let g = 0; g < 6; g++) {
    for (let s = 0; s < 3; s++) {
      const season = String(2023 + s);
      leagues.push({
        leagueId: `G${g}S${s}`,
        season,
        previousLeagueId: s ? `G${g}S${s - 1}` : null,
        owners: [`m${g}a`, `m${g}b`, `m${g}c`],
        // Half the leagues die early, so the label has both classes.
        lastActiveWeek: (g + s) % 2 === 0 ? 4 : 16,
      });
    }
  }
  const seeds = Array.from({ length: 6 }, (_, g) => `G${g}S2`);
  const { getJson } = makeGetJson({ leagues });
  const result = await crawl(OPTS({ seedLeagueIds: seeds, expandPerLeague: 0 }), { getJson });

  eq('integration: every league-season crawled', result.stats.leagueSeasonsCrawled, 18);
  eq('integration: every manager found', result.population.length, 18);

  const audit = auditEngagement(result.population);
  eq('integration: audit sees the crawled rows', audit.completeness.managerSeasons, 54);
  eq('integration: lineages collapse to one per league', audit.completeness.lineages, 6);
  eq('integration: no sweep truncation from a league-oriented crawl', audit.completeness.managersWithCappedSweep, 0);
  check('integration: the label has both classes',
    audit.label.positives > 0 && audit.label.positives < audit.label.scorableRows, audit.label);
  eq('integration: no blocking defects in a clean crawl', audit.blocking, []);

  // Coverage is the honest part: nobody was expanded, so no portfolio is known
  // and the audit must say so rather than implying complete portfolios.
  eq('integration: unexpanded crawl reports no known portfolios', audit.completeness.portfolioKnownShare, 0);
  check('integration: and warns about biased profile features',
    audit.completeness.warnings.some((w) => w.includes('Portfolio known')), audit.completeness.warnings);

  // Starters come through the crawl, so the empty-slot feature is populated
  // rather than silently absent.
  eq('integration: empty-slot coverage is complete', audit.completeness.startersCoverage, 1);
}

// silence the unused-helper warning for `run`, kept for readability above
void run;

// ── report ──

console.log(`\n${passed} checks passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('✓ crawler walks, budgets, attributes and anonymizes as specified');
