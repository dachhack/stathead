import { useState, useEffect, useMemo } from 'react';
import { normName, positionStats, zScore } from '../lib/nameUtils';
import { loadScoreManifest } from '../lib/modelScoreClient';
import type { AdpCurve } from '../lib/modelScoreStore';

// Simple draft-board table backed by the model score-store. Per-position
// boom/bust z-scores come from the CI bounds in score-store/adp.json so the
// column reads consistently with MyRankings and the Projections page.
//
// Pick Edge = predictedPPG − (intercept + slope·√ADP) per position, where
// the curve is fit on 2010–2025 historical data and shipped in
// score-store/manifest.json. Positive = our model thinks the player will
// out-earn what someone at this ADP slot typically delivers.

interface AdpScoreEntry {
  name: string;
  position: string;
  team: string;
  adp: number;
  predictedVor: number; // (Mislabeled in the JSON — actually ADP-aware predicted PPG; kept here only for boom/bust CI math.)
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

interface Row {
  name: string;
  position: string;
  team: string;
  adp: number;
  predictedPPG: number;
  adpBaselinePPG: number; // intercept + slope·√ADP for this player's position (NaN if curve missing or ADP missing)
  pickEdge: number;       // predictedPPG − adpBaselinePPG (NaN if either side missing)
  hitProb: string;
  boomZ: number;
  bustZ: number;
  isRookie: boolean;
}

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'] as const;
type PosFilter = typeof POSITIONS[number];

type SortKey = 'adp' | 'pickEdge' | 'predictedPPG' | 'boomZ' | 'bustZ' | 'name';

const BASE = import.meta.env.BASE_URL;

function fmtZ(z: number): string {
  if (!Number.isFinite(z) || z === 0) return '—';
  const sign = z > 0 ? '+' : '';
  return `${sign}${z.toFixed(2)}`;
}

function fmtEdge(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}`;
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

function boomColor(z: number): string {
  if (z >= 1.0) return '#22c55e';
  if (z >= 0.5) return '#86efac';
  if (z >= 0.2) return '#a3e635';
  return 'var(--text-muted)';
}

function bustColor(z: number): string {
  if (z >= 1.0) return '#ef4444';
  if (z >= 0.5) return '#fca5a5';
  if (z >= 0.2) return '#fb923c';
  return 'var(--text-muted)';
}

function hitProbColor(p: string): string {
  if (p === 'Likely Hit') return '#22c55e';
  if (p === 'Likely Bust') return '#ef4444';
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
      // Per-position z-scores over CI spreads. Only positive spreads
      // contribute to the cohort so deep depth-pieces with degenerate CIs
      // don't drag the mean down.
      const spreads = adpData.map((a) => ({
        position: a.position,
        up: Math.max(0, (a.ciUpper ?? 0) - (a.predictedVor ?? 0)),
        down: Math.max(0, (a.predictedVor ?? 0) - (a.ciLower ?? 0)),
      }));
      const upStats = positionStats(spreads.filter((s) => s.up > 0), (s) => s.position, (s) => s.up);
      const downStats = positionStats(spreads.filter((s) => s.down > 0), (s) => s.position, (s) => s.down);

      const built: Row[] = adpData.map((a) => {
        const up = Math.max(0, (a.ciUpper ?? 0) - (a.predictedVor ?? 0));
        const down = Math.max(0, (a.predictedVor ?? 0) - (a.ciLower ?? 0));
        const adp = Number(a.adp) || 999;
        const pred = ppgByName.get(normName(a.name)) ?? 0;
        const curve = adpCurves[a.position];
        // Curve undefined OR ADP missing OR predicted PPG missing → no edge.
        const adpBaselinePPG = curve && adp < 999 && pred > 0
          ? curve.sqrtIntercept + curve.sqrtSlope * Math.sqrt(adp)
          : NaN;
        const pickEdge = Number.isFinite(adpBaselinePPG) ? pred - adpBaselinePPG : NaN;
        return {
          name: a.name,
          position: a.position,
          team: a.team,
          adp,
          predictedPPG: pred,
          adpBaselinePPG,
          pickEdge,
          hitProb: a.hitProb ?? '',
          boomZ: up > 0 ? Math.round(zScore(up, upStats.get(a.position)) * 100) / 100 : 0,
          bustZ: down > 0 ? Math.round(zScore(down, downStats.get(a.position)) * 100) / 100 : 0,
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
        Sorted by <strong>Pick Edge</strong> — predicted PPG (from the ADP-free
        model) minus what someone at this ADP slot typically delivers. Positive
        = our models think the player out-earns the market at this draft cost.
        The baseline curve is fit per position as{' '}
        <code>PPG = intercept + slope·√ADP</code> on 2010–2025 historical data.
        Hit probability and boom/bust z-scores come from the ADP model's
        confidence intervals.
        {Object.keys(curves).length === 0 && (
          <span style={{ color: '#fb923c', marginLeft: 6 }}>
            ADP curve unavailable — Pick Edge will show as “—” until the next
            score-store build.
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
              <th style={{ ...th, textAlign: 'center', width: 84 }}>Hit</th>
              <th style={{ ...th, textAlign: 'right', width: 56 }} onClick={() => handleSort('boomZ')}>
                <span title="Boom z-score within position — CI upside spread vs cohort">Boom z</span>{sortArrow('boomZ')}
              </th>
              <th style={{ ...th, textAlign: 'right', width: 56 }} onClick={() => handleSort('bustZ')}>
                <span title="Bust z-score within position — CI downside spread vs cohort">Bust z</span>{sortArrow('bustZ')}
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
                <td style={{ ...td, textAlign: 'center', fontSize: 11, color: hitProbColor(r.hitProb) }}>
                  {r.hitProb || '—'}
                </td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: boomColor(r.boomZ) }}>
                  {fmtZ(r.boomZ)}
                </td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: bustColor(r.bustZ) }}>
                  {fmtZ(r.bustZ)}
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
