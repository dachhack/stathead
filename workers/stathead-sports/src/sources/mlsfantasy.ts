// MLS Fantasy's public player and squad feeds (gzip JSON on S3): availability
// per player (playing / uncertain / not-playing) and a stable fantasy id.
// Used to enrich the ESPN roster directory for MLS.

import { fetchJson } from '../util.js';

const BASE = 'https://fgp-data-us.s3.amazonaws.com/json/mls_mls';

export interface MlsFantasyPlayer {
  id: number;
  sportec_id?: string;
  first_name: string;
  last_name: string;
  known_name?: string | null;
  squad_id: number;
  status: 'playing' | 'uncertain' | 'not-playing' | string;
  positions?: number[];
  locked?: boolean;
}

export interface MlsFantasySquad {
  id: number;
  full_name: string;
  name: string;
  short_name: string;
}

export async function players(): Promise<MlsFantasyPlayer[]> {
  const d = await fetchJson<MlsFantasyPlayer[]>(`${BASE}/players.json`, { timeoutMs: 60_000 });
  return Array.isArray(d) ? d : [];
}

export async function squads(): Promise<MlsFantasySquad[]> {
  const d = await fetchJson<MlsFantasySquad[]>(`${BASE}/squads.json`);
  return Array.isArray(d) ? d : [];
}

export function fullName(p: MlsFantasyPlayer): string {
  const n = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim();
  return n || p.known_name || '';
}

export function injuryCode(p: MlsFantasyPlayer): string | null {
  switch (p.status) {
    case 'uncertain':
      return 'Q';
    case 'not-playing':
      return 'O';
    default:
      return null;
  }
}
