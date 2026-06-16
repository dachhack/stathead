/**
 * Precompute scenario-preset variants of the projections into a committed file
 * the MCP serves. Run with tsx:
 *
 *   tsx scripts/precompute-projection-presets.ts
 *
 * Output: public/data/redraft-projections-presets.json
 *   { season, generatedAt, note, presets: { <preset>: [ {name, position, ppg, recPG} ] } }
 *
 * Two classes of preset:
 *
 *  - "consensus": our in-house redraft PPG blended toward market consensus via
 *    internal per-position weights. Computed here at build time so only the
 *    derived (blended) numbers are committed — the raw consensus input is read
 *    locally and never leaves this script.
 *
 *  - The pool-dependent presets (rookie-optimistic, vet-optimistic,
 *    injury-skeptic, consensus-ml) run the REAL scenario engine over the
 *    exported Projections-tab base pool (public/data/projection-base-<season>.json,
 *    produced by the "Export base pool" button on the Projections tab). They are
 *    emitted only when that file is present, so there is zero numeric drift:
 *    we transform the site's exact pool rather than re-deriving it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SCENARIO_PRESETS, type PresetMeta, type PlayerMeta, type ConsensusStats, type PresetContext } from '../src/lib/scenarioPresets';
import { applyScenarioToProjections, normalizeProjName, type QBProjection, type RBProjection, type WRProjection, type TEProjection } from '../src/lib/projectionsTabEngine';
import type { SDIOProjection } from '../src/types';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'public/data');
const REDRAFT = path.join(DATA, 'redraft-projections.json');
const OUT = path.join(DATA, 'redraft-projections-presets.json');

interface PresetPlayer { name: string; position: string; ppg: number; recPG: number }

const CONSENSUS_WEIGHT: Record<string, number> = { QB: 0.75, RB: 0.75, WR: 0.55, TE: 0.85 };
const CONSENSUS_WEIGHT_DEFAULT = 0.7;

function loadJson<T>(p: string): T { return JSON.parse(fs.readFileSync(p, 'utf8')) as T; }
function round1(v: number): number { return Math.round(v * 10) / 10; }
function round2(v: number): number { return Math.round(v * 100) / 100; }

// ── Consensus (PPR-level blend on the redraft model) ─────────────────
function buildConsensus(
  redraft: { players: PresetPlayer[] },
  consensusDoc: { players: { name: string; ff_pt: number; games?: number }[] },
): { out: PresetPlayer[]; blended: number } {
  const consensusPpgByName = new Map<string, number>();
  for (const p of consensusDoc.players) {
    const ff = Number(p.ff_pt);
    const g = Number(p.games) > 0 ? Number(p.games) : 17;
    if (Number.isFinite(ff)) consensusPpgByName.set(normalizeProjName(p.name), ff / g);
  }
  let blended = 0;
  const out = redraft.players.map((p) => {
    const ours = Number(p.ppg);
    const consensusPpg = consensusPpgByName.get(normalizeProjName(p.name));
    if (!Number.isFinite(ours) || consensusPpg === undefined || consensusPpg <= 0) {
      return { name: p.name, position: p.position, ppg: p.ppg, recPG: p.recPG };
    }
    const w = CONSENSUS_WEIGHT[p.position] ?? CONSENSUS_WEIGHT_DEFAULT;
    blended++;
    return { name: p.name, position: p.position, ppg: round1(w * consensusPpg + (1 - w) * ours), recPG: p.recPG };
  });
  return { out, blended };
}

// ── Pool-dependent presets (real engine over the exported base pool) ──
interface BasePool {
  season: number;
  qbs: QBProjection[]; rbs: RBProjection[]; wrs: WRProjection[]; tes: TEProjection[];
  meta: ({ key: string } & PlayerMeta)[];
}

// Mirror of StatProjections.buildSearchProjections — the SDIOProjection[] view
// the preset factories search over.
function buildSdio(pool: BasePool): SDIOProjection[] {
  const zero = {
    PassingAttempts: 0, PassingCompletions: 0, PassingYards: 0, PassingTouchdowns: 0,
    PassingInterceptions: 0, RushingAttempts: 0, RushingYards: 0, RushingTouchdowns: 0,
    Targets: 0, Receptions: 0, ReceivingYards: 0, ReceivingTouchdowns: 0,
    FumblesLost: 0, FieldGoalsMade: 0, ExtraPointsMade: 0,
  };
  let id = 1;
  const out: SDIOProjection[] = [];
  for (const p of pool.qbs) out.push({ ...zero, PlayerID: id++, Name: p.name, Team: p.team, Position: 'QB', FantasyPoints: p.pprPts - 5, FantasyPointsPPR: p.pprPts, PassingAttempts: p.passAtt, PassingCompletions: p.passComp, PassingYards: p.passYds, PassingTouchdowns: p.passTD, PassingInterceptions: p.int, RushingAttempts: p.rushAtt, RushingYards: p.rushYds, RushingTouchdowns: p.rushTD } as SDIOProjection);
  for (const p of pool.rbs) out.push({ ...zero, PlayerID: id++, Name: p.name, Team: p.team, Position: 'RB', FantasyPoints: p.pprPts - 5, FantasyPointsPPR: p.pprPts, RushingAttempts: p.rushAtt, RushingYards: p.rushYds, RushingTouchdowns: p.rushTD, Targets: p.tgt, Receptions: p.rec, ReceivingYards: p.recYds, ReceivingTouchdowns: p.recTD } as SDIOProjection);
  for (const p of pool.wrs) out.push({ ...zero, PlayerID: id++, Name: p.name, Team: p.team, Position: 'WR', FantasyPoints: p.pprPts - 5, FantasyPointsPPR: p.pprPts, Targets: p.tgt, Receptions: p.rec, ReceivingYards: p.recYds, ReceivingTouchdowns: p.recTD, RushingAttempts: p.rushAtt, RushingYards: p.rushYds, RushingTouchdowns: p.rushTD } as SDIOProjection);
  for (const p of pool.tes) out.push({ ...zero, PlayerID: id++, Name: p.name, Team: p.team, Position: 'TE', FantasyPoints: p.pprPts - 5, FantasyPointsPPR: p.pprPts, Targets: p.tgt, Receptions: p.rec, ReceivingYards: p.recYds, ReceivingTouchdowns: p.recTD } as SDIOProjection);
  return out;
}

function toPpg<T extends { name: string; games: number; pprPts: number }>(arr: T[], position: string, hasRec: boolean): PresetPlayer[] {
  return arr.map((p) => {
    const g = p.games > 0 ? p.games : 17;
    const rec = hasRec ? ((p as unknown as { rec?: number }).rec ?? 0) : 0;
    return { name: p.name, position, ppg: round1(p.pprPts / g), recPG: hasRec ? round2(rec / g) : 0 };
  });
}

// Consensus-informed context for the consensus-ml preset, built from the committed
// consensus input. Only the blended OUTPUT is surfaced downstream.
function buildConsensusContext(consensusDoc: { players: Record<string, number | string>[] } | null): PresetContext | undefined {
  if (!consensusDoc) return undefined;
  const consensusStats = new Map<string, ConsensusStats>();
  const consensusPpr = new Map<string, number>();
  for (const p of consensusDoc.players) {
    const key = normalizeProjName(String(p.name));
    const ppr = Number(p.ff_pt);
    if (Number.isFinite(ppr)) consensusPpr.set(key, ppr);
    consensusStats.set(key, {
      position: String(p.position), pos_rk: Number(p.pos_rk) || 0,
      pass_yds: Number(p.pass_yds) || undefined, pass_td: Number(p.pass_td) || undefined, pass_int: Number(p.pass_int) || undefined,
      rush_yds: Number(p.rush_yds) || undefined, rush_td: Number(p.rush_td) || undefined,
      rec: Number(p.rec) || undefined, rec_yds: Number(p.rec_yds) || undefined, rec_td: Number(p.rec_td) || undefined,
      ppr: Number.isFinite(ppr) ? ppr : 0,
    });
  }
  return { consensusPpr, consensusStats };
}

// preset id -> committed key
const POOL_PRESETS: Record<string, string> = {
  'preset-rookie-optimistic': 'rookie-optimistic',
  'preset-vet-optimistic': 'vet-optimistic',
  'preset-injury-skeptic': 'injury-skeptic',
  'preset-consensus-ml': 'consensus-ml',
};

function buildPoolPresets(pool: BasePool, consensusDoc: { players: Record<string, number | string>[] } | null): Record<string, PresetPlayer[]> {
  const sdio = buildSdio(pool);
  const meta: PresetMeta = new Map();
  for (const m of pool.meta) meta.set(m.key, { isRookie: m.isRookie, yearsExp: m.yearsExp, age: m.age, priorGames: m.priorGames });
  const ctx = buildConsensusContext(consensusDoc);
  const result: Record<string, PresetPlayer[]> = {};
  for (const preset of SCENARIO_PRESETS) {
    const key = POOL_PRESETS[preset.id];
    if (!key) continue;
    if (preset.requiresConsensus && (!ctx || ctx.consensusStats?.size === 0)) continue;
    const sc = preset.build(sdio, meta, normalizeProjName, ctx);
    const { qbs, rbs, wrs, tes } = applyScenarioToProjections(pool.qbs, pool.rbs, pool.wrs, pool.tes, sc);
    result[key] = [
      ...toPpg(qbs, 'QB', false),
      ...toPpg(rbs, 'RB', true),
      ...toPpg(wrs, 'WR', true),
      ...toPpg(tes, 'TE', true),
    ];
  }
  return result;
}

function main() {
  const redraft = loadJson<{ season: number; players: PresetPlayer[] }>(REDRAFT);
  const consensusPath = path.join(DATA, `clay-projections-${redraft.season}.json`);
  const consensusDoc = fs.existsSync(consensusPath) ? loadJson<{ players: Record<string, number | string>[] }>(consensusPath) : null;

  const presets: Record<string, PresetPlayer[]> = {};

  // consensus — redraft PPR blend (no pool needed)
  if (consensusDoc) {
    const { out, blended } = buildConsensus(redraft, consensusDoc as { players: { name: string; ff_pt: number; games?: number }[] });
    presets.consensus = out;
    console.log(`  consensus: ${out.length} players (${blended} blended)`);
  } else {
    console.log('  consensus: skipped (no consensus input found)');
  }

  // pool-dependent presets — real engine over the exported base pool
  const basePath = path.join(DATA, `projection-base-${redraft.season}.json`);
  if (fs.existsSync(basePath)) {
    const pool = loadJson<BasePool>(basePath);
    const poolPresets = buildPoolPresets(pool, consensusDoc as { players: Record<string, number | string>[] } | null);
    for (const [k, v] of Object.entries(poolPresets)) {
      presets[k] = v;
      console.log(`  ${k}: ${v.length} players (engine over exported pool)`);
    }
  } else {
    console.log(`  pool presets: skipped (no ${path.basename(basePath)} — use the Projections tab "Export base pool" button)`);
  }

  const result = {
    season: redraft.season,
    generatedAt: new Date().toISOString(),
    note: 'Preset-adjusted projections. Derived StatHead outputs only — consensus/consensus-ml blend our projection toward market consensus via internal weights (not a raw feed); rookie/vet/injury presets are the scenario engine run over our season-projection pool.',
    presets,
  };
  fs.writeFileSync(OUT, JSON.stringify(result) + '\n');
  console.log(`Wrote ${OUT} with presets: ${Object.keys(presets).join(', ')}`);
}

main();
