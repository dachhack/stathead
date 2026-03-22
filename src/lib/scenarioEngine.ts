import type { SDIOProjection, ScenarioConfig, TeamStatKey } from '../types';

export function isScenarioEmpty(s: ScenarioConfig): boolean {
  return (
    s.vegasWeighting === 0 &&
    s.teamTendencies.length === 0 &&
    (s.teamVolumes ?? []).length === 0 &&
    (s.teamStatAdjustments ?? []).length === 0 &&
    s.volumeOverrides.length === 0 &&
    s.movements.length === 0 &&
    s.customPlayers.length === 0
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

  // 1. Player movements — reassign team before applying tendencies
  for (const move of scenario.movements) {
    const player = result.find((p) => p.PlayerID === move.playerId);
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  for (const override of scenario.volumeOverrides) {
    const player = result.find((p) => p.PlayerID === override.playerId);
    if (!player) continue;
    const factor = 1 + override.volumeDelta / 100;
    if (player.Position === 'RB') {
      rushOrigOvr.set(player.Team, (rushOrigOvr.get(player.Team) ?? 0) + (player.RushingAttempts || 0));
      rushNewOvr.set(player.Team, (rushNewOvr.get(player.Team) ?? 0) + (player.RushingAttempts || 0) * factor);
    }
    if (player.Position !== 'QB' && player.Position !== 'K') {
      recOrigOvr.set(player.Team, (recOrigOvr.get(player.Team) ?? 0) + (player.Receptions || 0));
      recNewOvr.set(player.Team, (recNewOvr.get(player.Team) ?? 0) + (player.Receptions || 0) * factor);
    }
  }

  const overriddenIds = new Set(scenario.volumeOverrides.map((v) => v.playerId));

  // Boost overridden players
  for (const override of scenario.volumeOverrides) {
    const player = result.find((p) => p.PlayerID === override.playerId);
    if (!player) continue;
    const factor = 1 + override.volumeDelta / 100;
    if (player.Position === 'QB') {
      player.PassingAttempts = (player.PassingAttempts || 0) * factor;
      player.PassingCompletions = (player.PassingCompletions || 0) * factor;
      player.PassingYards = (player.PassingYards || 0) * factor;
      player.PassingTouchdowns = (player.PassingTouchdowns || 0) * factor;
    } else {
      player.Receptions = (player.Receptions || 0) * factor;
      player.ReceivingYards = (player.ReceivingYards || 0) * factor;
      player.ReceivingTouchdowns = (player.ReceivingTouchdowns || 0) * factor;
      if (player.Position === 'RB') {
        player.RushingAttempts = (player.RushingAttempts || 0) * factor;
        player.RushingYards = (player.RushingYards || 0) * factor;
        player.RushingTouchdowns = (player.RushingTouchdowns || 0) * factor;
      }
    }
    const { ppr, std } = recalcPoints(player);
    player.FantasyPointsPPR = ppr;
    player.FantasyPoints = std;
  }

  // Scale down non-overridden players to keep team totals the same
  for (const player of result) {
    if (overriddenIds.has(player.PlayerID)) continue;
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
  };
}
