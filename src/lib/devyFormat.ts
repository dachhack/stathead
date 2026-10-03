// Display helpers for the devy career model's outputs (hit chance, draft-day
// outlook), shared by the devy board, the player card and the high-school board.

export interface DraftOutlook {
  day1: number; day2: number; day3: number; undrafted: number;
  /** 'model+board' where the big board is blended in (the nearest class). */
  source?: string;
}

/** Chance of round 1 and of rounds 1-3, e.g. "R1 57% · R1–3 61%". */
export function draftLine(d: DraftOutlook | null | undefined): string {
  if (!d) return '';
  return `R1 ${Math.round(d.day1)}% · R1–3 ${Math.round(d.day1 + d.day2)}%`;
}

export function draftTitle(d: DraftOutlook | null | undefined): string {
  if (!d) return '';
  return `Round 1 ${d.day1}% · rounds 2-3 ${d.day2}% · rounds 4-7 ${d.day3}% · undrafted ${d.undrafted}%`
    + (d.source === 'model+board' ? ' (college model blended with the big board)'
      : d.source === 'model+mock' ? ' (college model blended with an early mock draft)' : ' (college model)');
}

/** Hit chance as shown: one decimal under 1%, whole percents above. */
export function hitText(v: number | null | undefined): string {
  if (v == null) return '—';
  return v < 1 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`;
}
