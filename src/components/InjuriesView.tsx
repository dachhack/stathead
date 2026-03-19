import { useState, useEffect, useMemo } from 'react';
import type { Injury } from '../types';
import { fetchInjuries } from '../data';

const STATUS_COLORS: Record<string, string> = {
  Out: 'stat-negative',
  Doubtful: 'stat-negative',
  Questionable: '',
  'Did Not Participate In Practice': 'stat-negative',
  'Limited Participation in Practice': '',
  'Full Participation in Practice': 'stat-positive',
};

export function InjuriesView({ season, onDataLoaded }: { season: number; onDataLoaded?: (data: unknown[]) => void }) {
  const [data, setData] = useState<Injury[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [teamFilter, setTeamFilter] = useState('ALL');
  const [weekFilter, setWeekFilter] = useState(0);
  const [statusFilter, setStatusFilter] = useState('ALL');

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchInjuries(season)
      .then((d) => {
        setData(d);
        onDataLoaded?.(d);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [season, onDataLoaded]);

  const teams = useMemo(
    () => ['ALL', ...[...new Set(data.map((d) => d.team).filter(Boolean))].sort()],
    [data]
  );

  const weeks = useMemo(
    () => [...new Set(data.map((d) => d.week))].sort((a, b) => a - b),
    [data]
  );

  const filtered = useMemo(() => {
    let d = [...data];
    if (teamFilter !== 'ALL') d = d.filter((r) => r.team === teamFilter);
    if (weekFilter > 0) d = d.filter((r) => r.week === weekFilter);
    if (statusFilter !== 'ALL')
      d = d.filter((r) => r.report_status === statusFilter);
    if (search) {
      const q = search.toLowerCase();
      d = d.filter(
        (r) =>
          r.full_name?.toLowerCase().includes(q) ||
          r.report_primary_injury?.toLowerCase().includes(q)
      );
    }
    return d.sort((a, b) => b.week - a.week || a.team.localeCompare(b.team)).slice(0, 500);
  }, [data, teamFilter, weekFilter, statusFilter, search]);

  if (loading)
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading injury data...</div>
      </div>
    );
  if (error)
    return (
      <div className="empty-state">
        <h3>Failed to load injuries</h3>
        <p>{error}</p>
      </div>
    );

  return (
    <>
      <div className="controls">
        <input
          type="text"
          placeholder="Search players or injuries..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="control-group">
          <label className="control-label">Team</label>
          <select
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value)}
          >
            {teams.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="control-group">
          <label className="control-label">Week</label>
          <select
            value={weekFilter}
            onChange={(e) => setWeekFilter(Number(e.target.value))}
          >
            <option value={0}>All</option>
            {weeks.map((w) => (
              <option key={w} value={w}>
                Week {w}
              </option>
            ))}
          </select>
        </div>
        <div className="control-group">
          <label className="control-label">Status</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="ALL">All</option>
            <option value="Out">Out</option>
            <option value="Doubtful">Doubtful</option>
            <option value="Questionable">Questionable</option>
          </select>
        </div>
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Week</th>
              <th>Player</th>
              <th>Pos</th>
              <th>Team</th>
              <th>Primary Injury</th>
              <th>Secondary Injury</th>
              <th>Game Status</th>
              <th>Practice Status</th>
              <th>Practice Injury</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={`${r.gsis_id}-${r.week}-${i}`}>
                <td>{r.week}</td>
                <td>
                  <strong>{r.full_name}</strong>
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
                <td>{r.team}</td>
                <td>{r.report_primary_injury || '-'}</td>
                <td>{r.report_secondary_injury || '-'}</td>
                <td
                  className={STATUS_COLORS[r.report_status] || ''}
                >
                  <strong>{r.report_status || '-'}</strong>
                </td>
                <td>{r.practice_status || '-'}</td>
                <td>{r.practice_primary_injury || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
