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
  /** Model's ADP-free PPG (score-store/ppg.json). Always present even
   *  when a scenario is active. */
  modelPPG: number;
  /** Scenario-projected PPG (FantasyPointsPPR / 17 from the active
   *  scenario). NaN when no scenario is active OR the scenario doesn't
   *  cover this player. */
  projPPG: number;
  /** Effective PPG that drives PickEdge / Beat % / verdict — projPPG
   *  if finite, else modelPPG. Single number to read for downstream
   *  metrics. */
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
 * Verdict thresholds derived from cohort-relative PickEdge z-scores.
 * The cohort is `(position × ADP band)`, not just `position`. This
 * matters because the curve baseline is structurally high at low ADPs
 * (round-1 picks all show negative edge vs. curve) and structurally
 * low at deep ADPs (every meaningful late prediction shows huge
 * positive edge). Without per-band stratification, round-1 players
 * cluster as Fade/Strong Fade and round-11 players cluster as Strong
 * Target — independent of any genuine value disagreement. Recentering
 * on each band's own mean and rescaling by its own σ makes the verdict
 * read as "best/worst within your draft slot range."
 *
 * Strong Target: cohort z ≥ +1.0
 * Target:        cohort z ≥ +0.5
 * Strong Fade:   cohort z ≤ −1.0
 * Fade:          cohort z ≤ −0.5
 *
 * Beat % is NOT mixed into the verdict — it's a separate, absolute
 * probability ("does this player beat curve baseline regardless of
 * cohort"). Anding it with cohort z would block all R1-3 Strong
 * Targets, since everyone in that band has Beat < 50% by construction.
 * Beat % stays as its own column so users can see both the cohort-
 * relative and absolute views side by side.
 */
export function verdictFor(pickEdge: number, _pBeat: number, sigma: number, mean = 0): Verdict {
  if (!Number.isFinite(pickEdge) || !Number.isFinite(sigma) || sigma <= 0) return 'Unknown';
  const z = (pickEdge - mean) / sigma;
  if (z >= 1.0) return 'Strong Target';
  if (z >= 0.5) return 'Target';
  if (z <= -1.0) return 'Strong Fade';
  if (z <= -0.5) return 'Fade';
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
