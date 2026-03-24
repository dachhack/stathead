import { useState, useEffect, useMemo } from 'react';
import { fetchProspects2026 } from '../data';
import type { Prospect2026 } from '../data';

const ALL_POS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'OT', 'IOL', 'EDGE', 'DL', 'LB', 'CB', 'S'];
const SKILL_POS = new Set(['QB', 'RB', 'WR', 'TE']);

const POS_COLOR: Record<string, string> = {
  QB: '#6366f1', RB: '#10b981', WR: '#f59e0b', TE: '#ef4444',
  EDGE: '#8b5cf6', LB: '#06b6d4', CB: '#ec4899', S: '#14b8a6',
  OT: '#64748b', IOL: '#64748b', DL: '#64748b',
};

type SortKey = 'consensusRank' | 'fpRank' | 'djRank' | 'name' | 'pos' | 'school';
type View = 'overall' | 'fantasy';

export function ExternalRankings2026() {
  const [prospects, setProspects] = useState<Prospect2026[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [posFilter, setPosFilter] = useState('ALL');
  const [view, setView] = useState<View>('overall');
  const [sortKey, setSortKey] = useState<SortKey>('consensusRank');
  const [sortAsc, setSortAsc] = useState(true);

  useEffect(() => {
    fetchProspects2026().then((data) => {
      setProspects(data);
      setLoading(false);
    });
  }, []);

  // When switching views, reset sort to the natural default
  function handleViewChange(v: View) {
    setView(v);
    setPosFilter('ALL');
    if (v === 'fantasy') {
      setSortKey('fpRank');
      setSortAsc(true);
    } else {
      setSortKey('consensusRank');
      setSortAsc(true);
    }
  }

  const filtered = useMemo(() => {
    let data = [...prospects];

    // Fantasy view: skill positions only, must have an FP rank or be a skill pos in consensus
    if (view === 'fantasy') {
      data = data.filter((p) => SKILL_POS.has(p.pos));
    }

    if (posFilter !== 'ALL') {
      data = data.filter((p) => p.pos === posFilter);
    }

    if (search) {
      const q = search.toLowerCase();
      data = data.filter(
        (p) => p.name.toLowerCase().includes(q) || p.school.toLowerCase().includes(q),
      );
    }

    data.sort((a, b) => {
      if (sortKey === 'name' || sortKey === 'pos' || sortKey === 'school') {
        const av = a[sortKey] || '';
        const bv = b[sortKey] || '';
        return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      // Numeric: nulls go to the bottom
      const av = a[sortKey] ?? Infinity;
      const bv = b[sortKey] ?? Infinity;
      return sortAsc ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });

    return data;
  }, [prospects, view, posFilter, search, sortKey, sortAsc]);

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortAsc((a) => !a);
    else { setSortKey(key); setSortAsc(true); }
  }

  function arrow(key: SortKey) {
    return key === sortKey ? <span style={{ marginLeft: 3 }}>{sortAsc ? '▲' : '▼'}</span> : null;
  }

  const posOptions = view === 'fantasy'
    ? ['ALL', 'QB', 'RB', 'WR', 'TE']
    : ALL_POS;

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading 2026 draft class…</div>
      </div>
    );
  }

  return (
    <>
      {/* View toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['overall', 'fantasy'] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => handleViewChange(v)}
              style={{
                padding: '6px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                background: view === v ? 'var(--accent)' : 'var(--bg-tertiary)',
                color: view === v ? '#fff' : 'var(--text-secondary)',
              }}
            >
              {v === 'overall' ? '🏈 Overall Big Board' : '⭐ Fantasy Rankings'}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Search player or school…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, minWidth: 200 }}
        />
      </div>

      {/* Position filters */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {posOptions.map((pos) => (
          <button
            key={pos}
            onClick={() => setPosFilter(pos)}
            className={`pos-filter ${posFilter === pos ? 'active' : ''}`}
          >
            {pos}
          </button>
        ))}
      </div>

      {/* Source note */}
      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
        {view === 'overall' ? (
          <>Overall consensus rank aggregated from 121 big boards via{' '}
            <a href="https://www.nflmockdraftdatabase.com/big-boards/2026/consensus-big-board-2026" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>NFL Mock Draft Database</a>
            {' '}· DJ rank from{' '}
            <a href="https://www.nfl.com/news/daniel-jeremiah-s-top-50-2026-nfl-draft-prospect-rankings-3-0" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>Daniel Jeremiah (NFL.com)</a>.
          </>
        ) : (
          <>Fantasy dynasty rookie rankings from{' '}
            <a href="https://www.fantasypros.com/nfl/rankings/dynasty-rookies-overall.php" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>FantasyPros ECR</a>
            {' '}· consensus big board from{' '}
            <a href="https://www.nflmockdraftdatabase.com/big-boards/2026/consensus-big-board-2026" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>NFL Mock Draft Database</a>.
          </>
        )}
        {' '}{filtered.length} prospects shown.
      </p>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th style={{ width: 36, textAlign: 'center', cursor: 'pointer' }} onClick={() => handleSort('consensusRank')}>
                {view === 'fantasy' ? 'Overall' : '#'}{arrow('consensusRank')}
              </th>
              {view === 'fantasy' && (
                <th style={{ width: 52, textAlign: 'center', cursor: 'pointer', color: 'var(--accent)' }} onClick={() => handleSort('fpRank')}>
                  FP Rank{arrow('fpRank')}
                </th>
              )}
              <th style={{ cursor: 'pointer' }} onClick={() => handleSort('name')}>
                Player{arrow('name')}
              </th>
              <th style={{ cursor: 'pointer' }} onClick={() => handleSort('pos')}>
                Pos{arrow('pos')}
              </th>
              <th style={{ cursor: 'pointer' }} onClick={() => handleSort('school')}>
                School{arrow('school')}
              </th>
              <th style={{ textAlign: 'center', cursor: 'pointer' }} onClick={() => handleSort('djRank')}>
                DJ Rank{arrow('djRank')}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p, i) => {
              const color = POS_COLOR[p.pos] || '#64748b';
              return (
                <tr key={`${p.name}-${p.pos}`}>
                  <td style={{ textAlign: 'center', color: 'var(--text-muted)', fontWeight: 600 }}>
                    {p.consensusRank ?? '—'}
                  </td>
                  {view === 'fantasy' && (
                    <td style={{ textAlign: 'center', fontWeight: 700, color: 'var(--accent)' }}>
                      {p.fpRank != null ? (
                        <>
                          {p.fpRank}
                          {p.fpAvg != null && p.fpAvg !== p.fpRank && (
                            <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 3 }}>
                              ({p.fpAvg.toFixed(1)})
                            </span>
                          )}
                        </>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>{i + 1}</span>
                      )}
                    </td>
                  )}
                  <td>
                    <strong>{p.name}</strong>
                  </td>
                  <td>
                    <span style={{
                      display: 'inline-block', padding: '1px 7px', borderRadius: 4, fontSize: 11,
                      fontWeight: 700, background: color + '22', color,
                    }}>
                      {p.pos}
                    </span>
                  </td>
                  <td style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                    {p.school || '—'}
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    {p.djRank != null ? (
                      <span style={{
                        display: 'inline-block', padding: '1px 7px', borderRadius: 4, fontSize: 12,
                        background: 'var(--bg-tertiary)', color: 'var(--text-secondary)',
                      }}>
                        {p.djRank}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
