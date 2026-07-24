/**
 * Parse the Footballguys SFB cheatsheet (pdftotext -layout output) into the
 * local-only JSON the SFB16 Cheatsheet research tab consumes. The source is
 * a paid product — the output must never be committed (see .gitignore).
 *
 * Usage:
 *   pdftotext -layout Cheatsheet_for_Scott_Fish_Bowl.pdf - \
 *     | npx tsx scripts/parse-sfb-cheatsheet.ts > public/data/sfb16-cheatsheet.json
 *
 * Positions for the combined RB/WR/TE flex list are resolved from committed
 * lookups (sleeper-players.json, then the projection base pool) when those
 * files are present locally; the sheet itself only carries positions for
 * its overall top 60.
 */
import { readFileSync, existsSync } from 'fs';
import { parseCheatsheetText, resolvePositions, normalizeCheatsheetName } from '../src/lib/sfbCheatsheet';

const input = readFileSync(process.argv[2] ?? 0, 'utf8'); // file arg or stdin
const doc = parseCheatsheetText(input);

// Position lookup from committed data files (best-effort).
const posByName = new Map<string, string>();
try {
  if (existsSync('public/data/projection-base-2026.json')) {
    const base = JSON.parse(readFileSync('public/data/projection-base-2026.json', 'utf8'));
    for (const [arr, pos] of [[base.rbs, 'RB'], [base.wrs, 'WR'], [base.tes, 'TE'], [base.qbs, 'QB']] as const) {
      for (const p of arr ?? []) posByName.set(normalizeCheatsheetName(p.name), pos);
    }
  }
  if (existsSync('public/data/sleeper-players.json')) {
    const sleeper = JSON.parse(readFileSync('public/data/sleeper-players.json', 'utf8'));
    for (const p of sleeper.players ?? []) {
      const key = normalizeCheatsheetName(String(p.name ?? ''));
      if (key && p.position && !posByName.has(key)) posByName.set(key, String(p.position));
    }
  }
} catch (e) {
  console.error('position lookup failed (continuing without):', e);
}
resolvePositions(doc, posByName);

// Validation: both lists must be rank-contiguous or the column detection broke.
for (const [label, arr] of [['qbs', doc.qbs], ['flex', doc.flex]] as const) {
  const gaps = arr.filter((p, i) => p.rank !== i + 1).length;
  const unresolved = arr.filter((p) => !p.position).length;
  console.error(`${label}: ${arr.length} players, ${gaps} rank gaps, ${unresolved} without position`);
  if (gaps > 0) {
    const firstGap = arr.findIndex((p, i) => p.rank !== i + 1);
    console.error(`  first gap at index ${firstGap}: expected ${firstGap + 1}, got ${arr[firstGap]?.rank} (${arr[firstGap]?.name})`);
  }
}
console.error(`overall ranks joined: ${[...doc.qbs, ...doc.flex].filter((p) => p.overallRank).length}`);

process.stdout.write(JSON.stringify(doc, null, 1) + '\n');
