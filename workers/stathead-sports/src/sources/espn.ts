// ESPN public endpoints: the site API (scoreboards, box scores, teams,
// rosters, injuries) and the fantasy API (player universe, ADP). Both are
// unofficial; see DATA_SOURCES.md.

import { fetchJson, nowIso } from '../util.js';

export type EspnLeague = 'nba' | 'wnba';
export type EspnFantasyGame = 'fba' | 'wfba' | 'fhl' | 'flb';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const FANTASY = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games';

const SPORT_PATH: Record<EspnLeague, string> = { nba: 'basketball/nba', wnba: 'basketball/wnba' };

export interface EspnEvent {
  id: string;
  date: string;
  season?: { year: number; type: number };
  competitions: Array<{
    id: string;
    date: string;
    status: { type: { name: string; state: string; completed: boolean; detail?: string }; displayClock?: string; period?: number };
    competitors: Array<{ homeAway: 'home' | 'away'; score?: string; team: { id: string; abbreviation: string; displayName: string } }>;
  }>;
}

/** `dates` is YYYYMMDD for one day or YYYYMM for a month. */
export async function scoreboard(league: EspnLeague, dates: string): Promise<EspnEvent[]> {
  const d = await fetchJson<{ events?: EspnEvent[] }>(`${SITE}/${SPORT_PATH[league]}/scoreboard?dates=${dates}&limit=1000`);
  return d.events ?? [];
}

export interface EspnSummary {
  boxscore: {
    players?: Array<{
      team: { id: string; abbreviation: string };
      statistics: Array<{
        keys: string[];
        athletes: Array<{
          athlete: { id: string; displayName: string; position?: { abbreviation?: string } };
          starter?: boolean;
          didNotPlay?: boolean;
          reason?: string;
          stats: string[];
        }>;
      }>;
    }>;
  };
  header: { id: string; season?: { year: number; type: number }; competitions: EspnEvent['competitions'] };
}

export function summary(league: EspnLeague, eventId: string): Promise<EspnSummary> {
  return fetchJson<EspnSummary>(`${SITE}/${SPORT_PATH[league]}/summary?event=${encodeURIComponent(eventId)}`);
}

export async function teams(league: EspnLeague): Promise<Array<{ id: string; abbreviation: string; displayName: string }>> {
  const d = await fetchJson<any>(`${SITE}/${SPORT_PATH[league]}/teams?limit=50`);
  const list = d?.sports?.[0]?.leagues?.[0]?.teams ?? [];
  return list.map((t: any) => ({ id: String(t.team.id), abbreviation: t.team.abbreviation, displayName: t.team.displayName }));
}

export interface EspnRosterAthlete {
  id: string;
  fullName: string;
  jersey?: string;
  position?: { abbreviation?: string };
  injuries?: Array<{ status?: string; details?: { type?: string } }>;
  status?: { type?: string; name?: string };
  experience?: { years?: number };
  dateOfBirth?: string;
  headshot?: { href?: string };
}

export async function roster(league: EspnLeague, teamId: string): Promise<EspnRosterAthlete[]> {
  const d = await fetchJson<any>(`${SITE}/${SPORT_PATH[league]}/teams/${teamId}/roster`);
  return d?.athletes ?? [];
}

export interface EspnFantasyPlayer {
  id: number;
  fullName: string;
  firstName?: string;
  lastName?: string;
  proTeamId: number;
  defaultPositionId: number;
  eligibleSlots?: number[];
  jersey?: string;
  active?: boolean;
  injured?: boolean;
  injuryStatus?: string;
  ownership?: { averageDraftPosition?: number; percentOwned?: number; date?: number };
  draftRanksByRankType?: Record<string, { rank?: number }>;
}

/**
 * The fantasy game's whole player universe with injury status, jersey and ADP.
 * ESPN requires a sort whenever a limit is given.
 */
export async function fantasyPlayers(game: EspnFantasyGame, season: number, limit = 4000): Promise<EspnFantasyPlayer[]> {
  const filter = JSON.stringify({ players: { limit, sortPercOwned: { sortPriority: 1, sortAsc: false } } });
  const d = await fetchJson<EspnFantasyPlayer[]>(`${FANTASY}/${game}/seasons/${season}/players?view=kona_player_info`, {
    headers: { 'X-Fantasy-Filter': filter },
    timeoutMs: 90_000,
  });
  return Array.isArray(d) ? d : [];
}

/**
 * ESPN draft ADP for a season. ESPN parks every player at one sentinel value
 * (the last pick of a default draft) when no drafts have happened yet or
 * the game has been reset, so a board where the modal value covers most rows
 * is treated as unpopulated and returns no rows.
 */
export async function fantasyAdp(game: EspnFantasyGame, season: number): Promise<{ as_of: string; rows: Array<{ espn_id: string; name: string; proTeamId: number; adp: number }> }> {
  const players = await fantasyPlayers(game, season, 1500);
  const withAdp = players.filter((p) => typeof p.ownership?.averageDraftPosition === 'number' && p.ownership.averageDraftPosition > 0);
  if (withAdp.length === 0) return { as_of: nowIso(), rows: [] };
  const counts = new Map<number, number>();
  for (const p of withAdp) counts.set(p.ownership!.averageDraftPosition!, (counts.get(p.ownership!.averageDraftPosition!) ?? 0) + 1);
  let modal = 0;
  let modalN = 0;
  for (const [v, n] of counts) if (n > modalN) ((modal = v), (modalN = n));
  const sentinel = modalN / withAdp.length > 0.5 ? modal : null;
  const rows = withAdp
    .filter((p) => sentinel === null || p.ownership!.averageDraftPosition! < sentinel)
    .map((p) => ({ espn_id: String(p.id), name: p.fullName, proTeamId: p.proTeamId, adp: p.ownership!.averageDraftPosition! }));
  const stamp = Math.max(0, ...withAdp.map((p) => p.ownership?.date ?? 0));
  return { as_of: stamp ? new Date(stamp).toISOString() : nowIso(), rows: rows.length >= 20 ? rows : [] };
}

export function headshotUrl(league: EspnLeague, espnId: string): string {
  return `https://a.espncdn.com/i/headshots/${league}/players/full/${espnId}.png`;
}

/** ESPN fantasy injuryStatus → the consumer's basketball vocabulary. */
export function injuryCode(status: string | undefined | null): string | null {
  switch ((status ?? '').toUpperCase()) {
    case '':
    case 'ACTIVE':
    case 'NORMAL':
      return null;
    case 'OUT':
      return 'O';
    case 'DOUBTFUL':
      return 'D';
    case 'QUESTIONABLE':
      return 'Q';
    case 'PROBABLE':
      return 'P';
    case 'DAY_TO_DAY':
      return 'GTD';
    case 'SUSPENSION':
      return 'SUSP';
    case 'INJURY_RESERVE':
    case 'IR':
      return 'OFS';
    default:
      return status!.toUpperCase();
  }
}
