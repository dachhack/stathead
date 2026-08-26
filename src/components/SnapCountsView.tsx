import { useState, useEffect, useMemo } from 'react';
import { PlayerName } from './PlayerName';
import type { SnapCount, SortDirection } from '../types';
import { fetchSnapCounts, isNotPublished } from '../data';
import { SeasonDataPending } from './SeasonDataPending';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'LB', 'DB', 'K'];

type SortField = 'offense_snaps' | 'offense_pct' | 'defense_snaps' | 'defense_pct' | 'st_snaps' | 'st_pct' | 'player' | 'week';

export function SnapCountsView({ season, onDataLoaded }: { season: number; onDataLoaded?: (data: unknown[]) => void }) {
  const [snaps, setSnaps] = useState<SnapCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // A 404 preseason means the file is not published yet, not that we failed.
  const [pending, setPending] = useState(false);
  const [search, setSearch] = useState('');
  const [posFilter, setPosFilter] = useState('ALL');
  const [teamFilter, setTeamFilter] = useState('ALL');
  const [weekFilter, setWeekFilter] = useState(0);
  const [sortField, setSortField] = useState<SortField>('offense_snaps');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');

  useEffect(() => {
    setLoading(true);
    setError(null);
    setPending(false);
    fetchSnapCounts(season)
      .then((data) => {
        setSnaps(data);
        onDataLoaded?.(data);
      })
      .catch((e) => { if (isNotPublished(e)) setPending(true); else setError(e.message); })
      .finally(() => setLoading(false));
  }, [season, onDataLoaded]);

  const teams = useMemo(
    () => ['ALL', ...new Set(snaps.map((s) => s.team).filter(Boolean))].sort(),
    [snaps]
  );

  const weeks = useMemo(
    () => [...new Set(snaps.map((s) => s.week))].sort((a, b) => a - b),
    [snaps]
  );

  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const filtered = useMemo(() => {
    let data = [...snaps];
    if (posFilter !== 'ALL')
      data = data.filter((s) => s.position === posFilter);
    if (teamFilter !== 'ALL')
      data = data.filter((s) => s.team === teamFilter);
    if (weekFilter > 0) data = data.filter((s) => s.week === weekFilter);
    if (search) {
      const q = search.toLowerCase();
      data = data.filter(
        (s) =>
          s.player?.toLowerCase().includes(q) ||
          s.team?.toLowerCase().includes(q)
      );
    }
    data.sort((a, b) => {
      const aVal = a[sortField] ?? '';
      const bVal = b[sortField] ?? '';
      if (typeof aVal === 'string')
        return sortDir === 'asc'
          ? (aVal as string).localeCompare(bVal as string)
          : (bVal as string).localeCompare(aVal as string);
      return sortDir === 'asc'
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });
    return data.slice(0, 500);
  }, [snaps, posFilter, teamFilter, weekFilter, search, sortField, sortDir]);

  const sortArrow = (field: SortField) =>
    field === sortField ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';

  if (loading)
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading snap count data...</div>
      </div>
    );
  if (pending) return <SeasonDataPending season={season} what="snap counts" />;
  if (error)
    return (
      <div className="empty-state">
        <h3>Failed to load snap counts</h3>
        <p>{error}</p>
      </div>
    );

  const pctBar = (pct: number) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div
        style={{
          width: 60,
          height: 6,
          background: 'var(--bg-primary)',
          borderRadius: 3,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${Math.min(100, (pct || 0) * 100)}%`,
            height: '100%',
            background: 'var(--accent)',
            borderRadius: 3,
          }}
        />
      </div>
      <span>{pct != null ? `${Math.round(pct * 100)}%` : '-'}</span>
    </div>
  );

  return (
    <>
      <div className="controls">
        <input
          type="text"
          placeholder="Search players..."
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
                {w}
              </option>
            ))}
          </select>
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
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th onClick={() => handleSort('player')}>
                Player{sortArrow('player')}
              </th>
              <th>Pos</th>
              <th>Team</th>
              <th onClick={() => handleSort('week')}>
                Week{sortArrow('week')}
              </th>
              <th>Opponent</th>
              <th onClick={() => handleSort('offense_snaps')}>
                Off Snaps{sortArrow('offense_snaps')}
              </th>
              <th onClick={() => handleSort('offense_pct')}>
                Off %{sortArrow('offense_pct')}
              </th>
              <th onClick={() => handleSort('defense_snaps')}>
                Def Snaps{sortArrow('defense_snaps')}
              </th>
              <th onClick={() => handleSort('defense_pct')}>
                Def %{sortArrow('defense_pct')}
              </th>
              <th onClick={() => handleSort('st_snaps')}>
                ST Snaps{sortArrow('st_snaps')}
              </th>
              <th onClick={() => handleSort('st_pct')}>
                ST %{sortArrow('st_pct')}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s, i) => (
              <tr key={`${s.pfr_player_id}-${s.week}-${i}`}>
                <td>
                  <strong><PlayerName name={s.player} position={s.position} /></strong>
                </td>
                <td>
                  <span className={`pos-badge pos-${s.position}`}>
                    {s.position}
                  </span>
                </td>
                <td>{s.team}</td>
                <td>{s.week}</td>
                <td>{s.opponent}</td>
                <td>{s.offense_snaps ?? '-'}</td>
                <td>{pctBar(s.offense_pct)}</td>
                <td>{s.defense_snaps ?? '-'}</td>
                <td>{pctBar(s.defense_pct)}</td>
                <td>{s.st_snaps ?? '-'}</td>
                <td>{pctBar(s.st_pct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
