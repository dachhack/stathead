import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { fetchSleeperUser, fetchUserLeagues, fetchUserRostersAcrossLeagues, importLeague, isDynastyLeague, leagueFormatInfo, fetchUserHistory, fetchUserTradeActivity, recentSeasons, type SleeperUser, type SleeperLeagueSummary, type UserLeagueRoster, type LeagueImport, type LeagueTeam, type RosterPlayer, type LeagueSeasonRecord, type TradeActivity, type TradeRecord, type TradeSide } from '../lib/sleeper';
import { fetchSleeperPlayers, fetchKTCRankings } from '../data';
import type { SleeperPlayer, KTCPlayer } from '../types';
import { teamLogoUrl } from '../lib/teamLogo';
import { PlayerName } from './PlayerName';
import { LeagueFormatBadges } from './LeagueFormatBadges';
import { loadClayProjections, computeOptimalLineup, computePpr, type ClayPlayer } from '../lib/waiverUtils';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, LabelList, ResponsiveContainer } from 'recharts';
import { normalizeForMatch } from '../lib/nameMatch';

const LS_KEY = 'sleeper_snoop_user';

// Full-screen zoomed view of a clicked avatar. Click anywhere or press Escape
// to dismiss.
function ImageLightbox({ src, caption, onClose }: { src: string; caption?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.82)', zIndex: 1000,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 12, cursor: 'zoom-out',
      }}
    >
      <img
        src={src}
        alt={caption ?? ''}
        style={{ maxWidth: '80vw', maxHeight: '78vh', borderRadius: 12, boxShadow: '0 12px 48px rgba(0,0,0,0.6)' }}
        onError={(e) => { e.currentTarget.style.display = 'none'; }}
      />
      {caption && <div style={{ color: '#fff', fontSize: 14, fontWeight: 600 }}>{caption}</div>}
      <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11 }}>Click anywhere or press Esc to close</div>
    </div>
  );
}

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
        <PlayerName sleeperId={p.id} name={p.name} position={p.position} />
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
      .then((res) => {
        setData(res);
        // Default to the snooped user's team; fall back to the standings leader.
        const mine = snoopedUserId ? res.teams.find((t) => t.ownerId === snoopedUserId) : undefined;
        setSelected(mine?.rosterId ?? res.teams[0]?.rosterId ?? null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [leagueId, snoopedUserId]);

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

// PPR projection map (current-season talent signal) keyed by Sleeper id —
// shared by the by-year Objective chart and the Leagues-table Objective column.
function buildProjByPlayer(projections: ClayPlayer[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of projections) if (p.sleeperId) m.set(p.sleeperId, computePpr(p));
  return m;
}

// Historical window proxy: we have no historical dynasty values, so approximate
// each player's worth from their POSITION and current projected points (talent
// signal), and bucket young/prime/aging by their reconstructed AGE at that
// season (current age − years elapsed). Talent weights the value; age decides
// the bucket — which is exactly the contender↔rebuild axis.
const SNOOP_CURRENT_YEAR = new Date().getFullYear();
const POS_BASE: Record<string, number> = { QB: 7, RB: 6, WR: 7, TE: 5 };

// Per-position young/prime/aging age cutoffs (inclusive upper bounds): a player
// is "young" at age ≤ young, "prime" at young < age ≤ prime, "aging" above that.
// Aging curves differ sharply by position — RBs cliff earliest, QBs latest — so
// a single curve mislabels QB-heavy vs RB-heavy rosters on the win-now↔rebuild
// axis. Roughly: RB peak ~24-26 / decline 27+, WR ~25-28 / 29+, TE ~26-29 / 30+,
// QB ~27-32 / 33+.
const POS_AGE_BUCKETS: Record<string, { young: number; prime: number }> = {
  QB: { young: 26, prime: 32 },
  RB: { young: 23, prime: 26 },
  WR: { young: 24, prime: 28 },
  TE: { young: 25, prime: 29 },
};

function computeRosterWindowProxy(
  playerIds: string[],
  sleeperPlayers: Map<string, SleeperPlayer>,
  projByPlayer: Map<string, number>,
  season: string,
): WindowLabel | null {
  const yearsAgo = SNOOP_CURRENT_YEAR - Number(season);
  let totalValue = 0, youngValue = 0, primeValue = 0, agingValue = 0, matched = 0;
  for (const pid of playerIds) {
    const sp = sleeperPlayers.get(pid);
    if (!sp || !sp.position || !POS_BASE[sp.position] || !sp.age) continue;
    const ageThen = sp.age - yearsAgo;
    if (ageThen < 19 || ageThen > 44) continue; // implausible reconstruction
    const proj = projByPlayer.get(pid);
    // Talent multiplier: ~1.0 for a 150-PPR starter; 0.7 baseline when a player
    // has no current projection (e.g. since retired) so they still count by age.
    const talentMult = proj && proj > 0 ? Math.min(1.6, Math.max(0.3, proj / 150)) : 0.7;
    const value = POS_BASE[sp.position] * talentMult;
    const bucket = POS_AGE_BUCKETS[sp.position];
    matched++;
    totalValue += value;
    if (ageThen <= bucket.young) youngValue += value;
    else if (ageThen <= bucket.prime) primeValue += value;
    else agingValue += value;
  }
  if (matched < 3 || totalValue <= 0) return null;

  const youngPct = (youngValue / totalValue) * 100;
  const primePct = (primeValue / totalValue) * 100;
  const agingPct = (agingValue / totalValue) * 100;

  if (agingPct >= 40) return 'Win-Now';
  if (agingPct + primePct >= 65 && youngPct < 35) return 'Contender';
  if (youngPct >= 55) return 'Rebuild';
  if (youngPct >= 40) return 'Retooling';
  return 'Balanced';
}

// ── Career History (multi-season) ──────────────────────────────────────────

function finishColor(pct: number): string {
  // pct = finish percentile from the top (0 = champion-ish, 1 = last)
  if (pct <= 0.15) return '#22c55e';
  if (pct <= 0.4) return '#a3e635';
  if (pct <= 0.6) return 'var(--text-secondary)';
  if (pct <= 0.85) return '#f59e0b';
  return '#ef4444';
}

// Charts always span 2020 → current year so the x-axis is consistent.
const CHART_START_YEAR = 2020;
function chartSeasons(): string[] {
  const end = new Date().getFullYear();
  const out: string[] = [];
  for (let y = CHART_START_YEAR; y <= end; y++) out.push(String(y));
  return out;
}

// Reusable stacked bar chart of raw counts by season, with per-segment labels.
function StackedYearChart({ title, subtitle, data, series }: {
  title: string;
  subtitle?: string;
  data: Array<Record<string, string | number>>;
  series: { key: string; color: string }[];
}) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600 }}>{title}</div>
      {subtitle && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>{subtitle}</div>}
      <ResponsiveContainer width="100%" height={210}>
        <BarChart data={data} margin={{ top: 16, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="season" stroke="var(--text-muted)" fontSize={11} />
          <YAxis allowDecimals={false} stroke="var(--text-muted)" fontSize={11} width={28} />
          <Tooltip
            contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
            cursor={{ fill: 'rgba(255,255,255,0.04)' }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} stackId="a" fill={s.color} maxBarSize={54}>
              <LabelList
                dataKey={s.key}
                position="center"
                formatter={(v) => (Number(v) ? v : '')}
                style={{ fill: '#fff', fontSize: 10, fontWeight: 600 }}
              />
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Trade grading (hindsight, from the snooped user's side) ──
const PICK_GRADE_VALUE: Record<number, number> = { 1: 6000, 2: 3000, 3: 1500, 4: 700 };
const ORDINAL = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th'];

function sideValue(side: TradeSide, ktcByName: Map<string, number>, players: Map<string, SleeperPlayer>): number {
  let v = 0;
  for (const pid of side.players) {
    const sp = players.get(pid);
    if (sp) v += ktcByName.get(normalizeForMatch(sp.full_name)) ?? 0;
  }
  for (const pk of side.picks) v += PICK_GRADE_VALUE[pk.round] ?? 400;
  return v;
}

function tradeGrade(received: number, gave: number): { letter: string; color: string } {
  if (received <= 0 && gave <= 0) return { letter: '—', color: 'var(--text-muted)' };
  const margin = (received - gave) / Math.max(received, gave, 1);
  if (margin >= 0.35) return { letter: 'A', color: '#22c55e' };
  if (margin >= 0.12) return { letter: 'B', color: '#a3e635' };
  if (margin >= -0.12) return { letter: 'C', color: 'var(--text-secondary)' };
  if (margin >= -0.35) return { letter: 'D', color: '#f59e0b' };
  return { letter: 'F', color: '#ef4444' };
}

function SideAssets({ side, players }: { side: TradeSide; players: Map<string, SleeperPlayer> }) {
  const nodes: ReactNode[] = [];
  for (const pid of side.players) {
    const sp = players.get(pid);
    nodes.push(<PlayerName key={`p${pid}`} sleeperId={pid} name={sp?.full_name ?? `#${pid}`} position={sp?.position} />);
  }
  for (const pk of side.picks) nodes.push(<span key={`k${pk.season}-${pk.round}`}>{pk.season} {ORDINAL[pk.round] ?? `R${pk.round}`}</span>);
  if (side.faab > 0) nodes.push(<span key="faab">${side.faab} FAAB</span>);
  if (!nodes.length) return <span style={{ color: 'var(--text-muted)' }}>nothing</span>;
  return <>{nodes.map((n, i) => <span key={i}>{i > 0 ? ', ' : ''}{n}</span>)}</>;
}

function TradeList({ trades, players, ktcByName }: {
  trades: TradeRecord[];
  players: Map<string, SleeperPlayer>;
  ktcByName: Map<string, number>;
}) {
  const MAX = 80;
  const [leagueFilter, setLeagueFilter] = useState('all');

  const leagueOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of trades) if (!m.has(t.leagueId)) m.set(t.leagueId, t.leagueName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [trades]);

  const filtered = leagueFilter === 'all' ? trades : trades.filter((t) => t.leagueId === leagueFilter);
  const shown = filtered.slice(0, MAX);
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '8px 0 4px' }}>
        <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>League:</label>
        <select value={leagueFilter} onChange={(e) => setLeagueFilter(e.target.value)} style={{ fontSize: 11, padding: '2px 6px', fontFamily: 'inherit' }}>
          <option value="all">All leagues ({trades.length})</option>
          {leagueOptions.map(([id, name]) => (
            <option key={id} value={id}>{name} ({trades.filter((t) => t.leagueId === id).length})</option>
          ))}
        </select>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Grades are hindsight — current player/pick values from your side of each deal.
        </span>
      </div>
      <div className="table-container" style={{ maxHeight: 420 }}>
        <table className="sched-table" style={{ fontSize: 12 }}>
          <thead><tr><th>When</th><th>League</th><th>Got</th><th>Gave</th><th title="Hindsight grade from this manager's side">Grade</th></tr></thead>
          <tbody>
            {shown.map((t, i) => {
              const recv = sideValue(t.received, ktcByName, players);
              const gave = sideValue(t.gave, ktcByName, players);
              const g = tradeGrade(recv, gave);
              return (
                <tr key={`${t.leagueId}-${t.created}-${i}`}>
                  <td style={{ whiteSpace: 'nowrap' }}>{t.season} Wk{t.week}</td>
                  <td style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.leagueName}>{t.leagueName}</td>
                  <td style={{ color: '#22c55e' }}><SideAssets side={t.received} players={players} /></td>
                  <td style={{ color: 'var(--text-secondary)' }}><SideAssets side={t.gave} players={players} /></td>
                  <td
                    style={{ fontWeight: 800, color: g.color, textAlign: 'center' }}
                    title={recv > 0 || gave > 0 ? `Got ${(recv / 1000).toFixed(1)}k vs gave ${(gave / 1000).toFixed(1)}k (current value)` : 'Not enough current value data to grade'}
                  >{g.letter}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {filtered.length > MAX && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>Showing {MAX} of {filtered.length} trades.</div>
      )}
    </>
  );
}

interface YearSummary {
  season: string;
  leagues: number;
  dynasty: number;
  keeper: number;
  redraft: number;
  superflex: number;
  bestBall: number;
  idp: number;
  winPct: number | null;
  avgFinishPct: number | null; // 0 = best, 1 = worst
  champions: number;
}

function CareerHistorySection({ userId, players, ktc, projections }: { userId: string; players: Map<string, SleeperPlayer>; ktc: KTCPlayer[]; projections: ClayPlayer[] }) {
  const [history, setHistory] = useState<LeagueSeasonRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [trades, setTrades] = useState<TradeActivity | null>(null);
  const [tradeLoading, setTradeLoading] = useState(false);
  const [tradeProgress, setTradeProgress] = useState({ done: 0, total: 0 });
  const [chartsOpen, setChartsOpen] = useState(true);

  useEffect(() => {
    setLoading(true);
    setHistory([]);
    setTrades(null);
    fetchUserHistory(userId, recentSeasons())
      .then(setHistory)
      .catch(() => setHistory([]))
      .finally(() => setLoading(false));
  }, [userId]);

  // Records that actually played games — used for win% and finish.
  const played = useMemo(
    () => history.filter((r) => r.regSeasonRank > 0 && r.totalRosters > 1 && (r.wins + r.losses + r.ties) > 0),
    [history],
  );

  const career = useMemo(() => {
    if (!history.length) return null;
    const seasons = new Set(history.map((r) => r.season));
    const earliest = history.reduce((min, r) => (r.season < min ? r.season : min), history[0].season);
    let w = 0, l = 0, t = 0;
    for (const r of played) { w += r.wins; l += r.losses; t += r.ties; }
    const games = w + l + t;
    const completed = history.filter((r) => r.status === 'complete');
    const championships = history.filter((r) => r.champion).length;
    const runnerUps = history.filter((r) => r.runnerUp).length;
    const top3 = played.filter((r) => r.regSeasonRank <= 3).length;
    const finishPcts = played.map((r) => (r.regSeasonRank - 1) / (r.totalRosters - 1));
    const avgFinishPct = finishPcts.length ? finishPcts.reduce((a, b) => a + b, 0) / finishPcts.length : null;
    return {
      earliest,
      seasonsActive: seasons.size,
      totalLeagues: history.length,
      completedCount: completed.length,
      championships,
      runnerUps,
      top3,
      winPct: games ? (w + t * 0.5) / games : null,
      record: { w, l, t },
      avgFinishPct,
    };
  }, [history, played]);

  const byYear = useMemo(() => {
    const map = new Map<string, LeagueSeasonRecord[]>();
    for (const r of history) {
      if (!map.has(r.season)) map.set(r.season, []);
      map.get(r.season)!.push(r);
    }
    const out: YearSummary[] = [];
    for (const [season, recs] of map) {
      const playedRecs = recs.filter((r) => r.regSeasonRank > 0 && r.totalRosters > 1 && (r.wins + r.losses + r.ties) > 0);
      let w = 0, l = 0, t = 0;
      for (const r of playedRecs) { w += r.wins; l += r.losses; t += r.ties; }
      const games = w + l + t;
      const finishPcts = playedRecs.map((r) => (r.regSeasonRank - 1) / (r.totalRosters - 1));
      out.push({
        season,
        leagues: recs.length,
        dynasty: recs.filter((r) => r.format.type === 'Dynasty').length,
        keeper: recs.filter((r) => r.format.type === 'Keeper').length,
        redraft: recs.filter((r) => r.format.type === 'Redraft').length,
        superflex: recs.filter((r) => r.format.qb === 'Superflex').length,
        bestBall: recs.filter((r) => r.format.bestBall).length,
        idp: recs.filter((r) => r.format.idp).length,
        winPct: games ? (w + t * 0.5) / games : null,
        avgFinishPct: finishPcts.length ? finishPcts.reduce((a, b) => a + b, 0) / finishPcts.length : null,
        champions: recs.filter((r) => r.champion).length,
      });
    }
    out.sort((a, b) => b.season.localeCompare(a.season));
    return out;
  }, [history]);

  const leagueRows = useMemo(
    () => [...history].sort((a, b) =>
      b.season.localeCompare(a.season) ||
      (a.regSeasonRank || 99) - (b.regSeasonRank || 99)),
    [history],
  );

  const ktcByName = useMemo(() => {
    const m = new Map<string, number>();
    for (const k of ktc) m.set(normalizeForMatch(k.playerName), k.value);
    return m;
  }, [ktc]);

  // Current projected PPR points by sleeper id — the talent signal for the
  // historical window proxy.
  const projByPlayer = useMemo(() => buildProjByPlayer(projections), [projections]);

  // ── Stacked bar chart data (raw counts, fixed 2020 → current x-axis) ──
  const seasons = useMemo(() => chartSeasons(), []);

  const typeChartData = useMemo(() => seasons.map((season) => {
    const recs = history.filter((r) => r.season === season);
    return {
      season,
      Dynasty: recs.filter((r) => r.format.type === 'Dynasty').length,
      Keeper: recs.filter((r) => r.format.type === 'Keeper').length,
      Redraft: recs.filter((r) => r.format.type === 'Redraft').length,
    };
  }), [history, seasons]);

  const bestBallChartData = useMemo(() => seasons.map((season) => {
    const recs = history.filter((r) => r.season === season);
    return {
      season,
      'Best Ball': recs.filter((r) => r.format.bestBall).length,
      'Managed': recs.filter((r) => !r.format.bestBall).length,
    };
  }), [history, seasons]);

  const hasDynasty = useMemo(() => history.some((r) => r.format.type === 'Dynasty'), [history]);

  // Window classification uses the age+position+projection proxy (no historical
  // dynasty values exist), reconstructing each player's age at that season.
  const objectiveChartData = useMemo(() => {
    if (!hasDynasty || !players.size) return [];
    return seasons.map((season) => {
      const recs = history.filter((r) => r.season === season && r.format.type === 'Dynasty');
      const row: Record<string, string | number> = { season, 'Win-Now': 0, Contender: 0, Balanced: 0, Retooling: 0, Rebuild: 0 };
      for (const r of recs) {
        const w = computeRosterWindowProxy(r.players, players, projByPlayer, r.season);
        if (w) (row[w] as number)++;
      }
      return row;
    });
  }, [history, seasons, hasDynasty, players, projByPlayer]);

  const analyzeTrades = () => {
    setTradeLoading(true);
    setTradeProgress({ done: 0, total: 0 });
    fetchUserTradeActivity(history, (done, total) => setTradeProgress({ done, total }))
      .then(setTrades)
      .catch(() => setTrades(null))
      .finally(() => setTradeLoading(false));
  };

  if (loading && !history.length) {
    return (
      <div style={{ margin: '16px 0' }}>
        <div className="sched-section-title">Career History</div>
        <div className="loading" style={{ padding: '12px 0' }}><div className="spinner" /><span className="loading-text">Scanning past seasons…</span></div>
      </div>
    );
  }
  if (!career) {
    return (
      <div style={{ margin: '16px 0' }}>
        <div className="sched-section-title">Career History</div>
        <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>No past-season leagues found.</p>
      </div>
    );
  }

  const stat = (label: string, value: React.ReactNode, color?: string) => (
    <div><b style={{ color: color ?? 'var(--text-primary)' }}>{value}</b> <span style={{ color: 'var(--text-muted)' }}>{label}</span></div>
  );

  return (
    <div style={{ margin: '16px 0' }}>
      <div className="sched-section-title">Career History</div>
      <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '2px 0 8px' }}>
        Across the last {recentSeasons().length} NFL seasons (Sleeper exposes no signup date or all-time list).
      </p>

      {/* Career overview */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13, padding: 12, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8 }}>
        {stat(`on Sleeper since ${career.earliest} (${career.seasonsActive} seasons)`, '⏳')}
        {stat('leagues all-time', career.totalLeagues)}
        {career.winPct != null && stat('career win%', `${(career.winPct * 100).toFixed(1)}%`)}
        {stat('record', `${career.record.w}-${career.record.l}${career.record.t ? `-${career.record.t}` : ''}`)}
        {stat('🏆 titles', career.championships, '#fbbf24')}
        {career.runnerUps > 0 && stat('runner-up', career.runnerUps)}
        {stat('top-3 finishes', career.top3)}
        {career.avgFinishPct != null && stat('avg finish', `Top ${Math.round(career.avgFinishPct * 100)}%`, finishColor(career.avgFinishPct))}
      </div>

      {/* By year — collapsible stacked bar charts (raw counts, 2020 → current) */}
      <div
        className="sched-section-title"
        style={{ cursor: 'pointer', userSelect: 'none', marginTop: 12 }}
        onClick={() => setChartsOpen((o) => !o)}
      >
        <span style={{ display: 'inline-block', width: 16, fontSize: 10 }}>{chartsOpen ? '▼' : '▶'}</span>
        By Year
      </div>

      {chartsOpen && (
        <>
          <StackedYearChart
            title="Leagues by Type"
            data={typeChartData}
            series={[
              { key: 'Dynasty', color: '#22c55e' },
              { key: 'Keeper', color: '#f59e0b' },
              { key: 'Redraft', color: '#64748b' },
            ]}
          />

          {objectiveChartData.length > 0 && (
            <StackedYearChart
              title="Dynasty Team Objective by Year"
              subtitle="No historical values exist, so each roster's window is proxied from age-at-season (reconstructed, per-position aging curves) weighted by position + current projections."
              data={objectiveChartData}
              series={[
                { key: 'Win-Now', color: '#ef4444' },
                { key: 'Contender', color: '#f59e0b' },
                { key: 'Balanced', color: '#64748b' },
                { key: 'Retooling', color: '#a3e635' },
                { key: 'Rebuild', color: '#22c55e' },
              ]}
            />
          )}

          <StackedYearChart
            title="Best Ball vs Managed by Year"
            data={bestBallChartData}
            series={[
              { key: 'Best Ball', color: '#a78bfa' },
              { key: 'Managed', color: '#64748b' },
            ]}
          />
        </>
      )}

      <div style={{ fontSize: 11, fontWeight: 600, margin: '14px 0 4px', color: 'var(--text-secondary)' }}>Detail</div>
      <div className="table-container" style={{ maxHeight: 'none' }}>
        <table className="sched-table" style={{ fontSize: 12 }}>
          <thead><tr><th>Year</th><th>Leagues</th><th>Formats</th><th>Win%</th><th title="Average regular-season standing (top % of the league)">Avg Finish</th><th title="Championships won">🏆</th></tr></thead>
          <tbody>
            {byYear.map((y) => (
              <tr key={y.season}>
                <td><strong>{y.season}</strong></td>
                <td>{y.leagues}</td>
                <td style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  {[y.dynasty && `${y.dynasty} Dynasty`, y.keeper && `${y.keeper} Keeper`, y.redraft && `${y.redraft} Redraft`,
                    y.superflex && `${y.superflex} SF`, y.bestBall && `${y.bestBall} BB`, y.idp && `${y.idp} IDP`]
                    .filter(Boolean).join(' · ')}
                </td>
                <td>{y.winPct != null ? `${(y.winPct * 100).toFixed(0)}%` : '—'}</td>
                <td style={{ color: y.avgFinishPct != null ? finishColor(y.avgFinishPct) : 'var(--text-muted)' }}>
                  {y.avgFinishPct != null ? `Top ${Math.round(y.avgFinishPct * 100)}%` : '—'}
                </td>
                <td>{y.champions > 0 ? <span style={{ color: '#fbbf24' }}>{y.champions}</span> : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Trade activity */}
      <div style={{ fontSize: 12, fontWeight: 600, margin: '12px 0 4px' }}>Trade Activity</div>
      {!trades && !tradeLoading && (
        <button className="format-tab active" onClick={analyzeTrades} style={{ padding: '4px 12px', fontSize: 11 }}>
          Analyze trade activity
        </button>
      )}
      {!trades && !tradeLoading && (
        <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--text-muted)' }}>
          Sweeps weekly transaction logs — may take a few seconds.
        </span>
      )}
      {tradeLoading && (
        <div className="loading" style={{ padding: '8px 0' }}>
          <div className="spinner" />
          <span className="loading-text">
            Scanning transactions… {tradeProgress.total ? `${Math.round((tradeProgress.done / tradeProgress.total) * 100)}%` : ''}
          </span>
        </div>
      )}
      {trades && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13, marginTop: 4 }}>
          {stat('trades total', trades.totalTrades, '#a78bfa')}
          {stat('across leagues', trades.leaguesAnalyzed)}
          {career.seasonsActive > 0 && stat('trades / season', (trades.totalTrades / career.seasonsActive).toFixed(1))}
          <span style={{ fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center' }}>
            {Object.entries(trades.bySeason).sort((a, b) => b[0].localeCompare(a[0])).map(([s, n]) => `${s}: ${n}`).join(' · ')}
            {trades.capped && ' · (recent seasons only)'}
          </span>
        </div>
      )}
      {trades && trades.trades.length > 0 && (
        <TradeList trades={trades.trades} players={players} ktcByName={ktcByName} />
      )}

      {/* Per-league finishes */}
      <div style={{ fontSize: 12, fontWeight: 600, margin: '12px 0 4px' }}>League Finishes</div>
      <div className="table-container" style={{ maxHeight: 360 }}>
        <table className="sched-table" style={{ fontSize: 12 }}>
          <thead><tr><th>Year</th><th>League</th><th>Format</th><th>Record</th><th title="Regular-season standing">Finish</th><th>Result</th></tr></thead>
          <tbody>
            {leagueRows.map((r) => {
              const finishPct = r.regSeasonRank > 0 && r.totalRosters > 1 ? (r.regSeasonRank - 1) / (r.totalRosters - 1) : null;
              return (
                <tr key={`${r.season}-${r.leagueId}`}>
                  <td>{r.season}</td>
                  <td><strong>{r.leagueName}</strong></td>
                  <td><LeagueFormatBadges info={r.format} /></td>
                  <td>{r.wins}-{r.losses}{r.ties ? `-${r.ties}` : ''}</td>
                  <td style={{ color: finishPct != null ? finishColor(finishPct) : 'var(--text-muted)' }}>
                    {r.regSeasonRank > 0 ? `${r.regSeasonRank}/${r.totalRosters}` : '—'}
                  </td>
                  <td>
                    {r.champion ? <span style={{ color: '#fbbf24', fontWeight: 600 }}>🏆 Champion</span>
                      : r.runnerUp ? <span style={{ color: '#cbd5e1' }}>Runner-up</span>
                      : r.status !== 'complete' ? <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{r.status === 'in_season' ? 'In season' : r.status === 'pre_draft' ? 'Pre-draft' : r.status}</span>
                      : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
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
  const [zoom, setZoom] = useState<{ src: string; caption?: string } | null>(null);
  const [season, setSeason] = useState(String(new Date().getFullYear()));

  useEffect(() => {
    fetchSleeperPlayers().then(setPlayers);
    fetchKTCRankings('1qb').then(setKtc);
    loadClayProjections().then(setProjections);
  }, []);

  const snoop = (name: string, seasonArg: string = season) => {
    const trimmed = name.trim();
    if (!trimmed) { setError('Enter a Sleeper username.'); return; }
    setLoading(true);
    setError(null);
    setExpandedLeague(null);
    let user: SleeperUser;
    let leagues: SleeperLeagueSummary[];
    fetchSleeperUser(trimmed)
      .then((u) => { user = u; return fetchUserLeagues(u.user_id, seasonArg); })
      .then((lgs) => { leagues = lgs; return fetchUserRostersAcrossLeagues(user.user_id, lgs); })
      .then((rosters) => {
        setResult({ user, leagues, rosters });
        localStorage.setItem(LS_KEY, trimmed);
      })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setResult(null); })
      .finally(() => setLoading(false));
  };

  // Reload the snapshot (leagues + rosters) for a different season, reusing the
  // already-resolved user. Each Sleeper season has distinct league ids.
  const changeSeason = (s: string) => {
    setSeason(s);
    if (!result) return;
    const user = result.user;
    setLoading(true);
    setError(null);
    setExpandedLeague(null);
    fetchUserLeagues(user.user_id, s)
      .then((lgs) => fetchUserRostersAcrossLeagues(user.user_id, lgs).then((rosters) => setResult({ user, leagues: lgs, rosters })))
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); })
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

  // PPR talent signal feeding the historical window proxy below.
  const projByPlayer = useMemo(() => buildProjByPlayer(projections), [projections]);

  // Window labels (the rebuilding/contending framework) only apply to dynasty
  // leagues; redraft/keeper leagues are judged on projected score instead.
  // No historical dynasty values exist, so each roster's window is proxied from
  // age-at-season (reconstructed) weighted by position + current projections —
  // the same proxy the by-year Objective chart uses, so the table column and
  // chart always agree (and it stays accurate on past seasons, where current
  // KTC values/ages don't reflect the roster as it was then).
  const rosterWindows = useMemo(() => {
    if (!result || !players.size) return new Map<string, WindowLabel>();
    const map = new Map<string, WindowLabel>();
    for (const r of result.rosters) {
      if (!r.isDynasty) continue;
      const w = computeRosterWindowProxy(r.players, players, projByPlayer, season);
      if (w) map.set(r.leagueId, w);
    }
    return map;
  }, [result, players, projByPlayer, season]);

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
                  alt="" width={36} height={36}
                  title="Click to zoom"
                  style={{ borderRadius: '50%', cursor: 'zoom-in' }}
                  onClick={() => setZoom({ src: `https://sleepercdn.com/avatars/${result.user.avatar}`, caption: result.user.display_name })}
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

          {/* Career history across seasons */}
          <CareerHistorySection userId={result.user.user_id} players={players} ktc={ktc} projections={projections} />

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
                    <td><strong><PlayerName sleeperId={p.id} name={p.name} position={p.position} /></strong></td>
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
          <div className="sched-section-title" style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span>Leagues ({result.leagues.length})</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>
              <label className="control-label" style={{ fontSize: 11, color: 'var(--text-muted)' }}>Season</label>
              <select value={season} onChange={(e) => changeSeason(e.target.value)} disabled={loading} style={{ fontSize: 12, padding: '3px 8px', fontFamily: 'inherit' }}>
                {recentSeasons(10).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </span>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '2px 0 8px' }}>
            Click a league name to view standings, power rankings, and rosters.
          </p>
          <div className="table-container" style={{ maxHeight: 'none' }}>
            <table className="sched-table" style={{ fontSize: 12 }}>
              <thead><tr><th>League</th><th title="Win-Now ↔ Rebuild window. No historical dynasty values exist, so each roster is proxied from age-at-season (reconstructed, per-position aging curves) weighted by position + current projections — matching the by-year Objective chart.">Objective</th><th>Format</th><th>Teams</th><th>Record</th><th>PF</th><th>Status</th></tr></thead>
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

      {zoom && <ImageLightbox src={zoom.src} caption={zoom.caption} onClose={() => setZoom(null)} />}
    </div>
  );
}
