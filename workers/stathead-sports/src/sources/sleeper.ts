// Sleeper's public player files for NBA, WNBA, NHL and MLB: injury status and
// notes, years of experience, birth dates and platform ids. Used to enrich a
// league directory, never as the directory itself.

import { fetchJson } from '../util.js';

export type SleeperSport = 'nba' | 'wnba' | 'nhl' | 'mlb';

export interface SleeperPlayer {
  player_id: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  team?: string | null;
  position?: string | null;
  fantasy_positions?: string[] | null;
  number?: number | null;
  status?: string | null;
  active?: boolean;
  injury_status?: string | null;
  injury_notes?: string | null;
  injury_body_part?: string | null;
  years_exp?: number | null;
  birth_date?: string | null;
  espn_id?: number | string | null;
  yahoo_id?: number | string | null;
  rotowire_id?: number | string | null;
  sportradar_id?: string | null;
  swish_id?: number | null;
  metadata?: Record<string, string> | null;
}

export async function players(sport: SleeperSport): Promise<SleeperPlayer[]> {
  const d = await fetchJson<Record<string, SleeperPlayer>>(`https://api.sleeper.app/v1/players/${sport}`, { timeoutMs: 90_000 });
  return Object.values(d).filter((p) => p && p.player_id && (p.full_name || p.last_name));
}

export function fullName(p: SleeperPlayer): string {
  return p.full_name ?? [p.first_name, p.last_name].filter(Boolean).join(' ');
}

/** Sleeper's injury strings normalised to the sport's own code vocabulary. */
export function injuryCode(p: SleeperPlayer): string | null {
  const s = (p.injury_status ?? '').trim();
  if (!s) return null;
  const u = s.toUpperCase();
  if (u === 'OUT') return 'O';
  if (u === 'SUS' || u === 'SUSP' || u === 'SUSPENDED') return 'SUSP';
  if (u === 'DTD' || u === 'GTD' || u === 'IR' || u === 'LTIR' || /^IL\d+$/.test(u) || u === 'PL' || u === 'Q' || u === 'D' || u === 'P') return u;
  if (u === 'QUESTIONABLE') return 'Q';
  if (u === 'DOUBTFUL') return 'D';
  if (u === 'PROBABLE') return 'P';
  return u;
}

export function birthDate(p: SleeperPlayer): string | null {
  return p.birth_date ?? p.metadata?.birth_date ?? null;
}

export function platformIds(p: SleeperPlayer): Record<string, string> {
  const out: Record<string, string> = { sleeper_id: String(p.player_id) };
  for (const k of ['espn_id', 'yahoo_id', 'rotowire_id', 'sportradar_id', 'swish_id'] as const) {
    const v = p[k];
    if (v !== null && v !== undefined && v !== '') out[k] = String(v);
  }
  return out;
}
