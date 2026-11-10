// Formatting for the feature-importance tables in the model docs.
//
// Kept out of the panel component because a component file that also exports
// helpers breaks React fast refresh, and the tooltip text is worth testing on
// its own.
import type { ImportanceRow } from '../components/FeatureImportancePanel';

/** Compact number: integers plain, small values to 3 significant figures. */
export function num(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Number.isInteger(v)) return String(v);
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toPrecision(3).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Hover text for a row: the feature's own distribution, so "+1 SD" has a size.
 *
 * Returns '' when nothing is known, and the caller renders no tooltip at all
 * rather than an empty box. Each block is independent because model families
 * supply different amounts: the boosted models carry full quartiles from the
 * scored cohort, while a logistic model carries the mean and sd it was
 * standardised with, and gains quartiles only when it is next retrained.
 */
export function statsTooltip(r: ImportanceRow): string {
  const st = r.stats;
  const lines: string[] = [];
  if (st) {
    if ([st.min, st.q1, st.median, st.q3, st.max].every((v) => v != null)) {
      lines.push(`Quartiles   min ${num(st.min!)} · Q1 ${num(st.q1!)} · median ${num(st.median!)} · Q3 ${num(st.q3!)} · max ${num(st.max!)}`);
      lines.push(`IQR         ${num(st.q3! - st.q1!)}`);
    }
    if (st.mean != null && st.sd != null) {
      lines.push(`Mean ± SD   ${num(st.mean)} ± ${num(st.sd)}`);
      // The whole point of the tooltip: turn an abstract "+1 SD" into a move
      // between two numbers on the feature's own scale.
      if (st.sd > 0) lines.push(`+1 SD means going from ${num(st.mean)} to ${num(st.mean + st.sd)}.`);
    }
    if (st.oddsRatioPerSd != null) {
      const o = st.oddsRatioPerSd;
      lines.push(`Odds ×${o.toFixed(3)} per +1 SD (${o >= 1 ? '+' : ''}${((o - 1) * 100).toFixed(1)}%).`);
    }
    // Suppressed when it would repeat the cohort line below.
    if (st.n != null && st.n !== r.cohort) lines.push(`Fitted on ${st.n.toLocaleString()} rows.`);
  }
  if (r.direction != null) {
    lines.push(r.rankCorrelation != null
      ? `r ${r.direction.toFixed(3)} (linear), rho ${r.rankCorrelation.toFixed(3)} (rank).`
      : `Coefficient ${r.direction.toFixed(3)} on the standardised feature.`);
  }
  if (r.quintileMeans && r.quintileMeans.length > 1) {
    lines.push(`Mean target by feature quintile: ${r.quintileMeans.map((m) => num(m)).join(' → ')}`);
  }
  if (r.cohort) lines.push(`Cohort ${r.cohort.toLocaleString()} players.`);
  return lines.join('\n');
}
