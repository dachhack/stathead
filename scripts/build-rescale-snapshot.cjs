#!/usr/bin/env node
/**
 * Build a KTC → FantasyCalc value rescale snapshot from the prefetched
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
const FLOOR = 500;
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
