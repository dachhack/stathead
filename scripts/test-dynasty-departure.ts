// Test script: live dynasty departure scoring from a league id.
// Run: npx tsx scripts/test-dynasty-departure.ts
//
// Sleeper calls are injected, so the cases that matter can be built: a redraft
// league (out of scope), a lineage that stops partway, a brand-new member, and a
// member whose other leagues have vanished.
import { scoreDynastyLeague, gradeFor, GRADE_LABEL, GRADE_COLOR, clearSurvivalCache, type DepartureModel } from '../src/lib/dynastyDeparture';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; return; }
  failures.push(`${name}${detail === undefined ? '' : ` — got ${JSON.stringify(detail)}`}`);
}
function eq(name: string, a: unknown, b: unknown) { check(name, JSON.stringify(a) === JSON.stringify(b), a); }

const FEATURES = [
  'isNewMember', 'tenureYears', 'tenureCensored', 'leagueSize',
  'portfolioSize', 'logPortfolioSize', 'dynastyLineages', 'dynastyShare',
  'bestBallShare', 'seasonsActive', 'priorLeaveRate', 'priorLeaveObserved',
];

// A model that keys entirely on priorLeaveRate, so its effect is checkable.
const model = (over: Partial<DepartureModel> = {}): DepartureModel => ({
  featureNames: FEATURES,
  intercept: -2,
  coefficients: FEATURES.map((f) => (f === 'priorLeaveRate' ? 3 : 0)),
  mean: FEATURES.map(() => 0),
  sd: FEATURES.map(() => 1),
  gradeCutpoints: [0.10, 0.13, 0.15, 0.19],
  ...over,
});

interface FakeLeague {
  id: string; season: number; prev: string | null;
  owners: string[]; type?: number; bestBall?: boolean; rosters?: number;
}

function world(leagues: FakeLeague[], portfolios: Record<string, Record<number, string[]>>) {
  const byId = new Map(leagues.map((l) => [l.id, l]));
  const calls: string[] = [];
  const getJson = async (path: string): Promise<unknown> => {
    calls.push(path);
    let m = /^\/league\/([^/]+)$/.exec(path);
    if (m) {
      const l = byId.get(m[1]);
      if (!l) return null;
      return {
        league_id: l.id, season: String(l.season), previous_league_id: l.prev,
        name: `L${l.id}`, status: 'complete', total_rosters: l.rosters ?? l.owners.length,
        roster_positions: ['QB', 'RB', 'WR', 'TE'], scoring_settings: {},
        settings: { type: l.type ?? 2, best_ball: l.bestBall ? 1 : 0 },
      };
    }
    m = /^\/league\/([^/]+)\/rosters$/.exec(path);
    if (m) {
      const l = byId.get(m[1]);
      return l ? l.owners.map((o) => ({ owner_id: o })) : null;
    }
    m = /^\/user\/([^/]+)\/leagues\/nfl\/(\d+)$/.exec(path);
    if (m) {
      const ids = portfolios[m[1]]?.[Number(m[2])] ?? [];
      return ids.map((id) => {
        const l = byId.get(id);
        return {
          league_id: id, season: m![2], previous_league_id: l?.prev ?? null,
          name: id, status: 'complete', total_rosters: l?.rosters ?? 12,
          roster_positions: ['QB'], scoring_settings: {},
          settings: { type: l?.type ?? 2, best_ball: l?.bestBall ? 1 : 0 }, sport: 'nfl',
        };
      });
    }
    return null;
  };
  return { deps: { getJson }, calls };
}

// ── grade bands ──
{
  const cuts = [0.10, 0.13, 0.15, 0.19];
  eq('grades: below the first cut is 1', gradeFor(0.05, cuts), 1);
  eq('grades: on a cut moves up', gradeFor(0.10, cuts), 2);
  eq('grades: middle band', gradeFor(0.14, cuts), 3);
  eq('grades: fourth band', gradeFor(0.16, cuts), 4);
  eq('grades: above the last cut is 5', gradeFor(0.50, cuts), 5);
  eq('grades: capped at 5', gradeFor(1, cuts), 5);
  eq('grades: every grade has a label', Object.keys(GRADE_LABEL).length, 5);
  // The standings column paints the badge from GRADE_COLOR and the retention
  // view reads the same map. A gap here renders a transparent badge, not a
  // crash, so it has to be checked rather than noticed.
  eq('grades: every grade has a colour', Object.keys(GRADE_COLOR).length, 5);
  eq('grades: labels and colours cover the same grades',
    Object.keys(GRADE_LABEL).sort(), Object.keys(GRADE_COLOR).sort());
  check('grades: every colour is a hex value',
    Object.values(GRADE_COLOR).every((c) => /^#[0-9a-f]{6}$/i.test(c)), GRADE_COLOR);
  // Fixed cutpoints, so a healthy league can have no high grades at all —
  // grading within a league would force one.
  check('grades: a uniformly safe set can be all 1s',
    [0.01, 0.02, 0.03].every((r) => gradeFor(r, cuts) === 1));
}

// ── out of scope: redraft and best ball ──
{
  const { deps } = world([{ id: 'R', season: 2026, prev: null, owners: ['u1'], type: 0 }], {});
  const r = await scoreDynastyLeague('R', model(), { deps });
  check('scope: redraft is declined with a reason', (r.notApplicable ?? '').includes('redraft'), r.notApplicable);
  eq('scope: and nobody is scored', r.members.length, 0);

  // Best-ball DYNASTY is in scope: rosters persist, so "will they come back" is
  // well defined and recorded renewal matches regular dynasty. Best ball is only
  // excluded from the in-season engagement work, where there is no lineup or
  // waiver activity to read — a different question.
  const { deps: d2 } = world([{ id: 'B', season: 2026, prev: null, owners: ['u1'], type: 2, bestBall: true }],
    { u1: { 2026: ['B'] } });
  const bb = await scoreDynastyLeague('B', model(), { deps: d2 });
  eq('scope: best-ball dynasty is scored, not declined', bb.notApplicable, null);
  eq('scope: and its member gets a grade', bb.members.length, 1);

  // Best-ball REDRAFT is still out: the league chain says nothing there.
  const { deps: d3 } = world([{ id: 'BR', season: 2026, prev: null, owners: ['u1'], type: 0, bestBall: true }], {});
  const br = await scoreDynastyLeague('BR', model(), { deps: d3 });
  check('scope: best-ball redraft is still declined', (br.notApplicable ?? '').includes('redraft'), br.notApplicable);
}

// ── the lineage walk and tenure ──
{
  const leagues: FakeLeague[] = [
    { id: 'L26', season: 2026, prev: 'L25', owners: ['a', 'b', 'newbie'] },
    { id: 'L25', season: 2025, prev: 'L24', owners: ['a', 'b', 'gone'] },
    { id: 'L24', season: 2024, prev: null, owners: ['a', 'gone'] },
  ];
  const portfolios = {
    a: { 2026: ['L26'], 2025: ['L25'], 2024: ['L24'] },
    b: { 2026: ['L26'], 2025: ['L25'] },
    newbie: { 2026: ['L26'] },
  };
  const { deps, calls } = world(leagues, portfolios);
  const r = await scoreDynastyLeague('L26', model(), { deps, seasons: 4 });

  eq('walk: only current members are scored', r.members.length, 3);
  eq('walk: seasons walked', r.seasonsWalked, ['2024', '2025', '2026']);
  check('walk: it stops when the chain ends', !calls.some((c) => c === '/league/null'));

  const a = r.members.find((m) => m.ownerId === 'a')!;
  const b = r.members.find((m) => m.ownerId === 'b')!;
  const n = r.members.find((m) => m.ownerId === 'newbie')!;
  eq('tenure: three straight seasons', a.tenureYears, 3);
  eq('tenure: two straight seasons', b.tenureYears, 2);
  eq('tenure: a first season is one year', n.tenureYears, 1);
  eq('tenure: only the newcomer is flagged new', [a.isNewMember, b.isNewMember, n.isNewMember], [false, false, true]);
  // The chain ends at L24 with previous_league_id null, so the league genuinely
  // began in 2024 and a founding member's tenure of 3 is exact, not a floor.
  check('tenure: a founding member of a fully-walked chain is not censored', !a.tenureCensored, a);
  check('tenure: nor is a newcomer', !n.tenureCensored);
}

// ── a chain that runs past the lookback ──
{
  // Same league, but walked with a lookback of 2 so the chain is cut short.
  const leagues: FakeLeague[] = [
    { id: 'L26', season: 2026, prev: 'L25', owners: ['a'] },
    { id: 'L25', season: 2025, prev: 'L24', owners: ['a'] },
    { id: 'L24', season: 2024, prev: null, owners: ['a'] },
  ];
  const { deps } = world(leagues, { a: { 2026: ['L26'], 2025: ['L25'] } });
  const r = await scoreDynastyLeague('L26', model(), { deps, seasons: 2 });
  const a = r.members[0];
  eq('truncation: tenure is capped by how far we walked', a.tenureYears, 2);
  check('truncation: and marked as a floor rather than a fact', a.tenureCensored, a);
  eq('truncation: only the walked seasons are reported', r.seasonsWalked, ['2025', '2026']);
}

// ── the approximate past-exit feature ──
{
  const leagues: FakeLeague[] = [
    { id: 'M26', season: 2026, prev: 'M25', owners: ['stayer', 'churner'] },
    { id: 'M25', season: 2025, prev: null, owners: ['stayer', 'churner'] },
    // The churner's other dynasty league, which they left after 2025.
    { id: 'X25', season: 2025, prev: null, owners: ['churner'] },
  ];
  const portfolios = {
    stayer: { 2026: ['M26'], 2025: ['M25'] },
    churner: { 2026: ['M26'], 2025: ['M25', 'X25'] },
  };
  const { deps } = world(leagues, portfolios);
  const r = await scoreDynastyLeague('M26', model(), { deps, seasons: 3 });

  const stayer = r.members.find((m) => m.ownerId === 'stayer')!;
  const churner = r.members.find((m) => m.ownerId === 'churner')!;
  eq('past exits: the stayer kept everything', stayer.priorLeaveRate, 0);
  check('past exits: the churner shows one of two lost', churner.priorLeaveRate > 0, churner.priorLeaveRate);
  check('past exits: which raises their risk', churner.risk > stayer.risk, [churner.risk, stayer.risk]);
  check('past exits: and can raise their grade', churner.grade >= stayer.grade);
  // The approximation in one line: X25 may well have carried on without them,
  // and nothing here can tell.
  check('past exits: denominators are reported so the reader can judge',
    churner.priorLeaveObserved >= 1, churner.priorLeaveObserved);

  eq('output: sorted riskiest first', r.members[0].ownerId, 'churner');
  check('output: risks are probabilities', r.members.every((m) => m.risk >= 0 && m.risk <= 1));
  check('output: request count reported', r.requests > 0, r.requests);
}

// ── verification: a folded league is not a departure ──
{
  // The churner left X25. Whether that counts depends on whether X25 carried
  // on — and only X25's OTHER members can say.
  const leagues: FakeLeague[] = [
    { id: 'V26', season: 2026, prev: 'V25', owners: ['churner'] },
    { id: 'V25', season: 2025, prev: null, owners: ['churner'] },
    { id: 'X25', season: 2025, prev: null, owners: ['churner', 'other'] },
  ];
  const portfolios = {
    churner: { 2026: ['V26'], 2025: ['V25', 'X25'] },
    other: { 2025: ['X25'] },   // nobody carried X25 into 2026: it folded
  };

  clearSurvivalCache();
  const { deps } = world(leagues, portfolios);
  const approx = await scoreDynastyLeague('V26', model(), { deps, seasons: 3 });
  clearSurvivalCache();
  const { deps: d2, calls } = world(leagues, portfolios);
  const verified = await scoreDynastyLeague('V26', model(), { deps: d2, seasons: 3, verify: true });

  eq('verify: approximate counts the vanished league as an exit',
    approx.members[0].priorLeaveObserved, 2);
  check('verify: and so shows a non-zero rate', approx.members[0].priorLeaveRate > 0);

  // Verified: X25 had no successor, so it was never at risk and drops out.
  eq('verify: a folded league is not counted at risk', verified.members[0].priorLeaveObserved, 1);
  eq('verify: leaving the exit rate at zero', verified.members[0].priorLeaveRate, 0);
  check('verify: which lowers the risk', verified.members[0].risk < approx.members[0].risk,
    [verified.members[0].risk, approx.members[0].risk]);

  check('verify: reported as applied', verified.verification.applied, verified.verification);
  check('verify: with the check counted', verified.verification.checked >= 1);
  check('verify: it fetched the league rosters to find out',
    calls.some((c) => c === '/league/X25/rosters'), calls.filter((c) => c.includes('X25')));
  check('verify: approximate mode reports itself honestly',
    !approx.verification.applied && approx.verification.note.includes('approximate'));
}

// ── verification: a surviving league IS a departure ──
{
  const leagues: FakeLeague[] = [
    { id: 'W26', season: 2026, prev: 'W25', owners: ['churner'] },
    { id: 'W25', season: 2025, prev: null, owners: ['churner'] },
    { id: 'Y25', season: 2025, prev: null, owners: ['churner', 'stayer'] },
    { id: 'Y26', season: 2026, prev: 'Y25', owners: ['stayer'] },   // Y carried on
  ];
  const portfolios = {
    churner: { 2026: ['W26'], 2025: ['W25', 'Y25'] },
    stayer: { 2026: ['Y26'], 2025: ['Y25'] },
  };
  clearSurvivalCache();
  const { deps } = world(leagues, portfolios);
  const r = await scoreDynastyLeague('W26', model(), { deps, seasons: 3, verify: true });
  eq('verify: a surviving league keeps the row at risk', r.members[0].priorLeaveObserved, 2);
  check('verify: and the exit counts', r.members[0].priorLeaveRate > 0, r.members[0].priorLeaveRate);
}

// ── verification: budget and cache ──
{
  const leagues: FakeLeague[] = [
    { id: 'B26', season: 2026, prev: 'B25', owners: ['m'] },
    { id: 'B25', season: 2025, prev: null, owners: ['m'] },
    { id: 'Z25', season: 2025, prev: null, owners: ['m'] },
  ];
  const portfolios = { m: { 2026: ['B26'], 2025: ['B25', 'Z25'] } };

  clearSurvivalCache();
  const { deps } = world(leagues, portfolios);
  const capped = await scoreDynastyLeague('B26', model(), { deps, seasons: 3, verify: true, verifyBudget: 1 });
  check('budget: exhaustion is reported', capped.verification.budgetExhausted);
  check('budget: and the whole league falls back rather than mixing definitions',
    !capped.verification.applied && capped.verification.note.includes('fell back'));
  // Falling back must give exactly the approximate answer, not a hybrid.
  clearSurvivalCache();
  const { deps: d2 } = world(leagues, portfolios);
  const plain = await scoreDynastyLeague('B26', model(), { deps: d2, seasons: 3 });
  eq('budget: the fallback equals the approximate result',
    capped.members[0].priorLeaveRate, plain.members[0].priorLeaveRate);

  // Second run reuses the cache, so it fetches nothing.
  clearSurvivalCache();
  const { deps: d3 } = world(leagues, portfolios);
  const first = await scoreDynastyLeague('B26', model(), { deps: d3, seasons: 3, verify: true });
  const { deps: d4, calls: calls2 } = world(leagues, portfolios);
  const second = await scoreDynastyLeague('B26', model(), { deps: d4, seasons: 3, verify: true });
  check('cache: the first run fetches', first.verification.fetched > 0, first.verification);
  eq('cache: the second fetches nothing', second.verification.fetched, 0);
  check('cache: and asks no rosters again', !calls2.some((c) => c === '/league/Z25/rosters'));
  eq('cache: same answer either way', second.members[0].priorLeaveRate, first.members[0].priorLeaveRate);
}

// ── a missing league ──
{
  const { deps } = world([], {});
  const r = await scoreDynastyLeague('nope', model(), { deps });
  check('missing: reported, not thrown', (r.notApplicable ?? '').includes('not found'), r.notApplicable);
}

console.log(`\n${passed} checks passed, ${failures.length} failed\n`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
console.log('✓ dynasty departure scoring behaves as specified');
