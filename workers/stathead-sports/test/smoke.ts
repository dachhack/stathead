// Live smoke test: runs each adapter against its upstream on a small scope,
// checks the stat dictionaries, and drives the router over an in-memory store
// with and without a token.
//
//   tsx test/smoke.ts [--sport nhl,mlb,nba,wnba] [--date YYYY-MM-DD]

import { blendAdp } from '../src/adp.js';
import { handle } from '../src/router.js';
import { ADAPTERS } from '../src/sports/index.js';
import { MemoryStore, keys } from '../src/store.js';
import type { BoxScore, Sport } from '../src/types.js';
import { SPORTS } from '../src/types.js';
import { addDays, easternDate, num } from '../src/util.js';

const DICT: Record<Sport, string[]> = {
  nba: ['min', 'pts', 'fgm', 'fga', 'ftm', 'fta', 'tpm', 'tpa', 'oreb', 'dreb', 'reb', 'ast', 'stl', 'blk', 'tov', 'pf'],
  wnba: ['min', 'pts', 'fgm', 'fga', 'ftm', 'fta', 'tpm', 'tpa', 'oreb', 'dreb', 'reb', 'ast', 'stl', 'blk', 'tov', 'pf'],
  nhl: ['toi', 'g', 'a', 'pm', 'pim', 'sog', 'hit', 'blk', 'ppg', 'ppa', 'shg', 'sha', 'gwg', 'fow', 'fol', 'gva', 'tka'],
  mlb: ['pa', 'ab', 'h', '2b', '3b', 'hr', 'r', 'rbi', 'bb', 'ibb', 'hbp', 'k', 'sb', 'cs', 'sf', 'sh', 'gidp'],
  mls: ['min', 'g', 'a', 'sh', 'sot', 'fc', 'fs', 'yc', 'rc', 'og', 'off', 'sv', 'ga', 'shf', 'start', 'sub_in', 'cs', 'tga'],
  epl: ['min', 'g', 'a', 'sh', 'sot', 'fc', 'fs', 'yc', 'rc', 'og', 'off', 'sv', 'ga', 'shf', 'start', 'sub_in', 'cs', 'tga'],
};
const GOALIE = ['gapp', 'gs', 'gtoi', 'w', 'l', 'otl', 'ga', 'sv', 'sa', 'so'];
const PITCHER = ['gs', 'outs', 'w', 'l', 'sv', 'svo', 'bs', 'hld', 'p_k', 'p_bb', 'p_h', 'p_hr', 'p_hbp', 'er', 'p_r', 'bf', 'pitches', 'cg', 'sho'];

let failures = 0;
const check = (ok: unknown, msg: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failures++;
};

/** A date in the sport's last completed stretch with games on it. */
const SAMPLE_DATE: Record<Sport, string> = { nhl: '2025-10-07', mlb: '2026-09-15', nba: '2025-10-22', wnba: '2025-07-15', mls: '2025-10-04', epl: '2025-10-04' };

async function sport(s: Sport, dateArg?: string) {
  const a = ADAPTERS[s];
  console.log(`\n=== ${s} (season ${a.currentSeason(new Date())})`);
  let date = dateArg ?? SAMPLE_DATE[s];
  if (!dateArg && (s === 'mls' || s === 'epl')) {
    // Soccer rosters turn over every window, so read a recent final from the current season.
    const cal = await a.calendar(a.currentSeason(new Date()));
    const finals = cal.filter((g) => g.status === 'final');
    if (finals.length) date = finals[finals.length - 1].game_date;
    console.log(`     calendar ${a.currentSeason(new Date())}: ${cal.length} games, ${finals.length} final; sampling ${date}`);
  }
  const games = await a.schedule(date);
  check(games.length > 0, `schedule(${date}) -> ${games.length} games; first ${games[0]?.away}@${games[0]?.home} ${games[0]?.status} ${games[0]?.start_utc}`);
  check(games.every((g) => g.game_date === date), 'every game carries the requested Eastern date');
  const fin = games.find((g) => g.status === 'final');
  let box: BoxScore | null = null;
  if (fin) {
    box = await a.boxScore(fin.game_id);
    check(!!box && box.lines.length > 0, `boxScore(${fin.game_id}) -> ${box?.lines.length} lines, ${box?.lines.filter((l) => l.played).length} played`);
    if (box) {
      const skaters = box.lines.filter((l) => l.pos !== 'G');
      const sample = skaters.find((l) => l.played) ?? box.lines[0];
      check(DICT[s].every((k) => k in sample.stats), `dictionary fields present (${DICT[s].length}) on ${sample.name}: ${JSON.stringify(sample.stats)}`);
      if (s === 'nhl') {
        const g = box.lines.find((l) => l.pos === 'G' && l.played);
        check(!!g && GOALIE.every((k) => k in g.stats), `goalie fields on ${g?.name}: ${JSON.stringify(g?.stats)}`);
        const ppa = skaters.reduce((n, l) => n + l.stats.ppa, 0);
        const ppg = skaters.reduce((n, l) => n + l.stats.ppg, 0);
        const fow = skaters.reduce((n, l) => n + l.stats.fow, 0);
        const fol = skaters.reduce((n, l) => n + l.stats.fol, 0);
        check(fow === fol && fow > 0, `faceoffs balance: ${fow} won / ${fol} lost`);
        check(ppa <= 2 * ppg, `power-play assists ${ppa} vs goals ${ppg}`);
        check(skaters.reduce((n, l) => n + l.stats.gwg, 0) === 1, 'exactly one game-winning goal');
      }
      if (s === 'mlb') {
        const p = box.lines.find((l) => 'outs' in l.stats && l.stats.outs > 0);
        check(!!p && PITCHER.every((k) => k in p.stats), `pitcher fields on ${p?.name}: ${JSON.stringify(p?.stats)}`);
        const outs = box.lines.reduce((n, l) => n + (l.stats.outs ?? 0), 0);
        check(outs >= 51 && outs % 1 === 0, `innings come as outs: ${outs} total`);
      }
      if (s === 'mls' || s === 'epl') {
        const starters = box.lines.filter((l) => l.stats.start === 1);
        const goals = box.lines.reduce((n, l) => n + l.stats.g, 0);
        const score = num(box.game.home_score) + num(box.game.away_score);
        const ogs = box.lines.reduce((n, l) => n + l.stats.og, 0);
        check(starters.length === 22, `22 starters (${starters.length})`);
        check(goals + ogs === score, `goals ${goals} + own goals ${ogs} = score ${score}`);
        check(starters.every((l) => l.stats.min >= 1 && l.stats.min <= 120) && box.lines.some((l) => l.stats.sub_in === 1 && l.stats.min > 0 && l.stats.min < 90), `minutes: starters ${Math.min(...starters.map((l) => l.stats.min))}-${Math.max(...starters.map((l) => l.stats.min))}, a sub ${JSON.stringify(box.lines.find((l) => l.stats.sub_in === 1)?.stats)}`);
        const gks = box.lines.filter((l) => l.pos === 'G' && l.played);
        check(gks.length === 2 && gks.every((g) => 'sv' in g.stats), `two goalkeepers played: ${gks.map((g) => `${g.name} ga ${g.stats.ga} sv ${g.stats.sv} cs ${g.stats.cs}`).join('; ')}`);
      }
      if (s === 'nba' || s === 'wnba') {
        const top = [...box.lines].sort((x, y) => y.stats.pts - x.stats.pts)[0];
        check(top.stats.pts >= 15 && top.stats.fgm <= top.stats.fga, `top scorer ${top.name} ${top.stats.pts} pts on ${top.stats.fgm}/${top.stats.fga}`);
        check(box.lines.some((l) => !l.played), 'DNP rows are carried with played=false');
      }
    }
  } else {
    check(false, `no final game on ${date} to read a box score from`);
  }

  const season = a.currentSeason(new Date());
  const t0 = Date.now();
  const dir = await a.directory(season);
  check(dir.length > 200, `directory(${season}) -> ${dir.length} players in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const injured = dir.filter((p) => p.injury_status);
  const withExp = dir.filter((p) => p.exp != null).length;
  const onTeam = dir.filter((p) => p.team).length;
  console.log(`     on a team ${onTeam}, injured ${injured.length} ${JSON.stringify([...new Set(injured.map((p) => p.injury_status))])}, tenure known ${withExp}, headshots ${dir.filter((p) => p.headshot_url).length}`);
  console.log(`     sample: ${JSON.stringify(dir.find((p) => p.team && (p.exp != null || s === 'mls' || s === 'epl')))}`);
  check(new Set(dir.map((p) => p.player_id)).size === dir.length, 'player ids are unique');
  if (s === 'epl') check(dir.filter((p) => p.ids.fpl_id).length > dir.length * 0.6, `fpl_id on ${dir.filter((p) => p.ids.fpl_id).length} of ${dir.length}`);
  else if (s === 'mls') console.log(`     mls_fantasy_id on ${dir.filter((p) => p.ids.mls_fantasy_id).length} of ${dir.length} (the feed lags a season between campaigns)`);
  else check(dir.filter((p) => p.ids.sleeper_id).length > dir.length * 0.3, `sleeper ids on ${dir.filter((p) => p.ids.sleeper_id).length}`);
  if (box) {
    const ids = new Set(dir.map((p) => p.player_id));
    const played = box.lines.filter((l) => l.played);
    const hit = played.filter((l) => ids.has(l.player_id)).length;
    check(hit >= played.length * 0.9, `box-score ids resolve in the directory: ${hit}/${played.length}`);
  }

  const linesSeason = s === 'nba' || s === 'wnba' ? season - 1 : season - 1;
  const lines = await a.seasonLines(linesSeason, {
    boxScores: async () => {
      if (!(s === 'nba' || s === 'wnba' || s === 'mls' || s === 'epl')) return [];
      // One day's finals stand in for the season in this smoke test.
      const g = await a.schedule(date);
      const out: BoxScore[] = [];
      for (const x of g.filter((x) => x.status === 'final').slice(0, 2)) {
        const b = await a.boxScore(x.game_id);
        if (b) out.push({ ...b, game: { ...b.game, game_type: 'regular' } });
      }
      return out;
    },
  });
  check(lines.length > 0, `seasonLines(${linesSeason}) -> ${lines.length}; top ${JSON.stringify([...lines].sort((x, y) => (y.stats.pts ?? y.stats.g ?? y.stats.hr ?? 0) - (x.stats.pts ?? x.stats.g ?? x.stats.hr ?? 0))[0])}`);
  if (s === 'mlb') check(lines.some((l) => l.pos_games && Object.keys(l.pos_games).length > 1), 'MLB season lines carry per-position games');
  if (s === 'nhl') check(lines.some((l) => l.pos === 'G' && l.stats.gtoi > 100), 'goalie season TOI is in minutes');

  const sources = await a.adpSources(season);
  console.log(`     adp sources: ${sources.map((x) => `${x.provider}(${x.rows.length})`).join(', ') || 'none'}`);
  const adp = blendAdp(dir, sources);
  check(sources.length < 2 || adp.rows.length > 50, `adp blend -> ${adp.rows.length} players from ${adp.providers.length} providers; unmatched ${JSON.stringify(adp.unmatched)}; top ${JSON.stringify(adp.rows[0])}`);
  return { dir, lines, adp, games };
}

async function routerTest() {
  console.log('\n=== router');
  const store = new MemoryStore();
  await store.put(keys.directory('nhl', 2026), { sport: 'nhl', season: 2026, as_of: 'x', source: 'nhl', rows: [{ player_id: 'nhl-1', full_name: 'Test', ids: { nhl_id: '1' }, stats: { g: 1 } }] });
  await store.put(keys.meta('nhl'), { sport: 'nhl', as_of: 'x', current_season: 2026, seasons: [2026], counts: {} });
  const env = { API_TOKENS: 'drip:0123456789abcdef0123, other:zzzzzzzzzzzzzzzzzzzz', ADMIN_TOKEN: 'adminadminadminadmin1' };
  const get = (path: string, token?: string, method = 'GET', body?: string) =>
    handle(new Request(`https://x${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body }), env, { store });

  check((await get('/')).status === 200, 'health needs no token');
  check((await get('/v1/nhl/players')).status === 401, 'no token -> 401');
  check((await get('/v1/nhl/players', 'wrong-token-wrong-token')).status === 401, 'wrong token -> 401');
  const ok = await get('/v1/nhl/players', '0123456789abcdef0123');
  check(ok.status === 200 && ((await ok.json()) as any).count === 1, 'client token reads the directory');
  const jl = await get('/v1/nhl/players?format=jsonl', 'zzzzzzzzzzzzzzzzzzzz');
  check(jl.headers.get('content-type')?.includes('ndjson') && (await jl.text()).trim().split('\n').length === 1, 'jsonl format');
  const csv = await (await get('/v1/nhl/players?format=csv', 'zzzzzzzzzzzzzzzzzzzz')).text();
  check(csv.startsWith('player_id,full_name,ids.nhl_id,stats.g'), `csv flattens nested fields: ${csv.split('\n')[0]}`);
  check((await get('/v1/nhl/players?season=2020', '0123456789abcdef0123')).status === 404, 'missing bundle -> 404');
  check((await get('/v1/admin/store/k', '0123456789abcdef0123', 'PUT', '{}')).status === 403, 'client token cannot write');
  check((await get('/v1/admin/store/k', 'adminadminadminadmin1', 'PUT', '{"a":1}')).status === 200, 'admin token writes');
  check(((await (await get('/v1/admin/store/k', 'adminadminadminadmin1')).json()) as any).a === 1, 'admin reads back');
  check((await get('/v1/teams', '0123456789abcdef0123')).status === 404, 'unknown sport -> 404');
  const teams = (await (await get('/v1/mlb/teams', '0123456789abcdef0123')).json()) as any;
  check(teams.count === 30 && teams.rows.some((t: any) => t.code === 'ATH' && t.aliases.includes('OAK')), 'teams carry aliases');
  const sched = await get('/v1/nhl/games?date=2025-10-07', '0123456789abcdef0123');
  check(sched.status === 200 && ((await sched.json()) as any).count > 0, 'games?date= reads the feed live');
  const yday = addDays(easternDate(new Date()), -1);
  const live = await get(`/v1/mlb/games?date=${yday}`, '0123456789abcdef0123');
  check(live.status === 200, `games?date=${yday} (recent) -> ${live.status}`);
  const lines = await get('/v1/nhl/games/2025020001/lines', '0123456789abcdef0123');
  const lj = (await lines.json()) as any;
  check(lines.status === 200 && lj.count > 30 && lj.stored === false, `lines falls back to the feed when not stored (${lj.count} rows)`);
  const meta = (await (await get('/v1/meta', '0123456789abcdef0123')).json()) as any;
  check(meta.count === 6, 'meta lists six sports');
}

async function main() {
  const argv = process.argv.slice(2);
  const sportsArg = argv.includes('--sport') ? argv[argv.indexOf('--sport') + 1].split(',') : [...SPORTS];
  const dateArg = argv.includes('--date') ? argv[argv.indexOf('--date') + 1] : undefined;
  for (const s of sportsArg as Sport[]) {
    try {
      await sport(s, dateArg);
    } catch (e: any) {
      check(false, `${s} threw: ${e?.stack ?? e}`);
    }
  }
  if (!argv.includes('--no-router')) await routerTest();
  console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}`);
  process.exit(failures ? 1 : 0);
}

main();
