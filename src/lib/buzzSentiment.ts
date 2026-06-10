/**
 * Lexicon-based sentiment scoring for player news blurbs.
 *
 * Deliberately dependency-free so the exact same scorer runs in the browser
 * (Buzz Tracker UI) and in Node (scripts/fetch-player-buzz.ts). The result
 * shape carries a `method` tag so a later Claude/LLM pass can overwrite an
 * item's score without changing the data contract — see SentimentMethod.
 */

export type SentimentMethod = 'lexicon' | 'llm';
export type SentimentLabel = 'positive' | 'neutral' | 'negative';

// OTA / training-camp flavored. Multi-word phrases are matched as substrings,
// so "first-team reps" and "limited in practice" land even though the lexicon
// is flat.
export const POSITIVE_TERMS: readonly string[] = [
  'breakout', 'sleeper', 'league winner', 'league-winner', 'steal', 'undervalued',
  'first-team', 'first team', 'starter', 'starting', 'every-down', 'three-down',
  'bell cow', 'bell-cow', 'workhorse', 'lead back', 'lead-back', 'wr1', 'rb1',
  'qb1', 'te1', 'standout', 'impressive', 'impressed', 'turning heads', 'turned heads',
  'stood out', 'explosive', 'elite', 'upside', 'rave reviews', 'praised', 'praise',
  'healthy', 'full go', 'full-go', 'cleared', 'looks great', 'best shape', 'buy low',
  'buy-low', 'ascending', 'locked in', 'leaner', 'added muscle', 'extension', 'monster',
  'reps with the first', 'expanded role', 'bigger role', 'featured',
];

export const NEGATIVE_TERMS: readonly string[] = [
  'bust', 'overvalued', 'overhyped', 'overrated', 'fade', 'sell high', 'sell-high',
  'injury', 'injured', 'hurt', 'strain', 'sprain', 'surgery', 'setback', 'tweaked',
  'limited', 'dnp', 'did not practice', 'sidelined', 'questionable', 'doubtful',
  'holdout', 'hold out', 'holding out', 'contract dispute', 'suspended', 'suspension',
  'demoted', 'second team', 'second-team', 'committee', 'crowded', 'buried', 'concern',
  'concerning', 'red flag', 'regression', 'declining', 'washed', 'aging', 'pup list',
  'placed on ir', 'ruled out', 'absent', 'missed time', 'struggled', 'struggling',
];

export interface SentimentResult {
  score: number;          // net sentiment in [-1, 1]
  pos: number;            // positive term hits
  neg: number;            // negative term hits
  method: SentimentMethod;
}

/** Count lexicon hits in free text and return a normalized net score. */
export function scoreSentiment(text: string): SentimentResult {
  const lower = ` ${(text || '').toLowerCase()} `;
  let pos = 0;
  let neg = 0;
  for (const t of POSITIVE_TERMS) if (lower.includes(t)) pos++;
  for (const t of NEGATIVE_TERMS) if (lower.includes(t)) neg++;
  const total = pos + neg;
  const score = total === 0 ? 0 : (pos - neg) / total;
  return { score: Math.round(score * 100) / 100, pos, neg, method: 'lexicon' };
}

export function sentimentLabel(score: number): SentimentLabel {
  if (score >= 0.2) return 'positive';
  if (score <= -0.2) return 'negative';
  return 'neutral';
}
