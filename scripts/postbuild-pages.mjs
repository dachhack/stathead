#!/usr/bin/env node
/*
 * Post-build shaping of the static `dist/` so it deploys to hosts with a
 * per-file size cap — Cloudflare Pages rejects any asset over 25 MiB.
 * (GitHub Pages has no such cap, so QA worked without this; we run it on
 * every build so both environments ship identical output.)
 *
 *   1. Prune build-only data the browser never fetches (the cfbd/ season
 *      shards feed feature engineering at build time only — verified no
 *      `data/cfbd/` fetch exists in src/).
 *   2. Gzip the oversized runtime JSON the app loads through the
 *      .gz-aware `tryPreFetched` fallback (it fetches `<file>.gz` and
 *      inflates with DecompressionStream when the raw file is absent).
 *   3. Fail the build if anything still served exceeds the cap — a loud,
 *      early signal instead of a cryptic wrangler upload error.
 */
import { existsSync, rmSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const DIST = 'dist';
const DATA = `${DIST}/data`;
const CAP = 25 * 1024 * 1024; // Cloudflare Pages per-file limit
const mib = (b) => (b / 1048576).toFixed(1);

// 1. Build-only inputs — not fetched by any browser code.
rmSync(`${DATA}/cfbd`, { recursive: true, force: true });

// 2. Oversized runtime files → gzip + drop the raw. Keep this list in sync
//    with files loaded via tryPreFetched (which inflates the .gz sibling).
const GZIP_RUNTIME = ['cfbd-college-stats.json'];
for (const name of GZIP_RUNTIME) {
  const p = `${DATA}/${name}`;
  if (!existsSync(p)) continue;
  const raw = readFileSync(p);
  writeFileSync(`${p}.gz`, gzipSync(raw, { level: 9 }));
  rmSync(p);
  console.log(`postbuild: gzipped ${name} ${mib(raw.length)} MiB -> ${mib(statSync(`${p}.gz`).size)} MiB`);
}

// 3. Guard: nothing served may exceed the host cap.
const offenders = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const fp = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(fp);
    else if (statSync(fp).size > CAP) offenders.push(`${fp} (${mib(statSync(fp).size)} MiB)`);
  }
};
walk(DIST);
if (offenders.length) {
  console.error(
    `\npostbuild: ${offenders.length} file(s) exceed the ${mib(CAP)} MiB host cap:\n` +
    offenders.map((o) => `  - ${o}`).join('\n') +
    `\nFix: if browser-fetched, add it to GZIP_RUNTIME above and load it via the\n` +
    `tryPreFetched .gz fallback; if build-only, prune it from dist here.\n`,
  );
  process.exit(1);
}
console.log('postbuild: dist is within the host file-size cap.');
