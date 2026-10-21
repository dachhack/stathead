import { useEffect, useMemo, useState } from 'react';
import { bust } from '../lib/buildHash';
import { PlayerName } from './PlayerName';
import { fetchDynastyRankingsForDisplay } from '../data';
import type { DynastyPlayer } from '../types';
import { compareWithBlend, comparePicks, AGE_BANDS, type BlendComparison, type BlendGap } from '../lib/tradeVsBlend';

// StatHead trade values: what real dynasty managers paid, week by week
// (scripts/fit-player-values.py), with the trend / variability metrics and
// the short / long term forecasts (scripts/train_trade_value_forecast.py).
// StatHead model output only; no trade, league or manager is shown.

interface TVPlayer {
  sleeper_id: string;
  name: string | null;
  pos: string | null;
  idp?: boolean;
  value: number;
  rank?: number;
  posRank?: number;
  ciLow?: number;
  ciHigh?: number;
  change1w?: number;
  change4w?: number;
  change12w?: number;
  velocity?: number;
  acceleration?: number;
  volatility?: number;
  dispersion?: number;
  trend?: 'rising' | 'falling' | 'flat';
  high52w?: number;
  low52w?: number;
  fromHigh?: number;
  trades4w: number;
  trades8w: number;
  tradesAll: number;
  lastTraded?: string;
  /** TEs and QBs: the same player's value in other scorings. */
  scoring?: Record<string, number>;
  /** Page-side: the scoring multiplier applied to value (1 = base scoring). */
  scale?: number;
}

interface ScoringFactor { position: string; factor: number; factor52wAgo?: number | null; trades: number; trades4w: number }

interface TVPick { round: number; ahead: number; tier: string; value: number; n: number }

interface TVFormat {
  trades: number;
  to: string;
  nextWeek?: { asOfError?: number | null; trades?: number };
  scoring?: Record<string, ScoringFactor>;
  players: TVPlayer[];
  picks: TVPick[];
}

interface TVDoc { generatedAt: string; unit: string; formats: Record<string, TVFormat> }

interface Fc { value: number; lo: number; hi: number; change: number }
type FcPlayer = { value: number } & Partial<Record<'h4' | 'h13' | 'h26' | 'h52', Fc>>;
interface FcMetric { label: string; walkForward?: { skill: number | null; directionHit: number | null; coverage80?: number } }
interface FcDoc {
  generatedAt: string;
  horizons: { weeks: number; label: string }[];
  formats: Record<string, { asOf: string; metrics: Record<string, FcMetric>; players: Record<string, FcPlayer> }>;
}

interface HistDoc { formats: Record<string, Record<string, { from: string; v: number[] }>> }

type Fmt = 'superflex' | '1qb';
type SortKey = 'value' | 'blendGap' | 'change4w' | 'velocity' | 'volatility' | 'dispersion' | 'trades4w' | 'fromHigh' | 'h4' | 'h13' | 'h26' | 'h52';
const HZ: { key: 'h4' | 'h13' | 'h26' | 'h52'; weeks: number; label: string }[] = [
  { key: 'h4', weeks: 4, label: '1 mo' }, { key: 'h13', weeks: 13, label: '3 mo' },
  { key: 'h26', weeks: 26, label: '6 mo' }, { key: 'h52', weeks: 52, label: '1 yr' },
];
const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'] as const;
type Tep = 'none' | 'tePremiumUnder0.75' | 'tePremium0.75Plus';
const TEP_LABEL: Record<Tep, string> = { none: 'No TE premium', 'tePremiumUnder0.75': 'TE premium 0.5', 'tePremium0.75Plus': 'TE premium 1.0' };

const pct = (x?: number | null, digits = 0) => (x == null ? '—' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(digits)}%`);
const tone = (x?: number | null, dead = 0.02) =>
  x == null || Math.abs(x) < dead ? 'var(--text-muted)' : x > 0 ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)';

export function TradeValuesView() {
  const [doc, setDoc] = useState<TVDoc | null>(null);
  const [fc, setFc] = useState<FcDoc | null>(null);
  const [hist, setHist] = useState<HistDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fmt, setFmt] = useState<Fmt>('superflex');
  const [pos, setPos] = useState<typeof POSITIONS[number]>('ALL');
  const [search, setSearch] = useState('');
  const [hideThin, setHideThin] = useState(true);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'value', desc: true });
  const [open, setOpen] = useState<string | null>(null);
  const [blend, setBlend] = useState<DynastyPlayer[] | null>(null);
  const [tep, setTep] = useState<Tep>('none');
  const [pass6, setPass6] = useState(false);

  useEffect(() => {
    const base = import.meta.env.BASE_URL;
    fetch(bust(`${base}data/player-trade-values.json`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setDoc)
      .catch((e) => setError(String(e)));
    fetch(bust(`${base}data/trade-value-forecasts.json`)).then((r) => (r.ok ? r.json() : null)).then(setFc).catch(() => setFc(null));
    fetch(bust(`${base}data/player-trade-values-history.json`)).then((r) => (r.ok ? r.json() : null)).then(setHist).catch(() => setHist(null));
  }, []);

  // The StatHead blend (list prices), to explain where trades differ from it.
  useEffect(() => {
    let cancelled = false;
    setBlend(null);
    fetchDynastyRankingsForDisplay(fmt).then((b) => { if (!cancelled) setBlend(b); }).catch(() => { if (!cancelled) setBlend([]); });
    return () => { cancelled = true; };
  }, [fmt]);

  const f = doc?.formats[fmt];
  const fcF = fc?.formats[fmt];
  // The blend is priced for base scoring, so it is compared with base values.
  const cmp = useMemo(() => (f && blend?.length ? compareWithBlend(f.players, blend, fmt) : null), [f, blend, fmt]);

  // Values in the chosen scoring: TEs and QBs scaled by the format's fitted
  // factor, then everyone re-ranked.
  const players = useMemo(() => {
    if (!f) return [];
    const out = f.players.map((p) => {
      const alt = p.pos === 'TE' && tep !== 'none' ? p.scoring?.[tep] : p.pos === 'QB' && pass6 ? p.scoring?.passTd6 : undefined;
      const k = alt ? alt / p.value : 1;
      if (k === 1) return { ...p, scale: 1 };
      const m = (x?: number) => (x == null ? x : x * k);
      return { ...p, scale: k, value: p.value * k, ciLow: m(p.ciLow), ciHigh: m(p.ciHigh), high52w: m(p.high52w), low52w: m(p.low52w) };
    });
    if (tep !== 'none' || pass6) {
      const pos: Record<string, number> = {};
      out.filter((p) => !p.idp && p.rank != null).sort((a, b) => b.value - a.value).forEach((p, i) => {
        pos[p.pos!] = (pos[p.pos!] ?? 0) + 1;
        p.rank = i + 1;
        p.posRank = pos[p.pos!];
      });
    }
    return out;
  }, [f, tep, pass6]);

  const rows = useMemo(() => {
    if (!f) return [];
    const q = search.trim().toLowerCase();
    const val = (p: TVPlayer, k: SortKey): number | undefined => {
      if (k === 'blendGap') return cmp?.byId.get(p.sleeper_id)?.gap;
      if (k.startsWith('h')) return fcF?.players[p.sleeper_id]?.[k as 'h4']?.change;
      return p[k as keyof TVPlayer] as number | undefined;
    };
    return players
      .filter((p) => !p.idp && p.rank != null)
      .filter((p) => pos === 'ALL' || p.pos === pos)
      .filter((p) => !q || (p.name ?? '').toLowerCase().includes(q))
      .filter((p) => !hideThin || p.trades4w >= 10 || !!q)
      .sort((a, b) => {
        const x = val(a, sort.key), y = val(b, sort.key);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return sort.desc ? y - x : x - y;
      });
  }, [f, players, fcF, cmp, pos, search, hideThin, sort]);

  if (error) return <div className="empty-state"><h3>Trade values unavailable</h3><p>{error}</p></div>;
  if (!doc || !f) return <div className="loading"><div className="spinner" /><div className="loading-text">Loading trade values…</div></div>;

  const th = (key: SortKey, label: string, title: string) => (
    <th key={key} title={title} onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }))}
      style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}>
      {label}{sort.key === key ? (sort.desc ? ' ▾' : ' ▴') : ''}
    </th>
  );
  const nCols = 12 + (cmp ? 1 : 0) + (fcF ? HZ.length : 0);

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Trade Values</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 0', maxWidth: 780 }}>
          What dynasty managers actually paid: StatHead values fitted to {f.trades.toLocaleString()} completed trades in
          public Sleeper leagues, week by week, using only trades made up to each week (no hindsight). 100 = a mid
          1st-round pick in the next rookie draft that week; values add (two 50s trade for one 100). Values as of the
          week ending {f.to}. TEs and QBs are priced for your league&apos;s scoring (TE premium, 6-point passing TDs):
          set it below. <b>Early numbers:</b> the league crawl is still growing, so values refresh weekly and will
          firm up as more leagues come in.
        </p>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <select className="scenario-select" style={{ width: 'auto' }} value={fmt} onChange={(e) => setFmt(e.target.value as Fmt)}>
          <option value="superflex">Superflex</option>
          <option value="1qb">1QB</option>
        </select>
        <select className="scenario-select" style={{ width: 'auto' }} value={pos} onChange={(e) => setPos(e.target.value as typeof POSITIONS[number])}>
          {POSITIONS.map((p) => <option key={p} value={p}>{p === 'ALL' ? 'All positions' : p}</option>)}
        </select>
        {f.scoring && Object.keys(f.scoring).some((k) => k.startsWith('tePremium')) && (
          <select className="scenario-select" style={{ width: 'auto' }} value={tep} onChange={(e) => setTep(e.target.value as Tep)}
            title="TE values in leagues with this TE premium (bonus points per TE catch), fitted from trades in such leagues">
            {(Object.keys(TEP_LABEL) as Tep[]).filter((k) => k === 'none' || f.scoring?.[k]).map((k) => <option key={k} value={k}>{TEP_LABEL[k]}</option>)}
          </select>
        )}
        {f.scoring?.passTd6 && (
          <select className="scenario-select" style={{ width: 'auto' }} value={pass6 ? '6' : '4'} onChange={(e) => setPass6(e.target.value === '6')}
            title="QB values in leagues scoring passing TDs at this many points, fitted from trades in such leagues">
            <option value="4">4-pt pass TD</option>
            <option value="6">6-pt pass TD</option>
          </select>
        )}
        <input className="scenario-select" type="search" placeholder="Search player…" value={search}
          onChange={(e) => setSearch(e.target.value)} style={{ width: 'auto', minWidth: 160 }} />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}
          title="Players in fewer than 10 trades over the last 4 weeks have values that lean on older trades.">
          <input type="checkbox" checked={hideThin} onChange={(e) => setHideThin(e.target.checked)} />
          Only players traded 10+ times in 4 weeks
        </label>
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th style={{ textAlign: 'left' }}>Player</th>
              <th>Pos</th>
              {th('value', 'Value', 'StatHead trade value this week, with its 90% range below')}
              {th('change4w', '4 wk', 'Change in value over the last 4 weeks')}
              {th('velocity', 'Velocity', 'Current rate of change, % per week (slope over the last 4 weeks)')}
              <th title="Rising / falling: a 4-week move larger than twice what ordinary weekly noise would give">Trend</th>
              {th('volatility', 'Volatility', 'Typical weekly swing over the last 12 weeks')}
              {th('dispersion', 'Dispersion', 'How much the last 4 weeks of trades disagree on him (spread of the value each trade implied)')}
              {th('trades4w', 'Trades 4w', 'Trades he was in over the last 4 weeks: the more, the firmer the value')}
              {th('fromHigh', 'vs 52w high', 'Current value against his highest value in the last 52 weeks')}
              {cmp && th('blendGap', 'vs blend', 'His rank on the StatHead dynasty blend, and how much more (+) or less (-) trades pay for him than the blend implies at his rank. Open the row for why.')}
              {fcF && HZ.map((h) => th(h.key, h.label, `Forecast value in ${h.label.replace('mo', 'months').replace('yr', 'year')} (median), and the change from now`))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 400).map((p) => {
              const fp = fcF?.players[p.sleeper_id];
              const isOpen = open === p.sleeper_id;
              return [
                <tr key={p.sleeper_id} onClick={() => setOpen(isOpen ? null : p.sleeper_id)} style={{ cursor: 'pointer' }}>
                  <td style={{ color: 'var(--text-muted)' }}>{p.rank}</td>
                  <td style={{ textAlign: 'left', fontWeight: 600 }} onClick={(e) => e.stopPropagation()}>
                    <PlayerName sleeperId={p.sleeper_id} name={p.name ?? p.sleeper_id} position={p.pos} />
                  </td>
                  <td>{p.pos}{p.posRank ?? ''}</td>
                  <td style={{ fontWeight: 600 }}>
                    {p.value.toFixed(0)}
                    {p.ciLow != null && <div style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-muted)' }}>{p.ciLow.toFixed(0)}–{p.ciHigh?.toFixed(0)}</div>}
                  </td>
                  <td style={{ color: tone(p.change4w) }}>{pct(p.change4w)}</td>
                  <td style={{ color: tone(p.velocity, 0.01) }}>{pct(p.velocity, 1)}</td>
                  <td>{p.trend && p.trend !== 'flat'
                    ? <span style={{ fontSize: 11, fontWeight: 600, color: tone(p.trend === 'rising' ? 1 : -1) }}>{p.trend === 'rising' ? '▲ rising' : '▼ falling'}</span>
                    : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>flat</span>}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{p.volatility == null ? '—' : `${(p.volatility * 100).toFixed(1)}%`}</td>
                  <td style={{ color: 'var(--text-muted)' }}
                    title="Spread of the value each of his recent trades implied. Cheap players' trades imply very unstable values, so anything past ±100% is shown as such.">
                    {p.dispersion == null ? '—' : p.dispersion > 1 ? '>±100%' : `±${(p.dispersion * 100).toFixed(0)}%`}
                  </td>
                  <td>{p.trades4w}</td>
                  <td style={{ color: tone(p.fromHigh, 0.05) }}>{p.fromHigh == null || p.fromHigh > -0.005 ? 'at high' : pct(p.fromHigh)}</td>
                  {cmp && <BlendCell g={cmp.byId.get(p.sleeper_id)} />}
                  {fcF && HZ.map((h) => {
                    const x = fp?.[h.key];
                    return (
                      <td key={h.key} title={x ? `${(x.value * (p.scale ?? 1)).toFixed(0)} (80% range ${(x.lo * (p.scale ?? 1)).toFixed(0)}–${(x.hi * (p.scale ?? 1)).toFixed(0)})` : 'no forecast'}>
                        {x ? <>{(x.value * (p.scale ?? 1)).toFixed(0)}<div style={{ fontSize: 10, color: tone(x.change, 0.03) }}>{pct(x.change)}</div></> : '—'}
                      </td>
                    );
                  })}
                  <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{isOpen ? '▴' : '▾'}</td>
                </tr>,
                isOpen && (
                  <tr key={`${p.sleeper_id}:chart`}>
                    <td colSpan={nCols} style={{ textAlign: 'left', background: 'var(--bg-secondary)' }}>
                      <PlayerChart p={p} hist={hist?.formats[fmt]?.[p.sleeper_id]} fc={fp} />
                      {cmp && <BlendWhy p={p} g={cmp.byId.get(p.sleeper_id)} fmt={fmt} />}
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>
      {rows.length > 400 && <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Showing the top 400; search to find others.</p>}

      <PickTable picks={f.picks} />
      {f.scoring && <ScoringTable scoring={f.scoring} fmt={fmt} />}
      {cmp && blend && <BlendSection cmp={cmp} picks={comparePicks(f.picks, blend, fmt)} fmt={fmt} scoring={f.scoring} />}
      <Method f={f} fc={fcF} fcDoc={fc} />
    </div>
  );
}

/** Weekly as-of history with the forecast points and their 80% ranges. */
function PlayerChart({ p, hist: base, fc: fcBase }: { p: TVPlayer; hist?: { from: string; v: number[] }; fc?: FcPlayer }) {
  // In another scoring, the history and forecasts scale with today's factor.
  const k = p.scale ?? 1;
  const hist = base && k !== 1 ? { ...base, v: base.v.map((v) => v * k) } : base;
  const fc = fcBase && k !== 1
    ? Object.fromEntries(Object.entries(fcBase).map(([h, x]) => [h, typeof x === 'object' ? { ...x, value: x.value * k, lo: x.lo * k, hi: x.hi * k } : x])) as FcPlayer
    : fcBase;
  if (!hist || hist.v.length < 2) {
    return <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 4 }}>
      No weekly history yet (kept for players in 100+ trades). Last traded {p.lastTraded ?? '—'}.
    </p>;
  }
  const W = 760, H = 220, M = { l: 40, r: 16, t: 12, b: 24 };
  const day = 86400000;
  const t0 = Date.parse(hist.from) + 6 * day;   // each weekly value is as of its week's last day
  const pts = hist.v.map((v, i) => [t0 + i * 7 * day, v] as const);
  const last = pts[pts.length - 1][0];
  const fpts = HZ.flatMap((h) => (fc?.[h.key] ? [{ t: last + h.weeks * 7 * day, ...fc[h.key]! }] : []));
  const xMax = fpts.length ? fpts[fpts.length - 1].t : last;
  const yMax = Math.max(...pts.map((q) => q[1]), ...fpts.map((q) => q.hi)) * 1.08;
  const X = (t: number) => M.l + ((t - pts[0][0]) / (xMax - pts[0][0])) * (W - M.l - M.r);
  const Y = (v: number) => H - M.b - (v / yMax) * (H - M.t - M.b);
  const step = yMax > 300 ? 100 : yMax > 120 ? 50 : yMax > 50 ? 20 : 10;
  const years: number[] = [];
  for (let y = new Date(pts[0][0]).getUTCFullYear(); y <= new Date(xMax).getUTCFullYear() + 1; y++) years.push(y);
  return (
    <div style={{ padding: '6px 4px' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: W, height: 'auto', display: 'block' }} role="img"
        aria-label={`${p.name} trade value history and forecast`}>
        {Array.from({ length: Math.floor(yMax / step) + 1 }, (_, i) => i * step).map((v) => (
          <g key={v}>
            <line x1={M.l} x2={W - M.r} y1={Y(v)} y2={Y(v)} stroke="var(--border)" strokeWidth={1} />
            <text x={M.l - 6} y={Y(v) + 4} textAnchor="end" fontSize={10} fill="var(--text-muted)">{v}</text>
          </g>
        ))}
        {years.map((y) => {
          const t = Date.UTC(y, 0, 1);
          return t > pts[0][0] && t < xMax
            ? <text key={y} x={X(t)} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--text-muted)">{y}</text> : null;
        })}
        <line x1={X(last)} x2={X(last)} y1={M.t} y2={H - M.b} stroke="var(--border)" strokeDasharray="3 3" />
        <path d={pts.map((q, i) => `${i ? 'L' : 'M'}${X(q[0]).toFixed(1)},${Y(q[1]).toFixed(1)}`).join('')}
          fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
        {fpts.map((q) => (
          <g key={q.t}>
            <line x1={X(q.t)} x2={X(q.t)} y1={Y(q.lo)} y2={Y(q.hi)} stroke="var(--text-muted)" strokeWidth={2} strokeLinecap="round" />
            <circle cx={X(q.t)} cy={Y(q.value)} r={4} fill="var(--bg-card)" stroke="var(--accent)" strokeWidth={2} />
          </g>
        ))}
        {fpts.length > 0 && (
          <path d={`M${X(last)},${Y(pts[pts.length - 1][1])}` + fpts.map((q) => `L${X(q.t)},${Y(q.value)}`).join('')}
            fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="4 4" />
        )}
      </svg>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>
        Solid: weekly value, each from trades up to that week. Dashed: forecast medians at 1, 3, 6 and 12 months with
        80% ranges. 52-week range {p.low52w?.toFixed(0) ?? '—'}–{p.high52w?.toFixed(0) ?? '—'} · 12-week change {pct(p.change12w)} ·
        acceleration {pct(p.acceleration, 1)}/wk · {p.trades8w} trades in 8 weeks · last traded {p.lastTraded ?? '—'}.
      </p>
    </div>
  );
}

const FMT_LABEL: Record<Fmt, string> = { superflex: 'superflex', '1qb': '1QB' };

function BlendCell({ g }: { g?: BlendGap }) {
  if (!g) return <td style={{ color: 'var(--text-muted)' }} title="Not on the StatHead blend board">—</td>;
  const big = g.note !== 'close' && Math.abs(g.gap) >= 0.15;
  return (
    <td title={g.note === 'close' ? 'Within the noise of his trade value' : undefined}>
      <span style={{ color: 'var(--text-muted)' }}>#{g.blendRank}</span>
      <div style={{ fontSize: 10, fontWeight: big ? 700 : 400, color: big ? 'var(--text-primary)' : 'var(--text-muted)' }}>
        {g.note === 'close' ? '≈' : pct(g.gap)}
      </div>
    </td>
  );
}

/** One player's gap to the blend, in parts. */
function BlendWhy({ p, g, fmt }: { p: TVPlayer; g?: BlendGap; fmt: Fmt }) {
  if (!g) return null;
  const head = `Trades rank him #${g.tradeRank} among players on both boards; the StatHead blend has him #${g.blendRank}.`;
  if (g.note === 'close') {
    return <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 4px 0' }}>
      {head} The gap ({pct(g.gap)}) is inside the noise of his trade value: the two agree on him.
    </p>;
  }
  const more = g.player > 0 ? 'more' : 'less';
  const rest = {
    thin: `only ${p.trades4w} trades in 4 weeks, so his trade value leans on older trades and this part is soft.`,
    noise: `that is inside his trade value's 90% range, so treat it as noise.`,
    moving: `his trade value moved ${pct(p.change4w)} in 4 weeks in the same direction: a recent move the blend has not matched (yet).`,
    real: `managers are steadily paying ${more} for him than the blend's price, beyond what his position and age explain.`,
  }[g.note];
  return (
    <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '4px 4px 0' }}>
      {head} Trades pay {pct(g.gap)} against the blend at his rank. Of that: {p.pos}s in {FMT_LABEL[fmt]} trade{' '}
      {pct(g.position)} against the blend on average; {p.pos}s aged {g.ageBand || '?'} a further {pct(g.age)}; the
      remaining {pct(g.player)} is him: {rest}
    </p>
  );
}

const SCORING_LABEL: Record<string, string> = {
  'tePremiumUnder0.75': 'TE premium under 0.75 a catch (mostly 0.5)', 'tePremium0.75Plus': 'TE premium 0.75+ a catch (mostly 1.0)',
  passTd6: '6-point passing TDs',
};

/** The fitted scoring factors: what a TE premium or 6-point passing TDs does to a player's trade price. */
function ScoringTable({ scoring, fmt }: { scoring: Record<string, ScoringFactor>; fmt: Fmt }) {
  const keys = Object.keys(SCORING_LABEL).filter((k) => scoring[k]);
  if (!keys.length) return null;
  return (
    <div style={{ marginTop: 20, maxWidth: 820 }}>
      <h3 style={{ fontSize: 15, margin: '0 0 6px' }}>League scoring</h3>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 6px' }}>
        The table&apos;s values are for leagues with no TE premium and 4-point passing TDs. In other leagues a TE or QB
        trades at his value times the factor below, fitted week by week from trades in those leagues ({FMT_LABEL[fmt]}).
      </p>
      <div className="table-container">
        <table style={{ fontSize: 12 }}>
          <thead><tr><th style={{ textAlign: 'left' }}>Scoring</th><th>Position</th><th>Factor</th><th>A year ago</th><th>Trades</th></tr></thead>
          <tbody>
            {keys.map((k) => {
              const s = scoring[k];
              return (
                <tr key={k}>
                  <td style={{ textAlign: 'left' }}>{SCORING_LABEL[k]}</td>
                  <td>{s.position}</td>
                  <td style={{ fontWeight: 600 }}>×{s.factor.toFixed(2)}</td>
                  <td>{s.factor52wAgo != null ? `×${s.factor52wAgo.toFixed(2)}` : '—'}</td>
                  <td title={`${s.trades4w.toLocaleString()} in the last 4 weeks`}>{s.trades.toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Where trades and the blend differ, and why: groups, age, picks. */
function BlendSection({ cmp, picks, fmt, scoring }: { cmp: BlendComparison; picks: ReturnType<typeof comparePicks>; fmt: Fmt; scoring?: Record<string, ScoringFactor> }) {
  const cell = (x?: number) => <td style={{ color: x == null ? 'var(--text-muted)' : Math.abs(x) >= 0.1 ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: x != null && Math.abs(x) >= 0.1 ? 600 : 400 }}>{x == null ? '—' : pct(x)}</td>;
  const age = (pos: string, band: string) => cmp.ages.find((a) => a.pos === pos && a.band === band);
  const star = Math.pow(2, 1 / cmp.slope);
  const gapAt = (pos: string) => cmp.positions.find((g) => g.key === pos)?.gap ?? 0;
  // Receivers and backs past 27, weighted by group size.
  const old = cmp.ages.filter((a) => (a.pos === 'WR' || a.pos === 'RB') && (a.band === '27-29' || a.band === '30+'));
  const vets = old.reduce((t, a) => t + a.gap * a.n, 0) / (old.reduce((t, a) => t + a.n, 0) || 1);
  return (
    <div style={{ marginTop: 20, maxWidth: 820 }}>
      <h3 style={{ fontSize: 15, margin: '0 0 6px' }}>Trades vs the StatHead blend</h3>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 8px' }}>
        The blend is a list price: StatHead&apos;s blend of two dynasty markets. Trade values are what managers paid. Both are
        kept; where they differ, the difference is information. Gaps are read at the same rank, not on the raw numbers,
        because the two scales differ: trade values add up (two 50s trade for one 100), while list prices pay stars a
        premium. A player the blend prices at twice another trades for about {star.toFixed(2)}× him. Compared over{' '}
        {cmp.n} {FMT_LABEL[fmt]} players traded 10+ times in 4 weeks. + = trades pay more than the blend.
      </p>
      <div className="table-container">
        <table style={{ fontSize: 12 }}>
          <thead>
            <tr><th style={{ textAlign: 'left' }}>Position</th><th>All ages</th>{AGE_BANDS.map(([b]) => <th key={b}>{b}</th>)}</tr>
          </thead>
          <tbody>
            {cmp.positions.map((g) => (
              <tr key={g.key}>
                <td style={{ textAlign: 'left' }}>{g.key} <span style={{ color: 'var(--text-muted)' }}>({g.n})</span></td>
                {cell(g.gap)}
                {AGE_BANDS.map(([b]) => {
                  const a = age(g.key, b);
                  return a && a.n >= 5 ? <td key={b} title={`${a.n} players; on top of the position column`}>{pct(a.gap)}</td> : <td key={b} style={{ color: 'var(--text-muted)' }}>—</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 10px' }}>
        Age columns are on top of the position column. Means are shrunk toward zero, so small groups read closer to it.
      </p>
      <ul style={{ fontSize: 12, color: 'var(--text-secondary)', paddingLeft: 18, margin: '0 0 10px' }}>
        {scoring?.['tePremium0.75Plus'] && <li><b>TE premium</b> is taken out first: in leagues paying a TE premium,
          trades price TEs at ×{scoring['tePremium0.75Plus'].factor.toFixed(2)} (1.0 a catch)
          {scoring['tePremiumUnder0.75'] ? <> or ×{scoring['tePremiumUnder0.75'].factor.toFixed(2)} (0.5)</> : null} their
          no-premium value. The values compared here are no-premium, like the blend.
          {Math.abs(gapAt('TE')) >= 0.05 ? <> TEs still trade {pct(gapAt('TE'))} against the blend after that.</> : <> After that, TEs trade in line with it.</>}</li>}
        {!scoring?.['tePremium0.75Plus'] && gapAt('TE') >= 0.05 && <li><b>Tight ends</b> trade {pct(gapAt('TE'))} above the
          blend: many leagues score TEs a premium per catch, and the blend has no TE-premium version.</li>}
        {scoring?.passTd6 && <li><b>6-point passing TDs</b>: in those leagues trades price QBs at
          ×{scoring.passTd6.factor.toFixed(2)} their 4-point value; the values compared here are 4-point, like the blend.
          {gapAt('QB') >= 0.05 ? <> QBs still trade {pct(gapAt('QB'))} above the blend after that: a dependable starter fills a lineup slot every week{fmt === '1qb' ? ', and single-QB managers pay for that more than the list prices do' : ''}.</> : null}</li>}
        {!scoring?.passTd6 && gapAt('QB') >= 0.05 && <li><b>Quarterbacks</b> trade {pct(gapAt('QB'))} above the blend: a
          dependable starter fills a lineup slot every week{fmt === '1qb' ? ', and managers in single-QB leagues pay for that more than the list prices do' : ''}.</li>}
        {vets > 0.05 && <li><b>Veterans</b>: older receivers and backs trade above their list price ({pct(vets)} on
          average past 27) while young players trade below it. Contending teams buy this season&apos;s points.</li>}
        <li><b>Recent news</b>: trade values move with each week&apos;s trades, so an injury or role change shows up as the
          trades happen; a fresh gap can close either way.</li>
        <li><b>Noise</b>: a player in few trades, or whose trades disagree, can sit far from the blend by chance. Gaps
          inside his value&apos;s 90% range read as ≈.</li>
      </ul>
      {picks.length > 0 && (
        <>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 6px' }}>
            <b>Picks</b>: trades mark down future and later-round picks more than the blend does. Each pick as a share of a
            mid 1st in the next draft:
          </p>
          <div className="table-container">
            <table style={{ fontSize: 12 }}>
              <thead><tr><th style={{ textAlign: 'left' }}>Pick</th><th>Blend</th><th>Trades</th></tr></thead>
              <tbody>
                {picks.map((r) => (
                  <tr key={r.label}>
                    <td style={{ textAlign: 'left' }}>{r.label}</td>
                    <td>{r.blend == null ? '—' : `${(r.blend * 100).toFixed(0)}%`}</td>
                    <td>{r.trades == null ? '—' : `${(r.trades * 100).toFixed(0)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

const TIER_LABEL: Record<string, string> = { E: 'Early', M: 'Mid', L: 'Late', U: 'Any' };

/** Current rookie-pick values on the same scale. */
function PickTable({ picks }: { picks: TVPick[] }) {
  const get = (r: number, a: number, t: string) => picks.find((p) => p.round === r && p.ahead === a && p.tier === t);
  const rows = [
    ...['E', 'M', 'L'].map((t) => ({ label: `${TIER_LABEL[t]} pick, next draft`, a: 0, t })),
    { label: 'Pick next year (order unknown)', a: 1, t: 'U' },
    { label: 'Pick in two years', a: 2, t: 'U' },
  ];
  return (
    <div style={{ marginTop: 20 }}>
      <h3 style={{ fontSize: 15, margin: '0 0 6px' }}>Rookie picks, same scale</h3>
      <div className="table-container">
        <table>
          <thead><tr><th style={{ textAlign: 'left' }}>Pick</th>{[1, 2, 3, 4].map((r) => <th key={r}>Round {r}</th>)}</tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td style={{ textAlign: 'left' }}>{row.label}</td>
                {[1, 2, 3, 4].map((r) => {
                  const p = get(r, row.a, row.t);
                  return <td key={r} title={p ? `${p.n.toLocaleString()} trades` : ''}>{p ? p.value.toFixed(0) : '—'}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Method({ f, fc, fcDoc }: { f: TVFormat; fc?: FcDoc['formats'][string]; fcDoc: FcDoc | null }) {
  return (
    <details style={{ marginTop: 16, fontSize: 12, color: 'var(--text-secondary)', maxWidth: 820 }}>
      <summary style={{ cursor: 'pointer' }}>How these are made, and how good the forecasts are</summary>
      <p>
        Every completed two-team trade in a public Sleeper dynasty or keeper league (no FAAB) is read as an even swap:
        both managers accepted it. Each player and each rookie-pick class gets one value per week, fitted so the two
        sides of every trade balance, moving week to week only as far as trades push it. Each week&apos;s value uses only
        trades made by the end of that week. Priced with the previous week&apos;s values, a week&apos;s trades balance to
        within a median {f.nextWeek?.asOfError != null ? `${(f.nextWeek.asOfError * 100).toFixed(0)}%` : '—'} (log ratio of the two sides).
      </p>
      <p>
        Dispersion is how much recent trades disagree about a player; the 90% range combines it with his trade count and
        weekly volatility. Superflex and 1QB leagues are valued separately.
      </p>
      {fc && fcDoc && (
        <>
          <p>
            Forecasts: gradient-boosted models on how values moved over the next 1, 3, 6 and 12 months from the same
            point in their history, using momentum, the time of year, age, draft capital and production. Checked on
            later weeks they never saw, against a forecast of no change:
          </p>
          <table style={{ fontSize: 12 }}>
            <thead><tr><th style={{ textAlign: 'left' }}>Horizon</th><th>Error vs no change</th><th>Direction right on 10%+ moves</th><th>80% range covered</th></tr></thead>
            <tbody>
              {fcDoc.horizons.map((h) => {
                const m = fc.metrics[`h${h.weeks}`]?.walkForward;
                return (
                  <tr key={h.weeks}>
                    <td style={{ textAlign: 'left' }}>{h.label}</td>
                    <td>{m?.skill != null ? `${(m.skill * 100).toFixed(1)}% lower` : '—'}</td>
                    <td>{m?.directionHit != null ? `${(m.directionHit * 100).toFixed(0)}%` : '—'}</td>
                    <td>{m?.coverage80 != null ? `${(m.coverage80 * 100).toFixed(0)}%` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p>
            Values are hard to forecast: the models beat &quot;no change&quot; by a few percent, mostly by catching aging
            declines and by calling the direction of big moves. Treat them as a lean, not a price.
          </p>
        </>
      )}
    </details>
  );
}
