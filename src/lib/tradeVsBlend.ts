// Trade values vs the StatHead blend: keep both numbers and explain the gap.
//
// The two measure different things. The blend is a list price (StatHead's
// blend of two dynasty markets); trade values are what managers paid, read
// off completed trades (scripts/fit-player-values.py). The gap for a player
// is split into parts:
//   scale     the blend's star premium. Trade values add (two 50s = one 100),
//             list prices do not, so the numbers are not compared directly:
//             a trade value maps to the blend value at the same rank among
//             well-traded players, and the gap is his blend against that.
//   position  the mean gap at his position in this format (e.g. superflex
//             TEs, where many leagues pay a TE premium the blend has no
//             version of).
//   age       the mean gap for his age band at his position, once the
//             position part is out (trades pay more for veteran receivers and
//             backs: contenders buy this season).
//   player    what is left, read against his trade value's own uncertainty
//             and recent move.
// All parts are StatHead numbers; no market's own value or rank is used.

import type { DynastyPlayer } from '../types';
import { normalizeForMatch } from './nameMatch';

export interface TradeRow {
  sleeper_id: string;
  name: string | null;
  pos: string | null;
  idp?: boolean;
  value: number;
  ciHigh?: number;
  change4w?: number;
  trades4w: number;
}

export interface BlendGap {
  blendRank: number;
  tradeRank: number;
  /** Trades pay this much more (+) or less (-) than the blend implies, after the scale curve. */
  gap: number;
  position: number;
  age: number;
  player: number;
  ageBand: string;
  /** Short reason for the player part. */
  note: 'close' | 'noise' | 'moving' | 'thin' | 'real';
}

export interface GroupGap { key: string; gap: number; n: number }

export interface BlendComparison {
  byId: Map<string, BlendGap>;
  positions: GroupGap[];
  /** Age band within each position. */
  ages: (GroupGap & { pos: string; band: string })[];
  /** Slope of log(blend) on log(trade): above 1 = the blend pays stars more. */
  slope: number;
  n: number;
}

const POS = new Set(['QB', 'RB', 'WR', 'TE']);
export const AGE_BANDS: [string, number, number][] = [['under 24', 0, 24], ['24-26', 24, 27], ['27-29', 27, 30], ['30+', 30, 99]];
const MIN_TRADES = 10;   // players with fewer recent trades are explained but not fitted
const SHRINK = 5;        // group means shrink toward 0 as if 5 players at 0 were added

const ageBand = (age?: number) => (age ? AGE_BANDS.find(([, lo, hi]) => age >= lo && age < hi)?.[0] ?? '' : '');

/** Rank-matched curve: the blend value at the same place in the blend's order
 *  as v holds in the trades' order (log space, interpolated between players).
 *  Monotone and exact at the top, where a fitted polynomial bends. */
function rankCurve(tradeLogs: number[], blendLogs: number[]): (v: number) => number {
  const t = [...tradeLogs].sort((a, b) => b - a), b = [...blendLogs].sort((a, c) => c - a);
  return (v: number) => {
    if (v >= t[0]) return b[0];
    if (v <= t[t.length - 1]) return b[b.length - 1];
    let i = 0;
    while (t[i + 1] > v) i++;
    const w = t[i] === t[i + 1] ? 0 : (t[i] - v) / (t[i] - t[i + 1]);
    return b[i] + w * (b[i + 1] - b[i]);
  };
}

function shrunkMeans(rows: { key: string; r: number }[]): Map<string, GroupGap> {
  const acc = new Map<string, { s: number; n: number }>();
  for (const { key, r } of rows) {
    if (!key) continue;
    const a = acc.get(key) ?? { s: 0, n: 0 };
    a.s += r; a.n += 1;
    acc.set(key, a);
  }
  return new Map([...acc].map(([key, a]) => [key, { key, gap: a.s / (a.n + SHRINK), n: a.n }]));
}

/** Compare one format's trade values with the blend (value = 1QB, superflexValue = superflex). */
export function compareWithBlend(players: TradeRow[], blend: DynastyPlayer[], format: '1qb' | 'superflex'): BlendComparison {
  const bv = (b: DynastyPlayer) => (format === '1qb' ? b.value : b.superflexValue);
  const index = new Map<string, DynastyPlayer>();
  for (const b of blend) if (POS.has(b.position) && bv(b) > 0) index.set(`${normalizeForMatch(b.playerName)}|${b.position}`, b);

  const joined = players
    .filter((p) => !p.idp && p.pos && POS.has(p.pos) && p.name && p.value > 0)
    .flatMap((p) => {
      const b = index.get(`${normalizeForMatch(p.name!)}|${p.pos}`);
      return b ? [{ p, b }] : [];
    });
  const fit = joined.filter(({ p }) => p.trades4w >= MIN_TRADES);
  const empty: BlendComparison = { byId: new Map(), positions: [], ages: [], slope: 1, n: 0 };
  if (fit.length < 30) return empty;

  // Gap in log space, + = trades pay more than the curve says the blend implies.
  const x = fit.map(({ p }) => Math.log(p.value));
  const y = fit.map(({ b }) => Math.log(bv(b)));
  const curve = rankCurve(x, y);
  const mx = x.reduce((a, b) => a + b, 0) / x.length, my = y.reduce((a, b) => a + b, 0) / y.length;
  const slope = x.reduce((a, xi, i) => a + (xi - mx) * (y[i] - my), 0) / x.reduce((a, xi) => a + (xi - mx) ** 2, 0);
  const gapOf = (p: TradeRow, b: DynastyPlayer) => curve(Math.log(p.value)) - Math.log(bv(b));

  const fitRows = fit.map(({ p, b }) => ({ p, b, r: gapOf(p, b), band: ageBand(b.age) }));
  const posMeans = shrunkMeans(fitRows.map(({ p, r }) => ({ key: p.pos!, r })));
  // Age within position: old QBs are not paid like old WRs, and an age-only
  // effect added to the QB effect double counts them.
  const ageCells = shrunkMeans(fitRows.map(({ p, r, band }) => ({ key: band && `${p.pos}|${band}`, r: r - (posMeans.get(p.pos!)?.gap ?? 0) })));

  const rankOf = <T,>(rows: T[], v: (t: T) => number) => {
    const m = new Map<T, number>();
    [...rows].sort((a, c) => v(c) - v(a)).forEach((t, i) => m.set(t, i + 1));
    return m;
  };
  const tr = rankOf(joined, ({ p }) => p.value), br = rankOf(joined, ({ b }) => bv(b));

  const byId = new Map<string, BlendGap>();
  for (const j of joined) {
    const { p, b } = j;
    const r = gapOf(p, b);
    const band = ageBand(b.age);
    const pe = posMeans.get(p.pos!)?.gap ?? 0;
    const ae = ageCells.get(`${p.pos}|${band}`)?.gap ?? 0;
    const rest = r - pe - ae;
    const ci = p.ciHigh && p.ciHigh > p.value ? Math.log(p.ciHigh / p.value) : 0.3;
    const note: BlendGap['note'] =
      Math.abs(r) <= Math.max(ci, 0.1) ? 'close'
        : p.trades4w < 20 ? 'thin'
        : Math.abs(rest) <= ci ? 'noise'
          : Math.abs(p.change4w ?? 0) >= 0.15 && Math.sign(p.change4w ?? 0) === Math.sign(rest) ? 'moving'
            : 'real';
    byId.set(p.sleeper_id, {
      blendRank: br.get(j)!, tradeRank: tr.get(j)!,
      gap: Math.expm1(r), position: Math.expm1(pe), age: Math.expm1(ae), player: Math.expm1(rest),
      ageBand: band, note,
    });
  }
  const sortGroups = (m: Map<string, GroupGap>, order: string[]) =>
    order.flatMap((k) => (m.get(k) ? [{ ...m.get(k)!, gap: Math.expm1(m.get(k)!.gap) }] : []));
  return {
    byId,
    positions: sortGroups(posMeans, ['QB', 'RB', 'WR', 'TE']),
    ages: ['QB', 'RB', 'WR', 'TE'].flatMap((pos) => sortGroups(ageCells, AGE_BANDS.map(([k]) => `${pos}|${k}`))
      .map((g) => ({ ...g, pos, band: g.key.split('|')[1] }))),
    slope,
    n: fit.length,
  };
}

export interface PickGap { label: string; blend: number | null; trades: number | null }

/** Rookie picks as a share of a mid 1st in the next draft, blend vs trades. */
export function comparePicks(
  picks: { round: number; ahead: number; tier: string; value: number }[],
  blend: DynastyPlayer[], format: '1qb' | 'superflex',
): PickGap[] {
  const bv = (b: DynastyPlayer) => (format === '1qb' ? b.value : b.superflexValue);
  const named = new Map(blend.filter((b) => b.position === 'RDP').map((b) => [b.playerName, bv(b)]));
  const years = [...named.keys()].map((n) => parseInt(n, 10)).filter((y) => y > 2000);
  const tradeMid = picks.find((p) => p.round === 1 && p.ahead === 0 && p.tier === 'M')?.value;
  if (!years.length || !tradeMid) return [];
  const y0 = Math.min(...years);
  const blendMid = named.get(`${y0} Mid 1st`);
  if (!blendMid) return [];
  const ord = ['', '1st', '2nd', '3rd', '4th'];
  const rows: [string, number, number, string, string][] = [
    [`${y0} early 1st`, 1, 0, 'E', 'Early'], [`${y0} late 1st`, 1, 0, 'L', 'Late'],
    [`${y0 + 1} mid 1st`, 1, 1, 'U', 'Mid'], [`${y0 + 2} mid 1st`, 1, 2, 'U', 'Mid'],
    [`${y0} mid 2nd`, 2, 0, 'M', 'Mid'], [`${y0} mid 3rd`, 3, 0, 'M', 'Mid'], [`${y0} mid 4th`, 4, 0, 'M', 'Mid'],
  ];
  return rows.map(([label, round, ahead, tier, word]) => {
    const b = named.get(`${y0 + ahead} ${word} ${ord[round]}`);
    const t = picks.find((p) => p.round === round && p.ahead === ahead && p.tier === tier)?.value;
    return { label, blend: b ? b / blendMid : null, trades: t ? t / tradeMid : null };
  });
}
