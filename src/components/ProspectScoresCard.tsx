/**
 * ProspectScoresCard — the rookie career model's read on one prospect, drawn
 * rather than tabulated: the chance he clears each career-PPG bar against his
 * draft class, where his predicted career PPG sits among the classmates at his
 * position, and every model input as a percentile bar pointing in the
 * direction that helps him. Same data and conventions as the Prospects board's
 * card (score-store/career.json, goodness percentiles), on the player page.
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FEATURES, PRE_DRAFT_ROOKIE_FEATURES } from '../lib/featureTypes';
import { goodnessPctl, isMissing, pctlColor, type CareerScoreRec, type ProspectScores } from '../lib/prospectScores';

const ACCENT = 'var(--accent)';
const CONTEXT = 'var(--text-muted)';

const LABELS: Record<string, string> = {};
const CATEGORY: Record<string, string> = {};
for (const f of FEATURES) { LABELS[f.key] = f.label; CATEGORY[f.key] = f.category; }

// Inputs worth a bar beyond the model's own list: the headline draft-capital,
// age, athleticism and production numbers a reader expects to see.
const MARQUEE: Record<string, string[]> = {
  QB: ['nflDraftPick', 'age', 'relativeAthleticScore', 'collegeQBR2yr', 'collegeRushYpgPerAge'],
  RB: ['nflDraftPick', 'age', 'relativeAthleticScore', 'speedScore', 'collegeBestRushYds', 'collegeTotalTDs'],
  WR: ['nflDraftPick', 'age', 'relativeAthleticScore', 'speedScore', 'collegeDominatorRating', 'collegeBreakoutAge', 'collegeMarketShare'],
  TE: ['nflDraftPick', 'age', 'relativeAthleticScore', 'speedScore', 'collegeDominatorRating', 'collegeBreakoutAge'],
};

// Indicator flags and class-wide constants read as "100th percentile" for
// everyone and say nothing about the player.
const HIDE = /^(has|pdfHas|rspHas)|^draftClassDepth$/;
const COMBINE_ONLY = new Set(['forty', 'bench', 'vertical', 'broadJump', 'cone', 'shuttle', 'speedScore', 'heightAdjSpeedScore', 'relativeAthleticScore']);

function fmtVal(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Number.isInteger(v)) return v.toLocaleString();
  return Math.abs(v) < 1 ? v.toFixed(2) : v.toFixed(1);
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

// ── Threshold ladder ───────────────────────────────────────────────────────

function ThresholdLadder({ me, classmates }: { me: CareerScoreRec; classmates: CareerScoreRec[] }) {
  const rows = useMemo(() => {
    const keys = Object.keys(me.thresholdProbs || {}).sort((a, b) => Number(a) - Number(b));
    return keys.map((k) => {
      const mine = me.thresholdProbs?.[k] ?? 0;
      const vals = classmates.map((c) => c.thresholdProbs?.[k]).filter((v): v is number => typeof v === 'number');
      const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      return { k, mine, avg };
    });
  }, [me, classmates]);
  if (!rows.length) return null;
  const max = Math.max(20, ...rows.map((r) => Math.max(r.mine, r.avg ?? 0))) * 1.15;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>Chance of a career at each PPG bar</div>
        <div style={{ display: 'flex', gap: 12, fontSize: 10, color: 'var(--text-muted)' }}>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: ACCENT, borderRadius: 2, verticalAlign: -1, marginRight: 4 }} />This prospect</span>
          <span><span style={{ display: 'inline-block', width: 2, height: 10, background: CONTEXT, verticalAlign: -1, marginRight: 4 }} />Class average</span>
        </div>
      </div>
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '84px 1fr 44px', rowGap: 6, columnGap: 8, alignItems: 'center' }}>
        {rows.map((r) => (
          <FragmentRow key={r.k} r={r} max={max} />
        ))}
      </div>
    </div>
  );
}

function FragmentRow({ r, max }: { r: { k: string; mine: number; avg: number | null }; max: number }) {
  const w = Math.max(0, Math.min(100, (r.mine / max) * 100));
  const a = r.avg == null ? null : Math.max(0, Math.min(100, (r.avg / max) * 100));
  const title = `${r.mine.toFixed(0)}% chance of averaging ≥ ${r.k} PPG over his career` + (r.avg != null ? ` · class average ${r.avg.toFixed(0)}%` : '');
  return (
    <>
      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>≥ {r.k} PPG</span>
      <div title={title} style={{ position: 'relative', height: 14, background: 'var(--bg-tertiary)', borderRadius: '0 4px 4px 0' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${w}%`, background: ACCENT, borderRadius: '0 4px 4px 0' }} />
        {a != null && <div style={{ position: 'absolute', left: `calc(${a}% - 1px)`, top: -2, bottom: -2, width: 2, background: CONTEXT }} />}
      </div>
      <span style={{ fontSize: 12, fontWeight: 600, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.mine.toFixed(0)}%</span>
    </>
  );
}

// ── Class strip ────────────────────────────────────────────────────────────

/** Measured width of the strip's container, so the SVG's coordinate space is
 *  1:1 with CSS pixels: dots, ticks and labels keep their designed size on a
 *  phone instead of scaling down with a fixed 600-unit viewBox. */
function useMeasuredWidth<T extends HTMLElement>(fallback: number): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw && cw > 0) setW(Math.round(cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function ClassStrip({ me, classmates }: { me: CareerScoreRec; classmates: CareerScoreRec[] }) {
  const [wrapRef, W] = useMeasuredWidth<HTMLDivElement>(600);
  const H = 78, PAD = 14, BASE = 56;
  const all = useMemo(() => [...classmates, me].filter((r) => Number.isFinite(r.predictedPPG)), [me, classmates]);
  const { lo, hi, dots, median } = useMemo(() => {
    const vals = all.map((r) => r.predictedPPG);
    const lo0 = Math.min(...vals), hi0 = Math.max(...vals);
    const span = Math.max(0.5, hi0 - lo0);
    const lo = lo0 - span * 0.06, hi = hi0 + span * 0.06;
    const x = (v: number) => PAD + ((v - lo) / (hi - lo)) * (W - 2 * PAD);
    // Beeswarm-lite: stack a dot up a row when it would overlap the previous
    // ones at the baseline, so a crowded middle stays readable.
    const placed: { x: number; row: number }[] = [];
    const dots = [...all].sort((a, b) => a.predictedPPG - b.predictedPPG).map((r) => {
      const px = x(r.predictedPPG);
      let row = 0;
      while (placed.some((p) => p.row === row && Math.abs(p.x - px) < 9)) row++;
      placed.push({ x: px, row });
      return { r, x: px, y: BASE - row * 9, isMe: r === me };
    });
    const sorted = [...vals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return { lo, hi, dots, median, x };
  }, [all, me, W]);
  const xOf = (v: number) => PAD + ((v - lo) / (hi - lo)) * (W - 2 * PAD);
  const mine = dots.find((d) => d.isMe);
  const rank = 1 + classmates.filter((c) => c.predictedPPG > me.predictedPPG).length;
  const n = classmates.length + 1;
  return (
    <div ref={wrapRef}>
      <div style={{ fontSize: 12, fontWeight: 600 }}>
        Predicted career PPG vs the {me.draftSeason ?? ''} {me.position} class
        <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · {ordinal(rank)} of {n}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: 'block', marginTop: 4, overflow: 'visible' }} role="img"
        aria-label={`${me.name} predicted ${me.predictedPPG.toFixed(1)} career PPG, ${ordinal(rank)} of ${n} ${me.position}s in the class`}>
        <line x1={PAD} x2={W - PAD} y1={BASE + 8} y2={BASE + 8} stroke="var(--border)" strokeWidth={1} />
        <line x1={xOf(median)} x2={xOf(median)} y1={BASE + 4} y2={BASE + 12} stroke={CONTEXT} strokeWidth={2} />
        <text x={xOf(median)} y={H} fontSize={10} fill="var(--text-muted)" textAnchor="middle">median {median.toFixed(1)}</text>
        <text x={PAD} y={H} fontSize={10} fill="var(--text-muted)" textAnchor="start">{lo.toFixed(1)}</text>
        <text x={W - PAD} y={H} fontSize={10} fill="var(--text-muted)" textAnchor="end">{hi.toFixed(1)}</text>
        {dots.filter((d) => !d.isMe).map((d) => (
          <circle key={d.r.name} cx={d.x} cy={d.y} r={4} fill={CONTEXT} stroke="var(--bg-secondary)" strokeWidth={2}>
            <title>{d.r.name} · {d.r.predictedPPG.toFixed(1)} PPG</title>
          </circle>
        ))}
        {mine && (
          <>
            <circle cx={mine.x} cy={mine.y} r={6} fill={ACCENT} stroke="var(--bg-secondary)" strokeWidth={2}>
              <title>{me.name} · {me.predictedPPG.toFixed(1)} PPG</title>
            </circle>
            <text x={Math.min(W - PAD, Math.max(PAD, mine.x))} y={Math.max(10, mine.y - 11)} fontSize={11} fontWeight={600} fill="var(--text-primary)"
              textAnchor={mine.x > W * 0.8 ? 'end' : mine.x < W * 0.2 ? 'start' : 'middle'}>
              {me.predictedPPG.toFixed(1)} PPG
            </text>
          </>
        )}
      </svg>
    </div>
  );
}

// ── Model inputs ───────────────────────────────────────────────────────────

interface InputRow { key: string; label: string; category: string; raw: number | undefined; pctl: number | undefined; missing: boolean }

function ModelInputs({ me }: { me: CareerScoreRec }) {
  const groups = useMemo(() => {
    const feats = me.features || {};
    const pcts = me.featurePercentiles || {};
    const noCombine = feats.hasCombineData === 0;
    const keys = [...(PRE_DRAFT_ROOKIE_FEATURES[me.position] || []), ...(MARQUEE[me.position] || [])]
      .filter((k, i, arr) => arr.indexOf(k) === i && !HIDE.test(k) && !(noCombine && COMBINE_ONLY.has(k)));
    const rows: InputRow[] = keys.map((key) => {
      const raw = feats[key];
      const missing = isMissing(key, raw);
      const pctl = missing ? undefined : pcts[key];
      return { key, label: LABELS[key] || key, category: CATEGORY[key] || 'Other', raw, pctl, missing };
    }).filter((r) => r.missing || r.pctl != null);
    const order = ['Draft', 'Profile', 'Physical', 'College', 'Scouting', 'Sentiment', 'Other'];
    const by = new Map<string, InputRow[]>();
    for (const r of rows) (by.get(r.category) ?? by.set(r.category, []).get(r.category)!).push(r);
    return [...by.entries()].sort((a, b) => {
      const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }, [me]);
  if (!groups.length) return null;
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600 }}>Model inputs</div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', margin: '2px 0 8px' }}>
        Bar = percentile vs every {me.position} rookie the model trained on, pointed so longer and greener is better for him · raw value at right
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', columnGap: 20, rowGap: 10 }}>
        {groups.map(([cat, rows]) => (
          <div key={cat}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{cat}</div>
            {rows.map((r) => {
              const good = r.pctl == null ? null : goodnessPctl(r.key, r.pctl);
              return (
                <div key={r.key} style={{ display: 'grid', gridTemplateColumns: '112px 1fr 30px 48px', alignItems: 'center', gap: 6, marginBottom: 4 }}
                  title={r.missing ? `${r.label}: no data` : `${r.label}: ${good}th percentile (goodness) · raw ${fmtVal(r.raw as number)}`}>
                  <span style={{ fontSize: 11, color: r.missing ? 'var(--text-muted)' : 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
                  <div style={{ height: 6, background: 'var(--bg-tertiary)', borderRadius: '0 3px 3px 0' }}>
                    {good != null && <div style={{ width: `${good}%`, height: '100%', background: pctlColor(good), borderRadius: '0 3px 3px 0' }} />}
                  </div>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{good == null ? '—' : good}</span>
                  <span style={{ fontSize: 10, color: r.missing ? 'var(--text-muted)' : 'var(--text-secondary)', textAlign: 'right', fontStyle: r.missing ? 'italic' : 'normal', fontVariantNumeric: 'tabular-nums' }}>
                    {r.missing ? 'no data' : fmtVal(r.raw as number)}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Card ───────────────────────────────────────────────────────────────────

export function ProspectScoresCard({ scores }: { scores: ProspectScores }) {
  const { me, classmates } = scores;
  const zTile = (label: string, z: number | undefined, goodHigh: boolean, hint: string) => {
    if (z == null) return null;
    const strong = z >= 1, lean = z >= 0.3, opposite = z <= -0.5;
    const color = strong ? (goodHigh ? '#22c55e' : '#ef4444') : lean ? (goodHigh ? '#a3e635' : '#fb923c') : opposite ? (goodHigh ? '#fb923c' : '#22c55e') : 'var(--text-muted)';
    return (
      <div title={hint} style={{ background: 'var(--bg-tertiary)', borderRadius: 6, padding: '4px 10px', textAlign: 'center', minWidth: 64 }}>
        <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
        <div style={{ fontSize: 15, fontWeight: 700, color }}>{z >= 0 ? `+${z.toFixed(2)}` : z.toFixed(2)}</div>
      </div>
    );
  };
  return (
    <div style={{ gridColumn: '1 / -1', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Prospect Scores</h3>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
            {me.tierLabel ? <><strong style={{ color: 'var(--text-primary)' }}>{me.tierLabel}</strong> tier · </> : null}
            {me.percentile != null && <>{ordinal(Math.round(me.percentile))} percentile vs every drafted {me.position} since the model's first class · </>}
            {me.predictedPPG.toFixed(1)} predicted career PPG
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {zTile('Boom z', me.boomZ, true, 'Boom z-score: outperformance-event score standardized vs the historical rookie distribution. +1σ = unusually likely to beat his draft slot.')}
          {zTile('Bust z', me.bustZ, false, 'Bust z-score: bust-event score standardized vs the historical rookie distribution. +1σ = unusually high bust risk; −1σ = unusually safe.')}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20, marginBottom: 16 }}>
        <ThresholdLadder me={me} classmates={classmates} />
        {classmates.length >= 3 && <ClassStrip me={me} classmates={classmates} />}
      </div>
      <ModelInputs me={me} />
    </div>
  );
}
