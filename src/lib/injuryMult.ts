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
