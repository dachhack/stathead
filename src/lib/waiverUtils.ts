import { bust } from './buildHash';
export interface ClayPlayer {
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
}

interface CrosswalkRec {
  player_key: string;
  sleeper_id?: string;
  display_name?: string;
  position?: string;
}

const normName = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

export function computePpr(p: ClayPlayer): number {
  return (
    p.pass_yds * 0.04 + p.pass_td * 4 +
    p.rush_yds * 0.1 + p.rush_td * 6 +
    p.rec_yds * 0.1 + p.rec_td * 6 +
    p.rec
  );
}

export function computeCustomScore(p: ClayPlayer, scoring: Record<string, number>): number {
  return (
    p.pass_yds * (scoring['pass_yd'] ?? 0.04) +
    p.pass_td * (scoring['pass_td'] ?? 4) +
    p.rush_yds * (scoring['rush_yd'] ?? 0.1) +
    p.rush_td * (scoring['rush_td'] ?? 6) +
    p.rec_yds * (scoring['rec_yd'] ?? 0.1) +
    p.rec_td * (scoring['rec_td'] ?? 6) +
    p.rec * (scoring['rec'] ?? 1)
  );
}

export interface OptimalLineup {
  starters: { player: ClayPlayer; slot: string; pts: number }[];
  bench: { player: ClayPlayer; pts: number }[];
  totalStarterPts: number;
}

const FLEX_ELIGIBLE = new Set(['RB', 'WR', 'TE']);
const SUPER_FLEX_ELIGIBLE = new Set(['QB', 'RB', 'WR', 'TE']);

export function computeOptimalLineup(
  allPlayers: ClayPlayer[],
  rosterPositions: string[],
  scoring: Record<string, number>,
): OptimalLineup {
  const scored = allPlayers.map((p) => ({ player: p, pts: computeCustomScore(p, scoring) }));
  scored.sort((a, b) => b.pts - a.pts);

  const slots = rosterPositions.filter((s) => s !== 'BN');
  const used = new Set<string>();
  const starters: { player: ClayPlayer; slot: string; pts: number }[] = [];

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

let clayCache: ClayPlayer[] | null = null;

export async function loadClayProjections(): Promise<ClayPlayer[]> {
  if (clayCache) return clayCache;

  const [projRes, cwRes] = await Promise.all([
    fetch(bust(`${import.meta.env.BASE_URL}data/clay-projections-2026.json`)),
    fetch(bust(`${import.meta.env.BASE_URL}data/player-crosswalk.json`)),
  ]);
  if (!projRes.ok) return [];
  const projData = (await projRes.json()) as { players?: Record<string, unknown>[] };
  const players = projData.players ?? [];

  // Resolve a clay projection's Sleeper id from the crosswalk. Prefer the
  // record the projection is keyed to, but if that record's position
  // contradicts the projection (e.g. the rookie WR Antonio Williams is keyed to
  // the retired RB's record), fall back to a UNIQUE name+position match — which
  // points at the correct split-out record.
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

  clayCache = players
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
  return clayCache;
}

export function filterAvailable(
  players: ClayPlayer[],
  rosteredIds: Set<string>,
): ClayPlayer[] {
  return players.filter((p) => p.sleeperId && !rosteredIds.has(p.sleeperId));
}
