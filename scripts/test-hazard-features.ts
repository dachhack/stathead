// Test script: person-period expansion for the abandonment hazard model.
// Run: npx tsx scripts/test-hazard-features.ts
//
// The centrepiece is the future-deletion test: for every row at week w, delete
// every event from week w onward and assert the features are byte-identical.
// That is a direct check of the leakage-free property rather than a reading of
// the code.
import { personPeriods, asOfRows, hazardVector, HAZARD_FEATURE_NAMES, type ManagerInput, type HazardOptions } from '../src/lib/hazardFeatures';
import { classify } from '../src/lib/leagueHealth';
import { managerSeasonEngagement } from '../src/lib/engagement';
import type { LeagueSeasonRecord, TxnEvent, LeagueFormatInfo } from '../src/lib/sleeper';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; return; }
  failures.push(`${name}${detail === undefined ? '' : ` — got ${JSON.stringify(detail)}`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), actual);
}

const FMT = (o: Partial<LeagueFormatInfo> = {}): LeagueFormatInfo =>
  ({ type: 'Redraft', qb: '1QB', bestBall: false, idp: false, ...o });

const hist = (o: Partial<LeagueSeasonRecord>): LeagueSeasonRecord => ({
  season: '2024', leagueId: 'L1', previousLeagueId: null, leagueName: 'L', status: 'complete',
  format: FMT(), totalRosters: 12, rosterId: 1, wins: 7, losses: 7, ties: 0, pointsFor: 1500,
  regSeasonRank: 5, champion: false, runnerUp: false, players: [], ...o,
});

const ev = (o: Partial<TxnEvent>): TxnEvent => ({
  leagueId: 'L1', season: '2024', week: 1, created: 0, kind: 'free_agent',
  status: 'complete', adds: [], drops: [], faabBid: 0, partners: [], ...o,
});

function build(weeks: number[], o: { season?: string; leagueId?: string; format?: Partial<LeagueFormatInfo> } = {}) {
  const season = o.season ?? '2024';
  const leagueId = o.leagueId ?? 'L1';
  const history = [hist({ season, leagueId, format: FMT(o.format) })];
  const events = weeks.map((w) => ev({ week: w, season, leagueId }));
  return { history, events, rows: managerSeasonEngagement(history, events, { horizonWeek: 17 }) };
}
const input = (b: ReturnType<typeof build>, managerId = 'm1'): ManagerInput =>
  ({ managerId, rows: b.rows, events: b.events });

// ── 1. risk set and censoring, under the EVENT framing ──
{
  const EV: HazardOptions = { horizonWeek: 17, target: 'stops-this-week' };
  // Active weeks 1-3 then silence to the horizon: went dark, event at week 4.
  const dark = personPeriods(input(build([1, 2, 3])), EV);
  eq('risk set: runs from the week after the first activity to the event', dark.map((r) => r.week), [2, 3, 4]);
  eq('risk set: exactly one event, on the first silent week', dark.map((r) => r.event), [0, 0, 1]);

  // Active to week 16: still going at the horizon, so every row is censored.
  const alive = personPeriods(input(build([1, 5, 9, 16])), EV);
  eq('censoring: rows run to the horizon', alive[alive.length - 1].week, 17);
  eq('censoring: no event is recorded', alive.filter((r) => r.event === 1).length, 0);
  eq('censoring: risk starts after the first activity', alive[0].week, 2);

  // An internal gap is not an event — they came back.
  const gapped = personPeriods(input(build([1, 2, 10, 11, 16])), EV);
  eq('gaps: a mid-season silence is not an event', gapped.filter((r) => r.event === 1).length, 0);
  const atNine = gapped.find((r) => r.week === 9)!;
  eq('gaps: the silence becomes a feature instead', atNine.weeksSinceLastTxn, 6);

  // Single active week then gone.
  const oneWeek = personPeriods(input(build([2])), EV);
  eq('risk set: a single active week yields one row', oneWeek.map((r) => r.week), [3]);
  eq('risk set: which is the event', oneWeek[0].event, 1);
}

// ── 2. THE INVARIANT: deleting the future changes nothing ──
{
  // A busy, irregular season so the prefix state is genuinely exercised.
  const weeks = [1, 2, 4, 5, 6, 9, 12, 13, 14];
  const full = build(weeks);
  const rows = personPeriods(input(full), { horizonWeek: 17 });
  check('invariant: there are rows to check', rows.length > 5, rows.length);

  // Deleting the future legitimately changes the RISK SET — the label is
  // defined by when activity stopped, so a truncated season goes dark earlier
  // and some weeks fall outside it. That is the label depending on the future,
  // which is correct. What must not change is the FEATURES on the rows that
  // still exist.
  let mismatches = 0;
  let compared = 0;
  for (const row of rows) {
    const truncatedWeeks = weeks.filter((w) => w < row.week);
    if (!truncatedWeeks.length) continue;
    const rebuilt = personPeriods(input(build(truncatedWeeks)), { horizonWeek: 17 })
      .find((r) => r.week === row.week);
    if (!rebuilt) continue;   // week now outside the truncated risk set
    compared++;
    const a = JSON.stringify(hazardVector(row));
    const b = JSON.stringify(hazardVector(rebuilt));
    if (a !== b) {
      mismatches++;
      if (mismatches === 1) failures.push(`  first mismatch at week ${row.week}: ${a} vs ${b}`);
    }
  }
  eq('invariant: features at week w survive deleting weeks >= w', mismatches, 0);
  check('invariant: and the check was not vacuous', compared >= 8, compared);

  // And the converse — the features DO respond to the past, or the test above
  // would pass on a function that returns constants.
  const sparse = personPeriods(input(build([1])), { horizonWeek: 17 });
  const busy = personPeriods(input(build([1, 2, 3, 4, 5])), { horizonWeek: 17 });
  const sparseAt6 = sparse.find((r) => r.week === 6);
  const busyAt6 = busy.find((r) => r.week === 6)!;
  check('invariant: features are not constant — past activity moves them',
    !sparseAt6 || JSON.stringify(hazardVector(sparseAt6)) !== JSON.stringify(hazardVector(busyAt6)));
}

// ── 3. to-date arithmetic ──
{
  const b = build([1, 3, 4]);
  b.events.push(ev({ week: 3, kind: 'waiver', faabBid: 20, adds: ['p'], status: 'failed' }));
  b.rows = managerSeasonEngagement(b.history, b.events, { horizonWeek: 17 });
  const rows = personPeriods(input(b), { horizonWeek: 17 });

  const at4 = rows.find((r) => r.week === 4)!;
  // Weeks 1 and 3 are behind us: 1 free agent + 1 free agent + 1 failed waiver.
  eq('to-date: transactions counted through week 3', at4.txnToDate, 3);
  eq('to-date: waivers', at4.waiverToDate, 1);
  eq('to-date: failed claims', at4.failedToDate, 1);
  eq('to-date: FAAB', at4.faabToDate, 20);
  eq('to-date: active weeks', at4.activeWeeksToDate, 2);
  eq('to-date: gap between weeks 1 and 3', at4.longestGapToDate, 1);
  eq('to-date: weeks since last transaction', at4.weeksSinceLastTxn, 0);
  eq('to-date: weeks of history', at4.weeksSinceStart, 3);
  eq('to-date: rate over elapsed weeks', at4.txnPerWeekToDate, 1);

  const at2 = rows.find((r) => r.week === 2)!;
  eq('to-date: week 2 sees only week 1', at2.txnToDate, 1);
  eq('to-date: and no gap yet', at2.longestGapToDate, 0);
}

// ── 4. prior seasons are strictly earlier ──
{
  const s2023 = build([1, 2], { season: '2023', leagueId: 'A' });        // dark
  const s2024 = build([1, 5, 9, 16], { season: '2024', leagueId: 'B' }); // survives
  const merged: ManagerInput = {
    managerId: 'm1',
    rows: [...s2023.rows, ...s2024.rows],
    events: [...s2023.events, ...s2024.events],
  };
  const rows = personPeriods(merged, { horizonWeek: 17 });

  const in2023 = rows.filter((r) => r.season === '2023');
  const in2024 = rows.filter((r) => r.season === '2024');
  eq('prior: the first season has no history', in2023[0].priorSeasonWentDark, null);
  eq('prior: and says so rather than imputing zero', in2023[0].priorSeasonsObserved, 0);
  eq('prior: the later season sees the earlier one', in2024[0].priorSeasonWentDark, 1);
  eq('prior: counted', in2024[0].priorSeasonsObserved, 1);
  // The guard that matters: 2023's rows must not see 2023's own outcome.
  check('prior: a season never sees itself', in2023.every((r) => r.priorSeasonWentDark === null));
}

// ── 5. exclusions ──
{
  const bb = build([1, 2], { format: { bestBall: true } });
  eq('exclusions: best ball produces no rows', personPeriods(input(bb), { horizonWeek: 17 }).length, 0);

  const silent = build([]);
  eq('exclusions: a season with no activity produces no rows',
    personPeriods(input(silent), { horizonWeek: 17 }).length, 0);

  // An in-progress season: horizon 1 leaves no week at which anyone is at risk.
  const inProgress = build([1], { season: '2026' });
  eq('exclusions: an unstarted season contributes nothing',
    personPeriods(input(inProgress), { horizonWeek: (s) => (s === '2026' ? 1 : 17) }).length, 0);
}

// ── 5b. the feasibility artifact is exposed, not hidden ──
{
  // The event week is L+1, so an event can only land on a row where the manager
  // transacted last week. Mid-gap rows are infeasible by construction, and a
  // model scored over them gets separation it did not earn.
  const EV: HazardOptions = { horizonWeek: 17, target: 'stops-this-week' };
  const gapped = personPeriods(input(build([1, 2, 10, 11, 16])), EV);
  const feasible = gapped.filter((r) => r.feasible);
  const infeasible = gapped.filter((r) => !r.feasible);
  check('feasibility: mid-gap rows are marked infeasible', infeasible.length > 0, gapped.length);
  check('feasibility: a row right after activity is feasible', feasible.length > 0);
  eq('feasibility: feasible means silent-for-zero-weeks',
    feasible.every((r) => r.weeksSinceLastTxn === 0), true);
  eq('feasibility: infeasible means already silent',
    infeasible.every((r) => r.weeksSinceLastTxn > 0), true);

  // The property that matters: no infeasible row is ever an event.
  const dark = personPeriods(input(build([1, 2, 4, 5, 9])), EV);
  eq('feasibility: no infeasible row carries an event',
    dark.filter((r) => !r.feasible && r.event === 1).length, 0);
  eq('feasibility: the event row is feasible',
    dark.filter((r) => r.event === 1).every((r) => r.feasible), true);
}

// ── 5c. the default target: is the manager already done? ──
{
  // "Is there any activity from week w to the end of the season" is a state,
  // askable at any week — including mid-gap, where the event framing has
  // nothing to say. It is the product question and it has no infeasible rows.
  const gapped = personPeriods(input(build([1, 2, 10, 11, 16])), { horizonWeek: 17 });
  check('default: every row is answerable', gapped.every((r) => r.feasible), gapped.length);
  eq('default: a manager who returns is never positive',
    gapped.filter((r) => r.event === 1).length, 0);
  const midGap = gapped.find((r) => r.week === 6)!;
  eq('default: mid-gap is scored, and correctly negative — they come back', midGap.event, 0);
  // Last activity was week 2; weeks 3, 4 and 5 are behind us and silent.
  eq('default: while still recording the silence', midGap.weeksSinceLastTxn, 3);

  // Someone who stops for good is positive from the week after their last move.
  const quit = personPeriods(input(build([1, 2, 3])), { horizonWeek: 17 });
  eq('default: negative while activity remains ahead', quit.filter((r) => r.week <= 3).every((r) => r.event === 0), true);
  eq('default: positive once nothing remains', quit.filter((r) => r.week > 3).every((r) => r.event === 1), true);

  // The runway guard: scoring stops once fewer than minTrailing weeks remain,
  // because near the horizon "gone" is indistinguishable from a quiet fortnight
  // — and those weeks are dominated by managers simply out of contention.
  eq('default: scoring stops with less than minTrailing weeks left',
    Math.max(...quit.map((r) => r.week)), 13);
  const shortRunway = personPeriods(input(build([1, 2, 3])), { horizonWeek: 17, minTrailing: 2 });
  eq('default: the guard follows minTrailing', Math.max(...shortRunway.map((r) => r.week)), 16);

  // A manager active to the end is never positive.
  const steady = personPeriods(input(build([1, 5, 9, 14, 16])), { horizonWeek: 17 });
  eq('default: an engaged manager is negative throughout',
    steady.filter((r) => r.event === 1).length, 0);
}

// ── 6. the vector ──
{
  const rows = personPeriods(input(build([1, 2, 3])), { horizonWeek: 17 });
  const v = hazardVector(rows[0]);
  eq('vector: one column per declared name', v.length, HAZARD_FEATURE_NAMES.length);
  check('vector: every column is finite', v.every((x) => Number.isFinite(x)), v);
  check('vector: a null prior rate becomes 0 beside its indicator',
    v[HAZARD_FEATURE_NAMES.indexOf('priorSeasonWentDark')] === 0
    && v[HAZARD_FEATURE_NAMES.indexOf('priorSeasonsObserved')] === 0);
  check('vector: faabToDate is excluded — its scale is league-dependent',
    !(HAZARD_FEATURE_NAMES as readonly string[]).includes('faabToDate'));
}

// ── 7. scoring a live season ──
{
  // Training truncates the risk window near the horizon so a late silence is
  // not mislabelled. Scoring has no label to protect, so asOfRows must return
  // the requested week however late it is.
  const weeks = [1, 2, 3, 5, 8];
  const b = build(weeks);
  const at9 = asOfRows(input(b), 9, {});
  eq('as-of: one row for the requested week', at9.length, 1);
  eq('as-of: it is the requested week', at9[0].week, 9);
  eq('as-of: features are built from weeks before it', at9[0].txnToDate, weeks.length);
  eq('as-of: silence measured to the week before', at9[0].weeksSinceLastTxn, 0);

  // A manager who has ALREADY been silent past the threshold has, under this
  // failure definition, already failed — there is no hazard left to predict, so
  // no row comes back. The caller reports "gone" from the observed silence
  // instead of asking the model. This is behaviour to rely on, not a gap.
  const longGone = asOfRows(input(build([1, 2, 3])), 9, {});
  eq('as-of: no row once the manager has already gone dark', longGone.length, 0);

  // The event field carries no meaning at scoring time and must not be read.
  eq('as-of: the outcome is zeroed, not guessed', at9[0].event, 0);

  // Same feature code as training: the row at a week both paths emit must match.
  const shared = 5;
  const fromTraining = personPeriods(input(b), { horizonWeek: 17, target: 'stops-this-week' })
    .find((r) => r.week === shared)!;
  const fromScoring = asOfRows(input(b), shared, {})[0];
  eq('as-of: identical features to the training path at the same week',
    JSON.stringify(hazardVector(fromScoring)), JSON.stringify(hazardVector(fromTraining)));
}

// ── 8. league-health status bands ──
{
  // Bands sit on a calibrated weekly hazard whose training base rate was 4.3%.
  eq('bands: sustained silence is already gone, whatever the hazard says', classify(0.01, 5), 'gone');
  eq('bands: a high hazard is at risk', classify(0.2, 0), 'at-risk');
  eq('bands: a moderate hazard is quiet', classify(0.08, 1), 'quiet');
  eq('bands: a low hazard is active', classify(0.01, 0), 'active');
  eq('bands: no hazard yet reads as active, not as risk', classify(null, 0), 'active');
  // "Gone" is a fact about the data, so it outranks the model's opinion.
  eq('bands: observed silence outranks a low model score', classify(0.001, 6), 'gone');
  eq('bands: the silence threshold follows minTrailing', classify(0.001, 3, 3), 'gone');
}

console.log(`\n${passed} checks passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('✓ person-period features are built strictly from the past');
