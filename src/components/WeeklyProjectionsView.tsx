import { useEffect, useMemo, useState } from 'react';
import { bust } from '../lib/buildHash';
import { teamLogoUrl } from '../lib/teamLogo';
import { PlayerName } from './PlayerName';

interface WeeklyPlayer {
  name: string;
  pos: string;
  team: string;
  gp: number;
  ppg: number;
  recPG: number;
  wk: (number | null)[];
  /** Depth-chart rank (1 = starter); skill positions only. */
  depth?: number | null;
  /** nflverse roster status at build time (ACT / RES / EXE / DEV / INA / FA); skill positions only. */
  status?: string | null;
  /** false = on reserve / exempt / practice squad / unrostered; the builder zeroes the weeks from currentWeek on. */
  active?: boolean;
  /** A 1–3 game season line on a depth-2+ player: each week is a per-game rate conditional on playing, not an expectation of starting. */
  backup?: boolean;
}

interface TeamWeek { w: number; opp: string; home: boolean }

interface WeeklyDoc {
  season: number;
  generatedAt: string;
  note: string;
  weeks: number;
  /** Last week with every game final (0 preseason). */
  playedThrough?: number;
  /** First week whose games are not all final. */
  currentWeek?: number;
  defVsPos: Record<string, Record<string, number>>;
  teamWeeks: Record<string, TeamWeek[]>;
  players: WeeklyPlayer[];
}

/** Roster statuses that mean the player is not playing for this team this week. */
const STATUS_LABEL: Record<string, string> = {
  RES: 'IR / reserve', EXE: 'exempt list', DEV: 'practice squad', FA: 'unrostered',
};

type Scoring = 'ppr' | 'half' | 'std';
const POS_FILTERS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DST'] as const;
const PLAYOFF_WEEKS = [15, 16, 17];

// Matchup multiplier color: >1 = softer matchup (green), <1 = tougher (red).
function multColor(m: number): string {
  if (m >= 1.05) return '#22c55e';
  if (m >= 1.01) return '#a3e635';
  if (m > 0.99) return 'var(--text-muted)';
  if (m > 0.95) return '#f59e0b';
  return '#ef4444';
}

/** Re-score a weekly PPR number for the selected format. Weekly receptions
 *  scale with the same matchup multiplier as points (rec_w = recPG * pts/ppg),
 *  so the conversion only needs the season recPG. */
function scorePts(p: WeeklyPlayer, pprPts: number, scoring: Scoring): number {
  if (scoring === 'ppr' || p.ppg <= 0) return pprPts;
  const recW = p.recPG * (pprPts / p.ppg);
  return scoring === 'half' ? pprPts - 0.5 * recW : pprPts - recW;
}

function avgOverWeeks(p: WeeklyPlayer, weeks: number[], scoring: Scoring): number | null {
  const vals = weeks.map((w) => p.wk[w - 1]).filter((v): v is number => v != null);
  if (!vals.length) return null;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return scorePts(p, avg, scoring);
}

export function WeeklyProjectionsView() {
  const [doc, setDoc] = useState<WeeklyDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [week, setWeek] = useState(1);
  const [pos, setPos] = useState<(typeof POS_FILTERS)[number]>('ALL');
  const [scoring, setScoring] = useState<Scoring>('ppr');
  const [search, setSearch] = useState('');
  // Backups (1–3 game lines) rank on a conditional per-game rate that put a
  // one-game QB2 fourth on the board; hidden by default, toggle to see them.
  const [showBackups, setShowBackups] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(bust(`${import.meta.env.BASE_URL}data/weekly-projections-2026.json`))
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d: WeeklyDoc) => {
        if (cancelled) return;
        setDoc(d);
        // Open on the week being played, not week 1 all season.
        if (d.currentWeek && d.currentWeek >= 1 && d.currentWeek <= (d.weeks || 18)) setWeek(d.currentWeek);
      })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  const oppFor = useMemo(() => {
    const map = new Map<string, TeamWeek>();
    if (doc) {
      for (const [team, wks] of Object.entries(doc.teamWeeks)) {
        for (const g of wks) map.set(`${team}:${g.w}`, g);
      }
    }
    return map;
  }, [doc]);

  const rows = useMemo(() => {
    if (!doc) return [];
    const q = search.trim().toLowerCase();
    return doc.players
      .filter((p) => (pos === 'ALL' || p.pos === pos) && (!q || p.name.toLowerCase().includes(q)))
      // A searched-for backup still shows; only the unfiltered board hides them.
      .filter((p) => showBackups || !p.backup || !!q)
      .map((p) => {
        const raw = p.wk[week - 1];
        const game = oppFor.get(`${p.team}:${week}`) ?? null;
        const mult = game ? (doc.defVsPos[game.opp]?.[p.pos] ?? 1) : null;
        const inactive = p.active === false && (doc.currentWeek == null || week >= doc.currentWeek);
        return {
          p,
          game,
          mult,
          inactive,
          pts: raw == null ? null : scorePts(p, raw, scoring),
          playoffs: avgOverWeeks(p, PLAYOFF_WEEKS, scoring),
          seasonPpg: scorePts(p, p.ppg, scoring),
        };
      })
      // Starters by points, then backups by points; inactive rows are already
      // zero in the feed and fall to the bottom on their own.
      .sort((a, b) => {
        const ta = a.p.backup ? 1 : 0;
        const tb = b.p.backup ? 1 : 0;
        return ta !== tb ? ta - tb : (b.pts ?? -1) - (a.pts ?? -1);
      });
  }, [doc, week, pos, scoring, search, showBackups, oppFor]);

  const hiddenBackups = useMemo(() => {
    if (!doc || showBackups || search.trim()) return 0;
    return doc.players.filter((p) => p.backup && (pos === 'ALL' || p.pos === pos)).length;
  }, [doc, pos, showBackups, search]);

  if (error) return <div className="empty-state"><h3>Weekly projections unavailable</h3><p>{error}</p></div>;
  if (!doc) return <div className="loading"><div className="spinner" /><div className="loading-text">Loading weekly projections…</div></div>;

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{doc.season} Weekly Projections</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 0', maxWidth: 720 }}>
          Season projection split across the schedule: opponent defense-vs-position strength
          (last season&apos;s points allowed, heavily regressed) plus a home/away nudge, normalized so the
          17 weeks sum back to the season line. Points assume the player suits up; players on IR, the
          exempt list or a practice squad are zeroed from the current week on. Kickers (current
          depth-chart PK1) and team DST are projected from team context with the same matchup framework.
        </p>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <button className="se-cycle" onClick={() => setWeek((w) => Math.max(1, w - 1))} aria-label="previous week">◀</button>
        <select className="scenario-select" value={week} onChange={(e) => setWeek(Number(e.target.value))}>
          {Array.from({ length: doc.weeks }, (_, i) => i + 1).map((w) => <option key={w} value={w}>Week {w}</option>)}
        </select>
        <button className="se-cycle" onClick={() => setWeek((w) => Math.min(doc.weeks, w + 1))} aria-label="next week">▶</button>
        <select className="scenario-select" value={pos} onChange={(e) => setPos(e.target.value as typeof POS_FILTERS[number])}>
          {POS_FILTERS.map((f) => <option key={f} value={f}>{f === 'ALL' ? 'All positions' : f}</option>)}
        </select>
        <select className="scenario-select" value={scoring} onChange={(e) => setScoring(e.target.value as Scoring)}>
          <option value="ppr">PPR</option>
          <option value="half">Half PPR</option>
          <option value="std">Standard</option>
        </select>
        <input
          className="scenario-select"
          type="search"
          placeholder="Search player…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 160 }}
        />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}
          title="Backups carry a 1–3 game season line, so their weekly number is a per-game rate conditional on playing — not an expectation of starting.">
          <input type="checkbox" checked={showBackups} onChange={(e) => setShowBackups(e.target.checked)} />
          Show backups{hiddenBackups ? ` (${hiddenBackups})` : ''}
        </label>
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th style={{ textAlign: 'left' }}>Player</th>
              <th>Pos</th>
              <th>Team</th>
              <th>Opp</th>
              <th title="Opponent defense-vs-position multiplier. Green = softer matchup, red = tougher.">Matchup</th>
              <th title={`Projected points for week ${week} (if he plays)`}>Wk {week}</th>
              <th title="Average projected points over fantasy playoff weeks 15–17 (bye excluded)">Playoffs 15–17</th>
              <th title="Season projected points per game">Season PPG</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 300).map((r, i) => (
              <tr key={`${r.p.name}:${r.p.team}`}>
                <td style={{ color: 'var(--text-muted)' }}>{r.pts == null ? '—' : i + 1}</td>
                <td style={{ textAlign: 'left', fontWeight: 600 }}>
                  <PlayerName name={r.p.name} position={r.p.pos} />
                  {r.inactive && (
                    <span title={`Roster status ${r.p.status ?? ''}: not on the active roster; zeroed from the current week on.`}
                      style={{ marginLeft: 6, fontSize: 10, fontWeight: 600, color: '#ef4444', border: '1px solid #ef4444', borderRadius: 4, padding: '0 4px', verticalAlign: 'middle' }}>
                      {STATUS_LABEL[r.p.status ?? ''] ?? r.p.status ?? 'inactive'}
                    </span>
                  )}
                  {!r.inactive && r.p.backup && (
                    <span title={`Backup: a ${r.p.gp}-game season line, so this is a per-game rate conditional on playing.`}
                      style={{ marginLeft: 6, fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', border: '1px solid var(--text-muted)', borderRadius: 4, padding: '0 4px', verticalAlign: 'middle' }}>
                      backup
                    </span>
                  )}
                </td>
                <td>{r.p.pos}</td>
                <td>
                  <img src={teamLogoUrl(r.p.team)} alt="" width={18} height={18} style={{ objectFit: 'contain', verticalAlign: 'middle', marginRight: 4 }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                  {r.p.team}
                </td>
                <td>{r.game ? `${r.game.home ? 'vs' : '@'} ${r.game.opp}` : <span style={{ color: 'var(--text-muted)' }}>BYE</span>}</td>
                <td style={{ fontWeight: 600, color: r.mult == null ? 'var(--text-muted)' : multColor(r.mult) }}>
                  {r.mult == null ? '' : `${r.mult >= 1 ? '+' : ''}${((r.mult - 1) * 100).toFixed(0)}%`}
                </td>
                <td style={{ fontWeight: 700 }}>{r.pts == null ? '—' : r.pts.toFixed(1)}</td>
                <td>{r.playoffs == null ? '—' : r.playoffs.toFixed(1)}</td>
                <td style={{ color: 'var(--text-muted)' }}>{r.seasonPpg.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 8 }}>
        {rows.length} players{hiddenBackups ? ` (${hiddenBackups} backups hidden)` : ''} · generated {doc.generatedAt.slice(0, 10)} · refreshed with the daily data pipeline.
      </p>
    </div>
  );
}
