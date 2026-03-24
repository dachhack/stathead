import { useState, useEffect, useMemo } from 'react';
import type { DraftProspect, DraftProfile, SortDirection } from '../types';
import { fetchDraftProspects, fetchDraftProfiles } from '../data';

type MergedProspect = DraftProspect & { text1?: string; text2?: string; text3?: string; text4?: string };
type SortField = keyof MergedProspect;

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'LB', 'CB', 'S', 'EDGE'];

function gradeColor(grade: number | undefined): string {
  if (grade == null || isNaN(grade)) return 'var(--text-muted)';
  if (grade >= 90) return '#22c55e';
  if (grade >= 80) return '#4ade80';
  if (grade >= 70) return '#a3e635';
  if (grade >= 60) return '#facc15';
  if (grade >= 50) return '#fb923c';
  return '#ef4444';
}

function gradeLabel(grade: number | undefined): string {
  if (grade == null || isNaN(grade)) return '';
  if (grade >= 90) return 'Elite';
  if (grade >= 80) return 'Great';
  if (grade >= 70) return 'Good';
  if (grade >= 60) return 'Above Avg';
  if (grade >= 50) return 'Average';
  return 'Below Avg';
}

function heightDisplay(inches: number | undefined): string {
  if (!inches || isNaN(inches)) return '-';
  const ft = Math.floor(inches / 12);
  const rem = Math.round(inches % 12);
  return `${ft}'${rem}"`;
}

function roundLabel(round: number | undefined, pick: number | undefined): string {
  if (!round && !pick) return '-';
  if (round && pick) return `Rd ${round}, #${pick}`;
  if (round) return `Rd ${round}`;
  if (pick) return `#${pick}`;
  return '-';
}

export function RookieProspectsView({ onDataLoaded }: { onDataLoaded?: (data: unknown[]) => void }) {
  const [prospects, setProspects] = useState<MergedProspect[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [posFilter, setPosFilter] = useState('ALL');
  const [yearFilter, setYearFilter] = useState(0);
  const [sortField, setSortField] = useState<SortField>('ovr_rk');
  const [sortDir, setSortDir] = useState<SortDirection>('asc');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  useEffect(() => {
    Promise.all([fetchDraftProspects(), fetchDraftProfiles()])
      .then(([prosp, profiles]) => {
        const profileMap = new Map<number, DraftProfile>();
        for (const p of profiles) {
          profileMap.set(p.player_id, p);
        }
        const merged: MergedProspect[] = prosp.map((p) => {
          const profile = profileMap.get(p.player_id);
          return {
            ...p,
            text1: profile?.text1,
            text2: profile?.text2,
            text3: profile?.text3,
            text4: profile?.text4,
            // Use profile grade if prospect grade is missing
            grade: p.grade || profile?.grade || 0,
            ovr_rk: p.ovr_rk || profile?.ovr_rk || 999,
            pos_rk: p.pos_rk || profile?.pos_rk || 999,
          };
        });
        setProspects(merged);
        onDataLoaded?.(merged);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [onDataLoaded]);

  const years = useMemo(
    () => [...new Set(prospects.map((d) => d.draft_year).filter(Boolean))].sort((a, b) => b - a),
    [prospects]
  );

  // Default to the most recent draft year
  const activeYear = yearFilter || years[0] || 0;

  const handleSort = (field: SortField) => {
    if (field === sortField) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortField(field);
      setSortDir(field === 'grade' ? 'desc' : 'asc');
    }
  };

  const filtered = useMemo(() => {
    let d = [...prospects];
    if (activeYear > 0) d = d.filter((r) => r.draft_year === activeYear);
    if (posFilter !== 'ALL') {
      d = d.filter((r) => {
        const pos = (r.pos_abbr || r.position || '').toUpperCase();
        if (posFilter === 'OL') return ['OT', 'OG', 'C', 'OL', 'IOL', 'G', 'T'].includes(pos);
        if (posFilter === 'DL') return ['DT', 'DE', 'DL', 'NT', 'IDL'].includes(pos);
        if (posFilter === 'EDGE') return ['EDGE', 'OLB', 'DE'].includes(pos);
        return pos === posFilter;
      });
    }
    if (search) {
      const q = search.toLowerCase();
      d = d.filter(
        (r) =>
          r.player_name?.toLowerCase().includes(q) ||
          r.school_name?.toLowerCase().includes(q) ||
          r.school?.toLowerCase().includes(q) ||
          r.team?.toLowerCase().includes(q)
      );
    }
    d.sort((a, b) => {
      const aVal = a[sortField] ?? 999;
      const bVal = b[sortField] ?? 999;
      if (typeof aVal === 'string')
        return sortDir === 'asc'
          ? aVal.localeCompare(bVal as string)
          : (bVal as string).localeCompare(aVal);
      return sortDir === 'asc'
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });
    return d.slice(0, 300);
  }, [prospects, activeYear, posFilter, search, sortField, sortDir]);

  const sortArrow = (field: SortField) =>
    field === sortField ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';

  if (loading)
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading rookie prospect data...</div>
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
          placeholder="Search players, schools, or teams..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="control-group">
          <label className="control-label">Draft Year</label>
          <select
            value={yearFilter}
            onChange={(e) => setYearFilter(Number(e.target.value))}
          >
            <option value={0}>Latest ({years[0]})</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
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

      <div style={{ padding: '0 16px 8px', fontSize: 12, color: 'var(--text-muted)' }}>
        Showing {filtered.length} prospects for the {activeYear} draft class
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th onClick={() => handleSort('ovr_rk')} style={{ cursor: 'pointer' }}>
                Rank{sortArrow('ovr_rk')}
              </th>
              <th onClick={() => handleSort('player_name')} style={{ cursor: 'pointer' }}>
                Player{sortArrow('player_name')}
              </th>
              <th>Pos</th>
              <th onClick={() => handleSort('school_name')} style={{ cursor: 'pointer' }}>
                School{sortArrow('school_name')}
              </th>
              <th onClick={() => handleSort('grade')} style={{ cursor: 'pointer' }}>
                Grade{sortArrow('grade')}
              </th>
              <th onClick={() => handleSort('pos_rk')} style={{ cursor: 'pointer' }}>
                Pos Rk{sortArrow('pos_rk')}
              </th>
              <th onClick={() => handleSort('round')} style={{ cursor: 'pointer' }}>
                Proj. Round{sortArrow('round')}
              </th>
              <th onClick={() => handleSort('overall')} style={{ cursor: 'pointer' }}>
                Proj. Pick{sortArrow('overall')}
              </th>
              <th>Team</th>
              <th onClick={() => handleSort('height')} style={{ cursor: 'pointer' }}>
                Ht{sortArrow('height')}
              </th>
              <th onClick={() => handleSort('weight')} style={{ cursor: 'pointer' }}>
                Wt{sortArrow('weight')}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <>
                <tr
                  key={`${r.player_id}-${i}`}
                  onClick={() => setExpandedId(expandedId === r.player_id ? null : r.player_id)}
                  style={{ cursor: r.text1 ? 'pointer' : 'default' }}
                >
                  <td style={{ fontWeight: 700 }}>
                    {r.ovr_rk && r.ovr_rk < 999 ? r.ovr_rk : '-'}
                  </td>
                  <td>
                    <strong>{r.player_name}</strong>
                  </td>
                  <td>
                    <span className={`pos-badge pos-${(r.pos_abbr || r.position || '').toUpperCase()}`}>
                      {r.pos_abbr || r.position}
                    </span>
                  </td>
                  <td>{r.school_name || r.school || '-'}</td>
                  <td>
                    {r.grade ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span
                          style={{
                            display: 'inline-block',
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: gradeColor(r.grade),
                          }}
                        />
                        <strong style={{ color: gradeColor(r.grade) }}>
                          {Number(r.grade).toFixed(1)}
                        </strong>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                          {gradeLabel(r.grade)}
                        </span>
                      </span>
                    ) : (
                      '-'
                    )}
                  </td>
                  <td>{r.pos_rk && r.pos_rk < 999 ? r.pos_rk : '-'}</td>
                  <td>
                    {r.round ? (
                      <span
                        style={{
                          fontWeight: r.round <= 2 ? 700 : 400,
                          color: r.round === 1 ? '#22c55e' : r.round === 2 ? '#a3e635' : 'inherit',
                        }}
                      >
                        Round {r.round}
                      </span>
                    ) : (
                      '-'
                    )}
                  </td>
                  <td>{r.overall ? `#${r.overall}` : '-'}</td>
                  <td>{r.team_abbr || r.team || '-'}</td>
                  <td>{heightDisplay(r.height)}</td>
                  <td>{r.weight || '-'}</td>
                </tr>
                {expandedId === r.player_id && (r.text1 || r.text2 || r.text3 || r.text4) && (
                  <tr key={`${r.player_id}-detail`}>
                    <td colSpan={11} style={{ padding: '12px 16px', background: 'var(--bg-tertiary)', borderLeft: `3px solid ${gradeColor(r.grade)}` }}>
                      <div style={{ display: 'grid', gap: 8, fontSize: 13, lineHeight: 1.5 }}>
                        {r.text1 && <div><strong>Overview:</strong> {r.text1}</div>}
                        {r.text2 && <div><strong>Strengths:</strong> {r.text2}</div>}
                        {r.text3 && <div><strong>Weaknesses:</strong> {r.text3}</div>}
                        {r.text4 && <div><strong>Bottom Line:</strong> {r.text4}</div>}
                      </div>
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
