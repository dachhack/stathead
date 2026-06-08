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
  settings?: { type?: number; best_ball?: number };
}

// Sleeper encodes league format in settings.type: 0 = redraft, 1 = keeper,
// 2 = dynasty. The rebuilding/contending framework (window labels, age curves,
// dynasty value) is only meaningful for dynasty; everything else is judged on
// projected score for the upcoming season.
export function isDynastyLeague(league: { settings?: { type?: number } } | null | undefined): boolean {
  return league?.settings?.type === 2;
}

export function leagueTypeName(league: { settings?: { type?: number } } | null | undefined): 'Dynasty' | 'Keeper' | 'Redraft' {
  const t = league?.settings?.type;
  if (t === 2) return 'Dynasty';
  if (t === 1) return 'Keeper';
  return 'Redraft';
}

export function isBestBall(league: { settings?: { best_ball?: number } } | null | undefined): boolean {
  return league?.settings?.best_ball === 1;
}

// IDP roster slots Sleeper uses. Presence of any means the league starts
// defensive players individually (not just team D/ST).
const IDP_SLOTS = new Set(['DL', 'LB', 'DB', 'IDP_FLEX', 'DE', 'DT', 'CB', 'S', 'SS', 'FS', 'IDP']);
export function hasIDP(rosterPositions: string[] | undefined | null): boolean {
  return (rosterPositions ?? []).some((p) => IDP_SLOTS.has(p));
}

// QB format from the roster slots: Superflex, 2QB, or single-QB.
export function qbFormatLabel(rosterPositions: string[] | undefined | null): 'Superflex' | '2QB' | '1QB' {
  const positions = rosterPositions ?? [];
  if (positions.includes('SUPER_FLEX')) return 'Superflex';
  if (positions.filter((p) => p === 'QB').length >= 2) return '2QB';
  return '1QB';
}

export interface LeagueFormatInfo {
  type: 'Dynasty' | 'Keeper' | 'Redraft';
  qb: 'Superflex' | '2QB' | '1QB';
  bestBall: boolean;
  idp: boolean;
}

// One-stop format summary for league-listing rows.
export function leagueFormatInfo(
  league: { settings?: { type?: number; best_ball?: number }; roster_positions?: string[] } | null | undefined,
): LeagueFormatInfo {
  return {
    type: leagueTypeName(league),
    qb: qbFormatLabel(league?.roster_positions),
    bestBall: isBestBall(league),
    idp: hasIDP(league?.roster_positions),
  };
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
  settings?: { type?: number; best_ball?: number };
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
  roster_id: number;        // the pick's ORIGINAL owner (defines its draft slot)
  previous_owner_id: number; // the roster that gave it up in the latest trade
  owner_id: number;          // the CURRENT owner (who holds it now)
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

// ── Multi-season user history ────────────────────────────────────────────
// Sleeper has no "all my leagues ever" or per-user transaction endpoint, so we
// sweep a window of seasons and fan out per-league requests with bounded
// concurrency.

// Most recent `count` NFL seasons ending at `endYear` (inclusive), newest first.
export function recentSeasons(count = 9, endYear = new Date().getFullYear()): string[] {
  return Array.from({ length: count }, (_, i) => String(endYear - i));
}

// Run `fn` over `items` with at most `limit` in flight at once.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 0 }, worker));
  return results;
}

interface BracketMatch { r: number; m: number; w?: number | null; l?: number | null; p?: number }

export interface LeagueSeasonRecord {
  season: string;
  leagueId: string;
  leagueName: string;
  status: string;
  format: LeagueFormatInfo;
  totalRosters: number;
  rosterId: number | null;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  regSeasonRank: number; // 1 = best; 0 if the user's roster wasn't found
  champion: boolean;
  runnerUp: boolean;
  players: string[]; // the user's rostered player ids (for window classification)
}

// Every league the user fielded across the given seasons, with their record,
// regular-season finish, and (for completed leagues) championship result.
export async function fetchUserHistory(userId: string, seasons: string[]): Promise<LeagueSeasonRecord[]> {
  const perSeason = await mapLimit(seasons, 6, async (season) => {
    try {
      const leagues = await fetchUserLeagues(userId, season);
      return leagues.map((league) => ({ season, league }));
    } catch { return []; }
  });
  const pairs = perSeason.flat();

  const records = await mapLimit(pairs, 8, async ({ season, league }) => {
    try {
      const rosters = await getJson<RawRoster[]>(`${SLEEPER}/league/${league.league_id}/rosters`);
      const mine = rosters.find((r) => r.owner_id === userId) ?? null;
      const ranked = [...rosters].sort((a, b) =>
        (b.settings?.wins ?? 0) - (a.settings?.wins ?? 0) ||
        toPoints(b.settings?.fpts, b.settings?.fpts_decimal) - toPoints(a.settings?.fpts, a.settings?.fpts_decimal));
      const regSeasonRank = mine ? ranked.findIndex((r) => r.roster_id === mine.roster_id) + 1 : 0;

      let champion = false;
      let runnerUp = false;
      if (league.status === 'complete' && mine) {
        try {
          const bracket = await getJson<BracketMatch[]>(`${SLEEPER}/league/${league.league_id}/winners_bracket`);
          const final = bracket.find((b) => b.p === 1);
          if (final) {
            champion = final.w === mine.roster_id;
            runnerUp = final.l === mine.roster_id;
          }
        } catch { /* league without a bracket */ }
      }

      return {
        season,
        leagueId: league.league_id,
        leagueName: league.name,
        status: league.status,
        format: leagueFormatInfo(league),
        totalRosters: league.total_rosters,
        rosterId: mine?.roster_id ?? null,
        wins: mine?.settings?.wins ?? 0,
        losses: mine?.settings?.losses ?? 0,
        ties: mine?.settings?.ties ?? 0,
        pointsFor: toPoints(mine?.settings?.fpts, mine?.settings?.fpts_decimal),
        regSeasonRank,
        champion,
        runnerUp,
        players: mine?.players ?? [],
      } as LeagueSeasonRecord;
    } catch { return null; }
  });

  return records.filter((r): r is LeagueSeasonRecord => r !== null);
}

interface RawTransaction { type: string; status: string; roster_ids?: number[] }

export interface TradeActivity {
  totalTrades: number;
  leaguesAnalyzed: number;
  bySeason: Record<string, number>;
  capped: boolean; // true if we hit the request cap and didn't scan everything
}

// Count completed trades the user was party to, sweeping weekly transaction
// logs. There's no per-user endpoint, so this is bounded: newest seasons first,
// capped at MAX_TASKS week-requests total.
export async function fetchUserTradeActivity(
  records: LeagueSeasonRecord[],
  onProgress?: (done: number, total: number) => void,
): Promise<TradeActivity> {
  const WEEKS = 18;
  const MAX_TASKS = 700;
  const usable = records
    .filter((r) => r.rosterId != null && r.status !== 'pre_draft' && r.status !== 'drafting')
    .sort((a, b) => b.season.localeCompare(a.season));

  const tasks: { rec: LeagueSeasonRecord; week: number }[] = [];
  let capped = false;
  for (const rec of usable) {
    if (tasks.length >= MAX_TASKS) { capped = true; break; }
    for (let w = 1; w <= WEEKS; w++) tasks.push({ rec, week: w });
  }

  const bySeason: Record<string, number> = {};
  const analyzed = new Set<string>();
  let done = 0;
  await mapLimit(tasks, 12, async ({ rec, week }) => {
    try {
      const txns = await getJson<RawTransaction[]>(`${SLEEPER}/league/${rec.leagueId}/transactions/${week}`);
      analyzed.add(rec.leagueId);
      for (const t of txns ?? []) {
        if (t.type === 'trade' && t.status === 'complete' && rec.rosterId != null && (t.roster_ids ?? []).includes(rec.rosterId)) {
          bySeason[rec.season] = (bySeason[rec.season] ?? 0) + 1;
        }
      }
    } catch { /* ignore missing weeks */ }
    onProgress?.(++done, tasks.length);
  });

  const totalTrades = Object.values(bySeason).reduce((a, b) => a + b, 0);
  return { totalTrades, leaguesAnalyzed: analyzed.size, bySeason, capped };
}
