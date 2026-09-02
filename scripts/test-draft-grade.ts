// Test script: the Sleeper draft grader.
// Run: npx tsx scripts/test-draft-grade.ts
//
// The grade is relative to the league and built on replacement-level value, so
// the things that can be quietly wrong are the baselines (superflex and 2-RB
// leagues move them a long way), the lineup fill order, and "best available"
// being evaluated after the pick was removed instead of before.
import {
  gradeDraft, replacementRanks, replacementPoints, bestLineupPoints, letterFor,
  GRADE_COLOR, type DraftPickInput,
} from '../src/lib/draftGrade';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; return; }
  failures.push(`${name}${detail === undefined ? '' : ` — got ${JSON.stringify(detail)}`}`);
}
const eq = (n: string, a: unknown, b: unknown) => check(n, JSON.stringify(a) === JSON.stringify(b), a);
const near = (n: string, a: number, b: number, tol = 1e-6) => check(n, Math.abs(a - b) < tol, a);

const STD = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN'];
const SF = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'BN'];

// ── replacement baselines follow the league, not a constant ──
{
  const std = replacementRanks(STD, 12);
  const sf = replacementRanks(SF, 12);
  check('QB baseline is one per team in a 1QB league', std.QB === 12, std.QB);
  check('superflex pushes the QB baseline much deeper', sf.QB > std.QB + 5, { std: std.QB, sf: sf.QB });
  check('RB baseline counts the flex share', std.RB > 24, std.RB);
  check('bench slots do not move a baseline',
    replacementRanks([...STD, 'BN', 'BN', 'BN'], 12).RB === std.RB);
  check('every baseline is at least 1', Object.values(replacementRanks(['BN'], 12)).every((v) => v >= 1));
}

// ── replacement points read the right player off the board ──
{
  const pool = [
    { position: 'RB', points: 300 }, { position: 'RB', points: 200 },
    { position: 'RB', points: 100 }, { position: 'QB', points: 400 },
  ];
  eq('replacement is the Nth best at the position',
    replacementPoints(pool, { RB: 2 }).RB, 200);
  eq('a baseline deeper than the pool falls to the last player',
    replacementPoints(pool, { RB: 99 }).RB, 100);
  eq('a position absent from the pool is zero',
    replacementPoints(pool, { TE: 1 }).TE, 0);
}

// ── lineup fill: fixed slots before flex ──
{
  // Greedy flex-first would spend the flex on the 250 RB and strand the QB.
  const players = [
    { position: 'RB', points: 250 }, { position: 'RB', points: 240 },
    { position: 'RB', points: 230 }, { position: 'QB', points: 100 },
    { position: 'WR', points: 90 }, { position: 'WR', points: 80 },
    { position: 'TE', points: 70 },
  ];
  eq('fixed slots are filled before the flex',
    bestLineupPoints(players, STD), 250 + 240 + 100 + 90 + 80 + 70 + 230);
  eq('a missing position simply scores nothing',
    bestLineupPoints([{ position: 'RB', points: 100 }], STD), 100);
  eq('bench players do not score', bestLineupPoints(players, ['BN', 'BN']), 0);

  // Order matters only when the flex would eat a player some fixed slot cannot
  // replace. With one TE on the roster, a flex-first fill spends him and leaves
  // the TE slot empty. The earlier fixture had exactly as many players as slots,
  // so every ordering scored the same and the bug would have walked through.
  const scarce = [
    { position: 'TE', points: 200 },
    { position: 'RB', points: 100 },
    { position: 'QB', points: 50 },
  ];
  eq('a lone TE is not spent on the flex',
    bestLineupPoints(scarce, ['QB', 'TE', 'FLEX']), 350);
  check('superflex uses a second QB when it beats the alternatives',
    bestLineupPoints([...players, { position: 'QB', points: 999 }], SF) >
    bestLineupPoints(players, SF) + 900);
}

// ── the curve ──
{
  eq('best of twelve is an A', letterFor(0, 12), 'A');
  eq('worst of twelve is an F', letterFor(11, 12), 'F');
  eq('the middle is a C', letterFor(6, 12), 'C');
  check('a twelve-team league is not all As',
    new Set(Array.from({ length: 12 }, (_, i) => letterFor(i, 12))).size >= 4);
  eq('every letter has a colour', Object.keys(GRADE_COLOR).length, 5);
  check('grades are monotone: no better rank gets a worse letter', (() => {
    const order = ['A', 'B', 'C', 'D', 'F'];
    const seq = Array.from({ length: 24 }, (_, i) => order.indexOf(letterFor(i, 24)));
    return seq.every((v, i) => i === 0 || v >= seq[i - 1]);
  })());
}

// ── the whole grader on a hand-built draft ──
{
  const pool = [
    { playerId: 'a', position: 'RB', points: 300 },
    { playerId: 'b', position: 'WR', points: 280 },
    { playerId: 'c', position: 'RB', points: 150 },
    { playerId: 'd', position: 'WR', points: 140 },
    { playerId: 'e', position: 'QB', points: 320 },
    { playerId: 'f', position: 'TE', points: 130 },
  ];
  const proj = new Map(pool.map((p) => [p.playerId, p.points]));
  const pick = (pickNo: number, rosterId: number, playerId: string): DraftPickInput => {
    const p = pool.find((x) => x.playerId === playerId)!;
    return { pickNo, round: Math.ceil(pickNo / 2), rosterId, playerId, playerName: playerId, position: p.position };
  };
  // Team 1 takes the top of the board each time; team 2 takes leftovers.
  const picks = [pick(1, 1, 'a'), pick(2, 2, 'c'), pick(3, 1, 'b'), pick(4, 2, 'd')];
  const rep = gradeDraft({ picks, projByPlayerId: proj, pool, rosterPositions: STD, teams: 2 });

  eq('every pick is graded', rep.gradedPicks, 4);
  eq('nothing unmatched', rep.unmatchedPicks, 0);
  eq('the better drafter ranks first', rep.teams[0].rosterId, 1);
  eq('and takes the A', rep.teams[0].grade, 'A');
  check('the better drafter captured more', rep.teams[0].captureRate > rep.teams[1].captureRate,
    [rep.teams[0].captureRate, rep.teams[1].captureRate]);
  near('taking the top of the board every time captures all of it',
    rep.teams[0].captureRate, 1);
  check('the weaker draft left value on the board',
    (rep.teams[1].worstPick?.leftOnBoard ?? 0) > 0);

  // Best-available must be evaluated BEFORE the pick is removed, or a manager
  // who takes the top player looks like they missed him.
  const first = rep.teams[0].picks.find((p) => p.pickNo === 1)!;
  eq('best available at pick 1 is the pick itself', first.leftOnBoard, 0);

  // A player with no projection must not silently score as replacement level.
  const withGhost = gradeDraft({
    picks: [...picks, { pickNo: 5, round: 3, rosterId: 1, playerId: 'zz', playerName: 'Ghost', position: 'WR' }],
    projByPlayerId: proj, pool, rosterPositions: STD, teams: 2,
  });
  eq('an unprojected pick is reported, not hidden', withGhost.unmatchedPicks, 1);
  check('and does not add starter points',
    withGhost.teams.find((t) => t.rosterId === 1)!.starterPoints ===
    rep.teams.find((t) => t.rosterId === 1)!.starterPoints);
}

// ── a rookie draft is declined, not graded ──
{
  // Everything on this board sits far below the NFL replacement baseline, which
  // is exactly what a dynasty rookie draft looks like. Grading it produced
  // confident letters over a capture rate of 0% for nine of twelve teams.
  const pool = Array.from({ length: 40 }, (_, i) => ({
    playerId: `vet${i}`, position: 'RB', points: 300 - i * 5,
  }));
  const rookies = Array.from({ length: 10 }, (_, i) => ({
    playerId: `rook${i}`, position: 'RB', points: 20 - i,
  }));
  const proj = new Map([...pool, ...rookies].map((p) => [p.playerId, p.points]));
  const picks: DraftPickInput[] = rookies.map((r, i) => ({
    pickNo: i + 1, round: 1, rosterId: (i % 2) + 1,
    playerId: r.playerId, playerName: r.playerId, position: 'RB',
  }));
  const rep = gradeDraft({ picks, projByPlayerId: proj, pool: [...pool, ...rookies], rosterPositions: STD, teams: 2 });
  check('a rookie draft is declined', (rep.notApplicable ?? '').includes('rookie'), rep.notApplicable);

  // And a real redraft is NOT declined — the guard must not swallow the product.
  const realPicks: DraftPickInput[] = pool.slice(0, 10).map((p, i) => ({
    pickNo: i + 1, round: 1, rosterId: (i % 2) + 1,
    playerId: p.playerId, playerName: p.playerId, position: 'RB',
  }));
  const ok = gradeDraft({ picks: realPicks, projByPlayerId: proj, pool, rosterPositions: STD, teams: 2 });
  eq('a startup/redraft draft is graded normally', ok.notApplicable, null);
  check('and produces real capture rates', ok.teams.some((t) => t.captureRate > 0));
}

// ── degenerate inputs ──
{
  const empty = gradeDraft({ picks: [], projByPlayerId: new Map(), pool: [], rosterPositions: STD, teams: 12 });
  eq('an empty draft grades nothing', empty.teams.length, 0);
  const noRoster = gradeDraft({
    picks: [{ pickNo: 1, round: 1, rosterId: null, playerId: 'a', playerName: 'A', position: 'RB' }],
    projByPlayerId: new Map([['a', 100]]), pool: [{ playerId: 'a', position: 'RB', points: 100 }],
    rosterPositions: STD, teams: 12,
  });
  eq('a pick with no roster is skipped, not crashed', noRoster.teams.length, 0);
}

console.log(`\n${passed} checks passed, ${failures.length} failed\n`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
console.log('✓ draft grading behaves as specified');
