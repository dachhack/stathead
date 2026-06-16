import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { PlayerName } from './PlayerName';
import { fetchCombine, fetchFantasyRankings, fetchDynastyRankingsForDisplay, fetchRosters } from '../data';
import { canonicalizePlayerName } from '../lib/combineNameAliases';
import { applyScenario, isScenarioEmpty, loadAllScenarios } from '../lib/scenarioEngine';
import type {
  CombineResult,
  FantasyRanking,
  DynastyPlayer,
  Roster,
  ScenarioConfig,
  SDIOProjection,
} from '../types';
import prospectGrades from '../data/prospect-grades-2026.json';
import { normalizeNameUnicode as normalizeName } from '../lib/nameMatch';

// ── Types ──

interface ProspectGrade {
  name: string;
  pos: string;
  school: string;
  grade: number;
  projRound: number;
  projPick: number;
  tier: string;
  team?: string;
  actualRound?: number;
  actualPick?: number;
}

interface RedraftPlayer {
  name: string;
  position: string;
  ppg: number;
  recPG: number;
}

interface CareerPrediction {
  ppg: number;
  combinedScore: number;
  percentile: number;
  modelTier: number;
  boomProb: number;
  bustProb: number;
  boomZ?: number;
  bustZ?: number;
}

interface ProspectRankRow {
  id: string;
  rank: number;
  name: string;
  pos: string;
  school: string;
  // Scouting & model signals
  grade: number;
  projRound: number;
  projPick: number;
  scoutTier: string;
  rookieEcr: number;
  dynastyValue: number;
  predictedCareerPPG: number;
  modelTier: number;
  percentile: number;
  boomZ?: number;
  bustZ?: number;
  // NFL landing spot + projected volume (post-draft)
  nflTeam: string;
  hasNflTeam: boolean;
  projPPG: number;
  projTgtShare: number;
  projRushShare: number;
  projTargets: number;
  projRushAtt: number;
  // Actual draft results (populated once the player is drafted; sourced
  // from combine.draft_team/draft_round/draft_ovr).
  actualDraftTeam: string;
  actualDraftRound: number;
  actualDraftPick: number;
  // UI
  isLocked: boolean;
}

interface SavedProspectRanking {
  id: string;
  name: string;
  savedAt: string;
  order: string[];
  lockedIds: string[];
  scenarioId?: string;
}

const STORAGE_KEY = 'stathead-prospect-rankings';
const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];
const DRAFT_YEAR = 2026;
const GAMES = 17;
const BASE = import.meta.env.BASE_URL;

// Rookie career model tier system — kept in lock-step with
// RookieProspectsView and RookieCareerBacktest. See
// train_career_models.py for how modelTier is assigned from percentile
// and scout-consensus override.
const MODEL_TIER_MAP: Record<number, { label: string; color: string }> = {
  1: { label: 'Alpha',       color: '#22c55e' },
  2: { label: 'Blue Chip',   color: '#4ade80' },
  3: { label: 'Starter',     color: '#a3e635' },
  4: { label: 'Contributor', color: '#facc15' },
  5: { label: 'Depth',       color: '#fb923c' },
  6: { label: 'Longshot',    color: '#ef4444' },
};


function makeId(name: string, pos: string): string {
  return `${normalizeName(name)}:${pos}`;
}

function pct(v: number): string {
  if (!v) return '—';
  return `${Math.round(v * 100)}%`;
}

function gradeColor(g: number): string {
  if (g >= 90) return '#22c55e';
  if (g >= 85) return '#4ade80';
  if (g >= 78) return '#a3e635';
  if (g >= 70) return '#facc15';
  if (g >= 64) return '#fb923c';
  return '#ef4444';
}

function valueColor(v: number): string {
  if (v >= 7000) return '#22c55e';
  if (v >= 5000) return '#4ade80';
  if (v >= 3000) return '#a3e635';
  if (v >= 1500) return '#facc15';
  if (v >= 500) return '#fb923c';
  return 'var(--text-muted)';
}

function ecrTierColor(ecr: number): string {
  if (ecr <= 5) return '#22c55e';
  if (ecr <= 12) return '#4ade80';
  if (ecr <= 24) return '#a3e635';
  if (ecr <= 48) return '#facc15';
  if (ecr <= 80) return '#fb923c';
  return 'var(--text-muted)';
}

// ── Component ──

export function MyProspectRankings({ scenario }: { scenario: ScenarioConfig }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [combine, setCombine] = useState<CombineResult[]>([]);
  const [fpRanks, setFpRanks] = useState<FantasyRanking[]>([]);
  const [dynasty, setDynasty] = useState<DynastyPlayer[]>([]);
  const [careerMap, setCareerMap] = useState<Map<string, CareerPrediction>>(new Map());
  const [redraft, setRedraft] = useState<RedraftPlayer[]>([]);
  const [rosters, setRosters] = useState<Roster[]>([]);

  const [posFilter, setPosFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [showSaved, setShowSaved] = useState(false);
  const [savedList, setSavedList] = useState<SavedProspectRanking[]>([]);
  const [rankingName, setRankingName] = useState('My Prospect Rankings');

  const [customOrder, setCustomOrder] = useState<string[] | null>(null);
  const [lockedIds, setLockedIds] = useState<Set<string>>(new Set());

  const [savedScenarios, setSavedScenarios] = useState<ScenarioConfig[]>([]);
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>('');

  const dragIdx = useRef<number | null>(null);
  const dragOverIdx = useRef<number | null>(null);

  // ── Data loading ──
  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchCombine().catch(() => [] as CombineResult[]),
      fetchFantasyRankings().catch(() => [] as FantasyRanking[]),
      fetchDynastyRankingsForDisplay('1qb').catch(() => [] as DynastyPlayer[]),
      fetch(`${BASE}data/feature-matrix.json`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`${BASE}data/redraft-projections.json`).then(r => r.ok ? r.json() : { players: [] }).catch(() => ({ players: [] })),
      fetchRosters(DRAFT_YEAR).catch(() => [] as Roster[]),
    ])
      .then(([combineData, fpData, dynastyData, featureData, redraftData, rosterData]) => {
        setCombine(combineData);
        setFpRanks(fpData);
        setDynasty(dynastyData);
        setRedraft((redraftData?.players ?? []) as RedraftPlayer[]);
        setRosters(rosterData);

        const cm = new Map<string, CareerPrediction>();
        if (featureData?.careerPredictions2026) {
          for (const p of featureData.careerPredictions2026) {
            cm.set(normalizeName(p.name), {
              ppg: p.predictedCareerPPG || 0,
              combinedScore: p.combinedScore || 0,
              percentile: p.percentile || 0,
              modelTier: p.modelTier || 0,
              boomProb: p.boomProb || 0,
              bustProb: p.bustProb || 0,
              boomZ: p.boomZ,
              bustZ: p.bustZ,
            });
          }
        }
        setCareerMap(cm);
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setSavedList(JSON.parse(raw));
    } catch { /* ignore */ }
    setSavedScenarios(loadAllScenarios());
  }, []);

  // ── Scenario resolution ──
  const activeScenario = useMemo(() => {
    if (selectedScenarioId) {
      const found = savedScenarios.find(s => s.id === selectedScenarioId);
      if (found) return found;
    }
    return scenario;
  }, [selectedScenarioId, savedScenarios, scenario]);

  // Roster lookup by normalized name → current NFL team
  const teamByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rosters) {
      if (!r.full_name || !r.team) continue;
      m.set(normalizeName(r.full_name), r.team);
    }
    return m;
  }, [rosters]);

  // Build an SDIO-shaped projection set from our internal redraft projections
  // so the existing scenarioEngine can apply team/volume/movement deltas.
  // FantasyPointsPPR is set to ppg * GAMES so recalc/scaling works by ratio.
  const internalProjections = useMemo((): SDIOProjection[] => {
    return redraft.map((p, idx) => {
      const team = teamByName.get(normalizeName(p.name)) || '';
      const rec = p.recPG > 0 ? p.recPG * GAMES : 0;
      return {
        PlayerID: 1_000_000 + idx,
        Name: p.name,
        Team: team,
        Position: p.position,
        FantasyPointsPPR: (p.ppg || 0) * GAMES,
        FantasyPoints: (p.ppg || 0) * GAMES,
        PassingAttempts: 0,
        PassingCompletions: 0,
        PassingYards: 0,
        PassingTouchdowns: 0,
        PassingInterceptions: 0,
        RushingAttempts: p.position === 'RB' ? Math.max(0, (p.ppg || 0) * GAMES * 0.8) : 0,
        RushingYards: 0,
        RushingTouchdowns: 0,
        Receptions: rec,
        ReceivingYards: 0,
        ReceivingTouchdowns: 0,
        FumblesLost: 0,
        FieldGoalsMade: 0,
        ExtraPointsMade: 0,
      };
    });
  }, [redraft, teamByName]);

  const scenarioProjections = useMemo(() => {
    if (!internalProjections.length || isScenarioEmpty(activeScenario)) return internalProjections;
    return applyScenario(internalProjections, activeScenario);
  }, [internalProjections, activeScenario]);

  const projByName = useMemo(() => {
    const m = new Map<string, SDIOProjection>();
    for (const p of scenarioProjections) m.set(normalizeName(p.Name), p);
    return m;
  }, [scenarioProjections]);

  const teamTotals = useMemo(() => {
    const totals = new Map<string, { rushAtt: number; tgt: number }>();
    for (const p of scenarioProjections) {
      if (!p.Team) continue;
      const t = totals.get(p.Team) ?? { rushAtt: 0, tgt: 0 };
      if (p.Position === 'RB') t.rushAtt += p.RushingAttempts || 0;
      if (p.Position !== 'QB' && p.Position !== 'K') t.tgt += p.Receptions || 0;
      totals.set(p.Team, t);
    }
    return totals;
  }, [scenarioProjections]);

  // ── Build merged rows ──
  const allRows = useMemo((): ProspectRankRow[] => {
    // Lookup maps. All keys flow through canonicalizePlayerName so spelling
    // variants across sources (PFR's hyphenated middle, FantasyPros' "Nick"
    // vs "Nicholas") collapse to a single key.
    const gradeMap = new Map<string, ProspectGrade>();
    for (const g of prospectGrades as ProspectGrade[]) {
      gradeMap.set(normalizeName(canonicalizePlayerName(g.name)), g);
    }

    const prospects2026 = combine.filter(c => c.season === DRAFT_YEAR);
    const combineMap = new Map<string, CombineResult>();
    for (const c of prospects2026) combineMap.set(normalizeName(canonicalizePlayerName(c.player_name)), c);
    const rookieFp = fpRanks.filter(r => r.ecr_type === 'drk');
    const fpMap = new Map<string, FantasyRanking>();
    for (const r of rookieFp) fpMap.set(normalizeName(canonicalizePlayerName(r.player)), r);

    const dynastyRookies = dynasty.filter(p => p.isRookie);
    const dynastyMap = new Map<string, DynastyPlayer>();
    for (const p of dynastyRookies) dynastyMap.set(normalizeName(canonicalizePlayerName(p.playerName)), p);

    const seen = new Set<string>();
    const rows: ProspectRankRow[] = [];

    const buildRow = (
      name: string,
      pos: string,
      school: string,
      pg?: ProspectGrade,
      fp?: FantasyRanking,
      dynastyP?: DynastyPlayer,
    ): ProspectRankRow | null => {
      const nn = normalizeName(name);
      const id = makeId(name, pos);
      if (seen.has(id)) return null;
      seen.add(id);

      const career = careerMap.get(nn);
      const proj = projByName.get(nn);
      const rosterTeam = teamByName.get(nn) || '';
      const combineRec = combineMap.get(nn);

      // Actual draft results from the combine feed. draft_team / draft_round /
      // draft_ovr populate on the day the pick is announced; before that
      // they're empty/0 and we fall back to '—' in the UI. Per-season the
      // combine feed sometimes lags — fall back to the post-draft fields on
      // the prospect-grades record (`pg.team` / `pg.actualRound` /
      // `pg.actualPick`), which is populated from nflverse the moment the
      // draft results are pulled. Without this fallback, the entire 2026
      // class shows '—' for team in MyProspectRankings until the combine
      // feed catches up.
      const actualDraftTeam = combineRec?.draft_team || pg?.team || '';
      const actualDraftRound = combineRec?.draft_round || pg?.actualRound || 0;
      const actualDraftPick = combineRec?.draft_ovr || pg?.actualPick || 0;

      // Projected volume — uses our internal redraft projections, scenario-adjusted.
      // Team prefers the actual draft team once announced, then the NFL roster feed.
      let projPPG = 0;
      let projTgtShare = 0;
      let projRushShare = 0;
      let projTargets = 0;
      let projRushAtt = 0;
      const nflTeam = actualDraftTeam || proj?.Team || rosterTeam;
      const hasNflTeam = !!nflTeam;
      if (proj) {
        projPPG = (proj.FantasyPointsPPR || 0) > 0
          ? Math.round((proj.FantasyPointsPPR / GAMES) * 10) / 10
          : 0;
        projTargets = proj.Receptions || 0;
        projRushAtt = proj.RushingAttempts || 0;
        const tt = nflTeam ? teamTotals.get(nflTeam) : undefined;
        if (tt) {
          if (pos !== 'QB' && tt.tgt > 0) projTgtShare = (proj.Receptions || 0) / tt.tgt;
          if (pos === 'RB' && tt.rushAtt > 0) projRushShare = (proj.RushingAttempts || 0) / tt.rushAtt;
        }
      }

      return {
        id,
        rank: 0,
        name,
        pos,
        school,
        grade: pg?.grade || 0,
        projRound: pg?.projRound || 0,
        projPick: pg?.projPick || 0,
        scoutTier: pg?.tier || '',
        rookieEcr: fp?.ecr ?? 999,
        dynastyValue: dynastyP?.value || 0,
        predictedCareerPPG: career?.ppg || 0,
        modelTier: career?.modelTier || 0,
        percentile: career?.percentile || 0,
        boomZ: career?.boomZ,
        bustZ: career?.bustZ,
        nflTeam,
        hasNflTeam,
        projPPG,
        projTgtShare,
        projRushShare,
        projTargets,
        projRushAtt,
        actualDraftTeam,
        actualDraftRound,
        actualDraftPick,
        isLocked: false,
      };
    };

    // Seed from combine 2026 prospects
    for (const c of prospects2026) {
      const canonicalName = canonicalizePlayerName(c.player_name);
      const nn = normalizeName(canonicalName);
      const pg = gradeMap.get(nn);
      const fp = fpMap.get(nn);
      const dynastyP = dynastyMap.get(nn);
      const pos = pg?.pos || c.pos || '';
      const row = buildRow(canonicalName, pos, c.school || pg?.school || '', pg, fp, dynastyP);
      if (row) {
        rows.push(row);
        gradeMap.delete(nn);
        fpMap.delete(nn);
        dynastyMap.delete(nn);
      }
    }

    // Add graded prospects not in combine
    for (const [nn, pg] of gradeMap) {
      const fp = fpMap.get(nn);
      const dynastyP = dynastyMap.get(nn);
      const row = buildRow(canonicalizePlayerName(pg.name), pg.pos, pg.school, pg, fp, dynastyP);
      if (row) {
        rows.push(row);
        fpMap.delete(nn);
        dynastyMap.delete(nn);
      }
    }

    // Add FantasyPros rookies not yet matched
    for (const [nn, fp] of fpMap) {
      const dynastyP = dynastyMap.get(nn);
      const row = buildRow(canonicalizePlayerName(fp.player), fp.pos || '', '', undefined, fp, dynastyP);
      if (row) {
        rows.push(row);
        dynastyMap.delete(nn);
      }
    }

    // Default sort: grade desc, then model PPG desc, then ECR asc
    rows.sort((a, b) => {
      const ga = a.grade || 0;
      const gb = b.grade || 0;
      if (gb !== ga) return gb - ga;
      const pa = a.predictedCareerPPG || 0;
      const pb = b.predictedCareerPPG || 0;
      if (pb !== pa) return pb - pa;
      return (a.rookieEcr || 999) - (b.rookieEcr || 999);
    });

    return rows;
  }, [combine, fpRanks, dynasty, careerMap, projByName, teamByName, teamTotals]);

  // Apply custom order + locks
  const rankedRows = useMemo(() => {
    let ordered: ProspectRankRow[];
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
    if (posFilter !== 'ALL') {
      rows = rows.filter(r => {
        const p = r.pos.toUpperCase();
        return p === posFilter;
      });
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(r =>
        r.name.toLowerCase().includes(q) ||
        r.school.toLowerCase().includes(q) ||
        r.nflTeam.toLowerCase().includes(q)
      );
    }
    return rows;
  }, [rankedRows, posFilter, search]);

  // ── Drag handlers ──
  const onDragStart = useCallback((idx: number) => { dragIdx.current = idx; }, []);
  const onDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault();
    dragOverIdx.current = idx;
  }, []);
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
    setLockedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const resetOrder = useCallback(() => {
    setCustomOrder(null);
    setLockedIds(new Set());
  }, []);

  // ── Save / load ──
  const saveCurrent = useCallback(() => {
    const entry: SavedProspectRanking = {
      id: `prospect-rank-${Date.now()}`,
      name: rankingName,
      savedAt: new Date().toISOString(),
      order: customOrder ?? rankedRows.map(r => r.id),
      lockedIds: [...lockedIds],
      scenarioId: selectedScenarioId || undefined,
    };
    const updated = [...savedList.filter(s => s.name !== rankingName), entry];
    setSavedList(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  }, [rankingName, customOrder, rankedRows, lockedIds, savedList, selectedScenarioId]);

  const loadSaved = useCallback((s: SavedProspectRanking) => {
    setCustomOrder(s.order);
    setLockedIds(new Set(s.lockedIds));
    setRankingName(s.name);
    setSelectedScenarioId(s.scenarioId ?? '');
    setShowSaved(false);
  }, []);

  const deleteSaved = useCallback((id: string) => {
    const updated = savedList.filter(s => s.id !== id);
    setSavedList(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  }, [savedList]);

  const hasScenario = !isScenarioEmpty(activeScenario);
  const draftedCount = allRows.filter(r => r.hasNflTeam).length;

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">Loading prospect data...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <h3>Failed to load prospect data</h3>
        <p>{error}</p>
      </div>
    );
  }

  const th: React.CSSProperties = { padding: '6px 5px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '5px 5px', fontSize: 12 };

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: '16px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>My Prospect Rankings</h1>
        <span style={{
          fontSize: 11, background: 'var(--bg-tertiary)', color: 'var(--text-muted)',
          borderRadius: 6, padding: '2px 8px', fontWeight: 600,
        }}>
          {DRAFT_YEAR} Class
        </span>
        {hasScenario && (
          <span style={{
            fontSize: 11, background: '#6366f122', color: '#6366f1',
            border: '1px solid #6366f144', borderRadius: 6, padding: '2px 8px', fontWeight: 600,
          }}>
            {selectedScenarioId
              ? `Scenario: ${savedScenarios.find(s => s.id === selectedScenarioId)?.name ?? 'Active'}`
              : 'Scenario Active'}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
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
            {savedScenarios.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <input
            value={rankingName}
            onChange={e => setRankingName(e.target.value)}
            placeholder="Ranking name..."
            style={{
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 6, padding: '4px 8px', fontSize: 12, color: 'var(--text-primary)',
              width: 160, fontFamily: 'inherit',
            }}
          />
          <button className="scenario-action-btn" onClick={saveCurrent} style={{ fontSize: 11 }}>Save</button>
          <button
            className={`scenario-action-btn ${showSaved ? 'active' : ''}`}
            onClick={() => {
              setShowSaved(v => !v);
              setSavedList(prev => {
                try {
                  const raw = localStorage.getItem(STORAGE_KEY);
                  return raw ? JSON.parse(raw) : prev;
                } catch { return prev; }
              });
            }}
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
              No saved prospect rankings yet
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
          placeholder="Search players, schools, or NFL teams..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '4px 8px', fontSize: 12, color: 'var(--text-primary)',
            width: 240, fontFamily: 'inherit', marginLeft: 'auto',
          }}
        />
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {displayRows.length} prospects &middot; {draftedCount} with NFL team
        </span>
      </div>

      {/* Hint */}
      <div style={{ fontSize: 11, color: customOrder ? '#6366f1' : 'var(--text-muted)', marginBottom: 8 }}>
        {customOrder
          ? 'Custom ranking active. Drag to adjust, or Reset to return to default.'
          : `Drag rows to reorder. Default sort: prospect grade, model PPG, ECR. Actual Pick + NFL team populate from the live draft feed; volume projections flow in from our internal projections once the rookie has a team.${hasScenario ? ' Scenario adjustments applied.' : ''}`}
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--border)' }}>
              <th style={{ ...th, textAlign: 'center', width: 28 }}>#</th>
              <th style={{ ...th, textAlign: 'left', minWidth: 140 }}>Player</th>
              <th style={{ ...th, textAlign: 'center', width: 36 }}>Pos</th>
              <th style={{ ...th, textAlign: 'left', minWidth: 100 }}>School</th>
              <th style={{ ...th, textAlign: 'right', width: 52 }}>Grade</th>
              <th style={{ ...th, textAlign: 'left', width: 72 }} title="Pre-draft projected round and pick (from prospect grades)">Proj Draft</th>
              <th
                style={{ ...th, textAlign: 'left', width: 96 }}
                title="Actual draft slot once the pick is announced; Δ shows pick difference vs projection (negative = drafted earlier than projected)"
              >
                Actual Pick
              </th>
              <th style={{ ...th, textAlign: 'right', width: 48 }}>ECR</th>
              <th style={{ ...th, textAlign: 'right', width: 60 }}>Dyn Val</th>
              <th style={{ ...th, textAlign: 'right', width: 56 }}>
                <span title="Model-predicted career PPG">Mdl PPG</span>
              </th>
              <th style={{ ...th, textAlign: 'right', width: 44 }}
                  title="Career percentile vs all historical rookies at this position">Pctl</th>
              <th style={{ ...th, textAlign: 'left', width: 92 }}
                  title="Rookie career model tier — Alpha, Blue Chip, Starter, Contributor, Depth, Longshot (percentile-bucketed with first-round scout-consensus override)">
                Tier
              </th>
              <th style={{ ...th, textAlign: 'right', width: 44 }} title="Boom z-score">Boom z</th>
              <th style={{ ...th, textAlign: 'right', width: 44 }} title="Bust z-score">Bust z</th>
              <th style={{
                ...th, textAlign: 'center', width: 44, borderLeft: '1px solid var(--border)',
                color: '#6366f1',
              }} title="NFL team — actual draft team if announced, otherwise current roster">NFL</th>
              <th style={{ ...th, textAlign: 'right', width: 52, color: '#6366f1' }}
                  title="Projected PPG from our internal projections, scenario-adjusted">
                Proj PPG
              </th>
              <th style={{ ...th, textAlign: 'right', width: 48, color: '#6366f1' }}
                  title="Projected target share on NFL team">Tgt%</th>
              <th style={{ ...th, textAlign: 'right', width: 48, color: '#6366f1' }}
                  title="Projected rush-attempt share on NFL team (RB)">Rush%</th>
              <th style={{ ...th, textAlign: 'center', width: 24 }}></th>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((r, i) => {
              const modelTierDef = MODEL_TIER_MAP[r.modelTier];
              return (
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
                  <td style={{ ...td, fontWeight: 600 }}><PlayerName name={r.name} position={r.pos} /></td>
                  <td style={{ ...td, textAlign: 'center' }}>
                    <span className={`pos-badge pos-${r.pos}`} style={{ fontSize: 10 }}>{r.pos || '—'}</span>
                  </td>
                  <td style={{ ...td, color: 'var(--text-secondary)' }}>{r.school || '—'}</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: r.grade > 0 ? gradeColor(r.grade) : 'var(--text-muted)' }}>
                    {r.grade > 0 ? r.grade : '—'}
                  </td>
                  <td style={{ ...td, color: r.projRound === 1 ? '#22c55e' : r.projRound === 2 ? '#a3e635' : 'var(--text-secondary)' }}>
                    {r.projRound > 0
                      ? `Rd ${r.projRound}${r.projPick > 0 ? ` #${r.projPick}` : ''}`
                      : '—'}
                  </td>
                  <td style={{
                    ...td,
                    color: r.actualDraftRound === 1 ? '#22c55e'
                         : r.actualDraftRound === 2 ? '#a3e635'
                         : r.actualDraftRound > 0 ? 'var(--text-primary)' : 'var(--text-muted)',
                    fontWeight: r.actualDraftRound > 0 ? 600 : 400,
                  }}>
                    {r.actualDraftRound > 0 ? (
                      <>
                        Rd {r.actualDraftRound}
                        {r.actualDraftPick > 0 ? ` #${r.actualDraftPick}` : ''}
                        {r.projPick > 0 && r.actualDraftPick > 0 && (() => {
                          const delta = r.actualDraftPick - r.projPick;
                          if (delta === 0) return null;
                          const sign = delta > 0 ? '+' : '';
                          // Drafted earlier than projected = good (negative delta).
                          const color = delta < 0 ? '#22c55e' : '#fb923c';
                          return (
                            <span
                              style={{ marginLeft: 6, fontSize: 10, color, fontWeight: 600 }}
                              title="Actual pick − projected pick (negative = drafted earlier than projected)"
                            >
                              Δ {sign}{delta}
                            </span>
                          );
                        })()}
                      </>
                    ) : '—'}
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: r.rookieEcr < 999 ? ecrTierColor(r.rookieEcr) : 'var(--text-muted)' }}>
                    {r.rookieEcr < 999 ? r.rookieEcr.toFixed(1) : '—'}
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: r.dynastyValue > 0 ? valueColor(r.dynastyValue) : 'var(--text-muted)' }}>
                    {r.dynastyValue > 0 ? r.dynastyValue.toLocaleString() : '—'}
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>
                    {r.predictedCareerPPG > 0 ? r.predictedCareerPPG.toFixed(1) : '—'}
                  </td>
                  <td style={{
                    ...td, textAlign: 'right', fontWeight: 600,
                    color: r.percentile >= 95 ? '#22c55e'
                         : r.percentile >= 85 ? '#4ade80'
                         : r.percentile >= 70 ? '#a3e635'
                         : r.percentile >= 50 ? '#facc15'
                         : r.percentile >= 25 ? '#fb923c'
                         : r.percentile > 0 ? '#ef4444' : 'var(--text-muted)',
                  }}>
                    {r.percentile > 0 ? r.percentile : '—'}
                  </td>
                  <td style={{ ...td }}>
                    {modelTierDef ? (
                      <strong style={{ color: modelTierDef.color, fontSize: 11, whiteSpace: 'nowrap' }}>
                        {modelTierDef.label}
                      </strong>
                    ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                  </td>
                  <td style={{
                    ...td, textAlign: 'right', fontSize: 11, fontWeight: 600,
                    color: r.boomZ != null && r.boomZ >= 1 ? '#22c55e' : r.boomZ != null && r.boomZ >= 0.3 ? '#a3e635' : r.boomZ != null && r.boomZ <= -0.5 ? '#fb923c' : 'var(--text-muted)',
                  }}>
                    {r.boomZ != null ? (r.boomZ >= 0 ? `+${r.boomZ.toFixed(2)}` : r.boomZ.toFixed(2)) : '—'}
                  </td>
                  <td style={{
                    ...td, textAlign: 'right', fontSize: 11, fontWeight: 600,
                    color: r.bustZ != null && r.bustZ >= 1 ? '#ef4444' : r.bustZ != null && r.bustZ >= 0.3 ? '#fb923c' : r.bustZ != null && r.bustZ <= -0.5 ? '#22c55e' : 'var(--text-muted)',
                  }}>
                    {r.bustZ != null ? (r.bustZ >= 0 ? `+${r.bustZ.toFixed(2)}` : r.bustZ.toFixed(2)) : '—'}
                  </td>
                  <td style={{
                    ...td, textAlign: 'center', borderLeft: '1px solid var(--border)',
                    fontWeight: 700, color: r.hasNflTeam ? '#6366f1' : 'var(--text-muted)',
                  }}>
                    {r.hasNflTeam ? r.nflTeam : '—'}
                  </td>
                  <td style={{
                    ...td, textAlign: 'right', fontWeight: 700,
                    color: r.projPPG > 0 ? 'var(--text-primary)' : 'var(--text-muted)',
                  }}>
                    {r.projPPG > 0 ? r.projPPG.toFixed(1) : '—'}
                  </td>
                  <td style={{ ...td, textAlign: 'right', color: 'var(--text-secondary)' }}>
                    {r.projTgtShare > 0 ? pct(r.projTgtShare) : '—'}
                  </td>
                  <td style={{ ...td, textAlign: 'right', color: 'var(--text-secondary)' }}>
                    {r.projRushShare > 0 ? pct(r.projRushShare) : '—'}
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
              );
            })}
          </tbody>
        </table>
      </div>

      {displayRows.length === 0 && (
        <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
          No prospects match your filters.
        </div>
      )}
    </div>
  );
}
