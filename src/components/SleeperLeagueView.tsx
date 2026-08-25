import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { bust } from '../lib/buildHash';
import { importLeague, fetchSleeperUser, fetchUserLeagues, fetchLeagueRosteredIds, fetchTradedPicks, isDynastyLeague, leagueFormatInfo, type LeagueImport, type LeagueTeam, type RosterPlayer, type SleeperLeagueSummary, type SleeperTradedPick } from '../lib/sleeper';
import { LeagueFormatBadges } from './LeagueFormatBadges';
import { fetchMatchups, fetchTeamProjections, matchupFor, type MatchupsByKey, type TeamProjByTeam } from '../lib/nflSchedule';
import { fetchDynastyRankings, fetchDynastyRankingsForDisplay, fetchFantasyCalcRankings, fetchSleeperTrending, fetchSleeperPlayers } from '../data';
import type { DynastyPlayer, Tab, SleeperTrendingRow } from '../types';
import { teamLogoUrl } from '../lib/teamLogo';
import { PlayerName } from './PlayerName';
import { loadBlendedProjections, computePpr, computeCustomScore, computeOptimalLineup, type ConsensusPlayer, type OptimalLineup } from '../lib/waiverUtils';
import { generateTradeSuggestions, buildPickOwnership, evaluateTrade, type TradeGoal, type TradeSuggestion, type TradeAsset, type TradeScoreBreakdown, type TradeAssetStats, type DraftPick } from '../lib/tradeEngine';
import { normalizeForMatch, fallbackNameKey, buildFallbackIndex } from '../lib/nameMatch';
import { listProjectionScenarios, buildScenarioPprByName, buildPresetMeta } from '../lib/projectionScenario';
import type { PresetMeta } from '../lib/scenarioPresets';

const LS_KEY = 'sleeper_league_id';
const LS_USER_KEY = 'sleeper_username';

function PlayerLine({ p, proj, value, trend }: { p: RosterPlayer; proj?: number; value?: number; trend?: number | null }) {
  return (
    <div className="sl-player">
      <span className="sl-slot">{p.slot}</span>
      {p.position && <span className={`pos-badge pos-${p.position}`}>{p.position}</span>}
      <span className="sl-name">
        <PlayerName sleeperId={p.id} name={p.name} position={p.position} />
      </span>
      {p.team && (
        <span className="sl-team">
          <img src={teamLogoUrl(p.team)} alt="" width={16} height={16} style={{ objectFit: 'contain', verticalAlign: 'middle' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} /> {p.team}
        </span>
      )}
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, whiteSpace: 'nowrap' }}>
        {proj != null && proj > 0 && (
          <span title="Projected season points" style={{ color: '#6366f1', fontWeight: 600 }}>{proj.toFixed(0)}<span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>pt</span></span>
        )}
        {value != null && value > 0 && (
          <span title="Dynasty value (blended)" style={{ color: 'var(--text-secondary)' }}>{value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value}</span>
        )}
        {trend != null && trend !== 0 && (
          <span title="30-day dynasty value trend" style={{ color: trend > 0 ? '#22c55e' : '#ef4444' }}>{trend > 0 ? '+' : ''}{trend.toLocaleString()}</span>
        )}
      </span>
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


/** Pick the dynasty value matching the league format. SF/2QB leagues use the
 *  superflex value (QBs are worth far more); 1QB leagues use the base value.
 *  Mirrors the per-player + waiver value selection so power rankings,
 *  Win-Now/Rebuild scoring, and roster stats all agree. */
function dynastyValue(k: DynastyPlayer, isSuperflex: boolean): number {
  return isSuperflex ? k.superflexValue : k.value;
}

function scoreRoster(team: LeagueTeam, dynasty: DynastyPlayer[], isSuperflex: boolean): RosterScore | null {
  const dynastyByName = new Map<string, DynastyPlayer>();
  for (const p of dynasty) dynastyByName.set(normalizeForMatch(p.playerName), p);

  const allPlayers = [...team.starters, ...team.bench].filter((p) => p.position && p.position !== 'DEF' && p.name !== 'Empty');
  let totalValue = 0;
  let youngValue = 0;
  let primeValue = 0;
  let agingValue = 0;
  let ageSum = 0;
  let matchedCount = 0;
  const assets: { name: string; value: number; age: number }[] = [];

  for (const p of allPlayers) {
    const k = dynastyByName.get(normalizeForMatch(p.name));
    if (!k) continue;
    const val = dynastyValue(k, isSuperflex);
    if (val <= 0) continue;
    matchedCount++;
    totalValue += val;
    ageSum += k.age;
    assets.push({ name: p.name, value: val, age: k.age });
    if (k.age <= 24) youngValue += val;
    else if (k.age <= 27) primeValue += val;
    else agingValue += val;
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

type ViewMode = 'optimal' | 'starters' | 'starters-plus' | 'full';

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
  avgPts: number; // projected points per predicted starter
  avgAge: number; // average age of predicted starters (Dynasty)
  pickVal: number; // total dynasty value of owned rookie picks
}

type SortKey = 'team' | 'owner' | 'window' | 'value' | 'projPts' | 'avgPts' | 'avgAge' | 'qb' | 'rb' | 'wr' | 'te';
// Win-now → rebuild ordering, so sorting the Window column groups contenders.
const WINDOW_ORDER: WindowLabel[] = ['Win-Now', 'Contender', 'Balanced', 'Retooling', 'Rebuild'];

// Positional strength by dynasty value (Dynasty) over a resolved player set.
function computePositionalStrength(
  players: RosterPlayer[],
  dynastyByName: Map<string, DynastyPlayer>,
  isSuperflex: boolean,
): PositionalStrength {
  const str: PositionalStrength = { qb: 0, rb: 0, wr: 0, te: 0 };
  for (const p of players) {
    const k = dynastyByName.get(normalizeForMatch(p.name));
    if (!k) continue;
    const val = dynastyValue(k, isSuperflex);
    if (val <= 0) continue;
    const pos = p.position?.toUpperCase();
    if (pos === 'QB') str.qb += val;
    else if (pos === 'RB') str.rb += val;
    else if (pos === 'WR') str.wr += val;
    else if (pos === 'TE') str.te += val;
  }
  return str;
}

// Positional strength by projected season points (for redraft leagues),
// mirroring computePositionalStrength but using the projection map instead of value.
function computePositionalProjStrength(
  players: RosterPlayer[],
  projBySleeperIdMap: Map<string, number>,
): PositionalStrength {
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

// Roster slots that are not part of a scoring lineup (skip when optimizing).
const LINEUP_SKIP = new Set(['BN', 'BENCH', 'IR', 'TAXI', 'K', 'DEF', 'DST']);

/** The best legal starting lineup by projected points: fill fixed QB/RB/WR/TE
 *  slots with the top player at each position, then FLEX/REC_FLEX/SUPER_FLEX
 *  from whoever is left. Uses the full roster, ignoring Sleeper's set starters,
 *  so a team's projection reflects its optimal lineup. */
function optimalStarters(
  team: LeagueTeam,
  projBySleeperIdMap: Map<string, number>,
  rosterPositions: string[],
): RosterPlayer[] {
  const slots = rosterPositions.filter((s) => !LINEUP_SKIP.has(s));
  const all = [...team.starters, ...team.bench].filter((p) => p.name !== 'Empty');
  if (!slots.length) return all; // unknown slots → fall back to whole roster
  const scored = all
    .map((p) => ({ p, pts: projBySleeperIdMap.get(p.id) ?? 0 }))
    .sort((a, b) => b.pts - a.pts);
  const used = new Set<string>();
  const out: RosterPlayer[] = [];
  const take = (eligible: (pos: string) => boolean) => {
    const best = scored.find((s) => !used.has(s.p.id) && eligible((s.p.position || '').toUpperCase()));
    if (best) { used.add(best.p.id); out.push(best.p); }
  };
  const FIXED = ['QB', 'RB', 'WR', 'TE'];
  for (const slot of slots) if (FIXED.includes(slot)) take((pos) => pos === slot);
  for (const slot of slots) {
    if (slot === 'FLEX') take((pos) => pos === 'RB' || pos === 'WR' || pos === 'TE');
    else if (slot === 'REC_FLEX') take((pos) => pos === 'WR' || pos === 'TE');
    else if (slot === 'SUPER_FLEX') take((pos) => pos === 'QB' || pos === 'RB' || pos === 'WR' || pos === 'TE');
  }
  return out;
}

/** The player set a view mode counts toward a team's projected points: the
 *  optimal lineup, the predicted starters, those plus the top bench player at
 *  each position, or the full roster. Shared so projected points, per-starter
 *  averages, and positional strength always agree on which players count. */
function selectPlayers(
  team: LeagueTeam,
  mode: ViewMode,
  projBySleeperIdMap: Map<string, number>,
  rosterPositions: string[],
): RosterPlayer[] {
  if (mode === 'optimal') return optimalStarters(team, projBySleeperIdMap, rosterPositions);
  if (mode === 'starters') return team.starters.filter((p) => p.name !== 'Empty');
  if (mode === 'full') return [...team.starters, ...team.bench].filter((p) => p.name !== 'Empty');
  // starters-plus: starters + the top bench player at each position
  const out = team.starters.filter((p) => p.name !== 'Empty');
  const benchByPos = new Map<string, RosterPlayer[]>();
  for (const p of team.bench) {
    if (p.position) {
      if (!benchByPos.has(p.position)) benchByPos.set(p.position, []);
      benchByPos.get(p.position)!.push(p);
    }
  }
  for (const [, benched] of benchByPos) out.push(...benched.slice(0, 1));
  return out;
}

function computeTeamProjPts(players: RosterPlayer[], projBySleeperIdMap: Map<string, number>): number {
  let total = 0;
  for (const p of players) total += projBySleeperIdMap.get(p.id) ?? 0;
  return total;
}

/** Per-starter averages for a resolved player set: projected points per player
 *  and average age (from Dynasty, matched by name). */
function computeStarterAverages(
  players: RosterPlayer[],
  projBySleeperIdMap: Map<string, number>,
  dynastyByName: Map<string, DynastyPlayer>,
): { avgPts: number; avgAge: number } {
  let projTotal = 0;
  let ageSum = 0;
  let ageCount = 0;
  for (const p of players) {
    projTotal += projBySleeperIdMap.get(p.id) ?? 0;
    const k = dynastyByName.get(normalizeForMatch(p.name));
    if (k && k.age > 0) { ageSum += k.age; ageCount++; }
  }
  return {
    avgPts: players.length ? projTotal / players.length : 0,
    avgAge: ageCount ? ageSum / ageCount : 0,
  };
}

interface LeaguePowerProps {
  teams: LeagueTeam[];
  dynasty: DynastyPlayer[];
  isSuperflex: boolean;
  projBySleeperIdMap: Map<string, number>;
  rosterPositions: string[];
  pickValueByRosterId: Map<number, number>;
  isDynasty: boolean;
  selected: number | null;
  onSelect: (rosterId: number) => void;
  onNavigate?: (tab: Tab) => void;
}

function LeaguePowerRankings({ teams, dynasty, isSuperflex, projBySleeperIdMap, rosterPositions, pickValueByRosterId, isDynasty, selected, onSelect, onNavigate }: LeaguePowerProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('optimal');
  // Dynasty only: fold owned rookie-pick value into the Value column + sort.
  const [includePicks, setIncludePicks] = useState(false);
  // Click any column header to sort by it; default ranks dynasty by value,
  // redraft by projected points.
  const [sortKey, setSortKey] = useState<SortKey>(isDynasty ? 'value' : 'projPts');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const toggleSort = (k: SortKey, defaultDir: 'asc' | 'desc' = 'desc') => {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir(defaultDir); }
  };
  const sortArrow = (k: SortKey) => (sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const thSort: CSSProperties = { cursor: 'pointer', userSelect: 'none' };

  const rows: PowerRow[] = useMemo(() => {
    const dynastyByName = new Map<string, DynastyPlayer>();
    for (const p of dynasty) dynastyByName.set(normalizeForMatch(p.playerName), p);

    const out: PowerRow[] = [];
    for (const t of teams) {
      const players = selectPlayers(t, viewMode, projBySleeperIdMap, rosterPositions);
      const projPts = computeTeamProjPts(players, projBySleeperIdMap);
      const { avgPts, avgAge } = computeStarterAverages(players, projBySleeperIdMap, dynastyByName);
      const pickVal = pickValueByRosterId.get(t.rosterId) ?? 0;
      if (isDynasty) {
        const score = scoreRoster(t, dynasty, isSuperflex);
        if (!score) continue;
        const posStrength = computePositionalStrength(players, dynastyByName, isSuperflex);
        out.push({ team: t, score, posStrength, projPts, avgPts, avgAge, pickVal });
      } else {
        const posStrength = computePositionalProjStrength(players, projBySleeperIdMap);
        out.push({ team: t, score: null, posStrength, projPts, avgPts, avgAge, pickVal });
      }
    }
    return out;
  }, [teams, dynasty, isSuperflex, projBySleeperIdMap, rosterPositions, pickValueByRosterId, viewMode, isDynasty]);

  const sortedRows = useMemo(() => {
    const keyVal = (r: PowerRow): number | string => {
      switch (sortKey) {
        case 'team': return r.team.teamName.toLowerCase();
        case 'owner': return (r.team.owner || '').toLowerCase();
        case 'window': return r.score ? WINDOW_ORDER.indexOf(r.score.label) : 99;
        case 'value': return (r.score?.totalValue ?? 0) + (includePicks ? r.pickVal : 0);
        case 'projPts': return r.projPts;
        case 'avgPts': return r.avgPts;
        case 'avgAge': return r.avgAge;
        case 'qb': return r.posStrength.qb;
        case 'rb': return r.posStrength.rb;
        case 'wr': return r.posStrength.wr;
        case 'te': return r.posStrength.te;
      }
    };
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = keyVal(a);
      const bv = keyVal(b);
      if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * dir;
      return (av - bv) * dir;
    });
  }, [rows, sortKey, sortDir, includePicks]);

  if (!rows.length) return null;

  const maxPos = { qb: 0, rb: 0, wr: 0, te: 0 };
  for (const r of rows) {
    if (r.posStrength.qb > maxPos.qb) maxPos.qb = r.posStrength.qb;
    if (r.posStrength.rb > maxPos.rb) maxPos.rb = r.posStrength.rb;
    if (r.posStrength.wr > maxPos.wr) maxPos.wr = r.posStrength.wr;
    if (r.posStrength.te > maxPos.te) maxPos.te = r.posStrength.te;
  }

  // Dynasty bars carry Dynasty value (thousands); redraft bars carry projected points.
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
      <div className="sched-section-title">League View</div>
      <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '2px 0 8px' }}>
        {isDynasty
          ? 'Positional strength by dynasty value and projected score.'
          : 'Positional strength by projected season points (redraft).'}
      </p>
      <div className="controls" style={{ gap: 6, margin: '8px 0', flexWrap: 'wrap' }}>
        {([['optimal', 'Optimal Lineup'], ['starters', 'Starters Only'], ['starters-plus', 'Starters + Replacements'], ['full', 'Full Roster']] as const).map(([mode, label]) => (
          <button
            key={mode}
            className={`format-tab ${viewMode === mode ? 'active' : ''}`}
            onClick={() => setViewMode(mode)}
            style={{ padding: '3px 10px', fontSize: 11 }}
            title={mode === 'optimal' ? 'Best legal lineup by projected points (ignores Sleeper-set starters)' : undefined}
          >
            {label}
          </button>
        ))}
        {isDynasty && (
          <label style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }} title="Add owned rookie-pick value to each team's dynasty Value">
            <input type="checkbox" checked={includePicks} onChange={(e) => setIncludePicks(e.target.checked)} />
            Include pick value
          </label>
        )}
        <span style={{ marginLeft: 12, fontSize: 11, color: 'var(--text-muted)' }}>Click a column to sort.</span>
      </div>
      <div className="table-container" style={{ maxHeight: 'none' }}>
        <table className="sched-table" style={{ fontSize: 12 }}>
          <thead>
            <tr>
              <th>#</th>
              <th style={thSort} onClick={() => toggleSort('team', 'asc')}>Team{sortArrow('team')}</th>
              <th style={thSort} onClick={() => toggleSort('owner', 'asc')}>Owner{sortArrow('owner')}</th>
              {isDynasty && <>
                <th style={thSort} onClick={() => toggleSort('window', 'asc')}>Window{sortArrow('window')}</th>
                <th style={thSort} onClick={() => toggleSort('value')}>Value{sortArrow('value')}</th>
              </>}
              <th style={thSort} onClick={() => toggleSort('projPts')} title="Projected PPR points (season)">Proj Pts{sortArrow('projPts')}</th>
              <th style={thSort} onClick={() => toggleSort('avgPts')} title="Average projected points per predicted starter">Avg Pts{sortArrow('avgPts')}</th>
              <th style={thSort} onClick={() => toggleSort('avgAge', 'asc')} title="Average age of predicted starters (Dynasty)">Avg Age{sortArrow('avgAge')}</th>
              <th style={thSort} onClick={() => toggleSort('qb')}>QB{sortArrow('qb')}</th>
              <th style={thSort} onClick={() => toggleSort('rb')}>RB{sortArrow('rb')}</th>
              <th style={thSort} onClick={() => toggleSort('wr')}>WR{sortArrow('wr')}</th>
              <th style={thSort} onClick={() => toggleSort('te')}>TE{sortArrow('te')}</th>
              {isDynasty && <th style={{ width: 90 }}>Age Dist</th>}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((r, i) => (
              <tr
                key={r.team.rosterId}
                onClick={() => onSelect(r.team.rosterId)}
                style={{ cursor: 'pointer', background: r.team.rosterId === selected ? 'var(--bg-tertiary)' : undefined }}
              >
                <td className="rank-cell">{i + 1}</td>
                <td><strong>{r.team.teamName}</strong></td>
                <td>
                  <button
                    style={{ background: 'none', border: 'none', color: '#6366f1', cursor: 'pointer', padding: 0, font: 'inherit', fontSize: 'inherit' }}
                    title="View in User Snooper"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (r.team.owner && r.team.owner !== '—' && onNavigate) {
                        localStorage.setItem('sleeper_snoop_user', r.team.owner);
                        onNavigate('sleeper-snooper');
                      }
                    }}
                  >
                    {r.team.owner}
                  </button>
                </td>
                {isDynasty && r.score && (
                  <>
                    <td style={{ color: windowColor(r.score.label), fontWeight: 600 }}>{r.score.label}</td>
                    <td title={includePicks ? `Roster ${r.score.totalValue.toLocaleString()} + picks ${r.pickVal.toLocaleString()}` : undefined}>
                      {(r.score.totalValue + (includePicks ? r.pickVal : 0)).toLocaleString()}
                    </td>
                  </>
                )}
                <td style={{ fontWeight: 600 }}>{r.projPts > 0 ? r.projPts.toFixed(0) : '—'}</td>
                <td>{r.avgPts > 0 ? r.avgPts.toFixed(1) : '—'}</td>
                <td>{r.avgAge > 0 ? r.avgAge.toFixed(1) : '—'}</td>
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
  const [players, setPlayers] = useState<ConsensusPlayer[]>([]);
  const [trending, setTrending] = useState<SleeperTrendingRow[]>([]);
  const [posFilter, setPosFilter] = useState<string>('ALL');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!expanded || loaded) return;
    setLoaded(true);
    Promise.all([
      fetchLeagueRosteredIds(leagueId),
      loadBlendedProjections(),
      fetchSleeperTrending('add', 24, 75).catch(() => [] as SleeperTrendingRow[]),
    ]).then(([ids, proj, trend]) => {
      setRosteredIds(ids);
      setPlayers(proj);
      setTrending(trend);
    });
  }, [expanded, loaded, leagueId]);

  const waiverPicks = useMemo(() => {
    if (!players.length || !rosteredIds.size) return [];
    const out: (ConsensusPlayer & { pprPts: number })[] = [];
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
                        <td><strong><PlayerName sleeperId={w.sleeperId} name={w.name} position={w.position} /></strong></td>
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
                        <td><strong><PlayerName sleeperId={t.player_id} name={t.full_name} position={t.position} /></strong></td>
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

// ── Suggested Waiver Moves (add/drop for the selected team) ──

interface WaiverMove {
  add: ConsensusPlayer;
  addProj: number; addValue: number; addTrend: number | null;
  drop: RosterPlayer;
  dropProj: number; dropValue: number;
  gain: number; // improvement in the league-appropriate metric
}

interface WaiverSuggestionsProps {
  leagueId: string;
  team: LeagueTeam;
  projMap: Map<string, number>;
  blendedByName: Map<string, DynastyPlayer>;
  trendByName: Map<string, number>;
  allProjections: ConsensusPlayer[];
  isDynasty: boolean;
  isSuperflex: boolean;
}

const SKILL_POS = ['QB', 'RB', 'WR', 'TE'];

function WaiverSuggestionsSection({ leagueId, team, projMap, blendedByName, trendByName, allProjections, isDynasty, isSuperflex }: WaiverSuggestionsProps) {
  const [expanded, setExpanded] = useState(false);
  const [rosteredIds, setRosteredIds] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!expanded || loaded) return;
    setLoaded(true);
    fetchLeagueRosteredIds(leagueId).then(setRosteredIds).catch(() => {});
  }, [expanded, loaded, leagueId]);

  // Nickname axis (Chig/Chigoziem, Kenny/Kenneth): unambiguous last-name +
  // first-initial fallback for names the exact key can't reach.
  const dynastyFallback = useMemo(
    () => buildFallbackIndex(blendedByName.values(), (p) => p.playerName),
    [blendedByName],
  );

  const { moves, unvalued } = useMemo<{ moves: WaiverMove[]; unvalued: string[] }>(() => {
    if (!rosteredIds.size) return { moves: [], unvalued: [] };
    const dynPlayer = (name: string): DynastyPlayer | undefined =>
      blendedByName.get(normalizeForMatch(name)) ?? dynastyFallback.get(fallbackNameKey(name)) ?? undefined;
    // null = we have no value for this player, which is NOT the same as a
    // value of zero. Coercing the two together is what let a name-join miss
    // (Dynasty's "Kenneth Walker III" vs the roster's "Kenneth Walker") sort
    // a starting RB to the front of the drop list and advertise the pickup's
    // full value as the "gain".
    const dynVal = (name: string): number | null => {
      const k = dynPlayer(name);
      if (!k) return null;
      const v = isSuperflex ? k.superflexValue : k.value;
      return v > 0 ? v : null;
    };
    // Redraft mode carries the same rule: a player absent from the projection
    // map is unpriced, not a zero-point player, so he is set aside rather
    // than offered as the drop.
    const rosterMetric = (p: RosterPlayer): number | null =>
      isDynasty ? dynVal(p.name) : (projMap.get(p.id) ?? null);
    const availMetric = (p: ConsensusPlayer): number | null =>
      isDynasty ? dynVal(p.name) : (projMap.get(p.sleeperId ?? '') ?? null);

    // Drop candidates: this team's skill players, worst-first. A player we
    // can't price is set aside and named below the table rather than ranked
    // as worthless — an unpriced player is one we have no opinion on, and
    // "no opinion" must never render as a confident upgrade.
    const rosterAll = [...team.starters, ...team.bench]
      .filter((p) => p.name !== 'Empty' && SKILL_POS.includes(p.position || ''))
      .map((p) => ({ p, m: rosterMetric(p) }));
    const skipped = rosterAll.filter((x) => x.m == null).map((x) => x.p.name);
    const roster = rosterAll
      .filter((x): x is { p: RosterPlayer; m: number } => x.m != null)
      .sort((a, b) => a.m - b.m);

    // Add candidates: unrostered projected players, best-first by metric.
    const avail = allProjections
      .filter((p) => p.sleeperId && !rosteredIds.has(p.sleeperId) && SKILL_POS.includes(p.position))
      .map((p) => ({ p, m: availMetric(p) }))
      .filter((x): x is { p: ConsensusPlayer; m: number } => x.m != null && x.m > 0)
      .sort((a, b) => b.m - a.m);

    const minGain = isDynasty ? 400 : 12; // Dynasty value vs projected points
    const usedDrop = new Set<string>();
    const out: WaiverMove[] = [];
    for (const a of avail) {
      // Same-position swap keeps roster counts balanced: drop your worst at that
      // position if the pickup clearly beats them.
      const drop = roster.find((d) => d.p.position === a.p.position && !usedDrop.has(d.p.id));
      if (!drop || a.m - drop.m < minGain) continue;
      usedDrop.add(drop.p.id);
      out.push({
        add: a.p,
        addProj: projMap.get(a.p.sleeperId ?? '') ?? 0,
        addValue: dynVal(a.p.name) ?? 0,
        addTrend: trendByName.get(normalizeForMatch(a.p.name)) ?? null,
        drop: drop.p,
        dropProj: projMap.get(drop.p.id) ?? 0,
        dropValue: dynVal(drop.p.name) ?? 0,
        gain: a.m - drop.m,
      });
      if (out.length >= 8) break;
    }
    return { moves: out, unvalued: skipped };
  }, [rosteredIds, team, projMap, blendedByName, dynastyFallback, trendByName, allProjections, isDynasty, isSuperflex]);

  const fmtVal = (v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`;
  const fmtGain = (g: number) => isDynasty ? `+${fmtVal(g)}` : `+${g.toFixed(0)} pt`;

  return (
    <div style={{ margin: '16px 0' }}>
      <div className="sched-section-title" style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => setExpanded(!expanded)}>
        <span style={{ display: 'inline-block', width: 16, fontSize: 10 }}>{expanded ? '▼' : '▶'}</span>
        Suggested Waiver Moves — {team.teamName}
      </div>
      {!expanded && (
        <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '2px 0 0', cursor: 'pointer' }} onClick={() => setExpanded(true)}>
          Click for add/drop upgrades that raise your {isDynasty ? 'dynasty value' : 'projected points'}.
        </p>
      )}
      {expanded && (
        <>
          <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '2px 0 8px' }}>
            Pick up an available player and drop your weakest at that position, ranked by {isDynasty ? `dynasty value${isSuperflex ? ' (SF)' : ''}` : 'projected season points'}.
          </p>
          {loaded && unvalued.length > 0 && (
            <p style={{ color: '#fbbf24', fontSize: 11, margin: '0 0 8px' }}>
              No {isDynasty ? 'dynasty value' : 'projection'} on file for {unvalued.join(', ')} — left out of
              the drop candidates rather than ranked as worthless. Decide those yourself.
            </p>
          )}
          {!loaded ? (
            <div className="loading" style={{ padding: '8px 0' }}><div className="spinner" /><span className="loading-text">Scanning waivers…</span></div>
          ) : moves.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>No clear upgrades on waivers right now.</p>
          ) : (
            <div className="table-container" style={{ maxHeight: 'none' }}>
              <table className="sched-table" style={{ fontSize: 12 }}>
                <thead>
                  <tr><th>Add</th><th>Drop</th><th title="Improvement in the ranking metric">Gain</th></tr>
                </thead>
                <tbody>
                  {moves.map((m, i) => (
                    <tr key={i}>
                      <td>
                        <span className={`pos-badge pos-${m.add.position}`} style={{ marginRight: 4 }}>{m.add.position}</span>
                        <strong><PlayerName sleeperId={m.add.sleeperId} name={m.add.name} position={m.add.position} /></strong>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                          {m.addProj > 0 && <span style={{ color: '#6366f1' }}>{m.addProj.toFixed(0)}pt</span>}
                          {m.addValue > 0 && <> · {fmtVal(m.addValue)}</>}
                          {m.addTrend != null && m.addTrend !== 0 && <span style={{ color: m.addTrend > 0 ? '#22c55e' : '#ef4444' }}> · {m.addTrend > 0 ? '+' : ''}{m.addTrend.toLocaleString()}</span>}
                        </div>
                      </td>
                      <td>
                        <span className={`pos-badge pos-${m.drop.position}`} style={{ marginRight: 4 }}>{m.drop.position}</span>
                        <PlayerName sleeperId={m.drop.id} name={m.drop.name} position={m.drop.position} />
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                          {m.dropProj > 0 && <span>{m.dropProj.toFixed(0)}pt</span>}
                          {m.dropValue > 0 && <> · {fmtVal(m.dropValue)}</>}
                        </div>
                      </td>
                      <td style={{ fontWeight: 700, color: '#22c55e', whiteSpace: 'nowrap' }}>{fmtGain(m.gain)}</td>
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

// ── Win-Win Trade Suggestions ──

function scoreColor(score: number): string {
  if (score >= 80) return '#22c55e';
  if (score >= 65) return '#a3e635';
  if (score >= 50) return '#f59e0b';
  return '#ef4444';
}

// Dynasty assets are priced in Dynasty value (thousands); redraft assets in
// projected season points.
const fmtAssetValue = (v: number, isDynasty: boolean) =>
  isDynasty ? `${(v / 1000).toFixed(1)}k` : `${v.toFixed(0)} pts`;

function TradeAssetCard({ a, isDynasty }: { a: TradeAsset; isDynasty: boolean }) {
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
        {(isDynasty || !a.projStats) && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{fmtAssetValue(a.value, isDynasty)}</span>}
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

function TradeCard({ s, isDynasty }: { s: TradeSuggestion; isDynasty: boolean }) {
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
          {s.teamA.gives.map((a) => <TradeAssetCard key={a.name} a={a} isDynasty={isDynasty} />)}
          <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-muted)' }}>
            Total: {fmtAssetValue(result.givesTotal, isDynasty)}
          </div>
        </div>
        <div>
          <div style={{ color: 'var(--text-muted)', fontSize: 10, marginBottom: 3 }}>You get:</div>
          {s.teamA.receives.map((a) => <TradeAssetCard key={a.name} a={a} isDynasty={isDynasty} />)}
          <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-muted)' }}>
            Total: {fmtAssetValue(result.receivesTotal, isDynasty)}
            {result.net !== 0 && (
              <span style={{ color: result.net >= 0 ? '#22c55e' : '#ef4444', marginLeft: 6, fontWeight: 600 }}>
                ({result.net >= 0 ? '+' : '−'}{fmtAssetValue(Math.abs(result.net), isDynasty)})
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
  dynasty: DynastyPlayer[];
  pickOwnership: Map<number, DraftPick[]>;
  myRosterId?: number;
  myTeamName?: string;
  projBySleeperIdMap: Map<string, number>;
  projStatsMap: Map<string, TradeAssetStats>;
  lastSeasonMap: Map<string, { pts: number; posRank: number }>;
  isDynasty: boolean;
  isSuperflex: boolean;
}

function TradeSuggestionsSection({ teams, dynasty, pickOwnership, myRosterId, myTeamName, projBySleeperIdMap, projStatsMap, lastSeasonMap, isDynasty, isSuperflex }: TradeSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const [goals, setGoals] = useState<Map<number, TradeGoal>>(new Map());
  const [suggestions, setSuggestions] = useState<TradeSuggestion[]>([]);
  const [loading, setLoading] = useState(false);

  const myGoal = goals.get(myRosterId ?? -1) ?? 'balanced';

  const [generated, setGenerated] = useState(false);

  const doGenerate = async () => {
    setLoading(true);
    try {
      const results = generateTradeSuggestions(teams, dynasty, goals, pickOwnership, myRosterId, projBySleeperIdMap, 6, projStatsMap, lastSeasonMap, !isDynasty, isSuperflex);
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
              ? `Trades consider dynasty value${isSuperflex ? ' (Superflex)' : ''}, age, positional needs, and 2027–2028 draft picks (slotted by projected finish and priced by league size). Your top assets are protected.`
              : 'Trades consider projected season points (league scoring) and positional needs. Your top assets are protected.'}
          </p>

          {!isDynasty && (
            <div style={{
              margin: '4px 0 10px', padding: '8px 12px', fontSize: 11, lineHeight: 1.5,
              background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)',
              borderRadius: 6, color: 'var(--text-secondary)',
            }}>
              <b style={{ color: '#f59e0b' }}>Redraft league.</b> There's no future beyond this season, so the win-now/rebuild
              framework and rookie-pick assets don't apply. Trades are valued, matched, and scored on this season's
              <b> projected points</b> (shown on every player) rather than long-term dynasty value.
            </div>
          )}

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
              {suggestions.map((s, i) => <TradeCard key={`${i}-${s.teamB.rosterId}`} s={s} isDynasty={isDynasty} />)}
            </div>
          )}

          {!loading && generated && suggestions.length === 0 && (
            <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 8 }}>
              No viable 2-3 player trades found. Try {isDynasty ? 'changing your goal or ' : ''}selecting a different team.
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

// Owned future rookie picks for a single roster, slotted + priced by projected
// draft order. Picks acquired via trade are flagged with their original team.
// Rendered inside the roster's Bench column to use the empty space there.
function RosterPicks({ picks, teamNamesByRosterId, rosterId }: {
  picks: DraftPick[];
  teamNamesByRosterId: Map<number, string>;
  rosterId: number;
}) {
  if (!picks.length) return null;
  const sorted = [...picks].sort(
    (a, b) => a.season.localeCompare(b.season) || a.round - b.round || (a.projectedSlot ?? 99) - (b.projectedSlot ?? 99),
  );
  const total = sorted.reduce((s, p) => s + (p.value ?? 0), 0);
  return (
    <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--bg-tertiary)' }}>
      <div className="sl-col-head" title="2027–2028 rookie picks, slotted by projected finish">
        Draft Picks · {(total / 1000).toFixed(1)}k
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
        {sorted.map((pk, i) => {
          const acquired = pk.originalOwnerId !== rosterId;
          const viaName = acquired ? teamNamesByRosterId.get(pk.originalOwnerId) : null;
          const label = pk.projectedSlot != null
            ? `${pk.season} ${pk.round}.${String(pk.projectedSlot).padStart(2, '0')}`
            : `${pk.season} Rd ${pk.round}`;
          return (
            <div
              key={`${pk.season}-${pk.round}-${pk.originalOwnerId}-${i}`}
              title={viaName ? `Acquired from ${viaName}` : undefined}
              style={{
                padding: '2px 8px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                borderRadius: 6, fontSize: 11, whiteSpace: 'nowrap',
              }}
            >
              <span style={{ fontWeight: 600 }}>{label}</span>
              {pk.value != null && <span style={{ color: 'var(--text-muted)', marginLeft: 5 }}>{(pk.value / 1000).toFixed(1)}k</span>}
              {viaName && <span style={{ color: '#f59e0b', marginLeft: 5 }}>↤</span>}
            </div>
          );
        })}
      </div>
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
  const [standingsExpanded, setStandingsExpanded] = useState(false);
  const [matchups, setMatchups] = useState<MatchupsByKey>(new Map());
  const [teamProj, setTeamProj] = useState<TeamProjByTeam | null>(null);
  const [dynasty, setDynasty] = useState<DynastyPlayer[]>([]);
  const [blended, setBlended] = useState<DynastyPlayer[]>([]); // blended dynasty value (Dynasty→FC scale)
  const [fcTrend, setFcTrend] = useState<DynastyPlayer[]>([]); // FantasyCalc, for 30-day value trend
  const [allProjections, setAllProjections] = useState<ConsensusPlayer[]>([]);
  const [tradedPicks, setTradedPicks] = useState<SleeperTradedPick[]>([]);
  // Optional projection scenario (quick preset or saved) overlaid on proj pts.
  const [projScenarioId, setProjScenarioId] = useState<string>('');
  const projScenarios = useMemo(() => listProjectionScenarios(), []);
  const [presetMeta, setPresetMeta] = useState<PresetMeta>(new Map());
  useEffect(() => {
    let alive = true;
    fetchSleeperPlayers().then((m) => { if (alive) setPresetMeta(buildPresetMeta(m)); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Username → all leagues
  const [username, setUsername] = useState(() => localStorage.getItem(LS_USER_KEY) ?? '');
  const [userLeagues, setUserLeagues] = useState<SleeperLeagueSummary[]>([]);
  const [userLoading, setUserLoading] = useState(false);
  const [userError, setUserError] = useState<string | null>(null);
  // The looked-up user's id — used to default roster/trade views to their team.
  const [lookedUpUserId, setLookedUpUserId] = useState<string | null>(null);
  const lookedUpUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    Promise.all([fetchMatchups(), fetchTeamProjections(), fetchDynastyRankings('1qb')]).then(([m, tp, k]) => {
      setMatchups(m); setTeamProj(tp); setDynasty(k);
    });
    fetchDynastyRankingsForDisplay('1qb').then(setBlended).catch(() => {});
    fetchFantasyCalcRankings('1qb').then(setFcTrend).catch(() => {});
    loadBlendedProjections().then(setAllProjections);
  }, []);

  const lookupUser = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) { setUserError('Enter a Sleeper username.'); return; }
    setUserLoading(true);
    setUserError(null);
    fetchSleeperUser(trimmed)
      .then((u) => { lookedUpUserIdRef.current = u.user_id; setLookedUpUserId(u.user_id); return fetchUserLeagues(u.user_id); })
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
    setTradedPicks([]);
    importLeague(trimmed)
      .then((res) => {
        setData(res);
        // Default to the looked-up user's team; fall back to the standings leader.
        const mine = lookedUpUserIdRef.current
          ? res.teams.find((t) => t.ownerId === lookedUpUserIdRef.current)
          : undefined;
        setSelected(mine?.rosterId ?? res.teams[0]?.rosterId ?? null);
        localStorage.setItem(LS_KEY, trimmed);
      })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setData(null); })
      .finally(() => setLoading(false));
    fetchTradedPicks(trimmed).then(setTradedPicks).catch(() => setTradedPicks([]));
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

  // When a league loads (or the looked-up user resolves after it), center the
  // roster + trade views on that user's team. Only fires on load — manual team
  // selection afterward sticks since neither dependency changes.
  useEffect(() => {
    if (!data || !lookedUpUserId) return;
    const mine = data.teams.find((t) => t.ownerId === lookedUpUserId);
    if (mine) setSelected(mine.rosterId);
  }, [data, lookedUpUserId]);

  const scoring = data?.league.scoring_settings ?? {};
  const isDynasty = isDynastyLeague(data?.league);
  const isSuperflex = useMemo(() => {
    const pos = data?.league.roster_positions ?? [];
    return pos.includes('SUPER_FLEX') || pos.filter((p) => p === 'QB').length >= 2;
  }, [data]);

  // Power rankings + Win-Now/Rebuild scoring run on the same blended (FC-scale)
  // values shown per-player, falling back to raw Dynasty only if the rescaled list
  // failed to load. SF awareness is handled downstream via isSuperflex.
  const powerDynasty = useMemo(() => (blended.length ? blended : dynasty), [blended, dynasty]);

  // Blended dynasty value + FantasyCalc 30-day trend, keyed by normalized name.
  const blendedByName = useMemo(() => {
    const m = new Map<string, DynastyPlayer>();
    for (const k of blended) m.set(normalizeForMatch(k.playerName), k);
    return m;
  }, [blended]);
  const trendByName = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of fcTrend) if (p.trend30Day != null) m.set(normalizeForMatch(p.playerName), p.trend30Day);
    return m;
  }, [fcTrend]);
  const playerStat = (p: RosterPlayer): { proj?: number; value?: number; trend?: number | null } => {
    const k = blendedByName.get(normalizeForMatch(p.name));
    return {
      proj: projBySleeperIdMap.get(p.id),
      value: k ? (isSuperflex ? k.superflexValue : k.value) : undefined,
      trend: trendByName.get(normalizeForMatch(p.name)) ?? null,
    };
  };

  const projBySleeperIdMap = useMemo(() => {
    const map = new Map<string, number>();
    const hasCustomScoring = Object.keys(scoring).length > 0;
    // Scenario-adjusted PPR by name (null when no scenario selected). Custom
    // scoring leagues keep their own scoring (scenario reshapes PPR only).
    const adjByName = hasCustomScoring ? null : buildScenarioPprByName(allProjections, projScenarioId, presetMeta);
    for (const p of allProjections) {
      if (!p.sleeperId) continue;
      const base = hasCustomScoring ? computeCustomScore(p, scoring) : computePpr(p);
      const adj = adjByName?.get(normalizeForMatch(p.name));
      map.set(p.sleeperId, adj ?? base);
    }
    return map;
  }, [allProjections, scoring, projScenarioId, presetMeta]);

  // Total projected season points per roster — drives projected draft order
  // (weakest team picks first) for pick valuation.
  const projPointsByRosterId = useMemo(() => {
    const map = new Map<number, number>();
    if (!data) return map;
    for (const t of data.teams) {
      let sum = 0;
      for (const p of [...t.starters, ...t.bench]) sum += projBySleeperIdMap.get(p.id) ?? 0;
      map.set(t.rosterId, sum);
    }
    return map;
  }, [data, projBySleeperIdMap]);

  // Each roster's owned future rookie picks, slotted + priced by projected draft
  // order and league size. Dynasty only — redraft leagues carry no rookie picks.
  const pickOwnership = useMemo(() => {
    const merged = new Map<number, DraftPick[]>();
    if (!data || !isDynasty) return merged;
    for (const season of ['2027', '2028']) {
      const m = buildPickOwnership(data.teams, tradedPicks, season, projPointsByRosterId);
      for (const [rid, picks] of m) {
        if (!merged.has(rid)) merged.set(rid, []);
        merged.get(rid)!.push(...picks);
      }
    }
    return merged;
  }, [data, isDynasty, tradedPicks, projPointsByRosterId]);

  // Total dynasty value of each roster's owned rookie picks (for the optional
  // "include pick value" toggle in the power rankings Value column).
  const pickValueByRosterId = useMemo(() => {
    const m = new Map<number, number>();
    for (const [rid, picks] of pickOwnership) {
      m.set(rid, picks.reduce((s, p) => s + (p.value ?? 0), 0));
    }
    return m;
  }, [pickOwnership]);

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

  const [lastSeasonData, setLastSeasonData] = useState<ConsensusPlayer[]>([]);
  useEffect(() => {
    Promise.all([
      fetch(bust(`${import.meta.env.BASE_URL}data/clay-projections-2025.json`)),
      fetch(bust(`${import.meta.env.BASE_URL}data/player-crosswalk.json`)),
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

  const teamNamesByRosterId = useMemo(() => {
    const map = new Map<number, string>();
    for (const t of data?.teams ?? []) map.set(t.rosterId, t.teamName);
    return map;
  }, [data]);

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
              <thead><tr><th>League</th><th>Format</th><th>Season</th><th>Teams</th><th>Status</th><th /></tr></thead>
              <tbody>
                {userLeagues.map((l) => (
                  <tr key={l.league_id} style={{ cursor: 'pointer', background: l.league_id === leagueId ? 'var(--bg-tertiary)' : undefined }} onClick={() => selectLeague(l.league_id)}>
                    <td><strong>{l.name}</strong></td>
                    <td><LeagueFormatBadges info={leagueFormatInfo(l)} /></td>
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
            {' '}<LeagueFormatBadges info={leagueFormatInfo(data.league)} />
            <br />Roster: {rosterFormat(data.league.roster_positions)}
          </p>

          {powerDynasty.length > 0 && (
            <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '8px 0 0' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Projection scenario:</span>
              {projScenarios.length > 0 ? (
                <select
                  value={projScenarioId}
                  onChange={(e) => setProjScenarioId(e.target.value)}
                  style={{ fontSize: 11, padding: '2px 6px', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6 }}
                >
                  <option value="">None (Consensus)</option>
                  {projScenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              ) : (
                <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>none saved — build one in Projections → Scenario Builder</span>
              )}
            </div>
            <LeaguePowerRankings
              teams={data.teams}
              dynasty={powerDynasty}
              isSuperflex={isSuperflex}
              projBySleeperIdMap={projBySleeperIdMap}
              rosterPositions={data.league.roster_positions ?? []}
              pickValueByRosterId={pickValueByRosterId}
              isDynasty={isDynasty}
              selected={selected}
              onSelect={setSelected}
              onNavigate={onNavigate}
            />
            </>
          )}

          <div className="sched-section-title" style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => setStandingsExpanded(!standingsExpanded)}>
            <span style={{ display: 'inline-block', width: 16, fontSize: 10 }}>{standingsExpanded ? '▼' : '▶'}</span>
            Standings
          </div>
          {standingsExpanded && (
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
          )}

          <LeagueWaiverSection leagueId={data.league.league_id} />

          {dynasty.length > 0 && (
            <TradeSuggestionsSection
              teams={data.teams}
              dynasty={dynasty}
              pickOwnership={pickOwnership}
              myRosterId={selected ?? undefined}
              myTeamName={selectedTeam?.teamName}
              projBySleeperIdMap={projBySleeperIdMap}
              projStatsMap={projStatsMap}
              lastSeasonMap={lastSeasonMap}
              isDynasty={isDynasty}
              isSuperflex={isSuperflex}
            />
          )}

          {selectedTeam && (
            <>
              <div className="sched-section-title" style={{ marginTop: 16 }}>
                Roster — {selectedTeam.teamName} <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 11 }}>(click a team above to switch)</span>
              </div>
              {isDynasty && powerDynasty.length > 0 && (() => { const s = scoreRoster(selectedTeam, powerDynasty, isSuperflex); return s ? <WindowBadge score={s} /> : null; })()}

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
                            <td><strong><PlayerName sleeperId={s.player.sleeperId} name={s.player.name} position={s.player.position} /></strong></td>
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

              <WaiverSuggestionsSection
                leagueId={data.league.league_id}
                team={selectedTeam}
                projMap={projBySleeperIdMap}
                blendedByName={blendedByName}
                trendByName={trendByName}
                allProjections={allProjections}
                isDynasty={isDynasty}
                isSuperflex={isSuperflex}
              />

              <div style={{ fontSize: 10, color: 'var(--text-muted)', margin: '2px 0 4px' }}>
                Per player: <span style={{ color: '#6366f1' }}>projected pts</span> · dynasty value{isSuperflex ? ' (SF)' : ''} · <span style={{ color: '#22c55e' }}>30-day trend</span>
              </div>
              <div className="sl-roster-grid">
                <div className="sl-roster-col">
                  <div className="sl-col-head">Starters</div>
                  {selectedTeam.starters.map((p, i) => <PlayerLine key={`s${i}`} p={p} {...playerStat(p)} />)}
                </div>
                <div className="sl-roster-col">
                  <div className="sl-col-head">Bench</div>
                  {selectedTeam.bench.length ? selectedTeam.bench.map((p, i) => <PlayerLine key={`b${i}`} p={p} {...playerStat(p)} />)
                    : <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '6px 0' }}>No bench players.</div>}
                  {isDynasty && (
                    <RosterPicks
                      picks={pickOwnership.get(selectedTeam.rosterId) ?? []}
                      teamNamesByRosterId={teamNamesByRosterId}
                      rosterId={selectedTeam.rosterId}
                    />
                  )}
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
