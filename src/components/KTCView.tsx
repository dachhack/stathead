import { useState, useEffect, useMemo } from 'react';
import type { KTCPlayer } from '../types';
import { fetchKTCRankingsForDisplay, fetchFantasyCalcRankings } from '../data';
import { PlayerLink } from './PlayerLink';

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
  const [dataSource, setDataSource] = useState<'ktc' | 'fc'>('ktc');
  const [posFilter, setPosFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [showRookies, setShowRookies] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const fetcher = dataSource === 'fc' ? fetchFantasyCalcRankings : fetchKTCRankingsForDisplay;
    fetcher(format)
      .then((data) => {
        setPlayers(data);
        onDataLoaded?.(data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [format, dataSource, onDataLoaded]);

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

  const displayVal = (p: KTCPlayer) =>
    format === 'superflex' ? p.superflexValue : p.value;

  const sortedFiltered = useMemo(
    () => [...filtered].sort((a, b) => displayVal(b) - displayVal(a)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, format],
  );

  const maxValue = useMemo(
    () => (sortedFiltered.length > 0 ? Math.max(...sortedFiltered.map(displayVal)) : 9999),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sortedFiltered, format]
  );

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading {dataSource === 'fc' ? 'FantasyCalc' : 'market'} dynasty values...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <h3>Failed to load {dataSource === 'fc' ? 'FantasyCalc' : 'dynasty market'} data</h3>
        <p>{error}</p>
        {dataSource === 'ktc' && (
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 8 }}>
            The upstream source does not have a public API. This feature scrapes their dynasty
            rankings page, which may be blocked by CORS in some environments.
          </p>
        )}
        {dataSource === 'fc' && (
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 8 }}>
            Could not reach the FantasyCalc API. Check your network connection or try again later.
          </p>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="scoring-format-tabs" style={{ marginBottom: 12 }}>
        <button
          className={`format-tab ${dataSource === 'ktc' ? 'active' : ''}`}
          onClick={() => setDataSource('ktc')}
        >
          Market
        </button>
        <button
          className={`format-tab ${dataSource === 'fc' ? 'active' : ''}`}
          onClick={() => setDataSource('fc')}
        >
          FantasyCalc
        </button>
      </div>

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

      {dataSource === 'ktc' ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>
          Crowdsourced dynasty trade values based on tens of millions of user-submitted
          rankings using an adapted ELO algorithm. Max value = 9999.
        </p>
      ) : (
        <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>
          Dynasty trade values from{' '}
          <a
            href="https://fantasycalc.com/dynasty-rankings"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--accent)' }}
          >
            FantasyCalc
          </a>
          . 30-day trend shows value change over the past 30 days.
        </p>
      )}

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
              <th>{format === 'superflex' ? 'SF Value' : 'Value'}</th>
              <th style={{ minWidth: 160 }}>Value Chart</th>
              {dataSource === 'fc' ? (
                <th>30d Trend</th>
              ) : (
                format === '1qb' ? <th>SF Value</th> : <th>1QB Value</th>
              )}
            </tr>
          </thead>
          <tbody>
            {sortedFiltered.map((p, i) => (
              <tr key={p.slug || `${p.playerName}-${i}`}>
                <td className="rank-cell">{i + 1}</td>
                <td>
                  <strong>{p.playerName}</strong>
                  <PlayerLink name={p.playerName} position={p.position} />
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
                  <strong>{displayVal(p).toLocaleString()}</strong>
                </td>
                <td>
                  <div
                    style={{
                      background: 'var(--accent)',
                      height: 14,
                      borderRadius: 3,
                      width: `${Math.max((displayVal(p) / maxValue) * 100, 1)}%`,
                      opacity: 0.7,
                    }}
                  />
                </td>
                <td style={{ color: dataSource === 'fc' ? ((p.trend30Day ?? 0) >= 0 ? '#10b981' : '#ef4444') : 'var(--text-muted)' }}>
                  {dataSource === 'fc' ? (
                    (() => {
                      const trend = p.trend30Day ?? 0;
                      return trend === 0 ? '-' : `${trend >= 0 ? '+' : ''}${trend.toLocaleString()}`;
                    })()
                  ) : (
                    format === '1qb'
                      ? (p.superflexValue > 0 ? p.superflexValue.toLocaleString() : '-')
                      : (p.value > 0 ? p.value.toLocaleString() : '-')
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
