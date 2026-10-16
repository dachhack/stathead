// Test script: the Sleeper trade crawler, driven offline.
// Run: npx tsx scripts/test-sleeper-trade-crawler.ts
//
// A fabricated Sleeper serves leagues, rosters, transactions, matchups,
// drafts and user league lists, so trade parsing, records at the time of a
// trade, discovery order, resumption and the privacy guarantees can all be
// checked without the network.
import {
  crawlTrades, emptyState, tradeSides, recordsBefore, formatSummary, leaguePriority, hashId,
  type RawLeague, type RawTxn, type TradeCrawlOptions, type CrawlState,
} from './crawl-sleeper-trades';

let passed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) passed++;
  else failures.push(`${name}${detail === undefined ? '' : ` — got ${JSON.stringify(detail)}`}`);
};
const eq = (name: string, a: unknown, b: unknown) => check(name, JSON.stringify(a) === JSON.stringify(b), a);

// ── tradeSides ──
{
  const t: RawTxn = {
    transaction_id: '1', type: 'trade', status: 'complete', roster_ids: [2, 7],
    adds: { p1: 2, p2: 7, fa: 7 }, drops: { p1: 7, p2: 2, cutme: 2 },
    draft_picks: [{ season: '2027', round: 1, roster_id: 5, previous_owner_id: 2, owner_id: 7 }],
    waiver_budget: [{ sender: 7, receiver: 2, amount: 15 }],
  };
  const sides = tradeSides(t, (rid) => `o${rid}`);
  const s2 = sides.find((s) => s.rid === 2)!, s7 = sides.find((s) => s.rid === 7)!;
  eq('side 2 gets p1 and FAAB', [s2.gets.players, s2.gets.faab], [['p1'], 15]);
  eq('side 2 gives p2 and the pick it held', [s2.gives.players, s2.gives.picks], [['p2'], [{ season: '2027', round: 1, orig: 5 }]]);
  eq('side 7 gets the pick, keeps its original owner', s7.gets.picks, [{ season: '2027', round: 1, orig: 5 }]);
  eq('side 7 gives FAAB', s7.gives.faab, 15);
  eq('a drop with no add is a cut', s2.cut, ['cutme']);
  eq('an add with no drop is a free-agent pickup', s7.added, ['fa']);
  eq('owners attached', [s2.owner, s7.owner], ['o2', 'o7']);
  // Three-team trade: a roster appearing only through a pick still gets a side.
  const three = tradeSides({
    transaction_id: '2', type: 'trade', status: 'complete', roster_ids: [1, 2],
    adds: { a: 2 }, drops: { a: 1 },
    draft_picks: [{ season: '2026', round: 2, roster_id: 3, previous_owner_id: 3, owner_id: 1 }],
  }, () => null);
  eq('three-team trade has three sides', three.map((s) => s.rid), [1, 2, 3]);
}

// ── recordsBefore ──
{
  const m: Record<string, [number, number | null, number][]> = {
    '1': [[1, 1, 100], [2, 1, 90], [3, 2, 80], [4, 2, 80]],
    '2': [[1, 1, 70], [3, 1, 75], [2, 2, 110], [4, 2, 60]],
    '3': [[1, 1, 999], [2, 1, 0]],
  };
  const r = recordsBefore(m, 3);   // weeks 1 and 2 only
  eq('roster 1: 1-1', [r.get(1)!.w, r.get(1)!.l, r.get(1)!.pf], [1, 1, 170]);
  eq('roster 3: tie then win', [r.get(3)!.w, r.get(3)!.l, r.get(3)!.t], [1, 0, 1]);
  eq('points against', r.get(2)!.pa, 160);
  check('roster 3 ranks first (1.5 wins)', r.get(3)!.rank === 1, r.get(3));
  eq('week 3 ignored for a leg-3 trade', r.get(1)!.pf, 170);
}

// ── formatSummary / priority ──
{
  const f = formatSummary({
    league_id: 'x', season: '2026', total_rosters: 12,
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'BN', 'BN', 'TAXI'],
    settings: { type: 2, waiver_type: 2, waiver_budget: 1000, taxi_slots: 3, trade_deadline: 11 },
    scoring_settings: { rec: 1, bonus_rec_te: 0.5, pass_td: 6 },
  });
  eq('format', [f.type, f.sf, f.tep, f.ppr, f.passTd, f.faabBudget, f.starters, f.taxi, f.teams],
    ['dynasty', true, 0.5, 1, 6, 1000, 8, 3, 12]);
  eq('no FAAB without FAAB waivers', formatSummary({ league_id: 'y', season: '2026', settings: { waiver_type: 0 } }).faabBudget, 0);
  check('dynasty before keeper before redraft',
    leaguePriority({ season: '2019', settings: { type: 2 } }) > leaguePriority({ season: '2026', settings: { type: 1 } }) &&
    leaguePriority({ season: '2019', settings: { type: 1 } }) > leaguePriority({ season: '2026', settings: { type: 0 } }));
  check('newer first within a type',
    leaguePriority({ season: '2026', settings: { type: 2 } }) > leaguePriority({ season: '2025', settings: { type: 2 } }));
}

// ── the crawl, against a fabricated Sleeper ──

interface FL {
  id: string; season: string; prev?: string; type?: number; disabled?: boolean;
  owners: string[]; trades?: { leg: number; txn: Partial<RawTxn> }[];
}

function world(leagues: FL[], userLeagues: Record<string, string[]>, fail = new Set<string>()) {
  const byId = new Map(leagues.map((l) => [l.id, l]));
  const calls: string[] = [];
  const doc = (l: FL): RawLeague => ({
    league_id: l.id, season: l.season, previous_league_id: l.prev ?? null, status: 'complete', sport: 'nfl',
    total_rosters: l.owners.length, roster_positions: ['QB', 'RB', 'WR', 'TE', 'FLEX', 'BN'],
    settings: { type: l.type ?? 2, disable_trades: l.disabled ? 1 : 0, waiver_type: 2, waiver_budget: 100 },
    scoring_settings: { rec: 1 },
    // Fields the crawler must never store.
    ...({ name: 'Secret League Name', last_message_text_map: { x: 'chat' }, last_author_display_name: 'Someone' } as object),
  });
  const getJson = async (path: string): Promise<unknown> => {
    calls.push(path);
    if (fail.has(path)) throw new Error(`boom ${path}`);
    let m: RegExpExecArray | null;
    if ((m = /^\/league\/([^/]+)$/.exec(path))) { const l = byId.get(m[1]); return l ? doc(l) : null; }
    if ((m = /^\/league\/([^/]+)\/rosters$/.exec(path))) {
      return byId.get(m[1])?.owners.map((o, i) => ({ roster_id: i + 1, owner_id: o, players: [`p${i}`], settings: { wins: i, fpts: 100 + i } })) ?? null;
    }
    if ((m = /^\/league\/([^/]+)\/transactions\/(\d+)$/.exec(path))) {
      const l = byId.get(m[1]);
      return (l?.trades ?? []).filter((t) => t.leg === Number(m![2])).map((t, i) => ({
        type: 'trade', status: 'complete', leg: t.leg, created: 1000 + t.leg, creator: l!.owners[0],
        roster_ids: [1, 2], adds: { a: 2 }, drops: { a: 1 }, ...t.txn,
        transaction_id: t.txn.transaction_id ?? `${l!.id}-${t.leg}-${i}`,
      })).concat(Number(m[2]) === 2 ? [{ type: 'waiver', status: 'failed', leg: 2, transaction_id: `${m[1]}-w`, roster_ids: [1], adds: { z: 1 }, settings: { waiver_bid: 7 } } as never] : []);
    }
    if ((m = /^\/league\/([^/]+)\/matchups\/(\d+)$/.exec(path))) {
      return [{ roster_id: 1, matchup_id: 1, points: 120 }, { roster_id: 2, matchup_id: 1, points: 100 }];
    }
    if (/\/winners_bracket$/.test(path)) return [{ p: 1, w: 2, l: 1 }];
    if ((m = /^\/league\/([^/]+)\/drafts$/.exec(path))) {
      const l = byId.get(m[1]);
      return l ? [{ draft_id: `d${l.id}`, type: 'linear', status: 'complete', season: l.season, settings: { rounds: 1 } }] : null;
    }
    if ((m = /^\/draft\/d([^/]+)$/.exec(path))) return { draft_id: `d${m[1]}`, slot_to_roster_id: { 1: 2, 2: 1 } };
    if (/^\/draft\/d[^/]+\/picks$/.test(path)) return [{ pick_no: 1, round: 1, draft_slot: 1, roster_id: 2, player_id: 'rookie' }];
    if ((m = /^\/user\/([^/]+)\/leagues\/nfl\/(\d+)$/.exec(path))) {
      return (userLeagues[m[1]] ?? []).map((id) => byId.get(id)).filter((l) => l && l.season === m![2]).map((l) => doc(l!));
    }
    return null;
  };
  return { getJson, calls };
}

function opts(over: Partial<TradeCrawlOptions> = {}): TradeCrawlOptions {
  return {
    seedLeagueIds: [], seasons: ['2026', '2025', '2024'], currentSeason: '2026', currentLeg: 18,
    maxRequests: 100_000, maxLeagueSeasons: 1000, deadline: Number.MAX_SAFE_INTEGER, workers: 3,
    expandPerLeague: 2, expansionSeasons: ['2026', '2025'], maxFrontier: 1000, allMoves: false, salt: 's',
    ...over,
  };
}

function collect() {
  const out = { leagues: [] as Record<string, unknown>[], trades: [] as Record<string, unknown>[], waivers: [] as Record<string, unknown>[] };
  return { out, sink: { league: (r: object) => out.leagues.push(r as never), trade: (r: object) => out.trades.push(r as never), waiver: (r: object) => out.waivers.push(r as never) } };
}

async function main() {
  const leagues: FL[] = [
    { id: 'D26', season: '2026', prev: 'D25', type: 2, owners: ['u1', 'u2'], trades: [
      { leg: 1, txn: { draft_picks: [{ season: '2027', round: 1, roster_id: 1, previous_owner_id: 1, owner_id: 2 }] } },
      { leg: 5, txn: { waiver_budget: [{ sender: 2, receiver: 1, amount: 10 }] } },
    ] },
    { id: 'D25', season: '2025', prev: 'D24', type: 2, owners: ['u1', 'u2'], trades: [{ leg: 3, txn: {} }] },
    { id: 'D24', season: '2024', type: 2, owners: ['u1', 'u2'] },
    { id: 'R26', season: '2026', type: 0, owners: ['u2', 'u3'], trades: [{ leg: 2, txn: {} }] },
    { id: 'OFF', season: '2026', type: 2, disabled: true, owners: ['u3', 'u4'] },
    { id: 'OLD', season: '2018', type: 2, owners: ['u3', 'u4'] },
  ];
  const users = { u1: ['D26'], u2: ['D26', 'R26', 'OFF'], u3: ['R26', 'OFF'] };

  const w = world(leagues, users);
  const { out, sink } = collect();
  const state = emptyState('s');
  const stats = await crawlTrades(opts({ seedLeagueIds: ['D26'] }), state, { getJson: w.getJson, sink });

  eq('every reachable league-season crawled once', out.leagues.map((l) => l.season).sort(), ['2024', '2025', '2026', '2026']);
  check('trades-disabled league never fetched', !w.calls.some((c) => c.startsWith('/league/OFF')), w.calls.filter((c) => c.includes('OFF')));
  eq('trades found', stats.trades, 4);
  eq('frontier exhausted', stats.stoppedBy, 'frontier');
  check('dynasty lineage crawled before the redraft league',
    w.calls.indexOf('/league/D24') < w.calls.indexOf('/league/R26'), w.calls.filter((c) => /^\/league\/[^/]+$/.test(c)));

  const t5 = out.trades.find((t) => t.leg === 5) as { sides: { rid: number; record?: { w: number; l: number }; gets: { faab: number } }[]; format: { type: string } };
  eq('record at the time of a leg-5 trade (weeks 1-4)', t5.sides.map((s) => [s.rid, s.record?.w, s.record?.l]), [[1, 4, 0], [2, 0, 4]]);
  eq('FAAB in a trade', t5.sides.find((s) => s.rid === 1)!.gets.faab, 10);
  eq('format carried on the trade', t5.format.type, 'dynasty');
  check('matchups fetched only up to the last in-season trade',
    !w.calls.includes('/league/D26/matchups/5') && w.calls.includes('/league/D26/matchups/4'));
  check('no matchups for a league whose only trade is leg 1... or leg 2 needs week 1 only',
    w.calls.includes('/league/R26/matchups/1') && !w.calls.includes('/league/R26/matchups/2'));

  const t1 = out.trades.find((t) => t.leg === 1 && (t.lg === hashId('s', 'league', 'D26'))) as { sides: { rid: number; record?: unknown; gets: { picks: unknown[] } }[] };
  eq('pick moved with its original owner', t1.sides.find((s) => s.rid === 2)!.gets.picks, [{ season: '2027', round: 1, orig: 1 }]);
  check('no record for a leg-1 trade', t1.sides.every((s) => s.record === undefined));

  const d26 = out.leagues.find((l) => l.lg === hashId('s', 'league', 'D26')) as Record<string, unknown> & { drafts: { slotToRoster: unknown; picks: unknown[][] }[]; prev: string; champion: number };
  eq('draft slot order from the draft document', d26.drafts[0].slotToRoster, { 1: 2, 2: 1 });
  eq('draft selections kept', d26.drafts[0].picks[0], [1, 1, 1, 2, 'rookie', 0, null]);
  eq('lineage pointer hashed', d26.prev, hashId('s', 'league', 'D25'));
  eq('champion from the bracket', d26.champion, 2);
  eq('waiver bids kept, lost ones too', out.waivers.filter((x) => x.status === 'failed' && x.bid === 7).length, 4);

  // Privacy: nothing raw that names a person, league or chat.
  const blob = JSON.stringify(out);
  for (const raw of ['Secret League Name', 'chat', 'Someone', '"u1"', '"u2"', '"D26"', '"D26-1-0"']) {
    check(`output never contains ${raw}`, !blob.includes(raw));
  }
  check('owner ids hashed', blob.includes(hashId('s', 'user', 'u1')));

  // Resumption: the saved state skips everything already visited.
  const w2 = world(leagues, users);
  const c2 = collect();
  const again = await crawlTrades(opts({ seedLeagueIds: ['D26'] }), state, { getJson: w2.getJson, sink: c2.sink });
  eq('a second run re-crawls nothing', [again.leagueSeasons, c2.out.trades.length], [0, 0]);
  eq('totals accumulate across runs', state.totals.runs, 2);

  // A different salt would orphan every id: refuse.
  let threw = false;
  try { await crawlTrades(opts({ salt: 'other' }), state, { getJson: w2.getJson, sink: c2.sink }); } catch { threw = true; }
  check('refuses a state built with another salt', threw);

  // A transient failure: the league is not marked visited, so it is retried.
  const w3 = world(leagues, users, new Set(['/league/D25/transactions/7']));
  const c3 = collect();
  const s3: CrawlState = emptyState('s');
  const st3 = await crawlTrades(opts({ seedLeagueIds: ['D26'] }), s3, { getJson: w3.getJson, sink: c3.sink });
  check('failed league counted and left unvisited', st3.leaguesFailed === 1 && !('D25' in s3.visited), s3.visited);
  check('no partial rows from the failed league', !c3.out.leagues.some((l) => l.lg === hashId('s', 'league', 'D25')));

  // Budget: stops before starting a league-season it cannot finish.
  const c4 = collect();
  const st4 = await crawlTrades(opts({ seedLeagueIds: ['D26'], maxRequests: 60 }), emptyState('s'), { getJson: world(leagues, users).getJson, sink: c4.sink });
  check('request budget respected', st4.requests <= 60 && st4.stoppedBy === 'requests', st4);

  // Current season: transactions fetched only through the current leg.
  const w5 = world([{ id: 'C', season: '2026', type: 2, owners: ['a', 'b'] }], {});
  await crawlTrades(opts({ seedLeagueIds: ['C'], currentLeg: 6 }), emptyState('s'), {
    getJson: async (p) => { const r = await w5.getJson(p); return p === '/league/C' ? { ...(r as object), status: 'in_season' } : r; },
    sink: collect().sink,
  });
  check('in-season league stops at the current leg',
    w5.calls.includes('/league/C/transactions/6') && !w5.calls.includes('/league/C/transactions/7'));

  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
