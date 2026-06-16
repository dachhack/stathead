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

// Per-player Consensus stat line for stat-level blending (ML Optimized preset).
export interface ConsensusStats {
  position: string;
  pos_rk: number;
  pass_yds?: number; pass_td?: number; pass_int?: number;
  rush_yds?: number; rush_td?: number;
  rec?: number; rec_yds?: number; rec_td?: number;
  ppr: number;
}

// Optional external inputs a preset may consult. `consensusPpr` is the local-only
// Consensus projection set (PPR by normalized name) — present only when the
// gitignored runtime file exists. `presetPpr` carries the CI-precomputed,
// derived blend for a given preset id (season PPR by normalized name), read
// from redraft-projections-presets.json — so the Consensus presets work in the
// public deploy without shipping any Consensus data to the browser.
export interface PresetContext {
  consensusPpr?: Map<string, number>;
  consensusStats?: Map<string, ConsensusStats>;
  presetPpr?: Map<string, Map<string, number>>;
}

// A preset is a factory: given the live projection pool + metadata it produces
// a ready-to-apply ScenarioConfig built entirely from existing scenario levers.
// `requiresConsensus` presets are only offered when `ctx.consensusPpr` has data.
export interface ScenarioPreset {
  id: string;
  name: string;
  description: string;
  requiresConsensus?: boolean;
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

// Turn a precomputed season-PPR map (normalized name → PPR) into per-player
// points overrides against the live pool. Used by the Consensus presets so the
// public deploy applies the CI-derived blend without any Consensus data client-side.
function applyPrecomputed(
  players: SDIOProjection[],
  normalize: (s: string) => string,
  ppr: Map<string, number>,
): PointsOverride[] {
  const overrides: PointsOverride[] = [];
  for (const p of players) {
    const v = ppr.get(normalize(p.Name));
    if (v === undefined || v <= 0) continue;
    overrides.push({ playerId: p.PlayerID, playerName: p.Name, team: p.Team, position: p.Position, ppr: Math.round(v) });
  }
  return overrides;
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
        // Zero-sum volume boost: the engine scales rookie share up and trims
        // veteran teammates, so rookies genuinely gain share of the pie.
        overrides.push(vol(p, { volumeDelta: 25 }));
      } else if (p.Position === 'QB') {
        overrides.push(vol(p, { passDelta: 10, rushDelta: 18 }));
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

// ── Consensus (per-position Consensus blend) ──────────────────────────────
// Blend each player's projection toward the consensus numbers at the PPR level
// (counting stats keep our shape, scaled to the blended PPG).
// Weights derived from 5-year blend study (2021-2025, n=704 non-rookie
// player-seasons) averaging MAE-optimal and Spearman-optimal across
// season-total and per-game normalization. See scripts/consensus_blend_study.py.
// LOCAL-ONLY: depends on the gitignored Consensus set (ctx.consensusPpr); this preset is
// hidden in the public deploy where that data is absent.
const CONSENSUS_CLAY_WEIGHT: Record<string, number> = {
  QB: 0.75,
  RB: 0.75,
  WR: 0.55,
  TE: 0.85,
};
const CONSENSUS_CLAY_WEIGHT_DEFAULT = 0.70;
const consensus: ScenarioPreset = {
  id: 'preset-consensus',
  name: 'Consensus',
  description: 'Per-position consensus blend (5yr study: QB/RB 75%, WR 55%, TE 85%).',
  requiresConsensus: true,
  build: (players, _meta, normalize, ctx) => {
    const sc = base('Consensus');
    // Prefer the CI-precomputed derived blend (no Consensus in the browser).
    const pre = ctx?.presetPpr?.get('preset-consensus');
    if (pre && pre.size > 0) {
      sc.pointsOverrides = applyPrecomputed(players, normalize, pre);
      return sc;
    }
    const consensus = ctx?.consensusPpr;
    if (!consensus || consensus.size === 0) return sc;
    const overrides: PointsOverride[] = [];
    for (const p of players) {
      const consensusPpr = consensus.get(normalize(p.Name));
      if (consensusPpr === undefined || consensusPpr <= 0) continue;
      const ours = p.FantasyPointsPPR || 0;
      const w = CONSENSUS_CLAY_WEIGHT[p.Position] ?? CONSENSUS_CLAY_WEIGHT_DEFAULT;
      const blended = w * consensusPpr + (1 - w) * ours;
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

// ── Consensus ML Optimized (per-stat + tier-aware blend) ─────────────
// Instead of blending at the PPR level, blends each counting stat
// independently using weights optimized across 2021-2025 (n=704).
// Key insight: Consensus excels at TDs and role-based stats (RB rush yards)
// but our baseline is better at volume stats (WR rec yards, QB pass yards).
// Blending per-stat captures this — e.g. trust Consensus on rush_td (w=1.0)
// but lean toward us on pass_yds (w=0.38).
// See scripts/consensus_blend_study.py for derivation.
const STAT_WEIGHTS: Record<string, Record<string, number>> = {
  QB: { pass_yds: 0.38, pass_td: 0.90, pass_int: 0.00, rush_yds: 0.68, rush_td: 0.46 },
  RB: { rush_yds: 0.94, rush_td: 1.00, rec: 0.65, rec_yds: 0.45, rec_td: 1.00 },
  WR: { rec: 0.38, rec_yds: 0.25, rec_td: 0.84, rush_yds: 1.00 },
  TE: { rec: 0.85, rec_yds: 0.68, rec_td: 1.00 },
};

const PPR_SCORING: Record<string, number> = {
  pass_yds: 0.04, pass_td: 4, pass_int: -2,
  rush_yds: 0.1, rush_td: 6,
  rec: 1, rec_yds: 0.1, rec_td: 6,
};

// Mapping from Consensus stat keys to our SDIOProjection field names
const CLAY_TO_SDIO: Record<string, keyof SDIOProjection> = {
  pass_yds: 'PassingYards', pass_td: 'PassingTouchdowns', pass_int: 'PassingInterceptions',
  rush_yds: 'RushingYards', rush_td: 'RushingTouchdowns',
  rec: 'Receptions', rec_yds: 'ReceivingYards', rec_td: 'ReceivingTouchdowns',
};

const consensusMlOptimized: ScenarioPreset = {
  id: 'preset-consensus-ml',
  name: 'Consensus ML Optimized',
  description: 'Per-stat blend: trust Consensus on TDs/rushing, lean on us for volume/yardage (5yr study, n=704).',
  requiresConsensus: true,
  build: (players, _meta, normalize, ctx) => {
    const sc = base('Consensus ML Optimized');
    // Prefer the CI-precomputed derived blend (no Consensus in the browser).
    const pre = ctx?.presetPpr?.get('preset-consensus-ml');
    if (pre && pre.size > 0) {
      sc.pointsOverrides = applyPrecomputed(players, normalize, pre);
      return sc;
    }
    const consensusMap = ctx?.consensusStats;
    const consensusPprFallback = ctx?.consensusPpr;
    if ((!consensusMap || consensusMap.size === 0) && (!consensusPprFallback || consensusPprFallback.size === 0)) return sc;
    const overrides: PointsOverride[] = [];
    for (const p of players) {
      const key = normalize(p.Name);
      const cs = consensusMap?.get(key);
      if (cs) {
        const posWeights = STAT_WEIGHTS[p.Position];
        if (!posWeights) continue;
        let blendedPpr = 0;
        for (const [stat, pprMult] of Object.entries(PPR_SCORING)) {
          const consensusVal = cs[stat as keyof ConsensusStats] as number | undefined;
          const sdioField = CLAY_TO_SDIO[stat];
          const oursVal = sdioField ? (p[sdioField] as number) || 0 : 0;
          if (consensusVal !== undefined && stat in posWeights) {
            const w = posWeights[stat];
            blendedPpr += (w * consensusVal + (1 - w) * oursVal) * pprMult;
          } else {
            blendedPpr += oursVal * pprMult;
          }
        }
        overrides.push({
          playerId: p.PlayerID, playerName: p.Name,
          team: p.Team, position: p.Position,
          ppr: Math.round(blendedPpr),
        });
      } else {
        // Fall back to PPR-level blend if no stat line
        const cPpr = consensusPprFallback?.get(key);
        if (cPpr !== undefined && cPpr > 0) {
          const ours = p.FantasyPointsPPR || 0;
          const w = CONSENSUS_CLAY_WEIGHT[p.Position] ?? CONSENSUS_CLAY_WEIGHT_DEFAULT;
          overrides.push({
            playerId: p.PlayerID, playerName: p.Name,
            team: p.Team, position: p.Position,
            ppr: Math.round(w * cPpr + (1 - w) * ours),
          });
        }
      }
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
  consensusMlOptimized,
];
