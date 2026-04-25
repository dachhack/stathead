import { useState, useEffect, useMemo } from 'react';
import { normName } from '../lib/nameUtils';
import { loadScoreManifest } from '../lib/modelScoreClient';
import type { AdpCurve } from '../lib/modelScoreStore';

// Simple draft-board table backed by the model score-store.
//
// Three signals per row, each with a clean definition:
//
//  Pick Edge   = predictedPPG (ADP-free model) − (intercept + slope·√ADP).
//                Positive = model thinks the player out-earns what someone
//                at this ADP slot typically delivers.
//
//  Beat %      = P(actual season PPG > ADP-curve baseline), Gaussian
//                approximation from the 10/90 quantile bounds in
//                score-store/adp.json. Two-tailed quantile gap → σ;
//                midpoint → μ. Real probability, not a categorical label.
//
//  Upside / Downside (PPG) = ciUpper − predictedVor and predictedVor −
//                ciLower. Raw PPG range to the model's 90th/10th
//                percentile. NOT a probability — it's the size of the
//                model's belief band on either side of its central
//                prediction.

interface AdpScoreEntry {
  name: string;
  position: string;
  team: string;
  adp: number;
  predictedVor: number; // (Mislabeled in the JSON — actually ADP-aware predicted PPG; kept here only for upside/downside range math.)
  hitProb: string;      // Categorical 'Likely Hit' / 'Middle' / 'Likely Bust' label — no longer surfaced; superseded by `pBeat`.
  ciLower: number;
  ciUpper: number;
  isRookie: boolean;
}

interface PpgScoreEntry {
  name: string;
  position: string;
  predictedPPG: number;
}

interface Row {
  name: string;
  position: string;
  team: string;
  adp: number;
  predictedPPG: number;
  adpBaselinePPG: number; // intercept + slope·√ADP for this player's position (NaN if curve missing or ADP missing)
  pickEdge: number;       // predictedPPG − adpBaselinePPG (NaN if either side missing)
  pBeat: number;          // P(actual season PPG > adpBaselinePPG) from quantile-bound Gaussian (NaN if bounds or baseline missing)
  upsidePPG: number;      // ciUpper − predictedVor (NaN if bounds missing)
  downsidePPG: number;    // predictedVor − ciLower (NaN if bounds missing)
  isRookie: boolean;
}

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'] as const;
type PosFilter = typeof POSITIONS[number];

type SortKey = 'adp' | 'pickEdge' | 'predictedPPG' | 'pBeat' | 'upsidePPG' | 'downsidePPG' | 'name';

const BASE = import.meta.env.BASE_URL;

// 80% CI = ±1.2816σ. q90 − q10 = 2 × 1.2816σ → σ = (q90 − q10) / 2.5631.
const TWO_Z_90 = 2 * 1.2815515655446004;

/** Abramowitz & Stegun 26.2.17 normal CDF, accurate to ~7.5e-8. */
function normCdf(z: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/**
 * P(actual > baseline) under a Gaussian approximation. We anchor μ on the
 * ADP-free model's `predictedPPG` (same input PickEdge uses) and borrow σ
 * from the ADP-aware quantile bounds: σ = (ciUpper − ciLower) / 2.5631.
 *
 * Why mix models: PickEdge and Beat % must agree at the boundary
 * (Edge=0 ↔ Beat=50%). The CI midpoint is the ADP-aware model's center,
 * which can differ from the ADP-free PPG by several PPG (the two models
 * disagree about how much ADP-as-a-feature should pull predictions toward
 * the curve). Using ADP-aware σ as a proxy for the ADP-free model's σ is
 * a heuristic — both predict the same outcome so their uncertainty is
 * roughly comparable. Out-of-sample CI calibration is not yet validated
 * (in-sample 80% coverage = 79–83% per position, on target).
 *
 * Returns NaN when bounds are degenerate or required inputs are missing.
 */
function probBeatBaseline(
  centerPPG: number,
  ciLower: number,
  ciUpper: number,
  baseline: number,
): number {
  if (!Number.isFinite(centerPPG) || !Number.isFinite(ciLower) || !Number.isFinite(ciUpper) || !Number.isFinite(baseline)) return NaN;
  const width = ciUpper - ciLower;
  if (width <= 0.5) return NaN; // degenerate / fallback ±0.5 — no real distribution to integrate.
  const sigma = width / TWO_Z_90;
  return 1 - normCdf((baseline - centerPPG) / sigma);
}

function fmtEdge(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}`;
}

function fmtRange(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '—';
  return v.toFixed(1);
}

function fmtPct(p: number): string {
  if (!Number.isFinite(p)) return '—';
  return `${Math.round(p * 100)}%`;
}

function pickEdgeColor(e: number): string {
  if (!Number.isFinite(e)) return 'var(--text-muted)';
  if (e >= 2.0) return '#22c55e';
  if (e >= 1.0) return '#86efac';
  if (e >= 0.3) return '#a3e635';
  if (e <= -2.0) return '#ef4444';
  if (e <= -1.0) return '#fca5a5';
  if (e <= -0.3) return '#fb923c';
  return 'var(--text-muted)';
}

function pBeatColor(p: number): string {
  if (!Number.isFinite(p)) return 'var(--text-muted)';
  if (p >= 0.65) return '#22c55e';
  if (p >= 0.55) return '#86efac';
  if (p >= 0.45) return 'var(--text-primary)';
  if (p >= 0.35) return '#fb923c';
  return '#ef4444';
}

function upsideColor(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return 'var(--text-muted)';
  if (v >= 7) return '#22c55e';
  if (v >= 4) return '#86efac';
  if (v >= 2) return '#a3e635';
  return 'var(--text-muted)';
}

function downsideColor(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return 'var(--text-muted)';
  if (v >= 7) return '#ef4444';
  if (v >= 4) return '#fca5a5';
  if (v >= 2) return '#fb923c';
  return 'var(--text-muted)';
}

export function DraftOptimizerTable() {
  const [rows, setRows] = useState<Row[]>([]);
  const [curves, setCurves] = useState<Record<string, AdpCurve>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [posFilter, setPosFilter] = useState<PosFilter>('ALL');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('pickEdge');
  const [sortAsc, setSortAsc] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetch(`${BASE}data/score-store/adp.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch(`${BASE}data/score-store/ppg.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      loadScoreManifest(),
    ]).then(([adpData, ppgData, manifest]: [AdpScoreEntry[], PpgScoreEntry[], Awaited<ReturnType<typeof loadScoreManifest>>]) => {
      if (cancelled) return;
      if (!adpData?.length) {
        setError('Draft data not available yet — the build deploys every 2 hours.');
        setLoading(false);
        return;
      }
      const ppgByName = new Map<string, number>();
      for (const p of ppgData ?? []) {
        if (p?.name) ppgByName.set(normName(p.name), Number(p.predictedPPG) || 0);
      }
      const adpCurves = manifest?.adpCurves ?? {};

      const built: Row[] = adpData.map((a) => {
        const adp = Number(a.adp) || 999;
        const pred = ppgByName.get(normName(a.name)) ?? 0;
        const ciL = Number(a.ciLower);
        const ciU = Number(a.ciUpper);
        const center = Number(a.predictedVor);
        const haveCI = Number.isFinite(ciL) && Number.isFinite(ciU) && ciU > ciL;
        const upsidePPG = haveCI && Number.isFinite(center) ? Math.max(0, ciU - center) : NaN;
        const downsidePPG = haveCI && Number.isFinite(center) ? Math.max(0, center - ciL) : NaN;

        const curve = adpCurves[a.position];
        // Curve undefined OR ADP missing OR predicted PPG missing → no edge.
        // poolOffset corrects for selection bias between historical training
        // rows and the curated 2026 pool (see AdpCurve docstring). Falls
        // back to 0 (sqrt-only baseline) if a manifest from before the
        // recentering shipped is in use.
        const adpBaselinePPG = curve && adp < 999 && pred > 0
          ? curve.sqrtIntercept + curve.sqrtSlope * Math.sqrt(adp) + (curve.poolOffset ?? 0)
          : NaN;
        const pickEdge = Number.isFinite(adpBaselinePPG) ? pred - adpBaselinePPG : NaN;
        const pBeat = haveCI && pred > 0 ? probBeatBaseline(pred, ciL, ciU, adpBaselinePPG) : NaN;

        return {
          name: a.name,
          position: a.position,
          team: a.team,
          adp,
          predictedPPG: pred,
          adpBaselinePPG,
          pickEdge,
          pBeat,
          upsidePPG,
          downsidePPG,
          isRookie: !!a.isRookie,
        };
      });
      setRows(built);
      setCurves(adpCurves);
      setLoading(false);
    }).catch((e) => {
      if (!cancelled) {
        setError(e instanceof Error ? e.message : 'Failed to load draft data');
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const displayRows = useMemo(() => {
    let out = rows;
    if (posFilter !== 'ALL') out = out.filter((r) => r.position === posFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter((r) => r.name.toLowerCase().includes(q) || r.team.toLowerCase().includes(q));
    }
    out = [...out].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      // NaN always sorts to the bottom regardless of direction (e.g. Pick Edge
      // is NaN when ADP curve or PPG prediction is missing).
      const aNaN = typeof av === 'number' && !Number.isFinite(av);
      const bNaN = typeof bv === 'number' && !Number.isFinite(bv);
      if (aNaN && bNaN) return 0;
      if (aNaN) return 1;
      if (bNaN) return -1;
      return sortAsc ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
    return out;
  }, [rows, posFilter, search, sortKey, sortAsc]);

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortAsc((v) => !v);
    } else {
      setSortKey(key);
      // ADP and name default to ascending; everything else (edge, PPG, z-scores) descending.
      setSortAsc(key === 'adp' || key === 'name');
    }
  };

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortAsc ? ' ▲' : ' ▼') : '');

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading draft board...</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="empty-state">
        <h3>Draft Optimizer</h3>
        <p>{error}</p>
      </div>
    );
  }

  const th: React.CSSProperties = {
    padding: '6px 8px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
    cursor: 'pointer', userSelect: 'none',
  };
  const td: React.CSSProperties = { padding: '5px 8px', fontSize: 12 };

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Draft Optimizer</h1>
        <span style={{
          fontSize: 11, background: 'var(--bg-tertiary)', color: 'var(--text-muted)',
          border: '1px solid var(--border)', borderRadius: 6, padding: '2px 8px', fontWeight: 600,
        }}>
          Table view
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          {displayRows.length} players
        </span>
      </div>

      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.55 }}>
        Sorted by <strong>Pick Edge</strong> — predicted PPG (ADP-free model)
        minus the position's ADP-curve baseline{' '}
        <code>(intercept + slope·√ADP + poolOffset)</code>. The
        sqrt-curve is fit on 2010–2025 historical actuals; the poolOffset
        recenters the baseline so PickEdge averages zero across the
        current 2026 pool — without it, predictions skew systematically
        positive because the pool is curated to rosterable players while
        the historical curve includes every flameout that ever had an
        ADP. So PickEdge reads as "edge over the typical 2026 draftable
        at this ADP."{' '}
        <strong>Beat %</strong> is the Gaussian-approximated probability
        that actual PPG exceeds that baseline, with σ borrowed from the
        10/90 quantile bounds (in-sample 80% CI coverage on target; OOS
        not yet validated). <strong>Upside / Downside</strong> are raw
        PPG distances from the central prediction to ciUpper / ciLower —
        size of the uncertainty band, not a probability of booming or
        busting.
        {Object.keys(curves).length === 0 && (
          <span style={{ color: '#fb923c', marginLeft: 6 }}>
            ADP curve unavailable — Pick Edge and Beat % will show as “—”
            until the next score-store build.
          </span>
        )}
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {POSITIONS.map((p) => (
          <button
            key={p}
            className={`pos-filter ${posFilter === p ? 'active' : ''}`}
            onClick={() => setPosFilter(p)}
          >
            {p}
          </button>
        ))}
        <input
          type="text"
          placeholder="Search player or team..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '4px 8px', fontSize: 12, color: 'var(--text-primary)',
            width: 200, fontFamily: 'inherit', marginLeft: 'auto',
          }}
        />
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border)' }}>
              <th style={{ ...th, textAlign: 'center', width: 36, cursor: 'default' }}>#</th>
              <th style={{ ...th, textAlign: 'left' }} onClick={() => handleSort('name')}>
                Player{sortArrow('name')}
              </th>
              <th style={{ ...th, textAlign: 'center', width: 40 }}>Pos</th>
              <th style={{ ...th, textAlign: 'center', width: 40 }}>Tm</th>
              <th style={{ ...th, textAlign: 'right', width: 56 }} onClick={() => handleSort('adp')}>
                ADP{sortArrow('adp')}
              </th>
              <th style={{ ...th, textAlign: 'right', width: 64 }} onClick={() => handleSort('predictedPPG')}>
                <span title="Model-predicted PPG">Pred PPG</span>{sortArrow('predictedPPG')}
              </th>
              <th style={{ ...th, textAlign: 'right', width: 72 }} onClick={() => handleSort('pickEdge')}>
                <span title="Pick Edge: predicted PPG minus the ADP curve baseline (intercept + slope·√ADP) for this position. Positive = model thinks the player out-earns ADP.">Pick Edge</span>{sortArrow('pickEdge')}
              </th>
              <th style={{ ...th, textAlign: 'right', width: 60 }} onClick={() => handleSort('pBeat')}>
                <span title="P(season PPG > ADP-curve baseline). Gaussian approximation from the 10/90 quantile bounds (q90 − q10 = 2 × 1.2816σ).">Beat %</span>{sortArrow('pBeat')}
              </th>
              <th style={{ ...th, textAlign: 'right', width: 60 }} onClick={() => handleSort('upsidePPG')}>
                <span title="Upside PPG: ciUpper (90th percentile) minus the model's central prediction. Size of the model's belief band on the high side. NOT a probability of booming.">Upside</span>{sortArrow('upsidePPG')}
              </th>
              <th style={{ ...th, textAlign: 'right', width: 60 }} onClick={() => handleSort('downsidePPG')}>
                <span title="Downside PPG: model's central prediction minus ciLower (10th percentile). Size of the model's belief band on the low side. NOT a probability of busting.">Downside</span>{sortArrow('downsidePPG')}
              </th>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((r, i) => (
              <tr key={`${r.name}:${r.position}`} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ ...td, textAlign: 'center', color: 'var(--text-muted)', fontWeight: 700 }}>
                  {i + 1}
                </td>
                <td style={{ ...td, fontWeight: 600 }}>
                  {r.name}
                  {r.isRookie && <span style={{ fontSize: 9, color: '#6366f1', marginLeft: 4 }}>R</span>}
                </td>
                <td style={{ ...td, textAlign: 'center' }}>
                  <span className={`pos-badge pos-${r.position}`} style={{ fontSize: 10 }}>{r.position}</span>
                </td>
                <td style={{ ...td, textAlign: 'center', color: 'var(--text-muted)' }}>{r.team || '—'}</td>
                <td style={{ ...td, textAlign: 'right' }}>{r.adp < 999 ? r.adp.toFixed(1) : '—'}</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>
                  {r.predictedPPG > 0 ? r.predictedPPG.toFixed(1) : '—'}
                </td>
                <td
                  style={{ ...td, textAlign: 'right', fontWeight: 700, color: pickEdgeColor(r.pickEdge) }}
                  title={
                    Number.isFinite(r.pickEdge)
                      ? `Predicted ${r.predictedPPG.toFixed(1)} PPG − baseline ${r.adpBaselinePPG.toFixed(1)} PPG (${r.position} curve at ADP ${r.adp.toFixed(1)})`
                      : 'No baseline available — missing ADP, predicted PPG, or curve coefficients.'
                  }
                >
                  {fmtEdge(r.pickEdge)}
                </td>
                <td
                  style={{ ...td, textAlign: 'right', fontWeight: 700, color: pBeatColor(r.pBeat) }}
                  title={
                    Number.isFinite(r.pBeat)
                      ? `Gaussian P(actual > ${r.adpBaselinePPG.toFixed(1)} PPG) using μ=midpoint(${(r.upsidePPG + r.downsidePPG > 0 ? 'CI bounds' : 'n/a')}), σ from CI width.`
                      : 'No CI bounds or baseline available.'
                  }
                >
                  {fmtPct(r.pBeat)}
                </td>
                <td
                  style={{ ...td, textAlign: 'right', fontWeight: 600, color: upsideColor(r.upsidePPG) }}
                  title={Number.isFinite(r.upsidePPG) ? `+${r.upsidePPG.toFixed(1)} PPG to ciUpper` : 'No CI bounds available.'}
                >
                  {fmtRange(r.upsidePPG)}
                </td>
                <td
                  style={{ ...td, textAlign: 'right', fontWeight: 600, color: downsideColor(r.downsidePPG) }}
                  title={Number.isFinite(r.downsidePPG) ? `−${r.downsidePPG.toFixed(1)} PPG to ciLower` : 'No CI bounds available.'}
                >
                  {fmtRange(r.downsidePPG)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {displayRows.length === 0 && (
        <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
          No players match your filters.
        </div>
      )}
    </div>
  );
}
