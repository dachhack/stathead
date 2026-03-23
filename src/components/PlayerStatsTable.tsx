import { useState, useEffect, useMemo } from 'react';
import type { SeasonTotals, SortDirection } from '../types';
import { fetchRosters } from '../data';

interface Props {
  players: SeasonTotals[];
  loading: boolean;
  error: string | null;
  season?: number;
}

type SortField = keyof SeasonTotals;

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K'];

export function PlayerStatsTable({ players, loading, error, season }: Props) {
  const [sortField, setSortField] = useState<SortField>('fantasy_points_ppr');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');
  const [posFilter, setPosFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [rookiesOnly, setRookiesOnly] = useState(false);
  const [rookieIds, setRookieIds] = useState<Set<string>>(new Set());

  // Load roster data to identify rookies (entry_year === season)
  useEffect(() => {
    if (!season) return;
    fetchRosters(season)
      .then((rosters) => {
        const ids = new Set(
          rosters
            .filter((r) => r.entry_year === season)
            .map((r) => r.gsis_id)
            .filter(Boolean)
        );
        setRookieIds(ids);
      })
      .catch(() => setRookieIds(new Set()));
  }, [season]);

  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const sortArrow = (field: SortField) => {
    if (field !== sortField) return null;
    return (
      <span className="sort-arrow">{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>
    );
  };

  const filtered = useMemo(() => {
    let data = [...players];
    if (posFilter !== 'ALL') {
      data = data.filter((p) => p.position === posFilter);
    }
    if (rookiesOnly && rookieIds.size > 0) {
      data = data.filter((p) => rookieIds.has(p.player_id));
    }
    if (search) {
      const q = search.toLowerCase();
      data = data.filter(
        (p) =>
          p.player_display_name.toLowerCase().includes(q) ||
          p.recent_team.toLowerCase().includes(q)
      );
    }
    data.sort((a, b) => {
      const aVal = a[sortField] ?? 0;
      const bVal = b[sortField] ?? 0;
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDir === 'asc'
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal);
      }
      return sortDir === 'asc'
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });
    return data;
  }, [players, posFilter, rookiesOnly, rookieIds, search, sortField, sortDir]);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading player stats from nflverse...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <h3>Failed to load data</h3>
        <p>{error}</p>
      </div>
    );
  }

  const fmt = (n: number | null | undefined, decimals = 0) => {
    if (n == null || isNaN(n)) return '-';
    return decimals > 0 ? n.toFixed(decimals) : Math.round(n).toLocaleString();
  };

  return (
    <>
      <div className="controls">
        <div className="control-group">
          <input
            type="text"
            placeholder="Search players or teams..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
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
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <input
            type="checkbox"
            checked={rookiesOnly}
            onChange={(e) => setRookiesOnly(e.target.checked)}
          />
          Rookies only
          {rookiesOnly && rookieIds.size > 0 && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {rookieIds.size} players
            </span>
          )}
        </label>
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th style={{ width: 40 }}>#</th>
              <th>Player</th>
              <th>Pos</th>
              <th>Team</th>
              <th
                className={sortField === 'games' ? 'sorted' : ''}
                onClick={() => handleSort('games')}
              >
                G{sortArrow('games')}
              </th>
              <th
                className={sortField === 'passing_yards' ? 'sorted' : ''}
                onClick={() => handleSort('passing_yards')}
              >
                Pass Yds{sortArrow('passing_yards')}
              </th>
              <th
                className={sortField === 'passing_tds' ? 'sorted' : ''}
                onClick={() => handleSort('passing_tds')}
              >
                Pass TD{sortArrow('passing_tds')}
              </th>
              <th
                className={sortField === 'interceptions' ? 'sorted' : ''}
                onClick={() => handleSort('interceptions')}
              >
                INT{sortArrow('interceptions')}
              </th>
              <th
                className={sortField === 'rushing_yards' ? 'sorted' : ''}
                onClick={() => handleSort('rushing_yards')}
              >
                Rush Yds{sortArrow('rushing_yards')}
              </th>
              <th
                className={sortField === 'rushing_tds' ? 'sorted' : ''}
                onClick={() => handleSort('rushing_tds')}
              >
                Rush TD{sortArrow('rushing_tds')}
              </th>
              <th
                className={sortField === 'receptions' ? 'sorted' : ''}
                onClick={() => handleSort('receptions')}
              >
                Rec{sortArrow('receptions')}
              </th>
              <th
                className={sortField === 'receiving_yards' ? 'sorted' : ''}
                onClick={() => handleSort('receiving_yards')}
              >
                Rec Yds{sortArrow('receiving_yards')}
              </th>
              <th
                className={sortField === 'receiving_tds' ? 'sorted' : ''}
                onClick={() => handleSort('receiving_tds')}
              >
                Rec TD{sortArrow('receiving_tds')}
              </th>
              <th
                className={sortField === 'fantasy_points' ? 'sorted' : ''}
                onClick={() => handleSort('fantasy_points')}
              >
                FPts{sortArrow('fantasy_points')}
              </th>
              <th
                className={sortField === 'fantasy_points_half_ppr' ? 'sorted' : ''}
                onClick={() => handleSort('fantasy_points_half_ppr')}
              >
                Half PPR{sortArrow('fantasy_points_half_ppr')}
              </th>
              <th
                className={sortField === 'fantasy_points_ppr' ? 'sorted' : ''}
                onClick={() => handleSort('fantasy_points_ppr')}
              >
                PPR{sortArrow('fantasy_points_ppr')}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 200).map((p, i) => (
              <tr key={p.player_id}>
                <td className="rank-cell">{i + 1}</td>
                <td>
                  <div className="player-cell">
                    {p.headshot_url && (
                      <img
                        className="player-headshot"
                        src={p.headshot_url}
                        alt=""
                        loading="lazy"
                      />
                    )}
                    <div className="player-info">
                      <span className="player-name">
                        {p.player_display_name}
                      </span>
                    </div>
                  </div>
                </td>
                <td>
                  <span className={`pos-badge pos-${p.position}`}>
                    {p.position}
                  </span>
                </td>
                <td>{p.recent_team}</td>
                <td>{p.games}</td>
                <td>{fmt(p.passing_yards)}</td>
                <td>{fmt(p.passing_tds)}</td>
                <td>{fmt(p.interceptions)}</td>
                <td>{fmt(p.rushing_yards)}</td>
                <td>{fmt(p.rushing_tds)}</td>
                <td>{fmt(p.receptions)}</td>
                <td>{fmt(p.receiving_yards)}</td>
                <td>{fmt(p.receiving_tds)}</td>
                <td className="stat-positive">{fmt(p.fantasy_points, 1)}</td>
                <td className="stat-positive">
                  {fmt(p.fantasy_points_half_ppr, 1)}
                </td>
                <td className="stat-positive">
                  {fmt(p.fantasy_points_ppr, 1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
