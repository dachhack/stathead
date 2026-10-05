// MLB adapter: statsapi.mlb.com for everything (schedule, live feed box
// scores, player directory, season leaderboards, 40-man roster status).
// Sleeper's MLB file adds day-to-day injury notes and platform ids.

import type { AdpSource, BoxScore, Game, GameStatus, Line, Player, SeasonCtx, SeasonLine, SportAdapter, TeamInfo } from '../types.js';
import { NameIndex, easternDate, fetchJson, fetchJsonOrNull, nowIso, num, pMap, yearOf } from '../util.js';
import * as sleeper from '../sources/sleeper.js';
import * as espn from '../sources/espn.js';
import * as fantasypros from '../sources/fantasypros.js';

const API = 'https://statsapi.mlb.com/api';
const SOURCE = 'mlb';

interface MlbTeam extends TeamInfo {
  id: number;
}

const TEAMS: MlbTeam[] = [
  [108, 'LAA', 'Los Angeles Angels'], [109, 'AZ', 'Arizona Diamondbacks', 'ARI'], [110, 'BAL', 'Baltimore Orioles'], [111, 'BOS', 'Boston Red Sox'],
  [112, 'CHC', 'Chicago Cubs'], [113, 'CIN', 'Cincinnati Reds'], [114, 'CLE', 'Cleveland Guardians'], [115, 'COL', 'Colorado Rockies'],
  [116, 'DET', 'Detroit Tigers'], [117, 'HOU', 'Houston Astros'], [118, 'KC', 'Kansas City Royals', 'KCR'], [119, 'LAD', 'Los Angeles Dodgers'],
  [120, 'WSH', 'Washington Nationals', 'WAS'], [121, 'NYM', 'New York Mets'], [133, 'ATH', 'Athletics', 'OAK'], [134, 'PIT', 'Pittsburgh Pirates'],
  [135, 'SD', 'San Diego Padres', 'SDP'], [136, 'SEA', 'Seattle Mariners'], [137, 'SF', 'San Francisco Giants', 'SFG'], [138, 'STL', 'St. Louis Cardinals'],
  [139, 'TB', 'Tampa Bay Rays', 'TBR'], [140, 'TEX', 'Texas Rangers'], [141, 'TOR', 'Toronto Blue Jays'], [142, 'MIN', 'Minnesota Twins'],
  [143, 'PHI', 'Philadelphia Phillies'], [144, 'ATL', 'Atlanta Braves'], [145, 'CWS', 'Chicago White Sox', 'CHW'], [146, 'MIA', 'Miami Marlins'],
  [147, 'NYY', 'New York Yankees'], [158, 'MIL', 'Milwaukee Brewers'],
].map(([id, code, name, ...aliases]) => ({ id: id as number, code: code as string, name: name as string, aliases: aliases as string[] }));

const BY_ID = new Map(TEAMS.map((t) => [t.id, t.code]));
const ALIAS = new Map<string, string>();
for (const t of TEAMS) for (const a of t.aliases) ALIAS.set(a, t.code);
export const canonTeam = (code: string | null | undefined): string => (code ? ALIAS.get(code) ?? code : '');
const teamCode = (id: number | undefined | null): string => (id ? BY_ID.get(id) ?? '' : '');

function status(st: any): GameStatus {
  const code: string = st?.codedGameState ?? '';
  const detail: string = st?.detailedState ?? '';
  if (code === 'D' || /Postponed/i.test(detail)) return 'postponed';
  if (code === 'C' || /Cancel/i.test(detail)) return 'cancelled';
  if (code === 'F' || code === 'O' || st?.abstractGameState === 'Final') return 'final';
  if (code === 'I' || code === 'M' || code === 'N' || st?.abstractGameState === 'Live') return 'live';
  return 'pre';
}

const GAME_TYPE: Record<string, string> = { S: 'pre', E: 'pre', R: 'regular', F: 'post', D: 'post', L: 'post', W: 'post', A: 'allstar' };

function mapGame(g: any, season: number): Game {
  const st = status(g.status);
  const live = st === 'live';
  const ls = g.linescore;
  return {
    game_id: String(g.gamePk),
    game_date: g.officialDate ?? (g.gameDate ? easternDate(g.gameDate) : ''),
    start_utc: g.gameDate ?? null,
    home: teamCode(g.teams?.home?.team?.id),
    away: teamCode(g.teams?.away?.team?.id),
    status: st,
    clock: live && ls ? `${ls.inningHalf ?? ''} ${ls.currentInningOrdinal ?? ls.currentInning ?? ''}`.trim() : null,
    period: ls?.currentInning ?? null,
    home_score: st === 'pre' ? null : num(g.teams?.home?.score),
    away_score: st === 'pre' ? null : num(g.teams?.away?.score),
    season: Number(g.season) || season,
    game_type: GAME_TYPE[g.gameType] ?? 'other',
    source: SOURCE,
    updated_at: nowIso(),
  };
}

async function schedule(params: string, season: number): Promise<Game[]> {
  const d = await fetchJson<any>(`${API}/v1/schedule?sportId=1&${params}&hydrate=linescore`);
  const out: Game[] = [];
  for (const day of d.dates ?? []) for (const g of day.games ?? []) out.push(mapGame(g, season));
  return out;
}

/** Paged leaderboard pull; `playerPool=ALL` includes anyone with a line. */
async function leaderboard(group: 'hitting' | 'pitching' | 'fielding', season: number): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0; ; offset += 1000) {
    const d = await fetchJson<any>(`${API}/v1/stats?stats=season&group=${group}&season=${season}&sportId=1&gameType=R&playerPool=ALL&limit=1000&offset=${offset}`);
    const splits = d.stats?.[0]?.splits ?? [];
    out.push(...splits);
    if (splits.length < 1000) break;
  }
  return out;
}

const ROSTER_STATUS: Record<string, string> = { D7: 'IL7', D10: 'IL10', D15: 'IL15', D60: 'IL60', RM: 'MIN', SU: 'SUSP', RST: 'SUSP', BRV: 'BRV', PL: 'PL' };

export const mlb: SportAdapter = {
  sport: 'mlb',
  currentSeason: (now) => now.getUTCFullYear(),
  teams: () => TEAMS.map(({ code, name, aliases }) => ({ code, name, aliases })),

  schedule(date) {
    return schedule(`date=${date}`, Number(date.slice(0, 4)));
  },

  calendar(season) {
    return schedule(`season=${season}&gameType=R,F,D,L,W`, season);
  },

  async boxScore(gameId) {
    const d = await fetchJsonOrNull<any>(`${API}/v1.1/game/${gameId}/feed/live`);
    if (!d?.gameData) return null;
    const gd = d.gameData;
    const ls = d.liveData?.linescore;
    const game = mapGame(
      {
        gamePk: d.gamePk,
        gameDate: gd.datetime?.dateTime,
        officialDate: gd.datetime?.officialDate,
        status: gd.status,
        gameType: gd.game?.type,
        season: gd.game?.season,
        linescore: ls,
        teams: {
          home: { team: { id: gd.teams?.home?.id }, score: ls?.teams?.home?.runs },
          away: { team: { id: gd.teams?.away?.id }, score: ls?.teams?.away?.runs },
        },
      },
      Number(gd.game?.season) || new Date().getUTCFullYear(),
    );
    const lines: Line[] = [];
    for (const side of ['home', 'away'] as const) {
      const team = side === 'home' ? game.home : game.away;
      const t = d.liveData?.boxscore?.teams?.[side];
      for (const p of Object.values<any>(t?.players ?? {})) {
        const b = p.stats?.batting ?? {};
        const pi = p.stats?.pitching ?? {};
        const pa = num(b.plateAppearances);
        const bf = num(pi.battersFaced);
        const outs = num(pi.outs);
        const fielded = Array.isArray(p.allPositions) && p.allPositions.length > 0;
        const isPitcher = p.position?.abbreviation === 'P' || Object.keys(pi).length > 0;
        const stats: Record<string, number> = {
          pa,
          ab: num(b.atBats),
          h: num(b.hits),
          '2b': num(b.doubles),
          '3b': num(b.triples),
          hr: num(b.homeRuns),
          r: num(b.runs),
          rbi: num(b.rbi),
          bb: num(b.baseOnBalls),
          ibb: num(b.intentionalWalks),
          hbp: num(b.hitByPitch),
          k: num(b.strikeOuts),
          sb: num(b.stolenBases),
          cs: num(b.caughtStealing),
          sf: num(b.sacFlies),
          sh: num(b.sacBunts),
          gidp: num(b.groundIntoDoublePlay),
        };
        if (isPitcher || bf > 0) {
          Object.assign(stats, {
            gs: num(pi.gamesStarted),
            outs,
            w: num(pi.wins),
            l: num(pi.losses),
            sv: num(pi.saves),
            svo: num(pi.saveOpportunities),
            bs: num(pi.blownSaves),
            hld: num(pi.holds),
            p_k: num(pi.strikeOuts),
            p_bb: num(pi.baseOnBalls),
            p_h: num(pi.hits),
            p_hr: num(pi.homeRuns),
            p_hbp: num(pi.hitBatsmen),
            er: num(pi.earnedRuns),
            p_r: num(pi.runs),
            bf,
            pitches: num(pi.numberOfPitches ?? pi.pitchesThrown),
            cg: num(pi.completeGames),
            sho: num(pi.shutouts),
          });
        }
        lines.push({
          player_id: `mlb-${p.person?.id}`,
          name: p.person?.fullName ?? '',
          team,
          pos: p.position?.abbreviation ?? '',
          played: pa > 0 || bf > 0 || outs > 0 || fielded,
          stats,
          source: SOURCE,
        });
      }
    }
    return { game, lines, as_of: nowIso(), revised_at: null };
  },

  async directory(season) {
    const [people, hit, pit, hitPrev, pitPrev, rosters, sleep] = await Promise.all([
      fetchJson<any>(`${API}/v1/sports/1/players?season=${season}&fields=people,id,fullName,primaryNumber,birthDate,currentTeam,id,primaryPosition,abbreviation,mlbDebutDate,active`).then((d) => d.people ?? []),
      leaderboard('hitting', season),
      leaderboard('pitching', season),
      leaderboard('hitting', season - 1),
      leaderboard('pitching', season - 1),
      pMap(TEAMS, 6, (t) => fetchJsonOrNull<any>(`${API}/v1/teams/${t.id}/roster?rosterType=40Man&season=${season}`).then((r) => ({ team: t.code, roster: r?.roster ?? [] }))),
      sleeper.players('mlb').catch(() => [] as sleeper.SleeperPlayer[]),
    ]);

    const players = new Map<number, Player>();
    const add = (id: number, p: Partial<Player> & { full_name: string }, debut: string | null) => {
      const cur = players.get(id);
      const debutSeason = yearOf(debut) ?? cur?.debut_season ?? null;
      players.set(id, {
        player_id: `mlb-${id}`,
        full_name: p.full_name || cur?.full_name || '',
        team: p.team ?? cur?.team ?? '',
        pos: p.pos ?? cur?.pos ?? '',
        eligible: p.eligible ?? cur?.eligible ?? (p.pos ? [p.pos] : []),
        jersey: p.jersey ?? cur?.jersey ?? null,
        headshot_url: `https://img.mlbstatic.com/mlb-photos/image/upload/w_213,q_auto:best/v1/people/${id}/headshot/67/current`,
        active: p.active ?? cur?.active ?? false,
        injury_status: cur?.injury_status ?? null,
        injury_note: cur?.injury_note ?? null,
        exp: debutSeason != null ? Math.max(0, season - debutSeason) : (cur?.exp ?? null),
        debut_season: debutSeason,
        birth_date: p.birth_date ?? cur?.birth_date ?? null,
        ids: { ...(cur?.ids ?? {}), mlb_id: String(id) },
        source: SOURCE,
      });
    };
    for (const p of people) {
      add(
        p.id,
        {
          full_name: p.fullName,
          team: teamCode(p.currentTeam?.id),
          pos: p.primaryPosition?.abbreviation ?? '',
          jersey: p.primaryNumber ?? null,
          active: p.active !== false,
          birth_date: p.birthDate ?? null,
        },
        p.mlbDebutDate ?? null,
      );
    }
    // Anyone with a line this season or last who is not on a current list.
    const missing = new Set<number>();
    for (const rows of [hit, pit, hitPrev, pitPrev]) for (const s of rows) if (s.player?.id && !players.has(s.player.id)) missing.add(s.player.id);
    const ids = [...missing];
    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
    const looked = await pMap(chunks, 4, (c) => fetchJson<any>(`${API}/v1/people?personIds=${c.join(',')}&fields=people,id,fullName,primaryNumber,birthDate,currentTeam,id,primaryPosition,abbreviation,mlbDebutDate,active`).then((d) => d.people ?? []));
    for (const p of looked.flat()) {
      add(
        p.id,
        { full_name: p.fullName, team: p.active ? teamCode(p.currentTeam?.id) : '', pos: p.primaryPosition?.abbreviation ?? '', jersey: p.primaryNumber ?? null, active: false, birth_date: p.birthDate ?? null },
        p.mlbDebutDate ?? null,
      );
    }
    // Roster status (IL stints) from the 40-man lists.
    for (const { team, roster } of rosters) {
      for (const r of roster) {
        const p = players.get(r.person?.id);
        if (!p) continue;
        p.team = p.team || team;
        if (r.jerseyNumber && !p.jersey) p.jersey = String(r.jerseyNumber);
        const code = ROSTER_STATUS[r.status?.code];
        if (code && code !== 'MIN') {
          p.injury_status = code;
          p.injury_note = r.status?.description ?? null;
        }
      }
    }
    const out = [...players.values()];
    const idx = new NameIndex(sleep.map((p) => ({ ...p, team: canonTeam(p.team ?? null) })), (p) => sleeper.fullName(p));
    for (const p of out) {
      const s = idx.resolve(p.full_name, p.team);
      if (!s) continue;
      Object.assign(p.ids, sleeper.platformIds(s));
      const code = sleeper.injuryCode(s);
      if (code && !p.injury_status) p.injury_status = code;
      if (s.injury_notes && !p.injury_note) p.injury_note = s.injury_notes;
      if (p.birth_date == null) p.birth_date = sleeper.birthDate(s);
    }
    return out.sort((a, b) => a.full_name.localeCompare(b.full_name));
  },

  async seasonLines(season, _ctx: SeasonCtx) {
    const [hit, pit, fld] = await Promise.all([leaderboard('hitting', season), leaderboard('pitching', season), leaderboard('fielding', season)]);
    const lines = new Map<number, SeasonLine>();
    const line = (s: any): SeasonLine => {
      const id = s.player.id;
      let l = lines.get(id);
      if (!l) {
        l = { player_id: `mlb-${id}`, name: s.player.fullName, team: canonTeam(s.team?.abbreviation) || teamCode(s.team?.id), pos: s.position?.abbreviation ?? '', season, gp: 0, stats: {}, pos_games: {}, source: SOURCE };
        lines.set(id, l);
      }
      return l;
    };
    for (const s of hit) {
      const l = line(s);
      const b = s.stat;
      Object.assign(l.stats, {
        hgp: num(b.gamesPlayed),
        pa: num(b.plateAppearances),
        ab: num(b.atBats),
        h: num(b.hits),
        '2b': num(b.doubles),
        '3b': num(b.triples),
        hr: num(b.homeRuns),
        r: num(b.runs),
        rbi: num(b.rbi),
        bb: num(b.baseOnBalls),
        ibb: num(b.intentionalWalks),
        hbp: num(b.hitByPitch),
        k: num(b.strikeOuts),
        sb: num(b.stolenBases),
        cs: num(b.caughtStealing),
        sf: num(b.sacFlies),
        sh: num(b.sacBunts),
        gidp: num(b.groundIntoDoublePlay),
      });
      l.gp = Math.max(l.gp, num(b.gamesPlayed));
    }
    for (const s of pit) {
      const l = line(s);
      const p = s.stat;
      Object.assign(l.stats, {
        pgp: num(p.gamesPlayed),
        gs: num(p.gamesStarted),
        outs: num(p.outs),
        w: num(p.wins),
        l: num(p.losses),
        sv: num(p.saves),
        svo: num(p.saveOpportunities),
        bs: num(p.blownSaves),
        hld: num(p.holds),
        p_k: num(p.strikeOuts),
        p_bb: num(p.baseOnBalls),
        p_h: num(p.hits),
        p_hr: num(p.homeRuns),
        p_hbp: num(p.hitBatsmen),
        er: num(p.earnedRuns),
        p_r: num(p.runs),
        bf: num(p.battersFaced),
        pitches: num(p.numberOfPitches),
        cg: num(p.completeGames),
        sho: num(p.shutouts),
      });
      l.gp = Math.max(l.gp, num(p.gamesPlayed));
      if (!l.pos) l.pos = 'P';
    }
    for (const s of fld) {
      const l = lines.get(s.player.id);
      const pos = s.position?.abbreviation;
      if (!l || !pos) continue;
      l.pos_games![pos] = (l.pos_games![pos] ?? 0) + num(s.stat.gamesPlayed ?? s.stat.games);
    }
    return [...lines.values()];
  },

  async adpSources(season) {
    const [fp, es] = await Promise.all([
      fantasypros.adpSources('mlb').catch(() => [] as AdpSource[]),
      espn.fantasyAdp('flb', season).catch(() => ({ as_of: nowIso(), rows: [] })),
    ]);
    const out: AdpSource[] = [...fp];
    if (es.rows.length) out.push({ provider: 'espn', as_of: es.as_of, rows: es.rows.map((r) => ({ name: r.name, team: null, pos: null, adp: r.adp, ref: r.espn_id })) });
    return out;
  },
};

export type { BoxScore };
