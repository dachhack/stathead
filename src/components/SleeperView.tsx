import { useState, useEffect, useMemo } from 'react';
import type { SleeperTrendingRow } from '../types';
import { fetchSleeperTrending } from '../data';
import { bust } from '../lib/buildHash';

/** One row of the StatHead projections table (season total or a single week). */
interface StatHeadProjRow {
  key: string;
  name: string;
  position: string;
  team: string;
  /** Week mode: opponent label ("@BUF" / "BUF"), 'BYE', or '' when unknown. */
  opp?: string;
  /** Season mode: projected games played. */
  games?: number;
  ppr: number | null;
  half: number | null;
  std: number | null;
  passYd?: number; passTd?: number; passInt?: number;
  rushYd?: number; rushTd?: number;
  rec?: number; recYd?: number; recTd?: number;
}

/** Season base pool (public/data/projection-base-<season>.json) — the same pool
 *  the StatHead get_projections tool reads. */
interface BaseLine {
  name: string; team?: string; games?: number; pprPts?: number;
  passYds?: number; passTD?: number; int?: number;
  rushYds?: number; rushTD?: number;
  rec?: number; recYds?: number; recTD?: number;
}
interface BaseDoc { season?: number; qbs?: BaseLine[]; rbs?: BaseLine[]; wrs?: BaseLine[]; tes?: BaseLine[] }

/** Weekly matchup-adjusted projections (public/data/weekly-projections-2026.json). */
interface WeeklyLine { name: string; pos: string; team: string; ppg: number; recPG: number; wk: (number | null)[]; active?: boolean; backup?: boolean }
interface WeeklyDocLite { season?: number; teamWeeks?: Record<string, { w: number; opp: string; home: boolean }[]>; players?: WeeklyLine[] }

const SKILL_POS = new Set(['QB', 'RB', 'WR', 'TE']);
const PROJ_SEASON = 2026;

async function loadJson<T>(path: string): Promise<T> {
  const r = await fetch(bust(`${import.meta.env.BASE_URL}data/${path}`));
  if (!r.ok) throw new Error(`HTTP ${r.status} loading ${path}`);
  return r.json() as Promise<T>;
}

function seasonRows(doc: BaseDoc): StatHeadProjRow[] {
  const rows: StatHeadProjRow[] = [];
  const groups: [keyof BaseDoc, string][] = [['qbs', 'QB'], ['rbs', 'RB'], ['wrs', 'WR'], ['tes', 'TE']];
  for (const [g, position] of groups) {
    for (const p of (doc[g] as BaseLine[] | undefined) || []) {
      const games = Number(p.games) || 0;
      const ppr = Number(p.pprPts) || 0;
      if (!p.team || games <= 0 || ppr <= 0) continue;
      const rec = Number(p.rec) || 0;
      rows.push({
        key: `${position}:${p.name}:${p.team}`, name: p.name, position, team: p.team, games,
        ppr, half: ppr - 0.5 * rec, std: ppr - rec,
        passYd: Number(p.passYds) || 0, passTd: Number(p.passTD) || 0, passInt: Number(p.int) || 0,
        rushYd: Number(p.rushYds) || 0, rushTd: Number(p.rushTD) || 0,
        rec, recYd: Number(p.recYds) || 0, recTd: Number(p.recTD) || 0,
      });
    }
  }
  return rows.sort((a, b) => (b.ppr ?? 0) - (a.ppr ?? 0));
}

function weekRows(doc: WeeklyDocLite, week: number): StatHeadProjRow[] {
  const oppMap = new Map<string, string>();
  for (const [team, wks] of Object.entries(doc.teamWeeks || {})) {
    for (const g of wks) oppMap.set(`${team}:${g.w}`, g.home ? g.opp : `@${g.opp}`);
  }
  const rows: StatHeadProjRow[] = [];
  for (const p of doc.players || []) {
    if (!SKILL_POS.has(p.pos) || p.backup) continue;
    const pts = p.wk?.[week - 1];
    let ppr: number | null = null, half: number | null = null, std: number | null = null;
    if (pts != null) {
      // Same re-scoring as the Weekly Projections tab: weekly receptions scale
      // with the matchup multiplier (rec_w = recPG * pts / ppg).
      const recW = p.ppg > 0 ? p.recPG * (pts / p.ppg) : 0;
      ppr = pts; half = pts - 0.5 * recW; std = pts - recW;
    }
    rows.push({
      key: `${p.pos}:${p.name}:${p.team}`, name: p.name, position: p.pos, team: p.team,
      opp: pts == null ? 'BYE' : oppMap.get(`${p.team}:${week}`) || '',
      ppr, half, std,
    });
  }
  return rows.sort((a, b) => (b.ppr ?? -1) - (a.ppr ?? -1));
}

const fmt1 = (v: number | null | undefined) => (v == null ? '-' : v.toFixed(1));
const fmtInt = (v: number | undefined) => (v && v > 0 ? Math.round(v).toLocaleString() : '-');
const fmtDec = (v: number | undefined) => (v && v > 0 ? v.toFixed(1) : '-');

type ViewMode = 'trending_add' | 'trending_drop' | 'projections';
const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];

interface Props {
  season: number;
  onDataLoaded?: (data: unknown[]) => void;
}

export function SleeperView({ season, onDataLoaded }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('trending_add');
  const [trendingAdds, setTrendingAdds] = useState<SleeperTrendingRow[]>([]);
  const [trendingDrops, setTrendingDrops] = useState<SleeperTrendingRow[]>([]);
  const [projections, setProjections] = useState<StatHeadProjRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posFilter, setPosFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [lookback, setLookback] = useState(24);
  const [projWeek, setProjWeek] = useState<number | undefined>(undefined);

  // Fetch trending adds
  useEffect(() => {
    if (viewMode !== 'trending_add') return;
    setLoading(true);
    setError(null);
    fetchSleeperTrending('add', lookback, 100)
      .then((data) => {
        setTrendingAdds(data);
        onDataLoaded?.(data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [viewMode, lookback, onDataLoaded]);

  // Fetch trending drops
  useEffect(() => {
    if (viewMode !== 'trending_drop') return;
    setLoading(true);
    setError(null);
    fetchSleeperTrending('drop', lookback, 100)
      .then((data) => {
        setTrendingDrops(data);
        onDataLoaded?.(data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [viewMode, lookback, onDataLoaded]);

  // StatHead projections: season base pool for full season, weekly
  // matchup-adjusted file for a single week.
  useEffect(() => {
    if (viewMode !== 'projections') return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const load =
      projWeek == null
        ? loadJson<BaseDoc>(`projection-base-${PROJ_SEASON}.json`).then(seasonRows)
        : loadJson<WeeklyDocLite>(`weekly-projections-${PROJ_SEASON}.json`).then((d) => weekRows(d, projWeek));
    load
      .then((rows) => {
        if (cancelled) return;
        setProjections(rows);
        onDataLoaded?.(rows);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [viewMode, projWeek, onDataLoaded]);

  const trendingData = viewMode === 'trending_add' ? trendingAdds : trendingDrops;

  const filteredTrending = useMemo(() => {
    let data = [...trendingData];
    if (posFilter !== 'ALL') data = data.filter((p) => p.position === posFilter);
    if (search) {
      const q = search.toLowerCase();
      data = data.filter(
        (p) => p.full_name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q)
      );
    }
    return data;
  }, [trendingData, posFilter, search]);

  const filteredProjections = useMemo(() => {
    let data = [...projections];
    if (posFilter !== 'ALL') data = data.filter((p) => p.position === posFilter);
    if (search) {
      const q = search.toLowerCase();
      data = data.filter(
        (p) => p.name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q)
      );
    }
    return data.slice(0, 300);
  }, [projections, posFilter, search]);

  return (
    <>
      <div className="scoring-format-tabs" style={{ marginBottom: 12 }}>
        <button
          className={`format-tab ${viewMode === 'trending_add' ? 'active' : ''}`}
          onClick={() => setViewMode('trending_add')}
        >
          Trending Adds
        </button>
        <button
          className={`format-tab ${viewMode === 'trending_drop' ? 'active' : ''}`}
          onClick={() => setViewMode('trending_drop')}
        >
          Trending Drops
        </button>
        <button
          className={`format-tab ${viewMode === 'projections' ? 'active' : ''}`}
          onClick={() => setViewMode('projections')}
        >
          StatHead Projections
        </button>
      </div>

      {loading ? (
        <div className="loading">
          <div className="spinner" />
          <div className="loading-text">
            {viewMode === 'projections' ? 'Loading StatHead projections...' : 'Loading Sleeper data...'}
          </div>
        </div>
      ) : error ? (
        <div className="empty-state">
          <h3>{viewMode === 'projections' ? 'Failed to load StatHead projections' : 'Failed to load Sleeper data'}</h3>
          <p>{error}</p>
          {viewMode !== 'projections' && (
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 8 }}>
              The Sleeper API may be blocked by CORS in some environments.
              Works best when deployed to GitHub Pages.
            </p>
          )}
        </div>
      ) : viewMode === 'projections' ? (
        <>
          <div className="controls">
            <input
              type="text"
              placeholder="Search players..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
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
            <div className="control-group">
              <label className="control-label">Week</label>
              <select
                value={projWeek ?? 'full'}
                onChange={(e) =>
                  setProjWeek(e.target.value === 'full' ? undefined : Number(e.target.value))
                }
              >
                <option value="full">Full Season</option>
                {Array.from({ length: 18 }, (_, i) => i + 1).map((w) => (
                  <option key={w} value={w}>
                    Week {w}
                  </option>
                ))}
              </select>
            </div>
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              {filteredProjections.length} players
            </span>
          </div>

          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>
            <strong>StatHead projections</strong> ({PROJ_SEASON}
            {projWeek == null
              ? ' full season: projected season totals from the StatHead season model, blended toward in-season results'
              : `, week ${projWeek}: per-game points adjusted for opponent and home/away; assumes the player plays, before injury adjustments (see the Weekly Projections tab); depth-chart backups hidden`}
            ). Half / Std subtract 0.5 / 1 point per projected reception.
            {season !== PROJ_SEASON && ` StatHead projections are published for ${PROJ_SEASON} only.`}
          </p>

          <div className="table-container">
            <table>
              <caption style={{ textAlign: 'left', fontWeight: 600, padding: '4px 0' }}>StatHead projections</caption>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>Pos</th>
                  <th>Team</th>
                  {projWeek == null ? <th>Games</th> : <th>Opp</th>}
                  <th>PPR Pts</th>
                  <th>Half PPR</th>
                  <th>Std Pts</th>
                  {projWeek == null && (
                    <>
                      <th>Pass Yd</th>
                      <th>Pass TD</th>
                      <th>INT</th>
                      <th>Rush Yd</th>
                      <th>Rush TD</th>
                      <th>Rec</th>
                      <th>Rec Yd</th>
                      <th>Rec TD</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {filteredProjections.map((p, i) => (
                  <tr key={p.key}>
                    <td className="rank-cell">{i + 1}</td>
                    <td>
                      <strong>{p.name}</strong>
                    </td>
                    <td>
                      <span className={`pos-badge pos-${p.position}`}>{p.position}</span>
                    </td>
                    <td>{p.team}</td>
                    {projWeek == null ? <td>{p.games != null ? +p.games.toFixed(1) : '-'}</td> : <td>{p.opp || '-'}</td>}
                    <td className="stat-positive">{fmt1(p.ppr)}</td>
                    <td>{fmt1(p.half)}</td>
                    <td>{fmt1(p.std)}</td>
                    {projWeek == null && (
                      <>
                        <td>{fmtInt(p.passYd)}</td>
                        <td>{fmtDec(p.passTd)}</td>
                        <td>{fmtDec(p.passInt)}</td>
                        <td>{fmtInt(p.rushYd)}</td>
                        <td>{fmtDec(p.rushTd)}</td>
                        <td>{fmtDec(p.rec)}</td>
                        <td>{fmtInt(p.recYd)}</td>
                        <td>{fmtDec(p.recTd)}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <div className="controls">
            <input
              type="text"
              placeholder="Search players..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
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
            <div className="control-group">
              <label className="control-label">Lookback</label>
              <select
                value={lookback}
                onChange={(e) => {
                  setLookback(Number(e.target.value));
                  setTrendingAdds([]);
                  setTrendingDrops([]);
                }}
              >
                <option value={6}>6 hours</option>
                <option value={12}>12 hours</option>
                <option value={24}>24 hours</option>
                <option value={48}>48 hours</option>
              </select>
            </div>
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              {filteredTrending.length} players
            </span>
          </div>

          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>
            Data from{' '}
            <a
              href="https://sleeper.com"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--accent)' }}
            >
              Sleeper
            </a>
            . Shows most{' '}
            {viewMode === 'trending_add' ? 'added' : 'dropped'} players across all Sleeper leagues.
          </p>

          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>Pos</th>
                  <th>Team</th>
                  <th>Age</th>
                  <th>{viewMode === 'trending_add' ? 'Adds' : 'Drops'}</th>
                </tr>
              </thead>
              <tbody>
                {filteredTrending.map((p, i) => (
                  <tr key={p.player_id}>
                    <td className="rank-cell">{i + 1}</td>
                    <td>
                      <strong>{p.full_name}</strong>
                    </td>
                    <td>
                      <span className={`pos-badge pos-${p.position}`}>{p.position}</span>
                    </td>
                    <td>{p.team}</td>
                    <td>{p.age || '-'}</td>
                    <td>
                      <strong
                        className={viewMode === 'trending_add' ? 'stat-positive' : 'stat-negative'}
                      >
                        {p.count.toLocaleString()}
                      </strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
