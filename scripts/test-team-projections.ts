// Backtest team volume projections: old (simple blend) vs new (enhanced).
// Compares projected pass attempts, rush attempts, and PPR against actuals.
// Run: NODE_OPTIONS='--max-old-space-size=6144' npx tsx scripts/test-team-projections.ts

import { fetchPlayerStats, aggregateToSeasonTotals, fetchGames } from '../src/data';
import { projectTeamTotals } from '../src/lib/teamProjection';
import type { Game } from '../src/types';

const SEASONS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];

function rmse(actuals: number[], preds: number[]): number {
  if (actuals.length === 0) return 0;
  const mse = actuals.reduce((s, a, i) => s + (a - preds[i]) ** 2, 0) / actuals.length;
  return Math.round(Math.sqrt(mse) * 10) / 10;
}

function mae(actuals: number[], preds: number[]): number {
  if (actuals.length === 0) return 0;
  return Math.round(actuals.reduce((s, a, i) => s + Math.abs(a - preds[i]), 0) / actuals.length * 10) / 10;
}

async function main() {
  console.log('Loading games data...');
  const gamesData = await fetchGames();

  console.log('Backtesting team projections across seasons...\n');

  const metrics = {
    old: { passAttMAE: [] as number[], rushAttMAE: [] as number[], pprMAE: [] as number[] },
    new: { passAttMAE: [] as number[], rushAttMAE: [] as number[], pprMAE: [] as number[] },
  };

  for (const season of SEASONS) {
    console.log(`=== ${season} ===`);

    const [priorStats, currentStats] = await Promise.all([
      fetchPlayerStats(season - 1).catch(() => []),
      fetchPlayerStats(season).catch(() => []),
    ]);

    if (priorStats.length === 0 || currentStats.length === 0) {
      console.log('  Skipped (missing data)\n');
      continue;
    }

    const priorTotals = aggregateToSeasonTotals(priorStats.filter((s) => s.season_type === 'REG'));
    const actualTotals = aggregateToSeasonTotals(currentStats.filter((s) => s.season_type === 'REG'));

    // Actual team totals
    const actualByTeam = new Map<string, { passAtt: number; rushAtt: number; ppr: number }>();
    for (const p of actualTotals) {
      const team = p.recent_team;
      if (!team) continue;
      const t = actualByTeam.get(team) || { passAtt: 0, rushAtt: 0, ppr: 0 };
      t.passAtt += p.attempts || 0;
      t.rushAtt += p.carries || 0;
      t.ppr += p.fantasy_points_ppr || 0;
      actualByTeam.set(team, t);
    }

    // Old projection (simple blend, no context)
    const oldProj = projectTeamTotals(priorTotals);

    // New projection (with Vegas + coaching + QB rush adjustments)
    // Build context from games data
    const seasonGames = gamesData.filter((g: Game) => g.season === season);
    const coachChanges = new Set<string>();
    for (const g of seasonGames) {
      if (g.game_type !== 'REG') continue;
      const priorHomeCoach = gamesData.find((pg: Game) => pg.season === season - 1 && pg.home_team === g.home_team && pg.game_type === 'REG')?.home_coach;
      if (priorHomeCoach && g.home_coach && priorHomeCoach !== g.home_coach) coachChanges.add(g.home_team);
      const priorAwayCoach = gamesData.find((pg: Game) => pg.season === season - 1 && pg.away_team === g.away_team && pg.game_type === 'REG')?.away_coach;
      if (priorAwayCoach && g.away_coach && priorAwayCoach !== g.away_coach) coachChanges.add(g.away_team);
    }

    // QB rush by team (current season's starting QB prior rushing)
    const qbRushByTeam = new Map<string, number>();
    // Find each team's top QB from prior season
    for (const p of priorTotals) {
      if (p.position !== 'QB') continue;
      const team = p.recent_team || '';
      if (!team) continue;
      const existing = qbRushByTeam.get(team) || 0;
      if ((p.fantasy_points_ppr || 0) > existing) {
        qbRushByTeam.set(team, p.carries || 0);
      }
    }

    const newProj = projectTeamTotals(priorTotals, undefined, {
      games: seasonGames,
      coachChanges,
      qbRushByTeam,
    });

    // Compare
    const oldPassAtt: number[] = [], oldPassPred: number[] = [];
    const newPassAtt: number[] = [], newPassPred: number[] = [];
    const oldRushAtt: number[] = [], oldRushPred: number[] = [];
    const newRushAtt: number[] = [], newRushPred: number[] = [];
    const oldPPR: number[] = [], oldPPRPred: number[] = [];
    const newPPR: number[] = [], newPPRPred: number[] = [];

    for (const [team, actual] of actualByTeam) {
      const op = oldProj.get(team);
      const np = newProj.get(team);
      if (!op || !np) continue;

      oldPassAtt.push(actual.passAtt); oldPassPred.push(op.passAtt);
      newPassAtt.push(actual.passAtt); newPassPred.push(np.passAtt);
      oldRushAtt.push(actual.rushAtt); oldRushPred.push(op.rushAtt);
      newRushAtt.push(actual.rushAtt); newRushPred.push(np.rushAtt);
      oldPPR.push(actual.ppr); oldPPRPred.push(op.pprPts);
      newPPR.push(actual.ppr); newPPRPred.push(np.pprPts);
    }

    const oldPAMae = mae(oldPassAtt, oldPassPred);
    const newPAMae = mae(newPassAtt, newPassPred);
    const oldRAMae = mae(oldRushAtt, oldRushPred);
    const newRAMae = mae(newRushAtt, newRushPred);
    const oldPPRMae = mae(oldPPR, oldPPRPred);
    const newPPRMae = mae(newPPR, newPPRPred);

    metrics.old.passAttMAE.push(oldPAMae);
    metrics.new.passAttMAE.push(newPAMae);
    metrics.old.rushAttMAE.push(oldRAMae);
    metrics.new.rushAttMAE.push(newRAMae);
    metrics.old.pprMAE.push(oldPPRMae);
    metrics.new.pprMAE.push(newPPRMae);

    console.log(`  Teams: ${actualByTeam.size} | Coach changes: ${coachChanges.size}`);
    console.log(`  Pass Att MAE:  Old=${oldPAMae}  New=${newPAMae}  ${newPAMae < oldPAMae ? '✅' : newPAMae > oldPAMae ? '❌' : '➖'}`);
    console.log(`  Rush Att MAE:  Old=${oldRAMae}  New=${newRAMae}  ${newRAMae < oldRAMae ? '✅' : newRAMae > oldRAMae ? '❌' : '➖'}`);
    console.log(`  Team PPR MAE:  Old=${oldPPRMae}  New=${newPPRMae}  ${newPPRMae < oldPPRMae ? '✅' : newPPRMae > oldPPRMae ? '❌' : '➖'}`);
    console.log();
  }

  // Aggregate
  console.log('='.repeat(60));
  console.log('AGGREGATE RESULTS');
  console.log('='.repeat(60));
  const avgOldPA = Math.round(metrics.old.passAttMAE.reduce((a, b) => a + b, 0) / metrics.old.passAttMAE.length * 10) / 10;
  const avgNewPA = Math.round(metrics.new.passAttMAE.reduce((a, b) => a + b, 0) / metrics.new.passAttMAE.length * 10) / 10;
  const avgOldRA = Math.round(metrics.old.rushAttMAE.reduce((a, b) => a + b, 0) / metrics.old.rushAttMAE.length * 10) / 10;
  const avgNewRA = Math.round(metrics.new.rushAttMAE.reduce((a, b) => a + b, 0) / metrics.new.rushAttMAE.length * 10) / 10;
  const avgOldPPR = Math.round(metrics.old.pprMAE.reduce((a, b) => a + b, 0) / metrics.old.pprMAE.length * 10) / 10;
  const avgNewPPR = Math.round(metrics.new.pprMAE.reduce((a, b) => a + b, 0) / metrics.new.pprMAE.length * 10) / 10;

  console.log(`\n  Avg Pass Att MAE:  Old=${avgOldPA}  New=${avgNewPA}  Delta=${Math.round((avgNewPA - avgOldPA) * 10) / 10} ${avgNewPA < avgOldPA ? '✅ IMPROVED' : '❌ WORSE'}`);
  console.log(`  Avg Rush Att MAE:  Old=${avgOldRA}  New=${avgNewRA}  Delta=${Math.round((avgNewRA - avgOldRA) * 10) / 10} ${avgNewRA < avgOldRA ? '✅ IMPROVED' : '❌ WORSE'}`);
  console.log(`  Avg Team PPR MAE:  Old=${avgOldPPR}  New=${avgNewPPR}  Delta=${Math.round((avgNewPPR - avgOldPPR) * 10) / 10} ${avgNewPPR < avgOldPPR ? '✅ IMPROVED' : '❌ WORSE'}`);
  console.log();
}

main().catch((e) => {
  console.error('Test failed:', e.message || e);
  process.exit(0);
});
