// Test script: the retrospective league-health computation.
// Run: npx tsx scripts/test-league-health.ts
//
// Fetchers are injected, so the awkward cases are constructed rather than hunted
// for: a league with no prior season, a season with no transactions, a manager
// who never made a move, an owner who did not come back.
import { computeLeagueRetrospective } from '../src/lib/leagueHealth';
import type { LeagueImport, LeagueTeam, SleeperRawTransaction } from '../src/lib/sleeper';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; return; }
  failures.push(`${name}${detail === undefined ? '' : ` — got ${JSON.stringify(detail)}`}`);
}
function eq(name: string, a: unknown, b: unknown) { check(name, JSON.stringify(a) === JSON.stringify(b), a); }

const team = (rosterId: number, ownerId: string | null): LeagueTeam => ({
  rosterId, teamName: `Team ${rosterId}`, owner: `owner${rosterId}`,
  wins: 7, losses: 7, ties: 0, pointsFor: 1500, pointsAgainst: 1400,
  ownerId, starters: [], bench: [],
});

const league = (over: Partial<LeagueImport['league']> = {}): LeagueImport['league'] => ({
  league_id: 'CUR', previous_league_id: 'PREV', name: 'League', season: '2026',
  status: 'pre_draft', total_rosters: 3, roster_positions: ['QB', 'RB', 'WR'],
  scoring_settings: {}, settings: { type: 0 }, ...over,
});

const txn = (rosterId: number): SleeperRawTransaction =>
  ({ type: 'free_agent', status: 'complete', roster_ids: [rosterId], adds: { p: rosterId }, drops: null, created: 0 });

// Last season: three managers. 1 active to week 16, 2 stopped at week 4,
// 3 never made a move. Manager 2 is not in the current league.
function world(weeksByRoster: Record<number, number[]>, currentOwners: (string | null)[]) {
  const prev: LeagueImport = {
    league: league({ league_id: 'PREV', previous_league_id: null, season: '2025', status: 'complete' }),
    teams: [team(1, 'u1'), team(2, 'u2'), team(3, 'u3')],
  };
  const byWeek = Array.from({ length: 18 }, (_, i) => {
    const week = i + 1;
    const txns: SleeperRawTransaction[] = [];
    for (const [roster, weeks] of Object.entries(weeksByRoster)) {
      if (weeks.includes(week)) txns.push(txn(Number(roster)));
    }
    return { week, txns };
  });
  const current: LeagueImport = {
    league: league(),
    teams: currentOwners.map((o, i) => team(i + 1, o)),
  };
  return {
    current,
    deps: {
      importLeague: async () => prev,
      fetchTransactions: async () => ({ byWeek, weeksFailed: 0 }),
    },
  };
}

// ── the ordinary case ──
{
  const { current, deps } = world(
    { 1: [1, 5, 9, 16], 2: [1, 2, 4], 3: [] },
    ['u1', null, 'u3'],   // u2 did not come back
  );
  const r = await computeLeagueRetrospective(current, deps);

  eq('season taken from the prior league', r.season, '2025');
  eq('observed week is the last with any activity anywhere', r.observedWeek, 16);
  eq('one row per team', r.managers.length, 3);

  const m1 = r.managers.find((m) => m.rosterId === 1)!;
  const m2 = r.managers.find((m) => m.rosterId === 2)!;
  const m3 = r.managers.find((m) => m.rosterId === 3)!;

  eq('an engaged manager is not marked checked out', m1.wentDark, false);
  eq('their moves are counted', m1.transactions, 4);
  eq('and their last one recorded', m1.lastActiveWeek, 16);
  eq('quiet weeks measured to the observed end', m1.weeksSilentAtEnd, 0);

  eq('stopping early is checked out', m2.wentDark, true);
  eq('with the silence measured', m2.weeksSilentAtEnd, 12);
  eq('and the return status observed, not guessed', m2.returned, false);
  eq('a returning manager is marked back', m1.returned, true);

  // A manager who never moved is not a quitter — usually a league that never
  // really launched, matching how the label is defined everywhere else.
  eq('never active is not counted as checked out', m3.wentDark, false);
  eq('but the zero is visible', m3.transactions, 0);
  eq('and there is no last week to show', m3.lastActiveWeek, null);

  eq('checked-out count', r.wentDarkCount, 1);
  eq('checked out and gone is the actionable shortlist', r.darkAndGone, 1);

  // Worst first: the panel is a to-do list, not a leaderboard.
  eq('sorted worst first', r.managers[0].rosterId, 2);
}

// ── no prior season linked ──
{
  const { deps } = world({ 1: [1] }, ['u1']);
  const r = await computeLeagueRetrospective(
    { league: league({ previous_league_id: null }), teams: [team(1, 'u1')] }, deps,
  );
  check('no prior season is explained, not errored', !!r.notApplicable, r);
  check('and names previous_league_id so the reason is actionable',
    (r.notApplicable ?? '').includes('previous_league_id'));
  eq('with no rows', r.managers.length, 0);
}

// ── a prior season with no transactions at all ──
{
  const { current, deps } = world({ 1: [], 2: [], 3: [] }, ['u1', 'u2', 'u3']);
  const r = await computeLeagueRetrospective(current, deps);
  check('a silent season is explained rather than shown as everyone quitting', !!r.notApplicable, r);
  eq('and nobody is labelled', r.managers.length, 0);
}

// ── best ball last season ──
{
  const prev: LeagueImport = {
    league: league({ league_id: 'PREV', previous_league_id: null, season: '2025', settings: { type: 0, best_ball: 1 } }),
    teams: [team(1, 'u1')],
  };
  const r = await computeLeagueRetrospective(
    { league: league(), teams: [team(1, 'u1')] },
    { importLeague: async () => prev, fetchTransactions: async () => ({ byWeek: [], weeksFailed: 0 }) },
  );
  check('best ball is excluded with a reason', (r.notApplicable ?? '').includes('best ball'), r.notApplicable);
}

// ── an unowned prior roster ──
{
  const { current, deps } = world({ 1: [1, 2, 3], 2: [1], 3: [1] }, ['u1', 'u2', 'u3']);
  const prevOrphan: LeagueImport = {
    league: league({ league_id: 'PREV', previous_league_id: null, season: '2025', status: 'complete' }),
    teams: [team(1, 'u1'), team(2, null), team(3, 'u3')],
  };
  const r = await computeLeagueRetrospective(current, { ...deps, importLeague: async () => prevOrphan });
  const orphan = r.managers.find((m) => m.rosterId === 2)!;
  eq('an unowned roster has unknown return status, not false', orphan.returned, null);
}

// ── partial fetch is surfaced ──
{
  const { current, deps } = world({ 1: [1, 2] }, ['u1']);
  const r = await computeLeagueRetrospective(current, {
    ...deps, fetchTransactions: async () => ({ byWeek: [{ week: 1, txns: [txn(1)] }], weeksFailed: 4 }),
  });
  eq('failed weeks are reported so low counts are explainable', r.weeksFailed, 4);
}

console.log(`\n${passed} checks passed, ${failures.length} failed\n`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
console.log('✓ retrospective league health reports observed behaviour as specified');
