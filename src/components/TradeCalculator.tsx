import { useState, useEffect, useMemo } from 'react';
import type { KTCPlayer } from '../types';
import { fetchKTCRankings } from '../data';

type FormatMode = '1qb' | 'superflex';

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

  const getValue = (p: KTCPlayer) => format === 'superflex' ? p.superflexValue : p.value;

  const totalA = sideA.reduce((sum, p) => sum + getValue(p), 0);
  const totalB = sideB.reduce((sum, p) => sum + getValue(p), 0);
  const diff = totalA - totalB;

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

  // Find players that could balance the trade
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

  const renderSide = (
    label: string,
    side: KTCPlayer[],
    setSide: (p: KTCPlayer[]) => void,
    search: string,
    setSearch: (s: string) => void,
    suggestions: KTCPlayer[],
    total: number,
  ) => (
    <div style={{ flex: 1, minWidth: 280 }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 15, color: 'var(--text-secondary)' }}>{label}</h3>
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
          {side.map((p) => (
            <div
              key={p.playerID}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '8px 12px', background: 'var(--bg-tertiary)', borderRadius: 6,
              }}
            >
              <div>
                <strong>{p.playerName}</strong>
                <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                  {p.position} · {p.team}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ color: valueColor(getValue(p)), fontWeight: 600 }}>
                  {getValue(p).toLocaleString()}
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
          ))}
        </div>
      )}
      <div style={{
        marginTop: 12, padding: '10px 12px', background: 'var(--bg-secondary)',
        borderRadius: 6, display: 'flex', justifyContent: 'space-between',
        borderTop: '2px solid var(--border)',
      }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Total</span>
        <span style={{ fontWeight: 700, fontSize: 15, color: valueColor(total) }}>
          {total.toLocaleString()}
        </span>
      </div>
    </div>
  );

  return (
    <>
      <div className="controls" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div className="control-group">
          <label className="control-label">Format</label>
          <select value={format} onChange={(e) => { setFormat(e.target.value as FormatMode); setSideA([]); setSideB([]); }}>
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
      </div>

      <div style={{ padding: '0 16px', display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        {renderSide('Side A', sideA, setSideA, searchA, setSearchA, suggestionsA, totalA)}

        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          minWidth: 100, padding: '20px 0',
        }}>
          <div style={{
            fontSize: 28, fontWeight: 800, color: verdictColor,
            textAlign: 'center', lineHeight: 1.2,
          }}>
            {verdict}
          </div>
          {Math.abs(diff) >= 200 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, textAlign: 'center' }}>
              {diff > 0 ? 'Side A' : 'Side B'} wins by{' '}
              <strong style={{ color: 'var(--text-primary)' }}>{Math.abs(diff).toLocaleString()}</strong>
            </div>
          )}
        </div>

        {renderSide('Side B', sideB, setSideB, searchB, setSearchB, suggestionsB, totalB)}
      </div>

      {balanceSuggestions.length > 0 && (sideA.length > 0 || sideB.length > 0) && (
        <div style={{ padding: '16px', marginTop: 8 }}>
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
        Values from KeepTradeCut · {format === 'superflex' ? 'Superflex' : '1QB'} format
      </div>
    </>
  );
}
