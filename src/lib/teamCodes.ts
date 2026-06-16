// Normalize NFL team abbreviations to Sleeper's codes (GB, KC, NE, NO, SF,
// TB, LV, JAX, LAR, …). Sources disagree: Dynasty uses GBP/KCC/NEP/NOS/SFO/TBB/
// LVR/JAC, nflverse game logs use LA for the Rams, and older feeds use
// GNB/KAN/NWE/etc. Anything compared against Sleeper rosters (e.g. the
// player-page depth chart) must pass through this first.
const TO_SLEEPER: Record<string, string> = {
  GBP: 'GB', GNB: 'GB', KCC: 'KC', KAN: 'KC', NEP: 'NE', NWE: 'NE',
  NOS: 'NO', NOR: 'NO', SFO: 'SF', TBB: 'TB', TAM: 'TB', LVR: 'LV',
  OAK: 'LV', JAC: 'JAX', LA: 'LAR', STL: 'LAR', SD: 'LAC', AZ: 'ARI',
  ARZ: 'ARI', WSH: 'WAS', CLV: 'CLE', BLT: 'BAL', HST: 'HOU',
};

export function toSleeperTeam(team: string | null | undefined): string | null {
  if (!team) return null;
  const u = team.toUpperCase();
  return TO_SLEEPER[u] ?? u;
}
