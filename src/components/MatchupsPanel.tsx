import { useEffect, useMemo, useState } from 'react';
import { bust } from '../lib/buildHash';
import { teamLogoUrl } from '../lib/teamLogo';

/**
 * Weekly strength of matchup by offensive fantasy position, from
 * public/data/matchups-<season>.json (scripts/build-matchups.py): what each
 * defense has allowed per game to QB / RB / WR / TE this season, ranked
 * 1 = most allowed (softest matchup), laid over the selected team's schedule.
 * Receptions allowed ride along so half-PPR and standard are exact.
 */

type Pos = 'QB' | 'RB' | 'WR' | 'TE';
type Scoring = 'ppr' | 'half' | 'std';
const POSITIONS: Pos[] = ['QB', 'RB', 'WR', 'TE'];
const SCORING_COEF: Record<Scoring, number> = { ppr: 0, half: -0.5, std: -1 };

interface DefPos {
  g: number;
  ppr: number | null;
  rec: number | null;
  /** PPR points (and receptions) allowed per game over what the offenses faced produce in their other games. */
  oe?: number | null;
  oeRec?: number | null;
  oeRank?: number | null;
  rank: Record<Scoring, number | null>;
  prior: { g: number; ppr: number | null; rec: number | null };
  factor: number | null;
  factorRank: number | null;
  byWeek: { w: number; opp: string | null; ppr: number; rec: number }[];
}

interface SchedGame {
  w: number;
  opp: string;
  home: boolean;
  played: boolean;
  factor: Record<Pos, number | null>;
}

interface MatchupsDoc {
  season: number;
  generatedAt: string;
  playedThrough: number;
  currentWeek: number;
  positions: Pos[];
  league: Record<Pos, { ppr: number | null; rec: number | null }>;
  defenses: Record<string, Record<Pos, DefPos>>;
  schedule: Record<string, SchedGame[]>;
  bye?: Record<string, number | null>;
}

const MATCHUPS_SEASON = 2026;

function pts(c: { g: number; ppr: number | null; rec: number | null } | undefined, scoring: Scoring): number | null {
  if (!c || !c.g || c.ppr == null) return null;
  return c.ppr + SCORING_COEF[scoring] * (c.rec ?? 0);
}

/** Over-expected in the chosen scoring (points over expected + coef × receptions over expected). */
function overExpected(c: DefPos | undefined, scoring: Scoring): number | null {
  if (!c || !c.g || c.oe == null) return null;
  return c.oe + SCORING_COEF[scoring] * (c.oeRec ?? 0);
}

function signed(v: number | null, dp = 1): string {
  if (v == null) return '—';
  const t = v.toFixed(dp);
  return Number(t) === 0 ? (0).toFixed(dp) : `${Number(t) > 0 ? '+' : ''}${t}`;
}

function rankMap(values: Record<string, number>): Record<string, number> {
  const order = Object.entries(values).sort((a, b) => b[1] - a[1]);
  const rank: Record<string, number> = {};
  let prev: number | null = null; let prevRank = 0;
  order.forEach(([d, v], i) => { if (prev === null || v !== prev) prevRank = i + 1; rank[d] = prevRank; prev = v; });
  return rank;
}

// Rank 1 = most points allowed = softest for the offense: green → red.
function rankColor(rank: number | null, n: number): string {
  if (rank == null || !n) return 'var(--text-muted)';
  const q = Math.max(1, Math.round(n / 4));
  if (rank <= q) return '#22c55e';
  if (rank <= n / 2) return '#a3e635';
  if (rank <= n - q) return '#f59e0b';
  return '#ef4444';
}

function TeamLogo({ team, size = 20 }: { team: string; size?: number }) {
  return <img src={teamLogoUrl(team)} alt="" width={size} height={size} style={{ objectFit: 'contain', verticalAlign: 'middle' }} onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />;
}

function MatchupCell({ value, rank, n, factor, oe, title }: { value: number | null; rank: number | null; n: number; factor: number | null; oe?: number | null; title: string }) {
  if (value == null) return <td style={{ textAlign: 'center', color: 'var(--text-muted)' }}>—</td>;
  return (
    <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }} title={`${title}${oe != null ? ` · ${signed(oe)} over expected (schedule-adjusted)` : ''}${factor != null ? ` · model factor ${factor.toFixed(3)}` : ''}`}>
      <span style={{ fontWeight: 600 }}>{value.toFixed(1)}</span>
      <span style={{ marginLeft: 5, fontSize: 11, fontWeight: 700, color: rankColor(rank, n) }}>#{rank ?? '—'}</span>
    </td>
  );
}

export function MatchupsPanel({ team }: { team: string }) {
  const [doc, setDoc] = useState<MatchupsDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scoring, setScoring] = useState<Scoring>('ppr');
  const [mode, setMode] = useState<'schedule' | 'defenses' | 'ros'>('schedule');
  const [sortPos, setSortPos] = useState<Pos>('TE');
  const [showPlayed, setShowPlayed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(bust(`${import.meta.env.BASE_URL}data/matchups-${MATCHUPS_SEASON}.json`))
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d: MatchupsDoc) => { if (!cancelled) setDoc(d); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  // Points allowed per game in the chosen scoring, plus ranks (ties share the
  // better rank) and the league average, per position.
  const table = useMemo(() => {
    const out = {} as Record<Pos, { fpa: Record<string, number>; rank: Record<string, number>; avg: number | null; n: number }>;
    if (!doc) return out;
    for (const pos of POSITIONS) {
      const fpa: Record<string, number> = {};
      for (const [d, byPos] of Object.entries(doc.defenses)) {
        const v = pts(byPos[pos], scoring);
        if (v != null) fpa[d] = v;
      }
      const vals = Object.values(fpa);
      out[pos] = { fpa, rank: rankMap(fpa), avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, n: vals.length };
    }
    return out;
  }, [doc, scoring]);

  // Rest of schedule: per team and position, the mean of what the remaining
  // (unplayed, from the current week) opponents allow, its over-expected and
  // model factor, ranked 1 = softest rest of schedule.
  const ros = useMemo(() => {
    const out = {} as Record<Pos, { fpa: Record<string, number>; oe: Record<string, number | null>; factor: Record<string, number | null>; rank: Record<string, number>; left: Record<string, number>; n: number }>;
    if (!doc) return out;
    const mean = (xs: (number | null | undefined)[]) => { const v = xs.filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    for (const pos of POSITIONS) {
      const fpa: Record<string, number> = {}; const oe: Record<string, number | null> = {}; const factor: Record<string, number | null> = {}; const left: Record<string, number> = {};
      for (const [t, games] of Object.entries(doc.schedule)) {
        const rem = games.filter((g) => !g.played && g.w >= doc.currentWeek);
        left[t] = rem.length;
        const v = mean(rem.map((g) => table[pos]?.fpa[g.opp]));
        if (v != null) fpa[t] = v;
        oe[t] = mean(rem.map((g) => overExpected(doc.defenses[g.opp]?.[pos], scoring)));
        factor[t] = mean(rem.map((g) => g.factor?.[pos]));
      }
      out[pos] = { fpa, oe, factor, rank: rankMap(fpa), left, n: Object.keys(fpa).length };
    }
    return out;
  }, [doc, table, scoring]);

  if (error) return null;  // the schedule page still works without this file
  if (!doc) return null;

  const n = table.QB?.n ?? 0;
  const sched = doc.schedule[team] ?? [];
  const games = showPlayed ? sched : sched.filter((g) => g.w >= doc.currentWeek && !g.played);
  const defenses = Object.keys(doc.defenses)
    .filter((d) => table[sortPos]?.fpa[d] != null)
    .sort((a, b) => table[sortPos].fpa[b] - table[sortPos].fpa[a]);
  const nextGame = (d: string) => (doc.schedule[d] ?? []).find((g) => g.w >= doc.currentWeek && !g.played);
  const scoringLabel = scoring === 'ppr' ? 'PPR' : scoring === 'half' ? 'half-PPR' : 'standard';

  return (
    <>
      <div className="sched-section-title">
        Fantasy matchups by position
        <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 11 }}>
          {' '}— {scoringLabel} points each defense has allowed per game to the position
          {doc.playedThrough ? ` through week ${doc.playedThrough}` : ' (no games final yet)'}; #1 = most allowed = softest matchup
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <select className="scenario-select" value={mode} onChange={(e) => setMode(e.target.value as 'schedule' | 'defenses' | 'ros')}>
          <option value="schedule">{team} schedule</option>
          <option value="defenses">All defenses</option>
          <option value="ros">Rest of schedule</option>
        </select>
        <select className="scenario-select" value={scoring} onChange={(e) => setScoring(e.target.value as Scoring)}>
          <option value="ppr">PPR</option>
          <option value="half">Half PPR</option>
          <option value="std">Standard</option>
        </select>
        {mode === 'schedule' ? (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
            <input type="checkbox" checked={showPlayed} onChange={(e) => setShowPlayed(e.target.checked)} />
            Include played weeks
          </label>
        ) : (
          <select className="scenario-select" value={sortPos} onChange={(e) => setSortPos(e.target.value as Pos)}>
            {POSITIONS.map((p) => <option key={p} value={p}>Sort by {p}{mode === 'ros' ? ' rest of schedule' : ' allowed'}</option>)}
          </select>
        )}
        {n > 0 && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            League avg: {POSITIONS.map((p) => `${p} ${table[p].avg?.toFixed(1) ?? '—'}`).join(' · ')}
          </span>
        )}
      </div>

      <div className="table-container" style={{ maxHeight: 'none' }}>
        <table className="sched-table">
          {mode === 'ros' ? (
            <>
              <thead>
                <tr>
                  <th>Team</th>
                  <th title="Unplayed games from the current week">Left</th>
                  <th>Bye</th>
                  {POSITIONS.map((p) => <th key={p} style={p === sortPos ? { textDecoration: 'underline' } : undefined} title={`Mean ${scoringLabel} points the remaining opponents allow per game to ${p}s, and its rank (#1 = softest rest of schedule). Hover for over-expected and the mean model factor.`}>{p} ROS</th>)}
                </tr>
              </thead>
              <tbody>
                {Object.keys(doc.schedule)
                  .filter((t) => ros[sortPos]?.fpa[t] != null)
                  .sort((a, b) => ros[sortPos].fpa[b] - ros[sortPos].fpa[a])
                  .map((t) => (
                    <tr key={t} style={t === team ? { background: 'var(--bg-hover, rgba(255,255,255,0.04))' } : undefined}>
                      <td className="sched-opp"><TeamLogo team={t} /><span className="sched-opp-code">{t}</span></td>
                      <td style={{ textAlign: 'center', color: 'var(--text-muted)' }}>{ros[sortPos]?.left[t] ?? 0}</td>
                      <td style={{ textAlign: 'center', color: 'var(--text-muted)' }}>{doc.bye?.[t] ?? '—'}</td>
                      {POSITIONS.map((p) => (
                        <MatchupCell key={p} value={ros[p]?.fpa[t] ?? null} rank={ros[p]?.rank[t] ?? null} n={ros[p]?.n ?? 0}
                          factor={ros[p]?.factor[t] ?? null} oe={ros[p]?.oe[t] ?? null}
                          title={`${t}'s remaining opponents allow ${(ros[p]?.fpa[t] ?? 0).toFixed(1)} ${scoringLabel} pts/g to ${p}s on average (#${ros[p]?.rank[t] ?? '—'} of ${ros[p]?.n ?? 0}, 1 = softest)`} />
                      ))}
                    </tr>
                  ))}
              </tbody>
            </>
          ) : mode === 'schedule' ? (
            <>
              <thead>
                <tr>
                  <th>Wk</th>
                  <th>Opponent</th>
                  {POSITIONS.map((p) => <th key={p} title={`${scoringLabel} points the opponent has allowed per game to ${p}s this season, and its rank (#1 = most allowed). Hover a cell for the StatHead model factor the weekly projections apply.`}>vs {p}</th>)}
                </tr>
              </thead>
              <tbody>
                {games.length ? games.map((g) => (
                  <tr key={g.w} style={g.played ? { opacity: 0.6 } : undefined}>
                    <td className="sched-wk">{g.w}</td>
                    <td className="sched-opp">
                      <span className="sched-vs">{g.home ? 'vs' : '@'}</span>
                      <TeamLogo team={g.opp} />
                      <span className="sched-opp-code">{g.opp}</span>
                      {g.played && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-muted)' }}>final</span>}
                    </td>
                    {POSITIONS.map((p) => (
                      <MatchupCell key={p} value={table[p]?.fpa[g.opp] ?? null} rank={table[p]?.rank[g.opp] ?? null} n={n}
                        factor={g.factor?.[p] ?? null} oe={overExpected(doc.defenses[g.opp]?.[p], scoring)}
                        title={`${g.opp} allows ${(table[p]?.fpa[g.opp] ?? 0).toFixed(1)} ${scoringLabel} pts/g to ${p}s (#${table[p]?.rank[g.opp] ?? '—'} of ${n}, ${doc.defenses[g.opp]?.[p]?.g ?? 0} games)`} />
                    ))}
                  </tr>
                )) : <tr><td colSpan={6} className="sched-empty">No remaining games{sched.length ? ' — tick "Include played weeks"' : ''}.</td></tr>}
              </tbody>
            </>
          ) : (
            <>
              <thead>
                <tr>
                  <th>Defense</th>
                  <th>G</th>
                  {POSITIONS.map((p) => <th key={p} style={p === sortPos ? { textDecoration: 'underline' } : undefined} title={`${scoringLabel} points allowed per game to ${p}s and rank (#1 = most allowed)`}>vs {p}</th>)}
                  <th>Next</th>
                </tr>
              </thead>
              <tbody>
                {defenses.map((d) => {
                  const nx = nextGame(d);
                  return (
                    <tr key={d} style={d === team ? { background: 'var(--bg-hover, rgba(255,255,255,0.04))' } : undefined}>
                      <td className="sched-opp"><TeamLogo team={d} /><span className="sched-opp-code">{d}</span></td>
                      <td style={{ textAlign: 'center', color: 'var(--text-muted)' }}>{doc.defenses[d]?.QB?.g ?? 0}</td>
                      {POSITIONS.map((p) => (
                        <MatchupCell key={p} value={table[p]?.fpa[d] ?? null} rank={table[p]?.rank[d] ?? null} n={n}
                          factor={doc.defenses[d]?.[p]?.factor ?? null} oe={overExpected(doc.defenses[d]?.[p], scoring)}
                          title={`${d} allows ${(table[p]?.fpa[d] ?? 0).toFixed(1)} ${scoringLabel} pts/g to ${p}s (#${table[p]?.rank[d] ?? '—'} of ${n})${pts(doc.defenses[d]?.[p]?.prior, scoring) != null ? ` · last season ${pts(doc.defenses[d][p].prior, scoring)!.toFixed(1)}` : ''}`} />
                      ))}
                      <td style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{nx ? `wk ${nx.w} ${nx.home ? 'vs' : '@'} ${nx.opp}` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </>
          )}
        </table>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '6px 0 12px', maxWidth: 820 }}>
        Season-to-date actuals are loud early in the year (a defense can sit #1 against TEs on one 40-point game).
        Hover a cell for two correctives: over expected, which is what the defense allowed beyond what the offenses it
        faced produce in their other games (schedule-adjusted), and the StatHead model factor, which blends last season
        in, keeps about 40% of a deviation, and is what the Weekly Projections tab applies. Per-metric splits (QB passing
        vs rushing, TE receptions and yards per reception, RB rushing vs receiving) are in the MCP tool get_matchups and
        the Python package. A soft matchup here does not override a player&apos;s own role: a
        TE1 against the #1 defense is still a start, and a tough one is a reason to temper the projection, not bench him.
      </p>
    </>
  );
}
