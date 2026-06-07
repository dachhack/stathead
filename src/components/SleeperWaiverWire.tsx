import { useEffect, useMemo, useState } from 'react';
import { fetchSleeperUser, fetchUserLeagues, fetchLeagueRosteredIds, type SleeperLeagueSummary } from '../lib/sleeper';
import { fetchSleeperTrending, fetchSleeperProjections } from '../data';
import type { SleeperTrendingRow, SleeperProjection } from '../types';
import { teamLogoUrl } from '../lib/teamLogo';

const LS_KEY = 'sleeper_waiver_user';

interface LeagueAvailability {
  league: SleeperLeagueSummary;
  rosteredIds: Set<string>;
}

interface TrendingAvail extends SleeperTrendingRow {
  availableIn: string[]; // league names where available
}

interface WaiverPick extends SleeperProjection {
  availableIn: string[];
}

export function SleeperWaiverWire() {
  const [username, setUsername] = useState(() => localStorage.getItem(LS_KEY) ?? '');
  const [leagues, setLeagues] = useState<LeagueAvailability[]>([]);
  const [trending, setTrending] = useState<SleeperTrendingRow[]>([]);
  const [projections, setProjections] = useState<SleeperProjection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posFilter, setPosFilter] = useState<string>('ALL');

  useEffect(() => {
    Promise.all([
      fetchSleeperTrending('add', 24, 75),
      fetchSleeperProjections(2026),
    ]).then(([t, p]) => {
      setTrending(t);
      setProjections(p);
    });
  }, []);

  const loadLeagues = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) { setError('Enter a Sleeper username.'); return; }
    setLoading(true);
    setError(null);
    fetchSleeperUser(trimmed)
      .then((u) => fetchUserLeagues(u.user_id).then((lgs) => ({ userId: u.user_id, lgs })))
      .then(async ({ lgs }) => {
        const avails = await Promise.all(
          lgs.map(async (lg) => {
            try {
              const rosteredIds = await fetchLeagueRosteredIds(lg.league_id);
              return { league: lg, rosteredIds };
            } catch { return null; }
          })
        );
        setLeagues(avails.filter((a): a is LeagueAvailability => a !== null));
        localStorage.setItem(LS_KEY, trimmed);
      })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setLeagues([]); })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (username) loadLeagues(username);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trendingAvail: TrendingAvail[] = useMemo(() => {
    if (!leagues.length || !trending.length) return [];
    return trending.map((t) => {
      const availableIn = leagues
        .filter((la) => !la.rosteredIds.has(t.player_id))
        .map((la) => la.league.name);
      return { ...t, availableIn };
    }).filter((t) => t.availableIn.length > 0);
  }, [leagues, trending]);

  const waiverPicks: WaiverPick[] = useMemo(() => {
    if (!leagues.length || !projections.length) return [];
    const out: WaiverPick[] = [];
    for (const p of projections) {
      if (p.pts_ppr <= 0) continue;
      const availableIn = leagues
        .filter((la) => !la.rosteredIds.has(p.player_id))
        .map((la) => la.league.name);
      if (availableIn.length > 0) out.push({ ...p, availableIn });
    }
    out.sort((a, b) => b.pts_ppr - a.pts_ppr);
    return out;
  }, [leagues, projections]);

  const filteredTrending = posFilter === 'ALL' ? trendingAvail : trendingAvail.filter((t) => t.position === posFilter);
  const filteredWaivers = posFilter === 'ALL' ? waiverPicks : waiverPicks.filter((w) => w.position === posFilter);

  return (
    <div className="sl-page">
      <div className="sched-header">
        <h2 style={{ margin: 0, fontSize: 18 }}>Waiver Wire</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 0' }}>
          See which trending players and top projected scorers are available on waivers across your leagues.
        </p>
      </div>

      <div className="controls" style={{ gap: 8 }}>
        <input
          type="text"
          placeholder="Sleeper username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') loadLeagues(username); }}
          style={{ minWidth: 200, flex: 1 }}
        />
        <button className="format-tab active" onClick={() => loadLeagues(username)} disabled={loading}>
          {loading ? 'Loading…' : 'Load Waivers'}
        </button>
      </div>

      {loading && <div className="loading"><div className="spinner" /><div className="loading-text">Fetching rosters from {leagues.length || '…'} leagues…</div></div>}
      {error && !loading && <div className="empty-state"><h3>Lookup failed</h3><p>{error}</p></div>}

      {!loading && leagues.length > 0 && (
        <>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '8px 0' }}>
            Scanning waivers across <b>{leagues.length}</b> leagues.
          </p>

          <div className="controls" style={{ gap: 6, margin: '8px 0' }}>
            {['ALL', 'QB', 'RB', 'WR', 'TE'].map((pos) => (
              <button
                key={pos}
                className={`format-tab ${posFilter === pos ? 'active' : ''}`}
                onClick={() => setPosFilter(pos)}
                style={{ padding: '3px 10px', fontSize: 11 }}
              >
                {pos}
              </button>
            ))}
          </div>

          {/* Trending adds available on waivers */}
          <div className="sched-section-title" style={{ marginTop: 12 }}>
            Trending Adds — Available in Your Leagues
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '2px 0 8px' }}>
            Top Sleeper trending adds (last 24h) that are unrostered in at least one of your leagues.
          </p>
          {filteredTrending.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>No trending players available on your waivers right now.</p>
          ) : (
            <div className="table-container" style={{ maxHeight: 320 }}>
              <table className="sched-table" style={{ fontSize: 12 }}>
                <thead>
                  <tr><th>#</th><th>Player</th><th>Pos</th><th>Team</th><th>Adds</th><th>Available In</th></tr>
                </thead>
                <tbody>
                  {filteredTrending.slice(0, 30).map((t, i) => (
                    <tr key={t.player_id}>
                      <td className="rank-cell">{i + 1}</td>
                      <td><strong>{t.full_name}</strong></td>
                      <td><span className={`pos-badge pos-${t.position}`}>{t.position}</span></td>
                      <td>
                        {t.team && t.team !== 'FA' && <img src={teamLogoUrl(t.team)} alt="" width={14} height={14} style={{ objectFit: 'contain', verticalAlign: 'middle' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
                        {' '}{t.team}
                      </td>
                      <td style={{ color: 'var(--accent)', fontWeight: 600 }}>+{t.count}</td>
                      <td style={{ fontSize: 10, color: 'var(--text-muted)', maxWidth: 200 }}>
                        <span title={t.availableIn.join(', ')}>
                          {t.availableIn.length === leagues.length
                            ? <span style={{ color: '#22c55e' }}>All leagues</span>
                            : `${t.availableIn.length}/${leagues.length} — ${t.availableIn.slice(0, 2).join(', ')}${t.availableIn.length > 2 ? '…' : ''}`}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Top projected scorers on waivers */}
          <div className="sched-section-title" style={{ marginTop: 20 }}>
            Top Projected Scorers on Waivers
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '2px 0 8px' }}>
            Highest projected PPR scorers (2026 season) not rostered in at least one of your leagues.
          </p>
          {filteredWaivers.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>No projected players available.</p>
          ) : (
            <div className="table-container" style={{ maxHeight: 400 }}>
              <table className="sched-table" style={{ fontSize: 12 }}>
                <thead>
                  <tr><th>#</th><th>Player</th><th>Pos</th><th>Team</th><th>PPR</th><th>Half</th><th>Std</th><th>Available In</th></tr>
                </thead>
                <tbody>
                  {filteredWaivers.slice(0, 50).map((w, i) => (
                    <tr key={w.player_id}>
                      <td className="rank-cell">{i + 1}</td>
                      <td><strong>{w.full_name}</strong></td>
                      <td><span className={`pos-badge pos-${w.position}`}>{w.position}</span></td>
                      <td>
                        {w.team && w.team !== 'FA' && <img src={teamLogoUrl(w.team)} alt="" width={14} height={14} style={{ objectFit: 'contain', verticalAlign: 'middle' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
                        {' '}{w.team}
                      </td>
                      <td style={{ fontWeight: 600 }}>{w.pts_ppr.toFixed(1)}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{w.pts_half_ppr.toFixed(1)}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{w.pts_std.toFixed(1)}</td>
                      <td style={{ fontSize: 10, color: 'var(--text-muted)', maxWidth: 200 }}>
                        <span title={w.availableIn.join(', ')}>
                          {w.availableIn.length === leagues.length
                            ? <span style={{ color: '#22c55e' }}>All leagues</span>
                            : `${w.availableIn.length}/${leagues.length} — ${w.availableIn.slice(0, 2).join(', ')}${w.availableIn.length > 2 ? '…' : ''}`}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
