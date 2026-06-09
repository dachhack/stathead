import { useState, useEffect, useMemo } from 'react';
import { fetchFfcADP } from '../data';
import { applyScenario, isScenarioEmpty } from '../lib/scenarioEngine';
import { fetchSDIOSeasonProjections, hasSDIOKey } from '../lib/sportsDataIO';
import { normName, boomPct, bustPct } from '../lib/nameUtils';
import type { FfcADPPlayer, ScenarioConfig, SDIOProjection } from '../types';
import { PlayerName } from './PlayerName';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K'];
const GAMES = 17;
const BASE = import.meta.env.BASE_URL;

function boomColor(v: number): string {
  if (v >= 40) return '#22c55e';
  if (v >= 25) return '#86efac';
  if (v >= 15) return '#a3e635';
  return 'var(--text-muted)';
}

function bustColor(v: number): string {
  if (v >= 40) return '#ef4444';
  if (v >= 25) return '#fca5a5';
  if (v >= 15) return '#fb923c';
  return 'var(--text-muted)';
}

interface ADPScoreEntry {
  name: string;
  position: string;
  team: string;
  adp: number;
  predictedVor: number;
  ciLower: number;
  ciUpper: number;
}

interface PPGScoreEntry {
  name: string;
  position: string;
  predictedPPG: number;
}

interface RedraftPlayer {
  name: string;
  position: string;
  ppg: number;
}

interface Row {
  name: string;
  position: string;
  team: string;
  adp: number;
  high: number;
  low: number;
  stdev: number;
  projPPG: number;   // ML-predicted PPG (score-store/ppg.json)
  scenPPG: number;   // scenario-adjustable PPG (redraft + SDIO)
  boomPct: number;
  bustPct: number;
}

type SortKey = 'adp' | 'name' | 'position' | 'team' | 'projPPG' | 'scenPPG' | 'boomPct' | 'bustPct';

export function ExternalRankings2026({ scenario }: { scenario?: ScenarioConfig }) {
  const [ffc, setFfc] = useState<FfcADPPlayer[]>([]);
  const [adpScores, setAdpScores] = useState<ADPScoreEntry[]>([]);
  const [ppgScores, setPpgScores] = useState<PPGScoreEntry[]>([]);
  const [redraft, setRedraft] = useState<RedraftPlayer[]>([]);
  const [sdio, setSdio] = useState<SDIOProjection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [posFilter, setPosFilter] = useState('ALL');
  const [sortKey, setSortKey] = useState<SortKey>('adp');
  const [sortAsc, setSortAsc] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetchFfcADP(2026, 'ppr').catch(() => [] as FfcADPPlayer[]),
      fetch(`${BASE}data/score-store/adp.json`).then(r => r.json()).catch(() => [] as ADPScoreEntry[]),
      fetch(`${BASE}data/score-store/ppg.json`).then(r => r.json()).catch(() => [] as PPGScoreEntry[]),
      fetch(`${BASE}data/redraft-projections.json`).then(r => r.json()).catch(() => ({ players: [] })),
      hasSDIOKey() ? fetchSDIOSeasonProjections(2026).catch(() => []) : Promise.resolve([]),
      // Fallback when score-store shards are stale/empty.
      fetch(`${BASE}data/feature-matrix.json`).then(r => r.json()).catch(() => null),
    ]).then(([ffcData, adpData, ppgData, rdData, sdioData, featureMatrix]) => {
      setFfc(ffcData);

      const fmAdp: ADPScoreEntry[] = (!adpData?.length && featureMatrix?.predictions2026)
        ? featureMatrix.predictions2026.map((p: Record<string, unknown>) => ({
            name: String(p.name ?? ''),
            position: String(p.position ?? ''),
            team: String(p.team ?? ''),
            adp: Number(p.adp) || 0,
            predictedVor: Number(p.predictedVor) || 0,
            ciLower: Number(p.ciLower) || 0,
            ciUpper: Number(p.ciUpper) || 0,
          }))
        : adpData;

      const fmPpg: PPGScoreEntry[] = (!ppgData?.length && featureMatrix?.ppgPredictions2026)
        ? featureMatrix.ppgPredictions2026.map((p: Record<string, unknown>) => ({
            name: String(p.name ?? ''),
            position: String(p.position ?? ''),
            predictedPPG: Number(p.predictedPPG) || 0,
          }))
        : ppgData;

      setAdpScores(fmAdp);
      setPpgScores(fmPpg);
      setRedraft(rdData.players ?? []);
      setSdio(sdioData);
      setLoading(false);
    }).catch((e) => {
      setError(e.message);
      setLoading(false);
    });
  }, []);

  const adpByName = useMemo(() => {
    const m = new Map<string, ADPScoreEntry>();
    for (const p of adpScores) m.set(normName(p.name), p);
    return m;
  }, [adpScores]);

  const ppgByName = useMemo(() => {
    const m = new Map<string, PPGScoreEntry>();
    for (const p of ppgScores) m.set(normName(p.name), p);
    return m;
  }, [ppgScores]);

  const redraftByName = useMemo(() => {
    const m = new Map<string, RedraftPlayer>();
    for (const p of redraft) m.set(normName(p.name), p);
    return m;
  }, [redraft]);

  const activeScenario = scenario;
  const scenarioSdio = useMemo(() => {
    if (!sdio.length || !activeScenario || isScenarioEmpty(activeScenario)) return sdio;
    return applyScenario(sdio, activeScenario);
  }, [sdio, activeScenario]);

  const sdioByName = useMemo(() => {
    const m = new Map<string, SDIOProjection>();
    for (const p of scenarioSdio) m.set(normName(p.Name), p);
    return m;
  }, [scenarioSdio]);

  const rows = useMemo((): Row[] => {
    return ffc.map((p) => {
      const nn = normName(p.name);
      const adpS = adpByName.get(nn);
      const ppgS = ppgByName.get(nn);
      const rd = redraftByName.get(nn);
      const sdioP = sdioByName.get(nn);

      const vor = adpS?.predictedVor ?? 0;
      const ciLow = adpS?.ciLower ?? 0;
      const ciHigh = adpS?.ciUpper ?? 0;

      let scenPPG = rd?.ppg ?? 0;
      if (sdioP && activeScenario && !isScenarioEmpty(activeScenario) && (sdioP.FantasyPointsPPR ?? 0) > 0) {
        scenPPG = Math.round((sdioP.FantasyPointsPPR / GAMES) * 10) / 10;
      }

      return {
        name: p.name,
        position: p.position,
        team: p.team,
        adp: p.adp,
        high: p.high,
        low: p.low,
        stdev: p.stdev,
        projPPG: ppgS?.predictedPPG ?? 0,
        scenPPG,
        boomPct: boomPct(vor, ciHigh),
        bustPct: bustPct(vor, ciLow),
      };
    });
  }, [ffc, adpByName, ppgByName, redraftByName, sdioByName, activeScenario]);

  const filtered = useMemo(() => {
    let data = [...rows];
    if (posFilter !== 'ALL') data = data.filter((r) => r.position === posFilter);
    if (search) {
      const q = search.toLowerCase();
      data = data.filter((r) =>
        r.name.toLowerCase().includes(q) ||
        r.team.toLowerCase().includes(q)
      );
    }
    data.sort((a, b) => {
      if (sortKey === 'name' || sortKey === 'position' || sortKey === 'team') {
        const av = a[sortKey];
        const bv = b[sortKey];
        return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      const av = a[sortKey] as number;
      const bv = b[sortKey] as number;
      return sortAsc ? av - bv : bv - av;
    });
    return data;
  }, [rows, posFilter, search, sortKey, sortAsc]);

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortAsc((a) => !a);
    else { setSortKey(key); setSortAsc(key === 'adp'); }
  }

  function sortArrow(key: SortKey) {
    if (key !== sortKey) return null;
    return <span className="sort-arrow">{sortAsc ? '▲' : '▼'}</span>;
  }

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading 2026 pre-season ADP + projections…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <h3>Failed to load 2026 rankings</h3>
        <p>{error}</p>
      </div>
    );
  }

  const hasScenario = !!activeScenario && !isScenarioEmpty(activeScenario);

  return (
    <>
      <div className="controls">
        <div className="control-group">
          <input
            type="text"
            placeholder="Search players or teams…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
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
        {hasScenario && (
          <span style={{
            fontSize: 11, background: '#6366f122', color: '#6366f1',
            border: '1px solid #6366f144', borderRadius: 6, padding: '2px 8px', fontWeight: 600,
          }}>
            Scenario Active
          </span>
        )}
      </div>

      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
        2026 pre-season rankings with community ADP. Proj PPG from model, Scen PPG from redraft
        projections {hasScenario ? '(scenario-adjusted)' : ''}, Boom/Bust from ADP CI.
        {' '}{filtered.length} of {rows.length} players shown.
      </p>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th style={{ width: 40 }}>#</th>
              <th onClick={() => handleSort('name')} className={sortKey === 'name' ? 'sorted' : ''} style={{ cursor: 'pointer' }}>
                Player{sortArrow('name')}
              </th>
              <th onClick={() => handleSort('position')} className={sortKey === 'position' ? 'sorted' : ''} style={{ cursor: 'pointer' }}>
                Pos{sortArrow('position')}
              </th>
              <th onClick={() => handleSort('team')} className={sortKey === 'team' ? 'sorted' : ''} style={{ cursor: 'pointer' }}>
                Team{sortArrow('team')}
              </th>
              <th onClick={() => handleSort('adp')} className={sortKey === 'adp' ? 'sorted' : ''} style={{ cursor: 'pointer', textAlign: 'right' }}>
                ADP{sortArrow('adp')}
              </th>
              <th onClick={() => handleSort('projPPG')} className={sortKey === 'projPPG' ? 'sorted' : ''} style={{ cursor: 'pointer', textAlign: 'right' }}>
                <span title="Model-predicted PPG">Proj PPG</span>{sortArrow('projPPG')}
              </th>
              <th onClick={() => handleSort('scenPPG')} className={sortKey === 'scenPPG' ? 'sorted' : ''} style={{ cursor: 'pointer', textAlign: 'right' }}>
                <span title="Redraft PPG, scenario-adjustable">Scen PPG</span>{sortArrow('scenPPG')}
              </th>
              <th onClick={() => handleSort('boomPct')} className={sortKey === 'boomPct' ? 'sorted' : ''} style={{ cursor: 'pointer', textAlign: 'right' }}>
                <span title="Upside % — CI upper vs predicted VOR">Boom%</span>{sortArrow('boomPct')}
              </th>
              <th onClick={() => handleSort('bustPct')} className={sortKey === 'bustPct' ? 'sorted' : ''} style={{ cursor: 'pointer', textAlign: 'right' }}>
                <span title="Downside % — predicted VOR vs CI lower">Bust%</span>{sortArrow('bustPct')}
              </th>
              <th style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 11 }}>High</th>
              <th style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 11 }}>Low</th>
              <th style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 11 }}>StDev</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={`${r.name}-${r.position}`}>
                <td className="rank-cell">{i + 1}</td>
                <td>
                  <strong><PlayerName name={r.name} position={r.position} /></strong>
                  
                </td>
                <td>
                  <span className={`pos-badge pos-${r.position}`}>{r.position}</span>
                </td>
                <td>{r.team}</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{r.adp.toFixed(1)}</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>
                  {r.projPPG > 0 ? r.projPPG.toFixed(1) : '—'}
                </td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>
                  {r.scenPPG > 0 ? r.scenPPG.toFixed(1) : '—'}
                </td>
                <td style={{ textAlign: 'right', fontWeight: 600, color: boomColor(r.boomPct) }}>
                  {r.boomPct > 0 ? `${r.boomPct}%` : '—'}
                </td>
                <td style={{ textAlign: 'right', fontWeight: 600, color: bustColor(r.bustPct) }}>
                  {r.bustPct > 0 ? `${r.bustPct}%` : '—'}
                </td>
                <td style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 11 }}>{r.high}</td>
                <td style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 11 }}>{r.low}</td>
                <td style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 11 }}>{r.stdev.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
