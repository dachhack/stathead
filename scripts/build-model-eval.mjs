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
const importance = fm.featureImportance || {};
const predRows = fm.predRows || [];      // 2026 scored players + feature vectors
const preds = fm.predictions2026 || [];  // 2026 predictions (VOR, hit prob, CI)

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const predByKey = new Map(preds.map((p) => [norm(p.name) + '|' + p.position, p]));

// Per-position cohorts of feature vectors (from predRows) for percentile +
// correlation-direction against predictedVor.
const cohorts = {}; // pos -> { rows: [{feat, vor}], keys:Set }
for (const r of predRows) {
  const pos = r.position;
  const pred = predByKey.get(norm(r.name) + '|' + pos);
  if (!pred || typeof pred.predictedVor !== 'number') continue;
  (cohorts[pos] ??= { rows: [], values: {} }).rows.push({ name: r.name, team: r.team, adp: r.adp, features: r.features || {}, pred });
}

// Build per-position feature stats: sorted value arrays (percentile) + direction.
const statsByPos = {};
for (const [pos, c] of Object.entries(cohorts)) {
  const keys = new Set();
  for (const row of c.rows) for (const k of Object.keys(row.features)) keys.add(k);
  const byKey = {};
  const vors = c.rows.map((r) => r.pred.predictedVor);
  for (const k of keys) {
    const vals = [], paired = [], pv = [];
    for (let i = 0; i < c.rows.length; i++) {
      const v = Number(c.rows[i].features[k]);
      if (Number.isFinite(v)) { vals.push(v); paired.push(v); pv.push(vors[i]); }
    }
    if (vals.length < 5) continue;
    const sorted = [...vals].sort((a, b) => a - b);
    const dir = pearson(paired, pv);
    byKey[k] = { sorted, dir };
  }
  statsByPos[pos] = byKey;
}
const pctileOf = (sorted, v) => {
  if (!sorted || !sorted.length) return null;
  let lo = 0; for (const s of sorted) { if (s < v) lo++; else break; }
  return Math.round((lo / sorted.length) * 100);
};
const dirText = (d) => d > 0.05 ? 'higher → stronger projection' : d < -0.05 ? 'higher → weaker projection' : 'mixed / weak relationship';

// Feature importance, trimmed + annotated with direction + proprietary flag.
const impOut = {};
const catalog = {};
for (const [pos, list] of Object.entries(importance)) {
  impOut[pos] = list.slice(0, IMPORTANCE_KEEP).map((f) => {
    const prop = isProprietary(f.key);
    const dir = statsByPos[pos]?.[f.key]?.dir ?? 0;
    const label = prop ? `${f.category || 'Market'} signal` : (f.label || humanize(f.key));
    catalog[f.key] = { label, category: f.category || '', proprietary: prop };
    return { label, category: f.category || '', importance: Math.round(f.importance * 1000) / 1000, relationship: dirText(dir) };
  });
}

// Per-player drivers: that position's most important features, with the
// player's band + direction. Sanitize proprietary features.
const importanceKeysByPos = Object.fromEntries(
  Object.entries(importance).map(([pos, list]) => [pos, list.map((f) => f.key)]),
);
const players = [];
for (const [pos, c] of Object.entries(cohorts)) {
  const impKeys = importanceKeysByPos[pos] || [];
  for (const row of c.rows) {
    const drivers = [];
    for (const key of impKeys) {
      const st = statsByPos[pos]?.[key];
      if (!st) continue;
      const v = Number(row.features[key]);
      if (!Number.isFinite(v)) continue;
      const pct = pctileOf(st.sorted, v);
      const prop = isProprietary(key);
      const imp = importance[pos].find((f) => f.key === key);
      const d = {
        feature: prop ? `${imp?.category || 'Market'} signal` : (imp?.label || humanize(key)),
        category: imp?.category || '',
        band: bandFor(pct ?? 50),
        relationship: dirText(st.dir),
      };
      if (!prop) d.value = Math.round(v * 1000) / 1000;
      // rank by how notable: deviation from median × importance
      d._score = Math.abs((pct ?? 50) - 50) * (imp?.importance || 0);
      drivers.push(d);
      if (drivers.length >= impKeys.length) break;
    }
    drivers.sort((a, b) => b._score - a._score);
    const top = drivers.slice(0, TOP_DRIVERS).map(({ _score, ...d }) => d);
    const pred = row.pred;
    players.push({
      name: row.name, position: pos, team: row.team,
      adp: row.adp, predictedVor: pred.predictedVor, hitProb: pred.hitProb,
      ciLower: pred.ciLower, ciUpper: pred.ciUpper, isRookie: !!pred.isRookie,
      drivers: top,
    });
  }
}
players.sort((a, b) => (b.predictedVor ?? -99) - (a.predictedVor ?? -99));

const out = {
  season: SEASON,
  generatedAt: new Date().toISOString(),
  note: 'Derived StatHead model output. Per-player feature drivers show where a player lands vs the positional cohort and which way that pushes the projection; proprietary-sourced features are shown only as a qualitative band + direction (no raw value or source).',
  posThresholds: fm.posThresholds || {},
  shareModelSummary: fm.shareModelSummary || {},
  featureImportance: impOut,
  catalog,
  players,
};
const outPath = path.join(DATA, `model-eval-${SEASON}.json`);
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`Wrote ${outPath}`);
console.log(`  players: ${players.length}  positions: ${Object.keys(impOut).join(',')}  size: ${(fs.statSync(outPath).size / 1024).toFixed(0)} KB`);
console.log(`  sample: ${players[0]?.name} (${players[0]?.position}) VOR ${players[0]?.predictedVor} — drivers: ${players[0]?.drivers.slice(0,3).map((d) => d.feature).join(', ')}`);
