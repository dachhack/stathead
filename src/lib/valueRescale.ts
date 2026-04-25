/**
 * KTC → FantasyCalc value rescaling.
 *
 * The site displays FC values everywhere but uses a KTC-trained forecast model.
 * For each player present in both services we compute a per-player ratio
 *   fc_value / ktc_value
 * and apply it to KTC values (current, history, forecast) so they appear in
 * FC's scale. Players below a value floor or missing from FC fall back to a
 * positional median ratio.
 *
 * Pure utilities — no I/O. The snapshot is built offline (see
 * scripts/build-rescale-snapshot.cjs) and consumed via tryPreFetched.
 */
import type { KTCPlayer, KTCPlayerHistory, KTCHistoryPoint, FantasyCalcPlayer } from '../types';
import { normalizeName } from './featureTypes';

export type RescaleFormat = '1qb' | 'superflex';
export type RescalePosition = 'QB' | 'RB' | 'WR' | 'TE';

const POSITIONS: readonly RescalePosition[] = ['QB', 'RB', 'WR', 'TE'];

/** Player KTC values below this fall back to the positional median ratio. */
export const RESCALE_FLOOR = 500;

export interface RescaleSnapshot {
  generatedAt: string;
  floor: number;
  // Per-player ratios keyed by KTC playerID.
  perPlayer: Record<number, { oneQB?: number; sf?: number }>;
  // Position-median ratios used as fallback.
  positional: Record<RescalePosition, { oneQB: number; sf: number }>;
}

export interface Rescaler {
  /** Rescale a single KTC value into FC scale. Returns the original value
   *  for unsupported positions (e.g. K, picks). */
  value(playerID: number, ktcValue: number, position: string, fmt: RescaleFormat): number;
  /** Rescale every point in a KTC value history. */
  history(playerID: number, points: KTCHistoryPoint[], position: string, fmt: RescaleFormat): KTCHistoryPoint[];
  /** Expose the resolved ratio (per-player or positional) for a player+format. */
  ratio(playerID: number, ktcValue: number, position: string, fmt: RescaleFormat): number | null;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 1;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function isSupportedPosition(p: string): p is RescalePosition {
  return (POSITIONS as readonly string[]).includes(p);
}

/** Build a rescale snapshot from current KTC + FC snapshots. */
export function buildRescaleSnapshot(
  ktcRankings: KTCPlayer[],
  fcDynasty1qb: FantasyCalcPlayer[],
  fcDynastySf: FantasyCalcPlayer[],
  floor: number = RESCALE_FLOOR,
): RescaleSnapshot {
  const fcKey = (name: string, position: string) => `${normalizeName(name)}|${position}`;
  const fc1q = new Map<string, number>();
  const fcSf = new Map<string, number>();
  for (const p of fcDynasty1qb) fc1q.set(fcKey(p.player.name, p.player.position), p.value);
  for (const p of fcDynastySf) fcSf.set(fcKey(p.player.name, p.player.position), p.value);

  const perPlayer: Record<number, { oneQB?: number; sf?: number }> = {};
  const samples: Record<RescalePosition, { oneQB: number[]; sf: number[] }> = {
    QB: { oneQB: [], sf: [] }, RB: { oneQB: [], sf: [] },
    WR: { oneQB: [], sf: [] }, TE: { oneQB: [], sf: [] },
  };

  for (const k of ktcRankings) {
    if (!isSupportedPosition(k.position)) continue;
    const key = fcKey(k.playerName, k.position);
    const entry: { oneQB?: number; sf?: number } = {};
    const fc1qVal = fc1q.get(key);
    const fcSfVal = fcSf.get(key);
    if (fc1qVal != null && k.value >= floor && k.value > 0) {
      entry.oneQB = fc1qVal / k.value;
      samples[k.position].oneQB.push(entry.oneQB);
    }
    if (fcSfVal != null && k.superflexValue >= floor && k.superflexValue > 0) {
      entry.sf = fcSfVal / k.superflexValue;
      samples[k.position].sf.push(entry.sf);
    }
    if (entry.oneQB != null || entry.sf != null) {
      perPlayer[k.playerID] = entry;
    }
  }

  const positional = {} as Record<RescalePosition, { oneQB: number; sf: number }>;
  for (const pos of POSITIONS) {
    positional[pos] = {
      oneQB: median(samples[pos].oneQB),
      sf: median(samples[pos].sf),
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    floor,
    perPlayer,
    positional,
  };
}

/** Wrap a snapshot in a Rescaler. */
export function makeRescaler(snap: RescaleSnapshot): Rescaler {
  const ratio = (playerID: number, ktcValue: number, position: string, fmt: RescaleFormat): number | null => {
    if (!isSupportedPosition(position)) return null;
    const key = fmt === '1qb' ? 'oneQB' : 'sf';
    const player = snap.perPlayer[playerID];
    if (player && player[key] != null && ktcValue >= snap.floor) {
      return player[key]!;
    }
    return snap.positional[position][key];
  };

  return {
    ratio,
    value(playerID, ktcValue, position, fmt) {
      const r = ratio(playerID, ktcValue, position, fmt);
      return r == null ? ktcValue : Math.round(ktcValue * r);
    },
    history(playerID, points, position, fmt) {
      const r = ratio(playerID, points[points.length - 1]?.v ?? 0, position, fmt);
      if (r == null) return points;
      return points.map(p => ({ d: p.d, v: Math.round(p.v * r) }));
    },
  };
}

/** Apply a rescaler to a KTCPlayer, returning a new object with both values rescaled. */
export function rescaleKTCPlayer(p: KTCPlayer, r: Rescaler): KTCPlayer {
  return {
    ...p,
    value: r.value(p.playerID, p.value, p.position, '1qb'),
    superflexValue: r.value(p.playerID, p.superflexValue, p.position, 'superflex'),
  };
}

/** Apply a rescaler to a KTCPlayerHistory. Position is needed for the
 *  positional-fallback lookup. */
export function rescaleKTCHistory(h: KTCPlayerHistory, position: string, r: Rescaler): KTCPlayerHistory {
  return {
    playerID: h.playerID,
    oneQB: { valueHistory: r.history(h.playerID, h.oneQB.valueHistory, position, '1qb') },
    superflex: { valueHistory: r.history(h.playerID, h.superflex.valueHistory, position, 'superflex') },
  };
}
