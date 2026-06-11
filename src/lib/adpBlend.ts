/**
 * Pure ADP blending math — weights and weighted-mean helpers shared by the
 * browser surfaces (src/lib/adpSources.ts, draft kit, My Rankings) and the
 * Node training pipeline (src/lib/buildFeatureMatrix.ts). Keep this module
 * environment-free: no import.meta.env, no fetch, no fs.
 */

/** Half-life decay on data age. ~1 month half-life: yesterday ≈ 0.98,
 *  a month old ≈ 0.5, last September ≈ 0. Floor keeps a stale source
 *  visible-but-negligible instead of vanishing. */
export function recencyWeight(dateIso?: string, halfLifeDays = 30): number {
  if (!dateIso) return 1;
  const t = Date.parse(dateIso);
  if (!Number.isFinite(t)) return 1;
  const days = Math.max(0, (Date.now() - t) / 86_400_000);
  return Math.max(0.02, 0.5 ** (days / halfLifeDays));
}

/** Per-player sample weight from a draft count (FFC times_drafted):
 *  full weight at `ref`+ drafts, floored so tiny samples stay visible.
 *  Unknown counts get 0.5 — present but not fully trusted. */
export function sampleWeight(timesDrafted?: number, ref = 50): number {
  if (timesDrafted === undefined || !Number.isFinite(timesDrafted)) return 0.5;
  return Math.max(0.1, Math.min(1, timesDrafted / ref));
}

export interface WeightedPick {
  adp: number;
  weight: number;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Weighted mean of the available real-market picks. Plain numbers count
 *  at weight 1. Ignores missing / sentinel (≥999) values; undefined when
 *  no market prices the player. */
export function blendPicks(...picks: Array<number | WeightedPick | undefined>): number | undefined {
  let num = 0;
  let den = 0;
  for (const p of picks) {
    if (p === undefined) continue;
    const adp = typeof p === 'number' ? p : p.adp;
    const w = typeof p === 'number' ? 1 : p.weight;
    if (!Number.isFinite(adp) || adp <= 0 || adp >= 999 || !(w > 0)) continue;
    num += adp * w;
    den += w;
  }
  if (den <= 0) return undefined;
  return round1(num / den);
}
