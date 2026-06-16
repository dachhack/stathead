import { useState, useEffect, useMemo, useCallback } from 'react';
import { PlayerName } from './PlayerName';
import { bust } from '../lib/buildHash';
import {
  fetchFfcADP, fetchPlayerStats, aggregateToSeasonTotals,
  fetchDraftPicks, fetchRosters, fetchGames,
  fetchOddsGameLines,
} from '../data';
import type { DraftPick, FfcADPPlayer, Roster, Game, ScenarioConfig, SDIOProjection, FreeAgentPlayer } from '../types';
import { createEmptyScenario, isScenarioEmpty, loadAllScenarios } from '../lib/scenarioEngine';
import { SCENARIO_PRESETS } from '../lib/scenarioPresets';
import { NFL_DIVISIONS, divisionOf, compareTeams, groupByDivision } from '../lib/divisions';
import type { PresetMeta } from '../lib/scenarioPresets';
import { positionStats, zScore } from '../lib/nameUtils';
import { exportTeamXlsx, type XlsxTeam } from '../lib/exportTeamXlsx';
import { ScenarioBuilder } from './ScenarioBuilder';
import { TeamAccuracyChart } from './TeamAccuracyChart';
import {
  applyScenarioToProjections, computePPR, saveProjectionBase,
  normalizeProjName as normalizeName,
  type QBProjection, type RBProjection, type WRProjection, type TEProjection,
} from '../lib/projectionsTabEngine';
import projectionConfig from '../generated/projection-config.json';
import teamProjectionsEnsemble from '../generated/team-projections.json';
import { buildProjectionPool, type TeamTotalRow, type AdpModelEntry } from '../lib/buildProjectionPool';
import {
  PREDICT_SEASON, POSITIONS, type Position, TEAM_POS_LIMITS,
} from '../lib/projectionPoolConsts';

// ── Config ──

const POS_COLORS: Record<string, string> = {
  QB: '#6366f1', RB: '#10b981', WR: '#f59e0b', TE: '#ef4444',
};

// Round to 1 decimal for display — scenario scaling produces fractional TD
// totals (e.g. 30.700000000000003); this keeps them clean.
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

// Build SDIOProjection[] from internal projections for ScenarioBuilder player search
function buildSearchProjections(
  qbs: QBProjection[], rbs: RBProjection[], wrs: WRProjection[], tes: TEProjection[],
): SDIOProjection[] {
  const zero = {
    PassingAttempts: 0, PassingCompletions: 0, PassingYards: 0, PassingTouchdowns: 0,
    PassingInterceptions: 0, RushingAttempts: 0, RushingYards: 0, RushingTouchdowns: 0,
    Targets: 0, Receptions: 0, ReceivingYards: 0, ReceivingTouchdowns: 0,
    FumblesLost: 0, FieldGoalsMade: 0, ExtraPointsMade: 0,
  };
  let id = 1;
  // Carry the real counting stats so the Roster Editor can show/anchor them
  // (share % ↔ stat). Positions that lack a stat keep the zeroed default.
  return [
    ...qbs.map((p) => ({ ...zero, PlayerID: id++, Name: p.name, Team: p.team, Position: 'QB', FantasyPoints: p.pprPts - 5, FantasyPointsPPR: p.pprPts,
      PassingAttempts: p.passAtt, PassingCompletions: p.passComp, PassingYards: p.passYds, PassingTouchdowns: p.passTD, PassingInterceptions: p.int,
      RushingAttempts: p.rushAtt, RushingYards: p.rushYds, RushingTouchdowns: p.rushTD })),
    ...rbs.map((p) => ({ ...zero, PlayerID: id++, Name: p.name, Team: p.team, Position: 'RB', FantasyPoints: p.pprPts - 5, FantasyPointsPPR: p.pprPts,
      RushingAttempts: p.rushAtt, RushingYards: p.rushYds, RushingTouchdowns: p.rushTD,
      Targets: p.tgt, Receptions: p.rec, ReceivingYards: p.recYds, ReceivingTouchdowns: p.recTD })),
    ...wrs.map((p) => ({ ...zero, PlayerID: id++, Name: p.name, Team: p.team, Position: 'WR', FantasyPoints: p.pprPts - 5, FantasyPointsPPR: p.pprPts,
      Targets: p.tgt, Receptions: p.rec, ReceivingYards: p.recYds, ReceivingTouchdowns: p.recTD,
      RushingAttempts: p.rushAtt, RushingYards: p.rushYds, RushingTouchdowns: p.rushTD })),
    ...tes.map((p) => ({ ...zero, PlayerID: id++, Name: p.name, Team: p.team, Position: 'TE', FantasyPoints: p.pprPts - 5, FantasyPointsPPR: p.pprPts,
      Targets: p.tgt, Receptions: p.rec, ReceivingYards: p.recYds, ReceivingTouchdowns: p.recTD })),
  ] as SDIOProjection[];
}


// ── Component ──

type ViewMode = 'position' | 'team' | 'teamTotals' | 'accuracy';

interface TeamGroup {
  team: string;
  totalPPR: number;
  qbs: QBProjection[];
  rbs: RBProjection[];
  wrs: WRProjection[];
  tes: TEProjection[];
}

const EMPTY_SCENARIO = createEmptyScenario();

export function StatProjections({ season = PREDICT_SEASON, scenario: scenarioProp, onScenarioChange, embedBuilder = false }: { season?: number; scenario?: ScenarioConfig; onScenarioChange?: (sc: ScenarioConfig) => void; embedBuilder?: boolean }) {
  const isActuals = season < PREDICT_SEASON;

  const [loading, setLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selectedPos, setSelectedPos] = useState<Position>('RB');
  const [viewMode, setViewMode] = useState<ViewMode>('position');
  const [qbProjections, setQBProjections] = useState<QBProjection[]>([]);
  const [rbProjections, setRBProjections] = useState<RBProjection[]>([]);
  const [wrProjections, setWRProjections] = useState<WRProjection[]>([]);
  const [teProjections, setTEProjections] = useState<TEProjection[]>([]);
  const [, setOddsSource] = useState<'live' | 'historical' | ''>('');
  // Scenario is owned by App (shared across tabs); edits flow up via onScenarioChange.
  const scenario = scenarioProp ?? EMPTY_SCENARIO;
  const [freeAgentList, setFreeAgentList] = useState<FreeAgentPlayer[]>([]);
  // Per-player metadata (rookie / years-exp / age / prior-season games) for
  // the Scenario Builder preset factories. Keyed by normalized name.
  const [playerMetaMap, setPlayerMetaMap] = useState<PresetMeta>(new Map());
  // Full current roster per team (for the Scenario Builder's collapsible roster view).
  const [teamRosterMap, setTeamRosterMap] = useState<Record<string, { name: string; position: string; jersey: number; yearsExp: number; status: string }[]>>({});
  // Local-only Consensus projection PPR by normalized name, for the "Consensus"
  // preset. Sourced from a gitignored runtime file (public/data/consensus/) so Consensus's
  // proprietary numbers are never committed — empty (preset hidden) in the
  // public deploy where the file is absent.
  const [consensusPprMap, setConsensusPprMap] = useState<Map<string, number>>(new Map());
  const [consensusStatsMap, setConsensusStatsMap] = useState<Map<string, import('../lib/scenarioPresets').ConsensusStats>>(new Map());
  // CI-precomputed Consensus blends (preset id → normalized name → season PPR),
  // from redraft-projections-presets.json. Lets the Consensus presets work in
  // the public deploy without shipping Consensus to the browser.
  const [presetPprMap, setPresetPprMap] = useState<Map<string, Map<string, number>>>(new Map());
  const [projTeamTotalsMap, setProjTeamTotalsMap] = useState<Map<string, TeamTotalRow>>(new Map());
  // Lifted out of the projection effect so the by-team grouping memo can
  // consult Consensus's depth ordering directly. Belt-and-suspenders against
  // edge cases where pprPts ordering doesn't perfectly match depth (e.g.
  // a starter rookie whose Y1 projection misses a pool reconciliation
  // step and lands behind a vet's ML-shared volume).
  const [depthChart, setDepthChart] = useState<Record<string, Record<string, string[]>>>({});
  // Model-predicted PPG lookup (score-store/ppg.json). Keyed by normalized name.
  const [projPPGMap, setProjPPGMap] = useState<Map<string, number>>(new Map());

  // ADP-model lookups (score-store/adp.json). Used to (a) fill ADP for
  // players FFC doesn't list, and (b) compute within-position boom/bust
  // z-scores from the model's confidence interval.
  const [projAdpMap, setProjAdpMap] = useState<Map<string, AdpModelEntry>>(new Map());

  const searchProjections = useMemo(
    () => buildSearchProjections(qbProjections, rbProjections, wrProjections, teProjections),
    [qbProjections, rbProjections, wrProjections, teProjections],
  );

  const { qbs: dispQbs, rbs: dispRbs, wrs: dispWrs, tes: dispTes } = useMemo(() => {
    if (isActuals || isScenarioEmpty(scenario)) {
      return { qbs: qbProjections, rbs: rbProjections, wrs: wrProjections, tes: teProjections };
    }
    return applyScenarioToProjections(qbProjections, rbProjections, wrProjections, teProjections, scenario);
  }, [isActuals, qbProjections, rbProjections, wrProjections, teProjections, scenario]);

  // Scenario-adjusted overall rankings for the Scenario Builder's rankings panel.
  const builderRankings = useMemo(() => {
    const m = (arr: { name: string; team: string; pprPts: number }[], pos: string) =>
      arr.map((p) => ({ pos, name: p.name, team: p.team, ppr: Math.round(p.pprPts) }));
    return [...m(dispQbs, 'QB'), ...m(dispRbs, 'RB'), ...m(dispWrs, 'WR'), ...m(dispTes, 'TE')];
  }, [dispQbs, dispRbs, dispWrs, dispTes]);

  // Fully scenario-adjusted per-player stat lines (incl. team tendency/volume/
  // stat reshapes) keyed by normalized name, so the Scenario Builder workspace
  // can display reshaped numbers. SDIO field names to match the builder.
  const builderAdjusted = useMemo(() => {
    const m: Record<string, Record<string, number>> = {};
    const add = (arr: { name: string }[]) => {
      for (const p of arr) {
        const o = p as unknown as Record<string, number>;
        m[normalizeName(p.name)] = {
          games: o.games || 0,
          PassingAttempts: o.passAtt || 0, PassingCompletions: o.passComp || 0, PassingYards: o.passYds || 0,
          PassingTouchdowns: o.passTD || 0, PassingInterceptions: o.int || 0,
          RushingAttempts: o.rushAtt || 0, RushingYards: o.rushYds || 0, RushingTouchdowns: o.rushTD || 0,
          Targets: o.tgt || 0, Receptions: o.rec || 0, ReceivingYards: o.recYds || 0, ReceivingTouchdowns: o.recTD || 0,
          pprPts: o.pprPts || 0,
        };
      }
    };
    add(dispQbs); add(dispRbs); add(dispWrs); add(dispTes);
    return m;
  }, [dispQbs, dispRbs, dispWrs, dispTes]);

  // ── Inline editing for the by-team view ──
  // Highlight stat cells that have an active override so the read-only team view
  // shows at a glance where the scenario has changed a player's line.
  const overrideIdSet = useMemo(
    () => new Set((scenario.statOverrides ?? []).map((s) => s.playerId)),
    [scenario.statOverrides],
  );
  const searchIdByName = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of searchProjections) m.set(normalizeName(p.Name), p.PlayerID);
    return m;
  }, [searchProjections]);
  const isEdited = (name: string) => overrideIdSet.has(searchIdByName.get(normalizeName(name)) ?? -1);

  // Quick scenario swap from the projection views: pick a preset or saved
  // scenario and push it up as the active scenario (same materialization the
  // Scenario Builder uses). Consensus-only presets are hidden without Consensus data.
  const hasConsensus = consensusPprMap.size > 0;
  const projScenarioOptions = useMemo(() => {
    // A Consensus-dependent preset is offered when EITHER local Consensus data is present
    // OR its CI-precomputed derived blend loaded (public deploy).
    const presets = SCENARIO_PRESETS
      .filter((p) => !p.requiresConsensus || hasConsensus || (presetPprMap.get(p.id)?.size ?? 0) > 0)
      .map((p) => ({ id: p.id, name: p.name, kind: 'preset' as const }));
    const saved = loadAllScenarios().map((s) => ({ id: s.id, name: s.name, kind: 'saved' as const }));
    return [...presets, ...saved];
  }, [hasConsensus, presetPprMap]);
  const activeScenarioVal = isScenarioEmpty(scenario)
    ? ''
    : (projScenarioOptions.find((o) => o.id === scenario.id)?.id ?? 'custom');
  const applyScenarioById = (id: string) => {
    if (!onScenarioChange || id === 'custom') return;
    if (!id) { onScenarioChange(createEmptyScenario()); return; }
    const preset = SCENARIO_PRESETS.find((p) => p.id === id);
    if (preset) {
      const next = preset.build(searchProjections, playerMetaMap ?? new Map(), normalizeName, { consensusPpr: consensusPprMap, consensusStats: consensusStatsMap, presetPpr: presetPprMap });
      onScenarioChange({ ...next, id: preset.id, name: preset.name });
      return;
    }
    const saved = loadAllScenarios().find((s) => s.id === id);
    if (saved) onScenarioChange(saved);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setQBProjections([]);
    setRBProjections([]);
    setWRProjections([]);
    setTEProjections([]);

    async function run() {
      try {
        // ── Actuals mode: past seasons ──
        if (isActuals) {
          setLoadingStatus(`Loading ${season} actual stats...`);
          const weeklyStats = await fetchPlayerStats(season).catch(() => []);
          if (cancelled) return;

          setLoadingStatus('Processing stats...');
          const totals = aggregateToSeasonTotals(weeklyStats);

          const qbs: QBProjection[] = [];
          const rbs: RBProjection[] = [];
          const wrs: WRProjection[] = [];
          const tes: TEProjection[] = [];

          for (const p of totals) {
            if (!['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
            if (p.games < 1) continue;

            const ppr = Math.round(
              p.fantasy_points_ppr ||
              computePPR({
                passYds: p.passing_yards, passTD: p.passing_tds, int: p.interceptions,
                rushYds: p.rushing_yards, rushTD: p.rushing_tds,
                rec: p.receptions, recYds: p.receiving_yards, recTD: p.receiving_tds,
              })
            );

            if (p.position === 'QB') {
              qbs.push({
                name: p.player_display_name, team: p.recent_team, adp: 999, games: p.games,
                passAtt: p.attempts || 0, passComp: p.completions || 0,
                passYds: p.passing_yards || 0, passTD: p.passing_tds || 0, int: p.interceptions || 0,
                rushAtt: p.carries || 0, rushYds: p.rushing_yards || 0, rushTD: p.rushing_tds || 0,
                pprPts: ppr,
              });
            } else if (p.position === 'RB') {
              rbs.push({
                name: p.player_display_name, team: p.recent_team, adp: 999, games: p.games,
                rushAtt: p.carries || 0, rushYds: p.rushing_yards || 0, rushTD: p.rushing_tds || 0,
                tgt: p.targets || 0, rec: p.receptions || 0,
                recYds: p.receiving_yards || 0, recTD: p.receiving_tds || 0,
                pprPts: ppr,
              });
            } else if (p.position === 'WR') {
              wrs.push({
                name: p.player_display_name, team: p.recent_team, adp: 999, games: p.games,
                tgt: p.targets || 0, rec: p.receptions || 0,
                recYds: p.receiving_yards || 0, recTD: p.receiving_tds || 0,
                rushAtt: p.carries || 0, rushYds: p.rushing_yards || 0, rushTD: p.rushing_tds || 0,
                pprPts: ppr,
              });
            } else if (p.position === 'TE') {
              tes.push({
                name: p.player_display_name, team: p.recent_team, adp: 999, games: p.games,
                tgt: p.targets || 0, rec: p.receptions || 0,
                recYds: p.receiving_yards || 0, recTD: p.receiving_tds || 0,
                pprPts: ppr,
              });
            }
          }

          qbs.sort((a, b) => b.pprPts - a.pprPts);
          rbs.sort((a, b) => b.pprPts - a.pprPts);
          wrs.sort((a, b) => b.pprPts - a.pprPts);
          tes.sort((a, b) => b.pprPts - a.pprPts);

          if (!cancelled) {
            setQBProjections(qbs);
            setRBProjections(rbs);
            setWRProjections(wrs);
            setTEProjections(tes);
          }
          return;
        }

        // ── Projections mode: current/future season ──
        setLoadingStatus('Loading ADP & prior-season data...');

        const [adpData, priorStats, draftData, rosters, gamesData, oddsLines, shareScoresData, ppgScoresData, adpScoresData, redraftData, depthOrderData, featureMatrix, consensusDoc, presetsDoc] = await Promise.all([
          fetchFfcADP(PREDICT_SEASON, 'ppr', 12).catch(() => [] as FfcADPPlayer[]),
          fetchPlayerStats(PREDICT_SEASON - 1).catch(() => []),
          fetchDraftPicks().catch(() => [] as DraftPick[]),
          fetchRosters(PREDICT_SEASON).catch(() => [] as Roster[]),
          fetchGames().catch(() => [] as Game[]),
          fetchOddsGameLines().catch(() => []),
          fetch(`${import.meta.env.BASE_URL}data/score-store/shares.json`).then(r => r.ok ? r.json() : []).catch(() => []),
          fetch(`${import.meta.env.BASE_URL}data/score-store/ppg.json`).then(r => r.ok ? r.json() : []).catch(() => []),
          fetch(`${import.meta.env.BASE_URL}data/score-store/adp.json`).then(r => r.ok ? r.json() : []).catch(() => []),
          fetch(`${import.meta.env.BASE_URL}data/redraft-projections.json`).then(r => r.ok ? r.json() : { players: [] }).catch(() => ({ players: [] })),
          fetch(`${import.meta.env.BASE_URL}data/depth-order-2026.json`).then(r => r.ok ? r.json() : { players: [] }).catch(() => ({ players: [] })),
          // Hoisted out of the pure builder: feature-matrix.json (PPG fallback)
          // and clay-projections-<season>.json (Consensus preset source).
          fetch(`${import.meta.env.BASE_URL}data/feature-matrix.json`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(bust(`${import.meta.env.BASE_URL}data/clay-projections-${PREDICT_SEASON}.json`)).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          // CI-precomputed, DERIVED preset blends (Consensus, etc.) — lets the
          // Consensus presets work in the public deploy without shipping Consensus.
          fetch(`${import.meta.env.BASE_URL}data/redraft-projections-presets.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ]);
        if (cancelled) return;

        setLoadingStatus('Building projections...');
        const pool = buildProjectionPool({
          adpData, priorStats, draftData, rosters, gamesData, oddsLines,
          shareScoresData, ppgScoresData, adpScoresData, redraftData, depthOrderData,
          featureMatrix, consensusDoc, teamProjectionsEnsemble, season,
        });
        if (cancelled) return;

        // These three lookups were populated before the no-ADP early return
        // in the original effect, so set them regardless of the sentinel.
        if (!cancelled) setDepthChart(pool.depthChart);
        setProjAdpMap(pool.projAdpMap);
        setProjPPGMap(pool.projPPGMap);

        // No-ADP early-error sentinel (the builder does not call setState).
        if (pool.error) {
          setError(pool.error);
          return;
        }

        // The remaining lifted lookups were set only on the success path.
        if (!cancelled && pool.freeAgents) setFreeAgentList(pool.freeAgents);
        if (!cancelled) setPlayerMetaMap(pool.meta);
        if (!cancelled) setTeamRosterMap(pool.teamRosterMap);
        setConsensusPprMap(pool.consensusPprMap);
        setConsensusStatsMap(pool.consensusStatsMap);

        const { qbs, rbs, wrs, tes } = pool;

        // Build the precomputed Consensus blends into season-PPR overrides:
        // the presets file stores per-game PPG, so multiply by each player's
        // projected games from the live pool. Keyed by preset id.
        if (!cancelled) {
          const gamesByName = new Map<string, number>();
          for (const p of [...qbs, ...rbs, ...wrs, ...tes]) gamesByName.set(normalizeName(p.name), p.games);
          const fileKeyById: Record<string, string> = { 'preset-consensus': 'consensus', 'preset-consensus-ml': 'consensus-ml' };
          const presets = (presetsDoc as { presets?: Record<string, Array<{ name: string; ppg: number }>> } | null)?.presets;
          const built = new Map<string, Map<string, number>>();
          if (presets) {
            for (const [presetId, fileKey] of Object.entries(fileKeyById)) {
              const list = presets[fileKey];
              if (!Array.isArray(list)) continue;
              const m = new Map<string, number>();
              for (const pl of list) {
                const key = normalizeName(pl.name);
                const season = (Number(pl.ppg) || 0) * (gamesByName.get(key) ?? 17);
                if (season > 0) m.set(key, season);
              }
              if (m.size) built.set(presetId, m);
            }
          }
          setPresetPprMap(built);
        }

        if (!cancelled) {
          setQBProjections(qbs);
          setRBProjections(rbs);
          setWRProjections(wrs);
          setTEProjections(tes);
          setOddsSource(pool.oddsSource);
          setProjTeamTotalsMap(pool.projTeamTotals);
          // Persist the base pool so My Rankings can run the same scenario
          // function over the same numbers (exact cross-tab parity).
          saveProjectionBase({ season: PREDICT_SEASON, qbs, rbs, wrs, tes });
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to build projections');
      } finally {
        setLoading(false);
      }
    }

    run();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [season]);

  const fmtADP = (adp: number) => adp >= 500 ? '—' : adp.toFixed(1);

  const currentData = useMemo(() => {
    if (selectedPos === 'QB') return dispQbs;
    if (selectedPos === 'RB') return dispRbs;
    if (selectedPos === 'WR') return dispWrs;
    return dispTes;
  }, [selectedPos, dispQbs, dispRbs, dispWrs, dispTes]);

  // Boom/bust z-scores from the ADP model's CI bounds, computed within
  // position. Returns a name → { boomZ, bustZ } lookup so the position
  // tables can read constant-time per row.
  const boomBustZByName = useMemo(() => {
    interface ZRow { name: string; position: Position; up: number; down: number }
    const rows: ZRow[] = [];
    const stripStar = (n: string) => n.replace(/^★\s*/, '');
    const positions: { pos: Position; arr: { name: string }[] }[] = [
      { pos: 'QB', arr: dispQbs }, { pos: 'RB', arr: dispRbs },
      { pos: 'WR', arr: dispWrs }, { pos: 'TE', arr: dispTes },
    ];
    for (const { pos, arr } of positions) {
      for (const p of arr) {
        const m = projAdpMap.get(normalizeName(stripStar(p.name)));
        if (!m) continue;
        const up = Math.max(0, m.ciUpper - m.predictedVor);
        const down = Math.max(0, m.predictedVor - m.ciLower);
        if (up <= 0 && down <= 0) continue;
        rows.push({ name: p.name, position: pos, up, down });
      }
    }
    const upStats = positionStats(rows.filter((r) => r.up > 0), (r) => r.position, (r) => r.up);
    const downStats = positionStats(rows.filter((r) => r.down > 0), (r) => r.position, (r) => r.down);
    const out = new Map<string, { boomZ: number; bustZ: number }>();
    for (const r of rows) {
      out.set(normalizeName(stripStar(r.name)), {
        boomZ: r.up > 0 ? Math.round(zScore(r.up, upStats.get(r.position)) * 100) / 100 : 0,
        bustZ: r.down > 0 ? Math.round(zScore(r.down, downStats.get(r.position)) * 100) / 100 : 0,
      });
    }
    return out;
  }, [dispQbs, dispRbs, dispWrs, dispTes, projAdpMap]);

  const lookupZ = (name: string) => boomBustZByName.get(normalizeName(name.replace(/^★\s*/, ''))) ?? { boomZ: 0, bustZ: 0 };
  const lookupAdpFallback = (name: string, adp: number): number => {
    if (adp < 500) return adp;
    const m = projAdpMap.get(normalizeName(name.replace(/^★\s*/, '')));
    return m && m.adp > 0 ? m.adp : adp;
  };
  const fmtZCell = (z: number): string => {
    if (!z) return '—';
    const sign = z > 0 ? '+' : '';
    return `${sign}${z.toFixed(2)}`;
  };
  const zColor = (z: number, bust = false): string | undefined => {
    if (!z) return 'var(--text-muted)';
    if (bust) {
      if (z >= 1.0) return '#ef4444';
      if (z >= 0.5) return '#fb923c';
      return undefined;
    }
    if (z >= 1.0) return '#22c55e';
    if (z >= 0.5) return '#a3e635';
    return undefined;
  };

  const teamGroups = useMemo(() => {
    const byTeam = new Map<string, TeamGroup>();
    function ensure(team: string): TeamGroup {
      if (!byTeam.has(team)) byTeam.set(team, { team, totalPPR: 0, qbs: [], rbs: [], wrs: [], tes: [] });
      return byTeam.get(team)!;
    }
    for (const p of dispQbs) { if (p.team) ensure(p.team).qbs.push(p); }
    for (const p of dispRbs) { if (p.team) ensure(p.team).rbs.push(p); }
    for (const p of dispWrs) { if (p.team) ensure(p.team).wrs.push(p); }
    for (const p of dispTes) { if (p.team) ensure(p.team).tes.push(p); }
    // Depth-chart-aware sort. Primary: Consensus's depth ordering (lower
    // index = starter). Tiebreaker: projected pprPts. Anything not in
    // the depth chart gets rank 9999 and sorts purely by pprPts. This
    // is intentionally redundant with the candidatesByTeamPos sort —
    // by also sorting here, the by-team display is robust to any
    // projection-side issue that produces a starter pprPts < backup.
    const rankByDepth = (team: string, pos: string, name: string): number => {
      const list = depthChart?.[team]?.[pos];
      if (!list) return 9999;
      const norm = name.toLowerCase().replace(/[.']/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').replace(/\s+/g, ' ').trim();
      const idx = list.findIndex((n) => n.toLowerCase().replace(/[.']/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').replace(/\s+/g, ' ').trim() === norm);
      return idx >= 0 ? idx : 9999;
    };
    const sortBy = (pos: string) => (a: { name: string; team: string; pprPts: number }, b: { name: string; team: string; pprPts: number }) => {
      const ad = rankByDepth(a.team, pos, a.name.replace(/^★\s*/, ''));
      const bd = rankByDepth(b.team, pos, b.name.replace(/^★\s*/, ''));
      if (ad !== bd) return ad - bd;
      return b.pprPts - a.pprPts;
    };
    for (const g of byTeam.values()) {
      g.qbs = g.qbs.sort(sortBy('QB')).slice(0, TEAM_POS_LIMITS.QB);
      g.rbs = g.rbs.sort(sortBy('RB')).slice(0, TEAM_POS_LIMITS.RB);
      g.wrs = g.wrs.sort(sortBy('WR')).slice(0, TEAM_POS_LIMITS.WR);
      g.tes = g.tes.sort(sortBy('TE')).slice(0, TEAM_POS_LIMITS.TE);
      g.totalPPR = [...g.qbs, ...g.rbs, ...g.wrs, ...g.tes].reduce((s, p) => s + p.pprPts, 0);
    }
    return [...byTeam.values()].sort((a, b) => b.totalPPR - a.totalPPR);
  }, [dispQbs, dispRbs, dispWrs, dispTes, depthChart]);

  // Export the by-team view (current scenario applied) to a formatted .xlsx
  // workbook laid out like the on-screen cards, so users can keep a
  // nice-looking editable offline copy.
  const exportTeamView = useCallback(async () => {
    const num = (p: object, f: string) => (p as Record<string, number>)[f] ?? 0;
    const toRow = (p: { name: string; games: number }) => ({
      name: p.name, games: p.games,
      passAtt: num(p, 'passAtt'), passComp: num(p, 'passComp'), passYds: num(p, 'passYds'), passTD: num(p, 'passTD'), int: num(p, 'int'),
      rushAtt: num(p, 'rushAtt'), rushYds: num(p, 'rushYds'), rushTD: num(p, 'rushTD'),
      tgt: num(p, 'tgt'), rec: num(p, 'rec'), recYds: num(p, 'recYds'), recTD: num(p, 'recTD'),
    });
    const teams: XlsxTeam[] = teamGroups.map((g) => {
      const pt = projTeamTotalsMap.get(g.team);
      return {
        team: g.team,
        ppr: g.totalPPR,
        groups: [
          { pos: 'QB', players: g.qbs.map(toRow) },
          { pos: 'RB', players: g.rbs.map(toRow) },
          { pos: 'WR', players: g.wrs.map(toRow) },
          { pos: 'TE', players: g.tes.map(toRow) },
        ],
        proj: pt ? {
          passAtt: pt.passAtt, passComp: pt.passComp, passYds: pt.passYds, passTD: pt.passTD, int: pt.int,
          rushAtt: pt.rushAtt, rushYds: pt.rushYds, rushTD: pt.rushTD,
          tgt: pt.tgt, rec: pt.rec, recYds: pt.recYds, recTD: pt.recTD,
        } : undefined,
      };
    });
    await exportTeamXlsx(teams, season);
  }, [teamGroups, projTeamTotalsMap, season]);

  // Export the UNADJUSTED base projection pool + player meta as JSON. This is
  // the exact pool the scenario engine + presets consume, so committing it to
  // public/data/projection-base-<season>.json lets the offline preset
  // precompute (scripts/precompute-projection-presets.ts) run the real engine
  // and emit every scenario preset for the MCP — with zero numeric drift,
  // since it transforms these exact numbers rather than re-deriving them.
  const exportBasePool = useCallback(() => {
    const payload = {
      season,
      generatedAt: new Date().toISOString(),
      qbs: qbProjections,
      rbs: rbProjections,
      wrs: wrProjections,
      tes: teProjections,
      meta: [...playerMetaMap.entries()].map(([key, m]) => ({ key, ...m })),
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `projection-base-${season}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [season, qbProjections, rbProjections, wrProjections, teProjections, playerMetaMap]);

  // Team Totals sums ALL players (no per-team position slicing) so passing TDs = receiving TDs
  const teamTotals = useMemo((): TeamTotalRow[] => {
    const byTeam = new Map<string, TeamTotalRow>();
    function ensureRow(team: string): TeamTotalRow {
      if (!byTeam.has(team)) byTeam.set(team, { team, passAtt: 0, passComp: 0, passYds: 0, passTD: 0, int: 0, rushAtt: 0, rushYds: 0, rushTD: 0, tgt: 0, rec: 0, recYds: 0, recTD: 0, pprPts: 0 });
      return byTeam.get(team)!;
    }
    for (const p of dispQbs) { if (!p.team) continue; const t = ensureRow(p.team); t.passAtt += p.passAtt; t.passComp += p.passComp; t.passYds += p.passYds; t.passTD += p.passTD; t.int += p.int; t.rushAtt += p.rushAtt; t.rushYds += p.rushYds; t.rushTD += p.rushTD; t.pprPts += p.pprPts; }
    for (const p of dispRbs) { if (!p.team) continue; const t = ensureRow(p.team); t.rushAtt += p.rushAtt; t.rushYds += p.rushYds; t.rushTD += p.rushTD; t.tgt += p.tgt; t.rec += p.rec; t.recYds += p.recYds; t.recTD += p.recTD; t.pprPts += p.pprPts; }
    for (const p of dispWrs) { if (!p.team) continue; const t = ensureRow(p.team); t.rushAtt += p.rushAtt; t.rushYds += p.rushYds; t.rushTD += p.rushTD; t.tgt += p.tgt; t.rec += p.rec; t.recYds += p.recYds; t.recTD += p.recTD; t.pprPts += p.pprPts; }
    for (const p of dispTes) { if (!p.team) continue; const t = ensureRow(p.team); t.tgt += p.tgt; t.rec += p.rec; t.recYds += p.recYds; t.recTD += p.recTD; t.pprPts += p.pprPts; }
    return [...byTeam.values()];
  }, [dispQbs, dispRbs, dispWrs, dispTes]);

  const [teamSortCol, setTeamSortCol] = useState<keyof TeamTotalRow>('pprPts');
  const [teamSortAsc, setTeamSortAsc] = useState(false);
  // By Team view shows one division at a time (4 teams); Team Totals groups all.
  const [byTeamDivision, setByTeamDivision] = useState(NFL_DIVISIONS[0].name);

  const sortedTeamTotals = useMemo(() => {
    return [...teamTotals].sort((a, b) => {
      const av = a[teamSortCol]; const bv = b[teamSortCol];
      if (typeof av === 'string' && typeof bv === 'string') return teamSortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      return teamSortAsc ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
  }, [teamTotals, teamSortCol, teamSortAsc]);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <div className="loading-text">
          {loadingStatus}
          <br />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {isActuals
              ? `Loading ${season} actual stats`
              : `Building ${PREDICT_SEASON} stat projections from prior-season rates`}
          </span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <h3>Error</h3>
        <p>{error}</p>
      </div>
    );
  }

  // Full-page Scenario Builder tab. Reuses this component's loaded projection
  // data; edits flow up to App via onScenarioChange so the projection views and
  // rankings stay in sync.
  if (embedBuilder) {
    if (isActuals) {
      return (
        <div className="empty-state">
          <h3>Scenario Builder</h3>
          <p>The Scenario Builder is only available for projected seasons.</p>
        </div>
      );
    }
    return (
      <ScenarioBuilder
        open
        embedded
        projections={searchProjections}
        freeAgents={freeAgentList}
        playerMeta={playerMetaMap}
        consensusPpr={consensusPprMap}
        consensusStats={consensusStatsMap}
        normalizeName={normalizeName}
        scenario={scenario}
        onChange={(sc) => onScenarioChange?.(sc)}
        rankings={builderRankings}
        adjusted={builderAdjusted}
        teamRosters={teamRosterMap}
      />
    );
  }

  return (
    <>
      <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 12 }}>
        {isActuals
          ? <>
              <span style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontWeight: 700, padding: '2px 8px', borderRadius: 4, marginRight: 8, fontSize: 11 }}>
                ACTUALS
              </span>
              {season} actual player stats. Sorted by PPR.
            </>
          : <>
              <span style={{ background: 'rgba(99,102,241,0.15)', color: '#6366f1', fontWeight: 700, padding: '2px 8px', borderRadius: 4, marginRight: 8, fontSize: 11 }}>
                PROJECTED
              </span>
              {PREDICT_SEASON} projections: team totals projected via {Math.round(projectionConfig.winner.teamWeight * 100)}/{Math.round((1 - projectionConfig.winner.teamWeight) * 100)} team/league blend,
              position pools computed from prior-season tendencies (regressed toward league avg for coaching changes),
              then split by each player's share of team volume. Individual efficiency rates preserved. Sorted by PPR.
            </>
        }
      </p>

      {/* View mode + Position tabs */}
      <div className="controls" style={{ marginBottom: 16, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div className="control-group">
          <label className="control-label">Base pool</label>
          <button
            className="pos-filter"
            onClick={exportBasePool}
            title="Download the unadjusted projection pool + player metadata as JSON. Commit it to public/data/projection-base-<season>.json, then run scripts/precompute-projection-presets.ts to publish all scenario presets to the MCP."
            style={{ borderColor: 'var(--text-muted)' }}
          >
            ⬇ Export base pool
          </button>
        </div>
        <div className="control-group">
          <label className="control-label">View</label>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              className={`pos-filter ${viewMode === 'position' ? 'active' : ''}`}
              onClick={() => setViewMode('position')}
              style={{ borderColor: 'var(--text-muted)' }}
            >
              By Position
            </button>
            <button
              className={`pos-filter ${viewMode === 'team' ? 'active' : ''}`}
              onClick={() => setViewMode('team')}
              style={{ borderColor: 'var(--text-muted)' }}
            >
              By Team
            </button>
            <button
              className={`pos-filter ${viewMode === 'teamTotals' ? 'active' : ''}`}
              onClick={() => setViewMode('teamTotals')}
              style={{ borderColor: 'var(--text-muted)' }}
            >
              Team Totals
            </button>
            <button
              className={`pos-filter ${viewMode === 'accuracy' ? 'active' : ''}`}
              onClick={() => setViewMode('accuracy')}
              style={{ borderColor: 'var(--text-muted)' }}
            >
              Accuracy Chart
            </button>
          </div>
        </div>
        {!isActuals && onScenarioChange && viewMode !== 'accuracy' && (
          <div className="control-group">
            <label className="control-label">Scenario</label>
            <select
              value={activeScenarioVal}
              onChange={(e) => { if (e.target.value !== 'custom') applyScenarioById(e.target.value); }}
              style={{ padding: '4px 8px', fontSize: 13, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--text-muted)', borderRadius: 6 }}
              title="Apply a quick preset or saved scenario to these projections"
            >
              <option value="">None (base projection)</option>
              {projScenarioOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.kind === 'preset' ? '★ ' : ''}{o.name}</option>
              ))}
              {activeScenarioVal === 'custom' && <option value="custom">Custom (edited in Builder)</option>}
            </select>
          </div>
        )}
        {viewMode === 'position' && (
          <div className="control-group">
            <label className="control-label">Position</label>
            <div style={{ display: 'flex', gap: 4 }}>
              {POSITIONS.map((pos) => (
                <button
                  key={pos}
                  className={`pos-filter ${selectedPos === pos ? 'active' : ''}`}
                  onClick={() => setSelectedPos(pos)}
                  style={{ borderColor: POS_COLORS[pos] }}
                >
                  {pos}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Team view */}
      {viewMode === 'team' && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div className="control-group" style={{ marginBottom: 0 }}>
                <label className="control-label">Division</label>
                <select
                  value={byTeamDivision}
                  onChange={(e) => setByTeamDivision(e.target.value)}
                  style={{ padding: '4px 8px', fontSize: 13, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--text-muted)', borderRadius: 6 }}
                >
                  {NFL_DIVISIONS.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
                </select>
              </div>
              <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: 0 }}>
                Top {TEAM_POS_LIMITS.QB} QBs, {TEAM_POS_LIMITS.RB} RBs, {TEAM_POS_LIMITS.WR} WRs, {TEAM_POS_LIMITS.TE} TEs per team
              </p>
            </div>
            <button className="export-btn" onClick={() => { void exportTeamView(); }} title="Download every team's stat lines (current scenario applied) as a formatted Excel workbook — PPR and team totals are live formulas, so it recomputes as you edit">
              ⬇ Export to Excel
            </button>
          </div>
          {teamGroups
            .filter((g) => divisionOf(g.team) === byTeamDivision)
            .sort((a, b) => compareTeams(a.team, b.team))
            .map((g, ti) => {
            // Compute position subtotals and team total
            const sumQB = { passAtt: 0, passComp: 0, passYds: 0, passTD: 0, int: 0, rushAtt: 0, rushYds: 0, rushTD: 0, tgt: 0, rec: 0, recYds: 0, recTD: 0, ppr: 0 };
            for (const p of g.qbs) { sumQB.passAtt += p.passAtt; sumQB.passComp += p.passComp; sumQB.passYds += p.passYds; sumQB.passTD += p.passTD; sumQB.int += p.int; sumQB.rushAtt += p.rushAtt; sumQB.rushYds += p.rushYds; sumQB.rushTD += p.rushTD; sumQB.ppr += p.pprPts; }
            const sumRB = { passAtt: 0, passComp: 0, passYds: 0, passTD: 0, int: 0, rushAtt: 0, rushYds: 0, rushTD: 0, tgt: 0, rec: 0, recYds: 0, recTD: 0, ppr: 0 };
            for (const p of g.rbs) { sumRB.rushAtt += p.rushAtt; sumRB.rushYds += p.rushYds; sumRB.rushTD += p.rushTD; sumRB.tgt += p.tgt; sumRB.rec += p.rec; sumRB.recYds += p.recYds; sumRB.recTD += p.recTD; sumRB.ppr += p.pprPts; }
            const sumWR = { passAtt: 0, passComp: 0, passYds: 0, passTD: 0, int: 0, rushAtt: 0, rushYds: 0, rushTD: 0, tgt: 0, rec: 0, recYds: 0, recTD: 0, ppr: 0 };
            for (const p of g.wrs) { sumWR.tgt += p.tgt; sumWR.rec += p.rec; sumWR.recYds += p.recYds; sumWR.recTD += p.recTD; sumWR.rushAtt += p.rushAtt; sumWR.rushYds += p.rushYds; sumWR.rushTD += p.rushTD; sumWR.ppr += p.pprPts; }
            const sumTE = { passAtt: 0, passComp: 0, passYds: 0, passTD: 0, int: 0, rushAtt: 0, rushYds: 0, rushTD: 0, tgt: 0, rec: 0, recYds: 0, recTD: 0, ppr: 0 };
            for (const p of g.tes) { sumTE.tgt += p.tgt; sumTE.rec += p.rec; sumTE.recYds += p.recYds; sumTE.recTD += p.recTD; sumTE.ppr += p.pprPts; }
            const total = {
              passAtt: sumQB.passAtt, passComp: sumQB.passComp, passYds: sumQB.passYds, passTD: sumQB.passTD, int: sumQB.int,
              rushAtt: sumQB.rushAtt + sumRB.rushAtt + sumWR.rushAtt, rushYds: sumQB.rushYds + sumRB.rushYds + sumWR.rushYds, rushTD: sumQB.rushTD + sumRB.rushTD + sumWR.rushTD,
              tgt: sumRB.tgt + sumWR.tgt + sumTE.tgt, rec: sumRB.rec + sumWR.rec + sumTE.rec, recYds: sumRB.recYds + sumWR.recYds + sumTE.recYds, recTD: sumRB.recTD + sumWR.recTD + sumTE.recTD,
              ppr: g.totalPPR,
            };

            const thStyle = { fontSize: 10, padding: '4px 6px', whiteSpace: 'nowrap' as const };
            const tdStyle = { fontSize: 11, padding: '3px 6px' };
            const subtotalStyle = { ...tdStyle, fontWeight: 700 as const, background: 'var(--bg-tertiary)', borderTop: '1px solid var(--border)' };
            const totalStyle = { ...tdStyle, fontWeight: 700 as const, background: 'var(--bg-tertiary)', borderTop: '2px solid var(--text-muted)' };
            const shareStyle = { fontSize: 9, color: 'var(--text-muted)', marginLeft: 2, fontWeight: 400 as const };

            // Projected team totals from the blend model (reference for share %)
            const projTotal = projTeamTotalsMap.get(g.team);

            function pct(val: number, ref: number | undefined): string {
              if (!val || !ref) return '';
              return `${Math.round(val / ref * 100)}%`;
            }

            const gv = (p: object, f: string) => (p as Record<string, number>)[f] || 0;
            // Read-only stat cell. Editing lives in the Scenario Builder; an
            // overridden player's numbers are tinted so changes are visible here.
            function playerRow(pos: string, p: { name: string; team: string; games: number; pprPts: number }) {
              const isQB = pos === 'QB';
              const hasRush = pos !== 'TE';
              const edited = isEdited(p.name);
              const editColor = edited ? 'var(--accent)' : undefined;
              const cell = (field: string, shareRef?: number, opts?: { bold?: boolean; red?: boolean }) => {
                const v = gv(p, field);
                return (
                  <td style={{ ...tdStyle, textAlign: 'right', color: opts?.red && v ? '#ef4444' : editColor, fontWeight: opts?.bold && v ? 700 : undefined }}>
                    {v ? <>{v >= 1000 ? v.toLocaleString() : v}{shareRef ? <span style={shareStyle}>{pct(v, shareRef)}</span> : null}</> : ''}
                  </td>
                );
              };
              const blank = (key: string) => <td key={key} style={tdStyle} />;
              return (
                <tr key={p.name}>
                  <td style={{ ...tdStyle, color: POS_COLORS[pos], fontWeight: 700 }}>{pos}</td>
                  <td style={{ ...tdStyle, minWidth: 110, color: editColor }}><strong><PlayerName name={p.name} position={pos} /></strong></td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{p.games}</td>
                  {isQB ? cell('passAtt') : blank('pa')}
                  {isQB ? cell('passComp') : blank('pc')}
                  {isQB ? cell('passYds', projTotal?.passYds) : blank('py')}
                  {isQB ? cell('passTD', undefined, { bold: true }) : blank('pt')}
                  {isQB ? cell('int', undefined, { red: true }) : blank('pi')}
                  {hasRush ? cell('rushAtt', projTotal?.rushAtt) : blank('ra')}
                  {hasRush ? cell('rushYds') : blank('ry')}
                  {hasRush ? cell('rushTD', undefined, { bold: true }) : blank('rt')}
                  {isQB ? blank('tg') : cell('tgt', projTotal?.tgt)}
                  {isQB ? blank('rc') : cell('rec')}
                  {isQB ? blank('rcy') : cell('recYds', projTotal?.recYds)}
                  {isQB ? blank('rct') : cell('recTD', undefined, { bold: true })}
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: POS_COLORS[pos] }}>{p.pprPts}</td>
                </tr>
              );
            }

            function subtotalRow(label: string, color: string, s: typeof sumQB) {
              return (
                <tr key={label}>
                  <td colSpan={2} style={{ ...subtotalStyle, color }}>{label}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}></td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.passAtt || ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.passComp || ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.passYds ? <>{s.passYds.toLocaleString()}<span style={shareStyle}>{pct(s.passYds, projTotal?.passYds)}</span></> : ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.passTD || ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.int || ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.rushAtt ? <>{s.rushAtt}<span style={shareStyle}>{pct(s.rushAtt, projTotal?.rushAtt)}</span></> : ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.rushYds ? s.rushYds.toLocaleString() : ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.rushTD || ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.tgt ? <>{s.tgt}<span style={shareStyle}>{pct(s.tgt, projTotal?.tgt)}</span></> : ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.rec || ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.recYds ? <>{s.recYds.toLocaleString()}<span style={shareStyle}>{pct(s.recYds, projTotal?.recYds)}</span></> : ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right' }}>{s.recTD || ''}</td>
                  <td style={{ ...subtotalStyle, textAlign: 'right', color }}>{s.ppr}</td>
                </tr>
              );
            }

            return (
            <div key={g.team} style={{
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '12px 16px', marginBottom: 16,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 18, fontWeight: 700 }}>
                  <span style={{ color: 'var(--text-muted)', marginRight: 8 }}>#{ti + 1}</span>
                  {g.team}
                </span>
                <span style={{ fontSize: 14, fontWeight: 700, color: '#f59e0b' }}>
                  {g.totalPPR.toLocaleString()} PPR
                </span>
              </div>
              <div className="table-container" style={{ maxHeight: 'none', overflowX: 'auto' }}>
                <table style={{ fontSize: 11, borderCollapse: 'collapse', width: '100%' }}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Pos</th>
                      <th style={thStyle}>Player</th>
                      <th style={thStyle}>Gm</th>
                      <th colSpan={5} style={{ ...thStyle, textAlign: 'center', borderBottom: `2px solid ${POS_COLORS.QB}` }}>PASSING</th>
                      <th colSpan={3} style={{ ...thStyle, textAlign: 'center', borderBottom: `2px solid ${POS_COLORS.RB}` }}>RUSHING</th>
                      <th colSpan={4} style={{ ...thStyle, textAlign: 'center', borderBottom: `2px solid ${POS_COLORS.WR}` }}>RECEIVING</th>
                      <th style={{ ...thStyle, borderBottom: '2px solid #f59e0b' }}>PPR</th>
                    </tr>
                    <tr>
                      <th style={thStyle}></th>
                      <th style={thStyle}></th>
                      <th style={thStyle}></th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Att</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Cmp</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Yds</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>TD</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>INT</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Att</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Yds</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>TD</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Tgt</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Rec</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Yds</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>TD</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Pts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.qbs.map((p) => playerRow('QB', p))}
                    {subtotalRow('QB Total', POS_COLORS.QB, sumQB)}
                    {g.rbs.map((p) => playerRow('RB', p))}
                    {subtotalRow('RB Total', POS_COLORS.RB, sumRB)}
                    {g.wrs.map((p) => playerRow('WR', p))}
                    {subtotalRow('WR Total', POS_COLORS.WR, sumWR)}
                    {g.tes.map((p) => playerRow('TE', p))}
                    {subtotalRow('TE Total', POS_COLORS.TE, sumTE)}
                    <tr>
                      <td colSpan={2} style={{ ...totalStyle, fontSize: 12 }}>Total</td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}></td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.passAtt}<span style={shareStyle}>{pct(total.passAtt, projTotal?.passAtt)}</span></td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.passComp}</td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.passYds.toLocaleString()}<span style={shareStyle}>{pct(total.passYds, projTotal?.passYds)}</span></td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.passTD}</td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.int}</td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.rushAtt}<span style={shareStyle}>{pct(total.rushAtt, projTotal?.rushAtt)}</span></td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.rushYds.toLocaleString()}</td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.rushTD}</td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.tgt}<span style={shareStyle}>{pct(total.tgt, projTotal?.tgt)}</span></td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.rec}</td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.recYds.toLocaleString()}<span style={shareStyle}>{pct(total.recYds, projTotal?.recYds)}</span></td>
                      <td style={{ ...totalStyle, textAlign: 'right' }}>{total.recTD}</td>
                      <td style={{ ...totalStyle, textAlign: 'right', color: '#f59e0b', fontSize: 12 }}>{total.ppr}</td>
                    </tr>
                    {projTotal && (
                    <tr>
                      <td colSpan={2} style={{ ...tdStyle, fontSize: 10, color: 'var(--text-muted)' }}>Proj. Team</td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}></td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-muted)', fontSize: 10 }}>{projTotal.passAtt}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-muted)', fontSize: 10 }}>{projTotal.passComp}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-muted)', fontSize: 10 }}>{projTotal.passYds.toLocaleString()}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-muted)', fontSize: 10 }}>{projTotal.passTD}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-muted)', fontSize: 10 }}>{projTotal.int}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-muted)', fontSize: 10 }}>{projTotal.rushAtt}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-muted)', fontSize: 10 }}>{projTotal.rushYds.toLocaleString()}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-muted)', fontSize: 10 }}>{projTotal.rushTD}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-muted)', fontSize: 10 }}>{projTotal.tgt}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-muted)', fontSize: 10 }}>{projTotal.rec}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-muted)', fontSize: 10 }}>{projTotal.recYds.toLocaleString()}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-muted)', fontSize: 10 }}>{projTotal.recTD}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-muted)', fontSize: 10 }}></td>
                    </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            );
          })}
        </div>
      )}

      {/* Team Totals view */}
      {viewMode === 'teamTotals' && (() => {
        const thS = { fontSize: 10, padding: '4px 8px', cursor: 'pointer' as const, whiteSpace: 'nowrap' as const, userSelect: 'none' as const };
        const tdS = { fontSize: 11, padding: '4px 8px', textAlign: 'right' as const };
        function sortHeader(label: string, col: keyof TeamTotalRow, align: 'left' | 'right' = 'right') {
          const active = teamSortCol === col;
          return (
            <th
              style={{ ...thS, textAlign: align, color: active ? 'var(--text-primary)' : undefined }}
              onClick={() => { if (teamSortCol === col) setTeamSortAsc(!teamSortAsc); else { setTeamSortCol(col); setTeamSortAsc(false); } }}
            >
              {label}{active ? (teamSortAsc ? ' ▲' : ' ▼') : ''}
            </th>
          );
        }
        // League averages for the footer
        const avg: Record<string, number> = {};
        const n = sortedTeamTotals.length || 1;
        for (const key of ['passAtt','passComp','passYds','passTD','int','rushAtt','rushYds','rushTD','tgt','rec','recYds','recTD','pprPts'] as (keyof TeamTotalRow)[]) {
          avg[key] = Math.round(sortedTeamTotals.reduce((s, r) => s + (r[key] as number), 0) / n);
        }
        return (
          <div style={{ marginBottom: 20 }}>
            <h4 style={{ marginBottom: 8 }}>
              Team Totals — {season}
              <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>
                {sortedTeamTotals.length} teams · {TEAM_POS_LIMITS.QB} QB, {TEAM_POS_LIMITS.RB} RB, {TEAM_POS_LIMITS.WR} WR, {TEAM_POS_LIMITS.TE} TE per team · click headers to sort
              </span>
            </h4>
            <div className="table-container" style={{ maxHeight: 800, overflowY: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ ...thS, textAlign: 'center' }}>#</th>
                    {sortHeader('Team', 'team', 'left')}
                    <th colSpan={5} style={{ ...thS, textAlign: 'center', borderBottom: `2px solid ${POS_COLORS.QB}` }}>PASSING</th>
                    <th colSpan={3} style={{ ...thS, textAlign: 'center', borderBottom: `2px solid ${POS_COLORS.RB}` }}>RUSHING</th>
                    <th colSpan={4} style={{ ...thS, textAlign: 'center', borderBottom: `2px solid ${POS_COLORS.WR}` }}>RECEIVING</th>
                    <th style={{ ...thS, borderBottom: '2px solid #f59e0b' }}>PPR</th>
                  </tr>
                  <tr>
                    <th style={thS}></th>
                    <th style={thS}></th>
                    {sortHeader('Att', 'passAtt')}
                    {sortHeader('Cmp', 'passComp')}
                    {sortHeader('Yds', 'passYds')}
                    {sortHeader('TD', 'passTD')}
                    {sortHeader('INT', 'int')}
                    {sortHeader('Att', 'rushAtt')}
                    {sortHeader('Yds', 'rushYds')}
                    {sortHeader('TD', 'rushTD')}
                    {sortHeader('Tgt', 'tgt')}
                    {sortHeader('Rec', 'rec')}
                    {sortHeader('Yds', 'recYds')}
                    {sortHeader('TD', 'recTD')}
                    {sortHeader('Pts', 'pprPts')}
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const rank = new Map(sortedTeamTotals.map((r, i) => [r.team, i + 1] as const));
                    return groupByDivision(sortedTeamTotals, (r) => r.team).flatMap((grp) => [
                      <tr key={`div-${grp.division}`}>
                        <td colSpan={15} style={{ ...tdS, textAlign: 'left', fontWeight: 700, background: 'var(--bg-tertiary)', color: 'var(--text-muted)', fontSize: 10, letterSpacing: '0.05em' }}>{grp.division.toUpperCase()}</td>
                      </tr>,
                      ...grp.items.map((r) => (
                        <tr key={r.team} onClick={() => { setByTeamDivision(divisionOf(r.team)); setViewMode('team'); }} style={{ cursor: 'pointer' }}>
                          <td style={{ ...tdS, textAlign: 'center', color: 'var(--text-muted)' }}>{rank.get(r.team)}</td>
                          <td style={{ ...tdS, textAlign: 'left', fontWeight: 700 }}>{r.team}</td>
                          <td style={tdS}>{r.passAtt.toLocaleString()}</td>
                          <td style={tdS}>{r.passComp.toLocaleString()}</td>
                          <td style={tdS}>{r.passYds.toLocaleString()}</td>
                          <td style={{ ...tdS, fontWeight: 700 }}>{round1(r.passTD).toLocaleString()}</td>
                          <td style={{ ...tdS, color: '#ef4444' }}>{round1(r.int).toLocaleString()}</td>
                          <td style={tdS}>{r.rushAtt.toLocaleString()}</td>
                          <td style={tdS}>{r.rushYds.toLocaleString()}</td>
                          <td style={{ ...tdS, fontWeight: 700 }}>{round1(r.rushTD).toLocaleString()}</td>
                          <td style={tdS}>{r.tgt.toLocaleString()}</td>
                          <td style={tdS}>{r.rec.toLocaleString()}</td>
                          <td style={tdS}>{r.recYds.toLocaleString()}</td>
                          <td style={{ ...tdS, fontWeight: 700 }}>{round1(r.recTD).toLocaleString()}</td>
                          <td style={{ ...tdS, fontWeight: 700, color: '#f59e0b' }}>{r.pprPts.toLocaleString()}</td>
                        </tr>
                      )),
                    ]);
                  })()}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid var(--text-muted)' }}>
                    <td style={{ ...tdS, textAlign: 'center' }}></td>
                    <td style={{ ...tdS, textAlign: 'left', fontWeight: 700, color: 'var(--text-muted)' }}>Avg</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.passAtt?.toLocaleString()}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.passComp?.toLocaleString()}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.passYds?.toLocaleString()}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.passTD}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.int}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.rushAtt?.toLocaleString()}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.rushYds?.toLocaleString()}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.rushTD}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.tgt?.toLocaleString()}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.rec?.toLocaleString()}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.recYds?.toLocaleString()}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.recTD}</td>
                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{avg.pprPts?.toLocaleString()}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        );
      })()}

      {/* Summary cards */}
      {viewMode === 'position' && <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        {POSITIONS.map((pos) => {
          const data = pos === 'QB' ? dispQbs : pos === 'RB' ? dispRbs : pos === 'WR' ? dispWrs : dispTes;
          const top = data[0];
          return (
            <div
              key={pos}
              onClick={() => setSelectedPos(pos)}
              style={{
                background: selectedPos === pos ? 'var(--bg-tertiary)' : 'var(--bg-secondary)',
                border: `2px solid ${selectedPos === pos ? POS_COLORS[pos] : 'var(--border)'}`,
                borderRadius: 8,
                padding: '12px 16px',
                cursor: 'pointer',
                minWidth: 140,
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 700, color: POS_COLORS[pos], marginBottom: 4 }}>
                {pos}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                <div>{data.length} {isActuals ? 'players' : 'players projected'}</div>
                {top && <div>#{1}: <strong style={{ color: 'var(--text-primary)' }}>{top.name}</strong></div>}
                {top && <div>{top.pprPts} PPR pts</div>}
              </div>
            </div>
          );
        })}
      </div>}

      {/* Projection table */}
      {viewMode === 'position' && <>
      <h4 style={{ marginBottom: 8 }}>
        <span style={{ color: POS_COLORS[selectedPos] }}>{selectedPos}</span> {isActuals ? 'Actuals' : 'Projections'} — {season}
        <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>
          {currentData.length} players
        </span>
      </h4>
      <div className="table-container" style={{ marginBottom: 20, maxHeight: 600, overflowY: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>Team</th>
              <th>ADP</th>
              <th>Gm</th>
              {selectedPos === 'QB' && (
                <>
                  <th colSpan={5} style={{ textAlign: 'center', borderBottom: `2px solid ${POS_COLORS.QB}` }}>PASSING</th>
                  <th colSpan={3} style={{ textAlign: 'center', borderBottom: '2px solid #10b981' }}>RUSHING</th>
                </>
              )}
              {selectedPos === 'RB' && (
                <>
                  <th colSpan={3} style={{ textAlign: 'center', borderBottom: '2px solid #10b981' }}>RUSHING</th>
                  <th colSpan={4} style={{ textAlign: 'center', borderBottom: `2px solid ${POS_COLORS.WR}` }}>RECEIVING</th>
                </>
              )}
              {selectedPos === 'WR' && (
                <>
                  <th colSpan={4} style={{ textAlign: 'center', borderBottom: `2px solid ${POS_COLORS.WR}` }}>RECEIVING</th>
                  <th colSpan={3} style={{ textAlign: 'center', borderBottom: '2px solid #10b981' }}>RUSHING</th>
                </>
              )}
              {selectedPos === 'TE' && (
                <th colSpan={4} style={{ textAlign: 'center', borderBottom: `2px solid ${POS_COLORS.TE}` }}>RECEIVING</th>
              )}
              <th colSpan={5} style={{ textAlign: 'center', borderBottom: '2px solid #f59e0b' }}>PPR</th>
            </tr>
            <tr>
              <th></th>
              <th></th>
              <th></th>
              <th></th>
              <th></th>
              {selectedPos === 'QB' && (
                <>
                  <th>Att</th><th>Cmp</th><th>Yds</th><th>TD</th><th>INT</th>
                  <th>Att</th><th>Yds</th><th>TD</th>
                </>
              )}
              {selectedPos === 'RB' && (
                <>
                  <th>Att</th><th>Yds</th><th>TD</th>
                  <th>Tgt</th><th>Rec</th><th>Yds</th><th>TD</th>
                </>
              )}
              {selectedPos === 'WR' && (
                <>
                  <th>Tgt</th><th>Rec</th><th>Yds</th><th>TD</th>
                  <th>Att</th><th>Yds</th><th>TD</th>
                </>
              )}
              {selectedPos === 'TE' && (
                <>
                  <th>Tgt</th><th>Rec</th><th>Yds</th><th>TD</th>
                </>
              )}
              <th title="Total PPR points over projected games">Pts</th>
              <th title="Scenario-adjusted PPG (projected points ÷ games)">PPG</th>
              <th title="Model-predicted PPG (ADP-free model)">Proj PPG</th>
              <th title="Boom z-score within position — CI upside spread normalized to position peers. >+1 = unusually wide upside.">Boom z</th>
              <th title="Bust z-score within position — CI downside spread normalized to position peers. >+1 = unusually wide downside risk.">Bust z</th>
            </tr>
          </thead>
          <tbody>
            {selectedPos === 'QB' && dispQbs.map((p, i) => {
              const scenPPG = p.games > 0 ? Math.round((p.pprPts / p.games) * 10) / 10 : 0;
              const projPPG = projPPGMap.get(normalizeName(p.name.replace(/^★\s*/, ''))) ?? 0;
              const z = lookupZ(p.name);
              return (
                <tr key={p.name}>
                  <td className="rank-cell">{i + 1}</td>
                  <td><strong><PlayerName name={p.name} /></strong></td>
                  <td style={{ color: 'var(--text-muted)' }}>{p.team}</td>
                  <td>{fmtADP(lookupAdpFallback(p.name, p.adp))}</td>
                  <td>{p.games}</td>
                  <td>{p.passAtt}</td>
                  <td>{p.passComp}</td>
                  <td>{p.passYds.toLocaleString()}</td>
                  <td style={{ fontWeight: 700 }}>{p.passTD}</td>
                  <td style={{ color: '#ef4444' }}>{p.int}</td>
                  <td>{p.rushAtt}</td>
                  <td>{p.rushYds}</td>
                  <td style={{ fontWeight: 700 }}>{p.rushTD}</td>
                  <td style={{ fontWeight: 700, color: POS_COLORS.QB }}>{p.pprPts}</td>
                  <td style={{ fontWeight: 700 }}>{scenPPG > 0 ? scenPPG.toFixed(1) : '—'}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{projPPG > 0 ? projPPG.toFixed(1) : '—'}</td>
                  <td style={{ color: zColor(z.boomZ), fontWeight: 600 }}>{fmtZCell(z.boomZ)}</td>
                  <td style={{ color: zColor(z.bustZ, true), fontWeight: 600 }}>{fmtZCell(z.bustZ)}</td>
                </tr>
              );
            })}
            {selectedPos === 'RB' && dispRbs.map((p, i) => {
              const scenPPG = p.games > 0 ? Math.round((p.pprPts / p.games) * 10) / 10 : 0;
              const projPPG = projPPGMap.get(normalizeName(p.name.replace(/^★\s*/, ''))) ?? 0;
              const z = lookupZ(p.name);
              return (
                <tr key={p.name}>
                  <td className="rank-cell">{i + 1}</td>
                  <td><strong><PlayerName name={p.name} /></strong></td>
                  <td style={{ color: 'var(--text-muted)' }}>{p.team}</td>
                  <td>{fmtADP(lookupAdpFallback(p.name, p.adp))}</td>
                  <td>{p.games}</td>
                  <td>{p.rushAtt}</td>
                  <td>{p.rushYds.toLocaleString()}</td>
                  <td style={{ fontWeight: 700 }}>{p.rushTD}</td>
                  <td>{p.tgt}</td>
                  <td>{p.rec}</td>
                  <td>{p.recYds}</td>
                  <td style={{ fontWeight: 700 }}>{p.recTD}</td>
                  <td style={{ fontWeight: 700, color: POS_COLORS.RB }}>{p.pprPts}</td>
                  <td style={{ fontWeight: 700 }}>{scenPPG > 0 ? scenPPG.toFixed(1) : '—'}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{projPPG > 0 ? projPPG.toFixed(1) : '—'}</td>
                  <td style={{ color: zColor(z.boomZ), fontWeight: 600 }}>{fmtZCell(z.boomZ)}</td>
                  <td style={{ color: zColor(z.bustZ, true), fontWeight: 600 }}>{fmtZCell(z.bustZ)}</td>
                </tr>
              );
            })}
            {selectedPos === 'WR' && dispWrs.map((p, i) => {
              const scenPPG = p.games > 0 ? Math.round((p.pprPts / p.games) * 10) / 10 : 0;
              const projPPG = projPPGMap.get(normalizeName(p.name.replace(/^★\s*/, ''))) ?? 0;
              const z = lookupZ(p.name);
              return (
                <tr key={p.name}>
                  <td className="rank-cell">{i + 1}</td>
                  <td><strong><PlayerName name={p.name} /></strong></td>
                  <td style={{ color: 'var(--text-muted)' }}>{p.team}</td>
                  <td>{fmtADP(lookupAdpFallback(p.name, p.adp))}</td>
                  <td>{p.games}</td>
                  <td>{p.tgt}</td>
                  <td>{p.rec}</td>
                  <td>{p.recYds.toLocaleString()}</td>
                  <td style={{ fontWeight: 700 }}>{p.recTD}</td>
                  <td>{p.rushAtt}</td>
                  <td>{p.rushYds}</td>
                  <td style={{ fontWeight: 700 }}>{p.rushTD}</td>
                  <td style={{ fontWeight: 700, color: POS_COLORS.WR }}>{p.pprPts}</td>
                  <td style={{ fontWeight: 700 }}>{scenPPG > 0 ? scenPPG.toFixed(1) : '—'}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{projPPG > 0 ? projPPG.toFixed(1) : '—'}</td>
                  <td style={{ color: zColor(z.boomZ), fontWeight: 600 }}>{fmtZCell(z.boomZ)}</td>
                  <td style={{ color: zColor(z.bustZ, true), fontWeight: 600 }}>{fmtZCell(z.bustZ)}</td>
                </tr>
              );
            })}
            {selectedPos === 'TE' && dispTes.map((p, i) => {
              const scenPPG = p.games > 0 ? Math.round((p.pprPts / p.games) * 10) / 10 : 0;
              const projPPG = projPPGMap.get(normalizeName(p.name.replace(/^★\s*/, ''))) ?? 0;
              const z = lookupZ(p.name);
              return (
                <tr key={p.name}>
                  <td className="rank-cell">{i + 1}</td>
                  <td><strong><PlayerName name={p.name} /></strong></td>
                  <td style={{ color: 'var(--text-muted)' }}>{p.team}</td>
                  <td>{fmtADP(lookupAdpFallback(p.name, p.adp))}</td>
                  <td>{p.games}</td>
                  <td>{p.tgt}</td>
                  <td>{p.rec}</td>
                  <td>{p.recYds.toLocaleString()}</td>
                  <td style={{ fontWeight: 700 }}>{p.recTD}</td>
                  <td style={{ fontWeight: 700, color: POS_COLORS.TE }}>{p.pprPts}</td>
                  <td style={{ fontWeight: 700 }}>{scenPPG > 0 ? scenPPG.toFixed(1) : '—'}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{projPPG > 0 ? projPPG.toFixed(1) : '—'}</td>
                  <td style={{ color: zColor(z.boomZ), fontWeight: 600 }}>{fmtZCell(z.boomZ)}</td>
                  <td style={{ color: zColor(z.bustZ, true), fontWeight: 600 }}>{fmtZCell(z.bustZ)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </>}

      {/* Accuracy chart */}
      {viewMode === 'accuracy' && <TeamAccuracyChart />}
    </>
  );
}

