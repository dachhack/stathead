#!/usr/bin/env node
/**
 * Fetch FantasyCalc /values/current for the variants the app uses and save
 * each as JSON under public/data/. The files are picked up by tryPreFetched
 * in src/data.ts (pattern: fantasycalc_<sfx>.json).
 *
 * Routed through the fc-proxy Cloudflare Worker because api.fantasycalc.com
 * rejects most direct requests with 403 host_not_allowed.
 *
 * Usage: node scripts/fetch-fantasycalc.cjs [public/data]
 */

const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] || 'public/data';
const FC_PROXY = 'https://fc-proxy.dachhack.workers.dev';

const VARIANTS = [
  { sfx: 'dynasty_1qb', isDynasty: true,  numQbs: 1 },
  { sfx: 'dynasty_sf',  isDynasty: true,  numQbs: 2 },
  { sfx: 'redraft_1qb', isDynasty: false, numQbs: 1 },
  { sfx: 'redraft_sf',  isDynasty: false, numQbs: 2 },
];

async function fetchVariant({ sfx, isDynasty, numQbs }) {
  const outfile = path.join(OUT, `fantasycalc_${sfx}.json`);
  const url = `${FC_PROXY}/values/current?isDynasty=${isDynasty}&numQbs=${numQbs}&numTeams=12&ppr=1`;

  console.log(`  Fetching ${sfx}...`);
  const resp = await fetch(url, {
    headers: { 'Origin': 'https://dachhack.github.io' },
  });
  if (!resp.ok) throw new Error(`${sfx}: HTTP ${resp.status}`);
  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`${sfx}: empty or non-array response`);
  }
  fs.writeFileSync(outfile, JSON.stringify(data));
  console.log(`  Saved ${outfile} (${data.length} players)`);
}

async function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  for (const v of VARIANTS) {
    await fetchVariant(v);
  }
}

main().catch(err => {
  console.error('FantasyCalc fetch failed:', err.message);
  process.exit(1);
});
