// Data-completeness and feature-audit report for the Sleeper manager-engagement
// pipeline.
//
// Run:  npx tsx scripts/report-engagement-audit.ts [--input=<file>] [--out=<dir>]
//                                                  [--demo] [--no-fail]
//
// Input is a JSON array of ManagerObservation (see src/lib/featureAudit.ts) —
// what a league-oriented crawl produces. With --demo it fabricates a population
// instead, so the report renders end-to-end in a sandbox that cannot reach
// Sleeper (these endpoints 403 from the dev sandbox; see fetch-sleeper-adp.py).
//
// Writes  <out>/engagement-audit.json   versioned manifest, diffable run-to-run
//         <out>/engagement-audit.md     human-readable report
//
// Exits non-zero when the audit finds a BLOCKING defect — truncated sweeps, a
// failed invariant, a degenerate label — so a CI run cannot quietly train on
// data that has already invalidated itself. --no-fail downgrades that to a
// warning for local exploration.
//
// PRIVACY: the report contains aggregates only — counts, distributions,
// correlations. No manager ids, league ids, or per-row values are written, so
// the output is safe to upload as a CI artifact. The INPUT is not: keep crawled
// populations out of the repo.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { auditEngagement, ENGAGEMENT_FEATURES, type AuditReport, type ManagerObservation } from '../src/lib/featureAudit';
import { managerSeasonEngagement } from '../src/lib/engagement';
import { retentionEvents, type LeagueSeasonRef } from '../src/lib/leagueLineage';
import type { LeagueSeasonRecord, TxnEvent, LeagueFormatInfo } from '../src/lib/sleeper';

const REPORT_VERSION = 1;

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'] as [string, string];
  }),
);
const INPUT = args.get('input');
const OUT_DIR = args.get('out') ?? 'reports/engagement-audit';
const DEMO = args.get('demo') === 'true';
const NO_FAIL = args.get('no-fail') === 'true';

// ── synthetic population (--demo) ──
//
// Deliberately imperfect: it includes best-ball leagues, a capped sweep, absent
// starters and an unlaunched league, so the report exercises every check rather
// than printing a clean sheet that proves nothing.
function demoPopulation(): ManagerObservation[] {
  const fmt = (over: Partial<LeagueFormatInfo> = {}): LeagueFormatInfo =>
    ({ type: 'Redraft', qb: '1QB', bestBall: false, idp: false, ...over });

  const population: ManagerObservation[] = [];
  for (let m = 0; m < 40; m++) {
    const history: LeagueSeasonRecord[] = [];
    const events: TxnEvent[] = [];
    const nSeasons = 2 + (m % 3);

    for (let s = 0; s < nSeasons; s++) {
      const season = String(2023 + s);
      const leagueId = `L${m}_${s}`;
      const bestBall = m % 9 === 0;
      const dynasty = m % 4 === 0;
      // Every 7th manager-season is a quitter: activity stops early.
      const quits = (m + s) % 7 === 0 && !bestBall;
      const lastWeek = quits ? 3 + (m % 3) : 15 + (s % 2);
      const unlaunched = m === 5 && s === nSeasons - 1;

      history.push({
        season, leagueId, previousLeagueId: s ? `L${m}_${s - 1}` : null,
        leagueName: `League ${m}`, status: unlaunched ? 'pre_draft' : 'complete',
        format: fmt({ type: dynasty ? 'Dynasty' : 'Redraft', bestBall }),
        totalRosters: 10 + (m % 3) * 2, rosterId: 1,
        wins: quits ? 3 : 8, losses: quits ? 11 : 6, ties: 0,
        pointsFor: quits ? 1100 : 1600, regSeasonRank: quits ? 11 : 3,
        champion: !quits && m % 11 === 0, runnerUp: false, players: [],
      });

      if (unlaunched) continue;
      for (let w = 1; w <= lastWeek; w++) {
        if (w > 1 && (w + m) % 3 === 0) continue;   // natural gaps
        const kind = w % 5 === 0 ? 'waiver' : w % 7 === 0 ? 'trade' : 'free_agent';
        events.push({
          leagueId, season, week: w,
          created: Date.UTC(2000 + Number(season) % 100, 8, 1 + w),
          kind, status: w % 11 === 0 ? 'failed' : 'complete',
          adds: [`p${w}`], drops: w % 2 ? [`q${w}`] : [],
          faabBid: kind === 'waiver' ? (w * 3) % 40 : 0,
          partners: kind === 'trade' ? [2] : [],
        });
      }
    }

    // Starters only for some managers, so empty-slot coverage is realistically
    // partial rather than uniformly present.
    const startersByLeague = m % 3 === 0
      ? new Map(history.map((h) => [h.leagueId, ['p1', m % 6 === 0 ? '0' : 'p2', 'p3']]))
      : undefined;

    const rows = managerSeasonEngagement(history, events, { horizonWeek: 17, startersByLeague });
    const refs: LeagueSeasonRef[] = history.map((h) => ({
      leagueId: h.leagueId, previousLeagueId: h.previousLeagueId, season: h.season, name: h.leagueName,
    }));
    population.push({
      managerId: `demo-${m}`,
      rows,
      history,
      events,
      // A couple of managers with deep histories hit the sweep cap.
      sweep: { capped: m % 19 === 0, weeksScanned: Math.min(700, history.length * 18) },
      retention: retentionEvents(refs),
    });
  }
  return population;
}

// ── rendering ──

const pct = (x: number | null | undefined, digits = 1) =>
  x == null || !Number.isFinite(x) ? 'n/a' : `${(x * 100).toFixed(digits)}%`;
const num = (x: number | null | undefined, digits = 2) =>
  x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(digits);

function renderMarkdown(report: AuditReport, meta: { generatedAt: string; source: string; synthetic: boolean; horizons: boolean }): string {
  const c = report.completeness;
  const L: string[] = [];

  L.push('# Engagement pipeline — data completeness & feature audit', '');
  L.push(`Generated ${meta.generatedAt} · source: \`${meta.source}\` · report v${REPORT_VERSION}`, '');
  if (!meta.synthetic && !meta.horizons) {
    L.push('> ⚠️ No crawl manifest found next to the input, so per-season horizons are');
    L.push('> unknown and an in-progress season cannot be distinguished from a completed');
    L.push('> one. Expect inflated drift figures.', '');
  }

  if (meta.synthetic) {
    L.push('> ⚠️ **Synthetic population.** These numbers describe fabricated data and say');
    L.push('> nothing about real manager behavior. They verify the audit runs end-to-end;');
    L.push('> real figures require a crawled population (`--input`).', '');
  }

  L.push(report.blocking.length ? '## ❌ Blocking' : '## ✅ No blocking defects', '');
  if (report.blocking.length) {
    L.push('Training on this population would produce misleading results.', '');
    for (const b of report.blocking) L.push(`- ${b}`);
    L.push('');
  }

  L.push('## Completeness', '');
  L.push('| Check | Value | Reading |', '| --- | --- | --- |');
  L.push(`| Managers | ${c.managers} | |`);
  L.push(`| Manager-seasons | ${c.managerSeasons} | rows available to the audit |`);
  L.push(`| Distinct lineages | ${c.lineages} | leagues after collapsing per-season ids |`);
  L.push(`| Seasons | ${c.seasons.join(', ') || 'none'} | |`);
  L.push(`| Sweep truncated | ${c.managersWithCappedSweep} (${pct(c.cappedSweepShare)}) | oldest seasons missing transactions — reads as inactive |`);
  L.push(`| Zero-transaction rows | ${c.zeroTxnRows} | ${c.zeroTxnUnlaunched} unlaunched, ${c.zeroTxnBestBall} best ball, ${c.zeroTxnInProgress} season not started — all expected |`);
  L.push(`| ↳ unexplained | ${c.zeroTxnUnexplained} | live, managed, completed season, no activity at all |`);
  L.push(`| Rows with no roster id | ${c.missingRosterIdRows} | manager absent from the league's rosters |`);
  L.push(`| Transactions with no timestamp | ${pct(c.missingTimestampShare)} | breaks weekday / attention-shape features |`);
  L.push(`| Empty-slot coverage | ${pct(c.startersCoverage, 0)} | share of non-best-ball rows with starters supplied |`);
  L.push(`| Portfolio known | ${pct(c.portfolioKnownShare, 0)} | profile-level features are biased for the rest |`);
  L.push(`| Portfolio crawled | ${pct(c.meanPortfolioCoverage, 0)} | of known league-seasons, among managers with a known portfolio |`);
  L.push(`| Best-ball share | ${pct(c.bestBallShare)} | excluded from the abandonment label |`);
  L.push(`| Retention rows censored | ${pct(c.retentionCensoredShare)} | newest season is unlabelable by construction |`);
  L.push(`| Lineage season gaps | ${c.lineageSeasonGaps} | manager sat a year out; not a new league |`);
  L.push('');

  L.push('### Population shape by season', '');
  L.push('A crawl that samples structurally different leagues per season shows');
  L.push('apparent drift on every activity feature at once. That is the sample, not');
  L.push('the features — so it is reported here rather than in the feature table.', '');
  L.push('| Season | Rows | League-seasons | Best ball | Horizon | |', '| --- | --- | --- | --- | --- | --- |');
  for (const s of c.seasonComposition) {
    L.push(`| ${s.season} | ${s.rows} | ${s.leagueSeasons} | ${pct(s.bestBallShare, 0)} | ${s.horizonWeeks ?? 'n/a'} | ${s.inProgress ? 'in progress — excluded from stability' : ''} |`);
  }
  L.push('');

  if (c.requiredFieldViolations.length) {
    L.push('### Required-field violations', '');
    for (const v of c.requiredFieldViolations) L.push(`- \`${v.field}\` null on ${v.rows} row(s)`);
    L.push('');
  }

  L.push('## Label', '');
  L.push(`\`${report.label.name}\` — ${report.label.positives}/${report.label.scorableRows} positives (${pct(report.label.baseRate)}).`);
  L.push('');
  L.push('Scorable rows exclude best ball (no in-season management expected) and');
  L.push('seasons with no activity at all (a league that never launched, not a quitter).');
  L.push('');

  L.push('## Feature eligibility', '');
  L.push('Eligibility is derived from each feature\'s declared kind, not from a reviewer');
  L.push('remembering which columns are safe. `conditional` means the value shown here is');
  L.push('a season total and must be recomputed as-of the scored week before use.', '');
  L.push('| Feature | Kind | Eligible | Coverage | Signal AUC | Direction | Stability |', '| --- | --- | --- | --- | --- | --- | --- |');
  const mark = { eligible: '✅', conditional: '⚠️', ineligible: '⛔' } as const;
  for (const f of report.features) {
    const dir = f.directionOk === null ? f.direction : f.directionOk ? `${f.direction} ✓` : `${f.direction} ✗`;
    L.push(`| \`${f.name}\` | ${f.kind} | ${mark[f.eligibility]} ${f.eligibility} | ${pct(f.summary.coverage, 0)} | ${num(f.signalAuc, 3)} | ${dir} | ${f.stability} |`);
  }
  L.push('');

  const ineligible = report.features.filter((f) => f.eligibility === 'ineligible');
  if (ineligible.length) {
    L.push('### Why features are excluded', '');
    for (const kind of ['label-derived', 'season-final'] as const) {
      const group = ineligible.filter((f) => f.kind === kind);
      if (!group.length) continue;
      L.push(`**${kind}** — ${group[0].eligibilityReason}`, '');
      for (const f of group) L.push(`- \`${f.name}\` (signal AUC ${num(f.signalAuc, 3)})`);
      L.push('');
    }
    L.push('High AUC on these columns is the tell, not the prize: they encode the answer.', '');
  }

  const degenerate = report.features.filter((f) => f.degenerate);
  if (degenerate.length) {
    L.push('### Degenerate features', '');
    for (const f of degenerate) L.push(`- \`${f.name}\` — ${f.degenerateReason}`);
    L.push('');
  }

  const ml = report.managerLevel;
  L.push('## Manager-level features', '');
  L.push('A separate surface from the rows above, with its own label — did this manager');
  L.push('go dark in ANY scorable season — and its own failure mode. These describe a');
  L.push('person across their whole portfolio, so the risk is not leakage from one');
  L.push('season\'s outcome but being computed on a small sample of the portfolio they');
  L.push('claim to summarise.', '');
  L.push(`Label: **${ml.positives}/${ml.labelled}** managers (${pct(ml.baseRate)}), of ${ml.managers} in the population.`, '');
  L.push(`Portfolio enumerated for **${ml.portfolioEnumerated}/${ml.managers}** managers` +
    (ml.meanPortfolioSampled !== null ? `; of those portfolios, **${pct(ml.meanPortfolioSampled)}** was actually swept.` : '.'), '');
  L.push('`portfolio` means the axis is computed from the manager\'s enumerated league');
  L.push('list and is exact. `crawled` means it comes from the swept slice only —');
  L.push('intensity and sociality can never be anything else, because they need');
  L.push('transactions. `mixed` means the population contains both, which should not be');
  L.push('pooled.', '');
  L.push('| Feature | Axis | Eligible | Source | Coverage | Signal AUC | Direction |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const f of ml.features) {
    const dir = f.directionOk === null ? f.direction : f.directionOk ? `${f.direction} ✓` : `${f.direction} ✗`;
    L.push(`| \`${f.name}\` | ${f.axis} | ${mark[f.eligibility]} ${f.eligibility} | ${f.source} | ${pct(f.summary.coverage, 0)} | ${num(f.signalAuc, 3)} | ${dir} |`);
  }
  L.push('');

  const mlIneligible = ml.features.filter((f) => f.eligibility === 'ineligible');
  if (mlIneligible.length) {
    L.push('Excluded: ' + mlIneligible.map((f) => `\`${f.name}\` (${f.eligibilityReason.replace(/\.$/, '')})`).join('; ') + '.', '');
  }
  if (ml.warnings.length) {
    for (const w of ml.warnings) L.push(`- ${w}`);
    L.push('');
  }

  L.push('## Collinearity', '');
  if (report.collinearPairs.length) {
    L.push('Pairs at |r| ≥ 0.9 among model-usable features — the same column twice.', '');
    L.push('| A | B | r |', '| --- | --- | --- |');
    for (const p of report.collinearPairs) L.push(`| \`${p.a}\` | \`${p.b}\` | ${num(p.r, 3)} |`);
  } else {
    L.push('No model-usable pair reaches |r| ≥ 0.9.');
  }
  L.push('');

  L.push('## Invariants', '');
  L.push('| Check | Result | Rows |', '| --- | --- | --- |');
  for (const i of report.invariants) {
    L.push(`| ${i.name} | ${i.passed ? '✅ pass' : '❌ FAIL'} | ${i.violations} |`);
  }
  L.push('');
  const failed = report.invariants.filter((i) => !i.passed);
  if (failed.length) {
    for (const i of failed) L.push(`- **${i.name}** — ${i.detail}`);
    L.push('');
  }

  if (c.warnings.length) {
    L.push('## Warnings', '');
    for (const w of c.warnings) L.push(`- ${w}`);
    L.push('');
  }

  L.push('---', '');
  L.push(`Feature specs: \`src/lib/featureAudit.ts\` (${ENGAGEMENT_FEATURES.length} declared). Audit logic is covered by \`npm run test:engagement:mlops\`.`);
  return L.join('\n');
}

// ── main ──

function loadInput(path: string): ManagerObservation[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${path}: expected a JSON array of ManagerObservation`);
  // Rows come back as plain JSON; nothing in the audit needs class instances,
  // but activeWeeks must exist or the invariant checks throw rather than fail.
  for (const m of parsed) {
    for (const r of m.rows ?? []) if (!Array.isArray(r.activeWeeks)) r.activeWeeks = [];
  }
  return parsed as ManagerObservation[];
}

// The crawler writes <out>-manifest.json alongside its population, carrying the
// derived per-season horizon. Without it the audit cannot tell an in-progress
// season from a completed one, and reports drift on everything.
function loadHorizons(inputPath: string): Record<string, number> | undefined {
  const manifest = `${inputPath.replace(/\.json$/, '')}-manifest.json`;
  if (!existsSync(manifest)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    return parsed?.horizonBySeason ?? undefined;
  } catch { return undefined; }
}

function main() {
  let population: ManagerObservation[];
  let source: string;
  let synthetic = false;
  let horizonBySeason: Record<string, number> | undefined;

  if (INPUT) {
    population = loadInput(INPUT);
    source = INPUT;
    horizonBySeason = loadHorizons(INPUT);
  } else if (DEMO) {
    population = demoPopulation();
    source = 'synthetic (--demo)';
    synthetic = true;
  } else {
    console.error('No input. Pass --input=<crawled population.json>, or --demo to render the report on synthetic data.');
    process.exit(2);
    return;
  }

  const report = auditEngagement(population, undefined, { horizonBySeason });
  const generatedAt = new Date().toISOString();
  const meta = { generatedAt, source, synthetic, horizons: !!horizonBySeason };

  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = `${OUT_DIR}/engagement-audit.json`;
  const mdPath = `${OUT_DIR}/engagement-audit.md`;
  writeFileSync(jsonPath, `${JSON.stringify({ reportVersion: REPORT_VERSION, ...meta, ...report }, null, 2)}\n`);
  writeFileSync(mdPath, `${renderMarkdown(report, meta)}\n`);

  const c = report.completeness;
  console.log(`\nEngagement audit — ${c.managers} managers, ${c.managerSeasons} manager-seasons, ${c.lineages} lineages`);
  console.log(`  label: ${report.label.positives}/${report.label.scorableRows} positive (${pct(report.label.baseRate)})`);
  console.log(`  features: ${report.features.filter((f) => f.eligibility === 'eligible').length} eligible, ` +
    `${report.features.filter((f) => f.eligibility === 'conditional').length} conditional, ` +
    `${report.features.filter((f) => f.eligibility === 'ineligible').length} ineligible`);
  console.log(`  manager-level: ${report.managerLevel.positives}/${report.managerLevel.labelled} labelled positive, ` +
    `${report.managerLevel.portfolioEnumerated}/${report.managerLevel.managers} portfolios enumerated`);
  console.log(`  invariants: ${report.invariants.filter((i) => i.passed).length}/${report.invariants.length} passing`);
  console.log(`  warnings: ${c.warnings.length}   blocking: ${report.blocking.length}`);
  console.log(`\n  → ${jsonPath}\n  → ${mdPath}\n`);

  if (synthetic) console.log('  (synthetic population — verifies the audit runs, says nothing about real behavior)\n');

  if (report.blocking.length) {
    for (const b of report.blocking) console.log(`  BLOCKING: ${b}`);
    console.log('');
    if (!NO_FAIL) process.exit(1);
  }
}

main();
