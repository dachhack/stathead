// Per-member departure risk for a dynasty league, scored live from a league id.
//
// WHAT IT COSTS. Roughly 80-90 Sleeper requests for a 12-team league:
//   ~5   walking previous_league_id back through the lineage
//   ~5   one rosters call per prior season, for membership history
//   ~72  one portfolio call per member per season (12 x 6)
// A few seconds at modest concurrency.
//
// THE FEATURE THAT DOES NOT SURVIVE THE TRIP. priorLeaveRate is the model's
// strongest input, and computing it properly needs to know whether a manager's
// OTHER leagues carried on after they left — which their own portfolio cannot
// say, because once they leave, the successor league never appears in it.
// Offline that is resolved by pooling 1,723 portfolios. Live it is not, so this
// uses the approximation: any disappearance from a lineage counts as a
// departure, without verifying the league survived.
//
// That blurring costs real accuracy, and the numbers are worth knowing before
// trusting a grade (cross-validated, grouped by manager):
//
//   feature set    AUC     Q1 actual   Q5 actual   monotone?
//   full           0.644     7.1%        27.2%     yes
//   live-approx    0.604     9.6%        23.5%     yes   <- what ships
//   no prior       0.562    10.6%        17.0%     NO
//
// Dropping the feature entirely breaks the ranking at the top, which is the end
// that matters, so the approximation is the right trade.
import { leagueFormatInfo, type SleeperLeagueInfo } from './sleeper';

const SLEEPER = 'https://api.sleeper.app/v1';
const MODEL_URL = 'data/dynasty-departure-v1.json';

export interface DepartureModel {
  featureNames: string[];
  intercept: number;
  coefficients: number[];
  mean: number[];
  sd: number[];
  // Fixed thresholds from the training population, NOT computed within a league.
  // Grading relative to the twelve managers in front of you guarantees a grade 5
  // even in a perfectly stable league, and a grade 1 in a collapsing one.
  gradeCutpoints: number[];
  heldOut?: { auc: number; calibrationSlope: number; ece: number };
}

export async function fetchDepartureModel(baseUrl: string): Promise<DepartureModel> {
  const res = await fetch(`${baseUrl}${MODEL_URL}`);
  if (!res.ok) throw new Error(`Departure model unavailable (${res.status}).`);
  const m = (await res.json()) as DepartureModel;
  if (!m.featureNames?.length || m.coefficients?.length !== m.featureNames.length) {
    throw new Error('Departure model file is malformed.');
  }
  if (!Array.isArray(m.gradeCutpoints) || m.gradeCutpoints.length !== 4) {
    throw new Error('Departure model is missing its grade cutpoints.');
  }
  return m;
}

// 1 = most likely to stay, 5 = most likely to leave.
export type Grade = 1 | 2 | 3 | 4 | 5;

export function gradeFor(risk: number, cutpoints: number[]): Grade {
  let g = 1;
  for (const c of cutpoints) if (risk >= c) g++;
  return Math.min(5, g) as Grade;
}

export const GRADE_LABEL: Record<Grade, string> = {
  1: 'Anchor',
  2: 'Settled',
  3: 'Typical',
  4: 'Loosening',
  5: 'Flight risk',
};

// ── league-side inputs ──

interface RawLeague extends SleeperLeagueInfo { sport?: string }
interface RawRoster { owner_id: string | null }

export interface DepartureDeps {
  getJson: (path: string) => Promise<unknown>;
}

const liveDeps: DepartureDeps = {
  getJson: async (path) => {
    const r = await fetch(`${SLEEPER}${path}`);
    if (!r.ok) throw new Error(`Sleeper returned ${r.status}`);
    return r.json();
  },
};

export interface MemberRisk {
  ownerId: string;
  risk: number;
  grade: Grade;
  gradeLabel: string;
  tenureYears: number;
  tenureCensored: boolean;
  isNewMember: boolean;
  portfolioSize: number;
  dynastyLineages: number;
  seasonsActive: number;
  priorLeaveRate: number;
  priorLeaveObserved: number;
}

export interface LeagueDepartureReport {
  leagueId: string;
  season: string;
  seasonsWalked: string[];
  members: MemberRisk[];
  requests: number;
  notApplicable: string | null;
}

// Walk previous_league_id back, then score every current member.
export async function scoreDynastyLeague(
  leagueId: string,
  model: DepartureModel,
  opts: { seasons?: number; deps?: DepartureDeps } = {},
): Promise<LeagueDepartureReport> {
  const deps = opts.deps ?? liveDeps;
  const lookback = opts.seasons ?? 6;
  let requests = 0;
  const get = async <T>(path: string): Promise<T | null> => {
    requests++;
    try { return (await deps.getJson(path)) as T; } catch { return null; }
  };

  const league = await get<RawLeague>(`/league/${leagueId}`);
  if (!league?.league_id) {
    return { leagueId, season: '', seasonsWalked: [], members: [], requests, notApplicable: 'League not found.' };
  }
  const format = leagueFormatInfo(league);
  if (format.type !== 'Dynasty' || format.bestBall) {
    return {
      leagueId, season: league.season, seasonsWalked: [], members: [], requests,
      notApplicable: `This is a ${format.bestBall ? 'best ball' : format.type.toLowerCase()} league. The model is dynasty-only: redraft groups often recreate leagues from scratch, so previous_league_id says nothing about whether the same people came back.`,
    };
  }

  // Lineage chain, newest first.
  const chain: { leagueId: string; season: number }[] = [{ leagueId: league.league_id, season: Number(league.season) }];
  let cursor = league.previous_league_id;
  while (cursor && cursor !== '0' && chain.length < lookback) {
    const prev = await get<RawLeague>(`/league/${cursor}`);
    if (!prev?.league_id) break;
    chain.push({ leagueId: prev.league_id, season: Number(prev.season) });
    cursor = prev.previous_league_id;
  }
  // The chain still points further back than we followed, so anyone present in
  // the earliest season we walked may have been there longer than we can see.
  const chainTruncated = !!cursor && cursor !== '0';
  const earliestWalked = Math.min(...chain.map((c) => c.season));

  // Membership per season in the chain.
  const membersBySeason = new Map<number, Set<string>>();
  for (const link of chain) {
    const rosters = await get<RawRoster[]>(`/league/${link.leagueId}/rosters`);
    const set = new Set<string>();
    for (const r of rosters ?? []) if (r.owner_id) set.add(r.owner_id);
    membersBySeason.set(link.season, set);
  }

  const thisSeason = Number(league.season);
  const current = [...(membersBySeason.get(thisSeason) ?? [])];
  const seasonsToFetch = Array.from({ length: lookback }, (_, i) => thisSeason - i);

  // Each member's portfolio across the window.
  interface Portfolio { leagueId: string; previousLeagueId: string | null; season: number; dynasty: boolean; bestBall: boolean }
  const portfolios = new Map<string, Portfolio[]>();
  await Promise.all(current.map(async (ownerId) => {
    const entries: Portfolio[] = [];
    for (const season of seasonsToFetch) {
      const leagues = await get<RawLeague[]>(`/user/${ownerId}/leagues/nfl/${season}`);
      for (const lg of leagues ?? []) {
        if (lg.sport && lg.sport !== 'nfl') continue;
        const f = leagueFormatInfo(lg);
        entries.push({
          leagueId: lg.league_id,
          previousLeagueId: lg.previous_league_id && lg.previous_league_id !== '0' ? lg.previous_league_id : null,
          season: Number(lg.season ?? season),
          dynasty: f.type === 'Dynasty' && !f.bestBall,
          bestBall: f.bestBall,
        });
      }
    }
    portfolios.set(ownerId, entries);
  }));

  const members: MemberRisk[] = current.map((ownerId) => {
    const entries = portfolios.get(ownerId) ?? [];
    const inSeason = entries.filter((e) => e.season === thisSeason);
    const portfolioSize = Math.max(1, inSeason.length);
    const bestBallCount = inSeason.filter((e) => e.bestBall).length;

    // Lineages from this member's own dynasty entries: chain by
    // previous_league_id within their portfolio.
    const byId = new Map(entries.filter((e) => e.dynasty).map((e) => [e.leagueId, e]));
    const rootOf = (id: string): string => {
      let cur = id;
      const seen = new Set<string>();
      for (;;) {
        const e = byId.get(cur);
        if (!e?.previousLeagueId || seen.has(cur)) return cur;
        seen.add(cur);
        if (!byId.has(e.previousLeagueId)) return e.previousLeagueId;
        cur = e.previousLeagueId;
      }
    };
    const own = [...byId.values()].map((e) => ({ lineage: rootOf(e.leagueId), season: e.season }));
    const ownKeys = new Set(own.map((o) => `${o.lineage}|${o.season}`));
    const dynastyLineages = new Set(own.filter((o) => o.season === thisSeason).map((o) => o.lineage)).size || 1;

    // The approximation: a disappearance is a departure, unverified.
    const prior = own.filter((o) => o.season < thisSeason);
    const priorLeft = prior.filter((o) => !ownKeys.has(`${o.lineage}|${o.season + 1}`)).length;
    const priorLeaveRate = prior.length ? priorLeft / prior.length : 0;

    // Tenure in THIS league, from the chain's membership.
    let tenureYears = 1;
    while (membersBySeason.get(thisSeason - tenureYears)?.has(ownerId)) tenureYears++;
    // Censored only when the LINEAGE is cut short, not when the portfolio window
    // is: a founding member of a league that genuinely began three years ago has
    // a tenure of exactly three, not "3+".
    const tenureCensored = chainTruncated && thisSeason - tenureYears + 1 <= earliestWalked;
    const isNewMember = !membersBySeason.get(thisSeason - 1)?.has(ownerId);

    const x: Record<string, number> = {
      isNewMember: isNewMember ? 1 : 0,
      tenureYears,
      tenureCensored: tenureCensored ? 1 : 0,
      leagueSize: league.total_rosters,
      portfolioSize,
      logPortfolioSize: Math.log1p(portfolioSize),
      dynastyLineages,
      dynastyShare: dynastyLineages / portfolioSize,
      bestBallShare: bestBallCount / portfolioSize,
      seasonsActive: new Set(entries.map((e) => e.season)).size,
      priorLeaveRate,
      priorLeaveObserved: prior.length,
    };

    let z = model.intercept;
    model.featureNames.forEach((name, j) => {
      const v = Number.isFinite(x[name]) ? x[name] : 0;
      z += model.coefficients[j] * ((v - model.mean[j]) / (model.sd[j] || 1));
    });
    const risk = z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
    const grade = gradeFor(risk, model.gradeCutpoints);

    return {
      ownerId, risk, grade, gradeLabel: GRADE_LABEL[grade],
      tenureYears, tenureCensored, isNewMember,
      portfolioSize, dynastyLineages,
      seasonsActive: x.seasonsActive, priorLeaveRate, priorLeaveObserved: prior.length,
    };
  });

  members.sort((a, b) => b.risk - a.risk);
  return {
    leagueId, season: league.season,
    seasonsWalked: chain.map((c) => String(c.season)).sort(),
    members, requests, notApplicable: null,
  };
}
