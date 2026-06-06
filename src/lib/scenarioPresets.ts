import type {
  SDIOProjection,
  ScenarioConfig,
  VolumeOverride,
  PlayerAvailability,
} from '../types';
import { createEmptyScenario } from './scenarioEngine';

// Per-player metadata used to generate opinionated preset tilts. Keyed by
// normalized player name. Built in StatProjections (where draft / roster /
// prior-season data already live) and passed down to the ScenarioBuilder.
export interface PlayerMeta {
  isRookie: boolean;
  yearsExp: number | null;  // 0 = rookie; null = unknown
  age: number | null;       // projected-season age; null = unknown
  priorGames: number | null; // games played last season; null = unknown / no prior
}

export type PresetMeta = Map<string, PlayerMeta>;

// A preset is a factory: given the live projection pool + metadata it produces
// a ready-to-apply ScenarioConfig built entirely from existing scenario levers.
export interface ScenarioPreset {
  id: string;
  name: string;
  description: string;
  build: (
    players: SDIOProjection[],
    meta: PresetMeta,
    normalize: (s: string) => string,
  ) => ScenarioConfig;
}

const SKILL = new Set(['RB', 'WR', 'TE']);

function base(name: string): ScenarioConfig {
  return { ...createEmptyScenario(), name };
}

function isRookie(p: SDIOProjection, meta: PresetMeta, norm: (s: string) => string): boolean {
  const m = meta.get(norm(p.Name));
  if (!m) return false;
  return m.isRookie || m.yearsExp === 0;
}

function isVet(p: SDIOProjection, meta: PresetMeta, norm: (s: string) => string): boolean {
  const m = meta.get(norm(p.Name));
  if (!m) return false;
  if (m.yearsExp != null && m.yearsExp >= 3) return true;
  if (m.age != null && m.age >= 27) return true;
  return false;
}

function vol(p: SDIOProjection, deltas: Partial<VolumeOverride>): VolumeOverride {
  return {
    playerId: p.PlayerID,
    playerName: p.Name,
    team: p.Team,
    position: p.Position,
    volumeDelta: 0,
    ...deltas,
  };
}

// ── Rookie optimistic ──────────────────────────────────────────────
// Tilt the player pie toward first-year players. Zero-sum volume overrides
// boost rookie RB/WR/TE over their veteran teammates; rookie QBs get a
// modest pass + rush bump (rushing upside is the rookie-QB fantasy edge).
const rookieOptimistic: ScenarioPreset = {
  id: 'preset-rookie-optimistic',
  name: 'Rookie optimistic',
  description: 'Boost first-year RB/WR/TE volume (+20%) and rookie-QB rushing — bet on the youth movement.',
  build: (players, meta, norm) => {
    const sc = base('Rookie optimistic');
    const overrides: VolumeOverride[] = [];
    for (const p of players) {
      if (!isRookie(p, meta, norm)) continue;
      if (SKILL.has(p.Position)) {
        overrides.push(vol(p, { volumeDelta: 20 }));
      } else if (p.Position === 'QB') {
        overrides.push(vol(p, { passDelta: 10, rushDelta: 15 }));
      }
    }
    sc.volumeOverrides = overrides;
    return sc;
  },
};

// ── Vet optimistic ─────────────────────────────────────────────────
// Inverse tilt: fade rookies, lean on established veterans (3+ years or
// age 27+). Boosting vets and trimming rookies lets the engine's zero-sum
// redistribution hand vets the freed-up share.
const vetOptimistic: ScenarioPreset = {
  id: 'preset-vet-optimistic',
  name: 'Vet optimistic',
  description: 'Lean on established vets (+15%) and fade rookies (-12%) — proven production over upside.',
  build: (players, meta, norm) => {
    const sc = base('Vet optimistic');
    const overrides: VolumeOverride[] = [];
    for (const p of players) {
      if (!SKILL.has(p.Position) && p.Position !== 'QB') continue;
      if (isRookie(p, meta, norm)) {
        if (SKILL.has(p.Position)) overrides.push(vol(p, { volumeDelta: -12 }));
      } else if (isVet(p, meta, norm) && SKILL.has(p.Position)) {
        overrides.push(vol(p, { volumeDelta: 15 }));
      }
    }
    sc.volumeOverrides = overrides;
    return sc;
  },
};

// ── Injury skeptic ─────────────────────────────────────────────────
// Discount oft-injured / aging players via the per-player games haircut.
// Risk signal: age and prior-season games played. Tiered so the most
// fragile profiles take the bigger cut.
const injurySkeptic: ScenarioPreset = {
  id: 'preset-injury-skeptic',
  name: 'Injury skeptic',
  description: 'Haircut games for aging / oft-injured players (high risk → 11 games, moderate → 13) via the availability lever.',
  build: (players, meta, norm) => {
    const sc = base('Injury skeptic');
    const avail: PlayerAvailability[] = [];
    for (const p of players) {
      if (p.Position === 'K') continue;
      const m = meta.get(norm(p.Name));
      if (!m) continue;
      if (m.isRookie || m.yearsExp === 0) continue; // no prior availability signal
      const age = m.age;
      const pg = m.priorGames;
      let games: number | null = null;
      // High risk: clearly aged or missed a large chunk last year.
      if ((age != null && age >= 32) || (pg != null && pg <= 9)) {
        games = 11;
      // Moderate risk: getting older or a partial season missed.
      } else if ((age != null && age >= 30) || (pg != null && pg <= 12)) {
        games = 13;
      }
      if (games != null) {
        avail.push({
          playerId: p.PlayerID,
          playerName: p.Name,
          team: p.Team,
          position: p.Position,
          games,
        });
      }
    }
    sc.playerAvailability = avail;
    return sc;
  },
};

// ── Consensus ──────────────────────────────────────────────────────
// Market-compression tilt toward position means. NOTE: this is NOT Clay /
// industry data (which is licensed and kept offline) — our base projection is
// already consensus-calibrated, and this preset simply regresses upside toward
// the mean to mimic a conservative, market-efficient view.
const consensus: ScenarioPreset = {
  id: 'preset-consensus',
  name: 'Consensus',
  description: 'Regress projections 25% toward position means — a conservative, market-efficient (not Clay) view.',
  build: () => {
    const sc = base('Consensus');
    sc.vegasWeighting = 25;
    return sc;
  },
};

export const SCENARIO_PRESETS: ScenarioPreset[] = [
  rookieOptimistic,
  vetOptimistic,
  injurySkeptic,
  consensus,
];
