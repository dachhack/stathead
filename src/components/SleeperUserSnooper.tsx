import { useEffect, useMemo, useState } from 'react';
import { fetchSleeperUser, fetchUserLeagues, fetchUserRostersAcrossLeagues, importLeague, isDynastyLeague, leagueFormatInfo, type SleeperUser, type SleeperLeagueSummary, type UserLeagueRoster, type LeagueImport, type LeagueTeam, type RosterPlayer } from '../lib/sleeper';
import { fetchSleeperPlayers, fetchKTCRankings } from '../data';
import type { SleeperPlayer, KTCPlayer } from '../types';
import { teamLogoUrl } from '../lib/teamLogo';
import { PlayerLink } from './PlayerLink';
import { LeagueFormatBadges } from './LeagueFormatBadges';
import { loadClayProjections, computeOptimalLineup, type ClayPlayer } from '../lib/waiverUtils';

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

// ── Inline League Panel ──

function SnoopPlayerLine({ p }: { p: RosterPlayer }) {
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
          <img src={teamLogoUrl(p.team)} alt="" width={14} height={14} style={{ objectFit: 'contain', verticalAlign: 'middle' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} /> {p.team}
        </span>
      )}
    </div>
  );
}

type WindowLabel = 'Win-Now' | 'Contender' | 'Balanced' | 'Retooling' | 'Rebuild';

function normalizeForMatch(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '').replace(/^(jr|sr|ii|iii|iv)$/, '');
}

interface RosterScore {
  label: WindowLabel;
  totalValue: number;
  avgAge: number;
  youngPct: number;
  primePct: number;
  agingPct: number;
  matchedCount: number;
}

function scoreRosterSimple(team: LeagueTeam, ktc: KTCPlayer[]): RosterScore | null {
  const ktcByName = new Map<string, KTCPlayer>();
  for (const p of ktc) ktcByName.set(normalizeForMatch(p.playerName), p);
  const allPlayers = [...team.starters, ...team.bench].filter((p) => p.position && p.position !== 'DEF' && p.name !== 'Empty');
  let totalValue = 0, youngValue = 0, primeValue = 0, agingValue = 0, ageSum = 0, matchedCount = 0;
  for (const p of allPlayers) {
    const k = ktcByName.get(normalizeForMatch(p.name));
    if (!k || k.value <= 0) continue;
    matchedCount++;
    totalValue += k.value;
    ageSum += k.age;
    if (k.age <= 24) youngValue += k.value;
    else if (k.age <= 27) primeValue += k.value;
    else agingValue += k.value;
  }
  if (!matchedCount) return null;
  const avgAge = ageSum / matchedCount;
  const youngPct = totalValue ? (youngValue / totalValue) * 100 : 0;
  const primePct = totalValue ? (primeValue / totalValue) * 100 : 0;
  const agingPct = totalValue ? (agingValue / totalValue) * 100 : 0;
  let label: WindowLabel;
  if (agingPct >= 40) label = 'Win-Now';
  else if (agingPct + primePct >= 65 && youngPct < 35) label = 'Contender';
  else if (youngPct >= 55) label = 'Rebuild';
  else if (youngPct >= 40) label = 'Retooling';
  else label = 'Balanced';
  return { label, totalValue, avgAge, youngPct, primePct, agingPct, matchedCount };
}

function windowColor(label: WindowLabel): string {
  switch (label) {
    case 'Win-Now': return '#ef4444';
    case 'Contender': return '#f59e0b';
    case 'Balanced': return 'var(--text-muted)';
    case 'Retooling': return '#a3e635';
    case 'Rebuild': return '#22c55e';
  }
}

function SnoopLeaguePanel({ leagueId, ktc, projections, snoopedUserId, onSnoop }: { leagueId: string; ktc: KTCPlayer[]; projections: ClayPlayer[]; snoopedUserId?: string; onSnoop: (name: string) => void }) {
  const [data, setData] = useState<LeagueImport | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    importLeague(leagueId)
      .then((res) => { setData(res); setSelected(res.teams[0]?.rosterId ?? null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [leagueId]);

  const selectedTeam = useMemo(() => data?.teams.find((t) => t.rosterId === selected), [data, selected]);
  const isDynasty = isDynastyLeague(data?.league);

  // Projected season points per team's optimal lineup — the redraft strength metric.
  const projByTeam = useMemo(() => {
    const map = new Map<number, number>();
    if (!data || !projections.length) return map;
    const scoring = data.league.scoring_settings ?? {};
    const byId = new Map(projections.filter((p) => p.sleeperId).map((p) => [p.sleeperId!, p]));
    for (const t of data.teams) {
      const rosterPlayers = [...t.starters, ...t.bench]
        .filter((p) => p.name !== 'Empty')
        .map((p) => byId.get(p.id))
        .filter((p): p is ClayPlayer => !!p);
      if (!rosterPlayers.length) continue;
      const lineup = computeOptimalLineup(rosterPlayers, data.league.roster_positions, scoring);
      map.set(t.rosterId, lineup.totalStarterPts);
    }
    return map;
  }, [data, projections]);

  const powerRows = useMemo(() => {
    if (!data) return [];
    const out: { team: LeagueTeam; score: RosterScore | null; projPts: number }[] = [];
    for (const t of data.teams) {
      const score = ktc.length ? scoreRosterSimple(t, ktc) : null;
      const projPts = projByTeam.get(t.rosterId) ?? 0;
      if (isDynasty) {
        if (score) out.push({ team: t, score, projPts });
      } else {
        out.push({ team: t, score, projPts });
      }
    }
    if (isDynasty) out.sort((a, b) => (b.score?.totalValue ?? 0) - (a.score?.totalValue ?? 0));
    else out.sort((a, b) => b.projPts - a.projPts);
    return out;
  }, [data, ktc, isDynasty, projByTeam]);

  if (loading) return <div className="loading" style={{ padding: '12px 0' }}><div className="spinner" /><span className="loading-text">Loading league…</span></div>;
  if (error) return <p style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</p>;
  if (!data) return null;

  return (
    <div style={{ padding: '8px 0' }}>
      <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '0 0 8px' }}>
        {data.league.season} · {data.league.status} · {data.league.total_rosters} teams · {isDynasty ? 'Dynasty' : 'Redraft'}
      </p>

      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Standings</div>
      <div className="table-container" style={{ maxHeight: 'none' }}>
        <table className="sched-table" style={{ fontSize: 12 }}>
          <thead><tr><th>#</th><th>Team</th><th>Owner</th><th>W-L-T</th><th>PF</th><th>PA</th></tr></thead>
          <tbody>
            {data.teams.map((t, i) => {
              const isSnooped = snoopedUserId && t.ownerId === snoopedUserId;
              return (
                <tr
                  key={t.rosterId}
                  onClick={() => setSelected(t.rosterId)}
                  style={{ cursor: 'pointer', background: t.rosterId === selected ? 'var(--bg-tertiary)' : isSnooped ? 'rgba(99,102,241,0.08)' : undefined }}
                >
                  <td className="rank-cell">{i + 1}</td>
                  <td><strong>{t.teamName}</strong>{isSnooped && <span style={{ color: '#6366f1', fontSize: 9, marginLeft: 4 }}>★</span>}</td>
                  <td>
                    <button
                      style={{ background: 'none', border: 'none', color: '#6366f1', cursor: 'pointer', padding: 0, font: 'inherit', fontSize: 'inherit' }}
                      title={`Snoop ${t.owner}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (t.owner && t.owner !== '—') onSnoop(t.owner);
                      }}
                    >
                      {t.owner}
                    </button>
                  </td>
                  <td>{t.wins}-{t.losses}{t.ties ? `-${t.ties}` : ''}</td>
                  <td>{t.pointsFor.toFixed(1)}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{t.pointsAgainst.toFixed(1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {powerRows.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Power Rankings</div>
          <div className="table-container" style={{ maxHeight: 'none' }}>
            <table className="sched-table" style={{ fontSize: 12 }}>
              <thead><tr>
                <th>#</th><th>Team</th>
                {isDynasty
                  ? <><th>Window</th><th>Value</th><th>Avg Age</th><th style={{ width: 90 }}>Age Dist</th></>
                  : <th title="Projected PPR points (optimal lineup)">Proj Pts</th>}
              </tr></thead>
              <tbody>
                {powerRows.map(({ team: t, score: s, projPts }, i) => (
                  <tr key={t.rosterId}>
                    <td className="rank-cell">{i + 1}</td>
                    <td><strong>{t.teamName}</strong></td>
                    {isDynasty && s ? (
                      <>
                        <td style={{ color: windowColor(s.label), fontWeight: 600 }}>{s.label}</td>
                        <td>{s.totalValue.toLocaleString()}</td>
                        <td>{s.avgAge.toFixed(1)}</td>
                        <td>
                          <div style={{ display: 'flex', gap: 1, height: 10, borderRadius: 3, overflow: 'hidden', minWidth: 60 }}>
                            <div style={{ width: `${s.youngPct}%`, background: '#22c55e' }} />
                            <div style={{ width: `${s.primePct}%`, background: '#f59e0b' }} />
                            <div style={{ width: `${s.agingPct}%`, background: '#ef4444' }} />
                          </div>
                        </td>
                      </>
                    ) : (
                      <td style={{ fontWeight: 600 }}>{projPts > 0 ? projPts.toFixed(0) : '—'}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selectedTeam && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            Roster — {selectedTeam.teamName}
            <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 10, marginLeft: 6 }}>(click a team above)</span>
          </div>
          <div className="sl-roster-grid">
            <div className="sl-roster-col">
              <div className="sl-col-head">Starters</div>
              {selectedTeam.starters.map((p, i) => <SnoopPlayerLine key={`s${i}`} p={p} />)}
            </div>
            <div className="sl-roster-col">
              <div className="sl-col-head">Bench</div>
              {selectedTeam.bench.length ? selectedTeam.bench.map((p, i) => <SnoopPlayerLine key={`b${i}`} p={p} />)
                : <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '6px 0' }}>No bench players.</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function computeRosterWindow(
  playerIds: string[],
  sleeperPlayers: Map<string, SleeperPlayer>,
  ktc: KTCPlayer[],
): WindowLabel | null {
  const ktcByName = new Map<string, KTCPlayer>();
  for (const p of ktc) ktcByName.set(normalizeForMatch(p.playerName), p);

  let totalValue = 0, youngValue = 0, primeValue = 0, agingValue = 0, matched = 0;
  for (const pid of playerIds) {
    const sp = sleeperPlayers.get(pid);
    if (!sp || !sp.position || sp.position === 'DEF') continue;
    const k = ktcByName.get(normalizeForMatch(sp.full_name));
    if (!k || k.value <= 0) continue;
    matched++;
    totalValue += k.value;
    if (k.age <= 24) youngValue += k.value;
    else if (k.age <= 27) primeValue += k.value;
    else agingValue += k.value;
  }
  if (!matched) return null;

  const youngPct = (youngValue / totalValue) * 100;
  const primePct = (primeValue / totalValue) * 100;
  const agingPct = (agingValue / totalValue) * 100;

  if (agingPct >= 40) return 'Win-Now';
  if (agingPct + primePct >= 65 && youngPct < 35) return 'Contender';
  if (youngPct >= 55) return 'Rebuild';
  if (youngPct >= 40) return 'Retooling';
  return 'Balanced';
}

export function SleeperUserSnooper() {
  const [username, setUsername] = useState(() => localStorage.getItem(LS_KEY) ?? '');
  const [result, setResult] = useState<SnoopResult | null>(null);
  const [players, setPlayers] = useState<Map<string, SleeperPlayer>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ktc, setKtc] = useState<KTCPlayer[]>([]);
  const [projections, setProjections] = useState<ClayPlayer[]>([]);
  const [expandedLeague, setExpandedLeague] = useState<string | null>(null);

  useEffect(() => {
    fetchSleeperPlayers().then(setPlayers);
    fetchKTCRankings('1qb').then(setKtc);
    loadClayProjections().then(setProjections);
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

  // Window labels (the rebuilding/contending framework) only apply to dynasty
  // leagues; redraft/keeper leagues are judged on projected score instead.
  const rosterWindows = useMemo(() => {
    if (!result || !ktc.length || !players.size) return new Map<string, WindowLabel>();
    const map = new Map<string, WindowLabel>();
    for (const r of result.rosters) {
      if (!r.isDynasty) continue;
      const w = computeRosterWindow(r.players, players, ktc);
      if (w) map.set(r.leagueId, w);
    }
    return map;
  }, [result, ktc, players]);

  const windowBreakdown = useMemo(() => {
    const counts = new Map<WindowLabel, number>();
    for (const w of rosterWindows.values()) {
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    return counts;
  }, [rosterWindows]);

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
            {windowBreakdown.size > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Team Objectives Across Dynasty Leagues</div>
                <div style={{ display: 'flex', gap: 3, height: 14, borderRadius: 4, overflow: 'hidden', marginBottom: 4 }}>
                  {(['Win-Now', 'Contender', 'Balanced', 'Retooling', 'Rebuild'] as const).map((w) => {
                    const cnt = windowBreakdown.get(w) ?? 0;
                    if (!cnt) return null;
                    const pct = (cnt / rosterWindows.size) * 100;
                    return <div key={w} style={{ width: `${pct}%`, background: windowColor(w), minWidth: cnt > 0 ? 2 : 0 }} title={`${w}: ${cnt} (${pct.toFixed(0)}%)`} />;
                  })}
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11 }}>
                  {(['Win-Now', 'Contender', 'Balanced', 'Retooling', 'Rebuild'] as const).map((w) => {
                    const cnt = windowBreakdown.get(w) ?? 0;
                    if (!cnt) return null;
                    const pct = ((cnt / rosterWindows.size) * 100).toFixed(0);
                    return (
                      <span key={w} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        <span style={{ display: 'inline-block', width: 8, height: 8, background: windowColor(w), borderRadius: 2 }} />
                        <span style={{ color: windowColor(w), fontWeight: 600 }}>{w}</span>
                        <span style={{ color: 'var(--text-muted)' }}>{cnt} ({pct}%)</span>
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
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
          <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '2px 0 8px' }}>
            Click a league name to view standings, power rankings, and rosters.
          </p>
          <div className="table-container" style={{ maxHeight: 'none' }}>
            <table className="sched-table" style={{ fontSize: 12 }}>
              <thead><tr><th>League</th><th>Objective</th><th>Format</th><th>Teams</th><th>Record</th><th>PF</th><th>Status</th></tr></thead>
              <tbody>
                {result.rosters.sort((a, b) => b.pointsFor - a.pointsFor).map((r) => {
                  const lg = result.leagues.find((l) => l.league_id === r.leagueId);
                  const isExpanded = expandedLeague === r.leagueId;
                  return (
                    <tr key={r.leagueId} style={{ verticalAlign: 'top' }}>
                      <td>
                        <button
                          style={{ background: 'none', border: 'none', color: '#6366f1', cursor: 'pointer', padding: 0, font: 'inherit', fontWeight: 600, fontSize: 'inherit', textAlign: 'left' }}
                          onClick={() => setExpandedLeague(isExpanded ? null : r.leagueId)}
                        >
                          <span style={{ display: 'inline-block', width: 14, fontSize: 9 }}>{isExpanded ? '▼' : '▶'}</span>
                          {r.leagueName}
                        </button>
                        {isExpanded && (
                          <div style={{ marginTop: 8, padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                            <SnoopLeaguePanel leagueId={r.leagueId} ktc={ktc} projections={projections} snoopedUserId={result.user.user_id} onSnoop={(name) => { setUsername(name); snoop(name); setExpandedLeague(null); }} />
                          </div>
                        )}
                      </td>
                      <td>
                        {!r.isDynasty ? (
                          <span style={{ color: 'var(--text-muted)' }}>—</span>
                        ) : rosterWindows.get(r.leagueId) ? (
                          <span style={{ color: windowColor(rosterWindows.get(r.leagueId)!), fontWeight: 600, fontSize: 11 }}>
                            {rosterWindows.get(r.leagueId)}
                          </span>
                        ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>
                      <td>{lg ? <LeagueFormatBadges info={leagueFormatInfo(lg)} /> : leagueTypeLabel(r.rosterPositions)}</td>
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
