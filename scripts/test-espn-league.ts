// Test script: the ESPN league import (src/lib/espnLeague.ts) against a real
// public-league payload (scripts/fixtures-espn-league.json, ESPN league
// 42654852, 2026), slimmed the way workers/espn-news-proxy slims it.
// Run: npx tsx scripts/test-espn-league.ts

import fs from 'node:fs';
import path from 'node:path';
import { slimEspnLeague } from '../src/lib/espnLeagueSlim';
import { importEspnLeague, parseEspnLeagueInput, rosterPositionsFromSlots, scoringFromItems } from '../src/lib/espnLeague';
import { isDynastyLeague, qbFormatLabel } from '../src/lib/sleeper';
import { tepLevelFromScoring, isSuperflexLeague } from '../src/lib/tradeFinisher';

let passed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail?: string) => { if (cond) passed++; else failures.push(name + (detail ? ` — ${detail}` : '')); };

const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scripts/fixtures-espn-league.json'), 'utf8'));
const slim = slimEspnLeague(raw);
const crosswalk = fs.readFileSync(path.join(process.cwd(), 'public/data/player-crosswalk.json'), 'utf8');

// The importer fetches the proxy and the crosswalk; serve both from disk and
// record the headers it sends.
let sentHeaders: Record<string, string> = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/league/')) {
    sentHeaders = { ...(init?.headers as Record<string, string> | undefined) };
    if (url.endsWith('/9')) return new Response(JSON.stringify({ error: 'ESPN refused: this league is private.', status: 401 }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(slim), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.includes('player-crosswalk')) return new Response(crosswalk, { status: 200, headers: { 'Content-Type': 'application/json' } });
  return new Response('not found', { status: 404 });
}) as typeof fetch;

async function main() {
  // ── Input parsing ──
  check('bare id parses', parseEspnLeagueInput(' 42654852 ')?.leagueId === '42654852');
  const fromUrl = parseEspnLeagueInput('https://fantasy.espn.com/football/league?leagueId=42654852&seasonId=2025');
  check('league URL parses with its season', fromUrl?.leagueId === '42654852' && fromUrl?.season === 2025, JSON.stringify(fromUrl));
  check('team URL parses', parseEspnLeagueInput('https://fantasy.espn.com/football/team?leagueId=42654852&teamId=1')?.leagueId === '42654852');
  check('junk does not parse', parseEspnLeagueInput('hello') === null && parseEspnLeagueInput('https://fantasy.espn.com/football/') === null);

  // ── Slots and scoring ──
  const pos = rosterPositionsFromSlots({ '0': 1, '2': 2, '4': 2, '6': 1, '23': 1, '7': 1, '16': 1, '17': 1, '20': 7, '21': 1 });
  check('slot counts become Sleeper-style positions in lineup order', pos.join(',') === 'QB,RB,RB,WR,WR,TE,SUPER_FLEX,FLEX,DEF,K,BN,BN,BN,BN,BN,BN,BN,IR', pos.join(','));
  check('a superflex slot reads as superflex', isSuperflexLeague(pos) && qbFormatLabel(pos) === 'Superflex');
  const sc = scoringFromItems([{ statId: 53, points: 1, pointsOverrides: { '4': 1.5 } }, { statId: 3, points: 0.04 }, { statId: 4, points: 4 }, { statId: 999, points: 9 }]);
  check('scoring maps ESPN stat ids to Sleeper keys', sc.rec === 1 && sc.pass_yd === 0.04 && sc.pass_td === 4 && !('999' in sc), JSON.stringify(sc));
  check('a TE-only reception override becomes bonus_rec_te', sc.bonus_rec_te === 0.5 && tepLevelFromScoring(sc) === 1, String(sc.bonus_rec_te));
  check('no override → no TE premium', scoringFromItems([{ statId: 53, points: 1, pointsOverrides: {} }]).bonus_rec_te === undefined);

  // ── The import ──
  const res = await importEspnLeague('42654852', 2026, null);
  check('public league sends no cookie headers', !sentHeaders['X-ESPN-S2'] && !sentHeaders['X-ESPN-SWID']);
  check('league id is namespaced', res.league.league_id === 'espn:42654852', res.league.league_id);
  check('league name and size', res.league.name === 'FFLR Test League' && res.league.total_rosters === 4, `${res.league.name} ${res.league.total_rosters}`);
  check('roster positions from the fixture', res.league.roster_positions.join(',') === 'QB,RB,RB,WR,WR,TE,FLEX,DEF,K,BN,BN,BN,BN,BN,BN,BN,IR', res.league.roster_positions.join(','));
  check('1QB league without a superflex slot', qbFormatLabel(res.league.roster_positions) === '1QB');
  check('PPR scoring came through', res.league.scoring_settings.rec === 1 && res.league.scoring_settings.rec_yd === 0.1 && res.league.scoring_settings.pass_td === 4, JSON.stringify(res.league.scoring_settings));
  check('keepers read as dynasty by default', isDynastyLeague(res.league), String(res.league.settings?.type));
  const redraft = await importEspnLeague('42654852', 2026, null, { dynasty: false });
  check('the dynasty flag can be overridden', !isDynastyLeague(redraft.league) && redraft.league.settings?.type === 1);
  check('four teams, standings order', res.teams.length === 4 && res.teams.every((t, i) => i === 0 || res.teams[i - 1].wins >= t.wins), res.teams.map((t) => `${t.teamName} ${t.wins}-${t.losses}`).join(' | '));
  const t0 = res.teams.find((t) => t.teamName === 'Austin Astronauts')!;
  check('owner resolves to the member display name', t0.owner === 'K5cents' && t0.ownerId === '{22DFE7FF-9DF2-4F3B-9FE7-FF9DF2AF3BD2}', `${t0.owner} ${t0.ownerId}`);
  check('starters and bench split by lineup slot', t0.starters.length === 9 && t0.bench.length === 7, `${t0.starters.length} / ${t0.bench.length}`);
  const puka = [...t0.starters, ...t0.bench].find((p) => p.name === 'Puka Nacua');
  check('a known player carries his Sleeper id from the crosswalk', !!puka && /^\d+$/.test(puka.id) && puka.position === 'WR' && puka.team === 'LAR', JSON.stringify(puka));
  const dst = [...t0.starters, ...t0.bench].find((p) => p.position === 'DEF');
  check('a team defense keeps an espn: id and the DEF slot', !!dst && dst.id.startsWith('espn:') && dst.slot === 'DEF', JSON.stringify(dst));
  check('every roster player has a name, position and slot', res.teams.every((t) => [...t.starters, ...t.bench].every((p) => p.name && p.position && p.slot)));

  // ── Private league ──
  await importEspnLeague('42654852', 2026, { s2: 'AEB…', swid: '{ABC}' });
  check('private credentials ride as headers', sentHeaders['X-ESPN-S2'] === 'AEB…' && sentHeaders['X-ESPN-SWID'] === '{ABC}', JSON.stringify(sentHeaders));
  let msg = '';
  try { await importEspnLeague('9', 2026, null); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
  check('a refusal surfaces the proxy message', /private/.test(msg), msg);

  console.log(`\nESPN league: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL:', f);
  process.exit(failures.length ? 1 : 0);
}
main();
