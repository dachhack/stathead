import { useState, useEffect, useMemo } from 'react';
import { fetchFfcADP, fetchKTCRankings } from '../data';
import type { FfcADPPlayer, KTCPlayer } from '../types';
import { PlayerLink } from './PlayerLink';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K'];

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

interface Row {
  name: string;
  position: string;
  team: string;
  adp: number;
  adpFormatted: string;
  high: number;
  low: number;
  stdev: number;
  timesDrafted: number;
  ktcValue: number;
  sfValue: number;
  isRookie: boolean;
}

type SortKey = 'adp' | 'name' | 'position' | 'team' | 'ktcValue' | 'sfValue';

export function ExternalRankings2026() {
  const [ffc, setFfc] = useState<FfcADPPlayer[]>([]);
  const [ktc, setKtc] = useState<KTCPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [posFilter, setPosFilter] = useState('ALL');
  const [rookiesOnly, setRookiesOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('adp');
  const [sortAsc, setSortAsc] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetchFfcADP(2026, 'ppr').catch(() => [] as FfcADPPlayer[]),
      fetchKTCRankings('1qb').catch(() => [] as KTCPlayer[]),
    ]).then(([ffcData, ktcData]) => {
      setFfc(ffcData);
      setKtc(ktcData);
      setLoading(false);
    }).catch((e) => {
      setError(e.message);
      setLoading(false);
    });
  }, []);

  // Build a name→KTC map for fast lookup
  const ktcByName = useMemo(() => {
    const m = new Map<string, KTCPlayer>();
    for (const p of ktc) m.set(normName(p.playerName), p);
    return m;
  }, [ktc]);

  const rows = useMemo((): Row[] => {
    return ffc.map((p) => {
      const ktcPlayer = ktcByName.get(normName(p.name));
      return {
        name: p.name,
        position: p.position,
        team: p.team,
        adp: p.adp,
        adpFormatted: String(p.adp.toFixed(1)),
        high: p.high,
        low: p.low,
        stdev: p.stdev,
        timesDrafted: p.timesDrafted,
        ktcValue: ktcPlayer?.value ?? 0,
        sfValue: ktcPlayer?.superflexValue ?? 0,
        isRookie: ktcPlayer?.isRookie ?? false,
      };
    });
  }, [ffc, ktcByName]);

  const filtered = useMemo(() => {
    let data = [...rows];
    if (posFilter !== 'ALL') data = data.filter((r) => r.position === posFilter);
    if (rookiesOnly) data = data.filter((r) => r.isRookie);
    if (search) {
      const q = search.toLowerCase();
      data = data.filter((r) =>
        r.name.toLowerCase().includes(q) ||
        r.team.toLowerCase().includes(q)
      );
    }
    data.sort((a, b) => {
      let av: string | number;
      let bv: string | number;
      if (sortKey === 'name' || sortKey === 'position' || sortKey === 'team') {
        av = a[sortKey]; bv = b[sortKey];
        return sortAsc ? (av as string).localeCompare(bv as string) : (bv as string).localeCompare(av as string);
      }
      av = a[sortKey] as number;
      bv = b[sortKey] as number;
      return sortAsc ? av - bv : bv - av;
    });
    return data;
  }, [rows, posFilter, rookiesOnly, search, sortKey, sortAsc]);

  const rookieCount = useMemo(() => rows.filter((r) => r.isRookie).length, [rows]);

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortAsc((a) => !a);
    else { setSortKey(key); setSortAsc(key === 'adp'); }
  }

  function sortArrow(key: SortKey) {
    if (key !== sortKey) return null;
    return <span className="sort-arrow">{sortAsc ? '▲' : '▼'}</span>;
  }

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading 2026 pre-season ADP + KTC values…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <h3>Failed to load 2026 rankings</h3>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <>
      <div className="controls">
        <div className="control-group">
          <input
            type="text"
            placeholder="Search players or teams…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
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
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <input
            type="checkbox"
            checked={rookiesOnly}
            onChange={(e) => setRookiesOnly(e.target.checked)}
          />
          Rookies only
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {rookieCount} identified via KTC
          </span>
        </label>
      </div>

      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
        2026 pre-season rankings — ADP from{' '}
        <a href="https://fantasyfootballcalculator.com" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
          Fantasy Football Calculator
        </a>{' '}
        · dynasty values from{' '}
        <a href="https://keeptradecut.com" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
          KeepTradeCut
        </a>.
        {' '}{filtered.length} of {rows.length} players shown.
      </p>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th style={{ width: 40 }}>#</th>
              <th onClick={() => handleSort('name')} className={sortKey === 'name' ? 'sorted' : ''} style={{ cursor: 'pointer' }}>
                Player{sortArrow('name')}
              </th>
              <th onClick={() => handleSort('position')} className={sortKey === 'position' ? 'sorted' : ''} style={{ cursor: 'pointer' }}>
                Pos{sortArrow('position')}
              </th>
              <th onClick={() => handleSort('team')} className={sortKey === 'team' ? 'sorted' : ''} style={{ cursor: 'pointer' }}>
                Team{sortArrow('team')}
              </th>
              <th onClick={() => handleSort('adp')} className={sortKey === 'adp' ? 'sorted' : ''} style={{ cursor: 'pointer', textAlign: 'right' }}>
                ADP{sortArrow('adp')}
              </th>
              <th style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 11 }}>High</th>
              <th style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 11 }}>Low</th>
              <th style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 11 }}>StDev</th>
              <th onClick={() => handleSort('ktcValue')} className={sortKey === 'ktcValue' ? 'sorted' : ''} style={{ cursor: 'pointer', textAlign: 'right' }}>
                KTC Value{sortArrow('ktcValue')}
              </th>
              <th onClick={() => handleSort('sfValue')} className={sortKey === 'sfValue' ? 'sorted' : ''} style={{ cursor: 'pointer', textAlign: 'right', color: 'var(--text-muted)' }}>
                SF Value{sortArrow('sfValue')}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={`${r.name}-${r.position}`}>
                <td className="rank-cell">{i + 1}</td>
                <td>
                  <strong>{r.name}</strong>
                  <PlayerLink name={r.name} position={r.position} />
                  {r.isRookie && (
                    <span style={{
                      marginLeft: 6, fontSize: 10, background: 'var(--accent)',
                      color: '#fff', padding: '1px 5px', borderRadius: 3,
                    }}>R</span>
                  )}
                </td>
                <td>
                  <span className={`pos-badge pos-${r.position}`}>{r.position}</span>
                </td>
                <td>{r.team}</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{r.adp.toFixed(1)}</td>
                <td style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 11 }}>{r.high}</td>
                <td style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 11 }}>{r.low}</td>
                <td style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 11 }}>{r.stdev.toFixed(1)}</td>
                <td style={{ textAlign: 'right', fontWeight: 600, color: r.ktcValue > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                  {r.ktcValue > 0 ? r.ktcValue.toLocaleString() : '—'}
                </td>
                <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>
                  {r.sfValue > 0 ? r.sfValue.toLocaleString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
