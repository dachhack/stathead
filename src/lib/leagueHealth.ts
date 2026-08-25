// League health — per-manager abandonment risk for one league.
//
// Framing matters here, so it is stated once: this exists to help a
// commissioner see which teams need a check-in or a replacement before next
// season. It is not a tool for finding opponents to take advantage of, and the
// UI should not present it as one.
//
// The scoring path goes through the same personPeriods code the model was
// trained on. A second implementation of the features is how an app and its
// model quietly stop agreeing.
import { fetchLeagueTransactions, txnEventFor, leagueFormatInfo, type LeagueImport, type TxnEvent, type TxnContext, type LeagueSeasonRecord } from './sleeper';
import { managerSeasonEngagement } from './engagement';
import { asOfRows, DEFAULT_MIN_TRAILING, type PersonPeriodRow } from './hazardFeatures';
import { hazard, type AbandonmentModel } from './abandonmentModel';

// Where the model came from. Fitted weights only — no per-manager data — so it
// ships with the app; see docs/sleeper-engagement-model.md.
const MODEL_URL = 'data/abandonment-model-v1.json';

interface RawModelFile {
  model: string;
  version: number;
  featureNames: string[];
  mean: number[];
  sd: number[];
  intercept: number;
  coefficients: number[];
  weighting: string;
  lambda: number;
}

export async function fetchAbandonmentModel(baseUrl: string): Promise<AbandonmentModel> {
  const res = await fetch(`${baseUrl}${MODEL_URL}`);
  if (!res.ok) throw new Error(`Abandonment model unavailable (${res.status}).`);
  const raw = (await res.json()) as RawModelFile;
  if (!raw.featureNames?.length || raw.coefficients?.length !== raw.featureNames.length) {
    throw new Error('Abandonment model file is malformed.');
  }
  return {
    featureNames: raw.featureNames,
    mean: raw.mean,
    sd: raw.sd,
    intercept: raw.intercept,
    coefficients: raw.coefficients,
    weighting: raw.weighting === 'manager' ? 'manager' : 'none',
    lambda: raw.lambda,
    converged: true,
    trainedOn: { rows: 0, managers: 0, events: 0, effectiveRows: 0 },
  };
}

export type HealthStatus = 'active' | 'quiet' | 'at-risk' | 'gone';

export interface ManagerHealth {
  rosterId: number;
  teamName: string;
  owner: string;
  ownerId: string | null;
  // Weekly hazard from the model: P(this is the week they stop), given they
  // have not stopped yet. Calibrated, so it can be shown as a percentage.
  risk: number | null;
  status: HealthStatus;
  lastActiveWeek: number | null;
  weeksSilent: number | null;
  transactions: number;
  // Why the row reads the way it does, in one line, for the UI.
  reason: string;
}

export interface LeagueHealth {
  season: string;
  // The last week anything happened anywhere in the league. Derived from the
  // data rather than a calendar, so it needs no notion of "today".
  observedWeek: number;
  managers: ManagerHealth[];
  atRisk: number;
  gone: number;
  // Set when the model does not apply to this league at all.
  notApplicable: string | null;
  weeksFailed: number;
}

// Thresholds on a calibrated weekly hazard. The base rate in training was 4.3%,
// so 'at-risk' is roughly triple the typical week and 'quiet' is above average
// without being alarming. They are bands for a human reader, not decisions.
const AT_RISK = 0.15;
const QUIET = 0.06;

export function classify(risk: number | null, weeksSilent: number | null, minTrailing = DEFAULT_MIN_TRAILING): HealthStatus {
  if (weeksSilent !== null && weeksSilent >= minTrailing) return 'gone';
  if (risk === null) return 'active';
  if (risk >= AT_RISK) return 'at-risk';
  if (risk >= QUIET) return 'quiet';
  return 'active';
}

function reasonFor(h: Omit<ManagerHealth, 'reason'>, minTrailing: number): string {
  if (h.status === 'gone') {
    return `No transactions for ${h.weeksSilent} weeks — already disengaged.`;
  }
  if (h.transactions === 0) return 'No transactions at all this season.';
  if (h.status === 'at-risk') {
    return `${h.weeksSilent === 0 ? 'Active last week' : `Silent ${h.weeksSilent} week${h.weeksSilent === 1 ? '' : 's'}`}, but the pattern resembles managers who stopped.`;
  }
  if (h.status === 'quiet') return `Slowing down — ${h.transactions} transactions, last in week ${h.lastActiveWeek}.`;
  return `Active — ${h.transactions} transactions, last in week ${h.lastActiveWeek}.`;
  void minTrailing;
}

// Score every manager in a league. `data` is what importLeague already returns,
// so the panel reuses the league fetch the view has done.
export async function computeLeagueHealth(
  data: LeagueImport,
  model: AbandonmentModel,
  opts: { minTrailing?: number } = {},
): Promise<LeagueHealth> {
  const minTrailing = opts.minTrailing ?? DEFAULT_MIN_TRAILING;
  const format = leagueFormatInfo(data.league);
  const season = data.league.season;

  if (format.bestBall) {
    return {
      season, observedWeek: 0, managers: [], atRisk: 0, gone: 0, weeksFailed: 0,
      notApplicable: 'Best ball sets lineups automatically and usually has no waivers, so there is no in-season activity to read. The model excludes it.',
    };
  }

  const { byWeek, weeksFailed } = await fetchLeagueTransactions(data.league.league_id);
  const observedWeek = byWeek.reduce((max, w) => (w.txns.length ? Math.max(max, w.week) : max), 0);

  if (observedWeek < 2) {
    return {
      season, observedWeek, managers: [], atRisk: 0, gone: 0, weeksFailed,
      notApplicable: observedWeek === 0
        ? 'No transactions recorded in this league yet, so there is nothing to read.'
        : 'Only one week of activity so far — too early to say anything useful.',
    };
  }

  const managers: ManagerHealth[] = data.teams.map((team) => {
    const events: TxnEvent[] = [];
    for (const { week, txns } of byWeek) {
      const ctx: TxnContext = { leagueId: data.league.league_id, leagueName: data.league.name, season, week };
      for (const t of txns) {
        const ev = txnEventFor(t, team.rosterId, ctx);
        if (ev) events.push(ev);
      }
    }

    const history: LeagueSeasonRecord[] = [{
      season,
      leagueId: data.league.league_id,
      previousLeagueId: data.league.previous_league_id ?? null,
      leagueName: data.league.name,
      status: data.league.status,
      format,
      totalRosters: data.league.total_rosters,
      rosterId: team.rosterId,
      wins: team.wins,
      losses: team.losses,
      ties: team.ties,
      pointsFor: team.pointsFor,
      regSeasonRank: 0,
      champion: false,
      runnerUp: false,
      players: [...team.starters, ...team.bench].map((p) => p.id),
    }];

    const weeks = [...new Set(events.map((e) => e.week))].sort((a, b) => a - b);
    const lastActiveWeek = weeks.length ? weeks[weeks.length - 1] : null;
    const weeksSilent = lastActiveWeek === null ? null : observedWeek - lastActiveWeek;

    let risk: number | null = null;
    if (weeks.length) {
      const rows: PersonPeriodRow[] = asOfRows(
        { managerId: String(team.rosterId), rows: managerSeasonEngagement(history, events, { horizonWeek: observedWeek + minTrailing - 1 }), events },
        observedWeek,
        { minTrailing },
      );
      if (rows.length) risk = hazard(model, rows[0]);
    }

    const partial: Omit<ManagerHealth, 'reason'> = {
      rosterId: team.rosterId,
      teamName: team.teamName,
      owner: team.owner,
      ownerId: team.ownerId,
      risk,
      status: classify(risk, weeksSilent, minTrailing),
      lastActiveWeek,
      weeksSilent,
      transactions: events.length,
    };
    return { ...partial, reason: reasonFor(partial, minTrailing) };
  });

  // Worst first — the panel is a to-do list, not a leaderboard.
  const rank: Record<HealthStatus, number> = { gone: 0, 'at-risk': 1, quiet: 2, active: 3 };
  managers.sort((a, b) => rank[a.status] - rank[b.status] || (b.risk ?? -1) - (a.risk ?? -1));

  return {
    season,
    observedWeek,
    managers,
    atRisk: managers.filter((m) => m.status === 'at-risk').length,
    gone: managers.filter((m) => m.status === 'gone').length,
    notApplicable: null,
    weeksFailed,
  };
}
