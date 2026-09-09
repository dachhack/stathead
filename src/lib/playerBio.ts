/**
 * Player biography helpers: age and years-in-league for a given season.
 *
 * Every feature path used to derive both purely from the nflverse draft
 * table (`draft.age + (season - draft.season)`, `season - draft.season`).
 * That table only knows DRAFTED players, so every undrafted veteran — Rico
 * Dowdle, Jaylen Warren, Jakobi Meyers, Rashid Shaheed, ~200 of the ~460
 * scored RB/WR/TE — fell through to the "missing" defaults (age 0 in
 * training, 22 at prediction; years-in-league 0 in both) and was scored by
 * the share / interaction / aging models as a rookie-shaped player carrying
 * a veteran's prior usage.
 *
 * nflverse rosters carry `birth_date`, `entry_year` and `years_exp` for
 * nearly everyone (2026: 2,945 rows, 211 without a birth date, none without
 * years_exp), so this module resolves age / experience from the draft row
 * FIRST (unchanged behaviour for drafted players) and the roster SECOND.
 * Both the training and the prediction rows go through the same helpers so
 * the feature keeps one meaning across the two phases.
 */

export interface RosterBio {
  /** ISO date, e.g. "1998-06-14". Empty when the roster lacks one. */
  birthDate: string;
  /** First NFL season per the roster (`entry_year`), 0 when unknown. */
  entryYear: number;
  /** Seasons of experience AS OF `rosterSeason` (`years_exp`), -1 when unknown. */
  yearsExp: number;
  /** The roster season the row came from — needed to shift `yearsExp`. */
  rosterSeason: number;
}

export type RosterBioMap = Map<string, RosterBio>;

/** Minimal shape of the nflverse draft row these helpers read. */
export interface DraftBioLike {
  age?: number | null;
  season?: number | null;
}

/** Minimal shape of the nflverse roster row these helpers read. */
export interface RosterRowLike {
  full_name?: string;
  player_name?: string;
  birth_date?: string | null;
  entry_year?: number | string | null;
  years_exp?: number | string | null;
  season?: number | string | null;
}

/**
 * Record one roster row into the bio map. First non-empty value per field
 * wins, so a later row with a blank birth date never clobbers a known one.
 * Call this for EVERY roster row (before any ACT / position filter): a
 * player's bio does not depend on his status, and IR / practice-squad rows
 * are the only ones some players have.
 */
export function captureRosterBio(
  map: RosterBioMap,
  normalName: string,
  r: RosterRowLike,
  fallbackSeason: number,
): void {
  if (!normalName) return;
  const birthDate = typeof r.birth_date === 'string' ? r.birth_date.trim() : '';
  const entryYear = Number(r.entry_year) || 0;
  const yearsExpRaw = r.years_exp;
  const yearsExp = yearsExpRaw === '' || yearsExpRaw == null || Number.isNaN(Number(yearsExpRaw))
    ? -1
    : Number(yearsExpRaw);
  const rosterSeason = Number(r.season) || fallbackSeason;

  const existing = map.get(normalName);
  if (!existing) {
    map.set(normalName, { birthDate, entryYear, yearsExp, rosterSeason });
    return;
  }
  if (!existing.birthDate && birthDate) existing.birthDate = birthDate;
  if (!existing.entryYear && entryYear) existing.entryYear = entryYear;
  // Prefer the most recent roster's years_exp: it is the one closest to
  // the season being scored, so the shift below is smallest.
  if (yearsExp >= 0 && (existing.yearsExp < 0 || rosterSeason > existing.rosterSeason)) {
    existing.yearsExp = yearsExp;
    existing.rosterSeason = rosterSeason;
  }
}

/**
 * Age on 1 September of `season` from an ISO birth date (the NFL season
 * effectively starts then, and PFR's draft-table age is also a
 * during-the-season age, so the two sources agree to within a year).
 * Returns 0 when the date is missing or unparseable.
 */
export function ageOnSeptFirst(birthDate: string | null | undefined, season: number): number {
  if (!birthDate) return 0;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(birthDate.trim());
  if (!m) return 0;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!(y > 1900 && y < 2100) || !(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return 0;
  let age = season - y;
  // Birthday after 1 September of the season → hasn't had it yet.
  if (mo > 9 || (mo === 9 && d > 1)) age -= 1;
  return age > 0 && age < 60 ? age : 0;
}

/**
 * Player age in `season`: draft-table age carried forward when the draft
 * row has one, else the roster birth date, else `fallback`.
 */
export function resolvePlayerAge(
  draft: DraftBioLike | null | undefined,
  bio: RosterBio | null | undefined,
  season: number,
  fallback: number,
): number {
  const draftAge = Number(draft?.age) || 0;
  const draftYear = Number(draft?.season) || 0;
  if (draftAge > 0 && draftYear > 0) return draftAge + (season - draftYear);
  const fromRoster = ageOnSeptFirst(bio?.birthDate, season);
  if (fromRoster > 0) return fromRoster;
  return fallback;
}

/**
 * Seasons since entering the league as of `season`: draft year when
 * drafted, else the roster's entry year, else its years_exp shifted from
 * the roster season, else `fallback`. Never negative.
 */
export function resolveYearsInLeague(
  draft: DraftBioLike | null | undefined,
  bio: RosterBio | null | undefined,
  season: number,
  fallback = 0,
): number {
  const draftYear = Number(draft?.season) || 0;
  if (draftYear > 0) return Math.max(0, season - draftYear);
  if (bio) {
    if (bio.entryYear > 0) return Math.max(0, season - bio.entryYear);
    if (bio.yearsExp >= 0) return Math.max(0, bio.yearsExp + (season - bio.rosterSeason));
  }
  return fallback;
}
