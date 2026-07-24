/**
 * Scott Fish Bowl 16 (#SFB16, 2026) scoring.
 *
 * Rules (per the official SFB16 release):
 *   - All TDs 6 pts (passing included), all 2-pt conversions 2 pts
 *   - 0.04 / passing yard, 0.1 / rushing or receiving yard
 *   - 0.5 / reception, 0.5 / rushing or receiving first down
 *   - TE premium: +1 / reception and +1 / first down (1.5 total each)
 *   - No turnover penalties (INTs and fumbles score 0)
 *   - "Video game" bonuses, +10 pts each:
 *       · 300+ and 400+ passing-yard games (stack: a 400-yd game pays both)
 *       · 100+ and 200+ rush+rec-yard games (stack)
 *       · every 40+ yard pass play, 40+ yard rush, 20+ yard reception
 *
 * What's exact vs estimated here: yardage/TD/reception/2-pt scoring is
 * exact from any season stat line. First downs and milestone-game counts
 * are exact when the caller passes them (the nflverse weekly aggregation
 * carries both) and estimated from volume + efficiency otherwise (the
 * projection pool only has season lines). The per-play bonuses (40+ yd
 * pass/rush, 20+ yd receptions) are always estimated — no data source in
 * the app carries play-level counts. Estimator rates are calibrated to
 * recent league-wide seasons and documented inline.
 */

export const SFB_LABEL = 'SFB16';
export const SFB_BONUS = 10;

export interface SFBLine {
  position: string; // QB | RB | WR | TE
  games: number;
  passAtt?: number;
  passYds?: number;
  passTD?: number;
  rushAtt?: number;
  rushYds?: number;
  rushTD?: number;
  rec?: number;
  recYds?: number;
  recTD?: number;
  twoPtConversions?: number;
  specialTeamsTDs?: number;
  // Exact season totals when the source has them; estimated when absent.
  rushFirstDowns?: number;
  recFirstDowns?: number;
  games300Pass?: number;
  games400Pass?: number;
  games100Scrim?: number;
  games200Scrim?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** P(X >= threshold) for X ~ Normal(mean, sd), via the logistic
 *  approximation of the normal CDF (max error ~0.01). */
function probOver(mean: number, sd: number, threshold: number): number {
  if (sd <= 0) return mean >= threshold ? 1 : 0;
  const z = (threshold - mean) / sd;
  return 1 / (1 + Math.exp(1.702 * z));
}

/** RBs convert ~22% of carries into first downs at a typical 4.3 YPC —
 *  the rate scales roughly linearly with efficiency. QB carries convert
 *  far more often (scrambles are disproportionately on passing downs). */
export function estimateRushFirstDowns(position: string, rushAtt: number, rushYds: number): number {
  if (!rushAtt) return 0;
  const ypc = rushYds / rushAtt;
  const rate = position === 'QB' ? 0.32 : clamp(0.052 * ypc, 0.1, 0.32);
  return rushAtt * rate;
}

/** Share of receptions that gain a first down, by position (league-wide:
 *  WRs ~58%, TEs ~54%, RB dump-offs ~33%). */
export function estimateRecFirstDowns(position: string, rec: number): number {
  if (!rec) return 0;
  const rate = position === 'RB' ? 0.33 : position === 'TE' ? 0.54 : 0.58;
  return rec * rate;
}

/** Expected count of bonus PLAYS in a season: 40+ yd pass plays, 40+ yd
 *  rushes, 20+ yd receptions. All rates scale with per-touch efficiency:
 *  a 7.8 YPA passer hits ~9 forty-yard plays over a full season, a 4.4 YPC
 *  back ~1 forty-yard run per 300 carries, and a 14-YPR receiver turns
 *  ~18% of catches into 20+ yard gains. */
export function estimateBigPlays(line: SFBLine): number {
  const passAtt = line.passAtt || (line.passYds ? line.passYds / 7.2 : 0);
  const ypa = passAtt > 0 ? (line.passYds || 0) / passAtt : 0;
  const pass40 = passAtt * clamp(0.0043 * (ypa - 4), 0, 0.05);

  const rushAtt = line.rushAtt || 0;
  const ypc = rushAtt > 0 ? (line.rushYds || 0) / rushAtt : 0;
  const rush40 = rushAtt * clamp(0.0032 * (ypc - 3.4), 0, 0.02);

  const rec = line.rec || 0;
  const ypr = rec > 0 ? (line.recYds || 0) / rec : 0;
  const rec20 = rec * clamp(0.022 * (ypr - 6), 0, 0.35);

  return pass40 + rush40 + rec20;
}

/** Expected count of milestone GAMES in a season (300+/400+ passing,
 *  100+/200+ rush+rec — each pays once per game and they stack). Exact
 *  counts win when the caller has them; otherwise model each game's
 *  output as Normal around the per-game average (passing sd ~62 yds for
 *  a starter; scrimmage sd scales with volume). */
export function estimateMilestoneGames(line: SFBLine): number {
  const g = Math.max(1, line.games || 0);

  let passMilestones = (line.games300Pass ?? -1) >= 0 && (line.games400Pass ?? -1) >= 0
    ? (line.games300Pass || 0) + (line.games400Pass || 0)
    : -1;
  if (passMilestones < 0) {
    const passPG = (line.passYds || 0) / g;
    // Under ~120 pass yds/gm this isn't a passer — skip rather than pay
    // the tail of a distribution that doesn't apply.
    passMilestones = passPG >= 120
      ? g * (probOver(passPG, 62, 300) + probOver(passPG, 62, 400))
      : 0;
  }

  let scrimMilestones = (line.games100Scrim ?? -1) >= 0 && (line.games200Scrim ?? -1) >= 0
    ? (line.games100Scrim || 0) + (line.games200Scrim || 0)
    : -1;
  if (scrimMilestones < 0) {
    const scrimPG = ((line.rushYds || 0) + (line.recYds || 0)) / g;
    const sd = Math.max(24, 0.55 * scrimPG);
    scrimMilestones = scrimPG >= 25
      ? g * (probOver(scrimPG, sd, 100) + probOver(scrimPG, sd, 200))
      : 0;
  }

  return passMilestones + scrimMilestones;
}

/** Season SFB16 points for a stat line. Exact where the line allows,
 *  estimated bonuses elsewhere (see module doc). */
export function computeSFBPoints(line: SFBLine): number {
  const isTE = line.position === 'TE';
  const rec = line.rec || 0;

  let pts =
    (line.passYds || 0) * 0.04 +
    (line.passTD || 0) * 6 +
    (line.rushYds || 0) * 0.1 +
    (line.rushTD || 0) * 6 +
    (line.recYds || 0) * 0.1 +
    (line.recTD || 0) * 6 +
    rec * (isTE ? 1.5 : 0.5) +
    (line.twoPtConversions || 0) * 2 +
    (line.specialTeamsTDs || 0) * 6;

  const rushFD = line.rushFirstDowns ?? estimateRushFirstDowns(line.position, line.rushAtt || 0, line.rushYds || 0);
  const recFD = line.recFirstDowns ?? estimateRecFirstDowns(line.position, rec);
  pts += (rushFD + recFD) * 0.5;
  if (isTE) pts += recFD * 1;

  pts += (estimateBigPlays(line) + estimateMilestoneGames(line)) * SFB_BONUS;

  return Math.round(pts * 10) / 10;
}
