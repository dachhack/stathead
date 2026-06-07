import { useEffect, useMemo, useState } from 'react';
import { fetchSleeperUser, fetchUserLeagues, fetchUserRostersAcrossLeagues, type SleeperUser, type SleeperLeagueSummary, type UserLeagueRoster } from '../lib/sleeper';
import { fetchSleeperPlayers } from '../data';
import type { SleeperPlayer } from '../types';
import { teamLogoUrl } from '../lib/teamLogo';

const LS_KEY = 'sleeper_snoop_user';

interface SnoopResult {
  user: SleeperUser;
  leagues: SleeperLeagueSummary[];
  rosters: UserLeagueRoster[];
}

interface PlayerOwnership {
  id: string;
  name: string;
  position: string;
  team: string;
  count: number;
  leagueNames: string[];
  starterCount: number;
}

function computeOwnership(rosters: UserLeagueRoster[], players: Map<string, SleeperPlayer>): PlayerOwnership[] {
  const map = new Map<string, PlayerOwnership>();
  for (const r of rosters) {
    const starterSet = new Set(r.starters);
    for (const pid of r.players) {
      if (!pid || pid === '0') continue;
      let entry = map.get(pid);
      if (!entry) {
        const p = players.get(pid);
        entry = {
          id: pid,
          name: p?.full_name ?? pid,
          position: p?.position ?? '?',
          team: p?.team ?? '',
          count: 0,
          leagueNames: [],
          starterCount: 0,
        };
        map.set(pid, entry);
      }
      entry.count++;
      entry.leagueNames.push(r.leagueName);
      if (starterSet.has(pid)) entry.starterCount++;
    }
  }
  const out = [...map.values()];
  out.sort((a, b) => b.count - a.count);
  return out;
}

function leagueTypeLabel(rosterPositions: string[]): string {
  const hasSF = rosterPositions.includes('SUPER_FLEX');
  const qbSlots = rosterPositions.filter((p) => p === 'QB').length;
  if (hasSF) return 'Superflex';
  if (qbSlots >= 2) return '2QB';
  return '1QB';
}

export function SleeperUserSnooper() {
  const [username, setUsername] = useState(() => localStorage.getItem(LS_KEY) ?? '');
  const [result, setResult] = useState<SnoopResult | null>(null);
  const [players, setPlayers] = useState<Map<string, SleeperPlayer>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSleeperPlayers().then(setPlayers);
  }, []);

  const snoop = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) { setError('Enter a Sleeper username.'); return; }
    setLoading(true);
    setError(null);
    let user: SleeperUser;
    let leagues: SleeperLeagueSummary[];
    fetchSleeperUser(trimmed)
      .then((u) => { user = u; return fetchUserLeagues(u.user_id); })
      .then((lgs) => { leagues = lgs; return fetchUserRostersAcrossLeagues(user.user_id, lgs); })
      .then((rosters) => {
        setResult({ user, leagues, rosters });
        localStorage.setItem(LS_KEY, trimmed);
      })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setResult(null); })
      .finally(() => setLoading(false));
  };

  // Auto-load saved username
  useEffect(() => {
    if (username) snoop(username);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ownership = useMemo(() => {
    if (!result || !players.size) return [];
    return computeOwnership(result.rosters, players);
  }, [result, players]);

  const leagueTypes = useMemo(() => {
    if (!result) return new Map<string, number>();
    const m = new Map<string, number>();
    for (const lg of result.leagues) {
      const t = leagueTypeLabel(lg.roster_positions);
      m.set(t, (m.get(t) ?? 0) + 1);
    }
    return m;
  }, [result]);

  const leagueSizes = useMemo(() => {
    if (!result) return new Map<number, number>();
    const m = new Map<number, number>();
    for (const lg of result.leagues) m.set(lg.total_rosters, (m.get(lg.total_rosters) ?? 0) + 1);
    return m;
  }, [result]);

  const record = useMemo(() => {
    if (!result) return { wins: 0, losses: 0, pf: 0 };
    let wins = 0, losses = 0, pf = 0;
    for (const r of result.rosters) { wins += r.wins; losses += r.losses; pf += r.pointsFor; }
    return { wins, losses, pf };
  }, [result]);

  const posBreakdown = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of ownership) {
      if (p.position === '?' || p.position === 'DEF') continue;
      m.set(p.position, (m.get(p.position) ?? 0) + p.count);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [ownership]);

  return (
    <div className="sl-page">
      <div className="sched-header">
        <h2 style={{ margin: 0, fontSize: 18 }}>Sleeper User Snooper</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 0' }}>
          Look up any Sleeper user to see their leagues, record, most-owned players, and roster tendencies.
        </p>
      </div>

      <div className="controls" style={{ gap: 8 }}>
        <input
          type="text"
          placeholder="Sleeper username, e.g. dachhack"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') snoop(username); }}
          style={{ minWidth: 220, flex: 1 }}
        />
        <button className="format-tab active" onClick={() => snoop(username)} disabled={loading}>
          {loading ? 'Snooping…' : 'Snoop'}
        </button>
      </div>

      {loading && <div className="loading"><div className="spinner" /><div className="loading-text">Fetching leagues &amp; rosters…</div></div>}
      {error && !loading && <div className="empty-state"><h3>Lookup failed</h3><p>{error}</p></div>}

      {!loading && result && (
        <>
          {/* User summary */}
          <div style={{ margin: '16px 0', padding: 12, background: 'var(--bg-secondary)', borderRadius: 8, border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {result.user.avatar && (
                <img
                  src={`https://sleepercdn.com/avatars/thumbs/${result.user.avatar}`}
                  alt="" width={36} height={36} style={{ borderRadius: '50%' }}
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              )}
              <div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{result.user.display_name}</div>
                <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>@{result.user.username}</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap', fontSize: 13 }}>
              <div><b>{result.leagues.length}</b> <span style={{ color: 'var(--text-muted)' }}>leagues</span></div>
              <div><b>{record.wins}-{record.losses}</b> <span style={{ color: 'var(--text-muted)' }}>combined record</span></div>
              <div><b>{record.pf.toFixed(1)}</b> <span style={{ color: 'var(--text-muted)' }}>total PF</span></div>
              {result.rosters.length > 0 && <div><b>{(record.pf / result.rosters.length).toFixed(1)}</b> <span style={{ color: 'var(--text-muted)' }}>avg PF/league</span></div>}
            </div>
            <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-muted)' }}>
              {[...leagueTypes.entries()].map(([type, cnt]) => (
                <span key={type}>{cnt} {type}</span>
              ))}
              {' · '}
              {[...leagueSizes.entries()].sort((a, b) => a[0] - b[0]).map(([size, cnt]) => (
                <span key={size}>{cnt}× {size}-team</span>
              ))}
            </div>
          </div>

          {/* Position breakdown */}
          {posBreakdown.length > 0 && (
            <div style={{ margin: '12px 0' }}>
              <div className="sched-section-title">Positional Roster Shares</div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12 }}>
                {posBreakdown.map(([pos, cnt]) => (
                  <div key={pos} style={{ textAlign: 'center' }}>
                    <span className={`pos-badge pos-${pos}`}>{pos}</span>
                    <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>{cnt} slots</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Most-owned players */}
          <div className="sched-section-title" style={{ marginTop: 16 }}>Most-Owned Players</div>
          <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '2px 0 8px' }}>
            Players rostered across multiple leagues. "Started" = in starter slot.
          </p>
          <div className="table-container" style={{ maxHeight: 400 }}>
            <table className="sched-table" style={{ fontSize: 12 }}>
              <thead>
                <tr><th>#</th><th>Player</th><th>Pos</th><th>Team</th><th>Owned</th><th>Started</th><th>% Owned</th><th>Leagues</th></tr>
              </thead>
              <tbody>
                {ownership.slice(0, 50).map((p, i) => (
                  <tr key={p.id}>
                    <td className="rank-cell">{i + 1}</td>
                    <td><strong>{p.name}</strong></td>
                    <td><span className={`pos-badge pos-${p.position}`}>{p.position}</span></td>
                    <td>
                      {p.team && <img src={teamLogoUrl(p.team)} alt="" width={14} height={14} style={{ objectFit: 'contain', verticalAlign: 'middle' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
                      {' '}{p.team}
                    </td>
                    <td><b>{p.count}</b> / {result.rosters.length}</td>
                    <td>{p.starterCount}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <div style={{ width: 40, height: 6, background: 'var(--bg-tertiary)', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ width: `${(p.count / result.rosters.length) * 100}%`, height: '100%', background: 'var(--accent)', borderRadius: 3 }} />
                        </div>
                        <span style={{ color: 'var(--text-muted)' }}>{((p.count / result.rosters.length) * 100).toFixed(0)}%</span>
                      </div>
                    </td>
                    <td style={{ fontSize: 10, color: 'var(--text-muted)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.leagueNames.join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Leagues list */}
          <div className="sched-section-title" style={{ marginTop: 16 }}>Leagues ({result.leagues.length})</div>
          <div className="table-container" style={{ maxHeight: 300 }}>
            <table className="sched-table" style={{ fontSize: 12 }}>
              <thead><tr><th>League</th><th>Type</th><th>Teams</th><th>Record</th><th>PF</th><th>Status</th></tr></thead>
              <tbody>
                {result.rosters.sort((a, b) => b.pointsFor - a.pointsFor).map((r) => {
                  const lg = result.leagues.find((l) => l.league_id === r.leagueId);
                  return (
                    <tr key={r.leagueId}>
                      <td><strong>{r.leagueName}</strong></td>
                      <td>{leagueTypeLabel(r.rosterPositions)}</td>
                      <td>{r.totalRosters}</td>
                      <td>{r.wins}-{r.losses}</td>
                      <td>{r.pointsFor.toFixed(1)}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{lg?.status ?? ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
