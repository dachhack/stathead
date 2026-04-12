import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { fetchFfcADP, fetchKTCRankings } from '../data';
import { applyScenario, isScenarioEmpty } from '../lib/scenarioEngine';
import { fetchSDIOSeasonProjections, hasSDIOKey } from '../lib/sportsDataIO';
import type { ScenarioConfig, FfcADPPlayer, KTCPlayer, SDIOProjection } from '../types';

// ── Types ──

interface RedraftPlayer {
  name: string;
  position: string;
  ppg: number;
  recPG: number;
}

interface RankingRow {
  id: string;
  rank: number;
  name: string;
  position: string;
  team: string;
  // Projections
  ppg: number;          // projected PPG (from redraft-projections or SDIO)
  totalPts: number;     // PPG * 17
  // ADP
  adp: number;
  adpHigh: number;
  adpLow: number;
  // KTC dynasty
  ktcValue: number;
  // Model signals
  adpEdge: number;      // ppg rank vs adp rank (positive = value)
  // Meta
  isRookie: boolean;
  isLocked: boolean;     // user locked this rank
}

interface SavedRanking {
  id: string;
  name: string;
  savedAt: string;
  order: string[];      // player IDs in ranked order
  lockedIds: string[];  // which IDs are rank-locked
}

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];
const STORAGE_KEY = 'stathead-my-rankings';
const GAMES = 17;

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

function makeId(name: string, pos: string): string {
  return `${normName(name)}:${pos}`;
}

// ── Component ──

export function MyRankings({ scenario }: { scenario: ScenarioConfig }) {
  // Data loading
  const [loading, setLoading] = useState(true);
  const [redraft, setRedraft] = useState<RedraftPlayer[]>([]);
  const [ffc, setFfc] = useState<FfcADPPlayer[]>([]);
  const [ktc, setKtc] = useState<KTCPlayer[]>([]);
  const [sdio, setSdio] = useState<SDIOProjection[]>([]);

  // View state
  const [posFilter, setPosFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [showSaved, setShowSaved] = useState(false);
  const [savedList, setSavedList] = useState<SavedRanking[]>([]);
  const [rankingName, setRankingName] = useState('My Rankings');

  // Ranking state
  const [customOrder, setCustomOrder] = useState<string[] | null>(null);
  const [lockedIds, setLockedIds] = useState<Set<string>>(new Set());

  // Drag state
  const dragIdx = useRef<number | null>(null);
  const dragOverIdx = useRef<number | null>(null);

  // Load data
  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`${import.meta.env.BASE_URL}data/redraft-projections.json`).then(r => r.json()).catch(() => ({ players: [] })),
      fetchFfcADP(2026, 'ppr').catch(() => [] as FfcADPPlayer[]),
      fetchKTCRankings('1qb').catch(() => [] as KTCPlayer[]),
      hasSDIOKey() ? fetchSDIOSeasonProjections(2026).catch(() => []) : Promise.resolve([]),
    ]).then(([rdData, ffcData, ktcData, sdioData]) => {
      setRedraft(rdData.players ?? []);
      setFfc(ffcData);
      setKtc(ktcData);
      setSdio(sdioData);
      setLoading(false);
    });
  }, []);

  // Load saved rankings on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setSavedList(JSON.parse(raw));
    } catch { /* ignore */ }
  }, []);

  // Lookup maps
  const ffcByName = useMemo(() => {
    const m = new Map<string, FfcADPPlayer>();
    for (const p of ffc) m.set(normName(p.name), p);
    return m;
  }, [ffc]);

  const ktcByName = useMemo(() => {
    const m = new Map<string, KTCPlayer>();
    for (const p of ktc) m.set(normName(p.playerName), p);
    return m;
  }, [ktc]);

  // Apply scenario to SDIO projections
  const scenarioSdio = useMemo(() => {
    if (!sdio.length || isScenarioEmpty(scenario)) return sdio;
    return applyScenario(sdio, scenario);
  }, [sdio, scenario]);

  const sdioByName = useMemo(() => {
    const m = new Map<string, SDIOProjection>();
    for (const p of scenarioSdio) m.set(normName(p.Name), p);
    return m;
  }, [scenarioSdio]);

  // Build merged rows
  const allRows = useMemo((): RankingRow[] => {
    // Start from redraft projections as the base player list
    const seen = new Set<string>();
    const rows: RankingRow[] = [];

    for (const p of redraft) {
      const nn = normName(p.name);
      const id = makeId(p.name, p.position);
      if (seen.has(id)) continue;
      seen.add(id);

      const ffcP = ffcByName.get(nn);
      const ktcP = ktcByName.get(nn);
      const sdioP = sdioByName.get(nn);

      // PPG: prefer SDIO (scenario-adjusted) if available, else redraft
      let ppg = p.ppg;
      if (sdioP && (sdioP.FantasyPointsPPR ?? 0) > 0) {
        const games = sdioP.FantasyPointsPPR > 100 ? GAMES : 1; // SDIO is season total
        ppg = Math.round((sdioP.FantasyPointsPPR / games) * 10) / 10;
      }

      rows.push({
        id,
        rank: 0,
        name: p.name,
        position: p.position,
        team: ffcP?.team ?? sdioP?.Team ?? '',
        ppg,
        totalPts: Math.round(ppg * GAMES),
        adp: ffcP?.adp ?? 999,
        adpHigh: ffcP?.high ?? 0,
        adpLow: ffcP?.low ?? 0,
        ktcValue: ktcP?.value ?? 0,
        adpEdge: 0,
        isRookie: ktcP?.isRookie ?? false,
        isLocked: false,
      });
    }

    // Add any FFC ADP players not in redraft
    for (const p of ffc) {
      const id = makeId(p.name, p.position);
      if (seen.has(id) || !['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
      seen.add(id);
      const ktcP = ktcByName.get(normName(p.name));
      const sdioP = sdioByName.get(normName(p.name));
      let ppg = 0;
      if (sdioP && (sdioP.FantasyPointsPPR ?? 0) > 0) {
        ppg = Math.round((sdioP.FantasyPointsPPR / GAMES) * 10) / 10;
      }
      rows.push({
        id,
        rank: 0,
        name: p.name,
        position: p.position,
        team: p.team,
        ppg,
        totalPts: Math.round(ppg * GAMES),
        adp: p.adp,
        adpHigh: p.high,
        adpLow: p.low,
        ktcValue: ktcP?.value ?? 0,
        adpEdge: 0,
        isRookie: ktcP?.isRookie ?? false,
        isLocked: false,
      });
    }

    // Sort by PPG descending as default order
    rows.sort((a, b) => b.ppg - a.ppg);

    // Compute edge: ppg-rank vs adp-rank
    const ppgRanks = [...rows].map((r, i) => ({ id: r.id, ppgRank: i + 1 }));
    const adpSorted = [...rows].sort((a, b) => a.adp - b.adp);
    const adpRankMap = new Map<string, number>();
    adpSorted.forEach((r, i) => adpRankMap.set(r.id, i + 1));
    for (const pr of ppgRanks) {
      const row = rows.find(r => r.id === pr.id);
      if (row) {
        row.adpEdge = (adpRankMap.get(row.id) ?? rows.length) - pr.ppgRank;
      }
    }

    return rows;
  }, [redraft, ffc, ffcByName, ktcByName, sdioByName]);

  // Apply custom order
  const rankedRows = useMemo(() => {
    let ordered: RankingRow[];
    if (customOrder) {
      const orderMap = new Map(customOrder.map((id, i) => [id, i]));
      ordered = [...allRows].sort((a, b) => {
        const ai = orderMap.get(a.id) ?? 99999;
        const bi = orderMap.get(b.id) ?? 99999;
        return ai - bi;
      });
    } else {
      ordered = [...allRows];
    }
    return ordered.map((r, i) => ({ ...r, rank: i + 1, isLocked: lockedIds.has(r.id) }));
  }, [allRows, customOrder, lockedIds]);

  // Filtered rows for display
  const displayRows = useMemo(() => {
    let rows = rankedRows;
    if (posFilter !== 'ALL') rows = rows.filter(r => r.position === posFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(r => r.name.toLowerCase().includes(q) || r.team.toLowerCase().includes(q));
    }
    return rows;
  }, [rankedRows, posFilter, search]);

  // Drag handlers
  const onDragStart = useCallback((idx: number) => {
    dragIdx.current = idx;
  }, []);

  const onDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault();
    dragOverIdx.current = idx;
  }, []);

  const onDrop = useCallback(() => {
    if (dragIdx.current === null || dragOverIdx.current === null) return;
    if (dragIdx.current === dragOverIdx.current) return;

    const fromRow = displayRows[dragIdx.current];
    const toRow = displayRows[dragOverIdx.current];
    if (!fromRow || !toRow) return;

    // Work with full ranked order
    const currentOrder = customOrder ?? rankedRows.map(r => r.id);
    const fromGlobal = currentOrder.indexOf(fromRow.id);
    const toGlobal = currentOrder.indexOf(toRow.id);
    if (fromGlobal === -1 || toGlobal === -1) return;

    const newOrder = [...currentOrder];
    newOrder.splice(fromGlobal, 1);
    newOrder.splice(toGlobal, 0, fromRow.id);

    setCustomOrder(newOrder);
    dragIdx.current = null;
    dragOverIdx.current = null;
  }, [displayRows, customOrder, rankedRows]);

  // Lock/unlock
  const toggleLock = useCallback((id: string) => {
    setLockedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Reset to default
  const resetOrder = useCallback(() => {
    setCustomOrder(null);
    setLockedIds(new Set());
  }, []);

  // Save/Load/Delete
  const saveCurrent = useCallback(() => {
    const entry: SavedRanking = {
      id: `rank-${Date.now()}`,
      name: rankingName,
      savedAt: new Date().toISOString(),
      order: customOrder ?? rankedRows.map(r => r.id),
      lockedIds: [...lockedIds],
    };
    const updated = [...savedList.filter(s => s.name !== rankingName), entry];
    setSavedList(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  }, [rankingName, customOrder, rankedRows, lockedIds, savedList]);

  const loadSaved = useCallback((s: SavedRanking) => {
    setCustomOrder(s.order);
    setLockedIds(new Set(s.lockedIds));
    setRankingName(s.name);
    setShowSaved(false);
  }, []);

  const deleteSaved = useCallback((id: string) => {
    const updated = savedList.filter(s => s.id !== id);
    setSavedList(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  }, [savedList]);

  // Scenario indicator
  const hasScenario = !isScenarioEmpty(scenario);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading rankings data...</div>
      </div>
    );
  }

  const edgeColor = (v: number) => v > 10 ? '#22c55e' : v > 3 ? '#86efac' : v < -10 ? '#ef4444' : v < -3 ? '#fca5a5' : 'var(--text-secondary)';

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '16px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>My Rankings</h1>
        {hasScenario && (
          <span style={{
            fontSize: 11, background: '#6366f122', color: '#6366f1',
            border: '1px solid #6366f144', borderRadius: 6, padding: '2px 8px', fontWeight: 600,
          }}>
            Scenario Active
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={rankingName}
            onChange={e => setRankingName(e.target.value)}
            placeholder="Ranking name..."
            style={{
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 6, padding: '4px 8px', fontSize: 12, color: 'var(--text-primary)',
              width: 140, fontFamily: 'inherit',
            }}
          />
          <button className="scenario-action-btn" onClick={saveCurrent} style={{ fontSize: 11 }}>Save</button>
          <button
            className={`scenario-action-btn ${showSaved ? 'active' : ''}`}
            onClick={() => { setShowSaved(v => !v); setSavedList(prev => { try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : prev; } catch { return prev; } }); }}
            style={{ fontSize: 11 }}
          >
            Load
          </button>
          <button className="scenario-action-btn" onClick={resetOrder} style={{ fontSize: 11 }}>Reset</button>
        </div>
      </div>

      {/* Saved rankings list */}
      {showSaved && (
        <div style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          borderRadius: 8, padding: 12, marginBottom: 12,
        }}>
          {savedList.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 8 }}>
              No saved rankings yet
            </div>
          ) : savedList.map(s => (
            <div key={s.id} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '6px 0', borderBottom: '1px solid var(--border)',
            }}>
              <div>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>
                  {new Date(s.savedAt).toLocaleDateString()}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="scenario-link-btn" onClick={() => loadSaved(s)}>Load</button>
                <button className="scenario-link-btn danger" onClick={() => deleteSaved(s.id)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {POSITIONS.map(p => (
          <button
            key={p}
            className={`pos-filter ${posFilter === p ? 'active' : ''}`}
            onClick={() => setPosFilter(p)}
          >
            {p}
          </button>
        ))}
        <input
          type="text"
          placeholder="Search..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '4px 8px', fontSize: 12, color: 'var(--text-primary)',
            width: 160, fontFamily: 'inherit', marginLeft: 'auto',
          }}
        />
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {displayRows.length} players
        </span>
      </div>

      {/* Hint */}
      {!customOrder && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
          Drag rows to reorder. Default sort: projected PPG.
          {hasScenario ? ' Scenario adjustments applied to projections.' : ''}
        </div>
      )}
      {customOrder && (
        <div style={{ fontSize: 11, color: '#6366f1', marginBottom: 8 }}>
          Custom ranking active. Drag to adjust, or Reset to return to default.
        </div>
      )}

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border)' }}>
              <th style={{ textAlign: 'center', padding: '8px 4px', width: 30 }}>#</th>
              <th style={{ textAlign: 'left', padding: '8px 6px' }}>Player</th>
              <th style={{ textAlign: 'center', padding: '8px 4px', width: 40 }}>Pos</th>
              <th style={{ textAlign: 'center', padding: '8px 4px', width: 40 }}>Team</th>
              <th style={{ textAlign: 'right', padding: '8px 6px', width: 55 }}>PPG</th>
              <th style={{ textAlign: 'right', padding: '8px 6px', width: 60 }}>Total</th>
              <th style={{ textAlign: 'right', padding: '8px 6px', width: 55 }}>ADP</th>
              <th style={{ textAlign: 'right', padding: '8px 6px', width: 65 }}>ADP Range</th>
              <th style={{ textAlign: 'right', padding: '8px 6px', width: 55 }}>KTC</th>
              <th style={{ textAlign: 'right', padding: '8px 6px', width: 50 }}>Edge</th>
              <th style={{ textAlign: 'center', padding: '8px 4px', width: 30 }}></th>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((r, i) => (
              <tr
                key={r.id}
                draggable
                onDragStart={() => onDragStart(i)}
                onDragOver={(e) => onDragOver(e, i)}
                onDrop={onDrop}
                style={{
                  borderBottom: '1px solid var(--border)',
                  cursor: 'grab',
                  background: r.isLocked ? 'var(--bg-tertiary)' : undefined,
                  opacity: 1,
                }}
                onDragEnter={(e) => { (e.currentTarget as HTMLElement).style.borderTop = '2px solid #6366f1'; }}
                onDragLeave={(e) => { (e.currentTarget as HTMLElement).style.borderTop = ''; }}
                onDragEnd={(e) => { (e.currentTarget as HTMLElement).style.borderTop = ''; }}
              >
                <td style={{ textAlign: 'center', padding: '6px 4px', fontWeight: 700, color: 'var(--text-muted)' }}>
                  {r.rank}
                </td>
                <td style={{ padding: '6px 6px', fontWeight: 600 }}>
                  {r.name}
                  {r.isRookie && <span style={{ fontSize: 9, color: '#6366f1', marginLeft: 4 }}>R</span>}
                </td>
                <td style={{ textAlign: 'center', padding: '6px 4px' }}>
                  <span className={`pos-badge pos-${r.position}`} style={{ fontSize: 10 }}>{r.position}</span>
                </td>
                <td style={{ textAlign: 'center', padding: '6px 4px', color: 'var(--text-muted)' }}>{r.team}</td>
                <td style={{ textAlign: 'right', padding: '6px 6px', fontWeight: 700 }}>{r.ppg.toFixed(1)}</td>
                <td style={{ textAlign: 'right', padding: '6px 6px', color: 'var(--text-secondary)' }}>{r.totalPts}</td>
                <td style={{ textAlign: 'right', padding: '6px 6px' }}>
                  {r.adp < 999 ? r.adp.toFixed(1) : '—'}
                </td>
                <td style={{ textAlign: 'right', padding: '6px 6px', fontSize: 11, color: 'var(--text-muted)' }}>
                  {r.adp < 999 ? `${r.adpHigh}–${r.adpLow}` : ''}
                </td>
                <td style={{ textAlign: 'right', padding: '6px 6px', color: r.ktcValue > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                  {r.ktcValue > 0 ? r.ktcValue.toLocaleString() : '—'}
                </td>
                <td style={{ textAlign: 'right', padding: '6px 6px', fontWeight: 600, color: edgeColor(r.adpEdge) }}>
                  {r.adpEdge > 0 ? `+${r.adpEdge}` : r.adpEdge}
                </td>
                <td style={{ textAlign: 'center', padding: '6px 4px' }}>
                  <button
                    onClick={() => toggleLock(r.id)}
                    title={r.isLocked ? 'Unlock rank' : 'Lock rank'}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: r.isLocked ? '#6366f1' : 'var(--text-muted)',
                      fontSize: 12, padding: 0,
                    }}
                  >
                    {r.isLocked ? '🔒' : '📌'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {displayRows.length === 0 && !loading && (
        <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
          No players match your filters.
        </div>
      )}
    </div>
  );
}
