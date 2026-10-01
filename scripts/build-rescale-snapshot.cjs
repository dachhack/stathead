#!/usr/bin/env node
/**
 * Build the KTC → StatHead dynasty value snapshot (a blend of KTC and
 * FantasyCalc on FantasyCalc's scale) from the prefetched
 * rankings files in public/data/. Output is consumed by tryPreFetched in
 * src/data.ts and applied to KTC values everywhere they're displayed.
 *
 * Usage: node scripts/build-rescale-snapshot.cjs [public/data]
 *
 * Run after fetch-fantasycalc.cjs (and after fetch-ktc.cjs) so the inputs
 * reflect the latest values.
 */

const fs = require('fs');
const path = require('path');

const DIR = process.argv[2] || 'public/data';
// Geometric blending is stable at any value, so every matched player is
// blended; below the floor only guards against zero values.
const FLOOR = 1;
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

// Mirrors src/lib/featureTypes.ts:normalizeName. Keep in sync.
const FIRST_NAME_ALIASES = {};
function normalizeName(name) {
  if (!name) return '';
  let n = name.toLowerCase().replace(/[.']/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').replace(/\s+/g, ' ').trim();
  const parts = n.split(' ');
  if (parts.length >= 3) n = `${parts[0]} ${parts[parts.length - 1]}`;
  const [first, ...rest] = n.split(' ');
  if (first && rest.length > 0 && FIRST_NAME_ALIASES[first]) {
    n = `${FIRST_NAME_ALIASES[first]} ${rest.join(' ')}`;
  }
  return n;
}

function readJson(file) {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) throw new Error(`Missing input: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function median(xs) {
  if (xs.length === 0) return 1;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function main() {
  const ktc = readJson('ktc_rankings_1qb.json'); // KTCPlayer has both .value (1QB) and .superflexValue
  const fc1q = readJson('fantasycalc_dynasty_1qb.json');
  const fcSf = readJson('fantasycalc_dynasty_sf.json');

  const fcKey = (name, position) => `${normalizeName(name)}|${position}`;
  const fc1qMap = new Map();
  const fcSfMap = new Map();
  for (const p of fc1q) fc1qMap.set(fcKey(p.player.name, p.player.position), p.value);
  for (const p of fcSf) fcSfMap.set(fcKey(p.player.name, p.player.position), p.value);

  const perPlayer = {};
  const samples = {};
  for (const pos of POSITIONS) samples[pos] = { oneQB: [], sf: [] };

  const ktcById = new Map(ktc.map((k) => [k.playerID, k]));
  let matched1q = 0;
  let matchedSf = 0;
  for (const k of ktc) {
    if (!POSITIONS.includes(k.position)) continue;
    const key = fcKey(k.playerName, k.position);
    const entry = {};
    const v1q = fc1qMap.get(key);
    const vSf = fcSfMap.get(key);
    if (v1q != null && k.value >= FLOOR && k.value > 0) {
      entry.oneQB = v1q / k.value;
      samples[k.position].oneQB.push(entry.oneQB);
      matched1q++;
    }
    if (vSf != null && k.superflexValue >= FLOOR && k.superflexValue > 0) {
      entry.sf = vSf / k.superflexValue;
      samples[k.position].sf.push(entry.sf);
      matchedSf++;
    }
    if (entry.oneQB != null || entry.sf != null) {
      perPlayer[k.playerID] = entry;
    }
  }

  const positional = {};
  for (const pos of POSITIONS) {
    positional[pos] = {
      oneQB: median(samples[pos].oneQB),
      sf: median(samples[pos].sf),
    };
  }

  // StatHead dynasty value = the GEOMETRIC MEAN of FantasyCalc's value and
  // KTC's value calibrated to FC's scale (by rank within the position: the gap
  // between the two scales is not constant, so one multiplier cannot do it). A pure per-player FC/KTC ratio would make the
  // shown value FantasyCalc's own number; third-party values are inputs here,
  // never shown raw. Stored as a per-player ratio on KTC:
  //   ratio = sqrt(FC x cal(KTC)) / KTC.
  // Calibration: a SMOOTH curve per position and format, log FC as a linear
  // spline in log KTC (knots through the value range), fitted by least
  // squares. Smooth on purpose: an exact rank lookup would hand a player whose
  // rank agrees in both markets his own FC value back.
  const KNOTS = [500, 1500, 3000, 5000, 7500].map(Math.log);
  const basis = (x) => [1, x, ...KNOTS.map((k) => Math.max(0, x - k))];
  const solve = (rows, ys) => {
    const n = rows[0].length;
    const A = Array.from({ length: n }, (_, i) => [
      ...Array.from({ length: n }, (_, j) => rows.reduce((s, r) => s + r[i] * r[j], 0) + (i === j ? 1e-6 : 0)),
      rows.reduce((s, r, t) => s + r[i] * ys[t], 0)]);
    for (let i = 0; i < n; i++) {
      let piv = i;
      for (let k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[piv][i])) piv = k;
      [A[i], A[piv]] = [A[piv], A[i]];
      const d = A[i][i] || 1e-12;
      A[i] = A[i].map((x) => x / d);
      for (let k = 0; k < n; k++) if (k !== i && A[k][i]) { const m = A[k][i]; A[k] = A[k].map((x, j) => x - m * A[i][j]); }
    }
    return A.map((r) => r[n]);
  };
  const calib = {};
  for (const pos of POSITIONS) {
    calib[pos] = {};
    for (const [f, kkey, fcMap] of [['oneQB', 'value', fc1qMap], ['sf', 'superflexValue', fcSfMap]]) {
      const rows = [], ys = [];
      for (const k of ktc) {
        if (k.position !== pos || !(k[kkey] > 0)) continue;
        const v = fcMap.get(fcKey(k.playerName, k.position));
        if (v > 0) { rows.push(basis(Math.log(k[kkey]))); ys.push(Math.log(v)); }
      }
      calib[pos][f] = rows.length > 10 ? solve(rows, ys) : null;
    }
  }
  const cal = (pos, f, v) => {
    const c = calib[pos][f];
    return c ? Math.exp(basis(Math.log(v)).reduce((s, z, i) => s + z * c[i], 0)) : v * positional[pos][f];
  };
  for (const [id, e] of Object.entries(perPlayer)) {
    const k = ktcById.get(Number(id));
    const pos = k && k.position;
    if (!pos || !calib[pos]) continue;
    for (const [f, kkey] of [['oneQB', 'value'], ['sf', 'superflexValue']]) {
      if (e[f] == null) continue;
      const kv = k[kkey], fcv = e[f] * kv;   // e[f] was FC / KTC
      e[f] = Math.sqrt(fcv * cal(pos, f, kv)) / kv;
    }
  }
  // Players FC does not list: KTC calibrated to FC's scale at the positional
  // median value (a single-source fallback, scaled, never the raw number).

  const snap = {
    generatedAt: new Date().toISOString(),
    floor: FLOOR,
    perPlayer,
    positional,
  };

  const outfile = path.join(DIR, 'dynasty-fc-rescale.json');
  fs.writeFileSync(outfile, JSON.stringify(snap));
  console.log(`Saved ${outfile}`);
  console.log(`  Matched players: ${matched1q} (1QB), ${matchedSf} (SF) of ${ktc.length} KTC players`);
  console.log('  Positional medians:');
  for (const pos of POSITIONS) {
    console.log(`    ${pos}: 1QB=${positional[pos].oneQB.toFixed(3)}  SF=${positional[pos].sf.toFixed(3)}`);
  }
}

main();
