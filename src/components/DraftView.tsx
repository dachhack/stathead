import { useState, useEffect, useMemo } from 'react';
import type { DraftPick, SortDirection } from '../types';
import { fetchDraftPicks } from '../data';

type SortField = keyof DraftPick;

export function DraftView({ onDataLoaded }: { onDataLoaded?: (data: unknown[]) => void }) {
  const [data, setData] = useState<DraftPick[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [yearFilter, setYearFilter] = useState(0);
  const [roundFilter, setRoundFilter] = useState(0);
  const [sortField, setSortField] = useState<SortField>('pick');
  const [sortDir, setSortDir] = useState<SortDirection>('asc');

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchDraftPicks()
      .then((picks) => {
        setData(picks);
        // Default to most recent year
        const maxYear = Math.max(...picks.map((p) => p.season).filter(Boolean));
        if (maxYear) setYearFilter(maxYear);
        onDataLoaded?.(picks);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [onDataLoaded]);

  const years = useMemo(
    () =>
      [...new Set(data.map((d) => d.season).filter(Boolean))].sort((a, b) => b - a),
    [data]
  );

  const handleSort = (field: SortField) => {
    if (field === sortField) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortField(field);
      setSortDir(field === 'car_av' || field === 'games' ? 'desc' : 'asc');
    }
  };

  const filtered = useMemo(() => {
    let d = yearFilter > 0 ? data.filter((r) => r.season === yearFilter) : data;
    if (roundFilter > 0) d = d.filter((r) => r.round === roundFilter);
    if (search) {
      const q = search.toLowerCase();
      d = d.filter(
        (r) =>
          r.pfr_player_name?.toLowerCase().includes(q) ||
          r.college?.toLowerCase().includes(q) ||
          r.team?.toLowerCase().includes(q)
      );
    }
    d.sort((a, b) => {
      const aVal = a[sortField] ?? 0;
      const bVal = b[sortField] ?? 0;
      if (typeof aVal === 'string')
        return sortDir === 'asc'
          ? aVal.localeCompare(bVal as string)
          : (bVal as string).localeCompare(aVal);
      return sortDir === 'asc'
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });
    return d;
  }, [data, yearFilter, roundFilter, search, sortField, sortDir]);

  const sortArrow = (field: SortField) =>
    field === sortField ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';

  if (loading)
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading draft data...</div>
      </div>
    );
  if (error)
    return (
      <div className="empty-state">
        <h3>Failed to load draft data</h3>
        <p>{error}</p>
      </div>
    );

  return (
    <>
      <div className="controls">
        <input
          type="text"
          placeholder="Search players, colleges, teams..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="control-group">
          <label className="control-label">Year</label>
          <select
            value={yearFilter}
            onChange={(e) => { setYearFilter(Number(e.target.value)); setRoundFilter(0); }}
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        <div className="control-group">
          <label className="control-label">Round</label>
          <select
            value={roundFilter}
            onChange={(e) => setRoundFilter(Number(e.target.value))}
          >
            <option value={0}>All</option>
            {[1, 2, 3, 4, 5, 6, 7].map((r) => (
              <option key={r} value={r}>
                Round {r}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th onClick={() => handleSort('pick')} style={{ cursor: 'pointer' }}>
                Pick{sortArrow('pick')}
              </th>
              <th>Rd</th>
              <th>Team</th>
              <th onClick={() => handleSort('pfr_player_name')} style={{ cursor: 'pointer' }}>
                Player{sortArrow('pfr_player_name')}
              </th>
              <th>Pos</th>
              <th onClick={() => handleSort('college')} style={{ cursor: 'pointer' }}>
                College{sortArrow('college')}
              </th>
              <th onClick={() => handleSort('age')} style={{ cursor: 'pointer' }}>
                Age{sortArrow('age')}
              </th>
              <th onClick={() => handleSort('games')} style={{ cursor: 'pointer' }}>
                Games{sortArrow('games')}
              </th>
              <th onClick={() => handleSort('car_av')} style={{ cursor: 'pointer' }}>
                Career AV{sortArrow('car_av')}
              </th>
              <th onClick={() => handleSort('dr_av')} style={{ cursor: 'pointer' }}>
                Draft AV{sortArrow('dr_av')}
              </th>
              <th onClick={() => handleSort('probowls')} style={{ cursor: 'pointer' }}>
                Pro Bowls{sortArrow('probowls')}
              </th>
              <th onClick={() => handleSort('allpro')} style={{ cursor: 'pointer' }}>
                All-Pro{sortArrow('allpro')}
              </th>
              <th onClick={() => handleSort('seasons_started')} style={{ cursor: 'pointer' }}>
                Starts{sortArrow('seasons_started')}
              </th>
              <th>HOF</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={`${r.season}-${r.pick}-${i}`}>
                <td className="rank-cell">{r.pick}</td>
                <td>{r.round}</td>
                <td>
                  <strong>{r.team}</strong>
                </td>
                <td>
                  <strong>{r.pfr_player_name || '-'}</strong>
                </td>
                <td>
                  {r.position ? (
                    <span className={`pos-badge pos-${r.position}`}>
                      {r.position}
                    </span>
                  ) : (
                    '-'
                  )}
                </td>
                <td>{r.college || '-'}</td>
                <td>{r.age || '-'}</td>
                <td>{r.games || '-'}</td>
                <td className={r.car_av > 50 ? 'stat-positive' : ''}>
                  {r.car_av || '-'}
                </td>
                <td>{r.dr_av || '-'}</td>
                <td>{r.probowls || '-'}</td>
                <td className={r.allpro > 0 ? 'stat-positive' : ''}>
                  {r.allpro || '-'}
                </td>
                <td>{r.seasons_started || '-'}</td>
                <td className={r.hof ? 'stat-positive' : ''}>
                  {r.hof ? 'HOF' : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
