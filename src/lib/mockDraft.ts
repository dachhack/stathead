/**
 * Mock Draft engine — CPU opponents for the Draft Kit's practice room.
 *
 * Every CPU team gets a profile: a draft STYLE (how it orders the board)
 * and a GOAL (a positional plan that tilts that order). Scoring happens
 * in RANK SPACE — the style produces a base ordering, then goal tilts,
 * roster-need nudges, and Gaussian noise move players up and down in
 * units of picks (the same `numTeams * 1.5` idiom the plan sim uses).
 * The candidate with the lowest effective rank is the pick.
 *
 * Standard drafting behavior applies to every profile:
 *   - starters first: players who'd ride the bench get pushed down;
 *   - position caps: nobody drafts a fifth QB or an eighth WR;
 *   - forced fills: when remaining picks ≤ open starting slots, only
 *     players who fill a starting slot are considered.
 *
 * The user's seat picks "by plan": the selected My Rankings board when
 * one exists (starters-first nudge, same as the plan sim's board
 * strategy), else urgency-weighted VBD (the plan sim's value strategy).
 * Used both for full-simulation mode and as the autopick when the
 * user's pick timer expires.
 */

import type { DraftPrepSettings, DraftType, Position } from './draftPrepSettings';
import type { OpenSlots, ValuedPlayer } from './draftKit';
import { KIT_POSITIONS, SEASON_GAMES, assignSlot, kitKey, openSlots, starterSlotOpen } from './draftKit';
import { survivalAtPick, userPickNumbers } from './snakeDraft';

// ── Profiles ──

export type DraftStyle = 'chalk' | 'value' | 'needs' | 'wildcard';
export type TeamGoal =
  | 'balanced' | 'bpa' | 'zero-rb' | 'hero-rb' | 'rb-heavy'
  | 'wr-heavy' | 'early-qb' | 'late-qb' | 'te-premium';

export interface OpponentProfile {
  style: DraftStyle;
  goal: TeamGoal;
}

export const STYLE_INFO: Record<DraftStyle, { label: string; blurb: string; sigma: number }> = {
  chalk:    { label: 'ADP',       blurb: 'Drafts close to market ADP with a small wobble.', sigma: 4 },
  value:    { label: 'Value',     blurb: 'Drafts the best VBD value on the board.', sigma: 4 },
  needs:    { label: 'Needs',     blurb: 'Fills open starting slots aggressively.', sigma: 5 },
  wildcard: { label: 'Wildcard',  blurb: 'Unpredictable — big reaches and big falls.', sigma: 18 },
};

export const GOAL_INFO: Record<TeamGoal, { label: string; blurb: string }> = {
  balanced:    { label: 'Balanced',   blurb: 'No positional agenda — fills starters sensibly.' },
  bpa:         { label: 'Pure BPA',   blurb: 'Best player available; mostly ignores roster needs.' },
  'zero-rb':   { label: 'Zero RB',    blurb: 'WR/TE early, won’t touch RB the first five rounds.' },
  'hero-rb':   { label: 'Hero RB',    blurb: 'One early anchor RB, then avoids the position.' },
  'rb-heavy':  { label: 'RB heavy',   blurb: 'Hammers RBs through the early-middle rounds.' },
  'wr-heavy':  { label: 'WR heavy',   blurb: 'Hammers WRs through the early-middle rounds.' },
  'early-qb':  { label: 'Early QB',   blurb: 'Grabs a QB inside the first five rounds.' },
  'late-qb':   { label: 'Late QB',    blurb: 'Won’t draft a QB before the late-middle rounds.' },
  'te-premium': { label: 'TE premium', blurb: 'Pays up for an elite TE early.' },
};

export const STYLE_OPTIONS = Object.keys(STYLE_INFO) as DraftStyle[];
export const GOAL_OPTIONS = Object.keys(GOAL_INFO) as TeamGoal[];

/** Random room composition — chalk/balanced is the most common drafter,
 *  with a sprinkle of every archetype so the room feels like a real mock. */
export function randomOpponents(count: number, rng: () => number = Math.random): OpponentProfile[] {
  const pickWeighted = <T extends string>(weights: Array<[T, number]>): T => {
    const total = weights.reduce((s, [, w]) => s + w, 0);
    let r = rng() * total;
    for (const [v, w] of weights) { r -= w; if (r <= 0) return v; }
    return weights[weights.length - 1][0];
  };
  const out: OpponentProfile[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      style: pickWeighted<DraftStyle>([['chalk', 45], ['value', 20], ['needs', 20], ['wildcard', 15]]),
      goal: pickWeighted<TeamGoal>([
        ['balanced', 30], ['bpa', 10], ['zero-rb', 8], ['hero-rb', 8], ['rb-heavy', 10],
        ['wr-heavy', 10], ['early-qb', 8], ['late-qb', 8], ['te-premium', 8],
      ]),
    });
  }
  return out;
}

// ── Teams ──

export interface MockTeam {
  /** 1-based draft slot. */
  slot: number;
  name: string;
  isUser: boolean;
  /** null for the user's seat. */
  profile: OpponentProfile | null;
  players: ValuedPlayer[];
  open: OpenSlots;
  posCounts: Record<Position, number>;
}

export function makeTeams(settings: DraftPrepSettings, opponents: OpponentProfile[]): MockTeam[] {
  const teams: MockTeam[] = [];
  let oppIdx = 0;
  for (let slot = 1; slot <= settings.numTeams; slot++) {
    const isUser = slot === settings.pickSlot;
    teams.push({
      slot,
      name: isUser ? 'You' : `Team ${slot}`,
      isUser,
      profile: isUser ? null : opponents[oppIdx++] ?? { style: 'chalk', goal: 'balanced' },
      players: [],
      open: openSlots(settings),
      posCounts: { QB: 0, RB: 0, WR: 0, TE: 0 },
    });
  }
  return teams;
}

/** Record a pick on a team; returns the roster slot label (QB/FLEX/BN/…). */
export function applyPick(team: MockTeam, player: ValuedPlayer): string {
  team.players.push(player);
  team.posCounts[player.position]++;
  return assignSlot(team.open, player.position);
}

// ── Pick order math ──

/** Draft slot (1-based seat) on the clock for an overall pick number. */
export function slotForOverall(overall: number, numTeams: number, draftType: DraftType): number {
  const round = Math.ceil(overall / numTeams);
  const idx = overall - (round - 1) * numTeams; // 1..N within the round
  if (draftType === 'linear' || round % 2 === 1) return idx;
  return numTeams - idx + 1;
}

// ── Randomness ──

/** Standard normal via Box-Muller. */
function gaussian(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng(); // avoid log(0)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** CPU pick delay: 1–7s, normally distributed around 4s (σ 1.25s). */
export function sampleCpuDelayMs(rng: () => number = Math.random): number {
  const v = 4000 + gaussian(rng) * 1250;
  return Math.round(Math.min(7000, Math.max(1000, v)));
}

// ── Standard drafting behavior (shared by CPU + user autopick) ──

/** Max players a team will roster at a position. Generous enough that a
 *  full draft always completes, tight enough that nobody hoards. */
export function positionCap(pos: Position, settings: DraftPrepSettings, goal: TeamGoal): number {
  const r = settings.roster;
  if (pos === 'QB') return r.SF > 0 ? Math.max(3, r.QB + r.SF + 1) : r.QB + 1;
  if (pos === 'TE') return Math.max(2, r.TE + (goal === 'te-premium' ? 2 : 1));
  return Math.max(2, r[pos] + r.FLEX + r.SF + 4);
}

function countOpenStarters(open: OpenSlots): number {
  return open.QB + open.RB + open.WR + open.TE + open.FLEX + open.SF;
}

/** Apply caps + endgame forced fills. Falls back to the raw list rather
 *  than ever returning empty (a draft must always complete). */
function constrainCandidates(
  available: ValuedPlayer[],
  team: MockTeam,
  settings: DraftPrepSettings,
  totalRounds: number,
  goal: TeamGoal,
): ValuedPlayer[] {
  let cands = available.filter((p) => team.posCounts[p.position] < positionCap(p.position, settings, goal));
  if (cands.length === 0) cands = available;
  const remaining = totalRounds - team.players.length;
  if (remaining <= countOpenStarters(team.open)) {
    const must = cands.filter((p) => starterSlotOpen(team.open, p.position));
    if (must.length > 0) cands = must;
  }
  return cands;
}

// ── CPU pick logic ──

export interface PickContext {
  round: number;
  /** Overall pick number on the clock. */
  overall: number;
  totalRounds: number;
  settings: DraftPrepSettings;
  rng?: () => number;
}

/** Goal tilt in rank space (units of picks). Negative = boosted. */
function goalRankDelta(
  goal: TeamGoal,
  pos: Position,
  round: number,
  team: MockTeam,
  N: number,
  totalRounds: number,
): number {
  switch (goal) {
    case 'balanced':
    case 'bpa':
      return 0;
    case 'zero-rb':
      if (round <= 5) {
        if (pos === 'RB') return 2.5 * N;
        if (pos === 'WR') return -0.3 * N;
      }
      return 0;
    case 'hero-rb':
      if (pos === 'RB') {
        if (team.posCounts.RB === 0 && round <= 2) return -0.8 * N;
        if (team.posCounts.RB >= 1 && round <= 6) return 2 * N;
      }
      return 0;
    case 'rb-heavy':
      if (round <= 8) {
        if (pos === 'RB') return -0.6 * N;
        if (pos === 'WR') return 0.3 * N;
      }
      return 0;
    case 'wr-heavy':
      if (round <= 8) {
        if (pos === 'WR') return -0.6 * N;
        if (pos === 'RB') return 0.3 * N;
      }
      return 0;
    case 'early-qb':
      if (pos === 'QB' && round <= 5 && starterSlotOpen(team.open, 'QB')) return -1.2 * N;
      return 0;
    case 'late-qb':
      if (pos === 'QB' && round <= Math.min(9, totalRounds - 2)) return 2.5 * N;
      return 0;
    case 'te-premium':
      if (pos === 'TE' && round <= 6 && starterSlotOpen(team.open, 'TE')) return -1.0 * N;
      return 0;
  }
}

/**
 * Pick for a CPU team: order the constrained candidates by the style's
 * base metric (ADP for chalk/needs/wildcard, VBD for value), then add
 * Gaussian noise, the goal tilt, and roster-need nudges in rank space.
 */
export function chooseCpuPick(available: ValuedPlayer[], team: MockTeam, ctx: PickContext): ValuedPlayer | null {
  const { settings, round, totalRounds } = ctx;
  const rng = ctx.rng ?? Math.random;
  const N = settings.numTeams;
  const profile = team.profile ?? { style: 'chalk' as DraftStyle, goal: 'balanced' as TeamGoal };
  const cands = constrainCandidates(available, team, settings, totalRounds, profile.goal);
  if (cands.length === 0) return null;

  const ordered = [...cands];
  if (profile.style === 'value') ordered.sort((a, b) => b.vbd - a.vbd);
  else ordered.sort((a, b) => (a.adp - b.adp) || (b.vbd - a.vbd));

  const sigma = STYLE_INFO[profile.style].sigma;
  let best: ValuedPlayer | null = null;
  let bestScore = Infinity;
  ordered.forEach((p, i) => {
    // ADP volatility grows with draft depth (FFC stdev does too) — keep
    // the top of the board chalky and let the middle rounds wobble.
    const depthScale = 0.4 + 0.6 * Math.min(1, i / (2 * N));
    let score = i + gaussian(rng) * sigma * depthScale;
    score += goalRankDelta(profile.goal, p.position, round, team, N, totalRounds);
    if (!starterSlotOpen(team.open, p.position)) {
      // Bench-filler pushdown — needs-first teams barely consider them,
      // pure-BPA teams barely care.
      score += profile.style === 'needs' ? 3 * N : profile.goal === 'bpa' ? 0.75 * N : 1.5 * N;
    } else if (profile.style === 'needs' && team.open[p.position] > 0) {
      // Needs drafters also lean toward open DEDICATED slots.
      score -= 0.4 * N;
    }
    if (score < bestScore) { bestScore = score; best = p; }
  });
  return best;
}

// ── User plan pick (simulation mode + timer autopick) ──

/**
 * The user's candidates ranked by their plan: saved-board order when a
 * board is selected (starters-first nudge, unranked → VBD), else
 * urgency-weighted VBD against the user's NEXT pick — exactly the plan
 * sim's strategies, applied to live availability. Index 0 is the pick.
 */
export function rankPlanCandidates(
  available: ValuedPlayer[],
  team: MockTeam,
  ctx: PickContext,
  myRankByKey?: Map<string, number>,
): ValuedPlayer[] {
  const { settings, overall, totalRounds } = ctx;
  const N = settings.numTeams;
  const cands = constrainCandidates(available, team, settings, totalRounds, 'balanced');
  if (cands.length === 0) return [];

  if (myRankByKey && myRankByKey.size > 0) {
    const score = (p: ValuedPlayer): number => {
      const rank = myRankByKey.get(kitKey(p.name, p.position));
      const base = rank !== undefined ? rank : 100_000 - Math.max(p.vbd, -999);
      return base + (starterSlotOpen(team.open, p.position) ? 0 : 1.5 * N);
    };
    return [...cands].sort((a, b) => score(a) - score(b));
  }

  const myPicks = userPickNumbers(totalRounds, team.slot, N, settings.draftType);
  const nextPick = myPicks.find((n) => n > overall) ?? null;
  const score = (p: ValuedPlayer): number => {
    const survNext = nextPick === null
      ? 0
      : p.adp >= 999 ? 1 : survivalAtPick(Math.max(p.adp, overall), p.stdev || undefined, nextPick);
    return p.vbd * (1 - 0.9 * survNext) * (starterSlotOpen(team.open, p.position) ? 1 : 0.45);
  };
  return [...cands].sort((a, b) => score(b) - score(a));
}

export function choosePlanPick(
  available: ValuedPlayer[],
  team: MockTeam,
  ctx: PickContext,
  myRankByKey?: Map<string, number>,
): ValuedPlayer | null {
  return rankPlanCandidates(available, team, ctx, myRankByKey)[0] ?? null;
}

// ── Results ──

/** Projected season points of the best legal starting lineup of a roster. */
export function lineupPoints(roster: ValuedPlayer[], settings: DraftPrepSettings): number {
  const byPos: Record<Position, number[]> = { QB: [], RB: [], WR: [], TE: [] };
  for (const p of roster) byPos[p.position].push(p.ppg);
  for (const pos of KIT_POSITIONS) byPos[pos].sort((a, b) => b - a);
  const idx: Record<Position, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
  let pts = 0;
  for (const pos of KIT_POSITIONS) {
    for (let i = 0; i < settings.roster[pos]; i++) {
      const v = byPos[pos][idx[pos]];
      if (v !== undefined) { pts += v; idx[pos]++; }
    }
  }
  const flexFill = (eligible: Position[]) => {
    let bestPos: Position | null = null;
    let best = -Infinity;
    for (const pos of eligible) {
      const v = byPos[pos][idx[pos]];
      if (v !== undefined && v > best) { best = v; bestPos = pos; }
    }
    if (bestPos) { pts += best; idx[bestPos]++; }
  };
  for (let i = 0; i < settings.roster.FLEX; i++) flexFill(['RB', 'WR', 'TE']);
  for (let i = 0; i < settings.roster.SF; i++) flexFill(['QB', 'RB', 'WR', 'TE']);
  return pts * SEASON_GAMES;
}
