// Health check for the deployed service: reads /v1/meta and samples every
// route per sport through the public API, exactly as a partner would.
//
//   SPORTS_API_URL=https://… SPORTS_CHECK_TOKEN=… tsx src/jobs/check.ts [--sport nhl,mlb] [--max-age-hours 26]
//
// Prints a markdown report to stdout (the workflow appends it to the step
// summary) and exits 1 when a sport is failed, stale, missing a bundle, or a
// route misbehaves. Warnings (no ADP market, no injury refresh yet) do not
// fail the run. The token is read from the environment and never printed.

import { SPORTS, type Sport } from '../types.js';
import { addDays, easternDate } from '../util.js';

interface Row {
  sport: string;
  checks: string[];
  problems: string[];
  warnings: string[];
}

const base = (process.env.SPORTS_API_URL ?? '').replace(/\/$/, '');
const token = process.env.SPORTS_CHECK_TOKEN ?? process.env.SPORTS_ADMIN_TOKEN ?? '';
if (!base || !token) {
  console.error('SPORTS_API_URL and SPORTS_CHECK_TOKEN (or SPORTS_ADMIN_TOKEN) are required');
  process.exit(2);
}

const argv = process.argv.slice(2);
const sports: Sport[] = argv.includes('--sport') ? (argv[argv.indexOf('--sport') + 1].split(',') as Sport[]) : [...SPORTS];
const maxAgeHours = argv.includes('--max-age-hours') ? Number(argv[argv.indexOf('--max-age-hours') + 1]) : 26;

async function get(path: string, withToken = true): Promise<{ status: number; body: any; ms: number }> {
  const t0 = Date.now();
  const res = await fetch(`${base}${path}`, { headers: withToken ? { authorization: `Bearer ${token}` } : {} });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* jsonl or plain text */
  }
  return { status: res.status, body, ms: Date.now() - t0 };
}

const hoursAgo = (iso: string | undefined) => (iso ? (Date.now() - new Date(iso).getTime()) / 3_600_000 : Infinity);
const fmtAge = (iso: string | undefined) => (iso ? `${hoursAgo(iso).toFixed(1)} h ago` : 'never');

async function checkSport(sport: Sport, meta: any): Promise<Row> {
  const row: Row = { sport, checks: [], problems: [], warnings: [] };
  const ok = (s: string) => row.checks.push(s);
  const bad = (s: string) => row.problems.push(s);
  const warn = (s: string) => row.warnings.push(s);

  if (!meta || !meta.as_of) {
    bad('no meta: the daily job has not run for this sport');
    return row;
  }
  const season = meta.current_season;
  const counts = meta.counts ?? {};
  if (meta.failed) bad(`daily job marked failed: ${(meta.notes ?? []).filter((n: string) => /REFUSED|failed/.test(n)).join('; ') || 'see notes'}`);
  if (hoursAgo(meta.as_of) > maxAgeHours) bad(`bundles are stale: as_of ${fmtAge(meta.as_of)} (limit ${maxAgeHours} h)`);
  else ok(`daily as_of ${fmtAge(meta.as_of)}`);
  if (!meta.injuries_as_of) warn('no hourly injury refresh recorded yet');
  else if (hoursAgo(meta.injuries_as_of) > 3) warn(`injury refresh is ${fmtAge(meta.injuries_as_of)}`);
  else ok(`injuries ${fmtAge(meta.injuries_as_of)}`);

  // Directory
  const dir = await get(`/v1/${sport}/players?season=${season}`);
  if (dir.status !== 200) bad(`players: HTTP ${dir.status}`);
  else {
    const n = dir.body.count;
    if (n !== counts[`directory_${season}`]) bad(`players: ${n} rows served, meta says ${counts[`directory_${season}`]}`);
    else ok(`players ${n} (${dir.ms} ms)`);
    const r = dir.body.rows?.[0];
    if (r && !('player_id' in r && 'injury_status' in r && 'exp' in r)) bad('players: row is missing player_id, injury_status or exp');
  }

  // Season lines, current season first then the prior one when the current has none yet.
  let sl = await get(`/v1/${sport}/season-lines?season=${season}`);
  let slSeason = season;
  if (sl.status === 404 || (sl.status === 200 && sl.body.count === 0)) {
    sl = await get(`/v1/${sport}/season-lines?season=${season - 1}`);
    slSeason = season - 1;
  }
  if (sl.status !== 200) bad(`season-lines: HTTP ${sl.status}`);
  else if (sl.body.count === 0) bad(`season-lines ${slSeason}: 0 rows`);
  else {
    const top = sl.body.rows[0];
    ok(`season-lines ${slSeason}: ${sl.body.count} rows, e.g. ${top.name} gp ${top.gp}`);
  }

  // Calendar, then the newest stored final's lines.
  const cal = await get(`/v1/${sport}/games?season=${season}`);
  let finals: any[] = [];
  if (cal.status !== 200) bad(`games?season: HTTP ${cal.status}`);
  else {
    finals = (cal.body.rows as any[]).filter((g) => g.status === 'final');
    ok(`calendar ${season}: ${cal.body.count} games, ${finals.length} final`);
  }
  if (finals.length === 0 && season - 1 >= 2000) {
    const prev = await get(`/v1/${sport}/games?season=${season - 1}`);
    if (prev.status === 200) finals = (prev.body.rows as any[]).filter((g) => g.status === 'final');
  }
  const recent = finals.filter((g) => sport !== 'mlb' || g.game_date >= addDays(easternDate(new Date()), -29));
  const sample = recent[recent.length - 1];
  if (sample) {
    const lines = await get(`/v1/${sport}/games/${sample.game_id}/lines`);
    if (lines.status !== 200) bad(`lines ${sample.game_id}: HTTP ${lines.status}`);
    else if (lines.body.count === 0) bad(`lines ${sample.game_id}: 0 rows`);
    else {
      const played = (lines.body.rows as any[]).filter((l) => l.played).length;
      if (!lines.body.stored) warn(`lines ${sample.game_id} (${sample.game_date}) served from the feed, not the store`);
      ok(`lines ${sample.away}@${sample.home} ${sample.game_date}: ${lines.body.count} rows, ${played} played${lines.body.stored ? ', stored' : ''} (${lines.ms} ms)`);
    }
  } else warn('no final game to sample lines from');

  // Live path: yesterday's slate from the feed.
  const yday = addDays(easternDate(new Date()), -1);
  const slate = await get(`/v1/${sport}/games?date=${yday}`);
  if (slate.status !== 200) bad(`games?date=${yday}: HTTP ${slate.status} ${JSON.stringify(slate.body).slice(0, 120)}`);
  else ok(`slate ${yday}: ${slate.body.count} games (${slate.ms} ms)`);

  // ADP and crosswalk.
  const adp = await get(`/v1/${sport}/adp?season=${season}&format=jsonl`);
  if (adp.status !== 200) bad(`adp: HTTP ${adp.status}`);
  else {
    const n = String(adp.body).trim() ? String(adp.body).trim().split('\n').length : 0;
    const providers = meta.adp_providers ?? [];
    if (n === 0 && providers.length) bad('adp: providers listed but 0 rows');
    else if (n === 0) warn('adp: no market for this sport');
    else ok(`adp ${n} rows from ${providers.join(', ')}`);
  }
  const xw = await get(`/v1/${sport}/crosswalk`);
  if (xw.status !== 200) bad(`crosswalk: HTTP ${xw.status}`);
  else if (xw.body.count !== counts.crosswalk) bad(`crosswalk: ${xw.body.count} rows served, meta says ${counts.crosswalk}`);
  else ok(`crosswalk ${xw.body.count}`);

  return row;
}

async function main() {
  const out: string[] = [];
  let failed = false;

  const health = await get('/', false);
  const unauth = await get('/v1/meta', false);
  const meta = await get('/v1/meta');
  out.push(`## Sports health check`, '', `Base: ${base}`, '');
  if (health.status !== 200 || !health.body?.ok) ((failed = true), out.push(`- health: HTTP ${health.status} ❌`));
  else out.push(`- health: ok, version ${health.body.version} ✅`);
  if (unauth.status !== 401) ((failed = true), out.push(`- unauthenticated /v1/meta: HTTP ${unauth.status}, expected 401 ❌`));
  else out.push('- unauthenticated /v1/meta: 401 ✅');
  if (meta.status !== 200) {
    out.push(`- /v1/meta: HTTP ${meta.status} ❌`);
    console.log(out.join('\n'));
    process.exit(1);
  }
  out.push(`- /v1/meta: ${meta.body.count} sports ✅`, '');

  const metaBySport = new Map<string, any>((meta.body.rows as any[]).map((r) => [r.sport, r]));
  const rows: Row[] = [];
  for (const s of sports) rows.push(await checkSport(s, metaBySport.get(s)));

  out.push('| Sport | Result | Checks | Warnings | Problems |', '|---|---|---|---|---|');
  for (const r of rows) {
    if (r.problems.length) failed = true;
    out.push(`| ${r.sport} | ${r.problems.length ? '❌' : '✅'} | ${r.checks.join('<br>')} | ${r.warnings.join('<br>') || '—'} | ${r.problems.join('<br>') || '—'} |`);
  }
  out.push('', failed ? '**Result: problems found**' : '**Result: all sports healthy**');
  console.log(out.join('\n'));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log(`## Sports health check\n\nCrashed: ${String(e?.message ?? e)}`);
  process.exit(1);
});
