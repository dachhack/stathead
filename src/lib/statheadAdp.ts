/**
 * StatHead ADP: the weighted blend of the draft markets (FantasyPros, Sleeper,
 * FantasyFootballCalculator, ESPN, FantasyCalc — see adpSources.ts), and
 * nothing else. Third-party rankings and values are inputs, never shown raw:
 * no per-source pick is returned, and a player needs at least
 * MIN_ADP_SOURCES sources (a "blend" of one source would be that source's
 * number).
 */
import { buildMultiAdpRows, loadAdpSources, type AdpFormat } from './adpSources';

export const MIN_ADP_SOURCES = 2;

export interface StatHeadAdpRow {
  name: string;
  position: string;
  team: string;
  sleeperId?: string;
  /** Weighted blend of the sources' picks, one decimal. */
  adp: number;
  /** Rank by StatHead ADP (overall, 1 = first off the board). */
  rank: number;
  /** Rank within position. */
  posRank: number;
  /** Max minus min across sources: how much the markets disagree. */
  spread: number;
  sourceCount: number;
}

/** StatHead ADP for a season (historic seasons use the archived sources). */
export async function loadStatHeadAdp(
  season: number,
  currentSeason: number,
  format: AdpFormat = '1qb',
): Promise<StatHeadAdpRow[]> {
  const rows = buildMultiAdpRows(await loadAdpSources(season, currentSeason, format))
    .filter((r) => r.sourceCount >= MIN_ADP_SOURCES);
  const byPos: Record<string, number> = {};
  return rows.map((r, i) => {
    byPos[r.position] = (byPos[r.position] ?? 0) + 1;
    return {
      name: r.name, position: r.position, team: r.team, sleeperId: r.sleeperId,
      adp: r.blend, rank: i + 1, posRank: byPos[r.position], spread: r.spread, sourceCount: r.sourceCount,
    };
  });
}
