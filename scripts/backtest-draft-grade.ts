// Backtest: does a draft grade predict anything?
// Run: npx tsx scripts/backtest-draft-grade.ts
//
// A draft grader is trivial to build and trivial to make meaningless. The only
// question worth answering first is whether a grade computed AT DRAFT TIME, from
// what the market knew then, has any relationship to how the season went.
//
// Period-appropriate inputs matter: the grade uses the FFC ADP for that season
// only (2018-2026 on disk), never a later view. Outcomes come from the crawled
// standings.
//
// Everything is measured WITHIN league-season. Points-for scales differ hugely
// across leagues (scoring, roster size, best ball), so a raw correlation would
// mostly measure which league a team was in rather than how it drafted.
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { normalizeForMatch } from '../src/lib/nameMatch';

const CACHE = '.cache/sleeper-drafts';
const SLEEPER = 'https://api.sleeper.app/v1';

async function getJson<T>(path: string, key: string): Promise<T | null> {
  const f = `${CACHE}/${key}.json`;
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')) as T;
  const r = await fetch(`${SLEEPER}${path}`);
  if (!r.ok) { writeFileSync(f, 'null'); return null; }
  const d = (await r.json()) as T;
  writeFileSync(f, JSON.stringify(d));
  return d;
}

interface Pick {
  round: number; pick_no: number; roster_id: number | null;
  metadata?: { first_name?: string; last_name?: string; position?: string };
}
interface DraftInfo { draft_id: string; type?: string; settings?: { teams?: number; rounds?: number } }

// ── season ADP, keyed by normalised name ──
function adpForSeason(season: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const kind of ['ppr', '2qb']) {
    const f = `public/data/ffc_adp_${kind}_${season}.json`;
    if (!existsSync(f)) continue;
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    const rows = Array.isArray(raw) ? raw : (raw.players ?? raw.rows ?? []);
    for (const r of rows) {
      const k = normalizeForMatch(r.name ?? '');
      if (k && !out.has(k)) out.set(k, Number(r.adp));
    }
    if (out.size) break;   // prefer PPR; fall back to 2QB only if PPR is absent
  }
  return out;
}

// ── actual PPR points by normalised name for a season ──
function pointsForSeason(season: string): Map<string, number> {
  const f = `public/data/player_stats_${season}.csv.gz`;
  const out = new Map<string, number>();
  if (!existsSync(f)) return out;
  const text = gunzipSync(readFileSync(f)).toString('utf8');
  const lines = text.split('\n');
  const head = lines[0].split(',').map((h) => h.trim().replace(/"/g, ''));
  const iName = head.findIndex((h) => h === 'player_display_name' || h === 'player_name');
  const iPts = head.findIndex((h) => h === 'fantasy_points_ppr');
  const iType = head.findIndex((h) => h === 'season_type');
  if (iName < 0 || iPts < 0) return out;
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length <= Math.max(iName, iPts)) continue;
    if (iType >= 0 && c[iType] !== 'REG') continue;
    const k = normalizeForMatch((c[iName] ?? '').replace(/"/g, ''));
    const p = Number(c[iPts]);
    if (!k || !Number.isFinite(p)) continue;
    out.set(k, (out.get(k) ?? 0) + p);
  }
  return out;
}

export { getJson, adpForSeason, pointsForSeason };
export type { Pick, DraftInfo };

// ── the experiment ──

interface TeamDraft {
  leagueId: string; season: string; rosterId: number;
  bestBall: boolean; format: string;
  picks: number;
  adpValue: number;        // sum of (ADP - overall pick), positive = got them late
  adpValuePerPick: number;
  reachMagnitude: number;  // total slots reached ahead of ADP
  unrankedShare: number;   // picks with no ADP at all
  // LEVEL metrics: how good is the squad you ended up with, regardless of
  // whether you "beat" the market. Beating ADP and assembling a good roster are
  // different claims and need testing separately.
  rosterQuality: number;   // sum of a decreasing value curve over each pick's ADP
  slotAdjusted: number;    // the same, minus what this draft slot alone is worth
  // outcomes
  pointsFor: number; wins: number; rank: number; champion: boolean;
}

/** Rank-based within-group z, so league scale never leaks into the result. */
function withinGroupZ(rows: TeamDraft[], get: (t: TeamDraft) => number): Map<TeamDraft, number> {
  const byLeague = new Map<string, TeamDraft[]>();
  for (const t of rows) {
    const k = `${t.leagueId}|${t.season}`;
    (byLeague.get(k) ?? byLeague.set(k, []).get(k)!).push(t);
  }
  const out = new Map<TeamDraft, number>();
  for (const group of byLeague.values()) {
    if (group.length < 4) continue;
    const vals = group.map(get);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length) || 1;
    group.forEach((t, i) => out.set(t, (vals[i] - mean) / sd));
  }
  return out;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return NaN;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da && db ? num / Math.sqrt(da * db) : NaN;
}

// Fisher z 95% CI, so a correlation is reported with its uncertainty.
function corrCI(r: number, n: number): [number, number] {
  if (!Number.isFinite(r) || n < 5) return [NaN, NaN];
  const z = 0.5 * Math.log((1 + r) / (1 - r)), se = 1 / Math.sqrt(n - 3);
  const t = (v: number) => (Math.exp(2 * v) - 1) / (Math.exp(2 * v) + 1);
  return [t(z - 1.96 * se), t(z + 1.96 * se)];
}

async function main() {
  const pop = JSON.parse(readFileSync('sleeper-population.json', 'utf8')) as Array<{
    history?: Array<{ season: string; leagueId: string; rosterId: number | null; wins: number;
      pointsFor: number; regSeasonRank: number; champion: boolean;
      format: { type: string; bestBall: boolean } }>;
  }>;

  // outcome per (league, roster) — one row per team, deduped across managers
  const outcome = new Map<string, { season: string; wins: number; pointsFor: number; rank: number;
    champion: boolean; format: string; bestBall: boolean }>();
  for (const m of pop) for (const h of m.history ?? []) {
    if (h.rosterId == null || h.season > '2025') continue;
    outcome.set(`${h.leagueId}|${h.rosterId}`, {
      season: h.season, wins: h.wins, pointsFor: h.pointsFor, rank: h.regSeasonRank,
      champion: h.champion, format: h.format.type, bestBall: h.format.bestBall,
    });
  }

  // draft ids from the crawl cache
  const { readdirSync } = await import('fs');
  const leagues: Array<{ leagueId: string; draftId: string; season: string }> = [];
  for (const f of readdirSync('.cache/sleeper-crawl')) {
    if (!f.startsWith('league_') || f.split('_').length !== 2) continue;
    const lid = f.slice(7, -5);
    const d = JSON.parse(readFileSync(`.cache/sleeper-crawl/${f}`, 'utf8')).data;
    if (!d?.draft_id || !d?.season || d.season > '2025') continue;
    leagues.push({ leagueId: lid, draftId: d.draft_id, season: String(d.season) });
  }
  console.log(`leagues with a draft in a completed season: ${leagues.length}`);

  const adpCache = new Map<string, Map<string, number>>();
  const ptsCache = new Map<string, Map<string, number>>();
  const teams: TeamDraft[] = [];
  let noAdp = 0, fetched = 0;

  for (const lg of leagues) {
    if (!adpCache.has(lg.season)) adpCache.set(lg.season, adpForSeason(lg.season));
    if (!ptsCache.has(lg.season)) ptsCache.set(lg.season, pointsForSeason(lg.season));
    const adp = adpCache.get(lg.season)!;
    if (!adp.size) { noAdp++; continue; }

    const picks = await getJson<Pick[]>(`/draft/${lg.draftId}/picks`, `picks_${lg.draftId}`);
    fetched++;
    if (!picks?.length) continue;

    const byRoster = new Map<number, Pick[]>();
    for (const p of picks) {
      if (p.roster_id == null) continue;
      (byRoster.get(p.roster_id) ?? byRoster.set(p.roster_id, []).get(p.roster_id)!).push(p);
    }
    for (const [rosterId, ps] of byRoster) {
      const o = outcome.get(`${lg.leagueId}|${rosterId}`);
      if (!o) continue;
      let value = 0, reach = 0, unranked = 0, quality = 0, slotWorth = 0;
      // A simple decreasing curve: the ADP-1 player is worth ~200, fading to 0
      // by ADP 200. Crude, but any monotone curve gives the same ranking, and
      // the point here is whether roster LEVEL predicts at all.
      const curve = (rank: number) => Math.max(0, 200 - rank);
      for (const p of ps) {
        const name = `${p.metadata?.first_name ?? ''} ${p.metadata?.last_name ?? ''}`.trim();
        const a = adp.get(normalizeForMatch(name));
        slotWorth += curve(p.pick_no);         // what the slot is worth if you just take best available
        if (a == null) { unranked++; continue; }
        const delta = a - p.pick_no;           // + means taken later than market
        value += delta;
        quality += curve(a);
        if (delta < 0) reach += -delta;
      }
      teams.push({
        leagueId: lg.leagueId, season: lg.season, rosterId,
        bestBall: o.bestBall, format: o.format,
        picks: ps.length, adpValue: value, adpValuePerPick: value / Math.max(1, ps.length),
        reachMagnitude: reach, unrankedShare: unranked / Math.max(1, ps.length),
        rosterQuality: quality, slotAdjusted: quality - slotWorth,
        pointsFor: o.pointsFor, wins: o.wins, rank: o.rank, champion: o.champion,
      });
    }
  }
  console.log(`drafts fetched/cached: ${fetched}, seasons with no ADP file: ${noAdp}`);
  console.log(`team-drafts joined to an outcome: ${teams.length}\n`);

  const report = (label: string, rows: TeamDraft[]) => {
    if (rows.length < 40) { console.log(`${label}: only ${rows.length} rows — skipped\n`); return; }
    const zPts = withinGroupZ(rows, (t) => t.pointsFor);
    const usable = rows.filter((t) => zPts.has(t));
    console.log(`${label}  (${usable.length} team-drafts, ${new Set(usable.map((t) => t.leagueId + t.season)).size} leagues)`);
    for (const [nm, get] of [
      ['ADP value per pick', (t: TeamDraft) => t.adpValuePerPick],
      ['ADP value (total)',  (t: TeamDraft) => t.adpValue],
      ['reach magnitude',    (t: TeamDraft) => t.reachMagnitude],
      ['unranked share',     (t: TeamDraft) => t.unrankedShare],
      ['roster quality',     (t: TeamDraft) => t.rosterQuality],
      ['slot-adjusted',      (t: TeamDraft) => t.slotAdjusted],
    ] as const) {
      const zG = withinGroupZ(usable, get);
      const pairs = usable.filter((t) => zG.has(t)).map((t) => [zG.get(t)!, zPts.get(t)!] as const);
      const r = pearson(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
      const [lo, hi] = corrCI(r, pairs.length);
      const sig = Number.isFinite(lo) && (lo > 0 || hi < 0) ? '  *' : '';
      console.log(`   ${nm.padEnd(20)} r=${r.toFixed(3)}  95% CI [${lo.toFixed(3)}, ${hi.toFixed(3)}]${sig}`);
    }
    console.log();
  };

  // THE CONTROL THAT MATTERS. Every historical FFC snapshot is taken in the
  // last days before Week 1, but most drafts happen through August: 263 of 301
  // here predate their own ADP file. Grading those against it is lookahead —
  // the "ADP" already prices in late-August injury news the drafter never had,
  // so a player who tore an ACL after the draft shows a collapsed ADP and
  // whoever took him looks like he got enormous value, then scores nothing.
  // That inverts the sign of the whole grade. Split on it before believing any
  // of these numbers.
  const times: Record<string, number | null> = {};
  for (const l of leagues) {
    const meta = await getJson<{ start_time?: number }>(`/draft/${l.draftId}`, `meta_${l.draftId}`);
    times[l.draftId] = meta?.start_time ?? null;
  }
  const draftIdOf = new Map(leagues.map((l) => [l.leagueId, l.draftId]));
  const snapshotStart = new Map<string, string>();
  for (const season of new Set(leagues.map((l) => l.season))) {
    const f = `public/data/ffc_adp_ppr_${season}.json`;
    if (!existsSync(f)) continue;
    const meta = JSON.parse(readFileSync(f, 'utf8')).meta ?? {};
    if (meta.start_date) snapshotStart.set(season, meta.start_date);
  }
  const cleanlyTimed = (t: TeamDraft): boolean | null => {
    const id = draftIdOf.get(t.leagueId);
    const ts = id ? times[id] : null;
    const ws = snapshotStart.get(t.season);
    if (!ts || !ws) return null;
    return new Date(ts).toISOString().slice(0, 10) >= ws;
  };

  report('ALL (mostly contaminated — do not trust)', teams);
  report('CLEAN: drafted on/after the ADP snapshot', teams.filter((t) => cleanlyTimed(t) === true));
  report('CONTAMINATED: drafted before the snapshot', teams.filter((t) => cleanlyTimed(t) === false));
  report('Best ball (draft is the whole season)', teams.filter((t) => t.bestBall));
  report('Managed (waivers + lineups)', teams.filter((t) => !t.bestBall));
  report('Redraft only', teams.filter((t) => t.format === 'Redraft'));
  report('Dynasty only', teams.filter((t) => t.format === 'Dynasty'));
}

void main();
