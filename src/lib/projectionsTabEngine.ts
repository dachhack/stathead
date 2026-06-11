/**
 * Projection-scenario engine shared between the Projections tab
 * (StatProjections) and My Rankings.
 *
 * `applyScenarioToProjections` is THE scenario math of the Projections
 * tab / Scenario Builder — it operates on the tab's real per-position
 * stat lines and is the source of truth for what a saved scenario
 * "means" in points. My Rankings consumes it (plus the cached base pool
 * below) so a selected scenario shows the exact same values the
 * scenario tool shows, rather than a synthetic re-derivation.
 *
 * The base pool is computed inside StatProjections from many live
 * sources (ADP, vegas lines, ML shares, depth charts...). Rather than
 * lifting that whole pipeline, StatProjections persists its computed
 * base here (`saveProjectionBase`) on every load, and other surfaces
 * read it back with `loadProjectionBase`.
 */

import type { ScenarioConfig } from '../types';

function normalizeName(name: string | null | undefined): string {
  if (!name) return '';
  return name.toLowerCase().replace(/[.']/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').replace(/\s+/g, ' ').trim();
}


// ── Projection interfaces ──

export interface QBProjection {
  name: string; team: string; adp: number; games: number;
  passAtt: number; passComp: number; passYds: number; passTD: number; int: number;
  rushAtt: number; rushYds: number; rushTD: number;
  pprPts: number;
}

export interface RBProjection {
  name: string; team: string; adp: number; games: number;
  rushAtt: number; rushYds: number; rushTD: number;
  tgt: number; rec: number; recYds: number; recTD: number;
  pprPts: number;
}

export interface WRProjection {
  name: string; team: string; adp: number; games: number;
  tgt: number; rec: number; recYds: number; recTD: number;
  rushAtt: number; rushYds: number; rushTD: number;
  pprPts: number;
}

export interface TEProjection {
  name: string; team: string; adp: number; games: number;
  tgt: number; rec: number; recYds: number; recTD: number;
  pprPts: number;
}

// PPR scoring
export function computePPR(p: {
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

export function applyScenarioToProjections(
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

  // Team stat adjustments — scale a specific team stat for the relevant players
  // (mirrors scenarioEngine.applyScenario step 2.75, on this projection path).
  const teamStatAdj = (sc.teamStatAdjustments ?? []).filter((a) => a.delta !== 0);
  if (teamStatAdj.length > 0) {
    const SDIO_TO_INT: Record<string, string> = {
      PassingAttempts: 'passAtt', PassingCompletions: 'passComp', PassingYards: 'passYds',
      PassingTouchdowns: 'passTD', PassingInterceptions: 'int',
      RushingAttempts: 'rushAtt', RushingYards: 'rushYds', RushingTouchdowns: 'rushTD',
      Receptions: 'rec', ReceivingYards: 'recYds', ReceivingTouchdowns: 'recTD',
    };
    const PASS = new Set(['passAtt', 'passComp', 'passYds', 'passTD', 'int']);
    const RUSH = new Set(['rushAtt', 'rushYds', 'rushTD']);
    const recomputeP = (o: Record<string, number>) => Math.round(computePPR({
      passYds: o.passYds || 0, passTD: o.passTD || 0, int: o.int || 0,
      rushYds: o.rushYds || 0, rushTD: o.rushTD || 0,
      rec: o.rec || 0, recYds: o.recYds || 0, recTD: o.recTD || 0,
    }));
    const scaleArr = <T extends { team: string; pprPts: number }>(arr: T[], team: string, field: string, f: number) => {
      arr.forEach((p, i) => {
        if (p.team !== team) return;
        const o = p as unknown as Record<string, number>;
        if (o[field] === undefined) return;
        const next = { ...(p as object), [field]: Math.round((o[field] || 0) * f) } as unknown as Record<string, number>;
        arr[i] = { ...next, pprPts: recomputeP(next) } as unknown as T;
      });
    };
    for (const adj of teamStatAdj) {
      const field = SDIO_TO_INT[adj.stat];
      if (!field) continue;
      const f = 1 + adj.delta / 100;
      if (PASS.has(field)) {
        scaleArr(adjQbs, adj.team, field, f);
      } else if (RUSH.has(field)) {
        scaleArr(adjQbs, adj.team, field, f); scaleArr(adjRbs, adj.team, field, f); scaleArr(adjWrs, adj.team, field, f);
      } else {
        scaleArr(adjRbs, adj.team, field, f); scaleArr(adjWrs, adj.team, field, f); scaleArr(adjTes, adj.team, field, f);
      }
    }
  }

  // Player availability — per-player games haircut (non-zero-sum).
  // Scale counting stats by games/17 and recompute pprPts. Mirrors the
  // PlayerAvailability lever in scenarioEngine.applyScenario; matched by name
  // (consistent with volumeOverrides above) since this path keys on names.
  const availByName = new Map<string, number>();
  for (const pa of (sc.playerAvailability ?? [])) {
    if (pa.games < 17) availByName.set(normalizeName(pa.playerName), pa.games / 17);
  }
  if (availByName.size > 0) {
    const hairQb = (p: QBProjection): QBProjection => {
      const f = availByName.get(normalizeName(p.name));
      if (f === undefined) return p;
      const passYds = Math.round(p.passYds * f), passTD = Math.round(p.passTD * f), int = Math.round(p.int * f);
      const rushYds = Math.round(p.rushYds * f), rushTD = Math.round(p.rushTD * f);
      return { ...p, passAtt: Math.round(p.passAtt * f), passComp: Math.round(p.passComp * f),
        passYds, passTD, int, rushAtt: Math.round(p.rushAtt * f), rushYds, rushTD,
        pprPts: Math.round(computePPR({ passYds, passTD, int, rushYds, rushTD })) };
    };
    const hairRb = (p: RBProjection): RBProjection => {
      const f = availByName.get(normalizeName(p.name));
      if (f === undefined) return p;
      const rushYds = Math.round(p.rushYds * f), rushTD = Math.round(p.rushTD * f);
      const rec = Math.round(p.rec * f), recYds = Math.round(p.recYds * f), recTD = Math.round(p.recTD * f);
      return { ...p, rushAtt: Math.round(p.rushAtt * f), rushYds, rushTD,
        tgt: Math.round(p.tgt * f), rec, recYds, recTD,
        pprPts: Math.round(computePPR({ rushYds, rushTD, rec, recYds, recTD })) };
    };
    const hairWr = (p: WRProjection): WRProjection => {
      const f = availByName.get(normalizeName(p.name));
      if (f === undefined) return p;
      const rec = Math.round(p.rec * f), recYds = Math.round(p.recYds * f), recTD = Math.round(p.recTD * f);
      const rushYds = Math.round(p.rushYds * f), rushTD = Math.round(p.rushTD * f);
      return { ...p, tgt: Math.round(p.tgt * f), rec, recYds, recTD,
        rushAtt: Math.round(p.rushAtt * f), rushYds, rushTD,
        pprPts: Math.round(computePPR({ rushYds, rushTD, rec, recYds, recTD })) };
    };
    const hairTe = (p: TEProjection): TEProjection => {
      const f = availByName.get(normalizeName(p.name));
      if (f === undefined) return p;
      const rec = Math.round(p.rec * f), recYds = Math.round(p.recYds * f), recTD = Math.round(p.recTD * f);
      return { ...p, tgt: Math.round(p.tgt * f), rec, recYds, recTD,
        pprPts: Math.round(computePPR({ rec, recYds, recTD })) };
    };
    adjQbs.forEach((p, i) => { adjQbs[i] = hairQb(p); });
    adjRbs.forEach((p, i) => { adjRbs[i] = hairRb(p); });
    adjWrs.forEach((p, i) => { adjWrs[i] = hairWr(p); });
    adjTes.forEach((p, i) => { adjTes[i] = hairTe(p); });
  }

  // Player stat overrides — set specific absolute counting stats (Roster
  // Editor "Stats" view). Matched by name; SDIO field names map to internal
  // fields. Applied before availability/points; points recompute.
  const statByName = new Map<string, Record<string, number>>();
  for (const so of (sc.statOverrides ?? [])) {
    const entry: Record<string, number> = {};
    const map: [string, string][] = [
      ['PassingAttempts', 'passAtt'], ['PassingCompletions', 'passComp'], ['PassingYards', 'passYds'],
      ['PassingTouchdowns', 'passTD'], ['PassingInterceptions', 'int'],
      ['RushingAttempts', 'rushAtt'], ['RushingYards', 'rushYds'], ['RushingTouchdowns', 'rushTD'],
      ['Targets', 'tgt'], ['Receptions', 'rec'], ['ReceivingYards', 'recYds'], ['ReceivingTouchdowns', 'recTD'],
    ];
    for (const [sdio, internal] of map) {
      const v = (so as unknown as Record<string, number | undefined>)[sdio];
      if (v !== undefined) entry[internal] = v;
    }
    if (Object.keys(entry).length) statByName.set(normalizeName(so.playerName), entry);
  }
  if (statByName.size > 0) {
    const num = (o: Record<string, number>, k: string, fallback: number) => (o[k] !== undefined ? o[k] : fallback);
    adjQbs.forEach((p, i) => {
      const o = statByName.get(normalizeName(p.name)); if (!o) return;
      const n = { ...p,
        passAtt: num(o, 'passAtt', p.passAtt), passComp: num(o, 'passComp', p.passComp), passYds: num(o, 'passYds', p.passYds),
        passTD: num(o, 'passTD', p.passTD), int: num(o, 'int', p.int),
        rushAtt: num(o, 'rushAtt', p.rushAtt), rushYds: num(o, 'rushYds', p.rushYds), rushTD: num(o, 'rushTD', p.rushTD) };
      adjQbs[i] = { ...n, pprPts: Math.round(computePPR({ passYds: n.passYds, passTD: n.passTD, int: n.int, rushYds: n.rushYds, rushTD: n.rushTD })) };
    });
    adjRbs.forEach((p, i) => {
      const o = statByName.get(normalizeName(p.name)); if (!o) return;
      const n = { ...p,
        rushAtt: num(o, 'rushAtt', p.rushAtt), rushYds: num(o, 'rushYds', p.rushYds), rushTD: num(o, 'rushTD', p.rushTD),
        tgt: num(o, 'tgt', p.tgt), rec: num(o, 'rec', p.rec), recYds: num(o, 'recYds', p.recYds), recTD: num(o, 'recTD', p.recTD) };
      adjRbs[i] = { ...n, pprPts: Math.round(computePPR({ rushYds: n.rushYds, rushTD: n.rushTD, rec: n.rec, recYds: n.recYds, recTD: n.recTD })) };
    });
    adjWrs.forEach((p, i) => {
      const o = statByName.get(normalizeName(p.name)); if (!o) return;
      const n = { ...p,
        tgt: num(o, 'tgt', p.tgt), rec: num(o, 'rec', p.rec), recYds: num(o, 'recYds', p.recYds), recTD: num(o, 'recTD', p.recTD),
        rushAtt: num(o, 'rushAtt', p.rushAtt), rushYds: num(o, 'rushYds', p.rushYds), rushTD: num(o, 'rushTD', p.rushTD) };
      adjWrs[i] = { ...n, pprPts: Math.round(computePPR({ rushYds: n.rushYds, rushTD: n.rushTD, rec: n.rec, recYds: n.recYds, recTD: n.recTD })) };
    });
    adjTes.forEach((p, i) => {
      const o = statByName.get(normalizeName(p.name)); if (!o) return;
      const n = { ...p, tgt: num(o, 'tgt', p.tgt), rec: num(o, 'rec', p.rec), recYds: num(o, 'recYds', p.recYds), recTD: num(o, 'recTD', p.recTD) };
      adjTes[i] = { ...n, pprPts: Math.round(computePPR({ rec: n.rec, recYds: n.recYds, recTD: n.recTD })) };
    });
  }

  // Player points overrides — set a player to an absolute PPR target.
  // Scale counting stats by target/current so columns stay consistent; matched
  // by name (consistent with the other overrides on this path). Non-zero-sum.
  const pointsByName = new Map<string, number>();
  for (const po of (sc.pointsOverrides ?? [])) {
    const n = normalizeName(po.playerName);
    // A manual stat line beats a PPR pin (mirrors scenarioEngine): the pin
    // would re-scale the user's exact stats straight back to its target.
    if (statByName.has(n)) continue;
    pointsByName.set(n, po.ppr);
  }
  if (pointsByName.size > 0) {
    const scaleQb = (p: QBProjection): QBProjection => {
      const t = pointsByName.get(normalizeName(p.name));
      if (t === undefined || p.pprPts <= 0) return p;
      const f = t / p.pprPts;
      return { ...p, passAtt: Math.round(p.passAtt * f), passComp: Math.round(p.passComp * f),
        passYds: Math.round(p.passYds * f), passTD: Math.round(p.passTD * f), int: Math.round(p.int * f),
        rushAtt: Math.round(p.rushAtt * f), rushYds: Math.round(p.rushYds * f), rushTD: Math.round(p.rushTD * f),
        pprPts: Math.round(t) };
    };
    const scaleRb = (p: RBProjection): RBProjection => {
      const t = pointsByName.get(normalizeName(p.name));
      if (t === undefined || p.pprPts <= 0) return p;
      const f = t / p.pprPts;
      return { ...p, rushAtt: Math.round(p.rushAtt * f), rushYds: Math.round(p.rushYds * f), rushTD: Math.round(p.rushTD * f),
        tgt: Math.round(p.tgt * f), rec: Math.round(p.rec * f), recYds: Math.round(p.recYds * f), recTD: Math.round(p.recTD * f),
        pprPts: Math.round(t) };
    };
    const scaleWr = (p: WRProjection): WRProjection => {
      const t = pointsByName.get(normalizeName(p.name));
      if (t === undefined || p.pprPts <= 0) return p;
      const f = t / p.pprPts;
      return { ...p, tgt: Math.round(p.tgt * f), rec: Math.round(p.rec * f), recYds: Math.round(p.recYds * f), recTD: Math.round(p.recTD * f),
        rushAtt: Math.round(p.rushAtt * f), rushYds: Math.round(p.rushYds * f), rushTD: Math.round(p.rushTD * f),
        pprPts: Math.round(t) };
    };
    const scaleTe = (p: TEProjection): TEProjection => {
      const t = pointsByName.get(normalizeName(p.name));
      if (t === undefined || p.pprPts <= 0) return p;
      const f = t / p.pprPts;
      return { ...p, tgt: Math.round(p.tgt * f), rec: Math.round(p.rec * f), recYds: Math.round(p.recYds * f), recTD: Math.round(p.recTD * f),
        pprPts: Math.round(t) };
    };
    adjQbs.forEach((p, i) => { adjQbs[i] = scaleQb(p); });
    adjRbs.forEach((p, i) => { adjRbs[i] = scaleRb(p); });
    adjWrs.forEach((p, i) => { adjWrs[i] = scaleWr(p); });
    adjTes.forEach((p, i) => { adjTes[i] = scaleTe(p); });
  }

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

  // Re-sort by adjusted points so the position table re-ranks to reflect the
  // scenario (e.g. a boosted/Clay-blended player climbs). The empty-scenario
  // path skips this function entirely and keeps the base sort.
  adjQbs.sort((a, b) => b.pprPts - a.pprPts);
  adjRbs.sort((a, b) => b.pprPts - a.pprPts);
  adjWrs.sort((a, b) => b.pprPts - a.pprPts);
  adjTes.sort((a, b) => b.pprPts - a.pprPts);

  return { qbs: adjQbs, rbs: adjRbs, wrs: adjWrs, tes: adjTes };
}

export { normalizeName as normalizeProjName };

// ── Cached base pool (cross-tab sharing) ──

export interface ProjectionBase {
  season: number;
  savedAt: string;
  qbs: QBProjection[];
  rbs: RBProjection[];
  wrs: WRProjection[];
  tes: TEProjection[];
}

const PROJ_BASE_KEY = 'stathead-projection-base';

/** Persist the Projections tab's computed base pool so other tabs can run
 *  scenarios against the exact same numbers. */
export function saveProjectionBase(base: Omit<ProjectionBase, 'savedAt'>): void {
  try {
    localStorage.setItem(PROJ_BASE_KEY, JSON.stringify({ ...base, savedAt: new Date().toISOString() }));
  } catch {
    // ignore quota / private-mode write failures
  }
}

export function loadProjectionBase(season: number): ProjectionBase | null {
  try {
    const raw = localStorage.getItem(PROJ_BASE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ProjectionBase;
    if (parsed?.season !== season || !Array.isArray(parsed.qbs)) return null;
    return parsed;
  } catch {
    return null;
  }
}
