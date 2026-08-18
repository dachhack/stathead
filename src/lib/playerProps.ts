/**
 * Prop pricing for weekly stat-line projections.
 *
 * `scripts/build-player-props.py` ships projected **means** (a stat line per
 * player per week) plus the **spread** around them; `scripts/build-quarter-
 * splits.py` ships the quarter-by-quarter shape of a game. This module is the
 * math that turns those into something you can bet or start a lineup on:
 * a prop line, the probability of going over it, and a projection range.
 *
 * Two distributions, picked per stat:
 *
 *   counting stats (attempts, completions, targets, receptions, TDs, INTs)
 *     → negative binomial, var = mu + mu²/k. k comes from the data; large k
 *       collapses to Poisson, small k means a boom/bust usage profile.
 *
 *   yardage stats (passing/rushing/receiving yards, fantasy points)
 *     → gamma with shape = 1/cv², which reproduces the observed coefficient
 *       of variation and the right-skew of real yardage games (and, when
 *       cv > 1, the pile of near-zero games that a normal model misses).
 *
 * Both are shared by the web app and the MCP server, so a prop quoted in
 * chat and one rendered in the UI come from exactly the same numbers.
 */

export type PropPos = 'QB' | 'RB' | 'WR' | 'TE';
export type PropKind = 'count' | 'yards';

export interface DispersionParams {
  /** negative-binomial dispersion: var = mu + mu²/k */
  k: number;
  /** coefficient of variation (sd / mean) */
  cv: number;
  n?: number;
  mean?: number;
}

export interface TeamWeek { w: number; opp: string; home: boolean }

export interface PropPlayer {
  name: string;
  pos: PropPos;
  team: string;
  gsis: string | null;
  sleeper: string | null;
  /** projected games played this season */
  gp: number;
  /** probability he suits up in a given week */
  avail: number;
  /** season per-game means, in `statKeys[pos]` order */
  base: number[];
  /** per-week stat lines (null = bye), in `statKeys[pos]` order */
  wk: (number[] | null)[];
  injury?: { status?: string; detail?: string; week?: number; pPlay?: number; priorMissed?: number };
}

export interface DefenseProfile {
  overall: {
    epaPlay?: number; successRate?: number; playsGm?: number;
    passRateFaced?: number; sackRate?: number; explosiveRate?: number;
    ydsGm?: number; pointsGm?: number | null; gp?: number | null;
    /** 0-100, 100 = toughest defense in the league */
    grade?: number | null; rank?: number | null;
  };
  pos: Record<string, { pprGm: number; ratio: number; grade: number | null; rank: number | null }>;
  stat: Record<string, Record<string, number>>;
}

export interface PlayerPropsDoc {
  season: number;
  priorSeason: number;
  generatedAt: string;
  weeks: number;
  note: string;
  statKeys: Record<string, string[]>;
  countStats: string[];
  dispersion: Record<string, Record<string, DispersionParams>>;
  defense: Record<string, DefenseProfile>;
  teamWeeks: Record<string, TeamWeek[]>;
  byeWeeks: Record<string, number | null>;
  posMult: Record<string, Record<string, (number | null)[]>>;
  players: PropPlayer[];
}

export interface QuarterSplitsDoc {
  season: number;
  seasons: number[];
  generatedAt: string;
  note: string;
  scriptBuckets: string[];
  neutralBucket: string;
  countStats: string[];
  scriptFamily: Record<string, string>;
  share: Record<string, Record<string, number[]>>;
  cumulative: Record<string, Record<string, number[]>>;
  remaining: Record<string, Record<string, number[]>>;
  script: Record<string, Record<string, number>>;
  blend: Record<string, Record<string, Record<string, { wSeason: number; wInGame: number; n: number }>>>;
  dispersion: Record<string, Record<string, Record<string, DispersionParams>>>;
  team: { playShare: number[]; scoreShare: number[]; yardShare: number[] };
}

/* ────────────────────────── special functions ────────────────────────── */

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** log Γ(x) for x > 0 (Lanczos approximation). */
export function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i++) a += LANCZOS[i] / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularized lower incomplete gamma P(a, x), by series or continued fraction. */
export function gammaP(a: number, x: number): number {
  if (x <= 0 || a <= 0) return 0;
  if (x < a + 1) {
    // series expansion
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let i = 0; i < 300; i++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-12) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  // continued fraction for Q(a, x) = 1 - P(a, x)
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 300; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** Regularized incomplete beta I_x(a, b). */
export function betaI(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  const cf = (aa: number, bb: number, xx: number): number => {
    const tiny = 1e-300;
    const qab = aa + bb;
    const qap = aa + 1;
    const qam = aa - 1;
    let c = 1;
    let d = 1 - (qab * xx) / qap;
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 300; m++) {
      const m2 = 2 * m;
      let aaa = (m * (bb - m) * xx) / ((qam + m2) * (aa + m2));
      d = 1 + aaa * d;
      if (Math.abs(d) < tiny) d = tiny;
      c = 1 + aaa / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      h *= d * c;
      aaa = (-(aa + m) * (qab + m) * xx) / ((aa + m2) * (qap + m2));
      d = 1 + aaa * d;
      if (Math.abs(d) < tiny) d = tiny;
      c = 1 + aaa / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-12) break;
    }
    return h;
  };
  if (x < (a + 1) / (a + b + 2)) return (front * cf(a, b, x)) / a;
  return 1 - (front * cf(b, a, 1 - x)) / b;
}

/* ────────────────────────── prop probabilities ───────────────────────── */

/** Which distribution a stat uses. Anything not a counting stat is yardage. */
export function propKind(stat: string, countStats: readonly string[]): PropKind {
  return countStats.includes(stat) ? 'count' : 'yards';
}

/**
 * P(X > line) for a counting stat under a negative binomial with mean `mu`
 * and dispersion `k` (var = mu + mu²/k).
 *
 * NB CDF: P(X ≤ n) = I_p(k, n + 1) with p = k / (k + mu).
 */
export function countOverProb(mu: number, k: number, line: number): number {
  if (mu <= 0) return 0;
  const kk = Math.max(k, 0.05);
  // A line of 4.5 clears at 5+, i.e. P(X ≤ 4) is the "under".
  const n = Math.floor(line);
  if (n < 0) return 1;
  const p = kk / (kk + mu);
  return Math.min(1, Math.max(0, 1 - betaI(kk, n + 1, p)));
}

/**
 * P(X > line) for a yardage stat under a gamma with mean `mu` and coefficient
 * of variation `cv` (shape = 1/cv², scale = mu·cv²).
 */
export function yardsOverProb(mu: number, cv: number, line: number): number {
  if (mu <= 0) return 0;
  if (line <= 0) return 1;
  const c = Math.max(cv, 0.05);
  const shape = 1 / (c * c);
  const scale = mu / shape;
  return Math.min(1, Math.max(0, 1 - gammaP(shape, line / scale)));
}

/**
 * P(X > line) for any stat.
 *
 * `zeroProb` handles zero-inflated yardage: a receiver's *rushing* yards are
 * zero in four games out of five because he never gets a carry, and a plain
 * gamma — which puts no mass exactly at zero — would price a 1.5-yard prop as
 * a coin flip. Pass the probability the underlying volume is zero and the
 * remaining mass is re-spread over the games he does touch the ball.
 */
export function overProb(
  kind: PropKind, mu: number, disp: DispersionParams | undefined, line: number,
  zeroProb = 0,
): number {
  const d = disp ?? DEFAULT_DISPERSION;
  if (kind === 'count') return countOverProb(mu, d.k, line);
  const p0 = Math.min(Math.max(zeroProb, 0), 0.99);
  if (p0 <= 0) return yardsOverProb(mu, d.cv, line);
  if (line <= 0) return 1 - p0;
  return (1 - p0) * yardsOverProb(mu / (1 - p0), d.cv, line);
}

/** Value x with P(X ≤ x) = p, by bisection on the survival function. */
export function quantile(
  kind: PropKind, mu: number, disp: DispersionParams | undefined, p: number,
  zeroProb = 0,
): number {
  if (mu <= 0) return 0;
  let lo = 0;
  let hi = Math.max(mu * 12, 5);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (1 - overProb(kind, mu, disp, mid, zeroProb) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Yardage stat → the counting stat that has to happen for it to be non-zero. */
export const YARDS_VOLUME_STAT: Record<string, string> = {
  passYds: 'passAtt', rushYds: 'rushAtt', recYds: 'rec',
};

/**
 * P(the volume behind a yardage stat is zero this week), from the negative
 * binomial on its paired counting stat: P(X = 0) = (k / (k + mu))^k.
 * Returns 0 for stats with no natural volume pair (fantasy points).
 */
export function zeroProbForYards(
  stat: string, line: Record<string, number>,
  disp: Record<string, DispersionParams>,
): number {
  const volStat = YARDS_VOLUME_STAT[stat];
  if (!volStat) return 0;
  const volMu = line[volStat];
  if (volMu == null || volMu <= 0) return volMu === 0 ? 1 : 0;
  const k = Math.max(disp[volStat]?.k ?? DEFAULT_DISPERSION.k, 0.05);
  return Math.pow(k / (k + volMu), k);
}

/**
 * Snap a value onto the half-point grid a sportsbook would quote: …, 0.5,
 * 1.5, 2.5, … Half-points only, so a prop can never push. `step` widens the
 * grid for big totals (step 5 gives 245.5, 250.5, …); the default of 1 is
 * what books actually use, even on passing yards.
 */
export function snapLine(value: number, step = 1): number {
  const grid = Math.max(step, 0.5);
  return Math.max(Math.round((value - 0.5) / grid) * grid + 0.5, 0.5);
}

/** Fallback spread for a (position, stat) cell the builders could not
 *  estimate — deliberately wide, so a missing cell reads as uncertain
 *  rather than as a lock. */
export const DEFAULT_DISPERSION: DispersionParams = { k: 3, cv: 1.2 };

export interface Prop {
  stat: string;
  /** projected mean (conditional on playing) */
  mean: number;
  /** the quoted line */
  line: number;
  over: number;
  under: number;
  /** 10th / 90th percentile outcome, for a projection range */
  p10: number;
  p90: number;
}

/** Price one prop: the line nearest a coin flip, plus its over/under and range. */
export function priceProp(
  stat: string, mu: number, disp: DispersionParams | undefined,
  countStats: readonly string[], explicitLine?: number, zeroProb = 0,
): Prop {
  const kind = propKind(stat, countStats);
  const median = quantile(kind, mu, disp, 0.5, zeroProb);
  // Quote the half-point line closest to a coin flip rather than the one
  // nearest the median. On a discrete stat the median can sit right on a
  // jump — a 0.79-TD player has median 1, but 1.5 is a 20% prop and 0.5 is
  // the 50/50 one that matches how books quote it.
  let line = explicitLine;
  if (line == null) {
    const anchor = snapLine(median);
    const step = kind === 'yards' && mu >= 60 ? Math.max(1, Math.round(mu / 40)) : 1;
    let best = anchor;
    let bestGap = Infinity;
    for (let i = -3; i <= 3; i++) {
      const cand = anchor + i * step;
      if (cand < 0.5) continue;
      const gap = Math.abs(overProb(kind, mu, disp, cand, zeroProb) - 0.5);
      if (gap < bestGap - 1e-9) { bestGap = gap; best = cand; }
    }
    line = best;
  }
  const over = overProb(kind, mu, disp, line, zeroProb);
  return {
    stat,
    mean: mu,
    line,
    over,
    under: 1 - over,
    p10: quantile(kind, mu, disp, 0.1, zeroProb),
    p90: quantile(kind, mu, disp, 0.9, zeroProb),
  };
}

/** P(at least one TD), pooling rushing + receiving (+ returns) as Poisson. */
export function anytimeTdProb(expectedTds: number): number {
  return 1 - Math.exp(-Math.max(expectedTds, 0));
}

/* ──────────────────────────── doc helpers ────────────────────────────── */

/** A player's stat-line array for one week, as a named record. Null on a bye. */
export function weekLine(
  doc: PlayerPropsDoc, player: PropPlayer, week: number,
): Record<string, number> | null {
  const keys = doc.statKeys[player.pos];
  const row = player.wk[week - 1];
  if (!keys || !row) return null;
  const out: Record<string, number> = {};
  keys.forEach((k, i) => { out[k] = row[i]; });
  return out;
}

/** A player's season per-game means as a named record. */
export function baseLine(doc: PlayerPropsDoc, player: PropPlayer): Record<string, number> {
  const keys = doc.statKeys[player.pos] ?? [];
  const out: Record<string, number> = {};
  keys.forEach((k, i) => { out[k] = player.base[i]; });
  return out;
}

/** The week's opponent and home/away, or null on a bye. */
export function weekMatchup(
  doc: PlayerPropsDoc, team: string, week: number,
): TeamWeek | null {
  return (doc.teamWeeks[team] ?? []).find((g) => g.w === week) ?? null;
}

/** Probability the player suits up in a given week: the current injury report
 *  when it covers that week, otherwise the season baseline. */
export function availability(player: PropPlayer, week: number): number {
  const inj = player.injury;
  if (inj?.pPlay != null && (inj.week == null || inj.week === week)) return inj.pPlay;
  return player.avail;
}

/** Every prop for one player-week, with anytime-TD folded in. */
export function weekProps(
  doc: PlayerPropsDoc, player: PropPlayer, week: number, stats?: readonly string[],
): { props: Prop[]; anytimeTd: number | null } | null {
  const line = weekLine(doc, player, week);
  if (!line) return null;
  const disp = doc.dispersion[player.pos] ?? {};
  const keys = (stats ?? doc.statKeys[player.pos] ?? []).filter((k) => k in line);
  const props = keys.map((k) =>
    priceProp(k, line[k], disp[k], doc.countStats, undefined,
      zeroProbForYards(k, line, disp)));
  const tds = (line.rushTD ?? 0) + (line.recTD ?? 0);
  return { props, anytimeTd: tds > 0 ? anytimeTdProb(tds) : null };
}

/* ─────────────────────── rest of game (by quarter) ───────────────────── */

export interface RestOfGameInput {
  /** quarter just completed: 0 = pre-kickoff, 1-3 = after that quarter */
  quarter: 0 | 1 | 2 | 3;
  /** the player's production so far this game, by stat (optional) */
  soFar?: Record<string, number>;
  /** the player's team score minus the opponent's, right now */
  scoreDiff?: number;
}

export interface RestOfGameLine {
  quarter: number;
  /** score-differential bucket applied, or null when no score was supplied
   *  (pre-kickoff, or a caller that does not want a game-script adjustment) */
  bucket: string | null;
  /** fraction of a full game still to come, per stat */
  remaining: Record<string, number>;
  /** rest-of-game projected means */
  mean: Record<string, number>;
  props: Prop[];
  anytimeTd: number | null;
}

/** Score-differential bucket label used by `quarter-splits`. */
export function scriptBucket(scoreDiff: number): string {
  if (scoreDiff >= 15) return 'lead15';
  if (scoreDiff >= 9) return 'lead9';
  if (scoreDiff >= 4) return 'lead4';
  if (scoreDiff >= -3) return 'close';
  if (scoreDiff >= -8) return 'trail4';
  if (scoreDiff >= -14) return 'trail9';
  return 'trail15';
}

/**
 * Rest-of-game projection for a player, standing at the end of a quarter.
 *
 *   mu_rog = remaining[q] × (wSeason × fullGame + wInGame × paceImplied)
 *            × script[bucket]
 *
 * `paceImplied` extrapolates what he has already done this game
 * (`soFar / cumulative[q]`); the blend weights say how much of that to
 * believe, and were fit on the prior seasons' games. The spread comes from
 * the same partial-game windows, so a Q3 prop is priced off Q3 variance
 * rather than a scaled full-game number.
 */
export function restOfGame(
  props: PlayerPropsDoc, splits: QuarterSplitsDoc,
  player: PropPlayer, week: number, input: RestOfGameInput,
): RestOfGameLine | null {
  const full = weekLine(props, player, week);
  if (!full) return null;
  const q = input.quarter;
  const pos = player.pos;
  // No score supplied means no game-script view: leave the remainder at the
  // league-average play mix the full-game projection already assumes.
  const bucket = input.scoreDiff == null ? null : scriptBucket(input.scoreDiff);
  const scriptRow = (bucket && splits.script[bucket]) || {};
  const blendRow = splits.blend[String(q)]?.[pos] ?? {};
  const dispRow = splits.dispersion[String(q)]?.[pos] ?? {};
  const remRow = splits.remaining[pos] ?? {};
  const cumRow = splits.cumulative[pos] ?? {};

  const remaining: Record<string, number> = {};
  const mean: Record<string, number> = {};
  for (const [stat, fullMean] of Object.entries(full)) {
    const rem = remRow[stat]?.[q];
    if (rem == null) continue;                       // e.g. pprPts, handled below
    remaining[stat] = rem;
    const w = blendRow[stat] ?? { wSeason: 1, wInGame: 0 };
    const cum = q > 0 ? (cumRow[stat]?.[q - 1] ?? 0) : 0;
    const observed = input.soFar?.[stat];
    const paceImplied = cum > 0.02 && observed != null ? observed / cum : fullMean;
    const blended = w.wSeason * fullMean + w.wInGame * paceImplied;
    const family = splits.scriptFamily[stat];
    const scriptMult = (family && scriptRow[family]) || 1;

    mean[stat] = blended * rem * scriptMult;
  }

  const statList = Object.keys(mean);
  const propList = statList.map((stat) =>
    priceProp(stat, mean[stat], dispRow[stat] ?? props.dispersion[pos]?.[stat],
      splits.countStats, undefined,
      zeroProbForYards(stat, mean, dispRow[stat] ? dispRow : props.dispersion[pos] ?? {})));
  const tds = (mean.rushTD ?? 0) + (mean.recTD ?? 0);
  return {
    quarter: q,
    bucket,
    remaining,
    mean,
    props: propList,
    anytimeTd: tds > 0 ? anytimeTdProb(tds) : null,
  };
}

/** Fantasy points implied by a stat line, PPR unless told otherwise. */
export function fantasyPoints(
  line: Record<string, number>, ppr = 1,
): number {
  return (line.passYds ?? 0) * 0.04
    + (line.passTD ?? 0) * 4
    - (line.int ?? 0) * 2
    + (line.rushYds ?? 0) * 0.1
    + (line.rushTD ?? 0) * 6
    + (line.recYds ?? 0) * 0.1
    + (line.recTD ?? 0) * 6
    + (line.rec ?? 0) * ppr;
}

/** Find a player in the props doc by name, gsis or sleeper id. */
export function findPropPlayer(
  doc: PlayerPropsDoc, query: string, pos?: string,
): PropPlayer | undefined {
  const norm = (s: string) => s.toLowerCase()
    .replace(/[^a-z ]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const q = norm(query);
  const pool = pos ? doc.players.filter((p) => p.pos === pos) : doc.players;
  return pool.find((p) => p.gsis === query || p.sleeper === query)
    ?? pool.find((p) => norm(p.name) === q)
    ?? pool.find((p) => norm(p.name).includes(q));
}
