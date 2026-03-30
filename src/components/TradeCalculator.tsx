import { useState, useEffect, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import type { KTCPlayer, KTCPlayerHistory } from '../types';
import { fetchKTCRankings, fetchKTCHistory } from '../data';

type FormatMode = '1qb' | 'superflex';

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
  const [players, setPlayers] = useState<KTCPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [format, setFormat] = useState<FormatMode>('1qb');
  const [sideA, setSideA] = useState<KTCPlayer[]>([]);
  const [sideB, setSideB] = useState<KTCPlayer[]>([]);
  const [searchA, setSearchA] = useState('');
  const [searchB, setSearchB] = useState('');
  const [historyData, setHistoryData] = useState<KTCPlayerHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [tradeDate, setTradeDate] = useState<string>('');

  useEffect(() => {
    setLoading(true);
    fetchKTCRankings(format)
      .then((data) => {
        setPlayers(data);
        onDataLoaded?.(data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [format, onDataLoaded]);

  // Fetch history for all players in the trade
  const allTradePlayerIds = useMemo(
    () => [...sideA, ...sideB].map((p) => p.playerID),
    [sideA, sideB],
  );

  useEffect(() => {
    if (allTradePlayerIds.length === 0) {
      setHistoryData([]);
      return;
    }
    setHistoryLoading(true);
    fetchKTCHistory(allTradePlayerIds)
      .then(setHistoryData)
      .catch(() => setHistoryData([]))
      .finally(() => setHistoryLoading(false));
  }, [allTradePlayerIds]);

  const getValue = (p: KTCPlayer) => format === 'superflex' ? p.superflexValue : p.value;

  const getHistory = (playerID: number) => {
    const h = historyData.find((d) => d.playerID === playerID);
    if (!h) return [];
    return format === 'superflex' ? h.superflex.valueHistory : h.oneQB.valueHistory;
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

  const totalA = sideA.reduce((sum, p) => sum + getValue(p), 0);
  const totalB = sideB.reduce((sum, p) => sum + getValue(p), 0);
  const diff = totalA - totalB;

  // Trade-date values (if a date is set)
  const tradeDateTotals = useMemo(() => {
    if (!tradeDate || historyData.length === 0) return null;
    let aTotal = 0;
    let bTotal = 0;
    let valid = true;
    for (const p of sideA) {
      const v = getValueAtDate(p.playerID, tradeDate);
      if (v == null) { valid = false; break; }
      aTotal += v;
    }
    if (valid) {
      for (const p of sideB) {
        const v = getValueAtDate(p.playerID, tradeDate);
        if (v == null) { valid = false; break; }
        bTotal += v;
      }
    }
    if (!valid || (sideA.length === 0 && sideB.length === 0)) return null;
    return { aTotal, bTotal, diff: aTotal - bTotal };
  }, [tradeDate, sideA, sideB, historyData, format]);

  // Projected totals (using trend)
  const projA = sideA.reduce((sum, p) => sum + projectValue(getValue(p), p.trend30Day), 0);
  const projB = sideB.reduce((sum, p) => sum + projectValue(getValue(p), p.trend30Day), 0);
  const projDiff = projA - projB;

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

    // Build running last-known values
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
          aTotal += val;
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
          bTotal += val;
        }
      }
      return { date, 'Side A': aTotal, 'Side B': bTotal } as Record<string, unknown>;
    });

    // Add projected dashed segment: bridge from last actual to 90-day projection
    if (rows.length > 0 && (sideA.length > 0 || sideB.length > 0)) {
      const last = rows[rows.length - 1];
      // Tag the last actual point with projected values too (so the line connects)
      const projATotal = sideA.reduce((sum, p) => sum + projectValue(getValue(p), p.trend30Day), 0);
      const projBTotal = sideB.reduce((sum, p) => sum + projectValue(getValue(p), p.trend30Day), 0);
      last['Side A Proj'] = last['Side A'];
      last['Side B Proj'] = last['Side B'];

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
  }, [sideA, sideB, historyData, format]);

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
  }, [diff, players, sideA, sideB, format]);

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
    Math.abs(diff) < 200 ? 'Fair Trade' :
    Math.abs(diff) < 500 ? 'Slight Edge' :
    Math.abs(diff) < 1500 ? 'Uneven' : 'Lopsided';
  const verdictColor =
    Math.abs(diff) < 200 ? '#22c55e' :
    Math.abs(diff) < 500 ? '#a3e635' :
    Math.abs(diff) < 1500 ? '#facc15' : '#ef4444';

  const hasPlayers = sideA.length > 0 || sideB.length > 0;

  const renderPlayerRow = (p: KTCPlayer, side: KTCPlayer[], setSide: (v: KTCPlayer[]) => void) => {
    const val = getValue(p);
    const proj = projectValue(val, p.trend30Day);
    const projDelta = proj - val;
    const hist = getHistory(p.playerID);
    const deltas = computeHistoricalDeltas(hist);

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
            <strong>{p.playerName}</strong>
            <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-muted)' }}>
              {p.position} · {p.team}{p.age ? ` · ${p.age}` : ''}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: valueColor(val), fontWeight: 600 }}>
              {val.toLocaleString()}
            </span>
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
      </div>
    );
  };

  const renderSide = (
    label: string,
    side: KTCPlayer[],
    setSide: (p: KTCPlayer[]) => void,
    search: string,
    setSearch: (s: string) => void,
    suggestions: KTCPlayer[],
    total: number,
    projTotal: number,
    color: string,
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
                  <strong>{p.playerName}</strong>
                  <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                    {p.position} · {p.team}
                  </span>
                </span>
                <span style={{ color: valueColor(getValue(p)), fontWeight: 600, fontSize: 12 }}>
                  {getValue(p).toLocaleString()}
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
          <span style={{ fontWeight: 600, fontSize: 13 }}>Current Total</span>
          <span style={{ fontWeight: 700, fontSize: 15, color: valueColor(total) }}>
            {total.toLocaleString()}
          </span>
        </div>
        {projTotal !== total && (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Projected (3mo)</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: deltaColor(projTotal - total) }}>
              {projTotal.toLocaleString()} ({fmtDelta(projTotal - total)})
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
          <select value={format} onChange={(e) => setFormat(e.target.value as FormatMode)}>
            <option value="1qb">1QB</option>
            <option value="superflex">Superflex</option>
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

      {/* Trade date analysis */}
      {tradeDate && tradeDateTotals && hasPlayers && (
        <div style={{
          margin: '0 16px 12px', padding: '12px 16px', background: 'var(--bg-tertiary)',
          borderRadius: 8, border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: 'var(--text-secondary)' }}>
            Trade Analysis: {new Date(tradeDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} vs Today
          </div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12 }}>
            <div>
              <span style={{ color: SIDE_A_COLOR, fontWeight: 600 }}>Side A</span>{' '}
              <span style={{ color: 'var(--text-muted)' }}>then:</span>{' '}
              <strong>{tradeDateTotals.aTotal.toLocaleString()}</strong>
              <span style={{ color: 'var(--text-muted)' }}> → now:</span>{' '}
              <strong>{totalA.toLocaleString()}</strong>{' '}
              <span style={{ color: deltaColor(totalA - tradeDateTotals.aTotal), fontWeight: 600 }}>
                ({fmtDelta(totalA - tradeDateTotals.aTotal)})
              </span>
            </div>
            <div>
              <span style={{ color: SIDE_B_COLOR, fontWeight: 600 }}>Side B</span>{' '}
              <span style={{ color: 'var(--text-muted)' }}>then:</span>{' '}
              <strong>{tradeDateTotals.bTotal.toLocaleString()}</strong>
              <span style={{ color: 'var(--text-muted)' }}> → now:</span>{' '}
              <strong>{totalB.toLocaleString()}</strong>{' '}
              <span style={{ color: deltaColor(totalB - tradeDateTotals.bTotal), fontWeight: 600 }}>
                ({fmtDelta(totalB - tradeDateTotals.bTotal)})
              </span>
            </div>
          </div>
          <div style={{ marginTop: 8, fontSize: 13 }}>
            {(() => {
              const thenDiff = tradeDateTotals.diff;
              const aGain = totalA - tradeDateTotals.aTotal;
              const bGain = totalB - tradeDateTotals.bTotal;
              const winner = aGain > bGain ? 'Side A' : aGain < bGain ? 'Side B' : null;
              const winColor = winner === 'Side A' ? SIDE_A_COLOR : SIDE_B_COLOR;
              const margin = Math.abs(aGain - bGain);
              if (!winner || margin < 100) {
                return <span style={{ color: '#22c55e', fontWeight: 700 }}>Dead even — no clear winner</span>;
              }
              return (
                <span>
                  <span style={{ color: winColor, fontWeight: 700 }}>{winner} won the trade</span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {' '}— gained <strong style={{ color: 'var(--text-primary)' }}>{margin.toLocaleString()}</strong> more value since the trade
                    {Math.abs(thenDiff) >= 200 && (
                      <> (was {thenDiff > 0 ? 'Side A' : 'Side B'} by {Math.abs(thenDiff).toLocaleString()} at trade time)</>
                    )}
                  </span>
                </span>
              );
            })()}
          </div>
        </div>
      )}
      {tradeDate && !tradeDateTotals && hasPlayers && !historyLoading && (
        <div style={{ margin: '0 16px 12px', padding: '8px 16px', fontSize: 12, color: 'var(--text-muted)' }}>
          No history data available for that trade date. Try a more recent date.
        </div>
      )}

      <div style={{ padding: '0 16px', display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        {renderSide('Side A', sideA, setSideA, searchA, setSearchA, suggestionsA, totalA, projA, SIDE_A_COLOR)}

        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          minWidth: 120, padding: '20px 0',
        }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>NOW</div>
          <div style={{
            fontSize: 28, fontWeight: 800, color: verdictColor,
            textAlign: 'center', lineHeight: 1.2,
          }}>
            {verdict}
          </div>
          {Math.abs(diff) >= 200 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, textAlign: 'center' }}>
              {diff > 0 ? 'Side A' : 'Side B'} by{' '}
              <strong style={{ color: 'var(--text-primary)' }}>{Math.abs(diff).toLocaleString()}</strong>
            </div>
          )}

          {hasPlayers && projDiff !== diff && (
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

        {renderSide('Side B', sideB, setSideB, searchB, setSearchB, suggestionsB, totalB, projB, SIDE_B_COLOR)}
      </div>

      {/* Value History Chart */}
      {hasPlayers && chartData.length > 5 && (
        <div style={{ padding: '16px' }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text-secondary)' }}>
            Value History + 90-Day Projection
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
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                formatter={((value: any, name: any) => {
                  const n = String(name);
                  const label = n.replace(' Proj', '') + (n.includes('Proj') ? ' (Proj)' : '');
                  return [Number(value).toLocaleString(), label];
                }) as any}
              />
              {sideA.length > 0 && (
                <Line type="monotone" dataKey="Side A" stroke={SIDE_A_COLOR} strokeWidth={2} dot={false} connectNulls={false} />
              )}
              {sideB.length > 0 && (
                <Line type="monotone" dataKey="Side B" stroke={SIDE_B_COLOR} strokeWidth={2} dot={false} connectNulls={false} />
              )}
              {sideA.length > 0 && (
                <Line type="monotone" dataKey="Side A Proj" stroke={SIDE_A_COLOR} strokeWidth={2} strokeDasharray="6 4" dot={false} connectNulls={false} />
              )}
              {sideB.length > 0 && (
                <Line type="monotone" dataKey="Side B Proj" stroke={SIDE_B_COLOR} strokeWidth={2} strokeDasharray="6 4" dot={false} connectNulls={false} />
              )}
              <ReferenceLine y={0} stroke="var(--border)" />
              {tradeDate && (
                <ReferenceLine x={tradeDate} stroke="#ef4444" strokeDasharray="4 4" label={{ value: 'Trade', fill: '#ef4444', fontSize: 10, position: 'top' }} />
              )}
            </LineChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 16, justifyContent: 'center', fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            {sideA.length > 0 && (
              <span><span style={{ color: SIDE_A_COLOR, fontWeight: 700 }}>&#9632;</span> Side A</span>
            )}
            {sideB.length > 0 && (
              <span><span style={{ color: SIDE_B_COLOR, fontWeight: 700 }}>&#9632;</span> Side B</span>
            )}
            <span><span style={{ opacity: 0.6 }}>- - -</span> 90-day projection</span>
          </div>
        </div>
      )}

      {/* Balance suggestions */}
      {balanceSuggestions.length > 0 && hasPlayers && (
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
                <strong>{player.playerName}</strong>
                <span style={{ marginLeft: 4, color: valueColor(getValue(player)), fontWeight: 600 }}>
                  ({getValue(player).toLocaleString()})
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ padding: '8px 16px', fontSize: 11, color: 'var(--text-muted)' }}>
        Values from KeepTradeCut · {format === 'superflex' ? 'Superflex' : '1QB'} format · Projections based on 30-day trend
      </div>
    </>
  );
}
