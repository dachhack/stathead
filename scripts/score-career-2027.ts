/**
 * Score the 2027 draft class with the pre-draft rookie career model.
 *
 * Reads public/data/career-2027.json (consensus board + career college
 * stats + recruiting, built by build-career-2027.py), constructs the same
 * PRE_DRAFT_ROOKIE_FEATURES vectors the 2026 class was scored with, runs
 * the shipped rookieCareerModels from feature-matrix.json through the
 * real inference code (predictRookieCareerPPG / bootstrapThresholdProb),
 * and writes a `model` block back onto each row: predicted career PPG,
 * per-threshold hit probabilities, percentile vs the 2009-2025 backtest,
 * and the Alpha→Longshot model tier.
 *
 *   npx tsx scripts/score-career-2027.ts
 *
 * Pre-pre-draft caveats (all mirrored from how the 2026 class handled
 * missing data, so scores stay comparable):
 *  - No combine: RAS + weight impute to the 2026 same-position median,
 *    exactly the treatment 2026 prospects without workouts received.
 *  - No PDF/RSP scouting yet: those features are 0 with has-flags 0 —
 *    the pre-PDF-era training rows look identical.
 *  - College QBR: the shipped college_qbr file ends before 2024, so
 *    collegeQBR2yr is 0 — as it was for every 2026 QB (Mendoza included).
 *  - Draft capital uses the consensus-board projected pick; that is the
 *    pre-draft model's design (it trained on real picks, scored 2026
 *    pre-draft on projections the same way).
 */

import { readFileSync, writeFileSync } from 'fs';
import { predictRookieCareerPPG, bootstrapThresholdProb, PPG_THRESHOLD_CONFIG } from '../src/lib/rookieCareerModel';
import { predict } from '../src/lib/ridge';
import { predictBaggedGBM } from '../src/lib/gbm';
import { normalizeName } from '../src/lib/featureTypes';
import ncaaTeamData from '../src/data/ncaa-team-data.json';

const DRAFT_YEAR = 2027;

// ── inputs ────────────────────────────────────────────────────────────
const career27 = JSON.parse(readFileSync('public/data/career-2027.json', 'utf-8')) as any[];
const grades27 = JSON.parse(readFileSync('src/data/prospect-grades-2027.json', 'utf-8')) as any[];
const grades26 = JSON.parse(readFileSync('src/data/prospect-grades-2026.json', 'utf-8')) as any[];
const fm = JSON.parse(readFileSync('public/data/feature-matrix.json', 'utf-8'));
const rookieCareerModels = fm.rookieCareerModels as Record<string, any>;
const preds26 = fm.careerPredictions2026 as Array<{ position: string; features?: Record<string, number> }>;
const cfbdUsage = JSON.parse(readFileSync('public/data/cfbd-player-usage.json', 'utf-8')) as Record<string, any>;

// ── ncaa team context (same source collegeAnalytics uses) ─────────────
const ncaaSOS = (ncaaTeamData as any).sos as Record<string, number>;
const ncaaPassAttPerGame = (ncaaTeamData as any).teamPassAttPerGame as Record<string, number>;
const ncaaPredictive = (ncaaTeamData as any).predictiveRanking as Record<string, number>;

// Mirror collegeAnalytics.normalizeSchool closely enough for the schools
// on a top-100 board ("Ohio State" → "ohio st").
function normSchool(school: string): string {
  return (school || '').toLowerCase().trim()
    .replace(/\buniversity\b/g, '').replace(/\bstate\b/g, 'st')
    .replace(/\bnorthern\b/g, 'n').replace(/\bsouthern\b/g, 's')
    .replace(/\beastern\b/g, 'e').replace(/\bwestern\b/g, 'w')
    .replace(/\bcentral\b/g, 'c').replace(/\bmiddle\b/g, 'mid')
    .replace(/\s+/g, ' ').trim();
}
function teamKey(school: string, season: number): string {
  return `${normSchool(school)}:${season}`;
}
function cfbdKey(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ── draft-capital context from the 2027 board ─────────────────────────
const FANTASY = new Set(['QB', 'RB', 'WR', 'TE']);
const byPos = new Map<string, any[]>();
for (const g of grades27) {
  if (!FANTASY.has(g.pos)) continue;
  if (!byPos.has(g.pos)) byPos.set(g.pos, []);
  byPos.get(g.pos)!.push(g);
}
const draftPctByName = new Map<string, number>();
const classDepthByName = new Map<string, number>();
for (const list of byPos.values()) {
  const sorted = [...list].sort((a, b) => (a.projPick || 300) - (b.projPick || 300));
  sorted.forEach((g, i) => {
    draftPctByName.set(normalizeName(g.name), sorted.length > 1 ? i / (sorted.length - 1) : 0);
    classDepthByName.set(normalizeName(g.name), sorted.length);
  });
}
const sortedAll = [...grades27].sort((a, b) => (a.projPick || 300) - (b.projPick || 300));
const draftPctOverallByName = new Map<string, number>();
sortedAll.forEach((g, i) => {
  draftPctOverallByName.set(normalizeName(g.name), sortedAll.length > 1 ? i / (sortedAll.length - 1) : 0);
});

// ── 2026-class per-position medians for missing-combine imputation ────
function median(vals: number[]): number {
  if (!vals.length) return 0;
  const s = [...vals].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
const posMedian = new Map<string, { ras: number; weight: number }>();
for (const pos of FANTASY) {
  const rows = preds26.filter(p => p.position === pos && p.features);
  posMedian.set(pos, {
    ras: median(rows.map(p => p.features!.relativeAthleticScore || 0).filter(v => v > 0)),
    weight: median(rows.map(p => p.features!.weight || 0).filter(v => v > 0)),
  });
}

// ── teammate score: drafted/projected mates within ±2 draft classes ───
// 2025-26 real picks from nflverse draft_picks + the 2026 class's actual
// picks from prospect-grades, plus 2027 classmates at projected picks.
const matesBySchool = new Map<string, Array<{ name: string; pick: number }>>();
function addMate(school: string, name: string, pick: number) {
  if (!school || !pick) return;
  const k = normSchool(school);
  if (!matesBySchool.has(k)) matesBySchool.set(k, []);
  matesBySchool.get(k)!.push({ name: normalizeName(name), pick });
}
try {
  const raw = readFileSync('public/data/draft_picks.csv', 'utf-8');
  const lines = raw.split('\n');
  const header = lines[0].split(',');
  const idx = (c: string) => header.indexOf(c);
  const iSeason = idx('season'), iPick = idx('pick'), iName = idx('pfr_player_name');
  const iCollege = idx('college') >= 0 ? idx('college') : idx('school');
  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    const season = Number(cols[iSeason]);
    if (season < DRAFT_YEAR - 2 || season >= DRAFT_YEAR) continue;
    addMate(cols[iCollege] || '', cols[iName] || '', Number(cols[iPick]) || 0);
  }
} catch { /* draft_picks.csv is a build-time download; 2026 grades still cover the nearest class */ }
for (const g of grades26) {
  if (g.actualPick > 0) addMate(g.school || '', g.name, g.actualPick);
}
for (const g of grades27) {
  addMate(g.school || '', g.name, g.projPick || 0);
}
function trainedClassDepthMean(pos: string): number {
  const r = rookieCareerModels[pos]?.ridgeModel;
  if (!r) return 0;
  const i = r.featureNames.indexOf('draftClassDepth');
  return i >= 0 ? Math.round(r.featureMeans[i]) : 0;
}

function teammateScore(name: string, school: string): number {
  const nn = normalizeName(name);
  let score = 0;
  for (const m of matesBySchool.get(normSchool(school)) || []) {
    if (m.name === nn) continue;
    score += 1 / m.pick;
  }
  return Math.round(score * 1000) / 1000;
}

// ── per-prospect feature construction (mirrors the 2026 formulas) ─────
function buildFeatures(row: any): Record<string, number> {
  const pos = row.pos as string;
  const projPick = row.projPick || 300;
  const nn = normalizeName(row.name);
  const age = row.recruitClassYear ? DRAFT_YEAR - row.recruitClassYear + 18 : 21;
  const med = posMedian.get(pos) || { ras: 0, weight: 0 };
  const seasons: any[] = row.seasonStats || [];
  const lastSeason = seasons.length ? Math.max(...seasons.map(s => s.season)) : DRAFT_YEAR - 1;

  // ZAP: best season of recYds per team pass attempt, SOS-adjusted, with
  // the age-discount breakout score (collegeAnalytics formulas verbatim).
  // seasonStats carries no per-season school, so transfers price at the
  // current school's context — acceptable for a top-100 board.
  let bestRecYdsPerTPA = 0, breakoutScore = 0;
  for (const s of seasons) {
    const recYds = s['Receiving Yards'] || 0;
    if (recYds <= 0) continue;
    const key = teamKey(row.school, s.season);
    const paPerGame = ncaaPassAttPerGame[key] || 0;
    const teamPA = paPerGame > 0 ? Math.round(paPerGame * 13) : 0;
    if (teamPA <= 0) continue;
    const sosRaw = ncaaSOS[key] || 0;
    const sosMult = sosRaw ? 1 + sosRaw / 20 : 1;
    const recYdsPerTPA = (recYds / teamPA) * sosMult;
    bestRecYdsPerTPA = Math.max(bestRecYdsPerTPA, recYdsPerTPA);
    const ageInSeason = age - (DRAFT_YEAR - s.season);
    if (ageInSeason > 17 && ageInSeason < 25) {
      breakoutScore = Math.max(breakoutScore, recYdsPerTPA * (1.0 + (21 - ageInSeason) * 0.075));
    } else {
      breakoutScore = Math.max(breakoutScore, recYdsPerTPA);
    }
  }

  // QB context (precompute-features formulas verbatim).
  const games = (row.careerSeasons || seasons.length || 1) * 13;
  const passYpg = (row.careerPassYds || 0) / games;
  const rushYpg = (row.careerRushYds || 0) / games;
  const finalKey = teamKey(row.school, lastSeason);
  const sosRawFinal = ncaaSOS[finalKey] || 0;
  const sosMultFinal = sosRawFinal ? 1 + sosRawFinal / 20 : 1;
  const teamRating = ncaaPredictive[finalKey] || 0;

  // RB usage from CFBD PPA (real for 2024-25 actives).
  let usageOverall = 0;
  for (const s of seasons) {
    const u = cfbdUsage[`${cfbdKey(row.name)}:${s.season}`];
    if (u?.overall) usageOverall = Math.max(usageOverall, u.overall);
  }

  return {
    // draft capital
    logDraftPick: Math.log(projPick + 1),
    draftPickPct: draftPctByName.get(nn) ?? 1,
    draftPickPctOverall: draftPctOverallByName.get(nn) ?? 1,
    // The pre-pre-draft board lists ~a third of a real class (17 WRs vs a
    // trained mean of ~32 ± 2.6), so the literal count sits 6σ out of
    // distribution. Depth is unknowable this far out — feed the model the
    // per-position training mean (a neutral value) instead of an artifact
    // of board length. Constant per position, so intra-class order is
    // unaffected either way.
    draftClassDepth: trainedClassDepthMean(pos),
    age,
    // college production
    collegeBreakoutScore: Math.round(breakoutScore * 1000) / 1000,
    collegeRecYdsPerTeamPassAtt: Math.round(bestRecYdsPerTPA * 1000) / 1000,
    collegeBestRecYds: row.bestRecYds || 0,
    collegeTeammateScore: teammateScore(row.name, row.school),
    collegeUsageOverall: Math.round(usageOverall * 1000) / 1000,
    // dominator × late-round interaction is 0 for every pick ≤ ~53 by
    // construction (log(pick+1) − 4 ≤ 0); no 2027 board RB projects later.
    collegeDominatorXLateRound: 0,
    recruitStars: row.recruitStars || 0,
    recruitRating: row.recruitRating || 0,
    // physical: no combine yet → 2026 same-pos medians (the imputation
    // 2026 no-workout prospects received)
    weight: row.recruitWeight || med.weight,
    relativeAthleticScore: med.ras,
    // QB
    collegeQBR2yr: 0, // college_qbr source ends pre-2024; 2026 QBs also scored with 0
    collegeRushYpgPerAge: rushYpg > 0 ? Math.round((rushYpg / age) * 100) / 100 : 0,
    collegeSosFinalYr: Math.round(sosMultFinal * 100) / 100,
    collegeQbContextScore: Math.round(passYpg * Math.max(0, teamRating + 40) * sosMultFinal),
    // scouting sources that don't exist yet for this class
    pdfRankOverallMean: 0, pdfHasRank: 0,
    pdfNStrengths: 0, pdfNWeaknesses: 0, pdfNRedFlags: 0, pdfSentimentNet: 0,
    rspDotDraft: 0, rspBreadthDraft: 0, rspTierOrdinal: 0, rspNComps: 0, rspHasData: 0,
  };
}

// ── score ─────────────────────────────────────────────────────────────
const TIER_LABELS = ['Alpha', 'Blue Chip', 'Starter', 'Contributor', 'Depth', 'Longshot'];
const scored: any[] = [];
for (const row of career27) {
  const pos = row.pos;
  const cm = rookieCareerModels[pos];
  if (!cm?.ridgeModel) continue;
  const features = buildFeatures(row);
  const predictedPPG = Math.round(predictRookieCareerPPG(cm, features) * 10) / 10;

  const thresholds: number[] = PPG_THRESHOLD_CONFIG[pos]?.thresholds || cm.thresholds || [];
  const thresholdProbs: Record<number, number> = {};
  for (const t of thresholds) {
    const tm = cm.thresholdModels?.[t];
    let p: number;
    if (tm?.ridge) {
      const ridgeP = Math.max(0, Math.min(1, predict(tm.ridge, features).predicted));
      p = tm.gbm
        ? Math.max(0, Math.min(1, predictBaggedGBM(tm.gbm, features).predicted)) * 0.5 + ridgeP * 0.5
        : ridgeP;
    } else {
      p = bootstrapThresholdProb(predictedPPG, t, cm);
    }
    thresholdProbs[t] = Math.round(p * 1000) / 10;
  }

  // Boom/bust from the conditional residual bins (the same fallback the
  // 2026 pass uses when the Python talent-gap model hasn't scored a name).
  let boomProb = (cm.boomRate || 0) / 100, bustProb = (cm.bustRate || 0) / 100;
  const bins = cm.conditionalResiduals?.bins;
  if (bins?.length) {
    const bin = bins.find((b: any) => predictedPPG >= b.predMin && predictedPPG <= b.predMax)
      || bins.find((b: any) => b.label === 'mid');
    if (bin) { boomProb = bin.boomRate / 100; bustProb = bin.bustRate / 100; }
  }

  scored.push({ row, pos, features, predictedPPG, thresholdProbs, boomProb, bustProb });
}

// Percentile vs the historical backtest, per position (2026 pass verbatim),
// then tier bands + the WR-Alpha-requires-R1 cap.
for (const pos of FANTASY) {
  const cm = rookieCareerModels[pos];
  const refPPGs: number[] = (cm?.backtestRows || [])
    .map((r: any) => r.predictedPPG).filter((v: number) => v > 0).sort((a: number, b: number) => a - b);
  for (const s of scored.filter(x => x.pos === pos)) {
    let pctl = 0;
    if (s.predictedPPG > 0 && refPPGs.length) {
      pctl = Math.round((refPPGs.filter(p => p <= s.predictedPPG).length / refPPGs.length) * 100);
    }
    s.percentile = pctl;
    s.modelTier = pctl >= 95 ? 1 : pctl >= 85 ? 2 : pctl >= 70 ? 3 : pctl >= 50 ? 4 : pctl >= 30 ? 5 : 6;
    const isR1 = (s.row.projRound || 0) === 1 || (s.row.projPick || 300) <= 32;
    if (pos === 'WR' && s.modelTier === 1 && !isR1) {
      s.modelTier = 2;
      s.percentile = Math.min(s.percentile, 94);
    }
    // "Generational" is earned, not seeded: the model must place the
    // prospect at or above every historical same-position backtest
    // prediction (2009-2025). One flag, position-relative, data-only.
    s.generational = refPPGs.length > 0 && s.predictedPPG >= refPPGs[refPPGs.length - 1] && s.modelTier === 1;
  }
}

// ── write back ────────────────────────────────────────────────────────
const byName = new Map(scored.map(s => [normalizeName(s.row.name), s]));
let n = 0;
for (const row of career27) {
  const s = byName.get(normalizeName(row.name));
  if (!s) continue;
  row.model = {
    predictedCareerPPG: s.predictedPPG,
    percentile: s.percentile,
    modelTier: s.modelTier,
    tierLabel: s.generational ? 'Generational' : TIER_LABELS[s.modelTier - 1],
    generational: s.generational,
    thresholdProbs: s.thresholdProbs,
    boomProb: Math.round(s.boomProb * 1000) / 10,
    bustProb: Math.round(s.bustProb * 1000) / 10,
    features: s.features,
    scoredAt: new Date().toISOString(),
    source: 'rookieCareerModels (pre-draft) from feature-matrix.json',
  };
  n++;
}
writeFileSync('public/data/career-2027.json', JSON.stringify(career27, null, 1) + '\n');
console.log(`Scored ${n}/${career27.length} prospects with the pre-draft rookie career model`);
for (const s of [...scored].sort((a, b) => b.predictedPPG - a.predictedPPG).slice(0, 15)) {
  console.log(`  ${s.row.name.padEnd(22)} ${s.pos.padEnd(3)} pick ${String(s.row.projPick).padStart(3)}  ` +
    `PPG ${s.predictedPPG.toFixed(1).padStart(5)}  pctl ${String(s.percentile).padStart(3)}  ` +
    `${s.generational ? 'GENERATIONAL' : TIER_LABELS[s.modelTier - 1]}`);
}
