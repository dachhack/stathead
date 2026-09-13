/**
 * Where a prospect's combine numbers come from.
 *
 * The career model needs a value for every drill, so the feature builders
 * fill gaps with the position average. That is fine for the model and
 * misleading on a card: a 20.33-rep bench that is really "the TE average"
 * must not read as a result. Two bitmasks travel with the features:
 *
 *   combineMeasuredMask   bits for drills with an nflverse combine result
 *   combineEstimatedMask  bits for drills that came from the pre-draft
 *                         prospect sheet (a guide's projected 40, a listed
 *                         weight) rather than a timed run
 *
 * Anything set in neither mask is a positional-average fill. Records built
 * before the masks existed carry neither key; `combineProvenance` falls back
 * to the older hasCombineData / hasPhysicalData flags for those.
 */

export const COMBINE_METRICS = ['weight', 'forty', 'bench', 'vertical', 'broadJump', 'cone', 'shuttle'] as const;
export type CombineMetric = (typeof COMBINE_METRICS)[number];

export const COMBINE_BIT: Record<CombineMetric, number> = {
  weight: 1, forty: 2, bench: 4, vertical: 8, broadJump: 16, cone: 32, shuttle: 64,
};

/** Drills that make an athletic score; weight is a measurement, not a test. */
export const COMBINE_DRILLS: CombineMetric[] = ['forty', 'bench', 'vertical', 'broadJump', 'cone', 'shuttle'];

/** Fewest measured drills before an RAS is worth showing. */
export const RAS_MIN_DRILLS = 3;

/** Feature keys derived from combine numbers, and what they derive from. */
const DERIVED: Record<string, CombineMetric[]> = {
  speedScore: ['forty', 'weight'],
  heightAdjSpeedScore: ['forty', 'weight'],
  draftCapXSpeed: ['forty', 'weight'],
  bmi: ['weight'],
};

export function maskOf(present: Partial<Record<CombineMetric, boolean | number | null | undefined>>): number {
  let m = 0;
  for (const k of COMBINE_METRICS) if (present[k]) m |= COMBINE_BIT[k];
  return m;
}

export type Provenance = 'measured' | 'estimated' | 'imputed';

const isCombineKey = (k: string): k is CombineMetric => (COMBINE_METRICS as readonly string[]).includes(k);

/** True when the record carries the masks (built after this module landed). */
export function hasProvenance(features: Record<string, number | undefined>): boolean {
  return features.combineMeasuredMask != null || features.combineEstimatedMask != null;
}

/** Drills (not weight) with a real combine result. */
export function measuredDrillCount(features: Record<string, number | undefined>): number {
  const m = features.combineMeasuredMask ?? 0;
  return COMBINE_DRILLS.filter((d) => m & COMBINE_BIT[d]).length;
}

/** Where a combine-based feature's value came from. Non-combine keys are
 *  reported as measured (nothing to flag). */
export function combineProvenance(features: Record<string, number | undefined>, key: string): Provenance {
  const measured = features.combineMeasuredMask ?? 0;
  const estimated = features.combineEstimatedMask ?? 0;
  const one = (m: CombineMetric): Provenance => {
    if (hasProvenance(features)) {
      if (measured & COMBINE_BIT[m]) return 'measured';
      if (estimated & COMBINE_BIT[m]) return 'estimated';
      return 'imputed';
    }
    // Legacy records: one flag for the whole combine, weight from the roster.
    if (m === 'weight') return (features.hasPhysicalData ?? (features.hasCombineData ?? 1)) > 0 ? 'measured' : 'imputed';
    return (features.hasCombineData ?? 1) > 0 ? 'measured' : 'imputed';
  };
  const worst = (ms: CombineMetric[]): Provenance => {
    const ps = ms.map(one);
    return ps.includes('imputed') ? 'imputed' : ps.includes('estimated') ? 'estimated' : 'measured';
  };
  if (isCombineKey(key)) return one(key);
  if (key === 'relativeAthleticScore') {
    if (!hasProvenance(features)) return (features.hasCombineData ?? 1) > 0 ? 'measured' : 'imputed';
    return measuredDrillCount(features) >= RAS_MIN_DRILLS ? 'measured' : 'imputed';
  }
  if (DERIVED[key]) return worst(DERIVED[key]);
  return 'measured';
}

/** Short note for a card: why a value is greyed or marked. */
export function provenanceNote(features: Record<string, number | undefined>, key: string): string | null {
  const p = combineProvenance(features, key);
  if (p === 'measured') return null;
  if (key === 'relativeAthleticScore') {
    const n = hasProvenance(features) ? measuredDrillCount(features) : 0;
    return n ? `no RAS · ${n} drill${n === 1 ? '' : 's'} tested` : 'no RAS · not tested';
  }
  if (p === 'estimated') return key === 'weight' ? 'listed weight, not a combine weigh-in' : 'pre-draft estimate, not a timed result';
  return key === 'weight' ? 'position average' : 'not tested · position average';
}
