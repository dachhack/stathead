// How long do managers stay in a dynasty league?
//
// Run: npx tsx scripts/analyze-dynasty-member-survival.ts [--input=sleeper-population.json]
//                                                         [--out=reports/dynasty]
//
// WHY DYNASTY ONLY. previous_league_id records Sleeper's rollover feature. A
// dynasty league must roll over to keep its rosters, so for dynasty the pointer
// and the reality coincide and lineages are trustworthy. For redraft they are
// not — groups recreate leagues from scratch — so redraft is out of scope here.
//
// TWO THINGS THIS GETS RIGHT, both of which change the numbers:
//
// 1. It conditions on the LEAGUE SURVIVING. A manager-season is only at risk if
//    the lineage is observed to continue into the next season. Otherwise a
//    league folding is counted as every one of its members quitting, which is a
//    different event entirely.
//
// 2. Membership is measured exactly, not sampled. Every manager's full portfolio
//    was enumerated, so if a manager is in next season's league we see it in
//    their own league list. Unlike league renewal, there is no censoring on the
//    member side.
//
// The survival curve uses only OBSERVED JOINS — a manager absent from the
// lineage in season y-1 and present in y. Managers already present in the first
// observed season are left-truncated: they may have joined years earlier, and
// counting them from 2021 would understate tenure.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import type { ManagerObservation } from '../src/lib/featureAudit';
import { resolveLineages, type LeagueSeasonRef } from '../src/lib/leagueLineage';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'] as [string, string];
}));
const INPUT = args.get('input') ?? 'sleeper-population.json';
const OUT = args.get('out') ?? 'reports/dynasty';

const pop: ManagerObservation[] = JSON.parse(readFileSync(INPUT, 'utf8'));

// Dynasty league-seasons only, from every enumerated portfolio.
interface Entry { leagueId: string; previousLeagueId: string | null; season: number; totalRosters: number }
const dynasty = new Map<string, Entry>();
const membership = new Map<string, Set<string>>();   // `${lineage}|${season}` -> managerIds

for (const m of pop) {
  for (const e of m.portfolio ?? []) {
    if (e.format.bestBall || e.format.type !== 'Dynasty') continue;
    if (!dynasty.has(e.leagueId)) {
      dynasty.set(e.leagueId, {
        leagueId: e.leagueId, previousLeagueId: e.previousLeagueId,
        season: Number(e.season), totalRosters: e.totalRosters,
      });
    }
  }
}

const index = resolveLineages([...dynasty.values()].map((e): LeagueSeasonRef => ({
  leagueId: e.leagueId, previousLeagueId: e.previousLeagueId, season: String(e.season),
})));

// Which seasons does each lineage exist in, and who was in it?
const lineageSeasons = new Map<string, Set<number>>();
const sizeOf = new Map<string, number>();   // lineage -> modal roster count
for (const e of dynasty.values()) {
  const lin = index.byLeagueId.get(e.leagueId);
  if (!lin) continue;
  if (!lineageSeasons.has(lin)) lineageSeasons.set(lin, new Set());
  lineageSeasons.get(lin)!.add(e.season);
  if (e.totalRosters) sizeOf.set(lin, Math.max(sizeOf.get(lin) ?? 0, e.totalRosters));
}
for (const m of pop) {
  for (const e of m.portfolio ?? []) {
    if (e.format.bestBall || e.format.type !== 'Dynasty') continue;
    const lin = index.byLeagueId.get(e.leagueId);
    if (!lin) continue;
    const key = `${lin}|${e.season}`;
    if (!membership.has(key)) membership.set(key, new Set());
    membership.get(key)!.add(m.managerId);
  }
}

const inLineage = (lin: string, season: number, manager: string) =>
  membership.get(`${lin}|${season}`)?.has(manager) ?? false;
const lineageAlive = (lin: string, season: number) => lineageSeasons.get(lin)?.has(season) ?? false;

// ── year-over-year member survival, conditioned on the league continuing ──

interface Cell { atRisk: number; stayed: number }
const cell = (): Cell => ({ atRisk: 0, stayed: 0 });
const bump = (map: Map<string, Cell>, key: string, stayed: boolean) => {
  const c = map.get(key) ?? cell();
  c.atRisk++;
  if (stayed) c.stayed++;
  map.set(key, c);
};

const overall = cell();
const bySeason = new Map<string, Cell>();
const byTenure = new Map<string, Cell>();
const bySize = new Map<string, Cell>();

// Tenure = consecutive seasons already spent in this lineage, counted back from
// the season at risk. Capped by the observation window, so 4+ is a floor.
function tenureAt(lin: string, manager: string, season: number): number {
  let years = 1;
  while (inLineage(lin, season - years, manager)) years++;
  return years;
}

for (const [key, members] of membership) {
  const [lin, seasonStr] = key.split('|');
  const season = Number(seasonStr);
  // Only at risk if the league itself continues — otherwise this is a league
  // ending, not members leaving.
  if (!lineageAlive(lin, season + 1)) continue;

  for (const manager of members) {
    const stayed = inLineage(lin, season + 1, manager);
    overall.atRisk++;
    if (stayed) overall.stayed++;
    bump(bySeason, `${season} → ${season + 1}`, stayed);
    const t = tenureAt(lin, manager, season);
    bump(byTenure, t >= 4 ? '4+ years' : `${t} year${t === 1 ? '' : 's'}`, stayed);
    const size = sizeOf.get(lin) ?? 0;
    bump(bySize, size <= 10 ? '≤10 teams' : size <= 12 ? '12 teams' : '14+ teams', stayed);
  }
}

// ── survival curve from observed joins ──
//
// A join is a manager absent in season y-1 (with the lineage alive then) and
// present in y. Following those forward avoids left-truncation.
// Kaplan-Meier, because the naive version is wrong in a way that shows.
//
// A first pass counted "still present k years later" over ALL joins. That put
// +1y at 52% while year-over-year survival was 84.8% — irreconcilable, and the
// reason is that a join whose league folded (or whose later seasons we never
// observe) was silently counted as a departure. Those are CENSORED, not failures.
//
// So at each step the risk set is joins whose league is still observed alive and
// who were present the year before; leaving is a failure, the league ending is a
// censoring, and S(k) is the product of per-step survival.
const maxK = 4;
interface KM { joins: number; atRisk: number[]; failures: number[]; censored: number[] }
const km = (): KM => ({
  joins: 0,
  atRisk: new Array(maxK + 1).fill(0),
  failures: new Array(maxK + 1).fill(0),
  censored: new Array(maxK + 1).fill(0),
});
const cohort = km();
const joinsBySize = new Map<string, KM>();

for (const [key, members] of membership) {
  const [lin, seasonStr] = key.split('|');
  const season = Number(seasonStr);
  if (!lineageAlive(lin, season - 1)) continue;   // cannot see the absence

  for (const manager of members) {
    if (inLineage(lin, season - 1, manager)) continue;   // not a join

    const size = sizeOf.get(lin) ?? 0;
    const band = size <= 10 ? '≤10 teams' : size <= 12 ? '12 teams' : '14+ teams';
    let c = joinsBySize.get(band);
    if (!c) { c = km(); joinsBySize.set(band, c); }
    cohort.joins++;
    c.joins++;

    for (let k = 1; k <= maxK; k++) {
      if (!lineageAlive(lin, season + k)) {
        // The league is gone or unobserved: censor here, and it is not a
        // departure. This is the whole difference from the naive count.
        cohort.censored[k]++; c.censored[k]++;
        break;
      }
      cohort.atRisk[k]++; c.atRisk[k]++;
      if (inLineage(lin, season + k, manager)) continue;
      cohort.failures[k]++; c.failures[k]++;
      break;
    }
  }
}

function survivalCurve(k: KM): { step: number; atRisk: number; left: number; censored: number; survival: number }[] {
  const out: { step: number; atRisk: number; left: number; censored: number; survival: number }[] = [];
  let s = 1;
  for (let i = 1; i <= maxK; i++) {
    if (!k.atRisk[i]) break;
    s *= 1 - k.failures[i] / k.atRisk[i];
    out.push({ step: i, atRisk: k.atRisk[i], left: k.failures[i], censored: k.censored[i], survival: s });
  }
  return out;
}
const curve = survivalCurve(cohort);

const rate = (c: Cell) => (c.atRisk ? (100 * c.stayed) / c.atRisk : NaN);
const fmt = (x: number) => (Number.isFinite(x) ? `${x.toFixed(1)}%` : 'n/a');
function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!n) return [NaN, NaN];
  const p = k / n; const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}
const ci = (c: Cell) => {
  const [lo, hi] = wilson(c.stayed, c.atRisk);
  return `${(100 * lo).toFixed(1)}–${(100 * hi).toFixed(1)}%`;
};

const L: string[] = [];
const line = (s = '') => L.push(s);
line('# Dynasty league member survival');
line();
line(`Generated ${new Date().toISOString()} · source \`${INPUT}\``);
line();
line(`${dynasty.size.toLocaleString()} dynasty league-seasons collapsing to ${lineageSeasons.size.toLocaleString()} lineages,`);
line(`from ${pop.length.toLocaleString()} enumerated portfolios.`);
line();
line('Dynasty only: a dynasty league has to roll over to keep its rosters, so');
line('`previous_league_id` and reality coincide and lineages are trustworthy. Redraft');
line('is out of scope — those groups recreate leagues from scratch and the pointer');
line('says nothing.');
line();
line('**A manager-season counts as at risk only if the league itself continues.**');
line('Otherwise a league folding is counted as every member quitting, which is a');
line('different event. Membership itself is exact rather than sampled: every');
line('portfolio was enumerated, so a manager still in the league next season appears');
line('in their own league list.');
line();
line(`## Year-over-year survival`);
line();
line(`**${overall.stayed.toLocaleString()} of ${overall.atRisk.toLocaleString()} manager-seasons stayed — ${fmt(rate(overall))}** (${ci(overall)}).`);
line();
line('| Transition | At risk | Stayed | 95% CI |');
line('| --- | --- | --- | --- |');
for (const k of [...bySeason.keys()].sort()) {
  const c = bySeason.get(k)!;
  line(`| ${k} | ${c.atRisk.toLocaleString()} | **${fmt(rate(c))}** | ${ci(c)} |`);
}
line();
line('## By tenure already served');
line();
line('Tenure is capped by the observation window, so "4+ years" is a floor.');
line();
line('| Tenure entering the season | At risk | Stayed | 95% CI |');
line('| --- | --- | --- | --- |');
for (const k of ['1 year', '2 years', '3 years', '4+ years']) {
  const c = byTenure.get(k);
  if (!c) continue;
  line(`| ${k} | ${c.atRisk.toLocaleString()} | **${fmt(rate(c))}** | ${ci(c)} |`);
}
line();
line('## By league size');
line();
line('| Size | At risk | Stayed | 95% CI |');
line('| --- | --- | --- | --- |');
for (const k of ['≤10 teams', '12 teams', '14+ teams']) {
  const c = bySize.get(k);
  if (!c) continue;
  line(`| ${k} | ${c.atRisk.toLocaleString()} | **${fmt(rate(c))}** | ${ci(c)} |`);
}
line();
line('## Survival curve from an observed join');
line();
line(`${cohort.joins.toLocaleString()} observed joins — a manager absent from the lineage one`);
line('season and present the next. Following joins forward avoids left-truncation:');
line('managers already present in the first observed season may have joined years');
line('earlier, and counting them from 2021 would understate tenure.');
line();
line('Kaplan-Meier, so a league that folds or falls outside the window **censors**');
line('the manager rather than counting as a departure. A first pass without that');
line('distinction put year one at 52% against a year-over-year rate of 84.8% — the');
line('gap was entirely league deaths being scored as people leaving.');
line();
line('| Years after joining | At risk | Left | Censored | Still in the league |');
line('| --- | --- | --- | --- | --- |');
for (const row of curve) {
  line(`| ${row.step} | ${row.atRisk.toLocaleString()} | ${row.left.toLocaleString()} | ${row.censored.toLocaleString()} | **${fmt(100 * row.survival)}** |`);
}
line();
line('The observation window caps the curve at four years.');
line();

// Median tenure, read off the curve.
const firstBelowHalf = curve.find((r) => r.survival < 0.5);
const lastAboveHalf = [...curve].reverse().find((r) => r.survival >= 0.5);
line('## Reading');
line();
if (firstBelowHalf && lastAboveHalf) {
  line(`Median tenure from joining falls between **${lastAboveHalf.step} and ${firstBelowHalf.step} years** ` +
    `(${fmt(100 * lastAboveHalf.survival)} then ${fmt(100 * firstBelowHalf.survival)}).`);
} else if (curve.length) {
  line(`Survival is still ${fmt(100 * curve[curve.length - 1].survival)} at ${curve[curve.length - 1].step} years, so the median is beyond the window.`);
}
line();
line('**New members are the churn.** Three figures that look contradictory and are not:');
line();
line(`- Year-over-year survival across all members: **${fmt(rate(overall))}**.`);
const t1 = byTenure.get('1 year');
const t4 = byTenure.get('4+ years');
if (t1 && t4) {
  line(`- By tenure: **${fmt(rate(t1))}** at one year against **${fmt(rate(t4))}** at four or more.`);
}
if (curve.length) {
  line(`- First year after an *observed* join: **${fmt(100 * curve[0].survival)}**.`);
}
line();
line('The last is lower than the one-year tenure bucket because that bucket is');
line('left-truncated: a manager first seen in the earliest observed season may have');
line('been in the league for years already. The join cohort is genuinely new, so its');
line('figure is the honest new-member rate and the tenure table understates the');
line('difference between newcomers and veterans.');
line();
const censoredStep1 = curve.length ? curve[0].censored : 0;
if (censoredStep1 && cohort.joins) {
  line(`Censoring is heavy: **${((100 * censoredStep1) / cohort.joins).toFixed(0)}%** of joins are censored at the`);
  line('first step, because many dynasty lineages are observed for only a short span.');
  line('Kaplan-Meier handles that correctly, but the later steps rest on a much smaller');
  line('risk set than the join count suggests.');
  line();
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/dynasty-member-survival.md`, `${L.join('\n')}\n`);
writeFileSync(`${OUT}/dynasty-member-survival.json`, `${JSON.stringify({
  dynastyLeagueSeasons: dynasty.size, lineages: lineageSeasons.size,
  overall, bySeason: Object.fromEntries(bySeason), byTenure: Object.fromEntries(byTenure),
  bySize: Object.fromEntries(bySize), joinCohort: cohort,
  joinsBySize: Object.fromEntries(joinsBySize),
}, null, 2)}\n`);

console.log(`\nDynasty member survival — ${lineageSeasons.size.toLocaleString()} lineages`);
console.log(`  year over year: ${fmt(rate(overall))} of ${overall.atRisk.toLocaleString()} manager-seasons\n`);
console.log('  tenure entering    at risk    stayed');
for (const k of ['1 year', '2 years', '3 years', '4+ years']) {
  const c = byTenure.get(k);
  if (c) console.log(`  ${k.padEnd(18)} ${String(c.atRisk).padStart(7)}   ${fmt(rate(c)).padStart(7)}`);
}
console.log(`\n  from ${cohort.joins.toLocaleString()} observed joins (Kaplan-Meier, league death censors):`);
for (const row of curve) {
  console.log(`  +${row.step}y  ${fmt(100 * row.survival).padStart(7)}   (at risk ${String(row.atRisk).padStart(5)}, left ${String(row.left).padStart(4)}, censored ${String(row.censored).padStart(5)})`);
}
console.log(`\n  → ${OUT}/dynasty-member-survival.md\n`);
