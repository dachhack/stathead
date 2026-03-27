import { useState, useEffect, useMemo } from 'react';
import type { CombineResult, FantasyRanking, KTCPlayer, SortDirection } from '../types';
import { fetchCombine, fetchFantasyRankings, fetchKTCRankings } from '../data';

interface ProspectRow {
  name: string;
  pos: string;
  school: string;
  ht: string;
  wt: number;
  forty: number;
  bench: number;
  vertical: number;
  broadJump: number;
  cone: number;
  shuttle: number;
  // FantasyPros rookie ranking
  rookieEcr: number;
  rookieBest: number;
  rookieWorst: number;
  rookieSd: number;
  owned: number;
  // KTC dynasty
  dynastyValue: number;
  superflexValue: number;
  ktcPosRank: number;
  ktcTeam: string;
}

type SortField = keyof ProspectRow;

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'EDGE', 'DL', 'LB', 'CB', 'S', 'OL'];
const DRAFT_YEAR = 2026;

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.\-']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function valueColor(value: number): string {
  if (value >= 7000) return '#22c55e';
  if (value >= 5000) return '#4ade80';
  if (value >= 3000) return '#a3e635';
  if (value >= 1500) return '#facc15';
  if (value >= 500) return '#fb923c';
  return 'var(--text-muted)';
}

function ecrTierColor(ecr: number): string {
  if (ecr <= 5) return '#22c55e';
  if (ecr <= 12) return '#4ade80';
  if (ecr <= 24) return '#a3e635';
  if (ecr <= 48) return '#facc15';
  if (ecr <= 80) return '#fb923c';
  return 'var(--text-muted)';
}

function ecrTierLabel(ecr: number): string {
  if (ecr <= 5) return 'Elite';
  if (ecr <= 12) return 'Round 1';
  if (ecr <= 24) return 'Round 2';
  if (ecr <= 48) return 'Day 2';
  if (ecr <= 80) return 'Day 3';
  return 'Flier';
}

function fmtMeasurable(v: number | null | undefined): string {
  return v != null && !isNaN(v) && v > 0 ? v.toFixed(2) : '-';
}

export function RookieProspectsView({ onDataLoaded }: { onDataLoaded?: (data: unknown[]) => void }) {
  const [rows, setRows] = useState<ProspectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [posFilter, setPosFilter] = useState('ALL');
  const [sortField, setSortField] = useState<SortField>('rookieEcr');
  const [sortDir, setSortDir] = useState<SortDirection>('asc');
  const [view, setView] = useState<'all' | 'fantasy'>('fantasy');

  useEffect(() => {
    Promise.all([
      fetchCombine(),
      fetchFantasyRankings(),
      fetchKTCRankings('1qb'),
    ])
      .then(([combine, fpRankings, ktcPlayers]) => {
        // Filter to 2026 combine prospects
        const prospects2026 = combine.filter((c: CombineResult) => c.season === DRAFT_YEAR);

        // FantasyPros rookie rankings
        const rookieRanks = fpRankings.filter((r: FantasyRanking) => r.ecr_type === 'drk');
        const fpMap = new Map<string, FantasyRanking>();
        for (const r of rookieRanks) {
          fpMap.set(normalizeName(r.player), r);
        }

        // KTC rookies
        const ktcRookies = ktcPlayers.filter((p: KTCPlayer) => p.isRookie);
        const ktcMap = new Map<string, KTCPlayer>();
        for (const p of ktcRookies) {
          ktcMap.set(normalizeName(p.playerName), p);
        }

        // Build merged rows from combine as base
        const combineRows: ProspectRow[] = prospects2026.map((c: CombineResult) => {
          const nName = normalizeName(c.player_name);
          const fp = fpMap.get(nName);
          const ktc = ktcMap.get(nName);
          // Remove from maps so we can add unmatched FP/KTC entries after
          if (fp) fpMap.delete(nName);
          if (ktc) ktcMap.delete(nName);
          return {
            name: c.player_name,
            pos: c.pos || '',
            school: c.school || '',
            ht: c.ht || '',
            wt: c.wt || 0,
            forty: c.forty || 0,
            bench: c.bench || 0,
            vertical: c.vertical || 0,
            broadJump: c.broad_jump || 0,
            cone: c.cone || 0,
            shuttle: c.shuttle || 0,
            rookieEcr: fp ? fp.ecr : 999,
            rookieBest: fp ? fp.best : 0,
            rookieWorst: fp ? fp.worst : 0,
            rookieSd: fp ? fp.sd : 0,
            owned: fp ? (fp.player_owned_avg || 0) : 0,
            dynastyValue: ktc?.value || 0,
            superflexValue: ktc?.superflexValue || 0,
            ktcPosRank: ktc?.positionRank || 0,
            ktcTeam: ktc?.team || '',
          };
        });

        // Add FantasyPros rookies not in combine
        for (const [, fp] of fpMap) {
          const nName = normalizeName(fp.player);
          const ktc = ktcMap.get(nName);
          if (ktc) ktcMap.delete(nName);
          combineRows.push({
            name: fp.player,
            pos: fp.pos || '',
            school: '',
            ht: '',
            wt: 0,
            forty: 0, bench: 0, vertical: 0, broadJump: 0, cone: 0, shuttle: 0,
            rookieEcr: fp.ecr,
            rookieBest: fp.best,
            rookieWorst: fp.worst,
            rookieSd: fp.sd,
            owned: fp.player_owned_avg || 0,
            dynastyValue: ktc?.value || 0,
            superflexValue: ktc?.superflexValue || 0,
            ktcPosRank: ktc?.positionRank || 0,
            ktcTeam: ktc?.team || fp.team || '',
          });
        }

        setRows(combineRows);
        onDataLoaded?.(combineRows);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [onDataLoaded]);

  const handleSort = (field: SortField) => {
    if (field === sortField) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortField(field);
      const descFields: SortField[] = ['dynastyValue', 'superflexValue', 'wt', 'bench', 'vertical', 'broadJump', 'owned'];
      setSortDir(descFields.includes(field) ? 'desc' : 'asc');
    }
  };

  const filtered = useMemo(() => {
    let d = [...rows];
    // In fantasy view, only show players with a rookie ECR ranking
    if (view === 'fantasy') d = d.filter((r) => r.rookieEcr < 999);
    if (posFilter !== 'ALL') {
      d = d.filter((r) => {
        const pos = r.pos.toUpperCase();
        if (posFilter === 'OL') return ['OT', 'OG', 'C', 'OL', 'IOL', 'G', 'T'].includes(pos);
        if (posFilter === 'DL') return ['DT', 'DE', 'DL', 'NT', 'IDL'].includes(pos);
        if (posFilter === 'EDGE') return ['EDGE', 'OLB'].includes(pos);
        return pos === posFilter;
      });
    }
    if (search) {
      const q = search.toLowerCase();
      d = d.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.school.toLowerCase().includes(q) ||
          r.ktcTeam.toLowerCase().includes(q)
      );
    }
    d.sort((a, b) => {
      let aVal = a[sortField];
      let bVal = b[sortField];
      // Push zeros/999 to bottom
      if (sortField === 'rookieEcr') {
        if ((aVal as number) >= 999) aVal = sortDir === 'asc' ? Infinity : -Infinity;
        if ((bVal as number) >= 999) bVal = sortDir === 'asc' ? Infinity : -Infinity;
      }
      if (typeof aVal === 'string')
        return sortDir === 'asc'
          ? (aVal as string).localeCompare(bVal as string)
          : (bVal as string).localeCompare(aVal as string);
      return sortDir === 'asc'
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });
    return d.slice(0, 400);
  }, [rows, view, posFilter, search, sortField, sortDir]);

  const sortArrow = (field: SortField) =>
    field === sortField ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';

  if (loading)
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading 2026 prospect data...</div>
      </div>
    );
  if (error)
    return (
      <div className="empty-state">
        <h3>Failed to load prospect data</h3>
        <p>{error}</p>
      </div>
    );

  const rankedCount = rows.filter((r) => r.rookieEcr < 999).length;

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
          <label className="control-label">View</label>
          <select value={view} onChange={(e) => setView(e.target.value as 'all' | 'fantasy')}>
            <option value="fantasy">Fantasy Ranked ({rankedCount})</option>
            <option value="all">All Prospects ({rows.length})</option>
          </select>
        </div>
        <div className="position-filters">
          {(view === 'fantasy' ? POSITIONS.slice(0, 5) : POSITIONS).map((pos) => (
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
        {filtered.length} prospects &middot; Rookie rankings from FantasyPros &middot; Dynasty values from KTC &middot; Measurables from NFL Combine
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th style={{ width: 36 }}>#</th>
              <th onClick={() => handleSort('name')} style={{ cursor: 'pointer' }}>
                Player{sortArrow('name')}
              </th>
              <th>Pos</th>
              <th onClick={() => handleSort('school')} style={{ cursor: 'pointer' }}>
                School{sortArrow('school')}
              </th>
              <th onClick={() => handleSort('rookieEcr')} style={{ cursor: 'pointer' }}>
                Rookie ECR{sortArrow('rookieEcr')}
              </th>
              <th onClick={() => handleSort('dynastyValue')} style={{ cursor: 'pointer' }}>
                Dynasty Val{sortArrow('dynastyValue')}
              </th>
              <th onClick={() => handleSort('owned')} style={{ cursor: 'pointer' }}>
                Owned %{sortArrow('owned')}
              </th>
              <th onClick={() => handleSort('ht')} style={{ cursor: 'pointer' }}>
                Ht{sortArrow('ht')}
              </th>
              <th onClick={() => handleSort('wt')} style={{ cursor: 'pointer' }}>
                Wt{sortArrow('wt')}
              </th>
              <th onClick={() => handleSort('forty')} style={{ cursor: 'pointer' }}>
                40-Yd{sortArrow('forty')}
              </th>
              <th onClick={() => handleSort('bench')} style={{ cursor: 'pointer' }}>
                Bench{sortArrow('bench')}
              </th>
              <th onClick={() => handleSort('vertical')} style={{ cursor: 'pointer' }}>
                Vert{sortArrow('vertical')}
              </th>
              <th onClick={() => handleSort('broadJump')} style={{ cursor: 'pointer' }}>
                Broad{sortArrow('broadJump')}
              </th>
              <th onClick={() => handleSort('cone')} style={{ cursor: 'pointer' }}>
                3-Cone{sortArrow('cone')}
              </th>
              <th onClick={() => handleSort('shuttle')} style={{ cursor: 'pointer' }}>
                Shuttle{sortArrow('shuttle')}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={`${r.name}-${i}`}>
                <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{i + 1}</td>
                <td>
                  <strong>{r.name}</strong>
                </td>
                <td>
                  <span className={`pos-badge pos-${r.pos}`}>{r.pos}</span>
                </td>
                <td>{r.school || '-'}</td>
                <td>
                  {r.rookieEcr < 999 ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span
                        style={{
                          display: 'inline-block',
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: ecrTierColor(r.rookieEcr),
                        }}
                      />
                      <strong style={{ color: ecrTierColor(r.rookieEcr) }}>
                        {Number(r.rookieEcr).toFixed(1)}
                      </strong>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                        {ecrTierLabel(r.rookieEcr)}
                        {r.rookieBest > 0 && r.rookieWorst > 0 ? ` (${r.rookieBest}-${r.rookieWorst})` : ''}
                      </span>
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>-</span>
                  )}
                </td>
                <td>
                  {r.dynastyValue > 0 ? (
                    <span style={{ color: valueColor(r.dynastyValue), fontWeight: 600 }}>
                      {r.dynastyValue.toLocaleString()}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>-</span>
                  )}
                </td>
                <td>
                  {r.owned > 0 ? (
                    <span>{r.owned.toFixed(1)}%</span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>-</span>
                  )}
                </td>
                <td>{r.ht || '-'}</td>
                <td>{r.wt || '-'}</td>
                <td className={r.forty ? '' : 'text-muted'}>
                  {fmtMeasurable(r.forty)}
                </td>
                <td>{r.bench || '-'}</td>
                <td>{r.vertical ? fmtMeasurable(r.vertical) : '-'}</td>
                <td>{r.broadJump || '-'}</td>
                <td className={r.cone ? '' : 'text-muted'}>
                  {fmtMeasurable(r.cone)}
                </td>
                <td className={r.shuttle ? '' : 'text-muted'}>
                  {fmtMeasurable(r.shuttle)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
