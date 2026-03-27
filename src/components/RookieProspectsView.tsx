import { useState, useEffect, useMemo } from 'react';
import type { KTCPlayer, DraftPick, SortDirection } from '../types';
import { fetchKTCRankings, fetchDraftPicks } from '../data';

interface RookieRow {
  name: string;
  position: string;
  team: string;
  college: string;
  round: number;
  pick: number;
  age: number;
  dynastyValue: number;
  superflexValue: number;
  positionRank: number;
  ktcSlug: string;
  // Draft pick stats (rookie season)
  games: number;
  passYards: number;
  passTds: number;
  rushYards: number;
  rushTds: number;
  receptions: number;
  recYards: number;
  recTds: number;
}

type SortField = keyof RookieRow;

const FANTASY_POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];

function valueColor(value: number): string {
  if (value >= 7000) return '#22c55e';
  if (value >= 5000) return '#4ade80';
  if (value >= 3000) return '#a3e635';
  if (value >= 1500) return '#facc15';
  if (value >= 500) return '#fb923c';
  return '#ef4444';
}

function valueTier(value: number): string {
  if (value >= 7000) return 'Elite';
  if (value >= 5000) return 'Blue Chip';
  if (value >= 3000) return 'Starter';
  if (value >= 1500) return 'Upside';
  if (value >= 500) return 'Dart Throw';
  return 'Deep Stash';
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/iii$|ii$|iv$|jr$|sr$/, '');
}

export function RookieProspectsView({ onDataLoaded }: { onDataLoaded?: (data: unknown[]) => void }) {
  const [rows, setRows] = useState<RookieRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [posFilter, setPosFilter] = useState('ALL');
  const [sortField, setSortField] = useState<SortField>('dynastyValue');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');
  const [format, setFormat] = useState<'1qb' | 'superflex'>('1qb');

  useEffect(() => {
    Promise.all([
      fetchKTCRankings(format),
      fetchDraftPicks(),
    ])
      .then(([ktcPlayers, draftPicks]) => {
        // Get rookies from KTC
        const rookies = ktcPlayers.filter((p: KTCPlayer) => p.isRookie);

        // Build draft pick lookup by normalized name for the most recent draft year
        const maxDraftYear = Math.max(...draftPicks.map((d: DraftPick) => d.season));
        const recentPicks = draftPicks.filter((d: DraftPick) => d.season === maxDraftYear);
        const draftMap = new Map<string, DraftPick>();
        for (const dp of recentPicks) {
          draftMap.set(normalizeName(dp.pfr_player_name), dp);
        }

        const merged: RookieRow[] = rookies.map((ktc: KTCPlayer) => {
          const draft = draftMap.get(normalizeName(ktc.playerName));
          return {
            name: ktc.playerName,
            position: ktc.position,
            team: ktc.team || draft?.team || '',
            college: draft?.college || '',
            round: draft?.round || 0,
            pick: draft?.pick || 0,
            age: ktc.age || draft?.age || 0,
            dynastyValue: format === '1qb' ? ktc.value : ktc.superflexValue,
            superflexValue: ktc.superflexValue,
            positionRank: ktc.positionRank,
            ktcSlug: ktc.slug,
            games: draft?.games || 0,
            passYards: draft?.pass_yards || 0,
            passTds: draft?.pass_tds || 0,
            rushYards: draft?.rush_yards || 0,
            rushTds: draft?.rush_tds || 0,
            receptions: draft?.receptions || 0,
            recYards: Number((draft as Record<string, unknown>)?.rec_yards) || 0,
            recTds: Number((draft as Record<string, unknown>)?.rec_tds) || 0,
          };
        });

        setRows(merged);
        onDataLoaded?.(merged);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [format, onDataLoaded]);

  const handleSort = (field: SortField) => {
    if (field === sortField) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortField(field);
      setSortDir(field === 'name' || field === 'team' || field === 'college' ? 'asc' : 'desc');
    }
  };

  const filtered = useMemo(() => {
    let d = [...rows];
    if (posFilter !== 'ALL') d = d.filter((r) => r.position === posFilter);
    if (search) {
      const q = search.toLowerCase();
      d = d.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.team.toLowerCase().includes(q) ||
          r.college.toLowerCase().includes(q)
      );
    }
    d.sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      if (typeof aVal === 'string')
        return sortDir === 'asc'
          ? aVal.localeCompare(bVal as string)
          : (bVal as string).localeCompare(aVal);
      return sortDir === 'asc'
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });
    return d;
  }, [rows, posFilter, search, sortField, sortDir]);

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
          placeholder="Search players, teams, or colleges..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="control-group">
          <label className="control-label">Format</label>
          <select value={format} onChange={(e) => setFormat(e.target.value as '1qb' | 'superflex')}>
            <option value="1qb">1QB</option>
            <option value="superflex">Superflex</option>
          </select>
        </div>
        <div className="position-filters">
          {FANTASY_POSITIONS.map((pos) => (
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
        {filtered.length} rookies &middot; Dynasty values from KeepTradeCut &middot; Draft data from NFLverse
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th style={{ width: 40 }}>#</th>
              <th onClick={() => handleSort('name')} style={{ cursor: 'pointer' }}>
                Player{sortArrow('name')}
              </th>
              <th>Pos</th>
              <th onClick={() => handleSort('team')} style={{ cursor: 'pointer' }}>
                Team{sortArrow('team')}
              </th>
              <th onClick={() => handleSort('college')} style={{ cursor: 'pointer' }}>
                College{sortArrow('college')}
              </th>
              <th onClick={() => handleSort('round')} style={{ cursor: 'pointer' }}>
                Draft{sortArrow('round')}
              </th>
              <th onClick={() => handleSort('dynastyValue')} style={{ cursor: 'pointer' }}>
                Dynasty Value{sortArrow('dynastyValue')}
              </th>
              <th onClick={() => handleSort('positionRank')} style={{ cursor: 'pointer' }}>
                Pos Rk{sortArrow('positionRank')}
              </th>
              <th onClick={() => handleSort('age')} style={{ cursor: 'pointer' }}>
                Age{sortArrow('age')}
              </th>
              <th onClick={() => handleSort('games')} style={{ cursor: 'pointer' }}>
                GP{sortArrow('games')}
              </th>
              <th>Rookie Season Stats</th>
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
                  <span className={`pos-badge pos-${r.position}`}>{r.position}</span>
                </td>
                <td>{r.team || '-'}</td>
                <td>{r.college || '-'}</td>
                <td>
                  {r.round ? (
                    <span
                      style={{
                        fontWeight: r.round <= 2 ? 700 : 400,
                        color: r.round === 1 ? '#22c55e' : r.round === 2 ? '#a3e635' : 'inherit',
                      }}
                    >
                      Rd {r.round}{r.pick ? `, #${r.pick}` : ''}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>-</span>
                  )}
                </td>
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span
                      style={{
                        display: 'inline-block',
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: valueColor(r.dynastyValue),
                      }}
                    />
                    <strong style={{ color: valueColor(r.dynastyValue) }}>
                      {r.dynastyValue.toLocaleString()}
                    </strong>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      {valueTier(r.dynastyValue)}
                    </span>
                  </span>
                </td>
                <td>{r.positionRank || '-'}</td>
                <td>{r.age || '-'}</td>
                <td>{r.games || '-'}</td>
                <td style={{ fontSize: 12 }}>
                  {r.position === 'QB' && r.passYards > 0
                    ? `${r.passYards} yds, ${r.passTds} TD, ${r.rushYards} rush`
                    : (r.rushYards > 0 || r.recYards > 0)
                    ? `${r.rushYards ? `${r.rushYards} rush` : ''}${r.rushYards && r.recYards ? ', ' : ''}${r.recYards ? `${r.receptions} rec/${r.recYards} yds` : ''}${r.rushTds + r.recTds > 0 ? `, ${r.rushTds + r.recTds} TD` : ''}`
                    : <span style={{ color: 'var(--text-muted)' }}>-</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
