/**
 * Settings shared across the draft prep tool sections.
 *
 * Persisted to localStorage under DRAFT_PREP_SETTINGS_KEY; bumped via
 * `version` when the schema changes so old payloads can be migrated.
 *
 * The five inputs (league size, pick slot, draft type, roster slots, scoring)
 * drive every downstream computation: pick numbers per round, ADP-survival
 * probability at each pick, replacement-level math, ADP-band bucket sizes.
 */

export type Position = 'QB' | 'RB' | 'WR' | 'TE';
export type DraftType = 'snake' | 'linear';
export type Scoring = 'PPR' | 'HALF' | 'STD';

export interface RosterSlots {
  QB: number;
  RB: number;
  WR: number;
  TE: number;
  FLEX: number;
  SF: number;
}

export interface DraftPrepSettings {
  version: 1;
  numTeams: number;
  pickSlot: number;
  draftType: DraftType;
  roster: RosterSlots;
  scoring: Scoring;
}

export const DEFAULT_SETTINGS: DraftPrepSettings = {
  version: 1,
  numTeams: 12,
  pickSlot: 6,
  draftType: 'snake',
  roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SF: 0 },
  scoring: 'PPR',
};

const STORAGE_KEY = 'draft-prep-settings';

export function loadSettings(): DraftPrepSettings {
  if (typeof localStorage === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<DraftPrepSettings>;
    if (parsed.version !== 1) return DEFAULT_SETTINGS;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      roster: { ...DEFAULT_SETTINGS.roster, ...(parsed.roster ?? {}) },
    } as DraftPrepSettings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: DraftPrepSettings): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* quota / disabled */ }
}

/** Total starter slots per team (QB + RB + WR + TE + FLEX + SF). */
export function startersPerTeam(s: DraftPrepSettings): number {
  const r = s.roster;
  return r.QB + r.RB + r.WR + r.TE + r.FLEX + r.SF;
}
