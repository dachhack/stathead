// Do leagues come back year over year, and does it differ by format?
//
// Run: npx tsx scripts/analyze-league-renewal.ts [--input=sleeper-population.json]
//                                                [--out=reports/renewal]
//
// METHOD. Sleeper links seasons backwards: a 2025 league carries the 2024
// league's id in previous_league_id, and there is no forward pointer. So a
// league-season counts as renewed when some OTHER league-season in the corpus
// names it as its predecessor. Across 1,723 fully enumerated portfolios that is
// a large pointer graph, and it needs no rosters.
//
// THE CENSORING PROBLEM, stated up front because it bounds every number here.
// We see a league only through the managers whose portfolios we enumerated. A
// league that renewed but lost every one of those managers looks un-renewed. So
// these are LOWER BOUNDS on renewal, and the bias shrinks the more of a
// league's members we observe — which is why the observer-count breakdown
// matters more than the headline.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import type { ManagerObservation } from '../src/lib/featureAudit';
import type { PortfolioEntry } from '../src/lib/engagement';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'] as [string, string];
}));
const INPUT = args.get('input') ?? 'sleeper-population.json';
const OUT = args.get('out') ?? 'reports/renewal';

const pop: ManagerObservation[] = JSON.parse(readFileSync(INPUT, 'utf8'));

// One record per distinct league-season, plus how many of our managers we saw
// in it. Portfolios overlap heavily, so the same league appears many times.
interface LeagueSeason {
  leagueId: string;
  season: number;
  format: PortfolioEntry['format'];
  totalRosters: number;
  observers: Set<string>;
}
const leagues = new Map<string, LeagueSeason>();
// Every league id that some later league-season names as its predecessor.
const hasSuccessor = new Set<string>();

for (const m of pop) {
  for (const e of m.portfolio ?? []) {
    let ls = leagues.get(e.leagueId);
    if (!ls) {
      ls = {
        leagueId: e.leagueId, season: Number(e.season), format: e.format,
        totalRosters: e.totalRosters, observers: new Set(),
      };
      leagues.set(e.leagueId, ls);
    }
    ls.observers.add(m.managerId);
    if (e.previousLeagueId) hasSuccessor.add(e.previousLeagueId);
  }
}

const seasons = [...new Set([...leagues.values()].map((l) => l.season))].sort();
const latest = Math.max(...seasons);
// A league in the newest observed season cannot be scored: its successor would
// be next season, which we have not seen.
const scorable = [...leagues.values()].filter((l) => l.season < latest);

const formatOf = (l: LeagueSeason) =>
  l.format.bestBall ? 'Best ball' : l.format.type;

interface Cell { n: number; renewed: number }
const cell = (): Cell => ({ n: 0, renewed: 0 });
const add = (map: Map<string, Cell>, key: string, renewed: boolean) => {
  const c = map.get(key) ?? cell();
  c.n++;
  if (renewed) c.renewed++;
  map.set(key, c);
};

const byFormat = new Map<string, Cell>();
const bySeason = new Map<string, Cell>();
const byFormatSeason = new Map<string, Cell>();
const byObservers = new Map<string, Cell>();
const byFormatObservers = new Map<string, Cell>();

for (const l of scorable) {
  const renewed = hasSuccessor.has(l.leagueId);
  const fmt = formatOf(l);
  const obs = l.observers.size;
  const band = obs === 1 ? '1 observer' : obs <= 3 ? '2-3 observers' : obs <= 7 ? '4-7 observers' : '8+ observers';
  add(byFormat, fmt, renewed);
  add(bySeason, String(l.season), renewed);
  add(byFormatSeason, `${fmt}|${l.season}`, renewed);
  add(byObservers, band, renewed);
  add(byFormatObservers, `${fmt}|${band}`, renewed);
}

const pct = (c: Cell) => (c.n ? `${((100 * c.renewed) / c.n).toFixed(1)}%` : 'n/a');
// Wilson interval — the segments get small once split three ways.
function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!n) return [NaN, NaN];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}
const ci = (c: Cell) => {
  const [lo, hi] = wilson(c.renewed, c.n);
  return `${(100 * lo).toFixed(1)}–${(100 * hi).toFixed(1)}%`;
};

const formats = [...byFormat.keys()].sort((a, b) => byFormat.get(b)!.n - byFormat.get(a)!.n);
const obsBands = ['1 observer', '2-3 observers', '4-7 observers', '8+ observers'];

const L: string[] = [];
const line = (s = '') => L.push(s);
line('# Do leagues renew year over year?');
line();
line(`Generated ${new Date().toISOString()} · source \`${INPUT}\``);
line();
line(`${leagues.size.toLocaleString()} distinct league-seasons across ${seasons[0]}–${latest}, from`);
line(`${pop.length.toLocaleString()} enumerated portfolios. ${scorable.length.toLocaleString()} are scorable —`);
line(`${latest} is excluded because its successor would be next season.`);
line();
line('> ⚠️ **These are lower bounds.** A league is seen only through the managers whose');
line('> portfolios we enumerated, so one that renewed but lost all of them reads as');
line('> un-renewed. The bias shrinks as more of a league\'s members are observed, which');
line('> is what the observer-count table is for — read that before the headline.');
line();

line('## By format');
line();
line('| Format | League-seasons | Renewed | 95% CI |');
line('| --- | --- | --- | --- |');
for (const f of formats) {
  const c = byFormat.get(f)!;
  line(`| ${f} | ${c.n.toLocaleString()} | **${pct(c)}** | ${ci(c)} |`);
}
line();

line('## By how much of the league we can see');
line();
line('The censoring correction. If the lower bound is the whole story, renewal should');
line('rise with the number of observed members — and keep rising, because even 8');
line('observers is not the whole league.');
line();
line(`| Observers | ${formats.map((f) => f).join(' | ')} | All |`);
line(`| --- | ${formats.map(() => '---').join(' | ')} | --- |`);
for (const band of obsBands) {
  const cells = formats.map((f) => {
    const c = byFormatObservers.get(`${f}|${band}`);
    return c && c.n >= 20 ? `${pct(c)} (n=${c.n})` : c ? `·  (n=${c.n})` : '—';
  });
  const all = byObservers.get(band);
  line(`| ${band} | ${cells.join(' | ')} | ${all ? `${pct(all)} (n=${all.n})` : '—'} |`);
}
line();
line('Cells with fewer than 20 league-seasons are shown as `·` — the rate would be noise.');
line();

line('## By season');
line();
line(`| Season → next | ${formats.join(' | ')} | All |`);
line(`| --- | ${formats.map(() => '---').join(' | ')} | --- |`);
for (const s of seasons.filter((s) => s < latest)) {
  const cells = formats.map((f) => {
    const c = byFormatSeason.get(`${f}|${s}`);
    return c && c.n >= 20 ? `${pct(c)} (n=${c.n})` : c ? `·  (n=${c.n})` : '—';
  });
  const all = bySeason.get(String(s));
  line(`| ${s} → ${s + 1} | ${cells.join(' | ')} | ${all ? `${pct(all)} (n=${all.n})` : '—'} |`);
}
line();

// ── does a broken chain mean the group broke up? ──
//
// previous_league_id records Sleeper's ROLLOVER FEATURE, not "did these people
// play together again". A dynasty league must roll over to keep its rosters; a
// redraft group can just create a fresh league each August, which leaves
// previous_league_id null and looks identical to the league dying.
//
// Test: for a league-season with no recorded successor, where we observed at
// least two of its managers, do two or more of those managers turn up together
// in some OTHER league the next season? If so the group persisted and only the
// chain broke.
const leaguesByManagerSeason = new Map<string, Set<string>>();   // `${manager}|${season}` -> leagueIds
for (const m of pop) {
  for (const e of m.portfolio ?? []) {
    const key = `${m.managerId}|${e.season}`;
    let set = leaguesByManagerSeason.get(key);
    if (!set) { set = new Set(); leaguesByManagerSeason.set(key, set); }
    set.add(e.leagueId);
  }
}

// A PLACEBO IS REQUIRED. Managers here play a median ~96 league-seasons, so two
// of them turning up in some common league next season happens constantly by
// chance — especially in best ball, where one person may enter hundreds of
// tournaments. Without a null, "the group reformed" measures nothing but volume.
//
// So for each league we also draw the same number of RANDOM managers active that
// season and run the identical test on them. The real rate only means something
// to the extent it exceeds the placebo.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(0x1eaf17);

const activeBySeason = new Map<number, string[]>();
for (const m of pop) {
  for (const s of new Set((m.portfolio ?? []).map((e) => Number(e.season)))) {
    if (!activeBySeason.has(s)) activeBySeason.set(s, []);
    activeBySeason.get(s)!.push(m.managerId);
  }
}
for (const list of activeBySeason.values()) list.sort();

// Do 2+ of these managers share any league in `season`?
const anyTogether = (managers: Iterable<string>, season: number): boolean => {
  const together = new Map<string, number>();
  for (const managerId of managers) {
    for (const lid of leaguesByManagerSeason.get(`${managerId}|${season}`) ?? []) {
      const c = (together.get(lid) ?? 0) + 1;
      if (c >= 2) return true;
      together.set(lid, c);
    }
  }
  return false;
};

interface Reform { n: number; reformed: number; placebo: number }
const reformByFormat = new Map<string, Reform>();
for (const l of scorable) {
  if (hasSuccessor.has(l.leagueId)) continue;      // chain intact, nothing to explain
  if (l.observers.size < 2) continue;              // cannot detect a pair
  const fmt = formatOf(l);
  const next = l.season + 1;

  const reformed = anyTogether(l.observers, next);

  // Placebo: the same number of managers, drawn at random from those active in
  // this league's season, tested identically.
  const pool = activeBySeason.get(l.season) ?? [];
  const picks = new Set<string>();
  for (let i = 0; i < l.observers.size * 4 && picks.size < l.observers.size && pool.length; i++) {
    picks.add(pool[Math.floor(rand() * pool.length)]);
  }
  const placebo = picks.size >= 2 && anyTogether(picks, next);

  const r = reformByFormat.get(fmt) ?? { n: 0, reformed: 0, placebo: 0 };
  r.n++;
  if (reformed) r.reformed++;
  if (placebo) r.placebo++;
  reformByFormat.set(fmt, r);
}

line('## Broken chain, or broken league?');
line();
line('`previous_league_id` records Sleeper\'s **rollover feature**, not whether the same');
line('people played together again. A dynasty league has to roll over to keep its');
line('rosters. A redraft group can simply create a fresh league each August, which');
line('leaves the pointer null and is indistinguishable from the league folding.');
line();
line('Among league-seasons with no recorded successor where we observed at least two');
line('managers: how often do two or more of them appear together in some other league');
line('the next season?');
line();
line('Random managers are tested the same way as a placebo, because these managers');
line('play a median ~96 league-seasons and coincide constantly by chance. Only the');
line('**lift over placebo** is evidence.');
line();
line('| Format | No successor (2+ observed) | Reformed | Placebo | Lift |');
line('| --- | --- | --- | --- | --- |');
for (const f of formats) {
  const r = reformByFormat.get(f);
  if (!r || r.n < 20) continue;
  const real = (100 * r.reformed) / r.n;
  const plac = (100 * r.placebo) / r.n;
  line(`| ${f} | ${r.n.toLocaleString()} | ${real.toFixed(1)}% | ${plac.toFixed(1)}% | **${(real - plac >= 0 ? '+' : '')}${(real - plac).toFixed(1)} pts** |`);
}
line();
line('A large positive lift means the format\'s renewal figure above is measuring');
line('rollover-feature usage rather than league survival, and must not be read as');
line('leagues dying. A lift near zero means the co-occurrence was chance and the test');
line('says nothing either way.');
line();

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/league-renewal.md`, `${L.join('\n')}\n`);
writeFileSync(`${OUT}/league-renewal.json`, `${JSON.stringify({
  leagueSeasons: leagues.size, scorable: scorable.length, seasons,
  byFormat: Object.fromEntries(byFormat), bySeason: Object.fromEntries(bySeason),
  byObservers: Object.fromEntries(byObservers),
  byFormatObservers: Object.fromEntries(byFormatObservers),
}, null, 2)}\n`);

console.log(`\nLeague renewal — ${scorable.length.toLocaleString()} scorable league-seasons\n`);
console.log('  format            n        renewed (lower bound)');
for (const f of formats) {
  const c = byFormat.get(f)!;
  console.log(`  ${f.padEnd(16)} ${String(c.n).padStart(6)}   ${pct(c).padStart(7)}`);
}
console.log('\n  by observers seen in the league:');
for (const band of obsBands) {
  const c = byObservers.get(band);
  if (c) console.log(`  ${band.padEnd(16)} ${String(c.n).padStart(6)}   ${pct(c).padStart(7)}`);
}
console.log('\n  no recorded successor, 2+ observers — did the group reform elsewhere?');
for (const f of formats) {
  const r = reformByFormat.get(f);
  if (!r || r.n < 20) continue;
  const real = (100 * r.reformed) / r.n;
  const plac = (100 * r.placebo) / r.n;
  console.log(`  ${f.padEnd(16)} ${String(r.n).padStart(6)}   real ${real.toFixed(1).padStart(5)}%   placebo ${plac.toFixed(1).padStart(5)}%   lift ${(real - plac).toFixed(1).padStart(6)} pts`);
}
console.log(`\n  → ${OUT}/league-renewal.md\n`);
