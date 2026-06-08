import { useEffect, useMemo, useState } from 'react';
import { fetchSleeperUser, fetchUserLeagues, fetchLeagueRosteredIds, type SleeperLeagueSummary } from '../lib/sleeper';
import { fetchSleeperTrending } from '../data';
import type { SleeperTrendingRow } from '../types';
import { teamLogoUrl } from '../lib/teamLogo';

const LS_KEY = 'sleeper_waiver_user';

interface LeagueAvailability {
  league: SleeperLeagueSummary;
  rosteredIds: Set<string>;
}

interface ClayPlayer {
  name: string;
  team: string;
  position: string;
  player_key: string;
  pos_rk: number;
  ff_pt: number;
  games: number;
  sleeperId: string | null;
  pass_yds?: number;
  pass_td?: number;
  rush_yds?: number;
  rush_td?: number;
  rec?: number;
  rec_yds?: number;
  rec_td?: number;
}

interface CrosswalkRec {
  player_key: string;
  display_name: string;
  sleeper_id?: string;
  position?: string;
}

interface TrendingAvail extends SleeperTrendingRow {
  availableIn: string[];
}

interface WaiverPick extends ClayPlayer {
  availableIn: string[];
  pprPts: number;
}

function computePpr(p: ClayPlayer): number {
  const passYd = p.pass_yds ?? 0;
  const passTd = p.pass_td ?? 0;
  const rushYd = p.rush_yds ?? 0;
  const rushTd = p.rush_td ?? 0;
  const rec = p.rec ?? 0;
  const recYd = p.rec_yds ?? 0;
  const recTd = p.rec_td ?? 0;
  return passYd * 0.04 + passTd * 4 + rushYd * 0.1 + rushTd * 6 + recYd * 0.1 + recTd * 6 + rec;
}

async function loadClayProjections(): Promise<ClayPlayer[]> {
  const [projRes, cwRes] = await Promise.all([
    fetch(`${import.meta.env.BASE_URL}data/clay-projections-2026.json`),
    fetch(`${import.meta.env.BASE_URL}data/player-crosswalk.json`),
  ]);
  if (!projRes.ok) return [];
  const projData = (await projRes.json()) as { players?: Record<string, unknown>[] };
  const players = projData.players ?? [];

  const sleeperByKey = new Map<string, string>();
  if (cwRes.ok) {
    const cw = (await cwRes.json()) as { players?: CrosswalkRec[] };
    for (const rec of cw.players ?? []) {
      if (rec.sleeper_id && rec.player_key) {
        sleeperByKey.set(rec.player_key, rec.sleeper_id);
      }
    }
  }

  return players
    .filter((p) => ['QB', 'RB', 'WR', 'TE'].includes(String(p.position ?? '')))
    .map((p) => ({
      name: String(p.name ?? ''),
      team: String(p.team ?? ''),
      position: String(p.position ?? ''),
      player_key: String(p.player_key ?? ''),
      pos_rk: Number(p.pos_rk) || 0,
      ff_pt: Number(p.ff_pt) || 0,
      games: Number(p.games) || 0,
      sleeperId: sleeperByKey.get(String(p.player_key ?? '')) ?? null,
      pass_yds: Number(p.pass_yds) || 0,
      pass_td: Number(p.pass_td) || 0,
      rush_yds: Number(p.rush_yds) || 0,
      rush_td: Number(p.rush_td) || 0,
      rec: Number(p.rec) || 0,
      rec_yds: Number(p.rec_yds) || 0,
      rec_td: Number(p.rec_td) || 0,
    }));
}

export function SleeperWaiverWire() {
  const [username, setUsername] = useState(() => localStorage.getItem(LS_KEY) ?? '');
  const [leagues, setLeagues] = useState<LeagueAvailability[]>([]);
  const [trending, setTrending] = useState<SleeperTrendingRow[]>([]);
  const [clayPlayers, setClayPlayers] = useState<ClayPlayer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posFilter, setPosFilter] = useState<string>('ALL');

  useEffect(() => {
    loadClayProjections().then(setClayPlayers);
    fetchSleeperTrending('add', 24, 75).then(setTrending).catch(() => {});
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
    if (!leagues.length || !clayPlayers.length) return [];
    const out: WaiverPick[] = [];
    for (const p of clayPlayers) {
      if (!p.sleeperId) continue;
      const pprPts = computePpr(p);
      if (pprPts <= 0) continue;
      const availableIn = leagues
        .filter((la) => !la.rosteredIds.has(p.sleeperId!))
        .map((la) => la.league.name);
      if (availableIn.length > 0) out.push({ ...p, availableIn, pprPts });
    }
    out.sort((a, b) => b.pprPts - a.pprPts);
    return out;
  }, [leagues, clayPlayers]);

  const unmatchedCount = useMemo(() => clayPlayers.filter((p) => !p.sleeperId).length, [clayPlayers]);

  const filteredTrending = posFilter === 'ALL' ? trendingAvail : trendingAvail.filter((t) => t.position === posFilter);
  const filteredWaivers = posFilter === 'ALL' ? waiverPicks : waiverPicks.filter((w) => w.position === posFilter);

  return (
    <div className="sl-page">
      <div className="sched-header">
        <h2 style={{ margin: 0, fontSize: 18 }}>Waiver Wire</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 0' }}>
          Find top projected scorers and trending adds available on waivers across your leagues.
          Projections from Consensus (Clay 2026).
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

      {loading && <div className="loading"><div className="spinner" /><div className="loading-text">Fetching rosters from your leagues…</div></div>}
      {error && !loading && <div className="empty-state"><h3>Lookup failed</h3><p>{error}</p></div>}

      {!loading && leagues.length > 0 && (
        <>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '8px 0' }}>
            Scanning waivers across <b>{leagues.length}</b> leagues
            {clayPlayers.length > 0 && <> · <b>{clayPlayers.length}</b> projected players</>}
            {unmatchedCount > 0 && <> · <span style={{ color: '#f59e0b', fontSize: 10 }}>{unmatchedCount} without Sleeper ID</span></>}
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

          {/* Top projected scorers on waivers */}
          <div className="sched-section-title" style={{ marginTop: 12 }}>
            Top Projected Scorers on Waivers
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '2px 0 8px' }}>
            Highest Consensus projected PPR scorers (2026 full season) not rostered in at least one of your leagues.
          </p>
          {filteredWaivers.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>No projected players available on waivers.</p>
          ) : (
            <div className="table-container" style={{ maxHeight: 460 }}>
              <table className="sched-table" style={{ fontSize: 12 }}>
                <thead>
                  <tr><th>#</th><th>Player</th><th>Pos</th><th>Team</th><th title="Consensus PPR projection (full season)">PPR</th><th title="Consensus fantasy points (Clay)">Clay Pts</th><th title="Position rank">Pos Rk</th><th>Available In</th></tr>
                </thead>
                <tbody>
                  {filteredWaivers.slice(0, 60).map((w, i) => (
                    <tr key={w.player_key}>
                      <td className="rank-cell">{i + 1}</td>
                      <td><strong>{w.name}</strong></td>
                      <td><span className={`pos-badge pos-${w.position}`}>{w.position}</span></td>
                      <td>
                        {w.team && <img src={teamLogoUrl(w.team)} alt="" width={14} height={14} style={{ objectFit: 'contain', verticalAlign: 'middle' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
                        {' '}{w.team}
                      </td>
                      <td style={{ fontWeight: 600 }}>{w.pprPts.toFixed(1)}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{w.ff_pt}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{w.position}{w.pos_rk}</td>
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

          {/* Trending adds available on waivers */}
          <div className="sched-section-title" style={{ marginTop: 20 }}>
            Trending Adds — Available in Your Leagues
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '2px 0 8px' }}>
            Top Sleeper trending adds (last 24h) that are unrostered in at least one of your leagues.
          </p>
          {filteredTrending.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              {trending.length === 0
                ? 'Sleeper trending data is unavailable right now (common in the offseason).'
                : 'No trending players available on your waivers.'}
            </p>
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
        </>
      )}
    </div>
  );
}
