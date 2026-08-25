// Sleeper manager-engagement features.
//
// Turns the raw transaction sweep (src/lib/sleeper.ts) plus a manager's league
// history into (a) per-league-season engagement rows, (b) a per-manager profile
// on six behavioral axes, and (c) an engagement segment.
//
// These are the shared inputs for the abandonment (survival) and league-exit
// models — see docs/sleeper-engagement-model.md. Nothing here fits a model; it
// is all deterministic feature construction so it can be unit-checked and run
// client-side.
//
// PRIVACY: profiles describe named real people. Compute them on demand; never
// commit per-manager rows or profiles to the repo.
import type { LeagueSeasonRecord, LeagueFormatInfo, TxnEvent, TradeRecord } from './sleeper';
import { resolveLineages, retentionEvents, type LeagueSeasonRef } from './leagueLineage';

// Sleeper serves 18 weekly transaction logs; week 1 also carries draft-day and
// preseason moves, so it reads as "preseason" in the attention-shape split.
const LAST_WEEK = 18;
const DEFAULT_HORIZON = 17;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const share = (n: number, d: number) => (d > 0 ? n / d : 0);

export interface ManagerSeasonEngagement {
  season: string;
  leagueId: string;
  lineageId: string;
  leagueName: string;
  format: LeagueFormatInfo;
  totalRosters: number;

  // Volume, by Sleeper transaction type.
  txnCount: number;
  waiverCount: number;
  freeAgentCount: number;
  tradeCount: number;
  commishCount: number;
  failedCount: number;   // failed claims count as engagement: the manager tried
  addCount: number;
  dropCount: number;
  faabSpent: number;

  // Timing.
  activeWeeks: number[];          // ascending, de-duplicated
  firstActiveWeek: number | null;
  lastActiveWeek: number | null;
  longestSilentRun: number;       // longest zero-activity run BETWEEN active weeks
  trailingSilentWeeks: number;    // silent weeks from lastActiveWeek to the horizon
  weekdayCounts: number[];        // length 7, Sunday-indexed, UTC

  // Roster-derived. null when not measurable for this league-season.
  emptyStarterSlots: number | null;

  // Outcome context (drivers of quitting, not consequences of it).
  wins: number;
  losses: number;
  regSeasonRank: number;
  pointsFor: number;
  champion: boolean;

  // Best-ball leagues auto-start lineups and often have no waivers, so
  // lineup-derived signals are meaningless there. Unmasked, a model reads
  // "everyone in best-ball abandoned". Gate on this rather than passing it in
  // as a covariate.
  lineupSignalsValid: boolean;
}

export interface EngagementOptions {
  // Last week that could plausibly have activity, per season. Defaults to 17.
  // Pass the current week for the live season so trailing silence isn't
  // credited against a season that hasn't happened yet.
  horizonWeek?: number | ((season: string) => number);
  // leagueId → the manager's `starters` array, for empty-slot detection.
  startersByLeague?: Map<string, string[]>;
}

// Sleeper writes an unfilled starter slot as the string "0".
const EMPTY_SLOT = '0';

function horizonFor(opts: EngagementOptions, season: string): number {
  const h = opts.horizonWeek;
  if (typeof h === 'function') return h(season);
  if (typeof h === 'number') return h;
  return DEFAULT_HORIZON;
}

// ── Per-league-season rows ──

export function managerSeasonEngagement(
  history: LeagueSeasonRecord[],
  events: TxnEvent[],
  opts: EngagementOptions = {},
): ManagerSeasonEngagement[] {
  const refs: LeagueSeasonRef[] = history.map((r) => ({
    leagueId: r.leagueId,
    previousLeagueId: r.previousLeagueId,
    season: r.season,
    name: r.leagueName,
  }));
  const index = resolveLineages(refs);

  const byLeague = new Map<string, TxnEvent[]>();
  for (const e of events) {
    if (!byLeague.has(e.leagueId)) byLeague.set(e.leagueId, []);
    byLeague.get(e.leagueId)!.push(e);
  }

  return history.map((rec) => {
    const evs = byLeague.get(rec.leagueId) ?? [];
    const weekdayCounts = new Array(7).fill(0) as number[];
    let waiverCount = 0, freeAgentCount = 0, tradeCount = 0, commishCount = 0;
    let failedCount = 0, addCount = 0, dropCount = 0, faabSpent = 0;
    const weeks = new Set<number>();

    for (const e of evs) {
      weeks.add(e.week);
      if (e.kind === 'waiver') waiverCount++;
      else if (e.kind === 'free_agent') freeAgentCount++;
      else if (e.kind === 'trade') tradeCount++;
      else if (e.kind === 'commissioner') commishCount++;
      if (e.status !== 'complete') failedCount++;
      addCount += e.adds.length;
      dropCount += e.drops.length;
      faabSpent += e.faabBid;
      if (e.created > 0) weekdayCounts[new Date(e.created).getUTCDay()]++;
    }

    const activeWeeks = [...weeks].sort((a, b) => a - b);
    const firstActiveWeek = activeWeeks.length ? activeWeeks[0] : null;
    const lastActiveWeek = activeWeeks.length ? activeWeeks[activeWeeks.length - 1] : null;

    // Internal gaps only — no horizon assumption needed, so this is comparable
    // between finished and in-progress seasons.
    let longestSilentRun = 0;
    for (let i = 1; i < activeWeeks.length; i++) {
      longestSilentRun = Math.max(longestSilentRun, activeWeeks[i] - activeWeeks[i - 1] - 1);
    }

    const horizon = horizonFor(opts, rec.season);
    const trailingSilentWeeks = lastActiveWeek == null
      ? Math.max(0, horizon)
      : Math.max(0, horizon - lastActiveWeek);

    const bestBall = rec.format.bestBall;
    const starters = opts.startersByLeague?.get(rec.leagueId);
    const emptyStarterSlots = bestBall || !starters
      ? null
      : starters.filter((s) => !s || s === EMPTY_SLOT).length;

    return {
      season: rec.season,
      leagueId: rec.leagueId,
      lineageId: index.byLeagueId.get(rec.leagueId) ?? rec.leagueId,
      leagueName: rec.leagueName,
      format: rec.format,
      totalRosters: rec.totalRosters,
      txnCount: evs.length,
      waiverCount,
      freeAgentCount,
      tradeCount,
      commishCount,
      failedCount,
      addCount,
      dropCount,
      faabSpent,
      activeWeeks,
      firstActiveWeek,
      lastActiveWeek,
      longestSilentRun,
      trailingSilentWeeks,
      weekdayCounts,
      emptyStarterSlots,
      wins: rec.wins,
      losses: rec.losses,
      regSeasonRank: rec.regSeasonRank,
      pointsFor: rec.pointsFor,
      champion: rec.champion,
      lineupSignalsValid: !bestBall,
    };
  });
}

// ── Per-manager profile ──

export type AttentionShape = 'draft-only' | 'front-loaded' | 'sustained' | 'deadline-driven' | 'sparse';

export interface EngagementProfile {
  userId: string;

  // Volume
  leagueSeasons: number;
  leaguesCurrentSeason: number;
  seasonsActive: number;

  // Intensity
  txnPerLeagueWeek: number;

  // Persistence
  maxTenureSeasons: number;
  retentionRate: number | null;   // null when every row is right-censored

  // Mode
  dynastyShare: number;
  keeperShare: number;
  redraftShare: number;
  bestBallShare: number;

  // Attention shape
  preseasonShare: number;   // week <= 1 (includes draft day)
  earlySeasonShare: number; // weeks 2-6
  midSeasonShare: number;   // weeks 7-12
  lateSeasonShare: number;  // weeks 13+
  attentionShape: AttentionShape;

  // Sociality
  tradesPerLeagueSeason: number;
  partnerConcentration: number | null; // HHI over trade counterparties; null if <2 trades

  // Waiver behavior
  waiverShare: number;      // claims / (claims + free-agent grabs): bidding vs. grabbing
  faabPerWaiver: number;
  commishShare: number;

  // Reliability
  historicalAbandonmentRate: number | null;

  // How much this profile should be trusted vs. shrunk to a population prior.
  evidenceWeight: number;   // 0..1
}

// A manager-season counts as "went dark" if they stopped transacting well
// before the season ended. Deliberately conservative: best-ball is excluded
// (no in-season management is expected) and so are seasons with no activity at
// all, which are usually a league that never launched rather than a quitter.
export function wentDark(row: ManagerSeasonEngagement, minTrailing = 5): boolean {
  if (row.format.bestBall) return false;
  if (row.lastActiveWeek == null) return false;
  return row.trailingSilentWeeks >= minTrailing;
}

function attentionShapeOf(pre: number, early: number, late: number, txns: number): AttentionShape {
  if (txns < 5) return 'sparse';
  if (pre >= 0.6) return 'draft-only';
  if (late >= 0.45) return 'deadline-driven';
  if (pre + early >= 0.7) return 'front-loaded';
  return 'sustained';
}

export function engagementProfile(
  userId: string,
  history: LeagueSeasonRecord[],
  rows: ManagerSeasonEngagement[],
  events: TxnEvent[],
  trades: TradeRecord[],
  opts: EngagementOptions = {},
): EngagementProfile {
  const leagueSeasons = rows.length;
  const seasons = new Set(rows.map((r) => r.season));
  const latestSeason = [...seasons].sort((a, b) => Number(b) - Number(a))[0] ?? '';
  const leaguesCurrentSeason = rows.filter((r) => r.season === latestSeason).length;

  // Intensity is normalized per league-week so a 6-league manager isn't
  // automatically "more engaged" than a focused single-league one.
  const leagueWeeks = rows.reduce((sum, r) => sum + Math.max(1, horizonFor(opts, r.season)), 0);
  const txnPerLeagueWeek = share(events.length, leagueWeeks);

  const refs: LeagueSeasonRef[] = history.map((r) => ({
    leagueId: r.leagueId,
    previousLeagueId: r.previousLeagueId,
    season: r.season,
    name: r.leagueName,
  }));
  const index = resolveLineages(refs);
  const maxTenureSeasons = Math.max(0, ...[...index.lineages.values()].map((l) => l.tenureSeasons));

  const retention = retentionEvents(refs).filter((e) => e.returnedNextSeason !== null);
  const retentionRate = retention.length
    ? share(retention.filter((e) => e.returnedNextSeason).length, retention.length)
    : null;

  const fmt = (pick: (f: LeagueFormatInfo) => boolean) => share(rows.filter((r) => pick(r.format)).length, leagueSeasons);

  let pre = 0, early = 0, mid = 0, late = 0;
  for (const e of events) {
    if (e.week <= 1) pre++;
    else if (e.week <= 6) early++;
    else if (e.week <= 12) mid++;
    else late++;
  }
  const total = events.length;

  // HHI over trade counterparties, keyed per league so roster ids from
  // different leagues aren't conflated.
  const partnerCounts = new Map<string, number>();
  for (const t of trades) {
    for (const p of t.partners) {
      const key = `${t.leagueId}:${p}`;
      partnerCounts.set(key, (partnerCounts.get(key) ?? 0) + 1);
    }
  }
  const partnerTotal = [...partnerCounts.values()].reduce((a, b) => a + b, 0);
  const partnerConcentration = trades.length >= 2 && partnerTotal > 0
    ? [...partnerCounts.values()].reduce((acc, c) => acc + (c / partnerTotal) ** 2, 0)
    : null;

  const waivers = rows.reduce((s, r) => s + r.waiverCount, 0);
  const freeAgents = rows.reduce((s, r) => s + r.freeAgentCount, 0);
  const faab = rows.reduce((s, r) => s + r.faabSpent, 0);
  const commish = rows.reduce((s, r) => s + r.commishCount, 0);

  // Only completed, non-best-ball seasons can be scored for going dark.
  const scorable = rows.filter((r) => !r.format.bestBall && r.season !== latestSeason);
  const historicalAbandonmentRate = scorable.length
    ? share(scorable.filter((r) => wentDark(r)).length, scorable.length)
    : null;

  // Shrinkage weight: both breadth (how many league-seasons we've seen) and
  // depth (how many transactions) have to be present before a personal
  // estimate beats the population prior.
  const evidenceWeight = 0.5 * clamp01(leagueSeasons / 4) + 0.5 * clamp01(total / 40);

  return {
    userId,
    leagueSeasons,
    leaguesCurrentSeason,
    seasonsActive: seasons.size,
    txnPerLeagueWeek,
    maxTenureSeasons,
    retentionRate,
    dynastyShare: fmt((f) => f.type === 'Dynasty'),
    keeperShare: fmt((f) => f.type === 'Keeper'),
    redraftShare: fmt((f) => f.type === 'Redraft'),
    bestBallShare: fmt((f) => f.bestBall),
    preseasonShare: share(pre, total),
    earlySeasonShare: share(early, total),
    midSeasonShare: share(mid, total),
    lateSeasonShare: share(late, total),
    attentionShape: attentionShapeOf(share(pre, total), share(early, total), share(late, total), total),
    tradesPerLeagueSeason: share(trades.length, leagueSeasons),
    partnerConcentration,
    waiverShare: share(waivers, waivers + freeAgents),
    faabPerWaiver: share(faab, waivers),
    commishShare: share(commish, total),
    historicalAbandonmentRate,
    evidenceWeight,
  };
}

// ── Segments ──

export type SegmentName =
  | 'Unclassified'
  | 'Ghost'
  | 'Casual One-Leaguer'
  | 'Draft-Day Enthusiast'
  | 'Best-Ball Volume Player'
  | 'Dynasty Lifer'
  | 'Grinder'
  | 'Commissioner / Superuser';

export interface SegmentAssignment {
  segment: SegmentName;
  confidence: number;   // 0..1, scaled by evidenceWeight
  why: string;          // human-readable justification for the UI
}

// Cold-start classifier: deterministic thresholds on the profile axes, for a
// single manager with no fitted population behind them. Ordered — the first
// matching rule wins — so the thresholds below double as documentation of
// precedence. Replace with fitSegments/assignSegment centroids once a crawl
// exists; the return type is identical so callers don't change.
export function coldStartSegment(p: EngagementProfile): SegmentAssignment {
  const conf = (c: number) => clamp01(c * (0.4 + 0.6 * p.evidenceWeight));

  // Too little evidence to say anything. Better an honest abstention than a
  // confident wrong label on someone with two transactions.
  if (p.evidenceWeight < 0.2 || p.leagueSeasons === 0) {
    return { segment: 'Unclassified', confidence: 0, why: 'Not enough observed activity to classify.' };
  }

  if (p.txnPerLeagueWeek < 0.05 && p.attentionShape !== 'sustained') {
    return { segment: 'Ghost', confidence: conf(0.8), why: 'Almost no in-season transactions across their leagues.' };
  }
  if (p.commishShare >= 0.15 && p.leagueSeasons >= 4) {
    return { segment: 'Commissioner / Superuser', confidence: conf(0.7), why: 'High share of commissioner-type moves across many leagues.' };
  }
  if (p.bestBallShare >= 0.5 && p.leaguesCurrentSeason >= 4) {
    return { segment: 'Best-Ball Volume Player', confidence: conf(0.8), why: 'Mostly best-ball, many teams in the current season.' };
  }
  if (p.preseasonShare >= 0.6 && (p.retentionRate ?? 1) < 0.5) {
    return { segment: 'Draft-Day Enthusiast', confidence: conf(0.75), why: 'Activity concentrated at the draft, low league retention.' };
  }
  if (p.txnPerLeagueWeek >= 0.6 && p.attentionShape === 'sustained') {
    return { segment: 'Grinder', confidence: conf(0.85), why: 'Sustained weekly transaction volume all season.' };
  }
  if (p.dynastyShare >= 0.6 && p.maxTenureSeasons >= 3) {
    return { segment: 'Dynasty Lifer', confidence: conf(0.8), why: 'Mostly dynasty, with multi-season tenure in the same leagues.' };
  }
  if (p.leaguesCurrentSeason <= 1) {
    return { segment: 'Casual One-Leaguer', confidence: conf(0.6), why: 'A single active league with moderate activity.' };
  }
  return { segment: 'Unclassified', confidence: 0, why: 'No segment rule matched cleanly.' };
}

// ── Fitted segments (k-means), for when a crawled population exists ──

export interface SegmentModel {
  featureNames: string[];
  mean: number[];
  sd: number[];
  centroids: number[][];     // standardized space
  labels: SegmentName[];     // per centroid, named from coldStartSegment consensus
  sizes: number[];
}

const FEATURES: { name: string; get: (p: EngagementProfile) => number }[] = [
  { name: 'logLeagueSeasons', get: (p) => Math.log1p(p.leagueSeasons) },
  { name: 'txnPerLeagueWeek', get: (p) => p.txnPerLeagueWeek },
  { name: 'maxTenureSeasons', get: (p) => p.maxTenureSeasons },
  { name: 'dynastyShare', get: (p) => p.dynastyShare },
  { name: 'bestBallShare', get: (p) => p.bestBallShare },
  { name: 'preseasonShare', get: (p) => p.preseasonShare },
  { name: 'lateSeasonShare', get: (p) => p.lateSeasonShare },
  { name: 'tradesPerLeagueSeason', get: (p) => p.tradesPerLeagueSeason },
];

export function featureVector(p: EngagementProfile): number[] {
  return FEATURES.map((f) => f.get(p));
}

const dist2 = (a: number[], b: number[]) => a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0);

// Deterministic maximin ("k-center") seeding instead of random k-means++, so a
// given population always yields the same segments — the alternative makes
// segment names shuffle between runs, which is unusable in a UI.
function seedCentroids(pts: number[][], k: number): number[][] {
  const seeds = [pts[0]];
  while (seeds.length < k) {
    let best = -1, bestD = -1;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.min(...seeds.map((s) => dist2(pts[i], s)));
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best < 0 || bestD === 0) break;
    seeds.push(pts[best]);
  }
  return seeds.map((s) => [...s]);
}

export function fitSegments(profiles: EngagementProfile[], k = 6, iterations = 50): SegmentModel | null {
  if (profiles.length < k) return null;

  const raw = profiles.map(featureVector);
  const dim = FEATURES.length;
  const mean = new Array(dim).fill(0) as number[];
  const sd = new Array(dim).fill(0) as number[];
  for (let j = 0; j < dim; j++) {
    mean[j] = raw.reduce((s, r) => s + r[j], 0) / raw.length;
    const v = raw.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / raw.length;
    sd[j] = Math.sqrt(v) || 1;   // a constant column would divide by zero
  }
  const pts = raw.map((r) => r.map((v, j) => (v - mean[j]) / sd[j]));

  let centroids = seedCentroids(pts, k);
  const assign = new Array(pts.length).fill(0) as number[];
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < pts.length; i++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = dist2(pts[i], centroids[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; moved = true; }
    }
    const sums = centroids.map(() => new Array(dim).fill(0) as number[]);
    const counts = centroids.map(() => 0);
    for (let i = 0; i < pts.length; i++) {
      counts[assign[i]]++;
      for (let j = 0; j < dim; j++) sums[assign[i]][j] += pts[i][j];
    }
    centroids = centroids.map((c, ci) => (counts[ci] ? sums[ci].map((s) => s / counts[ci]) : c));
    if (!moved) break;
  }

  // Name each cluster by the most common cold-start label among its members,
  // so fitted clusters stay comparable to the threshold classifier instead of
  // being opaque "cluster 3" buckets.
  const labels: SegmentName[] = centroids.map((_, ci) => {
    const tally = new Map<SegmentName, number>();
    profiles.forEach((p, i) => {
      if (assign[i] !== ci) return;
      const s = coldStartSegment(p).segment;
      tally.set(s, (tally.get(s) ?? 0) + 1);
    });
    let bestLabel: SegmentName = 'Unclassified', bestN = -1;
    for (const [s, n] of tally) if (n > bestN) { bestN = n; bestLabel = s; }
    return bestLabel;
  });

  const sizes = centroids.map((_, ci) => assign.filter((a) => a === ci).length);
  return { featureNames: FEATURES.map((f) => f.name), mean, sd, centroids, labels, sizes };
}

export function assignSegment(p: EngagementProfile, model: SegmentModel | null): SegmentAssignment {
  if (!model) return coldStartSegment(p);
  const v = featureVector(p).map((x, j) => (x - model.mean[j]) / model.sd[j]);

  const dists = model.centroids.map((c) => Math.sqrt(dist2(v, c)));
  let best = 0;
  for (let i = 1; i < dists.length; i++) if (dists[i] < dists[best]) best = i;

  // Margin between the nearest and runner-up centroid, so a point sitting on a
  // cluster boundary reports low confidence rather than a coin-flip label.
  const sorted = [...dists].sort((a, b) => a - b);
  const margin = sorted.length > 1 && sorted[1] > 0 ? clamp01((sorted[1] - sorted[0]) / sorted[1]) : 1;

  return {
    segment: model.labels[best],
    confidence: clamp01(margin * (0.4 + 0.6 * p.evidenceWeight)),
    why: `Nearest fitted centroid (#${best + 1}, n=${model.sizes[best]}).`,
  };
}

export { LAST_WEEK };
