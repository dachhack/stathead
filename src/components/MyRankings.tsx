import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { fetchFfcADP } from '../data';
import { applyScenario, isScenarioEmpty, loadAllScenarios } from '../lib/scenarioEngine';
import { SCENARIO_PRESETS, type PresetMeta, type PlayerMeta } from '../lib/scenarioPresets';
import { fetchSDIOSeasonProjections, hasSDIOKey } from '../lib/sportsDataIO';
import { normName, positionStats, zScore } from '../lib/nameUtils';
import type { ScenarioConfig, FfcADPPlayer, SDIOProjection } from '../types';
import { DocsLink } from './DocsLink';

// ── Types ──

interface RedraftPlayer {
  name: string;
  position: string;
  ppg: number;
  recPG: number;
}

interface ADPScoreEntry {
  name: string;
  position: string;
  team: string;
  adp: number;
  predictedVor: number;
  ciLower: number;
  ciUpper: number;
  isRookie: boolean;
}

interface PPGScoreEntry {
  name: string;
  position: string;
  predictedPPG: number;
}

interface ShareScoreEntry {
  name: string;
  position: string;
  team: string;
  predTargetShare: number;
  predRushShare: number;
}

interface PriorStatsEntry {
  priorPPG: number;
  priorCarries: number;
  priorTargets: number;
  priorGames: number;
}

interface CompetitionEntry {
  priorTeamTouchShare: number;
  priorTeamTargetShare: number;
}

interface RankingRow {
  id: string;
  rank: number;
  name: string;
  position: string;
  team: string;
  // Projections
  ppg: number;
  // ADP
  adp: number;
  // Raw CI bounds from the ADP model (z-scored within position below)
  ciSpreadUp: number;   // ciUpper - predictedVor
  ciSpreadDown: number; // predictedVor - ciLower
  boomZ: number;        // z-score within position of ciSpreadUp
  bustZ: number;        // z-score within position of ciSpreadDown
  // Projected shares (from SDIO team totals)
  projTgtShare: number;  // 0-1
  projRushShare: number; // 0-1
  // Prior year
  priorPPG: number;
  priorTgtShare: number; // 0-1
  priorRushShare: number; // 0-1
  // Meta
  isRookie: boolean;
  isLocked: boolean;
}

interface SavedRanking {
  id: string;
  name: string;
  savedAt: string;
  order: string[];
  lockedIds: string[];
  scenarioId?: string;  // link to a saved projection scenario
}

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];
const STORAGE_KEY = 'stathead-my-rankings';
const GAMES = 17;

// Non-clay quick presets offered here (clay-blend presets would no-op without Clay).
const MR_PRESET_IDS = new Set(['preset-rookie-optimistic', 'preset-vet-optimistic', 'preset-injury-skeptic', 'preset-vegas-weighted']);

// Season fantasy points from a (possibly scenario-adjusted) SDIO line, under a
// chosen reception weight (PPR=1, Half=0.5, Standard=0).
function scoreSeasonPts(p: SDIOProjection, fmt: 'ppr' | 'half' | 'standard'): number {
  const recPt = fmt === 'ppr' ? 1 : fmt === 'half' ? 0.5 : 0;
  return (p.PassingYards || 0) * 0.04 + (p.PassingTouchdowns || 0) * 4 + (p.PassingInterceptions || 0) * -2
    + (p.RushingYards || 0) * 0.1 + (p.RushingTouchdowns || 0) * 6
    + (p.Receptions || 0) * recPt + (p.ReceivingYards || 0) * 0.1 + (p.ReceivingTouchdowns || 0) * 6
    + (p.FumblesLost || 0) * -2;
}
const BASE = import.meta.env.BASE_URL;

function makeId(name: string, pos: string): string {
  return `${normName(name)}:${pos}`;
}

function pct(v: number): string {
  if (!v) return '—';
  return `${Math.round(v * 100)}%`;
}

// Color a z-score: positive boom z = upside, positive bust z = downside risk.
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

function fmtZ(z: number): string {
  if (!Number.isFinite(z) || z === 0) return '—';
  const sign = z > 0 ? '+' : '';
  return `${sign}${z.toFixed(2)}`;
}

// ── Component ──

export function MyRankings({ scenario }: { scenario: ScenarioConfig }) {
  const [loading, setLoading] = useState(true);
  const [redraft, setRedraft] = useState<RedraftPlayer[]>([]);
  const [ffc, setFfc] = useState<FfcADPPlayer[]>([]);
  const [sdio, setSdio] = useState<SDIOProjection[]>([]);
  const [adpScores, setAdpScores] = useState<ADPScoreEntry[]>([]);
  const [ppgScores, setPpgScores] = useState<PPGScoreEntry[]>([]);
  const [shareScores, setShareScores] = useState<ShareScoreEntry[]>([]);
  const [priorStats, setPriorStats] = useState<Record<string, PriorStatsEntry>>({});
  const [competition, setCompetition] = useState<Record<string, CompetitionEntry>>({});

  const [posFilter, setPosFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [showSaved, setShowSaved] = useState(false);
  const [savedList, setSavedList] = useState<SavedRanking[]>([]);
  const [rankingName, setRankingName] = useState('My Rankings');

  const [customOrder, setCustomOrder] = useState<string[] | null>(null);
  const [lockedIds, setLockedIds] = useState<Set<string>>(new Set());

  // Projection scenario selection
  const [savedScenarios, setSavedScenarios] = useState<ScenarioConfig[]>([]);
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>('');
  // League scoring format — re-scores PPG from the projected stat line.
  const [scoringFormat, setScoringFormat] = useState<'ppr' | 'half' | 'standard'>('ppr');

  const dragIdx = useRef<number | null>(null);
  const dragOverIdx = useRef<number | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`${BASE}data/redraft-projections.json`).then(r => r.json()).catch(() => ({ players: [] })),
      fetchFfcADP(2026, 'ppr').catch(() => [] as FfcADPPlayer[]),
      hasSDIOKey() ? fetchSDIOSeasonProjections(2026).catch(() => []) : Promise.resolve([]),
      fetch(`${BASE}data/score-store/adp.json`).then(r => r.json()).catch(() => []),
      fetch(`${BASE}data/score-store/ppg.json`).then(r => r.json()).catch(() => []),
      fetch(`${BASE}data/score-store/shares.json`).then(r => r.json()).catch(() => []),
      fetch(`${BASE}data/feature-store/priorStats.json`).then(r => r.json()).catch(() => ({})),
      fetch(`${BASE}data/feature-store/competition.json`).then(r => r.json()).catch(() => ({})),
      // Fallback source — if score-store shards are empty, hydrate from the monolithic matrix.
      fetch(`${BASE}data/feature-matrix.json`).then(r => r.json()).catch(() => null),
    ]).then(([rdData, ffcData, sdioData, adpData, ppgData, shareData, priorData, compData, featureMatrix]) => {
      setRedraft(rdData.players ?? []);
      setFfc(ffcData);
      setSdio(sdioData);

      // If score-store is empty, derive equivalent shards from feature-matrix.json so
      // UI does not silently lose VOR/Boom/Bust/shares when the auto-commit lag leaves
      // the shards stale. Shape matches `src/lib/modelScoreStore.ts`.
      const fmAdp: ADPScoreEntry[] = (!adpData?.length && featureMatrix?.predictions2026)
        ? featureMatrix.predictions2026.map((p: Record<string, unknown>) => ({
            name: String(p.name ?? ''),
            position: String(p.position ?? ''),
            team: String(p.team ?? ''),
            adp: Number(p.adp) || 0,
            predictedVor: Number(p.predictedVor) || 0,
            ciLower: Number(p.ciLower) || 0,
            ciUpper: Number(p.ciUpper) || 0,
            isRookie: Boolean(p.isRookie),
          }))
        : adpData;

      const fmPpg: PPGScoreEntry[] = (!ppgData?.length && featureMatrix?.ppgPredictions2026)
        ? featureMatrix.ppgPredictions2026.map((p: Record<string, unknown>) => ({
            name: String(p.name ?? ''),
            position: String(p.position ?? ''),
            predictedPPG: Number(p.predictedPPG) || 0,
          }))
        : ppgData;

      const fmShares: ShareScoreEntry[] = (!shareData?.length && Array.isArray(featureMatrix?.predRows))
        ? featureMatrix.predRows
            .map((r: Record<string, unknown>) => {
              const feats = (r.features ?? {}) as Record<string, number>;
              const t = feats.predTargetShare || 0;
              const rs = feats.predRushShare || 0;
              if (!t && !rs) return null;
              return {
                name: String(r.name ?? ''),
                position: String(r.position ?? ''),
                team: String(r.team ?? ''),
                predTargetShare: t,
                predRushShare: rs,
              };
            })
            .filter((x: ShareScoreEntry | null): x is ShareScoreEntry => x !== null)
        : shareData;

      setAdpScores(fmAdp);
      setPpgScores(fmPpg);
      setShareScores(fmShares);
      setPriorStats(priorData);
      setCompetition(compData);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setSavedList(JSON.parse(raw));
    } catch { /* ignore */ }
    setSavedScenarios(loadAllScenarios());
  }, []);

  // Lookup maps
  const ffcByName = useMemo(() => {
    const m = new Map<string, FfcADPPlayer>();
    for (const p of ffc) m.set(normName(p.name), p);
    return m;
  }, [ffc]);

  const adpScoreByName = useMemo(() => {
    const m = new Map<string, ADPScoreEntry>();
    for (const p of adpScores) m.set(normName(p.name), p);
    return m;
  }, [adpScores]);

  const ppgScoreByName = useMemo(() => {
    const m = new Map<string, PPGScoreEntry>();
    for (const p of ppgScores) m.set(normName(p.name), p);
    return m;
  }, [ppgScores]);

  const shareScoreByName = useMemo(() => {
    const m = new Map<string, ShareScoreEntry>();
    for (const p of shareScores) m.set(normName(p.name), p);
    return m;
  }, [shareScores]);

  // Prior data: prefer ::2026 entries (which contain 2025 actual stats as "prior")
  const priorByName = useMemo(() => {
    const m = new Map<string, PriorStatsEntry>();
    for (const [key, val] of Object.entries(priorStats)) {
      if (key.endsWith('::2025') || key.endsWith('::2026')) {
        const rawName = key.replace(/::20\d{2}$/, '');
        const name = normName(rawName);
        // Prefer ::2026 (has 2025 actuals) over ::2025 (has 2024 actuals)
        if (!m.has(name) || key.endsWith('::2026')) {
          m.set(name, val as PriorStatsEntry);
        }
      }
    }
    return m;
  }, [priorStats]);

  const compByName = useMemo(() => {
    const m = new Map<string, CompetitionEntry>();
    for (const [key, val] of Object.entries(competition)) {
      if (key.endsWith('::2025') || key.endsWith('::2026')) {
        const rawName = key.replace(/::20\d{2}$/, '');
        const name = normName(rawName);
        // Prefer ::2026 (which has 2025 actuals as "prior") over ::2025 (which has 2024 actuals)
        if (!m.has(name) || key.endsWith('::2026')) {
          m.set(name, val as CompetitionEntry);
        }
      }
    }
    return m;
  }, [competition]);

  // Rookie/age metadata for quick presets, from the ADP model rows.
  const presetMeta = useMemo(() => {
    const m: PresetMeta = new Map<string, PlayerMeta>();
    for (const a of adpScores) {
      m.set(normName(a.name), { isRookie: a.isRookie, yearsExp: a.isRookie ? 0 : null, age: null, priorGames: null });
    }
    return m;
  }, [adpScores]);

  // Resolve active scenario: a selected quick preset or saved scenario overrides
  // the prop scenario. Clay-dependent presets are excluded (no Clay data here).
  const activeScenario = useMemo(() => {
    if (selectedScenarioId.startsWith('preset-')) {
      const preset = SCENARIO_PRESETS.find(p => p.id === selectedScenarioId);
      if (preset && sdio.length) return preset.build(sdio, presetMeta, normName, {});
    } else if (selectedScenarioId) {
      const found = savedScenarios.find(s => s.id === selectedScenarioId);
      if (found) return found;
    }
    return scenario;
  }, [selectedScenarioId, savedScenarios, scenario, sdio, presetMeta]);

  // Apply scenario to SDIO projections
  const scenarioSdio = useMemo(() => {
    if (!sdio.length || isScenarioEmpty(activeScenario)) return sdio;
    return applyScenario(sdio, activeScenario);
  }, [sdio, activeScenario]);

  const sdioByName = useMemo(() => {
    const m = new Map<string, SDIOProjection>();
    for (const p of scenarioSdio) m.set(normName(p.Name), p);
    return m;
  }, [scenarioSdio]);

  // Team totals from SDIO for projected share computation
  const teamTotals = useMemo(() => {
    const totals = new Map<string, { rushAtt: number; tgt: number }>();
    for (const p of scenarioSdio) {
      if (!p.Team) continue;
      const t = totals.get(p.Team) ?? { rushAtt: 0, tgt: 0 };
      if (p.Position === 'RB') {
        t.rushAtt += p.RushingAttempts || 0;
      }
      // Targets = receptions for non-QBs (SDIO doesn't have explicit targets, use receptions as proxy)
      if (p.Position !== 'QB' && p.Position !== 'K') {
        t.tgt += p.Receptions || 0;
      }
      totals.set(p.Team, t);
    }
    return totals;
  }, [scenarioSdio]);

  // Build merged rows
  const allRows = useMemo((): RankingRow[] => {
    const seen = new Set<string>();
    const rows: RankingRow[] = [];

    const buildRow = (name: string, position: string, basePpg: number, team: string): RankingRow | null => {
      const id = makeId(name, position);
      if (seen.has(id)) return null;
      seen.add(id);

      const nn = normName(name);
      const ffcP = ffcByName.get(nn);
      const adpS = adpScoreByName.get(nn);
      const ppgS = ppgScoreByName.get(nn);
      const shareS = shareScoreByName.get(nn);
      const sdioP = sdioByName.get(nn);
      const prior = priorByName.get(nn);
      const comp = compByName.get(nn);

      // PPG priority: 1) ML pipeline score-store predictedPPG, 2) redraft projections fallback
      let ppg = ppgS?.predictedPPG ?? basePpg;
      // Recompute from the (scenario-adjusted) SDIO line when a scenario is active
      // or a non-PPR league scoring format is selected.
      const scenarioActive = !isScenarioEmpty(activeScenario);
      if (sdioP && (sdioP.FantasyPointsPPR ?? 0) > 0 && (scenarioActive || scoringFormat !== 'ppr')) {
        const seasonPts = scoringFormat === 'ppr' ? (sdioP.FantasyPointsPPR ?? 0) : scoreSeasonPts(sdioP, scoringFormat);
        ppg = Math.round((seasonPts / GAMES) * 10) / 10;
      }

      const resolvedTeam = ffcP?.team ?? adpS?.team ?? sdioP?.Team ?? team;

      // CI bounds from the ADP model. The boom/bust *spreads* (raw numbers)
      // are computed here; the within-position z-score is applied in a
      // second pass once we have all rows, since z-score requires the
      // position cohort's mean+std.
      const vor = adpS?.predictedVor ?? 0;
      const ciLow = adpS?.ciLower ?? 0;
      const ciHigh = adpS?.ciUpper ?? 0;
      const ciSpreadUp = adpS ? Math.max(0, ciHigh - vor) : 0;
      const ciSpreadDown = adpS ? Math.max(0, vor - ciLow) : 0;

      // Projected shares: SDIO (scenario) > share model predictions > prior year
      let projTgtShare = 0;
      let projRushShare = 0;
      if (sdioP && resolvedTeam) {
        const tt = teamTotals.get(resolvedTeam);
        if (tt) {
          if (position !== 'QB' && tt.tgt > 0) {
            projTgtShare = (sdioP.Receptions || 0) / tt.tgt;
          }
          if (position === 'RB' && tt.rushAtt > 0) {
            projRushShare = (sdioP.RushingAttempts || 0) / tt.rushAtt;
          }
        }
      }
      // Share model predictions (primary source when no SDIO)
      if (!projTgtShare && shareS) {
        projTgtShare = shareS.predTargetShare ?? 0;
      }
      if (!projRushShare && shareS && position === 'RB') {
        projRushShare = shareS.predRushShare ?? 0;
      }
      // Final fallback: prior year shares
      if (!projTgtShare && comp) {
        projTgtShare = comp.priorTeamTargetShare ?? 0;
      }
      if (!projRushShare && comp && position === 'RB') {
        projRushShare = comp.priorTeamTouchShare ?? 0;
      }

      return {
        id,
        rank: 0,
        name,
        position,
        team: resolvedTeam,
        ppg,
        adp: ffcP?.adp ?? adpS?.adp ?? 999,
        ciSpreadUp,
        ciSpreadDown,
        boomZ: 0, // filled in below once position stats are known
        bustZ: 0,
        projTgtShare,
        projRushShare,
        priorPPG: prior?.priorPPG ?? 0,
        priorTgtShare: comp?.priorTeamTargetShare ?? 0,
        priorRushShare: position === 'RB' ? (comp?.priorTeamTouchShare ?? 0) : 0,
        isRookie: !prior || (prior.priorGames ?? 0) === 0,
        isLocked: false,
      };
    };

    // Start from redraft projections
    for (const p of redraft) {
      const row = buildRow(p.name, p.position, p.ppg, '');
      if (row) rows.push(row);
    }

    // Add FFC ADP players not in redraft
    for (const p of ffc) {
      if (!['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
      const row = buildRow(p.name, p.position, 0, p.team);
      if (row) rows.push(row);
    }

    // Within-position z-scores for boom (CI upside spread) and bust
    // (CI downside spread). Only count rows that have CI data (>0) so an
    // ocean of 0-spread rookies/depth pieces doesn't drag the mean down.
    const boomPool = rows.filter((r) => r.ciSpreadUp > 0);
    const bustPool = rows.filter((r) => r.ciSpreadDown > 0);
    const boomStats = positionStats(boomPool, (r) => r.position, (r) => r.ciSpreadUp);
    const bustStats = positionStats(bustPool, (r) => r.position, (r) => r.ciSpreadDown);
    for (const r of rows) {
      if (r.ciSpreadUp > 0) {
        r.boomZ = Math.round(zScore(r.ciSpreadUp, boomStats.get(r.position)) * 100) / 100;
      }
      if (r.ciSpreadDown > 0) {
        r.bustZ = Math.round(zScore(r.ciSpreadDown, bustStats.get(r.position)) * 100) / 100;
      }
    }

    // Sort by PPG descending
    rows.sort((a, b) => b.ppg - a.ppg);

    return rows;
  }, [redraft, ffc, ffcByName, adpScoreByName, ppgScoreByName, shareScoreByName, sdioByName, priorByName, compByName, teamTotals, activeScenario, scoringFormat]);

  // Apply custom order
  const rankedRows = useMemo(() => {
    let ordered: RankingRow[];
    if (customOrder) {
      const orderMap = new Map(customOrder.map((id, i) => [id, i]));
      ordered = [...allRows].sort((a, b) => (orderMap.get(a.id) ?? 99999) - (orderMap.get(b.id) ?? 99999));
    } else {
      ordered = [...allRows];
    }
    return ordered.map((r, i) => ({ ...r, rank: i + 1, isLocked: lockedIds.has(r.id) }));
  }, [allRows, customOrder, lockedIds]);

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
  const onDragStart = useCallback((idx: number) => { dragIdx.current = idx; }, []);
  const onDragOver = useCallback((e: React.DragEvent, idx: number) => { e.preventDefault(); dragOverIdx.current = idx; }, []);

  const onDrop = useCallback(() => {
    if (dragIdx.current === null || dragOverIdx.current === null || dragIdx.current === dragOverIdx.current) return;
    const fromRow = displayRows[dragIdx.current];
    const toRow = displayRows[dragOverIdx.current];
    if (!fromRow || !toRow) return;

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

  const toggleLock = useCallback((id: string) => {
    setLockedIds(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }, []);

  const resetOrder = useCallback(() => { setCustomOrder(null); setLockedIds(new Set()); }, []);

  const saveCurrent = useCallback(() => {
    const entry: SavedRanking = {
      id: `rank-${Date.now()}`, name: rankingName, savedAt: new Date().toISOString(),
      order: customOrder ?? rankedRows.map(r => r.id), lockedIds: [...lockedIds],
      scenarioId: selectedScenarioId || undefined,
    };
    const updated = [...savedList.filter(s => s.name !== rankingName), entry];
    setSavedList(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  }, [rankingName, customOrder, rankedRows, lockedIds, savedList, selectedScenarioId]);

  const loadSaved = useCallback((s: SavedRanking) => {
    setCustomOrder(s.order); setLockedIds(new Set(s.lockedIds)); setRankingName(s.name); setShowSaved(false);
    setSelectedScenarioId(s.scenarioId ?? '');
  }, []);

  const deleteSaved = useCallback((id: string) => {
    const updated = savedList.filter(s => s.id !== id);
    setSavedList(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  }, [savedList]);

  const hasScenario = !isScenarioEmpty(activeScenario);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading rankings data...</div>
      </div>
    );
  }

  const th: React.CSSProperties = { padding: '6px 5px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '5px 5px', fontSize: 12 };

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '16px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>My Rankings</h1>
        <DocsLink section="projection" title="Projection model validation — Model Docs" />
        {hasScenario && (
          <span style={{
            fontSize: 11, background: '#6366f122', color: '#6366f1',
            border: '1px solid #6366f144', borderRadius: 6, padding: '2px 8px', fontWeight: 600,
          }}>
            {selectedScenarioId
              ? `Scenario: ${SCENARIO_PRESETS.find(p => p.id === selectedScenarioId)?.name ?? savedScenarios.find(s => s.id === selectedScenarioId)?.name ?? 'Active'}`
              : 'Scenario Active'}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Scenario picker */}
          <select
            value={selectedScenarioId}
            onChange={e => setSelectedScenarioId(e.target.value)}
            style={{
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 6, padding: '4px 8px', fontSize: 11, color: 'var(--text-primary)',
              fontFamily: 'inherit', maxWidth: 150,
            }}
          >
            <option value="">No Scenario</option>
            <optgroup label="Quick presets">
              {SCENARIO_PRESETS.filter(p => MR_PRESET_IDS.has(p.id)).map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </optgroup>
            {savedScenarios.length > 0 && (
              <optgroup label="Saved">
                {savedScenarios.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </optgroup>
            )}
          </select>
          {/* League scoring */}
          <select
            value={scoringFormat}
            onChange={e => setScoringFormat(e.target.value as 'ppr' | 'half' | 'standard')}
            title="League scoring — re-scores PPG from the projected stat line"
            style={{
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 6, padding: '4px 8px', fontSize: 11, color: 'var(--text-primary)',
              fontFamily: 'inherit',
            }}
          >
            <option value="ppr">PPR</option>
            <option value="half">Half-PPR</option>
            <option value="standard">Standard</option>
          </select>
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
                {s.scenarioId && (
                  <span style={{
                    fontSize: 10, background: '#6366f122', color: '#6366f1',
                    borderRadius: 4, padding: '1px 5px', marginLeft: 6,
                  }}>
                    {savedScenarios.find(sc => sc.id === s.scenarioId)?.name ?? 'Scenario'}
                  </span>
                )}
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
          <button key={p} className={`pos-filter ${posFilter === p ? 'active' : ''}`} onClick={() => setPosFilter(p)}>
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
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{displayRows.length} players</span>
      </div>

      {/* Hint */}
      <div style={{ fontSize: 11, color: customOrder ? '#6366f1' : 'var(--text-muted)', marginBottom: 8 }}>
        {customOrder
          ? 'Custom ranking active. Drag to adjust, or Reset to return to default.'
          : `Drag rows to reorder. Default sort: projected PPG.${hasScenario ? ' Scenario adjustments applied.' : ''}`}
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border)' }}>
              <th style={{ ...th, textAlign: 'center', width: 28 }}>#</th>
              <th style={{ ...th, textAlign: 'left', minWidth: 120 }}>Player</th>
              <th style={{ ...th, textAlign: 'center', width: 36 }}>Pos</th>
              <th style={{ ...th, textAlign: 'center', width: 36 }}>Tm</th>
              <th style={{ ...th, textAlign: 'right', width: 44 }} title={`Projected points per game (${scoringFormat === 'ppr' ? 'PPR' : scoringFormat === 'half' ? 'Half-PPR' : 'Standard'})`}>PPG</th>
              <th style={{ ...th, textAlign: 'right', width: 44 }} title="Current FantasyCalc/FFC redraft ADP">ADP</th>
              <th style={{ ...th, textAlign: 'right', width: 48 }}>
                <span title="Boom z-score — CI upside spread vs the position cohort. >+1 = unusually wide upside.">Boom z</span>
              </th>
              <th style={{ ...th, textAlign: 'right', width: 48 }}>
                <span title="Bust z-score — CI downside spread vs the position cohort. >+1 = unusually wide downside risk.">Bust z</span>
              </th>
              <th style={{ ...th, textAlign: 'right', width: 44 }}>Tgt%</th>
              <th style={{ ...th, textAlign: 'right', width: 44 }}>Rush%</th>
              <th style={{ ...th, textAlign: 'right', width: 44, borderLeft: '1px solid var(--border)' }}>
                <span title="Prior season PPG">Pr PPG</span>
              </th>
              <th style={{ ...th, textAlign: 'right', width: 44 }}>
                <span title="Prior season target share">Pr Tgt%</span>
              </th>
              <th style={{ ...th, textAlign: 'right', width: 44 }}>
                <span title="Prior season rush share">Pr Rush%</span>
              </th>
              <th style={{ ...th, textAlign: 'center', width: 24 }}></th>
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
                onDragEnter={(e) => { (e.currentTarget as HTMLElement).style.borderTop = '2px solid #6366f1'; }}
                onDragLeave={(e) => { (e.currentTarget as HTMLElement).style.borderTop = ''; }}
                onDragEnd={(e) => { (e.currentTarget as HTMLElement).style.borderTop = ''; }}
                style={{
                  borderBottom: '1px solid var(--border)',
                  cursor: 'grab',
                  background: r.isLocked ? 'var(--bg-tertiary)' : undefined,
                }}
              >
                <td style={{ ...td, textAlign: 'center', fontWeight: 700, color: 'var(--text-muted)' }}>{r.rank}</td>
                <td style={{ ...td, fontWeight: 600 }}>
                  {r.name}
                  {r.isRookie && <span style={{ fontSize: 9, color: '#6366f1', marginLeft: 4 }}>R</span>}
                </td>
                <td style={{ ...td, textAlign: 'center' }}>
                  <span className={`pos-badge pos-${r.position}`} style={{ fontSize: 10 }}>{r.position}</span>
                </td>
                <td style={{ ...td, textAlign: 'center', color: 'var(--text-muted)' }}>{r.team || '—'}</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{r.ppg > 0 ? r.ppg.toFixed(1) : '—'}</td>
                <td style={{ ...td, textAlign: 'right' }}>{r.adp < 999 ? r.adp.toFixed(1) : '—'}</td>
                <td style={{ ...td, textAlign: 'right', fontSize: 11, fontWeight: 600, color: boomColor(r.boomZ) }}>
                  {fmtZ(r.boomZ)}
                </td>
                <td style={{ ...td, textAlign: 'right', fontSize: 11, fontWeight: 600, color: bustColor(r.bustZ) }}>
                  {fmtZ(r.bustZ)}
                </td>
                <td style={{ ...td, textAlign: 'right', color: 'var(--text-secondary)' }}>
                  {r.projTgtShare > 0 ? pct(r.projTgtShare) : '—'}
                </td>
                <td style={{ ...td, textAlign: 'right', color: 'var(--text-secondary)' }}>
                  {r.projRushShare > 0 ? pct(r.projRushShare) : '—'}
                </td>
                <td style={{ ...td, textAlign: 'right', borderLeft: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                  {r.priorPPG > 0 ? r.priorPPG.toFixed(1) : '—'}
                </td>
                <td style={{ ...td, textAlign: 'right', color: 'var(--text-muted)' }}>
                  {r.priorTgtShare > 0 ? pct(r.priorTgtShare) : '—'}
                </td>
                <td style={{ ...td, textAlign: 'right', color: 'var(--text-muted)' }}>
                  {r.priorRushShare > 0 ? pct(r.priorRushShare) : '—'}
                </td>
                <td style={{ ...td, textAlign: 'center' }}>
                  <button
                    onClick={() => toggleLock(r.id)}
                    title={r.isLocked ? 'Unlock rank' : 'Lock rank'}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: r.isLocked ? '#6366f1' : 'var(--text-muted)', fontSize: 11, padding: 0,
                    }}
                  >
                    {r.isLocked ? '\u{1F512}' : '\u{1F4CC}'}
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
