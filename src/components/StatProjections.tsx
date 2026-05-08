import { useState, useEffect, useMemo } from 'react';
import {
  fetchFfcADP, fetchPlayerStats, aggregateToSeasonTotals,
  fetchDraftPicks, fetchRosters, fetchGames,
  fetchOddsGameLines, aggregateOddsToTeamImplied,
} from '../data';
import type { SeasonTotals, DraftPick, FfcADPPlayer, Roster, Game, ScenarioConfig, SDIOProjection, FreeAgentPlayer } from '../types';
import { createEmptyScenario, isScenarioEmpty } from '../lib/scenarioEngine';
import { positionStats, zScore } from '../lib/nameUtils';
import { ScenarioBuilder } from './ScenarioBuilder';
import { TeamAccuracyChart } from './TeamAccuracyChart';
import projectionConfig from '../generated/projection-config.json';
import teamProjectionsEnsemble from '../generated/team-projections.json';

// ── Config ──

const PREDICT_SEASON = 2026;
const POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const;
type Position = typeof POSITIONS[number];

const POS_COLORS: Record<string, string> = {
  QB: '#6366f1', RB: '#10b981', WR: '#f59e0b', TE: '#ef4444',
};

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[.']/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').replace(/\s+/g, ' ').trim();
}

// ── Projection interfaces ──

interface QBProjection {
  name: string; team: string; adp: number; games: number;
  passAtt: number; passComp: number; passYds: number; passTD: number; int: number;
  rushAtt: number; rushYds: number; rushTD: number;
  pprPts: number;
}

interface RBProjection {
  name: string; team: string; adp: number; games: number;
  rushAtt: number; rushYds: number; rushTD: number;
  tgt: number; rec: number; recYds: number; recTD: number;
  pprPts: number;
}

interface WRProjection {
  name: string; team: string; adp: number; games: number;
  tgt: number; rec: number; recYds: number; recTD: number;
  rushAtt: number; rushYds: number; rushTD: number;
  pprPts: number;
}

interface TEProjection {
  name: string; team: string; adp: number; games: number;
  tgt: number; rec: number; recYds: number; recTD: number;
  pprPts: number;
}

// PPR scoring
function computePPR(p: {
  passYds?: number; passTD?: number; int?: number;
  rushYds?: number; rushTD?: number;
  rec?: number; recYds?: number; recTD?: number;
}): number {
  return (
    (p.passYds || 0) * 0.04 + (p.passTD || 0) * 4 + (p.int || 0) * -2 +
    (p.rushYds || 0) * 0.1 + (p.rushTD || 0) * 6 +
    (p.rec || 0) * 1 + (p.recYds || 0) * 0.1 + (p.recTD || 0) * 6
  );
}

// ── Scenario application ──

// Scale factor for FA signings: project to FA_PROJ_GAMES with regression
const FA_PROJ_GAMES = 14;
const FA_REG = 0.85;

function applyScenarioToProjections(
  qbsIn: QBProjection[],
  rbsIn: RBProjection[],
  wrsIn: WRProjection[],
  tesIn: TEProjection[],
  sc: ScenarioConfig,
): { qbs: QBProjection[]; rbs: RBProjection[]; wrs: WRProjection[]; tes: TEProjection[] } {
  // Inject free agent signings before team adjustments so tendencies apply to them
  const qbs = [...qbsIn];
  const rbs = [...rbsIn];
  const wrs = [...wrsIn];
  const tes = [...tesIn];

  for (const fa of (sc.freeAgentSignings ?? [])) {
    const scale = fa.priorGames > 0 ? (FA_PROJ_GAMES / fa.priorGames) * FA_REG : 0;
    const base = { name: `★ ${fa.name}`, team: fa.toTeam, adp: 999, games: FA_PROJ_GAMES };
    if (fa.position === 'QB') {
      const passAtt = Math.round(fa.passAtt * scale);
      const passComp = Math.round(fa.passComp * scale);
      const passYds = Math.round(fa.passYds * scale);
      const passTD = Math.round(fa.passTD * scale);
      const int = Math.round(fa.int * scale);
      const rushAtt = Math.round(fa.rushAtt * scale);
      const rushYds = Math.round(fa.rushYds * scale);
      const rushTD = Math.round(fa.rushTD * scale);
      qbs.push({ ...base, passAtt, passComp, passYds, passTD, int, rushAtt, rushYds, rushTD,
        pprPts: Math.round(computePPR({ passYds, passTD, int, rushYds, rushTD })) });
    } else if (fa.position === 'RB') {
      const rushAtt = Math.round(fa.rushAtt * scale);
      const rushYds = Math.round(fa.rushYds * scale);
      const rushTD = Math.round(fa.rushTD * scale);
      const tgt = Math.round(fa.tgt * scale);
      const rec = Math.round(fa.rec * scale);
      const recYds = Math.round(fa.recYds * scale);
      const recTD = Math.round(fa.recTD * scale);
      rbs.push({ ...base, rushAtt, rushYds, rushTD, tgt, rec, recYds, recTD,
        pprPts: Math.round(computePPR({ rushYds, rushTD, rec, recYds, recTD })) });
    } else if (fa.position === 'WR') {
      const tgt = Math.round(fa.tgt * scale);
      const rec = Math.round(fa.rec * scale);
      const recYds = Math.round(fa.recYds * scale);
      const recTD = Math.round(fa.recTD * scale);
      const rushAtt = Math.round(fa.rushAtt * scale);
      const rushYds = Math.round(fa.rushYds * scale);
      const rushTD = Math.round(fa.rushTD * scale);
      wrs.push({ ...base, tgt, rec, recYds, recTD, rushAtt, rushYds, rushTD,
        pprPts: Math.round(computePPR({ rec, recYds, recTD, rushYds, rushTD })) });
    } else if (fa.position === 'TE') {
      const tgt = Math.round(fa.tgt * scale);
      const rec = Math.round(fa.rec * scale);
      const recYds = Math.round(fa.recYds * scale);
      const recTD = Math.round(fa.recTD * scale);
      tes.push({ ...base, tgt, rec, recYds, recTD,
        pprPts: Math.round(computePPR({ rec, recYds, recTD })) });
    }
  }

  // Build lookup maps
  const teamOverrides = new Map<string, string>();
  for (const move of sc.movements) {
    teamOverrides.set(normalizeName(move.playerName), move.toTeam);
  }
  const volumeByName = new Map<string, { rush: number; rec: number; pass: number }>();
  for (const vo of sc.volumeOverrides) {
    volumeByName.set(normalizeName(vo.playerName), {
      rush: vo.rushDelta ?? vo.volumeDelta,
      rec: vo.recDelta ?? vo.volumeDelta,
      pass: vo.passDelta ?? vo.volumeDelta,
    });
  }

  const getTeam = (p: { name: string; team: string }) =>
    teamOverrides.get(normalizeName(p.name)) ?? p.team;

  const passMult = (team: string) => {
    const t = sc.teamTendencies.find((x) => x.team === team);
    return t ? 1 + t.passRatioDelta * 0.008 : 1;
  };
  const rushMult = (team: string) => {
    const t = sc.teamTendencies.find((x) => x.team === team);
    return t ? 1 - t.passRatioDelta * 0.010 : 1;
  };
  const volMult = (team: string) => {
    const tv = (sc.teamVolumes ?? []).find((x) => x.team === team);
    return tv ? 1 + tv.volumeDelta / 100 : 1;
  };

  // ── Pass 1: team-level adjustments (tendency + total volume), no player overrides ──

  const baseQbs = qbs.map((p) => {
    const team = getTeam(p);
    const vm = volMult(team);
    const f = passMult(team) * vm;
    const rf = rushMult(team) * vm;
    const passAtt = Math.round(p.passAtt * f);
    const passComp = Math.round(p.passComp * f);
    const passYds = Math.round(p.passYds * f);
    const passTD = Math.round(p.passTD * f);
    const int = Math.round(p.int * f);
    const rushAtt = Math.round(p.rushAtt * rf);
    const rushYds = p.rushAtt > 0 ? Math.round(rushAtt * p.rushYds / p.rushAtt) : 0;
    const rushTD = p.rushAtt > 0 ? Math.round(p.rushTD * rushAtt / p.rushAtt) : 0;
    return { ...p, team, passAtt, passComp, passYds, passTD, int, rushAtt, rushYds, rushTD,
      pprPts: Math.round(computePPR({ passYds, passTD, int, rushYds, rushTD })) };
  });

  const baseRbs = rbs.map((p) => {
    const team = getTeam(p);
    const vm = volMult(team);
    const rf = rushMult(team) * vm;
    const pf = passMult(team) * vm;
    const rushAtt = Math.round(p.rushAtt * rf);
    const rushYds = p.rushAtt > 0 ? Math.round(rushAtt * p.rushYds / p.rushAtt) : 0;
    const rushTD = p.rushAtt > 0 ? Math.round(p.rushTD * rushAtt / p.rushAtt) : 0;
    const tgt = Math.round(p.tgt * pf);
    const catchRate = p.tgt > 0 ? p.rec / p.tgt : 0.72;
    const rec = Math.round(tgt * catchRate);
    const recYds = p.rec > 0 ? Math.round(rec * p.recYds / p.rec) : 0;
    const recTD = p.tgt > 0 ? Math.round(p.recTD * tgt / p.tgt) : 0;
    return { ...p, team, rushAtt, rushYds, rushTD, tgt, rec, recYds, recTD,
      pprPts: Math.round(computePPR({ rushYds, rushTD, rec, recYds, recTD })) };
  });

  const baseWrs = wrs.map((p) => {
    const team = getTeam(p);
    const vm = volMult(team);
    const f = passMult(team) * vm;
    const rf = rushMult(team) * vm;
    const tgt = Math.round(p.tgt * f);
    const catchRate = p.tgt > 0 ? p.rec / p.tgt : 0.65;
    const rec = Math.round(tgt * catchRate);
    const recYds = p.rec > 0 ? Math.round(rec * p.recYds / p.rec) : 0;
    const recTD = p.tgt > 0 ? Math.round(p.recTD * tgt / p.tgt) : 0;
    const rushAtt = Math.round(p.rushAtt * rf);
    const rushYds = p.rushAtt > 0 ? Math.round(rushAtt * p.rushYds / p.rushAtt) : 0;
    const rushTD = p.rushAtt > 0 ? Math.round(p.rushTD * rushAtt / p.rushAtt) : 0;
    return { ...p, team, tgt, rec, recYds, recTD, rushAtt, rushYds, rushTD,
      pprPts: Math.round(computePPR({ rushYds, rushTD, rec, recYds, recTD })) };
  });

  const baseTes = tes.map((p) => {
    const team = getTeam(p);
    const vm = volMult(team);
    const f = passMult(team) * vm;
    const tgt = Math.round(p.tgt * f);
    const catchRate = p.tgt > 0 ? p.rec / p.tgt : 0.68;
    const rec = Math.round(tgt * catchRate);
    const recYds = p.rec > 0 ? Math.round(rec * p.recYds / p.rec) : 0;
    const recTD = p.tgt > 0 ? Math.round(p.recTD * tgt / p.tgt) : 0;
    return { ...p, team, tgt, rec, recYds, recTD,
      pprPts: Math.round(computePPR({ rec, recYds, recTD })) };
  });

  // ── Zero-sum redistribution setup ──
  // Compute team pool totals from base (before individual overrides)
  const teamRushPool = new Map<string, number>();
  const teamTgtPool = new Map<string, number>();
  for (const p of baseRbs) {
    teamRushPool.set(p.team, (teamRushPool.get(p.team) ?? 0) + p.rushAtt);
    teamTgtPool.set(p.team, (teamTgtPool.get(p.team) ?? 0) + p.tgt);
  }
  for (const p of [...baseWrs, ...baseTes]) {
    teamTgtPool.set(p.team, (teamTgtPool.get(p.team) ?? 0) + p.tgt);
  }

  // Sum up original and new targets/carries for overridden players per team
  const rushOrigOvr = new Map<string, number>();
  const rushNewOvr = new Map<string, number>();
  const tgtOrigOvr = new Map<string, number>();
  const tgtNewOvr = new Map<string, number>();
  for (const p of baseRbs) {
    const vo = volumeByName.get(normalizeName(p.name));
    if (vo !== undefined) {
      const rushF = 1 + vo.rush / 100;
      const recF = 1 + vo.rec / 100;
      rushOrigOvr.set(p.team, (rushOrigOvr.get(p.team) ?? 0) + p.rushAtt);
      rushNewOvr.set(p.team, (rushNewOvr.get(p.team) ?? 0) + p.rushAtt * rushF);
      tgtOrigOvr.set(p.team, (tgtOrigOvr.get(p.team) ?? 0) + p.tgt);
      tgtNewOvr.set(p.team, (tgtNewOvr.get(p.team) ?? 0) + p.tgt * recF);
    }
  }
  for (const p of [...baseWrs, ...baseTes]) {
    const vo = volumeByName.get(normalizeName(p.name));
    if (vo !== undefined) {
      const recF = 1 + vo.rec / 100;
      tgtOrigOvr.set(p.team, (tgtOrigOvr.get(p.team) ?? 0) + p.tgt);
      tgtNewOvr.set(p.team, (tgtNewOvr.get(p.team) ?? 0) + p.tgt * recF);
    }
  }

  // Scale factor for non-overridden players: keeps team total the same
  const rushOtherScale = (team: string): number => {
    const total = teamRushPool.get(team) ?? 0;
    const origOvr = rushOrigOvr.get(team) ?? 0;
    const newOvr = rushNewOvr.get(team) ?? 0;
    if (origOvr === 0 || total - origOvr <= 0) return 1;
    return Math.max(0, (total - newOvr) / (total - origOvr));
  };
  const tgtOtherScale = (team: string): number => {
    const total = teamTgtPool.get(team) ?? 0;
    const origOvr = tgtOrigOvr.get(team) ?? 0;
    const newOvr = tgtNewOvr.get(team) ?? 0;
    if (origOvr === 0 || total - origOvr <= 0) return 1;
    return Math.max(0, (total - newOvr) / (total - origOvr));
  };

  // Stat application helpers
  const applyRbStats = (p: RBProjection, rf: number, pf: number): RBProjection => {
    const rushAtt = Math.round(p.rushAtt * rf);
    const rushYds = p.rushAtt > 0 ? Math.round(rushAtt * p.rushYds / p.rushAtt) : 0;
    const rushTD = p.rushAtt > 0 ? Math.round(p.rushTD * rushAtt / p.rushAtt) : 0;
    const tgt = Math.round(p.tgt * pf);
    const catchRate = p.tgt > 0 ? p.rec / p.tgt : 0.72;
    const rec = Math.round(tgt * catchRate);
    const recYds = p.rec > 0 ? Math.round(rec * p.recYds / p.rec) : 0;
    const recTD = p.tgt > 0 ? Math.round(p.recTD * tgt / p.tgt) : 0;
    return { ...p, rushAtt, rushYds, rushTD, tgt, rec, recYds, recTD,
      pprPts: Math.round(computePPR({ rushYds, rushTD, rec, recYds, recTD })) };
  };
  const applyWrStats = (p: WRProjection, tgtF: number, rushF: number): WRProjection => {
    const tgt = Math.round(p.tgt * tgtF);
    const catchRate = p.tgt > 0 ? p.rec / p.tgt : 0.65;
    const rec = Math.round(tgt * catchRate);
    const recYds = p.rec > 0 ? Math.round(rec * p.recYds / p.rec) : 0;
    const recTD = p.tgt > 0 ? Math.round(p.recTD * tgt / p.tgt) : 0;
    const rushAtt = Math.round(p.rushAtt * rushF);
    const rushYds = p.rushAtt > 0 ? Math.round(rushAtt * p.rushYds / p.rushAtt) : 0;
    const rushTD = p.rushAtt > 0 ? Math.round(p.rushTD * rushAtt / p.rushAtt) : 0;
    return { ...p, tgt, rec, recYds, recTD, rushAtt, rushYds, rushTD,
      pprPts: Math.round(computePPR({ rushYds, rushTD, rec, recYds, recTD })) };
  };
  const applyTeStats = (p: TEProjection, f: number): TEProjection => {
    const tgt = Math.round(p.tgt * f);
    const catchRate = p.tgt > 0 ? p.rec / p.tgt : 0.68;
    const rec = Math.round(tgt * catchRate);
    const recYds = p.rec > 0 ? Math.round(rec * p.recYds / p.rec) : 0;
    const recTD = p.tgt > 0 ? Math.round(p.recTD * tgt / p.tgt) : 0;
    return { ...p, tgt, rec, recYds, recTD,
      pprPts: Math.round(computePPR({ rec, recYds, recTD })) };
  };

  // ── Pass 2: player overrides (boost overridden, scale down others) ──

  const adjQbs = baseQbs.map((p) => {
    const vo = volumeByName.get(normalizeName(p.name));
    if (vo === undefined) return p;
    const pf = 1 + vo.pass / 100;
    const rf = 1 + vo.rush / 100;
    const passAtt = Math.round(p.passAtt * pf);
    const passComp = Math.round(p.passComp * pf);
    const passYds = Math.round(p.passYds * pf);
    const passTD = Math.round(p.passTD * pf);
    const int = Math.round(p.int * pf);
    const rushAtt = Math.round(p.rushAtt * rf);
    const rushYds = p.rushAtt > 0 ? Math.round(rushAtt * p.rushYds / p.rushAtt) : 0;
    const rushTD = p.rushAtt > 0 ? Math.round(p.rushTD * rushAtt / p.rushAtt) : 0;
    return { ...p, passAtt, passComp, passYds, passTD, int, rushAtt, rushYds, rushTD,
      pprPts: Math.round(computePPR({ passYds, passTD, int, rushYds, rushTD })) };
  });

  const adjRbs = baseRbs.map((p) => {
    const vo = volumeByName.get(normalizeName(p.name));
    if (vo !== undefined) return applyRbStats(p, 1 + vo.rush / 100, 1 + vo.rec / 100);
    const rf = rushOtherScale(p.team);
    const pf = tgtOtherScale(p.team);
    return rf === 1 && pf === 1 ? p : applyRbStats(p, rf, pf);
  });

  const adjWrs = baseWrs.map((p) => {
    const vo = volumeByName.get(normalizeName(p.name));
    // Overridden WR: per-stat deltas for receiving and rushing independently
    if (vo !== undefined) return applyWrStats(p, 1 + vo.rec / 100, 1 + vo.rush / 100);
    // Non-overridden: only scale receiving (rushing is independent)
    const f = tgtOtherScale(p.team);
    return f === 1 ? p : applyWrStats(p, f, 1);
  });

  const adjTes = baseTes.map((p) => {
    const vo = volumeByName.get(normalizeName(p.name));
    if (vo !== undefined) return applyTeStats(p, 1 + vo.rec / 100);
    const f = tgtOtherScale(p.team);
    return f === 1 ? p : applyTeStats(p, f);
  });

  // Vegas weighting — regression toward position mean on pprPts
  if (sc.vegasWeighting > 0) {
    const factor = sc.vegasWeighting / 100;
    const mean = (arr: { pprPts: number }[]) =>
      arr.length ? arr.reduce((s, p) => s + p.pprPts, 0) / arr.length : 0;
    const regress = (pts: number, avg: number) => Math.round(pts + (avg - pts) * factor);
    const qbMean = mean(adjQbs), rbMean = mean(adjRbs), wrMean = mean(adjWrs), teMean = mean(adjTes);
    adjQbs.forEach((p, i) => { adjQbs[i] = { ...p, pprPts: regress(p.pprPts, qbMean) }; });
    adjRbs.forEach((p, i) => { adjRbs[i] = { ...p, pprPts: regress(p.pprPts, rbMean) }; });
    adjWrs.forEach((p, i) => { adjWrs[i] = { ...p, pprPts: regress(p.pprPts, wrMean) }; });
    adjTes.forEach((p, i) => { adjTes[i] = { ...p, pprPts: regress(p.pprPts, teMean) }; });
  }

  // Custom players — inject into position arrays
  for (const cp of sc.customPlayers) {
    const base = { name: `★ ${cp.name}`, team: cp.team || 'FA', adp: 999, games: 17, pprPts: cp.fantasyPointsPPR };
    if (cp.position === 'QB') {
      adjQbs.push({ ...base, passAtt: 0, passComp: 0, passYds: 0, passTD: 0, int: 0, rushAtt: 0, rushYds: 0, rushTD: 0 });
    } else if (cp.position === 'RB') {
      adjRbs.push({ ...base, rushAtt: 0, rushYds: 0, rushTD: 0, tgt: 0, rec: 0, recYds: 0, recTD: 0 });
    } else if (cp.position === 'WR') {
      adjWrs.push({ ...base, tgt: 0, rec: 0, recYds: 0, recTD: 0, rushAtt: 0, rushYds: 0, rushTD: 0 });
    } else if (cp.position === 'TE') {
      adjTes.push({ ...base, tgt: 0, rec: 0, recYds: 0, recTD: 0 });
    }
  }

  return { qbs: adjQbs, rbs: adjRbs, wrs: adjWrs, tes: adjTes };
}

// Build SDIOProjection[] from internal projections for ScenarioBuilder player search
function buildSearchProjections(
  qbs: QBProjection[], rbs: RBProjection[], wrs: WRProjection[], tes: TEProjection[],
): SDIOProjection[] {
  const zero = {
    PassingAttempts: 0, PassingCompletions: 0, PassingYards: 0, PassingTouchdowns: 0,
    PassingInterceptions: 0, RushingAttempts: 0, RushingYards: 0, RushingTouchdowns: 0,
    Receptions: 0, ReceivingYards: 0, ReceivingTouchdowns: 0,
    FumblesLost: 0, FieldGoalsMade: 0, ExtraPointsMade: 0,
  };
  let id = 1;
  return [
    ...qbs.map((p) => ({ ...zero, PlayerID: id++, Name: p.name, Team: p.team, Position: 'QB', FantasyPoints: p.pprPts - 5, FantasyPointsPPR: p.pprPts })),
    ...rbs.map((p) => ({ ...zero, PlayerID: id++, Name: p.name, Team: p.team, Position: 'RB', FantasyPoints: p.pprPts - 5, FantasyPointsPPR: p.pprPts })),
    ...wrs.map((p) => ({ ...zero, PlayerID: id++, Name: p.name, Team: p.team, Position: 'WR', FantasyPoints: p.pprPts - 5, FantasyPointsPPR: p.pprPts })),
    ...tes.map((p) => ({ ...zero, PlayerID: id++, Name: p.name, Team: p.team, Position: 'TE', FantasyPoints: p.pprPts - 5, FantasyPointsPPR: p.pprPts })),
  ] as SDIOProjection[];
}


// ── Component ──

type ViewMode = 'position' | 'team' | 'teamTotals' | 'accuracy';

interface TeamTotalRow {
  team: string;
  passAtt: number; passComp: number; passYds: number; passTD: number; int: number;
  rushAtt: number; rushYds: number; rushTD: number;
  tgt: number; rec: number; recYds: number; recTD: number;
  pprPts: number;
}

const TEAM_POS_LIMITS: Record<Position, number> = { QB: 2, RB: 4, WR: 5, TE: 3 };

interface TeamGroup {
  team: string;
  totalPPR: number;
  qbs: QBProjection[];
  rbs: RBProjection[];
  wrs: WRProjection[];
  tes: TEProjection[];
}

export function StatProjections({ season = PREDICT_SEASON, onScenarioChange }: { season?: number; onScenarioChange?: (sc: ScenarioConfig) => void }) {
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
  const [scenario, setScenario] = useState<ScenarioConfig>(createEmptyScenario);
  const [scenarioOpen, setScenarioOpen] = useState(false);
  const [freeAgentList, setFreeAgentList] = useState<FreeAgentPlayer[]>([]);
  const [projTeamTotalsMap, setProjTeamTotalsMap] = useState<Map<string, TeamTotalRow>>(new Map());
  // Model-predicted PPG lookup (score-store/ppg.json). Keyed by normalized name.
  const [projPPGMap, setProjPPGMap] = useState<Map<string, number>>(new Map());

  // ADP-model lookups (score-store/adp.json). Used to (a) fill ADP for
  // players FFC doesn't list, and (b) compute within-position boom/bust
  // z-scores from the model's confidence interval.
  interface AdpModelEntry { adp: number; predictedVor: number; ciLower: number; ciUpper: number }
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

        const [adpData, priorStats, draftData, rosters, gamesData, oddsLines, shareScoresData, ppgScoresData, adpScoresData, redraftData] = await Promise.all([
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
        ]);
        const redraftFallback = (redraftData as { players?: Array<{ name: string; position: string; ppg: number }> }).players ?? [];

        // ADP-model lookup (score-store/adp.json). Populates ADP for
        // players FFC misses and exposes the CI bounds we use for the
        // boom/bust z-score columns.
        const adpModelMap = new Map<string, AdpModelEntry>();
        for (const a of adpScoresData as Array<{ name: string; adp: number; predictedVor: number; ciLower: number; ciUpper: number }>) {
          if (!a?.name) continue;
          adpModelMap.set(normalizeName(a.name), {
            adp: Number(a.adp) || 0,
            predictedVor: Number(a.predictedVor) || 0,
            ciLower: Number(a.ciLower) || 0,
            ciUpper: Number(a.ciUpper) || 0,
          });
        }
        setProjAdpMap(adpModelMap);

        // ML share predictions lookup: name → { predTargetShare, predRushShare }
        const mlShares = new Map<string, { predTargetShare: number; predRushShare: number }>();
        for (const s of shareScoresData as Array<{ name: string; predTargetShare: number; predRushShare: number }>) {
          mlShares.set(normalizeName(s.name), { predTargetShare: s.predTargetShare || 0, predRushShare: s.predRushShare || 0 });
        }
        // ML PPG predictions lookup: name → predictedPPG. Fall back to
        // feature-matrix.json if the shard is empty (same pattern as MyRankings).
        let mlPPGEntries = ppgScoresData as Array<{ name: string; predictedPPG: number }>;
        if (!mlPPGEntries.length) {
          try {
            const fm = await fetch(`${import.meta.env.BASE_URL}data/feature-matrix.json`).then(r => r.ok ? r.json() : null);
            if (fm?.ppgPredictions2026) {
              mlPPGEntries = fm.ppgPredictions2026.map((p: Record<string, unknown>) => ({
                name: String(p.name ?? ''),
                predictedPPG: Number(p.predictedPPG) || 0,
              }));
            }
          } catch { /* ignore */ }
        }
        const mlPPG = new Map<string, number>();
        for (const s of mlPPGEntries) {
          if (s.predictedPPG > 0) mlPPG.set(normalizeName(s.name), s.predictedPPG);
        }
        // Fill from the redraft-projections shard for players the ML
        // model doesn't list (depth pieces beyond the model's coverage)
        // so the Proj PPG column isn't a sea of em-dashes.
        for (const p of redraftFallback) {
          const k = normalizeName(p.name);
          if (!mlPPG.has(k) && p.ppg > 0) mlPPG.set(k, p.ppg);
        }
        setProjPPGMap(mlPPG);
        if (cancelled) return;

        if (adpData.length === 0) {
          setError(`No ${PREDICT_SEASON} ADP data available yet`);
          return;
        }

        setLoadingStatus('Building projections...');

        // ── Step 1: Prior season player totals ──
        const priorTotals = aggregateToSeasonTotals(
          priorStats.filter((s) => s.season_type === 'REG')
        );
        const priorByName = new Map<string, SeasonTotals>();
        for (const p of priorTotals) {
          if (['QB', 'RB', 'WR', 'TE'].includes(p.position)) {
            priorByName.set(normalizeName(p.player_display_name), p);
          }
        }

        // Roster: player → current team
        const rosterTeam = new Map<string, string>();
        for (const r of rosters) {
          if (['QB', 'RB', 'WR', 'TE'].includes(r.position)) {
            rosterTeam.set(normalizeName(r.full_name), r.team);
          }
        }

        // ── Free agent list: prior-season players not on current rosters ──
        // Only built when roster data is substantial enough to be meaningful
        if (!cancelled && rosters.length >= 50) {
          const fas: FreeAgentPlayer[] = [];
          for (const p of priorTotals) {
            if (!['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
            if ((p.games || 0) < 3) continue;
            if ((p.fantasy_points_ppr || 0) < 25) continue;
            const nn = normalizeName(p.player_display_name);
            if (rosterTeam.has(nn)) continue; // already on a team
            fas.push({
              name: p.player_display_name,
              position: p.position,
              priorGames: p.games,
              priorPPR: Math.round(p.fantasy_points_ppr),
              passAtt: p.attempts || 0,
              passComp: p.completions || 0,
              passYds: p.passing_yards || 0,
              passTD: p.passing_tds || 0,
              int: p.interceptions || 0,
              rushAtt: p.carries || 0,
              rushYds: p.rushing_yards || 0,
              rushTD: p.rushing_tds || 0,
              tgt: p.targets || 0,
              rec: p.receptions || 0,
              recYds: p.receiving_yards || 0,
              recTD: p.receiving_tds || 0,
            });
          }
          // Sort by prior PPR descending
          fas.sort((a, b) => b.priorPPR - a.priorPPR);
          setFreeAgentList(fas);
        }

        // Vegas implied totals (kept for future sweeps that may re-enable it)
        const oddsTeamImplied = oddsLines.length > 0 ? aggregateOddsToTeamImplied(oddsLines) : [];
        const usingLiveOdds = oddsTeamImplied.length > 0;

        // Draft data for age/experience
        const draftByName = new Map<string, DraftPick>();
        for (const d of draftData) draftByName.set(normalizeName(d.pfr_player_name), d);

        // Rookie workload share by draft pick + position. Used by the no-
        // prior projection branches so a recently-drafted rookie like
        // Jeremiyah Love (R1 #3 ARI) gets a starter-level share of his
        // team's RB pool instead of the generic `1 / (players.length * 4)`
        // depth-piece fallback. Returns 0 for non-2026-rookies (vets without
        // prior stats) so the existing depth-piece fallback still kicks in.
        // Numbers are heuristic typical Y1 workload shares — RBs ramp fast,
        // TEs slow, QBs binary on starter status.
        function rookieShare(name: string, pos: string): number {
          const draft = draftByName.get(name);
          if (!draft || draft.season !== PREDICT_SEASON) return 0;
          const pick = draft.pick || 999;
          if (pos === 'RB') {
            if (pick <= 32)  return 0.55;
            if (pick <= 64)  return 0.30;
            if (pick <= 100) return 0.18;
            if (pick <= 150) return 0.10;
            return 0.05;
          }
          if (pos === 'WR') {
            if (pick <= 16)  return 0.22;
            if (pick <= 32)  return 0.18;
            if (pick <= 64)  return 0.12;
            if (pick <= 100) return 0.08;
            if (pick <= 150) return 0.05;
            return 0.03;
          }
          if (pos === 'TE') {
            if (pick <= 32)  return 0.18;
            if (pick <= 64)  return 0.12;
            if (pick <= 100) return 0.08;
            if (pick <= 150) return 0.05;
            return 0.03;
          }
          if (pos === 'QB') {
            if (pick <= 3)   return 0.85;
            if (pick <= 15)  return 0.50;
            if (pick <= 32)  return 0.25;
            if (pick <= 100) return 0.10;
            return 0.05;
          }
          return 0;
        }

        // Age-based regression factor
        function ageFactor(name: string, pos: string): number {
          const draft = draftByName.get(name);
          if (!draft) return 1;
          const age = (draft.age || 0) + (PREDICT_SEASON - draft.season);
          if (pos === 'RB') {
            if (age >= 30) return 0.80;
            if (age >= 28) return 0.90;
            if (age >= 26) return 0.95;
          } else if (pos === 'WR') {
            if (age >= 32) return 0.85;
            if (age >= 30) return 0.92;
          } else if (pos === 'QB') {
            if (age >= 38) return 0.90;
            if (age >= 36) return 0.95;
          } else if (pos === 'TE') {
            if (age >= 32) return 0.88;
            if (age >= 30) return 0.94;
          }
          return 1;
        }

        // Threshold below which a player is considered to have missed significant time
        const INJURY_GAMES = 13;
        const FULL_SEASON_GAMES = 16;

        // Scale a stat to full-season equivalent for an injured player.
        // Only applied to the primary starter (index 0 in ADP-sorted list) so that
        // backups who filled in don't get projected for the same usage in 2026.
        function healthAdjust(value: number, games: number): number {
          if (games >= INJURY_GAMES) return value;
          return value * (FULL_SEASON_GAMES / Math.max(games, 1));
        }

        // Projected games: regress toward 16.
        // Primary starters who missed significant time regress more strongly (assume health).
        function projectGames(prior: SeasonTotals | undefined, isPrimary = false): number {
          if (!prior) return 14;
          if (isPrimary && prior.games < INJURY_GAMES) {
            // Injured primary starter: regress 80% toward full season
            return Math.min(17, Math.round((prior.games * 0.2 + 16 * 0.8) * 10) / 10);
          }
          return Math.min(17, Math.round((prior.games * 0.6 + 16 * 0.4) * 10) / 10);
        }

        // ── Step 2: Aggregate prior-season TEAM totals ──
        interface TeamStats {
          passAtt: number; passComp: number; passYds: number; passTD: number; int: number;
          rushAtt: number; rushYds: number; rushTD: number;
          targets: number; receptions: number; recYds: number; recTD: number;
        }
        const priorTeamTotals = new Map<string, TeamStats>();
        for (const p of priorTotals) {
          if (!p.recent_team || !['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
          if (!priorTeamTotals.has(p.recent_team)) {
            priorTeamTotals.set(p.recent_team, {
              passAtt: 0, passComp: 0, passYds: 0, passTD: 0, int: 0,
              rushAtt: 0, rushYds: 0, rushTD: 0,
              targets: 0, receptions: 0, recYds: 0, recTD: 0,
            });
          }
          const t = priorTeamTotals.get(p.recent_team)!;
          t.passAtt += p.attempts || 0;
          t.passComp += p.completions || 0;
          t.passYds += p.passing_yards || 0;
          t.passTD += p.passing_tds || 0;
          t.int += p.interceptions || 0;
          t.rushAtt += p.carries || 0;
          t.rushYds += p.rushing_yards || 0;
          t.rushTD += p.rushing_tds || 0;
          t.targets += p.targets || 0;
          t.receptions += p.receptions || 0;
          t.recYds += p.receiving_yards || 0;
          t.recTD += p.receiving_tds || 0;
        }

        // League average team totals
        const leagueAvg: TeamStats = {
          passAtt: 0, passComp: 0, passYds: 0, passTD: 0, int: 0,
          rushAtt: 0, rushYds: 0, rushTD: 0,
          targets: 0, receptions: 0, recYds: 0, recTD: 0,
        };
        const nTeams = priorTeamTotals.size || 1;
        for (const t of priorTeamTotals.values()) {
          for (const k of Object.keys(leagueAvg) as (keyof TeamStats)[]) leagueAvg[k] += t[k];
        }
        for (const k of Object.keys(leagueAvg) as (keyof TeamStats)[]) leagueAvg[k] = Math.round(leagueAvg[k] / nTeams);

        // ── Step 3: Project team totals ──
        // Use ensemble projections (Ridge delta + LightGBM) when available,
        // with blend fallback for stats/teams not covered.
        const { teamWeight } = projectionConfig.winner;
        const leagueWeight = 1 - teamWeight;
        const ensembleTeams = (teamProjectionsEnsemble.season === PREDICT_SEASON
          ? teamProjectionsEnsemble.teams : null) as Record<string, Record<string, number>> | null;

        const projectedTeamTotals = new Map<string, TeamStats>();
        for (const [team, prior] of priorTeamTotals) {
          const blend: TeamStats = {} as TeamStats;
          for (const k of Object.keys(leagueAvg) as (keyof TeamStats)[]) {
            blend[k] = Math.round(prior[k] * teamWeight + leagueAvg[k] * leagueWeight);
          }
          const ep = ensembleTeams?.[team];
          if (ep) {
            // Use ensemble for volume stats, blend for the rest
            blend.passAtt    = ep.passAtt    ?? blend.passAtt;
            blend.rushAtt    = ep.rushAtt    ?? blend.rushAtt;
            blend.targets    = ep.targets    ?? blend.targets;
            blend.receptions = ep.receptions ?? blend.receptions;
            blend.passTD     = ep.passTD     ?? blend.passTD;
            blend.rushTD     = ep.rushTD     ?? blend.rushTD;
            blend.passYds    = ep.passYds    ?? blend.passYds;
            blend.rushYds    = ep.rushYds    ?? blend.rushYds;
            blend.recYds     = ep.recYds     ?? blend.recYds;
          }
          projectedTeamTotals.set(team, blend);
        }

        // Build projected team totals map for share display in team view
        const ptmMap = new Map<string, TeamTotalRow>();
        for (const [team, t] of projectedTeamTotals) {
          ptmMap.set(team, {
            team, passAtt: t.passAtt, passComp: t.passComp, passYds: t.passYds, passTD: t.passTD, int: t.int,
            rushAtt: t.rushAtt, rushYds: t.rushYds, rushTD: t.rushTD,
            tgt: t.targets, rec: t.receptions, recYds: t.recYds, recTD: t.recTD,
            pprPts: 0,
          });
        }

        // ── Step 3b: Compute per-team position pool shares from prior season ──
        // Instead of hardcoded "RBs get 88% of rush att", compute actual shares
        interface PosPoolShares {
          qbPassAtt: number; qbRushAtt: number; qbRushYds: number; qbRushTD: number;
          rbRushAtt: number; rbRushYds: number; rbRushTD: number; rbTgt: number; rbRecTD: number;
          wrTgt: number; wrRecTD: number; wrRushAtt: number; wrRushYds: number; wrRushTD: number;
          teTgt: number; teRecTD: number;
        }

        // Compute actual shares from prior-season player stats grouped by team+position
        function computePoolShares(team: string): PosPoolShares {
          const teamPlayers = priorTotals.filter(
            (p) => p.recent_team === team && ['QB', 'RB', 'WR', 'TE'].includes(p.position)
          );
          const teamRushAtt = teamPlayers.reduce((s, p) => s + (p.carries || 0), 0) || 1;
          const teamRushYds = teamPlayers.reduce((s, p) => s + (p.rushing_yards || 0), 0) || 1;
          const teamRushTD = teamPlayers.reduce((s, p) => s + (p.rushing_tds || 0), 0) || 1;
          const teamTgt = teamPlayers.reduce((s, p) => s + (p.targets || 0), 0) || 1;
          const teamRecTD = teamPlayers.reduce((s, p) => s + (p.receiving_tds || 0), 0) || 1;
          const teamPassAtt = teamPlayers.reduce((s, p) => s + (p.attempts || 0), 0) || 1;

          const byPos = (pos: string) => teamPlayers.filter((p) => p.position === pos);

          const qbs = byPos('QB');
          const rbPlayers = byPos('RB');
          const wrPlayers = byPos('WR');
          const tePlayers = byPos('TE');

          return {
            qbPassAtt: qbs.reduce((s, p) => s + (p.attempts || 0), 0) / teamPassAtt,
            qbRushAtt: qbs.reduce((s, p) => s + (p.carries || 0), 0) / teamRushAtt,
            qbRushYds: qbs.reduce((s, p) => s + (p.rushing_yards || 0), 0) / teamRushYds,
            qbRushTD: qbs.reduce((s, p) => s + (p.rushing_tds || 0), 0) / teamRushTD,
            rbRushAtt: rbPlayers.reduce((s, p) => s + (p.carries || 0), 0) / teamRushAtt,
            rbRushYds: rbPlayers.reduce((s, p) => s + (p.rushing_yards || 0), 0) / teamRushYds,
            rbRushTD: rbPlayers.reduce((s, p) => s + (p.rushing_tds || 0), 0) / teamRushTD,
            rbTgt: rbPlayers.reduce((s, p) => s + (p.targets || 0), 0) / teamTgt,
            rbRecTD: rbPlayers.reduce((s, p) => s + (p.receiving_tds || 0), 0) / teamRecTD,
            wrTgt: wrPlayers.reduce((s, p) => s + (p.targets || 0), 0) / teamTgt,
            wrRecTD: wrPlayers.reduce((s, p) => s + (p.receiving_tds || 0), 0) / teamRecTD,
            wrRushAtt: wrPlayers.reduce((s, p) => s + (p.carries || 0), 0) / teamRushAtt,
            wrRushYds: wrPlayers.reduce((s, p) => s + (p.rushing_yards || 0), 0) / teamRushYds,
            wrRushTD: wrPlayers.reduce((s, p) => s + (p.rushing_tds || 0), 0) / teamRushTD,
            teTgt: tePlayers.reduce((s, p) => s + (p.targets || 0), 0) / teamTgt,
            teRecTD: tePlayers.reduce((s, p) => s + (p.receiving_tds || 0), 0) / teamRecTD,
          };
        }

        // League-average position pool shares (fallback / regression target)
        const leaguePoolShares: PosPoolShares = {
          qbPassAtt: 0, qbRushAtt: 0, qbRushYds: 0, qbRushTD: 0,
          rbRushAtt: 0, rbRushYds: 0, rbRushTD: 0, rbTgt: 0, rbRecTD: 0,
          wrTgt: 0, wrRecTD: 0, wrRushAtt: 0, wrRushYds: 0, wrRushTD: 0,
          teTgt: 0, teRecTD: 0,
        };
        const teamsWithShares: PosPoolShares[] = [];
        for (const team of priorTeamTotals.keys()) {
          const shares = computePoolShares(team);
          teamsWithShares.push(shares);
        }
        if (teamsWithShares.length > 0) {
          for (const k of Object.keys(leaguePoolShares) as (keyof PosPoolShares)[]) {
            leaguePoolShares[k] = teamsWithShares.reduce((s, t) => s + t[k], 0) / teamsWithShares.length;
          }
        }

        // ── Step 3c: Detect coaching changes & carry over coach tendencies ──
        // Build team ↔ coach maps for prior and current seasons
        const priorSeasonGames = gamesData.filter(
          (g) => g.season === PREDICT_SEASON - 1 && g.game_type === 'REG'
        );
        const currentSeasonGames = gamesData.filter(
          (g) => g.season === PREDICT_SEASON && g.game_type === 'REG'
        );
        const priorCoach = new Map<string, string>(); // team → coach last season
        const coachPriorTeam = new Map<string, string>(); // coach → team last season
        for (const g of priorSeasonGames) {
          if (g.home_coach) {
            priorCoach.set(g.home_team, g.home_coach);
            coachPriorTeam.set(g.home_coach, g.home_team);
          }
          if (g.away_coach) {
            priorCoach.set(g.away_team, g.away_coach);
            coachPriorTeam.set(g.away_coach, g.away_team);
          }
        }
        const currentCoach = new Map<string, string>(); // team → coach this season
        for (const g of currentSeasonGames) {
          if (g.home_coach) currentCoach.set(g.home_team, g.home_coach);
          if (g.away_coach) currentCoach.set(g.away_team, g.away_coach);
        }

        // Identify coaching changes and where the new coach came from
        // coachOriginTeam: for teams with new HC, the team that coach ran last year
        const coachChangedTeams = new Set<string>();
        const coachOriginTeam = new Map<string, string>(); // new team → coach's old team
        for (const [team, coach] of currentCoach) {
          const prev = priorCoach.get(team);
          if (prev && prev !== coach) {
            coachChangedTeams.add(team);
            // Where did this coach come from?
            const origin = coachPriorTeam.get(coach);
            if (origin && origin !== team) {
              coachOriginTeam.set(team, origin);
            }
          }
        }

        // Blend pool shares:
        // Same coach:  75% team + 25% league
        // New coach (promoted/first-time): 35% team + 65% league
        // New coach from another team: 30% team + 40% coach's old team + 30% league
        function getTeamPools(team: string): PosPoolShares {
          const teamShares = computePoolShares(team);

          if (!coachChangedTeams.has(team)) {
            // Same coach — mostly preserve team tendencies
            const blended: PosPoolShares = {} as PosPoolShares;
            for (const k of Object.keys(leaguePoolShares) as (keyof PosPoolShares)[]) {
              blended[k] = teamShares[k] * 0.75 + leaguePoolShares[k] * 0.25;
            }
            return blended;
          }

          const origin = coachOriginTeam.get(team);
          if (origin) {
            // New coach from another team — blend in his old team's tendencies
            const coachShares = computePoolShares(origin);
            const blended: PosPoolShares = {} as PosPoolShares;
            for (const k of Object.keys(leaguePoolShares) as (keyof PosPoolShares)[]) {
              blended[k] = teamShares[k] * 0.30 + coachShares[k] * 0.40 + leaguePoolShares[k] * 0.30;
            }
            return blended;
          }

          // New coach but no prior HC record (promoted coordinator / first-time HC)
          const blended: PosPoolShares = {} as PosPoolShares;
          for (const k of Object.keys(leaguePoolShares) as (keyof PosPoolShares)[]) {
            blended[k] = teamShares[k] * 0.35 + leaguePoolShares[k] * 0.65;
          }
          return blended;
        }

        // ── Step 4: Build player roster for each team ──
        // Collect all players we'll project: ADP players + roster fill-ins
        interface PlayerCandidate {
          name: string; team: string; position: Position; adp: number;
          prior: SeasonTotals | undefined;
        }

        const candidatesByTeamPos = new Map<string, PlayerCandidate[]>();
        function tpKey(team: string, pos: string) { return `${team}:${pos}`; }
        function ensureList(key: string) {
          if (!candidatesByTeamPos.has(key)) candidatesByTeamPos.set(key, []);
          return candidatesByTeamPos.get(key)!;
        }

        const addedNames = new Set<string>();

        // First pass: ADP players (have draft capital / expected starters).
        // Cap matches MAX_ADP=400 from precompute-features so every player we
        // publish predictions for also appears in the projection tables.
        for (const adp of adpData) {
          if (!POSITIONS.includes(adp.position as Position)) continue;
          if (adp.adp > 400) continue;
          const nn = normalizeName(adp.name);
          const team = rosterTeam.get(nn) || adp.team || '';
          if (!team) continue;
          const prior = priorByName.get(nn);
          ensureList(tpKey(team, adp.position)).push({
            name: adp.name, team, position: adp.position as Position,
            adp: adp.adp, prior,
          });
          addedNames.add(nn);
        }

        // Second pass: rostered players not in ADP. Rookies land here
        // because community ADP doesn't price them yet — assign a synthetic
        // ADP based on draft pick + position so high-pick rookies sort
        // ahead of vet bench pieces (Mendoza R1 #1 LV ahead of Aidan O'Connell,
        // Jeremiyah Love R1 #3 ARI ahead of Trey Benson, etc.). Without
        // this, every drafted rookie sorts to ADP 999 and gets the depth-
        // piece projection branch downstream.
        function syntheticRookieAdp(name: string, pos: string): number {
          const draft = draftByName.get(name);
          if (!draft || draft.season !== PREDICT_SEASON) return 999;
          const pick = draft.pick || 999;
          if (pos === 'RB') {
            if (pick <= 32)  return 50;
            if (pick <= 64)  return 100;
            if (pick <= 100) return 150;
            return 200;
          }
          if (pos === 'WR') {
            if (pick <= 16)  return 30;
            if (pick <= 32)  return 70;
            if (pick <= 64)  return 130;
            if (pick <= 100) return 180;
            return 230;
          }
          if (pos === 'TE') {
            if (pick <= 16)  return 60;
            if (pick <= 32)  return 110;
            if (pick <= 64)  return 170;
            return 220;
          }
          if (pos === 'QB') {
            if (pick <= 3)   return 80;
            if (pick <= 15)  return 150;
            if (pick <= 32)  return 220;
            return 280;
          }
          return 999;
        }
        for (const r of rosters) {
          if (!POSITIONS.includes(r.position as Position)) continue;
          const nn = normalizeName(r.full_name);
          if (addedNames.has(nn)) continue;
          const prior = priorByName.get(nn);
          ensureList(tpKey(r.team, r.position)).push({
            name: r.full_name, team: r.team, position: r.position as Position,
            adp: syntheticRookieAdp(nn, r.position), prior,
          });
          addedNames.add(nn);
        }

        // Third pass: prior-season players not yet captured
        for (const p of priorTotals) {
          if (!POSITIONS.includes(p.position as Position)) continue;
          const nn = normalizeName(p.player_display_name);
          if (addedNames.has(nn)) continue;
          const team = rosterTeam.get(nn) || p.recent_team || '';
          if (!team) continue;
          ensureList(tpKey(team, p.position)).push({
            name: p.player_display_name, team, position: p.position as Position,
            adp: 999, prior: p,
          });
          addedNames.add(nn);
        }

        // Sort each team+pos group: by ADP (lower = better), then by prior PPR
        for (const [, list] of candidatesByTeamPos) {
          list.sort((a, b) => {
            if (a.adp !== b.adp) return a.adp - b.adp;
            const aPPR = a.prior ? (a.prior.fantasy_points_ppr || 0) : 0;
            const bPPR = b.prior ? (b.prior.fantasy_points_ppr || 0) : 0;
            return bPPR - aPPR;
          });
        }

        // ── Step 5: Compute shares & split the team pie ──
        const qbs: QBProjection[] = [];
        const rbs: RBProjection[] = [];
        const wrs: WRProjection[] = [];
        const tes: TEProjection[] = [];

        const allTeams = new Set<string>();
        for (const r of rosters) { if (r.team && POSITIONS.includes(r.position as Position)) allTeams.add(r.team); }
        for (const [team] of priorTeamTotals) allTeams.add(team);

        for (const team of allTeams) {
          const projTeam = projectedTeamTotals.get(team);
          if (!projTeam) continue;

          // Per-team position pool shares (computed from prior season + coach regression)
          const pools = getTeamPools(team);

          for (const pos of POSITIONS) {
            const players = (candidatesByTeamPos.get(tpKey(team, pos)) || []).slice(0, TEAM_POS_LIMITS[pos]);

            if (pos === 'QB') {
              // Rush share still uses prior-season tendencies (scrambling style varies by QB).
              const priorRushAttTotal = players.reduce((s, p, i) => {
                const car = p.prior?.carries || 0;
                const g = p.prior?.games ?? 17;
                return s + (i === 0 ? healthAdjust(car, g) : car);
              }, 0);
              const qbPassPool = projTeam.passAtt * pools.qbPassAtt;
              const qbRushPool = projTeam.rushAtt * pools.qbRushAtt;
              const qbRushTDPool = projTeam.rushTD * pools.qbRushTD;

              // Zero-sum QB games: starter gets projected games (health-adjusted), backup gets remainder to 17.
              // Players are sorted by ADP ascending, so players[0] is the starter.
              const starterProjected = players.length > 0 ? Math.round(projectGames(players[0].prior, true)) : 17;
              const starterGames = players.length === 1 ? 17 : Math.min(16, Math.max(1, starterProjected));

              // Track allocated pool so each subsequent QB fills the remainder,
              // guaranteeing QB totals always equal the team's projected passing budget.
              let allocatedPassAtt = 0;
              let allocatedPassTD = 0;
              let allocatedPassYds = 0;
              let allocatedRushAtt = 0;

              for (let idx = 0; idx < players.length; idx++) {
                const player = players[idx];
                const isPrimary = idx === 0;
                const prior = player.prior;
                const games = idx === 0 ? starterGames : 17 - starterGames;
                const gamesScale = games / 17;
                const sp = players[0]?.prior; // starter's prior — used for backup rate reference

                let passAtt: number, passComp: number, passYds: number, passTD: number, ints: number;
                let rushAtt: number, rushYds: number, rushTD: number;

                // High-pick rookie QBs (top 15) project as starters even
                // without prior NFL stats — Mendoza R1 #1 LV starts week 1
                // by every reasonable expectation. Treat them like the
                // starter branch but use rookie-typical efficiency rates.
                const rookieQbShare = rookieShare(normalizeName(player.name), 'QB');
                const isRookieStarter = isPrimary && (!prior || prior.games < 3) && rookieQbShare >= 0.5;
                if ((isPrimary && prior && prior.games >= 3) || isRookieStarter) {
                  // Starter throws ALL team passes in their games (no intra-game sharing with backup).
                  // Game allocation already encodes the time split, so no passShare multiplier needed.
                  passAtt = Math.round(qbPassPool * gamesScale);
                  const compRate = (prior?.attempts || 0) > 0 ? (prior!.completions || 0) / prior!.attempts : 0.62;
                  passComp = Math.round(passAtt * compRate);
                  // Anchor passYds to the team's projected passing yards so QB passYds
                  // reconcile with receiver recYds (same pool, gamesScale applied like receivers)
                  passYds = Math.round(projTeam.passYds * gamesScale);
                  // Anchor TDs to the team's projected receiving TD budget so QB passTDs
                  // reconcile with receiver recTDs (same pool, gamesScale applied like receivers)
                  passTD = Math.round(projTeam.recTD * gamesScale);
                  const intRate = (prior?.attempts || 0) > 0 ? (prior!.interceptions || 0) / prior!.attempts : 0.028;
                  ints = Math.round(passAtt * intRate);

                  const adjCar = prior ? healthAdjust(prior.carries || 0, prior.games) : 0;
                  // Rookie starters: assume moderate rush share (0.5 of QB rush
                  // pool) — rookies are often more mobile than vets but we
                  // don't want to overcommit without a usage signal.
                  const rushShare = priorRushAttTotal > 0
                    ? adjCar / priorRushAttTotal
                    : (isRookieStarter ? 0.5 : 0.5);
                  rushAtt = Math.round(qbRushPool * rushShare * gamesScale);
                  const ypc = (prior?.carries || 0) > 0 ? (prior!.rushing_yards || 0) / prior!.carries : 5.0;
                  rushYds = Math.round(rushAtt * ypc);
                  rushTD = Math.round(qbRushTDPool * rushShare * gamesScale);
                } else {
                  // Backup QB: fill remaining pool for exact reconciliation with team totals.
                  // Use starter's per-play efficiency rates (slightly discounted).
                  const compRate = sp && sp.attempts > 0 ? Math.min(0.68, (sp.completions || 0) / sp.attempts) : 0.60;
                  const intRate = sp && sp.attempts > 0 ? Math.max(0.025, ((sp.interceptions || 0) / sp.attempts) * 1.15) : 0.032;

                  passAtt = Math.max(0, Math.round(qbPassPool) - allocatedPassAtt);
                  passComp = Math.round(passAtt * compRate);
                  passYds = Math.max(0, Math.round(projTeam.passYds) - allocatedPassYds);
                  passTD = Math.max(0, Math.round(projTeam.recTD) - allocatedPassTD);
                  ints = Math.round(passAtt * intRate);

                  rushAtt = Math.max(0, Math.round(qbRushPool) - allocatedRushAtt);
                  rushYds = Math.round(rushAtt * 3.8);
                  rushTD = 0;
                }

                allocatedPassAtt += passAtt;
                allocatedPassTD += passTD;
                allocatedPassYds += passYds;
                allocatedRushAtt += rushAtt;

                const pts = computePPR({ passYds, passTD, int: ints, rushYds, rushTD });
                qbs.push({
                  name: player.name, team, adp: player.adp, games: Math.round(games),
                  passAtt, passComp, passYds, passTD, int: ints,
                  rushAtt, rushYds, rushTD, pprPts: Math.round(pts),
                });
              }
            } else if (pos === 'RB') {
              const priorRushTotal = players.reduce((s, p, i) => {
                const car = p.prior?.carries || 0;
                const g = p.prior?.games ?? 17;
                return s + (i === 0 ? healthAdjust(car, g) : car);
              }, 0);
              const priorTgtTotal = players.reduce((s, p, i) => {
                const tgt = p.prior?.targets || 0;
                const g = p.prior?.games ?? 17;
                return s + (i === 0 ? healthAdjust(tgt, g) : tgt);
              }, 0);
              // ML shares are team-wide fractions — use directly from team totals
              // Fall back to position-pool allocation when ML shares unavailable
              const rbRushPool = projTeam.rushAtt * pools.rbRushAtt;
              const rbTgtPool = projTeam.targets * pools.rbTgt;
              const rbRushTDPool = projTeam.rushTD * pools.rbRushTD;
              const rbRecTDPool = projTeam.recTD * pools.rbRecTD;

              // Prior-year within-group sums (for fallback allocation)
              const priorRushTotal2 = priorRushTotal;
              const priorTgtTotal2 = priorTgtTotal;

              const rbStart = rbs.length;

              for (let idx = 0; idx < players.length; idx++) {
                const player = players[idx];
                const isPrimary = idx === 0;
                const prior = player.prior;
                const games = projectGames(prior, isPrimary);
                const af = ageFactor(normalizeName(player.name), 'RB');
                const gamesScale = games / 17;

                let rushAtt: number, rushYds: number, rushTD: number;
                let tgt: number, rec: number, recYds: number, recTD: number;

                const ml = mlShares.get(normalizeName(player.name));

                if (prior && prior.games >= 3) {
                  // Rush: ML share directly from team totals, or fall back to pool
                  if (ml && ml.predRushShare > 0) {
                    rushAtt = Math.round(projTeam.rushAtt * ml.predRushShare * gamesScale);
                    rushTD = Math.max(0, Math.round(projTeam.rushTD * ml.predRushShare * gamesScale));
                  } else {
                    const adjCar = isPrimary ? healthAdjust(prior.carries || 0, prior.games) : (prior.carries || 0);
                    const rushShare = priorRushTotal2 > 0 ? adjCar / priorRushTotal2 : 1 / players.length;
                    rushAtt = Math.round(rbRushPool * rushShare * af * gamesScale);
                    rushTD = Math.max(0, Math.round(rbRushTDPool * rushShare * gamesScale));
                  }
                  const ypc = (prior.carries || 0) > 0 ? (prior.rushing_yards || 0) / prior.carries : 4.0;
                  rushYds = Math.round(rushAtt * ypc);

                  // Targets: ML share directly from team totals, or fall back to pool
                  if (ml && ml.predTargetShare > 0) {
                    tgt = Math.round(projTeam.targets * ml.predTargetShare * gamesScale);
                    recTD = Math.max(0, Math.round(projTeam.recTD * ml.predTargetShare));
                  } else {
                    const adjTgt = isPrimary ? healthAdjust(prior.targets || 0, prior.games) : (prior.targets || 0);
                    const tgtShare = priorTgtTotal2 > 0 ? adjTgt / priorTgtTotal2 : 1 / players.length;
                    tgt = Math.round(rbTgtPool * tgtShare * af * gamesScale);
                    recTD = Math.max(0, Math.round(rbRecTDPool * tgtShare));
                  }
                  const catchRate = (prior.targets || 0) > 0 ? (prior.receptions || 0) / prior.targets : 0.75;
                  rec = Math.round(tgt * catchRate);
                  const ypr = (prior.receptions || 0) > 0 ? (prior.receiving_yards || 0) / prior.receptions : 7.5;
                  recYds = Math.round(rec * ypr);
                } else {
                  // No prior NFL stats: 2026 rookies use draft-pick-based
                  // share; everyone else falls back to the depth-piece
                  // share. Rookie ypc is positional-typical (4.3); rookie
                  // ypr ~7.5 from college reception data.
                  const rs = rookieShare(normalizeName(player.name), 'RB');
                  const share = rs > 0 ? rs : 1 / (players.length * 4);
                  rushAtt = Math.round(rbRushPool * share * gamesScale);
                  const ypc = rs > 0 ? 4.3 : 3.8;
                  rushYds = Math.round(rushAtt * ypc);
                  rushTD = Math.max(0, Math.round(rbRushTDPool * share * gamesScale));
                  // Rookie target share scales down since RBs catch fewer
                  // passes than they run early in their careers.
                  const tgtShare = rs > 0 ? rs * 0.7 : share;
                  tgt = Math.round(rbTgtPool * tgtShare * gamesScale);
                  rec = Math.round(tgt * 0.72);
                  const ypr = rs > 0 ? 7.5 : 6.5;
                  recYds = Math.round(rec * ypr);
                  recTD = Math.max(0, Math.round(rbRecTDPool * tgtShare));
                }

                const pts = computePPR({ rushYds, rushTD, rec, recYds, recTD });
                rbs.push({
                  name: player.name, team, adp: player.adp, games: Math.round(games),
                  rushAtt, rushYds, rushTD, tgt, rec, recYds, recTD, pprPts: Math.round(pts),
                });
              }

              // Reconcile RB rushing to the projected pool. Per-player allocations
              // are shrunk by gamesScale and ageFactor without redistribution, which
              // consistently under-allocates team rushing. Also, per-player yards use
              // prior-year ypc which can fall below the team's projected ypc, so yards
              // must be scaled against the team's projected rushYds (not the attempts
              // ratio) to keep team totals in sync.
              const rbSlice = rbs.slice(rbStart);
              const rbAllocRushAtt = rbSlice.reduce((s, p) => s + p.rushAtt, 0);
              if (rbAllocRushAtt > 0 && rbAllocRushAtt < rbRushPool) {
                const attScale = rbRushPool / rbAllocRushAtt;
                for (const p of rbSlice) {
                  p.rushAtt = Math.round(p.rushAtt * attScale);
                  p.rushTD = Math.max(0, Math.round(p.rushTD * attScale));
                }
              }
              const rbRushYdsPool = projTeam.rushYds * pools.rbRushYds;
              const rbAllocRushYds = rbSlice.reduce((s, p) => s + p.rushYds, 0);
              if (rbAllocRushYds > 0 && rbAllocRushYds < rbRushYdsPool) {
                const ydsScale = rbRushYdsPool / rbAllocRushYds;
                for (const p of rbSlice) p.rushYds = Math.round(p.rushYds * ydsScale);
              }
              for (const p of rbSlice) {
                p.pprPts = Math.round(computePPR({
                  rushYds: p.rushYds, rushTD: p.rushTD,
                  rec: p.rec, recYds: p.recYds, recTD: p.recTD,
                }));
              }
            } else if (pos === 'WR') {
              const priorTgtTotal = players.reduce((s, p, i) => {
                const tgt = p.prior?.targets || 0;
                const g = p.prior?.games ?? 17;
                return s + (i === 0 ? healthAdjust(tgt, g) : tgt);
              }, 0);
              const priorRushTotal = players.reduce((s, p, i) => {
                const car = p.prior?.carries || 0;
                const g = p.prior?.games ?? 17;
                return s + (i === 0 ? healthAdjust(car, g) : car);
              }, 0);
              // Fallback pools (used when ML shares unavailable)
              const wrTgtPool = projTeam.targets * pools.wrTgt;
              const wrRushPool = projTeam.rushAtt * pools.wrRushAtt;
              const wrRecTDPool = projTeam.recTD * pools.wrRecTD;
              const wrRushTDPool = projTeam.rushTD * pools.wrRushTD;

              const wrStart = wrs.length;

              for (let idx = 0; idx < players.length; idx++) {
                const player = players[idx];
                const isPrimary = idx === 0;
                const prior = player.prior;
                const games = projectGames(prior, isPrimary);
                const af = ageFactor(normalizeName(player.name), 'WR');
                const gamesScale = games / 17;

                let tgt: number, rec: number, recYds: number, recTD: number;
                let rushAtt: number, rushYds: number, rushTD: number;

                const ml = mlShares.get(normalizeName(player.name));

                if (prior && prior.games >= 3) {
                  // Targets: ML share directly from team totals, or fall back to pool
                  if (ml && ml.predTargetShare > 0) {
                    tgt = Math.round(projTeam.targets * ml.predTargetShare * gamesScale);
                    recTD = Math.max(0, Math.round(projTeam.recTD * ml.predTargetShare));
                  } else {
                    const adjTgt = isPrimary ? healthAdjust(prior.targets || 0, prior.games) : (prior.targets || 0);
                    const tgtShare = priorTgtTotal > 0 ? adjTgt / priorTgtTotal : 1 / players.length;
                    tgt = Math.round(wrTgtPool * tgtShare * af * gamesScale);
                    recTD = Math.max(0, Math.round(wrRecTDPool * tgtShare));
                  }
                  const catchRate = (prior.targets || 0) > 0 ? (prior.receptions || 0) / prior.targets : 0.65;
                  rec = Math.round(tgt * catchRate);
                  const ypr = (prior.receptions || 0) > 0 ? (prior.receiving_yards || 0) / prior.receptions : 12.5;
                  recYds = Math.round(rec * ypr);

                  // Rush: WR rush shares are negligible, use prior-year pool allocation
                  const adjCar = isPrimary ? healthAdjust(prior.carries || 0, prior.games) : (prior.carries || 0);
                  const rushShare = priorRushTotal > 0 ? adjCar / priorRushTotal : 0;
                  rushAtt = Math.round(wrRushPool * rushShare * af * gamesScale);
                  const ypc = (prior.carries || 0) > 0 ? (prior.rushing_yards || 0) / prior.carries : 5.0;
                  rushYds = Math.round(rushAtt * ypc);
                  rushTD = Math.max(0, Math.round(wrRushTDPool * rushShare * gamesScale));
                } else {
                  // No prior NFL stats: 2026 rookies use draft-pick-based
                  // target share; vets without prior fall back to depth.
                  const rs = rookieShare(normalizeName(player.name), 'WR');
                  const share = rs > 0 ? rs : 1 / (players.length * 4);
                  tgt = Math.round(wrTgtPool * share * gamesScale);
                  rec = Math.round(tgt * 0.62);
                  const ypr = rs > 0 ? 12.0 : 11.0;
                  recYds = Math.round(rec * ypr);
                  recTD = Math.max(0, Math.round(wrRecTDPool * share));
                  rushAtt = 0; rushYds = 0; rushTD = 0;
                }

                const pts = computePPR({ rushYds, rushTD, rec, recYds, recTD });
                wrs.push({
                  name: player.name, team, adp: player.adp, games: Math.round(games),
                  tgt, rec, recYds, recTD, rushAtt, rushYds, rushTD, pprPts: Math.round(pts),
                });
              }

              // Reconcile WR rushing to the projected pool (same issue as RBs).
              const wrSlice = wrs.slice(wrStart);
              const wrAllocRushAtt = wrSlice.reduce((s, p) => s + p.rushAtt, 0);
              if (wrAllocRushAtt > 0 && wrAllocRushAtt < wrRushPool) {
                const attScale = wrRushPool / wrAllocRushAtt;
                for (const p of wrSlice) {
                  p.rushAtt = Math.round(p.rushAtt * attScale);
                  p.rushTD = Math.max(0, Math.round(p.rushTD * attScale));
                }
              }
              const wrRushYdsPool = projTeam.rushYds * pools.wrRushYds;
              const wrAllocRushYds = wrSlice.reduce((s, p) => s + p.rushYds, 0);
              if (wrAllocRushYds > 0 && wrAllocRushYds < wrRushYdsPool) {
                const ydsScale = wrRushYdsPool / wrAllocRushYds;
                for (const p of wrSlice) p.rushYds = Math.round(p.rushYds * ydsScale);
              }
              for (const p of wrSlice) {
                p.pprPts = Math.round(computePPR({
                  rushYds: p.rushYds, rushTD: p.rushTD,
                  rec: p.rec, recYds: p.recYds, recTD: p.recTD,
                }));
              }
            } else if (pos === 'TE') {
              const priorTgtTotal = players.reduce((s, p, i) => {
                const tgt = p.prior?.targets || 0;
                const g = p.prior?.games ?? 17;
                return s + (i === 0 ? healthAdjust(tgt, g) : tgt);
              }, 0);
              // Fallback pools
              const teTgtPool = projTeam.targets * pools.teTgt;
              const teRecTDPool = projTeam.recTD * pools.teRecTD;

              for (let idx = 0; idx < players.length; idx++) {
                const player = players[idx];
                const isPrimary = idx === 0;
                const prior = player.prior;
                const games = projectGames(prior, isPrimary);
                const af = ageFactor(normalizeName(player.name), 'TE');
                const gamesScale = games / 17;

                let tgt: number, rec: number, recYds: number, recTD: number;

                const ml = mlShares.get(normalizeName(player.name));

                if (prior && prior.games >= 3) {
                  // Targets: ML share directly from team totals, or fall back to pool
                  if (ml && ml.predTargetShare > 0) {
                    tgt = Math.round(projTeam.targets * ml.predTargetShare * gamesScale);
                    recTD = Math.max(0, Math.round(projTeam.recTD * ml.predTargetShare));
                  } else {
                    const adjTgt = isPrimary ? healthAdjust(prior.targets || 0, prior.games) : (prior.targets || 0);
                    const tgtShare = priorTgtTotal > 0 ? adjTgt / priorTgtTotal : 1 / players.length;
                    tgt = Math.round(teTgtPool * tgtShare * af * gamesScale);
                    recTD = Math.max(0, Math.round(teRecTDPool * tgtShare));
                  }
                  const catchRate = (prior.targets || 0) > 0 ? (prior.receptions || 0) / prior.targets : 0.68;
                  rec = Math.round(tgt * catchRate);
                  const ypr = (prior.receptions || 0) > 0 ? (prior.receiving_yards || 0) / prior.receptions : 11.0;
                  recYds = Math.round(rec * ypr);
                } else {
                  // No prior NFL stats: 2026 rookies use draft-pick-based
                  // target share; vets without prior fall back to depth.
                  const rs = rookieShare(normalizeName(player.name), 'TE');
                  const share = rs > 0 ? rs : 1 / (players.length * 4);
                  tgt = Math.round(teTgtPool * share * gamesScale);
                  rec = Math.round(tgt * 0.65);
                  const ypr = rs > 0 ? 10.5 : 9.5;
                  recYds = Math.round(rec * ypr);
                  recTD = Math.max(0, Math.round(teRecTDPool * share));
                }

                const pts = computePPR({ rec, recYds, recTD });
                tes.push({
                  name: player.name, team, adp: player.adp, games: Math.round(games),
                  tgt, rec, recYds, recTD, pprPts: Math.round(pts),
                });
              }
            }
          }
        }

        // Team-level reconciliation: normalize each team's rushing and receiving
        // totals across all its players to match the projected team totals.
        // Per-position pool reconciliation handles most of the gap, but
        // (a) pool shares can sum to slightly <1 due to blending, (b) some stats
        // are derived from per-player rates (ypc / ypr / catchRate) and never
        // tied to a team pool, (c) rounding drift compounds. This final pass
        // guarantees team totals match projections within rounding.
        for (const team of allTeams) {
          const projTeam = projectedTeamTotals.get(team);
          if (!projTeam) continue;

          const teamQbs = qbs.filter((p) => p.team === team);
          const teamRbs = rbs.filter((p) => p.team === team);
          const teamWrs = wrs.filter((p) => p.team === team);
          const teamTes = tes.filter((p) => p.team === team);
          const rushers = [...teamQbs, ...teamRbs, ...teamWrs];
          const receivers = [...teamRbs, ...teamWrs, ...teamTes];

          const scaleUpToMatch = <T extends object>(
            items: T[], key: keyof T, target: number,
          ) => {
            const total = items.reduce((s, p) => s + ((p[key] as unknown as number) || 0), 0);
            if (total <= 0 || Math.abs(total - target) <= 1) return;
            const scale = target / total;
            for (const p of items) {
              (p[key] as unknown as number) = Math.round(((p[key] as unknown as number) || 0) * scale);
            }
          };

          if (rushers.length > 0) {
            scaleUpToMatch(rushers, 'rushAtt', projTeam.rushAtt);
            scaleUpToMatch(rushers, 'rushYds', projTeam.rushYds);
          }
          if (receivers.length > 0) {
            scaleUpToMatch(receivers, 'tgt', projTeam.targets);
            scaleUpToMatch(receivers, 'rec', projTeam.receptions);
            scaleUpToMatch(receivers, 'recYds', projTeam.recYds);
          }

          // Refresh PPR points for everyone touched.
          for (const p of teamRbs) {
            p.pprPts = Math.round(computePPR({
              rushYds: p.rushYds, rushTD: p.rushTD,
              rec: p.rec, recYds: p.recYds, recTD: p.recTD,
            }));
          }
          for (const p of teamWrs) {
            p.pprPts = Math.round(computePPR({
              rushYds: p.rushYds, rushTD: p.rushTD,
              rec: p.rec, recYds: p.recYds, recTD: p.recTD,
            }));
          }
          for (const p of teamTes) {
            p.pprPts = Math.round(computePPR({
              rec: p.rec, recYds: p.recYds, recTD: p.recTD,
            }));
          }
          for (const p of teamQbs) {
            p.pprPts = Math.round(computePPR({
              passYds: p.passYds, passTD: p.passTD, int: p.int,
              rushYds: p.rushYds, rushTD: p.rushTD,
            }));
          }
        }

        // Sort by PPR points descending
        qbs.sort((a, b) => b.pprPts - a.pprPts);
        rbs.sort((a, b) => b.pprPts - a.pprPts);
        wrs.sort((a, b) => b.pprPts - a.pprPts);
        tes.sort((a, b) => b.pprPts - a.pprPts);

        if (!cancelled) {
          setQBProjections(qbs);
          setRBProjections(rbs);
          setWRProjections(wrs);
          setTEProjections(tes);
          setOddsSource(usingLiveOdds ? 'live' : 'historical');
          setProjTeamTotalsMap(ptmMap);
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
    for (const g of byTeam.values()) {
      g.qbs = g.qbs.sort((a, b) => b.pprPts - a.pprPts).slice(0, TEAM_POS_LIMITS.QB);
      g.rbs = g.rbs.sort((a, b) => b.pprPts - a.pprPts).slice(0, TEAM_POS_LIMITS.RB);
      g.wrs = g.wrs.sort((a, b) => b.pprPts - a.pprPts).slice(0, TEAM_POS_LIMITS.WR);
      g.tes = g.tes.sort((a, b) => b.pprPts - a.pprPts).slice(0, TEAM_POS_LIMITS.TE);
      g.totalPPR = [...g.qbs, ...g.rbs, ...g.wrs, ...g.tes].reduce((s, p) => s + p.pprPts, 0);
    }
    return [...byTeam.values()].sort((a, b) => b.totalPPR - a.totalPPR);
  }, [dispQbs, dispRbs, dispWrs, dispTes]);

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
        {!isActuals && (
          <button
            className={`scenario-builder-btn ${!isScenarioEmpty(scenario) ? 'active' : ''}`}
            onClick={() => setScenarioOpen(true)}
          >
            {!isScenarioEmpty(scenario) && <span className="scenario-active-dot" />}
            Scenarios
          </button>
        )}
      </div>

      {/* Team view */}
      {viewMode === 'team' && (
        <div style={{ marginBottom: 20 }}>
          <p style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 12 }}>
            Top {TEAM_POS_LIMITS.QB} QBs, {TEAM_POS_LIMITS.RB} RBs, {TEAM_POS_LIMITS.WR} WRs, {TEAM_POS_LIMITS.TE} TEs per team — sorted by combined PPR
          </p>
          {teamGroups.map((g, ti) => {
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

            function playerRow(pos: string, name: string, gm: number, pAtt: number, pComp: number, pYds: number, pTD: number, pInt: number, rAtt: number, rYds: number, rTD: number, tgt: number, rec: number, recYds: number, recTD: number, ppr: number) {
              return (
                <tr key={name}>
                  <td style={{ ...tdStyle, color: POS_COLORS[pos], fontWeight: 700 }}>{pos}</td>
                  <td style={{ ...tdStyle, minWidth: 130 }}><strong>{name}</strong></td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{gm}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{pAtt || ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{pComp || ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{pYds ? <>{pYds.toLocaleString()}<span style={shareStyle}>{pct(pYds, projTotal?.passYds)}</span></> : ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: pTD ? 700 : 400 }}>{pTD || ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: pInt ? '#ef4444' : undefined }}>{pInt || ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{rAtt ? <>{rAtt}<span style={shareStyle}>{pct(rAtt, projTotal?.rushAtt)}</span></> : ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{rYds ? rYds.toLocaleString() : ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: rTD ? 700 : 400 }}>{rTD || ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{tgt ? <>{tgt}<span style={shareStyle}>{pct(tgt, projTotal?.tgt)}</span></> : ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{rec || ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{recYds ? <>{recYds.toLocaleString()}<span style={shareStyle}>{pct(recYds, projTotal?.recYds)}</span></> : ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: recTD ? 700 : 400 }}>{recTD || ''}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: POS_COLORS[pos] }}>{ppr}</td>
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
                    {g.qbs.map((p) => playerRow('QB', p.name, p.games, p.passAtt, p.passComp, p.passYds, p.passTD, p.int, p.rushAtt, p.rushYds, p.rushTD, 0, 0, 0, 0, p.pprPts))}
                    {subtotalRow('QB Total', POS_COLORS.QB, sumQB)}
                    {g.rbs.map((p) => playerRow('RB', p.name, p.games, 0, 0, 0, 0, 0, p.rushAtt, p.rushYds, p.rushTD, p.tgt, p.rec, p.recYds, p.recTD, p.pprPts))}
                    {subtotalRow('RB Total', POS_COLORS.RB, sumRB)}
                    {g.wrs.map((p) => playerRow('WR', p.name, p.games, 0, 0, 0, 0, 0, p.rushAtt, p.rushYds, p.rushTD, p.tgt, p.rec, p.recYds, p.recTD, p.pprPts))}
                    {subtotalRow('WR Total', POS_COLORS.WR, sumWR)}
                    {g.tes.map((p) => playerRow('TE', p.name, p.games, 0, 0, 0, 0, 0, 0, 0, 0, p.tgt, p.rec, p.recYds, p.recTD, p.pprPts))}
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
                  {sortedTeamTotals.map((r, i) => (
                    <tr key={r.team} onClick={() => { setViewMode('team'); }} style={{ cursor: 'pointer' }}>
                      <td style={{ ...tdS, textAlign: 'center', color: 'var(--text-muted)' }}>{i + 1}</td>
                      <td style={{ ...tdS, textAlign: 'left', fontWeight: 700 }}>{r.team}</td>
                      <td style={tdS}>{r.passAtt.toLocaleString()}</td>
                      <td style={tdS}>{r.passComp.toLocaleString()}</td>
                      <td style={tdS}>{r.passYds.toLocaleString()}</td>
                      <td style={{ ...tdS, fontWeight: 700 }}>{r.passTD}</td>
                      <td style={{ ...tdS, color: '#ef4444' }}>{r.int}</td>
                      <td style={tdS}>{r.rushAtt.toLocaleString()}</td>
                      <td style={tdS}>{r.rushYds.toLocaleString()}</td>
                      <td style={{ ...tdS, fontWeight: 700 }}>{r.rushTD}</td>
                      <td style={tdS}>{r.tgt.toLocaleString()}</td>
                      <td style={tdS}>{r.rec.toLocaleString()}</td>
                      <td style={tdS}>{r.recYds.toLocaleString()}</td>
                      <td style={{ ...tdS, fontWeight: 700 }}>{r.recTD}</td>
                      <td style={{ ...tdS, fontWeight: 700, color: '#f59e0b' }}>{r.pprPts.toLocaleString()}</td>
                    </tr>
                  ))}
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
                  <td><strong>{p.name}</strong></td>
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
                  <td><strong>{p.name}</strong></td>
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
                  <td><strong>{p.name}</strong></td>
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
                  <td><strong>{p.name}</strong></td>
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

      {!isActuals && (
        <ScenarioBuilder
          open={scenarioOpen}
          onClose={() => setScenarioOpen(false)}
          projections={searchProjections}
          freeAgents={freeAgentList}
          scenario={scenario}
          onChange={(sc) => { setScenario(sc); onScenarioChange?.(sc); }}
        />
      )}
    </>
  );
}

