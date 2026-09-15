/**
 * Trade Finisher — take a real Sleeper league, one trade partner and the offer
 * on the table, work out what each roster actually needs, and search the
 * nearby offers (add a piece, drop a piece, swap a piece, on either side) for
 * versions that are about fair AND move both teams toward their goals.
 *
 * Pure logic: no fetching, no React. Assets are priced on the dynasty board
 * in the league's format (superflex / 1QB, TE premium applied) and lineups on
 * projected season points in the league's scoring, so "fair" and "helps my
 * lineup" are measured in the same currency the rest of the app uses.
 */

import type { LeagueTeam, SleeperTradedPick } from './sleeper';
import type { DynastyPlayer } from '../types';
import { normalizeForMatch } from './nameMatch';
import { buildPickOwnership, type DraftPick, type TradeGoal } from './tradeEngine';
import { TEP_MULTIPLIERS, type TepLevel } from './dynastyForecast';

export type { TradeGoal };

export const GOAL_LABEL: Record<TradeGoal, string> = { 'win-now': 'Win now', balanced: 'Balanced', rebuild: 'Rebuild' };

export const SKILL_POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const;
export type SkillPos = (typeof SKILL_POSITIONS)[number];
const isSkillPos = (p: string): p is SkillPos => (SKILL_POSITIONS as readonly string[]).includes(p);

// Sleeper lineup slots the finisher scores. Kickers, defenses, IDP, bench,
// IR and taxi are ignored: the trade currency here is the skill lineup.
const SLOT_ELIGIBLE: Record<string, readonly SkillPos[]> = {
  QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'],
  FLEX: ['RB', 'WR', 'TE'], REC_FLEX: ['WR', 'TE'], WRRB_FLEX: ['RB', 'WR'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
};
// Fill order: fixed slots, then the narrow flexes, then FLEX, then superflex,
// so a QB2 lands in SUPER_FLEX rather than blocking a fixed slot.
const SLOT_ORDER = ['QB', 'RB', 'WR', 'TE', 'REC_FLEX', 'WRRB_FLEX', 'FLEX', 'SUPER_FLEX'];

export function lineupSlots(rosterPositions: string[]): string[] {
  return rosterPositions.filter((s) => s in SLOT_ELIGIBLE);
}

export function isSuperflexLeague(rosterPositions: string[]): boolean {
  return rosterPositions.includes('SUPER_FLEX') || rosterPositions.filter((p) => p === 'QB').length >= 2;
}

/** Sleeper's TE reception bonus → the app's TE-premium tier. */
export function tepLevelFromScoring(scoring: Record<string, number> | undefined | null): TepLevel {
  const b = scoring?.bonus_rec_te ?? 0;
  return b >= 1.5 ? 3 : b >= 1 ? 2 : b >= 0.5 ? 1 : 0;
}

/** Rookie-pick seasons still on rosters. Rookie drafts run April–May, so from
 *  June the current season's picks are spent and the next two seasons trade. */
export function tradablePickSeasons(today = new Date()): string[] {
  const y = today.getFullYear();
  const first = today.getMonth() < 5 ? y : y + 1;
  return [String(first), String(first + 1)];
}

// ── Assets ────────────────────────────────────────────────────────────────

export interface FinisherAsset {
  /** `p:<sleeperId>` for players, `k:<season>-<round>-<originalRosterId>` for picks. */
  id: string;
  type: 'player' | 'pick';
  name: string;
  position: SkillPos | 'PICK';
  team?: string;
  age?: number;
  /** Dynasty value in the league's format (TE premium applied). */
  value: number;
  /** Projected season points in the league's scoring (0 for picks). */
  projPts: number;
  /** Where the board is heading: forecast dynasty value LATER_DAYS out (same scale as `value`); absent without a forecast. */
  valueLater?: number;
  sleeperId?: string;
  pick?: DraftPick;
  /** The dynasty board row behind the value, so the calculator can load it. */
  ktcId?: number;
}

export interface FinisherTeam {
  rosterId: number;
  teamName: string;
  owner: string;
  ownerId: string | null;
  wins: number;
  losses: number;
  assets: FinisherAsset[];
}

export interface BuildOptions {
  dynasty: DynastyPlayer[];
  isSuperflex: boolean;
  tepLevel: TepLevel;
  rosterPositions: string[];
  /** Projected season points by Sleeper id, with a name-keyed fallback. */
  projBySleeperId: Map<string, number>;
  projByName?: Map<string, number>;
  tradedPicks: SleeperTradedPick[];
  seasons?: string[];
  /** Forecast log-return per dynasty board id at LATER_DAYS (from the forecast cache); scale-free so TE premium carries through. */
  laterLogReturnByKtcId?: Map<number, number>;
}

/** The forecast horizon the reads call "later": the longest one the dynasty forecast models ship. */
export const LATER_DAYS = 120;

const ROUND_WORD = (r: number) => (r === 1 ? '1st' : r === 2 ? '2nd' : r === 3 ? '3rd' : `${r}th`);

export function pickTier(slot: number | undefined, totalTeams: number): 'Early' | 'Mid' | 'Late' {
  if (slot == null || totalTeams <= 0) return 'Mid';
  const third = totalTeams / 3;
  return slot <= third ? 'Early' : slot <= 2 * third ? 'Mid' : 'Late';
}

/** The dynasty board's generic pick row for a league pick ("2027 Mid 1st"). */
export function pickBoardEntry(dynasty: DynastyPlayer[], pick: DraftPick, totalTeams: number): DynastyPlayer | undefined {
  const name = `${pick.season} ${pickTier(pick.projectedSlot, totalTeams)} ${ROUND_WORD(pick.round)}`;
  return dynasty.find((d) => d.position === 'RDP' && d.playerName === name);
}

export function dynastyValueFor(k: DynastyPlayer, isSuperflex: boolean, tepLevel: TepLevel): number {
  const base = isSuperflex ? k.superflexValue : k.value;
  return k.position === 'TE' && tepLevel > 0 ? Math.round(base * TEP_MULTIPLIERS[tepLevel]) : base;
}

export function buildFinisherTeams(teams: LeagueTeam[], opts: BuildOptions): FinisherTeam[] {
  const { dynasty, isSuperflex, tepLevel, rosterPositions, projBySleeperId, projByName, tradedPicks } = opts;
  const seasons = opts.seasons ?? tradablePickSeasons();
  const dynastyByName = new Map<string, DynastyPlayer>();
  for (const k of dynasty) if (k.position !== 'RDP') dynastyByName.set(normalizeForMatch(k.playerName), k);

  const out: FinisherTeam[] = teams.map((t) => {
    const assets: FinisherAsset[] = [];
    for (const p of [...t.starters, ...t.bench]) {
      if (!p.id || p.name === 'Empty' || !isSkillPos(p.position)) continue;
      const k = dynastyByName.get(normalizeForMatch(p.name));
      const value = k ? dynastyValueFor(k, isSuperflex, tepLevel) : 0;
      const projPts = projBySleeperId.get(p.id) ?? projByName?.get(normalizeForMatch(p.name)) ?? 0;
      const lr = k ? opts.laterLogReturnByKtcId?.get(k.playerID) : undefined;
      assets.push({
        id: `p:${p.id}`, type: 'player', name: p.name, position: p.position, team: p.team || k?.team,
        age: k?.age && k.age > 0 ? k.age : undefined, value, projPts, sleeperId: p.id, ktcId: k?.playerID,
        valueLater: lr != null && value > 0 ? Math.round(value * Math.exp(lr)) : undefined,
      });
    }
    return { rosterId: t.rosterId, teamName: t.teamName, owner: t.owner, ownerId: t.ownerId, wins: t.wins, losses: t.losses, assets };
  });

  // Picks: slotted by each ORIGINAL owner's projected lineup (weakest picks
  // first) and priced on the board's Early/Mid/Late row for that round.
  const projPointsByRosterId = new Map<number, number>();
  for (const t of out) projPointsByRosterId.set(t.rosterId, optimalLineup(t.assets, rosterPositions).total);
  const nameByRoster = new Map(out.map((t) => [t.rosterId, t.teamName]));
  for (const season of seasons) {
    const owned = buildPickOwnership(teams, tradedPicks, season, projPointsByRosterId);
    for (const t of out) {
      for (const pick of owned.get(t.rosterId) ?? []) {
        const row = pickBoardEntry(dynasty, pick, teams.length);
        const value = row ? (isSuperflex ? row.superflexValue : row.value) : (pick.value ?? 0);
        const via = pick.originalOwnerId !== t.rosterId ? ` (via ${nameByRoster.get(pick.originalOwnerId) ?? 'trade'})` : '';
        const slot = pick.projectedSlot != null ? ` ~${pick.round}.${String(pick.projectedSlot).padStart(2, '0')}` : '';
        t.assets.push({
          id: `k:${season}-${pick.round}-${pick.originalOwnerId}`, type: 'pick',
          name: `${season} ${ROUND_WORD(pick.round)}${via}${slot}`, position: 'PICK',
          value, projPts: 0, pick, ktcId: row?.playerID,
        });
      }
    }
  }
  for (const t of out) t.assets.sort((a, b) => b.value - a.value || b.projPts - a.projPts);
  return out;
}

// ── Lineups & needs ───────────────────────────────────────────────────────

export interface LineupSlot { slot: string; asset: FinisherAsset | null; pts: number }
export interface Lineup { slots: LineupSlot[]; total: number }

/** Best lineup by projected points over the league's skill slots. */
export function optimalLineup(players: FinisherAsset[], rosterPositions: string[]): Lineup {
  const slots = lineupSlots(rosterPositions);
  const sorted = players.filter((p) => p.type === 'player').sort((a, b) => b.projPts - a.projPts);
  const used = new Set<string>();
  const out: LineupSlot[] = [];
  for (const kind of SLOT_ORDER) {
    for (const slot of slots) {
      if (slot !== kind) continue;
      const eligible = SLOT_ELIGIBLE[slot];
      const best = sorted.find((p) => !used.has(p.id) && eligible.includes(p.position as SkillPos));
      if (best) used.add(best.id);
      out.push({ slot, asset: best ?? null, pts: best?.projPts ?? 0 });
    }
  }
  return { slots: out, total: out.reduce((s, x) => s + x.pts, 0) };
}

export interface PositionNeed {
  pos: SkillPos;
  /** Fixed slots at this position in the league lineup. */
  fixedSlots: number;
  /** Projected points this position contributes to the optimal lineup. */
  pts: number;
  /** League median of the same measure. */
  median: number;
  ratio: number;
  /** Bench players at the position with a projection (trade surplus). */
  depth: number;
  status: 'weak' | 'ok' | 'strong';
}

export interface TeamNeeds {
  lineup: Lineup;
  positions: PositionNeed[];
  weak: SkillPos[];
  strong: SkillPos[];
  starterAvgAge: number;
  totalValue: number;
  pickValue: number;
  youngPct: number;
  agingPct: number;
  inferredGoal: TradeGoal;
  goalReason: string;
}

function positionPoints(lineup: Lineup): Record<SkillPos, number> {
  const pts: Record<SkillPos, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const s of lineup.slots) if (s.asset) pts[s.asset.position as SkillPos] += s.pts;
  return pts;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export const WEAK_RATIO = 0.85;
export const STRONG_RATIO = 1.15;

export function computeNeeds(team: FinisherTeam, league: FinisherTeam[], rosterPositions: string[]): TeamNeeds {
  const lineup = optimalLineup(team.assets, rosterPositions);
  const mine = positionPoints(lineup);
  const leaguePts = league.map((t) => positionPoints(optimalLineup(t.assets, rosterPositions)));
  const slots = lineupSlots(rosterPositions);
  const started = new Set(lineup.slots.map((s) => s.asset?.id).filter(Boolean));

  const positions: PositionNeed[] = SKILL_POSITIONS.map((pos) => {
    const med = median(leaguePts.map((p) => p[pos]));
    const ratio = med > 0 ? mine[pos] / med : 1;
    const depth = team.assets.filter((a) => a.type === 'player' && a.position === pos && a.projPts > 0 && !started.has(a.id)).length;
    const status: PositionNeed['status'] = med > 0 && ratio < WEAK_RATIO ? 'weak' : ratio > STRONG_RATIO && depth >= 1 ? 'strong' : 'ok';
    return { pos, fixedSlots: slots.filter((s) => s === pos).length, pts: mine[pos], median: med, ratio, depth, status };
  });

  // Age / value profile of the roster (players only) for the goal read.
  let total = 0, young = 0, aging = 0, ageSum = 0, ageN = 0;
  for (const a of team.assets) {
    if (a.type !== 'player' || a.value <= 0) continue;
    total += a.value;
    if (a.age != null) {
      if (a.age <= 24) young += a.value;
      else if (a.age >= 28) aging += a.value;
    }
  }
  for (const s of lineup.slots) if (s.asset?.age != null) { ageSum += s.asset.age; ageN++; }
  const pickValue = team.assets.filter((a) => a.type === 'pick').reduce((s, a) => s + a.value, 0);
  const youngPct = total ? (young / total) * 100 : 0;
  const agingPct = total ? (aging / total) * 100 : 0;

  // Goal read: who the roster is built for, nudged by the standings once a few
  // games are in. Positive leans win-now, negative leans rebuild.
  const games = team.wins + team.losses;
  const winPct = games ? team.wins / games : 0.5;
  const recordAdj = games >= 3 ? (winPct - 0.5) * 60 : 0;
  const lean = agingPct - youngPct + recordAdj;
  const inferredGoal: TradeGoal = lean >= 12 ? 'win-now' : lean <= -12 ? 'rebuild' : 'balanced';
  const goalReason = `${agingPct.toFixed(0)}% of value is 28+, ${youngPct.toFixed(0)}% is 24-and-under` +
    (games >= 3 ? `, ${team.wins}-${team.losses}` : '');

  return {
    lineup, positions,
    weak: positions.filter((p) => p.status === 'weak').map((p) => p.pos),
    strong: positions.filter((p) => p.status === 'strong').map((p) => p.pos),
    starterAvgAge: ageN ? ageSum / ageN : 0,
    totalValue: total, pickValue, youngPct, agingPct, inferredGoal, goalReason,
  };
}

// ── Offers ────────────────────────────────────────────────────────────────

export interface Offer { give: FinisherAsset[]; get: FinisherAsset[] }

export type Verdict = 'fair' | 'slight' | 'uneven' | 'lopsided';

export interface OfferEval {
  giveValue: number;
  getValue: number;
  /** Value you receive minus value you send; positive = you win the value. */
  diff: number;
  /** |diff| as a % of the average side. */
  fairnessPct: number;
  verdict: Verdict;
  legal: boolean;
  illegalReason?: string;
  myLineupBefore: number;
  myLineupAfter: number;
  myLineupDelta: number;
  partnerLineupDelta: number;
  /** Average age of players you receive minus players you send (null when a side has no players). */
  ageDelta: number | null;
  /** Roster spots: positive means you take on more players than you send. */
  netPlayers: number;
  myFit: number;
  partnerFit: number;
  needsFit: number;
  score: number;
  tags: string[];
  /** Each side's read of the deal against its own goal and roster: now (weekly lineup points), later (dynasty value, forecast, age), and the role of every piece. */
  myRead: SideRead;
  partnerRead: SideRead;
}

// ── Roster roles and the per-side read ────────────────────────────────────

export type RosterRole = 'starter' | 'backup' | 'surplus' | 'pick';

export interface AssetRole {
  asset: FinisherAsset;
  /** Weekly starter (with the slot), next man up at the position, or surplus depth that does not play. */
  role: RosterRole;
  slot?: string;
  /** Depth chart label on that roster: WR1, QB4… (picks: the round). */
  depthLabel: string;
  /** Points per week the piece adds to that roster's best lineup over the next man up (0 when it does not start). */
  weeklyPts: number;
}

export type FitVerdict = 'great' | 'good' | 'even' | 'poor' | 'bad';

export const FIT_LABEL: Record<FitVerdict, string> = { great: 'Great', good: 'Good', even: 'A wash', poor: 'Poor', bad: 'Bad' };

export interface SideRead {
  goal: TradeGoal;
  /** Best-lineup change in projected points per week. */
  weeklyPts: number;
  /** Dynasty value received minus sent (the long-term currency). */
  valueNow: number;
  /** The same at the forecast horizon; null when no piece has a forecast. */
  valueLater: number | null;
  /** Average age received minus sent (null when a side has no players). */
  ageDelta: number | null;
  /** What this side sends, read on its roster before the trade. */
  out: AssetRole[];
  /** What this side receives, read on its roster after the trade. */
  in: AssetRole[];
  /** Goal-weighted fit in [-1, 1] and the word for it. */
  fit: number;
  verdict: FitVerdict;
}

export const WEEKS = 17;

const posRank = (asset: FinisherAsset, roster: FinisherAsset[]): number =>
  roster.filter((a) => a.type === 'player' && a.position === asset.position && (a.projPts > asset.projPts || (a.projPts === asset.projPts && a.id < asset.id))).length + 1;

/** Where one piece sits on a roster: the slot it starts in and what it adds
 *  over the next man up, or how deep on the bench it is. A "surplus" piece is
 *  behind every starter at its position and the first backup — your fourth
 *  QB in a superflex league, your fifth WR — and never sees the lineup. */
export function rosterRole(asset: FinisherAsset, roster: FinisherAsset[], rosterPositions: string[]): AssetRole {
  if (asset.type === 'pick') return { asset, role: 'pick', depthLabel: asset.pick ? `${asset.pick.season} ${ROUND_WORD(asset.pick.round)}` : 'pick', weeklyPts: 0 };
  const lineup = optimalLineup(roster, rosterPositions);
  const mine = lineup.slots.find((s) => s.asset?.id === asset.id);
  const rank = posRank(asset, roster);
  const depthLabel = `${asset.position}${rank}`;
  if (mine) {
    const without = optimalLineup(roster.filter((a) => a.id !== asset.id), rosterPositions);
    return { asset, role: 'starter', slot: mine.slot, depthLabel, weeklyPts: (lineup.total - without.total) / WEEKS };
  }
  const startersAtPos = lineup.slots.filter((s) => s.asset?.position === asset.position).length;
  return { asset, role: rank <= startersAtPos + 1 ? 'backup' : 'surplus', depthLabel, weeklyPts: 0 };
}

export function fitVerdict(fit: number): FitVerdict {
  return fit >= 0.45 ? 'great' : fit >= 0.15 ? 'good' : fit > -0.15 ? 'even' : fit > -0.45 ? 'poor' : 'bad';
}

const SLOT_WORD: Record<string, string> = { FLEX: 'the flex', REC_FLEX: 'the flex', WRRB_FLEX: 'the flex', SUPER_FLEX: 'the superflex' };
const slotWord = (r: AssetRole) => (r.slot && SLOT_WORD[r.slot]) || r.asset.position;
const pts1 = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}`;

/** The read in words, for one side. `you` is 'You' for the reader's own
 *  seat, else the team name; every line is a full clause. */
export function readLines(read: SideRead, you = 'You', horizonDays = LATER_DAYS): string[] {
  const your = you === 'You' ? 'your' : `${you}'s`;
  const are = you === 'You' ? 'are' : 'is';
  const lines: string[] = [];
  const starters = read.in.filter((r) => r.role === 'starter');
  const benchIn = read.in.filter((r) => r.role === 'backup' || r.role === 'surplus');
  const surplusOut = read.out.filter((r) => r.role === 'surplus');
  const backupOut = read.out.filter((r) => r.role === 'backup');
  const startersOut = read.out.filter((r) => r.role === 'starter');
  for (const r of starters) lines.push(`${r.asset.name} starts at ${slotWord(r)} for ${you === 'You' ? 'you' : you} (${pts1(r.weeklyPts)} pts/wk over the next man up)`);
  for (const r of startersOut) lines.push(`${r.asset.name} was ${your} ${r.depthLabel}, starting at ${slotWord(r)} (${pts1(-r.weeklyPts)} pts/wk)`);
  if (surplusOut.length) lines.push(`${surplusOut.map((r) => `${r.asset.name} (${r.depthLabel})`).join(', ')} ${surplusOut.length === 1 ? 'was' : 'were'} surplus depth that never started`);
  if (backupOut.length) lines.push(`${backupOut.map((r) => `${r.asset.name} (${r.depthLabel})`).join(', ')} ${backupOut.length === 1 ? 'was' : 'were'} ${your} next man up`);
  if (benchIn.length) lines.push(`${benchIn.map((r) => `${r.asset.name}`).join(', ')} ${benchIn.length === 1 ? 'lands' : 'land'} on ${your} bench (${benchIn.map((r) => r.depthLabel).join(', ')})`);
  const picksIn = read.in.filter((r) => r.role === 'pick'), picksOut = read.out.filter((r) => r.role === 'pick');
  if (picksIn.length) lines.push(`${you} add${you === 'You' ? '' : 's'} ${picksIn.map((r) => r.depthLabel).join(', ')}`);
  if (picksOut.length) lines.push(`${you} send${you === 'You' ? '' : 's'} ${picksOut.map((r) => r.depthLabel).join(', ')}`);
  const now = `Now: lineup ${pts1(read.weeklyPts)} pts/wk`;
  const laterBits = [`value ${read.valueNow >= 0 ? '+' : '−'}${Math.abs(Math.round(read.valueNow)).toLocaleString()}`];
  if (read.valueLater != null && Math.round(read.valueLater) !== Math.round(read.valueNow)) laterBits.push(`${read.valueLater >= 0 ? '+' : '−'}${Math.abs(Math.round(read.valueLater)).toLocaleString()} on the ${horizonDays}-day forecast`);
  if (read.ageDelta != null && Math.abs(read.ageDelta) >= 1) laterBits.push(`${Math.abs(read.ageDelta).toFixed(1)} yrs ${read.ageDelta < 0 ? 'younger' : 'older'}`);
  lines.push(`${now} · Later: ${laterBits.join(', ')}`);
  lines.push(`${you} ${are} ${GOAL_LABEL[read.goal].toLowerCase()}: ${FIT_LABEL[read.verdict].toLowerCase()} for ${you === 'You' ? 'you' : you}`);
  return lines;
}

export interface EvalContext {
  rosterPositions: string[];
  myGoal: TradeGoal;
  partnerGoal: TradeGoal;
  myNeeds: TeamNeeds;
  partnerNeeds: TeamNeeds;
  /** Max |diff| as % of the average side that still counts as "about fair". */
  tolerancePct?: number;
}

export const DEFAULT_TOLERANCE_PCT = 12;

export function verdictFor(fairnessPct: number): Verdict {
  return fairnessPct <= 6 ? 'fair' : fairnessPct <= DEFAULT_TOLERANCE_PCT ? 'slight' : fairnessPct <= 25 ? 'uneven' : 'lopsided';
}

const clip = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const sum = (xs: FinisherAsset[]) => xs.reduce((s, a) => s + a.value, 0);
const avgAge = (xs: FinisherAsset[]): number | null => {
  const ages = xs.filter((a) => a.type === 'player' && a.age != null).map((a) => a.age as number);
  return ages.length ? ages.reduce((s, a) => s + a, 0) / ages.length : null;
};

function applyTrade(roster: FinisherAsset[], out: FinisherAsset[], inn: FinisherAsset[]): FinisherAsset[] {
  const gone = new Set(out.map((a) => a.id));
  return [...roster.filter((a) => !gone.has(a.id)), ...inn];
}

/** Every fixed lineup slot must still be fillable after the trade. */
function lineupHole(roster: FinisherAsset[], rosterPositions: string[]): SkillPos | null {
  const slots = lineupSlots(rosterPositions);
  for (const pos of SKILL_POSITIONS) {
    const need = slots.filter((s) => s === pos).length;
    if (!need) continue;
    const have = roster.filter((a) => a.type === 'player' && a.position === pos).length;
    if (have < need) return pos;
  }
  return null;
}

/** How a package moves a team toward its goal, in [-1, 1]. "Now" is the
 *  best-lineup change (weekly points), "later" is dynasty value — today's
 *  board, where the forecast says it is heading, and age. A win-now team
 *  weighs now; a rebuild weighs later; balanced splits. */
function goalFit(goal: TradeGoal, lineupDelta: number, lineupBefore: number, valueDelta: number, laterDelta: number | null, giveValue: number, ageDelta: number | null, picksIn: number, picksOut: number): number {
  const lineupGain = clip(lineupDelta / Math.max(1, 0.06 * lineupBefore));
  const norm = Math.max(500, 0.08 * Math.max(giveValue, 1));
  const valueGain = clip(valueDelta / norm);
  const laterGain = laterDelta != null ? clip(laterDelta / norm) : valueGain;
  const longTerm = 0.6 * valueGain + 0.4 * laterGain;
  // Younger incoming players and incoming picks are the rebuild currency.
  let youth = ageDelta != null ? clip(-ageDelta / 4) : 0;
  youth = clip(youth + 0.35 * (picksIn - picksOut));
  switch (goal) {
    case 'win-now': return clip(0.7 * lineupGain + 0.3 * longTerm - 0.15 * Math.max(0, picksIn - picksOut));
    case 'rebuild': return clip(0.45 * youth + 0.55 * longTerm);
    default: return clip(0.35 * lineupGain + 0.35 * longTerm + 0.3 * youth);
  }
}

const sumLater = (xs: FinisherAsset[]) => xs.reduce((s, a) => s + (a.valueLater ?? a.value), 0);
const hasLater = (xs: FinisherAsset[]) => xs.some((a) => a.valueLater != null);

export function evaluateOffer(offer: Offer, me: FinisherTeam, partner: FinisherTeam, ctx: EvalContext): OfferEval {
  const tol = ctx.tolerancePct ?? DEFAULT_TOLERANCE_PCT;
  const giveValue = sum(offer.give);
  const getValue = sum(offer.get);
  const diff = getValue - giveValue;
  const avg = (giveValue + getValue) / 2 || 1;
  const fairnessPct = (Math.abs(diff) / avg) * 100;
  const verdict = verdictFor(fairnessPct);

  const myAfter = applyTrade(me.assets, offer.give, offer.get);
  const partnerAfter = applyTrade(partner.assets, offer.get, offer.give);
  const myHole = lineupHole(myAfter, ctx.rosterPositions);
  const partnerHole = lineupHole(partnerAfter, ctx.rosterPositions);
  const legal = !myHole && !partnerHole;
  const illegalReason = myHole ? `leaves you without a starting ${myHole}` : partnerHole ? `leaves ${partner.teamName} without a starting ${partnerHole}` : undefined;

  const myBefore = ctx.myNeeds.lineup.total;
  const myAfterLineup = optimalLineup(myAfter, ctx.rosterPositions).total;
  const partnerBefore = ctx.partnerNeeds.lineup.total;
  const partnerAfterLineup = optimalLineup(partnerAfter, ctx.rosterPositions).total;
  const myLineupDelta = myAfterLineup - myBefore;
  const partnerLineupDelta = partnerAfterLineup - partnerBefore;

  const ageIn = avgAge(offer.get), ageOut = avgAge(offer.give);
  const ageDelta = ageIn != null && ageOut != null ? ageIn - ageOut : null;
  const picksIn = offer.get.filter((a) => a.type === 'pick').length;
  const picksOut = offer.give.filter((a) => a.type === 'pick').length;
  const netPlayers = offer.get.filter((a) => a.type === 'player').length - offer.give.filter((a) => a.type === 'player').length;

  const laterDiff = hasLater(offer.give) || hasLater(offer.get) ? sumLater(offer.get) - sumLater(offer.give) : null;
  const myFit = goalFit(ctx.myGoal, myLineupDelta, myBefore, diff, laterDiff, giveValue, ageDelta, picksIn, picksOut);
  const partnerFit = goalFit(ctx.partnerGoal, partnerLineupDelta, partnerBefore, -diff, laterDiff == null ? null : -laterDiff, getValue, ageDelta == null ? null : -ageDelta, picksOut, picksIn);

  // Each side's read: roles before (what leaves) and after (what arrives).
  const myRead: SideRead = {
    goal: ctx.myGoal, weeklyPts: myLineupDelta / WEEKS, valueNow: diff, valueLater: laterDiff, ageDelta,
    out: offer.give.map((a) => rosterRole(a, me.assets, ctx.rosterPositions)),
    in: offer.get.map((a) => rosterRole(a, myAfter, ctx.rosterPositions)),
    fit: myFit, verdict: fitVerdict(myFit),
  };
  const partnerRead: SideRead = {
    goal: ctx.partnerGoal, weeklyPts: partnerLineupDelta / WEEKS, valueNow: -diff, valueLater: laterDiff == null ? null : -laterDiff, ageDelta: ageDelta == null ? null : -ageDelta,
    out: offer.get.map((a) => rosterRole(a, partner.assets, ctx.rosterPositions)),
    in: offer.give.map((a) => rosterRole(a, partnerAfter, ctx.rosterPositions)),
    fit: partnerFit, verdict: fitVerdict(partnerFit),
  };

  // Positional needs: incoming players at your weak spots and outgoing from
  // your surplus score up; the reverse scores down. Partner counts half.
  let needs = 0, n = 0;
  const posScore = (asset: FinisherAsset, incoming: boolean, who: TeamNeeds) => {
    if (asset.type !== 'player') return;
    const pos = asset.position as SkillPos;
    n++;
    if (incoming) needs += who.weak.includes(pos) ? 1 : who.strong.includes(pos) ? -0.5 : 0;
    else needs += who.strong.includes(pos) ? 0.5 : who.weak.includes(pos) ? -1 : 0;
  };
  for (const a of offer.get) posScore(a, true, ctx.myNeeds);
  for (const a of offer.give) posScore(a, false, ctx.myNeeds);
  const myNeedsFit = n ? needs / n : 0;
  needs = 0; n = 0;
  for (const a of offer.give) posScore(a, true, ctx.partnerNeeds);
  for (const a of offer.get) posScore(a, false, ctx.partnerNeeds);
  const partnerNeedsFit = n ? needs / n : 0;
  const needsFit = clip(0.67 * myNeedsFit + 0.33 * partnerNeedsFit);

  const fairnessScore = clip(1 - fairnessPct / tol, -1, 1);
  const score = legal ? 0.45 * myFit + 0.25 * partnerFit + 0.2 * needsFit + 0.1 * fairnessScore : -9;

  const tags: string[] = [];
  const weakHit = offer.get.filter((a) => a.type === 'player' && ctx.myNeeds.weak.includes(a.position as SkillPos)).map((a) => a.position);
  if (weakHit.length) tags.push(`Fills your ${[...new Set(weakHit)].join('/')}`);
  const weakCost = offer.give.filter((a) => a.type === 'player' && ctx.myNeeds.weak.includes(a.position as SkillPos)).map((a) => a.position);
  if (weakCost.length) tags.push(`Thins your ${[...new Set(weakCost)].join('/')}`);
  const partnerHit = offer.give.filter((a) => a.type === 'player' && ctx.partnerNeeds.weak.includes(a.position as SkillPos)).map((a) => a.position);
  if (partnerHit.length) tags.push(`Fills their ${[...new Set(partnerHit)].join('/')}`);
  if (Math.abs(myLineupDelta) >= 3) tags.push(`Your lineup ${myLineupDelta > 0 ? '+' : ''}${myLineupDelta.toFixed(0)} pts`);
  if (Math.abs(partnerLineupDelta) >= 3) tags.push(`Their lineup ${partnerLineupDelta > 0 ? '+' : ''}${partnerLineupDelta.toFixed(0)} pts`);
  if (ageDelta != null && Math.abs(ageDelta) >= 1.5) tags.push(ageDelta < 0 ? `You get younger (${ageDelta.toFixed(1)} yrs)` : `You get older (+${ageDelta.toFixed(1)} yrs)`);
  if (picksIn) tags.push(`You add ${picksIn} pick${picksIn > 1 ? 's' : ''}`);
  if (picksOut) tags.push(`You send ${picksOut} pick${picksOut > 1 ? 's' : ''}`);
  if (netPlayers > 0) tags.push(`Needs ${netPlayers} drop${netPlayers > 1 ? 's' : ''}`);
  if (netPlayers < 0) tags.push(`Frees ${-netPlayers} roster spot${netPlayers < -1 ? 's' : ''}`);
  const startsForMe = myRead.in.filter((r) => r.role === 'starter');
  if (startsForMe.length) tags.push(`Starts for you: ${startsForMe.map((r) => r.asset.name).join(', ')}`);
  const surplusOut = myRead.out.filter((r) => r.role === 'surplus');
  if (surplusOut.length) tags.push(`You send surplus: ${surplusOut.map((r) => `${r.asset.name} (${r.depthLabel})`).join(', ')}`);
  const startsForThem = partnerRead.in.filter((r) => r.role === 'starter');
  if (startsForThem.length) tags.push(`Starts for them: ${startsForThem.map((r) => r.asset.name).join(', ')}`);
  if (myFit >= 0.25) tags.push('Serves your goal');
  else if (myFit <= -0.25) tags.push('Against your goal');
  if (partnerFit >= 0.25) tags.push('Serves their goal');
  else if (partnerFit <= -0.25) tags.push('Against their goal');
  if (!legal && illegalReason) tags.push(`Illegal: ${illegalReason}`);

  return {
    giveValue, getValue, diff, fairnessPct, verdict, legal, illegalReason,
    myLineupBefore: myBefore, myLineupAfter: myAfterLineup, myLineupDelta, partnerLineupDelta,
    ageDelta, netPlayers, myFit, partnerFit, needsFit, score, tags, myRead, partnerRead,
  };
}

// ── Search ────────────────────────────────────────────────────────────────

export interface Edit {
  kind: 'add' | 'remove' | 'swap';
  /** Which side of YOUR offer changed: what you give or what you get. */
  side: 'give' | 'get';
  asset: FinisherAsset;
  /** For swaps: the asset that left the offer. */
  replaced?: FinisherAsset;
}

export interface Variant { offer: Offer; edits: Edit[]; eval: OfferEval }

export interface SuggestOptions {
  max?: number;
  tolerancePct?: number;
  /** Cap on assets considered per side (highest value first). */
  poolSize?: number;
  maxSideSize?: number;
}

const offerKey = (o: Offer) => [...o.give.map((a) => a.id)].sort().join(',') + '|' + [...o.get.map((a) => a.id)].sort().join(',');

export function describeEdit(e: Edit, partnerName: string, youName = 'you'): string {
  const from = e.side === 'get' ? `from ${partnerName}` : `from ${youName}`;
  if (e.kind === 'add') return `+ ${e.asset.name} ${from}`;
  if (e.kind === 'remove') return `− ${e.asset.name} (${e.side === 'get' ? `${partnerName} keeps` : youName === 'you' ? 'you keep' : `${youName} keeps`})`;
  return `${e.replaced?.name ?? '?'} → ${e.asset.name} ${from}`;
}

/** What an offer does FOR THE PARTNER, and nothing else — the read that goes
 *  on the partner's page. Second person ("your"), positives only: the value
 *  they win, the lineup points they gain, the holes it fills, the youth or
 *  picks they add, the roster spots it frees, the goal it serves. The
 *  proposer's side of the ledger stays with the proposer. */
export function partnerPositives(ev: OfferEval, partnerNeeds: TeamNeeds, offer: Offer): string[] {
  const out: string[] = [];
  if (ev.diff < 0) out.push(`You win the value by ${Math.round(-ev.diff).toLocaleString()}`);
  else if (ev.verdict === 'fair') out.push('About even on value');
  const fills = [...new Set(offer.give.filter((a) => a.type === 'player' && partnerNeeds.weak.includes(a.position as SkillPos)).map((a) => a.position))];
  if (fills.length) out.push(`Fills your ${fills.join('/')}`);
  for (const r of ev.partnerRead.in.filter((x) => x.role === 'starter')) out.push(`${r.asset.name} starts at ${slotWord(r)} for you (+${r.weeklyPts.toFixed(1)} pts/wk)`);
  const surplus = ev.partnerRead.out.filter((x) => x.role === 'surplus');
  if (surplus.length) out.push(`${surplus.map((r) => `${r.asset.name} (${r.depthLabel})`).join(', ')} ${surplus.length === 1 ? 'was' : 'were'} surplus depth that never started`);
  if (ev.partnerLineupDelta >= 3) out.push(`Your lineup +${(ev.partnerLineupDelta / WEEKS).toFixed(1)} pts/wk`);
  if (ev.partnerRead.valueLater != null && ev.partnerRead.valueLater > 0 && ev.partnerRead.valueLater > ev.partnerRead.valueNow) out.push(`Value heading your way: +${Math.round(ev.partnerRead.valueLater).toLocaleString()} on the ${LATER_DAYS}-day forecast`);
  if (ev.ageDelta != null && ev.ageDelta >= 1.5) out.push(`You get younger (−${ev.ageDelta.toFixed(1)} yrs)`);
  const picks = offer.give.filter((a) => a.type === 'pick').length;
  if (picks) out.push(`You add ${picks} pick${picks > 1 ? 's' : ''}`);
  if (ev.netPlayers > 0) out.push(`Frees ${ev.netPlayers} roster spot${ev.netPlayers > 1 ? 's' : ''}`);
  if (ev.partnerFit >= 0.25) out.push('Serves your goal');
  return out;
}

/** Rewrite an evaluation's you/their tags with team names, for a page read by
 *  both sides (or a third party) where "you" is ambiguous. */
export function nameTags(tags: string[], youName: string, themName: string): string[] {
  const yours = `${youName}'s`, theirs = `${themName}'s`;
  return tags.map((t) => t
    .replace(/^Fills your /, `Fills ${yours} `).replace(/^Thins your /, `Thins ${yours} `).replace(/^Fills their /, `Fills ${theirs} `)
    .replace(/^Your lineup /, `${youName} lineup `).replace(/^Their lineup /, `${themName} lineup `)
    .replace(/^You get younger/, `${youName} gets younger`).replace(/^You get older/, `${youName} gets older`)
    .replace(/^You add /, `${youName} adds `).replace(/^You send /, `${youName} sends `)
    .replace(/^Needs /, `${youName} needs `).replace(/^Frees /, `${youName} frees `)
    .replace(/^Starts for you: /, `Starts for ${youName}: `).replace(/^Starts for them: /, `Starts for ${themName}: `).replace(/^You send surplus: /, `${youName} sends surplus: `)
    .replace(/^Serves your goal/, `Serves ${yours} goal`).replace(/^Against your goal/, `Against ${yours} goal`)
    .replace(/^Serves their goal/, `Serves ${theirs} goal`).replace(/^Against their goal/, `Against ${theirs} goal`));
}

/**
 * Offers one or two edits away from the one on the table that land inside
 * the fairness tolerance and are legal for both rosters, ranked by how well
 * they serve your goal, the partner's goal, both teams' needs and fairness.
 */
export function suggestFinishes(offer: Offer, me: FinisherTeam, partner: FinisherTeam, ctx: EvalContext, opts: SuggestOptions = {}): Variant[] {
  const max = opts.max ?? 8;
  const tol = opts.tolerancePct ?? ctx.tolerancePct ?? DEFAULT_TOLERANCE_PCT;
  const poolSize = opts.poolSize ?? 40;
  const maxSide = opts.maxSideSize ?? 5;
  const evalCtx: EvalContext = { ...ctx, tolerancePct: tol };

  const inGive = new Set(offer.give.map((a) => a.id));
  const inGet = new Set(offer.get.map((a) => a.id));
  const myPool = me.assets.filter((a) => !inGive.has(a.id) && a.value > 0).slice(0, poolSize);
  const theirPool = partner.assets.filter((a) => !inGet.has(a.id) && a.value > 0).slice(0, poolSize);

  const candidates = new Map<string, { offer: Offer; edits: Edit[] }>();
  const baseKey = offerKey(offer);
  const consider = (give: FinisherAsset[], get: FinisherAsset[], edits: Edit[]) => {
    if (!give.length || !get.length || give.length > maxSide || get.length > maxSide) return;
    const o = { give, get };
    const key = offerKey(o);
    if (key === baseKey || candidates.has(key)) return;
    // Cheap fairness gate before the full evaluation.
    const gv = sum(give), rv = sum(get);
    const avg = (gv + rv) / 2 || 1;
    if ((Math.abs(rv - gv) / avg) * 100 > tol) return;
    candidates.set(key, { offer: o, edits });
  };

  const add = (side: 'give' | 'get', a: FinisherAsset): Edit => ({ kind: 'add', side, asset: a });
  const remove = (side: 'give' | 'get', a: FinisherAsset): Edit => ({ kind: 'remove', side, asset: a });
  const swap = (side: 'give' | 'get', a: FinisherAsset, replaced: FinisherAsset): Edit => ({ kind: 'swap', side, asset: a, replaced });
  const without = (xs: FinisherAsset[], a: FinisherAsset) => xs.filter((x) => x.id !== a.id);

  // One edit.
  for (const g of myPool) consider([...offer.give, g], offer.get, [add('give', g)]);
  for (const r of theirPool) consider(offer.give, [...offer.get, r], [add('get', r)]);
  for (const g of offer.give) consider(without(offer.give, g), offer.get, [remove('give', g)]);
  for (const r of offer.get) consider(offer.give, without(offer.get, r), [remove('get', r)]);
  for (const g of offer.give) for (const g2 of myPool) consider([...without(offer.give, g), g2], offer.get, [swap('give', g2, g)]);
  for (const r of offer.get) for (const r2 of theirPool) consider(offer.give, [...without(offer.get, r), r2], [swap('get', r2, r)]);

  // Two edits: a piece each way, a sweetener plus a removal, two pieces one way.
  for (const g of myPool) for (const r of theirPool) consider([...offer.give, g], [...offer.get, r], [add('give', g), add('get', r)]);
  for (const r of theirPool) for (const g of offer.give) consider(without(offer.give, g), [...offer.get, r], [add('get', r), remove('give', g)]);
  for (const g of myPool) for (const r of offer.get) consider([...offer.give, g], without(offer.get, r), [add('give', g), remove('get', r)]);
  for (let i = 0; i < theirPool.length; i++) for (let j = i + 1; j < theirPool.length; j++) {
    consider(offer.give, [...offer.get, theirPool[i], theirPool[j]], [add('get', theirPool[i]), add('get', theirPool[j])]);
  }
  for (let i = 0; i < myPool.length; i++) for (let j = i + 1; j < myPool.length; j++) {
    consider([...offer.give, myPool[i], myPool[j]], offer.get, [add('give', myPool[i]), add('give', myPool[j])]);
  }

  const variants: Variant[] = [];
  for (const c of candidates.values()) {
    const ev = evaluateOffer(c.offer, me, partner, evalCtx);
    if (!ev.legal) continue;
    // Neither side should be clearly worse off on its own goal, or there is
    // no reason to say yes; milder misses are ranked down, not hidden.
    if (ev.partnerFit < -0.5 || ev.myFit < -0.5) continue;
    const score = ev.score - 0.06 * c.edits.length;
    variants.push({ offer: c.offer, edits: c.edits, eval: { ...ev, score } });
  }
  variants.sort((a, b) => b.eval.score - a.eval.score);

  // Spread the list: no more than two variants built on the same added asset.
  const seen = new Map<string, number>();
  const out: Variant[] = [];
  for (const v of variants) {
    const keys = v.edits.filter((e) => e.kind !== 'remove').map((e) => e.asset.id);
    if (keys.some((k) => (seen.get(k) ?? 0) >= 2)) continue;
    for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}
