import { useState, useEffect, useMemo } from 'react';
import { trainRookieCareerModels } from '../lib/rookieCareerModel';
import type { RookieCareerBacktestRow } from '../lib/rookieCareerModel';
import { assemblePlayerRows } from '../lib/featureStoreClient';
import { PlayerCard } from './PlayerCard';
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
  predictedPPG: number; // our model's predicted PPG (0 for 2026)
  delta: number;
  winner: '' | 'ours' | 'zap' | 'tie'; // who was closer to actual?
}

type SortField = 'zapRank' | 'name' | 'pos' | 'zapScore' | 'ourScore' | 'actualPPG' | 'predictedPPG' | 'delta' | 'absDelta' | 'winner';

export function ZapComparison() {
  const [rows2026, setRows2026] = useState<CompRow[]>([]);
  const [rows2023, setRows2023] = useState<CompRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [season, setSeason] = useState<'2026' | '2023'>('2026');
  const [posFilter, setPosFilter] = useState('ALL');
  const [sortField, setSortField] = useState<SortField>('zapRank');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [selectedPlayer, setSelectedPlayer] = useState<CompRow | null>(null);
  const [backtestData, setBacktestData] = useState<Map<string, RookieCareerBacktestRow>>(new Map());

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
            predictedPPG: 0, delta: our > 0 ? our - z.zap : 0,
            winner: '',
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
      // Use predictedPPG (regression output) instead of combinedScore (threshold probs)
      // to avoid double-rescaling compression artifacts
      for (const pos of ['RB', 'WR'] as const) {
        const posRows = [...backtestByName.values()].filter(r => r.position === pos);
        if (posRows.length < 2) continue;
        // Use predicted PPG as the raw signal — more linear and interpretable
        const ppgs = posRows.map(r => r.predictedPPG);
        const min = Math.min(...ppgs);
        const max = Math.max(...ppgs);
        const range = max - min;
        if (range > 0) {
          for (const r of posRows) {
            r.combinedScore = Math.round((5 + ((r.predictedPPG - min) / range) * 93) * 10) / 10;
          }
        }
      }

      const r2023: CompRow[] = [];
      for (const pos of ['RB', 'WR'] as const) {
        for (const z of (zapScores2023 as any)[pos] || []) {
          const nName = normalizeName(z.name);
          const bt = backtestByName.get(nName);
          const ourScore = bt?.combinedScore || 0;
          const actualPPG = bt?.actualPPG || 0;
          const predictedPPG = bt?.predictedPPG || 0;
          // Determine who was closer to actual (using score as proxy for ranking accuracy)
          // Compare how close each model's score correlates with actual outcome
          let winner: '' | 'ours' | 'zap' | 'tie' = '';
          if (ourScore > 0 && actualPPG > 0) {
            const ourError = Math.abs(ourScore - actualPPG * (100 / 20)); // normalize actual to 0-100 scale
            const zapError = Math.abs(z.zap - actualPPG * (100 / 20));
            if (Math.abs(ourError - zapError) < 2) winner = 'tie';
            else winner = ourError < zapError ? 'ours' : 'zap';
          }
          r2023.push({
            name: z.name, pos, zapRank: z.rank,
            zapScore: z.zap, ourScore, actualPPG, predictedPPG,
            delta: ourScore > 0 ? ourScore - z.zap : 0, winner,
          });
        }
      }
      setRows2023(r2023);
      setBacktestData(backtestByName);
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
      else if (sortField === 'winner') {
        const winOrder = { ours: 0, tie: 1, zap: 2, '': 3 };
        aVal = winOrder[a.winner] ?? 3; bVal = winOrder[b.winner] ?? 3;
      }
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
    // Win/loss record vs ZAP
    const oursWins = withActuals.filter(r => r.winner === 'ours').length;
    const zapWins = withActuals.filter(r => r.winner === 'zap').length;
    const ties = withActuals.filter(r => r.winner === 'tie').length;
    return {
      n, corr: corr.toFixed(3), mae: mae.toFixed(1),
      zapVsActualCorr: zapVsActualCorr.toFixed(3), ourVsActualCorr: ourVsActualCorr.toFixed(3),
      hasActuals: withActuals.length > 0,
      oursWins, zapWins, ties,
    };
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
              { label: 'Record vs ZAP', value: `${stats.oursWins}W-${stats.zapWins}L-${stats.ties}T`, color: stats.oursWins > stats.zapWins ? '#22c55e' : stats.oursWins < stats.zapWins ? '#ef4444' : '#facc15' },
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
                <>
                  <th onClick={() => handleSort('predictedPPG')} style={{ cursor: 'pointer', textAlign: 'right' }}>Pred PPG{sortArrow('predictedPPG')}</th>
                  <th onClick={() => handleSort('actualPPG')} style={{ cursor: 'pointer', textAlign: 'right' }}>Actual PPG{sortArrow('actualPPG')}</th>
                  <th onClick={() => handleSort('winner')} style={{ cursor: 'pointer', textAlign: 'center' }}>Winner{sortArrow('winner')}</th>
                </>
              )}
              <th onClick={() => handleSort('delta')} style={{ cursor: 'pointer', textAlign: 'right' }}>Delta{sortArrow('delta')}</th>
              <th onClick={() => handleSort('absDelta')} style={{ cursor: 'pointer', textAlign: 'right' }}>|Delta|{sortArrow('absDelta')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={`${r.name}-${i}`}>
                <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{r.zapRank}</td>
                <td><strong style={{ cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'var(--border)' }} onClick={() => setSelectedPlayer(r)}>{r.name}</strong></td>
                <td><span style={{ color: POS_COLORS[r.pos], fontWeight: 600 }}>{r.pos}</span></td>
                <td style={{ textAlign: 'right', fontWeight: 700, color: tierColor(r.zapScore) }}>{r.zapScore.toFixed(1)}</td>
                <td style={{ textAlign: 'right', fontWeight: 700, color: r.ourScore > 0 ? tierColor(r.ourScore) : 'var(--text-muted)' }}>
                  {r.ourScore > 0 ? r.ourScore.toFixed(1) : '-'}
                </td>
                {season === '2023' && (
                  <>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: r.predictedPPG >= 14 ? '#22c55e' : r.predictedPPG >= 10 ? '#a3e635' : r.predictedPPG >= 6 ? '#facc15' : r.predictedPPG > 0 ? '#fb923c' : 'var(--text-muted)' }}>
                      {r.predictedPPG > 0 ? r.predictedPPG.toFixed(1) : '-'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: r.actualPPG >= 14 ? '#22c55e' : r.actualPPG >= 10 ? '#a3e635' : r.actualPPG >= 6 ? '#facc15' : r.actualPPG > 0 ? '#fb923c' : 'var(--text-muted)' }}>
                      {r.actualPPG > 0 ? r.actualPPG.toFixed(1) : '-'}
                    </td>
                    <td style={{ textAlign: 'center', fontWeight: 700, fontSize: 12, color: r.winner === 'ours' ? '#22c55e' : r.winner === 'zap' ? '#ef4444' : r.winner === 'tie' ? '#facc15' : 'var(--text-muted)' }}>
                      {r.winner === 'ours' ? 'Us' : r.winner === 'zap' ? 'ZAP' : r.winner === 'tie' ? 'Tie' : '-'}
                    </td>
                  </>
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

      {selectedPlayer && (
        <PlayerCard
          player={{
            name: selectedPlayer.name,
            position: selectedPlayer.pos,
            draftSeason: season === '2023' ? 2023 : 2026,
            zapScore: selectedPlayer.zapScore,
            ourScore: selectedPlayer.ourScore,
            predictedPPG: selectedPlayer.predictedPPG,
            actualPPG: selectedPlayer.actualPPG,
            thresholdProbs: backtestData.get(normalizeName(selectedPlayer.name))?.thresholdProbs,
            features: backtestData.get(normalizeName(selectedPlayer.name))?.features,
          }}
          onClose={() => setSelectedPlayer(null)}
        />
      )}
    </>
  );
}
