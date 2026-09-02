// The measured SHAPE of a feature's relationship to a model's output.
//
// Extracted from build-model-eval.mjs so it can be tested against known
// answers. The classifier decides what a model doc SAYS about every driver, and
// two of its rules were wrong on first contact with real data:
//
//   - Any interior extreme was called a U or a hump, so Vegas implied win %
//     (rank correlation +0.58) was reported as "best in the middle" on a
//     fractional wobble. A reversal now has to be a real share of the spread.
//   - "Insufficient data" conflated a feature absent from the cohort with a
//     cohort too small to bin. Those need different sentences.
//
// Both are pinned by tests in scripts/test-relationship-shape.mjs.

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { const x = xs[i], y = ys[i]; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
  const cov = sxy - sx * sy / n;
  const vx = sxx - sx * sx / n, vy = syy - sy * sy / n;
  if (vx <= 0 || vy <= 0) return 0;
  return cov / Math.sqrt(vx * vy);
}
/** Spearman: rank correlation, so a monotone-but-curved relationship still reads. */
function spearman(xs, ys) {
  const rank = (a) => {
    const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(a.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;            // average rank over ties
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  return pearson(rank(xs), rank(ys));
}

/**
 * The SHAPE of a feature's relationship to the target, not just its sign.
 *
 * A Pearson correlation alone cannot tell "no relationship" from "strong but
 * non-monotone", and both were previously reported as "mixed / weak" — which is
 * the single most misleading thing a model doc can say. Age and ADP-interaction
 * features are routinely U-shaped or inverted-U.
 *
 * Method: bin the cohort into quintiles by feature value, take the mean target
 * in each bin, and read the sequence of steps. Quintiles rather than deciles
 * because these cohorts run a few hundred players, and a decile of 20 is noise.
 */
const SHAPE_MIN_COHORT = 25;
function shapeOf(vals, targets) {
  const n = vals.length;
  if (n === 0) return { shape: 'not-in-cohort', bins: [] };
  if (n < SHAPE_MIN_COHORT) return { shape: 'cohort-too-small', bins: [] };
  const pairs = vals.map((v, i) => [v, targets[i]]).sort((a, b) => a[0] - b[0]);
  const BINS = 5;
  const bins = [];
  for (let b = 0; b < BINS; b++) {
    const lo = Math.floor((b * n) / BINS), hi = Math.floor(((b + 1) * n) / BINS);
    const slice = pairs.slice(lo, hi);
    if (!slice.length) return { shape: 'insufficient-data', bins: [] };
    bins.push({
      meanFeature: slice.reduce((s, x) => s + x[0], 0) / slice.length,
      meanTarget: slice.reduce((s, x) => s + x[1], 0) / slice.length,
      n: slice.length,
    });
  }
  const ys = bins.map((b) => b.meanTarget);
  const spread = Math.max(...ys) - Math.min(...ys);
  // Scale the "flat" test against the target's own spread across the cohort,
  // so a feature is called flat on the target's terms rather than an absolute.
  const tSorted = [...targets].sort((a, b) => a - b);
  const iqr = tSorted[Math.floor(n * 0.75)] - tSorted[Math.floor(n * 0.25)];
  // Degenerate cases first. A target with no variation at all, or bin means
  // that never move, is flat by definition — gating only on `iqr > 0` let a
  // constant target fall through every later rule and come out
  // "non-monotone", which is the opposite of what it is.
  if (spread === 0 || iqr === 0) return { shape: 'flat', bins };
  if (spread < iqr * 0.25) return { shape: 'flat', bins };

  const rho = spearman(vals, targets);
  const steps = ys.slice(1).map((y, i) => Math.sign(y - ys[i]));
  if (steps.every((d) => d > 0)) return { shape: 'increasing', bins, rho };
  if (steps.every((d) => d < 0)) return { shape: 'decreasing', bins, rho };

  // A turning point only counts as a U or a hump when the REVERSAL IS
  // MATERIAL. Taking any interior extreme labelled Vegas implied win % as
  // "best in the middle" on a fractional wobble, while its rank correlation
  // was +0.58 — a monotone driver described as non-monotone, which is the
  // worst kind of wrong for a model doc. Require the move back from the
  // extreme to be a real share of the spread before naming a shape.
  const REVERSAL = 0.25;
  const argmax = ys.indexOf(Math.max(...ys)), argmin = ys.indexOf(Math.min(...ys));
  if (argmax > 0 && argmax < BINS - 1) {
    const fallAfter = ys[argmax] - Math.min(...ys.slice(argmax + 1));
    const riseBefore = ys[argmax] - Math.min(...ys.slice(0, argmax));
    if (Math.min(fallAfter, riseBefore) >= spread * REVERSAL) {
      return { shape: 'inverted-u', bins, rho, peakBin: argmax };
    }
  }
  if (argmin > 0 && argmin < BINS - 1) {
    const riseAfter = Math.max(...ys.slice(argmin + 1)) - ys[argmin];
    const fallBefore = Math.max(...ys.slice(0, argmin)) - ys[argmin];
    if (Math.min(riseAfter, fallBefore) >= spread * REVERSAL) {
      return { shape: 'u-shaped', bins, rho, troughBin: argmin };
    }
  }
  if (Math.abs(rho) > 0.15) return { shape: rho > 0 ? 'mostly-increasing' : 'mostly-decreasing', bins, rho };
  return { shape: 'non-monotone', bins, rho };
}

/** One sentence a reader can act on, from the measured shape. */
function shapeText(shape, label) {
  const L = label || 'this input';
  switch (shape) {
    case 'increasing': return `More ${L} means a stronger projection, all the way up.`;
    case 'decreasing': return `More ${L} means a weaker projection, all the way down.`;
    case 'mostly-increasing': return `Generally more ${L} is better, with the middle bins out of order.`;
    case 'mostly-decreasing': return `Generally more ${L} is worse, with the middle bins out of order.`;
    case 'inverted-u': return `Best in the middle: too little or too much ${L} both project worse.`;
    case 'u-shaped': return `Worst in the middle: the extremes of ${L} both project better.`;
    case 'non-monotone': return `No consistent direction — the model uses ${L} in combination, not on its own.`;
    case 'flat': return `Little effect on its own once the cohort is binned by ${L}.`;
    case 'not-in-cohort': return `Not populated for the players this model scores, so its shape cannot be read here.`;
    case 'cohort-too-small': return `The importance is fitted, but this year's cohort is too small to bin — the shape needs the historical training cohort.`;
    default: return `Shape not characterised.`;
  }
}

export { pearson, spearman, shapeOf, shapeText, SHAPE_MIN_COHORT };
