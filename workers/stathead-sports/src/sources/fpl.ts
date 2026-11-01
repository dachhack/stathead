// The official Fantasy Premier League bootstrap: every Premier League player
// with availability status, injury news, squad number and the PL player code.
// Used to enrich the ESPN roster directory for the Premier League.

import { fetchJson } from '../util.js';

export interface FplElement {
  id: number;
  code: number;
  first_name: string;
  second_name: string;
  web_name: string;
  team: number;
  team_code: number;
  element_type: number;
  /** a available, d doubtful, i injured, s suspended, u unavailable, n not in squad */
  status: string;
  news: string;
  chance_of_playing_next_round: number | null;
  squad_number: number | null;
  birth_date?: string | null;
  minutes: number;
}

export interface FplBootstrap {
  teams: Array<{ id: number; short_name: string; name: string; code: number }>;
  elements: FplElement[];
  events: Array<{ id: number; is_current: boolean; deadline_time: string }>;
}

export interface FplDraftElement {
  id: number;
  code: number;
  web_name: string;
  first_name: string;
  second_name: string;
  team: number;
  /** FPL Draft's published draft order (1 = first pick). */
  draft_rank: number;
  status: string;
}

/** The FPL Draft game's bootstrap: the same players with a published draft rank. */
export async function draftBootstrap(): Promise<{ elements: FplDraftElement[]; teams: Array<{ id: number; short_name: string }> }> {
  return fetchJson('https://draft.premierleague.com/api/bootstrap-static', { timeoutMs: 60_000 });
}

export function bootstrap(): Promise<FplBootstrap> {
  return fetchJson<FplBootstrap>('https://fantasy.premierleague.com/api/bootstrap-static/', { timeoutMs: 60_000 });
}

/** FPL team short names that differ from ESPN's abbreviations. */
export const FPL_TEAM_ALIASES: Record<string, string> = { MCI: 'MNC', MUN: 'MAN', WHU: 'WHU', NFO: 'NFO', SHU: 'SHU' };

export function fullName(e: FplElement): string {
  return `${e.first_name} ${e.second_name}`.trim();
}

/** FPL status → the service's soccer injury vocabulary. */
export function injuryCode(e: FplElement): string | null {
  switch (e.status) {
    case 'a':
      return null;
    case 'd':
      return 'D';
    case 'i':
      return 'O';
    case 's':
      return 'SUSP';
    case 'u':
      return 'NA';
    case 'n':
      return 'NA';
    default:
      return e.status ? e.status.toUpperCase() : null;
  }
}

export function headshotUrl(e: FplElement): string {
  return `https://resources.premierleague.com/premierleague/photos/players/250x250/p${e.code}.png`;
}
