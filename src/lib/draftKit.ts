/**
 * Draft Kit engine — value-based drafting (VBD) math for the redraft
 * Draft Optimizer.
 *
 * Builds a wide player pool (base projections + ADP + model PPG + market
 * metadata) and computes replacement-level baselines from the user's
 * league settings, BeerSheets-style:
 *
 *   VOLS — Value Over Last Starter. Baseline = the last starter at the
 *          position once dedicated + FLEX/SF slots are allocated greedily
 *          by projected PPG. Aggressive: values positions that start more
 *          players.
 *   VORP — Value Over Replacement Player. Baseline = best player likely
 *          available on waivers (starters + a league-wide bench
 *          allocation distributed proportionally to starter share).
 *          Conservative: flattens onesie positions (QB/TE).
 *   BEER — midpoint of the VOLS and VORP baselines. Default — a
 *          starters-plus-bench-derisking compromise.
 *
 * VBD = (scoring-adjusted PPG − baseline PPG) × 17, i.e. season points
 * over a freely-available alternative. Draft order by VBD ≈ optimal
 * season-long value accumulation; the spread between a player's VBD rank
 * and his ADP is the market edge the optimizer surfaces.
 */

import { normName } from './nameUtils';
import type { DraftPrepSettings, Position, Scoring } from './draftPrepSettings';
import type { SDIOProjection } from '../types';

export const KIT_POSITIONS: Position[] = ['QB', 'RB', 'WR', 'TE'];
export const SEASON_GAMES = 17;

export type AdpSource = 'ffc' | 'fc-rank' | 'none';

export interface KitPlayer {
  name: string;
  position: Position;
  team: string;
  /** Base PPR projection (redraft-projections.json). */
  pprPpg: number;
  /** Projected receptions per game — drives Half/Standard re-scoring. */
  recPG: number;
  /** Scoring-adjusted PPG under the league's scoring setting. */
  ppg: number;
  /** ppg × 17. */
  seasonPts: number;
  /** Best available market ADP: FFC ADP when present, else FantasyCalc
   *  redraft overall rank as a pick proxy, else 999 (undrafted). */
  adp: number;
  adpSource: AdpSource;
  /** FFC ADP stdev (picks); 0 when unavailable. */
  stdev: number;
  isRookie: boolean;
  age: number | null;
  yearsExp: number | null;
  /** Stathead ADP-free model PPG (score-store/ppg.json); NaN if missing. */
  modelPPG: number;
}

export function kitKey(name: string, position: string): string {
  return `${normName(name)}::${position}`;
}

/** Re-score a PPR PPG line for Half/Standard by removing reception points. */
export function adjustPpg(pprPpg: number, recPG: number, scoring: Scoring): number {
  if (scoring === 'PPR') return pprPpg;
  const recPts = scoring === 'HALF' ? 0.5 * recPG : recPG;
  return Math.max(0, pprPpg - recPts);
}

export interface KitPoolInputs {
  /** redraft-projections.json players — the projection spine. */
  projections: Array<{ name: string; position: string; ppg: number; recPG?: number }>;
  /** FFC ADP entries (real market ADP, vets only this far from draft season). */
  ffc: Array<{ name: string; position: string; team?: string; adp: number; stdev?: number }>;
  /** FantasyCalc redraft snapshot — covers rookies; overallRank ≈ consensus pick. */
  fcRedraft: Array<{
    player: { name: string; position: string; maybeTeam?: string | null; maybeAge?: number | null; maybeYoe?: number | null };
    overallRank: number;
  }>;
  /** score-store/ppg.json. */
  modelPpg: Array<{ name: string; position: string; predictedPPG: number }>;
  /** Names of current-season rookie class (career model draftSeason === this season). */
  rookieNames: Set<string>;
  /** Optional team lookup (score-store/adp.json has team for the model pool). */
  teams?: Map<string, string>;
  scoring: Scoring;
}

/**
 * Merge sources into the kit pool, keyed on normName+position. The
 * projection file is the spine — a player with no projection can't be
 * valued, so ADP-only players are dropped.
 */
export function buildKitPool(inputs: KitPoolInputs): KitPlayer[] {
  const ffcByKey = new Map<string, { adp: number; stdev: number; team?: string }>();
  for (const f of inputs.ffc) {
    if (!f?.name || !Number.isFinite(f.adp)) continue;
    ffcByKey.set(kitKey(f.name, f.position), { adp: f.adp, stdev: Number(f.stdev) || 0, team: f.team });
  }
  const fcByKey = new Map<string, { rank: number; team: string; age: number | null; yoe: number | null }>();
  for (const v of inputs.fcRedraft) {
    const p = v?.player;
    if (!p?.name) continue;
    fcByKey.set(kitKey(p.name, p.position), {
      rank: v.overallRank,
      team: p.maybeTeam ?? '',
      age: Number.isFinite(p.maybeAge as number) ? (p.maybeAge as number) : null,
      yoe: Number.isFinite(p.maybeYoe as number) ? (p.maybeYoe as number) : null,
    });
  }
  const modelByKey = new Map<string, number>();
  for (const m of inputs.modelPpg) {
    if (m?.name) modelByKey.set(kitKey(m.name, m.position), Number(m.predictedPPG) || NaN);
  }

  const out: KitPlayer[] = [];
  for (const pr of inputs.projections) {
    const pos = pr.position as Position;
    if (!KIT_POSITIONS.includes(pos)) continue;
    const pprPpg = Number(pr.ppg) || 0;
    if (pprPpg <= 0) continue;
    const key = kitKey(pr.name, pos);
    const ffc = ffcByKey.get(key);
    const fc = fcByKey.get(key);
    let adp = 999;
    let adpSource: AdpSource = 'none';
    if (ffc) { adp = ffc.adp; adpSource = 'ffc'; }
    else if (fc) { adp = fc.rank; adpSource = 'fc-rank'; }
    const recPG = Number(pr.recPG) || 0;
    const ppg = adjustPpg(pprPpg, recPG, inputs.scoring);
    out.push({
      name: pr.name,
      position: pos,
      team: ffc?.team || fc?.team || inputs.teams?.get(key) || '',
      pprPpg,
      recPG,
      ppg,
      seasonPts: ppg * SEASON_GAMES,
      adp,
      adpSource,
      stdev: ffc?.stdev ?? 0,
      isRookie: inputs.rookieNames.has(normName(pr.name)),
      age: fc?.age ?? null,
      yearsExp: fc?.yoe ?? null,
      modelPPG: modelByKey.get(key) ?? NaN,
    });
  }
  return out;
}

// ── Replacement levels ──

export type BaselineMode = 'VOLS' | 'BEER' | 'VORP';

export const BASELINE_LABEL: Record<BaselineMode, string> = {
  VOLS: 'VOLS — last starter',
  BEER: 'BEER — starters + bench blend',
  VORP: 'VORP — best waiver player',
};

/** Assumed bench depth per team for the VORP waiver baseline. */
const BENCH_PER_TEAM = 6;

export interface ReplacementLevels {
  mode: BaselineMode;
  /** Baseline PPG per position under the active mode. */
  baselinePpg: Record<Position, number>;
  /** League-wide starter count per position (dedicated + flex share). */
  startersAtPos: Record<Position, number>;
}

/**
 * Greedy flex allocation: dedicated starters come off the top of each
 * position's PPG-sorted list, then FLEX (RB/WR/TE) and SF (QB/RB/WR/TE)
 * slots each take the best remaining player across eligible positions.
 * Mirrors how leagues actually fill lineups, so the "last starter" index
 * reflects real positional demand rather than fixed quotas.
 */
export function computeReplacementLevels(
  pool: KitPlayer[],
  settings: DraftPrepSettings,
  mode: BaselineMode,
): ReplacementLevels {
  const sorted: Record<Position, number[]> = { QB: [], RB: [], WR: [], TE: [] };
  for (const p of pool) sorted[p.position].push(p.ppg);
  for (const pos of KIT_POSITIONS) sorted[pos].sort((a, b) => b - a);

  const N = settings.numTeams;
  const taken: Record<Position, number> = {
    QB: Math.min(N * settings.roster.QB, sorted.QB.length),
    RB: Math.min(N * settings.roster.RB, sorted.RB.length),
    WR: Math.min(N * settings.roster.WR, sorted.WR.length),
    TE: Math.min(N * settings.roster.TE, sorted.TE.length),
  };

  const allocate = (slots: number, eligible: Position[]) => {
    for (let i = 0; i < slots; i++) {
      let bestPos: Position | null = null;
      let bestPpg = -Infinity;
      for (const pos of eligible) {
        const next = sorted[pos][taken[pos]];
        if (next !== undefined && next > bestPpg) { bestPpg = next; bestPos = pos; }
      }
      if (!bestPos) break;
      taken[bestPos]++;
    }
  };
  allocate(N * settings.roster.FLEX, ['RB', 'WR', 'TE']);
  allocate(N * settings.roster.SF, ['QB', 'RB', 'WR', 'TE']);

  const baselineAt = (pos: Position, index: number): number => {
    const list = sorted[pos];
    if (list.length === 0) return 0;
    return list[Math.min(Math.max(index, 1), list.length) - 1];
  };

  const totalStarters = taken.QB + taken.RB + taken.WR + taken.TE;
  const baselinePpg = {} as Record<Position, number>;
  for (const pos of KIT_POSITIONS) {
    const volsIdx = Math.max(taken[pos], 1);
    // Bench allocation proportional to starter share — a position that
    // soaks up more starting slots also soaks up more bench stashes.
    const benchAlloc = totalStarters > 0
      ? Math.round((taken[pos] / totalStarters) * N * BENCH_PER_TEAM)
      : 0;
    const vols = baselineAt(pos, volsIdx);
    const vorp = baselineAt(pos, volsIdx + benchAlloc);
    baselinePpg[pos] = mode === 'VOLS' ? vols : mode === 'VORP' ? vorp : (vols + vorp) / 2;
  }

  return { mode, baselinePpg, startersAtPos: taken };
}

export interface ValuedPlayer extends KitPlayer {
  /** Season points over the replacement baseline. */
  vbd: number;
  /** 1-based rank by VBD across all positions. */
  valueRank: number;
  /** valueRank − adp in rounds. Positive = market drafts him later than
   *  his value (discount / can wait); negative = must reach. NaN when
   *  no market ADP. */
  adpDeltaRounds: number;
  /** 1-based tier within position (1 = top), from VBD gap clustering. */
  tier: number;
}

/** Round.pick string for an overall pick number, e.g. 31 → "3.07" in 12-team. */
export function roundPick(overall: number, numTeams: number): string {
  if (!Number.isFinite(overall) || overall <= 0) return '—';
  const round = Math.ceil(overall / numTeams);
  const slot = overall - (round - 1) * numTeams;
  return `${round}.${String(Math.round(slot)).padStart(2, '0')}`;
}

/**
 * Value the pool: VBD per player, overall value rank, ADP-arbitrage delta
 * (in rounds), and per-position tiers from VBD gap clustering.
 */
export function valuePool(
  pool: KitPlayer[],
  settings: DraftPrepSettings,
  mode: BaselineMode,
): { players: ValuedPlayer[]; levels: ReplacementLevels } {
  const levels = computeReplacementLevels(pool, settings, mode);
  const valued: ValuedPlayer[] = pool.map((p) => ({
    ...p,
    vbd: (p.ppg - levels.baselinePpg[p.position]) * SEASON_GAMES,
    valueRank: 0,
    adpDeltaRounds: NaN,
    tier: 0,
  }));
  valued.sort((a, b) => b.vbd - a.vbd);
  valued.forEach((p, i) => {
    p.valueRank = i + 1;
    if (p.adp < 999) p.adpDeltaRounds = (p.adp - p.valueRank) / settings.numTeams;
  });

  // Tier clustering per position: walk the VBD-sorted list and start a
  // new tier when the gap to the previous player exceeds a threshold
  // scaled to the position's overall VBD spread. Only players above the
  // baseline get meaningful tiers; sub-baseline players collapse into
  // the last tier.
  for (const pos of KIT_POSITIONS) {
    const posPlayers = valued.filter((p) => p.position === pos);
    if (posPlayers.length === 0) continue;
    const top = posPlayers[0].vbd;
    const spread = Math.max(top - 0, 1);
    const gapThreshold = Math.max(8, spread / 14);
    let tier = 1;
    posPlayers[0].tier = 1;
    for (let i = 1; i < posPlayers.length; i++) {
      const gap = posPlayers[i - 1].vbd - posPlayers[i].vbd;
      if (gap >= gapThreshold && tier < 9 && posPlayers[i].vbd > -spread * 0.15) tier++;
      posPlayers[i].tier = tier;
    }
  }

  return { players: valued, levels };
}

/** Total positive VBD remaining per position — the scarcity bar input. */
export function positionalScarcity(players: ValuedPlayer[]): Record<Position, number> {
  const out = { QB: 0, RB: 0, WR: 0, TE: 0 } as Record<Position, number>;
  for (const p of players) if (p.vbd > 0) out[p.position] += p.vbd;
  return out;
}

// ── Roster-slot bookkeeping (shared by the draft sim + live assistant) ──

export interface OpenSlots {
  QB: number; RB: number; WR: number; TE: number; FLEX: number; SF: number;
}

export function openSlots(settings: DraftPrepSettings): OpenSlots {
  return {
    QB: settings.roster.QB, RB: settings.roster.RB, WR: settings.roster.WR, TE: settings.roster.TE,
    FLEX: settings.roster.FLEX, SF: settings.roster.SF,
  };
}

/** Fill the best open slot for a position (dedicated → FLEX → SF → bench),
 *  mutating `slots`. Returns the slot label the player landed in. */
export function assignSlot(slots: OpenSlots, pos: Position): string {
  if (slots[pos] > 0) { slots[pos]--; return pos; }
  if (pos !== 'QB' && slots.FLEX > 0) { slots.FLEX--; return 'FLEX'; }
  if (slots.SF > 0) { slots.SF--; return 'SF'; }
  return 'BN';
}

/** True while the position can still fill a starting slot (incl. flex). */
export function starterSlotOpen(slots: OpenSlots, pos: Position): boolean {
  return slots[pos] > 0 || (pos !== 'QB' && slots.FLEX > 0) || slots.SF > 0;
}

// ── Synthetic SDIO-shaped rows (scenario support without an SDIO key) ──

/** Deterministic positive id from a kit key — stable across loads so a
 *  preset built against these rows always matches its own ids. */
function syntheticId(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h * 31) + key.charCodeAt(i)) | 0;
  return (Math.abs(h) % 1_000_000_000) + 1_000_000_000;
}

export interface SyntheticInput {
  name: string;
  position: string;
  /** Season PPR PPG (base projection). */
  ppg: number;
  /** Projected receptions per game (real data where present). */
  recPG?: number;
  team?: string;
}

/**
 * Build SDIOProjection-shaped season rows from the base projections so
 * the scenario engine (and the scenario presets) can run without a
 * SportsDataIO key. The stat decomposition uses positional archetypes
 * (receptions from real recPG; yards/TD splits at typical rates) and is
 * EXACTLY self-consistent: recomputing PPR from the synthetic stat line
 * reproduces ppg × 17. Scenario levers are multiplicative on stats, so
 * an approximate decomposition still yields the right relative PPG
 * moves — which is all the kit consumes.
 */
export function buildSyntheticSdio(entries: SyntheticInput[]): SDIOProjection[] {
  const out: SDIOProjection[] = [];
  for (const e of entries) {
    const pos = e.position;
    const P = (Number(e.ppg) || 0) * SEASON_GAMES;
    if (P <= 0 || !['QB', 'RB', 'WR', 'TE'].includes(pos)) continue;
    const row: SDIOProjection = {
      PlayerID: syntheticId(kitKey(e.name, pos)),
      Name: e.name,
      Team: e.team ?? '',
      Position: pos,
      FantasyPoints: 0,
      FantasyPointsPPR: P,
      PassingAttempts: 0, PassingCompletions: 0, PassingYards: 0, PassingTouchdowns: 0,
      PassingInterceptions: 0, RushingAttempts: 0, RushingYards: 0, RushingTouchdowns: 0,
      Targets: 0, Receptions: 0, ReceivingYards: 0, ReceivingTouchdowns: 0,
      FumblesLost: 0, FieldGoalsMade: 0, ExtraPointsMade: 0,
    } as SDIOProjection;

    if (pos === 'QB') {
      // ~15% of QB fantasy value from rushing (85/15 yards-to-TD split
      // inside each bucket), the rest passing at a 62/38 yds/TD split.
      const rushPts = P * 0.15;
      row.RushingYards = (rushPts * 0.85) / 0.1;
      row.RushingTouchdowns = (rushPts * 0.15) / 6;
      row.RushingAttempts = row.RushingYards / 5.5;
      const passPts = P - rushPts;
      row.PassingYards = (passPts * 0.62) / 0.04;
      row.PassingTouchdowns = (passPts * 0.38) / 4;
      row.PassingAttempts = row.PassingYards / 7.1;
      row.PassingCompletions = row.PassingAttempts * 0.655;
    } else {
      // Receptions are real where recPG exists; otherwise estimate from
      // the position's typical share of PPR value.
      const recShare: Record<string, number> = { RB: 0.14, WR: 0.36, TE: 0.4 };
      let rec = (Number(e.recPG) || 0) * SEASON_GAMES;
      if (rec <= 0) rec = P * recShare[pos];
      const ypr: Record<string, number> = { RB: 7.5, WR: 11.5, TE: 10 };
      let recYds = rec * ypr[pos];
      // Points already claimed by the receiving line (rec + yds).
      let claimed = rec + recYds * 0.1;
      if (claimed > P) {
        // Projection lighter than the reception line implies — compress
        // the line proportionally so the row stays self-consistent.
        const f = P / claimed;
        rec *= f; recYds *= f; claimed = P;
      }
      const remaining = P - claimed;
      if (pos === 'RB') {
        // Remainder is mostly rushing (90%) plus a little receiving TD.
        const rushPts = remaining * 0.9;
        row.RushingYards = (rushPts * 0.72) / 0.1;
        row.RushingTouchdowns = (rushPts * 0.28) / 6;
        row.RushingAttempts = row.RushingYards / 4.3;
        row.ReceivingTouchdowns = (remaining * 0.1) / 6;
      } else {
        // WR/TE remainder splits yards-bump vs TDs.
        const extraYds = (remaining * 0.45) / 0.1;
        recYds += extraYds;
        row.ReceivingTouchdowns = (remaining * 0.55) / 6;
      }
      row.Receptions = rec;
      row.ReceivingYards = recYds;
      row.Targets = rec / 0.72;
    }

    // Standard points = PPR minus receptions (1 pt each) by construction.
    row.FantasyPoints = P - (row.Receptions || 0);
    out.push(row);
  }
  return out;
}
