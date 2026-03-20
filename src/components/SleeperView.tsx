import { useState, useEffect, useMemo } from 'react';
import type { SleeperTrendingRow, SleeperProjection } from '../types';
import { fetchSleeperTrending, fetchSleeperProjections } from '../data';

type ViewMode = 'trending_add' | 'trending_drop' | 'projections';
const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];

interface Props {
  season: number;
  onDataLoaded?: (data: unknown[]) => void;
}

export function SleeperView({ season, onDataLoaded }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('trending_add');
  const [trendingAdds, setTrendingAdds] = useState<SleeperTrendingRow[]>([]);
  const [trendingDrops, setTrendingDrops] = useState<SleeperTrendingRow[]>([]);
  const [projections, setProjections] = useState<SleeperProjection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posFilter, setPosFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [lookback, setLookback] = useState(24);
  const [projWeek, setProjWeek] = useState<number | undefined>(undefined);

  // Fetch trending adds
  useEffect(() => {
    if (viewMode !== 'trending_add') return;
    setLoading(true);
    setError(null);
    fetchSleeperTrending('add', lookback, 100)
      .then((data) => {
        setTrendingAdds(data);
        onDataLoaded?.(data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [viewMode, lookback, onDataLoaded]);

  // Fetch trending drops
  useEffect(() => {
    if (viewMode !== 'trending_drop') return;
    setLoading(true);
    setError(null);
    fetchSleeperTrending('drop', lookback, 100)
      .then((data) => {
        setTrendingDrops(data);
        onDataLoaded?.(data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [viewMode, lookback, onDataLoaded]);

  // Fetch projections
  useEffect(() => {
    if (viewMode !== 'projections') return;
    setLoading(true);
    setError(null);
    fetchSleeperProjections(season, projWeek)
      .then((data) => {
        setProjections(data);
        onDataLoaded?.(data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [viewMode, season, projWeek, onDataLoaded]);

  const trendingData = viewMode === 'trending_add' ? trendingAdds : trendingDrops;

  const filteredTrending = useMemo(() => {
    let data = [...trendingData];
    if (posFilter !== 'ALL') data = data.filter((p) => p.position === posFilter);
    if (search) {
      const q = search.toLowerCase();
      data = data.filter(
        (p) => p.full_name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q)
      );
    }
    return data;
  }, [trendingData, posFilter, search]);

  const filteredProjections = useMemo(() => {
    let data = [...projections];
    if (posFilter !== 'ALL') data = data.filter((p) => p.position === posFilter);
    if (search) {
      const q = search.toLowerCase();
      data = data.filter(
        (p) => p.full_name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q)
      );
    }
    return data.slice(0, 300);
  }, [projections, posFilter, search]);

  return (
    <>
      <div className="scoring-format-tabs" style={{ marginBottom: 12 }}>
        <button
          className={`format-tab ${viewMode === 'trending_add' ? 'active' : ''}`}
          onClick={() => setViewMode('trending_add')}
        >
          Trending Adds
        </button>
        <button
          className={`format-tab ${viewMode === 'trending_drop' ? 'active' : ''}`}
          onClick={() => setViewMode('trending_drop')}
        >
          Trending Drops
        </button>
        <button
          className={`format-tab ${viewMode === 'projections' ? 'active' : ''}`}
          onClick={() => setViewMode('projections')}
        >
          Projections
        </button>
      </div>

      {loading ? (
        <div className="loading">
          <div className="spinner" />
          <div className="loading-text">Loading Sleeper data...</div>
        </div>
      ) : error ? (
        <div className="empty-state">
          <h3>Failed to load Sleeper data</h3>
          <p>{error}</p>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 8 }}>
            The Sleeper API may be blocked by CORS in some environments.
            Works best when deployed to GitHub Pages.
          </p>
        </div>
      ) : viewMode === 'projections' ? (
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
            <div className="control-group">
              <label className="control-label">Week</label>
              <select
                value={projWeek ?? 'full'}
                onChange={(e) =>
                  setProjWeek(e.target.value === 'full' ? undefined : Number(e.target.value))
                }
              >
                <option value="full">Full Season</option>
                {Array.from({ length: 18 }, (_, i) => i + 1).map((w) => (
                  <option key={w} value={w}>
                    Week {w}
                  </option>
                ))}
              </select>
            </div>
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              {filteredProjections.length} players
            </span>
          </div>

          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>
            Data from{' '}
            <a
              href="https://sleeper.com"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--accent)' }}
            >
              Sleeper
            </a>
            . Projections are Sleeper&apos;s own estimates.
          </p>

          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>Pos</th>
                  <th>Team</th>
                  <th>Std Pts</th>
                  <th>Half PPR</th>
                  <th>PPR Pts</th>
                  <th>Pass Yd</th>
                  <th>Pass TD</th>
                  <th>INT</th>
                  <th>Rush Yd</th>
                  <th>Rush TD</th>
                  <th>Rec</th>
                  <th>Rec Yd</th>
                  <th>Rec TD</th>
                </tr>
              </thead>
              <tbody>
                {filteredProjections.map((p, i) => (
                  <tr key={p.player_id}>
                    <td className="rank-cell">{i + 1}</td>
                    <td>
                      <strong>{p.full_name}</strong>
                    </td>
                    <td>
                      <span className={`pos-badge pos-${p.position}`}>{p.position}</span>
                    </td>
                    <td>{p.team}</td>
                    <td>{p.pts_std.toFixed(1)}</td>
                    <td>{p.pts_half_ppr.toFixed(1)}</td>
                    <td className="stat-positive">{p.pts_ppr.toFixed(1)}</td>
                    <td>{p.pass_yd > 0 ? Math.round(p.pass_yd) : '-'}</td>
                    <td>{p.pass_td > 0 ? p.pass_td.toFixed(1) : '-'}</td>
                    <td>{p.pass_int > 0 ? p.pass_int.toFixed(1) : '-'}</td>
                    <td>{p.rush_yd > 0 ? Math.round(p.rush_yd) : '-'}</td>
                    <td>{p.rush_td > 0 ? p.rush_td.toFixed(1) : '-'}</td>
                    <td>{p.rec > 0 ? p.rec.toFixed(1) : '-'}</td>
                    <td>{p.rec_yd > 0 ? Math.round(p.rec_yd) : '-'}</td>
                    <td>{p.rec_td > 0 ? p.rec_td.toFixed(1) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
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
            <div className="control-group">
              <label className="control-label">Lookback</label>
              <select
                value={lookback}
                onChange={(e) => {
                  setLookback(Number(e.target.value));
                  setTrendingAdds([]);
                  setTrendingDrops([]);
                }}
              >
                <option value={6}>6 hours</option>
                <option value={12}>12 hours</option>
                <option value={24}>24 hours</option>
                <option value={48}>48 hours</option>
              </select>
            </div>
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              {filteredTrending.length} players
            </span>
          </div>

          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>
            Data from{' '}
            <a
              href="https://sleeper.com"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--accent)' }}
            >
              Sleeper
            </a>
            . Shows most{' '}
            {viewMode === 'trending_add' ? 'added' : 'dropped'} players across all Sleeper leagues.
          </p>

          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>Pos</th>
                  <th>Team</th>
                  <th>Age</th>
                  <th>{viewMode === 'trending_add' ? 'Adds' : 'Drops'}</th>
                </tr>
              </thead>
              <tbody>
                {filteredTrending.map((p, i) => (
                  <tr key={p.player_id}>
                    <td className="rank-cell">{i + 1}</td>
                    <td>
                      <strong>{p.full_name}</strong>
                    </td>
                    <td>
                      <span className={`pos-badge pos-${p.position}`}>{p.position}</span>
                    </td>
                    <td>{p.team}</td>
                    <td>{p.age || '-'}</td>
                    <td>
                      <strong
                        className={viewMode === 'trending_add' ? 'stat-positive' : 'stat-negative'}
                      >
                        {p.count.toLocaleString()}
                      </strong>
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
