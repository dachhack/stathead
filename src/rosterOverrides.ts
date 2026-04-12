/**
 * Manual roster overrides for trades and free-agent signings not yet reflected in
 * nflverse data. Keys are normalized player names (lowercase, letters + spaces only,
 * matching the normalizeName() convention used throughout the app).
 *
 * Last updated: 2026-04-01
 * Sources: NFL.com, ESPN, CBS Sports, Spotrac trackers
 */

interface RosterOverride {
  /** New team abbreviation */
  team: string;
  /** Human-readable note for debugging */
  note: string;
}

/**
 * 2025-26 offseason moves: season 2026 roster overrides.
 * Covers the 2025 trade deadline (Nov 4) and 2026 free agency / trade period.
 * Last updated: 2026-04-01
 * Sources: NFL.com, ESPN, CBS Sports trackers
 */
export const ROSTER_OVERRIDES_2026: Record<string, RosterOverride> = {
  // ── 2025 Trade Deadline ────────────────────────────────────────────────────
  'jakobi meyers': { team: 'JAX', note: 'Traded LV → JAX (Nov 2025)' },
  'rashid shaheed': { team: 'SEA', note: 'Traded NO → SEA (Nov 2025)' },
  'ad mitchell': { team: 'NYJ', note: 'Traded IND → NYJ (Nov 2025)' },

  // ── 2026 Offseason Trades ─────────────────────────────────────────────────
  'geno smith': { team: 'NYJ', note: 'Traded LV → NYJ (Mar 11, 2026)' },
  'dj moore': { team: 'BUF', note: 'Traded CHI → BUF (Mar 2026)' },
  'michael pittman jr': { team: 'PIT', note: 'Traded IND → PIT (Mar 2026)' },
  'jaylen waddle': { team: 'DEN', note: 'Traded MIA → DEN (Mar 17, 2026)' },
  'david montgomery': { team: 'HOU', note: 'Traded DET → HOU (Mar 2026)' },

  // ── 2026 Free-Agent Signings ──────────────────────────────────────────────
  'mike evans': { team: 'SF', note: 'Free agent TB → SF (Mar 9, 2026)' },
  'kenneth walker iii': { team: 'KC', note: 'Free agent SEA → KC (Mar 9, 2026)' },
  'isiah pacheco': { team: 'DET', note: 'Free agent KC → DET (Mar 2026)' },
  'tua tagovailoa': { team: 'ATL', note: 'Free agent MIA → ATL (Mar 2026)' },
  'malik willis': { team: 'MIA', note: 'Free agent TEN → MIA (Mar 2026)' },
  'kyler murray': { team: 'MIN', note: 'Free agent ARI → MIN (Mar 2026)' },
  'gardner minshew': { team: 'ARI', note: 'Free agent LV → ARI (Mar 2026)' },
  'rico dowdle': { team: 'PIT', note: 'Free agent DAL → PIT (Mar 2026)' },
  'tyler allgeier': { team: 'ARI', note: 'Free agent ATL → ARI (Mar 2026)' },
  'brian robinson': { team: 'ATL', note: 'Free agent WAS → ATL (Mar 2026)' },
  'rachaad white': { team: 'WAS', note: 'Free agent TB → WAS (Mar 2026)' },
  'kenneth gainwell': { team: 'TB', note: 'Free agent PHI → TB (Mar 2026)' },
  'dameon pierce': { team: 'PHI', note: 'Free agent HOU → PHI (Mar 20, 2026)' },
  'jk dobbins': { team: 'DEN', note: 'Re-signed with DEN (Mar 2026)' },
  'marquise brown': { team: 'PHI', note: 'Free agent KC → PHI (Mar 17, 2026)' },
  'hollywood brown': { team: 'PHI', note: 'Free agent KC → PHI (Mar 17, 2026)' },
  'kendrick bourne': { team: 'ARI', note: 'Free agent NE → ARI (Mar 2026)' },
  'elijah moore': { team: 'PHI', note: 'Free agent CLE → PHI (Mar 2026)' },
  'greg dortch': { team: 'DET', note: 'Free agent ARI → DET (Mar 2026)' },
  'joshua palmer': { team: 'BUF', note: 'Signed LAC → BUF (2025)' },
  'kyle pitts': { team: 'ATL', note: 'Franchise tagged by ATL (Mar 2026)' },
};

/** First season to which the 2026 overrides apply */
export const ROSTER_OVERRIDES_2026_SEASON = 2026;
