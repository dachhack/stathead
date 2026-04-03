import { useState, useEffect, useMemo } from 'react';
import zapScores from '../data/zap-scores-2026.json';

const POSITIONS = ['ALL', 'RB', 'WR', 'TE'];
const POS_COLORS: Record<string, string> = { QB: '#ef4444', RB: '#22c55e', WR: '#3b82f6', TE: '#f59e0b' };

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[.\-''`]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
}

function tierColor(tier: string): string {
  if (tier.includes('Legendary')) return '#22c55e';
  if (tier.includes('Elite')) return '#4ade80';
  if (tier.includes('Starter')) return '#a3e635';
  if (tier.includes('Flex')) return '#facc15';
  if (tier.includes('Bench')) return '#fb923c';
  if (tier.includes('Waiver')) return '#ef4444';
  return '#991b1b';
}

interface CompRow {
  name: string;
  pos: string;
  zapRank: number;
  zapScore: number;
  zapTier: string;
  ourScore: number;
  ourTier: string;
  delta: number; // our score - zap score
}

export function ZapComparison() {
  const [rows, setRows] = useState<CompRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [posFilter, setPosFilter] = useState('ALL');
  const [sortField, setSortField] = useState<keyof CompRow | 'absDelta'>('zapRank');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  useEffect(() => {
    async function load() {
      // Load our model's scores from feature-matrix.json
      let ourScores = new Map<string, { score: number; tier: number }>();
      try {
        const resp = await fetch(`${import.meta.env.BASE_URL}data/feature-matrix.json`);
        if (resp.ok) {
          const d = await resp.json();
          if (d.careerPredictions2026) {
            for (const p of d.careerPredictions2026) {
              ourScores.set(normalizeName(p.name), {
                score: p.combinedScore || 0,
                tier: p.modelTier || 0,
              });
            }
          }
        }
      } catch {}

      // Also try localStorage
      if (ourScores.size === 0) {
        try {
          const cached = localStorage.getItem('adp_features_v3_total_none');
          if (cached) {
            const d = JSON.parse(cached);
            if (d.careerPredictions2026) {
              for (const p of d.careerPredictions2026) {
                ourScores.set(normalizeName(p.name), {
                  score: p.combinedScore || 0,
                  tier: p.modelTier || 0,
                });
              }
            }
          }
        } catch {}
      }

      const tierLabels: Record<number, string> = {
        1: 'Legendary', 2: 'Elite', 3: 'Starter', 4: 'Flex',
        5: 'Bench', 6: 'Waiver', 7: 'Dart Throw',
      };

      const allRows: CompRow[] = [];
      for (const pos of ['RB', 'WR', 'TE'] as const) {
        for (const z of (zapScores as any)[pos] || []) {
          const nName = normalizeName(z.name);
          const our = ourScores.get(nName);
          allRows.push({
            name: z.name,
            pos,
            zapRank: z.rank,
            zapScore: z.zap,
            zapTier: z.tier,
            ourScore: our?.score || 0,
            ourTier: tierLabels[our?.tier || 7] || 'Dart Throw',
            delta: (our?.score || 0) - z.zap,
          });
        }
      }
      setRows(allRows);
      setLoading(false);
    }
    load();
  }, []);

  const handleSort = (field: keyof CompRow | 'absDelta') => {
    if (field === sortField) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else {
      setSortField(field);
      setSortDir(field === 'zapRank' ? 'asc' : 'desc');
    }
  };
  const sortArrow = (field: keyof CompRow | 'absDelta') => field === sortField ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';

  const filtered = useMemo(() => {
    let d = [...rows];
    if (posFilter !== 'ALL') d = d.filter(r => r.pos === posFilter);
    d.sort((a, b) => {
      let aVal: number | string, bVal: number | string;
      if (sortField === 'absDelta') {
        aVal = Math.abs(a.delta);
        bVal = Math.abs(b.delta);
      } else {
        aVal = a[sortField];
        bVal = b[sortField];
      }
      if (typeof aVal === 'string') return sortDir === 'asc' ? aVal.localeCompare(bVal as string) : (bVal as string).localeCompare(aVal);
      return sortDir === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });
    return d;
  }, [rows, posFilter, sortField, sortDir]);

  // Stats
  const stats = useMemo(() => {
    const scored = filtered.filter(r => r.ourScore > 0);
    if (scored.length === 0) return null;
    const correlation = (() => {
      const n = scored.length;
      const mx = scored.reduce((s, r) => s + r.zapScore, 0) / n;
      const my = scored.reduce((s, r) => s + r.ourScore, 0) / n;
      let cov = 0, vx = 0, vy = 0;
      for (const r of scored) {
        cov += (r.zapScore - mx) * (r.ourScore - my);
        vx += (r.zapScore - mx) ** 2;
        vy += (r.ourScore - my) ** 2;
      }
      return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
    })();
    const mae = scored.reduce((s, r) => s + Math.abs(r.delta), 0) / scored.length;
    const sameDirection = scored.filter(r => {
      if (r.zapScore >= 60 && r.ourScore >= 60) return true;
      if (r.zapScore < 30 && r.ourScore < 30) return true;
      if (r.zapScore >= 30 && r.zapScore < 60 && r.ourScore >= 30 && r.ourScore < 60) return true;
      return false;
    }).length;
    return {
      n: scored.length,
      correlation: correlation.toFixed(3),
      mae: mae.toFixed(1),
      tierAgreement: Math.round(sameDirection / scored.length * 100),
    };
  }, [filtered]);

  if (loading) return <div className="loading"><div className="spinner" /><div className="loading-text">Loading comparison data...</div></div>;

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
      </div>

      {stats && (
        <div style={{ padding: '0 16px 12px', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {[
            { label: 'Prospects', value: stats.n.toString(), color: 'var(--text-primary)' },
            { label: 'Correlation', value: stats.correlation, color: Number(stats.correlation) > 0.5 ? '#22c55e' : Number(stats.correlation) > 0.3 ? '#facc15' : '#ef4444' },
            { label: 'Score MAE', value: stats.mae, color: 'var(--text-primary)' },
            { label: 'Tier Agreement', value: `${stats.tierAgreement}%`, color: stats.tierAgreement > 60 ? '#22c55e' : stats.tierAgreement > 40 ? '#facc15' : '#ef4444' },
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
        Comparing StatHead career model scores vs ZAP Model (Late Round Fantasy Football, 2026 Prospect Guide)
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th onClick={() => handleSort('zapRank')} style={{ cursor: 'pointer', width: 36 }}>#{sortArrow('zapRank')}</th>
              <th onClick={() => handleSort('name')} style={{ cursor: 'pointer' }}>Player{sortArrow('name')}</th>
              <th>Pos</th>
              <th onClick={() => handleSort('zapScore')} style={{ cursor: 'pointer', textAlign: 'right' }}>ZAP{sortArrow('zapScore')}</th>
              <th>ZAP Tier</th>
              <th onClick={() => handleSort('ourScore')} style={{ cursor: 'pointer', textAlign: 'right' }}>Ours{sortArrow('ourScore')}</th>
              <th>Our Tier</th>
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
                <td style={{ textAlign: 'right', fontWeight: 700, color: tierColor(r.zapTier) }}>{r.zapScore.toFixed(1)}</td>
                <td style={{ fontSize: 11, color: tierColor(r.zapTier) }}>{r.zapTier}</td>
                <td style={{ textAlign: 'right', fontWeight: 700, color: r.ourScore > 0 ? tierColor(r.ourTier) : 'var(--text-muted)' }}>
                  {r.ourScore > 0 ? r.ourScore.toFixed(1) : '-'}
                </td>
                <td style={{ fontSize: 11, color: r.ourScore > 0 ? tierColor(r.ourTier) : 'var(--text-muted)' }}>
                  {r.ourScore > 0 ? r.ourTier : '-'}
                </td>
                <td style={{
                  textAlign: 'right', fontWeight: 600, fontSize: 12,
                  color: Math.abs(r.delta) < 10 ? '#22c55e' : Math.abs(r.delta) < 20 ? '#facc15' : '#ef4444',
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
