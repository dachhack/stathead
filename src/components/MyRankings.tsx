import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { fetchFfcADP } from '../data';
import { applyScenario, isScenarioEmpty, loadAllScenarios } from '../lib/scenarioEngine';
import { SCENARIO_PRESETS, type PresetMeta, type PlayerMeta } from '../lib/scenarioPresets';
import { buildSyntheticSdio } from '../lib/draftKit';
import { normName, positionStats, zScore } from '../lib/nameUtils';
import { blendPicks, fetchFfcRaw, recencyWeight, sampleWeight } from '../lib/adpSources';
import { applyScenarioToProjections, loadProjectionBase, type ProjectionBase } from '../lib/projectionsTabEngine';
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

// FantasyCalc redraft snapshot — daily-refreshed consensus. Covers current
// rookies and deep vets that FFC's offseason ADP misses, plus team and
// age / years-of-experience for the preset metadata.
interface FcRedraftEntry {
  player: {
    name: string;
    position: string;
    maybeTeam?: string | null;
    maybeAge?: number | null;
    maybeYoe?: number | null;
  };
  overallRank: number;
}

// score-store/career.json — career-model scores; draftSeason identifies the
// current rookie class for the rookie/vet presets.
interface CareerScoreEntry {
  name: string;
  position: string;
  draftSeason: number;
}

// depth-order-2026.json — model depth-chart ordering; the widest local
// player→team mapping (covers deep depth pieces no ADP source ranks).
interface DepthOrderEntry {
  name: string;
  team: string;
  pos: string;
}

// sleeper-adp-<season>.json — Sleeper market ADP snapshot (CI-fetched daily
// by fetch-sleeper-players.yml). Real draft-room ADP that covers rookies and
// deep vets long before FFC's offseason ADP fills out.
interface SleeperAdpEntry {
  name: string;
  position: string;
  team?: string;
  adp_ppr?: number;
  adp_half_ppr?: number;
  adp_std?: number;
}

interface SleeperAdpDoc {
  fetchedAt?: string;
  players?: SleeperAdpEntry[];
}

// One scenario-adjusted row from the Projections tab's own engine — the
// exact values the scenario tool displays for the active scenario.
interface ToolProjEntry {
  position: string;
  team: string;
  games: number;
  pprPts: number;
  rec: number;
  tgt: number;
  rushAtt: number;
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
const CURRENT_SEASON = 2026;

// Non-clay quick presets offered here (clay-blend presets would no-op without Clay).
const MR_PRESET_IDS = new Set(['preset-rookie-optimistic', 'preset-vet-optimistic', 'preset-injury-skeptic', 'preset-vegas-weighted']);

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
  const [adpScores, setAdpScores] = useState<ADPScoreEntry[]>([]);
  const [ppgScores, setPpgScores] = useState<PPGScoreEntry[]>([]);
  const [shareScores, setShareScores] = useState<ShareScoreEntry[]>([]);
  const [priorStats, setPriorStats] = useState<Record<string, PriorStatsEntry>>({});
  const [competition, setCompetition] = useState<Record<string, CompetitionEntry>>({});
  const [fcRedraft, setFcRedraft] = useState<FcRedraftEntry[]>([]);
  const [careerScores, setCareerScores] = useState<CareerScoreEntry[]>([]);
  const [depthOrder, setDepthOrder] = useState<DepthOrderEntry[]>([]);
  const [sleeperAdp, setSleeperAdp] = useState<SleeperAdpEntry[]>([]);
  // Source freshness for ADP weighting: Sleeper snapshot fetch date and the
  // FFC file's draft-window end date + per-player sample sizes.
  const [sleeperFetchedAt, setSleeperFetchedAt] = useState<string | undefined>(undefined);
  const [ffcEndDate, setFfcEndDate] = useState<string | undefined>(undefined);
  const [ffcSampleByName, setFfcSampleByName] = useState<Map<string, number>>(new Map());

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
  // The Projections tab's computed base pool (cached on every load of that
  // tab) — lets this page run the tab's own scenario engine for exact parity.
  const [projBase, setProjBase] = useState<ProjectionBase | null>(null);
  // League scoring format — re-scores PPG from the projected stat line.
  const [scoringFormat, setScoringFormat] = useState<'ppr' | 'half' | 'standard'>('ppr');

  const dragIdx = useRef<number | null>(null);
  const dragOverIdx = useRef<number | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`${BASE}data/redraft-projections.json`).then(r => r.json()).catch(() => ({ players: [] })),
      fetchFfcADP(2026, 'ppr').catch(() => [] as FfcADPPlayer[]),
      fetch(`${BASE}data/score-store/adp.json`).then(r => r.json()).catch(() => []),
      fetch(`${BASE}data/score-store/ppg.json`).then(r => r.json()).catch(() => []),
      fetch(`${BASE}data/score-store/shares.json`).then(r => r.json()).catch(() => []),
      fetch(`${BASE}data/feature-store/priorStats.json`).then(r => r.json()).catch(() => ({})),
      fetch(`${BASE}data/feature-store/competition.json`).then(r => r.json()).catch(() => ({})),
      // Fallback source — if score-store shards are empty, hydrate from the monolithic matrix.
      fetch(`${BASE}data/feature-matrix.json`).then(r => r.json()).catch(() => null),
      // FFC's offseason ADP is thin (~170 players) and adp.json only covers the
      // model pool, so teams/ADP need deeper local fallbacks: FantasyCalc
      // redraft (team + rank + age/yoe, rookie-inclusive) and the depth-chart
      // ordering (widest player→team map).
      fetch(`${BASE}data/fantasycalc_redraft_1qb.json`)
        .then(r => (r.ok ? r.json() : []))
        .then(d => (Array.isArray(d) ? d : []) as FcRedraftEntry[])
        .catch(() => [] as FcRedraftEntry[]),
      fetch(`${BASE}data/score-store/career.json`)
        .then(r => (r.ok ? r.json() : []))
        .then(d => (Array.isArray(d) ? d : []) as CareerScoreEntry[])
        .catch(() => [] as CareerScoreEntry[]),
      fetch(`${BASE}data/depth-order-${CURRENT_SEASON}.json`)
        .then(r => (r.ok ? r.json() : null))
        .then(d => (Array.isArray(d?.players) ? d.players : []) as DepthOrderEntry[])
        .catch(() => [] as DepthOrderEntry[]),
      fetch(`${BASE}data/sleeper-adp-${CURRENT_SEASON}.json`)
        .then(r => (r.ok ? r.json() : null))
        .then(d => (d ?? {}) as SleeperAdpDoc)
        .catch(() => ({} as SleeperAdpDoc)),
      fetchFfcRaw(CURRENT_SEASON),
    ]).then(([rdData, ffcData, adpData, ppgData, shareData, priorData, compData, featureMatrix, fcData, careerData, depthData, sleeperDoc, ffcRaw]) => {
      setRedraft(rdData.players ?? []);
      setFfc(ffcData);

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
      setFcRedraft(fcData);
      setCareerScores(careerData);
      setDepthOrder(depthData);
      setSleeperAdp(Array.isArray(sleeperDoc?.players) ? sleeperDoc.players : []);
      setSleeperFetchedAt(sleeperDoc?.fetchedAt);
      setFfcEndDate(ffcRaw?.meta?.end_date);
      {
        const m = new Map<string, number>();
        for (const p of ffcRaw?.players ?? []) {
          if (p?.name && p.times_drafted !== undefined) m.set(normName(p.name), Number(p.times_drafted));
        }
        setFfcSampleByName(m);
      }
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setSavedList(JSON.parse(raw));
    } catch { /* ignore */ }
    setSavedScenarios(loadAllScenarios());
    setProjBase(loadProjectionBase(CURRENT_SEASON));
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

  const fcByName = useMemo(() => {
    const m = new Map<string, { team: string; rank: number; age: number | null; yoe: number | null }>();
    for (const v of fcRedraft) {
      const p = v?.player;
      if (!p?.name) continue;
      m.set(normName(p.name), {
        team: p.maybeTeam ?? '',
        rank: v.overallRank,
        age: Number.isFinite(p.maybeAge as number) ? (p.maybeAge as number) : null,
        yoe: Number.isFinite(p.maybeYoe as number) ? (p.maybeYoe as number) : null,
      });
    }
    return m;
  }, [fcRedraft]);

  const depthTeamByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of depthOrder) {
      if (p?.name && p.team) m.set(`${normName(p.name)}|${p.pos}`, p.team);
    }
    return m;
  }, [depthOrder]);

  const sleeperByName = useMemo(() => {
    const m = new Map<string, SleeperAdpEntry>();
    for (const p of sleeperAdp) {
      if (p?.name) m.set(normName(p.name), p);
    }
    return m;
  }, [sleeperAdp]);

  // Current rookie class from the career model — adp.json's isRookie flag
  // only covers the model pool, so it can't identify the rookie class for
  // the rookie/vet presets on its own.
  const rookieNames = useMemo(() => {
    const s = new Set<string>();
    for (const c of careerScores) {
      if (c.draftSeason === CURRENT_SEASON) s.add(normName(c.name));
    }
    return s;
  }, [careerScores]);

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

  // Rookie/availability metadata for quick presets, spanning the whole
  // projection pool: rookie flag from the career model class (plus the ADP
  // model rows), age / years-of-experience from FantasyCalc, and
  // prior-season games from the feature store (injury skeptic risk tiers).
  const presetMeta = useMemo(() => {
    const m: PresetMeta = new Map<string, PlayerMeta>();
    for (const p of redraft) {
      const nn = normName(p.name);
      const fc = fcByName.get(nn);
      const isRookie = rookieNames.has(nn) || (adpScoreByName.get(nn)?.isRookie ?? false);
      m.set(nn, {
        isRookie,
        yearsExp: isRookie ? 0 : fc?.yoe ?? null,
        age: fc?.age ?? null,
        priorGames: priorByName.get(nn)?.priorGames ?? null,
      });
    }
    return m;
  }, [redraft, fcByName, rookieNames, adpScoreByName, priorByName]);

  // Team resolution, widest-coverage chain: FFC ADP → ADP model pool →
  // FantasyCalc redraft → Sleeper ADP → model depth-chart ordering. Team
  // coverage matters beyond display — scenario team levers (tendencies/
  // volumes) and the Tgt%/Rush% team totals only reach players with a
  // resolved team.
  const resolveTeam = useCallback((nn: string, position: string): string => {
    return ffcByName.get(nn)?.team
      || adpScoreByName.get(nn)?.team
      || fcByName.get(nn)?.team
      || sleeperByName.get(nn)?.team
      || depthTeamByKey.get(`${nn}|${position}`)
      || '';
  }, [ffcByName, adpScoreByName, fcByName, sleeperByName, depthTeamByKey]);

  // Scenario pool: synthetic SDIO-shaped rows decomposed from the validated
  // model projections (redraft-projections.json — the same Consensus base the
  // Projections tab's scenario engine runs on), so scenario adjustments and
  // the scoring selector move the same numbers the page already shows.
  const projPool = useMemo(
    () => buildSyntheticSdio(redraft.map((p) => ({
      name: p.name,
      position: p.position,
      ppg: p.ppg,
      recPG: p.recPG,
      team: resolveTeam(normName(p.name), p.position),
    }))),
    [redraft, resolveTeam],
  );

  // Resolve active scenario: a selected quick preset or saved scenario overrides
  // the prop scenario. Clay-blend presets are excluded (handled via MR_PRESET_IDS).
  const activeScenario = useMemo(() => {
    if (selectedScenarioId.startsWith('preset-')) {
      const preset = SCENARIO_PRESETS.find(p => p.id === selectedScenarioId);
      if (preset && projPool.length) return preset.build(projPool, presetMeta, normName, {});
    } else if (selectedScenarioId) {
      const found = savedScenarios.find(s => s.id === selectedScenarioId);
      if (found) return found;
    }
    return scenario;
  }, [selectedScenarioId, savedScenarios, scenario, projPool, presetMeta]);

  // Apply scenario to the projection pool
  const scenarioSdio = useMemo(() => {
    if (!projPool.length || isScenarioEmpty(activeScenario)) return projPool;
    return applyScenario(projPool, activeScenario);
  }, [projPool, activeScenario]);

  const sdioByName = useMemo(() => {
    const m = new Map<string, SDIOProjection>();
    for (const p of scenarioSdio) m.set(normName(p.Name), p);
    return m;
  }, [scenarioSdio]);

  // Pre-scenario synthetic lines — the baseline the scenario delta is
  // measured against, so scenario PPG can be applied as a relative move on
  // top of whichever base PPG the row displays.
  const basePoolByName = useMemo(() => {
    const m = new Map<string, SDIOProjection>();
    for (const p of projPool) m.set(normName(p.Name), p);
    return m;
  }, [projPool]);

  // Exact scenario values: when the Projections tab's base pool is cached,
  // run the tab's OWN scenario engine over the tab's OWN base, so a selected
  // scenario shows the exact numbers the scenario tool shows. The synthetic
  // pool above remains the fallback for players (or whole sessions) the
  // cache doesn't cover.
  const toolAdjusted = useMemo(() => {
    if (!projBase || isScenarioEmpty(activeScenario)) return null;
    return applyScenarioToProjections(projBase.qbs, projBase.rbs, projBase.wrs, projBase.tes, activeScenario);
  }, [projBase, activeScenario]);

  const toolByName = useMemo(() => {
    const m = new Map<string, ToolProjEntry>();
    if (!toolAdjusted) return m;
    const add = (arr: Array<{ name: string; team: string; games: number; pprPts: number }>, position: string) => {
      for (const p of arr) {
        // Scenario-injected custom/FA rows ("★ Name") have no rankings row.
        if (p.name.startsWith('★')) continue;
        const o = p as unknown as Record<string, number>;
        m.set(normName(p.name), {
          position,
          team: p.team,
          games: p.games,
          pprPts: p.pprPts,
          rec: o.rec || 0,
          tgt: o.tgt || 0,
          rushAtt: o.rushAtt || 0,
        });
      }
    };
    add(toolAdjusted.qbs, 'QB');
    add(toolAdjusted.rbs, 'RB');
    add(toolAdjusted.wrs, 'WR');
    add(toolAdjusted.tes, 'TE');
    return m;
  }, [toolAdjusted]);

  // Team totals over the tool-adjusted pool, for exact Tgt%/Rush%.
  const toolTeamTotals = useMemo(() => {
    const m = new Map<string, { rushAtt: number; tgt: number }>();
    for (const e of toolByName.values()) {
      if (!e.team) continue;
      const t = m.get(e.team) ?? { rushAtt: 0, tgt: 0 };
      if (e.position === 'RB') t.rushAtt += e.rushAtt;
      if (e.position !== 'QB') t.tgt += e.tgt;
      m.set(e.team, t);
    }
    return m;
  }, [toolByName]);

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

    const sleeperAdpFor = (nn: string): number | undefined => {
      const s = sleeperByName.get(nn);
      return s?.adp_ppr ?? s?.adp_half_ppr ?? s?.adp_std;
    };
    // Source weights: sample size × recency. FFC's "year N" endpoint can
    // serve months-old mocks between seasons, so its weight decays with
    // the file's draft-window age; Sleeper publishes no counts (huge
    // platform) so its weight is snapshot recency only.
    const ffcFileW = recencyWeight(ffcEndDate);
    const sleeperW = recencyWeight(sleeperFetchedAt);

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
      const scenarioActive = !isScenarioEmpty(activeScenario);
      const toolEntry = scenarioActive ? toolByName.get(nn) : undefined;
      const toolP = toolEntry && toolEntry.position === position && toolEntry.games > 0 ? toolEntry : undefined;
      if (toolP) {
        // Exact value from the Projections tab under this scenario — the
        // same round(pprPts / games, 1) its PPG column shows. Half/Standard
        // re-scored from the tab's real receptions.
        let pts = toolP.pprPts;
        if (scoringFormat === 'half') pts -= 0.5 * toolP.rec;
        else if (scoringFormat === 'standard') pts -= toolP.rec;
        ppg = Math.max(0, Math.round((pts / toolP.games) * 10) / 10);
      } else {
        // Fallback (no cached Projections-tab base, or player outside its
        // pool): scenario and league-scoring adjustments applied RELATIVE
        // to the synthetic stat line, so untouched players keep their base
        // PPG instead of jumping to a different decomposition's numbers.
        const baseP = basePoolByName.get(nn);
        if (sdioP && baseP) {
          if (scenarioActive) {
            const basePts = baseP.FantasyPointsPPR ?? 0;
            const scenPts = sdioP.FantasyPointsPPR ?? 0;
            if (basePts > 0) ppg *= scenPts / basePts;
          }
          if (scoringFormat !== 'ppr') {
            // Receptions in the synthetic line are real (recPG-based), so
            // subtracting reception points per game re-scores exactly.
            const recPG = (sdioP.Receptions || 0) / GAMES;
            ppg -= (scoringFormat === 'half' ? 0.5 : 1) * recPG;
          }
          ppg = Math.max(0, Math.round(ppg * 10) / 10);
        }
      }

      // With exact tool values, the tab's team wins (it reflects scenario
      // player movements); otherwise the widest-coverage local chain.
      const resolvedTeam = toolP?.team || ffcP?.team || adpS?.team || sdioP?.Team || resolveTeam(nn, position) || team;

      // CI bounds from the ADP model. The boom/bust *spreads* (raw numbers)
      // are computed here; the within-position z-score is applied in a
      // second pass once we have all rows, since z-score requires the
      // position cohort's mean+std.
      const vor = adpS?.predictedVor ?? 0;
      const ciLow = adpS?.ciLower ?? 0;
      const ciHigh = adpS?.ciUpper ?? 0;
      const ciSpreadUp = adpS ? Math.max(0, ciHigh - vor) : 0;
      const ciSpreadDown = adpS ? Math.max(0, vor - ciLow) : 0;

      // Projected shares: exact tool pool (scenario) > SDIO (scenario) >
      // share model predictions > prior year
      let projTgtShare = 0;
      let projRushShare = 0;
      if (toolP) {
        const tt = toolTeamTotals.get(toolP.team);
        if (tt) {
          if (position !== 'QB' && tt.tgt > 0) {
            projTgtShare = toolP.tgt / tt.tgt;
          }
          if (position === 'RB' && tt.rushAtt > 0) {
            projRushShare = toolP.rushAtt / tt.rushAtt;
          }
        }
      }
      if (!projTgtShare && !projRushShare && sdioP && resolvedTeam) {
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
        // Current market ADP: weighted blend of the real markets — the
        // FFC family (FFC ADP, else the FFC-derived model-pool ADP) and
        // Sleeper draft rooms. FantasyCalc overall rank only as a pick
        // proxy when no market prices the player.
        adp: (() => {
          const ffcAdp = ffcP?.adp ?? adpS?.adp;
          const slAdp = sleeperAdpFor(nn);
          return blendPicks(
            ffcAdp !== undefined ? { adp: ffcAdp, weight: sampleWeight(ffcSampleByName.get(nn)) * ffcFileW } : undefined,
            slAdp !== undefined ? { adp: slAdp, weight: sleeperW } : undefined,
          ) ?? fcByName.get(nn)?.rank ?? 999;
        })(),
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
  }, [redraft, ffc, ffcByName, adpScoreByName, ppgScoreByName, shareScoreByName, sdioByName, basePoolByName, toolByName, toolTeamTotals, fcByName, sleeperByName, ffcSampleByName, ffcEndDate, sleeperFetchedAt, resolveTeam, priorByName, compByName, teamTotals, activeScenario, scoringFormat]);

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
              <th style={{ ...th, textAlign: 'right', width: 44 }} title={`Projected points per game (${scoringFormat === 'ppr' ? 'PPR' : scoringFormat === 'half' ? 'Half-PPR' : 'Standard'}). With a scenario active, exact Projections-tab values for that scenario.`}>PPG</th>
              <th style={{ ...th, textAlign: 'right', width: 44 }} title="Current market redraft ADP — weighted blend of FFC and Sleeper draft rooms (weights = sample size × recency); FantasyCalc rank as a pick proxy when no market lists the player">ADP</th>
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
