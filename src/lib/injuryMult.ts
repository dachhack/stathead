// What an injury designation is worth, measured over 2016-2025 REG weeks 1-16
// (scripts/measure-injury-designations.py → public/data/injury-designation-
// multipliers.json): points scored that week ÷ the player's own healthy
// baseline, a DNP counted as 0, over 4,147 designated player-weeks.
//   Out            0.1% played  ×0.00
//   Doubtful       1.2% played  ×0.01
//   Questionable    71% played  ×0.63
//     by final practice: Full ×0.80 (85% played), Limited ×0.64, DNP ×0.39 (48%)
// Sleeper's IR / PUP / Sus / NFI / COV are Out by definition. The MCP's
// get_weekly_projections applies the same table (mcp/dist/server.mjs, injuryMult).
export const QUESTIONABLE_MULT = 0.63;
export const QUESTIONABLE_BY_PRACTICE: Record<string, number> = { Full: 0.8, Limited: 0.64, DNP: 0.39 };

export function injuryMult(status: string | null | undefined, practice?: string | null): number {
  const s = (status ?? '').toLowerCase();
  if (s === 'questionable') return (practice ? QUESTIONABLE_BY_PRACTICE[practice] : undefined) ?? QUESTIONABLE_MULT;
  if (s === 'doubtful') return 0;
  if (/^(out|ir|pup|injured reserve|sus|nfi|cov)$/.test(s)) return 0;
  return 1;
}

// Once the team posts its inactive list (~90 min before kickoff) the coin flip
// is settled: inactive → 0, active → what a designated player who PLAYS scores
// against his own healthy baseline (multIfPlayed, same measurement). The call
// comes from RotoWire (scripts/fetch-gameday-inactives.py) as the row's `gd`.
export const ACTIVE_Q_BY_PRACTICE: Record<string, number> = { Full: 0.91, Limited: 0.88, DNP: 0.77 };

export function activeMult(status: string | null | undefined, practice?: string | null): number {
  const s = (status ?? '').toLowerCase();
  if (s === 'questionable') return (practice ? ACTIVE_Q_BY_PRACTICE[practice] : undefined) ?? 0.88;
  if (s === 'doubtful') return 0.58;
  return 1;
}

// QB starter calls (RotoWire, row.qbc): a team's newest firm / likely start
// call names its QB for the week. Over weeks 1-3 of 2026 it named the QB who
// threw the most passes in 12 team-weeks of 12, so a notch below certain.
export const QB_START_P: Record<string, number> = { firm: 0.95, likely: 0.85 };
export const QB_NOT_START = 0.05;
