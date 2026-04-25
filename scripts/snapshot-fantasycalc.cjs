#!/usr/bin/env node
/**
 * Append today's FantasyCalc value to a per-variant history file.
 *
 * For each variant (dynasty_1qb, dynasty_sf, redraft_1qb) we maintain
 *   public/data/fantasycalc_history_<variant>.json
 * with the shape
 *   [
 *     { playerID, name, position, valueHistory: [{ d: 'YYYY-MM-DD', v }, …] },
 *     …
 *   ]
 * keyed by FC's player.id. Idempotent within a day — if today's point
 * already exists for a player, it's replaced.
 *
 * Reads from the committed snapshot files at public/data/fantasycalc_<variant>.json,
 * so run scripts/fetch-fantasycalc.cjs first to refresh those before this.
 *
 * Usage: node scripts/snapshot-fantasycalc.cjs [public/data]
 */

const fs = require('fs');
const path = require('path');

const DIR = process.argv[2] || 'public/data';
const VARIANTS = ['dynasty_1qb', 'dynasty_sf', 'redraft_1qb'];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function readJson(file, fallback) {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function appendHistory(variant) {
  const snap = readJson(`fantasycalc_${variant}.json`, null);
  if (!snap || !Array.isArray(snap) || snap.length === 0) {
    console.log(`  [skip] ${variant}: no current snapshot at fantasycalc_${variant}.json`);
    return;
  }

  const histFile = `fantasycalc_history_${variant}.json`;
  const existing = readJson(histFile, []);
  const byID = new Map();
  for (const row of existing) byID.set(row.playerID, row);

  const date = todayISO();
  let appended = 0;
  let replaced = 0;
  let created = 0;

  for (const fc of snap) {
    const id = fc.player?.id;
    if (id == null) continue;
    const value = Number(fc.value);
    if (!Number.isFinite(value)) continue;

    let row = byID.get(id);
    if (!row) {
      row = {
        playerID: id,
        name: fc.player.name,
        position: fc.player.position,
        valueHistory: [],
      };
      byID.set(id, row);
      created++;
    }

    const last = row.valueHistory[row.valueHistory.length - 1];
    if (last && last.d === date) {
      last.v = value;
      replaced++;
    } else {
      row.valueHistory.push({ d: date, v: value });
      appended++;
    }
  }

  const out = [...byID.values()].sort((a, b) => a.playerID - b.playerID);
  const outfile = path.join(DIR, histFile);
  fs.writeFileSync(outfile, JSON.stringify(out));
  console.log(`  ${variant}: ${out.length} players (${created} new, ${appended} appended, ${replaced} replaced) → ${outfile}`);
}

function main() {
  console.log(`FantasyCalc daily snapshot (${todayISO()})`);
  for (const v of VARIANTS) appendHistory(v);
}

main();
