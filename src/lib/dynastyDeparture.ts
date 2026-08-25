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
// Two fitted models. The approximate one is trained on the blurred feature and
// the verified one on the properly-resolved feature, so each is calibrated to
// the inputs it will actually receive — and each carries its own grade
// cutpoints. Scoring verified features with approximate weights would be a
// quiet mismatch.
const MODEL_URL = 'data/dynasty-departure-v1.json';
const MODEL_URL_VERIFIED = 'data/dynasty-departure-full-v1.json';

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

export async function fetchDepartureModel(baseUrl: string, verified = false): Promise<DepartureModel> {
  const res = await fetch(`${baseUrl}${verified ? MODEL_URL_VERIFIED : MODEL_URL}`);
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

// Whether a given league-season was succeeded by a next-season league.
//
// Cached for the life of the page, and safe to cache forever: whether a 2023
// league rolled into 2024 is settled history. Someone scoring several leagues
// pays for each lineage once.
const survivalCache = new Map<string, boolean>();

export function clearSurvivalCache(): void { survivalCache.clear(); }

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
  // Which feature the past-exit rate came from, and why.
  verification: {
    requested: boolean;
    applied: boolean;
    checked: number;        // distinct (league, season) pairs resolved
    freeFromCoMembers: number;
    fetched: number;
    budgetExhausted: boolean;
    note: string;
  };
}

export interface ScoreOptions {
  seasons?: number;
  deps?: DepartureDeps;
  // Resolve past exits properly instead of approximating. Costs roughly 3.5
  // extra requests per distinct departure — a few hundred for a typical league.
  verify?: boolean;
  // Cap on verification requests. Hitting it falls the WHOLE league back to the
  // approximate feature rather than mixing two definitions across members.
  verifyBudget?: number;
  onProgress?: (message: string) => void;
}

// Walk previous_league_id back, then score every current member.
export async function scoreDynastyLeague(
  leagueId: string,
  model: DepartureModel,
  opts: ScoreOptions = {},
): Promise<LeagueDepartureReport> {
  const deps = opts.deps ?? liveDeps;
  const lookback = opts.seasons ?? 6;
  const verifyBudget = opts.verifyBudget ?? 4000;
  const progress = opts.onProgress ?? (() => {});
  let requests = 0;
  const get = async <T>(path: string): Promise<T | null> => {
    requests++;
    try { return (await deps.getJson(path)) as T; } catch { return null; }
  };

  progress('Loading the league…');
  const league = await get<RawLeague>(`/league/${leagueId}`);
  if (!league?.league_id) {
    return {
      leagueId, season: '', seasonsWalked: [], members: [], requests,
      notApplicable: 'League not found.',
    verification: { requested: !!opts.verify, applied: false, checked: 0, freeFromCoMembers: 0, fetched: 0, budgetExhausted: false, note: 'Not scored.' },
    };
  }
  const format = leagueFormatInfo(league);
  if (format.type !== 'Dynasty' || format.bestBall) {
    return {
      leagueId, season: league.season, seasonsWalked: [], members: [], requests,
      notApplicable: `This is a ${format.bestBall ? 'best ball' : format.type.toLowerCase()} league. The model is dynasty-only: redraft groups often recreate leagues from scratch, so previous_league_id says nothing about whether the same people came back.`,
    verification: { requested: !!opts.verify, applied: false, checked: 0, freeFromCoMembers: 0, fetched: 0, budgetExhausted: false, note: 'Not scored.' },
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

  progress(`Reading ${chain.length} season${chain.length === 1 ? '' : 's'} of membership…`);
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

  progress(`Fetching ${current.length} members' league lists…`);
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

  // ── verification pass ──
  //
  // A departure is only a departure if the league carried on without them. To
  // establish that for league L in season y we need ANY season-y+1 league whose
  // previous_league_id is L — which only the league's own members can show us.
  //
  // Free first: 12 members' portfolios are already in hand, and any of them who
  // were also in L will reveal the successor. That covers ~8% in practice —
  // dynasty league-mates rarely overlap in each other's OTHER dynasty leagues —
  // so the rest need fetching.
  const verifyStats = { checked: 0, free: 0, fetched: 0, exhausted: false };
  const survived = new Map<string, boolean>();   // leagueId (season y) -> carried on

  if (opts.verify) {
    // Every distinct (league, season) any member appears to have left. Deduped
    // across members: several of them may have left the same league.
    const candidates = new Map<string, number>();   // leagueId -> season
    for (const [ownerId, entries] of portfolios) {
      void ownerId;
      const dyn = entries.filter((e) => e.dynasty);
      const seasons = new Set(dyn.map((e) => e.season));
      const latestSeen = Math.max(...seasons, thisSeason);
      // Successor within this member's own portfolio means they stayed.
      const successorOf = new Set(dyn.map((e) => e.previousLeagueId).filter(Boolean) as string[]);
      for (const e of dyn) {
        if (e.season >= latestSeen) continue;
        if (successorOf.has(e.leagueId)) continue;   // they carried it forward
        candidates.set(e.leagueId, e.season);
      }
    }

    // Free pass: does any member's portfolio already name a successor?
    const allEntries = [...portfolios.values()].flat();
    const knownSuccessors = new Set(allEntries.map((e) => e.previousLeagueId).filter(Boolean) as string[]);
    const toFetch: [string, number][] = [];
    for (const [lid, season] of candidates) {
      if (survivalCache.has(lid)) { survived.set(lid, survivalCache.get(lid)!); verifyStats.checked++; continue; }
      if (knownSuccessors.has(lid)) {
        survived.set(lid, true); survivalCache.set(lid, true);
        verifyStats.checked++; verifyStats.free++;
      } else {
        toFetch.push([lid, season]);
      }
    }

    const estimate = toFetch.length * 3;
    if (estimate > verifyBudget) {
      verifyStats.exhausted = true;
    } else {
      let done = 0;
      for (const [lid, season] of toFetch) {
        progress(`Verifying past exits… ${++done} of ${toFetch.length}`);
        const rosters = await get<RawRoster[]>(`/league/${lid}/rosters`);
        const owners = (rosters ?? []).map((r) => r.owner_id).filter((o): o is string => !!o).slice(0, 2);
        let found = false;
        for (const o of owners) {
          const next = await get<RawLeague[]>(`/user/${o}/leagues/nfl/${season + 1}`);
          if ((next ?? []).some((lg) => lg.previous_league_id === lid)) { found = true; break; }
        }
        survived.set(lid, found);
        survivalCache.set(lid, found);
        verifyStats.checked++; verifyStats.fetched++;
      }
    }
  }
  const verifyApplied = !!opts.verify && !verifyStats.exhausted;

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

    // Past exits. Verified: only count a season as at-risk when the league is
    // known to have carried on, which is the definition the offline model was
    // fitted to. Unverified: every disappearance counts, which over-counts by
    // roughly the share of leagues that simply folded.
    const priorAll = own.filter((o) => o.season < thisSeason);
    let prior = priorAll;
    let priorLeft: number;
    if (verifyApplied) {
      const dynById = new Map(entries.filter((e) => e.dynasty).map((e) => [e.leagueId, e]));
      const leagueFor = (lineage: string, season: number) =>
        [...dynById.values()].find((e) => e.season === season && rootOf(e.leagueId) === lineage);
      prior = priorAll.filter((o) => {
        const stayed = ownKeys.has(`${o.lineage}|${o.season + 1}`);
        if (stayed) return true;                      // at risk and they stayed
        const lg = leagueFor(o.lineage, o.season);
        return lg ? survived.get(lg.leagueId) === true : false;   // at risk only if it lived on
      });
      priorLeft = prior.filter((o) => !ownKeys.has(`${o.lineage}|${o.season + 1}`)).length;
    } else {
      priorLeft = priorAll.filter((o) => !ownKeys.has(`${o.lineage}|${o.season + 1}`)).length;
    }
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
    verification: {
      requested: !!opts.verify,
      applied: verifyApplied,
      checked: verifyStats.checked,
      freeFromCoMembers: verifyStats.free,
      fetched: verifyStats.fetched,
      budgetExhausted: verifyStats.exhausted,
      note: !opts.verify
        ? 'Past exits are approximate: any disappearance from a league counts, including leagues that folded.'
        : verifyStats.exhausted
          ? 'Verification would have exceeded the request budget, so the whole league fell back to the approximate feature rather than mixing two definitions across members.'
          : `Past exits verified against ${verifyStats.checked} league${verifyStats.checked === 1 ? '' : 's'} (${verifyStats.free} free from co-members, ${verifyStats.fetched} fetched).`,
    },
  };
}
