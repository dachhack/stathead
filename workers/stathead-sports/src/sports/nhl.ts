// NHL adapter: api-web.nhle.com (schedule, rosters, game centre) and the
// stats REST reports (season lines, bios). Sleeper's NHL file adds injury
// status and platform ids.

import type { AdpSource, BoxScore, Game, GameStatus, Line, Player, SeasonCtx, SeasonLine, SportAdapter, TeamInfo } from '../types.js';
import { NameIndex, easternDate, fetchJson, fetchJsonOrNull, mmssToMinutes, nowIso, num, pMap } from '../util.js';
import * as sleeper from '../sources/sleeper.js';
import * as espn from '../sources/espn.js';
import * as fantasypros from '../sources/fantasypros.js';

const WEB = 'https://api-web.nhle.com/v1';
const REST = 'https://api.nhle.com/stats/rest/en';
const SOURCE = 'nhl';

const TEAMS: TeamInfo[] = [
  ['ANA', 'Anaheim Ducks'], ['BOS', 'Boston Bruins'], ['BUF', 'Buffalo Sabres'], ['CGY', 'Calgary Flames'],
  ['CAR', 'Carolina Hurricanes'], ['CHI', 'Chicago Blackhawks'], ['COL', 'Colorado Avalanche'], ['CBJ', 'Columbus Blue Jackets', 'CLS'],
  ['DAL', 'Dallas Stars'], ['DET', 'Detroit Red Wings'], ['EDM', 'Edmonton Oilers'], ['FLA', 'Florida Panthers'],
  ['LAK', 'Los Angeles Kings', 'LA'], ['MIN', 'Minnesota Wild'], ['MTL', 'Montreal Canadiens', 'MON'], ['NSH', 'Nashville Predators'],
  ['NJD', 'New Jersey Devils', 'NJ'], ['NYI', 'New York Islanders'], ['NYR', 'New York Rangers'], ['OTT', 'Ottawa Senators'],
  ['PHI', 'Philadelphia Flyers'], ['PIT', 'Pittsburgh Penguins'], ['SJS', 'San Jose Sharks', 'SJ'], ['SEA', 'Seattle Kraken'],
  ['STL', 'St. Louis Blues'], ['TBL', 'Tampa Bay Lightning', 'TB'], ['TOR', 'Toronto Maple Leafs'], ['UTA', 'Utah Mammoth', 'UTAH'],
  ['VAN', 'Vancouver Canucks'], ['VGK', 'Vegas Golden Knights', 'VEG'], ['WPG', 'Winnipeg Jets'], ['WSH', 'Washington Capitals', 'WAS'],
].map(([code, name, ...aliases]) => ({ code, name, aliases }));

const ALIAS = new Map<string, string>();
for (const t of TEAMS) for (const a of t.aliases) ALIAS.set(a, t.code);
export const canonTeam = (code: string | null | undefined): string => (code ? ALIAS.get(code) ?? code : '');

const seasonId = (season: number) => `${season}${season + 1}`;

function status(g: any): GameStatus {
  const sched = g.gameScheduleState;
  if (sched === 'PPD') return 'postponed';
  if (sched === 'CNCL') return 'cancelled';
  switch (g.gameState) {
    case 'LIVE':
    case 'CRIT':
      return 'live';
    case 'OFF':
    case 'FINAL':
      return 'final';
    default:
      return 'pre';
  }
}

const GAME_TYPE: Record<number, string> = { 1: 'pre', 2: 'regular', 3: 'post', 4: 'allstar' };

function mapGame(g: any, season: number): Game {
  const st = status(g);
  const live = st === 'live';
  return {
    game_id: String(g.id),
    game_date: g.gameDate ?? (g.startTimeUTC ? easternDate(g.startTimeUTC) : ''),
    start_utc: g.startTimeUTC ?? null,
    home: canonTeam(g.homeTeam?.abbrev),
    away: canonTeam(g.awayTeam?.abbrev),
    status: st,
    clock: live ? `${g.periodDescriptor?.number ?? ''}P ${g.clock?.timeRemaining ?? ''}`.trim() : null,
    period: live || st === 'final' ? g.periodDescriptor?.number ?? null : null,
    home_score: st === 'pre' ? null : num(g.homeTeam?.score),
    away_score: st === 'pre' ? null : num(g.awayTeam?.score),
    season,
    game_type: GAME_TYPE[g.gameType] ?? 'other',
    source: SOURCE,
    updated_at: nowIso(),
  };
}

const seasonOf = (g: any, fallback: number) => (g.season ? Number(String(g.season).slice(0, 4)) : fallback);

async function report<T = any>(path: string, season: number, extra = ''): Promise<T[]> {
  const exp = encodeURIComponent(`seasonId=${seasonId(season)} and gameTypeId=2${extra}`);
  const d = await fetchJson<{ data: T[] }>(`${REST}/${path}?limit=-1&cayenneExp=${exp}`);
  return d.data ?? [];
}

export const nhl: SportAdapter = {
  sport: 'nhl',
  currentSeason(now) {
    return now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  },
  teams: () => TEAMS,

  async schedule(date) {
    const d = await fetchJson<any>(`${WEB}/schedule/${date}`);
    const day = (d.gameWeek ?? []).find((w: any) => w.date === date);
    const season = this.currentSeason(new Date(`${date}T12:00:00Z`));
    return (day?.games ?? []).map((g: any) => mapGame({ ...g, gameDate: date }, seasonOf(g, season)));
  },

  async calendar(season) {
    const seen = new Map<string, Game>();
    const lists = await pMap(TEAMS, 6, (t) => fetchJsonOrNull<any>(`${WEB}/club-schedule-season/${t.code}/${seasonId(season)}`));
    for (const d of lists) {
      for (const g of d?.games ?? []) {
        if (g.gameType !== 2 && g.gameType !== 3) continue;
        if (!seen.has(String(g.id))) seen.set(String(g.id), mapGame(g, season));
      }
    }
    return [...seen.values()].sort((a, b) => (a.start_utc ?? '').localeCompare(b.start_utc ?? ''));
  },

  async boxScore(gameId) {
    const box = await fetchJsonOrNull<any>(`${WEB}/gamecenter/${gameId}/boxscore`);
    if (!box) return null;
    const game = mapGame(box, seasonOf(box, this.currentSeason(new Date())));
    const started = game.status !== 'pre' && game.status !== 'postponed' && game.status !== 'cancelled';
    const [landing, pbp] = started
      ? await Promise.all([fetchJsonOrNull<any>(`${WEB}/gamecenter/${gameId}/landing`), fetchJsonOrNull<any>(`${WEB}/gamecenter/${gameId}/play-by-play`)])
      : [null, null];

    // Special-teams assists, short-handed goals and the game winner come from
    // the scoring summary; faceoffs from the play-by-play (the box score only
    // has a percentage).
    const extra = new Map<number, Record<string, number>>();
    const bump = (pid: number, k: string, n = 1) => {
      const e = extra.get(pid) ?? {};
      e[k] = (e[k] ?? 0) + n;
      extra.set(pid, e);
    };
    const homeId = box.homeTeam?.id;
    const homeFinal = num(box.homeTeam?.score);
    const awayFinal = num(box.awayTeam?.score);
    const winnerHome = homeFinal > awayFinal;
    const gwgIndex = Math.min(homeFinal, awayFinal) + 1; // the winner's nth goal clinched it
    let winnerGoals = 0;
    for (const period of landing?.summary?.scoring ?? []) {
      if (period.periodDescriptor?.periodType === 'SO') continue;
      for (const goal of period.goals ?? []) {
        const pp = goal.strength === 'pp';
        const sh = goal.strength === 'sh';
        if (pp) bump(goal.playerId, 'ppg');
        if (sh) bump(goal.playerId, 'shg');
        for (const a of goal.assists ?? []) {
          if (pp) bump(a.playerId, 'ppa');
          if (sh) bump(a.playerId, 'sha');
        }
        const scorerHome = goal.isHome ?? (goal.teamAbbrev?.default ? canonTeam(goal.teamAbbrev.default) === game.home : goal.eventOwnerTeamId === homeId);
        if (game.status === 'final' && scorerHome === winnerHome) {
          winnerGoals++;
          if (winnerGoals === gwgIndex) bump(goal.playerId, 'gwg');
        }
      }
    }
    for (const p of pbp?.plays ?? []) {
      if (p.typeDescKey !== 'faceoff') continue;
      if (p.details?.winningPlayerId) bump(p.details.winningPlayerId, 'fow');
      if (p.details?.losingPlayerId) bump(p.details.losingPlayerId, 'fol');
    }

    const lines: Line[] = [];
    for (const side of ['homeTeam', 'awayTeam'] as const) {
      const team = side === 'homeTeam' ? game.home : game.away;
      const stats = box.playerByGameStats?.[side] ?? {};
      const goalies: any[] = stats.goalies ?? [];
      for (const s of [...(stats.forwards ?? []), ...(stats.defense ?? [])]) {
        const e = extra.get(s.playerId) ?? {};
        const toi = mmssToMinutes(s.toi);
        lines.push({
          player_id: `nhl-${s.playerId}`,
          name: s.name?.default ?? '',
          team,
          pos: s.position,
          played: toi > 0,
          stats: {
            toi,
            g: num(s.goals),
            a: num(s.assists),
            pm: num(s.plusMinus),
            pim: num(s.pim),
            sog: num(s.sog),
            hit: num(s.hits),
            blk: num(s.blockedShots),
            ppg: num(s.powerPlayGoals ?? e.ppg),
            ppa: num(e.ppa),
            shg: num(e.shg),
            sha: num(e.sha),
            gwg: num(e.gwg),
            fow: num(e.fow),
            fol: num(e.fol),
            gva: num(s.giveaways),
            tka: num(s.takeaways),
          },
          source: SOURCE,
        });
      }
      for (const g of goalies) {
        const gtoi = mmssToMinutes(g.toi);
        const played = gtoi > 0;
        const ga = num(g.goalsAgainst);
        const othersPlayed = goalies.some((o) => o.playerId !== g.playerId && mmssToMinutes(o.toi) > 0);
        lines.push({
          player_id: `nhl-${g.playerId}`,
          name: g.name?.default ?? '',
          team,
          pos: 'G',
          played,
          stats: {
            gapp: played ? 1 : 0,
            gs: g.starter ? 1 : 0,
            gtoi,
            w: g.decision === 'W' ? 1 : 0,
            l: g.decision === 'L' ? 1 : 0,
            otl: g.decision === 'O' ? 1 : 0,
            ga,
            sv: num(g.saves),
            sa: num(g.shotsAgainst),
            so: game.status === 'final' && g.decision === 'W' && ga === 0 && !othersPlayed ? 1 : 0,
          },
          source: SOURCE,
        });
      }
    }
    return { game, lines, as_of: nowIso(), revised_at: null };
  },

  async directory(season) {
    const sid = seasonId(season);
    const [rosters, skaters, goalies, skatersPrev, goaliesPrev, bios, gbios, sleep] = await Promise.all([
      pMap(TEAMS, 6, (t) => fetchJsonOrNull<any>(`${WEB}/roster/${t.code}/${sid}`).then((r) => ({ team: t.code, r }))),
      report('skater/summary', season),
      report('goalie/summary', season),
      report('skater/summary', season - 1),
      report('goalie/summary', season - 1),
      fetchJson<{ data: any[] }>(`${REST}/skater/bios?limit=-1&cayenneExp=${encodeURIComponent(`seasonId>=20102011 and gameTypeId=2`)}`).then((d) => d.data ?? []),
      fetchJson<{ data: any[] }>(`${REST}/goalie/bios?limit=-1&cayenneExp=${encodeURIComponent(`seasonId>=20102011 and gameTypeId=2`)}`).then((d) => d.data ?? []),
      sleeper.players('nhl').catch(() => [] as sleeper.SleeperPlayer[]),
    ]);

    // Bios: one row per player per season; keep the earliest first season and latest row.
    const bio = new Map<number, { first: number | null; birth: string | null; team: string | null }>();
    for (const b of [...bios, ...gbios]) {
      const first = b.firstSeasonForGameType ? Number(String(b.firstSeasonForGameType).slice(0, 4)) : null;
      const cur = bio.get(b.playerId);
      bio.set(b.playerId, {
        first: cur?.first != null && first != null ? Math.min(cur.first, first) : (cur?.first ?? first),
        birth: b.birthDate ?? cur?.birth ?? null,
        team: b.currentTeamAbbrev ?? cur?.team ?? null,
      });
    }

    const players = new Map<number, Player>();
    const stamp = (id: number, p: Partial<Player> & { full_name: string }) => {
      const cur = players.get(id);
      const b = bio.get(id);
      const exp = b?.first != null ? Math.max(0, season - b.first) : null;
      players.set(id, {
        player_id: `nhl-${id}`,
        full_name: p.full_name || cur?.full_name || '',
        team: p.team ?? cur?.team ?? '',
        pos: p.pos ?? cur?.pos ?? '',
        eligible: p.eligible ?? cur?.eligible ?? (p.pos ? [p.pos] : []),
        jersey: p.jersey ?? cur?.jersey ?? null,
        headshot_url: p.headshot_url ?? cur?.headshot_url ?? `https://assets.nhle.com/mugs/nhl/${sid}/${(p.team ?? cur?.team) || 'NHL'}/${id}.png`,
        active: p.active ?? cur?.active ?? false,
        injury_status: cur?.injury_status ?? null,
        injury_note: cur?.injury_note ?? null,
        exp: cur?.exp ?? exp,
        debut_season: b?.first ?? cur?.debut_season ?? null,
        birth_date: p.birth_date ?? b?.birth ?? cur?.birth_date ?? null,
        ids: { ...(cur?.ids ?? {}), nhl_id: String(id) },
        source: SOURCE,
      });
    };
    for (const { team, r } of rosters) {
      for (const group of ['forwards', 'defensemen', 'goalies']) {
        for (const p of r?.[group] ?? []) {
          stamp(p.id, {
            full_name: `${p.firstName?.default ?? ''} ${p.lastName?.default ?? ''}`.trim(),
            team,
            pos: p.positionCode,
            jersey: p.sweaterNumber != null ? String(p.sweaterNumber) : null,
            headshot_url: p.headshot ?? null,
            active: true,
            birth_date: p.birthDate ?? null,
          });
        }
      }
    }
    // Anyone with a line this season or last (injured, assigned, traded, retired mid-year).
    for (const rows of [skaters, goalies, skatersPrev, goaliesPrev]) {
      for (const s of rows) {
        if (players.has(s.playerId)) continue;
        const teamCode = String(s.teamAbbrevs ?? '').split(',').pop()?.trim() ?? '';
        stamp(s.playerId, {
          full_name: s.skaterFullName ?? s.goalieFullName ?? '',
          team: rows === skaters || rows === goalies ? canonTeam(teamCode) : '',
          pos: s.positionCode ?? (s.goalieFullName ? 'G' : ''),
          active: false,
        });
      }
    }

    const out = [...players.values()];
    const idx = new NameIndex(sleep.map((p) => ({ ...p, team: canonTeam(p.team ?? null) })), (p) => sleeper.fullName(p));
    for (const p of out) {
      const s = idx.resolve(p.full_name, p.team);
      if (!s) continue;
      p.injury_status = sleeper.injuryCode(s);
      p.injury_note = s.injury_notes ?? null;
      if (p.birth_date == null) p.birth_date = sleeper.birthDate(s);
      if (p.exp == null && s.years_exp != null) p.exp = s.years_exp;
      Object.assign(p.ids, sleeper.platformIds(s));
      if (s.status === 'IR' && !p.injury_status) p.injury_status = 'IR';
    }
    return out.sort((a, b) => a.full_name.localeCompare(b.full_name));
  },

  async seasonLines(season, _ctx: SeasonCtx) {
    const [summary, realtime, faceoffs, goalies] = await Promise.all([
      report('skater/summary', season),
      report('skater/realtime', season),
      report('skater/faceoffwins', season),
      report('goalie/summary', season),
    ]);
    const rt = new Map(realtime.map((r: any) => [r.playerId, r]));
    const fo = new Map(faceoffs.map((r: any) => [r.playerId, r]));
    const lines: SeasonLine[] = [];
    for (const s of summary) {
      const r: any = rt.get(s.playerId) ?? {};
      const f: any = fo.get(s.playerId) ?? {};
      const gp = num(s.gamesPlayed);
      lines.push({
        player_id: `nhl-${s.playerId}`,
        name: s.skaterFullName,
        team: canonTeam(String(s.teamAbbrevs ?? '').split(',').pop()?.trim()),
        pos: s.positionCode,
        season,
        gp,
        stats: {
          toi: Math.round((num(s.timeOnIcePerGame) * gp) / 60 * 100) / 100,
          g: num(s.goals),
          a: num(s.assists),
          pm: num(s.plusMinus),
          pim: num(s.penaltyMinutes),
          sog: num(s.shots),
          hit: num(r.hits),
          blk: num(r.blockedShots),
          ppg: num(s.ppGoals),
          ppa: num(s.ppPoints) - num(s.ppGoals),
          shg: num(s.shGoals),
          sha: num(s.shPoints) - num(s.shGoals),
          gwg: num(s.gameWinningGoals),
          fow: num(f.totalFaceoffWins),
          fol: num(f.totalFaceoffLosses),
          gva: num(r.giveaways),
          tka: num(r.takeaways),
        },
        source: SOURCE,
      });
    }
    for (const g of goalies) {
      lines.push({
        player_id: `nhl-${g.playerId}`,
        name: g.goalieFullName,
        team: canonTeam(String(g.teamAbbrevs ?? '').split(',').pop()?.trim()),
        pos: 'G',
        season,
        gp: num(g.gamesPlayed),
        stats: {
          gapp: num(g.gamesPlayed),
          gs: num(g.gamesStarted),
          gtoi: Math.round((num(g.timeOnIce) / 60) * 100) / 100,
          w: num(g.wins),
          l: num(g.losses),
          otl: num(g.otLosses),
          ga: num(g.goalsAgainst),
          sv: num(g.saves),
          sa: num(g.shotsAgainst),
          so: num(g.shutouts),
        },
        source: SOURCE,
      });
    }
    return lines;
  },

  async adpSources(season) {
    const [fp, es] = await Promise.all([
      fantasypros.adpSources('nhl').catch(() => [] as AdpSource[]),
      espn.fantasyAdp('fhl', season + 1).catch(() => ({ as_of: nowIso(), rows: [] })),
    ]);
    const out: AdpSource[] = [...fp];
    if (es.rows.length) out.push({ provider: 'espn', as_of: es.as_of, rows: es.rows.map((r) => ({ name: r.name, team: null, pos: null, adp: r.adp, ref: r.espn_id })) });
    return out;
  },
};

export type { BoxScore };
