// Test script: Sleeper manager-engagement features, league lineages, segments.
// Run: npx tsx scripts/test-engagement-features.ts
//
// Synthetic fixtures on purpose. The Sleeper endpoints these features consume
// 403 from the dev sandbox (see scripts/fetch-sleeper-adp.py), and the tricky
// cases here — chains observed from different join years, best-ball masking,
// right-censoring — are hard to find on demand in live data anyway.
import { resolveLineages, retentionEvents, type LeagueSeasonRef } from '../src/lib/leagueLineage';
import {
  managerSeasonEngagement, engagementProfile, wentDark,
  coldStartSegment, fitSegments, assignSegment,
  type ManagerSeasonEngagement, type EngagementProfile, type PortfolioEntry,
} from '../src/lib/engagement';
import type { LeagueSeasonRecord, TxnEvent, TradeRecord, LeagueFormatInfo } from '../src/lib/sleeper';

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; return; }
  failures.push(`${name}${detail === undefined ? '' : ` — got ${JSON.stringify(detail)}`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), actual);
}

// ── fixtures ──

const FMT = (over: Partial<LeagueFormatInfo> = {}): LeagueFormatInfo => ({
  type: 'Redraft', qb: '1QB', bestBall: false, idp: false, ...over,
});

const rec = (over: Partial<LeagueSeasonRecord>): LeagueSeasonRecord => ({
  season: '2025', leagueId: 'L1', previousLeagueId: null, leagueName: 'League', status: 'complete',
  format: FMT(), totalRosters: 12, rosterId: 1, wins: 7, losses: 7, ties: 0, pointsFor: 1500,
  regSeasonRank: 5, champion: false, runnerUp: false, players: [], ...over,
});

const ev = (over: Partial<TxnEvent>): TxnEvent => ({
  leagueId: 'L1', season: '2025', week: 3, created: Date.UTC(2025, 8, 10),
  kind: 'free_agent', status: 'complete', adds: [], drops: [], faabBid: 0, partners: [], ...over,
});

const trade = (over: Partial<TradeRecord>): TradeRecord => ({
  leagueId: 'L1', leagueName: 'League', season: '2025', week: 5, created: 0, rosterId: 1,
  partners: [2], received: { players: [], picks: [], faab: 0 }, gave: { players: [], picks: [], faab: 0 }, ...over,
});

// ── 1. lineages: union-find across managers who joined in different years ──
// This is the whole reason for union-find. Manager A saw 2022-24, manager B saw
// 2024-26. Pointer-chasing from each manager's earliest league gives them
// different roots for the same league; union-find must merge on the shared ids.
{
  const a: LeagueSeasonRef[] = [
    { leagueId: 'L22', previousLeagueId: 'L21', season: '2022', name: 'Dynasty Home' },
    { leagueId: 'L23', previousLeagueId: 'L22', season: '2023' },
    { leagueId: 'L24', previousLeagueId: 'L23', season: '2024' },
  ];
  const b: LeagueSeasonRef[] = [
    { leagueId: 'L24', previousLeagueId: 'L23', season: '2024' },
    { leagueId: 'L25', previousLeagueId: 'L24', season: '2025' },
    { leagueId: 'L26', previousLeagueId: 'L25', season: '2026', name: 'Dynasty Home' },
  ];
  const idx = resolveLineages([...a, ...b]);
  const ids = new Set(['L22', 'L23', 'L24', 'L25', 'L26'].map((l) => idx.byLeagueId.get(l)));
  eq('lineage: all five seasons collapse to one lineage', ids.size, 1);
  eq('lineage: representative is earliest OBSERVED season', idx.byLeagueId.get('L26'), 'L22');
  check('lineage: unobserved glue id is not a lineage', !idx.lineages.has('L21'));
  const lin = idx.lineages.get('L22')!;
  eq('lineage: tenure counts distinct seasons', lin.tenureSeasons, 5);
  eq('lineage: span', [lin.firstSeason, lin.lastSeason], ['2022', '2026']);
  eq('lineage: name taken from most recent observation', lin.name, 'Dynasty Home');
  eq('lineage: duplicate league-season observations de-duplicated', lin.seasons.length, 5);
}

// ── 2. absent previous-league markers must not merge unrelated leagues ──
{
  const idx = resolveLineages([
    { leagueId: 'A1', previousLeagueId: '0', season: '2025' },
    { leagueId: 'B1', previousLeagueId: null, season: '2025' },
    { leagueId: 'C1', previousLeagueId: '', season: '2025' },
  ]);
  eq('lineage: "0"/null/"" are all "no prior season"', idx.lineages.size, 3);
}

// ── 3. retention labels: censoring and gaps ──
{
  const refs: LeagueSeasonRef[] = [
    { leagueId: 'L22', previousLeagueId: null, season: '2022' },
    { leagueId: 'L23', previousLeagueId: 'L22', season: '2023' },
    // 2024 skipped by this manager, then back in 2025 — a gap, not a new league.
    { leagueId: 'L25', previousLeagueId: 'L24', season: '2025' },
  ];
  // The 2024 league-season exists in the wider population even though this
  // manager sat it out; that's what glues L25 to the L22 chain.
  const population: LeagueSeasonRef[] = [...refs, { leagueId: 'L24', previousLeagueId: 'L23', season: '2024' }];
  const events = retentionEvents(refs, population);
  eq('retention: one row per lineage-season', events.length, 3);
  eq('retention: returned the next season', events[0].returnedNextSeason, true);
  eq('retention: gap year reads as not returning', events[1].returnedNextSeason, false);
  eq('retention: newest season is right-censored', events[2].returnedNextSeason, null);
  check('retention: league still alive in the gap year', events[1].lineageAbsentNextSeason === false);
  eq('retention: all rows share one lineage', new Set(events.map((e) => e.lineageId)).size, 1);
}

// ── 4. engagement rows: counts, FAAB, silence ──
{
  const history = [rec({ leagueId: 'L1', season: '2025' })];
  const events: TxnEvent[] = [
    ev({ week: 1, kind: 'free_agent', adds: ['p1'], drops: ['p2'] }),
    ev({ week: 2, kind: 'waiver', status: 'complete', faabBid: 12, adds: ['p3'] }),
    // A failed claim: nothing moved, but the manager was clearly engaged.
    ev({ week: 2, kind: 'waiver', status: 'failed', faabBid: 5 }),
    ev({ week: 8, kind: 'trade', status: 'complete', partners: [4] }),
    ev({ week: 8, kind: 'commissioner' }),
  ];
  const [row] = managerSeasonEngagement(history, events, { horizonWeek: 17 });

  eq('engagement: every transaction counted', row.txnCount, 5);
  eq('engagement: failed claims counted as engagement', row.failedCount, 1);
  eq('engagement: waivers', row.waiverCount, 2);
  eq('engagement: free agents', row.freeAgentCount, 1);
  eq('engagement: trades', row.tradeCount, 1);
  eq('engagement: commissioner moves', row.commishCount, 1);
  eq('engagement: adds/drops flattened to the manager side', [row.addCount, row.dropCount], [2, 1]);
  // Both the won and the lost bid are FAAB the manager committed.
  eq('engagement: FAAB from settings.waiver_bid', row.faabSpent, 17);
  eq('engagement: active weeks de-duplicated', row.activeWeeks, [1, 2, 8]);
  eq('engagement: first/last active week', [row.firstActiveWeek, row.lastActiveWeek], [1, 8]);
  eq('engagement: longest INTERNAL silent run (weeks 3-7)', row.longestSilentRun, 5);
  eq('engagement: trailing silence to the horizon', row.trailingSilentWeeks, 9);
  eq('engagement: weekday histogram totals the timestamped events', row.weekdayCounts.reduce((a, b) => a + b, 0), 5);
}

// ── 5. a season with no activity at all ──
{
  const [row] = managerSeasonEngagement([rec({})], [], { horizonWeek: 17 });
  eq('engagement: silent season has no active weeks', [row.firstActiveWeek, row.lastActiveWeek], [null, null]);
  eq('engagement: no internal gap to measure', row.longestSilentRun, 0);
  eq('engagement: trailing silence spans the season', row.trailingSilentWeeks, 17);
  check('wentDark: a never-started season is not a quitter', wentDark(row) === false);
}

// ── 6. best-ball masking ──
{
  const history = [rec({ leagueId: 'BB', format: FMT({ bestBall: true }) })];
  const starters = new Map([['BB', ['p1', '0', '0']]]);
  const [row] = managerSeasonEngagement(history, [ev({ leagueId: 'BB', week: 1 })], {
    horizonWeek: 17, startersByLeague: starters,
  });
  check('best ball: lineup signals flagged invalid', row.lineupSignalsValid === false);
  eq('best ball: empty-slot count suppressed', row.emptyStarterSlots, null);
  check('best ball: never scored as abandoned', wentDark(row) === false);
}

// ── 7. empty starter slots ──
{
  const starters = new Map([['L1', ['111', '0', '', '222']]]);
  const [row] = managerSeasonEngagement([rec({})], [ev({})], { startersByLeague: starters });
  eq('empty slots: "0" and "" both count as unfilled', row.emptyStarterSlots, 2);

  const [noData] = managerSeasonEngagement([rec({})], [ev({})], {});
  eq('empty slots: null when starters were not supplied', noData.emptyStarterSlots, null);
}

// ── 8. wentDark threshold ──
{
  const mk = (lastWeek: number) => managerSeasonEngagement(
    [rec({})], [ev({ week: lastWeek })], { horizonWeek: 17 },
  )[0];
  check('wentDark: quit at week 5', wentDark(mk(5)) === true);
  check('wentDark: active through week 15', wentDark(mk(15)) === false);
  check('wentDark: threshold is configurable', wentDark(mk(15), 2) === true);
}

// ── 9. profile axes ──
{
  const history = [
    rec({ leagueId: 'D1', season: '2024', previousLeagueId: null, format: FMT({ type: 'Dynasty' }) }),
    rec({ leagueId: 'D2', season: '2025', previousLeagueId: 'D1', format: FMT({ type: 'Dynasty' }) }),
    rec({ leagueId: 'R1', season: '2025', previousLeagueId: null, format: FMT({ type: 'Redraft' }) }),
  ];
  const events: TxnEvent[] = [
    ...Array.from({ length: 8 }, () => ev({ leagueId: 'D1', season: '2024', week: 1 })),
    ...Array.from({ length: 2 }, () => ev({ leagueId: 'D2', season: '2025', week: 14 })),
  ];
  const rows = managerSeasonEngagement(history, events, { horizonWeek: 17 });
  const trades = [trade({ leagueId: 'D1', partners: [2] }), trade({ leagueId: 'D1', partners: [2] })];
  const p = engagementProfile('u1', history, rows, events, trades, { horizonWeek: 17 });

  eq('profile: league-seasons', p.leagueSeasons, 3);
  eq('profile: leagues in the newest season', p.leaguesCurrentSeason, 2);
  eq('profile: distinct seasons', p.seasonsActive, 2);
  eq('profile: dynasty share', p.dynastyShare, 2 / 3);
  eq('profile: tenure follows the D1→D2 chain', p.maxTenureSeasons, 2);
  eq('profile: attention concentrated at the draft', p.attentionShape, 'draft-only');
  eq('profile: preseason share', Number(p.preseasonShare.toFixed(2)), 0.8);
  // Intensity is per league-week, so it is not inflated by league count.
  eq('profile: intensity normalized per league-week', Number(p.txnPerLeagueWeek.toFixed(4)), Number((10 / 51).toFixed(4)));
  eq('profile: repeat counterparty gives maximal HHI', p.partnerConcentration, 1);
  eq('profile: trades per league-season', Number(p.tradesPerLeagueSeason.toFixed(3)), 0.667);
  check('profile: retention rate computed from uncensored rows only', p.retentionRate === 1);

  const diverse = engagementProfile('u1', history, rows, events,
    [trade({ leagueId: 'D1', partners: [2] }), trade({ leagueId: 'D1', partners: [3] })], { horizonWeek: 17 });
  eq('profile: two distinct partners halve the HHI', diverse.partnerConcentration, 0.5);

  const oneTrade = engagementProfile('u1', history, rows, events, [trade({})], { horizonWeek: 17 });
  eq('profile: HHI needs at least two trades', oneTrade.partnerConcentration, null);
}

// ── 10. segments: abstain on thin evidence, classify on thick ──
{
  const thin = engagementProfile('u2', [rec({})], managerSeasonEngagement([rec({})], [ev({})]), [ev({})], []);
  const thinSeg = coldStartSegment(thin);
  eq('segments: abstains when evidence is thin', thinSeg.segment, 'Unclassified');
  eq('segments: abstention carries zero confidence', thinSeg.confidence, 0);

  // A grinder: five league-seasons, heavy sustained weekly activity.
  const history = Array.from({ length: 5 }, (_, i) =>
    rec({ leagueId: `G${i}`, season: String(2022 + i), previousLeagueId: i ? `G${i - 1}` : null }));
  const events = history.flatMap((h) =>
    Array.from({ length: 30 }, (_, w) => ev({ leagueId: h.leagueId, season: h.season, week: (w % 16) + 2 })));
  const rows = managerSeasonEngagement(history, events, { horizonWeek: 17 });
  const grinder = engagementProfile('u3', history, rows, events, []);
  const seg = coldStartSegment(grinder);
  eq('segments: sustained heavy volume reads as Grinder', seg.segment, 'Grinder');
  check('segments: confidence scales with evidence', seg.confidence > 0.5, seg.confidence);
  check('segments: thick evidence outweighs thin', grinder.evidenceWeight > thin.evidenceWeight);
}

// ── 10b. an enumerated portfolio makes the portfolio-level axes exact ──
{
  const entry = (over: Partial<PortfolioEntry>): PortfolioEntry => ({
    leagueId: 'P1', previousLeagueId: null, season: '2025',
    format: FMT(), totalRosters: 12, ...over,
  });

  // The manager really plays 100 league-seasons; the crawl swept two of them.
  // Every portfolio-level number computed from the sweep is a 2% sample.
  const history = [
    rec({ leagueId: 'C1', season: '2024', previousLeagueId: null }),
    rec({ leagueId: 'C2', season: '2025', previousLeagueId: 'C1' }),
  ];
  const events = Array.from({ length: 20 }, (_, i) =>
    ev({ leagueId: i % 2 ? 'C1' : 'C2', season: i % 2 ? '2024' : '2025', week: (i % 16) + 1 }));
  const rows = managerSeasonEngagement(history, events, { horizonWeek: 17 });

  const portfolio: PortfolioEntry[] = [
    // A five-season chain: tenure the crawled slice cannot see.
    ...['2021', '2022', '2023', '2024', '2025'].map((season, i) => entry({
      leagueId: `D${season}`, previousLeagueId: i ? `D${2020 + i}` : null,
      season, format: FMT({ type: 'Dynasty' }),
    })),
    // Plus 95 single-season best-ball entries in the newest season.
    ...Array.from({ length: 95 }, (_, i) => entry({
      leagueId: `BB${i}`, season: '2025', format: FMT({ bestBall: true }),
    })),
  ];

  const sampled = engagementProfile('u1', history, rows, events, [], { horizonWeek: 17 });
  const exact = engagementProfile('u1', history, rows, events, [], { horizonWeek: 17, portfolio });

  eq('portfolio: volume comes from the enumeration', exact.leagueSeasons, 100);
  eq('portfolio: the crawled slice would have said 2', sampled.leagueSeasons, 2);
  eq('portfolio: current-season count is exact', exact.leaguesCurrentSeason, 96);
  eq('portfolio: seasons active is exact', exact.seasonsActive, 5);
  eq('portfolio: format mix is exact', Number(exact.bestBallShare.toFixed(2)), 0.95);
  eq('portfolio: the crawled slice saw no best ball at all', sampled.bestBallShare, 0);
  eq('portfolio: tenure follows the full chain', exact.maxTenureSeasons, 5);
  eq('portfolio: the crawled slice saw tenure 2', sampled.maxTenureSeasons, 2);

  // The critical guard: transactions exist only for swept leagues, so the
  // intensity denominator must stay on the sweep. Dividing 20 events by an
  // enumerated 100 league-seasons would understate intensity ~50x.
  eq('portfolio: intensity denominator stays on the crawled sweep',
    Number(exact.txnPerLeagueWeek.toFixed(4)), Number((20 / 34).toFixed(4)));
  eq('portfolio: intensity is unchanged by enumeration',
    exact.txnPerLeagueWeek, sampled.txnPerLeagueWeek);

  eq('portfolio: provenance marks the exact axes', exact.provenance,
    { volume: 'portfolio', mode: 'portfolio', persistence: 'portfolio', intensity: 'crawled', sociality: 'crawled' });
  eq('portfolio: provenance marks a sampled profile', sampled.provenance.volume, 'crawled');
  eq('portfolio: true size recorded', exact.portfolioLeagueSeasons, 100);
  eq('portfolio: sampled fraction recorded', Number(exact.portfolioSampled!.toFixed(2)), 0.02);
  eq('portfolio: no fraction without an enumeration', sampled.portfolioSampled, null);

  // Evidence is about what we swept, not what they own: knowing a manager
  // plays 100 leagues says nothing about their behaviour in the two we saw.
  eq('portfolio: evidence weight ignores the un-swept portfolio',
    exact.evidenceWeight, sampled.evidenceWeight);
}

// ── 10c. the as-of guard on the label-derived user feature ──
{
  // historicalAbandonmentRate is computed FROM the abandonment label, so a
  // profile used to score season S must not see S's own outcome.
  const history = ['2023', '2024', '2025'].map((season, i) =>
    rec({ leagueId: `H${season}`, season, previousLeagueId: i ? `H${2022 + i}` : null }));
  // Went dark in 2024 only; active all season in 2023 and 2025.
  const events = history.flatMap((h) => {
    const last = h.season === '2024' ? 3 : 16;
    return Array.from({ length: last }, (_, w) => ev({ leagueId: h.leagueId, season: h.season, week: w + 1 }));
  });
  const rows = managerSeasonEngagement(history, events, { horizonWeek: 17 });
  const profile = (asOfSeason?: string) =>
    engagementProfile('u1', history, rows, events, [], { horizonWeek: 17, asOfSeason });

  // Scoring 2025: 2023 and 2024 are visible, and 2024 went dark → 1 of 2.
  eq('as-of: prior seasons are visible', profile('2025').historicalAbandonmentRate, 0.5);
  // Scoring 2024: only 2023 is visible, which was clean → 0.
  eq('as-of: the scored season is not visible', profile('2024').historicalAbandonmentRate, 0);
  // Scoring 2023: nothing prior, so the feature is absent rather than 0.
  eq('as-of: no prior seasons gives null, not zero', profile('2023').historicalAbandonmentRate, null);
  eq('as-of: the guard is recorded on the profile', profile('2024').asOfSeason, '2024');
  eq('as-of: no guard by default', profile().asOfSeason, null);
  // Ungated, the newest crawled season is still excluded as a weaker fallback.
  eq('as-of: ungated falls back to excluding the newest season',
    profile().historicalAbandonmentRate, 0.5);
}

// ── 11. fitted segments are deterministic ──
{
  const profiles: EngagementProfile[] = [];
  for (let i = 0; i < 14; i++) {
    const history = Array.from({ length: 1 + (i % 4) }, (_, j) =>
      rec({
        leagueId: `X${i}_${j}`, season: String(2023 + j), previousLeagueId: j ? `X${i}_${j - 1}` : null,
        format: FMT({ type: i % 3 === 0 ? 'Dynasty' : 'Redraft', bestBall: i % 5 === 0 }),
      }));
    const events = history.flatMap((h) =>
      Array.from({ length: (i * 3) % 25 }, (_, w) => ev({ leagueId: h.leagueId, season: h.season, week: (w % 17) + 1 })));
    const rows: ManagerSeasonEngagement[] = managerSeasonEngagement(history, events, { horizonWeek: 17 });
    profiles.push(engagementProfile(`u${i}`, history, rows, events, []));
  }

  const m1 = fitSegments(profiles, 4);
  const m2 = fitSegments(profiles, 4);
  check('fitSegments: returns a model', m1 !== null);
  eq('fitSegments: deterministic centroids across runs', m1?.centroids, m2?.centroids);
  eq('fitSegments: deterministic labels across runs', m1?.labels, m2?.labels);
  eq('fitSegments: every profile lands in a cluster', m1?.sizes.reduce((a, b) => a + b, 0), profiles.length);
  eq('fitSegments: refuses to fit more clusters than profiles', fitSegments(profiles.slice(0, 2), 6), null);

  const assigned = assignSegment(profiles[0], m1);
  check('assignSegment: names the cluster', typeof assigned.segment === 'string');
  check('assignSegment: confidence within range', assigned.confidence >= 0 && assigned.confidence <= 1);
  eq('assignSegment: falls back to cold start with no model',
    assignSegment(profiles[0], null).segment, coldStartSegment(profiles[0]).segment);
}

// ── report ──

console.log(`\n${passed} checks passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('✓ engagement features, lineages and segments all behave as specified');
