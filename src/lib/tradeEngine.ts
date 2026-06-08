import type { LeagueTeam, SleeperTradedPick } from './sleeper';
import type { KTCPlayer } from '../types';

export type TradeGoal = 'win-now' | 'rebuild' | 'balanced';

export interface DraftPick {
  season: string;
  round: number;
  originalOwnerId: number;
  currentOwnerId: number;
  value?: number;          // scaled dynasty value (set when projected context is supplied)
  projectedSlot?: number;  // projected pick position within its round (1 = first off the board)
}

export interface TradeAssetStats {
  projPts: number;
  projPosRank: number;
  projPassYds?: number;
  projPassTd?: number;
  projRushYds?: number;
  projRushTd?: number;
  projRec?: number;
  projRecYds?: number;
  projRecTd?: number;
}

export interface TradeAsset {
  type: 'player' | 'pick';
  name: string;
  value: number;
  age?: number;
  position?: string;
  sleeperId?: string;
  pick?: DraftPick;
  projPts?: number;
  projStats?: TradeAssetStats;
  lastSeasonPts?: number;
  lastSeasonPosRank?: number;
}

export interface TradeScoreBreakdown {
  fairness: number;
  goalAlignmentA: boolean;
  goalAlignmentB: boolean;
  strengthensA: boolean;
  strengthensB: boolean;
  total: number;
}

export interface TradeSuggestion {
  teamA: { rosterId: number; teamName: string; gives: TradeAsset[]; receives: TradeAsset[]; netValue: number };
  teamB: { rosterId: number; teamName: string; gives: TradeAsset[]; receives: TradeAsset[]; netValue: number };
  fairness: number;
  score: number;
  scoreBreakdown: TradeScoreBreakdown;
  rationale: string;
}

// Fallback round midpoint values (≈12-team) used when no projected draft order
// is available. Prefer the scaled curve below whenever team strength is known.
const PICK_VALUES: Record<number, number> = { 1: 7000, 2: 4500, 3: 2500, 4: 1500 };
const POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const;

// Overall draft position of a pick: round and slot-within-round combine with
// league size, so a 2nd-round pick in a 16-team league sits much later (and is
// worth far less) than the same round in a 10-team league.
export function overallPickNumber(round: number, slot: number, totalTeams: number): number {
  return (round - 1) * totalTeams + slot;
}

// Smooth decay curve for rookie-pick value as a function of overall draft slot.
// Calibrated to common 12-team valuations: 1.01 ≈ 8600, mid-1st ≈ 7000,
// late-1st ≈ 5000, mid-2nd ≈ 4200, mid-3rd ≈ 2600, mid-4th ≈ 1700.
export function dynastyPickValue(overall: number): number {
  const v = 8200 * Math.exp(-0.045 * (overall - 1)) + 400;
  return Math.round(v / 50) * 50;
}

// Resolve a pick's effective trade value: the scaled value if a projected draft
// slot is known, otherwise the flat round midpoint.
function pickValue(pick: DraftPick): number {
  return pick.value ?? PICK_VALUES[pick.round] ?? 1000;
}

// "2027 1.04" when a projected slot is known, else "2027 Rd 1".
function pickLabel(pick: DraftPick): string {
  if (pick.projectedSlot != null) {
    return `${pick.season} ${pick.round}.${String(pick.projectedSlot).padStart(2, '0')}`;
  }
  return `${pick.season} Rd ${pick.round}`;
}

function normalizeForMatch(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '').replace(/^(jr|sr|ii|iii|iv)$/, '');
}

interface TeamProfile {
  team: LeagueTeam;
  goal: TradeGoal;
  assets: TradeAsset[];
  posValues: Record<string, number>;
  posCount: Record<string, number>;
  totalValue: number;
  weakPositions: string[];
  strongPositions: string[];
}

function buildTeamProfile(
  team: LeagueTeam,
  ktcByName: Map<string, KTCPlayer>,
  picks: DraftPick[],
  goal: TradeGoal,
  projMap?: Map<string, number>,
  projStatsMap?: Map<string, TradeAssetStats>,
  lastSeasonMap?: Map<string, { pts: number; posRank: number }>,
  // Redraft leagues value, compare, and rank everything on projected season
  // points instead of dynasty (KTC) value.
  useProjectedValue = false,
): TeamProfile {
  const assets: TradeAsset[] = [];
  const posValues: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
  const posCount: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };

  for (const p of [...team.starters, ...team.bench]) {
    if (p.name === 'Empty' || !p.position || p.position === 'DEF') continue;
    const k = ktcByName.get(normalizeForMatch(p.name));
    const proj = projMap?.get(p.id) ?? 0;
    // In redraft mode the trade currency is projected points; include any player
    // with a projection. In dynasty mode it's KTC value.
    const value = useProjectedValue ? proj : (k?.value ?? 0);
    if (value <= 0) continue;
    assets.push({
      type: 'player',
      name: p.name,
      value,
      age: k?.age,
      position: p.position,
      sleeperId: p.id,
      projPts: projMap?.get(p.id),
      projStats: projStatsMap?.get(p.id),
      lastSeasonPts: lastSeasonMap?.get(p.id)?.pts,
      lastSeasonPosRank: lastSeasonMap?.get(p.id)?.posRank,
    });
    if (posValues[p.position] !== undefined) {
      posValues[p.position] += value;
      posCount[p.position]++;
    }
  }

  for (const pick of picks) {
    assets.push({
      type: 'pick',
      name: pickLabel(pick),
      value: pickValue(pick),
      pick,
    });
  }

  assets.sort((a, b) => b.value - a.value);
  const totalValue = Object.values(posValues).reduce((a, b) => a + b, 0);

  // Determine weak/strong positions relative to team average
  const avgPosValue = totalValue / 4;
  const weakPositions: string[] = [];
  const strongPositions: string[] = [];
  for (const pos of POSITIONS) {
    if (posValues[pos] < avgPosValue * 0.6) weakPositions.push(pos);
    else if (posValues[pos] > avgPosValue * 1.4) strongPositions.push(pos);
  }

  return { team, goal, assets, posValues, posCount, totalValue, weakPositions, strongPositions };
}

function isTradableAsset(asset: TradeAsset, profile: TeamProfile, useProjectedValue = false): boolean {
  if (asset.type === 'pick') return profile.goal === 'win-now' || profile.goal === 'balanced';

  // Never trade top 2 most valuable players
  const playerAssets = profile.assets.filter((a) => a.type === 'player');
  if (playerAssets.indexOf(asset) < 2) return false;

  // Don't trade from weak positions
  if (asset.position && profile.weakPositions.includes(asset.position)) return false;

  // Don't trade if it would leave a position with only 1 player
  if (asset.position && (profile.posCount[asset.position] ?? 0) <= 2) return false;

  // Redraft: no age/dynasty thresholds — any non-core, non-weak player is movable.
  if (useProjectedValue) return true;

  if (!asset.age) return false;

  if (profile.goal === 'win-now') {
    return asset.age <= 23 || (asset.age >= 29 && asset.value < 4000);
  }
  if (profile.goal === 'rebuild') {
    return asset.age >= 26;
  }
  return asset.value < 6000;
}

function wouldLeavePositionWeak(
  profile: TeamProfile,
  giving: TradeAsset[],
  receiving: TradeAsset[],
): boolean {
  const afterPosValues = { ...profile.posValues };
  const afterPosCount = { ...profile.posCount };

  for (const a of giving) {
    if (a.position && afterPosValues[a.position] !== undefined) {
      afterPosValues[a.position] -= a.value;
      afterPosCount[a.position]--;
    }
  }
  for (const a of receiving) {
    if (a.position && afterPosValues[a.position] !== undefined) {
      afterPosValues[a.position] += a.value;
      afterPosCount[a.position]++;
    }
  }

  for (const pos of POSITIONS) {
    if (afterPosCount[pos] < 1) return true;
    if (afterPosValues[pos] < 1000 && profile.posValues[pos] >= 2000) return true;
  }
  return false;
}

function meetsGoal(receiving: TradeAsset[], goal: TradeGoal): boolean {
  const players = receiving.filter((a) => a.type === 'player');
  if (!players.length) return goal === 'rebuild';

  if (goal === 'win-now') {
    return players.some((p) => (p.age ?? 0) >= 24 && (p.age ?? 99) <= 30);
  }
  if (goal === 'rebuild') {
    return players.some((p) => (p.age ?? 99) <= 25) || receiving.some((a) => a.type === 'pick');
  }
  return true;
}

function strengthensWeakness(receiving: TradeAsset[], weakPositions: string[]): boolean {
  if (!weakPositions.length) return true;
  return receiving.some((a) => a.position && weakPositions.includes(a.position));
}

function scoreTrade(
  profileA: TeamProfile,
  givesA: TradeAsset[],
  receivesA: TradeAsset[],
  profileB: TeamProfile,
  givesB: TradeAsset[],
  receivesB: TradeAsset[],
): TradeScoreBreakdown {
  let score = 50;

  const totalGiveA = givesA.reduce((s, a) => s + a.value, 0);
  const totalGiveB = givesB.reduce((s, a) => s + a.value, 0);
  const avg = (totalGiveA + totalGiveB) / 2 || 1;
  const imbalance = Math.abs(totalGiveA - totalGiveB) / avg;
  const fairnessScore = Math.max(0, 20 - imbalance * 40);
  score += fairnessScore;

  const goalAlignmentA = meetsGoal(receivesA, profileA.goal);
  const goalAlignmentB = meetsGoal(receivesB, profileB.goal);
  if (goalAlignmentA) score += 10;
  if (goalAlignmentB) score += 10;

  const strengthensA = strengthensWeakness(receivesA, profileA.weakPositions);
  const strengthensB = strengthensWeakness(receivesB, profileB.weakPositions);
  if (strengthensA) score += 5;
  if (strengthensB) score += 5;

  return {
    fairness: Math.round(fairnessScore * 5),
    goalAlignmentA,
    goalAlignmentB,
    strengthensA,
    strengthensB,
    total: Math.min(100, Math.max(0, Math.round(score))),
  };
}

export function buildPickOwnership(
  teams: LeagueTeam[],
  tradedPicks: SleeperTradedPick[],
  season = '2027',
  // Projected season points per roster. When supplied, picks are slotted by the
  // ORIGINAL owner's projected finish (weakest team picks first) and priced on
  // the league-size-aware decay curve. Contenders' picks land late and cheap;
  // rebuilding teams' picks land early and rich.
  projectedPointsByRosterId?: Map<number, number>,
): Map<number, DraftPick[]> {
  const map = new Map<number, DraftPick[]>();
  for (const t of teams) map.set(t.rosterId, []);

  for (const t of teams) {
    for (let round = 1; round <= 4; round++) {
      map.get(t.rosterId)!.push({ season, round, originalOwnerId: t.rosterId, currentOwnerId: t.rosterId });
    }
  }

  for (const tp of tradedPicks) {
    if (tp.season !== season) continue;
    for (const [rosterId, picks] of map) {
      const idx = picks.findIndex((p) => p.round === tp.round && p.originalOwnerId === tp.owner_id);
      if (idx >= 0 && rosterId !== tp.roster_id) {
        picks.splice(idx, 1);
      }
    }
    const ownerPicks = map.get(tp.roster_id);
    if (ownerPicks && !ownerPicks.find((p) => p.round === tp.round && p.originalOwnerId === tp.owner_id)) {
      ownerPicks.push({ season: tp.season, round: tp.round, originalOwnerId: tp.owner_id, currentOwnerId: tp.roster_id });
    }
  }

  // Slot + price every pick by its original owner's projected draft position.
  if (projectedPointsByRosterId && teams.length) {
    const totalTeams = teams.length;
    const ranked = [...teams].sort(
      (a, b) => (projectedPointsByRosterId.get(a.rosterId) ?? 0) - (projectedPointsByRosterId.get(b.rosterId) ?? 0),
    );
    const slotByRoster = new Map<number, number>();
    ranked.forEach((t, i) => slotByRoster.set(t.rosterId, i + 1)); // weakest projected = slot 1
    const midSlot = Math.ceil(totalTeams / 2);
    for (const picks of map.values()) {
      for (const pick of picks) {
        const slot = slotByRoster.get(pick.originalOwnerId) ?? midSlot;
        pick.projectedSlot = slot;
        pick.value = dynastyPickValue(overallPickNumber(pick.round, slot, totalTeams));
      }
    }
  }

  return map;
}

// Seeded PRNG for shuffling — ensures different results each call
let rngState = Date.now();
function nextRng(): number {
  rngState = (rngState * 1664525 + 1013904223) & 0x7fffffff;
  return rngState / 0x7fffffff;
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(nextRng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function generateTradeSuggestions(
  teams: LeagueTeam[],
  ktc: KTCPlayer[],
  goals: Map<number, TradeGoal>,
  pickOwnership: Map<number, DraftPick[]>,
  myRosterId?: number,
  projMap?: Map<string, number>,
  maxSuggestions = 6,
  projStatsMap?: Map<string, TradeAssetStats>,
  lastSeasonMap?: Map<string, { pts: number; posRank: number }>,
  // Redraft: value, compare, and rank on projected points instead of KTC value.
  useProjectedValue = false,
): TradeSuggestion[] {
  rngState = Date.now();

  const ktcByName = new Map<string, KTCPlayer>();
  for (const p of ktc) ktcByName.set(normalizeForMatch(p.playerName), p);

  const profiles = new Map<number, TeamProfile>();
  for (const t of teams) {
    const goal = goals.get(t.rosterId) ?? 'balanced';
    profiles.set(t.rosterId, buildTeamProfile(t, ktcByName, pickOwnership.get(t.rosterId) ?? [], goal, projMap, projStatsMap, lastSeasonMap, useProjectedValue));
  }

  const myProfile = myRosterId ? profiles.get(myRosterId) : undefined;
  if (!myProfile) return [];

  const tradableA = shuffle(myProfile.assets.filter((a) => isTradableAsset(a, myProfile, useProjectedValue)));
  const candidates: TradeSuggestion[] = [];

  for (const teamB of teams) {
    if (teamB.rosterId === myProfile.team.rosterId) continue;
    const profileB = profiles.get(teamB.rosterId)!;
    const tradableB = shuffle(profileB.assets.filter((a) => isTradableAsset(a, profileB, useProjectedValue)));

    // Try 2-for-2 and 2-for-3 / 3-for-2 combinations
    for (let sizeA = 2; sizeA <= 3 && sizeA <= tradableA.length; sizeA++) {
      for (let sizeB = 2; sizeB <= 3 && sizeB <= tradableB.length; sizeB++) {
        // Try multiple combos from shuffled pools
        const combosToTry = Math.min(8, Math.max(3, tradableA.length));
        for (let attempt = 0; attempt < combosToTry; attempt++) {
          const startA = (attempt * sizeA) % Math.max(1, tradableA.length - sizeA + 1);
          const givesA = tradableA.slice(startA, startA + sizeA);
          if (givesA.length < sizeA) continue;

          const totalGiveA = givesA.reduce((s, a) => s + a.value, 0);

          // Find matching package from B within 30% value
          let bestGivesB: TradeAsset[] | null = null;
          let bestDiff = Infinity;

          for (let bStart = 0; bStart <= tradableB.length - sizeB; bStart++) {
            const tryB = tradableB.slice(bStart, bStart + sizeB);
            const totalB = tryB.reduce((s, a) => s + a.value, 0);
            const diff = Math.abs(totalGiveA - totalB);
            const avg = (totalGiveA + totalB) / 2;
            if (diff / avg > 0.30) continue;
            if (diff < bestDiff) {
              bestDiff = diff;
              bestGivesB = tryB;
            }
          }

          if (!bestGivesB) continue;

          // Validate: doesn't leave either team with a gutted position
          if (wouldLeavePositionWeak(myProfile, givesA, bestGivesB)) continue;
          if (wouldLeavePositionWeak(profileB, bestGivesB, givesA)) continue;

          // Validate: meets both teams' goals
          if (!meetsGoal(bestGivesB, myProfile.goal) && !meetsGoal(givesA, profileB.goal)) continue;

          const totalGiveB = bestGivesB.reduce((s, a) => s + a.value, 0);
          const avgVal = (totalGiveA + totalGiveB) / 2 || 1;
          const fairness = Math.max(0, 100 - (Math.abs(totalGiveA - totalGiveB) / avgVal) * 100);

          const tradeScore = scoreTrade(myProfile, givesA, bestGivesB, profileB, bestGivesB, givesA);

          // Build rationale
          const parts: string[] = [];
          const aWeakFixed = bestGivesB.filter((a) => a.position && myProfile.weakPositions.includes(a.position));
          const bWeakFixed = givesA.filter((a) => a.position && profileB.weakPositions.includes(a.position));
          if (aWeakFixed.length) parts.push(`Strengthens your ${aWeakFixed.map((a) => a.position).join('/')}`);
          if (bWeakFixed.length) parts.push(`Helps ${teamB.teamName} at ${bWeakFixed.map((a) => a.position).join('/')}`);
          if (myProfile.goal === 'win-now' && bestGivesB.some((a) => (a.age ?? 0) >= 24))
            parts.push('Adds proven production');
          if (myProfile.goal === 'rebuild' && bestGivesB.some((a) => (a.age ?? 99) <= 25))
            parts.push('Acquires youth');
          if (!parts.length) parts.push(useProjectedValue ? 'Even projected-points swap' : 'Balanced value swap');

          candidates.push({
            teamA: {
              rosterId: myProfile.team.rosterId,
              teamName: myProfile.team.teamName,
              gives: givesA,
              receives: bestGivesB,
              netValue: totalGiveB - totalGiveA,
            },
            teamB: {
              rosterId: teamB.rosterId,
              teamName: teamB.teamName,
              gives: bestGivesB,
              receives: givesA,
              netValue: totalGiveA - totalGiveB,
            },
            fairness,
            score: tradeScore.total,
            scoreBreakdown: tradeScore,
            rationale: parts.join(' · '),
          });
        }
      }
    }
  }

  // Sort by score then fairness
  candidates.sort((a, b) => (b.score + b.fairness) - (a.score + a.fairness));

  // Dedupe: don't repeat the same players in multiple suggestions
  const usedPlayers = new Set<string>();
  const final: TradeSuggestion[] = [];
  for (const s of candidates) {
    const playerNames = [
      ...s.teamA.gives.map((a) => a.name),
      ...s.teamB.gives.map((a) => a.name),
    ];
    const overlap = playerNames.filter((n) => usedPlayers.has(n)).length;
    if (overlap > 0) continue;
    for (const n of playerNames) usedPlayers.add(n);
    final.push(s);
    if (final.length >= maxSuggestions) break;
  }

  return final;
}

export function evaluateTrade(
  gives: TradeAsset[],
  receives: TradeAsset[],
): { givesTotal: number; receivesTotal: number; net: number; fairness: number } {
  const givesTotal = gives.reduce((s, a) => s + a.value, 0);
  const receivesTotal = receives.reduce((s, a) => s + a.value, 0);
  const net = receivesTotal - givesTotal;
  const avg = (givesTotal + receivesTotal) / 2 || 1;
  const fairness = Math.max(0, 100 - (Math.abs(net) / avg) * 100);
  return { givesTotal, receivesTotal, net, fairness };
}
