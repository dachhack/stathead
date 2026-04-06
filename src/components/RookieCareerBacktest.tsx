import { useState, useEffect, useMemo } from 'react';
import { trainRookieCareerModels } from '../lib/rookieCareerModel';
import type { RookieCareerBacktestRow, RookieCareerModelResult } from '../lib/rookieCareerModel';
import { assemblePlayerRows } from '../lib/featureStoreClient';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];

function tierColor(tier: number): string {
  if (tier === 1) return '#22c55e';
  if (tier === 2) return '#4ade80';
  if (tier === 3) return '#a3e635';
  if (tier === 4) return '#facc15';
  if (tier === 5) return '#fb923c';
  if (tier === 6) return '#ef4444';
  return '#991b1b';
}

function tierLabel(tier: number): string {
  if (tier === 1) return 'Legendary';
  if (tier === 2) return 'Elite';
  if (tier === 3) return 'Starter';
  if (tier === 4) return 'Flex';
  if (tier === 5) return 'Bench';
  if (tier === 6) return 'Waiver';
  return 'Dart Throw';
}

function probBg(pct: number): string {
  if (pct >= 70) return 'rgba(34,197,94,0.25)';
  if (pct >= 50) return 'rgba(34,197,94,0.15)';
  if (pct >= 30) return 'rgba(163,230,53,0.12)';
  if (pct >= 15) return 'rgba(250,204,21,0.10)';
  if (pct >= 5) return 'rgba(251,146,60,0.10)';
  return 'rgba(239,68,68,0.12)';
}

function probColor(pct: number): string {
  if (pct >= 70) return '#22c55e';
  if (pct >= 50) return '#4ade80';
  if (pct >= 30) return '#a3e635';
  if (pct >= 15) return '#facc15';
  if (pct >= 5) return '#fb923c';
  return '#ef4444';
}

const POS_COLORS: Record<string, string> = { QB: '#ef4444', RB: '#22c55e', WR: '#3b82f6', TE: '#f59e0b' };

type SortField = 'name' | 'position' | 'draftSeason' | 'actualPPG' | 'predictedPPG' | 'combinedScore' | 'percentile' | 'modelTier' | 'error';

export function RookieCareerBacktest() {
  const [models, setModels] = useState<Record<string, RookieCareerModelResult> | null>(null);
  const [loading, setLoading] = useState(true);
  const [posFilter, setPosFilter] = useState('ALL');
  const [selectedSeasons, setSelectedSeasons] = useState<Set<number>>(new Set());
  const [sortField, setSortField] = useState<SortField>('combinedScore');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    async function load() {
      let d: any = null;
      try {
        const resp = await fetch(`${import.meta.env.BASE_URL}data/feature-matrix.json`);
        if (resp.ok) d = await resp.json();
      } catch {}
      if (!d || !d.rows?.length) {
        try {
          const cached = localStorage.getItem('adp_features_v3_total_none');
          if (cached) d = JSON.parse(cached);
        } catch {}
      }
      // Fallback: assemble from feature store shards
      if (!d || !d.rows?.length) {
        try {
          const storeRows = await assemblePlayerRows();
          if (storeRows.length > 0) d = { rows: storeRows };
        } catch {}
      }
      if (d?.rows?.length) {
        let careerModels = d.rookieCareerModels;
        if (!careerModels || Object.keys(careerModels).length === 0 || !careerModels[Object.keys(careerModels)[0]]?.backtestRows) {
          try { careerModels = trainRookieCareerModels(d.rows); } catch {}
        }
        setModels(careerModels || null);
      }
      setLoading(false);
    }
    load();
  }, []);

  const allRows = useMemo(() => {
    if (!models) return [];
    const rows: RookieCareerBacktestRow[] = [];
    for (const m of Object.values(models)) {
      if (m.backtestRows) rows.push(...m.backtestRows);
    }
    // Recompute combinedScore as cross-year percentile within position
    // so scores are consistent with ZAP Compare and Prospects views
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      const posRows = rows.filter(r => r.position === pos);
      if (posRows.length < 3) continue;
      const sorted = [...posRows].map(r => r.predictedPPG).sort((a, b) => a - b);
      for (const r of posRows) {
        const rank = sorted.filter(ppg => ppg <= r.predictedPPG).length;
        r.combinedScore = Math.round((rank / sorted.length) * 100);
        r.percentile = r.combinedScore;
      }
    }
    return rows;
  }, [models]);

  const seasons = useMemo(() => {
    const s = [...new Set(allRows.map(r => r.draftSeason))].sort();
    return s;
  }, [allRows]);

  const thresholds = useMemo(() => {
    if (posFilter !== 'ALL' && models?.[posFilter]) return models[posFilter].thresholds || [];
    return models?.['RB']?.thresholds || models?.['WR']?.thresholds || [];
  }, [posFilter, models]);

  const filtered = useMemo(() => {
    let d = [...allRows];
    if (posFilter !== 'ALL') d = d.filter(r => r.position === posFilter);
    if (selectedSeasons.size > 0) d = d.filter(r => selectedSeasons.has(r.draftSeason));
    d.sort((a, b) => {
      let aVal: number | string, bVal: number | string;
      if (sortField === 'error') {
        aVal = Math.abs(a.actualPPG - a.predictedPPG);
        bVal = Math.abs(b.actualPPG - b.predictedPPG);
      } else {
        aVal = a[sortField];
        bVal = b[sortField];
      }
      if (typeof aVal === 'string') return sortDir === 'asc' ? aVal.localeCompare(bVal as string) : (bVal as string).localeCompare(aVal);
      return sortDir === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });
    return d;
  }, [allRows, posFilter, selectedSeasons, sortField, sortDir]);

  const handleSort = (field: SortField) => {
    if (field === sortField) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else {
      setSortField(field);
      const descFields: SortField[] = ['actualPPG', 'predictedPPG', 'combinedScore', 'percentile'];
      setSortDir(descFields.includes(field) ? 'desc' : 'asc');
    }
  };
  const sortArrow = (field: SortField) => field === sortField ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';

  // Aggregate stats
  const stats = useMemo(() => {
    if (filtered.length === 0) return null;
    const errors = filtered.map(r => r.actualPPG - r.predictedPPG);
    const absErrors = errors.map(e => Math.abs(e));
    const mae = absErrors.reduce((s, e) => s + e, 0) / absErrors.length;
    const meanActual = filtered.reduce((s, r) => s + r.actualPPG, 0) / filtered.length;
    const ssTot = filtered.reduce((s, r) => s + (r.actualPPG - meanActual) ** 2, 0);
    const ssRes = filtered.reduce((s, r) => s + (r.actualPPG - r.predictedPPG) ** 2, 0);
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
    // Tier accuracy: what % of tier 1-3 finished with above-median actual PPG?
    const median = [...filtered].sort((a, b) => a.actualPPG - b.actualPPG)[Math.floor(filtered.length / 2)]?.actualPPG || 0;
    const topTiers = filtered.filter(r => r.modelTier <= 3);
    const topTierHit = topTiers.filter(r => r.actualPPG >= median).length;
    return { n: filtered.length, mae: mae.toFixed(1), r2: r2.toFixed(3), topTierPct: topTiers.length > 0 ? Math.round(topTierHit / topTiers.length * 100) : 0 };
  }, [filtered]);

  if (loading) return <div className="loading"><div className="spinner" /><div className="loading-text">Training career models...</div></div>;
  if (!models || allRows.length === 0) return <div className="empty-state"><h3>No Backtest Data</h3><p>Visit the Draft Optimizer tab first to generate training data, then return here.</p></div>;

  return (
    <>
      <div className="controls">
        <div className="position-filters">
          {POSITIONS.map(pos => (
            <button key={pos} className={`pos-filter ${posFilter === pos ? 'active' : ''}`} onClick={() => setPosFilter(pos)}>
              {pos}
            </button>
          ))}
        </div>
        <div className="control-group">
          <label className="control-label">Draft Class</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            <button
              className={`pos-filter ${selectedSeasons.size === 0 ? 'active' : ''}`}
              onClick={() => setSelectedSeasons(new Set())}
              style={{ fontSize: 11, padding: '3px 8px' }}
            >All</button>
            {seasons.map(s => (
              <button
                key={s}
                className={`pos-filter ${selectedSeasons.has(s) ? 'active' : ''}`}
                onClick={() => {
                  const next = new Set(selectedSeasons);
                  if (next.has(s)) next.delete(s); else next.add(s);
                  setSelectedSeasons(next);
                }}
                style={{ fontSize: 11, padding: '3px 8px' }}
              >{s}</button>
            ))}
          </div>
        </div>
      </div>

      {stats && (
        <div style={{ padding: '0 16px 12px', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {[
            { label: 'Rookies', value: stats.n.toString(), color: 'var(--text-primary)' },
            { label: 'R²', value: stats.r2, color: Number(stats.r2) > 0.1 ? '#22c55e' : Number(stats.r2) > 0 ? '#facc15' : '#ef4444' },
            { label: 'MAE', value: `${stats.mae} PPG`, color: 'var(--text-primary)' },
            { label: 'Tier 1-3 Hit Rate', value: `${stats.topTierPct}%`, color: stats.topTierPct > 60 ? '#22c55e' : stats.topTierPct > 45 ? '#facc15' : '#ef4444' },
          ].map(c => (
            <div key={c.label} style={{
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '8px 14px', minWidth: 100,
            }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>{c.label}</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: c.color }}>{c.value}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ padding: '0 16px 8px', fontSize: 12, color: 'var(--text-muted)' }}>
        {filtered.length} rookies &middot; LOSO cross-validated: each rookie scored using a model trained WITHOUT their draft class &middot;
        Only includes rookies with 2+ qualifying seasons in years 1-3 (draft classes {seasons.length > 0 ? `${seasons[0]}-${seasons[seasons.length - 1]}` : '?'})
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th style={{ width: 36 }}>#</th>
              <th onClick={() => handleSort('name')} style={{ cursor: 'pointer' }}>Player{sortArrow('name')}</th>
              <th>Pos</th>
              <th onClick={() => handleSort('draftSeason')} style={{ cursor: 'pointer' }}>Class{sortArrow('draftSeason')}</th>
              <th onClick={() => handleSort('modelTier')} style={{ cursor: 'pointer' }}>Tier{sortArrow('modelTier')}</th>
              <th onClick={() => handleSort('predictedPPG')} style={{ cursor: 'pointer' }}>Pred PPG{sortArrow('predictedPPG')}</th>
              <th onClick={() => handleSort('actualPPG')} style={{ cursor: 'pointer' }}>Actual PPG{sortArrow('actualPPG')}</th>
              <th onClick={() => handleSort('error')} style={{ cursor: 'pointer' }}>Error{sortArrow('error')}</th>
              <th style={{ textAlign: 'center', fontSize: 11 }}>Boom%</th>
              <th style={{ textAlign: 'center', fontSize: 11 }}>Bust%</th>
              {thresholds.map(t => (
                <th key={t} style={{ textAlign: 'center', fontSize: 11, padding: '6px 4px', minWidth: 48 }}>
                  &gt;{t}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => {
              const err = r.actualPPG - r.predictedPPG;
              return (
                <tr key={`${r.name}-${r.draftSeason}-${i}`}>
                  <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{i + 1}</td>
                  <td><strong>{r.name}</strong></td>
                  <td><span style={{ color: POS_COLORS[r.position] || 'var(--text-secondary)', fontWeight: 600 }}>{r.position}</span></td>
                  <td>{r.draftSeason}</td>
                  <td>
                    <strong style={{ color: tierColor(r.modelTier), fontSize: 12 }}>{tierLabel(r.modelTier)}</strong>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>({r.combinedScore.toFixed(0)})</span>
                  </td>
                  <td style={{ fontWeight: 600 }}>{r.predictedPPG.toFixed(1)}</td>
                  <td style={{ fontWeight: 700, color: r.actualPPG >= 14 ? '#22c55e' : r.actualPPG >= 10 ? '#a3e635' : r.actualPPG >= 6 ? '#facc15' : '#fb923c' }}>
                    {r.actualPPG.toFixed(1)}
                  </td>
                  <td style={{
                    fontWeight: 600, fontSize: 12,
                    color: Math.abs(err) <= 2 ? '#22c55e' : Math.abs(err) <= 4 ? '#facc15' : '#ef4444',
                  }}>
                    {err >= 0 ? '+' : ''}{err.toFixed(1)}
                  </td>
                  <td style={{ textAlign: 'center', fontSize: 11, fontWeight: 600, color: r.boomProb > 30 ? '#22c55e' : r.boomProb > 15 ? '#a3e635' : 'var(--text-muted)' }}>
                    {r.boomProb > 0 ? `${r.boomProb.toFixed(0)}%` : '-'}
                    {err > 0 && r.boomProb > 20 && <span style={{ marginLeft: 2, fontSize: 9 }}>&#x2713;</span>}
                  </td>
                  <td style={{ textAlign: 'center', fontSize: 11, fontWeight: 600, color: r.bustProb > 30 ? '#ef4444' : r.bustProb > 15 ? '#fb923c' : 'var(--text-muted)' }}>
                    {r.bustProb > 0 ? `${r.bustProb.toFixed(0)}%` : '-'}
                    {err < 0 && r.bustProb > 20 && <span style={{ marginLeft: 2, fontSize: 9 }}>&#x2713;</span>}
                  </td>
                  {thresholds.map(t => {
                    const prob = r.thresholdProbs?.[t];
                    const hit = r.actualPPG >= t;
                    const hasProb = prob != null && prob > 0;
                    return (
                      <td key={t} style={{
                        textAlign: 'center', fontSize: 11, fontWeight: 600, padding: '4px 3px',
                        background: hasProb ? probBg(prob) : undefined,
                        color: hasProb ? probColor(prob) : 'var(--text-muted)',
                      }}>
                        {hasProb ? `${prob.toFixed(0)}%` : '-'}
                        {hit && <span style={{ marginLeft: 2, color: '#22c55e', fontSize: 10 }}>&#10003;</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
