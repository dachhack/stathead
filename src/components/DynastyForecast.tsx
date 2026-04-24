import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
  ResponsiveContainer, Area, ComposedChart,
} from 'recharts';
import type { KTCPlayer } from '../types';
import { fetchKTCRankings, fetchKTCHistory } from '../data';
import {
  loadForecasts, getPlayerForecasts,
  type ForecastCache, type ForecastResult,
} from '../lib/ktcForecast';

// ── Forecast types ───────────────────────────────────────────────────

interface ForecastPoint extends ForecastResult {
  cvR2: number | null;
}

interface PlayerForecast {
  player: KTCPlayer;
  currentValue: number;
  forecasts: ForecastPoint[];
  signal: number; // within-position z-score of composite log-return
}

// ── Colors ───────────────────────────────────────────────────────────

const POS_COLORS: Record<string, string> = {
  QB: '#6366f1',
  RB: '#22c55e',
  WR: '#f59e0b',
  TE: '#ec4899',
};

function posColor(pos: string): string {
  return POS_COLORS[pos] || '#94a3b8';
}

// ── Chart data ───────────────────────────────────────────────────────

interface ChartRow {
  days: number;
  history?: number;
  forecast?: number;
  ciLow: number;
  ciHigh: number;
}

function buildChartData(
  currentValue: number,
  forecasts: ForecastPoint[],
  history: { d: string; v: number }[],
): ChartRow[] {
  const rows: ChartRow[] = [];
  const now = Date.now();

  // Historical data: last 180 days, sampled to ~20 points
  if (history.length > 0) {
    const cutoff = now - 180 * 86400000;
    const recent = history.filter(h => new Date(h.d).getTime() >= cutoff);
    const step = Math.max(1, Math.ceil(recent.length / 20));
    for (let i = 0; i < recent.length; i += step) {
      const h = recent[i];
      const days = Math.round((new Date(h.d).getTime() - now) / 86400000);
      rows.push({ days, history: h.v, ciLow: h.v, ciHigh: h.v });
    }
    // Always include the last history point for a smooth bridge to "Now"
    const last = recent[recent.length - 1];
    if (last && rows.length > 0) {
      const lastDays = Math.round((new Date(last.d).getTime() - now) / 86400000);
      if (rows[rows.length - 1].days !== lastDays) {
        rows.push({ days: lastDays, history: last.v, ciLow: last.v, ciHigh: last.v });
      }
    }
  }

  // "Now" bridge: connects history and forecast lines
  rows.push({
    days: 0,
    history: currentValue,
    forecast: currentValue,
    ciLow: currentValue,
    ciHigh: currentValue,
  });

  // Forecast points
  for (const f of forecasts) {
    rows.push({
      days: f.horizon,
      forecast: Math.round(f.value),
      ciLow: Math.round(f.ciLow),
      ciHigh: Math.round(f.ciHigh),
    });
  }

  return rows;
}

// ── Component ────────────────────────────────────────────────────────

export function DynastyForecast({ onDataLoaded }: { onDataLoaded?: (d: unknown[]) => void }) {
  const [forecastCache, setForecastCache] = useState<ForecastCache | null>(null);
  const [players, setPlayers] = useState<KTCPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [posFilter, setPosFilter] = useState<string>('ALL');
  const [format, setFormat] = useState<'1qb' | 'superflex'>('1qb');
  const [sortCol, setSortCol] = useState<string>('now');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [selectedHistory, setSelectedHistory] = useState<{ d: string; v: number }[]>([]);

  // Load data
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [cache, rankings] = await Promise.all([
          loadForecasts(format).then(c => {
            if (!c) throw new Error('Forecast data unavailable');
            return c;
          }),
          fetchKTCRankings(format),
        ]);
        if (cancelled) return;
        setForecastCache(cache);
        setPlayers(rankings);
        onDataLoaded?.(rankings);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [onDataLoaded, format]);

  // Fetch value history for the selected player (for chart)
  useEffect(() => {
    if (selectedId === null) { setSelectedHistory([]); return; }
    fetchKTCHistory([selectedId])
      .then(data => {
        const h = data.find(d => d.playerID === selectedId);
        if (h) {
          setSelectedHistory(format === 'superflex' ? h.superflex.valueHistory : h.oneQB.valueHistory);
        } else {
          setSelectedHistory([]);
        }
      })
      .catch(() => setSelectedHistory([]));
  }, [selectedId, format]);

  // Build forecasts from pre-computed cache + compute within-position signal
  const allForecasts = useMemo(() => {
    if (!forecastCache || players.length === 0) return [];

    // Weights for the composite: heavier on shorter, more reliable horizons
    const SIGNAL_WEIGHTS: Record<number, number> = { 7: 0.10, 30: 0.25, 60: 0.25, 90: 0.25, 120: 0.15 };

    // First pass: collect raw data + composite scores per position
    const raw: Array<{ player: KTCPlayer; currentValue: number; forecasts: ForecastPoint[]; composite: number }> = [];
    const compositesByPos = new Map<string, number[]>();

    for (const player of players) {
      if (!['QB', 'RB', 'WR', 'TE'].includes(player.position)) continue;
      const currentValue = format === 'superflex' ? player.superflexValue : player.value;
      const allHorizons = getPlayerForecasts(forecastCache, player.playerID);
      // Display H=7..90; 120d feeds the signal but isn't shown as a column
      const forecasts = allHorizons
        .filter(f => f.horizon !== 120)
        .map(f => ({ ...f, cvR2: null as number | null }));
      if (forecasts.length === 0) continue;

      // Weighted composite of log-returns across all horizons (including 120d)
      let wSum = 0, wTotal = 0;
      for (const f of allHorizons) {
        const w = SIGNAL_WEIGHTS[f.horizon] ?? 0;
        if (w > 0) { wSum += w * f.logReturn; wTotal += w; }
      }
      const composite = wTotal > 0 ? wSum / wTotal : 0;

      raw.push({ player, currentValue, forecasts, composite });
      const arr = compositesByPos.get(player.position) || [];
      arr.push(composite);
      compositesByPos.set(player.position, arr);
    }

    // Compute per-position mean + std for z-scoring
    const posStats = new Map<string, { mean: number; std: number }>();
    for (const [pos, vals] of compositesByPos) {
      const n = vals.length;
      const mean = vals.reduce((a, b) => a + b, 0) / n;
      const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / n) || 1;
      posStats.set(pos, { mean, std });
    }

    // Second pass: z-score each player within their position
    return raw.map(({ player, currentValue, forecasts, composite }) => {
      const { mean, std } = posStats.get(player.position) || { mean: 0, std: 1 };
      const signal = (composite - mean) / std;
      return { player, currentValue, forecasts, signal };
    });
  }, [forecastCache, players, format]);

  // Filtered + searched + sorted list
  const filtered = useMemo(() => {
    let list = allForecasts;
    if (posFilter !== 'ALL') {
      list = list.filter(f => f.player.position === posFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(f => f.player.playerName.toLowerCase().includes(q));
    }
    const getSortValue = (pf: PlayerForecast): number | string => {
      if (sortCol === 'player') return pf.player.playerName.toLowerCase();
      if (sortCol === 'now') return pf.currentValue;
      if (sortCol === 'signal') return pf.signal;
      if (sortCol === 'trend') {
        const last = pf.forecasts[pf.forecasts.length - 1];
        return last ? (last.value - pf.currentValue) / pf.currentValue : 0;
      }
      const h = parseInt(sortCol);
      if (!isNaN(h)) {
        const f = pf.forecasts.find(x => x.horizon === h);
        return f ? f.value : 0;
      }
      return 0;
    };
    return [...list].sort((a, b) => {
      const va = getSortValue(a);
      const vb = getSortValue(b);
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDir === 'desc' ? -cmp : cmp;
    });
  }, [allForecasts, posFilter, search, sortCol, sortDir]);

  const selectedForecast = useMemo(() => {
    if (selectedId === null) return null;
    return allForecasts.find(f => f.player.playerID === selectedId) ?? null;
  }, [allForecasts, selectedId]);

  const handlePlayerClick = useCallback((id: number) => {
    setSelectedId(prev => prev === id ? null : id);
  }, []);

  const handleSort = useCallback((col: string) => {
    setSortCol(prev => {
      if (prev === col) {
        setSortDir(d => d === 'desc' ? 'asc' : 'desc');
        return col;
      }
      // Default: descending for numbers, ascending for player name
      setSortDir(col === 'player' ? 'asc' : 'desc');
      return col;
    });
  }, []);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading dynasty forecast models...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <h3>Failed to load forecast data</h3>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ padding: '16px 16px 8px' }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>Dynasty Value Forecast</h2>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-muted)' }}>
          GBM time-series models predict dynasty value changes at 7/30/60/90 day horizons.
          Signal is a within-position z-score of composite momentum (higher = rising faster than peers).
        </p>

        {/* Controls */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={format}
            onChange={e => setFormat(e.target.value as '1qb' | 'superflex')}
            style={{
              padding: '4px 8px', fontSize: 12, background: 'var(--bg-secondary)',
              border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)',
            }}
          >
            <option value="1qb">1QB</option>
            <option value="superflex">Superflex</option>
          </select>
          <input
            type="text"
            placeholder="Search player..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              padding: '6px 10px', fontSize: 13, background: 'var(--bg-secondary)',
              border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)',
              width: 220,
            }}
          />
          {['ALL', 'QB', 'RB', 'WR', 'TE'].map(pos => (
            <button
              key={pos}
              onClick={() => setPosFilter(pos)}
              style={{
                padding: '4px 10px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
                border: posFilter === pos ? '1px solid var(--text-primary)' : '1px solid var(--border)',
                background: posFilter === pos ? 'var(--bg-tertiary)' : 'transparent',
                color: pos === 'ALL' ? 'var(--text-primary)' : posColor(pos),
                fontWeight: posFilter === pos ? 700 : 400,
              }}
            >
              {pos}
            </button>
          ))}
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
            {filtered.length} players
          </span>
        </div>
      </div>

      {/* Selected player chart */}
      {selectedForecast && (
        <div style={{
          margin: '8px 16px 0', padding: 16,
          background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div>
              <span style={{ fontSize: 16, fontWeight: 700 }}>{selectedForecast.player.playerName}</span>
              <span style={{ fontSize: 12, color: posColor(selectedForecast.player.position), marginLeft: 8, fontWeight: 600 }}>
                {selectedForecast.player.position} - {selectedForecast.player.team}
              </span>
            </div>
            <button
              onClick={() => setSelectedId(null)}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16 }}
            >
              ✕
            </button>
          </div>
          <ForecastChart
            currentValue={selectedForecast.currentValue}
            forecasts={selectedForecast.forecasts}
            position={selectedForecast.player.position}
            history={selectedHistory}
          />
        </div>
      )}

      {/* Player table */}
      <div style={{ padding: '8px 16px 16px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border)' }}>
              {([
                { col: 'player', label: 'Player', right: false },
                { col: 'now', label: 'Now', right: true },
                { col: '7', label: '+7d', right: true },
                { col: '30', label: '+30d', right: true },
                { col: '60', label: '+60d', right: true },
                { col: '90', label: '+90d', right: true },
                { col: 'signal', label: 'Signal', right: true },
                { col: 'trend', label: 'Trend', right: true },
              ] as const).map(({ col, label, right }) => (
                <th
                  key={col}
                  onClick={() => handleSort(col)}
                  style={{
                    ...(right ? thStyleR : thStyle),
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                >
                  {label}
                  {sortCol === col && (
                    <span style={{ marginLeft: 3, fontSize: 9 }}>
                      {sortDir === 'desc' ? '\u25BC' : '\u25B2'}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 100).map(({ player, currentValue, forecasts, signal }) => {
              const last = forecasts[forecasts.length - 1];
              const pctChange = last ? (last.value - currentValue) / currentValue * 100 : 0;
              const isSelected = selectedId === player.playerID;
              return (
                <tr
                  key={player.playerID}
                  onClick={() => handlePlayerClick(player.playerID)}
                  style={{
                    borderBottom: '1px solid var(--border)',
                    cursor: 'pointer',
                    background: isSelected ? 'var(--bg-tertiary)' : 'transparent',
                  }}
                  onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--bg-secondary)'; }}
                  onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                >
                  <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                    <span style={{ color: posColor(player.position), fontWeight: 600, marginRight: 6, fontSize: 11 }}>
                      {player.position}
                    </span>
                    {player.playerName}
                    <span style={{ color: 'var(--text-muted)', fontSize: 11, marginLeft: 6 }}>{player.team}</span>
                  </td>
                  <td style={tdR}>{currentValue.toLocaleString()}</td>
                  {[7, 30, 60, 90].map(h => {
                    const f = forecasts.find(x => x.horizon === h);
                    if (!f) return <td key={h} style={tdR}>-</td>;
                    const delta = f.value - currentValue;
                    return (
                      <td key={h} style={{ ...tdR, color: deltaColor(delta) }}>
                        {Math.round(f.value).toLocaleString()}
                      </td>
                    );
                  })}
                  <td style={{ ...tdR, color: signalColor(signal), fontWeight: 700 }}>
                    {signalLabel(signal)}
                  </td>
                  <td style={{ ...tdR, color: trendColor(pctChange), fontWeight: 600 }}>
                    {pctChange >= 0 ? '+' : ''}{pctChange.toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length > 100 && (
          <div style={{ textAlign: 'center', padding: 8, fontSize: 12, color: 'var(--text-muted)' }}>
            Showing top 100 of {filtered.length}. Use search to find specific players.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────

function ForecastChart({ currentValue, forecasts, position, history }: {
  currentValue: number;
  forecasts: ForecastPoint[];
  position: string;
  history: { d: string; v: number }[];
}) {
  const data = buildChartData(currentValue, forecasts, history);
  const color = posColor(position);
  const ciColor = color + '20';

  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="days"
          type="number"
          domain={['dataMin', 'dataMax']}
          tickFormatter={(days: number) => {
            if (days === 0) return 'Now';
            if (days > 0) return `+${days}d`;
            const d = new Date();
            d.setDate(d.getDate() + days);
            return `${d.getMonth() + 1}/${d.getDate()}`;
          }}
          stroke="var(--text-muted)"
          fontSize={11}
        />
        <YAxis
          stroke="var(--text-muted)"
          fontSize={10}
          tickFormatter={(v: number) => v.toLocaleString()}
          domain={['auto', 'auto']}
        />
        <Tooltip
          contentStyle={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            fontSize: 12,
          }}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          formatter={((value: any, name: any) => {
            if (name === 'ciHigh' || name === 'ciLow') return [null, null];
            const label = name === 'history' ? 'Value' : 'Forecast';
            return [Math.round(Number(value)).toLocaleString(), label];
          }) as any}
          labelFormatter={(days) => {
            const d = Number(days);
            if (d === 0) return 'Today';
            if (d > 0) return `+${d} days`;
            const date = new Date();
            date.setDate(date.getDate() + d);
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          }}
        />
        {/* CI band: fills between ciLow and ciHigh (zero-width over history) */}
        <Area
          dataKey="ciHigh"
          stroke="none"
          fill={ciColor}
          legendType="none"
          tooltipType="none"
          baseLine={data.map(d => d.ciLow) as any}
        />
        {/* Historical value: solid line */}
        <Line
          type="monotone"
          dataKey="history"
          stroke={color}
          strokeWidth={2}
          dot={false}
          name="history"
          connectNulls={false}
        />
        {/* Forecast: dashed line with dots */}
        <Line
          type="monotone"
          dataKey="forecast"
          stroke={color}
          strokeWidth={2.5}
          strokeDasharray="6 3"
          dot={{ fill: color, r: 4 }}
          name="forecast"
          connectNulls={false}
        />
        {/* "Now" reference line */}
        <ReferenceLine x={0} stroke="var(--text-muted)" strokeDasharray="3 3" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ── Style helpers ────────────────────────────────────────────────────

const thStyle: React.CSSProperties = {
  padding: '6px 8px', textAlign: 'left', fontSize: 11,
  color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase',
};

const thStyleR: React.CSSProperties = { ...thStyle, textAlign: 'right' };

const tdR: React.CSSProperties = {
  padding: '6px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
};

function deltaColor(delta: number): string {
  if (delta > 300) return '#22c55e';
  if (delta > 50) return '#4ade80';
  if (delta > -50) return 'var(--text-secondary)';
  if (delta > -300) return '#fb923c';
  return '#ef4444';
}

function trendColor(pct: number): string {
  if (pct > 5) return '#22c55e';
  if (pct > 1) return '#4ade80';
  if (pct > -1) return 'var(--text-secondary)';
  if (pct > -5) return '#fb923c';
  return '#ef4444';
}

function signalColor(z: number): string {
  if (z >= 1.5) return '#22c55e';
  if (z >= 0.5) return '#4ade80';
  if (z > -0.5) return 'var(--text-secondary)';
  if (z > -1.5) return '#fb923c';
  return '#ef4444';
}

function signalLabel(z: number): string {
  const sign = z >= 0 ? '+' : '';
  const abs = Math.abs(z);
  let tag: string;
  if (abs >= 2.0) tag = 'Strong';
  else if (abs >= 1.0) tag = 'Mod';
  else if (abs >= 0.3) tag = 'Mild';
  else return 'Neutral';
  return `${sign}${z.toFixed(1)} ${tag}`;
}
