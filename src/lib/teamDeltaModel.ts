// Team volume DELTA model — predicts year-over-year changes, not absolutes.
// Then: projected = prior + predicted_delta
//
// Why delta > absolute: prior volume is 85%+ of the signal for absolute levels.
// Predicting the delta focuses the model on what CHANGES — coaching, QB, roster moves.
// The prior baseline provides the stability, the delta model provides the edge.

import type { SeasonTotals, Game } from '../types';
import { trainRidgeRegression, predict } from './ridge';

interface TeamDeltaRow {
  team: string;
  season: number;
  // Features (all known before season starts)
  priorPassAtt: number;
  priorRushAtt: number;
  priorTargets: number;
  newQB: number;           // 0 or 1 — different starting QB than last year
  newCoach: number;        // 0 or 1
  qbRushAttPrior: number;  // starting QB's rush attempts last year
  qbAge: number;           // starting QB age
  vegasImpliedPtsPerGame: number;
  vegasWinTotal: number;
  priorWinPct: number;
  passAttTrend: number;    // 2-year change in pass att (year -1 minus year -2)
  // Targets (what we predict)
  deltaPassAtt: number;
  deltaRushAtt: number;
  deltaTargets: number;
  deltaPassTD: number;
  deltaRushTD: number;
}

const DELTA_FEATURE_KEYS = [
  'priorPassAtt', 'priorRushAtt', 'priorTargets',
  'newQB', 'newCoach',
  'qbRushAttPrior', 'qbAge',
  'vegasImpliedPtsPerGame', 'vegasWinTotal', 'priorWinPct',
  'passAttTrend',
];

/**
 * Build training data: for each team-season, compute the delta from prior to current.
 */
export function buildTeamDeltaData(
  seasons: number[],
  fetchedTotals: Map<number, SeasonTotals[]>,
  gamesData: Game[],
): TeamDeltaRow[] {
  const rows: TeamDeltaRow[] = [];

  // Aggregate team totals per season
  const teamTotals = new Map<string, { passAtt: number; rushAtt: number; targets: number; passTD: number; rushTD: number }>();
  const teamTotalsBySeason = new Map<number, typeof teamTotals>();

  for (const [season, totals] of fetchedTotals) {
    const byTeam = new Map<string, { passAtt: number; rushAtt: number; targets: number; passTD: number; rushTD: number }>();
    for (const p of totals) {
      const team = p.recent_team || '';
      if (!team) continue;
      const t = byTeam.get(team) || { passAtt: 0, rushAtt: 0, targets: 0, passTD: 0, rushTD: 0 };
      t.passAtt += p.attempts || 0;
      t.rushAtt += p.carries || 0;
      t.targets += p.targets || 0;
      t.passTD += p.passing_tds || 0;
      t.rushTD += p.rushing_tds || 0;
      byTeam.set(team, t);
    }
    teamTotalsBySeason.set(season, byTeam);
  }

  // Find starting QB per team per season (highest fantasy pts among QBs)
  const startingQB = new Map<string, { name: string; rushAtt: number; age: number }>(); // "season:team" → QB
  for (const [season, totals] of fetchedTotals) {
    const qbByTeam = new Map<string, SeasonTotals>();
    for (const p of totals) {
      if (p.position !== 'QB') continue;
      const team = p.recent_team || '';
      const existing = qbByTeam.get(team);
      if (!existing || (p.fantasy_points_ppr || 0) > (existing.fantasy_points_ppr || 0)) {
        qbByTeam.set(team, p);
      }
    }
    for (const [team, qb] of qbByTeam) {
      startingQB.set(`${season}:${team}`, {
        name: qb.player_display_name || '',
        rushAtt: qb.carries || 0,
        age: 0, // would need draft data for real age
      });
    }
  }

  // Coach lookup
  const coachByTeamSeason = new Map<string, string>();
  for (const g of gamesData) {
    if (g.game_type !== 'REG') continue;
    if (g.home_coach) coachByTeamSeason.set(`${g.season}:${g.home_team}`, g.home_coach);
    if (g.away_coach) coachByTeamSeason.set(`${g.season}:${g.away_team}`, g.away_coach);
  }

  // Vegas data
  const vegasByTeamSeason = new Map<string, { impliedPts: number; wins: number; games: number }>();
  for (const g of gamesData) {
    if (g.game_type !== 'REG') continue;
    const tl = g.total_line || 0;
    const sl = g.spread_line || 0;
    if (tl <= 0) continue;
    for (const [team, implied] of [
      [g.home_team, (tl - sl) / 2] as [string, number],
      [g.away_team, (tl + sl) / 2] as [string, number],
    ]) {
      const key = `${g.season}:${team}`;
      const v = vegasByTeamSeason.get(key) || { impliedPts: 0, wins: 0, games: 0 };
      v.impliedPts += implied;
      v.games += 1;
      const isHome = team === g.home_team;
      const won = isHome ? (g.home_score || 0) > (g.away_score || 0) : (g.away_score || 0) > (g.home_score || 0);
      if (won) v.wins += 1;
      vegasByTeamSeason.set(key, v);
    }
  }

  for (const season of seasons) {
    const current = teamTotalsBySeason.get(season);
    const prior = teamTotalsBySeason.get(season - 1);
    const prior2 = teamTotalsBySeason.get(season - 2);
    if (!current || !prior) continue;

    for (const [team, act] of current) {
      const pr = prior.get(team);
      if (!pr) continue;

      const pr2 = prior2?.get(team);
      const priorQB = startingQB.get(`${season - 1}:${team}`);
      const currentQB = startingQB.get(`${season}:${team}`);
      const newQB = priorQB && currentQB && priorQB.name !== currentQB.name ? 1 : 0;
      const priorCoach = coachByTeamSeason.get(`${season - 1}:${team}`);
      const currentCoach = coachByTeamSeason.get(`${season}:${team}`);
      const newCoach = priorCoach && currentCoach && priorCoach !== currentCoach ? 1 : 0;

      const vegasPrior = vegasByTeamSeason.get(`${season - 1}:${team}`);
      const vegasCurrent = vegasByTeamSeason.get(`${season}:${team}`);
      const priorGames = vegasPrior?.games || 17;

      rows.push({
        team, season,
        priorPassAtt: pr.passAtt,
        priorRushAtt: pr.rushAtt,
        priorTargets: pr.targets,
        newQB,
        newCoach,
        qbRushAttPrior: currentQB?.rushAtt || priorQB?.rushAtt || 0,
        qbAge: 27, // placeholder — real age needs draft data
        vegasImpliedPtsPerGame: vegasCurrent ? vegasCurrent.impliedPts / Math.max(1, vegasCurrent.games) : vegasPrior ? vegasPrior.impliedPts / priorGames : 23,
        vegasWinTotal: vegasPrior ? vegasPrior.wins : 8,
        priorWinPct: vegasPrior ? vegasPrior.wins / priorGames : 0.5,
        passAttTrend: pr2 ? pr.passAtt - pr2.passAtt : 0,
        deltaPassAtt: act.passAtt - pr.passAtt,
        deltaRushAtt: act.rushAtt - pr.rushAtt,
        deltaTargets: act.targets - pr.targets,
        deltaPassTD: act.passTD - pr.passTD,
        deltaRushTD: act.rushTD - pr.rushTD,
      });
    }
  }

  return rows;
}

/**
 * Train delta models and return enhanced team projections.
 * projected = prior + predicted_delta
 */
export function trainTeamDeltaModel(
  trainingRows: TeamDeltaRow[],
  predictionRows: TeamDeltaRow[],
): { predictions: Map<string, { passAtt: number; rushAtt: number; targets: number; passTD: number; rushTD: number }>;
     cvMetrics: Record<string, { r2: number; mae: number }> } {

  const predictions = new Map<string, { passAtt: number; rushAtt: number; targets: number; passTD: number; rushTD: number }>();
  const cvMetrics: Record<string, { r2: number; mae: number }> = {};

  const targets: Array<{ key: string; deltaKey: keyof TeamDeltaRow; priorKey: keyof TeamDeltaRow }> = [
    { key: 'passAtt', deltaKey: 'deltaPassAtt', priorKey: 'priorPassAtt' },
    { key: 'rushAtt', deltaKey: 'deltaRushAtt', priorKey: 'priorRushAtt' },
    { key: 'targets', deltaKey: 'deltaTargets', priorKey: 'priorTargets' },
    { key: 'passTD', deltaKey: 'deltaPassTD', priorKey: 'priorPassAtt' }, // use passAtt as prior proxy
    { key: 'rushTD', deltaKey: 'deltaRushTD', priorKey: 'priorRushAtt' },
  ];

  // Initialize predictions with prior values
  for (const pr of predictionRows) {
    predictions.set(pr.team, {
      passAtt: pr.priorPassAtt,
      rushAtt: pr.priorRushAtt,
      targets: pr.priorTargets,
      passTD: 0,
      rushTD: 0,
    });
  }

  for (const { key, deltaKey, priorKey } of targets) {
    const X = trainingRows.map((r) => DELTA_FEATURE_KEYS.map((k) => (r as unknown as Record<string, number>)[k] || 0));
    const y = trainingRows.map((r) => (r as unknown as Record<string, number>)[deltaKey] || 0);
    if (X.length < 30) continue;

    // Ridge with moderate regularization (small sample, 11 features)
    const model = trainRidgeRegression(X, y, DELTA_FEATURE_KEYS, 8);

    // LOSO CV
    const uniqueSeasons = [...new Set(trainingRows.map((r) => r.season))].sort();
    const actuals: number[] = [];
    const preds: number[] = [];
    for (const held of uniqueSeasons) {
      const trainR = trainingRows.filter((r) => r.season !== held);
      const testR = trainingRows.filter((r) => r.season === held);
      if (trainR.length < 30) continue;
      const Xtr = trainR.map((r) => DELTA_FEATURE_KEYS.map((k) => (r as unknown as Record<string, number>)[k] || 0));
      const ytr = trainR.map((r) => (r as unknown as Record<string, number>)[deltaKey] || 0);
      const foldModel = trainRidgeRegression(Xtr, ytr, DELTA_FEATURE_KEYS, 8);
      for (const row of testR) {
        const features: Record<string, number> = {};
        for (const k of DELTA_FEATURE_KEYS) features[k] = (row as unknown as Record<string, number>)[k] || 0;
        const actualDelta = (row as unknown as Record<string, number>)[deltaKey] || 0;
        const predDelta = predict(foldModel, features).predicted;
        // What we care about is the FINAL prediction accuracy (prior + delta)
        const priorVal = (row as unknown as Record<string, number>)[priorKey] || 0;
        actuals.push(priorVal + actualDelta);
        preds.push(priorVal + predDelta);
      }
    }
    if (actuals.length >= 10) {
      const mean = actuals.reduce((a, b) => a + b, 0) / actuals.length;
      const ssTot = actuals.reduce((s, v) => s + (v - mean) ** 2, 0);
      const ssRes = actuals.reduce((s, v, i) => s + (v - preds[i]) ** 2, 0);
      cvMetrics[key] = {
        r2: ssTot > 0 ? Math.round((1 - ssRes / ssTot) * 1000) / 1000 : 0,
        mae: Math.round(actuals.reduce((s, v, i) => s + Math.abs(v - preds[i]), 0) / actuals.length),
      };
    }

    // Generate predictions: prior + predicted_delta
    for (const pr of predictionRows) {
      const features: Record<string, number> = {};
      for (const k of DELTA_FEATURE_KEYS) features[k] = (pr as unknown as Record<string, number>)[k] || 0;
      const predDelta = predict(model, features).predicted;
      const result = predictions.get(pr.team)!;
      const priorVal = (pr as unknown as Record<string, number>)[priorKey] || 0;
      (result as unknown as Record<string, number>)[key] = Math.round(priorVal + predDelta);
    }
  }

  return { predictions, cvMetrics };
}
