import { useEffect, useMemo, useState } from 'react';
import { fetchNflSchedule, computeSOS, teamStrengthIndex, SCHEDULE_SEASON, type ScheduleByTeam, type TeamSOS, type SchedGame } from '../lib/nflSchedule';
import { teamLogoUrl } from '../lib/teamLogo';

const NFL_DIVISIONS: [string, string[]][] = [
  ['AFC East', ['BUF', 'MIA', 'NE', 'NYJ']],
  ['AFC North', ['BAL', 'CIN', 'CLE', 'PIT']],
  ['AFC South', ['HOU', 'IND', 'JAX', 'TEN']],
  ['AFC West', ['DEN', 'KC', 'LV', 'LAC']],
  ['NFC East', ['DAL', 'NYG', 'PHI', 'WAS']],
  ['NFC North', ['CHI', 'DET', 'GB', 'MIN']],
  ['NFC South', ['ATL', 'CAR', 'NO', 'TB']],
  ['NFC West', ['ARI', 'LA', 'SF', 'SEA']],
];
const ORDERED = NFL_DIVISIONS.flatMap(([, t]) => t);
const divisionOf = (() => { const m: Record<string, string> = {}; for (const [d, ts] of NFL_DIVISIONS) for (const t of ts) m[t] = d; return m; })();

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

function TeamLogo({ team, size = 22 }: { team: string; size?: number }) {
  return <img src={teamLogoUrl(team)} alt="" width={size} height={size} style={{ objectFit: 'contain', verticalAlign: 'middle' }} onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />;
}

function SosCard({ label, rank, idx }: { label: string; rank: number; idx: number }) {
  return (
    <div className="sched-sos-card">
      <div className="sched-sos-label">{label}</div>
      <div className="sched-sos-rank" style={{ color: rankColor(rank) }}>#{rank || '—'}</div>
      <div className="sched-sos-sub">of 32 · opp idx {Math.round(idx)}</div>
    </div>
  );
}

function GameRow({ g }: { g: SchedGame }) {
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
      <td className="sched-strength" style={{ color: rankColor(0) }}>{g.seasonType === 2 ? teamStrengthIndex(g.opp) : ''}</td>
    </tr>
  );
}

export function ScheduleView() {
  const [byTeam, setByTeam] = useState<ScheduleByTeam | null>(null);
  const [sos, setSos] = useState<Record<string, TeamSOS>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [team, setTeam] = useState('BUF');

  useEffect(() => {
    let cancelled = false;
    fetchNflSchedule()
      .then(({ byTeam }) => {
        if (cancelled) return;
        const teams = Object.keys(byTeam);
        if (!teams.length) { setError('No schedule returned. ESPN may be unreachable right now.'); setLoading(false); return; }
        setByTeam(byTeam); setSos(computeSOS(byTeam)); setLoading(false);
      })
      .catch((e: unknown) => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const teamsPresent = useMemo(() => new Set(byTeam ? Object.keys(byTeam) : []), [byTeam]);
  const cycle = (dir: number) => {
    const i = ORDERED.indexOf(team);
    setTeam(ORDERED[(i + dir + ORDERED.length) % ORDERED.length]);
  };

  const sched = byTeam?.[team];
  const s = sos[team];

  return (
    <div className="sched-page">
      <div className="sched-header">
        <h2 style={{ margin: 0, fontSize: 18 }}>{SCHEDULE_SEASON} Schedule &amp; Strength of Schedule</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 0' }}>
          Live from ESPN. SOS uses opponents' projected offensive strength (reg. season only). Rank #1 = hardest.
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
              {NFL_DIVISIONS.map(([div, codes]) => {
                const present = codes.filter((c) => teamsPresent.has(c));
                if (!present.length) return null;
                return <optgroup key={div} label={div}>{present.map((c) => <option key={c} value={c}>{c}</option>)}</optgroup>;
              })}
            </select>
            <button className="se-cycle" onClick={() => cycle(1)} aria-label="next team">▶</button>
            <span className="sched-div">{divisionOf[team]}</span>
          </div>

          {s && (
            <div className="sched-sos-row">
              <SosCard label="Overall SOS" rank={s.overallRank} idx={s.overall} />
              <SosCard label="Weeks 1–6" rank={s.t1Rank} idx={s.t1} />
              <SosCard label="Weeks 7–12" rank={s.t2Rank} idx={s.t2} />
              <SosCard label="Weeks 13–18" rank={s.t3Rank} idx={s.t3} />
            </div>
          )}

          <div className="sched-section-title">Regular season</div>
          <div className="table-container" style={{ maxHeight: 'none' }}>
            <table className="sched-table">
              <thead><tr><th>Wk</th><th>Opponent</th><th>Date / Time</th><th>Location</th><th>Network</th><th title="Opponent offensive strength index (0–100)">Opp</th></tr></thead>
              <tbody>
                {sched && sched.reg.length > 0
                  ? sched.reg.map((g, i) => <GameRow key={`r${i}`} g={g} />)
                  : <tr><td colSpan={6} className="sched-empty">No regular-season games found.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="sched-section-title">Preseason <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 11 }}>— rookies' first looks on their new teams</span></div>
          <div className="table-container" style={{ maxHeight: 'none' }}>
            <table className="sched-table">
              <thead><tr><th>Wk</th><th>Opponent</th><th>Date / Time</th><th>Location</th><th>Network</th><th /></tr></thead>
              <tbody>
                {sched && sched.pre.length > 0
                  ? sched.pre.map((g, i) => <GameRow key={`p${i}`} g={g} />)
                  : <tr><td colSpan={6} className="sched-empty">No preseason games found.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
