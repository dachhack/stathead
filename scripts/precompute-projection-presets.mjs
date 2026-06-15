// Precompute scenario-preset variants of the in-house redraft projections into
// a committed file the MCP serves. Presets that depend on the consensus blend
// are computed HERE, at build time, so only the derived (blended) numbers are
// committed — the raw third-party (Clay) inputs are read locally and never
// leave this script. Re-run after refreshing redraft-projections.json or the
// Clay input.
//
//   node scripts/precompute-projection-presets.mjs
//
// Output: public/data/redraft-projections-presets.json
//   { season, generatedAt, note, presets: { "consensus": [ {name, position, ppg, recPG} ] } }

import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/user/stathead';
const DATA = path.join(ROOT, 'public/data');
const REDRAFT = path.join(DATA, 'redraft-projections.json');
const OUT = path.join(DATA, 'redraft-projections-presets.json');

// Mirror of the MCP's normalizeNameForMatch so the build-time join matches the
// server's runtime lookups exactly.
function norm(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[.'`’‘]/g, '')
    .replace(/-/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Per-position weight on the consensus blend (5yr study: QB/RB 75%, WR 55%,
// TE 85%). Identical to scenarioPresets.ts CONSENSUS_CLAY_WEIGHT.
const CONSENSUS_WEIGHT = { QB: 0.75, RB: 0.75, WR: 0.55, TE: 0.85 };
const CONSENSUS_WEIGHT_DEFAULT = 0.7;

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function buildConsensus(redraft, clayDoc) {
  // Consensus PPR-level blend, expressed per-game to match our PPG base.
  // blended_ppg = w * clay_ppg + (1-w) * our_ppg, for players present in both
  // sets; players absent from the consensus input keep their base projection
  // (mirrors the engine, where the override only touches matched players).
  const clayPpgByName = new Map();
  for (const p of clayDoc.players) {
    const ff = Number(p.ff_pt);
    const g = Number(p.games) > 0 ? Number(p.games) : 17;
    if (!Number.isFinite(ff)) continue;
    clayPpgByName.set(norm(p.name), ff / g);
  }
  let blended = 0;
  const out = redraft.players.map((p) => {
    const ours = Number(p.ppg);
    const clayPpg = clayPpgByName.get(norm(p.name));
    if (!Number.isFinite(ours) || clayPpg === undefined || clayPpg <= 0) {
      return { name: p.name, position: p.position, ppg: p.ppg, recPG: p.recPG };
    }
    const w = CONSENSUS_WEIGHT[p.position] ?? CONSENSUS_WEIGHT_DEFAULT;
    blended++;
    return {
      name: p.name,
      position: p.position,
      ppg: Math.round((w * clayPpg + (1 - w) * ours) * 10) / 10,
      recPG: p.recPG,
    };
  });
  return { out, blended };
}

function main() {
  const redraft = loadJson(REDRAFT);
  // Consensus input lives alongside redraft as a committed build input; the
  // blend output (below) is the only thing we surface.
  const clayPath = path.join(DATA, `clay-projections-${redraft.season}.json`);
  if (!fs.existsSync(clayPath)) {
    console.error(`No consensus input at ${clayPath}; cannot build consensus preset.`);
    process.exit(1);
  }
  const clayDoc = loadJson(clayPath);

  const { out: consensus, blended } = buildConsensus(redraft, clayDoc);

  const result = {
    season: redraft.season,
    generatedAt: new Date().toISOString(),
    note:
      'Preset-adjusted variants of the in-house redraft projections. ' +
      'Derived StatHead outputs only — consensus is our projection blended ' +
      'toward market consensus via internal per-position weights (QB/RB 75%, ' +
      'WR 55%, TE 85%), not a raw third-party feed.',
    presets: {
      consensus,
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(result) + '\n');
  console.log(`Wrote ${OUT}`);
  console.log(`  consensus: ${consensus.length} players (${blended} blended toward consensus, rest base)`);
}

main();
