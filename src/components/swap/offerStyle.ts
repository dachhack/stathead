/** Colours, labels and number formats shared by the Trade Finisher and Swap Meet. */

import type { FinisherAsset, FitVerdict, TradeGoal, Verdict } from '../../lib/tradeFinisher';

export const GIVE_COLOR = '#6366f1';   // the calculator's Side A
export const GET_COLOR = '#f59e0b';    // Side B
export const MUTED = 'var(--text-muted)';

export const VERDICT_LABEL: Record<Verdict, string> = { fair: 'Fair', slight: 'Slight edge', uneven: 'Uneven', lopsided: 'Lopsided' };
export const VERDICT_COLOR: Record<Verdict, string> = { fair: '#22c55e', slight: '#a3e635', uneven: '#facc15', lopsided: '#ef4444' };
export const GOAL_COLOR: Record<TradeGoal, string> = { 'win-now': '#ef4444', balanced: MUTED, rebuild: '#22c55e' };

/** Ink tones for the paper offer sheets (the dark pages keep the bright set). */
export const GIVE_INK = '#3d38b8';
export const GET_INK = '#b0560f';
export const INK = { green: '#1f7a3a', red: '#b3261e', amber: '#a8611a', blue: '#1b5e7b', muted: '#857860', grey: '#5b5347' } as const;
export const PAPER_VERDICT_COLOR: Record<Verdict, string> = { fair: INK.green, slight: '#5a7a1f', uneven: INK.amber, lopsided: INK.red };
/** Each side's goal-weighted read of a deal (great … bad), bright and ink. */
export const FIT_COLOR: Record<FitVerdict, string> = { great: '#22c55e', good: '#a3e635', even: '#94a3b8', poor: '#f59e0b', bad: '#ef4444' };
export const PAPER_FIT_COLOR: Record<FitVerdict, string> = { great: INK.green, good: '#5a7a1f', even: INK.muted, poor: INK.amber, bad: INK.red };

export const fmt = (n: number) => Math.round(n).toLocaleString();
export const signed = (n: number, digits = 0) => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(digits);
export const sumValue = (xs: FinisherAsset[]) => xs.reduce((s, a) => s + a.value, 0);

/** A team name short enough for tags and inline reads: cut at the first
 *  comma or colon, then at 18 characters. */
export function shortName(name: string): string {
  const cut = name.split(/[,:]/)[0].trim() || name;
  return cut.length > 18 ? `${cut.slice(0, 17).trimEnd()}…` : cut;
}
