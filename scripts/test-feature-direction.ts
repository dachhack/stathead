// Test script: feature directionality on the prospect cards.
// Run: npx tsx scripts/test-feature-direction.ts
//
// A bar on a prospect card must be long and green when the stat is GOOD for
// the player. That takes two halves that must agree:
//   1. the score store keeps RAW percentiles (higher percentile = higher raw
//      value, no inversion anywhere in precompute-features), and
//   2. src/lib/prospectScores.ts LOWER_IS_BETTER names every feature where a
//      smaller raw value is the good one, so goodnessPctl() flips exactly those.
// This checks the list against the feature registry, the store against the
// raw-percentile contract, and both against the career model's own
// coefficient signs.

import { readFileSync, existsSync } from 'fs';
import { LOWER_IS_BETTER, goodnessPctl, isMissing, HIDE_FROM_BARS } from '../src/lib/prospectScores';
import { FEATURES } from '../src/lib/featureTypes';

let passed = 0;
const failures: string[] = [];
const warnings: string[] = [];
const check = (name: string, cond: boolean, detail?: string) => { if (cond) passed++; else failures.push(name + (detail ? ` — ${detail}` : '')); };

// ── The list itself ────────────────────────────────────────────────────────
const registry = new Set(FEATURES.map((f) => f.key));
const unknown = [...LOWER_IS_BETTER].filter((k) => !registry.has(k) && !['adp', 'adpRound'].includes(k));
check('every LOWER_IS_BETTER key is a registered feature', unknown.length === 0, unknown.join(', '));

const mustBeLower = ['nflDraftPick', 'nflDraftRound', 'logDraftPick', 'draftPickPct', 'draftPickPctOverall', 'age', 'forty', 'cone', 'shuttle', 'collegeBreakoutAge', 'pdfNWeaknesses', 'pdfNRedFlags', 'pdfRankOverallMean', 'pdfProjectedRound', 'teamSamePosCount'];
for (const k of mustBeLower) check(`${k} is lower-is-better`, LOWER_IS_BETTER.has(k));
const mustBeHigher = ['weight', 'bench', 'vertical', 'broadJump', 'relativeAthleticScore', 'speedScore', 'collegeDominatorRating', 'collegeBreakoutScore', 'collegeBestRecYds', 'collegeBestRushYds', 'recruitStars', 'recruitRating', 'pdfNStrengths', 'pdfSentimentNet', 'rspNComps', 'collegeTeamTalent', 'collegeUsageOverall', 'collegeQBR2yr', 'predictedPPG', 'invDraftPick'];
for (const k of mustBeHigher) check(`${k} is higher-is-better`, !LOWER_IS_BETTER.has(k));
check('goodnessPctl flips only lower-is-better keys', goodnessPctl('logDraftPick', 76) === 24 && goodnessPctl('weight', 9) === 9 && goodnessPctl('age', 70) === 30);
check('flags and class constants are hidden from bars', ['hasCombineData', 'pdfHasRank', 'rspHasData', 'draftClassDepth'].every((k) => HIDE_FROM_BARS.test(k)) && !HIDE_FROM_BARS.test('pdfNStrengths'));
check('guide counts are missing without a guide profile', isMissing('pdfNRedFlags', 0, { pdfHasData: 0 }) && !isMissing('pdfNRedFlags', 0, { pdfHasData: 1 }));
check('scout comps are missing without scout data', isMissing('rspNComps', 0, { rspHasData: 0 }) && !isMissing('rspNComps', 2, { rspHasData: 1 }));

// ── The store: raw percentiles, no inversion ───────────────────────────────
const storePath = 'public/data/score-store/career.json';
if (existsSync(storePath)) {
  const d = JSON.parse(readFileSync(storePath, 'utf-8'));
  const rows: Array<{ position: string; draftSeason: number; features?: Record<string, number>; featurePercentiles?: Record<string, number> }> =
    Array.isArray(d) ? d : d.players ?? d.rows ?? [];
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const cls = rows.filter((r) => r.position === pos && r.draftSeason === 2026 && r.featurePercentiles && r.features);
    if (cls.length < 5) continue;
    // Spearman-style sanity: the raw percentile of a lower-is-better feature
    // must RISE with the raw value (a later pick → a higher raw percentile).
    for (const key of ['nflDraftPick', 'logDraftPick', 'age']) {
      const pts = cls.map((r) => [r.features![key], r.featurePercentiles![key]] as [number, number]).filter(([v, p]) => Number.isFinite(v) && Number.isFinite(p));
      if (pts.length < 5) continue;
      let agree = 0, total = 0;
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
        if (pts[i][0] === pts[j][0]) continue;
        total++;
        if ((pts[i][0] - pts[j][0]) * (pts[i][1] - pts[j][1]) > 0) agree++;
      }
      check(`${pos} ${key}: store percentile rises with the raw value (raw, not inverted)`, total > 0 && agree / total > 0.95, `${agree}/${total} concordant pairs`);
    }
  }
  // A late pick must render as a short bar.
  const late = rows.filter((r) => r.draftSeason === 2026 && (r.features?.nflDraftPick ?? 0) >= 150 && r.featurePercentiles?.logDraftPick != null);
  check('late picks render as bad draft capital', late.length > 0 && late.every((r) => goodnessPctl('logDraftPick', r.featurePercentiles!.logDraftPick) <= 50),
    late.slice(0, 3).map((r) => `${r.features!.nflDraftPick}→${goodnessPctl('logDraftPick', r.featurePercentiles!.logDraftPick)}`).join(', '));
} else {
  warnings.push('score store not found — skipped the raw-percentile checks');
}

// ── The model's own directions ─────────────────────────────────────────────
// The card shows the INTUITIVE direction (an early pick is good). The career
// model's coefficient signs should agree wherever the weight is meaningful;
// where they don't, that is worth knowing but is not a card bug (ridge signs
// on collinear inputs can flip), so it warns rather than fails.
const fmPath = 'public/data/feature-matrix.json';
if (existsSync(fmPath)) {
  const fm = JSON.parse(readFileSync(fmPath, 'utf-8'));
  const models = fm.rookieCareerModels ?? {};
  for (const pos of Object.keys(models)) {
    for (const f of models[pos].featureImportance ?? []) {
      if (!f.direction || (f.importance ?? 0) < 0.05 || HIDE_FROM_BARS.test(f.key)) continue;
      const modelSaysLower = f.direction === 'negative';
      const cardSaysLower = LOWER_IS_BETTER.has(f.key);
      if (modelSaysLower !== cardSaysLower) warnings.push(`${pos} ${f.key}: model direction ${f.direction} (importance ${f.importance.toFixed(2)}) vs card ${cardSaysLower ? 'lower' : 'higher'}-is-better`);
      else passed++;
    }
  }
}

console.log(`\nFeature direction: ${passed} passed, ${failures.length} failed, ${warnings.length} warnings`);
for (const w of warnings) console.log('  WARN:', w);
for (const f of failures) console.log('  FAIL:', f);
process.exit(failures.length ? 1 : 0);
