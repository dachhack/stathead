import { useState, useEffect, useMemo } from 'react';
import type { DynastyPlayer } from '../types';
import { fetchDynastyRankingsForDisplay } from '../data';
import { fetchStatHeadTrends } from '../lib/statheadTrend';
import { TEP_MULTIPLIERS, TEP_LABELS, type TepLevel } from '../lib/dynastyForecast';
import { PlayerName } from './PlayerName';

type FormatMode = '1qb' | 'superflex';
const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];

// TE Premium: scale TE dynasty values by the same empirical Dynasty multipliers the
// Trade Calculator uses (TE+ 1.11x, TE++ 1.215x, TE+++ 1.32x).
function tepValueFactor(position: string, level: TepLevel): number {
  return position === 'TE' ? TEP_MULTIPLIERS[level] : 1;
}

interface Props {
  onDataLoaded?: (data: unknown[]) => void;
}

export function DynastyView({ onDataLoaded }: Props) {
  const [players, setPlayers] = useState<DynastyPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [format, setFormat] = useState<FormatMode>('1qb');
  const [trends, setTrends] = useState<Map<number, number>>(new Map());
  const [posFilter, setPosFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [showRookies, setShowRookies] = useState(false);
  // TE Premium level (matches the Trade Calculator's 0–3 scale); persisted.
  const [tepLevel, setTepLevel] = useState<TepLevel>(() => {
    if (typeof localStorage === 'undefined') return 0;
    const v = Number(localStorage.getItem('dynastyTepLevel'));
    return v === 1 || v === 2 || v === 3 ? v : 0;
  });
  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('dynastyTepLevel', String(tepLevel));
  }, [tepLevel]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setTrends(new Map());
    let cancelled = false;
    fetchDynastyRankingsForDisplay(format)
      .then((data) => {
        if (cancelled) return;
        if (data.length === 0) throw new Error('StatHead dynasty values are unavailable right now');
        setPlayers(data);
        onDataLoaded?.(data);
        // StatHead 30-day value trend, from StatHead-scale history (non-blocking).
        fetchStatHeadTrends(data, format).then((t) => { if (!cancelled) setTrends(t); });
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [format, onDataLoaded]);

  const filtered = useMemo(() => {
    let data = [...players];
    if (posFilter !== 'ALL') data = data.filter((p) => p.position === posFilter);
    if (showRookies) data = data.filter((p) => p.isRookie);
    if (search) {
      const q = search.toLowerCase();
      data = data.filter(
        (p) =>
          p.playerName.toLowerCase().includes(q) || p.team.toLowerCase().includes(q)
      );
    }
    return data;
  }, [players, posFilter, search, showRookies]);

  const displayVal = (p: DynastyPlayer) =>
    Math.round((format === 'superflex' ? p.superflexValue : p.value) * tepValueFactor(p.position, tepLevel));

  const sortedFiltered = useMemo(
    () => [...filtered].sort((a, b) => displayVal(b) - displayVal(a)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, format, tepLevel],
  );

  const maxValue = useMemo(
    () => (sortedFiltered.length > 0 ? Math.max(...sortedFiltered.map(displayVal)) : 9999),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sortedFiltered, format, tepLevel]
  );

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading StatHead dynasty values...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <h3>Failed to load StatHead dynasty values</h3>
        <p>{error}</p>
      </div>
    );
  }

  return (
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
        <div className="scoring-format-tabs">
          <button
            className={`format-tab ${format === '1qb' ? 'active' : ''}`}
            onClick={() => { setFormat('1qb'); setPlayers([]); }}
          >
            1QB
          </button>
          <button
            className={`format-tab ${format === 'superflex' ? 'active' : ''}`}
            onClick={() => { setFormat('superflex'); setPlayers([]); }}
          >
            Superflex
          </button>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showRookies}
            onChange={(e) => setShowRookies(e.target.checked)}
          />
          Rookies only
        </label>
        <div className="scoring-format-tabs" title="Tight End Premium — boosts TE dynasty values (same multipliers as the Trade Calculator)">
          {([0, 1, 2, 3] as TepLevel[]).map((lv) => (
            <button
              key={lv}
              className={`format-tab ${tepLevel === lv ? 'active' : ''}`}
              onClick={() => setTepLevel(lv)}
            >
              {lv === 0 ? 'No TEP' : TEP_LABELS[lv]}
            </button>
          ))}
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          {filtered.length} players
        </span>
      </div>

      <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>
        StatHead dynasty trade values — a blend of crowdsourced market sources (KeepTradeCut
        and FantasyCalc) rescaled onto StatHead's value scale. 30d Trend is the change in
        StatHead value over the past 30 days.
      </p>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>Pos</th>
              <th>Pos Rank</th>
              <th>Team</th>
              <th>Age</th>
              <th>{format === 'superflex' ? 'SF Value' : 'Value'}</th>
              <th style={{ minWidth: 160 }}>Value Chart</th>
              {format === '1qb' ? <th>SF Value</th> : <th>1QB Value</th>}
              <th>30d Trend</th>
            </tr>
          </thead>
          <tbody>
            {sortedFiltered.map((p, i) => (
              <tr key={p.slug || `${p.playerName}-${i}`}>
                <td className="rank-cell">{i + 1}</td>
                <td>
                  <strong><PlayerName name={p.playerName} position={p.position} /></strong>
                  
                  {p.isRookie && (
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 10,
                        background: 'var(--accent)',
                        color: '#fff',
                        padding: '1px 5px',
                        borderRadius: 3,
                      }}
                    >
                      R
                    </span>
                  )}
                </td>
                <td>
                  <span className={`pos-badge pos-${p.position}`}>{p.position}</span>
                </td>
                <td>
                  {p.position}
                  {p.positionRank}
                </td>
                <td>{p.team}</td>
                <td>{p.age || '-'}</td>
                <td>
                  <strong>{displayVal(p).toLocaleString()}</strong>
                </td>
                <td>
                  <div
                    style={{
                      background: 'var(--accent)',
                      height: 14,
                      borderRadius: 3,
                      width: `${Math.max((displayVal(p) / maxValue) * 100, 1)}%`,
                      opacity: 0.7,
                    }}
                  />
                </td>
                <td style={{ color: 'var(--text-muted)' }}>
                  {format === '1qb'
                    ? (p.superflexValue > 0 ? Math.round(p.superflexValue * tepValueFactor(p.position, tepLevel)).toLocaleString() : '-')
                    : (p.value > 0 ? Math.round(p.value * tepValueFactor(p.position, tepLevel)).toLocaleString() : '-')}
                </td>
                {(() => {
                  const trend = Math.round((trends.get(p.playerID) ?? 0) * tepValueFactor(p.position, tepLevel));
                  return (
                    <td style={{ color: trend === 0 ? 'var(--text-muted)' : trend > 0 ? '#10b981' : '#ef4444' }}>
                      {trend === 0 ? '-' : `${trend > 0 ? '+' : ''}${trend.toLocaleString()}`}
                    </td>
                  );
                })()}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
