// Person-period expansion for the abandonment hazard model.
//
// The audited manager-season features are SEASON TOTALS. A season total of how
// much someone transacted is entangled with when they stopped, which is what
// the label reads — so none of them can score a manager mid-season. This module
// is the recomputation that makes them usable: one row per (manager-season,
// week), with every feature built from weeks STRICTLY BEFORE the week being
// scored.
//
// THE INVARIANT: a feature on the row for week w must be unchanged if every
// event from week w onward is deleted. That is not a comment, it is a test —
// see scripts/test-hazard-features.ts, which deletes the future and asserts the
// features are identical.
//
// Why strictly before and not through w: the event at week w IS "no activity
// from w onward". Including week w's own activity in the features would hand
// the model the answer.
//
// Risk set and censoring, per manager-season:
//   F = first active week, L = last active week, H = the season horizon.
//   Rows run w = F+1 .. T. A manager is not at risk of stopping before they
//   have started, and week F+1 is the first week with any history to build on.
//   If H - L >= minTrailing the manager went dark: T = L+1, the first week of
//   the terminal silence, and that row carries event = 1.
//   Otherwise they were still active at the horizon: T = H, every row event = 0
//   (right-censored).
//
// Internal gaps are not events. A manager who goes quiet for six weeks and
// comes back never stopped; the gap becomes a FEATURE (weeksSinceLastTxn),
// which is the whole point of the hazard framing.
//
// ⚠️ AN ARTIFACT OF THIS EVENT DEFINITION, and the reason `feasible` exists.
// The event week is L+1, so every event row has weeksSinceLastTxn == 0 — the
// manager transacted the week before, by construction. Rows in the middle of an
// internal gap have weeksSinceLastTxn > 0 and can NEVER be events. On the real
// population that is 7,928 of 17,621 rows: infeasible by definition.
//
// A model scored over all rows gets that separation for free and reports an
// inflated AUC (0.873 vs 0.767 within the feasible set). It is not leakage —
// no feature sees the future — but it is not skill either. Evaluate on
// `feasible` rows, or the headline number is measuring the event definition
// rather than the model.
//
// This is a property of asking "does the manager stop THIS week". The other
// framing — "will there be no activity from week w through the horizon" — makes
// every week feasible and mid-gap rows genuinely uncertain. That is a different
// target, not a bug fix, so it is a decision rather than a default.
import type { ManagerSeasonEngagement } from './engagement';
import type { TxnEvent } from './sleeper';

export const DEFAULT_MIN_TRAILING = 5;

export interface PersonPeriodRow {
  // identity / grouping
  managerId: string;
  leagueId: string;
  lineageId: string;
  season: string;
  week: number;          // the week whose hazard this row predicts
  event: number;         // 1 = the terminal silence starts here
  // Could this row be an event at all? False mid-gap, where the manager was
  // already silent last week and the event definition (L+1) cannot apply.
  // Evaluate on these rows only; see the artifact note in the header.
  feasible: boolean;

  // ── features, all built from weeks < week ──

  // Baseline hazard shape.
  weekIndex: number;         // the week itself
  weeksSinceStart: number;   // weeks since their first activity

  // The core hazard term.
  weeksSinceLastTxn: number;

  // Running volume.
  txnToDate: number;
  txnPerWeekToDate: number;
  waiverToDate: number;
  freeAgentToDate: number;
  tradeToDate: number;
  failedToDate: number;
  addToDate: number;
  dropToDate: number;
  activeWeeksToDate: number;

  // Running pattern.
  longestGapToDate: number;

  // Not comparable across leagues — budgets vary and the crawl does not capture
  // settings.waiver_budget. Kept so it is available once it can be normalised,
  // and flagged so it is not used before then.
  faabToDate: number;

  // Static league context.
  totalRosters: number;
  isDynasty: number;
  isSuperflex: number;

  // Prior-season behaviour. Strictly earlier seasons only, so it cannot see the
  // season being scored. Absent (null) for a manager's first observed season —
  // null rather than 0, because "no history" is not "a clean history".
  priorSeasonWentDark: number | null;
  priorSeasonsObserved: number;
}

export interface HazardOptions {
  // Last week each season could plausibly have had activity.
  horizonWeek?: number | ((season: string) => number);
  // Trailing silent weeks that count as having gone dark. Matches wentDark.
  minTrailing?: number;
}

export interface ManagerInput {
  managerId: string;
  rows: ManagerSeasonEngagement[];
  events: TxnEvent[];
}

const DEFAULT_HORIZON = 17;

function horizonFor(opts: HazardOptions, season: string): number {
  const h = opts.horizonWeek;
  if (typeof h === 'function') return h(season);
  if (typeof h === 'number') return h;
  return DEFAULT_HORIZON;
}

// Weeks a manager transacted in this league-season, ascending and unique.
function activeWeeksFor(events: TxnEvent[]): number[] {
  return [...new Set(events.map((e) => e.week))].sort((a, b) => a - b);
}

// Did this manager-season end in a terminal silence? Mirrors engagement.wentDark
// but works from the raw weeks, so the two cannot drift apart on rounding.
function darkSeason(activeWeeks: number[], horizon: number, minTrailing: number): boolean {
  if (!activeWeeks.length) return false;
  return horizon - activeWeeks[activeWeeks.length - 1] >= minTrailing;
}

export function personPeriods(input: ManagerInput, opts: HazardOptions = {}): PersonPeriodRow[] {
  const minTrailing = opts.minTrailing ?? DEFAULT_MIN_TRAILING;

  const eventsByLeague = new Map<string, TxnEvent[]>();
  for (const e of input.events) {
    if (!eventsByLeague.has(e.leagueId)) eventsByLeague.set(e.leagueId, []);
    eventsByLeague.get(e.leagueId)!.push(e);
  }

  // Prior-season history, built once. Best ball is excluded from the label, so
  // it is excluded here too — it cannot make a season "dark".
  const seasonDark = new Map<string, boolean[]>();   // season -> per league-season
  for (const row of input.rows) {
    if (row.format.bestBall) continue;
    const evs = eventsByLeague.get(row.leagueId) ?? [];
    const weeks = activeWeeksFor(evs);
    if (!weeks.length) continue;
    const dark = darkSeason(weeks, horizonFor(opts, row.season), minTrailing);
    if (!seasonDark.has(row.season)) seasonDark.set(row.season, []);
    seasonDark.get(row.season)!.push(dark);
  }
  const priorHistory = (season: string) => {
    let dark = 0;
    let total = 0;
    for (const [s, flags] of seasonDark) {
      if (Number(s) >= Number(season)) continue;   // strictly earlier seasons
      for (const f of flags) { total++; if (f) dark++; }
    }
    return { rate: total ? dark / total : null, seasons: total };
  };

  const out: PersonPeriodRow[] = [];

  for (const row of input.rows) {
    // Best ball auto-starts lineups and usually has no waivers: no in-season
    // management is expected, so abandonment does not apply.
    if (row.format.bestBall) continue;

    const evs = eventsByLeague.get(row.leagueId) ?? [];
    const weeks = activeWeeksFor(evs);
    if (!weeks.length) continue;   // a league that never launched, not a quitter

    const horizon = horizonFor(opts, row.season);
    const first = weeks[0];
    const last = weeks[weeks.length - 1];
    const dark = darkSeason(weeks, horizon, minTrailing);
    const terminal = dark ? last + 1 : horizon;
    if (terminal <= first) continue;   // no week at which they were ever at risk

    const prior = priorHistory(row.season);

    // Prefix state, advanced one week at a time. Building it incrementally is
    // what makes the strictly-before guarantee structural rather than a
    // convention someone has to remember.
    let txn = 0, waiver = 0, freeAgent = 0, trade = 0, failed = 0;
    let adds = 0, drops = 0, faab = 0, activeCount = 0;
    let lastActive = first;
    let longestGap = 0;

    const consume = (week: number) => {
      const inWeek = evs.filter((e) => e.week === week);
      if (!inWeek.length) return;
      if (activeCount > 0) longestGap = Math.max(longestGap, week - lastActive - 1);
      activeCount++;
      lastActive = week;
      for (const e of inWeek) {
        txn++;
        if (e.kind === 'waiver') waiver++;
        else if (e.kind === 'free_agent') freeAgent++;
        else if (e.kind === 'trade') trade++;
        if (e.status !== 'complete') failed++;
        adds += e.adds.length;
        drops += e.drops.length;
        faab += e.faabBid;
      }
    };

    // Weeks 1..first are consumed before the first scored week, so every row
    // starts with at least one week of history behind it.
    for (let w = 1; w <= first; w++) consume(w);

    for (let week = first + 1; week <= terminal; week++) {
      const elapsed = week - first;   // weeks of history, >= 1
      out.push({
        managerId: input.managerId,
        leagueId: row.leagueId,
        lineageId: row.lineageId,
        season: row.season,
        week,
        event: dark && week === terminal ? 1 : 0,
        feasible: (week - 1) === lastActive,

        weekIndex: week,
        weeksSinceStart: elapsed,
        weeksSinceLastTxn: (week - 1) - lastActive,

        txnToDate: txn,
        txnPerWeekToDate: txn / elapsed,
        waiverToDate: waiver,
        freeAgentToDate: freeAgent,
        tradeToDate: trade,
        failedToDate: failed,
        addToDate: adds,
        dropToDate: drops,
        activeWeeksToDate: activeCount,
        longestGapToDate: longestGap,
        faabToDate: faab,

        totalRosters: row.totalRosters,
        isDynasty: row.format.type === 'Dynasty' ? 1 : 0,
        isSuperflex: row.format.qb === 'Superflex' ? 1 : 0,

        priorSeasonWentDark: prior.rate,
        priorSeasonsObserved: prior.seasons,
      });

      // Only now fold in the week just scored, so the NEXT row sees it and this
      // one never did.
      consume(week);
    }
  }

  return out;
}

// The feature columns, in a fixed order, excluding identity and the event.
// faabToDate is omitted by default: its scale depends on a league budget the
// crawl does not capture, so it means different things in different leagues.
export const HAZARD_FEATURE_NAMES = [
  'weekIndex',
  'weeksSinceStart',
  'weeksSinceLastTxn',
  'txnToDate',
  'txnPerWeekToDate',
  'waiverToDate',
  'freeAgentToDate',
  'tradeToDate',
  'failedToDate',
  'addToDate',
  'dropToDate',
  'activeWeeksToDate',
  'longestGapToDate',
  'totalRosters',
  'isDynasty',
  'isSuperflex',
  'priorSeasonWentDark',
  'priorSeasonsObserved',
] as const;

export type HazardFeatureName = typeof HAZARD_FEATURE_NAMES[number];

// Design matrix row. A null prior-season rate becomes 0 paired with its
// indicator (priorSeasonsObserved), so "no history" is distinguishable from
// "a clean history" instead of being silently imputed as clean.
export function hazardVector(row: PersonPeriodRow, names: readonly string[] = HAZARD_FEATURE_NAMES): number[] {
  return names.map((n) => {
    const v = (row as unknown as Record<string, number | null>)[n];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  });
}
