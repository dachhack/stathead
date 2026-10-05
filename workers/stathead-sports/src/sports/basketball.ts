// NBA and WNBA adapter on ESPN's public endpoints. The league CDNs refuse
// datacenter requests and serve no past-season day; ESPN serves both leagues'
// scoreboards and box scores for any date, so NBA and WNBA keys are ESPN ids.
// The ESPN fantasy player universe is the directory (ids, team, positions,
// jersey, injury status); Sleeper adds tenure, birth dates and platform ids.
// Season lines are the sum of the stored box scores (see jobs/daily.ts).

import type { AdpSource, BoxScore, Game, GameStatus, Line, Player, SeasonCtx, SeasonLine, SportAdapter, TeamInfo } from '../types.js';
import { NameIndex, easternDate, nowIso, num, pMap } from '../util.js';
import * as espn from '../sources/espn.js';
import * as sleeper from '../sources/sleeper.js';
import * as fantasypros from '../sources/fantasypros.js';

interface LeagueConfig {
  sport: 'nba' | 'wnba';
  espn: espn.EspnLeague;
  fantasy: espn.EspnFantasyGame;
  /** ESPN fantasy season id for a StatHead season. */
  fantasySeason: (season: number) => number;
  /** First and last calendar month of a season as [year offset, month]. */
  months: (season: number) => string[];
  currentSeason: (now: Date) => number;
  teams: TeamInfo[];
  /** ESPN tricode → canonical. */
  alias: Record<string, string>;
  /** ESPN fantasy defaultPositionId and slot id → position code. */
  positions: Record<number, string>;
  slots: Record<number, string>;
}

const months = (fromY: number, fromM: number, toY: number, toM: number): string[] => {
  const out: string[] = [];
  for (let y = fromY, m = fromM; y < toY || (y === toY && m <= toM); m === 12 ? ((y++), (m = 1)) : m++) out.push(`${y}${String(m).padStart(2, '0')}`);
  return out;
};

const NBA: LeagueConfig = {
  sport: 'nba',
  espn: 'nba',
  fantasy: 'fba',
  fantasySeason: (s) => s + 1,
  months: (s) => months(s, 10, s + 1, 6),
  currentSeason: (now) => (now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1),
  teams: [
    ['ATL', 'Atlanta Hawks'], ['BOS', 'Boston Celtics'], ['BKN', 'Brooklyn Nets'], ['CHA', 'Charlotte Hornets'], ['CHI', 'Chicago Bulls'],
    ['CLE', 'Cleveland Cavaliers'], ['DAL', 'Dallas Mavericks'], ['DEN', 'Denver Nuggets'], ['DET', 'Detroit Pistons'], ['GSW', 'Golden State Warriors', 'GS'],
    ['HOU', 'Houston Rockets'], ['IND', 'Indiana Pacers'], ['LAC', 'LA Clippers'], ['LAL', 'Los Angeles Lakers'], ['MEM', 'Memphis Grizzlies'],
    ['MIA', 'Miami Heat'], ['MIL', 'Milwaukee Bucks'], ['MIN', 'Minnesota Timberwolves'], ['NOP', 'New Orleans Pelicans', 'NO'], ['NYK', 'New York Knicks', 'NY'],
    ['OKC', 'Oklahoma City Thunder'], ['ORL', 'Orlando Magic'], ['PHI', 'Philadelphia 76ers'], ['PHX', 'Phoenix Suns', 'PHO'], ['POR', 'Portland Trail Blazers'],
    ['SAC', 'Sacramento Kings'], ['SAS', 'San Antonio Spurs', 'SA'], ['TOR', 'Toronto Raptors'], ['UTA', 'Utah Jazz', 'UTAH'], ['WAS', 'Washington Wizards', 'WSH'],
  ].map(([code, name, ...aliases]) => ({ code, name, aliases })),
  alias: { GS: 'GSW', NO: 'NOP', NY: 'NYK', SA: 'SAS', UTAH: 'UTA', WSH: 'WAS', PHO: 'PHX' },
  positions: { 1: 'PG', 2: 'SG', 3: 'SF', 4: 'PF', 5: 'C' },
  slots: { 0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C' },
};

const WNBA: LeagueConfig = {
  sport: 'wnba',
  espn: 'wnba',
  fantasy: 'wfba',
  fantasySeason: (s) => s,
  months: (s) => months(s, 5, s, 10),
  currentSeason: (now) => now.getUTCFullYear(),
  teams: [
    ['ATL', 'Atlanta Dream'], ['CHI', 'Chicago Sky'], ['CON', 'Connecticut Sun', 'CONN'], ['DAL', 'Dallas Wings'], ['GSV', 'Golden State Valkyries', 'GS'],
    ['IND', 'Indiana Fever'], ['LAS', 'Los Angeles Sparks', 'LA'], ['LVA', 'Las Vegas Aces', 'LV'], ['MIN', 'Minnesota Lynx'], ['NYL', 'New York Liberty', 'NY'],
    ['PHO', 'Phoenix Mercury', 'PHX'], ['POR', 'Portland Fire'], ['SEA', 'Seattle Storm'], ['TOR', 'Toronto Tempo'], ['WAS', 'Washington Mystics', 'WSH'],
  ].map(([code, name, ...aliases]) => ({ code, name, aliases })),
  alias: { CONN: 'CON', GS: 'GSV', LA: 'LAS', LV: 'LVA', NY: 'NYL', PHX: 'PHO', WSH: 'WAS' },
  positions: { 1: 'G', 2: 'F', 3: 'C' },
  slots: { 0: 'C', 1: 'G', 2: 'F' },
};

function status(t: { name: string; state: string }): GameStatus {
  if (/POSTPONED/i.test(t.name)) return 'postponed';
  if (/CANCEL/i.test(t.name)) return 'cancelled';
  if (t.state === 'in') return 'live';
  if (t.state === 'post') return 'final';
  return 'pre';
}

const SEASON_TYPE: Record<number, string> = { 1: 'pre', 2: 'regular', 3: 'post', 4: 'other', 5: 'allstar' };

function makeAdapter(cfg: LeagueConfig): SportAdapter {
  const canon = (code: string | null | undefined) => (code ? cfg.alias[code] ?? code : '');
  const teamCodes = new Set(cfg.teams.map((t) => t.code));
  const knownTeam = (code: string) => teamCodes.has(code);
  const source = `espn-${cfg.espn}`;
  let teamIds: Promise<Map<string, string>> | null = null;
  const teamById = () => (teamIds ??= espn.teams(cfg.espn).then((ts) => new Map(ts.map((t) => [t.id, canon(t.abbreviation)]))));

  const mapGame = (ev: espn.EspnEvent, season: number): Game => {
    const c = ev.competitions[0];
    const home = c.competitors.find((x) => x.homeAway === 'home');
    const away = c.competitors.find((x) => x.homeAway === 'away');
    const st = status(c.status.type);
    const seasonYear = ev.season?.year;
    const shSeason = seasonYear ? (cfg.sport === 'nba' ? seasonYear - 1 : seasonYear) : season;
    const homeCode = canon(home?.team.abbreviation);
    const awayCode = canon(away?.team.abbreviation);
    let gameType = SEASON_TYPE[ev.season?.type ?? 0] ?? 'other';
    // ESPN files the All-Star game as a regular-season event between made-up
    // teams; anything not between two league teams is not a regular game.
    if (gameType === 'regular' && (!knownTeam(homeCode) || !knownTeam(awayCode))) gameType = 'other';
    return {
      game_id: String(ev.id),
      game_date: easternDate(c.date ?? ev.date),
      start_utc: new Date(c.date ?? ev.date).toISOString(),
      home: homeCode,
      away: awayCode,
      status: st,
      clock: st === 'live' ? `${c.status.period ?? ''}Q ${c.status.displayClock ?? ''}`.trim() : null,
      period: st === 'live' || st === 'final' ? c.status.period ?? null : null,
      home_score: st === 'pre' ? null : num(home?.score),
      away_score: st === 'pre' ? null : num(away?.score),
      season: shSeason,
      game_type: gameType,
      source,
      updated_at: nowIso(),
    };
  };

  const splitPair = (s: string): [number, number] => {
    const m = /^(\d+)-(\d+)$/.exec(s ?? '');
    return m ? [Number(m[1]), Number(m[2])] : [0, 0];
  };

  return {
    sport: cfg.sport,
    currentSeason: cfg.currentSeason,
    teams: () => cfg.teams,

    async schedule(date) {
      const events = await espn.scoreboard(cfg.espn, date.replace(/-/g, ''));
      const season = cfg.currentSeason(new Date(`${date}T12:00:00Z`));
      return events.map((e) => mapGame(e, season)).filter((g) => g.game_date === date);
    },

    async calendar(season) {
      const lists = await pMap(cfg.months(season), 3, (m) => espn.scoreboard(cfg.espn, m));
      const seen = new Map<string, Game>();
      for (const e of lists.flat()) {
        const g = mapGame(e, season);
        if (g.season !== season) continue;
        if (g.game_type !== 'regular' && g.game_type !== 'post') continue;
        seen.set(g.game_id, g);
      }
      return [...seen.values()].sort((a, b) => (a.start_utc ?? '').localeCompare(b.start_utc ?? ''));
    },

    async boxScore(gameId) {
      let d: espn.EspnSummary | null;
      try {
        d = await espn.summary(cfg.espn, gameId);
      } catch (e: any) {
        if (e?.status === 400 || e?.status === 404) return null;
        throw e;
      }
      if (!d?.header?.competitions?.[0]) return null;
      const ev: espn.EspnEvent = { id: d.header.id, date: d.header.competitions[0].date, season: d.header.season, competitions: d.header.competitions };
      const game = mapGame(ev, cfg.currentSeason(new Date(ev.date)));
      const lines: Line[] = [];
      for (const t of d.boxscore?.players ?? []) {
        const team = canon(t.team.abbreviation);
        for (const block of t.statistics ?? []) {
          const idx = Object.fromEntries(block.keys.map((k, i) => [k, i]));
          const at = (a: { stats: string[] }, k: string) => (idx[k] != null ? a.stats[idx[k]] : '');
          for (const a of block.athletes ?? []) {
            const min = num(String(at(a, 'minutes')).split(':')[0]);
            const [fgm, fga] = splitPair(at(a, 'fieldGoalsMade-fieldGoalsAttempted'));
            const [tpm, tpa] = splitPair(at(a, 'threePointFieldGoalsMade-threePointFieldGoalsAttempted'));
            const [ftm, fta] = splitPair(at(a, 'freeThrowsMade-freeThrowsAttempted'));
            const played = !a.didNotPlay && (min > 0 || a.stats.some((s) => s && s !== '0' && s !== '0-0' && s !== '--'));
            lines.push({
              player_id: `${cfg.sport}-${a.athlete.id}`,
              name: a.athlete.displayName,
              team,
              pos: a.athlete.position?.abbreviation ?? '',
              played,
              stats: {
                min,
                pts: num(at(a, 'points')),
                fgm,
                fga,
                ftm,
                fta,
                tpm,
                tpa,
                oreb: num(at(a, 'offensiveRebounds')),
                dreb: num(at(a, 'defensiveRebounds')),
                reb: num(at(a, 'rebounds')),
                ast: num(at(a, 'assists')),
                stl: num(at(a, 'steals')),
                blk: num(at(a, 'blocks')),
                tov: num(at(a, 'turnovers')),
                pf: num(at(a, 'fouls')),
              },
              source,
            });
          }
        }
      }
      return { game, lines, as_of: nowIso(), revised_at: null };
    },

    async directory(season) {
      const [universe, teamMap, sleep] = await Promise.all([
        espn.fantasyPlayers(cfg.fantasy, cfg.fantasySeason(season)),
        teamById(),
        sleeper.players(cfg.sport).catch(() => [] as sleeper.SleeperPlayer[]),
      ]);
      const out: Player[] = [];
      for (const p of universe) {
        // ESPN's universe keeps a stale proTeamId on retired players, so the
        // active flag decides membership; the injured stay whatever the flag.
        if (!p.active && !p.injured) continue;
        const team = p.proTeamId > 0 ? teamMap.get(String(p.proTeamId)) ?? '' : '';
        const rostered = team !== '';
        const pos = cfg.positions[p.defaultPositionId] ?? '';
        const eligible = [...new Set((p.eligibleSlots ?? []).map((s) => cfg.slots[s]).filter(Boolean))];
        out.push({
          player_id: `${cfg.sport}-${p.id}`,
          full_name: p.fullName,
          team,
          pos,
          eligible: eligible.length ? eligible : pos ? [pos] : [],
          jersey: p.jersey ?? null,
          headshot_url: espn.headshotUrl(cfg.espn, String(p.id)),
          active: rostered && p.active !== false,
          injury_status: espn.injuryCode(p.injuryStatus),
          injury_note: null,
          exp: null,
          debut_season: null,
          birth_date: null,
          ids: { espn_id: String(p.id) },
          source,
        });
      }
      const idx = new NameIndex(sleep.map((s) => ({ ...s, team: canon(s.team ?? null) })), (s) => sleeper.fullName(s));
      for (const p of out) {
        const s = idx.resolve(p.full_name, p.team);
        if (!s) continue;
        Object.assign(p.ids, sleeper.platformIds(s));
        if (s.years_exp != null) {
          p.exp = s.years_exp;
          p.debut_season = season - s.years_exp;
        }
        p.birth_date = sleeper.birthDate(s);
        p.injury_note = s.injury_notes ?? null;
        if (!p.injury_status) p.injury_status = sleeper.injuryCode(s);
      }
      return out.sort((a, b) => a.full_name.localeCompare(b.full_name));
    },

    async seasonLines(season, ctx: SeasonCtx) {
      const boxes = await ctx.boxScores();
      const acc = new Map<string, SeasonLine>();
      for (const b of boxes) {
        if (b.game.status !== 'final' || b.game.game_type !== 'regular') continue;
        for (const l of b.lines) {
          let s = acc.get(l.player_id);
          if (!s) acc.set(l.player_id, (s = { player_id: l.player_id, name: l.name, team: l.team, pos: l.pos, season, gp: 0, stats: {}, source }));
          if (!l.played) continue;
          s.gp++;
          s.team = l.team;
          for (const [k, v] of Object.entries(l.stats)) s.stats[k] = (s.stats[k] ?? 0) + v;
        }
      }
      return [...acc.values()].filter((s) => s.gp > 0);
    },

    async adpSources(season) {
      const out: AdpSource[] = [];
      if (cfg.sport === 'nba') out.push(...(await fantasypros.adpSources('nba').catch(() => [] as AdpSource[])));
      const es = await espn.fantasyAdp(cfg.fantasy, cfg.fantasySeason(season)).catch(() => ({ as_of: nowIso(), rows: [] }));
      if (es.rows.length) {
        const teamMap = await teamById();
        out.push({
          provider: 'espn',
          as_of: es.as_of,
          rows: es.rows.map((r) => ({ name: r.name, team: teamMap.get(String(r.proTeamId)) ?? null, pos: null, adp: r.adp, ref: r.espn_id })),
        });
      }
      return out;
    },
  };
}

export const nba = makeAdapter(NBA);
export const wnba = makeAdapter(WNBA);
export type { BoxScore };

