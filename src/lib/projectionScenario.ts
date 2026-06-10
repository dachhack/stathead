/**
 * Projection scenarios — apply the Scenario Builder's quick presets and the
 * user's saved scenarios to the Clay/Consensus projected points shown in the
 * Sleeper League View and player-card rosters.
 *
 * Those surfaces work off Clay projections (ClayPlayer + computePpr), while the
 * scenario engine operates on SDIOProjection stat lines. ClayPlayer carries the
 * same counting stats, and scenarioEngine.recalcPoints reproduces computePpr
 * exactly, so we bridge Clay -> SDIOProjection, run the real applyScenario /
 * preset machinery, and read the adjusted FantasyPointsPPR back out. This is
 * the same engine the Projections tab uses, so results stay consistent — and it
 * needs no SportsDataIO key (works in the public deploy).
 */
import type { ScenarioConfig, SDIOProjection, SleeperPlayer } from '../types';
import type { ClayPlayer } from './waiverUtils';
import { computePpr } from './waiverUtils';
import { applyScenario, isScenarioEmpty, loadAllScenarios } from './scenarioEngine';
import { SCENARIO_PRESETS, type PresetMeta, type PlayerMeta, type ClayStats } from './scenarioPresets';
import { normalizeForMatch } from './nameMatch';

export interface ProjectionScenarioOption {
  id: string;
  name: string;
  kind: 'preset' | 'saved';
}

/** All Scenario Builder quick presets + the user's saved scenarios. */
export function listProjectionScenarios(): ProjectionScenarioOption[] {
  const presets: ProjectionScenarioOption[] = SCENARIO_PRESETS
    .map((p) => ({ id: p.id, name: p.name, kind: 'preset' as const }));
  const saved: ProjectionScenarioOption[] = loadAllScenarios()
    .map((s) => ({ id: s.id, name: s.name, kind: 'saved' as const }));
  return [...presets, ...saved];
}

/** Rookie/age metadata for the presets, from the Sleeper players map. */
export function buildPresetMeta(sleeper: Map<string, SleeperPlayer>): PresetMeta {
  const meta: PresetMeta = new Map<string, PlayerMeta>();
  for (const p of sleeper.values()) {
    if (!p.full_name) continue;
    const yearsExp = typeof p.years_exp === 'number' ? p.years_exp : null;
    meta.set(normalizeForMatch(p.full_name), {
      isRookie: yearsExp === 0,
      yearsExp,
      age: typeof p.age === 'number' && p.age > 0 ? p.age : null,
      priorGames: null,
    });
  }
  return meta;
}

// ClayPlayer -> SDIOProjection. recalcPoints uses Passing/Rushing/Receiving
// yards+TDs, Receptions, INTs and fumbles; Clay lacks INT/fumbles (computePpr
// ignores them too), so the bridged base PPR matches computePpr exactly.
function claysToSdio(clay: ClayPlayer[]): SDIOProjection[] {
  const zero = {
    PassingAttempts: 0, PassingCompletions: 0, PassingYards: 0, PassingTouchdowns: 0,
    PassingInterceptions: 0, RushingAttempts: 0, RushingYards: 0, RushingTouchdowns: 0,
    Targets: 0, Receptions: 0, ReceivingYards: 0, ReceivingTouchdowns: 0,
    FumblesLost: 0, FieldGoalsMade: 0, ExtraPointsMade: 0,
  };
  let id = 1;
  return clay.map((c) => {
    // Scale stat components to the blended total so applyScenario's recompute
    // stays consistent with computePpr (which already returns the blend).
    const s = c.blendScale ?? 1;
    return {
      ...zero,
      PlayerID: id++,
      Name: c.name,
      Team: c.team,
      Position: c.position,
      FantasyPoints: 0,
      FantasyPointsPPR: computePpr(c),
      PassingYards: c.pass_yds * s, PassingTouchdowns: c.pass_td * s,
      RushingYards: c.rush_yds * s, RushingTouchdowns: c.rush_td * s,
      Receptions: c.rec * s, ReceivingYards: c.rec_yds * s, ReceivingTouchdowns: c.rec_td * s,
    };
  }) as SDIOProjection[];
}

function resolveScenario(clay: ClayPlayer[], sdio: SDIOProjection[], optionId: string, meta: PresetMeta): ScenarioConfig | null {
  const preset = SCENARIO_PRESETS.find((p) => p.id === optionId);
  if (preset) {
    const clayPpr = new Map<string, number>();
    const clayStats = new Map<string, ClayStats>();
    for (const c of clay) {
      const key = normalizeForMatch(c.name);
      clayPpr.set(key, computePpr(c));
      clayStats.set(key, {
        position: c.position, pos_rk: 0, ppr: computePpr(c),
        pass_yds: c.pass_yds, pass_td: c.pass_td,
        rush_yds: c.rush_yds, rush_td: c.rush_td,
        rec: c.rec, rec_yds: c.rec_yds, rec_td: c.rec_td,
      });
    }
    return preset.build(sdio, meta, normalizeForMatch, { clayPpr, clayStats });
  }
  return loadAllScenarios().find((s) => s.id === optionId) ?? null;
}

/**
 * Adjusted PPR by normalized name for a selected preset/scenario, or null when
 * nothing is selected / the scenario is empty (callers fall back to base PPR).
 */
export function buildScenarioPprByName(
  clay: ClayPlayer[],
  optionId: string,
  meta: PresetMeta,
): Map<string, number> | null {
  if (!optionId || !clay.length) return null;
  const sdio = claysToSdio(clay);
  const scenario = resolveScenario(clay, sdio, optionId, meta);
  if (!scenario || isScenarioEmpty(scenario)) return null;
  const adjusted = applyScenario(sdio, scenario);
  const out = new Map<string, number>();
  for (const p of adjusted) out.set(normalizeForMatch(p.Name), p.FantasyPointsPPR ?? 0);
  return out;
}
