// 2026 NFL schedule + strength-of-schedule, fetched live from ESPN's public
// scoreboard API at runtime (client-side; the app already does live fetches
// like Dynasty). Includes preseason. Opponent strength for SOS comes from our own
// team offensive projections.
import teamProjections from '../generated/team-projections.json';

export const SCHEDULE_SEASON = 2026;

export interface SchedGame {
  week: number;          // ESPN week number within the season type
  seasonType: 1 | 2;     // 1 = preseason, 2 = regular season
  date: string;          // ISO datetime (kickoff)
  opp: string;           // opponent team code (our codes)
  home: boolean;         // true if this team is home
  venue: string;         // stadium name
  city: string;          // "City, ST"
  network: string;       // TV network(s)
}

export interface TeamSchedule { reg: SchedGame[]; pre: SchedGame[]; }
export type ScheduleByTeam = Record<string, TeamSchedule>;

// ESPN uses a couple of abbreviations that differ from our team codes.
const ESPN_TO_OURS: Record<string, string> = { LAR: 'LA', WSH: 'WAS' };
const fixTeam = (a: string) => ESPN_TO_OURS[a] ?? a;

interface EspnCompetitor { homeAway: string; team?: { abbreviation?: string } }
interface EspnEvent {
  date?: string;
  week?: { number?: number };
  season?: { type?: number };
  competitions?: Array<{
    venue?: { fullName?: string; address?: { city?: string; state?: string } };
    competitors?: EspnCompetitor[];
    broadcasts?: Array<{ names?: string[] }>;
    geoBroadcasts?: Array<{ media?: { shortName?: string } }>;
  }>;
}

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

async function fetchWeek(seasonType: 1 | 2, week: number): Promise<EspnEvent[]> {
  const url = `${SCOREBOARD}?seasontype=${seasonType}&week=${week}&dates=${SCHEDULE_SEASON}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const d = (await r.json()) as { events?: EspnEvent[] };
    return d.events ?? [];
  } catch {
    return [];
  }
}

function networkOf(comp: NonNullable<EspnEvent['competitions']>[number]): string {
  const fromBroadcasts = (comp.broadcasts ?? []).flatMap((b) => b.names ?? []);
  if (fromBroadcasts.length) return Array.from(new Set(fromBroadcasts)).join('/');
  const fromGeo = (comp.geoBroadcasts ?? []).map((g) => g.media?.shortName).filter(Boolean) as string[];
  return Array.from(new Set(fromGeo)).join('/');
}

interface CommittedSchedule { season: number; updated?: string; games?: Array<{ week: number; date: string; away: string; home: string; venue: string; neutral?: boolean; network?: string }> }

/** Best-effort ESPN overlay: fill TV network (and city) on regular-season games
 *  and populate the preseason. ESPN's host must be reachable from the browser;
 *  failures are swallowed so the committed regular season still renders. */
async function overlayEspn(byTeam: ScheduleByTeam, ensure: (t: string) => TeamSchedule, mergePre = false): Promise<void> {
  const jobs: Promise<{ seasonType: 1 | 2; events: EspnEvent[] }>[] = [];
  for (let w = 1; w <= 4; w++) jobs.push(fetchWeek(1, w).then((events) => ({ seasonType: 1 as const, events })));
  for (let w = 1; w <= 18; w++) jobs.push(fetchWeek(2, w).then((events) => ({ seasonType: 2 as const, events })));
  const results = await Promise.all(jobs);
  for (const { seasonType, events } of results) {
    for (const ev of events) {
      const comp = ev.competitions?.[0];
      if (!comp) continue;
      const ht = comp.competitors?.find((c) => c.homeAway === 'home')?.team?.abbreviation;
      const at = comp.competitors?.find((c) => c.homeAway === 'away')?.team?.abbreviation;
      if (!ht || !at) continue;
      const homeT = fixTeam(ht), awayT = fixTeam(at);
      const venue = comp.venue?.fullName ?? '';
      const addr = comp.venue?.address;
      const city = addr?.city ? `${addr.city}${addr.state ? ', ' + addr.state : ''}` : '';
      const network = networkOf(comp);
      const week = ev.week?.number ?? 0;
      const date = ev.date ?? '';
      if (seasonType === 1) {
        if (mergePre) {
          // merge network/venue/city onto committed preseason (match by opponent)
          for (const [team, opp] of [[homeT, awayT], [awayT, homeT]] as const) {
            const g = byTeam[team]?.pre.find((x) => x.opp === opp);
            if (g) { if (network) g.network = network; if (venue && !g.venue) g.venue = venue; if (city && !g.city) g.city = city; }
          }
        } else {
          ensure(homeT).pre.push({ week, seasonType: 1, date, opp: awayT, home: true, venue, city, network });
          ensure(awayT).pre.push({ week, seasonType: 1, date, opp: homeT, home: false, venue, city, network });
        }
      } else {
        // merge network/city onto the committed regular-season game
        for (const [team, opp] of [[homeT, awayT], [awayT, homeT]] as const) {
          const g = byTeam[team]?.reg.find((x) => x.week === week && x.opp === opp);
          if (g) { if (network) g.network = network; if (city && !g.city) g.city = city; }
        }
      }
    }
  }
}

/** Full 2026 schedule by team. Regular season comes from the committed nflverse
 *  snapshot (reliable, build-reachable); TV network + preseason are overlaid
 *  live from ESPN when the browser can reach it. */
export async function fetchNflSchedule(): Promise<{ byTeam: ScheduleByTeam; updated: number; grades: UnitGradesByTeam | null; matchups: MatchupsByKey; teamProj: TeamProjByTeam | null }> {
  const byTeam: ScheduleByTeam = {};
  const ensure = (t: string) => (byTeam[t] ??= { reg: [], pre: [] });

  let updated = Date.now();
  try {
    const committed = await fetch(`${import.meta.env.BASE_URL}data/schedule-${SCHEDULE_SEASON}.json`)
      .then((r) => (r.ok ? (r.json() as Promise<CommittedSchedule>) : null));
    if (committed?.games?.length) {
      if (committed.updated) updated = Date.parse(committed.updated) || updated;
      for (const g of committed.games) {
        const net = g.network ?? '';
        ensure(g.home).reg.push({ week: g.week, seasonType: 2, date: g.date, opp: g.away, home: true, venue: g.venue, city: '', network: net });
        ensure(g.away).reg.push({ week: g.week, seasonType: 2, date: g.date, opp: g.home, home: false, venue: g.venue, city: '', network: net });
      }
    }
  } catch {
    // committed file missing — fall through to ESPN-only overlay
  }

  // Committed preseason (entered from published matchups; ESPN adds network/venue).
  let hasPre = false;
  try {
    const pre = await fetch(`${import.meta.env.BASE_URL}data/schedule-preseason-${SCHEDULE_SEASON}.json`)
      .then((r) => (r.ok ? (r.json() as Promise<CommittedSchedule>) : null));
    if (pre?.games?.length) {
      hasPre = true;
      for (const g of pre.games) {
        ensure(g.home).pre.push({ week: g.week, seasonType: 1, date: g.date, opp: g.away, home: true, venue: g.venue, city: '', network: g.network ?? '' });
        ensure(g.away).pre.push({ week: g.week, seasonType: 1, date: g.date, opp: g.home, home: false, venue: g.venue, city: '', network: g.network ?? '' });
      }
    }
  } catch { /* optional */ }

  try { await overlayEspn(byTeam, ensure, hasPre); } catch { /* ESPN unreachable — keep committed data */ }

  const [grades, matchups, teamProj] = await Promise.all([
    fetchUnitGrades(), fetchMatchups(), fetchTeamProjections(),
  ]);

  for (const t of Object.values(byTeam)) {
    t.reg.sort((a, b) => a.week - b.week);
    t.pre.sort((a, b) => a.week - b.week);
  }
  return { byTeam, updated, grades, matchups, teamProj };
}

// ── Consensus unit grades (opponent quality for SOS) ──
export interface UnitGrades {
  units: Record<string, number>;
  overall: number; overall_rk: number;
  offense: number; offense_rk: number;
  defense: number; defense_rk: number;
}
export type UnitGradesByTeam = Record<string, UnitGrades>;

/** Load the committed Consensus unit grades (scripts/extract_consensus_unit_grades.py).
 *  Returns null when absent so SOS falls back to the offense-only proxy. */
export async function fetchUnitGrades(season = SCHEDULE_SEASON): Promise<UnitGradesByTeam | null> {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}data/clay-unit-grades-${season}.json`);
    if (!r.ok) return null;
    const d = (await r.json()) as { teams?: UnitGradesByTeam };
    return d.teams ?? null;
  } catch {
    return null;
  }
}

// ── Consensus matchups (projected score + win prob) ──
export interface Matchup {
  week: number; home: string; away: string;
  home_pts: number; away_pts: number; home_win_prob: number;
}
export type MatchupsByKey = Map<string, Matchup>; // `${week}|${home}|${away}`
const matchupKey = (week: number, home: string, away: string) => `${week}|${home}|${away}`;

export async function fetchMatchups(season = SCHEDULE_SEASON): Promise<MatchupsByKey> {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}data/clay-matchups-${season}.json`);
    if (!r.ok) return new Map();
    const d = (await r.json()) as { games?: Matchup[] };
    return new Map((d.games ?? []).map((g) => [matchupKey(g.week, g.home, g.away), g]));
  } catch {
    return new Map();
  }
}

/** Projected score + win prob for `team` in a given week vs `opp`, from team's
 *  perspective. Returns null when no matchup data is loaded for that game. */
export function matchupFor(
  matchups: MatchupsByKey, week: number, team: string, opp: string, home: boolean,
): { teamPts: number; oppPts: number; winProb: number } | null {
  const [h, a] = home ? [team, opp] : [opp, team];
  const g = matchups.get(matchupKey(week, h, a));
  if (!g) return null;
  return home
    ? { teamPts: g.home_pts, oppPts: g.away_pts, winProb: g.home_win_prob }
    : { teamPts: g.away_pts, oppPts: g.home_pts, winProb: 100 - g.home_win_prob };
}

// ── Consensus team season projections ──
export interface TeamProjection {
  points_for: number; points_against: number;
  proj_wins: number; wins_rank: number; sos_rank: number;
  off_rk: number; def_rk: number; ovr_rk: number;
}
export type TeamProjByTeam = Record<string, TeamProjection>;

export async function fetchTeamProjections(season = SCHEDULE_SEASON): Promise<TeamProjByTeam | null> {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}data/clay-team-projections-${season}.json`);
    if (!r.ok) return null;
    const d = (await r.json()) as { teams?: TeamProjByTeam };
    return d.teams ?? null;
  } catch {
    return null;
  }
}

// ── Opponent strength + SOS (regular season only) ──
const TP = (teamProjections as { teams: Record<string, { passTD: number; rushTD: number; passYds: number; rushYds: number }> }).teams;

// Fallback opponent-quality proxy when Consensus unit grades are unavailable:
// the opponent's own offensive output. Coarse, but build-reachable everywhere.
function offenseProxy(team: string): number {
  const t = TP[team];
  if (!t) return 0;
  return (t.passTD + t.rushTD) + (t.passYds + t.rushYds) / 300;
}

/** Opponent difficulty for SOS — how tough a team is to produce fantasy points
 *  against. Uses the opponent's Consensus DEFENSE grade when available (higher =
 *  harder), otherwise falls back to the offense-only proxy. */
export function teamStrength(team: string, grades?: UnitGradesByTeam | null): number {
  const g = grades?.[team];
  return g ? g.defense : offenseProxy(team);
}

/** Build a 0–100 normalized difficulty index over the league, for display.
 *  Normalizes against whichever metric `teamStrength` is using. */
export function makeStrengthIndex(grades?: UnitGradesByTeam | null): (team: string) => number {
  const codes = Object.keys(grades ?? TP);
  const vals = codes.map((c) => teamStrength(c, grades));
  const min = Math.min(...vals), max = Math.max(...vals);
  const out: Record<string, number> = {};
  codes.forEach((c, i) => { out[c] = max > min ? Math.round(((vals[i] - min) / (max - min)) * 100) : 50; });
  return (team: string) => out[team] ?? 0;
}

export interface TeamSOS {
  overall: number; t1: number; t2: number; t3: number; // avg opponent strength
  overallRank: number; t1Rank: number; t2Rank: number; t3Rank: number; // 1 = hardest
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/** Compute SOS for every team from regular-season opponents. Thirds = weeks
 *  1–6, 7–12, 13–18. Rank 1 = hardest (highest avg opponent strength). */
export function computeSOS(byTeam: ScheduleByTeam, grades?: UnitGradesByTeam | null): Record<string, TeamSOS> {
  const raw: Record<string, { overall: number; t1: number; t2: number; t3: number }> = {};
  for (const [team, sched] of Object.entries(byTeam)) {
    const inThird = (lo: number, hi: number) => sched.reg.filter((g) => g.week >= lo && g.week <= hi).map((g) => teamStrength(g.opp, grades));
    raw[team] = {
      overall: avg(sched.reg.map((g) => teamStrength(g.opp, grades))),
      t1: avg(inThird(1, 6)),
      t2: avg(inThird(7, 12)),
      t3: avg(inThird(13, 18)),
    };
  }
  const rankBy = (key: 'overall' | 't1' | 't2' | 't3') => {
    const order = Object.keys(raw).sort((a, b) => raw[b][key] - raw[a][key]); // desc → 1 hardest
    const r: Record<string, number> = {};
    order.forEach((t, i) => { r[t] = i + 1; });
    return r;
  };
  const ro = rankBy('overall'), r1 = rankBy('t1'), r2 = rankBy('t2'), r3 = rankBy('t3');
  const out: Record<string, TeamSOS> = {};
  for (const team of Object.keys(raw)) {
    out[team] = {
      ...raw[team],
      overallRank: ro[team], t1Rank: r1[team], t2Rank: r2[team], t3Rank: r3[team],
    };
  }
  return out;
}

// ── Defensive sub-units (from the Consensus unit grades) ──
// Groups the per-position grades (DI/ED/LB/CB/S) into the matchup-relevant
// defensive units so SOS can be broken down by what a player actually faces.
export const DEF_UNIT_GROUPS = [
  { key: 'dline', label: 'D-Line', units: ['DI', 'ED'], hint: 'Interior + edge — run front & pass rush' },
  { key: 'lb', label: 'LB', units: ['LB'], hint: 'Linebackers' },
  { key: 'secondary', label: 'Secondary', units: ['CB', 'S'], hint: 'Corners + safeties — pass coverage' },
] as const;
export type DefUnitKey = typeof DEF_UNIT_GROUPS[number]['key'];

/** Average Consensus grade for a team's defensive sub-unit (higher = stronger);
 *  null when grades are missing for the team. */
export function unitGroupGrade(team: string, units: readonly string[], grades?: UnitGradesByTeam | null): number | null {
  const u = grades?.[team]?.units;
  if (!u) return null;
  const vals = units.map((k) => u[k]).filter((v): v is number => typeof v === 'number');
  return vals.length ? avg(vals) : null;
}

/** 0–100 league-normalized strength index for a defensive sub-unit (higher =
 *  tougher matchup). Returns null per-team when grades are unavailable. */
export function makeUnitStrengthIndex(
  grades: UnitGradesByTeam | null | undefined,
  units: readonly string[],
): (team: string) => number | null {
  if (!grades) return () => null;
  const codes = Object.keys(grades);
  const vals = codes.map((c) => unitGroupGrade(c, units, grades) ?? 0);
  const min = Math.min(...vals), max = Math.max(...vals);
  const out: Record<string, number> = {};
  codes.forEach((c, i) => { out[c] = max > min ? Math.round(((vals[i] - min) / (max - min)) * 100) : 50; });
  return (team: string) => (grades[team] ? out[team] ?? 0 : null);
}

export interface UnitSOS { idx: number; rank: number; }

/** Season SOS broken down by defensive sub-unit: each team's average opponent
 *  sub-unit grade + a league rank (1 = hardest). Empty when grades are absent. */
export function computeUnitSOS(
  byTeam: ScheduleByTeam,
  grades: UnitGradesByTeam | null | undefined,
): Record<string, Record<DefUnitKey, UnitSOS>> {
  const out: Record<string, Record<DefUnitKey, UnitSOS>> = {};
  if (!grades) return out;
  const raw: Record<string, Record<string, number>> = {};
  for (const [team, sched] of Object.entries(byTeam)) {
    raw[team] = {};
    for (const u of DEF_UNIT_GROUPS) {
      const vals = sched.reg
        .map((g) => unitGroupGrade(g.opp, u.units, grades))
        .filter((v): v is number => v != null);
      raw[team][u.key] = avg(vals);
    }
  }
  for (const u of DEF_UNIT_GROUPS) {
    const order = Object.keys(raw).sort((a, b) => raw[b][u.key] - raw[a][u.key]); // desc → 1 hardest
    const rank: Record<string, number> = {};
    order.forEach((t, i) => { rank[t] = i + 1; });
    for (const t of Object.keys(raw)) {
      if (!out[t]) out[t] = {} as Record<DefUnitKey, UnitSOS>;
      out[t][u.key] = { idx: raw[t][u.key], rank: rank[t] };
    }
  }
  return out;
}
