import type {
  SDIOProjection,
  ScenarioConfig,
  VolumeOverride,
  PlayerAvailability,
  PointsOverride,
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

// Optional external inputs a preset may consult. `clayPpr` is the local-only
// Clay projection set (PPR by normalized name) — present only when the
// gitignored runtime file exists, so Clay-dependent presets are hidden in the
// public deploy.
export interface PresetContext {
  clayPpr?: Map<string, number>;
}

// A preset is a factory: given the live projection pool + metadata it produces
// a ready-to-apply ScenarioConfig built entirely from existing scenario levers.
// `requiresClay` presets are only offered when `ctx.clayPpr` has data.
export interface ScenarioPreset {
  id: string;
  name: string;
  description: string;
  requiresClay?: boolean;
  build: (
    players: SDIOProjection[],
    meta: PresetMeta,
    normalize: (s: string) => string,
    ctx?: PresetContext,
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

// ── Vegas Weighted ─────────────────────────────────────────────────
// Market-compression tilt toward position means. A conservative,
// market-efficient view that regresses upside toward the mean. No external
// data dependency.
const vegasWeighted: ScenarioPreset = {
  id: 'preset-vegas-weighted',
  name: 'Vegas Weighted',
  description: 'Regress projections 25% toward position means — a conservative, market-efficient view.',
  build: () => {
    const sc = base('Vegas Weighted');
    sc.vegasWeighting = 25;
    return sc;
  },
};

// ── Consensus (80% Clay / 20% us) ──────────────────────────────────
// Blend each player's projection toward Mike Clay's numbers: 0.8·Clay + 0.2·us
// at the PPR level (counting stats keep our shape, scaled to the blended PPG).
// LOCAL-ONLY: depends on the gitignored Clay set (ctx.clayPpr); this preset is
// hidden in the public deploy where that data is absent, so Clay's licensed
// numbers are never shipped. Falls back to a no-op if no Clay data is present.
const CONSENSUS_CLAY_WEIGHT = 0.8;
const consensus: ScenarioPreset = {
  id: 'preset-consensus',
  name: 'Consensus',
  description: 'Blend 80% Clay / 20% our projection per player (local Clay data required).',
  requiresClay: true,
  build: (players, _meta, normalize, ctx) => {
    const sc = base('Consensus');
    const clay = ctx?.clayPpr;
    if (!clay || clay.size === 0) return sc; // no Clay data → no-op
    const overrides: PointsOverride[] = [];
    for (const p of players) {
      const clayPpr = clay.get(normalize(p.Name));
      if (clayPpr === undefined || clayPpr <= 0) continue;
      const ours = p.FantasyPointsPPR || 0;
      const blended = CONSENSUS_CLAY_WEIGHT * clayPpr + (1 - CONSENSUS_CLAY_WEIGHT) * ours;
      overrides.push({
        playerId: p.PlayerID,
        playerName: p.Name,
        team: p.Team,
        position: p.Position,
        ppr: Math.round(blended),
      });
    }
    sc.pointsOverrides = overrides;
    return sc;
  },
};

export const SCENARIO_PRESETS: ScenarioPreset[] = [
  rookieOptimistic,
  vetOptimistic,
  injurySkeptic,
  vegasWeighted,
  consensus,
];
