// Shared constants/helpers for the season projection pool. Extracted from
// StatProjections.tsx so the pure pool builder (buildProjectionPool.ts), the
// headless Node script, and the React component all reference ONE definition.
// Moving these verbatim — do NOT change any value.

export const PREDICT_SEASON = 2026;
export const POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const;
export type Position = typeof POSITIONS[number];

// Canonicalize team abbreviations to the nflverse codes used by the stats +
// team-projection data. The 2026 roster feed labels Arizona "AZ" while the
// prior-season stats and team-projections use "ARI"; without this the entire
// Arizona pipeline (team totals, pool shares, projTeam lookup) mismatches and
// its depth players get the studs' reconciled volume — e.g. Kendrick Bourne /
// Josiah Deguara projecting as WR1/TE1 over Harrison / McBride. Also maps the
// other historical nflverse variants so the same class of bug can't recur.
export const TEAM_CANON: Record<string, string> = {
  AZ: 'ARI', ARZ: 'ARI', JAC: 'JAX', LAR: 'LA', STL: 'LA', SD: 'LAC',
  OAK: 'LV', LVR: 'LV', WSH: 'WAS', GNB: 'GB', KAN: 'KC', NWE: 'NE',
  NOR: 'NO', SFO: 'SF', TAM: 'TB', CLV: 'CLE', BLT: 'BAL', HST: 'HOU',
};
export const normTeam = (t: string | undefined | null): string => {
  const u = (t || '').toUpperCase();
  return TEAM_CANON[u] || u;
};

export const TEAM_POS_LIMITS: Record<Position, number> = { QB: 2, RB: 4, WR: 5, TE: 3 };
