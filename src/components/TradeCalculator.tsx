import { useState, useEffect, useMemo } from 'react';
import { PlayerName } from './PlayerName';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import type { DynastyPlayer, DynastyPlayerHistory } from '../types';
import { fetchDynastyRankingsForDisplay, fetchDynastyHistoryForDisplay } from '../data';
import { loadForecastsForDisplay, getPlayerForecasts, getProjectedValueFromCache, loadRedraftLookup, getRedraftPPG, TEP_MULTIPLIERS, TEP_LABELS, type ForecastCache, type ForecastResult, type RedraftLookup, type TepLevel } from '../lib/dynastyForecast';

const SIDE_A_COLOR = '#6366f1';
const SIDE_B_COLOR = '#f59e0b';

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[.\-']/g, '').replace(/\s+/g, ' ').trim();
}

function valueColor(value: number): string {
  if (value >= 7000) return '#22c55e';
  if (value >= 5000) return '#4ade80';
  if (value >= 3000) return '#a3e635';
  if (value >= 1500) return '#facc15';
  if (value >= 500) return '#fb923c';
  return 'var(--text-muted)';
}

function deltaColor(delta: number): string {
  if (delta > 500) return '#22c55e';
  if (delta > 100) return '#4ade80';
  if (delta > -100) return 'var(--text-secondary)';
  if (delta > -500) return '#fb923c';
  return '#ef4444';
}

function fmtDelta(v: number): string {
  return (v >= 0 ? '+' : '') + v.toLocaleString();
}

function fmtDate(d: string): string {
  const [, m, dd] = d.split('-');
  return `${parseInt(m)}/${dd}`;
}

function fmtMonthYear(d: string): string {
  const [y, m] = d.split('-');
  return `${parseInt(m)}/${y.slice(2)}`;
}

/** Estimate projected value using 30-day trend extrapolated 90 days */
function projectValue(current: number, trend30Day: number | undefined): number {
  if (!trend30Day) return current;
  // Extrapolate 3 months (dampen: 90 days but with decay)
  const projected = current + Math.round(trend30Day * 2.5);
  return Math.max(0, projected);
}

/** Use value history to compute 30/60/90 day change */
function computeHistoricalDeltas(
  history: { d: string; v: number }[],
): { d30: number | null; d60: number | null; d90: number | null } {
  if (history.length < 2) return { d30: null, d60: null, d90: null };
  const now = history[history.length - 1];
  const nowDate = new Date(now.d).getTime();
  const find = (days: number) => {
    const target = nowDate - days * 86400000;
    let closest = history[0];
    for (const h of history) {
      if (Math.abs(new Date(h.d).getTime() - target) < Math.abs(new Date(closest.d).getTime() - target)) {
        closest = h;
      }
    }
    // Only use if within 15 days of target
    if (Math.abs(new Date(closest.d).getTime() - target) > 15 * 86400000) return null;
    return now.v - closest.v;
  };
  return { d30: find(30), d60: find(60), d90: find(90) };
}

interface Props {
  onDataLoaded?: (data: unknown[]) => void;
}

export function TradeCalculator({ onDataLoaded }: Props) {
  const [players, setPlayers] = useState<DynastyPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [leagueFormat, setLeagueFormat] = useState<'1qb' | 'superflex'>('1qb');
  const [tepLevel, setTepLevel] = useState<TepLevel>(0);
  const [sideA, setSideA] = useState<DynastyPlayer[]>([]);
  const [sideB, setSideB] = useState<DynastyPlayer[]>([]);
  const [searchA, setSearchA] = useState('');
  const [searchB, setSearchB] = useState('');
  const [historyData, setHistoryData] = useState<DynastyPlayerHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [tradeDate, setTradeDate] = useState<string>('');
  const [forecastCache, setForecastCache] = useState<ForecastCache | null>(null);
  const [redraftLookup, setRedraftLookup] = useState<RedraftLookup | null>(null);

  // Dynasty only has 1QB and superflex; TEP is an orthogonal overlay
  const dynastyFormat = leagueFormat;
  // scoringFormat is no longer needed — tepLevel is passed directly to getRedraftPPG

  useEffect(() => {
    // Only show full loading spinner on initial load — format switches update silently
    if (players.length === 0) setLoading(true);
    fetchDynastyRankingsForDisplay(dynastyFormat as '1qb' | 'superflex')
      .then((data) => {
        setPlayers(data);
        onDataLoaded?.(data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [dynastyFormat, onDataLoaded]);

  // Load pre-computed Dynasty forecasts (fire-and-forget, non-blocking)
  useEffect(() => {
    loadForecastsForDisplay(dynastyFormat as '1qb' | 'superflex')
      .then(c => { if (c) setForecastCache(c); });
  }, [dynastyFormat]);

  // Load redraft PPG projections (one-time, format-independent)
  useEffect(() => {
    loadRedraftLookup().then(setRedraftLookup);
  }, []);

  // Fetch history for all players in the trade
  const tradePlayers = useMemo(() => [...sideA, ...sideB], [sideA, sideB]);
  const allTradePlayerIds = useMemo(
    () => tradePlayers.map((p) => p.playerID),
    [tradePlayers],
  );

  useEffect(() => {
    if (allTradePlayerIds.length === 0) {
      setHistoryData([]);
      return;
    }
    setHistoryLoading(true);
    const positionByID = new Map(tradePlayers.map((p) => [p.playerID, p.position]));
    fetchDynastyHistoryForDisplay(allTradePlayerIds, positionByID)
      .then(setHistoryData)
      .catch(() => setHistoryData([]))
      .finally(() => setHistoryLoading(false));
  }, [allTradePlayerIds, tradePlayers]);

  const getValue = (p: DynastyPlayer) => {
    const base = leagueFormat === '1qb' ? p.value : p.superflexValue;
    if (tepLevel > 0 && p.position === 'TE') {
      return Math.round(base * TEP_MULTIPLIERS[tepLevel]);
    }
    return base;
  };

  /** Apply TEP boost to a raw Dynasty value for a player (used for history/forecasts) */
  const tepAdjust = (p: DynastyPlayer, val: number): number =>
    tepLevel > 0 && p.position === 'TE' ? Math.round(val * TEP_MULTIPLIERS[tepLevel]) : val;

  const getHistory = (playerID: number) => {
    const h = historyData.find((d) => d.playerID === playerID);
    if (!h) return [];
    return leagueFormat === '1qb' ? h.oneQB.valueHistory : h.superflex.valueHistory;
  };

  // Pre-computed GBM forecasts for trade players (keyed by playerID)
  const gbmForecasts = useMemo(() => {
    const map = new Map<number, ForecastResult[]>();
    if (!forecastCache) return map;
    const tradePlayers = [...sideA, ...sideB];
    for (const p of tradePlayers) {
      if (map.has(p.playerID)) continue;
      const forecasts = getPlayerForecasts(forecastCache, p.playerID);
      if (forecasts.length > 0) map.set(p.playerID, forecasts);
    }
    return map;
  }, [forecastCache, sideA, sideB]);

  /** Get GBM projected value at ~90 days, falling back to linear trend. */
  const getProjectedValue = (p: DynastyPlayer): number => {
    if (forecastCache) {
      const val = getProjectedValueFromCache(forecastCache, p.playerID, 90);
      if (val !== null) return tepAdjust(p, val);
    }
    // Fallback: getValue already includes TEP boost
    return projectValue(getValue(p), p.trend30Day);
  };

  /** Get a player's value on or near a specific date from history */
  const getValueAtDate = (playerID: number, dateStr: string): number | null => {
    const hist = getHistory(playerID);
    if (hist.length === 0) return null;
    let best = hist[0];
    for (const h of hist) {
      if (h.d <= dateStr) best = h;
      else break;
    }
    // Only valid if within 10 days of target
    if (Math.abs(new Date(best.d).getTime() - new Date(dateStr).getTime()) > 10 * 86400000) return null;
    return best.v;
  };

  /** Get redraft projected PPG for a player, adjusted for scoring format. */
  const getPlayerPPG = (p: DynastyPlayer): number | null => {
    if (!redraftLookup) return null;
    return getRedraftPPG(redraftLookup, p.playerName, p.position, tepLevel);
  };

  const totalA = sideA.reduce((sum, p) => sum + getValue(p), 0);
  const totalB = sideB.reduce((sum, p) => sum + getValue(p), 0);
  const diff = totalA - totalB;

  // Redraft PPG totals (only meaningful for current-date evaluation)
  const redraftA = sideA.reduce((sum, p) => sum + (getPlayerPPG(p) ?? 0), 0);
  const redraftB = sideB.reduce((sum, p) => sum + (getPlayerPPG(p) ?? 0), 0);
  const redraftDiff = redraftA - redraftB;

  // Trade-date values (if a date is set)
  const tradeDateTotals = useMemo(() => {
    if (!tradeDate || historyData.length === 0) return null;
    let aTotal = 0;
    let bTotal = 0;
    let valid = true;
    for (const p of sideA) {
      const v = getValueAtDate(p.playerID, tradeDate);
      if (v == null) { valid = false; break; }
      aTotal += tepAdjust(p, v);
    }
    if (valid) {
      for (const p of sideB) {
        const v = getValueAtDate(p.playerID, tradeDate);
        if (v == null) { valid = false; break; }
        bTotal += tepAdjust(p, v);
      }
    }
    if (!valid || (sideA.length === 0 && sideB.length === 0)) return null;
    return { aTotal, bTotal, diff: aTotal - bTotal };
  }, [tradeDate, sideA, sideB, historyData, leagueFormat, tepLevel]);

  const hasRedraft = !tradeDateTotals && redraftLookup !== null && (redraftA > 0 || redraftB > 0);

  // Projected totals (GBM at H=90, with linear fallback)
  const projA = sideA.reduce((sum, p) => sum + getProjectedValue(p), 0);
  const projB = sideB.reduce((sum, p) => sum + getProjectedValue(p), 0);
  const projDiff = projA - projB;

  // Effective evaluation: use trade-date values when set, otherwise current
  const evalA = tradeDateTotals ? tradeDateTotals.aTotal : totalA;
  const evalB = tradeDateTotals ? tradeDateTotals.bTotal : totalB;
  const evalDiff = evalA - evalB;

  const suggestionsA = useMemo(() => {
    if (!searchA) return [];
    const q = normalizeName(searchA);
    return players
      .filter((p) => normalizeName(p.playerName).includes(q) && !sideA.some((s) => s.playerID === p.playerID))
      .slice(0, 8);
  }, [searchA, players, sideA]);

  const suggestionsB = useMemo(() => {
    if (!searchB) return [];
    const q = normalizeName(searchB);
    return players
      .filter((p) => normalizeName(p.playerName).includes(q) && !sideB.some((s) => s.playerID === p.playerID))
      .slice(0, 8);
  }, [searchB, players, sideB]);

  // Build history chart: aggregate side totals over time
  const chartData = useMemo(() => {
    if (sideA.length === 0 && sideB.length === 0) return [];
    const allDates = new Set<string>();
    const playerHistories = new Map<number, Map<string, number>>();

    for (const p of [...sideA, ...sideB]) {
      const hist = getHistory(p.playerID);
      const dateMap = new Map<string, number>();
      for (const h of hist) {
        allDates.add(h.d);
        dateMap.set(h.d, h.v);
      }
      playerHistories.set(p.playerID, dateMap);
    }

    const dates = Array.from(allDates).sort();
    // Only show last 12 months
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 12);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const filteredDates = dates.filter((d) => d >= cutoffStr);

    // Build running last-known values (with TEP boost for TEs)
    const rows = filteredDates.map((date) => {
      let aTotal = 0;
      let bTotal = 0;
      for (const p of sideA) {
        const hist = playerHistories.get(p.playerID);
        if (hist) {
          // Find latest value on or before this date
          let val = 0;
          const allH = getHistory(p.playerID);
          for (const h of allH) {
            if (h.d <= date) val = h.v;
            else break;
          }
          aTotal += tepAdjust(p, val);
        }
      }
      for (const p of sideB) {
        const hist = playerHistories.get(p.playerID);
        if (hist) {
          let val = 0;
          const allH = getHistory(p.playerID);
          for (const h of allH) {
            if (h.d <= date) val = h.v;
            else break;
          }
          bTotal += tepAdjust(p, val);
        }
      }
      return { date, 'Side A': aTotal, 'Side B': bTotal };
    });

    // Add projected dashed segment: bridge from last actual to 90-day projection
    if (rows.length > 0 && (sideA.length > 0 || sideB.length > 0)) {
      const last = rows[rows.length - 1];
      const projATotal = sideA.reduce((sum, p) => sum + getProjectedValue(p), 0);
      const projBTotal = sideB.reduce((sum, p) => sum + getProjectedValue(p), 0);
      (last as any)['Side A Proj'] = last['Side A'];
      (last as any)['Side B Proj'] = last['Side B'];

      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 90);
      const futureDateStr = futureDate.toISOString().slice(0, 10);
      rows.push({
        date: futureDateStr,
        'Side A Proj': projATotal,
        'Side B Proj': projBTotal,
      } as any);
    }

    return rows;
  }, [sideA, sideB, historyData, leagueFormat, tepLevel]);

  // Balance suggestions
  const balanceSuggestions = useMemo(() => {
    if (Math.abs(diff) < 200) return [];
    const losing = diff > 0 ? 'B' : 'A';
    const gap = Math.abs(diff);
    const usedIds = new Set([...sideA, ...sideB].map((p) => p.playerID));
    return players
      .filter((p) => !usedIds.has(p.playerID) && getValue(p) > 0)
      .map((p) => ({ player: p, delta: Math.abs(getValue(p) - gap) }))
      .sort((a, b) => a.delta - b.delta)
      .slice(0, 5)
      .map((x) => ({ ...x, side: losing }));
  }, [diff, players, sideA, sideB, leagueFormat, tepLevel]);

  if (loading)
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading dynasty values...</div>
      </div>
    );
  if (error)
    return (
      <div className="empty-state">
        <h3>Failed to load trade values</h3>
        <p>{error}</p>
      </div>
    );

  const verdict =
    Math.abs(evalDiff) < 200 ? 'Fair Trade' :
    Math.abs(evalDiff) < 500 ? 'Slight Edge' :
    Math.abs(evalDiff) < 1500 ? 'Uneven' : 'Lopsided';
  const verdictColor =
    Math.abs(evalDiff) < 200 ? '#22c55e' :
    Math.abs(evalDiff) < 500 ? '#a3e635' :
    Math.abs(evalDiff) < 1500 ? '#facc15' : '#ef4444';

  const hasPlayers = sideA.length > 0 || sideB.length > 0;

  const renderPlayerRow = (p: DynastyPlayer, side: DynastyPlayer[], setSide: (v: DynastyPlayer[]) => void) => {
    const val = getValue(p);
    const proj = getProjectedValue(p);
    const projDelta = proj - val;
    const hist = getHistory(p.playerID);
    const deltas = computeHistoricalDeltas(hist);
    const ppg = !tradeDateTotals ? getPlayerPPG(p) : null;

    return (
      <div
        key={p.playerID}
        style={{
          padding: '8px 12px', background: 'var(--bg-tertiary)', borderRadius: 6,
          display: 'flex', flexDirection: 'column', gap: 4,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <strong><PlayerName name={p.playerName} position={p.position} /></strong>
            <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-muted)' }}>
              {p.position} · {p.team}{p.age ? ` · ${p.age}` : ''}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: valueColor(val), fontWeight: 600 }}>
              {val.toLocaleString()}
            </span>
            {ppg !== null && (
              <span style={{
                fontSize: 11, color: '#60a5fa', fontWeight: 600,
                padding: '1px 6px', background: 'rgba(96,165,250,0.1)',
                borderRadius: 4,
              }}>
                {ppg.toFixed(1)} ppg
              </span>
            )}
            <button
              onClick={() => setSide(side.filter((s) => s.playerID !== p.playerID))}
              style={{
                background: 'none', border: 'none', color: '#ef4444',
                cursor: 'pointer', fontSize: 16, padding: '0 4px',
              }}
            >
              &times;
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, fontSize: 11, flexWrap: 'wrap' }}>
          {deltas.d30 != null && (
            <span style={{ color: deltaColor(deltas.d30) }}>
              30d: {fmtDelta(deltas.d30)}
            </span>
          )}
          {deltas.d60 != null && (
            <span style={{ color: deltaColor(deltas.d60) }}>
              60d: {fmtDelta(deltas.d60)}
            </span>
          )}
          {deltas.d90 != null && (
            <span style={{ color: deltaColor(deltas.d90) }}>
              90d: {fmtDelta(deltas.d90)}
            </span>
          )}
          {projDelta !== 0 && (
            <span style={{ color: deltaColor(projDelta), fontWeight: 600 }}>
              Proj: {fmtDelta(projDelta)} ({proj.toLocaleString()})
            </span>
          )}
        </div>
        {/* GBM multi-horizon forecasts */}
        {gbmForecasts.has(p.playerID) && (
          <div style={{ display: 'flex', gap: 10, fontSize: 10, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600 }}>GBM:</span>
            {gbmForecasts.get(p.playerID)!
              .filter(f => [30, 60, 90, 120].includes(f.horizon))
              .map(f => {
                const delta = Math.round(f.value) - val;
                return (
                  <span key={f.horizon} style={{ color: deltaColor(delta) }}>
                    +{f.horizon}d: {Math.round(f.value).toLocaleString()}
                  </span>
                );
              })}
          </div>
        )}
      </div>
    );
  };

  const renderSide = (
    label: string,
    side: DynastyPlayer[],
    setSide: (p: DynastyPlayer[]) => void,
    search: string,
    setSearch: (s: string) => void,
    suggestions: DynastyPlayer[],
    total: number,
    projTotal: number,
    color: string,
    todayTotal?: number,
    redraftPPG?: number,
  ) => (
    <div style={{ flex: 1, minWidth: 280 }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 15, color }}>
        {label}
      </h3>
      <div style={{ position: 'relative', marginBottom: 12 }}>
        <input
          type="text"
          placeholder="Search players..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box' }}
        />
        {suggestions.length > 0 && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            borderRadius: 6, maxHeight: 240, overflow: 'auto',
            boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
          }}>
            {suggestions.map((p) => (
              <button
                key={p.playerID}
                onClick={() => { setSide([...side, p]); setSearch(''); }}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  width: '100%', padding: '8px 12px', border: 'none',
                  background: 'transparent', color: 'var(--text-primary)',
                  cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
                }}
                onMouseEnter={(e) => { (e.target as HTMLElement).style.background = 'var(--bg-tertiary)'; }}
                onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'transparent'; }}
              >
                <span>
                  <strong><PlayerName name={p.playerName} position={p.position} /></strong>
                  <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                    {p.position} · {p.team}
                  </span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: valueColor(getValue(p)), fontWeight: 600, fontSize: 12 }}>
                    {getValue(p).toLocaleString()}
                  </span>
                  {!tradeDateTotals && getPlayerPPG(p) !== null && (
                    <span style={{ fontSize: 10, color: '#60a5fa' }}>
                      {getPlayerPPG(p)!.toFixed(1)}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {side.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          Add players to this side
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {side.map((p) => renderPlayerRow(p, side, setSide))}
        </div>
      )}
      <div style={{
        marginTop: 12, padding: '10px 12px', background: 'var(--bg-secondary)',
        borderRadius: 6, borderTop: `2px solid ${color}`,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{todayTotal != null ? 'At Trade' : 'Total'}</span>
          <span style={{ fontWeight: 700, fontSize: 15, color: valueColor(total) }}>
            {total.toLocaleString()}
          </span>
        </div>
        {todayTotal != null && (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Today</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: deltaColor(todayTotal - total) }}>
              {todayTotal.toLocaleString()} ({fmtDelta(todayTotal - total)})
            </span>
          </div>
        )}
        {todayTotal == null && projTotal !== total && (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Projected (3mo)</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: deltaColor(projTotal - total) }}>
              {projTotal.toLocaleString()} ({fmtDelta(projTotal - total)})
            </span>
          </div>
        )}
        {redraftPPG != null && redraftPPG > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
            <span style={{ fontSize: 12, color: '#60a5fa' }}>Redraft PPG</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#60a5fa' }}>
              {redraftPPG.toFixed(1)} ppg
            </span>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      <div className="controls" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div className="control-group">
          <label className="control-label">Format</label>
          <select value={leagueFormat} onChange={(e) => setLeagueFormat(e.target.value as '1qb' | 'superflex')}>
            <option value="1qb">1QB</option>
            <option value="superflex">Superflex</option>
          </select>
        </div>
        <div className="control-group">
          <label className="control-label">TEP</label>
          <select value={tepLevel} onChange={(e) => setTepLevel(Number(e.target.value) as TepLevel)}>
            {([0, 1, 2, 3] as TepLevel[]).map(lv => (
              <option key={lv} value={lv}>{TEP_LABELS[lv]}</option>
            ))}
          </select>
        </div>
        <button
          onClick={() => { setSideA([]); setSideB([]); setSearchA(''); setSearchB(''); }}
          style={{
            padding: '6px 14px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
            borderRadius: 6, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12,
            fontFamily: 'inherit',
          }}
        >
          Clear All
        </button>
        <div className="control-group">
          <label className="control-label">Trade Date</label>
          <input
            type="date"
            value={tradeDate}
            onChange={(e) => setTradeDate(e.target.value)}
            max={new Date().toISOString().slice(0, 10)}
            style={{ fontSize: 12, padding: '4px 8px', fontFamily: 'inherit' }}
          />
        </div>
      </div>

      {/* Warning when trade date has no history */}
      {tradeDate && !tradeDateTotals && hasPlayers && !historyLoading && (
        <div style={{ margin: '0 16px 12px', padding: '8px 16px', fontSize: 12, color: 'var(--text-muted)' }}>
          No history data available for that trade date. Try a more recent date.
        </div>
      )}

      <div style={{ padding: '0 16px', display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        {renderSide('Side A', sideA, setSideA, searchA, setSearchA, suggestionsA,
          evalA, projA, SIDE_A_COLOR, tradeDateTotals ? totalA : undefined,
          !tradeDateTotals ? redraftA : undefined)}

        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          minWidth: 120, padding: '20px 0',
        }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
            {tradeDateTotals
              ? new Date(tradeDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
              : 'NOW'}
          </div>
          <div style={{
            fontSize: 28, fontWeight: 800, color: verdictColor,
            textAlign: 'center', lineHeight: 1.2,
          }}>
            {verdict}
          </div>
          {Math.abs(evalDiff) >= 200 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, textAlign: 'center' }}>
              {evalDiff > 0 ? 'Side A' : 'Side B'} by{' '}
              <strong style={{ color: 'var(--text-primary)' }}>{Math.abs(evalDiff).toLocaleString()}</strong>
            </div>
          )}

          {/* "Since Trade" retrospective when trade date is set */}
          {tradeDateTotals && hasPlayers && (
            <>
              <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '8px 0' }} />
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>SINCE TRADE</div>
              {(() => {
                const aGain = totalA - tradeDateTotals.aTotal;
                const bGain = totalB - tradeDateTotals.bTotal;
                const winner = aGain > bGain ? 'Side A' : aGain < bGain ? 'Side B' : null;
                const winColor = winner === 'Side A' ? SIDE_A_COLOR : SIDE_B_COLOR;
                const margin = Math.abs(aGain - bGain);
                if (!winner || margin < 100) {
                  return <div style={{ fontSize: 13, color: '#22c55e', fontWeight: 700, textAlign: 'center' }}>Dead even</div>;
                }
                return (
                  <>
                    <div style={{ fontSize: 16, fontWeight: 700, color: winColor, textAlign: 'center' }}>
                      {winner} won
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
                      +{margin.toLocaleString()} more value gained
                    </div>
                  </>
                );
              })()}
            </>
          )}

          {/* Win Now PPG comparison (only for current-date evaluation) */}
          {hasRedraft && hasPlayers && (
            <>
              <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '8px 0' }} />
              <div style={{ fontSize: 11, color: '#60a5fa', marginBottom: 4 }}>WIN NOW</div>
              <div style={{
                fontSize: 18, fontWeight: 700, color: '#60a5fa', textAlign: 'center',
              }}>
                {redraftA.toFixed(1)} vs {redraftB.toFixed(1)}
              </div>
              {Math.abs(redraftDiff) >= 1 && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
                  {redraftDiff > 0 ? 'Side A' : 'Side B'} by{' '}
                  <strong style={{ color: '#60a5fa' }}>{Math.abs(redraftDiff).toFixed(1)} ppg</strong>
                </div>
              )}
              {Math.abs(redraftDiff) < 1 && (
                <div style={{ fontSize: 11, color: '#22c55e', textAlign: 'center', fontWeight: 600 }}>
                  Even for this season
                </div>
              )}
            </>
          )}

          {/* Projected section (only when no trade date) */}
          {!tradeDateTotals && hasPlayers && projDiff !== diff && (
            <>
              <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '8px 0' }} />
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>PROJECTED</div>
              <div style={{
                fontSize: 20, fontWeight: 700,
                color: Math.abs(projDiff) < 200 ? '#22c55e' :
                  Math.abs(projDiff) < 500 ? '#a3e635' :
                  Math.abs(projDiff) < 1500 ? '#facc15' : '#ef4444',
                textAlign: 'center',
              }}>
                {Math.abs(projDiff) < 200 ? 'Fair' :
                  Math.abs(projDiff) < 500 ? 'Slight Edge' :
                  Math.abs(projDiff) < 1500 ? 'Uneven' : 'Lopsided'}
              </div>
              {Math.abs(projDiff) >= 200 && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
                  {projDiff > 0 ? 'Side A' : 'Side B'} by{' '}
                  <strong style={{ color: 'var(--text-primary)' }}>{Math.abs(projDiff).toLocaleString()}</strong>
                </div>
              )}
            </>
          )}
        </div>

        {renderSide('Side B', sideB, setSideB, searchB, setSearchB, suggestionsB,
          evalB, projB, SIDE_B_COLOR, tradeDateTotals ? totalB : undefined,
          !tradeDateTotals ? redraftB : undefined)}
      </div>

      {/* Value History Chart */}
      {hasPlayers && chartData.length > 5 && (
        <div style={{ padding: '16px' }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text-secondary)' }}>
            Value History (12 months)
            {historyLoading && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)' }}>Loading...</span>}
          </h4>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="date"
                tickFormatter={fmtMonthYear}
                stroke="var(--text-muted)"
                fontSize={10}
                interval="preserveStartEnd"
              />
              <YAxis stroke="var(--text-muted)" fontSize={10} tickFormatter={(v: number) => v.toLocaleString()} />
              <Tooltip
                contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
                labelFormatter={(label) => fmtDate(String(label))}
                formatter={(value: unknown, name: unknown) => [Number(value).toLocaleString(), String(name ?? '')]}
              />
              {sideA.length > 0 && (
                <Line type="monotone" dataKey="Side A" stroke={SIDE_A_COLOR} strokeWidth={2} dot={false} />
              )}
              {sideB.length > 0 && (
                <Line type="monotone" dataKey="Side B" stroke={SIDE_B_COLOR} strokeWidth={2} dot={false} />
              )}
              <ReferenceLine y={0} stroke="var(--border)" />
              {tradeDate && (
                <ReferenceLine x={tradeDate} stroke="#ef4444" strokeDasharray="4 4" label={{ value: 'Trade', fill: '#ef4444', fontSize: 10, position: 'top' }} />
              )}
            </LineChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 16, justifyContent: 'center', fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            {sideA.length > 0 && (
              <span><span style={{ color: SIDE_A_COLOR, fontWeight: 700 }}>&#9632;</span> Side A total value</span>
            )}
            {sideB.length > 0 && (
              <span><span style={{ color: SIDE_B_COLOR, fontWeight: 700 }}>&#9632;</span> Side B total value</span>
            )}
          </div>
        </div>
      )}

      {/* Balance suggestions (only for current-date evaluation) */}
      {!tradeDateTotals && balanceSuggestions.length > 0 && hasPlayers && (
        <div style={{ padding: '0 16px 16px' }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text-muted)' }}>
            Add to {diff > 0 ? 'Side B' : 'Side A'} to balance:
          </h4>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {balanceSuggestions.map(({ player, side }) => (
              <button
                key={player.playerID}
                onClick={() => {
                  if (side === 'A') setSideA([...sideA, player]);
                  else setSideB([...sideB, player]);
                }}
                style={{
                  padding: '6px 12px', background: 'var(--bg-tertiary)',
                  border: '1px solid var(--border)', borderRadius: 6,
                  color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12,
                  fontFamily: 'inherit',
                }}
              >
                <strong><PlayerName name={player.playerName} position={player.position} /></strong>
                <span style={{ marginLeft: 4, color: valueColor(getValue(player)), fontWeight: 600 }}>
                  ({getValue(player).toLocaleString()})
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ padding: '8px 16px', fontSize: 11, color: 'var(--text-muted)' }}>
        Dynasty market values · {leagueFormat === 'superflex' ? 'Superflex' : '1QB'}{tepLevel > 0 ? ` ${TEP_LABELS[tepLevel]}` : ''} · Projections via GBM time-series
        {hasRedraft && ` · Redraft PPG = ML predicted${tepLevel > 0 ? ' (TEs +0.5/rec)' : ''}`}
      </div>
    </>
  );
}
