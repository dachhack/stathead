// Test script: the relationship-shape classifier behind the model docs.
// Run: node scripts/test-relationship-shape.mjs
//
// This decides what the docs SAY about every driver of every model, so a wrong
// call here is a confidently-worded false statement on a public page. Known
// answers are built from constructed relationships where the truth is not in
// doubt.
import { pearson, spearman, shapeOf, shapeText, SHAPE_MIN_COHORT } from './lib/relationship-shape.mjs';

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed++; return; }
  failures.push(`${name}${detail === undefined ? '' : ` — got ${JSON.stringify(detail)}`}`);
};
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), a);

const N = 200;
const xs = Array.from({ length: N }, (_, i) => i / (N - 1));   // 0..1

// ── monotone ──
eq('a straight rise is increasing', shapeOf(xs, xs.map((x) => x)).shape, 'increasing');
eq('a straight fall is decreasing', shapeOf(xs, xs.map((x) => -x)).shape, 'decreasing');
// Monotone but strongly curved: Pearson understates it, Spearman does not.
eq('a monotone curve is still increasing', shapeOf(xs, xs.map((x) => x ** 4)).shape, 'increasing');

// ── genuine turning points ──
eq('a real hump is inverted-u', shapeOf(xs, xs.map((x) => -((x - 0.5) ** 2))).shape, 'inverted-u');
eq('a real bowl is u-shaped', shapeOf(xs, xs.map((x) => (x - 0.5) ** 2)).shape, 'u-shaped');

/**
 * Build a cohort whose five quintile means are exactly `means`, so the
 * classifier's inputs are controlled rather than hoped for. The earlier version
 * of these tests shaped a curve and assumed where the peak would land; the peak
 * stayed in the last bin, so the interior-extreme rule was never exercised and
 * a mutation reinstating the original bug passed clean.
 */
function cohortWithBinMeans(means, perBin = 40) {
  const v = [], t = [];
  means.forEach((m, b) => {
    for (let i = 0; i < perBin; i++) {
      v.push(b + i / perBin);      // strictly increasing across and within bins
      t.push(m);
    }
  });
  return [v, t];
}

// ── the bug that shipped a false statement ──
// A dominant rise whose last bin gives back a sliver. The peak IS an interior
// bin, so the old "any interior extreme is a hump" rule fired and documented a
// driver with rank correlation +0.58 as "best in the middle: too little or too
// much both project worse". The give-back here is 5% of the spread.
{
  const [v, t] = cohortWithBinMeans([0, 0.25, 0.5, 1.0, 0.95]);
  const s = shapeOf(v, t);
  check('the peak really is an interior bin (fixture is valid)',
    s.bins.map((b) => b.meanTarget).indexOf(Math.max(...s.bins.map((b) => b.meanTarget))) === 3,
    s.bins.map((b) => b.meanTarget));
  check('a 5% give-back is NOT called a hump', s.shape !== 'inverted-u', s.shape);
  check('it reads as rising instead', /increasing/.test(s.shape), s.shape);

  // And a real hump with the same peak position IS caught, so the guard is a
  // threshold and not a blanket refusal.
  const [v2, t2] = cohortWithBinMeans([0, 0.5, 0.8, 1.0, 0.2]);
  eq('a 80% give-back is a hump', shapeOf(v2, t2).shape, 'inverted-u');
}

// ── the rank correlation has to be a RANK correlation ──
// One out-of-order middle bin on a heavily curved rise. Spearman sees the order
// and calls it mostly-increasing; Pearson is dragged down by the curvature and
// would fall under the 0.15 gate, reporting "no consistent direction" for a
// driver that plainly has one.
{
  const [v, t] = cohortWithBinMeans([0, 0.25, 0.2, 0.6, 1.0]);
  const s = shapeOf(v, t);
  check('a rise with one inverted middle bin is mostly-increasing', s.shape === 'mostly-increasing', s.shape);

  // Pin the STATISTIC, not just the verdict. A heavy-tailed feature is exactly
  // where the two diverge: rank correlation is unmoved while Pearson is
  // diluted by the outliers. Asserting the returned rho equals spearman
  // catches a swap to pearson directly, which a classification check does not
  // reliably do — the earlier attempt at this test passed under the mutation.
  const heavy = v.map((x) => Math.exp(x * 2));
  const sh = shapeOf(heavy, t);
  check('the reported rho IS the rank correlation',
    Math.abs((sh.rho ?? 0) - spearman(heavy, t)) < 1e-9,
    { reported: sh.rho, spearman: spearman(heavy, t), pearson: pearson(heavy, t) });
  check('and on this fixture rank and linear correlation genuinely differ',
    Math.abs(spearman(heavy, t) - pearson(heavy, t)) > 0.05,
    { rho: spearman(heavy, t), r: pearson(heavy, t) });
}

// ── flat and noise ──
eq('a constant target is flat', shapeOf(xs, xs.map(() => 5)).shape, 'flat');
{
  // Deterministic pseudo-noise, so the test cannot flake.
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const s = shapeOf(xs, xs.map(() => rnd()));
  check('pure noise is not called a direction',
    ['flat', 'non-monotone'].includes(s.shape), s.shape);
}

// ── cohort guards, which must stay distinguishable ──
eq('an empty cohort is not-in-cohort', shapeOf([], []).shape, 'not-in-cohort');
eq('a cohort under the minimum says so',
  shapeOf(xs.slice(0, SHAPE_MIN_COHORT - 1), xs.slice(0, SHAPE_MIN_COHORT - 1)).shape, 'cohort-too-small');
check('the minimum is at least 25 so a quintile is not 4 players', SHAPE_MIN_COHORT >= 25, SHAPE_MIN_COHORT);
check('the two gaps get different sentences',
  shapeText('not-in-cohort', 'x') !== shapeText('cohort-too-small', 'x'));

// ── evidence is returned with the verdict ──
{
  const s = shapeOf(xs, xs.map((x) => x));
  eq('five quintile means are returned', s.bins.length, 5);
  check('and they are ordered for a rising relationship',
    s.bins.every((b, i, a) => i === 0 || b.meanTarget > a[i - 1].meanTarget));
  check('every bin reports its size', s.bins.every((b) => b.n > 0));
}

// ── spearman itself ──
check('spearman is 1 for any monotone rise', Math.abs(spearman(xs, xs.map((x) => x ** 7)) - 1) < 1e-9);
check('spearman is -1 for a monotone fall', Math.abs(spearman(xs, xs.map((x) => -x)) + 1) < 1e-9);
check('spearman handles ties without blowing up',
  Number.isFinite(spearman([1, 1, 1, 2, 2, 3], [1, 2, 3, 4, 5, 6])));

// ── every shape has a sentence, and none is a placeholder ──
for (const sh of ['increasing', 'decreasing', 'mostly-increasing', 'mostly-decreasing',
  'inverted-u', 'u-shaped', 'non-monotone', 'flat', 'not-in-cohort', 'cohort-too-small']) {
  const t = shapeText(sh, 'age');
  check(`${sh} has a real sentence`, t.length > 25 && !/not characterised/.test(t), t);
}

console.log(`\n${passed} checks passed, ${failures.length} failed\n`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
console.log('✓ relationship-shape classification behaves as specified');
