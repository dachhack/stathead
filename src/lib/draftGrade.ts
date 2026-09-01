// Sleeper draft grader — scores every team in a completed or in-progress draft.
//
// WHAT THIS DOES NOT CLAIM. It grades against StatHead's own projections. That
// is a statement about our board, not a validated prediction of the season.
//
// The honest reason for that hedge is measured, not modest. scripts/
// backtest-draft-grade.ts graded 3,310 real team-drafts from 301 crawled
// league-seasons against actual standings, and NOTHING derived from draft-time
// market pricing predicted points scored:
//
//   metric              contaminated (2,965)   clean (344)
//   ADP value per pick     -0.103 *              0.006
//   ADP value total        -0.133 *             -0.001
//   reach magnitude        +0.115 *             -0.013
//   roster quality         +0.093 *              0.064
//   slot-adjusted          +0.152 *              0.002
//
// The significant column is an artifact: every historical FFC ADP snapshot is
// taken in the last days before Week 1, and 263 of those 301 drafts happened
// BEFORE their own snapshot, so the ADP already priced in late-August injury
// news the drafter never had. Split that out and every effect goes to zero.
//
// So no grade here is presented as a forecast. What it can say honestly:
// how good the squad looks on our numbers, and how much of the value on the
// board a manager captured. Both are descriptions with a stated yardstick.
//
// Grading is RELATIVE TO THE LEAGUE, unlike the dynasty departure grade, which
// uses fixed population cutpoints. That difference is deliberate: departure
// risk is an absolute property of a manager, while a draft is a competition
// against the other eleven teams in the room. Being the best drafter in a weak
// league is exactly what a draft grade should reward.

export interface DraftPickInput {
  pickNo: number;
  round: number;
  rosterId: number | null;
  playerId: string;
  playerName: string;
  position: string;
}

export interface DraftGradeOptions {
  picks: DraftPickInput[];
  /** Scoring-adjusted projected season points by Sleeper player id. */
  projByPlayerId: Map<string, number>;
  /** Every projectable player, so "best available" means the whole pool. */
  pool: Array<{ playerId: string; position: string; points: number }>;
  /** League starting slots, e.g. ['QB','RB','RB','WR','WR','TE','FLEX','BN']. */
  rosterPositions: string[];
  teams: number;
}

export interface GradedPick extends DraftPickInput {
  points: number;
  vor: number;
  /** Best VOR still on the board when this pick was made. */
  bestAvailableVor: number;
  bestAvailableName: string;
  /** VOR forgone. Zero when the manager took the top of our board. */
  leftOnBoard: number;
}

export interface TeamDraftGrade {
  rosterId: number;
  picks: GradedPick[];
  /** Projected points of the best legal starting lineup from what they drafted. */
  starterPoints: number;
  /** Total value over replacement drafted. */
  vorTotal: number;
  /** Share of the VOR available at their own slots that they actually took. */
  captureRate: number;
  /** Biggest single miss, for the one-line explanation. */
  worstPick: GradedPick | null;
  bestPick: GradedPick | null;
  rank: number;      // 1 = best starterPoints in the league
  grade: DraftLetter;
}

export type DraftLetter = 'A' | 'B' | 'C' | 'D' | 'F';

export interface DraftGradeReport {
  teams: TeamDraftGrade[];
  /** Positions whose replacement baseline was derived, for the tooltip. */
  replacementRank: Record<string, number>;
  gradedPicks: number;
  unmatchedPicks: number;
}

const FLEX_ELIGIBLE = new Set(['RB', 'WR', 'TE']);
const SUPERFLEX_ELIGIBLE = new Set(['QB', 'RB', 'WR', 'TE']);

/**
 * Replacement rank per position: how many of that position the league starts in
 * total. The Nth-best is the waiver-wire alternative, so value above him is the
 * only value that matters. Derived from the actual roster settings rather than
 * a constant, because a superflex or 2-RB league moves these a long way.
 */
export function replacementRanks(rosterPositions: string[], teams: number): Record<string, number> {
  const slots = rosterPositions.filter((s) => s !== 'BN' && s !== 'IR' && s !== 'TAXI');
  const count = (p: string) => slots.filter((s) => s === p).length;
  const flex = slots.filter((s) => s === 'FLEX' || s === 'WRRB_FLEX' || s === 'REC_FLEX').length;
  const superflex = slots.filter((s) => s === 'SUPER_FLEX' || s === 'QB/WR/RB/TE').length;

  // Flex spots are shared; split them across the eligible positions rather than
  // charging each position the full amount, which would push every baseline far
  // too deep and flatten the VOR spread.
  const flexShare = flex / 3;
  return {
    QB: Math.max(1, Math.round((count('QB') + superflex * 0.6) * teams)),
    RB: Math.max(1, Math.round((count('RB') + flexShare + superflex * 0.15) * teams)),
    WR: Math.max(1, Math.round((count('WR') + flexShare + superflex * 0.15) * teams)),
    TE: Math.max(1, Math.round((count('TE') + flexShare + superflex * 0.1) * teams)),
  };
}

/** Points of the replacement-level player at each position. */
export function replacementPoints(
  pool: Array<{ position: string; points: number }>,
  ranks: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [pos, rank] of Object.entries(ranks)) {
    const at = pool.filter((p) => p.position === pos).map((p) => p.points).sort((a, b) => b - a);
    out[pos] = at.length ? (at[Math.min(rank, at.length) - 1] ?? 0) : 0;
  }
  return out;
}

/** Best legal starting lineup from a set of drafted players. */
export function bestLineupPoints(
  players: Array<{ position: string; points: number }>,
  rosterPositions: string[],
): number {
  const slots = rosterPositions.filter((s) => s !== 'BN' && s !== 'IR' && s !== 'TAXI');
  const left = [...players].sort((a, b) => b.points - a.points);
  const used = new Set<number>();
  let total = 0;

  const take = (eligible: (pos: string) => boolean) => {
    for (let i = 0; i < left.length; i++) {
      if (used.has(i) || !eligible(left[i].position)) continue;
      used.add(i);
      total += left[i].points;
      return;
    }
  };
  // Fixed slots first: a flex filled greedily before QB could strand a starter.
  for (const s of slots) {
    if (s === 'FLEX' || s === 'SUPER_FLEX' || s === 'WRRB_FLEX' || s === 'REC_FLEX' || s === 'QB/WR/RB/TE') continue;
    take((p) => p === s);
  }
  for (const s of slots) {
    if (s === 'FLEX' || s === 'WRRB_FLEX') take((p) => FLEX_ELIGIBLE.has(p));
    else if (s === 'REC_FLEX') take((p) => p === 'WR' || p === 'TE');
    else if (s === 'SUPER_FLEX' || s === 'QB/WR/RB/TE') take((p) => SUPERFLEX_ELIGIBLE.has(p));
  }
  return total;
}

export function gradeDraft(opts: DraftGradeOptions): DraftGradeReport {
  const ranks = replacementRanks(opts.rosterPositions, opts.teams);
  const repl = replacementPoints(opts.pool, ranks);
  const vorOf = (position: string, points: number) => points - (repl[position] ?? 0);

  // Walk the draft in order so "best available" means what was actually there.
  const available = new Map(opts.pool.map((p) => [p.playerId, p]));
  const ordered = [...opts.picks].sort((a, b) => a.pickNo - b.pickNo);

  const byTeam = new Map<number, GradedPick[]>();
  let unmatched = 0;

  for (const pick of ordered) {
    const proj = opts.projByPlayerId.get(pick.playerId);
    // Best VOR on the board right now, evaluated before removing this pick.
    let bestVor = -Infinity;
    let bestName = '';
    for (const cand of available.values()) {
      const v = vorOf(cand.position, cand.points);
      if (v > bestVor) { bestVor = v; bestName = cand.playerId; }
    }
    if (bestVor === -Infinity) bestVor = 0;

    available.delete(pick.playerId);
    if (proj == null) { unmatched++; }

    const points = proj ?? 0;
    const vor = proj == null ? 0 : vorOf(pick.position, points);
    const graded: GradedPick = {
      ...pick, points, vor,
      bestAvailableVor: bestVor,
      bestAvailableName: bestName,
      leftOnBoard: Math.max(0, bestVor - vor),
    };
    if (pick.rosterId == null) continue;
    const arr = byTeam.get(pick.rosterId) ?? [];
    arr.push(graded);
    byTeam.set(pick.rosterId, arr);
  }

  const teams: TeamDraftGrade[] = [];
  for (const [rosterId, picks] of byTeam) {
    const scored = picks.filter((p) => p.points > 0);
    const starterPoints = bestLineupPoints(
      scored.map((p) => ({ position: p.position, points: p.points })), opts.rosterPositions);
    const vorTotal = picks.reduce((s, p) => s + Math.max(0, p.vor), 0);
    // Capture is measured only over picks where a positive-VOR player was
    // actually available. Late rounds where the whole board is below
    // replacement would otherwise drag every manager toward zero identically.
    const live = picks.filter((p) => p.bestAvailableVor > 0);
    const got = live.reduce((s, p) => s + Math.max(0, p.vor), 0);
    const had = live.reduce((s, p) => s + p.bestAvailableVor, 0);
    const withVor = picks.filter((p) => p.points > 0);
    teams.push({
      rosterId, picks, starterPoints, vorTotal,
      captureRate: had > 0 ? got / had : 0,
      worstPick: withVor.length
        ? withVor.reduce((a, b) => (b.leftOnBoard > a.leftOnBoard ? b : a)) : null,
      bestPick: withVor.length
        ? withVor.reduce((a, b) => (b.vor > a.vor ? b : a)) : null,
      rank: 0, grade: 'C',
    });
  }

  teams.sort((a, b) => b.starterPoints - a.starterPoints);
  teams.forEach((t, i) => { t.rank = i + 1; t.grade = letterFor(i, teams.length); });

  return {
    teams, replacementRank: ranks,
    gradedPicks: ordered.length - unmatched,
    unmatchedPicks: unmatched,
  };
}

/**
 * A curve, because a draft is a competition: someone in every room drafted best
 * and someone drafted worst. Top ~17% A, next ~25% B, middle C, and so on, so a
 * twelve-team league lands roughly 2/3/4/2/1.
 */
export function letterFor(index: number, total: number): DraftLetter {
  if (total <= 0) return 'C';
  if (total === 1) return 'C';
  // Normalised by total - 1 so the last team sits at exactly 1.0. Dividing by
  // total instead puts the worst of twelve at 0.917 and makes F unreachable,
  // which quietly turns the bottom grade into a decoration.
  const pct = index / (total - 1);
  if (pct < 0.17) return 'A';
  if (pct < 0.42) return 'B';
  if (pct < 0.75) return 'C';
  if (pct < 0.92) return 'D';
  return 'F';
}

export const GRADE_COLOR: Record<DraftLetter, string> = {
  A: '#15803d', B: '#4d7c0f', C: '#a16207', D: '#c2410c', F: '#b91c1c',
};
