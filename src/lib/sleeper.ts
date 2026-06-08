// Sleeper league import — pull a league's rosters, standings, and settings by
// league id, then resolve every rostered player to a name / position / team.
// Sleeper's public API is CORS-open (access-control-allow-origin: *), so this
// all runs client-side in the browser, like the KTC and ESPN-schedule fetches.
// Docs: https://docs.sleeper.com/
import { fetchSleeperPlayers } from '../data';

const SLEEPER = 'https://api.sleeper.app/v1';

export interface SleeperLeagueInfo {
  league_id: string;
  name: string;
  season: string;
  status: string;
  total_rosters: number;
  roster_positions: string[];
  scoring_settings: Record<string, number>;
  settings?: { type?: number };
}

// Sleeper encodes league format in settings.type: 0 = redraft, 1 = keeper,
// 2 = dynasty. The rebuilding/contending framework (window labels, age curves,
// dynasty value) is only meaningful for dynasty; everything else is judged on
// projected score for the upcoming season.
export function isDynastyLeague(league: { settings?: { type?: number } } | null | undefined): boolean {
  return league?.settings?.type === 2;
}

interface RawRoster {
  roster_id: number;
  owner_id: string | null;
  starters: string[] | null;
  players: string[] | null;
  settings?: {
    wins?: number; losses?: number; ties?: number;
    fpts?: number; fpts_decimal?: number;
    fpts_against?: number; fpts_against_decimal?: number;
  };
}

interface RawUser {
  user_id: string;
  display_name: string;
  metadata?: { team_name?: string };
}

export interface RosterPlayer {
  id: string;
  name: string;
  position: string;
  team: string;
  slot: string; // starting-slot label (QB / FLEX / SUPER_FLEX / …) or "BN"
}

export interface LeagueTeam {
  rosterId: number;
  teamName: string;
  owner: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  ownerId: string | null;
  starters: RosterPlayer[];
  bench: RosterPlayer[];
}

export interface LeagueImport {
  league: SleeperLeagueInfo;
  teams: LeagueTeam[]; // sorted by standings (wins, then points for)
}

export interface SleeperUser {
  user_id: string;
  username: string;
  display_name: string;
  avatar: string | null;
}

export interface SleeperLeagueSummary {
  league_id: string;
  name: string;
  season: string;
  status: string;
  total_rosters: number;
  sport: string;
  roster_positions: string[];
  avatar: string | null;
  settings?: { type?: number };
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Sleeper API returned ${r.status} for ${url.replace(SLEEPER, '')}`);
  return r.json() as Promise<T>;
}

export async function fetchSleeperUser(username: string): Promise<SleeperUser> {
  const u = await getJson<SleeperUser | null>(`${SLEEPER}/user/${username.trim()}`);
  if (!u?.user_id) throw new Error(`No Sleeper user found for "${username}".`);
  return u;
}

export async function fetchUserLeagues(userId: string, season = '2026'): Promise<SleeperLeagueSummary[]> {
  const leagues = await getJson<SleeperLeagueSummary[]>(`${SLEEPER}/user/${userId}/leagues/nfl/${season}`);
  return leagues.filter((l) => l.sport === 'nfl');
}

interface RawRosterMinimal {
  roster_id: number;
  owner_id: string | null;
  players: string[] | null;
  starters: string[] | null;
  settings?: { wins?: number; losses?: number; fpts?: number; fpts_decimal?: number };
}

export interface UserLeagueRoster {
  leagueId: string;
  leagueName: string;
  totalRosters: number;
  rosterPositions: string[];
  isDynasty: boolean;
  players: string[];
  starters: string[];
  wins: number;
  losses: number;
  pointsFor: number;
}

export async function fetchUserRostersAcrossLeagues(
  userId: string,
  leagues: SleeperLeagueSummary[],
): Promise<UserLeagueRoster[]> {
  const results: UserLeagueRoster[] = [];
  const fetches = leagues.map(async (lg) => {
    try {
      const rosters = await getJson<RawRosterMinimal[]>(`${SLEEPER}/league/${lg.league_id}/rosters`);
      const mine = rosters.find((r) => r.owner_id === userId);
      if (!mine) return;
      results.push({
        leagueId: lg.league_id,
        leagueName: lg.name,
        totalRosters: lg.total_rosters,
        rosterPositions: lg.roster_positions,
        isDynasty: isDynastyLeague(lg),
        players: mine.players ?? [],
        starters: mine.starters ?? [],
        wins: mine.settings?.wins ?? 0,
        losses: mine.settings?.losses ?? 0,
        pointsFor: (mine.settings?.fpts ?? 0) + (mine.settings?.fpts_decimal ?? 0) / 100,
      });
    } catch { /* skip leagues that fail */ }
  });
  await Promise.all(fetches);
  return results;
}

export async function fetchLeagueRosteredIds(leagueId: string): Promise<Set<string>> {
  const rosters = await getJson<RawRosterMinimal[]>(`${SLEEPER}/league/${leagueId}/rosters`);
  const ids = new Set<string>();
  for (const r of rosters) {
    if (r.players) for (const pid of r.players) ids.add(pid);
  }
  return ids;
}

export interface SleeperTradedPick {
  season: string;
  round: number;
  roster_id: number;     // who currently owns it
  previous_owner_id: number;
  owner_id: number;      // original owner
}

export async function fetchTradedPicks(leagueId: string): Promise<SleeperTradedPick[]> {
  try {
    return await getJson<SleeperTradedPick[]>(`${SLEEPER}/league/${leagueId}/traded_picks`);
  } catch { return []; }
}

// Sleeper stores points as an integer part + hundredths (1802 + 8 → 1802.08).
const toPoints = (whole?: number, dec?: number) => (whole ?? 0) + (dec ?? 0) / 100;

// Team defenses are rostered under the team code itself ("BUF"), not a numeric id.
const DEF_ID = /^[A-Z]{2,4}$/;

export async function importLeague(leagueId: string): Promise<LeagueImport> {
  const id = leagueId.trim();
  if (!id) throw new Error('Enter a Sleeper league ID.');

  const [league, rosters, users, players] = await Promise.all([
    getJson<SleeperLeagueInfo | null>(`${SLEEPER}/league/${id}`),
    getJson<RawRoster[]>(`${SLEEPER}/league/${id}/rosters`),
    getJson<RawUser[]>(`${SLEEPER}/league/${id}/users`),
    fetchSleeperPlayers(),
  ]);
  if (!league?.league_id) throw new Error(`No league found for id "${id}".`);

  const userById = new Map(users.map((u) => [u.user_id, u]));
  const startSlots = (league.roster_positions ?? []).filter((p) => p !== 'BN');

  const resolve = (pid: string, slot: string): RosterPlayer => {
    if (!pid || pid === '0') return { id: pid, name: 'Empty', position: '', team: '', slot };
    const p = players.get(pid);
    if (p) return { id: pid, name: p.full_name, position: p.position, team: p.team, slot };
    if (DEF_ID.test(pid)) return { id: pid, name: `${pid} D/ST`, position: 'DEF', team: pid, slot };
    return { id: pid, name: `#${pid}`, position: '?', team: '', slot };
  };

  const teams: LeagueTeam[] = rosters.map((r) => {
    const u = r.owner_id ? userById.get(r.owner_id) : undefined;
    const starterIds = r.starters ?? [];
    const starters = starterIds.map((pid, i) => resolve(pid, startSlots[i] ?? 'FLEX'));
    const starterSet = new Set(starterIds.filter((pid) => pid && pid !== '0'));
    const bench = (r.players ?? [])
      .filter((pid) => !starterSet.has(pid))
      .map((pid) => resolve(pid, 'BN'));
    return {
      rosterId: r.roster_id,
      teamName: u?.metadata?.team_name || u?.display_name || `Team ${r.roster_id}`,
      owner: u?.display_name || '—',
      ownerId: r.owner_id ?? null,
      wins: r.settings?.wins ?? 0,
      losses: r.settings?.losses ?? 0,
      ties: r.settings?.ties ?? 0,
      pointsFor: toPoints(r.settings?.fpts, r.settings?.fpts_decimal),
      pointsAgainst: toPoints(r.settings?.fpts_against, r.settings?.fpts_against_decimal),
      starters,
      bench,
    };
  });

  teams.sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor);
  return { league, teams };
}
