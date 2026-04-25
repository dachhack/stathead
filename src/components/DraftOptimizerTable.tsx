import { useState, useEffect, useMemo } from 'react';
import { normName } from '../lib/nameUtils';
import { loadScoreManifest } from '../lib/modelScoreClient';
import type { AdpCurve } from '../lib/modelScoreStore';
import { DraftPrepSettings as SettingsHeader } from './DraftPrepSettings';
import type { DraftPrepSettings } from '../lib/draftPrepSettings';
import { loadSettings } from '../lib/draftPrepSettings';
import { userPickNumbers, maxSurvival } from '../lib/snakeDraft';
import {
  type EdgeBoardRow,
  verdictFor, VERDICT_STYLE, pickEdgeColor, pBeatColor, fmtEdge, fmtPct,
} from '../lib/edgeBoardRow';
import { DraftRoundPlan } from './DraftRoundPlan';

// Edge Board for the draft prep tool. Backed by the model score-store and
// the user's saved league settings.
//
// Three signals per row, each with a clean definition:
//
//  Pick Edge   = predictedPPG (ADP-free model) − (intercept + slope·√ADP
//                + poolOffset). Positive = model thinks the player
//                out-earns what someone at this ADP slot typically delivers
//                in the curated 2026 pool.
//
//  Beat %      = P(actual season PPG > baseline), Gaussian approximation
//                with μ = predictedPPG, σ from the 10/90 quantile bounds.
//                Real probability, not a categorical label.
//
//  Upside / Downside (PPG) = ciUpper − predictedVor and predictedVor −
//                ciLower. Raw PPG range. Size of the model's belief band,
//                NOT a probability of booming or busting.
//
// Plus two prep-specific columns:
//
//  Target Share %ile = within-position percentile of `predTargetShare`
//                from score-store/shares.json. RB/WR have R²≈0.30 LOSO
//                — useful color. TE has R²≈0.12 — shown with low-conf
//                styling.
//
//  Verdict     = Strong Target / Target / Fair / Fade / Strong Fade.
//                Per-position thresholds derived from the live PickEdge
//                σ within position, combined with Beat %. See verdictFor().

interface AdpScoreEntry {
  name: string;
  position: string;
  team: string;
  adp: number;
  predictedVor: number;
  hitProb: string;
  ciLower: number;
  ciUpper: number;
  isRookie: boolean;
}

interface PpgScoreEntry {
  name: string;
  position: string;
  predictedPPG: number;
}

interface ShareScoreEntry {
  name: string;
  position: string;
  predTargetShare: number;
  predRushShare: number;
}

interface FfcAdpEntry {
  name: string;
  position: string;
  adp: number;
  stdev: number;
}

// Row + verdict types live in lib/edgeBoardRow.ts so multiple sections
// (Edge Board, Round Plan, future Tier Map / Targets & Fades) can share
// the same shape without circular imports. The local alias keeps
// existing call sites short.
type Row = EdgeBoardRow;

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'] as const;
type PosFilter = typeof POSITIONS[number];

// ADP bands by round in user's league. Round cutoffs are universal; band
// edges scale by numTeams, so R1-3 in 12-team = 1-36, in 10-team = 1-30.
const ADP_BANDS = [
  { id: 'ALL', label: 'All' },
  { id: 'R1-3', label: 'R1–3', maxRound: 3 },
  { id: 'R4-6', label: 'R4–6', minRound: 4, maxRound: 6 },
  { id: 'R7-10', label: 'R7–10', minRound: 7, maxRound: 10 },
  { id: 'R11+', label: 'R11+', minRound: 11 },
] as const;
type AdpBandId = typeof ADP_BANDS[number]['id'];

type SortKey = 'adp' | 'pickEdge' | 'predictedPPG' | 'pBeat' | 'upsidePPG' | 'downsidePPG' | 'targetSharePctile' | 'name';

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

function fmtRange(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '—';
  return v.toFixed(1);
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

function tsharePctileColor(p: number): string {
  if (!Number.isFinite(p)) return 'var(--text-muted)';
  if (p >= 80) return '#22c55e';
  if (p >= 60) return '#86efac';
  if (p >= 40) return 'var(--text-primary)';
  if (p >= 20) return '#fb923c';
  return '#ef4444';
}


export function DraftOptimizerTable() {
  const [settings, setSettings] = useState<DraftPrepSettings>(() => loadSettings());
  const [rows, setRows] = useState<Row[]>([]);
  const [curves, setCurves] = useState<Record<string, AdpCurve>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [posFilter, setPosFilter] = useState<PosFilter>('ALL');
  const [adpBand, setAdpBand] = useState<AdpBandId>('ALL');
  const [myPicksOnly, setMyPicksOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('pickEdge');
  const [sortAsc, setSortAsc] = useState(false);

  // User's pick numbers across the first 12 rounds — feeds the my-picks
  // filter and the survival-best column. Rebuilt whenever the user
  // tweaks league size, slot, or draft type.
  const myPicks = useMemo(
    () => userPickNumbers(12, settings.pickSlot, settings.numTeams, settings.draftType),
    [settings.pickSlot, settings.numTeams, settings.draftType],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetch(`${BASE}data/score-store/adp.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch(`${BASE}data/score-store/ppg.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch(`${BASE}data/score-store/shares.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      // FFC dump shapes vary by year — 2025 is a bare array, 2026 wraps
      // in `{ players: [...] }`. Normalize to an array on read.
      fetch(`${BASE}data/ffc_adp_ppr_2026.json`)
        .then((r) => (r.ok ? r.json() : { players: [] }))
        .then((d) => Array.isArray(d) ? d : (d?.players ?? []))
        .catch(() => []),
      loadScoreManifest(),
    ]).then(([adpData, ppgData, shareData, ffcData, manifest]: [
      AdpScoreEntry[],
      PpgScoreEntry[],
      ShareScoreEntry[],
      FfcAdpEntry[],
      Awaited<ReturnType<typeof loadScoreManifest>>,
    ]) => {
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
      const shareByKey = new Map<string, number>();
      for (const s of shareData ?? []) {
        if (s?.name) shareByKey.set(`${normName(s.name)}::${s.position}`, Number(s.predTargetShare) || 0);
      }
      const stdevByKey = new Map<string, number>();
      for (const f of ffcData ?? []) {
        if (f?.name) stdevByKey.set(`${normName(f.name)}::${f.position}`, Number(f.stdev) || 0);
      }
      const adpCurves = manifest?.adpCurves ?? {};

      // First pass: build everything except verdict + targetSharePctile —
      // those need pool-wide stats (per-position σ of PickEdge, share
      // percentiles within position).
      const partial = adpData.map((a) => {
        const adp = Number(a.adp) || 999;
        const pred = ppgByName.get(normName(a.name)) ?? 0;
        const ciL = Number(a.ciLower);
        const ciU = Number(a.ciUpper);
        const center = Number(a.predictedVor);
        const haveCI = Number.isFinite(ciL) && Number.isFinite(ciU) && ciU > ciL;
        const upsidePPG = haveCI && Number.isFinite(center) ? Math.max(0, ciU - center) : NaN;
        const downsidePPG = haveCI && Number.isFinite(center) ? Math.max(0, center - ciL) : NaN;

        const curve = adpCurves[a.position];
        const adpBaselinePPG = curve && adp < 999 && pred > 0
          ? curve.sqrtIntercept + curve.sqrtSlope * Math.sqrt(adp) + (curve.poolOffset ?? 0)
          : NaN;
        const pickEdge = Number.isFinite(adpBaselinePPG) ? pred - adpBaselinePPG : NaN;
        const pBeat = haveCI && pred > 0 ? probBeatBaseline(pred, ciL, ciU, adpBaselinePPG) : NaN;

        const stdev = stdevByKey.get(`${normName(a.name)}::${a.position}`) ?? 0;
        const rawTargetShare = shareByKey.get(`${normName(a.name)}::${a.position}`) ?? NaN;

        return {
          name: a.name,
          position: a.position,
          team: a.team,
          adp,
          stdev,
          predictedPPG: pred,
          adpBaselinePPG,
          pickEdge,
          pBeat,
          upsidePPG,
          downsidePPG,
          rawTargetShare,
          isRookie: !!a.isRookie,
        };
      });

      // Per-position σ of PickEdge for verdict thresholds.
      const sigmaByPos = new Map<string, number>();
      for (const pos of ['QB', 'RB', 'WR', 'TE']) {
        const vals = partial
          .filter((r) => r.position === pos && Number.isFinite(r.pickEdge))
          .map((r) => r.pickEdge as number);
        if (vals.length < 5) continue;
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
        const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
        sigmaByPos.set(pos, Math.sqrt(variance));
      }

      // Per-position target-share percentile. Only RB/WR/TE have shares;
      // QBs always get NaN (column displays as “—”).
      const sortedSharesByPos = new Map<string, number[]>();
      for (const pos of ['RB', 'WR', 'TE']) {
        const vals = partial
          .filter((r) => r.position === pos && Number.isFinite(r.rawTargetShare) && r.rawTargetShare > 0)
          .map((r) => r.rawTargetShare as number)
          .sort((a, b) => a - b);
        if (vals.length >= 3) sortedSharesByPos.set(pos, vals);
      }
      const pctileFor = (pos: string, share: number): number => {
        const sorted = sortedSharesByPos.get(pos);
        if (!sorted || !Number.isFinite(share) || share <= 0) return NaN;
        // Percent of pool ≤ this share.
        let lo = 0, hi = sorted.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (sorted[mid] <= share) lo = mid + 1; else hi = mid;
        }
        return Math.round((lo / sorted.length) * 100);
      };

      const built: Row[] = partial.map((r) => {
        const sigma = sigmaByPos.get(r.position) ?? NaN;
        const verdict = verdictFor(r.pickEdge, r.pBeat, sigma);
        const targetSharePctile = pctileFor(r.position, r.rawTargetShare);
        const survivalBest = r.adp < 999 ? maxSurvival(r.adp, r.stdev || undefined, myPicks) : NaN;
        return { ...r, verdict, targetSharePctile, survivalBest };
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
  }, [myPicks]);

  const displayRows = useMemo(() => {
    let out = rows;
    if (posFilter !== 'ALL') out = out.filter((r) => r.position === posFilter);
    if (adpBand !== 'ALL') {
      const band = ADP_BANDS.find((b) => b.id === adpBand);
      const N = settings.numTeams;
      const minAdp = band && 'minRound' in band ? (band.minRound - 1) * N + 1 : 1;
      const maxAdp = band && 'maxRound' in band ? band.maxRound * N : Infinity;
      out = out.filter((r) => r.adp >= minAdp && r.adp <= maxAdp);
    }
    if (myPicksOnly) {
      // Show players with a meaningful chance of being available at any of
      // the user's picks. Threshold (15%) is intentionally generous —
      // includes coin-flip sleepers, excludes only "definitely gone" picks.
      out = out.filter((r) => Number.isFinite(r.survivalBest) && r.survivalBest >= 0.15);
    }
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
  }, [rows, posFilter, adpBand, myPicksOnly, search, sortKey, sortAsc, settings.numTeams]);

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Draft Prep</h1>
        <span style={{
          fontSize: 11, background: 'var(--bg-tertiary)', color: 'var(--text-muted)',
          border: '1px solid var(--border)', borderRadius: 6, padding: '2px 8px', fontWeight: 600,
        }}>
          Edge Board
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          {displayRows.length} players
        </span>
      </div>

      <SettingsHeader settings={settings} onChange={setSettings} />

      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.55 }}>
        <strong>Pick Edge</strong> = predicted PPG minus the position's
        ADP-curve baseline (recentered to the 2026 pool).{' '}
        <strong>Beat %</strong> = P(actual PPG &gt; baseline), Gaussian
        approx with σ from quantile bounds.{' '}
        <strong>Upside / Downside</strong> = raw PPG distances to ciUpper
        / ciLower (uncertainty band, not a hit/bust probability).{' '}
        <strong>TS %ile</strong> = predicted target-share percentile
        within position (RB/WR R²≈0.30, TE R²≈0.12 — shown muted).{' '}
        <strong>Verdict</strong> uses per-position PickEdge σ × Beat %
        bands — Strong Target/Target/Fair/Fade/Strong Fade. Toggle{' '}
        <em>Available at my picks</em> to filter to players with ≥15%
        survival probability across your snake-draft picks.
        {Object.keys(curves).length === 0 && (
          <span style={{ color: '#fb923c', marginLeft: 6 }}>
            ADP curve unavailable — Pick Edge / Beat % / Verdict will
            show as “—” until the next score-store build.
          </span>
        )}
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
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

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.5 }}>
          ADP BAND
        </span>
        {ADP_BANDS.map((b) => (
          <button
            key={b.id}
            className={`pos-filter ${adpBand === b.id ? 'active' : ''}`}
            onClick={() => setAdpBand(b.id)}
            style={{ minWidth: 56 }}
          >
            {b.label}
          </button>
        ))}
        <label style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 11, fontWeight: 600, color: 'var(--text-primary)',
          background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '3px 10px', cursor: 'pointer', marginLeft: 8,
        }}>
          <input
            type="checkbox"
            checked={myPicksOnly}
            onChange={(e) => setMyPicksOnly(e.target.checked)}
            style={{ margin: 0 }}
          />
          Available at my picks
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>
            (≥15% survival)
          </span>
        </label>
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
              <th style={{ ...th, textAlign: 'right', width: 64 }} onClick={() => handleSort('targetSharePctile')}>
                <span title="Within-position percentile of predicted target share (RB/WR/TE only). RB/WR share models are LOSO R²≈0.30; TE is R²≈0.12 (shown muted).">TS %ile</span>{sortArrow('targetSharePctile')}
              </th>
              <th style={{ ...th, textAlign: 'center', width: 110, cursor: 'default' }}>
                <span title="Verdict: per-position thresholds combining PickEdge z-score and Beat %. Strong Target = ≥+1σ edge AND ≥60% beat; Target = ≥+0.5σ AND ≥50% beat; Fade/Strong Fade are mirrors.">Verdict</span>
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
                <td
                  style={{
                    ...td, textAlign: 'right', fontWeight: 600,
                    color: tsharePctileColor(r.targetSharePctile),
                    opacity: r.position === 'TE' && Number.isFinite(r.targetSharePctile) ? 0.65 : 1,
                  }}
                  title={
                    Number.isFinite(r.targetSharePctile)
                      ? `Predicted target share ${(r.rawTargetShare * 100).toFixed(1)}% — p${r.targetSharePctile} within ${r.position}` +
                        (r.position === 'TE' ? ' (TE share model R²≈0.12, treat as low confidence).' : '')
                      : 'No share prediction available.'
                  }
                >
                  {Number.isFinite(r.targetSharePctile) ? `p${r.targetSharePctile}` : '—'}
                </td>
                <td style={{ ...td, textAlign: 'center' }}>
                  <span
                    style={{
                      display: 'inline-block', fontSize: 10, fontWeight: 700,
                      padding: '2px 8px', borderRadius: 10,
                      background: VERDICT_STYLE[r.verdict].bg,
                      color: VERDICT_STYLE[r.verdict].fg,
                      border: r.verdict === 'Fair' || r.verdict === 'Unknown' ? '1px solid var(--border)' : 'none',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {VERDICT_STYLE[r.verdict].label}
                  </span>
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

      {/* Section 2: Round-by-Round Plan. Reads from the same `rows` and
          `settings` the Edge Board uses; keyed off pickSlot/numTeams/
          draftType so it auto-updates when the user tweaks the header. */}
      <DraftRoundPlan rows={rows} settings={settings} />
    </div>
  );
}
