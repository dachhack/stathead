import { useState, useEffect, useMemo } from 'react';
import { fetchFfcADP, fetchKTCRankings, fetchDraftProfiles, fetchDraftProspects } from '../data';
import type { FfcADPPlayer, KTCPlayer, DraftProfile, DraftProspect } from '../types';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K'];

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

function gradeColor(grade: number): string {
  if (grade >= 90) return '#10b981'; // elite
  if (grade >= 80) return '#34d399'; // great
  if (grade >= 70) return '#60a5fa'; // good
  if (grade >= 60) return '#fbbf24'; // average
  return '#ef4444'; // below average
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
  // Draft prospect fields (rookies only)
  grade: number | null;
  ovrRk: number | null;
  posRk: number | null;
  projRound: number | null;
  projPick: number | null;
  projOverall: number | null;
}

type SortKey = 'adp' | 'name' | 'position' | 'team' | 'ktcValue' | 'sfValue' | 'grade' | 'ovrRk' | 'posRk' | 'projRound';

export function ExternalRankings2026() {
  const [ffc, setFfc] = useState<FfcADPPlayer[]>([]);
  const [ktc, setKtc] = useState<KTCPlayer[]>([]);
  const [profiles, setProfiles] = useState<DraftProfile[]>([]);
  const [prospects, setProspects] = useState<DraftProspect[]>([]);
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
      fetchDraftProfiles().catch(() => [] as DraftProfile[]),
      fetchDraftProspects().catch(() => [] as DraftProspect[]),
    ]).then(([ffcData, ktcData, profileData, prospectData]) => {
      setFfc(ffcData);
      setKtc(ktcData);
      setProfiles(profileData);
      setProspects(prospectData.filter((p) => p.draft_year === 2026));
      setLoading(false);
    }).catch((e) => {
      setError(e.message);
      setLoading(false);
    });
  }, []);

  // Build name→lookup maps for fast matching
  const ktcByName = useMemo(() => {
    const m = new Map<string, KTCPlayer>();
    for (const p of ktc) m.set(normName(p.playerName), p);
    return m;
  }, [ktc]);

  const profileByName = useMemo(() => {
    const m = new Map<string, DraftProfile>();
    for (const p of profiles) m.set(normName(p.player_name), p);
    return m;
  }, [profiles]);

  const prospectByName = useMemo(() => {
    const m = new Map<string, DraftProspect>();
    for (const p of prospects) m.set(normName(p.player_name), p);
    return m;
  }, [prospects]);

  const rows = useMemo((): Row[] => {
    return ffc.map((p) => {
      const nn = normName(p.name);
      const ktcPlayer = ktcByName.get(nn);
      const profile = profileByName.get(nn);
      const prospect = prospectByName.get(nn);
      const isRookie = ktcPlayer?.isRookie ?? false;
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
        isRookie,
        grade: isRookie ? (profile?.grade ?? prospect?.grade ?? null) : null,
        ovrRk: isRookie ? (profile?.ovr_rk ?? prospect?.ovr_rk ?? null) : null,
        posRk: isRookie ? (profile?.pos_rk ?? prospect?.pos_rk ?? null) : null,
        projRound: isRookie && prospect ? (prospect.round || null) : null,
        projPick: isRookie && prospect ? (prospect.pick || null) : null,
        projOverall: isRookie && prospect ? (prospect.overall || null) : null,
      };
    });
  }, [ffc, ktcByName, profileByName, prospectByName]);

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
      if (sortKey === 'name' || sortKey === 'position' || sortKey === 'team') {
        const av = a[sortKey]; const bv = b[sortKey];
        return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      // Numeric sort — treat null as Infinity so blanks sort last
      const av = (a[sortKey] as number | null) ?? Infinity;
      const bv = (b[sortKey] as number | null) ?? Infinity;
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
        </a>
        {' '}· rookie grades from ESPN via{' '}
        <a href="https://github.com/JackLich10/nfl-draft-data" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
          nfl-draft-data
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
              <th onClick={() => handleSort('grade')} className={sortKey === 'grade' ? 'sorted' : ''} style={{ cursor: 'pointer', textAlign: 'right' }}>
                Grade{sortArrow('grade')}
              </th>
              <th onClick={() => handleSort('ovrRk')} className={sortKey === 'ovrRk' ? 'sorted' : ''} style={{ cursor: 'pointer', textAlign: 'right' }}>
                Ovr Rk{sortArrow('ovrRk')}
              </th>
              <th onClick={() => handleSort('posRk')} className={sortKey === 'posRk' ? 'sorted' : ''} style={{ cursor: 'pointer', textAlign: 'right' }}>
                Pos Rk{sortArrow('posRk')}
              </th>
              <th onClick={() => handleSort('projRound')} className={sortKey === 'projRound' ? 'sorted' : ''} style={{ cursor: 'pointer', textAlign: 'right' }}>
                Rd/Pick{sortArrow('projRound')}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={`${r.name}-${r.position}`}>
                <td className="rank-cell">{i + 1}</td>
                <td>
                  <strong>{r.name}</strong>
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
                <td style={{ textAlign: 'right', fontWeight: r.grade ? 600 : 400, color: r.grade ? gradeColor(r.grade) : 'var(--text-muted)' }}>
                  {r.grade ?? '—'}
                </td>
                <td style={{ textAlign: 'right', color: r.ovrRk ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                  {r.ovrRk ?? '—'}
                </td>
                <td style={{ textAlign: 'right', color: r.posRk ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                  {r.posRk ?? '—'}
                </td>
                <td style={{ textAlign: 'right', color: r.projRound ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                  {r.projRound ? `${r.projRound}.${String(r.projPick ?? '').padStart(2, '0')}` : '—'}
                  {r.projOverall ? <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 3 }}>({r.projOverall})</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
