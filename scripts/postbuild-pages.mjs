#!/usr/bin/env node
/*
 * Post-build shaping of the static `dist/` so it deploys to hosts with a
 * per-file size cap — Cloudflare Pages rejects any asset over 25 MiB.
 * (GitHub Pages has no such cap, so QA worked without this; we run it on
 * every build so both environments ship identical output.)
 *
 *   1. Prune build-only data the browser never fetches (the cfbd/ season
 *      shards feed feature engineering at build time only — verified no
 *      `data/cfbd/` fetch in src/).
 *   2. Gzip the oversized files the app loads through a .gz-aware loader,
 *      dropping the raw:
 *        - large CSVs (play-by-play, participation, depth charts) →
 *          fetchCsv inflates the `.csv.gz` sibling;
 *        - the listed oversized JSON → tryPreFetched inflates the `.gz`
 *          sibling.
 *      Both fetch the raw path first and fall back to the `.gz` on 404.
 *   3. Fail the build if anything still served exceeds the cap — a loud,
 *      early signal instead of a cryptic wrangler upload error.
 *
 * NOTE: only gzip files whose loader is gz-aware. feature-matrix.json is
 * fetched with a plain `fetch().json()` in several components and stays
 * under the cap, so it is deliberately left raw.
 */
import { existsSync, rmSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const DIST = 'dist';
const DATA = `${DIST}/data`;
const CAP = 25 * 1024 * 1024;        // Cloudflare Pages per-file limit
const CSV_GZIP_OVER = 20 * 1024 * 1024; // gzip CSVs at/over this (well under the cap)
const mib = (b) => (b / 1048576).toFixed(1);

const gzipDrop = (fp) => {
  const raw = readFileSync(fp);
  writeFileSync(`${fp}.gz`, gzipSync(raw, { level: 9 }));
  rmSync(fp);
  console.log(`postbuild: gzipped ${fp.replace(`${DATA}/`, '')} ${mib(raw.length)} MiB -> ${mib(statSync(`${fp}.gz`).size)} MiB`);
};

// 1. Build-only inputs — not fetched by any browser code.
rmSync(`${DATA}/cfbd`, { recursive: true, force: true });

// 2a. Oversized JSON loaded via the gz-aware tryPreFetched fallback.
const GZIP_RUNTIME_JSON = ['cfbd-college-stats.json'];
for (const name of GZIP_RUNTIME_JSON) {
  const p = `${DATA}/${name}`;
  if (existsSync(p)) gzipDrop(p);
}

// 2b. Oversized CSVs loaded via the gz-aware fetchCsv fallback.
const gzipBigCsvs = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const fp = `${dir}/${e.name}`;
    if (e.isDirectory()) gzipBigCsvs(fp);
    else if (e.name.endsWith('.csv') && statSync(fp).size > CSV_GZIP_OVER) gzipDrop(fp);
  }
};
gzipBigCsvs(DATA);

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
    `\nFix: if it's a CSV, fetchCsv already inflates a .csv.gz sibling — lower\n` +
    `CSV_GZIP_OVER or gzip it here. If it's other browser-fetched data, route\n` +
    `it through a gz-aware loader and gzip it; if build-only, prune it.\n`,
  );
  process.exit(1);
}
console.log('postbuild: dist is within the host file-size cap.');
