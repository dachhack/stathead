import { useEffect, useMemo, useState } from 'react';
import type { FantasyCalcPlayer } from '../types';
import { fetchFantasyCalcValues } from '../data';
import { teamLogoUrl } from '../lib/teamLogo';
import { PlayerName } from './PlayerName';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];

// FantasyCalc team codes → our (nflverse) codes.
const FC_TEAM_TO_OURS: Record<string, string> = { LAR: 'LA', WSH: 'WAS' };
const fixTeam = (t: string | null) => (t ? FC_TEAM_TO_OURS[t] ?? t : '');

function Trend({ v }: { v: number }) {
  if (!v) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  const up = v > 0;
  return <span className={up ? 'stat-positive' : 'stat-negative'}>{up ? '▲' : '▼'} {Math.abs(v)}</span>;
}

export function ConsensusAdpView() {
  const [rows, setRows] = useState<FantasyCalcPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [posFilter, setPosFilter] = useState('ALL');
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    // Redraft, 1QB, 12-team, full PPR — matches the committed daily snapshot
    // (public/data/fantasycalc_redraft_1qb.json, refreshed by
    // .github/workflows/fetch-fantasycalc-snapshot.yml).
    fetchFantasyCalcValues(false, 1, 12, 1)
      .then((data) => { if (!cancelled) { setRows(data); setLoading(false); } })
      .catch((e: unknown) => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const hasAdp = useMemo(() => rows.some((r) => r.maybeAdp != null), [rows]);

  const filtered = useMemo(() => {
    let data = rows;
    if (posFilter !== 'ALL') data = data.filter((r) => r.player.position === posFilter);
    if (search) {
      const q = search.toLowerCase();
      data = data.filter((r) => r.player.name.toLowerCase().includes(q) || (r.player.maybeTeam ?? '').toLowerCase().includes(q));
    }
    return data;
  }, [rows, posFilter, search]);

  return (
    <div className="sl-page">
      <div className="sched-header">
        <h2 style={{ margin: 0, fontSize: 18 }}>Consensus ADP</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 0' }}>
          Redraft consensus from{' '}
          <a href="https://fantasycalc.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>FantasyCalc</a>
          {' '}— aggregated from real fantasy leagues across <b>Sleeper</b>, MFL &amp; Fleaflicker. Refreshed daily.
          {!hasAdp && ' Numeric ADP fills in closer to draft season; until then the consensus value/rank is live.'}
        </p>
      </div>

      <div className="controls">
        <input type="text" placeholder="Search players…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="position-filters">
          {POSITIONS.map((pos) => (
            <button key={pos} className={`pos-filter ${posFilter === pos ? 'active' : ''}`} onClick={() => setPosFilter(pos)}>{pos}</button>
          ))}
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{filtered.length} players</span>
      </div>

      {loading && <div className="loading"><div className="spinner" /><div className="loading-text">Loading consensus…</div></div>}
      {error && !loading && <div className="empty-state"><h3>Couldn&apos;t load consensus ADP</h3><p>{error}</p></div>}

      {!loading && !error && (
        <div className="table-container" style={{ maxHeight: 'none' }}>
          <table className="sched-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th>Pos</th>
                <th>Team</th>
                {hasAdp && <th title="Average draft position (FantasyCalc)">ADP</th>}
                <th title="FantasyCalc consensus value">Value</th>
                <th title="Tier">Tier</th>
                <th title="30-day value trend">30d</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const team = fixTeam(r.player.maybeTeam);
                return (
                  <tr key={r.player.id}>
                    <td className="rank-cell">{r.overallRank}</td>
                    <td>
                      <strong><PlayerName sleeperId={r.player.sleeperId} name={r.player.name} position={r.player.position} /></strong>
                      
                    </td>
                    <td><span className={`pos-badge pos-${r.player.position}`}>{r.player.position}{r.positionRank}</span></td>
                    <td>
                      {team && <img src={teamLogoUrl(team)} alt="" width={16} height={16} style={{ objectFit: 'contain', verticalAlign: 'middle', marginRight: 4 }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
                      {team || '—'}
                    </td>
                    {hasAdp && <td>{r.maybeAdp != null ? r.maybeAdp.toFixed(1) : '—'}</td>}
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.value.toLocaleString()}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{r.maybeTier != null ? r.maybeTier : '—'}</td>
                    <td><Trend v={r.trend30Day} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
