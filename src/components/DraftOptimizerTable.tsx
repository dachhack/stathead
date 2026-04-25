import { useState, useEffect, useMemo } from 'react';
import { normName, positionStats, zScore } from '../lib/nameUtils';

// Simple draft-board table backed by the ADP-model score-store. Replaces
// the previous in-browser model-training UI, which is parked until a
// proper redesign. Per-position boom/bust z-scores come from the CI
// bounds in score-store/adp.json so the column reads consistently with
// MyRankings and the Projections page.

interface AdpScoreEntry {
  name: string;
  position: string;
  team: string;
  adp: number;
  predictedVor: number;
  hitProb: string;
  ciLower: number;
  ciUpper: number;
  isRookie: boolean;
}

interface PpgScoreEntry {
  name: string;
  position: string;
  predictedPPG: number;
}

interface Row {
  name: string;
  position: string;
  team: string;
  adp: number;
  predictedPPG: number;
  predictedVor: number;
  hitProb: string;
  boomZ: number;
  bustZ: number;
  isRookie: boolean;
}

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'] as const;
type PosFilter = typeof POSITIONS[number];

type SortKey = 'adp' | 'predictedVor' | 'predictedPPG' | 'boomZ' | 'bustZ' | 'name';

const BASE = import.meta.env.BASE_URL;

function fmtZ(z: number): string {
  if (!Number.isFinite(z) || z === 0) return '—';
  const sign = z > 0 ? '+' : '';
  return `${sign}${z.toFixed(2)}`;
}

function boomColor(z: number): string {
  if (z >= 1.0) return '#22c55e';
  if (z >= 0.5) return '#86efac';
  if (z >= 0.2) return '#a3e635';
  return 'var(--text-muted)';
}

function bustColor(z: number): string {
  if (z >= 1.0) return '#ef4444';
  if (z >= 0.5) return '#fca5a5';
  if (z >= 0.2) return '#fb923c';
  return 'var(--text-muted)';
}

function hitProbColor(p: string): string {
  if (p === 'Likely Hit') return '#22c55e';
  if (p === 'Likely Bust') return '#ef4444';
  return 'var(--text-muted)';
}

export function DraftOptimizerTable() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [posFilter, setPosFilter] = useState<PosFilter>('ALL');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('adp');
  const [sortAsc, setSortAsc] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetch(`${BASE}data/score-store/adp.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch(`${BASE}data/score-store/ppg.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    ]).then(([adpData, ppgData]: [AdpScoreEntry[], PpgScoreEntry[]]) => {
      if (cancelled) return;
      if (!adpData?.length) {
        setError('Draft data not available yet — the build deploys every 2 hours.');
        setLoading(false);
        return;
      }
      const ppgByName = new Map<string, number>();
      for (const p of ppgData ?? []) {
        if (p?.name) ppgByName.set(normName(p.name), Number(p.predictedPPG) || 0);
      }
      // Per-position z-scores over CI spreads. Only positive spreads
      // contribute to the cohort so deep depth-pieces with degenerate CIs
      // don't drag the mean down.
      const spreads = adpData.map((a) => ({
        position: a.position,
        up: Math.max(0, (a.ciUpper ?? 0) - (a.predictedVor ?? 0)),
        down: Math.max(0, (a.predictedVor ?? 0) - (a.ciLower ?? 0)),
      }));
      const upStats = positionStats(spreads.filter((s) => s.up > 0), (s) => s.position, (s) => s.up);
      const downStats = positionStats(spreads.filter((s) => s.down > 0), (s) => s.position, (s) => s.down);

      const built: Row[] = adpData.map((a) => {
        const up = Math.max(0, (a.ciUpper ?? 0) - (a.predictedVor ?? 0));
        const down = Math.max(0, (a.predictedVor ?? 0) - (a.ciLower ?? 0));
        return {
          name: a.name,
          position: a.position,
          team: a.team,
          adp: Number(a.adp) || 999,
          predictedPPG: ppgByName.get(normName(a.name)) ?? 0,
          predictedVor: Number(a.predictedVor) || 0,
          hitProb: a.hitProb ?? '',
          boomZ: up > 0 ? Math.round(zScore(up, upStats.get(a.position)) * 100) / 100 : 0,
          bustZ: down > 0 ? Math.round(zScore(down, downStats.get(a.position)) * 100) / 100 : 0,
          isRookie: !!a.isRookie,
        };
      });
      setRows(built);
      setLoading(false);
    }).catch((e) => {
      if (!cancelled) {
        setError(e instanceof Error ? e.message : 'Failed to load draft data');
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const displayRows = useMemo(() => {
    let out = rows;
    if (posFilter !== 'ALL') out = out.filter((r) => r.position === posFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter((r) => r.name.toLowerCase().includes(q) || r.team.toLowerCase().includes(q));
    }
    out = [...out].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortAsc ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
    return out;
  }, [rows, posFilter, search, sortKey, sortAsc]);

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortAsc((v) => !v);
    } else {
      setSortKey(key);
      setSortAsc(key === 'adp' || key === 'name');
    }
  };

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortAsc ? ' ▲' : ' ▼') : '');

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading draft board...</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="empty-state">
        <h3>Draft Optimizer</h3>
        <p>{error}</p>
      </div>
    );
  }

  const th: React.CSSProperties = {
    padding: '6px 8px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
    cursor: 'pointer', userSelect: 'none',
  };
  const td: React.CSSProperties = { padding: '5px 8px', fontSize: 12 };

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Draft Optimizer</h1>
        <span style={{
          fontSize: 11, background: 'var(--bg-tertiary)', color: 'var(--text-muted)',
          border: '1px solid var(--border)', borderRadius: 6, padding: '2px 8px', fontWeight: 600,
        }}>
          Table view
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          {displayRows.length} players
        </span>
      </div>

      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.55 }}>
        Best-available board sorted by ADP. Predicted VOR, hit probability, and
        the within-position boom/bust z-scores are pulled from the ADP model
        (<code>score-store/adp.json</code>); predicted PPG comes from the
        ADP-free PPG model. The previous in-browser optimizer is parked
        pending a redesign.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {POSITIONS.map((p) => (
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
          placeholder="Search player or team..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '4px 8px', fontSize: 12, color: 'var(--text-primary)',
            width: 200, fontFamily: 'inherit', marginLeft: 'auto',
          }}
        />
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border)' }}>
              <th style={{ ...th, textAlign: 'center', width: 36, cursor: 'default' }}>#</th>
              <th style={{ ...th, textAlign: 'left' }} onClick={() => handleSort('name')}>
                Player{sortArrow('name')}
              </th>
              <th style={{ ...th, textAlign: 'center', width: 40 }}>Pos</th>
              <th style={{ ...th, textAlign: 'center', width: 40 }}>Tm</th>
              <th style={{ ...th, textAlign: 'right', width: 56 }} onClick={() => handleSort('adp')}>
                ADP{sortArrow('adp')}
              </th>
              <th style={{ ...th, textAlign: 'right', width: 64 }} onClick={() => handleSort('predictedPPG')}>
                <span title="Model-predicted PPG">Pred PPG</span>{sortArrow('predictedPPG')}
              </th>
              <th style={{ ...th, textAlign: 'right', width: 60 }} onClick={() => handleSort('predictedVor')}>
                <span title="Predicted PPG over replacement">Pred VOR</span>{sortArrow('predictedVor')}
              </th>
              <th style={{ ...th, textAlign: 'center', width: 84 }}>Hit</th>
              <th style={{ ...th, textAlign: 'right', width: 56 }} onClick={() => handleSort('boomZ')}>
                <span title="Boom z-score within position — CI upside spread vs cohort">Boom z</span>{sortArrow('boomZ')}
              </th>
              <th style={{ ...th, textAlign: 'right', width: 56 }} onClick={() => handleSort('bustZ')}>
                <span title="Bust z-score within position — CI downside spread vs cohort">Bust z</span>{sortArrow('bustZ')}
              </th>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((r, i) => (
              <tr key={`${r.name}:${r.position}`} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ ...td, textAlign: 'center', color: 'var(--text-muted)', fontWeight: 700 }}>
                  {i + 1}
                </td>
                <td style={{ ...td, fontWeight: 600 }}>
                  {r.name}
                  {r.isRookie && <span style={{ fontSize: 9, color: '#6366f1', marginLeft: 4 }}>R</span>}
                </td>
                <td style={{ ...td, textAlign: 'center' }}>
                  <span className={`pos-badge pos-${r.position}`} style={{ fontSize: 10 }}>{r.position}</span>
                </td>
                <td style={{ ...td, textAlign: 'center', color: 'var(--text-muted)' }}>{r.team || '—'}</td>
                <td style={{ ...td, textAlign: 'right' }}>{r.adp < 999 ? r.adp.toFixed(1) : '—'}</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>
                  {r.predictedPPG > 0 ? r.predictedPPG.toFixed(1) : '—'}
                </td>
                <td style={{ ...td, textAlign: 'right' }}>
                  {r.predictedVor !== 0 ? r.predictedVor.toFixed(1) : '—'}
                </td>
                <td style={{ ...td, textAlign: 'center', fontSize: 11, color: hitProbColor(r.hitProb) }}>
                  {r.hitProb || '—'}
                </td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: boomColor(r.boomZ) }}>
                  {fmtZ(r.boomZ)}
                </td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: bustColor(r.bustZ) }}>
                  {fmtZ(r.bustZ)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {displayRows.length === 0 && (
        <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
          No players match your filters.
        </div>
      )}
    </div>
  );
}
