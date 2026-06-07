import { useEffect, useMemo, useState } from 'react';
import { importLeague, fetchSleeperUser, fetchUserLeagues, type LeagueImport, type LeagueTeam, type RosterPlayer, type SleeperLeagueSummary } from '../lib/sleeper';
import { fetchMatchups, fetchTeamProjections, matchupFor, type MatchupsByKey, type TeamProjByTeam } from '../lib/nflSchedule';
import { teamLogoUrl } from '../lib/teamLogo';
import { PlayerLink } from './PlayerLink';

const LS_KEY = 'sleeper_league_id';
const LS_USER_KEY = 'sleeper_username';

function PlayerLine({ p }: { p: RosterPlayer }) {
  return (
    <div className="sl-player">
      <span className="sl-slot">{p.slot}</span>
      {p.position && <span className={`pos-badge pos-${p.position}`}>{p.position}</span>}
      <span className="sl-name">
        {p.name}
        <PlayerLink sleeperId={p.id} name={p.name} position={p.position} />
      </span>
      {p.team && (
        <span className="sl-team">
          <img src={teamLogoUrl(p.team)} alt="" width={16} height={16} style={{ objectFit: 'contain', verticalAlign: 'middle' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} /> {p.team}
        </span>
      )}
    </div>
  );
}

function rosterFormat(positions: string[]): string {
  const counts = new Map<string, number>();
  for (const p of positions) counts.set(p, (counts.get(p) ?? 0) + 1);
  return [...counts.entries()].map(([p, n]) => `${n} ${p}`).join(' · ');
}

function rankColor(rank: number): string {
  if (!rank) return 'var(--text-muted)';
  if (rank <= 8) return '#ef4444';
  if (rank <= 16) return '#f59e0b';
  if (rank <= 24) return '#a3e635';
  return '#22c55e';
}

function winProbColor(wp: number): string {
  if (wp >= 70) return '#22c55e';
  if (wp >= 55) return '#a3e635';
  if (wp >= 45) return 'var(--text-muted)';
  if (wp >= 30) return '#f59e0b';
  return '#ef4444';
}

interface TeamOutlookProps {
  team: LeagueTeam;
  teamProj: TeamProjByTeam | null;
  matchups: MatchupsByKey;
}

function TeamOutlook({ team, teamProj, matchups }: TeamOutlookProps) {
  const nflTeams = useMemo(() => {
    const all = [...team.starters, ...team.bench].filter((p) => p.team && p.position !== 'DEF');
    const counts = new Map<string, number>();
    for (const p of all) if (p.team) counts.set(p.team, (counts.get(p.team) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [team]);

  if (!nflTeams.length || (!teamProj && !matchups.size)) return null;

  return (
    <div style={{ marginTop: 16 }}>
      <div className="sched-section-title">Team Projections &amp; Matchups</div>
      <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '2px 0 8px' }}>
        NFL team outlook for players on this roster. Win prob and projected scores from Consensus (Clay).
      </p>
      <div className="table-container" style={{ maxHeight: 'none' }}>
        <table className="sched-table" style={{ fontSize: 12 }}>
          <thead>
            <tr>
              <th>Team</th>
              <th>Players</th>
              <th>Proj W</th>
              <th>Off</th>
              <th>Def</th>
              <th>Ovr</th>
              <th colSpan={6} style={{ textAlign: 'center' }}>Upcoming Matchups (Wk 1–6)</th>
            </tr>
          </thead>
          <tbody>
            {nflTeams.map(([code, count]) => {
              const tp = teamProj?.[code];
              const upcoming: { week: number; opp: string; home: boolean; proj: ReturnType<typeof matchupFor> }[] = [];
              for (let w = 1; w <= 6; w++) {
                for (const [, m] of matchups) {
                  if (m.week === w && (m.home === code || m.away === code)) {
                    const isHome = m.home === code;
                    const opp = isHome ? m.away : m.home;
                    upcoming.push({ week: w, opp, home: isHome, proj: matchupFor(matchups, w, code, opp, isHome) });
                    break;
                  }
                }
              }
              return (
                <tr key={code}>
                  <td>
                    <img src={teamLogoUrl(code)} alt="" width={16} height={16} style={{ objectFit: 'contain', verticalAlign: 'middle' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                    {' '}<strong>{code}</strong>
                  </td>
                  <td>{count}</td>
                  <td>{tp ? <><b>{tp.proj_wins.toFixed(1)}</b> <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>#{tp.wins_rank}</span></> : '—'}</td>
                  <td>{tp ? <span style={{ color: rankColor(tp.off_rk) }}>#{tp.off_rk}</span> : '—'}</td>
                  <td>{tp ? <span style={{ color: rankColor(tp.def_rk) }}>#{tp.def_rk}</span> : '—'}</td>
                  <td>{tp ? <span style={{ color: rankColor(tp.ovr_rk) }}>#{tp.ovr_rk}</span> : '—'}</td>
                  {upcoming.map((u) => (
                    <td key={u.week} style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                      <span style={{ color: 'var(--text-muted)' }}>{u.home ? 'v' : '@'}</span>{u.opp}
                      {u.proj && <span style={{ color: winProbColor(u.proj.winProb), marginLeft: 2 }}>{u.proj.winProb}%</span>}
                    </td>
                  ))}
                  {Array.from({ length: Math.max(0, 6 - upcoming.length) }).map((_, i) => <td key={`e${i}`} />)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SleeperLeagueView() {
  const [leagueId, setLeagueId] = useState(() => localStorage.getItem(LS_KEY) ?? '');
  const [data, setData] = useState<LeagueImport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [matchups, setMatchups] = useState<MatchupsByKey>(new Map());
  const [teamProj, setTeamProj] = useState<TeamProjByTeam | null>(null);

  // Username → all leagues
  const [username, setUsername] = useState(() => localStorage.getItem(LS_USER_KEY) ?? '');
  const [userLeagues, setUserLeagues] = useState<SleeperLeagueSummary[]>([]);
  const [userLoading, setUserLoading] = useState(false);
  const [userError, setUserError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchMatchups(), fetchTeamProjections()]).then(([m, tp]) => {
      setMatchups(m); setTeamProj(tp);
    });
  }, []);

  const lookupUser = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) { setUserError('Enter a Sleeper username.'); return; }
    setUserLoading(true);
    setUserError(null);
    fetchSleeperUser(trimmed)
      .then((u) => fetchUserLeagues(u.user_id))
      .then((leagues) => {
        setUserLeagues(leagues);
        localStorage.setItem(LS_USER_KEY, trimmed);
      })
      .catch((e: unknown) => { setUserError(e instanceof Error ? e.message : String(e)); setUserLeagues([]); })
      .finally(() => setUserLoading(false));
  };

  const selectLeague = (id: string) => {
    setLeagueId(id);
    run(id);
  };

  const run = (id: string) => {
    const trimmed = id.trim();
    if (!trimmed) { setError('Enter a Sleeper league ID.'); return; }
    setLoading(true);
    setError(null);
    importLeague(trimmed)
      .then((res) => {
        setData(res);
        setSelected(res.teams[0]?.rosterId ?? null);
        localStorage.setItem(LS_KEY, trimmed);
      })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setData(null); })
      .finally(() => setLoading(false));
  };

  // Auto-load saved user's leagues on mount.
  useEffect(() => {
    if (username) lookupUser(username);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-import the saved league on first mount.
  useEffect(() => {
    if (leagueId) run(leagueId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedTeam: LeagueTeam | undefined = useMemo(
    () => data?.teams.find((t) => t.rosterId === selected),
    [data, selected],
  );

  return (
    <div className="sl-page">
      <div className="sched-header">
        <h2 style={{ margin: 0, fontSize: 18 }}>Sleeper Leagues</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 0' }}>
          Enter your Sleeper username to browse all your leagues, or paste a league ID directly.
        </p>
      </div>

      {/* Username lookup */}
      <div className="controls" style={{ gap: 8 }}>
        <input
          type="text"
          placeholder="Sleeper username, e.g. dachhack"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') lookupUser(username); }}
          style={{ minWidth: 200, flex: 1 }}
        />
        <button className="format-tab active" onClick={() => lookupUser(username)} disabled={userLoading}>
          {userLoading ? 'Looking up…' : 'Find Leagues'}
        </button>
      </div>

      {userError && !userLoading && <p style={{ color: 'var(--danger)', fontSize: 12, margin: '4px 0' }}>{userError}</p>}

      {userLeagues.length > 0 && (
        <div style={{ margin: '12px 0' }}>
          <div className="sched-section-title">My Leagues ({userLeagues.length})</div>
          <div className="table-container" style={{ maxHeight: 260 }}>
            <table className="sched-table" style={{ fontSize: 12 }}>
              <thead><tr><th>League</th><th>Season</th><th>Teams</th><th>Status</th><th /></tr></thead>
              <tbody>
                {userLeagues.map((l) => (
                  <tr key={l.league_id} style={{ cursor: 'pointer', background: l.league_id === leagueId ? 'var(--bg-tertiary)' : undefined }} onClick={() => selectLeague(l.league_id)}>
                    <td><strong>{l.name}</strong></td>
                    <td>{l.season}</td>
                    <td>{l.total_rosters}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{l.status}</td>
                    <td><button className="format-tab" style={{ padding: '2px 8px', fontSize: 11 }} onClick={(e) => { e.stopPropagation(); selectLeague(l.league_id); }}>Load</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Direct league ID input */}
      <details style={{ margin: '8px 0' }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)' }}>Or enter a league ID directly</summary>
        <div className="controls" style={{ gap: 8, marginTop: 6 }}>
          <input
            type="text"
            inputMode="numeric"
            placeholder="Sleeper league ID, e.g. 1182033380414181376"
            value={leagueId}
            onChange={(e) => setLeagueId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') run(leagueId); }}
            style={{ minWidth: 280, flex: 1 }}
          />
          <button className="format-tab active" onClick={() => run(leagueId)} disabled={loading}>
            {loading ? 'Importing…' : 'Import'}
          </button>
        </div>
      </details>

      {loading && <div className="loading"><div className="spinner" /><div className="loading-text">Importing league…</div></div>}
      {error && !loading && (
        <div className="empty-state">
          <h3>Couldn&apos;t import that league</h3>
          <p>{error}</p>
        </div>
      )}

      {!loading && data && (
        <>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 12px' }}>
            <b style={{ color: 'var(--text-primary)' }}>{data.league.name}</b> · {data.league.season} · {data.league.status} · {data.league.total_rosters} teams
            <br />Roster: {rosterFormat(data.league.roster_positions)}
          </p>

          <div className="sched-section-title">Standings</div>
          <div className="table-container" style={{ maxHeight: 'none' }}>
            <table className="sched-table">
              <thead><tr><th>#</th><th>Team</th><th>Owner</th><th>W-L-T</th><th>PF</th><th>PA</th></tr></thead>
              <tbody>
                {data.teams.map((t, i) => (
                  <tr
                    key={t.rosterId}
                    onClick={() => setSelected(t.rosterId)}
                    style={{ cursor: 'pointer', background: t.rosterId === selected ? 'var(--bg-tertiary)' : undefined }}
                  >
                    <td className="rank-cell">{i + 1}</td>
                    <td><strong>{t.teamName}</strong></td>
                    <td style={{ color: 'var(--text-muted)' }}>{t.owner}</td>
                    <td>{t.wins}-{t.losses}{t.ties ? `-${t.ties}` : ''}</td>
                    <td>{t.pointsFor.toFixed(1)}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{t.pointsAgainst.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selectedTeam && (
            <>
              <div className="sched-section-title" style={{ marginTop: 16 }}>
                Roster — {selectedTeam.teamName} <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 11 }}>(click a team above to switch)</span>
              </div>
              <div className="sl-roster-grid">
                <div className="sl-roster-col">
                  <div className="sl-col-head">Starters</div>
                  {selectedTeam.starters.map((p, i) => <PlayerLine key={`s${i}`} p={p} />)}
                </div>
                <div className="sl-roster-col">
                  <div className="sl-col-head">Bench</div>
                  {selectedTeam.bench.length ? selectedTeam.bench.map((p, i) => <PlayerLine key={`b${i}`} p={p} />)
                    : <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '6px 0' }}>No bench players.</div>}
                </div>
              </div>
              <TeamOutlook team={selectedTeam} teamProj={teamProj} matchups={matchups} />
            </>
          )}
        </>
      )}
    </div>
  );
}
