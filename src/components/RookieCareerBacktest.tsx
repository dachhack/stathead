import { useState, useEffect, useMemo, useCallback } from 'react';
import { trainRookieCareerModels } from '../lib/rookieCareerModel';
import type { RookieCareerBacktestRow, RookieCareerModelResult } from '../lib/rookieCareerModel';
import { assemblePlayerRows } from '../lib/featureStoreClient';
import { normalizeName } from '../lib/featureTypes';
import { PlayerCard } from './PlayerCard';
import zapScores2023 from '../data/zap-scores-2023.json';
import zapScores2026 from '../data/zap-scores-2026.json';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];

// StatHead tier system — our own labels, not ZAP's
const TIER_DEFS = [
  { tier: 1, label: 'Alpha',       pctlMin: 95, color: '#22c55e', desc: 'Franchise-defining rookie' },
  { tier: 2, label: 'Blue Chip',   pctlMin: 85, color: '#4ade80', desc: 'Weekly locked-in starter' },
  { tier: 3, label: 'Starter',     pctlMin: 70, color: '#a3e635', desc: 'Reliable lineup contributor' },
  { tier: 4, label: 'Contributor', pctlMin: 50, color: '#facc15', desc: 'Flex play with upside' },
  { tier: 5, label: 'Depth',       pctlMin: 30, color: '#fb923c', desc: 'Bench stash / handcuff' },
  { tier: 6, label: 'Longshot',    pctlMin: 0,  color: '#ef4444', desc: 'Low probability of impact' },
];

function tierFromPercentile(pctl: number): typeof TIER_DEFS[0] {
  for (const t of TIER_DEFS) {
    if (pctl >= t.pctlMin) return t;
  }
  return TIER_DEFS[TIER_DEFS.length - 1];
}

function tierColor(tier: number): string {
  return TIER_DEFS.find(t => t.tier === tier)?.color || '#ef4444';
}

function tierLabel(tier: number): string {
  return TIER_DEFS.find(t => t.tier === tier)?.label || 'Longshot';
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
  const [trainingRows, setTrainingRows] = useState<any[]>([]);
  const [predictions2026, setPredictions2026] = useState<any[]>([]);
  const [selectedPlayer, setSelectedPlayer] = useState<RookieCareerBacktestRow | null>(null);

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
        setTrainingRows(d.rows);
        if (d.careerPredictions2026) setPredictions2026(d.careerPredictions2026);
        let careerModels = d.rookieCareerModels;
        if (!careerModels || Object.keys(careerModels).length === 0 || !careerModels[Object.keys(careerModels)[0]]?.backtestRows) {
          try { careerModels = trainRookieCareerModels(d.rows); } catch {}
        }
        // Debug: check if features are present in backtest rows
        const samplePos = Object.keys(careerModels || {})[0];
        const sampleRow = careerModels?.[samplePos]?.backtestRows?.[0];
        console.log('[CareerBacktest] features present:', !!sampleRow?.features, 'keys:', Object.keys(sampleRow?.features || {}).length);
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
        const pctl = Math.round((rank / sorted.length) * 100);
        r.combinedScore = pctl;
        r.percentile = pctl;
        r.modelTier = tierFromPercentile(pctl).tier;
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

  // Tier summary: avg/median actual PPG per tier
  const tierSummary = useMemo(() => {
    if (filtered.length === 0) return [];
    return TIER_DEFS.map(td => {
      const tierRows = filtered.filter(r => r.modelTier === td.tier);
      if (tierRows.length === 0) return null;
      const ppgs = tierRows.map(r => r.actualPPG).sort((a, b) => a - b);
      const avg = ppgs.reduce((a, b) => a + b, 0) / ppgs.length;
      const med = ppgs[Math.floor(ppgs.length / 2)];
      const hitRate = tierRows.filter(r => r.actualPPG >= 10).length / tierRows.length;
      return {
        ...td,
        n: tierRows.length,
        avgPPG: avg,
        medPPG: med,
        minPPG: ppgs[0],
        maxPPG: ppgs[ppgs.length - 1],
        hitRate, // % who averaged 10+ PPG
      };
    }).filter(Boolean) as Array<typeof TIER_DEFS[0] & { n: number; avgPPG: number; medPPG: number; minPPG: number; maxPPG: number; hitRate: number }>;
  }, [filtered]);

  // Build ZAP lookup for CSV export
  const zapLookup = useMemo(() => {
    const map = new Map<string, { zap: number; rank: number }>();
    for (const pos of ['RB', 'WR'] as const) {
      for (const z of (zapScores2023 as any)[pos] || []) {
        map.set(`${normalizeName(z.name)}::2023`, { zap: z.zap, rank: z.rank });
      }
    }
    for (const pos of ['RB', 'WR', 'TE'] as const) {
      for (const z of (zapScores2026 as any)[pos] || []) {
        map.set(`${normalizeName(z.name)}::2026`, { zap: z.zap, rank: z.rank });
      }
    }
    return map;
  }, []);

  // Rookie year 1 PPG lookup from training rows
  const rookieYear1PPG = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of trainingRows) {
      const yil = r.features?.yearsInLeague ?? 99;
      if (yil === 0 && r.rawPPG > 0) {
        const key = `${normalizeName(r.name)}::${r.position}`;
        // Keep the first year's PPG
        if (!map.has(key)) map.set(key, r.rawPPG);
      }
    }
    return map;
  }, [trainingRows]);

  // CSV export
  const exportCSV = useCallback(() => {
    const header = [
      'Name', 'Position', 'Draft Class', 'Draft Pick',
      'Rookie Yr1 PPG', 'Best 2of3 PPG', 'Predicted PPG',
      'Percentile', 'Tier',
      'ZAP Score', 'ZAP Rank',
    ];
    const csvRows: string[][] = [];

    // Historical backtest rows
    for (const r of allRows) {
      const zapKey = `${normalizeName(r.name)}::${r.draftSeason}`;
      const zap = zapLookup.get(zapKey);
      const yr1Key = `${normalizeName(r.name)}::${r.position}`;
      const yr1PPG = rookieYear1PPG.get(yr1Key);

      csvRows.push([
        r.name,
        r.position,
        String(r.draftSeason),
        String(r.features?.nflDraftPick || ''),
        yr1PPG != null ? yr1PPG.toFixed(1) : '',
        r.actualPPG > 0 ? r.actualPPG.toFixed(1) : '',
        r.predictedPPG > 0 ? r.predictedPPG.toFixed(1) : '',
        String(r.percentile || r.combinedScore || ''),
        tierLabel(r.modelTier),
        zap ? zap.zap.toFixed(1) : '',
        zap ? String(zap.rank) : '',
      ]);
    }

    // 2026 prospects
    for (const p of predictions2026) {
      const zapKey = `${normalizeName(p.name)}::2026`;
      const zap = zapLookup.get(zapKey);

      csvRows.push([
        p.name,
        p.position,
        '2026',
        String(p.adp || ''),
        '', // no year 1 PPG yet
        '', // no B2/3 yet
        p.predictedCareerPPG > 0 ? p.predictedCareerPPG.toFixed(1) : '',
        p.percentile != null ? String(p.percentile) : String(p.combinedScore || ''),
        p.modelTier ? tierLabel(p.modelTier) : '',
        zap ? zap.zap.toFixed(1) : '',
        zap ? String(zap.rank) : '',
      ]);
    }

    // Sort by draft class desc, then percentile desc
    csvRows.sort((a, b) => {
      const yearDiff = Number(b[2] || 0) - Number(a[2] || 0);
      if (yearDiff !== 0) return yearDiff;
      return Number(b[7] || 0) - Number(a[7] || 0);
    });

    const csv = [header, ...csvRows].map(row =>
      row.map(cell => cell.includes(',') ? `"${cell}"` : cell).join(',')
    ).join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stathead_rookie_career_scores_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [allRows, predictions2026, zapLookup, rookieYear1PPG]);

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
          <button
            onClick={exportCSV}
            style={{
              marginLeft: 'auto', padding: '4px 12px', fontSize: 11,
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 6, cursor: 'pointer', color: 'var(--text-secondary)',
            }}
          >Export CSV</button>
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

      {/* Tier summary table */}
      {tierSummary.length > 0 && (
        <div style={{ padding: '0 16px 12px' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)', fontWeight: 500 }}>Tier</th>
                <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)', fontWeight: 500 }}>Pctl</th>
                <th style={{ textAlign: 'right', padding: '4px 8px', color: 'var(--text-muted)', fontWeight: 500 }}>N</th>
                <th style={{ textAlign: 'right', padding: '4px 8px', color: 'var(--text-muted)', fontWeight: 500 }}>Avg PPG</th>
                <th style={{ textAlign: 'right', padding: '4px 8px', color: 'var(--text-muted)', fontWeight: 500 }}>Med PPG</th>
                <th style={{ textAlign: 'right', padding: '4px 8px', color: 'var(--text-muted)', fontWeight: 500 }}>Range</th>
                <th style={{ textAlign: 'right', padding: '4px 8px', color: 'var(--text-muted)', fontWeight: 500 }}>10+ PPG</th>
              </tr>
            </thead>
            <tbody>
              {tierSummary.map(t => (
                <tr key={t.tier} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '5px 8px', fontWeight: 600, color: t.color }}>{t.label}</td>
                  <td style={{ padding: '5px 8px', color: 'var(--text-muted)', fontSize: 11 }}>
                    {t.pctlMin === 0 ? '<30' : `${t.pctlMin}+`}
                  </td>
                  <td style={{ textAlign: 'right', padding: '5px 8px' }}>{t.n}</td>
                  <td style={{ textAlign: 'right', padding: '5px 8px', fontWeight: 700, color: t.avgPPG >= 14 ? '#22c55e' : t.avgPPG >= 10 ? '#a3e635' : t.avgPPG >= 6 ? '#facc15' : '#fb923c' }}>
                    {t.avgPPG.toFixed(1)}
                  </td>
                  <td style={{ textAlign: 'right', padding: '5px 8px', color: 'var(--text-secondary)' }}>{t.medPPG.toFixed(1)}</td>
                  <td style={{ textAlign: 'right', padding: '5px 8px', color: 'var(--text-muted)', fontSize: 11 }}>
                    {t.minPPG.toFixed(1)}-{t.maxPPG.toFixed(1)}
                  </td>
                  <td style={{ textAlign: 'right', padding: '5px 8px', fontWeight: 600, color: t.hitRate >= 0.5 ? '#22c55e' : t.hitRate >= 0.2 ? '#facc15' : '#ef4444' }}>
                    {Math.round(t.hitRate * 100)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ padding: '0 16px 8px', fontSize: 12, color: 'var(--text-muted)' }}>
        {filtered.length} rookies &middot; LOSO cross-validated &middot; Percentile ranked vs all historical rookies at position
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
                  <td><strong style={{ cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'var(--border)' }} onClick={() => setSelectedPlayer(r)}>{r.name}</strong></td>
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

      {selectedPlayer && (
        <PlayerCard
          player={{
            name: selectedPlayer.name,
            position: selectedPlayer.position,
            draftSeason: selectedPlayer.draftSeason,
            ourScore: selectedPlayer.combinedScore,
            predictedPPG: selectedPlayer.predictedPPG,
            actualPPG: selectedPlayer.actualPPG,
            thresholdProbs: selectedPlayer.thresholdProbs,
            features: selectedPlayer.features,
          }}
          onClose={() => setSelectedPlayer(null)}
        />
      )}
    </>
  );
}
