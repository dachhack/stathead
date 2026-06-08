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
}

export function computePpr(p: ClayPlayer): number {
  return (
    p.pass_yds * 0.04 + p.pass_td * 4 +
    p.rush_yds * 0.1 + p.rush_td * 6 +
    p.rec_yds * 0.1 + p.rec_td * 6 +
    p.rec
  );
}

let clayCache: ClayPlayer[] | null = null;

export async function loadClayProjections(): Promise<ClayPlayer[]> {
  if (clayCache) return clayCache;

  const [projRes, cwRes] = await Promise.all([
    fetch(`${import.meta.env.BASE_URL}data/clay-projections-2026.json`),
    fetch(`${import.meta.env.BASE_URL}data/player-crosswalk.json`),
  ]);
  if (!projRes.ok) return [];
  const projData = (await projRes.json()) as { players?: Record<string, unknown>[] };
  const players = projData.players ?? [];

  const sleeperByKey = new Map<string, string>();
  if (cwRes.ok) {
    const cw = (await cwRes.json()) as { players?: CrosswalkRec[] };
    for (const rec of cw.players ?? []) {
      if (rec.sleeper_id && rec.player_key) {
        sleeperByKey.set(rec.player_key, rec.sleeper_id);
      }
    }
  }

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
      sleeperId: sleeperByKey.get(String(p.player_key ?? '')) ?? null,
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
