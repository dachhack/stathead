import { useState, useEffect, useMemo } from 'react';
import { PlayerName } from './PlayerName';
import type { SnapCount, Roster } from '../types';
import { fetchSnapCounts, fetchRosters } from '../data';

// Rookie snap-share ramp tracker. Weekly offensive snap % for the season's
// rookie class, with a ramp signal (last-3-week avg − first-3-week avg) that
// surfaces mid-season role expansion a static depth chart misses — the classic
// late-bloomer pattern (e.g. a rookie RB climbing from 30% to 70% snaps).

const SKILL = ['QB', 'RB', 'WR', 'TE'];
const POSITIONS = ['ALL', 'RB', 'WR', 'TE', 'QB'];
type SortField = 'ramp' | 'latest' | 'peak' | 'avg';

function norm(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[.'`'']/g, '')
    .replace(/-/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface RookieRow {
  player: string;
  position: string;
  team: string;
  weeksPlayed: number;
  byWeek: { week: number; pct: number }[];
  early: number;
  late: number;
  ramp: number;
  latest: number;
  peak: number;
  avg: number;
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

export function RookieSnapTracker({ season, onDataLoaded }: { season: number; onDataLoaded?: (data: unknown[]) => void }) {
  const [snaps, setSnaps] = useState<SnapCount[]>([]);
  const [rosters, setRosters] = useState<Roster[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [posFilter, setPosFilter] = useState('ALL');
  const [sortField, setSortField] = useState<SortField>('ramp');
  const [minWeeks, setMinWeeks] = useState(4);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchSnapCounts(season), fetchRosters(season)])
      .then(([snapData, rosterData]) => {
        setSnaps(snapData);
        setRosters(rosterData);
        onDataLoaded?.(snapData);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [season, onDataLoaded]);

  const rows = useMemo<RookieRow[]>(() => {
    const rookiePos = new Map<string, string>();
    for (const r of rosters) {
      const isRookie = Number(r.years_exp) === 0 || Number(r.rookie_year) === season || Number(r.entry_year) === season;
      if (isRookie && SKILL.includes(r.position)) rookiePos.set(norm(r.full_name), r.position);
    }
    const byPlayer = new Map<string, { player: string; position: string; team: string; weeks: { week: number; pct: number }[] }>();
    for (const s of snaps) {
      if (s.game_type && s.game_type !== 'REG') continue;
      const key = norm(s.player);
      const pos = rookiePos.get(key);
      if (!pos) continue;
      let rec = byPlayer.get(key);
      if (!rec) {
        rec = { player: s.player, position: s.position || pos, team: s.team, weeks: [] };
        byPlayer.set(key, rec);
      }
      rec.weeks.push({ week: s.week, pct: (s.offense_pct || 0) * 100 });
    }
    const out: RookieRow[] = [];
    for (const rec of byPlayer.values()) {
      const byWeek = rec.weeks.sort((a, b) => a.week - b.week);
      if (byWeek.length < minWeeks) continue;
      const pcts = byWeek.map((x) => x.pct);
      const early = mean(pcts.slice(0, Math.min(3, pcts.length)));
      const late = mean(pcts.slice(-Math.min(3, pcts.length)));
      out.push({
        player: rec.player,
        position: rec.position,
        team: rec.team,
        weeksPlayed: byWeek.length,
        byWeek,
        early,
        late,
        ramp: late - early,
        latest: pcts[pcts.length - 1],
        peak: Math.max(...pcts),
        avg: mean(pcts),
      });
    }
    return out;
  }, [snaps, rosters, season, minWeeks]);

  const filtered = useMemo(() => {
    let data = rows;
    if (posFilter !== 'ALL') data = data.filter((r) => r.position === posFilter);
    if (search) {
      const q = search.toLowerCase();
      data = data.filter((r) => r.player.toLowerCase().includes(q) || r.team.toLowerCase().includes(q));
    }
    return [...data].sort((a, b) => b[sortField] - a[sortField]);
  }, [rows, posFilter, search, sortField]);

  if (loading)
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading rookie snap data...</div>
      </div>
    );
  if (error)
    return (
      <div className="empty-state">
        <h3>Failed to load rookie snap data</h3>
        <p>{error}</p>
      </div>
    );

  // Sparkline of weekly snap % across the season (weeks 1–18). Bars are placed
  // at their true week so byes/missed weeks show as gaps.
  const maxWeek = 18;
  const trajectory = (byWeek: { week: number; pct: number }[]) => {
    const pctByWeek = new Map(byWeek.map((w) => [w.week, w.pct]));
    return (
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 28 }} title="Weekly offensive snap %">
        {Array.from({ length: maxWeek }, (_, i) => i + 1).map((wk) => {
          const pct = pctByWeek.get(wk);
          const h = pct == null ? 0 : Math.max(2, Math.round((pct / 100) * 28));
          return (
            <div
              key={wk}
              title={pct == null ? `W${wk}: —` : `W${wk}: ${Math.round(pct)}%`}
              style={{
                width: 4,
                height: h,
                background: pct == null ? 'var(--bg-tertiary)' : 'var(--accent)',
                opacity: pct == null ? 0.4 : 0.45 + (pct / 100) * 0.55,
                borderRadius: 1,
              }}
            />
          );
        })}
      </div>
    );
  };

  const rampBadge = (ramp: number) => {
    const up = ramp >= 0;
    return (
      <span style={{ color: up ? 'var(--positive, #10b981)' : 'var(--negative, #ef4444)', fontWeight: 700 }}>
        {up ? '▲' : '▼'} {up ? '+' : ''}{Math.round(ramp)}pp
      </span>
    );
  };

  return (
    <>
      <div style={{ padding: '4px 0 12px', color: 'var(--text-secondary)', fontSize: 13, maxWidth: 760 }}>
        Weekly offensive snap share for {season} rookies. <strong>Ramp</strong> = last-3-week avg − first-3-week avg —
        a positive ramp flags a rookie climbing into a bigger role (the late-bloomer signal a static depth chart misses).
        Use the header <em>Season</em> selector for a completed year; the in-progress season updates as games are played.
      </div>

      <div className="controls">
        <input
          type="text"
          placeholder="Search players..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="control-group">
          <label className="control-label">Sort by</label>
          <select value={sortField} onChange={(e) => setSortField(e.target.value as SortField)}>
            <option value="ramp">Ramp (biggest risers)</option>
            <option value="latest">Latest snap %</option>
            <option value="peak">Peak snap %</option>
            <option value="avg">Average snap %</option>
          </select>
        </div>
        <div className="control-group">
          <label className="control-label">Min weeks</label>
          <select value={minWeeks} onChange={(e) => setMinWeeks(Number(e.target.value))}>
            {[1, 3, 4, 6, 8].map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
        </div>
        <div className="position-filters">
          {POSITIONS.map((pos) => (
            <button
              key={pos}
              className={`pos-filter ${posFilter === pos ? 'active' : ''}`}
              onClick={() => setPosFilter(pos)}
            >
              {pos}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <h3>No rookie snap data for {season}</h3>
          <p>
            Either the season hasn't started yet, or the roster/snap feeds aren't available for {season}. Pick a
            completed season (e.g. {season > 2012 ? season - 1 : 2024}) from the header Season selector.
          </p>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Player</th>
                <th>Pos</th>
                <th>Team</th>
                <th>Wks</th>
                <th style={{ minWidth: 110 }}>Weekly snap %</th>
                <th>Early</th>
                <th>Late</th>
                <th>Ramp</th>
                <th>Latest</th>
                <th>Peak</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={`${r.player}-${r.team}`}>
                  <td>
                    <strong><PlayerName name={r.player} position={r.position} /></strong>
                  </td>
                  <td>
                    <span className={`pos-badge pos-${r.position}`}>{r.position}</span>
                  </td>
                  <td>{r.team}</td>
                  <td>{r.weeksPlayed}</td>
                  <td>{trajectory(r.byWeek)}</td>
                  <td>{Math.round(r.early)}%</td>
                  <td>{Math.round(r.late)}%</td>
                  <td>{rampBadge(r.ramp)}</td>
                  <td>{Math.round(r.latest)}%</td>
                  <td>{Math.round(r.peak)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
