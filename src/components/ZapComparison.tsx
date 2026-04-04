import { useState, useEffect, useMemo } from 'react';
import { trainRookieCareerModels } from '../lib/rookieCareerModel';
import type { RookieCareerBacktestRow } from '../lib/rookieCareerModel';
import { assemblePlayerRows } from '../lib/featureStoreClient';
import zapScores2026 from '../data/zap-scores-2026.json';
import zapScores2023 from '../data/zap-scores-2023.json';

const POSITIONS = ['ALL', 'RB', 'WR', 'TE'];
const POS_COLORS: Record<string, string> = { QB: '#ef4444', RB: '#22c55e', WR: '#3b82f6', TE: '#f59e0b' };

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[.\-''`]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
}

function tierColor(score: number): string {
  if (score >= 90) return '#22c55e';
  if (score >= 75) return '#4ade80';
  if (score >= 60) return '#a3e635';
  if (score >= 40) return '#facc15';
  if (score >= 30) return '#fb923c';
  if (score >= 20) return '#ef4444';
  return '#991b1b';
}

interface CompRow {
  name: string;
  pos: string;
  zapRank: number;
  zapScore: number;
  ourScore: number;
  actualPPG: number;  // 0 for 2026 (unknown)
  delta: number;
}

type SortField = 'zapRank' | 'name' | 'pos' | 'zapScore' | 'ourScore' | 'actualPPG' | 'delta' | 'absDelta';

export function ZapComparison() {
  const [rows2026, setRows2026] = useState<CompRow[]>([]);
  const [rows2023, setRows2023] = useState<CompRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [season, setSeason] = useState<'2026' | '2023'>('2026');
  const [posFilter, setPosFilter] = useState('ALL');
  const [sortField, setSortField] = useState<SortField>('zapRank');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  useEffect(() => {
    async function load() {
      // Load our 2026 scores
      let ourScores2026 = new Map<string, number>();
      let backtestRows: RookieCareerBacktestRow[] = [];
      try {
        const resp = await fetch(`${import.meta.env.BASE_URL}data/feature-matrix.json`);
        if (resp.ok) {
          const d = await resp.json();
          if (d.careerPredictions2026) {
            for (const p of d.careerPredictions2026) {
              ourScores2026.set(normalizeName(p.name), p.combinedScore || 0);
            }
          }
          // Get backtest rows for 2023 validation
          if (d.rookieCareerModels) {
            for (const m of Object.values(d.rookieCareerModels as Record<string, any>)) {
              if (m.backtestRows) backtestRows.push(...m.backtestRows);
            }
          }
        }
      } catch {}

      // If no backtest rows from precomputed, try training at runtime
      if (backtestRows.length === 0) {
        try {
          // Try localStorage cache first
          let d: any = null;
          const cached = localStorage.getItem('adp_features_v3_total_none');
          if (cached) d = JSON.parse(cached);
          // Fallback: assemble from feature store shards
          if (!d?.rows?.length) {
            const storeRows = await assemblePlayerRows();
            if (storeRows.length > 0) d = { rows: storeRows };
          }
          if (d?.rows?.length) {
            const models = trainRookieCareerModels(d.rows);
            for (const m of Object.values(models)) {
              if (m.backtestRows) backtestRows.push(...m.backtestRows);
            }
          }
        } catch {}
      }

      // Build 2026 comparison
      const r2026: CompRow[] = [];
      for (const pos of ['RB', 'WR', 'TE'] as const) {
        for (const z of (zapScores2026 as any)[pos] || []) {
          const nName = normalizeName(z.name);
          const our = ourScores2026.get(nName) || 0;
          r2026.push({
            name: z.name, pos, zapRank: z.rank,
            zapScore: z.zap, ourScore: our, actualPPG: 0,
            delta: our > 0 ? our - z.zap : 0,
          });
        }
      }
      setRows2026(r2026);

      // Build 2023 comparison with actuals
      const backtestByName = new Map<string, RookieCareerBacktestRow>();
      for (const r of backtestRows) {
        if (r.draftSeason === 2023) backtestByName.set(normalizeName(r.name), r);
      }

      // Rescale 2023 backtest scores to 0-100 within position
      // (global rescaling spreads across all years, making 2023 class cluster in a narrow band)
      for (const pos of ['RB', 'WR'] as const) {
        const posRows = [...backtestByName.values()].filter(r => r.position === pos);
        if (posRows.length < 2) continue;
        const scores = posRows.map(r => r.combinedScore);
        const min = Math.min(...scores);
        const max = Math.max(...scores);
        const range = max - min;
        if (range > 0) {
          for (const r of posRows) {
            r.combinedScore = Math.round((5 + ((r.combinedScore - min) / range) * 93) * 10) / 10;
          }
        }
      }

      const r2023: CompRow[] = [];
      for (const pos of ['RB', 'WR'] as const) {
        for (const z of (zapScores2023 as any)[pos] || []) {
          const nName = normalizeName(z.name);
          const bt = backtestByName.get(nName);
          r2023.push({
            name: z.name, pos, zapRank: z.rank,
            zapScore: z.zap,
            ourScore: bt?.combinedScore || 0,
            actualPPG: bt?.actualPPG || 0,
            delta: (bt?.combinedScore || 0) > 0 ? (bt?.combinedScore || 0) - z.zap : 0,
          });
        }
      }
      setRows2023(r2023);
      setLoading(false);
    }
    load();
  }, []);

  const rows = season === '2026' ? rows2026 : rows2023;

  const handleSort = (field: SortField) => {
    if (field === sortField) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir(field === 'zapRank' ? 'asc' : 'desc'); }
  };
  const sortArrow = (field: SortField) => field === sortField ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';

  const filtered = useMemo(() => {
    let d = [...rows];
    if (posFilter !== 'ALL') d = d.filter(r => r.pos === posFilter);
    d.sort((a, b) => {
      let aVal: number | string, bVal: number | string;
      if (sortField === 'absDelta') { aVal = Math.abs(a.delta); bVal = Math.abs(b.delta); }
      else { aVal = a[sortField]; bVal = b[sortField]; }
      if (typeof aVal === 'string') return sortDir === 'asc' ? aVal.localeCompare(bVal as string) : (bVal as string).localeCompare(aVal);
      return sortDir === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });
    return d;
  }, [rows, posFilter, sortField, sortDir]);

  const stats = useMemo(() => {
    const scored = filtered.filter(r => r.ourScore > 0);
    if (scored.length === 0) return null;
    const n = scored.length;
    const mx = scored.reduce((s, r) => s + r.zapScore, 0) / n;
    const my = scored.reduce((s, r) => s + r.ourScore, 0) / n;
    let cov = 0, vx = 0, vy = 0;
    for (const r of scored) { cov += (r.zapScore - mx) * (r.ourScore - my); vx += (r.zapScore - mx) ** 2; vy += (r.ourScore - my) ** 2; }
    const corr = vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
    const mae = scored.reduce((s, r) => s + Math.abs(r.delta), 0) / n;
    // For 2023: also compute correlation with actuals
    const withActuals = scored.filter(r => r.actualPPG > 0);
    let zapVsActualCorr = 0, ourVsActualCorr = 0;
    if (withActuals.length >= 5) {
      const ma = withActuals.reduce((s, r) => s + r.actualPPG, 0) / withActuals.length;
      const mz = withActuals.reduce((s, r) => s + r.zapScore, 0) / withActuals.length;
      const mo = withActuals.reduce((s, r) => s + r.ourScore, 0) / withActuals.length;
      let czA = 0, coA = 0, vzz = 0, voo = 0, vaa = 0;
      for (const r of withActuals) {
        czA += (r.zapScore - mz) * (r.actualPPG - ma); coA += (r.ourScore - mo) * (r.actualPPG - ma);
        vzz += (r.zapScore - mz) ** 2; voo += (r.ourScore - mo) ** 2; vaa += (r.actualPPG - ma) ** 2;
      }
      zapVsActualCorr = vzz > 0 && vaa > 0 ? czA / Math.sqrt(vzz * vaa) : 0;
      ourVsActualCorr = voo > 0 && vaa > 0 ? coA / Math.sqrt(voo * vaa) : 0;
    }
    return { n, corr: corr.toFixed(3), mae: mae.toFixed(1), zapVsActualCorr: zapVsActualCorr.toFixed(3), ourVsActualCorr: ourVsActualCorr.toFixed(3), hasActuals: withActuals.length > 0 };
  }, [filtered]);

  if (loading) return <div className="loading"><div className="spinner" /><div className="loading-text">Loading comparison data...</div></div>;

  return (
    <>
      <div className="controls">
        <div className="control-group">
          <label className="control-label">Class</label>
          <select value={season} onChange={e => setSeason(e.target.value as '2026' | '2023')}>
            <option value="2026">2026 Prospects</option>
            <option value="2023">2023 (with actuals)</option>
          </select>
        </div>
        <div className="position-filters">
          {POSITIONS.map(pos => (
            <button key={pos} className={`pos-filter ${posFilter === pos ? 'active' : ''}`} onClick={() => setPosFilter(pos)}>
              {pos}
            </button>
          ))}
        </div>
      </div>

      {stats && (
        <div style={{ padding: '0 16px 12px', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {[
            { label: 'Prospects', value: stats.n.toString(), color: 'var(--text-primary)' },
            { label: 'Score Correlation', value: stats.corr, color: Number(stats.corr) > 0.5 ? '#22c55e' : Number(stats.corr) > 0.3 ? '#facc15' : '#ef4444' },
            { label: 'Score MAE', value: stats.mae, color: 'var(--text-primary)' },
            ...(stats.hasActuals ? [
              { label: 'ZAP vs Actual', value: stats.zapVsActualCorr, color: Number(stats.zapVsActualCorr) > 0.3 ? '#22c55e' : Number(stats.zapVsActualCorr) > 0.1 ? '#facc15' : '#ef4444' },
              { label: 'Ours vs Actual', value: stats.ourVsActualCorr, color: Number(stats.ourVsActualCorr) > 0.3 ? '#22c55e' : Number(stats.ourVsActualCorr) > 0.1 ? '#facc15' : '#ef4444' },
            ] : []),
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
        {season === '2026'
          ? 'Comparing StatHead career model scores vs ZAP Model (Late Round 2026 Prospect Guide)'
          : 'Comparing 2023 ZAP scores vs StatHead LOSO predictions vs actual best 2-of-3 PPG (2023-2025)'}
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th onClick={() => handleSort('zapRank')} style={{ cursor: 'pointer', width: 36 }}>#{sortArrow('zapRank')}</th>
              <th onClick={() => handleSort('name')} style={{ cursor: 'pointer' }}>Player{sortArrow('name')}</th>
              <th>Pos</th>
              <th onClick={() => handleSort('zapScore')} style={{ cursor: 'pointer', textAlign: 'right' }}>ZAP{sortArrow('zapScore')}</th>
              <th onClick={() => handleSort('ourScore')} style={{ cursor: 'pointer', textAlign: 'right' }}>Ours{sortArrow('ourScore')}</th>
              {season === '2023' && (
                <th onClick={() => handleSort('actualPPG')} style={{ cursor: 'pointer', textAlign: 'right' }}>Actual PPG{sortArrow('actualPPG')}</th>
              )}
              <th onClick={() => handleSort('delta')} style={{ cursor: 'pointer', textAlign: 'right' }}>Delta{sortArrow('delta')}</th>
              <th onClick={() => handleSort('absDelta')} style={{ cursor: 'pointer', textAlign: 'right' }}>|Delta|{sortArrow('absDelta')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={`${r.name}-${i}`}>
                <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{r.zapRank}</td>
                <td><strong>{r.name}</strong></td>
                <td><span style={{ color: POS_COLORS[r.pos], fontWeight: 600 }}>{r.pos}</span></td>
                <td style={{ textAlign: 'right', fontWeight: 700, color: tierColor(r.zapScore) }}>{r.zapScore.toFixed(1)}</td>
                <td style={{ textAlign: 'right', fontWeight: 700, color: r.ourScore > 0 ? tierColor(r.ourScore) : 'var(--text-muted)' }}>
                  {r.ourScore > 0 ? r.ourScore.toFixed(1) : '-'}
                </td>
                {season === '2023' && (
                  <td style={{ textAlign: 'right', fontWeight: 700, color: r.actualPPG >= 14 ? '#22c55e' : r.actualPPG >= 10 ? '#a3e635' : r.actualPPG >= 6 ? '#facc15' : r.actualPPG > 0 ? '#fb923c' : 'var(--text-muted)' }}>
                    {r.actualPPG > 0 ? r.actualPPG.toFixed(1) : '-'}
                  </td>
                )}
                <td style={{
                  textAlign: 'right', fontWeight: 600, fontSize: 12,
                  color: r.ourScore > 0 ? (Math.abs(r.delta) < 10 ? '#22c55e' : Math.abs(r.delta) < 20 ? '#facc15' : '#ef4444') : 'var(--text-muted)',
                }}>
                  {r.ourScore > 0 ? `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(1)}` : '-'}
                </td>
                <td style={{ textAlign: 'right', fontSize: 12, color: 'var(--text-muted)' }}>
                  {r.ourScore > 0 ? Math.abs(r.delta).toFixed(1) : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
