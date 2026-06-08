import { useEffect, useMemo, useState } from 'react';
import { importLeague, fetchSleeperUser, fetchUserLeagues, fetchLeagueRosteredIds, fetchTradedPicks, isDynastyLeague, type LeagueImport, type LeagueTeam, type RosterPlayer, type SleeperLeagueSummary } from '../lib/sleeper';
import { fetchMatchups, fetchTeamProjections, matchupFor, type MatchupsByKey, type TeamProjByTeam } from '../lib/nflSchedule';
import { fetchKTCRankings, fetchSleeperTrending } from '../data';
import type { KTCPlayer, Tab, SleeperTrendingRow } from '../types';
import { teamLogoUrl } from '../lib/teamLogo';
import { PlayerLink } from './PlayerLink';
import { loadClayProjections, computePpr, computeCustomScore, computeOptimalLineup, type ClayPlayer, type OptimalLineup } from '../lib/waiverUtils';
import { generateTradeSuggestions, buildPickOwnership, evaluateTrade, type TradeGoal, type TradeSuggestion, type TradeAsset, type TradeScoreBreakdown, type TradeAssetStats } from '../lib/tradeEngine';

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
  const [expanded, setExpanded] = useState(false);
  const nflTeams = useMemo(() => {
    const all = [...team.starters, ...team.bench].filter((p) => p.team && p.position !== 'DEF');
    const counts = new Map<string, number>();
    for (const p of all) if (p.team) counts.set(p.team, (counts.get(p.team) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [team]);

  if (!nflTeams.length || (!teamProj && !matchups.size)) return null;

  return (
    <div style={{ marginTop: 16 }}>
      <div
        className="sched-section-title"
        style={{ cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{ display: 'inline-block', width: 16, fontSize: 10 }}>{expanded ? '▼' : '▶'}</span>
        Team Projections &amp; Matchups
      </div>
      {!expanded && (
        <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '2px 0 0', cursor: 'pointer' }} onClick={() => setExpanded(true)}>
          Click to expand NFL team outlook and matchups.
        </p>
      )}
      {expanded && <>
      <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '2px 0 8px' }}>
        NFL team outlook for players on this roster. Win prob and projected scores from Consensus projections.
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
      </>}
    </div>
  );
}

// ── Win-Now / Rebuild scoring ──

type WindowLabel = 'Win-Now' | 'Contender' | 'Balanced' | 'Retooling' | 'Rebuild';

interface RosterScore {
  label: WindowLabel;
  totalValue: number;
  avgAge: number;
  youngPct: number; // % value in players ≤24
  primePct: number; // % value in players 25-27
  agingPct: number; // % value in players 28+
  matchedCount: number;
  topAssets: { name: string; value: number; age: number }[];
}

function normalizeForMatch(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '').replace(/^(jr|sr|ii|iii|iv)$/, '');
}

function scoreRoster(team: LeagueTeam, ktc: KTCPlayer[]): RosterScore | null {
  const ktcByName = new Map<string, KTCPlayer>();
  for (const p of ktc) ktcByName.set(normalizeForMatch(p.playerName), p);

  const allPlayers = [...team.starters, ...team.bench].filter((p) => p.position && p.position !== 'DEF' && p.name !== 'Empty');
  let totalValue = 0;
  let youngValue = 0;
  let primeValue = 0;
  let agingValue = 0;
  let ageSum = 0;
  let matchedCount = 0;
  const assets: { name: string; value: number; age: number }[] = [];

  for (const p of allPlayers) {
    const k = ktcByName.get(normalizeForMatch(p.name));
    if (!k || k.value <= 0) continue;
    matchedCount++;
    totalValue += k.value;
    ageSum += k.age;
    assets.push({ name: p.name, value: k.value, age: k.age });
    if (k.age <= 24) youngValue += k.value;
    else if (k.age <= 27) primeValue += k.value;
    else agingValue += k.value;
  }

  if (!matchedCount) return null;

  const avgAge = ageSum / matchedCount;
  const youngPct = totalValue ? (youngValue / totalValue) * 100 : 0;
  const primePct = totalValue ? (primeValue / totalValue) * 100 : 0;
  const agingPct = totalValue ? (agingValue / totalValue) * 100 : 0;

  // Heuristic: win-now has high aging+prime %, rebuild has high young %
  let label: WindowLabel;
  if (agingPct >= 40) label = 'Win-Now';
  else if (agingPct + primePct >= 65 && youngPct < 35) label = 'Contender';
  else if (youngPct >= 55) label = 'Rebuild';
  else if (youngPct >= 40) label = 'Retooling';
  else label = 'Balanced';

  assets.sort((a, b) => b.value - a.value);
  return { label, totalValue, avgAge, youngPct, primePct, agingPct, matchedCount, topAssets: assets.slice(0, 5) };
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

interface WindowBadgeProps { score: RosterScore }

function WindowBadge({ score }: WindowBadgeProps) {
  return (
    <div style={{ margin: '12px 0', padding: 12, background: 'var(--bg-secondary)', borderRadius: 8, border: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: windowColor(score.label) }}>{score.label}</span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Dynasty Value: <b style={{ color: 'var(--text-primary)' }}>{score.totalValue.toLocaleString()}</b>
          {' · '}Avg Age: <b style={{ color: 'var(--text-primary)' }}>{score.avgAge.toFixed(1)}</b>
          {' · '}{score.matchedCount} players matched
        </span>
      </div>
      <div style={{ display: 'flex', gap: 4, marginTop: 8, height: 8, borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${score.youngPct}%`, background: '#22c55e' }} title={`Young (≤24): ${score.youngPct.toFixed(0)}%`} />
        <div style={{ width: `${score.primePct}%`, background: '#f59e0b' }} title={`Prime (25-27): ${score.primePct.toFixed(0)}%`} />
        <div style={{ width: `${score.agingPct}%`, background: '#ef4444' }} title={`Aging (28+): ${score.agingPct.toFixed(0)}%`} />
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: 10, color: 'var(--text-muted)' }}>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, background: '#22c55e', borderRadius: 2, marginRight: 3 }} />Young ≤24: {score.youngPct.toFixed(0)}%</span>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, background: '#f59e0b', borderRadius: 2, marginRight: 3 }} />Prime 25-27: {score.primePct.toFixed(0)}%</span>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, background: '#ef4444', borderRadius: 2, marginRight: 3 }} />Aging 28+: {score.agingPct.toFixed(0)}%</span>
      </div>
      {score.topAssets.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
          <b>Top assets:</b>{' '}
          {score.topAssets.map((a, i) => (
            <span key={i}>
              {i > 0 && ' · '}
              {a.name} <span style={{ color: 'var(--text-primary)' }}>{a.value.toLocaleString()}</span>
              <span style={{ color: a.age <= 24 ? '#22c55e' : a.age <= 27 ? '#f59e0b' : '#ef4444', marginLeft: 2 }}>({a.age})</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── League-wide power rankings ──

type ViewMode = 'starters' | 'starters-plus' | 'full';

interface PositionalStrength {
  qb: number;
  rb: number;
  wr: number;
  te: number;
}

interface PowerRow {
  team: LeagueTeam;
  score: RosterScore | null; // dynasty window/value scoring — null for redraft
  posStrength: PositionalStrength;
  projPts: number;
}

function computePositionalStrength(
  team: LeagueTeam,
  ktcByName: Map<string, KTCPlayer>,
  mode: ViewMode,
): PositionalStrength {
  let players: RosterPlayer[];
  if (mode === 'starters') {
    players = team.starters.filter((p) => p.name !== 'Empty');
  } else if (mode === 'starters-plus') {
    const starterPositions = new Map<string, number>();
    for (const p of team.starters) {
      if (p.position) starterPositions.set(p.position, (starterPositions.get(p.position) ?? 0) + 1);
    }
    const benchByPos = new Map<string, RosterPlayer[]>();
    for (const p of team.bench) {
      if (p.position) {
        if (!benchByPos.has(p.position)) benchByPos.set(p.position, []);
        benchByPos.get(p.position)!.push(p);
      }
    }
    players = [...team.starters.filter((p) => p.name !== 'Empty')];
    for (const [pos, benched] of benchByPos) {
      const starterCount = starterPositions.get(pos) ?? 0;
      const replacements = benched.slice(0, Math.max(1, Math.ceil(starterCount * 0.5)));
      players.push(...replacements);
    }
  } else {
    players = [...team.starters, ...team.bench].filter((p) => p.name !== 'Empty');
  }

  const str: PositionalStrength = { qb: 0, rb: 0, wr: 0, te: 0 };
  for (const p of players) {
    const k = ktcByName.get(normalizeForMatch(p.name));
    if (!k || k.value <= 0) continue;
    const pos = p.position?.toUpperCase();
    if (pos === 'QB') str.qb += k.value;
    else if (pos === 'RB') str.rb += k.value;
    else if (pos === 'WR') str.wr += k.value;
    else if (pos === 'TE') str.te += k.value;
  }
  return str;
}

// Positional strength measured by projected season points (for redraft leagues),
// mirroring computePositionalStrength but using the projection map instead of value.
function computePositionalProjStrength(
  team: LeagueTeam,
  projBySleeperIdMap: Map<string, number>,
  mode: ViewMode,
): PositionalStrength {
  let players: RosterPlayer[];
  if (mode === 'starters') {
    players = team.starters.filter((p) => p.name !== 'Empty');
  } else if (mode === 'starters-plus') {
    const starterPositions = new Map<string, number>();
    for (const p of team.starters) {
      if (p.position) starterPositions.set(p.position, (starterPositions.get(p.position) ?? 0) + 1);
    }
    const benchByPos = new Map<string, RosterPlayer[]>();
    for (const p of team.bench) {
      if (p.position) {
        if (!benchByPos.has(p.position)) benchByPos.set(p.position, []);
        benchByPos.get(p.position)!.push(p);
      }
    }
    players = [...team.starters.filter((p) => p.name !== 'Empty')];
    for (const [pos, benched] of benchByPos) {
      const starterCount = starterPositions.get(pos) ?? 0;
      const replacements = benched.slice(0, Math.max(1, Math.ceil(starterCount * 0.5)));
      players.push(...replacements);
    }
  } else {
    players = [...team.starters, ...team.bench].filter((p) => p.name !== 'Empty');
  }

  const str: PositionalStrength = { qb: 0, rb: 0, wr: 0, te: 0 };
  for (const p of players) {
    const pts = projBySleeperIdMap.get(p.id) ?? 0;
    if (pts <= 0) continue;
    const pos = p.position?.toUpperCase();
    if (pos === 'QB') str.qb += pts;
    else if (pos === 'RB') str.rb += pts;
    else if (pos === 'WR') str.wr += pts;
    else if (pos === 'TE') str.te += pts;
  }
  return str;
}

function computeTeamProjPts(
  team: LeagueTeam,
  projBySleeperIdMap: Map<string, number>,
  mode: ViewMode,
): number {
  let players: RosterPlayer[];
  if (mode === 'starters') {
    players = team.starters.filter((p) => p.name !== 'Empty');
  } else if (mode === 'full') {
    players = [...team.starters, ...team.bench].filter((p) => p.name !== 'Empty');
  } else {
    players = [...team.starters.filter((p) => p.name !== 'Empty')];
    const benchByPos = new Map<string, RosterPlayer[]>();
    for (const p of team.bench) {
      if (p.position) {
        if (!benchByPos.has(p.position)) benchByPos.set(p.position, []);
        benchByPos.get(p.position)!.push(p);
      }
    }
    for (const [, benched] of benchByPos) {
      players.push(...benched.slice(0, 1));
    }
  }
  let total = 0;
  for (const p of players) {
    total += projBySleeperIdMap.get(p.id) ?? 0;
  }
  return total;
}

interface LeaguePowerProps {
  teams: LeagueTeam[];
  ktc: KTCPlayer[];
  projBySleeperIdMap: Map<string, number>;
  isDynasty: boolean;
}

function LeaguePowerRankings({ teams, ktc, projBySleeperIdMap, isDynasty }: LeaguePowerProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('starters');
  const [dynastySortBy, setDynastySortBy] = useState<'value' | 'proj'>('value');
  // Redraft leagues are always ranked on projected season points.
  const sortBy = isDynasty ? dynastySortBy : 'proj';

  const rows: PowerRow[] = useMemo(() => {
    const ktcByName = new Map<string, KTCPlayer>();
    for (const p of ktc) ktcByName.set(normalizeForMatch(p.playerName), p);

    const out: PowerRow[] = [];
    for (const t of teams) {
      const projPts = computeTeamProjPts(t, projBySleeperIdMap, viewMode);
      if (isDynasty) {
        const score = scoreRoster(t, ktc);
        if (!score) continue;
        const posStrength = computePositionalStrength(t, ktcByName, viewMode);
        out.push({ team: t, score, posStrength, projPts });
      } else {
        const posStrength = computePositionalProjStrength(t, projBySleeperIdMap, viewMode);
        out.push({ team: t, score: null, posStrength, projPts });
      }
    }
    if (sortBy === 'value') out.sort((a, b) => (b.score?.totalValue ?? 0) - (a.score?.totalValue ?? 0));
    else out.sort((a, b) => b.projPts - a.projPts);
    return out;
  }, [teams, ktc, projBySleeperIdMap, viewMode, sortBy, isDynasty]);

  if (!rows.length) return null;

  const maxPos = { qb: 0, rb: 0, wr: 0, te: 0 };
  for (const r of rows) {
    if (r.posStrength.qb > maxPos.qb) maxPos.qb = r.posStrength.qb;
    if (r.posStrength.rb > maxPos.rb) maxPos.rb = r.posStrength.rb;
    if (r.posStrength.wr > maxPos.wr) maxPos.wr = r.posStrength.wr;
    if (r.posStrength.te > maxPos.te) maxPos.te = r.posStrength.te;
  }

  // Dynasty bars carry KTC value (thousands); redraft bars carry projected points.
  const posBar = (val: number, max: number, color: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <div style={{ width: 50, height: 8, background: 'var(--bg-tertiary)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${max ? (val / max) * 100 : 0}%`, height: '100%', background: color, borderRadius: 4 }} />
      </div>
      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
        {val ? (isDynasty ? (val / 1000).toFixed(1) + 'k' : val.toFixed(0)) : '—'}
      </span>
    </div>
  );

  return (
    <div style={{ margin: '16px 0' }}>
      <div className="sched-section-title">League Power Rankings</div>
      <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '2px 0 8px' }}>
        {isDynasty
          ? 'Positional strength by dynasty value and projected score.'
          : 'Positional strength by projected season points (redraft).'}
      </p>
      <div className="controls" style={{ gap: 6, margin: '8px 0' }}>
        {([['starters', 'Starters Only'], ['starters-plus', 'Starters + Replacements'], ['full', 'Full Roster']] as const).map(([mode, label]) => (
          <button
            key={mode}
            className={`format-tab ${viewMode === mode ? 'active' : ''}`}
            onClick={() => setViewMode(mode)}
            style={{ padding: '3px 10px', fontSize: 11 }}
          >
            {label}
          </button>
        ))}
        {isDynasty && (
          <>
            <span style={{ marginLeft: 12, fontSize: 11, color: 'var(--text-muted)' }}>Sort:</span>
            <button className={`format-tab ${sortBy === 'value' ? 'active' : ''}`} onClick={() => setDynastySortBy('value')} style={{ padding: '3px 10px', fontSize: 11 }}>Dynasty Value</button>
            <button className={`format-tab ${sortBy === 'proj' ? 'active' : ''}`} onClick={() => setDynastySortBy('proj')} style={{ padding: '3px 10px', fontSize: 11 }}>Projected Pts</button>
          </>
        )}
      </div>
      <div className="table-container" style={{ maxHeight: 'none' }}>
        <table className="sched-table" style={{ fontSize: 12 }}>
          <thead>
            <tr>
              <th>#</th><th>Team</th>
              {isDynasty && <><th>Window</th><th>Value</th></>}
              <th title="Projected PPR points (season)">Proj Pts</th>
              <th>QB</th><th>RB</th><th>WR</th><th>TE</th>
              {isDynasty && <th style={{ width: 90 }}>Age Dist</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.team.rosterId}>
                <td className="rank-cell">{i + 1}</td>
                <td><strong>{r.team.teamName}</strong></td>
                {isDynasty && r.score && (
                  <>
                    <td style={{ color: windowColor(r.score.label), fontWeight: 600 }}>{r.score.label}</td>
                    <td>{r.score.totalValue.toLocaleString()}</td>
                  </>
                )}
                <td style={{ fontWeight: 600 }}>{r.projPts > 0 ? r.projPts.toFixed(0) : '—'}</td>
                <td>{posBar(r.posStrength.qb, maxPos.qb, '#6366f1')}</td>
                <td>{posBar(r.posStrength.rb, maxPos.rb, '#22c55e')}</td>
                <td>{posBar(r.posStrength.wr, maxPos.wr, '#f59e0b')}</td>
                <td>{posBar(r.posStrength.te, maxPos.te, '#ef4444')}</td>
                {isDynasty && r.score && (
                  <td>
                    <div style={{ display: 'flex', gap: 1, height: 10, borderRadius: 3, overflow: 'hidden', minWidth: 60 }}>
                      <div style={{ width: `${r.score.youngPct}%`, background: '#22c55e' }} />
                      <div style={{ width: `${r.score.primePct}%`, background: '#f59e0b' }} />
                      <div style={{ width: `${r.score.agingPct}%`, background: '#ef4444' }} />
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Inline Waiver Wire (per-league) ──

interface LeagueWaiverSectionProps {
  leagueId: string;
}

function LeagueWaiverSection({ leagueId }: LeagueWaiverSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const [rosteredIds, setRosteredIds] = useState<Set<string>>(new Set());
  const [players, setPlayers] = useState<ClayPlayer[]>([]);
  const [trending, setTrending] = useState<SleeperTrendingRow[]>([]);
  const [posFilter, setPosFilter] = useState<string>('ALL');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!expanded || loaded) return;
    setLoaded(true);
    Promise.all([
      fetchLeagueRosteredIds(leagueId),
      loadClayProjections(),
      fetchSleeperTrending('add', 24, 75).catch(() => [] as SleeperTrendingRow[]),
    ]).then(([ids, proj, trend]) => {
      setRosteredIds(ids);
      setPlayers(proj);
      setTrending(trend);
    });
  }, [expanded, loaded, leagueId]);

  const waiverPicks = useMemo(() => {
    if (!players.length || !rosteredIds.size) return [];
    const out: (ClayPlayer & { pprPts: number })[] = [];
    for (const p of players) {
      if (!p.sleeperId || rosteredIds.has(p.sleeperId)) continue;
      const pprPts = computePpr(p);
      if (pprPts > 0) out.push({ ...p, pprPts });
    }
    out.sort((a, b) => b.pprPts - a.pprPts);
    return out;
  }, [players, rosteredIds]);

  const trendingAvail = useMemo(() => {
    if (!trending.length || !rosteredIds.size) return [];
    return trending.filter((t) => !rosteredIds.has(t.player_id));
  }, [trending, rosteredIds]);

  const filteredWaivers = posFilter === 'ALL' ? waiverPicks : waiverPicks.filter((w) => w.position === posFilter);
  const filteredTrending = posFilter === 'ALL' ? trendingAvail : trendingAvail.filter((t) => t.position === posFilter);

  return (
    <div style={{ margin: '16px 0' }}>
      <div
        className="sched-section-title"
        style={{ cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{ display: 'inline-block', width: 16, fontSize: 10 }}>{expanded ? '▼' : '▶'}</span>
        Waiver Wire
      </div>
      {!expanded && (
        <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '2px 0 0', cursor: 'pointer' }} onClick={() => setExpanded(true)}>
          Click to see top projected scorers and trending adds available on waivers.
        </p>
      )}
      {expanded && (
        <>
          <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '2px 0 8px' }}>
            Highest Consensus projected PPR scorers and trending adds not rostered in this league.
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

          {filteredWaivers.length > 0 && (
            <>
              <div style={{ fontSize: 12, fontWeight: 600, margin: '8px 0 4px' }}>Top Projected Scorers on Waivers</div>
              <div className="table-container" style={{ maxHeight: 340 }}>
                <table className="sched-table" style={{ fontSize: 12 }}>
                  <thead>
                    <tr><th>#</th><th>Player</th><th>Pos</th><th>Team</th><th title="Consensus PPR projection">PPR</th><th>Pos Rk</th></tr>
                  </thead>
                  <tbody>
                    {filteredWaivers.slice(0, 40).map((w, i) => (
                      <tr key={w.player_key}>
                        <td className="rank-cell">{i + 1}</td>
                        <td><strong>{w.name}</strong></td>
                        <td><span className={`pos-badge pos-${w.position}`}>{w.position}</span></td>
                        <td>
                          {w.team && <img src={teamLogoUrl(w.team)} alt="" width={14} height={14} style={{ objectFit: 'contain', verticalAlign: 'middle' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
                          {' '}{w.team}
                        </td>
                        <td style={{ fontWeight: 600 }}>{w.pprPts.toFixed(1)}</td>
                        <td style={{ color: 'var(--text-muted)' }}>{w.position}{w.pos_rk}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {filteredTrending.length > 0 && (
            <>
              <div style={{ fontSize: 12, fontWeight: 600, margin: '12px 0 4px' }}>Trending Adds (Last 24h)</div>
              <div className="table-container" style={{ maxHeight: 260 }}>
                <table className="sched-table" style={{ fontSize: 12 }}>
                  <thead>
                    <tr><th>#</th><th>Player</th><th>Pos</th><th>Team</th><th>Adds</th></tr>
                  </thead>
                  <tbody>
                    {filteredTrending.slice(0, 25).map((t, i) => (
                      <tr key={t.player_id}>
                        <td className="rank-cell">{i + 1}</td>
                        <td><strong>{t.full_name}</strong></td>
                        <td><span className={`pos-badge pos-${t.position}`}>{t.position}</span></td>
                        <td>
                          {t.team && t.team !== 'FA' && <img src={teamLogoUrl(t.team)} alt="" width={14} height={14} style={{ objectFit: 'contain', verticalAlign: 'middle' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
                          {' '}{t.team}
                        </td>
                        <td style={{ color: 'var(--accent)', fontWeight: 600 }}>+{t.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {!filteredWaivers.length && !filteredTrending.length && loaded && (
            <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>No waiver data available.</p>
          )}
        </>
      )}
    </div>
  );
}

// ── Win-Win Trade Suggestions ──

function scoreColor(score: number): string {
  if (score >= 80) return '#22c55e';
  if (score >= 65) return '#a3e635';
  if (score >= 50) return '#f59e0b';
  return '#ef4444';
}

function TradeAssetCard({ a }: { a: TradeAsset }) {
  if (a.type === 'pick') {
    return (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '3px 0' }}>
        <span style={{ fontWeight: 500 }}>{a.name}</span>
        <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{(a.value / 1000).toFixed(1)}k</span>
      </div>
    );
  }

  return (
    <div style={{ padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ fontWeight: 500 }}>{a.name}</span>
        {a.position && <span className={`pos-badge pos-${a.position}`} style={{ fontSize: 9, padding: '0 4px' }}>{a.position}</span>}
        {a.age != null && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>Age {a.age}</span>}
        <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{(a.value / 1000).toFixed(1)}k</span>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 2, fontSize: 10, color: 'var(--text-muted)' }}>
        {a.projStats && (
          <>
            <span style={{ color: '#6366f1', fontWeight: 600 }}>
              2026: {a.projStats.projPts.toFixed(0)}pts ({a.position}{a.projStats.projPosRank})
            </span>
            {a.projStats.projPassYds != null && a.projStats.projPassYds > 0 && (
              <span>{a.projStats.projPassYds.toFixed(0)}yds/{a.projStats.projPassTd?.toFixed(0)}td pass</span>
            )}
            {a.projStats.projRushYds != null && a.projStats.projRushYds > 0 && (
              <span>{a.projStats.projRushYds.toFixed(0)}yds/{a.projStats.projRushTd?.toFixed(0)}td rush</span>
            )}
            {a.projStats.projRec != null && a.projStats.projRec > 0 && (
              <span>{a.projStats.projRec.toFixed(0)}rec/{a.projStats.projRecYds?.toFixed(0)}yds/{a.projStats.projRecTd?.toFixed(0)}td</span>
            )}
          </>
        )}
        {!a.projStats && a.projPts != null && a.projPts > 0 && (
          <span style={{ color: '#6366f1' }}>2026 proj: {a.projPts.toFixed(0)}pts</span>
        )}
        {a.lastSeasonPts != null && (
          <span>2025: {a.lastSeasonPts.toFixed(0)}pts{a.lastSeasonPosRank ? ` (${a.position}${a.lastSeasonPosRank})` : ''}</span>
        )}
      </div>
    </div>
  );
}

function ScoreBreakdownBar({ breakdown, teamAName, teamBName }: { breakdown: TradeScoreBreakdown; teamAName: string; teamBName: string }) {
  const checks = [
    { label: 'Value Fairness', pass: breakdown.fairness >= 60, detail: `${breakdown.fairness}/100` },
    { label: `${teamAName} goal met`, pass: breakdown.goalAlignmentA, detail: breakdown.goalAlignmentA ? 'Yes' : 'No' },
    { label: `${teamBName} goal met`, pass: breakdown.goalAlignmentB, detail: breakdown.goalAlignmentB ? 'Yes' : 'No' },
    { label: `Helps ${teamAName} weakness`, pass: breakdown.strengthensA, detail: breakdown.strengthensA ? 'Yes' : 'No' },
    { label: `Helps ${teamBName} weakness`, pass: breakdown.strengthensB, detail: breakdown.strengthensB ? 'Yes' : 'No' },
  ];
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 10, marginTop: 6 }}>
      {checks.map((c) => (
        <span key={c.label} style={{ display: 'flex', gap: 3, alignItems: 'center', padding: '2px 6px', borderRadius: 4, background: c.pass ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${c.pass ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}` }}>
          <span style={{ color: c.pass ? '#22c55e' : '#ef4444' }}>{c.pass ? '✓' : '✗'}</span>
          <span style={{ color: 'var(--text-secondary)' }}>{c.label}</span>
          <span style={{ color: 'var(--text-muted)' }}>{c.detail}</span>
        </span>
      ))}
    </div>
  );
}

function TradeCard({ s }: { s: TradeSuggestion }) {
  const result = evaluateTrade(s.teamA.gives, s.teamA.receives);

  return (
    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>
          {s.teamA.teamName} ↔ {s.teamB.teamName}
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: scoreColor(s.score) }}>
            {s.score}/100
          </span>
          <span style={{ fontSize: 10, color: s.fairness >= 80 ? '#22c55e' : s.fairness >= 60 ? '#f59e0b' : '#ef4444' }}>
            {s.fairness.toFixed(0)}% fair
          </span>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 11 }}>
        <div>
          <div style={{ color: 'var(--text-muted)', fontSize: 10, marginBottom: 3 }}>You give:</div>
          {s.teamA.gives.map((a) => <TradeAssetCard key={a.name} a={a} />)}
          <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-muted)' }}>
            Total: {(result.givesTotal / 1000).toFixed(1)}k
          </div>
        </div>
        <div>
          <div style={{ color: 'var(--text-muted)', fontSize: 10, marginBottom: 3 }}>You get:</div>
          {s.teamA.receives.map((a) => <TradeAssetCard key={a.name} a={a} />)}
          <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-muted)' }}>
            Total: {(result.receivesTotal / 1000).toFixed(1)}k
            {result.net !== 0 && (
              <span style={{ color: result.net >= 0 ? '#22c55e' : '#ef4444', marginLeft: 6, fontWeight: 600 }}>
                ({result.net >= 0 ? '+' : ''}{(result.net / 1000).toFixed(1)}k)
              </span>
            )}
          </div>
        </div>
      </div>
      <ScoreBreakdownBar breakdown={s.scoreBreakdown} teamAName={s.teamA.teamName} teamBName={s.teamB.teamName} />
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>{s.rationale}</div>
    </div>
  );
}

interface TradeSectionProps {
  teams: LeagueTeam[];
  ktc: KTCPlayer[];
  leagueId: string;
  myRosterId?: number;
  myTeamName?: string;
  projBySleeperIdMap: Map<string, number>;
  projStatsMap: Map<string, TradeAssetStats>;
  lastSeasonMap: Map<string, { pts: number; posRank: number }>;
  isDynasty: boolean;
}

function TradeSuggestionsSection({ teams, ktc, leagueId, myRosterId, myTeamName, projBySleeperIdMap, projStatsMap, lastSeasonMap, isDynasty }: TradeSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const [goals, setGoals] = useState<Map<number, TradeGoal>>(new Map());
  const [suggestions, setSuggestions] = useState<TradeSuggestion[]>([]);
  const [loading, setLoading] = useState(false);

  const myGoal = goals.get(myRosterId ?? -1) ?? 'balanced';

  const [generated, setGenerated] = useState(false);

  const doGenerate = async () => {
    setLoading(true);
    try {
      const tradedPicks = await fetchTradedPicks(leagueId);
      const pickOwnership = buildPickOwnership(teams, tradedPicks, '2027');
      const results = generateTradeSuggestions(teams, ktc, goals, pickOwnership, myRosterId, projBySleeperIdMap, 6, projStatsMap, lastSeasonMap);
      setSuggestions(results);
      setGenerated(true);
    } catch {
      setSuggestions([]);
    }
    setLoading(false);
  };

  const setMyGoal = (goal: TradeGoal) => {
    const next = new Map(goals);
    if (myRosterId) next.set(myRosterId, goal);
    setGoals(next);
  };

  return (
    <div style={{ margin: '16px 0' }}>
      <div
        className="sched-section-title"
        style={{ cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{ display: 'inline-block', width: 16, fontSize: 10 }}>{expanded ? '▼' : '▶'}</span>
        Win-Win Trade Suggestions
      </div>
      {!expanded && (
        <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '2px 0 0', cursor: 'pointer' }} onClick={() => setExpanded(true)}>
          Click to get trade suggestions that benefit both sides.
        </p>
      )}
      {expanded && (
        <>
          {myTeamName && (
            <div style={{ fontSize: 13, fontWeight: 600, margin: '6px 0 4px', color: 'var(--text-primary)' }}>
              Suggesting trades for: <span style={{ color: '#6366f1' }}>{myTeamName}</span>
              <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6 }}>(select a team in standings to change)</span>
            </div>
          )}
          <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '2px 0 8px' }}>
            {isDynasty
              ? 'Trades consider dynasty value, age, positional needs, and 2027 draft picks. Your top assets are protected.'
              : 'Trades consider player value, projected points, and positional needs. Your top assets are protected.'}
          </p>

          <div className="controls" style={{ gap: 6, margin: '8px 0', flexWrap: 'wrap' }}>
            {isDynasty && <>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>My Goal:</span>
              {(['win-now', 'balanced', 'rebuild'] as const).map((g) => (
                <button
                  key={g}
                  className={`format-tab ${myGoal === g ? 'active' : ''}`}
                  onClick={() => setMyGoal(g)}
                  style={{ padding: '3px 10px', fontSize: 11 }}
                >
                  {g === 'win-now' ? 'Win Now' : g === 'rebuild' ? 'Rebuild' : 'Balanced'}
                </button>
              ))}
            </>}
            <button
              className="format-tab active"
              onClick={doGenerate}
              disabled={loading}
              style={{ marginLeft: 12, padding: '3px 12px', fontSize: 11 }}
            >
              {loading ? 'Generating…' : generated ? 'Refresh Suggestions' : 'Generate Trades'}
            </button>
          </div>

          {suggestions.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
              {suggestions.map((s, i) => <TradeCard key={`${i}-${s.teamB.rosterId}`} s={s} />)}
            </div>
          )}

          {!loading && generated && suggestions.length === 0 && (
            <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 8 }}>
              No viable 2-3 player trades found. Try changing your goal or selecting a different team.
            </p>
          )}

          {!loading && !generated && (
            <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 8 }}>
              Click "Generate Trades" to find win-win deals with 2-3 player packages.
            </p>
          )}
        </>
      )}
    </div>
  );
}

interface SleeperLeagueViewProps {
  onNavigate?: (tab: Tab) => void;
}

export function SleeperLeagueView({ onNavigate }: SleeperLeagueViewProps) {
  const [leagueId, setLeagueId] = useState(() => localStorage.getItem(LS_KEY) ?? '');
  const [data, setData] = useState<LeagueImport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [matchups, setMatchups] = useState<MatchupsByKey>(new Map());
  const [teamProj, setTeamProj] = useState<TeamProjByTeam | null>(null);
  const [ktc, setKtc] = useState<KTCPlayer[]>([]);
  const [allProjections, setAllProjections] = useState<ClayPlayer[]>([]);

  // Username → all leagues
  const [username, setUsername] = useState(() => localStorage.getItem(LS_USER_KEY) ?? '');
  const [userLeagues, setUserLeagues] = useState<SleeperLeagueSummary[]>([]);
  const [userLoading, setUserLoading] = useState(false);
  const [userError, setUserError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchMatchups(), fetchTeamProjections(), fetchKTCRankings('1qb')]).then(([m, tp, k]) => {
      setMatchups(m); setTeamProj(tp); setKtc(k);
    });
    loadClayProjections().then(setAllProjections);
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

  const scoring = data?.league.scoring_settings ?? {};
  const isDynasty = isDynastyLeague(data?.league);

  const projBySleeperIdMap = useMemo(() => {
    const map = new Map<string, number>();
    const hasCustomScoring = Object.keys(scoring).length > 0;
    for (const p of allProjections) {
      if (p.sleeperId) {
        map.set(p.sleeperId, hasCustomScoring ? computeCustomScore(p, scoring) : computePpr(p));
      }
    }
    return map;
  }, [allProjections, scoring]);

  const projStatsMap = useMemo(() => {
    const map = new Map<string, TradeAssetStats>();
    const hasCustomScoring = Object.keys(scoring).length > 0;
    const byPos = new Map<string, { sleeperId: string; pts: number }[]>();
    for (const p of allProjections) {
      if (!p.sleeperId) continue;
      const pts = hasCustomScoring ? computeCustomScore(p, scoring) : computePpr(p);
      if (!byPos.has(p.position)) byPos.set(p.position, []);
      byPos.get(p.position)!.push({ sleeperId: p.sleeperId, pts });
    }
    for (const entries of byPos.values()) entries.sort((a, b) => b.pts - a.pts);
    for (const p of allProjections) {
      if (!p.sleeperId) continue;
      const pts = hasCustomScoring ? computeCustomScore(p, scoring) : computePpr(p);
      const posEntries = byPos.get(p.position) ?? [];
      const posRank = posEntries.findIndex((e) => e.sleeperId === p.sleeperId) + 1;
      map.set(p.sleeperId, {
        projPts: pts,
        projPosRank: posRank,
        projPassYds: p.pass_yds || undefined,
        projPassTd: p.pass_td || undefined,
        projRushYds: p.rush_yds || undefined,
        projRushTd: p.rush_td || undefined,
        projRec: p.rec || undefined,
        projRecYds: p.rec_yds || undefined,
        projRecTd: p.rec_td || undefined,
      });
    }
    return map;
  }, [allProjections, scoring]);

  const [lastSeasonData, setLastSeasonData] = useState<ClayPlayer[]>([]);
  useEffect(() => {
    Promise.all([
      fetch(`${import.meta.env.BASE_URL}data/clay-projections-2025.json`),
      fetch(`${import.meta.env.BASE_URL}data/player-crosswalk.json`),
    ]).then(async ([projRes, cwRes]) => {
      if (!projRes.ok) return;
      const projData = await projRes.json() as { players?: Record<string, unknown>[] };
      const sleeperByKey = new Map<string, string>();
      if (cwRes.ok) {
        const cw = await cwRes.json() as { players?: { player_key: string; sleeper_id?: string }[] };
        for (const rec of cw.players ?? []) {
          if (rec.sleeper_id && rec.player_key) sleeperByKey.set(rec.player_key, rec.sleeper_id);
        }
      }
      const players = (projData.players ?? [])
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
      setLastSeasonData(players);
    }).catch(() => {});
  }, []);

  const lastSeasonMap = useMemo(() => {
    const map = new Map<string, { pts: number; posRank: number }>();
    if (!lastSeasonData.length) return map;
    const byPos = new Map<string, { sleeperId: string; pts: number }[]>();
    for (const p of lastSeasonData) {
      if (!p.sleeperId) continue;
      const pts = computePpr(p);
      if (!byPos.has(p.position)) byPos.set(p.position, []);
      byPos.get(p.position)!.push({ sleeperId: p.sleeperId, pts });
    }
    for (const entries of byPos.values()) entries.sort((a, b) => b.pts - a.pts);
    for (const p of lastSeasonData) {
      if (!p.sleeperId) continue;
      const pts = computePpr(p);
      const posEntries = byPos.get(p.position) ?? [];
      const posRank = posEntries.findIndex((e) => e.sleeperId === p.sleeperId) + 1;
      map.set(p.sleeperId, { pts, posRank });
    }
    return map;
  }, [lastSeasonData]);

  const selectedTeam: LeagueTeam | undefined = useMemo(
    () => data?.teams.find((t) => t.rosterId === selected),
    [data, selected],
  );

  const optimalLineup: OptimalLineup | null = useMemo(() => {
    if (!selectedTeam || !allProjections.length || !data) return null;
    const rosterPlayerIds = [...selectedTeam.starters, ...selectedTeam.bench]
      .filter((p) => p.name !== 'Empty')
      .map((p) => p.id);
    const myPlayers = allProjections.filter((cp) => cp.sleeperId && rosterPlayerIds.includes(cp.sleeperId));
    if (!myPlayers.length) return null;
    return computeOptimalLineup(myPlayers, data.league.roster_positions, scoring);
  }, [selectedTeam, allProjections, data, scoring]);

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
            <b style={{ color: 'var(--text-primary)' }}>{data.league.name}</b> · {data.league.season} · {data.league.status} · {data.league.total_rosters} teams · {isDynasty ? 'Dynasty' : 'Redraft'}
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
                    <td>
                      <button
                        style={{ background: 'none', border: 'none', color: '#6366f1', cursor: 'pointer', padding: 0, font: 'inherit', fontSize: 'inherit' }}
                        title="View in User Snooper"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (t.owner && t.owner !== '—' && onNavigate) {
                            localStorage.setItem('sleeper_snoop_user', t.owner);
                            onNavigate('sleeper-snooper');
                          }
                        }}
                      >
                        {t.owner}
                      </button>
                    </td>
                    <td>{t.wins}-{t.losses}{t.ties ? `-${t.ties}` : ''}</td>
                    <td>{t.pointsFor.toFixed(1)}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{t.pointsAgainst.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {ktc.length > 0 && <LeaguePowerRankings teams={data.teams} ktc={ktc} projBySleeperIdMap={projBySleeperIdMap} isDynasty={isDynasty} />}

          <LeagueWaiverSection leagueId={data.league.league_id} />

          {ktc.length > 0 && (
            <TradeSuggestionsSection
              teams={data.teams}
              ktc={ktc}
              leagueId={data.league.league_id}
              myRosterId={selected ?? undefined}
              myTeamName={selectedTeam?.teamName}
              projBySleeperIdMap={projBySleeperIdMap}
              projStatsMap={projStatsMap}
              lastSeasonMap={lastSeasonMap}
              isDynasty={isDynasty}
            />
          )}

          {selectedTeam && (
            <>
              <div className="sched-section-title" style={{ marginTop: 16 }}>
                Roster — {selectedTeam.teamName} <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 11 }}>(click a team above to switch)</span>
              </div>
              {isDynasty && ktc.length > 0 && (() => { const s = scoreRoster(selectedTeam, ktc); return s ? <WindowBadge score={s} /> : null; })()}

              {optimalLineup && (
                <div style={{ margin: '8px 0 12px', padding: '10px 14px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                    Optimal Projected Lineup
                    <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11, marginLeft: 8 }}>
                      {Object.keys(scoring).length > 0 ? 'Using league scoring' : 'Standard PPR'} · Season total: <b style={{ color: '#6366f1' }}>{optimalLineup.totalStarterPts.toFixed(0)} pts</b>
                    </span>
                  </div>
                  <div className="table-container" style={{ maxHeight: 'none' }}>
                    <table className="sched-table" style={{ fontSize: 11 }}>
                      <thead>
                        <tr><th>Slot</th><th>Player</th><th>Pos</th><th>Team</th><th>Proj Pts</th></tr>
                      </thead>
                      <tbody>
                        {optimalLineup.starters.map((s, i) => (
                          <tr key={i}>
                            <td style={{ color: 'var(--text-muted)', fontSize: 10 }}>{s.slot}</td>
                            <td><strong>{s.player.name}</strong></td>
                            <td><span className={`pos-badge pos-${s.player.position}`}>{s.player.position}</span></td>
                            <td>
                              {s.player.team && <img src={teamLogoUrl(s.player.team)} alt="" width={14} height={14} style={{ objectFit: 'contain', verticalAlign: 'middle' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
                              {' '}{s.player.team}
                            </td>
                            <td style={{ fontWeight: 600 }}>{s.pts.toFixed(1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

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
