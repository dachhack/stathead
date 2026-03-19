import { useState, useEffect, useMemo } from 'react';
import type { Game } from '../types';
import { fetchGames } from '../data';

export function GamesView({ onDataLoaded }: { onDataLoaded?: (data: unknown[]) => void }) {
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [season, setSeason] = useState(2024);
  const [week, setWeek] = useState(0); // 0 = all
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetchGames()
      .then((data) => {
        setGames(data);
        onDataLoaded?.(data);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [onDataLoaded]);

  const seasons = useMemo(
    () => [...new Set(games.map((g) => g.season))].sort((a, b) => b - a),
    [games]
  );

  const weeks = useMemo(() => {
    const seasonGames = games.filter(
      (g) => g.season === season && g.game_type === 'REG'
    );
    return [...new Set(seasonGames.map((g) => g.week))].sort((a, b) => a - b);
  }, [games, season]);

  const filtered = useMemo(() => {
    let data = games.filter((g) => g.season === season);
    if (week > 0) data = data.filter((g) => g.week === week);
    if (search) {
      const q = search.toLowerCase();
      data = data.filter(
        (g) =>
          g.home_team?.toLowerCase().includes(q) ||
          g.away_team?.toLowerCase().includes(q)
      );
    }
    return data.sort((a, b) => a.week - b.week);
  }, [games, season, week, search]);

  if (loading)
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading game schedule data...</div>
      </div>
    );
  if (error)
    return (
      <div className="empty-state">
        <h3>Failed to load games</h3>
        <p>{error}</p>
      </div>
    );

  const spreadResult = (g: Game) => {
    if (g.result == null || g.spread_line == null) return null;
    const covered = g.result + g.spread_line > 0;
    return covered ? 'covered' : 'missed';
  };

  const totalResult = (g: Game) => {
    if (g.home_score == null || g.away_score == null || g.total_line == null)
      return null;
    const actual = g.home_score + g.away_score;
    return actual > g.total_line ? 'over' : 'under';
  };

  return (
    <>
      <div className="controls">
        <div className="control-group">
          <label className="control-label">Season</label>
          <select
            value={season}
            onChange={(e) => {
              setSeason(Number(e.target.value));
              setWeek(0);
            }}
          >
            {seasons.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="control-group">
          <label className="control-label">Week</label>
          <select value={week} onChange={(e) => setWeek(Number(e.target.value))}>
            <option value={0}>All Weeks</option>
            {weeks.map((w) => (
              <option key={w} value={w}>
                Week {w}
              </option>
            ))}
          </select>
        </div>
        <input
          type="text"
          placeholder="Search teams..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Week</th>
              <th>Date</th>
              <th>Away</th>
              <th>Score</th>
              <th>Home</th>
              <th>Score</th>
              <th>Result</th>
              <th>Total</th>
              <th>Spread</th>
              <th>ATS</th>
              <th>O/U Line</th>
              <th>O/U</th>
              <th>Surface</th>
              <th>Roof</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((g) => {
              const ats = spreadResult(g);
              const ou = totalResult(g);
              return (
                <tr key={g.game_id}>
                  <td>
                    {g.game_type === 'REG'
                      ? `Wk ${g.week}`
                      : `${g.game_type} ${g.week}`}
                  </td>
                  <td>{g.gameday}</td>
                  <td>
                    <strong>{g.away_team}</strong>
                  </td>
                  <td>{g.away_score ?? '-'}</td>
                  <td>
                    <strong>{g.home_team}</strong>
                  </td>
                  <td>{g.home_score ?? '-'}</td>
                  <td
                    className={
                      g.result != null
                        ? g.result > 0
                          ? 'stat-positive'
                          : g.result < 0
                            ? 'stat-negative'
                            : ''
                        : ''
                    }
                  >
                    {g.result != null ? (g.result > 0 ? `+${g.result}` : g.result) : '-'}
                  </td>
                  <td>
                    {g.home_score != null && g.away_score != null
                      ? g.home_score + g.away_score
                      : '-'}
                  </td>
                  <td>{g.spread_line ?? '-'}</td>
                  <td
                    className={
                      ats === 'covered' ? 'stat-positive' : ats === 'missed' ? 'stat-negative' : ''
                    }
                  >
                    {ats ?? '-'}
                  </td>
                  <td>{g.total_line ?? '-'}</td>
                  <td
                    className={
                      ou === 'over' ? 'stat-positive' : ou === 'under' ? 'stat-negative' : ''
                    }
                  >
                    {ou ?? '-'}
                  </td>
                  <td>{g.surface || '-'}</td>
                  <td>{g.roof || '-'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
