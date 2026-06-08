import type { LeagueTeam, SleeperTradedPick } from './sleeper';
import type { KTCPlayer } from '../types';

export type TradeGoal = 'win-now' | 'rebuild' | 'balanced';

export interface DraftPick {
  season: string;
  round: number;
  originalOwnerId: number;
  currentOwnerId: number;
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
}

export interface TradeSuggestion {
  teamA: { rosterId: number; teamName: string; gives: TradeAsset[]; receives: TradeAsset[]; netValue: number };
  teamB: { rosterId: number; teamName: string; gives: TradeAsset[]; receives: TradeAsset[]; netValue: number };
  fairness: number;
  rationale: string;
}

const PICK_VALUES: Record<number, number> = { 1: 7000, 2: 4500, 3: 2500, 4: 1500 };

function normalizeForMatch(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '').replace(/^(jr|sr|ii|iii|iv)$/, '');
}

function getTeamAssets(
  team: LeagueTeam,
  ktcByName: Map<string, KTCPlayer>,
  picks: DraftPick[],
  projBySleeperIdMap?: Map<string, number>,
): TradeAsset[] {
  const assets: TradeAsset[] = [];
  const allPlayers = [...team.starters, ...team.bench].filter(
    (p) => p.name !== 'Empty' && p.position && p.position !== 'DEF',
  );

  for (const p of allPlayers) {
    const k = ktcByName.get(normalizeForMatch(p.name));
    if (k && k.value > 0) {
      assets.push({
        type: 'player',
        name: p.name,
        value: k.value,
        age: k.age,
        position: p.position,
        sleeperId: p.id,
        projPts: projBySleeperIdMap?.get(p.id),
      });
    }
  }

  for (const pick of picks) {
    const val = PICK_VALUES[pick.round] ?? 1000;
    assets.push({
      type: 'pick',
      name: `${pick.season} Rd ${pick.round}`,
      value: val,
      pick,
    });
  }

  assets.sort((a, b) => b.value - a.value);
  return assets;
}

function isTradableForGoal(asset: TradeAsset, goal: TradeGoal, teamAssets: TradeAsset[]): boolean {
  if (asset.type === 'pick') {
    // Rebuilders keep picks; win-now teams trade them away
    return goal === 'win-now' || goal === 'balanced';
  }

  // Never trade your top 3 most valuable players if win-now
  if (goal === 'win-now') {
    const playerAssets = teamAssets.filter((a) => a.type === 'player');
    const topN = playerAssets.slice(0, 3);
    if (topN.find((a) => a.name === asset.name)) return false;
  }

  if (!asset.age) return false;

  if (goal === 'win-now') {
    // Win-now trades away young unproven guys (age ≤ 23) or aging depth (low-value aging)
    return asset.age <= 23 || (asset.age >= 30 && asset.value < 3000);
  }
  if (goal === 'rebuild') {
    // Rebuild trades away prime/aging players for youth and picks
    return asset.age >= 27;
  }
  // Balanced: trade mid-value players
  return asset.value < 5000;
}

function isDesirableForGoal(asset: TradeAsset, goal: TradeGoal): boolean {
  if (asset.type === 'pick') return goal === 'rebuild';
  if (!asset.age) return true;
  if (goal === 'win-now') return asset.age >= 24 && asset.age <= 30;
  if (goal === 'rebuild') return asset.age <= 25;
  return true;
}

export function buildPickOwnership(
  teams: LeagueTeam[],
  tradedPicks: SleeperTradedPick[],
  season = '2027',
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

  return map;
}

export function generateTradeSuggestions(
  teams: LeagueTeam[],
  ktc: KTCPlayer[],
  goals: Map<number, TradeGoal>,
  pickOwnership: Map<number, DraftPick[]>,
  myRosterId?: number,
  projBySleeperIdMap?: Map<string, number>,
  maxSuggestions = 8,
): TradeSuggestion[] {
  const ktcByName = new Map<string, KTCPlayer>();
  for (const p of ktc) ktcByName.set(normalizeForMatch(p.playerName), p);

  const teamAssets = new Map<number, TradeAsset[]>();
  for (const t of teams) {
    teamAssets.set(t.rosterId, getTeamAssets(t, ktcByName, pickOwnership.get(t.rosterId) ?? [], projBySleeperIdMap));
  }

  const suggestions: TradeSuggestion[] = [];
  const myTeam = myRosterId ? teams.find((t) => t.rosterId === myRosterId) : undefined;
  if (!myTeam) return [];

  const goalA = goals.get(myTeam.rosterId) ?? 'balanced';
  const assetsA = teamAssets.get(myTeam.rosterId) ?? [];
  const tradableA = assetsA.filter((a) => isTradableForGoal(a, goalA, assetsA) && a.value >= 1500).slice(0, 8);

  for (const teamB of teams) {
    if (teamB.rosterId === myTeam.rosterId) continue;
    const goalB = goals.get(teamB.rosterId) ?? 'balanced';
    const assetsB = teamAssets.get(teamB.rosterId) ?? [];
    const tradableB = assetsB.filter((a) => isTradableForGoal(a, goalB, assetsB) && a.value >= 1500).slice(0, 8);

    for (const giveA of tradableA) {
      for (const giveB of tradableB) {
        const rawDiff = Math.abs(giveA.value - giveB.value);
        const avgValue = (giveA.value + giveB.value) / 2;
        if (rawDiff > avgValue * 0.35) continue;

        // Both sides should want what they're getting
        const aWantsB = isDesirableForGoal(giveB, goalA);
        const bWantsA = isDesirableForGoal(giveA, goalB);
        if (!aWantsB && !bWantsA) continue;

        const fairness = Math.max(0, 100 - (rawDiff / avgValue) * 100);

        let rationale = '';
        if (giveA.type === 'pick' && giveB.type === 'player') {
          rationale = `Trade future pick for immediate production`;
        } else if (giveA.type === 'player' && giveB.type === 'pick') {
          rationale = `Sell aging asset for rebuild capital`;
        } else if (goalA === 'win-now' && (giveB.age ?? 0) >= 24) {
          rationale = `Upgrade with proven talent for win-now push`;
        } else if (goalA === 'rebuild' && (giveB.age ?? 99) <= 25) {
          rationale = `Acquire youth for long-term rebuild`;
        } else {
          rationale = `Value swap — ${giveA.position ?? 'asset'} for ${giveB.position ?? 'asset'}`;
        }

        suggestions.push({
          teamA: { rosterId: myTeam.rosterId, teamName: myTeam.teamName, gives: [giveA], receives: [giveB], netValue: giveB.value - giveA.value },
          teamB: { rosterId: teamB.rosterId, teamName: teamB.teamName, gives: [giveB], receives: [giveA], netValue: giveA.value - giveB.value },
          fairness,
          rationale,
        });
      }
    }
  }

  // Sort by: desirability for my goal first, then fairness
  suggestions.sort((a, b) => {
    const scoreA = (isDesirableForGoal(a.teamA.receives[0], goalA) ? 20 : 0) + a.fairness;
    const scoreB = (isDesirableForGoal(b.teamA.receives[0], goalA) ? 20 : 0) + b.fairness;
    return scoreB - scoreA;
  });

  const seen = new Set<string>();
  const final: TradeSuggestion[] = [];
  for (const s of suggestions) {
    const key = [
      ...s.teamA.gives.map((g) => g.name),
      ...s.teamB.gives.map((g) => g.name),
    ].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
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
