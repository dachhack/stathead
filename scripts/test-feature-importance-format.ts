// Test script: the model-docs feature tooltip.
// Run: npx tsx scripts/test-feature-importance-format.ts
//
// The tooltip exists so "+1 SD" has a size. Two failure modes matter: showing
// a half-built stats block as if it were complete, and rendering an empty box
// for a row that knows nothing.
import { statsTooltip, num } from '../src/lib/featureImportanceFormat';
import type { ImportanceRow } from '../src/components/FeatureImportancePanel';

let passed = 0;
const failures: string[] = [];
const check = (n: string, c: boolean, d?: unknown) => {
  if (c) { passed++; return; }
  failures.push(`${n}${d === undefined ? '' : ` — got ${JSON.stringify(d)}`}`);
};
const eq = (n: string, a: unknown, b: unknown) => check(n, JSON.stringify(a) === JSON.stringify(b), a);

const base: ImportanceRow = { label: 'ADP Round', importance: 1, shape: 'decreasing', shapeText: 'x' };

// ── num ──
eq('num keeps integers plain', num(15), '15');
eq('num gives two decimals above 1', num(15.981), '15.98');
eq('num keeps precision below 1', num(0.20512), '0.205');
eq('num handles non-finite', num(NaN), '—');

// ── nothing known → no tooltip, not an empty box ──
eq('a bare row produces no tooltip', statsTooltip(base), '');
check('an empty string is falsy so the caller can skip the attribute', !statsTooltip(base));

// ── full stats ──
{
  const t = statsTooltip({ ...base, stats: { min: 3, q1: 9, median: 15, q3: 20, max: 33, mean: 15.98, sd: 8.71, n: 44 }, cohort: 44 });
  check('quartiles are shown', /min 3 · Q1 9 · median 15 · Q3 20 · max 33/.test(t), t);
  check('IQR is computed, not restated', /IQR\s+11/.test(t), t);
  check('the SD is turned into a concrete move', /\+1 SD means going from 15.98 to 24.69\./.test(t), t);
  check('the cohort is reported once, not twice',
    (t.match(/44/g) ?? []).length === 1, t);
}

// ── partial stats must not fake a complete block ──
{
  const t = statsTooltip({ ...base, stats: { mean: 0.252, sd: 0.205 } });
  check('no quartile line when quartiles are absent', !/Quartiles/.test(t), t);
  check('mean and SD still shown', /Mean ± SD\s+0.252 ± 0.205/.test(t), t);
  const partial = statsTooltip({ ...base, stats: { min: 1, q1: 2 } });
  check('a half-filled quartile set is not rendered as quartiles', !/Quartiles/.test(partial), partial);
}

// ── odds ratio, the actionable form for a logistic model ──
{
  const up = statsTooltip({ ...base, stats: { oddsRatioPerSd: 1.392 } });
  check('an odds ratio above 1 reads as an increase', /Odds ×1\.392 per \+1 SD \(\+39\.2%\)\./.test(up), up);
  const down = statsTooltip({ ...base, stats: { oddsRatioPerSd: 0.804 } });
  check('and below 1 as a decrease', /\(-19\.6%\)/.test(down), down);
}

// ── a zero SD must not claim a move ──
{
  const t = statsTooltip({ ...base, stats: { mean: 7, sd: 0 } });
  check('a constant feature states its mean', /Mean ± SD\s+7 ± 0/.test(t), t);
  check('but claims no +1 SD move', !/\+1 SD means going/.test(t), t);
}

// ── correlations are labelled by which is which ──
{
  const both = statsTooltip({ ...base, direction: -0.826, rankCorrelation: -0.89 });
  check('r and rho are both named', /r -0\.826 \(linear\), rho -0\.890 \(rank\)\./.test(both), both);
  const coefOnly = statsTooltip({ ...base, direction: 0.331 });
  check('with no rank correlation it is called a coefficient',
    /Coefficient 0\.331 on the standardised feature\./.test(coefOnly), coefOnly);
}

console.log(`\n${passed} checks passed, ${failures.length} failed\n`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
console.log('✓ feature tooltip formatting behaves as specified');
