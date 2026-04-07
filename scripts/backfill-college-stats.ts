/**
 * Backfill college stats for historical rookies.
 *
 * Fetches nflverse college_statistics.csv, cross-references with training rows,
 * and writes missing college data to the prospect store so player cards have data.
 *
 * Run: npx tsx scripts/backfill-college-stats.ts
 * Or: runs automatically during precompute-features.ts
 */

import { fetchCollegeStats, fetchDraftPicks, fetchCombine } from '../src/data';
import { buildCollegeAnalytics } from '../src/lib/collegeAnalytics';
import { normalizeName, POSITIONS } from '../src/lib/featureTypes';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const STORE_PATH = 'public/data/feature-store/prospects.json';

async function main() {
  console.log('Backfilling college stats for historical rookies...');

  // Load existing prospect store
  let store: Record<string, any> = {};
  if (existsSync(STORE_PATH)) {
    store = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
  }
  const existingCount = Object.keys(store).length;

  // Load training rows to find who needs backfill
  const cachePath = existsSync('public/data/training-rows-cache-v32.json')
    ? 'public/data/training-rows-cache-v32.json'
    : existsSync('public/data/training-rows-cache-v31.json')
    ? 'public/data/training-rows-cache-v31.json'
    : null;

  if (!cachePath) {
    console.log('No training cache found, skipping backfill');
    return;
  }

  const cached = JSON.parse(readFileSync(cachePath, 'utf-8'));
  const rows = cached.rows;

  // Find rookies needing backfill
  const needsBackfill = new Map<string, { name: string; pos: string; draftSeason: number; pick: number }>();
  for (const r of rows) {
    const yil = r.features?.yearsInLeague ?? 99;
    if (yil > 1) continue;
    const pick = r.features?.nflDraftPick || 300;
    const age = r.features?.age || 0;
    if (pick >= 300 && age === 0) continue; // UDFA veteran

    const nn = normalizeName(r.name);
    if (store[nn]) continue; // already in store

    const hasCollege = (r.features?.hasCollegeStats || 0) > 0;
    const hasZAP = (r.features?.collegeBreakoutScore || 0) > 0 || (r.features?.collegeRecYdsPerTeamPassAtt || 0) > 0;
    if (hasCollege && hasZAP) continue; // already has data

    const draftSeason = r.season - yil;
    if (!needsBackfill.has(nn)) {
      needsBackfill.set(nn, { name: r.name, pos: r.position, draftSeason, pick });
    }
  }

  console.log(`  ${needsBackfill.size} rookies need college data backfill`);
  if (needsBackfill.size === 0) return;

  // Fetch college stats from nflverse
  console.log('  Fetching college stats from nflverse...');
  const [collegeStatsData, draftData, combineData] = await Promise.all([
    fetchCollegeStats().catch(() => []),
    fetchDraftPicks().catch(() => []),
    fetchCombine().catch(() => []),
  ]);

  if (collegeStatsData.length === 0) {
    console.log('  No college stats available, skipping backfill');
    return;
  }

  // Build lookups
  const collegeByName = new Map<string, Map<string, number>>();
  for (const cs of collegeStatsData) {
    const name = normalizeName(cs.player_name);
    if (!collegeByName.has(name)) collegeByName.set(name, new Map());
    const existing = collegeByName.get(name)!;
    const existingKey = `${cs.statistic}:latest`;
    const existingSeason = existing.get(existingKey) || 0;
    if (cs.season >= existingSeason) {
      existing.set(cs.statistic, cs.value || 0);
      existing.set(existingKey, cs.season);
    }
  }

  const draftByName = new Map<string, any>();
  for (const d of draftData) draftByName.set(normalizeName(d.pfr_player_name), d);

  const combineByName = new Map<string, any>();
  for (const c of combineData) combineByName.set(normalizeName(c.player_name), c);

  const prospectByName = new Map<string, any>(); // empty, not needed for analytics

  // Build college analytics
  console.log('  Computing college analytics...');
  const analytics = buildCollegeAnalytics(collegeStatsData, draftByName, collegeByName, prospectByName);

  // Backfill each rookie
  let filled = 0;
  for (const [nn, info] of needsBackfill) {
    const cs = collegeByName.get(nn);
    const pg = analytics.collegePerGameByName.get(nn);
    const adv = analytics.collegeAdvancedByName.get(nn);
    const best = analytics.collegeBestSeasonByName.get(nn);
    const zap = analytics.collegeZapByName.get(nn);
    const ts = analytics.teammateScoreByName.get(nn) || 0;
    const draft = draftByName.get(nn);
    const combine = combineByName.get(nn);

    // Only backfill if we have SOME data
    if (!cs && !combine && !draft) continue;

    const wt = combine?.wt || 0;
    const ft = combine?.forty || 0;
    const ss = (wt > 0 && ft > 0) ? Math.round((wt * 200) / Math.pow(ft, 4) * 10) / 10 : 0;
    const ht = combine?.ht ? (typeof combine.ht === 'string' ? (() => {
      const parts = combine.ht.split('-');
      return parts.length === 2 ? Number(parts[0]) * 12 + Number(parts[1]) : 0;
    })() : combine.ht) : 0;

    const recYds = cs?.get('Receiving Yards') || 0;
    const rushYds = cs?.get('Rushing Yards') || 0;
    const recs = cs?.get('Receptions') || 0;
    const rushAtt = cs?.get('Rushing Attempts') || cs?.get('Carries') || 0;
    const totalTDs = (cs?.get('Passing Touchdowns') || 0) + (cs?.get('Rushing Touchdowns') || 0) + (cs?.get('Receiving Touchdowns') || 0);

    store[nn] = {
      name: info.name,
      pos: info.pos,
      school: draft?.college || combine?.school || '',
      age: draft?.age || 0,
      projRound: draft?.round || 8,
      projPick: info.pick,
      weight: wt,
      forty: ft,
      height: ht,
      collegeRushYds: rushYds,
      collegeRushTDs: cs?.get('Rushing Touchdowns') || 0,
      collegeRushAtt: rushAtt,
      collegeRecYds: recYds,
      collegeRecTDs: cs?.get('Receiving Touchdowns') || 0,
      collegeReceptions: recs,
      collegePassTDs: cs?.get('Passing Touchdowns') || 0,
      collegeTotalTDs: totalTDs,
      collegeGames: pg?.games || 0,
      collegeSeasons: best?.numSeasons || 0,
      collegeRecPerGame: pg?.recPerGame || 0,
      collegeYdsPerGame: pg?.ydsPerGame || 0,
      collegeTDsPerGame: pg?.tdsPerGame || 0,
      collegeRushYPC: pg?.rushYPC || 0,
      collegeYdsPerRec: pg?.ydsPerRec || 0,
      collegeBestRecYds: best?.bestRecYds || 0,
      collegeBestRushYds: best?.bestRushYds || 0,
      collegeDominatorRating: adv?.dominatorRating || 0,
      collegeBreakoutAge: adv?.breakoutAge || 0,
      collegeMarketShare: adv?.marketShare || 0,
      collegeRecYdsPerTeamPassAtt: zap?.recYdsPerTeamPassAtt || 0,
      collegeReceptionShare: zap?.receptionShare || 0,
      collegeBreakoutScore: zap?.breakoutScore || 0,
      collegeRushProductionWR: zap?.rushProductionWR || 0,
      collegeTeammateScore: ts,
      collegeEarlyDeclare: (best?.numSeasons || 99) <= 3 ? 1 : 0,
      speedScore: ss,
      heightAdjSpeedScore: (ht > 0 && ss > 0) ? Math.round(ss * (ht / 76) * 10) / 10 : ss,
      source: 'backfill',
      updatedAt: new Date().toISOString(),
    };
    filled++;
  }

  // Write updated store
  mkdirSync('public/data/feature-store', { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  console.log(`  Backfilled ${filled} rookies (${existingCount} existing → ${Object.keys(store).length} total)`);
}

main().catch(e => {
  console.error('Backfill failed:', e);
  process.exit(0); // don't fail the build
});
