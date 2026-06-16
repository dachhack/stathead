import { bust } from './buildHash';
export interface ConsensusPlayer {
  name: string;
  team: string;
  position: string;
  player_key: string;
  pos_rk: number;
  ff_pt: number;
  games: number;
  sleeperId: string | null;
  pass_yds: number;
  pass_td: number;
  rush_yds: number;
  rush_td: number;
  rec: number;
  rec_yds: number;
  rec_td: number;
  // Multiplier that rescales this player's PPR/custom score to the in-house
  // model's blended projection (redraft-projections.json). Set by
  // loadBlendedProjections; raw stat components are left untouched so detailed
  // stat displays stay sane. Undefined = no blend available (use raw Consensus).
  blendScale?: number;
}

interface CrosswalkRec {
  player_key: string;
  sleeper_id?: string;
  display_name?: string;
  position?: string;
}

const normName = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

export function computePpr(p: ConsensusPlayer): number {
  const raw = (
    p.pass_yds * 0.04 + p.pass_td * 4 +
    p.rush_yds * 0.1 + p.rush_td * 6 +
    p.rec_yds * 0.1 + p.rec_td * 6 +
    p.rec
  );
  return p.blendScale !== undefined ? raw * p.blendScale : raw;
}

export function computeCustomScore(p: ConsensusPlayer, scoring: Record<string, number>): number {
  const raw = (
    p.pass_yds * (scoring['pass_yd'] ?? 0.04) +
    p.pass_td * (scoring['pass_td'] ?? 4) +
    p.rush_yds * (scoring['rush_yd'] ?? 0.1) +
    p.rush_td * (scoring['rush_td'] ?? 6) +
    p.rec_yds * (scoring['rec_yd'] ?? 0.1) +
    p.rec_td * (scoring['rec_td'] ?? 6) +
    p.rec * (scoring['rec'] ?? 1)
  );
  // Scale proportionally toward the blended model total (the model has no stat
  // breakdown, so we keep Consensus's mix and match its PPR total).
  return p.blendScale !== undefined ? raw * p.blendScale : raw;
}

export interface OptimalLineup {
  starters: { player: ConsensusPlayer; slot: string; pts: number }[];
  bench: { player: ConsensusPlayer; pts: number }[];
  totalStarterPts: number;
}

const FLEX_ELIGIBLE = new Set(['RB', 'WR', 'TE']);
const SUPER_FLEX_ELIGIBLE = new Set(['QB', 'RB', 'WR', 'TE']);

export function computeOptimalLineup(
  allPlayers: ConsensusPlayer[],
  rosterPositions: string[],
  scoring: Record<string, number>,
): OptimalLineup {
  const scored = allPlayers.map((p) => ({ player: p, pts: computeCustomScore(p, scoring) }));
  scored.sort((a, b) => b.pts - a.pts);

  const slots = rosterPositions.filter((s) => s !== 'BN');
  const used = new Set<string>();
  const starters: { player: ConsensusPlayer; slot: string; pts: number }[] = [];

  // Fill fixed-position slots first (QB, RB, WR, TE)
  for (const slot of slots) {
    if (slot === 'FLEX' || slot === 'SUPER_FLEX' || slot === 'REC_FLEX') continue;
    const best = scored.find((s) => !used.has(s.player.player_key) && s.player.position === slot);
    if (best) {
      used.add(best.player.player_key);
      starters.push({ player: best.player, slot, pts: best.pts });
    }
  }

  // Fill FLEX slots
  for (const slot of slots) {
    if (slot !== 'FLEX' && slot !== 'REC_FLEX') continue;
    const eligible = slot === 'REC_FLEX' ? new Set(['WR', 'TE']) : FLEX_ELIGIBLE;
    const best = scored.find((s) => !used.has(s.player.player_key) && eligible.has(s.player.position));
    if (best) {
      used.add(best.player.player_key);
      starters.push({ player: best.player, slot, pts: best.pts });
    }
  }

  // Fill SUPER_FLEX slots
  for (const slot of slots) {
    if (slot !== 'SUPER_FLEX') continue;
    const best = scored.find((s) => !used.has(s.player.player_key) && SUPER_FLEX_ELIGIBLE.has(s.player.position));
    if (best) {
      used.add(best.player.player_key);
      starters.push({ player: best.player, slot, pts: best.pts });
    }
  }

  const bench = scored.filter((s) => !used.has(s.player.player_key));
  const totalStarterPts = starters.reduce((sum, s) => sum + s.pts, 0);

  return { starters, bench, totalStarterPts };
}

let consensusCache: ConsensusPlayer[] | null = null;

export async function loadConsensusProjections(): Promise<ConsensusPlayer[]> {
  if (consensusCache) return consensusCache;

  const [projRes, cwRes] = await Promise.all([
    fetch(bust(`${import.meta.env.BASE_URL}data/clay-projections-2026.json`)),
    fetch(bust(`${import.meta.env.BASE_URL}data/player-crosswalk.json`)),
  ]);

  // Resolve a projection's Sleeper id from the crosswalk. Prefer the record the
  // projection is keyed to, but if that record's position contradicts the
  // projection (e.g. the rookie WR Antonio Williams is keyed to the retired
  // RB's record), fall back to a UNIQUE name+position match — which points at
  // the correct split-out record.
  const recByKey = new Map<string, CrosswalkRec>();
  const sleeperByNamePos = new Map<string, string | null>(); // null = ambiguous
  if (cwRes.ok) {
    const cw = (await cwRes.json()) as { players?: CrosswalkRec[] };
    for (const rec of cw.players ?? []) {
      if (rec.player_key) recByKey.set(rec.player_key, rec);
      if (rec.sleeper_id && rec.display_name && rec.position) {
        const k = `${normName(rec.display_name)}|${rec.position}`;
        if (!sleeperByNamePos.has(k)) sleeperByNamePos.set(k, rec.sleeper_id);
        else if (sleeperByNamePos.get(k) !== rec.sleeper_id) sleeperByNamePos.set(k, null);
      }
    }
  }
  const resolveSleeper = (name: string, position: string, key: string): string | null => {
    const rec = recByKey.get(key);
    if (rec?.sleeper_id && (!rec.position || rec.position === position)) return rec.sleeper_id;
    const alt = sleeperByNamePos.get(`${normName(name)}|${position}`);
    if (alt) return alt;
    return rec?.sleeper_id ?? null;
  };

  // Mike Clay's projections are a paid product, so clay-projections-*.json is
  // gitignored and ABSENT from the public deploy (see .gitignore). When it's
  // missing we fall back to the shippable first-party season-projection base
  // (projection-base-2026.json) so projected points still render everywhere
  // (player-card rosters, waiver wire, league view) — never a blank column.
  const projData = projRes.ok
    ? ((await projRes.json()) as { players?: Record<string, unknown>[] })
    : null;
  if (!projData?.players?.length) {
    consensusCache = await loadBaseProjections(resolveSleeper);
    return consensusCache;
  }
  const players = projData.players;

  consensusCache = players
    .filter((p) => ['QB', 'RB', 'WR', 'TE'].includes(String(p.position ?? '')))
    .map((p) => ({
      name: String(p.name ?? ''),
      team: String(p.team ?? ''),
      position: String(p.position ?? ''),
      player_key: String(p.player_key ?? ''),
      pos_rk: Number(p.pos_rk) || 0,
      ff_pt: Number(p.ff_pt) || 0,
      games: Number(p.games) || 0,
      sleeperId: resolveSleeper(String(p.name ?? ''), String(p.position ?? ''), String(p.player_key ?? '')),
      pass_yds: Number(p.pass_yds) || 0,
      pass_td: Number(p.pass_td) || 0,
      rush_yds: Number(p.rush_yds) || 0,
      rush_td: Number(p.rush_td) || 0,
      rec: Number(p.rec) || 0,
      rec_yds: Number(p.rec_yds) || 0,
      rec_td: Number(p.rec_td) || 0,
    }));
  return consensusCache;
}

/**
 * Build ConsensusPlayer rows from the shippable season-projection base pool
 * (projection-base-2026.json) — the public-deploy fallback when Consensus is absent.
 * Stat components are real season totals, so computePpr and the scenario engine
 * (which needs the breakdown) both work; loadBlendedProjections then rescales
 * each to the redraft-projections.json consensus PPG just as it does for Consensus.
 */
async function loadBaseProjections(
  resolveSleeper: (name: string, position: string, key: string) => string | null,
): Promise<ConsensusPlayer[]> {
  let base: Record<string, Array<Record<string, unknown>>> | null = null;
  try {
    const r = await fetch(bust(`${import.meta.env.BASE_URL}data/projection-base-2026.json`));
    if (r.ok) base = await r.json();
  } catch { /* no shippable base either → empty (callers degrade gracefully) */ }
  if (!base) return [];

  const POS_ARRAYS: Array<[string, string]> = [['QB', 'qbs'], ['RB', 'rbs'], ['WR', 'wrs'], ['TE', 'tes']];
  const out: ConsensusPlayer[] = [];
  for (const [position, arrKey] of POS_ARRAYS) {
    for (const p of base[arrKey] ?? []) {
      const name = String(p.name ?? '');
      if (!name) continue;
      out.push({
        name,
        team: String(p.team ?? ''),
        position,
        player_key: '',
        pos_rk: 0,
        ff_pt: Number(p.pprPts) || 0,
        games: Number(p.games) || GAMES,
        sleeperId: resolveSleeper(name, position, ''),
        pass_yds: Number(p.passYds) || 0,
        pass_td: Number(p.passTD) || 0,
        rush_yds: Number(p.rushYds) || 0,
        rush_td: Number(p.rushTD) || 0,
        rec: Number(p.rec) || 0,
        rec_yds: Number(p.recYds) || 0,
        rec_td: Number(p.recTD) || 0,
      });
    }
  }
  return out;
}

const GAMES = 17;
const lastName = (name: string) =>
  normName((name.replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').trim().split(/\s+/).pop()) || name);

let blendedCache: ConsensusPlayer[] | null = null;

/**
 * Consensus projections rescaled to the in-house model's blended projection
 * (redraft-projections.json — the "Consensus" base shown on the Projections tab
 * and My Rankings). Sets `blendScale` so computePpr/computeCustomScore return the
 * blended total while leaving raw stat components intact. Players the model
 * doesn't carry keep raw Consensus. Use this — not loadConsensusProjections — anywhere we
 * display projected points, so we never ship raw Consensus.
 */
export async function loadBlendedProjections(): Promise<ConsensusPlayer[]> {
  if (blendedCache) return blendedCache;
  const consensus = await loadConsensusProjections();

  let model: { name?: unknown; position?: unknown; ppg?: unknown }[] = [];
  try {
    const r = await fetch(bust(`${import.meta.env.BASE_URL}data/redraft-projections.json`));
    if (r.ok) model = ((await r.json())?.players ?? []) as typeof model;
  } catch { /* fall through to raw Consensus */ }
  if (!model.length) { blendedCache = consensus; return consensus; }

  const ppgByName = new Map<string, number>();      // normName -> model PPG
  const ppgByLastPos = new Map<string, number>();   // lastName|pos -> model PPG (nickname fallback)
  for (const m of model) {
    const ppg = Number(m.ppg) || 0;
    const name = String(m.name ?? '');
    const pos = String(m.position ?? '');
    if (ppg <= 0 || !name) continue;
    ppgByName.set(normName(name), ppg);
    const k = `${lastName(name)}|${pos}`;
    if (!ppgByLastPos.has(k)) ppgByLastPos.set(k, ppg);
  }

  const rawPpr = (p: ConsensusPlayer) =>
    p.pass_yds * 0.04 + p.pass_td * 4 + p.rush_yds * 0.1 + p.rush_td * 6 + p.rec_yds * 0.1 + p.rec_td * 6 + p.rec;

  blendedCache = consensus.map((c) => {
    const ppg = ppgByName.get(normName(c.name)) ?? ppgByLastPos.get(`${lastName(c.name)}|${c.position}`);
    const base = rawPpr(c);
    if (ppg === undefined || base <= 0) return c; // model lacks player → raw Consensus
    return { ...c, blendScale: (ppg * GAMES) / base };
  });
  return blendedCache;
}

export function filterAvailable(
  players: ConsensusPlayer[],
  rosteredIds: Set<string>,
): ConsensusPlayer[] {
  return players.filter((p) => p.sleeperId && !rosteredIds.has(p.sleeperId));
}
