import { useEffect, useMemo, useState } from 'react';
import type { FantasyCalcPlayer } from '../types';
import { fetchFantasyCalcValues } from '../data';
import {
  loadAdpSources, buildMultiAdpRows,
  ADP_SOURCE_LABELS, ADP_SOURCE_TITLES,
  type AdpSourceKey, type MultiAdpRow,
} from '../lib/adpSources';
import { normName } from '../lib/nameUtils';
import { teamLogoUrl } from '../lib/teamLogo';
import { PlayerName } from './PlayerName';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];
const CURRENT_SEASON = 2026;
// FFC snapshots exist 2018+; Sleeper 2020+. Older seasons would be FFC-only.
const SEASONS = Array.from({ length: CURRENT_SEASON - 2018 + 1 }, (_, i) => CURRENT_SEASON - i);
const SOURCE_KEYS: AdpSourceKey[] = ['ffc', 'sleeper', 'espn', 'fc'];

type SortKey = 'blend' | 'spread' | AdpSourceKey;

function Trend({ v }: { v: number }) {
  if (!v) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  const up = v > 0;
  return <span className={up ? 'stat-positive' : 'stat-negative'}>{up ? '▲' : '▼'} {Math.abs(v)}</span>;
}

// Disagreement heat: tint the spread cell once sources differ by a round+.
function spreadColor(spread: number): string | undefined {
  if (spread >= 48) return '#ef4444';
  if (spread >= 24) return '#fb923c';
  if (spread >= 12) return '#facc15';
  return undefined;
}

export function ConsensusAdpView() {
  const [season, setSeason] = useState(CURRENT_SEASON);
  const [rows, setRows] = useState<MultiAdpRow[]>([]);
  const [fcByName, setFcByName] = useState<Map<string, FantasyCalcPlayer>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [posFilter, setPosFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('blend');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadAdpSources(season, CURRENT_SEASON)
      .then((data) => { if (!cancelled) { setRows(buildMultiAdpRows(data)); setLoading(false); } })
      .catch((e: unknown) => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [season]);

  // FantasyCalc extras (value / 30d trend) for the current season.
  useEffect(() => {
    let cancelled = false;
    fetchFantasyCalcValues(false, 1, 12, 1)
      .then((data) => {
        if (cancelled) return;
        const m = new Map<string, FantasyCalcPlayer>();
        for (const p of data) m.set(normName(p.player.name), p);
        setFcByName(m);
      })
      .catch(() => { /* extras only */ });
    return () => { cancelled = true; };
  }, []);

  // Hide source columns with no data for the selected season (e.g. Sleeper
  // pre-2020, FantasyCalc on historic seasons, ESPN when unreachable).
  const activeSources = useMemo(
    () => SOURCE_KEYS.filter((k) => rows.some((r) => r.adp[k] !== undefined)),
    [rows],
  );

  const filtered = useMemo(() => {
    let data = rows;
    if (posFilter !== 'ALL') data = data.filter((r) => r.position === posFilter);
    if (search) {
      const q = search.toLowerCase();
      data = data.filter((r) => r.name.toLowerCase().includes(q) || r.team.toLowerCase().includes(q));
    }
    const sorted = [...data];
    if (sortKey === 'spread') {
      // Contrast view: biggest disagreements first, but only where 2+
      // sources actually price the player.
      sorted.sort((a, b) => (b.sourceCount > 1 ? b.spread : -1) - (a.sourceCount > 1 ? a.spread : -1));
    } else if (sortKey === 'blend') {
      sorted.sort((a, b) => a.blend - b.blend);
    } else {
      sorted.sort((a, b) => (a.adp[sortKey] ?? 9999) - (b.adp[sortKey] ?? 9999));
    }
    return sorted.slice(0, 500);
  }, [rows, posFilter, search, sortKey]);

  const isCurrent = season === CURRENT_SEASON;
  const sortableTh = (key: SortKey, label: string, title: string) => (
    <th
      key={key}
      title={`${title} — click to sort`}
      onClick={() => setSortKey(key)}
      style={{ cursor: 'pointer', color: sortKey === key ? 'var(--accent)' : undefined, whiteSpace: 'nowrap' }}
    >
      {label}{sortKey === key ? ' ▾' : ''}
    </th>
  );

  return (
    <div className="sl-page">
      <div className="sched-header">
        <h2 style={{ margin: 0, fontSize: 18 }}>Consensus ADP</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 0' }}>
          Side-by-side market ADP from{' '}
          <a href="https://fantasyfootballcalculator.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>FFC</a> mocks,{' '}
          <a href="https://sleeper.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>Sleeper</a> draft rooms,{' '}
          ESPN live drafts and{' '}
          <a href="https://fantasycalc.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>FantasyCalc</a> consensus.
          {' '}<b>Blend</b> = mean pick across available sources; <b>Spread</b> = max−min disagreement (click it to surface the players the markets can&apos;t agree on).
          {' '}History: FFC back to 2018, Sleeper back to 2020 — immutable committed snapshots (the model-training input); ESPN/FantasyCalc are current-season only.
        </p>
      </div>

      <div className="controls">
        <select
          value={season}
          onChange={(e) => setSeason(Number(e.target.value))}
          style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '4px 8px', fontSize: 13, color: 'var(--text-primary)', fontFamily: 'inherit',
          }}
        >
          {SEASONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input type="text" placeholder="Search players…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="position-filters">
          {POSITIONS.map((pos) => (
            <button key={pos} className={`pos-filter ${posFilter === pos ? 'active' : ''}`} onClick={() => setPosFilter(pos)}>{pos}</button>
          ))}
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{filtered.length} players</span>
      </div>

      {loading && <div className="loading"><div className="spinner" /><div className="loading-text">Loading ADP sources…</div></div>}
      {error && !loading && <div className="empty-state"><h3>Couldn&apos;t load ADP</h3><p>{error}</p></div>}

      {!loading && !error && (
        <div className="table-container" style={{ maxHeight: 'none' }}>
          <table className="sched-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th>Pos</th>
                <th>Team</th>
                {sortableTh('blend', 'Blend', 'Mean pick across available sources')}
                {activeSources.map((k) => sortableTh(k, ADP_SOURCE_LABELS[k], ADP_SOURCE_TITLES[k]))}
                {sortableTh('spread', 'Spread', 'Disagreement across sources (max − min picks)')}
                <th title="How many sources price this player">Srcs</th>
                {isCurrent && <th title="FantasyCalc consensus value">Value</th>}
                {isCurrent && <th title="30-day value trend">30d</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const fc = isCurrent ? fcByName.get(normName(r.name)) : undefined;
                return (
                  <tr key={`${r.name}:${r.position}`}>
                    <td className="rank-cell">{i + 1}</td>
                    <td>
                      <strong><PlayerName sleeperId={r.sleeperId} name={r.name} position={r.position} /></strong>
                    </td>
                    <td><span className={`pos-badge pos-${r.position}`}>{r.position}</span></td>
                    <td>
                      {r.team && <img src={teamLogoUrl(r.team)} alt="" width={16} height={16} style={{ objectFit: 'contain', verticalAlign: 'middle', marginRight: 4 }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
                      {r.team || '—'}
                    </td>
                    <td style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{r.blend.toFixed(1)}</td>
                    {activeSources.map((k) => (
                      <td key={k} style={{ fontVariantNumeric: 'tabular-nums', color: r.adp[k] === undefined ? 'var(--text-muted)' : undefined }}>
                        {r.adp[k] !== undefined ? r.adp[k]!.toFixed(1) : '—'}
                      </td>
                    ))}
                    <td style={{ fontVariantNumeric: 'tabular-nums', color: spreadColor(r.spread) ?? 'var(--text-muted)' }}>
                      {r.sourceCount > 1 ? r.spread.toFixed(1) : '—'}
                    </td>
                    <td style={{ color: 'var(--text-muted)' }}>{r.sourceCount}</td>
                    {isCurrent && <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fc ? fc.value.toLocaleString() : '—'}</td>}
                    {isCurrent && <td>{fc ? <Trend v={fc.trend30Day} /> : '—'}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
