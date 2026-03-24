import { useState, useEffect, useMemo } from 'react';
import type { DraftPick, DraftProfile, DraftProspect, SortDirection } from '../types';
import { fetchDraftPicks, fetchDraftProfiles, fetchDraftProspects } from '../data';

type SortField = keyof DraftPick;

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

function gradeColor(grade: number): string {
  if (grade >= 90) return '#10b981';
  if (grade >= 80) return '#34d399';
  if (grade >= 70) return '#60a5fa';
  if (grade >= 60) return '#fbbf24';
  return '#ef4444';
}

// Merged row for the 2026 prospect table
interface ProspectRow {
  name: string;
  position: string;
  school: string;
  height: number;
  weight: number;
  grade: number;
  ovrRk: number;
  posRk: number;
  projRound: number | null;
  projPick: number | null;
  projOverall: number | null;
  scouting: string[];
}

type ProspectSortField = 'name' | 'position' | 'school' | 'grade' | 'ovrRk' | 'posRk' | 'projOverall' | 'height' | 'weight';

const POS_FILTERS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'LB', 'CB', 'S', 'EDGE'];

export function DraftView({ onDataLoaded }: { onDataLoaded?: (data: unknown[]) => void }) {
  const [data, setData] = useState<DraftPick[]>([]);
  const [profiles, setProfiles] = useState<DraftProfile[]>([]);
  const [prospects, setProspects] = useState<DraftProspect[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [yearFilter, setYearFilter] = useState(2026);
  const [roundFilter, setRoundFilter] = useState(0);
  const [posFilter, setPosFilter] = useState('ALL');
  const [sortField, setSortField] = useState<SortField>('pick');
  const [sortDir, setSortDir] = useState<SortDirection>('asc');
  // Prospect-specific sort
  const [pSortField, setPSortField] = useState<ProspectSortField>('ovrRk');
  const [pSortDir, setPSortDir] = useState<SortDirection>('asc');
  const [expandedPlayer, setExpandedPlayer] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetchDraftPicks(),
      fetchDraftProfiles().catch(() => [] as DraftProfile[]),
      fetchDraftProspects().catch(() => [] as DraftProspect[]),
    ])
      .then(([picks, profileData, prospectData]) => {
        setData(picks);
        setProfiles(profileData);
        setProspects(prospectData.filter((p) => p.draft_year === 2026));
        onDataLoaded?.(picks);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [onDataLoaded]);

  const is2026 = yearFilter === 2026;

  // ── Historical years ──
  const years = useMemo(
    () =>
      [2026, ...new Set(data.map((d) => d.season).filter(Boolean))].sort(
        (a, b) => b - a
      ),
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
    let d = data.filter((r) => r.season === yearFilter);
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

  // ── 2026 Prospects ──
  const prospectByName = useMemo(() => {
    const m = new Map<string, DraftProspect>();
    for (const p of prospects) m.set(normName(p.player_name), p);
    return m;
  }, [prospects]);

  const prospectRows = useMemo((): ProspectRow[] => {
    return profiles.map((p) => {
      const prospect = prospectByName.get(normName(p.player_name));
      const scouting = [p.text1, p.text2, p.text3, p.text4].filter(Boolean);
      return {
        name: p.player_name,
        position: p.pos_abbr,
        school: p.school_name || p.school,
        height: p.height,
        weight: p.weight,
        grade: p.grade || prospect?.grade || 0,
        ovrRk: p.ovr_rk || prospect?.ovr_rk || 0,
        posRk: p.pos_rk || prospect?.pos_rk || 0,
        projRound: prospect?.round || null,
        projPick: prospect?.pick || null,
        projOverall: prospect?.overall || null,
        scouting,
      };
    });
  }, [profiles, prospectByName]);

  const handlePSort = (field: ProspectSortField) => {
    if (field === pSortField) setPSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setPSortField(field);
      setPSortDir(field === 'grade' ? 'desc' : 'asc');
    }
  };

  const pSortArrow = (field: ProspectSortField) =>
    field === pSortField ? (pSortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';

  const filteredProspects = useMemo(() => {
    let d = [...prospectRows];
    if (posFilter !== 'ALL') d = d.filter((r) => r.position === posFilter);
    if (roundFilter > 0) d = d.filter((r) => r.projRound === roundFilter);
    if (search) {
      const q = search.toLowerCase();
      d = d.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.school.toLowerCase().includes(q) ||
          r.position.toLowerCase().includes(q)
      );
    }
    d.sort((a, b) => {
      const aVal = a[pSortField] ?? (pSortDir === 'asc' ? Infinity : -Infinity);
      const bVal = b[pSortField] ?? (pSortDir === 'asc' ? Infinity : -Infinity);
      if (typeof aVal === 'string')
        return pSortDir === 'asc'
          ? aVal.localeCompare(bVal as string)
          : (bVal as string).localeCompare(aVal);
      return pSortDir === 'asc'
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });
    return d;
  }, [prospectRows, posFilter, roundFilter, search, pSortField, pSortDir]);

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
          placeholder={is2026 ? 'Search prospects, schools...' : 'Search players, colleges, teams...'}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="control-group">
          <label className="control-label">Year</label>
          <select
            value={yearFilter}
            onChange={(e) => { setYearFilter(Number(e.target.value)); setRoundFilter(0); setPosFilter('ALL'); }}
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}{y === 2026 ? ' Prospects' : ''}
              </option>
            ))}
          </select>
        </div>
        {is2026 && (
          <div className="position-filters">
            {POS_FILTERS.map((pos) => (
              <button
                key={pos}
                className={`pos-filter ${posFilter === pos ? 'active' : ''}`}
                onClick={() => setPosFilter(pos)}
              >
                {pos}
              </button>
            ))}
          </div>
        )}
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

      {is2026 ? (
        <>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
            2026 NFL Draft prospects — grades &amp; rankings from ESPN via{' '}
            <a href="https://github.com/JackLich10/nfl-draft-data" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
              nfl-draft-data
            </a>.
            {' '}{filteredProspects.length} of {prospectRows.length} prospects shown.
            {' '}Click a row to view scouting notes.
          </p>
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  <th onClick={() => handlePSort('name')} style={{ cursor: 'pointer' }}>
                    Player{pSortArrow('name')}
                  </th>
                  <th onClick={() => handlePSort('position')} style={{ cursor: 'pointer' }}>
                    Pos{pSortArrow('position')}
                  </th>
                  <th onClick={() => handlePSort('school')} style={{ cursor: 'pointer' }}>
                    School{pSortArrow('school')}
                  </th>
                  <th onClick={() => handlePSort('grade')} style={{ cursor: 'pointer', textAlign: 'right' }}>
                    Grade{pSortArrow('grade')}
                  </th>
                  <th onClick={() => handlePSort('ovrRk')} style={{ cursor: 'pointer', textAlign: 'right' }}>
                    Ovr Rk{pSortArrow('ovrRk')}
                  </th>
                  <th onClick={() => handlePSort('posRk')} style={{ cursor: 'pointer', textAlign: 'right' }}>
                    Pos Rk{pSortArrow('posRk')}
                  </th>
                  <th onClick={() => handlePSort('projOverall')} style={{ cursor: 'pointer', textAlign: 'right' }}>
                    Proj Rd/Pick{pSortArrow('projOverall')}
                  </th>
                  <th onClick={() => handlePSort('height')} style={{ cursor: 'pointer', textAlign: 'right' }}>
                    Ht{pSortArrow('height')}
                  </th>
                  <th onClick={() => handlePSort('weight')} style={{ cursor: 'pointer', textAlign: 'right' }}>
                    Wt{pSortArrow('weight')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredProspects.map((r, i) => (
                  <>
                    <tr
                      key={`${r.name}-${r.position}`}
                      onClick={() => setExpandedPlayer(expandedPlayer === r.name ? null : r.name)}
                      style={{ cursor: r.scouting.length > 0 ? 'pointer' : undefined }}
                    >
                      <td className="rank-cell">{i + 1}</td>
                      <td><strong>{r.name}</strong></td>
                      <td>
                        <span className={`pos-badge pos-${r.position}`}>{r.position}</span>
                      </td>
                      <td>{r.school || '-'}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: r.grade ? gradeColor(r.grade) : 'var(--text-muted)' }}>
                        {r.grade || '-'}
                      </td>
                      <td style={{ textAlign: 'right' }}>{r.ovrRk || '-'}</td>
                      <td style={{ textAlign: 'right' }}>{r.posRk || '-'}</td>
                      <td style={{ textAlign: 'right' }}>
                        {r.projRound
                          ? <>
                              {r.projRound}.{String(r.projPick ?? '').padStart(2, '0')}
                              <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 3 }}>
                                ({r.projOverall})
                              </span>
                            </>
                          : '-'}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 12 }}>
                        {r.height ? `${Math.floor(r.height / 12)}'${r.height % 12}"` : '-'}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 12 }}>
                        {r.weight || '-'}
                      </td>
                    </tr>
                    {expandedPlayer === r.name && r.scouting.length > 0 && (
                      <tr key={`${r.name}-scouting`}>
                        <td colSpan={10} style={{ padding: '8px 16px', background: 'var(--bg-secondary)', fontSize: 12, lineHeight: 1.5 }}>
                          {r.scouting.map((t, j) => (
                            <p key={j} style={{ margin: j === 0 ? 0 : '6px 0 0' }}>{t}</p>
                          ))}
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th onClick={() => handleSort('pick')}>
                    Pick{sortArrow('pick')}
                  </th>
                  <th>Rd</th>
                  <th>Team</th>
                  <th onClick={() => handleSort('pfr_player_name')}>
                    Player{sortArrow('pfr_player_name')}
                  </th>
                  <th>Pos</th>
                  <th onClick={() => handleSort('college')}>
                    College{sortArrow('college')}
                  </th>
                  <th onClick={() => handleSort('age')}>
                    Age{sortArrow('age')}
                  </th>
                  <th onClick={() => handleSort('games')}>
                    Games{sortArrow('games')}
                  </th>
                  <th onClick={() => handleSort('car_av')}>
                    Career AV{sortArrow('car_av')}
                  </th>
                  <th onClick={() => handleSort('dr_av')}>
                    Draft AV{sortArrow('dr_av')}
                  </th>
                  <th onClick={() => handleSort('probowls')}>
                    Pro Bowls{sortArrow('probowls')}
                  </th>
                  <th onClick={() => handleSort('allpro')}>
                    All-Pro{sortArrow('allpro')}
                  </th>
                  <th onClick={() => handleSort('seasons_started')}>
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
      )}
    </>
  );
}
