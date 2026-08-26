// Test script: transactionsEnabled(), the flag that decides whether a quiet
// league is meaningful or expected.
// Run: npx tsx scripts/test-txn-enabled.ts
//
// Getting this wrong in the permissive direction excuses a genuinely dead
// league; getting it wrong in the strict direction floods the audit with false
// alarms. It was wrong for months in a third way: "best ball" was used as a
// proxy for "no waivers", which is false for best-ball dynasty.
import { transactionsEnabled, leagueFormatInfo } from '../src/lib/sleeper';

let passed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean) => { cond ? passed++ : failures.push(name); };

// ── the locked tournament config, the one case that is genuinely off ──
// Measured: 108 crawled leagues carried it, none recorded a waiver or a trade.
check('locked: rolling waivers off + trades disabled',
  transactionsEnabled({ settings: { waiver_type: 0, disable_trades: 1 } }) === false);

// ── everything else transacts ──
// waiver_type 0 alone is NOT off: 18 crawled leagues had it and 61% ran waivers.
check('waiver_type 0 alone still transacts',
  transactionsEnabled({ settings: { waiver_type: 0, disable_trades: 0 } }) === true);
check('trades disabled alone still transacts (waivers remain)',
  transactionsEnabled({ settings: { waiver_type: 2, disable_trades: 1 } }) === true);
check('FAAB waivers with trades on transacts',
  transactionsEnabled({ settings: { waiver_type: 2, disable_trades: 0 } }) === true);

// ── unknown means "assume it counts", so nothing is excused by accident ──
check('no settings at all defaults to enabled', transactionsEnabled({}) === true);
check('null league defaults to enabled', transactionsEnabled(null) === true);
check('undefined defaults to enabled', transactionsEnabled(undefined) === true);
check('partial settings default to enabled',
  transactionsEnabled({ settings: { waiver_type: 0 } }) === true);

// ── best ball is orthogonal: it removes the lineup, not the waiver wire ──
const bbDynasty = leagueFormatInfo({
  settings: { type: 2, best_ball: 1, waiver_type: 2, disable_trades: 0 },
  roster_positions: ['QB', 'RB', 'WR', 'TE'],
});
check('best-ball dynasty with waivers: bestBall true', bbDynasty.bestBall === true);
check('best-ball dynasty with waivers: txnEnabled true', bbDynasty.txnEnabled === true);

const bbTourney = leagueFormatInfo({
  settings: { type: 0, best_ball: 1, waiver_type: 0, disable_trades: 1 },
  roster_positions: ['QB', 'RB', 'WR', 'TE'],
});
check('best-ball tournament: bestBall true', bbTourney.bestBall === true);
check('best-ball tournament: txnEnabled false', bbTourney.txnEnabled === false);

const stdDynasty = leagueFormatInfo({
  settings: { type: 2, best_ball: 0, waiver_type: 2, disable_trades: 0 },
  roster_positions: ['QB', 'RB', 'WR', 'TE'],
});
check('standard dynasty: txnEnabled true', stdDynasty.txnEnabled === true);
check('standard dynasty: bestBall false', stdDynasty.bestBall === false);

console.log(`\n${passed} checks passed, ${failures.length} failed\n`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
console.log('✓ transaction-capability detection behaves as specified');
