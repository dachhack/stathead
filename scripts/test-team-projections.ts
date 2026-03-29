// Backtest team volume projections: simple blend vs delta model.
// Run: NODE_OPTIONS='--max-old-space-size=4096' npx tsx scripts/test-team-projections.ts

import { fetchPlayerStats, aggregateToSeasonTotals, fetchGames } from '../src/data';
import { projectTeamTotals } from '../src/lib/teamProjection';
import { buildTeamDeltaData, trainTeamDeltaModel } from '../src/lib/teamDeltaModel';
import type { Game, SeasonTotals } from '../src/types';

const SEASONS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];

function mae(actuals: number[], preds: number[]): number {
  if (actuals.length === 0) return 0;
  return Math.round(actuals.reduce((s, a, i) => s + Math.abs(a - preds[i]), 0) / actuals.length * 10) / 10;
}

async function main() {
  console.log('Loading games data...');
  const gamesData = await fetchGames();

  // Pre-fetch all season totals
  console.log('Loading player stats for all seasons...');
  const allTotals = new Map<number, SeasonTotals[]>();
  for (const s of [2017, 2018, ...SEASONS]) {
    try {
      const stats = await fetchPlayerStats(s);
      allTotals.set(s, aggregateToSeasonTotals(stats.filter((st) => st.season_type === 'REG')));
    } catch { /* skip missing */ }
  }

  console.log('Backtesting team projections...\n');
  console.log('Three approaches:');
  console.log('  Blend: prior × weight + league_avg × (1-weight)');
  console.log('  Delta: prior + ML-predicted year-over-year change');
  console.log();

  const blendMAEs = { passAtt: [] as number[], rushAtt: [] as number[], ppr: [] as number[] };
  const deltaMAEs = { passAtt: [] as number[], rushAtt: [] as number[], ppr: [] as number[] };

  // Build delta training data for all seasons
  const deltaData = buildTeamDeltaData(SEASONS, allTotals, gamesData);
  console.log(`Delta model training data: ${deltaData.length} team-seasons\n`);

  for (const season of SEASONS) {
    const currentTotals = allTotals.get(season);
    const priorTotals = allTotals.get(season - 1);
    if (!currentTotals || !priorTotals) {
      console.log(`=== ${season} === Skipped (missing data)\n`);
      continue;
    }

    // Actual team totals
    const actualByTeam = new Map<string, { passAtt: number; rushAtt: number; ppr: number }>();
    for (const p of currentTotals) {
      const team = p.recent_team;
      if (!team) continue;
      const t = actualByTeam.get(team) || { passAtt: 0, rushAtt: 0, ppr: 0 };
      t.passAtt += p.attempts || 0;
      t.rushAtt += p.carries || 0;
      t.ppr += p.fantasy_points_ppr || 0;
      actualByTeam.set(team, t);
    }

    // 1. Simple blend
    const blendProj = projectTeamTotals(priorTotals);

    // 2. Delta model (LOSO: train on all seasons except current)
    const deltaTrain = deltaData.filter((r) => r.season !== season);
    const deltaTest = deltaData.filter((r) => r.season === season);
    let deltaResult: Map<string, { passAtt: number; rushAtt: number; targets: number; passTD: number; rushTD: number }>;

    if (deltaTrain.length >= 30 && deltaTest.length > 0) {
      const { predictions } = trainTeamDeltaModel(deltaTrain, deltaTest);
      deltaResult = predictions;
    } else {
      deltaResult = new Map();
    }

    // Compare
    const bPA: number[] = [], bPP: number[] = [];
    const bRA: number[] = [], bRP: number[] = [];
    const bPPR: number[] = [], bPPRP: number[] = [];
    const dPA: number[] = [], dPP: number[] = [];
    const dRA: number[] = [], dRP: number[] = [];
    const dPPR: number[] = [], dPPRP: number[] = [];

    for (const [team, actual] of actualByTeam) {
      const bp = blendProj.get(team);
      const dp = deltaResult.get(team);

      if (bp) {
        bPA.push(actual.passAtt); bPP.push(bp.passAtt);
        bRA.push(actual.rushAtt); bRP.push(bp.rushAtt);
        bPPR.push(actual.ppr); bPPRP.push(bp.pprPts);
      }
      if (dp) {
        dPA.push(actual.passAtt); dPP.push(dp.passAtt);
        dRA.push(actual.rushAtt); dRP.push(dp.rushAtt);
        // Approximate PPR from volumes
        const estPPR = dp.passAtt * 7 * 0.04 + dp.passTD * 4 + dp.rushAtt * 4 * 0.1 + dp.rushTD * 6;
        dPPR.push(actual.ppr); dPPRP.push(estPPR);
      }
    }

    const bPAMae = mae(bPA, bPP);
    const dPAMae = dPA.length > 0 ? mae(dPA, dPP) : 0;
    const bRAMae = mae(bRA, bRP);
    const dRAMae = dRA.length > 0 ? mae(dRA, dRP) : 0;

    blendMAEs.passAtt.push(bPAMae);
    blendMAEs.rushAtt.push(bRAMae);
    if (dPAMae > 0) deltaMAEs.passAtt.push(dPAMae);
    if (dRAMae > 0) deltaMAEs.rushAtt.push(dRAMae);

    console.log(`=== ${season} ===`);
    console.log(`  Pass Att MAE:  Blend=${bPAMae}  Delta=${dPAMae || 'N/A'}  ${dPAMae && dPAMae < bPAMae ? '✅ DELTA' : dPAMae && dPAMae > bPAMae ? '❌ BLEND' : '➖'}`);
    console.log(`  Rush Att MAE:  Blend=${bRAMae}  Delta=${dRAMae || 'N/A'}  ${dRAMae && dRAMae < bRAMae ? '✅ DELTA' : dRAMae && dRAMae > bRAMae ? '❌ BLEND' : '➖'}`);
    console.log();
  }

  // Aggregate
  console.log('='.repeat(60));
  console.log('AGGREGATE RESULTS');
  console.log('='.repeat(60));
  const avgBlendPA = blendMAEs.passAtt.reduce((a, b) => a + b, 0) / blendMAEs.passAtt.length;
  const avgDeltaPA = deltaMAEs.passAtt.length > 0 ? deltaMAEs.passAtt.reduce((a, b) => a + b, 0) / deltaMAEs.passAtt.length : 0;
  const avgBlendRA = blendMAEs.rushAtt.reduce((a, b) => a + b, 0) / blendMAEs.rushAtt.length;
  const avgDeltaRA = deltaMAEs.rushAtt.length > 0 ? deltaMAEs.rushAtt.reduce((a, b) => a + b, 0) / deltaMAEs.rushAtt.length : 0;

  console.log(`\n  Avg Pass Att MAE:  Blend=${avgBlendPA.toFixed(1)}  Delta=${avgDeltaPA.toFixed(1)}  ${avgDeltaPA < avgBlendPA ? '✅ DELTA WINS' : '❌ BLEND WINS'}`);
  console.log(`  Avg Rush Att MAE:  Blend=${avgBlendRA.toFixed(1)}  Delta=${avgDeltaRA.toFixed(1)}  ${avgDeltaRA < avgBlendRA ? '✅ DELTA WINS' : '❌ BLEND WINS'}`);

  // Print delta model CV metrics
  if (deltaData.length > 0) {
    console.log('\n  Delta model features (what drives volume changes):');
    const allTrain = deltaData;
    const { cvMetrics } = trainTeamDeltaModel(allTrain, []);
    for (const [stat, m] of Object.entries(cvMetrics)) {
      console.log(`    ${stat}: R²=${m.r2.toFixed(3)}, MAE=${m.mae}`);
    }
  }
  console.log();
}

main().catch((e) => {
  console.error('Test failed:', e.message || e);
  process.exit(0);
});
