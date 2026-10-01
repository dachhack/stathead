import { useEffect, useMemo, useState } from 'react';
import type { AdpFormat } from '../lib/adpSources';
import { loadStatHeadAdp, MIN_ADP_SOURCES, type StatHeadAdpRow } from '../lib/statheadAdp';
import { teamLogoUrl } from '../lib/teamLogo';
import { PlayerName } from './PlayerName';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];
const CURRENT_SEASON = 2026;
// StatHead ADP needs ≥2 sources: FFC snapshots exist 2018+, Sleeper 2020+,
// so 2020 is the first season with a blend.
const SEASONS = Array.from({ length: CURRENT_SEASON - 2020 + 1 }, (_, i) => CURRENT_SEASON - i);

type SortKey = 'adp' | 'spread';

// Disagreement heat: tint the spread cell once sources differ by a round+.
function spreadColor(spread: number): string | undefined {
  if (spread >= 48) return '#ef4444';
  if (spread >= 24) return '#fb923c';
  if (spread >= 12) return '#facc15';
  return undefined;
}

export function ConsensusAdpView() {
  const [season, setSeason] = useState(CURRENT_SEASON);
  const [format, setFormat] = useState<AdpFormat>('1qb');
  const [rows, setRows] = useState<StatHeadAdpRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [posFilter, setPosFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('adp');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadStatHeadAdp(season, CURRENT_SEASON, format)
      .then((data) => { if (!cancelled) { setRows(data); setLoading(false); } })
      .catch((e: unknown) => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [season, format]);

  const filtered = useMemo(() => {
    let data = rows;
    if (posFilter !== 'ALL') data = data.filter((r) => r.position === posFilter);
    if (search) {
      const q = search.toLowerCase();
      data = data.filter((r) => r.name.toLowerCase().includes(q) || r.team.toLowerCase().includes(q));
    }
    const sorted = [...data];
    if (sortKey === 'spread') {
      // Contrast view: biggest disagreements first.
      sorted.sort((a, b) => b.spread - a.spread);
    } else {
      sorted.sort((a, b) => a.adp - b.adp);
    }
    return sorted.slice(0, 500);
  }, [rows, posFilter, search, sortKey]);

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
        <h2 style={{ margin: 0, fontSize: 18 }}>StatHead ADP</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 0' }}>
          StatHead ADP blends the draft markets — FantasyPros, Sleeper draft rooms, FFC mocks,
          ESPN live drafts and FantasyCalc — into one weighted mean pick (weights = sample size × recency,
          so a thin or stale market counts less). Only players priced by at least {MIN_ADP_SOURCES} sources are shown.
          {' '}<b>Spread</b> = how many picks the sources disagree by (click it to surface the players the markets can&apos;t agree on).
          {' '}Redraft drafts only — dynasty startups and rookie-only drafts are excluded at the source. SF = superflex/2QB pricing (ESPN publishes no SF ADP).
          {' '}History (2020+): a blend of the archived FFC and Sleeper snapshots (the model-training input).
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
        <div className="position-filters">
          {(['1qb', 'sf'] as const).map((f) => (
            <button
              key={f}
              className={`pos-filter ${format === f ? 'active' : ''}`}
              title={f === 'sf' ? 'Superflex / 2QB drafts — QB pricing is radically different' : '1QB PPR drafts'}
              onClick={() => setFormat(f)}
            >
              {f === 'sf' ? 'SF' : '1QB'}
            </button>
          ))}
        </div>
        <input type="text" placeholder="Search players…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="position-filters">
          {POSITIONS.map((pos) => (
            <button key={pos} className={`pos-filter ${posFilter === pos ? 'active' : ''}`} onClick={() => setPosFilter(pos)}>{pos}</button>
          ))}
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{filtered.length} players</span>
      </div>

      {loading && <div className="loading"><div className="spinner" /><div className="loading-text">Loading StatHead ADP…</div></div>}
      {error && !loading && <div className="empty-state"><h3>Couldn&apos;t load ADP</h3><p>{error}</p></div>}
      {!loading && !error && rows.length === 0 && (
        <div className="empty-state">
          <h3>StatHead ADP isn&apos;t available for {season}{format === 'sf' ? ' (SF)' : ''}</h3>
          <p>StatHead ADP needs at least {MIN_ADP_SOURCES} draft markets, and fewer are available for this season and format.</p>
        </div>
      )}

      {!loading && !error && rows.length > 0 && (
        <div className="table-container" style={{ maxHeight: 'none' }}>
          <table className="sched-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th>Pos</th>
                <th>Team</th>
                {sortableTh('adp', 'StatHead ADP', 'Weighted mean pick across the draft markets (weights = sample size × recency)')}
                {sortableTh('spread', 'Spread', 'How many picks the sources disagree by')}
                <th title="How many draft markets price this player">Srcs</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
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
                  <td style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{r.adp.toFixed(1)}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums', color: spreadColor(r.spread) ?? 'var(--text-muted)' }}>
                    {r.spread.toFixed(1)}
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>{r.sourceCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
