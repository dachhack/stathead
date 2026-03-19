import { useState, useEffect, useMemo } from 'react';
import type { AdvancedStats, SortDirection } from '../types';
import { fetchAdvancedStats } from '../data';

type StatType = 'pass' | 'rush' | 'rec' | 'def';
type SortField = keyof AdvancedStats;

const STAT_LABELS: Record<StatType, string> = {
  pass: 'Passing',
  rush: 'Rushing',
  rec: 'Receiving',
  def: 'Defense',
};

export function AdvancedStatsView({ season }: { season: number }) {
  const [data, setData] = useState<AdvancedStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statType, setStatType] = useState<StatType>('pass');
  const [search, setSearch] = useState('');
  const [weekFilter, setWeekFilter] = useState(0);
  const [sortField, setSortField] = useState<SortField>('times_pressured');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchAdvancedStats(season, statType)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [season, statType]);

  const weeks = useMemo(
    () => [...new Set(data.map((d) => d.week))].sort((a, b) => a - b),
    [data]
  );

  const handleSort = (field: SortField) => {
    if (field === sortField) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const filtered = useMemo(() => {
    let d = [...data];
    if (weekFilter > 0) d = d.filter((r) => r.week === weekFilter);
    if (search) {
      const q = search.toLowerCase();
      d = d.filter(
        (r) =>
          r.pfr_player_name?.toLowerCase().includes(q) ||
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
    return d.slice(0, 500);
  }, [data, weekFilter, search, sortField, sortDir]);

  const sortArrow = (field: SortField) =>
    field === sortField ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';

  const fmt = (v: number | null | undefined, dec = 0) => {
    if (v == null || isNaN(v)) return '-';
    return dec > 0 ? v.toFixed(dec) : String(v);
  };

  const pctFmt = (v: number | null | undefined) => {
    if (v == null || isNaN(v)) return '-';
    return `${(v * 100).toFixed(1)}%`;
  };

  if (loading)
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">
          Loading {STAT_LABELS[statType]} advanced stats...
        </div>
      </div>
    );
  if (error)
    return (
      <div className="empty-state">
        <h3>Failed to load advanced stats</h3>
        <p>{error}</p>
      </div>
    );

  return (
    <>
      <div className="scoring-format-tabs" style={{ marginBottom: 12 }}>
        {(Object.keys(STAT_LABELS) as StatType[]).map((t) => (
          <button
            key={t}
            className={`format-tab ${statType === t ? 'active' : ''}`}
            onClick={() => setStatType(t)}
          >
            {STAT_LABELS[t]}
          </button>
        ))}
      </div>

      <div className="controls">
        <input
          type="text"
          placeholder="Search players or teams..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
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
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Week</th>
              <th onClick={() => handleSort('pfr_player_name')}>
                Player{sortArrow('pfr_player_name')}
              </th>
              <th>Team</th>
              <th>Opp</th>
              {statType === 'pass' && (
                <>
                  <th onClick={() => handleSort('passing_drops')}>
                    Drops{sortArrow('passing_drops')}
                  </th>
                  <th onClick={() => handleSort('passing_drop_pct')}>
                    Drop %{sortArrow('passing_drop_pct')}
                  </th>
                  <th onClick={() => handleSort('passing_bad_throws')}>
                    Bad Throws{sortArrow('passing_bad_throws')}
                  </th>
                  <th onClick={() => handleSort('passing_bad_throw_pct')}>
                    Bad Throw %{sortArrow('passing_bad_throw_pct')}
                  </th>
                  <th onClick={() => handleSort('times_sacked')}>
                    Sacked{sortArrow('times_sacked')}
                  </th>
                  <th onClick={() => handleSort('times_blitzed')}>
                    Blitzed{sortArrow('times_blitzed')}
                  </th>
                  <th onClick={() => handleSort('times_hurried')}>
                    Hurried{sortArrow('times_hurried')}
                  </th>
                  <th onClick={() => handleSort('times_hit')}>
                    Hit{sortArrow('times_hit')}
                  </th>
                  <th onClick={() => handleSort('times_pressured')}>
                    Pressured{sortArrow('times_pressured')}
                  </th>
                  <th onClick={() => handleSort('times_pressured_pct')}>
                    Press %{sortArrow('times_pressured_pct')}
                  </th>
                </>
              )}
              {statType === 'rec' && (
                <>
                  <th onClick={() => handleSort('receiving_drop')}>
                    Drops{sortArrow('receiving_drop')}
                  </th>
                  <th onClick={() => handleSort('receiving_drop_pct')}>
                    Drop %{sortArrow('receiving_drop_pct')}
                  </th>
                </>
              )}
              {statType === 'def' && (
                <>
                  <th onClick={() => handleSort('def_times_blitzed')}>
                    Blitzed{sortArrow('def_times_blitzed')}
                  </th>
                  <th onClick={() => handleSort('def_times_hurried')}>
                    Hurries{sortArrow('def_times_hurried')}
                  </th>
                  <th onClick={() => handleSort('def_times_hitqb')}>
                    QB Hits{sortArrow('def_times_hitqb')}
                  </th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={`${r.pfr_player_id}-${r.week}-${i}`}>
                <td>{r.week}</td>
                <td>
                  <strong>{r.pfr_player_name}</strong>
                </td>
                <td>{r.team}</td>
                <td>{r.opponent}</td>
                {statType === 'pass' && (
                  <>
                    <td>{fmt(r.passing_drops)}</td>
                    <td>{pctFmt(r.passing_drop_pct)}</td>
                    <td>{fmt(r.passing_bad_throws)}</td>
                    <td>{pctFmt(r.passing_bad_throw_pct)}</td>
                    <td>{fmt(r.times_sacked)}</td>
                    <td>{fmt(r.times_blitzed)}</td>
                    <td>{fmt(r.times_hurried)}</td>
                    <td>{fmt(r.times_hit)}</td>
                    <td>{fmt(r.times_pressured)}</td>
                    <td>{pctFmt(r.times_pressured_pct)}</td>
                  </>
                )}
                {statType === 'rec' && (
                  <>
                    <td>{fmt(r.receiving_drop)}</td>
                    <td>{pctFmt(r.receiving_drop_pct)}</td>
                  </>
                )}
                {statType === 'def' && (
                  <>
                    <td>{fmt(r.def_times_blitzed)}</td>
                    <td>{fmt(r.def_times_hurried)}</td>
                    <td>{fmt(r.def_times_hitqb)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
