/**
 * Buzz Tracker data contract + loader.
 *
 * The snapshot is produced offline by scripts/fetch-player-buzz.ts (ESPN news
 * + Rotowire + Reddit r/fantasyfootball, r/dynastyff, r/32beatwriters),
 * committed to public/data/player-buzz.json, and refreshed on a cron. The UI
 * just reads it — no live fan-out in the browser.
 */
import type { SentimentLabel, SentimentMethod } from './buzzSentiment';

export interface BuzzItem {
  /** 'espn' | 'rotowire' | 'reddit:fantasyfootball' | 'reddit:dynastyff' | 'reddit:32beatwriters' */
  source: string;
  headline: string;
  summary?: string;
  published: string;        // ISO date
  link?: string;
  score: number;            // per-item sentiment in [-1, 1]
  method: SentimentMethod;
}

export interface BuzzPlayer {
  player_key: string | null;
  name: string;
  position: string;
  team?: string;
  espn_id?: string;
  volume: number;                         // item count in the window
  volumeBySource: Record<string, number>;
  sentiment: number;                      // net sentiment in [-1, 1]
  sentimentLabel: SentimentLabel;
  pos: number;                            // positive hits
  neg: number;                            // negative hits
  trend: number;                          // recent-half vs prior-half volume ratio
  lastPublished?: string;
  items: BuzzItem[];
  method: SentimentMethod;
}

export interface BuzzSnapshot {
  generated: string;
  windowDays: number;
  sources: string[];
  players: BuzzPlayer[];
}

export async function fetchPlayerBuzz(): Promise<BuzzSnapshot | null> {
  try {
    const resp = await fetch(`${import.meta.env.BASE_URL}data/player-buzz.json`);
    if (!resp.ok) return null;
    return (await resp.json()) as BuzzSnapshot;
  } catch {
    return null;
  }
}
