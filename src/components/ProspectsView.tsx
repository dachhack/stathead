import { useState, useEffect, useMemo } from 'react';
import type { DraftProfile, DraftProspect, SortDirection } from '../types';
import { fetchDraftProfiles, fetchDraftProspects } from '../data';

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

export function ProspectsView({ onDataLoaded }: { onDataLoaded?: (data: unknown[]) => void }) {
  const [profiles, setProfiles] = useState<DraftProfile[]>([]);
  const [prospects, setProspects] = useState<DraftProspect[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [posFilter, setPosFilter] = useState('ALL');
  const [roundFilter, setRoundFilter] = useState(0);
  const [sortField, setSortField] = useState<ProspectSortField>('ovrRk');
  const [sortDir, setSortDir] = useState<SortDirection>('asc');
  const [expandedPlayer, setExpandedPlayer] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetchDraftProfiles().catch(() => [] as DraftProfile[]),
      fetchDraftProspects().catch(() => [] as DraftProspect[]),
    ])
      .then(([profileData, prospectData]) => {
        setProfiles(profileData);
        setProspects(prospectData.filter((p) => p.draft_year === 2026));
        onDataLoaded?.(profileData);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [onDataLoaded]);

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

  const handleSort = (field: ProspectSortField) => {
    if (field === sortField) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortField(field);
      setSortDir(field === 'grade' ? 'desc' : 'asc');
    }
  };

  const sortArrow = (field: ProspectSortField) =>
    field === sortField ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';

  const filtered = useMemo(() => {
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
      const aVal = a[sortField] ?? (sortDir === 'asc' ? Infinity : -Infinity);
      const bVal = b[sortField] ?? (sortDir === 'asc' ? Infinity : -Infinity);
      if (typeof aVal === 'string')
        return sortDir === 'asc'
          ? aVal.localeCompare(bVal as string)
          : (bVal as string).localeCompare(aVal);
      return sortDir === 'asc'
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });
    return d;
  }, [prospectRows, posFilter, roundFilter, search, sortField, sortDir]);

  if (loading)
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading prospect data...</div>
      </div>
    );
  if (error)
    return (
      <div className="empty-state">
        <h3>Failed to load prospect data</h3>
        <p>{error}</p>
      </div>
    );

  return (
    <>
      <div className="controls">
        <input
          type="text"
          placeholder="Search prospects, schools..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
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
        <div className="control-group">
          <label className="control-label">Proj Round</label>
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

      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
        2026 NFL Draft prospects — grades &amp; rankings from ESPN via{' '}
        <a href="https://github.com/JackLich10/nfl-draft-data" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
          nfl-draft-data
        </a>.
        {' '}{filtered.length} of {prospectRows.length} prospects shown.
        {' '}Click a row to view scouting notes. Click column headers to sort.
      </p>
      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th style={{ width: 40 }}>#</th>
              <th onClick={() => handleSort('name')} style={{ cursor: 'pointer' }}>
                Player{sortArrow('name')}
              </th>
              <th onClick={() => handleSort('position')} style={{ cursor: 'pointer' }}>
                Pos{sortArrow('position')}
              </th>
              <th onClick={() => handleSort('school')} style={{ cursor: 'pointer' }}>
                School{sortArrow('school')}
              </th>
              <th onClick={() => handleSort('grade')} style={{ cursor: 'pointer', textAlign: 'right' }}>
                Grade{sortArrow('grade')}
              </th>
              <th onClick={() => handleSort('ovrRk')} style={{ cursor: 'pointer', textAlign: 'right' }}>
                Ovr Rk{sortArrow('ovrRk')}
              </th>
              <th onClick={() => handleSort('posRk')} style={{ cursor: 'pointer', textAlign: 'right' }}>
                Pos Rk{sortArrow('posRk')}
              </th>
              <th onClick={() => handleSort('projOverall')} style={{ cursor: 'pointer', textAlign: 'right' }}>
                Proj Rd/Pick{sortArrow('projOverall')}
              </th>
              <th onClick={() => handleSort('height')} style={{ cursor: 'pointer', textAlign: 'right' }}>
                Ht{sortArrow('height')}
              </th>
              <th onClick={() => handleSort('weight')} style={{ cursor: 'pointer', textAlign: 'right' }}>
                Wt{sortArrow('weight')}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
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
  );
}
