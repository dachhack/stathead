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
}

interface TeamWeek { w: number; opp: string; home: boolean }

interface WeeklyDoc {
  season: number;
  generatedAt: string;
  note: string;
  weeks: number;
  defVsPos: Record<string, Record<string, number>>;
  teamWeeks: Record<string, TeamWeek[]>;
  players: WeeklyPlayer[];
}

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

  useEffect(() => {
    let cancelled = false;
    fetch(bust(`${import.meta.env.BASE_URL}data/weekly-projections-2026.json`))
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d: WeeklyDoc) => { if (!cancelled) setDoc(d); })
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
      .map((p) => {
        const raw = p.wk[week - 1];
        const game = oppFor.get(`${p.team}:${week}`) ?? null;
        const mult = game ? (doc.defVsPos[game.opp]?.[p.pos] ?? 1) : null;
        return {
          p,
          game,
          mult,
          pts: raw == null ? null : scorePts(p, raw, scoring),
          playoffs: avgOverWeeks(p, PLAYOFF_WEEKS, scoring),
          seasonPpg: scorePts(p, p.ppg, scoring),
        };
      })
      .sort((a, b) => (b.pts ?? -1) - (a.pts ?? -1));
  }, [doc, week, pos, scoring, search, oppFor]);

  if (error) return <div className="empty-state"><h3>Weekly projections unavailable</h3><p>{error}</p></div>;
  if (!doc) return <div className="loading"><div className="spinner" /><div className="loading-text">Loading weekly projections…</div></div>;

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{doc.season} Weekly Projections</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 0', maxWidth: 720 }}>
          Season projection split across the schedule: opponent defense-vs-position strength
          (last season&apos;s points allowed, heavily regressed) plus a home/away nudge, normalized so the
          17 weeks sum back to the season line. Points assume the player suits up. Kickers (current
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
        {rows.length} players · generated {doc.generatedAt.slice(0, 10)} · refreshed with the daily data pipeline.
      </p>
    </div>
  );
}
