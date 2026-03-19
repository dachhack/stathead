import { useState, useEffect, useMemo } from 'react';
import type { CombineResult, SortDirection } from '../types';
import { fetchCombine } from '../data';

type SortField = keyof CombineResult;
const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'OT', 'OG', 'C', 'DE', 'DT', 'LB', 'CB', 'S', 'K', 'P'];

export function CombineView() {
  const [data, setData] = useState<CombineResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [posFilter, setPosFilter] = useState('ALL');
  const [yearFilter, setYearFilter] = useState(0);
  const [sortField, setSortField] = useState<SortField>('season');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');

  useEffect(() => {
    fetchCombine()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const years = useMemo(
    () => [...new Set(data.map((d) => d.season).filter(Boolean))].sort((a, b) => b - a),
    [data]
  );

  const handleSort = (field: SortField) => {
    if (field === sortField) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortField(field);
      setSortDir(field === 'forty' || field === 'cone' || field === 'shuttle' ? 'asc' : 'desc');
    }
  };

  const filtered = useMemo(() => {
    let d = [...data];
    if (posFilter !== 'ALL') d = d.filter((r) => r.pos === posFilter);
    if (yearFilter > 0) d = d.filter((r) => r.season === yearFilter);
    if (search) {
      const q = search.toLowerCase();
      d = d.filter(
        (r) =>
          r.player_name?.toLowerCase().includes(q) ||
          r.school?.toLowerCase().includes(q)
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
  }, [data, posFilter, yearFilter, search, sortField, sortDir]);

  const sortArrow = (field: SortField) =>
    field === sortField ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';

  const fmt = (v: number | null | undefined) =>
    v != null && !isNaN(v) ? v.toFixed(2) : '-';

  if (loading)
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading NFL Combine data...</div>
      </div>
    );
  if (error)
    return (
      <div className="empty-state">
        <h3>Failed to load combine data</h3>
        <p>{error}</p>
      </div>
    );

  return (
    <>
      <div className="controls">
        <input
          type="text"
          placeholder="Search players or schools..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="control-group">
          <label className="control-label">Year</label>
          <select
            value={yearFilter}
            onChange={(e) => setYearFilter(Number(e.target.value))}
          >
            <option value={0}>All Years</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        <div className="position-filters">
          {POSITIONS.slice(0, 8).map((pos) => (
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
              <th onClick={() => handleSort('season')}>
                Year{sortArrow('season')}
              </th>
              <th onClick={() => handleSort('player_name')}>
                Player{sortArrow('player_name')}
              </th>
              <th>Pos</th>
              <th onClick={() => handleSort('school')}>
                School{sortArrow('school')}
              </th>
              <th onClick={() => handleSort('ht')}>Ht{sortArrow('ht')}</th>
              <th onClick={() => handleSort('wt')}>Wt{sortArrow('wt')}</th>
              <th onClick={() => handleSort('forty')}>
                40-Yd{sortArrow('forty')}
              </th>
              <th onClick={() => handleSort('bench')}>
                Bench{sortArrow('bench')}
              </th>
              <th onClick={() => handleSort('vertical')}>
                Vert{sortArrow('vertical')}
              </th>
              <th onClick={() => handleSort('broad_jump')}>
                Broad{sortArrow('broad_jump')}
              </th>
              <th onClick={() => handleSort('cone')}>
                3-Cone{sortArrow('cone')}
              </th>
              <th onClick={() => handleSort('shuttle')}>
                Shuttle{sortArrow('shuttle')}
              </th>
              <th>Draft</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={`${r.pfr_id || r.player_name}-${i}`}>
                <td>{r.season}</td>
                <td>
                  <strong>{r.player_name}</strong>
                </td>
                <td>
                  <span className={`pos-badge pos-${r.pos}`}>{r.pos}</span>
                </td>
                <td>{r.school || '-'}</td>
                <td>{r.ht || '-'}</td>
                <td>{r.wt || '-'}</td>
                <td className={r.forty ? '' : 'text-muted'}>
                  {fmt(r.forty)}
                </td>
                <td>{r.bench || '-'}</td>
                <td>{r.vertical ? fmt(r.vertical) : '-'}</td>
                <td>{r.broad_jump || '-'}</td>
                <td>{r.cone ? fmt(r.cone) : '-'}</td>
                <td>{r.shuttle ? fmt(r.shuttle) : '-'}</td>
                <td>
                  {r.draft_round && r.draft_ovr
                    ? `Rd ${r.draft_round}, #${r.draft_ovr}`
                    : 'UDFA'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
