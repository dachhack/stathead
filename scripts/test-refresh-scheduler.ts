// Test script: the refresh-scheduler worker's one-trigger schedule matching.
// Run: npx tsx scripts/test-refresh-scheduler.ts
import { readFileSync } from 'fs';
import * as worker from '../workers/refresh-scheduler/src/index';

// workers/refresh-scheduler has its own package.json, so tsx loads it as
// CommonJS: its exports can arrive on the namespace's default.
type W = typeof worker;
const ns = worker as W & { default?: W };
const mod: W = ns.default && 'SCHEDULES' in ns.default ? ns.default : ns;
const { SCHEDULES, TRIGGER, cronMatches, dueAt } = mod;

let passed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) passed++; else failures.push(`${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`);
};
const at = (iso: string) => new Date(`${iso}Z`);

// wrangler.toml holds exactly the one trigger, equal to TRIGGER.
const toml = readFileSync(new URL('../workers/refresh-scheduler/wrangler.toml', import.meta.url), 'utf8');
const crons = JSON.parse(/^crons\s*=\s*(\[.*\])/m.exec(toml)![1]) as string[];
check('wrangler.toml has the one trigger, equal to TRIGGER', crons.length === 1 && crons[0] === TRIGGER, crons);

// Over a whole day, every minute a schedule matches is a minute the trigger fires.
let missed = 0, fired = 0;
for (let m = 0; m < 24 * 60; m++) {
  const t = new Date(Date.UTC(2026, 9, 22, 0, m));
  const due = dueAt(t);
  if (due.length && !cronMatches(TRIGGER, t)) missed++;
  fired += due.length;
}
check('the trigger covers every scheduled minute', missed === 0, missed);
// 18 h of injury refreshes (11-23, 0-4) x 3 + 4 crawls + yahoo + report + analysis
check('a day dispatches the expected count', fired === 18 * 3 + 4 + 1 + 1 + 1, fired);

const names = (iso: string) => dueAt(at(iso)).flatMap((c) => SCHEDULES[c].workflows).sort();
check('01:23 starts the Sleeper crawl', JSON.stringify(names('2026-10-22T01:23:00')) === '["sleeper-trade-crawl.yml"]', names('2026-10-22T01:23:00'));
check('10:17 starts the trade analysis', JSON.stringify(names('2026-10-22T10:17:00')) === '["trade-db-analysis.yml"]', names('2026-10-22T10:17:00'));
check('13:00 starts the report only', JSON.stringify(names('2026-10-22T13:00:00')) === '["daily-report.yml"]', names('2026-10-22T13:00:00'));
check('13:07 refreshes injuries', JSON.stringify(names('2026-10-22T13:07:00')) === '["refresh-injuries.yml"]', names('2026-10-22T13:07:00'));
check('05:07 is outside the injury hours', names('2026-10-22T05:07:00').length === 0, names('2026-10-22T05:07:00'));
check('00:47 is inside them (0-4 range)', JSON.stringify(names('2026-10-22T00:47:00')) === '["refresh-injuries.yml"]', names('2026-10-22T00:47:00'));
check('13:41 starts the Yahoo crawl', JSON.stringify(names('2026-10-22T13:41:00')) === '["yahoo-trade-crawl.yml"]', names('2026-10-22T13:41:00'));
check('a minute off matches nothing', names('2026-10-22T10:18:00').length === 0);

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
if (failures.length) process.exit(1);
