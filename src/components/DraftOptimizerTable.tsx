import { useState, useEffect, useMemo } from 'react';
import { normName } from '../lib/nameUtils';
import { loadScoreManifest } from '../lib/modelScoreClient';
import type { AdpCurve } from '../lib/modelScoreStore';
import { DraftPrepSettings as SettingsHeader } from './DraftPrepSettings';
import type { DraftPrepSettings } from '../lib/draftPrepSettings';
import { loadSettings } from '../lib/draftPrepSettings';
import { userPickNumbers, maxSurvival, bandIdFor } from '../lib/snakeDraft';
import type { ScenarioConfig, SDIOProjection } from '../types';
import { applyScenario, isScenarioEmpty, loadAllScenarios } from '../lib/scenarioEngine';
import { fetchSDIOSeasonProjections, hasSDIOKey } from '../lib/sportsDataIO';
import {
  type EdgeBoardRow,
  verdictFor, VERDICT_STYLE, pickEdgeColor, pBeatColor, fmtEdge, fmtPct,
} from '../lib/edgeBoardRow';
import { DraftRoundPlan } from './DraftRoundPlan';
import { DraftTierMap } from './DraftTierMap';
import { DraftTargetsFades } from './DraftTargetsFades';
import { DraftValueBoard } from './DraftValueBoard';
import { DraftRosterSim } from './DraftRosterSim';
import { DraftRookieVetEdges } from './DraftRookieVetEdges';
import { PlayerName } from './PlayerName';
import type { KitPlayer } from '../lib/draftKit';
import { buildKitPool, kitKey } from '../lib/draftKit';

// Edge Board for the draft prep tool. Backed by the model score-store and
// the user's saved league settings.
//
// Three signals per row, each with a clean definition:
//
//  Pick Edge   = predictedPPG (ADP-free model) − (intercept + slope·√ADP
//                + poolOffset). Positive = model thinks the player
//                out-earns what someone at this ADP slot typically delivers
//                in the curated 2026 pool.
//
//  Beat %      = P(actual season PPG > baseline), Gaussian approximation
//                with μ = predictedPPG, σ from the 10/90 quantile bounds.
//                Real probability, not a categorical label.
//
//  Upside / Downside (PPG) = ciUpper − predictedVor and predictedVor −
//                ciLower. Raw PPG range. Size of the model's belief band,
//                NOT a probability of booming or busting.
//
// Plus two prep-specific columns:
//
//  Target Share %ile = within-position percentile of `predTargetShare`
//                from score-store/shares.json. RB/WR have R²≈0.30 LOSO
//                — useful color. TE has R²≈0.12 — shown with low-conf
//                styling.
//
//  Verdict     = Strong Target / Target / Fair / Fade / Strong Fade.
//                Per-position thresholds derived from the live PickEdge
//                σ within position, combined with Beat %. See verdictFor().

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

interface ShareScoreEntry {
  name: string;
  position: string;
  predTargetShare: number;
  predRushShare: number;
}

interface FfcAdpEntry {
  name: string;
  position: string;
  team?: string;
  adp: number;
  stdev: number;
}

interface RedraftProjEntry {
  name: string;
  position: string;
  ppg: number;
  recPG?: number;
}

// FantasyCalc redraft snapshot — daily-refreshed consensus. Covers
// current rookies (which FFC's offseason ADP and the score-store pool
// don't), plus age / years-of-experience for the vet-edge logic.
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

// score-store/career.json — rookie career-model scores. Used by the
// Rookie & Veteran Edges section for boom/startable probabilities.
interface CareerScoreEntry {
  name: string;
  position: string;
  draftSeason: number;
  predictedPPG: number;
  percentile: number;
  tierLabel: string;
  boomProb: number;
  bustProb: number;
  thresholdProbs: Record<string, number>;
}

// Saved custom boards from the My Rankings tab (localStorage). `order`
// holds `${normName}:${pos}` ids in the user's preferred draft order.
interface SavedRankingBoard {
  id: string;
  name: string;
  savedAt: string;
  order: string[];
}

const MY_RANKINGS_KEY = 'stathead-my-rankings';
const CURRENT_SEASON = 2026;

function loadSavedBoards(): SavedRankingBoard[] {
  try {
    const raw = localStorage.getItem(MY_RANKINGS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Row + verdict types live in lib/edgeBoardRow.ts so multiple sections
// (Edge Board, Round Plan, future Tier Map / Targets & Fades) can share
// the same shape without circular imports. The local alias keeps
// existing call sites short.
type Row = EdgeBoardRow;

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'] as const;
type PosFilter = typeof POSITIONS[number];

// ADP bands by round in user's league. Round cutoffs are universal; band
// edges scale by numTeams, so R1-3 in 12-team = 1-36, in 10-team = 1-30.
const ADP_BANDS = [
  { id: 'ALL', label: 'All' },
  { id: 'R1-3', label: 'R1–3', maxRound: 3 },
  { id: 'R4-6', label: 'R4–6', minRound: 4, maxRound: 6 },
  { id: 'R7-10', label: 'R7–10', minRound: 7, maxRound: 10 },
  { id: 'R11+', label: 'R11+', minRound: 11 },
] as const;
type AdpBandId = typeof ADP_BANDS[number]['id'];

type SortKey = 'adp' | 'pickEdge' | 'modelPPG' | 'projPPG' | 'pBeat' | 'upsidePPG' | 'downsidePPG' | 'targetSharePctile' | 'name';

const BASE = import.meta.env.BASE_URL;

// 80% CI = ±1.2816σ. q90 − q10 = 2 × 1.2816σ → σ = (q90 − q10) / 2.5631.
const TWO_Z_90 = 2 * 1.2815515655446004;

/** Abramowitz & Stegun 26.2.17 normal CDF, accurate to ~7.5e-8. */
function normCdf(z: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/**
 * P(actual > baseline) under a Gaussian approximation. We anchor μ on the
 * ADP-free model's `predictedPPG` (same input PickEdge uses) and borrow σ
 * from the ADP-aware quantile bounds: σ = (ciUpper − ciLower) / 2.5631.
 *
 * Why mix models: PickEdge and Beat % must agree at the boundary
 * (Edge=0 ↔ Beat=50%). The CI midpoint is the ADP-aware model's center,
 * which can differ from the ADP-free PPG by several PPG (the two models
 * disagree about how much ADP-as-a-feature should pull predictions toward
 * the curve). Using ADP-aware σ as a proxy for the ADP-free model's σ is
 * a heuristic — both predict the same outcome so their uncertainty is
 * roughly comparable. Out-of-sample CI calibration is not yet validated
 * (in-sample 80% coverage = 79–83% per position, on target).
 *
 * Returns NaN when bounds are degenerate or required inputs are missing.
 */
function probBeatBaseline(
  centerPPG: number,
  ciLower: number,
  ciUpper: number,
  baseline: number,
): number {
  if (!Number.isFinite(centerPPG) || !Number.isFinite(ciLower) || !Number.isFinite(ciUpper) || !Number.isFinite(baseline)) return NaN;
  const width = ciUpper - ciLower;
  if (width <= 0.5) return NaN; // degenerate / fallback ±0.5 — no real distribution to integrate.
  const sigma = width / TWO_Z_90;
  return 1 - normCdf((baseline - centerPPG) / sigma);
}

function fmtRange(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '—';
  return v.toFixed(1);
}

function upsideColor(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return 'var(--text-muted)';
  if (v >= 7) return '#22c55e';
  if (v >= 4) return '#86efac';
  if (v >= 2) return '#a3e635';
  return 'var(--text-muted)';
}

function downsideColor(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return 'var(--text-muted)';
  if (v >= 7) return '#ef4444';
  if (v >= 4) return '#fca5a5';
  if (v >= 2) return '#fb923c';
  return 'var(--text-muted)';
}

function tsharePctileColor(p: number): string {
  if (!Number.isFinite(p)) return 'var(--text-muted)';
  if (p >= 80) return '#22c55e';
  if (p >= 60) return '#86efac';
  if (p >= 40) return 'var(--text-primary)';
  if (p >= 20) return '#fb923c';
  return '#ef4444';
}


// Scenario-independent inputs per player. The `enrichedRows` useMemo
// derives PPG / baseline / PickEdge / Beat % from these plus the active
// scenario, so flipping scenarios doesn't require a refetch.
interface RawRow {
  name: string;
  position: string;
  team: string;
  adp: number;
  stdev: number;
  basePpg: number;     // ADP-free model PPG (score-store/ppg.json)
  baseProjPpg: number; // Base projection PPG (redraft-projections.json) — pre-scenario
  ciLower: number;     // ADP-aware quantile bounds (unaffected by scenario)
  ciUpper: number;
  ciCenter: number;    // predictedVor — center of the CI
  rawTargetShare: number;
  isRookie: boolean;
}

export function DraftOptimizerTable() {
  const [settings, setSettings] = useState<DraftPrepSettings>(() => loadSettings());
  const [rawRows, setRawRows] = useState<RawRow[]>([]);
  const [curves, setCurves] = useState<Record<string, AdpCurve>>({});
  const [sdio, setSdio] = useState<SDIOProjection[]>([]);
  const [scenarios, setScenarios] = useState<ScenarioConfig[]>([]);
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>('');
  // Wide-pool inputs for the VBD sections (Value Board / Team Builder /
  // Rookie & Vet Edges). The Edge Board's score-store pool is model-only
  // (153 vets, no rookies); these sections need full projection depth.
  const [redraftEntries, setRedraftEntries] = useState<RedraftProjEntry[]>([]);
  const [ffcEntries, setFfcEntries] = useState<FfcAdpEntry[]>([]);
  const [fcRedraft, setFcRedraft] = useState<FcRedraftEntry[]>([]);
  const [careerScores, setCareerScores] = useState<CareerScoreEntry[]>([]);
  const [savedBoards, setSavedBoards] = useState<SavedRankingBoard[]>([]);
  const [selectedBoardId, setSelectedBoardId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [posFilter, setPosFilter] = useState<PosFilter>('ALL');
  const [adpBand, setAdpBand] = useState<AdpBandId>('ALL');
  const [myPicksOnly, setMyPicksOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('pickEdge');
  const [sortAsc, setSortAsc] = useState(false);

  // User's pick numbers across the first 12 rounds — feeds the my-picks
  // filter and the survival-best column. Rebuilt whenever the user
  // tweaks league size, slot, or draft type.
  const myPicks = useMemo(
    () => userPickNumbers(12, settings.pickSlot, settings.numTeams, settings.draftType),
    [settings.pickSlot, settings.numTeams, settings.draftType],
  );

  // Saved scenarios live in localStorage. Loaded on mount; refreshed
  // whenever the user re-enters the tab (focus event) so a scenario
  // saved on the Projections page shows up here without a hard reload.
  useEffect(() => {
    setScenarios(loadAllScenarios());
    setSavedBoards(loadSavedBoards());
    const onFocus = () => {
      setScenarios(loadAllScenarios());
      setSavedBoards(loadSavedBoards());
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetch(`${BASE}data/score-store/adp.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch(`${BASE}data/score-store/ppg.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch(`${BASE}data/score-store/shares.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      // FFC dump shapes vary by year — 2025 is a bare array, 2026 wraps
      // in `{ players: [...] }`. Normalize to an array on read.
      fetch(`${BASE}data/ffc_adp_ppr_2026.json`)
        .then((r) => (r.ok ? r.json() : { players: [] }))
        .then((d) => Array.isArray(d) ? d : (d?.players ?? []))
        .catch(() => []),
      loadScoreManifest(),
      // SDIO projections power scenario PPG. Skipped (empty array)
      // when no API key is configured; scenarios still apply on top of
      // an empty SDIO array as a no-op, so the dropdown stays usable
      // even if the user hasn't configured SDIO.
      hasSDIOKey() ? fetchSDIOSeasonProjections(2026).catch(() => []) : Promise.resolve([]),
      // Base projections — the same redraft-projections.json the
      // Projections tab reads. Always available (no API key needed),
      // 320 players with `ppg`. Drives the Proj column when no
      // scenario is active; scenarios override on top of these.
      fetch(`${BASE}data/redraft-projections.json`)
        .then((r) => (r.ok ? r.json() : { players: [] }))
        .then((d) => (Array.isArray(d) ? d : (d?.players ?? [])) as RedraftProjEntry[])
        .catch(() => [] as RedraftProjEntry[]),
      // FantasyCalc redraft consensus — rookie-inclusive rank + age/yoe.
      fetch(`${BASE}data/fantasycalc_redraft_1qb.json`)
        .then((r) => (r.ok ? r.json() : []))
        .then((d) => (Array.isArray(d) ? d : []) as FcRedraftEntry[])
        .catch(() => [] as FcRedraftEntry[]),
      // Career model scores — rookie boom/startable probabilities.
      fetch(`${BASE}data/score-store/career.json`)
        .then((r) => (r.ok ? r.json() : []))
        .then((d) => (Array.isArray(d) ? d : []) as CareerScoreEntry[])
        .catch(() => [] as CareerScoreEntry[]),
    ]).then(([adpData, ppgData, shareData, ffcData, manifest, sdioData, redraftData, fcData, careerData]: [
      AdpScoreEntry[],
      PpgScoreEntry[],
      ShareScoreEntry[],
      FfcAdpEntry[],
      Awaited<ReturnType<typeof loadScoreManifest>>,
      SDIOProjection[],
      RedraftProjEntry[],
      FcRedraftEntry[],
      CareerScoreEntry[],
    ]) => {
      if (cancelled) return;
      setSdio(sdioData);
      setRedraftEntries(redraftData ?? []);
      setFfcEntries(ffcData ?? []);
      setFcRedraft(fcData ?? []);
      setCareerScores(careerData ?? []);
      if (!adpData?.length) {
        setError('Draft data not available yet — the build deploys every 2 hours.');
        setLoading(false);
        return;
      }

      // Base PPG from the score-store (the trained model's prediction).
      // Scenarios may override this in `enrichedRows` below.
      const basePpgByName = new Map<string, number>();
      for (const p of ppgData ?? []) {
        if (p?.name) basePpgByName.set(normName(p.name), Number(p.predictedPPG) || 0);
      }
      const shareByKey = new Map<string, number>();
      for (const s of shareData ?? []) {
        if (s?.name) shareByKey.set(`${normName(s.name)}::${s.position}`, Number(s.predTargetShare) || 0);
      }
      const stdevByKey = new Map<string, number>();
      for (const f of ffcData ?? []) {
        if (f?.name) stdevByKey.set(`${normName(f.name)}::${f.position}`, Number(f.stdev) || 0);
      }
      // Base projection PPG keyed by player name. Drives the Proj
      // column when no scenario is active; scenarios layer on top via
      // applyScenario() in the useMemo below.
      const baseProjByName = new Map<string, number>();
      for (const p of redraftData ?? []) {
        if (p?.name) baseProjByName.set(normName(p.name), Number(p.ppg) || 0);
      }
      const adpCurves = manifest?.adpCurves ?? {};

      // Raw rows hold only scenario-independent fields. PPG, baseline,
      // PickEdge, Beat % are derived in `enrichedRows` below so they
      // recompute on scenario change without refetching.
      const built: RawRow[] = adpData.map((a) => {
        const adp = Number(a.adp) || 999;
        const ciL = Number(a.ciLower);
        const ciU = Number(a.ciUpper);
        const center = Number(a.predictedVor);
        const stdev = stdevByKey.get(`${normName(a.name)}::${a.position}`) ?? 0;
        const rawTargetShare = shareByKey.get(`${normName(a.name)}::${a.position}`) ?? NaN;
        const basePpg = basePpgByName.get(normName(a.name)) ?? 0;
        const baseProjPpg = baseProjByName.get(normName(a.name)) ?? 0;
        return {
          name: a.name,
          position: a.position,
          team: a.team,
          adp,
          stdev,
          basePpg,
          baseProjPpg,
          ciLower: ciL,
          ciUpper: ciU,
          ciCenter: center,
          rawTargetShare,
          isRookie: !!a.isRookie,
        };
      });

      // The score-store pool is vets-only (no current rookie class).
      // Append synthetic rows for market-priced players it misses —
      // mostly rookies (FFC ADP or FantasyCalc redraft rank as the pick
      // proxy) — so the Edge Board, Round Plan, Tier Map, and Targets &
      // Fades see the whole draftable pool. These rows have no CI
      // bounds (Beat % / Upside / Downside show "—"); PickEdge runs on
      // the base projection vs the position's ADP curve.
      const inPool = new Set(adpData.map((a) => `${normName(a.name)}::${a.position}`));
      const rookieNames = new Set<string>();
      for (const c of careerData ?? []) {
        if (c.draftSeason === CURRENT_SEASON) rookieNames.add(normName(c.name));
      }
      const fcByKey = new Map<string, FcRedraftEntry>();
      for (const v of fcData ?? []) {
        if (v?.player?.name) fcByKey.set(`${normName(v.player.name)}::${v.player.position}`, v);
      }
      const ffcByKey = new Map<string, FfcAdpEntry>();
      for (const f of ffcData ?? []) {
        if (f?.name) ffcByKey.set(`${normName(f.name)}::${f.position}`, f);
      }
      for (const p of redraftData ?? []) {
        const key = `${normName(p.name)}::${p.position}`;
        if (inPool.has(key) || !['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
        const ppg = Number(p.ppg) || 0;
        if (ppg <= 0) continue;
        const ffc = ffcByKey.get(key);
        const fc = fcByKey.get(key);
        const adp = ffc?.adp ?? fc?.overallRank;
        if (adp === undefined || !Number.isFinite(adp)) continue; // no market price — not draft-relevant
        inPool.add(key);
        built.push({
          name: p.name,
          position: p.position,
          team: ffc?.team || fc?.player?.maybeTeam || '',
          adp,
          stdev: ffc?.stdev ?? 0,
          basePpg: basePpgByName.get(normName(p.name)) ?? 0,
          baseProjPpg: ppg,
          ciLower: NaN,
          ciUpper: NaN,
          ciCenter: NaN,
          rawTargetShare: NaN,
          isRookie: rookieNames.has(normName(p.name)),
        });
      }

      setRawRows(built);
      setCurves(adpCurves);
      setLoading(false);
    }).catch((e) => {
      if (!cancelled) {
        setError(e instanceof Error ? e.message : 'Failed to load draft data');
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  // Active scenario — user-selected from the saved-scenarios dropdown.
  // Falls back to "no scenario" when nothing is selected.
  const activeScenario = useMemo<ScenarioConfig | null>(() => {
    if (!selectedScenarioId) return null;
    return scenarios.find((s) => s.id === selectedScenarioId) ?? null;
  }, [selectedScenarioId, scenarios]);

  // Apply scenario to SDIO projections. When no scenario is active or
  // SDIO data isn't loaded, returns SDIO unchanged (so the
  // scenarioPpgByName map below is empty and the score-store base PPG
  // wins for every player).
  const scenarioSdio = useMemo<SDIOProjection[]>(() => {
    if (!sdio.length || !activeScenario || isScenarioEmpty(activeScenario)) return sdio;
    return applyScenario(sdio, activeScenario);
  }, [sdio, activeScenario]);

  // Scenario-derived PPG per player. SDIO `FantasyPointsPPR` is a season
  // total; divide by 17 to align with our per-game PPG convention.
  const scenarioPpgByName = useMemo<Map<string, number>>(() => {
    const m = new Map<string, number>();
    if (!activeScenario || isScenarioEmpty(activeScenario)) return m;
    for (const p of scenarioSdio) {
      const ppg = (p.FantasyPointsPPR ?? 0) / 17;
      if (ppg > 0 && p.Name) m.set(normName(p.Name), Math.round(ppg * 10) / 10);
    }
    return m;
  }, [scenarioSdio, activeScenario]);

  // Wide kit pool for the VBD sections. Spine = base projections (416
  // players incl. all rookies); scenario PPG overrides per player when a
  // scenario is active, so the Value Board / Team Builder / Edges all
  // respect the same projection assumptions as the Edge Board.
  const kitPool = useMemo<KitPlayer[]>(() => {
    if (redraftEntries.length === 0) return [];
    const rookieNames = new Set<string>();
    for (const c of careerScores) {
      if (c.draftSeason === CURRENT_SEASON) rookieNames.add(normName(c.name));
    }
    const projections = redraftEntries.map((p) => {
      const scen = scenarioPpgByName.get(normName(p.name));
      return scen !== undefined && scen > 0 ? { ...p, ppg: scen } : p;
    });
    const teams = new Map<string, string>();
    for (const r of rawRows) {
      if (r.team) teams.set(kitKey(r.name, r.position), r.team);
    }
    return buildKitPool({
      projections,
      ffc: ffcEntries,
      fcRedraft,
      modelPpg: rawRows.map((r) => ({ name: r.name, position: r.position, predictedPPG: r.basePpg })),
      rookieNames,
      teams,
      scoring: settings.scoring,
    });
  }, [redraftEntries, ffcEntries, fcRedraft, careerScores, rawRows, scenarioPpgByName, settings.scoring]);

  // Selected My Rankings board → kitKey → 1-based rank. Saved order ids
  // are `${normName}:${pos}` (see MyRankings.makeId); kitKey is
  // `${normName}::${pos}`.
  const myBoard = useMemo(
    () => savedBoards.find((b) => b.id === selectedBoardId) ?? null,
    [savedBoards, selectedBoardId],
  );
  const myRankByKey = useMemo(() => {
    const m = new Map<string, number>();
    if (!myBoard?.order) return m;
    myBoard.order.forEach((id, i) => {
      const sep = id.lastIndexOf(':');
      if (sep <= 0) return;
      m.set(`${id.slice(0, sep)}::${id.slice(sep + 1)}`, i + 1);
    });
    return m;
  }, [myBoard]);

  // Per-position target-share %ile lookup. Doesn't depend on scenario;
  // computed once over the raw share data.
  const tsharePctile = useMemo(() => {
    const sortedByPos = new Map<string, number[]>();
    for (const pos of ['RB', 'WR', 'TE']) {
      const vals = rawRows
        .filter((r) => r.position === pos && Number.isFinite(r.rawTargetShare) && r.rawTargetShare > 0)
        .map((r) => r.rawTargetShare)
        .sort((a, b) => a - b);
      if (vals.length >= 3) sortedByPos.set(pos, vals);
    }
    return (pos: string, share: number): number => {
      const sorted = sortedByPos.get(pos);
      if (!sorted || !Number.isFinite(share) || share <= 0) return NaN;
      let lo = 0, hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] <= share) lo = mid + 1; else hi = mid;
      }
      return Math.round((lo / sorted.length) * 100);
    };
  }, [rawRows]);

  // Derive everything that depends on scenario, settings, or live picks.
  // Verdict thresholds use per-(position × ADP band) stats — recentered
  // on each band's own mean and rescaled by its own σ. Without per-band
  // stratification, round-1 picks all cluster as Fade (curve baseline
  // is high) and round-11 picks all cluster as Strong Target. Verdict
  // reads as "best in your draft slot range" — Beat % is the absolute
  // probability counterpart.
  const enrichedRows = useMemo<Row[]>(() => {
    if (rawRows.length === 0) return [];
    const N = settings.numTeams;

    // First pass: resolve PPG and derive baseline/edge/beat from it.
    // Three numbers per row:
    //   modelPPG = score-store ensemble (always present).
    //   projPPG  = scenario PPG when active and player is covered, else
    //              the base projection (redraft-projections.json) when
    //              available, else NaN. The Proj column reflects this.
    //   predictedPPG = whichever drives PickEdge / Beat % / verdict —
    //              projPPG if finite, else modelPPG.
    const seeded: Row[] = rawRows.map((r) => {
      const scenarioPpg = scenarioPpgByName.get(normName(r.name));
      const scenarioPpgFinite = scenarioPpg !== undefined && scenarioPpg > 0;
      const baseProjFinite = r.baseProjPpg > 0;
      const projPPG = scenarioPpgFinite
        ? (scenarioPpg as number)
        : baseProjFinite
          ? r.baseProjPpg
          : NaN;
      const modelPPG = r.basePpg;
      const pred = Number.isFinite(projPPG) ? projPPG : modelPPG;
      const haveCI = Number.isFinite(r.ciLower) && Number.isFinite(r.ciUpper) && r.ciUpper > r.ciLower;
      const upsidePPG = haveCI && Number.isFinite(r.ciCenter) ? Math.max(0, r.ciUpper - r.ciCenter) : NaN;
      const downsidePPG = haveCI && Number.isFinite(r.ciCenter) ? Math.max(0, r.ciCenter - r.ciLower) : NaN;
      const curve = curves[r.position];
      const adpBaselinePPG = curve && r.adp < 999 && pred > 0
        ? curve.sqrtIntercept + curve.sqrtSlope * Math.sqrt(r.adp) + (curve.poolOffset ?? 0)
        : NaN;
      const pickEdge = Number.isFinite(adpBaselinePPG) ? pred - adpBaselinePPG : NaN;
      const pBeat = haveCI && pred > 0 ? probBeatBaseline(pred, r.ciLower, r.ciUpper, adpBaselinePPG) : NaN;
      return {
        name: r.name,
        position: r.position,
        team: r.team,
        adp: r.adp,
        stdev: r.stdev,
        modelPPG,
        projPPG,
        predictedPPG: pred,
        adpBaselinePPG,
        pickEdge,
        pBeat,
        upsidePPG,
        downsidePPG,
        rawTargetShare: r.rawTargetShare,
        targetSharePctile: tsharePctile(r.position, r.rawTargetShare),
        survivalBest: r.adp < 999 ? maxSurvival(r.adp, r.stdev || undefined, myPicks) : NaN,
        verdict: 'Unknown' as const,
        isRookie: r.isRookie,
      };
    });

    // Second pass: cohort-relative verdict thresholds derived from
    // *seeded* PickEdge so the verdict re-stratifies under each scenario.
    const stats = new Map<string, { mean: number; std: number }>();
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      const all = seeded.filter((r) => r.position === pos && Number.isFinite(r.pickEdge));
      if (all.length >= 5) {
        const m = all.reduce((s, r) => s + r.pickEdge, 0) / all.length;
        const v = all.reduce((s, r) => s + (r.pickEdge - m) ** 2, 0) / all.length;
        stats.set(`${pos}::ALL`, { mean: m, std: Math.sqrt(v) });
      }
      for (const bandId of ['R1-3', 'R4-6', 'R7-10', 'R11+'] as const) {
        const band = seeded.filter((r) =>
          r.position === pos
          && Number.isFinite(r.pickEdge)
          && bandIdFor(r.adp, N) === bandId,
        );
        if (band.length < 5) continue;
        const m = band.reduce((s, r) => s + r.pickEdge, 0) / band.length;
        const v = band.reduce((s, r) => s + (r.pickEdge - m) ** 2, 0) / band.length;
        stats.set(`${pos}::${bandId}`, { mean: m, std: Math.sqrt(v) });
      }
    }
    return seeded.map((r) => {
      const cohort = stats.get(`${r.position}::${bandIdFor(r.adp, N)}`)
        ?? stats.get(`${r.position}::ALL`);
      const verdict = cohort
        ? verdictFor(r.pickEdge, r.pBeat, cohort.std, cohort.mean)
        : 'Unknown';
      return { ...r, verdict };
    });
  }, [rawRows, curves, scenarioPpgByName, tsharePctile, settings.numTeams, myPicks]);

  const displayRows = useMemo(() => {
    let out = enrichedRows;
    if (posFilter !== 'ALL') out = out.filter((r) => r.position === posFilter);
    if (adpBand !== 'ALL') {
      const band = ADP_BANDS.find((b) => b.id === adpBand);
      const N = settings.numTeams;
      const minAdp = band && 'minRound' in band ? (band.minRound - 1) * N + 1 : 1;
      const maxAdp = band && 'maxRound' in band ? band.maxRound * N : Infinity;
      out = out.filter((r) => r.adp >= minAdp && r.adp <= maxAdp);
    }
    if (myPicksOnly) {
      // Show players with a meaningful chance of being available at any of
      // the user's picks. Threshold (15%) is intentionally generous —
      // includes coin-flip sleepers, excludes only "definitely gone" picks.
      out = out.filter((r) => Number.isFinite(r.survivalBest) && r.survivalBest >= 0.15);
    }
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
      // NaN always sorts to the bottom regardless of direction (e.g. Pick Edge
      // is NaN when ADP curve or PPG prediction is missing).
      const aNaN = typeof av === 'number' && !Number.isFinite(av);
      const bNaN = typeof bv === 'number' && !Number.isFinite(bv);
      if (aNaN && bNaN) return 0;
      if (aNaN) return 1;
      if (bNaN) return -1;
      return sortAsc ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
    return out;
  }, [enrichedRows, posFilter, adpBand, myPicksOnly, search, sortKey, sortAsc, settings.numTeams]);

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortAsc((v) => !v);
    } else {
      setSortKey(key);
      // ADP and name default to ascending; everything else (edge, PPG, z-scores) descending.
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Draft Prep</h1>
        <span style={{
          fontSize: 11, background: 'var(--bg-tertiary)', color: 'var(--text-muted)',
          border: '1px solid var(--border)', borderRadius: 6, padding: '2px 8px', fontWeight: 600,
        }}>
          Edge Board
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          {displayRows.length} players
        </span>
      </div>

      <SettingsHeader
        settings={settings}
        onChange={setSettings}
        scenarios={scenarios}
        selectedScenarioId={selectedScenarioId}
        onScenarioChange={setSelectedScenarioId}
      />

      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.55 }}>
        <strong>Model</strong> = our ADP-free ensemble's predicted PPG
        (Stathead, score-store/ppg.json).{' '}
        <strong>Proj</strong> = base projections from{' '}
        <code>redraft-projections.json</code> (the same source the
        Projections tab uses); when a scenario is active, scenario
        PPG (FantasyPointsPPR ÷ 17) overrides for covered players.
        Pick Edge / Beat % / Verdict use Proj when available, else fall
        back to Model.{' '}
        <strong>Pick Edge</strong> = effective PPG minus the position's
        ADP-curve baseline (recentered to the 2026 pool).{' '}
        <strong>Beat %</strong> = P(actual PPG &gt; baseline), Gaussian
        approx with σ from quantile bounds.{' '}
        <strong>Upside / Downside</strong> = raw PPG distances to ciUpper
        / ciLower (uncertainty band, not a hit/bust probability).{' '}
        <strong>TS %ile</strong> = predicted target-share percentile
        within position (RB/WR R²≈0.30, TE R²≈0.12 — shown muted).{' '}
        <strong>Verdict</strong> is cohort-relative — per-(position × ADP
        band) z-score — so Strong Target reads as "best in your draft
        slot range." Beat % stands alone as the absolute "will they beat
        curve baseline" view. Rookies (and other players outside the
        model pool) are included with projection-only rows — Pick Edge
        runs on Proj vs the ADP curve; Beat % / Upside / Downside show
        “—” since the model has no CI for them. Toggle{' '}
        <em>Available at my picks</em> to filter to players with ≥15%
        survival probability across your snake-draft picks.
        {scenarios.length > 0 && (
          <>
            {' '}Pick a saved <strong>Scenario</strong> in the settings
            header to swap your Projections-tab assumptions in — PPG,
            PickEdge, Beat %, and Verdict all recompute against the
            scenario's projections, and verdicts re-stratify against the
            new distribution.
          </>
        )}
        {Object.keys(curves).length === 0 && (
          <span style={{ color: '#fb923c', marginLeft: 6 }}>
            ADP curve unavailable — Pick Edge / Beat % / Verdict will
            show as “—” until the next score-store build.
          </span>
        )}
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
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

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.5 }}>
          ADP BAND
        </span>
        {ADP_BANDS.map((b) => (
          <button
            key={b.id}
            className={`pos-filter ${adpBand === b.id ? 'active' : ''}`}
            onClick={() => setAdpBand(b.id)}
            style={{ minWidth: 56 }}
          >
            {b.label}
          </button>
        ))}
        <label style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 11, fontWeight: 600, color: 'var(--text-primary)',
          background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '3px 10px', cursor: 'pointer', marginLeft: 8,
        }}>
          <input
            type="checkbox"
            checked={myPicksOnly}
            onChange={(e) => setMyPicksOnly(e.target.checked)}
            style={{ margin: 0 }}
          />
          Available at my picks
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>
            (≥15% survival)
          </span>
        </label>
        {savedBoards.length > 0 && (
          <label style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 11, fontWeight: 600, color: 'var(--text-primary)',
            background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '3px 10px',
          }}>
            My board{' '}
            <select
              value={selectedBoardId}
              onChange={(e) => setSelectedBoardId(e.target.value)}
              style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 11, fontWeight: 700 }}
              title="Overlay a board saved on the My Rankings tab — your rank shows on the Value Board next to market ADP"
            >
              <option value="">None</option>
              {savedBoards.map((b) => (
                <option key={b.id} value={b.id}>{b.name || 'Untitled'}</option>
              ))}
            </select>
          </label>
        )}
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
              <th style={{ ...th, textAlign: 'right', width: 56 }} onClick={() => handleSort('modelPPG')}>
                <span title="Model-predicted PPG (Stathead ADP-free ensemble, score-store/ppg.json). Shown alongside Proj so you can see what the model thinks regardless of which scenario is active.">Model</span>{sortArrow('modelPPG')}
              </th>
              <th style={{ ...th, textAlign: 'right', width: 56 }} onClick={() => handleSort('projPPG')}>
                <span title="Projected PPG. Source: redraft-projections.json by default (same as the Projections tab); when a scenario is active, the scenario's FantasyPointsPPR/17 overrides for covered players. Drives PickEdge / Beat % / Verdict when present.">Proj</span>{sortArrow('projPPG')}
              </th>
              <th style={{ ...th, textAlign: 'right', width: 72 }} onClick={() => handleSort('pickEdge')}>
                <span title="Pick Edge: predicted PPG minus the ADP curve baseline (intercept + slope·√ADP) for this position. Positive = model thinks the player out-earns ADP.">Pick Edge</span>{sortArrow('pickEdge')}
              </th>
              <th style={{ ...th, textAlign: 'right', width: 60 }} onClick={() => handleSort('pBeat')}>
                <span title="P(season PPG > ADP-curve baseline). Gaussian approximation from the 10/90 quantile bounds (q90 − q10 = 2 × 1.2816σ).">Beat %</span>{sortArrow('pBeat')}
              </th>
              <th style={{ ...th, textAlign: 'right', width: 60 }} onClick={() => handleSort('upsidePPG')}>
                <span title="Upside PPG: ciUpper (90th percentile) minus the model's central prediction. Size of the model's belief band on the high side. NOT a probability of booming.">Upside</span>{sortArrow('upsidePPG')}
              </th>
              <th style={{ ...th, textAlign: 'right', width: 60 }} onClick={() => handleSort('downsidePPG')}>
                <span title="Downside PPG: model's central prediction minus ciLower (10th percentile). Size of the model's belief band on the low side. NOT a probability of busting.">Downside</span>{sortArrow('downsidePPG')}
              </th>
              <th style={{ ...th, textAlign: 'right', width: 64 }} onClick={() => handleSort('targetSharePctile')}>
                <span title="Within-position percentile of predicted target share (RB/WR/TE only). RB/WR share models are LOSO R²≈0.30; TE is R²≈0.12 (shown muted).">TS %ile</span>{sortArrow('targetSharePctile')}
              </th>
              <th style={{ ...th, textAlign: 'center', width: 110, cursor: 'default' }}>
                <span title="Verdict: cohort-relative — z-score within (position × ADP band). Strong Target = top of band (z ≥ +1), Strong Fade = bottom of band (z ≤ −1). Per-band stratification keeps round-1 picks from all clustering as Fade and round-11 picks from all clustering as Strong Target. Beat % is separate (absolute probability vs curve).">Verdict</span>
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
                  <PlayerName name={r.name} position={r.position} />
                  {r.isRookie && <span style={{ fontSize: 9, color: '#6366f1', marginLeft: 4 }}>R</span>}
                </td>
                <td style={{ ...td, textAlign: 'center' }}>
                  <span className={`pos-badge pos-${r.position}`} style={{ fontSize: 10 }}>{r.position}</span>
                </td>
                <td style={{ ...td, textAlign: 'center', color: 'var(--text-muted)' }}>{r.team || '—'}</td>
                <td style={{ ...td, textAlign: 'right' }}>{r.adp < 999 ? r.adp.toFixed(1) : '—'}</td>
                <td
                  style={{
                    ...td, textAlign: 'right', fontWeight: 700,
                    // Dim the model column when a scenario is active so the
                    // user's eye lands on Proj — Model is reference, not driver.
                    opacity: Number.isFinite(r.projPPG) ? 0.6 : 1,
                  }}
                >
                  {r.modelPPG > 0 ? r.modelPPG.toFixed(1) : '—'}
                </td>
                <td
                  style={{ ...td, textAlign: 'right', fontWeight: 700 }}
                  title={
                    Number.isFinite(r.projPPG) && r.modelPPG > 0
                      ? `Scenario projects ${r.projPPG.toFixed(1)} vs model's ${r.modelPPG.toFixed(1)} (Δ ${(r.projPPG - r.modelPPG >= 0 ? '+' : '') + (r.projPPG - r.modelPPG).toFixed(1)})`
                      : 'No scenario projection for this player.'
                  }
                >
                  {Number.isFinite(r.projPPG) ? r.projPPG.toFixed(1) : '—'}
                </td>
                <td
                  style={{ ...td, textAlign: 'right', fontWeight: 700, color: pickEdgeColor(r.pickEdge) }}
                  title={
                    Number.isFinite(r.pickEdge)
                      ? `Predicted ${r.predictedPPG.toFixed(1)} PPG − baseline ${r.adpBaselinePPG.toFixed(1)} PPG (${r.position} curve at ADP ${r.adp.toFixed(1)})`
                      : 'No baseline available — missing ADP, predicted PPG, or curve coefficients.'
                  }
                >
                  {fmtEdge(r.pickEdge)}
                </td>
                <td
                  style={{ ...td, textAlign: 'right', fontWeight: 700, color: pBeatColor(r.pBeat) }}
                  title={
                    Number.isFinite(r.pBeat)
                      ? `Gaussian P(actual > ${r.adpBaselinePPG.toFixed(1)} PPG) using μ=midpoint(${(r.upsidePPG + r.downsidePPG > 0 ? 'CI bounds' : 'n/a')}), σ from CI width.`
                      : 'No CI bounds or baseline available.'
                  }
                >
                  {fmtPct(r.pBeat)}
                </td>
                <td
                  style={{ ...td, textAlign: 'right', fontWeight: 600, color: upsideColor(r.upsidePPG) }}
                  title={Number.isFinite(r.upsidePPG) ? `+${r.upsidePPG.toFixed(1)} PPG to ciUpper` : 'No CI bounds available.'}
                >
                  {fmtRange(r.upsidePPG)}
                </td>
                <td
                  style={{ ...td, textAlign: 'right', fontWeight: 600, color: downsideColor(r.downsidePPG) }}
                  title={Number.isFinite(r.downsidePPG) ? `−${r.downsidePPG.toFixed(1)} PPG to ciLower` : 'No CI bounds available.'}
                >
                  {fmtRange(r.downsidePPG)}
                </td>
                <td
                  style={{
                    ...td, textAlign: 'right', fontWeight: 600,
                    color: tsharePctileColor(r.targetSharePctile),
                    opacity: r.position === 'TE' && Number.isFinite(r.targetSharePctile) ? 0.65 : 1,
                  }}
                  title={
                    Number.isFinite(r.targetSharePctile)
                      ? `Predicted target share ${(r.rawTargetShare * 100).toFixed(1)}% — p${r.targetSharePctile} within ${r.position}` +
                        (r.position === 'TE' ? ' (TE share model R²≈0.12, treat as low confidence).' : '')
                      : 'No share prediction available.'
                  }
                >
                  {Number.isFinite(r.targetSharePctile) ? `p${r.targetSharePctile}` : '—'}
                </td>
                <td style={{ ...td, textAlign: 'center' }}>
                  <span
                    style={{
                      display: 'inline-block', fontSize: 10, fontWeight: 700,
                      padding: '2px 8px', borderRadius: 10,
                      background: VERDICT_STYLE[r.verdict].bg,
                      color: VERDICT_STYLE[r.verdict].fg,
                      border: r.verdict === 'Fair' || r.verdict === 'Unknown' ? '1px solid var(--border)' : 'none',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {VERDICT_STYLE[r.verdict].label}
                  </span>
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

      {/* Section 2: Value Board. BeerSheets-style VBD cheat sheet over
          the wide projection pool (rookie-inclusive), with tier colors,
          scarcity bars, and ADP-arbitrage deltas. */}
      <DraftValueBoard
        pool={kitPool}
        settings={settings}
        myRankByKey={myRankByKey}
        myBoardName={myBoard?.name}
      />

      {/* Section 3: Optimal Team Builder. Simulates the user's draft
          from their seat (survival-aware, roster-aware greedy VBD) and
          quantifies the edge vs an ADP-chalk roster. */}
      <DraftRosterSim pool={kitPool} settings={settings} />

      {/* Section 4: Rookie & Veteran Edges. Market mispricings on the
          rookie class (career-model boom/startable probs) and on boring
          4+-year vets the community fades. */}
      <DraftRookieVetEdges
        pool={kitPool}
        settings={settings}
        career={careerScores}
        currentSeason={CURRENT_SEASON}
      />

      {/* Section 5: Round-by-Round Plan. Reads enrichedRows so verdict
          + survival reflect the user's current settings header. */}
      <DraftRoundPlan rows={enrichedRows} settings={settings} />

      {/* Section 6: Tier Map. Per-position scatter (ADP × Pred PPG)
          with cliff lines at tier boundaries. Production tiers — by
          predicted PPG — answer the "where do positions run out?"
          question; verdict color overlays the value signal. */}
      <DraftTierMap rows={enrichedRows} settings={settings} />

      {/* Section 7: Targets & Fades. Top-N undervalued and overvalued
          per position, scored by edge × confidence. Filtered to
          ADP ≤ 200 by default to keep the lists in actionable
          territory; toggle off for sleepers. */}
      <DraftTargetsFades rows={enrichedRows} />
    </div>
  );
}
