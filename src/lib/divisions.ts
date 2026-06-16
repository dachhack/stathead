// Canonical NFL division grouping + ordering. Single source of truth so every
// team list on the site shows divisions in the same order and teams in the same
// order within a division. Team codes match the Sleeper/Consensus/ESPN convention
// (LA, LAC, LV, WAS, JAX).
export interface Division {
  name: string;
  teams: string[];
}

export const NFL_DIVISIONS: Division[] = [
  { name: 'AFC East', teams: ['BUF', 'MIA', 'NE', 'NYJ'] },
  { name: 'AFC North', teams: ['BAL', 'CIN', 'CLE', 'PIT'] },
  { name: 'AFC South', teams: ['HOU', 'IND', 'JAX', 'TEN'] },
  { name: 'AFC West', teams: ['DEN', 'KC', 'LV', 'LAC'] },
  { name: 'NFC East', teams: ['DAL', 'NYG', 'PHI', 'WAS'] },
  { name: 'NFC North', teams: ['CHI', 'DET', 'GB', 'MIN'] },
  { name: 'NFC South', teams: ['ATL', 'CAR', 'NO', 'TB'] },
  { name: 'NFC West', teams: ['ARI', 'LA', 'SF', 'SEA'] },
];

// Team code → division name.
export const DIVISION_OF: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const d of NFL_DIVISIONS) for (const t of d.teams) m[t] = d.name;
  return m;
})();

export const divisionOf = (team: string): string => DIVISION_OF[team] ?? '';

// Canonical team order: division order, then team order within division.
export const TEAM_ORDER: string[] = NFL_DIVISIONS.flatMap((d) => d.teams);

const TEAM_RANK: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  TEAM_ORDER.forEach((t, i) => { m[t] = i; });
  return m;
})();

/** Comparator placing teams in canonical division / within-division order.
 *  Unknown teams sort last, alphabetically. */
export function compareTeams(a: string, b: string): number {
  const ra = TEAM_RANK[a] ?? 999;
  const rb = TEAM_RANK[b] ?? 999;
  if (ra !== rb) return ra - rb;
  return a.localeCompare(b);
}

/** Group items by division in canonical order. Within a division, items keep
 *  the caller's existing order (sort beforehand if a specific order is wanted).
 *  Teams with an unknown code collect under "Other" at the end. */
export function groupByDivision<T>(items: T[], getTeam: (item: T) => string): { division: string; items: T[] }[] {
  const byDiv = new Map<string, T[]>();
  for (const it of items) {
    const div = divisionOf(getTeam(it)) || 'Other';
    if (!byDiv.has(div)) byDiv.set(div, []);
    byDiv.get(div)!.push(it);
  }
  const out: { division: string; items: T[] }[] = [];
  for (const d of NFL_DIVISIONS) {
    const list = byDiv.get(d.name);
    if (list && list.length) out.push({ division: d.name, items: list });
  }
  const other = byDiv.get('Other');
  if (other && other.length) out.push({ division: 'Other', items: other });
  return out;
}
