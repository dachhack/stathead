// Display helpers for the devy career model's outputs (hit chance, draft-day
// outlook), shared by the devy board, the player card and the high-school board.

export interface DraftOutlook { day1: number; day2: number; day3: number; undrafted: number }

const DAY_LABEL: Record<keyof DraftOutlook, string> = { day1: 'Day 1', day2: 'Day 2', day3: 'Day 3', undrafted: 'Undrafted' };

/** The most likely draft day and its chance, e.g. "Day 2 · 41%". */
export function draftLine(d: DraftOutlook | null | undefined): string {
  if (!d) return '';
  const k = (Object.keys(DAY_LABEL) as (keyof DraftOutlook)[]).reduce((a, b) => (d[b] > d[a] ? b : a));
  return `${DAY_LABEL[k]} · ${Math.round(d[k])}%`;
}

export function draftTitle(d: DraftOutlook | null | undefined): string {
  if (!d) return '';
  return `Day 1 (R1) ${d.day1}% · Day 2 (R2-3) ${d.day2}% · Day 3 (R4-7) ${d.day3}% · undrafted ${d.undrafted}%`;
}

/** Hit chance as shown: one decimal under 1%, whole percents above. */
export function hitText(v: number | null | undefined): string {
  if (v == null) return '—';
  return v < 1 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`;
}
