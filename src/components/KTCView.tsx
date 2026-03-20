import { useState, useEffect, useMemo } from 'react';
import type { KTCPlayer } from '../types';
import { fetchKTCRankings } from '../data';

type FormatMode = '1qb' | 'superflex';
const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];

interface Props {
  onDataLoaded?: (data: unknown[]) => void;
}

export function KTCView({ onDataLoaded }: Props) {
  const [players, setPlayers] = useState<KTCPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [format, setFormat] = useState<FormatMode>('1qb');
  const [posFilter, setPosFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [showRookies, setShowRookies] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchKTCRankings(format)
      .then((data) => {
        setPlayers(data);
        onDataLoaded?.(data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [format, onDataLoaded]);

  const filtered = useMemo(() => {
    let data = [...players];
    if (posFilter !== 'ALL') data = data.filter((p) => p.position === posFilter);
    if (showRookies) data = data.filter((p) => p.isRookie);
    if (search) {
      const q = search.toLowerCase();
      data = data.filter(
        (p) =>
          p.playerName.toLowerCase().includes(q) || p.team.toLowerCase().includes(q)
      );
    }
    return data;
  }, [players, posFilter, search, showRookies]);

  // The max value for the bar chart visualization
  const maxValue = useMemo(
    () => (filtered.length > 0 ? filtered[0].value : 9999),
    [filtered]
  );

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading KeepTradeCut dynasty values...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <h3>Failed to load KTC data</h3>
        <p>{error}</p>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 8 }}>
          KTC does not have a public API. This feature scrapes their dynasty rankings page,
          which may be blocked by CORS in some environments.
          Works best when deployed behind a CORS proxy or server-side.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="controls">
        <input
          type="text"
          placeholder="Search players..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="position-filters">
          {POSITIONS.map((pos) => (
            <button
              key={pos}
              className={`pos-filter ${posFilter === pos ? 'active' : ''}`}
              onClick={() => setPosFilter(pos)}
            >
              {pos}
            </button>
          ))}
        </div>
        <div className="scoring-format-tabs">
          <button
            className={`format-tab ${format === '1qb' ? 'active' : ''}`}
            onClick={() => { setFormat('1qb'); setPlayers([]); }}
          >
            1QB
          </button>
          <button
            className={`format-tab ${format === 'superflex' ? 'active' : ''}`}
            onClick={() => { setFormat('superflex'); setPlayers([]); }}
          >
            Superflex
          </button>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showRookies}
            onChange={(e) => setShowRookies(e.target.checked)}
          />
          Rookies only
        </label>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          {filtered.length} players
        </span>
      </div>

      <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>
        Crowdsourced dynasty trade values from{' '}
        <a
          href="https://keeptradecut.com/dynasty-rankings"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--accent)' }}
        >
          KeepTradeCut
        </a>
        . Values are based on 25M+ user-submitted rankings using an adapted ELO algorithm.
        Max value = 9999.
      </p>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>Pos</th>
              <th>Pos Rank</th>
              <th>Team</th>
              <th>Age</th>
              <th>Value</th>
              <th style={{ minWidth: 160 }}>Value Chart</th>
              {format === '1qb' && <th>SF Value</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.map((p, i) => (
              <tr key={p.slug || `${p.playerName}-${i}`}>
                <td className="rank-cell">{i + 1}</td>
                <td>
                  <strong>{p.playerName}</strong>
                  {p.isRookie && (
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 10,
                        background: 'var(--accent)',
                        color: '#fff',
                        padding: '1px 5px',
                        borderRadius: 3,
                      }}
                    >
                      R
                    </span>
                  )}
                </td>
                <td>
                  <span className={`pos-badge pos-${p.position}`}>{p.position}</span>
                </td>
                <td>
                  {p.position}
                  {p.positionRank}
                </td>
                <td>{p.team}</td>
                <td>{p.age || '-'}</td>
                <td>
                  <strong>{p.value.toLocaleString()}</strong>
                </td>
                <td>
                  <div
                    style={{
                      background: 'var(--accent)',
                      height: 14,
                      borderRadius: 3,
                      width: `${Math.max((p.value / maxValue) * 100, 1)}%`,
                      opacity: 0.7,
                    }}
                  />
                </td>
                {format === '1qb' && (
                  <td style={{ color: 'var(--text-muted)' }}>
                    {p.superflexValue > 0 ? p.superflexValue.toLocaleString() : '-'}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
