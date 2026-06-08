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
}

export interface TradeSuggestion {
  teamA: { rosterId: number; teamName: string; gives: TradeAsset[]; receives: TradeAsset[]; netValue: number };
  teamB: { rosterId: number; teamName: string; gives: TradeAsset[]; receives: TradeAsset[]; netValue: number };
  fairness: number; // 0-100, higher = more fair
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



function isGoodFit(asset: TradeAsset, goal: TradeGoal): boolean {
  if (asset.type === 'pick') return goal === 'rebuild';
  if (!asset.age) return true;
  if (goal === 'win-now') return asset.age >= 24 && asset.age <= 29;
  if (goal === 'rebuild') return asset.age <= 25;
  return true;
}

function valueFit(asset: TradeAsset, goal: TradeGoal): number {
  if (isGoodFit(asset, goal)) return asset.value * 1.15;
  return asset.value * 0.85;
}

export function buildPickOwnership(
  teams: LeagueTeam[],
  tradedPicks: SleeperTradedPick[],
  season = '2026',
): Map<number, DraftPick[]> {
  const map = new Map<number, DraftPick[]>();
  for (const t of teams) map.set(t.rosterId, []);

  // Default: each team owns their own picks (rounds 1-4)
  for (const t of teams) {
    for (let round = 1; round <= 4; round++) {
      map.get(t.rosterId)!.push({ season, round, originalOwnerId: t.rosterId, currentOwnerId: t.rosterId });
    }
  }

  // Apply trades
  for (const tp of tradedPicks) {
    if (tp.season !== season) continue;
    // Remove from previous owner
    for (const [rosterId, picks] of map) {
      const idx = picks.findIndex((p) => p.round === tp.round && p.originalOwnerId === tp.owner_id);
      if (idx >= 0 && rosterId !== tp.roster_id) {
        picks.splice(idx, 1);
      }
    }
    // Add to current owner
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
  maxSuggestions = 8,
): TradeSuggestion[] {
  const ktcByName = new Map<string, KTCPlayer>();
  for (const p of ktc) ktcByName.set(normalizeForMatch(p.playerName), p);

  const teamAssets = new Map<number, TradeAsset[]>();
  for (const t of teams) {
    teamAssets.set(t.rosterId, getTeamAssets(t, ktcByName, pickOwnership.get(t.rosterId) ?? []));
  }

  const suggestions: TradeSuggestion[] = [];
  const teamsToConsider = myRosterId ? teams.filter((t) => t.rosterId === myRosterId) : teams;
  const otherTeams = myRosterId ? teams.filter((t) => t.rosterId !== myRosterId) : teams;

  for (const teamA of teamsToConsider) {
    const goalA = goals.get(teamA.rosterId) ?? 'balanced';
    const assetsA = teamAssets.get(teamA.rosterId) ?? [];

    for (const teamB of otherTeams) {
      if (teamA.rosterId === teamB.rosterId) continue;
      const goalB = goals.get(teamB.rosterId) ?? 'balanced';
      const assetsB = teamAssets.get(teamB.rosterId) ?? [];

      // Find assets each team might trade away (poor fit for their goal)
      const tradableA = assetsA.filter((a) => !isGoodFit(a, goalA) && a.value >= 1500).slice(0, 5);
      const tradableB = assetsB.filter((a) => !isGoodFit(a, goalB) && a.value >= 1500).slice(0, 5);

      // Also include picks for rebuilders
      if (goalA === 'win-now') {
        const picks = assetsA.filter((a) => a.type === 'pick');
        for (const pk of picks) if (!tradableA.includes(pk)) tradableA.push(pk);
      }
      if (goalB === 'win-now') {
        const picks = assetsB.filter((a) => a.type === 'pick');
        for (const pk of picks) if (!tradableB.includes(pk)) tradableB.push(pk);
      }

      for (const giveA of tradableA) {
        for (const giveB of tradableB) {
          const fitAReceives = valueFit(giveB, goalA);
          const fitBReceives = valueFit(giveA, goalB);
          const rawDiff = Math.abs(giveA.value - giveB.value);
          const avgValue = (giveA.value + giveB.value) / 2;
          if (rawDiff > avgValue * 0.35) continue; // too lopsided

          const fairness = Math.max(0, 100 - (rawDiff / avgValue) * 100);
          const bothBenefit = fitAReceives > giveA.value * 0.9 && fitBReceives > giveB.value * 0.9;
          if (!bothBenefit) continue;

          let rationale = '';
          if (goalA === 'win-now' && goalB === 'rebuild') {
            rationale = `${teamA.teamName} gets proven talent; ${teamB.teamName} gets youth/picks`;
          } else if (goalA === 'rebuild' && goalB === 'win-now') {
            rationale = `${teamA.teamName} gets youth/picks; ${teamB.teamName} gets proven talent`;
          } else {
            rationale = `Positional value swap based on team needs`;
          }

          suggestions.push({
            teamA: { rosterId: teamA.rosterId, teamName: teamA.teamName, gives: [giveA], receives: [giveB], netValue: giveB.value - giveA.value },
            teamB: { rosterId: teamB.rosterId, teamName: teamB.teamName, gives: [giveB], receives: [giveA], netValue: giveA.value - giveB.value },
            fairness,
            rationale,
          });
        }
      }
    }
  }

  // Sort by fairness and diversity
  suggestions.sort((a, b) => b.fairness - a.fairness);

  // Dedupe by ensuring variety
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
