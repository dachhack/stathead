/**
 * Manual roster overrides for trades and free-agent signings not yet reflected in
 * nflverse data. Keys are normalized player names (lowercase, letters + spaces only,
 * matching the normalizeName() convention used throughout the app).
 *
 * Last updated: 2026-03-22
 * Sources: NFL.com, ESPN, CBS Sports trackers
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
};

/** First season to which the 2026 overrides apply */
export const ROSTER_OVERRIDES_2026_SEASON = 2026;
