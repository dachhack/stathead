// Test script: telling "not published yet" apart from "the fetch broke".
// Run: npx tsx scripts/test-data-availability.ts
//
// Preseason, every nflverse feed derived from games played (snap counts,
// injuries, weekly stats, NGS, charting) 404s for the upcoming season until
// Week 1 is in the books. Views should say so rather than show fetch-failure
// text. The risk in that change is the opposite error: swallowing a real
// outage as "not published". These checks pin both directions.
import { DataUnavailableError, isNotPublished } from '../src/data';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean) {
  if (cond) { passed++; return; }
  failures.push(name);
}

// ── the case the empty state is for ──
check('a 404 reads as not-published', isNotPublished(new DataUnavailableError('/data/snap_counts_2026.csv', 404)));

// ── everything else must still surface as a real error ──
// If any of these flip, an outage renders as a friendly "no data yet" and
// nobody finds out the site is broken.
check('a 500 is a real failure', !isNotPublished(new DataUnavailableError('/data/x.csv', 500)));
check('a 403 is a real failure', !isNotPublished(new DataUnavailableError('/data/x.csv', 403)));
check('a 502 is a real failure', !isNotPublished(new DataUnavailableError('/data/x.csv', 502)));
check('a bare Error is a real failure', !isNotPublished(new Error('Failed to fetch /data/x: 404')));
check('an abort is a real failure', !isNotPublished(new DOMException('aborted', 'AbortError')));
check('a non-error value is handled', !isNotPublished(undefined));
check('a string is handled', !isNotPublished('404'));

// ── the error stays diagnosable ──
const e = new DataUnavailableError('/data/snap_counts_2026.csv', 404);
check('extends Error', e instanceof Error);
check('keeps a readable message', e.message === 'Failed to fetch /data/snap_counts_2026.csv: 404');
check('carries the url', e.url === '/data/snap_counts_2026.csv');
check('carries the status', e.status === 404);
check('names itself', e.name === 'DataUnavailableError');

console.log(`\n${passed} checks passed, ${failures.length} failed\n`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
console.log('✓ missing-season data is distinguished from a failed fetch');
