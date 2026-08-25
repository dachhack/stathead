// Do the engagement segments predict who comes back?
//
// Build segments from data available AS OF 2024, then measure what share of
// each segment fielded a team in 2025. Strictly temporal: nothing from 2025 or
// later touches the profile, so this is a forecast rather than a description.
//
// Run: npx tsx scripts/validate-segments-retention.ts [--input=sleeper-population.json]
//                                                     [--build=2024] [--validate=2025]
//                                                     [--out=reports/segments]
//
// The design doc says segments have to be validated by predicting behaviour or
// they are decoration. This is that test, and "% retained" is the metric.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import {
  engagementProfile, managerSeasonEngagement, coldStartSegment, tradesFromEvents, wentDark,
  type EngagementProfile, type SegmentName,
} from '../src/lib/engagement';
import { resolveLineages, type LeagueSeasonRef } from '../src/lib/leagueLineage';
import type { ManagerObservation } from '../src/lib/featureAudit';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'] as [string, string];
}));
const INPUT = args.get('input') ?? 'sleeper-population.json';
const BUILD = args.get('build') ?? '2024';
const VALIDATE = args.get('validate') ?? '2025';
const OUT = args.get('out') ?? 'reports/segments';

const pop: ManagerObservation[] = JSON.parse(readFileSync(INPUT, 'utf8'));
let horizons: Record<string, number> = {};
try {
  horizons = JSON.parse(readFileSync(`${INPUT.replace(/\.json$/, '')}-manifest.json`, 'utf8')).horizonBySeason ?? {};
} catch { /* fall back to a full season */ }
const horizonWeek = (s: string) => Math.min(17, horizons[s] ?? 17);

const buildYear = Number(BUILD);
const validateYear = Number(VALIDATE);

// Wilson score interval — the right one for proportions on small segments,
// where the normal approximation puts bounds outside [0, 1].
function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!n) return [NaN, NaN];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - spread) / d), Math.min(1, (centre + spread) / d)];
}

interface Subject {
  managerId: string;
  wentDarkInBuild: boolean;
  profile: EngagementProfile;
  segment: SegmentName;
  confidence: number;
  retainedPlatform: boolean;   // fielded any team in the validation season
  retainedLineage: boolean;    // returned to one of the build season's leagues
  buildLeagueSeasons: number;
}

const subjects: Subject[] = [];
for (const m of pop) {
  const portfolio = m.portfolio ?? [];
  // Must have been present in the build season to be "retained" afterwards.
  const inBuild = portfolio.filter((e) => Number(e.season) === buildYear);
  if (!inBuild.length) continue;

  // Everything the profile sees is strictly at or before the build season.
  const asOfPortfolio = portfolio.filter((e) => Number(e.season) <= buildYear);
  const events = (m.events ?? []).filter((e) => Number(e.season) <= buildYear);
  const history = (m.history ?? []).filter((hh) => Number(hh.season) <= buildYear);

  const profile = engagementProfile(
    m.managerId, history,
    managerSeasonEngagement(history, events, { horizonWeek }),
    events, tradesFromEvents(events),
    { horizonWeek, portfolio: asOfPortfolio, asOfSeason: String(validateYear) },
  );

  // Retention, measured two ways. Platform retention is the cleaner signal;
  // lineage retention is confounded by leagues that simply folded.
  const retainedPlatform = portfolio.some((e) => Number(e.season) === validateYear);
  const index = resolveLineages(portfolio.map((e): LeagueSeasonRef => ({
    leagueId: e.leagueId, previousLeagueId: e.previousLeagueId, season: e.season,
  })));
  const buildLineages = new Set(inBuild.map((e) => index.byLeagueId.get(e.leagueId)).filter(Boolean));
  const retainedLineage = portfolio.some((e) =>
    Number(e.season) === validateYear && buildLineages.has(index.byLeagueId.get(e.leagueId)));

  // Did they go dark in the build season, in any non-best-ball league they
  // played? Observed, not predicted — the season is over.
  const buildRows = m.rows.filter((r) => Number(r.season) === buildYear);
  const wentDarkInBuild = buildRows.some((r) => wentDark(r));

  const seg = coldStartSegment(profile);
  subjects.push({
    managerId: m.managerId, wentDarkInBuild, profile, segment: seg.segment, confidence: seg.confidence,
    retainedPlatform, retainedLineage, buildLeagueSeasons: inBuild.length,
  });
}

const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : 'n/a');
const baseK = subjects.filter((s) => s.retainedPlatform).length;
const baseRate = baseK / subjects.length;
const lineageRate = subjects.filter((s) => s.retainedLineage).length / subjects.length;

interface Bucket { label: string; n: number; retained: number; lineage: number }
function bucketise(key: (s: Subject) => string): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const s of subjects) {
    const label = key(s);
    let b = map.get(label);
    if (!b) { b = { label, n: 0, retained: 0, lineage: 0 }; map.set(label, b); }
    b.n++;
    if (s.retainedPlatform) b.retained++;
    if (s.retainedLineage) b.lineage++;
  }
  return [...map.values()].sort((a, b) => b.retained / b.n - a.retained / a.n);
}

// Chi-square against the base rate: is the spread between buckets more than
// sampling noise? Buckets under 20 are excluded — a segment of six tells you
// nothing and drags the statistic around.
function chiSquare(buckets: Bucket[], rate: number, pick: (b: Bucket) => number):
{ chi2: number; df: number; usable: number; critical: number; rejects: boolean } {
  const usable = buckets.filter((b) => b.n >= 20);
  let chi2 = 0;
  let df = 0;
  for (const b of usable) {
    const expected = b.n * rate;
    const expectedNot = b.n * (1 - rate);
    // The chi-square approximation needs both expected cells above ~5. With a
    // 95% base rate the "did not return" cell is the binding one.
    if (expected < 5 || expectedNot < 5) continue;
    chi2 += (pick(b) - expected) ** 2 / expected + ((b.n - pick(b)) - expectedNot) ** 2 / expectedNot;
    df++;
  }
  const critical = CHI2_95[Math.max(0, df - 1)] ?? Infinity;
  return { chi2, df: Math.max(0, df - 1), usable: usable.length, critical, rejects: chi2 > critical };
}

// 95th percentile of the chi-square distribution, indexed by degrees of
// freedom. Small table beats pulling in a stats dependency for one lookup.
const CHI2_95 = [3.84, 5.99, 7.81, 9.49, 11.07, 12.59, 14.07, 15.51, 16.92, 18.31, 19.68];

const bySegment = bucketise((s) => s.segment);
// Single-variable comparators: a segmentation has to beat the obvious column,
// or it is a more complicated way of saying the same thing.
const byLeagueCount = bucketise((s) => {
  const n = s.profile.leagueSeasons;
  return n <= 10 ? 'portfolio 1-10' : n <= 50 ? 'portfolio 11-50' : n <= 200 ? 'portfolio 51-200' : 'portfolio 200+';
});
const byIntensity = bucketise((s) => {
  const t = s.profile.txnPerLeagueWeek;
  return t < 0.05 ? 'intensity <0.05' : t < 0.3 ? 'intensity 0.05-0.3' : t < 1 ? 'intensity 0.3-1' : 'intensity 1+';
});

const L: string[] = [];
const line = (s = '') => L.push(s);
line(`# Segment retention — built on ${BUILD}, validated on ${VALIDATE}`);
line();
line(`Generated ${new Date().toISOString()} · source \`${INPUT}\``);
line();
line('Segments are built from data available **as of the build season only** — no');
line(`${VALIDATE} information touches the profile — and scored on what share of each`);
line(`segment fielded a team in ${VALIDATE}. A forecast, not a description.`);
line();
line(`**${subjects.length} managers** active in ${BUILD}. Base retention into ${VALIDATE}:`);
line(`**${pct(baseRate)}** on the platform, **${pct(lineageRate)}** back in the same league.`);
line();
if (baseRate > 0.9) {
  line(`> ⚠️ **Ceiling effect.** ${pct(baseRate)} of this population came back, so platform`);
  line('> retention has almost no variance to explain and any segmentation will look');
  line('> flat against it. That is a property of the sample — managers reached through');
  line('> one power user\'s network, median portfolio ~96 league-seasons — not a finding');
  line('> about Sleeper. Same-league retention has more headroom and is the better');
  line('> metric here.');
  line();
}

function table(title: string, buckets: Bucket[], note?: string) {
  line(`## ${title}`);
  line();
  if (note) { line(note); line(); }
  line('| Bucket | n | % retained | 95% CI | % same league |');
  line('| --- | --- | --- | --- | --- |');
  for (const b of buckets) {
    const [lo, hi] = wilson(b.retained, b.n);
    const small = b.n < 20 ? ' ⚠︎' : '';
    line(`| ${b.label}${small} | ${b.n} | **${pct(b.retained / b.n)}** | ${pct(lo)}–${pct(hi)} | ${pct(b.lineage / b.n)} |`);
  }
  const plat = chiSquare(buckets, baseRate, (b) => b.retained);
  const lin = chiSquare(buckets, lineageRate, (b) => b.lineage);
  line();
  line(`Platform retention: χ² = ${plat.chi2.toFixed(1)} on ${plat.df} df ` +
    `(5% critical ${plat.critical.toFixed(2)}) — **${plat.rejects ? 'rejects' : 'does not reject'}** the null that every bucket shares the base rate.`);
  line(`Same-league retention: χ² = ${lin.chi2.toFixed(1)} on ${lin.df} df ` +
    `(5% critical ${lin.critical.toFixed(2)}) — **${lin.rejects ? 'rejects' : 'does not reject'}**.`);
  line();
}

table('By engagement segment', bySegment,
  'Buckets marked ⚠︎ have fewer than 20 managers and are shown for completeness only.');
table('By portfolio size alone', byLeagueCount,
  'The comparator. A segmentation has to beat the obvious single column, or it is a more complicated way of saying the same thing.');
table('By transaction intensity alone', byIntensity);

// The conditional the offseason panel actually needs: a manager went dark last
// season — how often did they come back to that league?
const byWentDark = bucketise((s) => (s.wentDarkInBuild ? `went dark in ${BUILD}` : `stayed active in ${BUILD}`));
table(`By observed behaviour in ${BUILD}`, byWentDark,
  'Observed, not predicted — the season is over. This is the conditional a retrospective panel quotes: they went dark, so how often did they come back?');

const spread = bySegment.filter((b) => b.n >= 20);
const segPlat = chiSquare(bySegment, baseRate, (b) => b.retained);
const segLin = chiSquare(bySegment, lineageRate, (b) => b.lineage);
line('## Reading');
line();
line('The omnibus test comes first, because picking the widest gap out of eight buckets');
line('after seeing them is how noise gets published.');
line();
line(`- Platform retention: ${segPlat.rejects ? 'the segments differ beyond noise' : '**the segments do not differ beyond noise**'} ` +
  `(χ² ${segPlat.chi2.toFixed(1)} vs critical ${segPlat.critical.toFixed(2)}).`);
line(`- Same-league retention: ${segLin.rejects ? '**the segments do differ beyond noise**' : 'the segments do not differ beyond noise'} ` +
  `(χ² ${segLin.chi2.toFixed(1)} vs critical ${segLin.critical.toFixed(2)}).`);
line();
const best = spread[0];
const worst = spread[spread.length - 1];
if (best && worst && best !== worst) {
  const [bl] = wilson(best.retained, best.n);
  const [, wh] = wilson(worst.retained, worst.n);
  line(`Post-hoc, the widest usable gap is **${best.label}** at ${pct(best.retained / best.n)} against ` +
    `**${worst.label}** at ${pct(worst.retained / worst.n)}; their intervals ` +
    `${bl > wh ? 'do not overlap' : 'overlap'} (${pct(bl)} vs ${pct(wh)}).`);
  line();
  line(segPlat.rejects
    ? 'With the omnibus test rejecting, that pair is worth following up.'
    : 'With the omnibus test failing to reject, treat that pair as a hypothesis for a');
  if (!segPlat.rejects) line('larger or less selected sample — not as a result.');
  line();
}
line('## Limits');
line();
line('- One seed portfolio: every manager is a league-mate or a league-mate\'s league-mate.');
line(`- Platform retention counts fielding *any* team in ${VALIDATE}. Same-league retention is`);
line('  shown alongside but is confounded by leagues that simply folded.');
line('- Intensity and sociality axes are computed on the crawled slice (~7% of each');
line('  portfolio); volume, mode and persistence are exact from the enumeration.');

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/segment-retention.md`, `${L.join('\n')}\n`);
writeFileSync(`${OUT}/segment-retention.json`, `${JSON.stringify({
  build: BUILD, validate: VALIDATE, subjects: subjects.length, baseRate,
  bySegment, byLeagueCount, byIntensity,
}, null, 2)}\n`);

console.log(`\nSegment retention — built ${BUILD}, validated ${VALIDATE}`);
console.log(`  ${subjects.length} managers · base retention ${pct(baseRate)}\n`);
console.log('  segment                     n    % retained   same league');
for (const b of bySegment) {
  console.log(`  ${b.label.padEnd(26)} ${String(b.n).padStart(4)}   ${pct(b.retained / b.n).padStart(9)}   ${pct(b.lineage / b.n).padStart(10)}`);
}
console.log(`\n  → ${OUT}/segment-retention.md\n`);
