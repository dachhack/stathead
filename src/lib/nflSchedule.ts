// 2026 NFL schedule + strength-of-schedule, fetched live from ESPN's public
// scoreboard API at runtime (client-side; the app already does live fetches
// like KTC). Includes preseason. Opponent strength for SOS comes from our own
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

/** Fetch the full 2026 schedule (preseason + regular season) grouped by team. */
export async function fetchNflSchedule(): Promise<{ byTeam: ScheduleByTeam; updated: number }> {
  const jobs: Promise<{ seasonType: 1 | 2; events: EspnEvent[] }>[] = [];
  for (let w = 1; w <= 4; w++) jobs.push(fetchWeek(1, w).then((events) => ({ seasonType: 1 as const, events })));
  for (let w = 1; w <= 18; w++) jobs.push(fetchWeek(2, w).then((events) => ({ seasonType: 2 as const, events })));
  const results = await Promise.all(jobs);

  const byTeam: ScheduleByTeam = {};
  const ensure = (t: string) => (byTeam[t] ??= { reg: [], pre: [] });

  for (const { seasonType, events } of results) {
    for (const ev of events) {
      const comp = ev.competitions?.[0];
      if (!comp) continue;
      const home = comp.competitors?.find((c) => c.homeAway === 'home');
      const away = comp.competitors?.find((c) => c.homeAway === 'away');
      const ht = home?.team?.abbreviation;
      const at = away?.team?.abbreviation;
      if (!ht || !at) continue;
      const homeT = fixTeam(ht), awayT = fixTeam(at);
      const venue = comp.venue?.fullName ?? '';
      const addr = comp.venue?.address;
      const city = addr?.city ? `${addr.city}${addr.state ? ', ' + addr.state : ''}` : '';
      const network = networkOf(comp);
      const week = ev.week?.number ?? 0;
      const date = ev.date ?? '';
      const list = (t: TeamSchedule) => (seasonType === 1 ? t.pre : t.reg);
      list(ensure(homeT)).push({ week, seasonType, date, opp: awayT, home: true, venue, city, network });
      list(ensure(awayT)).push({ week, seasonType, date, opp: homeT, home: false, venue, city, network });
    }
  }
  for (const t of Object.values(byTeam)) {
    t.reg.sort((a, b) => a.week - b.week);
    t.pre.sort((a, b) => a.week - b.week);
  }
  return { byTeam, updated: Date.now() };
}

// ── Opponent strength + SOS (regular season only) ──
const TP = (teamProjections as { teams: Record<string, { passTD: number; rushTD: number; passYds: number; rushYds: number }> }).teams;

/** Offensive strength rating per team (proxy for opponent quality). */
export function teamStrength(team: string): number {
  const t = TP[team];
  if (!t) return 0;
  return (t.passTD + t.rushTD) + (t.passYds + t.rushYds) / 300;
}

// 0–100 normalized strength index for display.
const strengthIndex: Record<string, number> = (() => {
  const codes = Object.keys(TP);
  const vals = codes.map(teamStrength);
  const min = Math.min(...vals), max = Math.max(...vals);
  const out: Record<string, number> = {};
  codes.forEach((c, i) => { out[c] = max > min ? Math.round(((vals[i] - min) / (max - min)) * 100) : 50; });
  return out;
})();
export const teamStrengthIndex = (team: string) => strengthIndex[team] ?? 0;

export interface TeamSOS {
  overall: number; t1: number; t2: number; t3: number; // avg opponent strength
  overallRank: number; t1Rank: number; t2Rank: number; t3Rank: number; // 1 = hardest
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/** Compute SOS for every team from regular-season opponents. Thirds = weeks
 *  1–6, 7–12, 13–18. Rank 1 = hardest (highest avg opponent strength). */
export function computeSOS(byTeam: ScheduleByTeam): Record<string, TeamSOS> {
  const raw: Record<string, { overall: number; t1: number; t2: number; t3: number }> = {};
  for (const [team, sched] of Object.entries(byTeam)) {
    const inThird = (lo: number, hi: number) => sched.reg.filter((g) => g.week >= lo && g.week <= hi).map((g) => teamStrength(g.opp));
    raw[team] = {
      overall: avg(sched.reg.map((g) => teamStrength(g.opp))),
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
