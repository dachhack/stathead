import { useEffect, useMemo, useState } from 'react';
import { fetchNflSchedule, computeSOS, makeStrengthIndex, makeUnitStrengthIndex, matchupFor, computeUnitSOS, DEF_UNIT_GROUPS, SCHEDULE_SEASON, type ScheduleByTeam, type TeamSOS, type SchedGame, type UnitGradesByTeam, type MatchupsByKey, type TeamProjByTeam, type DefUnitKey, type UnitSOS } from '../lib/nflSchedule';
import { teamLogoUrl } from '../lib/teamLogo';
import { NFL_DIVISIONS, TEAM_ORDER, divisionOf } from '../lib/divisions';

function fmtKick(iso: string): string {
  if (!iso) return 'TBD';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'TBD';
  return d.toLocaleString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Rank 1 = hardest. Red (hard) → green (easy).
function rankColor(rank: number): string {
  if (!rank) return 'var(--text-muted)';
  if (rank <= 8) return '#ef4444';
  if (rank <= 16) return '#f59e0b';
  if (rank <= 24) return '#a3e635';
  return '#22c55e';
}

// 0–100 strength index: higher = tougher matchup (red), lower = easier (green).
function idxColor(idx: number): string {
  if (idx >= 67) return '#ef4444';
  if (idx >= 50) return '#f59e0b';
  if (idx >= 33) return '#a3e635';
  return '#22c55e';
}

function TeamLogo({ team, size = 22 }: { team: string; size?: number }) {
  return <img src={teamLogoUrl(team)} alt="" width={size} height={size} style={{ objectFit: 'contain', verticalAlign: 'middle' }} onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />;
}

function SosCard({ label, rank, idx }: { label: string; rank: number; idx: number }) {
  return (
    <div className="sched-sos-card">
      <div className="sched-sos-label">{label}</div>
      <div className="sched-sos-rank" style={{ color: rankColor(rank) }}>#{rank || '—'}</div>
      <div className="sched-sos-sub">of 32 · avg opp {idx.toFixed(1)}</div>
    </div>
  );
}

function GameRow({ g, strengthIdx, proj, unitIdx }: {
  g: SchedGame;
  strengthIdx: (team: string) => number;
  proj: { teamPts: number; oppPts: number; winProb: number } | null;
  unitIdx?: { key: string; fn: (team: string) => number | null }[];
}) {
  const isReg = g.seasonType === 2;
  return (
    <tr>
      <td className="sched-wk">{g.seasonType === 1 ? `P${g.week}` : g.week}</td>
      <td className="sched-opp">
        <span className="sched-vs">{g.home ? 'vs' : '@'}</span>
        <TeamLogo team={g.opp} size={20} />
        <span className="sched-opp-code">{g.opp}</span>
      </td>
      <td>{fmtKick(g.date)}</td>
      <td className="sched-loc">{g.venue}{g.city ? ` · ${g.city}` : ''}</td>
      <td className="sched-net">{g.network || '—'}</td>
      <td className="sched-proj">
        {proj ? (
          <>
            <span className={proj.teamPts >= proj.oppPts ? 'stat-positive' : ''}>{proj.teamPts.toFixed(1)}</span>
            <span style={{ color: 'var(--text-muted)' }}>–{proj.oppPts.toFixed(1)}</span>
            {' '}<span style={{ color: rankColor(proj.winProb >= 50 ? 8 : 28) }}>{proj.winProb}%</span>
          </>
        ) : ''}
      </td>
      <td className="sched-strength" style={{ color: rankColor(0) }}>{isReg ? strengthIdx(g.opp) : ''}</td>
      {unitIdx?.map(({ key, fn }) => {
        const v = isReg ? fn(g.opp) : null;
        return (
          <td key={key} style={{ textAlign: 'center', color: v == null ? 'var(--text-muted)' : idxColor(v), fontWeight: 600 }}>
            {v == null ? '' : v}
          </td>
        );
      })}
    </tr>
  );
}

export function ScheduleView() {
  const [byTeam, setByTeam] = useState<ScheduleByTeam | null>(null);
  const [sos, setSos] = useState<Record<string, TeamSOS>>({});
  const [grades, setGrades] = useState<UnitGradesByTeam | null>(null);
  const [matchups, setMatchups] = useState<MatchupsByKey>(new Map());
  const [teamProj, setTeamProj] = useState<TeamProjByTeam | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [team, setTeam] = useState('BUF');

  useEffect(() => {
    let cancelled = false;
    fetchNflSchedule()
      .then(({ byTeam, grades, matchups, teamProj }) => {
        if (cancelled) return;
        const teams = Object.keys(byTeam);
        if (!teams.length) { setError('No schedule returned. ESPN may be unreachable right now.'); setLoading(false); return; }
        setByTeam(byTeam); setGrades(grades); setMatchups(matchups); setTeamProj(teamProj);
        setSos(computeSOS(byTeam, grades)); setLoading(false);
      })
      .catch((e: unknown) => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const teamsPresent = useMemo(() => new Set(byTeam ? Object.keys(byTeam) : []), [byTeam]);
  const strengthIdx = useMemo(() => makeStrengthIndex(grades), [grades]);
  // Per-game opponent sub-unit strength index (D-Line / LB / Secondary).
  const unitIdx = useMemo(
    () => DEF_UNIT_GROUPS.map((u) => ({ key: u.key, fn: makeUnitStrengthIndex(grades, u.units) })),
    [grades],
  );
  // Season SOS broken down by defensive sub-unit (avg opp grade + rank).
  const unitSos = useMemo(() => (byTeam ? computeUnitSOS(byTeam, grades) : {}), [byTeam, grades]);
  const cycle = (dir: number) => {
    const i = TEAM_ORDER.indexOf(team);
    setTeam(TEAM_ORDER[(i + dir + TEAM_ORDER.length) % TEAM_ORDER.length]);
  };

  const sched = byTeam?.[team];
  const s = sos[team];

  return (
    <div className="sched-page">
      <div className="sched-header">
        <h2 style={{ margin: 0, fontSize: 18 }}>{SCHEDULE_SEASON} Schedule &amp; Strength of Schedule</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 0' }}>
          Live from ESPN. SOS uses each opponent&apos;s {grades ? 'Consensus defense grade' : 'projected offensive strength'} (reg. season only). Rank #1 = hardest.
        </p>
      </div>

      {loading && <div className="loading"><div className="spinner" /><div className="loading-text">Loading {SCHEDULE_SEASON} schedule…</div></div>}
      {error && <div className="empty-state"><h3>Schedule unavailable</h3><p>{error}</p></div>}

      {!loading && !error && byTeam && (
        <>
          <div className="sched-controls">
            <button className="se-cycle" onClick={() => cycle(-1)} aria-label="previous team">◀</button>
            <TeamLogo team={team} size={28} />
            <select className="scenario-select" value={team} onChange={(e) => setTeam(e.target.value)}>
              {NFL_DIVISIONS.map((d) => {
                const present = d.teams.filter((c) => teamsPresent.has(c));
                if (!present.length) return null;
                return <optgroup key={d.name} label={d.name}>{present.map((c) => <option key={c} value={c}>{c}</option>)}</optgroup>;
              })}
            </select>
            <button className="se-cycle" onClick={() => cycle(1)} aria-label="next team">▶</button>
            <span className="sched-div">{divisionOf(team)}</span>
          </div>

          {s && (
            <div className="sched-sos-row">
              <SosCard label="Overall SOS" rank={s.overallRank} idx={s.overall} />
              <SosCard label="Weeks 1–6" rank={s.t1Rank} idx={s.t1} />
              <SosCard label="Weeks 7–12" rank={s.t2Rank} idx={s.t2} />
              <SosCard label="Weeks 13–18" rank={s.t3Rank} idx={s.t3} />
            </div>
          )}

          {grades && unitSos[team] && (
            <div className="sched-sos-row">
              {DEF_UNIT_GROUPS.map((u) => {
                const us: UnitSOS | undefined = unitSos[team][u.key as DefUnitKey];
                return us ? <SosCard key={u.key} label={`Opp ${u.label}`} rank={us.rank} idx={us.idx} /> : null;
              })}
            </div>
          )}

          {teamProj?.[team] && (() => {
            const tp = teamProj[team];
            return (
              <div className="sched-proj-strip">
                <span><b>Consensus team outlook</b></span>
                <span>Proj wins <b>{tp.proj_wins.toFixed(1)}</b> <span className="sched-rk">#{tp.wins_rank}</span></span>
                <span>PF <b>{tp.points_for}</b> / PA <b>{tp.points_against}</b></span>
                <span>Off <span className="sched-rk">#{tp.off_rk}</span> · Def <span className="sched-rk">#{tp.def_rk}</span> · Ovr <span className="sched-rk">#{tp.ovr_rk}</span></span>
              </div>
            );
          })()}

          <div className="sched-section-title">Regular season</div>
          <div className="table-container" style={{ maxHeight: 'none' }}>
            <table className="sched-table">
              <thead><tr><th>Wk</th><th>Opponent</th><th>Date / Time</th><th>Location</th><th>Network</th><th title="Consensus projected score (team–opp) and win probability">Proj</th><th title={`Opponent ${grades ? 'defense' : 'offensive'} strength index (0–100, higher = tougher)`}>Opp</th>{grades && DEF_UNIT_GROUPS.map((u) => <th key={u.key} title={`Opponent ${u.label} strength index (0–100, higher = tougher) — ${u.hint}`}>{u.label}</th>)}</tr></thead>
              <tbody>
                {sched && sched.reg.length > 0
                  ? sched.reg.map((g, i) => <GameRow key={`r${i}`} g={g} strengthIdx={strengthIdx} proj={matchupFor(matchups, g.week, team, g.opp, g.home)} unitIdx={grades ? unitIdx : undefined} />)
                  : <tr><td colSpan={grades ? 10 : 7} className="sched-empty">No regular-season games found.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="sched-section-title">Preseason <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 11 }}>— rookies' first looks on their new teams</span></div>
          <div className="table-container" style={{ maxHeight: 'none' }}>
            <table className="sched-table">
              <thead><tr><th>Wk</th><th>Opponent</th><th>Date / Time</th><th>Location</th><th>Network</th><th /><th /></tr></thead>
              <tbody>
                {sched && sched.pre.length > 0
                  ? sched.pre.map((g, i) => <GameRow key={`p${i}`} g={g} strengthIdx={strengthIdx} proj={null} />)
                  : <tr><td colSpan={7} className="sched-empty">No preseason games found.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
