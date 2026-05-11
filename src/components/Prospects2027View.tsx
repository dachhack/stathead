import { useState, useEffect, useMemo, useCallback } from 'react';
import type { SortDirection } from '../types';

interface Prospect2027 {
  name: string;
  pos: string;
  school: string;
  grade: number;
  projPick: number;
  projRound: number;
  tier: string;
  sources: string[];
  consensusRank: number | null;
  pffRank: number | null;
  tankathonPick: number | null;
  careerSeasons: number;
  careerSeasonList: number[];
  careerPassYds: number;
  careerPassTDs: number;
  careerPassInt: number;
  careerPassCmp: number;
  careerPassAtt: number;
  careerRushYds: number;
  careerRushTDs: number;
  careerRecYds: number;
  careerRecTDs: number;
  careerReceptions: number;
  bestPassYds: number;
  bestRushYds: number;
  bestRecYds: number;
  recruitStars: number | null;
  recruitRating: number | null;
  recruitClassYear: number | null;
  recruitPosition: string | null;
  usage2025: number | null;
  usage2024: number | null;
  cfbdKey: string | null;
  cfbdSchool: string | null;
}

type SortField =
  | 'projPick' | 'grade' | 'name' | 'pos' | 'school' | 'recruitStars'
  | 'careerRecYds' | 'careerRushYds' | 'careerPassYds' | 'careerRecTDs'
  | 'careerPassTDs' | 'careerRushTDs' | 'usage2025' | 'consensusRank'
  | 'pffRank' | 'tankathonPick';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];

function tierColor(tier: string): string {
  if (tier === 'Generational') return '#22c55e';
  if (tier === 'Elite') return '#4ade80';
  if (tier === 'Top Prospect') return '#a3e635';
  if (tier === '1st-2nd Round') return '#facc15';
  if (tier === '2nd-3rd Round') return '#fb923c';
  return 'var(--text-muted)';
}

function starsColor(stars: number | null): string {
  if (stars == null) return 'var(--text-muted)';
  if (stars >= 5) return '#22c55e';
  if (stars >= 4) return '#a3e635';
  if (stars >= 3) return '#facc15';
  return 'var(--text-muted)';
}

function fmt(n: number | null | undefined): string {
  if (n == null || n === 0) return '—';
  if (n >= 1000) return n.toLocaleString();
  return String(n);
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function productionCell(p: Prospect2027): string {
  if (p.pos === 'QB') {
    if (!p.careerPassYds) return '—';
    return `${fmt(p.careerPassYds)} yds / ${p.careerPassTDs} TD / ${p.careerPassInt} INT`;
  }
  if (p.pos === 'RB') {
    const rush = `${fmt(p.careerRushYds)} yds / ${p.careerRushTDs} TD`;
    if (p.careerRecYds > 0) {
      return `${rush} · ${p.careerReceptions} rec / ${p.careerRecYds} yds`;
    }
    return rush;
  }
  if (p.pos === 'WR' || p.pos === 'TE') {
    if (!p.careerReceptions) return '—';
    return `${p.careerReceptions} rec / ${fmt(p.careerRecYds)} yds / ${p.careerRecTDs} TD`;
  }
  return '—';
}

function bestSeasonCell(p: Prospect2027): string {
  if (p.pos === 'QB') return p.bestPassYds ? `${fmt(p.bestPassYds)} yds` : '—';
  if (p.pos === 'RB') return p.bestRushYds ? `${fmt(p.bestRushYds)} yds` : '—';
  return p.bestRecYds ? `${fmt(p.bestRecYds)} yds` : '—';
}

export function Prospects2027View({ onDataLoaded }: { onDataLoaded?: (data: unknown[]) => void }) {
  const [rows, setRows] = useState<Prospect2027[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [posFilter, setPosFilter] = useState('ALL');
  const [sortField, setSortField] = useState<SortField>('projPick');
  const [sortDir, setSortDir] = useState<SortDirection>('asc');

  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}data/career-2027.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: Prospect2027[]) => {
        if (cancelled) return;
        setRows(data);
        setLoading(false);
        onDataLoaded?.(data);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onDataLoaded]);

  const filtered = useMemo(() => {
    let r = rows;
    if (posFilter !== 'ALL') r = r.filter((p) => p.pos === posFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      r = r.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.school.toLowerCase().includes(q) ||
          p.pos.toLowerCase() === q,
      );
    }
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...r].sort((a, b) => {
      const va = a[sortField] as number | string | null;
      const vb = b[sortField] as number | string | null;
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [rows, search, posFilter, sortField, sortDir]);

  const toggleSort = useCallback(
    (field: SortField) => {
      if (field === sortField) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortField(field);
        // Default direction: name/school ascending, everything else descending
        // except projPick (where lower = better).
        setSortDir(field === 'projPick' || field === 'name' || field === 'school' ? 'asc' : 'desc');
      }
    },
    [sortField],
  );

  if (loading) return <div style={{ padding: 16 }}>Loading 2027 prospects…</div>;
  if (error) return <div style={{ padding: 16, color: '#ef4444' }}>Error: {error}</div>;

  const sortArrow = (f: SortField) => (sortField === f ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '');

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ margin: '0 0 4px 0' }}>2027 NFL Draft Prospects</h2>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Consensus board from PFF + Tankathon + NFL Mock Draft Database. Career stats are through 2025 — the 2026
          college season hasn't been played yet. Model-scored predictions (PPG, boom/bust) will be added after the
          senior season completes.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Search name / school / position"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            padding: '6px 10px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            color: 'var(--text-primary)',
            borderRadius: 4,
            fontSize: 13,
            minWidth: 240,
          }}
        />
        <div style={{ display: 'flex', gap: 4 }}>
          {POSITIONS.map((p) => (
            <button
              key={p}
              onClick={() => setPosFilter(p)}
              style={{
                padding: '6px 12px',
                background: posFilter === p ? 'var(--bg-tertiary)' : 'transparent',
                color: posFilter === p ? 'var(--text-primary)' : 'var(--text-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: posFilter === p ? 600 : 400,
              }}
            >
              {p}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>
          {filtered.length} of {rows.length} fantasy prospects
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
              <th onClick={() => toggleSort('projPick')} style={thStyle}>Rank{sortArrow('projPick')}</th>
              <th style={thStyle}>Tier</th>
              <th onClick={() => toggleSort('name')} style={thStyle}>Player{sortArrow('name')}</th>
              <th onClick={() => toggleSort('pos')} style={thStyle}>Pos{sortArrow('pos')}</th>
              <th onClick={() => toggleSort('school')} style={thStyle}>School{sortArrow('school')}</th>
              <th onClick={() => toggleSort('grade')} style={{ ...thStyle, textAlign: 'right' }}>Grade{sortArrow('grade')}</th>
              <th onClick={() => toggleSort('recruitStars')} style={{ ...thStyle, textAlign: 'center' }}>
                ★{sortArrow('recruitStars')}
              </th>
              <th style={thStyle}>Career (thru 2025)</th>
              <th style={thStyle}>Best Season</th>
              <th onClick={() => toggleSort('usage2025')} style={{ ...thStyle, textAlign: 'right' }}>
                Usage '25{sortArrow('usage2025')}
              </th>
              <th onClick={() => toggleSort('consensusRank')} style={{ ...thStyle, textAlign: 'right' }} title="NFL Mock Draft Database consensus board rank">
                #Cons{sortArrow('consensusRank')}
              </th>
              <th onClick={() => toggleSort('pffRank')} style={{ ...thStyle, textAlign: 'right' }} title="PFF Big Board rank">
                #PFF{sortArrow('pffRank')}
              </th>
              <th onClick={() => toggleSort('tankathonPick')} style={{ ...thStyle, textAlign: 'right' }} title="Tankathon mock-draft pick">
                #Tank{sortArrow('tankathonPick')}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr key={`${p.name}::${p.school}`} style={{ borderBottom: '1px solid var(--border-subtle, #2a2a2a)' }}>
                <td style={{ ...tdStyle, fontWeight: 600 }}>{p.projPick}</td>
                <td style={tdStyle}>
                  <span style={{ color: tierColor(p.tier), fontSize: 11 }}>{p.tier}</span>
                </td>
                <td style={{ ...tdStyle, fontWeight: 600 }}>{p.name}</td>
                <td style={tdStyle}>{p.pos}</td>
                <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{p.school}</td>
                <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>{p.grade}</td>
                <td style={{ ...tdStyle, textAlign: 'center', color: starsColor(p.recruitStars) }}>
                  {p.recruitStars ? `${p.recruitStars}★` : '—'}
                </td>
                <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{productionCell(p)}</td>
                <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{bestSeasonCell(p)}</td>
                <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtPct(p.usage2025)}</td>
                <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-muted)' }}>
                  {p.consensusRank ?? '—'}
                </td>
                <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-muted)' }}>
                  {p.pffRank ?? '—'}
                </td>
                <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-muted)' }}>
                  {p.tankathonPick ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: '8px 6px',
  fontWeight: 600,
  fontSize: 11,
  color: 'var(--text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  cursor: 'pointer',
  userSelect: 'none',
  whiteSpace: 'nowrap',
};

const tdStyle: React.CSSProperties = {
  padding: '6px',
  whiteSpace: 'nowrap',
};
