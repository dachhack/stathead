// MLS and Premier League adapter on ESPN's soccer endpoints (scoreboard,
// summary with per-player match stats and substitution clocks, team rosters).
// The directory is ESPN's rosters; FPL enriches the Premier League (status,
// news, squad number, PL code) and MLS Fantasy enriches MLS (availability).
// Season lines are the sum of stored box scores, as for basketball.
//
// Soccer has no consumer dictionary yet, so the service defines one:
//   min g a sh sot fc fs yc rc og off sv ga shf start sub_in cs tga
// (sv, ga, shf are the goalkeeper's; cs is a clean sheet at 60+ minutes with
// the team conceding none; tga is the team's goals against, for the scorer).

import type { AdpSource, BoxScore, DirectoryHints, Game, GameStatus, Line, Player, SeasonCtx, SeasonLine, SportAdapter, TeamInfo } from '../types.js';
import { NameIndex, easternDate, nowIso, num, pMap } from '../util.js';
import * as espn from '../sources/espn.js';
import * as fpl from '../sources/fpl.js';
import * as mlsf from '../sources/mlsfantasy.js';

interface LeagueConfig {
  sport: 'mls' | 'epl';
  espn: espn.EspnLeague;
  months: (season: number) => string[];
  currentSeason: (now: Date) => number;
  /** Other feeds' codes → ESPN's. */
  alias: Record<string, string>;
}

const months = (fromY: number, fromM: number, toY: number, toM: number): string[] => {
  const out: string[] = [];
  for (let y = fromY, m = fromM; y < toY || (y === toY && m <= toM); m === 12 ? ((y++), (m = 1)) : m++) out.push(`${y}${String(m).padStart(2, '0')}`);
  return out;
};

const MLS: LeagueConfig = {
  sport: 'mls',
  espn: 'mls',
  months: (s) => months(s, 2, s, 12),
  currentSeason: (now) => now.getUTCFullYear(),
  alias: {},
};

const EPL: LeagueConfig = {
  sport: 'epl',
  espn: 'epl',
  months: (s) => months(s, 8, s + 1, 5),
  currentSeason: (now) => (now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1),
  alias: fpl.FPL_TEAM_ALIASES,
};

function status(t: { name: string; state: string }): GameStatus {
  if (/POSTPONED/i.test(t.name)) return 'postponed';
  if (/CANCEL|ABANDON/i.test(t.name)) return 'cancelled';
  if (t.state === 'in') return 'live';
  if (t.state === 'post') return 'final';
  return 'pre';
}

function gameType(slug: string | undefined): string {
  const s = (slug ?? '').toLowerCase();
  if (!s) return 'regular';
  if (/playoff|final|cup|knockout|wild-?card|play-?in/.test(s)) return 'post';
  if (/pre-?season|friendl/.test(s)) return 'pre';
  if (/regular|premier-league|english/.test(s)) return 'regular';
  return 'other';
}

/** "67'" → 67, "90'+4'" → 94. */
function clockMinutes(display: string | undefined): number | null {
  if (!display) return null;
  const m = /^(\d+)'(?:\+(\d+)')?$/.exec(display.trim());
  return m ? Number(m[1]) + Number(m[2] ?? 0) : null;
}

function makeAdapter(cfg: LeagueConfig): SportAdapter {
  const canon = (code: string | null | undefined) => (code ? cfg.alias[code] ?? code : '');
  const source = `espn-${cfg.espn}`;
  let teamsPromise: Promise<Array<{ id: string; abbreviation: string; displayName: string }>> | null = null;
  const espnTeams = () => (teamsPromise ??= espn.teams(cfg.espn));

  const mapGame = (ev: espn.EspnEvent, season: number): Game => {
    const c = ev.competitions[0];
    const home = c.competitors.find((x) => x.homeAway === 'home');
    const away = c.competitors.find((x) => x.homeAway === 'away');
    const st = status(c.status.type);
    return {
      game_id: String(ev.id),
      game_date: easternDate(c.date ?? ev.date),
      start_utc: new Date(c.date ?? ev.date).toISOString(),
      home: canon(home?.team.abbreviation),
      away: canon(away?.team.abbreviation),
      status: st,
      clock: st === 'live' ? c.status.displayClock ?? null : null,
      period: st === 'live' || st === 'final' ? c.status.period ?? null : null,
      home_score: st === 'pre' ? null : num(home?.score),
      away_score: st === 'pre' ? null : num(away?.score),
      season: ev.season?.year ?? season,
      game_type: gameType(ev.season?.slug),
      source,
      updated_at: nowIso(),
    };
  };

  return {
    sport: cfg.sport,
    currentSeason: cfg.currentSeason,
    async teams(): Promise<TeamInfo[]> {
      const ts = await espnTeams();
      const reverse = new Map<string, string[]>();
      for (const [a, c] of Object.entries(cfg.alias)) (reverse.get(c) ?? reverse.set(c, []).get(c)!).push(a);
      return ts.map((t) => ({ code: t.abbreviation, name: t.displayName, aliases: reverse.get(t.abbreviation) ?? [] })).sort((a, b) => a.code.localeCompare(b.code));
    },

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
      let d: any;
      try {
        d = await espn.summary(cfg.espn, gameId);
      } catch (e: any) {
        if (e?.status === 400 || e?.status === 404) return null;
        throw e;
      }
      const comp = d?.header?.competitions?.[0];
      if (!comp) return null;
      const ev: espn.EspnEvent = { id: d.header.id, date: comp.date, season: d.header.season ? { year: d.header.season.year, type: d.header.season.type, slug: d.header.season.slug ?? d.header.season.name } : undefined, competitions: d.header.competitions };
      const game = mapGame(ev, cfg.currentSeason(new Date(comp.date)));
      if (!ev.season?.slug) game.game_type = 'regular';
      // Match length: 90, or 120 when the header shows extra time.
      const periods = num(comp.status?.period);
      const length = periods > 2 ? 120 : 90;
      const lines: Line[] = [];
      for (const block of d.rosters ?? []) {
        const team = canon(block.team?.abbreviation);
        const isHome = block.homeAway === 'home';
        const tga = isHome ? num(game.away_score) : num(game.home_score);
        for (const r of block.roster ?? []) {
          const stat = new Map<string, number>((r.stats ?? []).map((s: any) => [s.name, num(s.displayValue ?? s.value)]));
          const plays: any[] = r.plays ?? [];
          const subClock = clockMinutes(plays.find((p) => p.substitution)?.clock?.displayValue);
          const redClock = clockMinutes(plays.find((p) => p.redCard)?.clock?.displayValue);
          const starter = !!r.starter;
          const subbedIn = !!r.subbedIn;
          const played = starter || subbedIn;
          let min = 0;
          if (played) {
            const start = starter ? 0 : subClock ?? length;
            const end = Math.min(length, r.subbedOut && starter ? subClock ?? length : redClock ?? length, redClock ?? length);
            // A sub who is later subbed off or sent off: his own plays carry both clocks.
            const offClock = subbedIn && (r.subbedOut || redClock != null) ? clockMinutes(plays.filter((p) => p.substitution || p.redCard).map((p) => p.clock?.displayValue).sort((a: string, b: string) => (clockMinutes(a) ?? 0) - (clockMinutes(b) ?? 0)).pop()) : null;
            min = Math.max(0, (subbedIn && offClock != null && offClock > start ? offClock : end) - start);
          }
          const isGk = r.position?.abbreviation === 'G';
          lines.push({
            player_id: `${cfg.sport}-${r.athlete?.id}`,
            name: r.athlete?.displayName ?? r.athlete?.fullName ?? '',
            team,
            pos: r.position?.abbreviation ?? '',
            played,
            stats: {
              min,
              g: stat.get('totalGoals') ?? 0,
              a: stat.get('goalAssists') ?? 0,
              sh: stat.get('totalShots') ?? 0,
              sot: stat.get('shotsOnTarget') ?? 0,
              fc: stat.get('foulsCommitted') ?? 0,
              fs: stat.get('foulsSuffered') ?? 0,
              yc: stat.get('yellowCards') ?? 0,
              rc: stat.get('redCards') ?? 0,
              og: stat.get('ownGoals') ?? 0,
              off: stat.get('offsides') ?? 0,
              sv: isGk ? stat.get('saves') ?? 0 : 0,
              ga: isGk ? stat.get('goalsConceded') ?? 0 : 0,
              shf: isGk ? stat.get('shotsFaced') ?? 0 : 0,
              start: starter ? 1 : 0,
              sub_in: subbedIn ? 1 : 0,
              cs: played && min >= 60 && tga === 0 ? 1 : 0,
              tga,
            },
            source,
          });
        }
      }
      return { game, lines, as_of: nowIso(), revised_at: null };
    },

    async directory(season, hints?: DirectoryHints) {
      const ts = await espnTeams();
      const rosters = await pMap(ts, 5, (t) => espn.roster(cfg.espn, t.id).then((r) => ({ team: t.abbreviation, r })).catch(() => ({ team: t.abbreviation, r: [] as espn.EspnRosterAthlete[] })));
      const out: Player[] = [];
      for (const { team, r } of rosters) {
        for (const a of r) {
          const pos = a.position?.abbreviation ?? '';
          out.push({
            player_id: `${cfg.sport}-${a.id}`,
            full_name: a.fullName,
            team,
            pos,
            eligible: pos ? [pos] : [],
            jersey: a.jersey ?? null,
            headshot_url: a.headshot?.href ?? espn.headshotUrl(cfg.espn, String(a.id)),
            active: (a.status?.type ?? 'active') === 'active',
            injury_status: a.injuries?.length ? espn.injuryCode(a.injuries[0].status) : null,
            injury_note: a.injuries?.[0]?.details?.type ?? null,
            exp: null,
            debut_season: null,
            birth_date: a.dateOfBirth ? a.dateOfBirth.slice(0, 10) : null,
            ids: { espn_id: String(a.id) },
            source,
          });
        }
      }
      if (cfg.sport === 'epl') {
        const b = await fpl.bootstrap().catch(() => null);
        if (b) {
          const teamCode = new Map(b.teams.map((t) => [t.id, canon(t.short_name)]));
          const elements = b.elements.map((e) => ({ el: e, team: teamCode.get(e.team) ?? null }));
          const idx = new NameIndex(elements, (x) => fpl.fullName(x.el));
          const idxWeb = new NameIndex(elements, (x) => x.el.web_name);
          for (const p of out) {
            const e = (idx.resolve(p.full_name, p.team) ?? idxWeb.resolve(p.full_name.split(' ').pop() ?? '', p.team))?.el;
            if (!e) continue;
            p.ids.fpl_id = String(e.id);
            p.ids.pl_code = String(e.code);
            p.injury_status = fpl.injuryCode(e);
            p.injury_note = e.news || null;
            if (e.squad_number != null && !p.jersey) p.jersey = String(e.squad_number);
            if (!p.birth_date && e.birth_date) p.birth_date = e.birth_date;
          }
        }
      } else {
        const [players, squads] = await Promise.all([mlsf.players().catch(() => []), mlsf.squads().catch(() => [])]);
        if (players.length) {
          const byName = new Map(ts.map((t) => [t.displayName.toLowerCase(), t.abbreviation]));
          const squadCode = new Map(squads.map((s) => [s.id, byName.get(s.full_name.toLowerCase()) ?? byName.get(s.name.toLowerCase()) ?? s.short_name]));
          const idx = new NameIndex(players.map((x) => ({ ...x, team: squadCode.get(x.squad_id) ?? null })), (x) => mlsf.fullName(x));
          const idxKnown = new NameIndex(players.filter((x) => x.known_name).map((x) => ({ ...x, team: squadCode.get(x.squad_id) ?? null })), (x) => x.known_name!);
          for (const p of out) {
            const x = idx.resolve(p.full_name, p.team) ?? idxKnown.resolve(p.full_name, p.team);
            if (!x) continue;
            p.ids.mls_fantasy_id = String(x.id);
            if (x.sportec_id) p.ids.sportec_id = x.sportec_id;
            const code = mlsf.injuryCode(x);
            if (code) p.injury_status = code;
          }
        }
      }
      // Tenure from the ESPN bio (career stints with season ranges): the debut
      // is the earliest club season, experience the seasons since. Known
      // debuts arrive as hints so only new players cost a read.
      const known = hints?.debutSeasons ?? {};
      await pMap(out, 6, async (p) => {
        let debut: number | null | undefined = known[p.player_id];
        if (debut === undefined) {
          try {
            debut = espn.debutYear(await espn.athleteBio(cfg.espn, p.ids.espn_id));
          } catch {
            debut = null;
          }
        }
        if (debut != null) {
          p.debut_season = debut;
          p.exp = Math.max(0, season - debut);
        }
      });
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

    // No two draft markets exist for either league (FPL publishes one rank,
    // not an ADP; MLS Fantasy has no draft), so there is nothing to blend.
    async adpSources(): Promise<AdpSource[]> {
      return [];
    },
  };
}

export const mls = makeAdapter(MLS);
export const epl = makeAdapter(EPL);
export type { BoxScore };
