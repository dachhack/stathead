import { useEffect, useMemo, useState } from 'react';
import { importLeague, type LeagueImport, type LeagueTeam, type RosterPlayer } from '../lib/sleeper';
import { teamLogoUrl } from '../lib/teamLogo';

const LS_KEY = 'sleeper_league_id';

function PlayerLine({ p }: { p: RosterPlayer }) {
  return (
    <div className="sl-player">
      <span className="sl-slot">{p.slot}</span>
      {p.position && <span className={`pos-badge pos-${p.position}`}>{p.position}</span>}
      <span className="sl-name">{p.name}</span>
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

export function SleeperLeagueView() {
  const [leagueId, setLeagueId] = useState(() => localStorage.getItem(LS_KEY) ?? '');
  const [data, setData] = useState<LeagueImport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

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

  // Auto-import the saved league on first mount.
  useEffect(() => {
    if (leagueId) run(leagueId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const team: LeagueTeam | undefined = useMemo(
    () => data?.teams.find((t) => t.rosterId === selected),
    [data, selected],
  );

  return (
    <div className="sl-page">
      <div className="sched-header">
        <h2 style={{ margin: 0, fontSize: 18 }}>Sleeper League Import</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 0' }}>
          Enter a Sleeper league ID to pull its rosters, standings, and settings live from{' '}
          <a href="https://docs.sleeper.com/" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>Sleeper</a>.
          Find the ID in your league URL: <code>sleeper.com/leagues/<b>&lt;league_id&gt;</b>/…</code>
        </p>
      </div>

      <div className="controls" style={{ gap: 8 }}>
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

          {team && (
            <>
              <div className="sched-section-title" style={{ marginTop: 16 }}>
                Roster — {team.teamName} <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 11 }}>(click a team above to switch)</span>
              </div>
              <div className="sl-roster-grid">
                <div className="sl-roster-col">
                  <div className="sl-col-head">Starters</div>
                  {team.starters.map((p, i) => <PlayerLine key={`s${i}`} p={p} />)}
                </div>
                <div className="sl-roster-col">
                  <div className="sl-col-head">Bench</div>
                  {team.bench.length ? team.bench.map((p, i) => <PlayerLine key={`b${i}`} p={p} />)
                    : <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '6px 0' }}>No bench players.</div>}
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
