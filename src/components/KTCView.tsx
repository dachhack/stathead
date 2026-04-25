import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import type { KTCPlayer, KTCPlayerHistory, ScenarioConfig } from '../types';
import { fetchKTCRankingsForDisplay, fetchKTCHistoryForDisplay, fetchFantasyCalcRankings } from '../data';
import { KTCFactorAnalysis } from './KTCFactorAnalysis';
import { KTCPredictiveModel } from './KTCPredictiveModel';
import { PlayerLink } from './PlayerLink';

type FormatMode = '1qb' | 'superflex';
type ViewMode = 'rankings' | 'history' | 'factors' | 'model';
const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];

const CHART_COLORS = [
  '#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316',
];

interface Props {
  onDataLoaded?: (data: unknown[]) => void;
  scenario?: ScenarioConfig;
}

export function KTCView({ onDataLoaded, scenario }: Props) {
  const [players, setPlayers] = useState<KTCPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [format, setFormat] = useState<FormatMode>('1qb');
  const [viewMode, setViewMode] = useState<ViewMode>('rankings');
  const [dataSource, setDataSource] = useState<'ktc' | 'fc'>('ktc');
  const [posFilter, setPosFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [showRookies, setShowRookies] = useState(false);

  // History state
  const [selectedPlayers, setSelectedPlayers] = useState<KTCPlayer[]>([]);
  const [historyData, setHistoryData] = useState<KTCPlayerHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historySearch, setHistorySearch] = useState('');

  // Model factor view
  const [modelPlayer, setModelPlayer] = useState<string | null>(null);

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

  // Fetch history when selected players change
  useEffect(() => {
    if (selectedPlayers.length === 0) {
      setHistoryData([]);
      return;
    }
    setHistoryLoading(true);
    setHistoryError(null);
    const positionByID = new Map(selectedPlayers.map((p) => [p.playerID, p.position]));
    fetchKTCHistoryForDisplay(selectedPlayers.map((p) => p.playerID), positionByID)
      .then(setHistoryData)
      .catch((e) => setHistoryError(e instanceof Error ? e.message : 'Failed to load history'))
      .finally(() => setHistoryLoading(false));
  }, [selectedPlayers]);

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

  // Re-sort filtered list by the active format's value so switching 1QB↔SF
  // immediately reorders the table (data arrives sorted by 1QB value).
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

  // Players matching the history search box
  const historySearchResults = useMemo(() => {
    if (!historySearch || historySearch.length < 2) return [];
    const q = historySearch.toLowerCase();
    return players
      .filter(
        (p) =>
          p.playerName.toLowerCase().includes(q) &&
          !selectedPlayers.some((s) => s.playerID === p.playerID)
      )
      .slice(0, 8);
  }, [players, historySearch, selectedPlayers]);

  // Build chart data: merge all players' history into date-keyed rows
  const chartData = useMemo(() => {
    if (historyData.length === 0) return [];

    // Collect all dates across all players
    const dateMap = new Map<string, Record<string, number>>();

    for (const ph of historyData) {
      const history = format === '1qb' ? ph.oneQB?.valueHistory : ph.superflex?.valueHistory;
      if (!history) continue;
      const player = selectedPlayers.find((p) => p.playerID === ph.playerID);
      const name = player?.playerName || `ID ${ph.playerID}`;

      for (const point of history) {
        const existing = dateMap.get(point.d) || {};
        existing[name] = point.v;
        dateMap.set(point.d, existing);
      }
    }

    // Sort by date and return
    return Array.from(dateMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, values]) => ({ date, ...values }));
  }, [historyData, selectedPlayers, format]);

  const addPlayer = useCallback((player: KTCPlayer) => {
    if (selectedPlayers.length >= 8) return;
    setSelectedPlayers((prev) => [...prev, player]);
    setHistorySearch('');
  }, [selectedPlayers]);

  const removePlayer = useCallback((playerID: number) => {
    setSelectedPlayers((prev) => prev.filter((p) => p.playerID !== playerID));
  }, []);

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
            Works best when deployed behind a CORS proxy or server-side.
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
      <div className="scoring-format-tabs" style={{ marginBottom: 8 }}>
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

      <div className="scoring-format-tabs" style={{ marginBottom: 12 }}>
        <button
          className={`format-tab ${viewMode === 'rankings' ? 'active' : ''}`}
          onClick={() => setViewMode('rankings')}
        >
          Dynasty Rankings
        </button>
        <button
          className={`format-tab ${viewMode === 'history' ? 'active' : ''}`}
          onClick={() => setViewMode('history')}
        >
          Value History
        </button>
        <button
          className={`format-tab ${viewMode === 'factors' ? 'active' : ''}`}
          onClick={() => setViewMode('factors')}
        >
          RB Factor Analysis
        </button>
        <button
          className={`format-tab ${viewMode === 'model' ? 'active' : ''}`}
          onClick={() => setViewMode('model')}
        >
          Predictive Model
        </button>
      </div>

      {viewMode === 'model' ? (
        <KTCPredictiveModel initialPlayer={modelPlayer} scenario={scenario} dataSource={dataSource} />
      ) : viewMode === 'factors' ? (
        <KTCFactorAnalysis />
      ) : viewMode === 'history' ? (
        dataSource === 'fc' ? (
          <div className="empty-state">
            <h3>Value history not available for FantasyCalc</h3>
            <p>Value history is only available for the market source. Switch sources to view historical trends.</p>
          </div>
        ) : (
        <>
          <div className="controls">
            <div style={{ position: 'relative', flex: 1 }}>
              <input
                type="text"
                placeholder="Search players to add to chart (max 8)..."
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
              />
              {historySearchResults.length > 0 && (
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    right: 0,
                    background: 'var(--bg-card, #1e1e2e)',
                    border: '1px solid var(--border, #333)',
                    borderRadius: 6,
                    zIndex: 100,
                    maxHeight: 240,
                    overflowY: 'auto',
                  }}
                >
                  {historySearchResults.map((p) => (
                    <button
                      key={p.playerID}
                      onClick={() => addPlayer(p)}
                      style={{
                        display: 'block',
                        width: '100%',
                        padding: '8px 12px',
                        textAlign: 'left',
                        background: 'none',
                        border: 'none',
                        color: 'inherit',
                        cursor: 'pointer',
                        fontSize: 13,
                        borderBottom: '1px solid var(--border, #333)',
                      }}
                    >
                      <strong>{p.playerName}</strong>{' '}
                      <span className={`pos-badge pos-${p.position}`}>{p.position}</span>{' '}
                      <span style={{ color: 'var(--text-muted)' }}>{p.team}</span>{' '}
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                        Value: {p.value.toLocaleString()}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="scoring-format-tabs">
              <button
                className={`format-tab ${format === '1qb' ? 'active' : ''}`}
                onClick={() => setFormat('1qb')}
              >
                1QB
              </button>
              <button
                className={`format-tab ${format === 'superflex' ? 'active' : ''}`}
                onClick={() => setFormat('superflex')}
              >
                Superflex
              </button>
            </div>
          </div>

          {selectedPlayers.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              {selectedPlayers.map((p, i) => (
                <span
                  key={p.playerID}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '4px 10px',
                    borderRadius: 20,
                    fontSize: 12,
                    fontWeight: 600,
                    background: CHART_COLORS[i % CHART_COLORS.length],
                    color: '#fff',
                  }}
                >
                  {p.playerName}
                  <button
                    onClick={() => removePlayer(p.playerID)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#fff',
                      cursor: 'pointer',
                      fontSize: 14,
                      padding: 0,
                      lineHeight: 1,
                    }}
                  >
                    x
                  </button>
                </span>
              ))}
            </div>
          )}

          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 12 }}>
            Historical dynasty trade values. Search and select up to 8 players to compare value
            trends over time.
          </p>

          {historyLoading ? (
            <div className="loading">
              <div className="spinner" />
              <div className="loading-text">Loading value history...</div>
            </div>
          ) : historyError ? (
            <div className="empty-state">
              <h3>Failed to load history</h3>
              <p>{historyError}</p>
              <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 8 }}>
                The history endpoint may be blocked by CORS in some environments.
              </p>
            </div>
          ) : selectedPlayers.length === 0 ? (
            <div className="empty-state">
              <h3>No players selected</h3>
              <p>Search for players above and click to add them to the chart.</p>
            </div>
          ) : chartData.length > 0 ? (
            <div style={{ width: '100%', height: 420 }}>
              <ResponsiveContainer>
                <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border, #333)" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11, fill: 'var(--text-muted, #888)' }}
                    tickFormatter={(d: string) => {
                      const date = new Date(d);
                      return `${date.getMonth() + 1}/${String(date.getFullYear()).slice(2)}`;
                    }}
                    interval="preserveStartEnd"
                    minTickGap={40}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: 'var(--text-muted, #888)' }}
                    domain={[0, 'auto']}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--bg-card, #1e1e2e)',
                      border: '1px solid var(--border, #333)',
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                    labelFormatter={(d) => {
                      const date = new Date(String(d));
                      return date.toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      });
                    }}
                    formatter={(value) => [Number(value).toLocaleString(), undefined]}
                  />
                  <Legend />
                  {selectedPlayers.map((p, i) => (
                    <Line
                      key={p.playerID}
                      type="monotone"
                      dataKey={p.playerName}
                      stroke={CHART_COLORS[i % CHART_COLORS.length]}
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : null}

          {/* Quick-add: top players by position */}
          {selectedPlayers.length === 0 && (
            <div style={{ marginTop: 16 }}>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8 }}>
                Quick add top players:
              </p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {players.slice(0, 12).map((p) => (
                  <button
                    key={p.playerID}
                    onClick={() => addPlayer(p)}
                    className="pos-filter"
                    style={{ fontSize: 12 }}
                  >
                    {p.playerName}
                    <span
                      className={`pos-badge pos-${p.position}`}
                      style={{ marginLeft: 4, fontSize: 10 }}
                    >
                      {p.position}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
        )
      ) : (
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
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sortedFiltered.map((p, i) => (
                  <tr key={p.slug || `${p.playerName}-${i}`}>
                    <td className="rank-cell">{i + 1}</td>
                    <td>
                      <strong
                        style={{ cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'var(--border)' }}
                        title="View predicted factors"
                        onClick={() => {
                          setModelPlayer(p.playerName);
                          setViewMode('model');
                        }}
                      >
                        {p.playerName}
                      </strong>
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
                    <td>
                      {dataSource === 'ktc' && (
                        <button
                          onClick={() => {
                            setSelectedPlayers((prev) =>
                              prev.some((s) => s.playerID === p.playerID)
                                ? prev
                                : [...prev.slice(0, 7), p]
                            );
                            setViewMode('history');
                          }}
                          title="View value history"
                          style={{
                            background: 'none',
                            border: '1px solid var(--border, #333)',
                            borderRadius: 4,
                            color: 'var(--accent)',
                            cursor: 'pointer',
                            fontSize: 11,
                            padding: '2px 6px',
                          }}
                        >
                          History
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
