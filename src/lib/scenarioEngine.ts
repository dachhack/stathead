import type { SDIOProjection, ScenarioConfig, TeamStatKey } from '../types';
import { normName } from './nameUtils';

export function isScenarioEmpty(s: ScenarioConfig): boolean {
  return (
    s.vegasWeighting === 0 &&
    s.teamTendencies.length === 0 &&
    (s.teamVolumes ?? []).length === 0 &&
    (s.teamStatAdjustments ?? []).length === 0 &&
    s.volumeOverrides.length === 0 &&
    (s.playerAvailability ?? []).length === 0 &&
    (s.pointsOverrides ?? []).length === 0 &&
    (s.statOverrides ?? []).length === 0 &&
    s.movements.length === 0 &&
    s.customPlayers.length === 0 &&
    (s.freeAgentSignings ?? []).length === 0
  );
}

const PASSING_STAT_KEYS = new Set<TeamStatKey>([
  'PassingAttempts', 'PassingCompletions', 'PassingYards',
  'PassingTouchdowns', 'PassingInterceptions',
]);
const RUSHING_STAT_KEYS = new Set<TeamStatKey>([
  'RushingAttempts', 'RushingYards', 'RushingTouchdowns',
]);

function recalcPoints(p: SDIOProjection): { ppr: number; std: number } {
  const passing =
    (p.PassingYards || 0) * 0.04 +
    (p.PassingTouchdowns || 0) * 4 +
    (p.PassingInterceptions || 0) * -2;
  const rushing =
    (p.RushingYards || 0) * 0.1 +
    (p.RushingTouchdowns || 0) * 6;
  const recYds = (p.ReceivingYards || 0) * 0.1;
  const recTds = (p.ReceivingTouchdowns || 0) * 6;
  const fumbles = (p.FumblesLost || 0) * -2;
  const ppr = passing + rushing + (p.Receptions || 0) * 1 + recYds + recTds + fumbles;
  const std = passing + rushing + recYds + recTds + fumbles;
  return { ppr, std };
}

export function applyScenario(
  projections: SDIOProjection[],
  scenario: ScenarioConfig
): SDIOProjection[] {
  if (isScenarioEmpty(scenario)) return projections;

  let result = projections.map((p) => ({ ...p }));

  // Player-specific levers are stored with the PlayerID of whichever
  // surface created them (Projections tab ids, SDIO ids, synthetic kit
  // ids — all different id spaces). Resolve by id first, then fall back
  // to normalized name + position (then unambiguous name) so a scenario
  // saved on one surface still hits its players on another.
  const byNamePos = new Map<string, SDIOProjection>();
  const byNameOnly = new Map<string, SDIOProjection | null>(); // null = ambiguous
  for (const p of result) {
    const n = normName(p.Name);
    if (!n) continue;
    byNamePos.set(`${n}|${p.Position}`, p);
    byNameOnly.set(n, byNameOnly.has(n) ? null : p);
  }
  const findPlayer = (playerId: number, playerName?: string, position?: string): SDIOProjection | undefined => {
    const byId = result.find((p) => p.PlayerID === playerId);
    if (byId) return byId;
    if (!playerName) return undefined;
    const n = normName(playerName);
    if (position) {
      const hit = byNamePos.get(`${n}|${position}`);
      if (hit) return hit;
    }
    return byNameOnly.get(n) ?? undefined;
  };

  // 1. Player movements — reassign team before applying tendencies
  for (const move of scenario.movements) {
    const player = findPlayer(move.playerId, move.playerName);
    if (player) player.Team = move.toTeam;
  }

  // 2. Team tendencies — adjust pass/run balance
  for (const tendency of scenario.teamTendencies) {
    if (tendency.passRatioDelta === 0) continue;
    // +10 passRatioDelta → ~8% boost to passing volume, ~10% reduction to rushing
    const passBoost = tendency.passRatioDelta * 0.008;
    const rushCut = tendency.passRatioDelta * 0.010;

    for (const player of result.filter((p) => p.Team === tendency.team)) {
      if (player.Position === 'QB') {
        player.PassingAttempts = (player.PassingAttempts || 0) * (1 + passBoost);
        player.PassingCompletions = (player.PassingCompletions || 0) * (1 + passBoost);
        player.PassingYards = (player.PassingYards || 0) * (1 + passBoost);
        player.PassingTouchdowns = (player.PassingTouchdowns || 0) * (1 + passBoost);
        // INTs scale less aggressively
        player.PassingInterceptions = (player.PassingInterceptions || 0) * (1 + passBoost * 0.5);
      } else if (player.Position === 'WR' || player.Position === 'TE') {
        player.Receptions = (player.Receptions || 0) * (1 + passBoost);
        player.ReceivingYards = (player.ReceivingYards || 0) * (1 + passBoost);
        player.ReceivingTouchdowns = (player.ReceivingTouchdowns || 0) * (1 + passBoost);
      } else if (player.Position === 'RB') {
        player.RushingAttempts = (player.RushingAttempts || 0) * (1 - rushCut);
        player.RushingYards = (player.RushingYards || 0) * (1 - rushCut);
        player.RushingTouchdowns = (player.RushingTouchdowns || 0) * (1 - rushCut);
        // Slight check-down boost in pass-heavy schemes
        player.Receptions = (player.Receptions || 0) * (1 + passBoost * 0.3);
        player.ReceivingYards = (player.ReceivingYards || 0) * (1 + passBoost * 0.3);
      }
      const { ppr, std } = recalcPoints(player);
      player.FantasyPointsPPR = ppr;
      player.FantasyPoints = std;
    }
  }

  // 2.5. Team volume — scale the entire team's output (total pie size)
  for (const tv of (scenario.teamVolumes ?? [])) {
    if (tv.volumeDelta === 0) continue;
    const f = 1 + tv.volumeDelta / 100;
    for (const player of result.filter((p) => p.Team === tv.team)) {
      if (player.Position === 'QB') {
        player.PassingAttempts = (player.PassingAttempts || 0) * f;
        player.PassingCompletions = (player.PassingCompletions || 0) * f;
        player.PassingYards = (player.PassingYards || 0) * f;
        player.PassingTouchdowns = (player.PassingTouchdowns || 0) * f;
        player.PassingInterceptions = (player.PassingInterceptions || 0) * f;
      }
      player.RushingAttempts = (player.RushingAttempts || 0) * f;
      player.RushingYards = (player.RushingYards || 0) * f;
      player.RushingTouchdowns = (player.RushingTouchdowns || 0) * f;
      player.Receptions = (player.Receptions || 0) * f;
      player.ReceivingYards = (player.ReceivingYards || 0) * f;
      player.ReceivingTouchdowns = (player.ReceivingTouchdowns || 0) * f;
      const { ppr, std } = recalcPoints(player);
      player.FantasyPointsPPR = ppr;
      player.FantasyPoints = std;
    }
  }

  // 2.75. Team stat adjustments — targeted per-stat overrides
  for (const adj of (scenario.teamStatAdjustments ?? [])) {
    if (adj.delta === 0) continue;
    const f = 1 + adj.delta / 100;
    const isPassStat = PASSING_STAT_KEYS.has(adj.stat);
    const isRushStat = RUSHING_STAT_KEYS.has(adj.stat);
    const isRecStat = !isPassStat && !isRushStat;

    for (const player of result.filter((p) => p.Team === adj.team)) {
      const applies =
        (isPassStat && player.Position === 'QB') ||
        (isRushStat && player.Position !== 'K') ||
        (isRecStat && (player.Position === 'RB' || player.Position === 'WR' || player.Position === 'TE'));
      if (!applies) continue;
       
      (player as unknown as Record<string, number>)[adj.stat] = ((player as unknown as Record<string, number>)[adj.stat] || 0) * f;
      const { ppr, std } = recalcPoints(player);
      player.FantasyPointsPPR = ppr;
      player.FantasyPoints = std;
    }
  }

  // 3. Player volume overrides — zero-sum share redistribution within team pools
  // Compute base pool totals (after team adjustments, before individual overrides)
  const teamRushPool = new Map<string, number>();
  const teamRecPool = new Map<string, number>();
  for (const p of result) {
    // Players without a team (e.g. synthetic rows that couldn't resolve
    // one) must not pool together as a giant '' pseudo-team — their
    // overrides still apply directly, just without redistribution.
    if (!p.Team) continue;
    if (p.Position === 'RB') {
      teamRushPool.set(p.Team, (teamRushPool.get(p.Team) ?? 0) + (p.RushingAttempts || 0));
    }
    if (p.Position !== 'QB' && p.Position !== 'K') {
      teamRecPool.set(p.Team, (teamRecPool.get(p.Team) ?? 0) + (p.Receptions || 0));
    }
  }

  // Track how much each team's pool shifts due to overrides
  const rushOrigOvr = new Map<string, number>();
  const rushNewOvr = new Map<string, number>();
  const recOrigOvr = new Map<string, number>();
  const recNewOvr = new Map<string, number>();
  const overriddenPlayers = new Set<SDIOProjection>();
  for (const override of scenario.volumeOverrides) {
    const player = findPlayer(override.playerId, override.playerName, override.position);
    if (!player) continue;
    overriddenPlayers.add(player);
    const rushF = 1 + (override.rushDelta ?? override.volumeDelta) / 100;
    const recF = 1 + (override.recDelta ?? override.volumeDelta) / 100;
    if (player.Position === 'RB') {
      rushOrigOvr.set(player.Team, (rushOrigOvr.get(player.Team) ?? 0) + (player.RushingAttempts || 0));
      rushNewOvr.set(player.Team, (rushNewOvr.get(player.Team) ?? 0) + (player.RushingAttempts || 0) * rushF);
    }
    if (player.Position !== 'QB' && player.Position !== 'K') {
      recOrigOvr.set(player.Team, (recOrigOvr.get(player.Team) ?? 0) + (player.Receptions || 0));
      recNewOvr.set(player.Team, (recNewOvr.get(player.Team) ?? 0) + (player.Receptions || 0) * recF);
    }
  }

  // Boost overridden players (per-stat deltas override the blanket volumeDelta)
  for (const override of scenario.volumeOverrides) {
    const player = findPlayer(override.playerId, override.playerName, override.position);
    if (!player) continue;
    const rushF = 1 + (override.rushDelta ?? override.volumeDelta) / 100;
    const recF = 1 + (override.recDelta ?? override.volumeDelta) / 100;
    const passF = 1 + (override.passDelta ?? override.volumeDelta) / 100;
    if (player.Position === 'QB') {
      player.PassingAttempts = (player.PassingAttempts || 0) * passF;
      player.PassingCompletions = (player.PassingCompletions || 0) * passF;
      player.PassingYards = (player.PassingYards || 0) * passF;
      player.PassingTouchdowns = (player.PassingTouchdowns || 0) * passF;
      player.RushingAttempts = (player.RushingAttempts || 0) * rushF;
      player.RushingYards = (player.RushingYards || 0) * rushF;
      player.RushingTouchdowns = (player.RushingTouchdowns || 0) * rushF;
    } else {
      player.Receptions = (player.Receptions || 0) * recF;
      player.ReceivingYards = (player.ReceivingYards || 0) * recF;
      player.ReceivingTouchdowns = (player.ReceivingTouchdowns || 0) * recF;
      if (player.Position === 'RB') {
        player.RushingAttempts = (player.RushingAttempts || 0) * rushF;
        player.RushingYards = (player.RushingYards || 0) * rushF;
        player.RushingTouchdowns = (player.RushingTouchdowns || 0) * rushF;
      }
    }
    const { ppr, std } = recalcPoints(player);
    player.FantasyPointsPPR = ppr;
    player.FantasyPoints = std;
  }

  // Scale down non-overridden players to keep team totals the same
  for (const player of result) {
    if (overriddenPlayers.has(player)) continue;
    if (player.Position === 'QB' || player.Position === 'K') continue;

    let rushSc = 1;
    if (player.Position === 'RB') {
      const total = teamRushPool.get(player.Team) ?? 0;
      const origOvr = rushOrigOvr.get(player.Team) ?? 0;
      const newOvr = rushNewOvr.get(player.Team) ?? 0;
      if (origOvr > 0 && total - origOvr > 0) {
        rushSc = Math.max(0, (total - newOvr) / (total - origOvr));
      }
    }

    let recSc = 1;
    {
      const total = teamRecPool.get(player.Team) ?? 0;
      const origOvr = recOrigOvr.get(player.Team) ?? 0;
      const newOvr = recNewOvr.get(player.Team) ?? 0;
      if (origOvr > 0 && total - origOvr > 0) {
        recSc = Math.max(0, (total - newOvr) / (total - origOvr));
      }
    }

    if (rushSc !== 1) {
      player.RushingAttempts = (player.RushingAttempts || 0) * rushSc;
      player.RushingYards = (player.RushingYards || 0) * rushSc;
      player.RushingTouchdowns = (player.RushingTouchdowns || 0) * rushSc;
    }
    if (recSc !== 1) {
      player.Receptions = (player.Receptions || 0) * recSc;
      player.ReceivingYards = (player.ReceivingYards || 0) * recSc;
      player.ReceivingTouchdowns = (player.ReceivingTouchdowns || 0) * recSc;
    }
    if (rushSc !== 1 || recSc !== 1) {
      const { ppr, std } = recalcPoints(player);
      player.FantasyPointsPPR = ppr;
      player.FantasyPoints = std;
    }
  }

  // 3.4. Stat overrides — set specific absolute counting-stat values.
  // Applied before availability/points so a games haircut and a PPR target
  // still layer on top of the user's exact numbers. Non-zero-sum.
  const STAT_OVERRIDE_KEYS: (keyof SDIOProjection)[] = [
    'PassingAttempts', 'PassingCompletions', 'PassingYards', 'PassingTouchdowns', 'PassingInterceptions',
    'RushingAttempts', 'RushingYards', 'RushingTouchdowns',
    'Receptions', 'ReceivingYards', 'ReceivingTouchdowns',
  ];
  for (const so of (scenario.statOverrides ?? [])) {
    const player = findPlayer(so.playerId, so.playerName, so.position);
    if (!player) continue;
    let changed = false;
    for (const k of STAT_OVERRIDE_KEYS) {
      const v = (so as unknown as Record<string, number | undefined>)[k];
      if (v !== undefined) { (player as unknown as Record<string, number>)[k] = v; changed = true; }
    }
    if (!changed) continue;
    const { ppr, std } = recalcPoints(player);
    player.FantasyPointsPPR = ppr;
    player.FantasyPoints = std;
  }

  // 3.5. Player availability — per-player games haircut (non-zero-sum)
  // Scale a player's counting stats by games/17. Unlike volume overrides this
  // does NOT redistribute to teammates: the games are simply lost (an injury
  // discount). Applied after volume redistribution so it haircuts final volume.
  for (const avail of (scenario.playerAvailability ?? [])) {
    if (avail.games >= 17) continue;
    const f = Math.max(0, Math.min(1, avail.games / 17));
    const player = findPlayer(avail.playerId, avail.playerName, avail.position);
    if (!player) continue;
    player.PassingAttempts = (player.PassingAttempts || 0) * f;
    player.PassingCompletions = (player.PassingCompletions || 0) * f;
    player.PassingYards = (player.PassingYards || 0) * f;
    player.PassingTouchdowns = (player.PassingTouchdowns || 0) * f;
    player.PassingInterceptions = (player.PassingInterceptions || 0) * f;
    player.RushingAttempts = (player.RushingAttempts || 0) * f;
    player.RushingYards = (player.RushingYards || 0) * f;
    player.RushingTouchdowns = (player.RushingTouchdowns || 0) * f;
    player.Receptions = (player.Receptions || 0) * f;
    player.ReceivingYards = (player.ReceivingYards || 0) * f;
    player.ReceivingTouchdowns = (player.ReceivingTouchdowns || 0) * f;
    const { ppr, std } = recalcPoints(player);
    player.FantasyPointsPPR = ppr;
    player.FantasyPoints = std;
  }

  // 3.7. Points overrides — set a player to an absolute PPR target.
  // Scale all counting stats by target/current so the stat line stays
  // internally consistent and PPR lands on the target. Non-zero-sum (used by
  // the "Consensus" preset to blend toward an external projection set).
  for (const po of (scenario.pointsOverrides ?? [])) {
    const player = findPlayer(po.playerId, po.playerName, po.position);
    if (!player) continue;
    const cur = recalcPoints(player).ppr;
    if (cur <= 0 || po.ppr < 0) continue;
    const f = po.ppr / cur;
    player.PassingAttempts = (player.PassingAttempts || 0) * f;
    player.PassingCompletions = (player.PassingCompletions || 0) * f;
    player.PassingYards = (player.PassingYards || 0) * f;
    player.PassingTouchdowns = (player.PassingTouchdowns || 0) * f;
    player.PassingInterceptions = (player.PassingInterceptions || 0) * f;
    player.RushingAttempts = (player.RushingAttempts || 0) * f;
    player.RushingYards = (player.RushingYards || 0) * f;
    player.RushingTouchdowns = (player.RushingTouchdowns || 0) * f;
    player.Receptions = (player.Receptions || 0) * f;
    player.ReceivingYards = (player.ReceivingYards || 0) * f;
    player.ReceivingTouchdowns = (player.ReceivingTouchdowns || 0) * f;
    const { ppr, std } = recalcPoints(player);
    player.FantasyPointsPPR = ppr;
    player.FantasyPoints = std;
  }

  // 4. Vegas weighting — regression toward position mean
  // Simulates market-efficiency compression: high-upside projections regress
  // toward the mean at the rate specified (0% = no change, 50% = halfway to mean)
  if (scenario.vegasWeighting > 0) {
    const factor = scenario.vegasWeighting / 100;
    const posGroups: Record<string, number[]> = {};
    for (const p of result) {
      if (!posGroups[p.Position]) posGroups[p.Position] = [];
      posGroups[p.Position].push(p.FantasyPointsPPR || 0);
    }
    const posMeans: Record<string, number> = {};
    for (const [pos, vals] of Object.entries(posGroups)) {
      posMeans[pos] = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    result = result.map((p) => {
      const mean = posMeans[p.Position] || 0;
      const ppr = (p.FantasyPointsPPR || 0) + (mean - (p.FantasyPointsPPR || 0)) * factor;
      const std = (p.FantasyPoints || 0) + (mean - (p.FantasyPoints || 0)) * factor;
      return { ...p, FantasyPointsPPR: ppr, FantasyPoints: std };
    });
  }

  // 5. Custom players — inject as new rows
  let cpIdx = 100000;
  for (const cp of scenario.customPlayers) {
    result.push({
      PlayerID: -(cpIdx++),
      Name: `★ ${cp.name}`,
      Team: cp.team || 'FA',
      Position: cp.position,
      FantasyPointsPPR: cp.fantasyPointsPPR,
      FantasyPoints: cp.fantasyPoints,
      PassingAttempts: 0,
      PassingCompletions: 0,
      PassingYards: 0,
      PassingTouchdowns: 0,
      PassingInterceptions: 0,
      RushingAttempts: 0,
      RushingYards: 0,
      RushingTouchdowns: 0,
      Receptions: 0,
      ReceivingYards: 0,
      ReceivingTouchdowns: 0,
      FumblesLost: 0,
      FieldGoalsMade: 0,
      ExtraPointsMade: 0,
    });
  }

  // 6. Free agent signings — inject with scaled prior-season stats
  // Stats are scaled from priorGames → FA_PROJ_GAMES with regression
  const FA_PROJ_GAMES = 14;
  const FA_REG = 0.85;
  for (const fa of (scenario.freeAgentSignings ?? [])) {
    const scale = fa.priorGames > 0 ? (FA_PROJ_GAMES / fa.priorGames) * FA_REG : 0;
    const passAtt = Math.round(fa.passAtt * scale);
    const passComp = Math.round(fa.passComp * scale);
    const passYds = Math.round(fa.passYds * scale);
    const passTD = Math.round(fa.passTD * scale);
    const passInt = Math.round(fa.int * scale);
    const rushAtt = Math.round(fa.rushAtt * scale);
    const rushYds = Math.round(fa.rushYds * scale);
    const rushTD = Math.round(fa.rushTD * scale);
    const rec = Math.round(fa.rec * scale);
    const recYds = Math.round(fa.recYds * scale);
    const recTD = Math.round(fa.recTD * scale);
    const { ppr, std } = recalcPoints({
      PassingYards: passYds, PassingTouchdowns: passTD, PassingInterceptions: passInt,
      RushingYards: rushYds, RushingTouchdowns: rushTD,
      Receptions: rec, ReceivingYards: recYds, ReceivingTouchdowns: recTD,
      FumblesLost: 0,
    } as SDIOProjection);
    result.push({
      PlayerID: -(cpIdx++),
      Name: `★ ${fa.name}`,
      Team: fa.toTeam,
      Position: fa.position,
      FantasyPointsPPR: ppr,
      FantasyPoints: std,
      PassingAttempts: passAtt,
      PassingCompletions: passComp,
      PassingYards: passYds,
      PassingTouchdowns: passTD,
      PassingInterceptions: passInt,
      RushingAttempts: rushAtt,
      RushingYards: rushYds,
      RushingTouchdowns: rushTD,
      Receptions: rec,
      ReceivingYards: recYds,
      ReceivingTouchdowns: recTD,
      FumblesLost: 0,
      FieldGoalsMade: 0,
      ExtraPointsMade: 0,
    });
  }

  return result;
}

export function saveScenario(scenario: ScenarioConfig): void {
  const all = loadAllScenarios();
  const idx = all.findIndex((s) => s.id === scenario.id);
  if (idx >= 0) {
    all[idx] = scenario;
  } else {
    all.push(scenario);
  }
  localStorage.setItem('stathead-scenarios', JSON.stringify(all));
}

export function loadAllScenarios(): ScenarioConfig[] {
  try {
    const raw = localStorage.getItem('stathead-scenarios');
    return raw ? (JSON.parse(raw) as ScenarioConfig[]) : [];
  } catch {
    return [];
  }
}

export function deleteScenario(id: string): void {
  const all = loadAllScenarios().filter((s) => s.id !== id);
  localStorage.setItem('stathead-scenarios', JSON.stringify(all));
}

export function createEmptyScenario(): ScenarioConfig {
  return {
    id: `scenario-${Date.now()}`,
    name: 'New Scenario',
    vegasWeighting: 0,
    teamTendencies: [],
    teamVolumes: [],
    teamStatAdjustments: [],
    volumeOverrides: [],
    movements: [],
    customPlayers: [],
    freeAgentSignings: [],
    playerAvailability: [],
    pointsOverrides: [],
    statOverrides: [],
  };
}
