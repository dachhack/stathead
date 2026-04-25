/**
 * Shared row + verdict types used across the Edge Board and the
 * Round-by-Round Plan. Defined in lib/ (not in a component) so multiple
 * sections can consume the same shape without circular imports.
 *
 * The data-fetching code in DraftOptimizerTable populates rows once;
 * sub-sections (EdgeBoard, RoundPlan, TierMap, TargetsFades) all read
 * from the same array.
 */

export type Verdict = 'Strong Target' | 'Target' | 'Fair' | 'Fade' | 'Strong Fade' | 'Unknown';

export interface EdgeBoardRow {
  name: string;
  position: string;
  team: string;
  adp: number;
  stdev: number;             // FFC ADP stdev; 0 if unavailable
  predictedPPG: number;
  adpBaselinePPG: number;
  pickEdge: number;
  pBeat: number;
  upsidePPG: number;
  downsidePPG: number;
  targetSharePctile: number; // 0–100 within position; NaN if no share data
  rawTargetShare: number;    // raw 0–1 fraction; NaN if missing
  survivalBest: number;      // best survival prob across user's picks; NaN if no FFC data
  verdict: Verdict;
  isRookie: boolean;
}

/**
 * Per-position verdict thresholds derived from the live PickEdge σ within
 * position, combined with Beat % bands. Per-position thresholds (instead
 * of universal cutoffs) compensate for the fact that QB has narrower
 * PickEdge spread than RB/WR/TE.
 *
 * Strong Target: PickEdge ≥ +1.0σ AND Beat ≥ 60%
 * Target:        PickEdge ≥ +0.5σ AND Beat ≥ 50%
 * Strong Fade:   PickEdge ≤ −1.0σ AND Beat ≤ 40%
 * Fade:          PickEdge ≤ −0.5σ AND Beat ≤ 50%
 *
 * If Beat % is missing (degenerate CI bounds), the verdict falls back to
 * PickEdge-only thresholds.
 */
export function verdictFor(pickEdge: number, pBeat: number, sigma: number): Verdict {
  if (!Number.isFinite(pickEdge) || !Number.isFinite(sigma) || sigma <= 0) return 'Unknown';
  const z = pickEdge / sigma;
  const beatKnown = Number.isFinite(pBeat);
  if (z >= 1.0 && (!beatKnown || pBeat >= 0.60)) return 'Strong Target';
  if (z >= 0.5 && (!beatKnown || pBeat >= 0.50)) return 'Target';
  if (z <= -1.0 && (!beatKnown || pBeat <= 0.40)) return 'Strong Fade';
  if (z <= -0.5 && (!beatKnown || pBeat <= 0.50)) return 'Fade';
  return 'Fair';
}

export const VERDICT_STYLE: Record<Verdict, { label: string; bg: string; fg: string }> = {
  'Strong Target': { label: 'Strong Target', bg: '#0c4a2c', fg: '#86efac' },
  'Target':        { label: 'Target',        bg: '#1a3a2a', fg: '#a3e635' },
  'Fair':          { label: 'Fair',          bg: 'var(--bg-tertiary)', fg: 'var(--text-muted)' },
  'Fade':          { label: 'Fade',          bg: '#3a1a1a', fg: '#fb923c' },
  'Strong Fade':   { label: 'Strong Fade',   bg: '#4a0c0c', fg: '#fca5a5' },
  'Unknown':       { label: '—',             bg: 'transparent', fg: 'var(--text-muted)' },
};

export function pickEdgeColor(e: number): string {
  if (!Number.isFinite(e)) return 'var(--text-muted)';
  if (e >= 2.0) return '#22c55e';
  if (e >= 1.0) return '#86efac';
  if (e >= 0.3) return '#a3e635';
  if (e <= -2.0) return '#ef4444';
  if (e <= -1.0) return '#fca5a5';
  if (e <= -0.3) return '#fb923c';
  return 'var(--text-muted)';
}

export function pBeatColor(p: number): string {
  if (!Number.isFinite(p)) return 'var(--text-muted)';
  if (p >= 0.65) return '#22c55e';
  if (p >= 0.55) return '#86efac';
  if (p >= 0.45) return 'var(--text-primary)';
  if (p >= 0.35) return '#fb923c';
  return '#ef4444';
}

export function fmtEdge(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}`;
}

export function fmtPct(p: number): string {
  if (!Number.isFinite(p)) return '—';
  return `${Math.round(p * 100)}%`;
}
