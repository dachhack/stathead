// StatHead dynasty value trends, derived from StatHead-scale value history
// (fetchDynastyHistoryForDisplay). Third-party trends are never shown raw.

import type { DynastyHistoryPoint, DynastyPlayer } from '../types';
import { fetchDynastyHistoryForDisplay } from '../data';

const DAY_MS = 86_400_000;

/** Change in value over the last `days` days of a history series: the latest
 *  point minus the last point on or before (latest date − days). Null when the
 *  series doesn't reach back that far. */
export function historyTrend(points: DynastyHistoryPoint[], days = 30): number | null {
  if (points.length < 2) return null;
  const sorted = [...points].sort((a, b) => a.d.localeCompare(b.d));
  const last = sorted[sorted.length - 1];
  const cutoff = Date.parse(last.d) - days * DAY_MS;
  let base: DynastyHistoryPoint | null = null;
  for (const p of sorted) {
    if (Date.parse(p.d) <= cutoff) base = p;
    else break;
  }
  return base ? last.v - base.v : null;
}

/** StatHead dynasty value trend (default 30 days) per playerID, for players
 *  from fetchDynastyRankingsForDisplay. Players without enough history are
 *  omitted. Resolves to an empty map if history is unavailable. */
export async function fetchStatHeadTrends(
  players: DynastyPlayer[],
  format: '1qb' | 'superflex',
  days = 30,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (players.length === 0) return out;
  const positionByID = new Map(players.map((p) => [p.playerID, p.position]));
  try {
    const hist = await fetchDynastyHistoryForDisplay([...positionByID.keys()], positionByID);
    for (const h of hist) {
      const series = format === 'superflex' ? h.superflex.valueHistory : h.oneQB.valueHistory;
      const t = historyTrend(series, days);
      if (t != null) out.set(h.playerID, t);
    }
  } catch {
    // History unavailable — no trends.
  }
  return out;
}
