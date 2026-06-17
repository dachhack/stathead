/**
 * Build a COMPACT, MCP-friendly model-evaluation artifact from the big
 * feature-matrix.json (which is ~25 MB and embeds raw feature vectors).
 *
 *   node scripts/build-model-eval.mjs
 *   → public/data/model-eval-<season>.json
 *
 * Output (small, first-party, safe to serve): per-position feature importance
 * with the direction of each feature's relationship to the target, the
 * hit/bust thresholds + share-model CV summary, and — for each 2026 SCORED
 * player — their prediction (VOR, hit probability, CI) plus the top feature
 * "drivers": where they land vs the positional cohort (percentile band) and
 * which way that pushes the projection.
 *
 * Each player also carries a `models[]` array breaking the SAME drivers logic
 * out across every model that scores them — Hit/Bust (VOR), Season Projection
 * (PPG), Rookie Career / Prospect, Usage Share, and a market-derived Dynasty
 * Value note. Drivers are computed against each model's OWN target + cohort
 * (so the percentile band + relationship are model-specific), and the web
 * player card renders one panel per model. The legacy top-level `drivers`
 * field (= the Hit/Bust model) is kept for the MCP get_player_features tool.
 *
 * Proprietary policy: any feature sourced from a paid product (KTC / FantasyCalc
 * / Clay / RSP / Beast / PFF, etc.) is SANITIZED — we keep only a qualitative
 * magnitude band + direction and a generic label, never the raw value or the
 * source name. (The current feature set is all open-source, so this is a
 * forward-looking guard, applied by key pattern.)
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'public/data');
const SEASON = 2026;
const TOP_DRIVERS = 8;     // feature drivers surfaced per player
const IMPORTANCE_KEEP = 12; // importance rows kept per position

// Feature keys whose VALUES derive from paid/proprietary products. Matches are
// sanitized: no raw value, no source name — only magnitude band + direction.
const PROPRIETARY_RE = /ktc|fantasycalc|(^|_)fc_|clay|consensus|rsp|beast|pff|tradeval|dynval|marketval|superflexval/i;
const isProprietary = (key) => PROPRIETARY_RE.test(key);

function humanize(key) {
  return key.replace(/^_+/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
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
// Missing-data handling: the model imputes 0 for absent inputs, which would
// otherwise read as a misleading "bottom 10% (0)" driver. We detect missing
// data two ways: the model's coarse availability flags, and a set of
// positive-domain features where an exact 0 means "not measured" (a composite
// can be 0 even when its category flag is set — e.g. Speed Score needs weight).
const ZERO_IS_MISSING = new Set([
  'speedScore', 'heightAdjSpeedScore', 'relativeAthleticScore', 'forty', 'vertical',
  'broadJump', 'cone', 'shuttle', 'weight', 'age', 'collegeQBR', 'collegeQBR2yr',
  'recruitStars', 'recruitRating', 'collegeTeamTalent',
]);
function governingFlag(key) {
  if (/^college/i.test(key) || /^recruit/i.test(key) || key === 'collegeTeamTalent') return 'hasCollegeStats';
  if (/speedScore|^forty$|vertical|broad|cone|shuttle|relativeAthletic|heightAdj|^weight$/i.test(key)) return 'hasCombineData';
  return null;
}
function featureMissing(key, features) {
  const flag = governingFlag(key);
  if (flag && Number(features[flag]) === 0) return true;
  if (ZERO_IS_MISSING.has(key) && Number(features[key]) === 0) return true;
  return false;
}
function bandFor(pctile) {
  if (pctile >= 90) return 'top 10%';
  if (pctile >= 75) return 'top 25%';
  if (pctile >= 55) return 'above average';
  if (pctile > 45) return 'average';
  if (pctile > 25) return 'below average';
  if (pctile > 10) return 'bottom 25%';
  return 'bottom 10%';
}

const fm = JSON.parse(fs.readFileSync(path.join(DATA, 'feature-matrix.json'), 'utf8'));
const importance = fm.featureImportance || {};        // Hit/Bust (VOR) model
const vetImportance = fm.vetFeatureImportance || {};  // Season projection (PPG) model
const rookieImportance = fm.rookieFeatureImportance || {}; // Rookie career (prospect) model
const predRows = fm.predRows || [];          // 2026 scored players + 266-feature vectors
const preds = fm.predictions2026 || [];      // VOR / hit prob / CI
const ppgPreds = fm.ppgPredictions2026 || []; // season PPG projection
const careerPreds = fm.careerPredictions2026 || []; // rookie career model (own 85-feature vectors)

// ── Calibrated hit/bust vs draft cost ───────────────────────────────────────
// The absolute VOR threshold can't discriminate within the draftable pool
// (every drafted player clears it). Instead calibrate P(hit)/P(bust) RELATIVE
// TO ADP from history: the empirical rate at which players drafted near a slot
// beat / missed their cost (ground-truth isHit/isBust in the training cache),
// tilted by how far THIS model ranks the player above/below their ADP peers.
// We emit (a) a per-position base-rate curve over ADP and (b) a per-player
// model "lean", so get_player_features can recompute pHit/pBust against the
// LIVE consensus ADP at serve time (the card's ADP drifts from the market).
const nrm2 = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const pk2 = (name, pos) => nrm2(name) + '|' + pos;
function loadTrainingRows() {
  const f = fs.readdirSync(DATA)
    .filter((x) => /^training-rows-cache-v\d+\.json$/.test(x))
    .sort((a, b) => Number(a.match(/v(\d+)/)[1]) - Number(b.match(/v(\d+)/)[1])).pop();
  if (!f) return [];
  const d = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
  return (d.rows || d).filter((r) => r && r.adp > 0 && r.adp < 300 && r.position);
}
const histByPos = {};
for (const r of loadTrainingRows()) (histByPos[r.position] ??= []).push(r);
for (const pos of Object.keys(histByPos)) histByPos[pos].sort((a, b) => a.adp - b.adp);
// Smoothed base rate at an ADP = mean isHit / isBust over the nearest-by-ADP
// historical players at that position (k-NN in ADP space).
function baseRatesAt(pos, adp) {
  const arr = histByPos[pos];
  if (!arr || arr.length < 12) return null;
  const K = Math.min(80, Math.max(30, Math.round(arr.length * 0.15)));
  const near = arr.map((r) => [Math.abs(r.adp - adp), r]).sort((a, b) => a[0] - b[0]).slice(0, K);
  const hit = near.reduce((s, x) => s + (x[1].isHit ? 1 : 0), 0) / near.length;
  const bust = near.reduce((s, x) => s + (x[1].isBust ? 1 : 0), 0) / near.length;
  return { hit, bust };
}
// Per-position base-rate curve sampled over ADP (interpolated at serve time).
const ADP_GRID = [1, 3, 6, 10, 15, 20, 25, 30, 40, 50, 65, 80, 100, 120, 150, 180, 220, 260];
const hitBustCalib = {};
for (const pos of ['QB', 'RB', 'WR', 'TE']) {
  if (!histByPos[pos]) continue;
  hitBustCalib[pos] = ADP_GRID.map((adp) => {
    const b = baseRatesAt(pos, adp);
    return b ? { adp, hit: Math.round(b.hit * 1000) / 1000, bust: Math.round(b.bust * 1000) / 1000 } : null;
  }).filter(Boolean);
}
// 2026 within-position ranks: predictedVor (desc=better) vs ADP (asc=earlier).
// lean>0 ⇒ the model ranks the player better than their ADP slot ⇒ undervalued.
const posRankCtx = {};
for (const pos of ['QB', 'RB', 'WR', 'TE']) {
  const list = preds.filter((p) => p.position === pos && typeof p.predictedVor === 'number' && p.adp > 0);
  const vorRank = new Map([...list].sort((a, b) => b.predictedVor - a.predictedVor).map((p, i) => [pk2(p.name, pos), i]));
  const adpRank = new Map([...list].sort((a, b) => a.adp - b.adp).map((p, i) => [pk2(p.name, pos), i]));
  posRankCtx[pos] = { vorRank, adpRank, n: list.length };
}
function modelLean(name, pos) {
  const ctx = posRankCtx[pos];
  if (!ctx || ctx.n < 5) return 0;
  const k = pk2(name, pos);
  const vr = ctx.vorRank.get(k), ar = ctx.adpRank.get(k);
  if (vr == null || ar == null) return 0;
  return Math.round(((ar - vr) / ctx.n) * 1000) / 1000; // -1..1
}
const clamp01 = (x) => Math.max(0.01, Math.min(0.99, x));
function interpCurve(curve, adp) {
  if (!curve || !curve.length) return null;
  if (adp <= curve[0].adp) return curve[0];
  if (adp >= curve[curve.length - 1].adp) return curve[curve.length - 1];
  for (let i = 1; i < curve.length; i++) {
    if (adp <= curve[i].adp) {
      const a = curve[i - 1], b = curve[i], t = (adp - a.adp) / (b.adp - a.adp);
      return { hit: a.hit + (b.hit - a.hit) * t, bust: a.bust + (b.bust - a.bust) * t };
    }
  }
  return curve[curve.length - 1];
}
// Calibrated pHit/pBust at a given ADP + lean (base rate dominates; the model
// lean shifts each by at most ~±12pp).
function calibHitBust(pos, adp, lean) {
  const base = interpCurve(hitBustCalib[pos], adp);
  if (!base) return null;
  const shift = 0.12 * Math.tanh((lean || 0) * 2.5);
  return { pHit: Math.round(clamp01(base.hit + shift) * 100), pBust: Math.round(clamp01(base.bust - shift) * 100) };
}

// Usage-share model inputs — mirror SHARE_FEATURE_KEYS in
// scripts/train_projection_models.py. Shares have no per-feature importance, so
// drivers rank purely by how far the player sits from the cohort median.
const SHARE_FEATURE_KEYS = [
  'priorTeamTargetShare', 'priorTeamTouchShare', 'priorTargetShare',
  'priorSnapPct', 'depthChartRank', 'teamSamePosCount',
  'contractAPY', 'age', 'yearsInLeague', 'priorPPG',
  'nflDraftPick', 'priorReceptions', 'priorTargets', 'priorCarries',
  'teamTargetHHI', 'vegasImpliedTotal',
  'adp', 'teamElitePassCatchers', 'priorWOPR',
];

let shareScores = [];
try {
  shareScores = JSON.parse(fs.readFileSync(path.join(DATA, 'score-store/shares.json'), 'utf8'));
} catch { /* shares are optional — the Usage Share panel is just skipped */ }

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const pk = (name, pos) => norm(name) + '|' + pos;

// ── Label / category lookup, pooled across every model's importance list ────
const keyMeta = {}; // key -> { label, category }
for (const imp of [importance, vetImportance, rookieImportance]) {
  for (const list of Object.values(imp)) {
    for (const f of list) if (f.key && !keyMeta[f.key]) keyMeta[f.key] = { label: f.label || humanize(f.key), category: f.category || '' };
  }
}
// Categories for share-only keys not present in any importance list.
const SHARE_CATEGORY = {
  priorTeamTargetShare: 'Share', priorTeamTouchShare: 'Share', priorTargetShare: 'Share',
  priorSnapPct: 'Usage', depthChartRank: 'Profile', teamSamePosCount: 'Competition',
  contractAPY: 'Contract', age: 'Profile', yearsInLeague: 'Profile', priorPPG: 'Prior',
  nflDraftPick: 'Draft', priorReceptions: 'Prior', priorTargets: 'Prior', priorCarries: 'Prior',
  teamTargetHHI: 'Competition', vegasImpliedTotal: 'Vegas', adp: 'Draft',
  teamElitePassCatchers: 'Competition', priorWOPR: 'Prior',
};
const labelOf = (key) => keyMeta[key]?.label || humanize(key);
const categoryOf = (key) => keyMeta[key]?.category || SHARE_CATEGORY[key] || '';

// ── Lookups joined by normalized name|position ──────────────────────────────
const predByKey = new Map(preds.map((p) => [pk(p.name, p.position), p]));
const ppgByKey = new Map(ppgPreds.map((p) => [pk(p.name, p.position), p]));
const careerByKey = new Map(careerPreds.map((p) => [pk(p.name, p.position), p]));
const shareByKey = new Map(shareScores.map((p) => [pk(p.name, p.position), p]));

// Feature source per player: the scored-pool vector (266 keys) for everything
// except the rookie career model, which keeps its own 85-key training vector.
const featByKey = new Map();
for (const r of predRows) featByKey.set(pk(r.name, r.position), r.features || {});

const pctileOf = (sorted, v) => {
  if (!sorted || !sorted.length) return null;
  let lo = 0; for (const s of sorted) { if (s < v) lo++; else break; }
  return Math.round((lo / sorted.length) * 100);
};
const dirText = (d) => d > 0.05 ? 'higher → stronger projection' : d < -0.05 ? 'higher → weaker projection' : 'mixed / weak relationship';

// ── Model registry ──────────────────────────────────────────────────────────
// Each model declares: a target series to correlate drivers against, the
// feature source + importance weights, the cohort of players to score, and how
// to render the headline prediction. `valueTrend` is intentionally note-only —
// dynasty value is a market-derived composite with no first-party feature model.
const importanceKeys = (imp, pos) => (imp[pos] || []).slice(0, IMPORTANCE_KEEP).map((f) => f.key);
const importanceWeight = (imp, pos) => {
  const m = {};
  for (const f of (imp[pos] || [])) m[f.key] = f.importance || 0;
  return m;
};

const MODELS = [
  {
    id: 'hitBust', label: 'Hit / Bust (VOR)',
    blurb: 'Per-position gradient-boosted VOR model; Hit/Bust % calibrated against historical hit/bust rates by draft slot, tilted by the model’s value-vs-ADP lean.',
    keysByPos: (pos) => importanceKeys(importance, pos),
    weightByPos: (pos) => importanceWeight(importance, pos),
    featureSource: (k) => featByKey.get(k),
    target: (k) => predByKey.get(k)?.predictedVor,
    eligible: (k) => typeof predByKey.get(k)?.predictedVor === 'number',
    prediction: (k) => {
      const p = predByKey.get(k);
      const lean = modelLean(p.name, p.position);
      // Offline pHit/pBust uses the (possibly stale) card ADP; get_player_features
      // recomputes against the live consensus ADP using calibLean + the curve.
      const cal = calibHitBust(p.position, p.adp, lean);
      return {
        vor: p.predictedVor, hitProb: p.hitProb, ciLower: p.ciLower, ciUpper: p.ciUpper,
        calibLean: lean,
        ...(cal ? { pHit: cal.pHit, pBust: cal.pBust } : {}),
      };
    },
  },
  {
    id: 'projection', label: 'Season Projection (PPG)',
    blurb: 'Veteran PPG blend (prior actual + 2yr avg + age curve) over team-volume shares.',
    keysByPos: (pos) => importanceKeys(vetImportance, pos),
    weightByPos: (pos) => importanceWeight(vetImportance, pos),
    featureSource: (k) => featByKey.get(k),
    target: (k) => ppgByKey.get(k)?.predictedPPG,
    eligible: (k) => typeof ppgByKey.get(k)?.predictedPPG === 'number',
    prediction: (k) => ({ ppg: ppgByKey.get(k).predictedPPG }),
  },
  {
    id: 'rookieCareer', label: 'Rookie Career / Prospect',
    blurb: 'Best-2-of-3-seasons PPG model from draft capital, college production, and athletic testing.',
    keysByPos: (pos) => importanceKeys(rookieImportance, pos),
    weightByPos: (pos) => importanceWeight(rookieImportance, pos),
    featureSource: (k) => careerByKey.get(k)?.features,
    target: (k) => careerByKey.get(k)?.predictedCareerPPG,
    eligible: (k) => typeof careerByKey.get(k)?.predictedCareerPPG === 'number',
    prediction: (k) => {
      const c = careerByKey.get(k);
      return {
        careerPPG: c.predictedCareerPPG, tier: c.modelTier, percentile: c.percentile,
        boomProb: c.boomProb, bustProb: c.bustProb,
      };
    },
  },
  {
    id: 'share', label: 'Usage Share',
    blurb: 'Predicted share of team targets / carries from prior usage, competition, and depth chart.',
    positions: new Set(['RB', 'WR', 'TE']),
    keysByPos: () => SHARE_FEATURE_KEYS,
    weightByPos: () => ({}), // no importance — rank by deviation from median
    featureSource: (k) => featByKey.get(k),
    target: (k) => shareByKey.get(k)?.predTargetShare,
    eligible: (k) => typeof shareByKey.get(k)?.predTargetShare === 'number',
    prediction: (k) => {
      const s = shareByKey.get(k);
      return { targetShare: s.predTargetShare, rushShare: s.predRushShare };
    },
  },
  {
    id: 'valueTrend', label: 'Dynasty Value',
    blurb: 'Market-consensus dynasty value + trend. A composite of paid market feeds — no first-party feature decomposition, so the live value/trend is shown on the Dynasty Value card.',
    noteOnly: true,
  },
];

// ── Per-model, per-position feature stats (sorted values + direction) ────────
// Computed inside each model's OWN cohort against its OWN target, so the
// percentile band and relationship are model-specific.
function buildStats(model) {
  const byPos = {}; // pos -> key -> { sorted, dir }
  const cohorts = {}; // pos -> [{ key }]
  for (const k of featByKey.keys()) {
    const pos = k.split('|')[1];
    if (model.positions && !model.positions.has(pos)) continue;
    if (!model.eligible(k)) continue;
    (cohorts[pos] ??= []).push(k);
  }
  for (const [pos, keys] of Object.entries(cohorts)) {
    const out = {};
    for (const fk of model.keysByPos(pos)) {
      const vals = [], pv = [];
      for (const k of keys) {
        const feats = model.featureSource(k);
        const v = Number(feats?.[fk]);
        const t = Number(model.target(k));
        if (Number.isFinite(v) && Number.isFinite(t)) { vals.push(v); pv.push(t); }
      }
      if (vals.length < 5) continue;
      out[fk] = { sorted: [...vals].sort((a, b) => a - b), dir: pearson(vals, pv) };
    }
    byPos[pos] = out;
  }
  return byPos;
}
const statsByModel = Object.fromEntries(MODELS.filter((m) => !m.noteOnly).map((m) => [m.id, buildStats(m)]));

// Drivers for one (player, model): top features by |pctile-50| × importance.
function driversFor(model, key, pos) {
  const stats = statsByModel[model.id]?.[pos] || {};
  const feats = model.featureSource(key) || {};
  const weights = model.weightByPos(pos);
  const out = [];
  for (const fk of model.keysByPos(pos)) {
    const st = stats[fk];
    if (!st) continue;
    const v = Number(feats[fk]);
    if (!Number.isFinite(v)) continue;
    if (featureMissing(fk, feats)) continue; // imputed-0 reads as a bogus driver
    const pct = pctileOf(st.sorted, v) ?? 50;
    const prop = isProprietary(fk);
    const d = {
      feature: prop ? `${categoryOf(fk) || 'Market'} signal` : labelOf(fk),
      category: categoryOf(fk),
      band: bandFor(pct), pctile: pct,
      relationship: dirText(st.dir),
    };
    if (!prop) d.value = Math.round(v * 1000) / 1000;
    // No importance (share model) → weight 1, so ranking falls back to deviation.
    const w = (model.id === 'share') ? 1 : (weights[fk] || 0);
    d._score = Math.abs(pct - 50) * w;
    out.push(d);
  }
  out.sort((a, b) => b._score - a._score);
  return out.slice(0, TOP_DRIVERS).map(({ _score, ...d }) => d);
}

// Per-position Hit/Bust importance, trimmed + annotated (legacy MCP artifact).
const impOut = {};
const catalog = {};
for (const [pos, list] of Object.entries(importance)) {
  impOut[pos] = list.slice(0, IMPORTANCE_KEEP).map((f) => {
    const prop = isProprietary(f.key);
    const dir = statsByModel.hitBust?.[pos]?.[f.key]?.dir ?? 0;
    const label = prop ? `${f.category || 'Market'} signal` : (f.label || humanize(f.key));
    catalog[f.key] = { label, category: f.category || '', proprietary: prop };
    return { label, category: f.category || '', importance: Math.round(f.importance * 1000) / 1000, relationship: dirText(dir) };
  });
}

// ── Assemble per-player records (one per scored player) ──────────────────────
const players = [];
for (const r of predRows) {
  const pos = r.position;
  const key = pk(r.name, pos);
  const pred = predByKey.get(key);
  if (!pred || typeof pred.predictedVor !== 'number') continue;
  const f = r.features || {};

  // What the (scored-player) model lacks for this player — reported instead of
  // scoring an imputed 0.
  const dataGaps = [];
  if (Number(f.hasCollegeStats) === 0) dataGaps.push('college production');
  if (Number(f.hasCombineData) === 0) dataGaps.push('combine / athletic testing');
  else if (Number(f.speedScore) === 0 && Number(f.weight) === 0) dataGaps.push('athletic composites (no listed weight)');
  if (pred.isRookie && Number(f.hasProspectGrade) === 0) dataGaps.push('scouting grade');

  // Each model that scores this player.
  const models = [];
  for (const m of MODELS) {
    if (m.noteOnly) { models.push({ id: m.id, label: m.label, blurb: m.blurb, noteOnly: true }); continue; }
    if (m.positions && !m.positions.has(pos)) continue;
    if (!m.eligible(key)) continue;
    const drivers = driversFor(m, key, pos);
    if (!drivers.length && m.id !== 'hitBust') continue;
    models.push({ id: m.id, label: m.label, blurb: m.blurb, prediction: m.prediction(key), drivers });
  }

  players.push({
    name: r.name, position: pos, team: r.team,
    adp: r.adp, predictedVor: pred.predictedVor, hitProb: pred.hitProb,
    ciLower: pred.ciLower, ciUpper: pred.ciUpper, isRookie: !!pred.isRookie,
    drivers: models.find((m) => m.id === 'hitBust')?.drivers ?? [], // legacy MCP field
    models,
    ...(dataGaps.length ? { dataGaps } : {}),
  });
}
players.sort((a, b) => (b.predictedVor ?? -99) - (a.predictedVor ?? -99));

const out = {
  season: SEASON,
  generatedAt: new Date().toISOString(),
  note: 'Derived StatHead model output. Per-player feature drivers show where a player lands vs the positional cohort for that model and which way that pushes the prediction; proprietary-sourced features are shown only as a qualitative band + direction (no raw value or source). Each player carries a models[] breakdown (Hit/Bust, Season Projection, Rookie Career, Usage Share, Dynasty Value); the top-level drivers field is the Hit/Bust model, kept for the MCP get_player_features tool.',
  posThresholds: fm.posThresholds || {},
  hitBustCalib,
  shareModelSummary: fm.shareModelSummary || {},
  featureImportance: impOut,
  catalog,
  players,
};
const outPath = path.join(DATA, `model-eval-${SEASON}.json`);
fs.writeFileSync(outPath, JSON.stringify(out));
const modelCounts = {};
for (const p of players) for (const m of p.models || []) modelCounts[m.id] = (modelCounts[m.id] || 0) + 1;
console.log(`Wrote ${outPath}`);
console.log(`  players: ${players.length}  positions: ${Object.keys(impOut).join(',')}  size: ${(fs.statSync(outPath).size / 1024).toFixed(0)} KB`);
console.log(`  models per-player coverage: ${Object.entries(modelCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
console.log(`  sample: ${players[0]?.name} (${players[0]?.position}) — models: ${(players[0]?.models || []).map((m) => m.id).join(', ')}`);
