// Adapter registry and the season convention.
//
// SEASON_RULE: a StatHead `season` is the year a season STARTS for the two
// cross-year leagues (NHL 2026 = 2026-27, NBA 2026 = 2026-27) and the calendar
// year for MLB and the WNBA. ESPN's fantasy ids for NBA and NHL use the end
// year; the adapters translate.

import type { Sport, SportAdapter } from '../types.js';
import { nhl } from './nhl.js';
import { mlb } from './mlb.js';
import { nba, wnba } from './basketball.js';

export const ADAPTERS: Record<Sport, SportAdapter> = { nhl, mlb, nba, wnba };

export function adapterFor(sport: string): SportAdapter | null {
  return (ADAPTERS as Record<string, SportAdapter>)[sport] ?? null;
}

export const SEASON_RULE = 'start year for NHL and NBA (2026 = 2026-27); calendar year for MLB and WNBA';
