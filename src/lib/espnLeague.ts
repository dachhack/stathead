/**
 * ESPN fantasy league import — the same LeagueImport shape the Sleeper
 * import produces, so the Trade Finisher and Swap Meet work off either.
 *
 * ESPN's league API is not CORS-open, so the call goes through
 * workers/espn-news-proxy (`/league/<season>/<id>`), which slims the payload.
 * Public leagues load with nothing else; a private league needs the manager's
 * own espn_s2 + SWID cookies, sent as request headers and forwarded upstream
 * once — the worker never stores them and never caches a credentialed reply.
 *
 * Players are resolved through the crosswalk by ESPN id, so a roster entry
 * gets the Sleeper id the rest of the app keys on (projections, headshots,
 * dynasty values); a player the crosswalk does not know keeps an `espn:<id>`
 * id and still prices by name. ESPN exposes no future draft picks, so an
 * ESPN league's picks are each team's own (nothing traded) — see the note
 * the finisher shows.
 */

import { loadCrosswalk, lookupByEspnId } from './playerLookup';
import type { LeagueImport, LeagueTeam, RosterPlayer, SleeperLeagueInfo } from './sleeper';

const PROXY: string = import.meta.env?.VITE_ESPN_NEWS_PROXY ?? 'https://espn-news-proxy.dachhack.workers.dev';

export interface EspnCredentials { s2: string; swid: string }

// ESPN lineup slot ids → Sleeper-style roster position labels.
const SLOT: Record<number, string> = {
  0: 'QB', 1: 'TQB', 2: 'RB', 3: 'WRRB_FLEX', 4: 'WR', 5: 'REC_FLEX', 6: 'TE', 7: 'SUPER_FLEX',
  8: 'DT', 9: 'DE', 10: 'LB', 11: 'DL', 12: 'CB', 13: 'S', 14: 'DB', 15: 'IDP_FLEX',
  16: 'DEF', 17: 'K', 18: 'P', 19: 'HC', 20: 'BN', 21: 'IR', 23: 'FLEX', 24: 'EDR',
};
// ESPN default position ids → positions.
const POS: Record<number, string> = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 7: 'P', 9: 'DT', 10: 'DE', 11: 'LB', 12: 'CB', 13: 'S', 16: 'DEF' };
// ESPN pro team ids → the abbreviations the app uses (Sleeper's).
const TEAM: Record<number, string> = {
  1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC',
  13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT',
  24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU',
};
// ESPN stat ids → the Sleeper scoring keys the app's scorer reads.
const STAT: Record<number, string> = {
  3: 'pass_yd', 4: 'pass_td', 19: 'pass_2pt', 20: 'pass_int',
  24: 'rush_yd', 25: 'rush_td', 26: 'rush_2pt',
  42: 'rec_yd', 43: 'rec_td', 44: 'rec_2pt', 53: 'rec', 72: 'fum_lost',
};

interface SlimLeague {
  id: number; seasonId: number; scoringPeriodId: number;
  settings: {
    name: string; size: number; isPublic: boolean;
    rosterSettings: { lineupSlotCounts: Record<string, number> };
    scoringSettings: { scoringItems: { statId: number; points: number; pointsOverrides?: Record<string, number> }[] };
    draftSettings: { keeperCount?: number; keeperCountFuture?: number; type?: string };
  };
  members: { id: string; displayName?: string; firstName?: string; lastName?: string }[];
  teams: {
    id: number; name?: string; abbrev?: string; location?: string; nickname?: string; owners?: string[]; primaryOwner?: string;
    record: { wins?: number; losses?: number; ties?: number; pointsFor?: number; pointsAgainst?: number };
    roster: { playerId: number; lineupSlotId: number; player: { id: number; fullName: string; defaultPositionId: number; proTeamId: number; injuryStatus?: string } }[];
  }[];
}

/** "https://fantasy.espn.com/football/league?leagueId=123&seasonId=2026", a
 *  team URL, or a bare id → { leagueId, season? }. */
export function parseEspnLeagueInput(text: string): { leagueId: string; season?: number } | null {
  const t = text.trim();
  if (!t) return null;
  if (/^\d{3,12}$/.test(t)) return { leagueId: t };
  try {
    const u = new URL(t);
    const id = u.searchParams.get('leagueId');
    if (!id || !/^\d+$/.test(id)) return null;
    const season = Number(u.searchParams.get('seasonId'));
    return { leagueId: id, season: Number.isFinite(season) && season > 2000 ? season : undefined };
  } catch { return null; }
}

/** Sleeper-style roster positions from ESPN's slot counts (bench and IR kept, IDP slots kept by name). */
export function rosterPositionsFromSlots(counts: Record<string, number>): string[] {
  const out: string[] = [];
  const order = [0, 1, 2, 3, 4, 5, 6, 7, 23, 24, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
  for (const slot of order) {
    const n = Number(counts[String(slot)] || 0);
    const label = SLOT[slot];
    if (!label || n <= 0) continue;
    for (let i = 0; i < n; i++) out.push(label);
  }
  return out;
}

/** Sleeper-style scoring keys from ESPN's scoring items. A TE-only override on
 *  receptions (ESPN's per-position points) becomes bonus_rec_te, which is how
 *  the app reads TE premium. */
export function scoringFromItems(items: SlimLeague['settings']['scoringSettings']['scoringItems']): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const key = STAT[it.statId];
    if (!key) continue;
    out[key] = Number(it.points) || 0;
    if (it.statId === 53) {
      const te = it.pointsOverrides?.['4'];
      if (typeof te === 'number' && te !== it.points) out.bonus_rec_te = te - (Number(it.points) || 0);
    }
  }
  return out;
}

export async function importEspnLeague(leagueId: string, season: number, creds?: EspnCredentials | null, opts: { dynasty?: boolean } = {}): Promise<LeagueImport> {
  const headers: Record<string, string> = {};
  if (creds?.s2 && creds?.swid) { headers['X-ESPN-S2'] = creds.s2.trim(); headers['X-ESPN-SWID'] = creds.swid.trim(); }
  let res: Response;
  try {
    res = await fetch(`${PROXY}/league/${season}/${encodeURIComponent(leagueId)}`, { headers });
  } catch {
    throw new Error('Could not reach the ESPN league proxy. Check your connection and try again.');
  }
  const body = (await res.json().catch(() => ({}))) as Partial<SlimLeague> & { error?: string };
  if (!res.ok) throw new Error(body.error || `ESPN league request failed (${res.status})`);
  const lg = body as SlimLeague;
  if (!lg.settings || !Array.isArray(lg.teams)) throw new Error('ESPN sent a league without teams.');

  const crosswalk = await loadCrosswalk().catch(() => null);
  const memberName = new Map<string, string>();
  for (const m of lg.members || []) memberName.set(m.id, m.displayName || [m.firstName, m.lastName].filter(Boolean).join(' ') || m.id);

  const teams: LeagueTeam[] = lg.teams.map((t) => {
    const starters: RosterPlayer[] = [];
    const bench: RosterPlayer[] = [];
    for (const e of t.roster || []) {
      const p = e.player || ({} as SlimLeague['teams'][0]['roster'][0]['player']);
      const rec = crosswalk ? lookupByEspnId(crosswalk, p.id ?? e.playerId) : null;
      const position = rec?.position && ['QB', 'RB', 'WR', 'TE', 'K'].includes(rec.position) ? rec.position : (POS[p.defaultPositionId] ?? 'UNK');
      const slot = SLOT[e.lineupSlotId] ?? 'BN';
      const row: RosterPlayer = {
        id: rec?.sleeper_id ? String(rec.sleeper_id) : `espn:${p.id ?? e.playerId}`,
        name: p.fullName || rec?.display_name || String(e.playerId),
        position,
        team: TEAM[p.proTeamId] ?? '',
        slot,
      };
      if (slot === 'BN' || slot === 'IR') bench.push(row); else starters.push(row);
    }
    const owner = t.primaryOwner ?? t.owners?.[0] ?? null;
    return {
      rosterId: t.id,
      teamName: t.name || [t.location, t.nickname].filter(Boolean).join(' ') || `Team ${t.id}`,
      owner: owner ? (memberName.get(owner) ?? owner) : '',
      ownerId: owner,
      wins: Number(t.record?.wins) || 0, losses: Number(t.record?.losses) || 0, ties: Number(t.record?.ties) || 0,
      pointsFor: Number(t.record?.pointsFor) || 0, pointsAgainst: Number(t.record?.pointsAgainst) || 0,
      starters, bench,
    };
  }).sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor);

  const keepers = Number(lg.settings.draftSettings?.keeperCount || 0) + Number(lg.settings.draftSettings?.keeperCountFuture || 0);
  const dynasty = opts.dynasty ?? keepers > 0;
  const league: SleeperLeagueInfo = {
    league_id: `espn:${lg.id}`,
    name: lg.settings.name || `ESPN league ${lg.id}`,
    season: String(lg.seasonId || season),
    status: 'in_season',
    total_rosters: lg.teams.length,
    roster_positions: rosterPositionsFromSlots(lg.settings.rosterSettings?.lineupSlotCounts || {}),
    scoring_settings: scoringFromItems(lg.settings.scoringSettings?.scoringItems || []),
    // ESPN has no dynasty flag: keepers carried into next season read as dynasty (the caller can override).
    settings: { type: dynasty ? 2 : keepers > 0 ? 1 : 0 },
  };
  return { league, teams };
}
