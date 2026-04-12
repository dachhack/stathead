/**
 * Add or update prospect features in the feature store.
 *
 * Usage:
 *   # Add with inline stats
 *   npx tsx scripts/add-prospect.ts --name "Kaytron Allen" --pos RB --school "Penn St." \
 *     --age 21 --projRound 5 --projPick 160 --collegeSeasons 3 \
 *     --rushYds 1800 --rushTDs 16 --rushAtt 350 --recYds 200 --receptions 30 --games 36 \
 *     --weight 220 --forty 4.52
 *
 *   # List all prospects in the store
 *   npx tsx scripts/add-prospect.ts --list
 *
 *   # Show one prospect
 *   npx tsx scripts/add-prospect.ts --show "Kaytron Allen"
 *
 *   # Bulk add from CSV (name,pos,school,rushYds,recYds,...)
 *   npx tsx scripts/add-prospect.ts --csv prospects.csv
 */

import { loadProspectStore, saveProspectStore, upsertProspect } from '../src/lib/featureStore/prospectStore';
import type { ProspectFeatures } from '../src/lib/featureStore/prospectStore';
import { normalizeName } from '../src/lib/featureTypes';
import { readFileSync, existsSync } from 'fs';

function main() {
  const args = process.argv.slice(2);
  const store = loadProspectStore();

  // ── List mode ──
  if (args.includes('--list')) {
    if (store.size === 0) {
      console.log('No prospects in store. Add with: npx tsx scripts/add-prospect.ts --name "Player" --pos RB ...');
      return;
    }
    console.log(`\nProspect Feature Store (${store.size} prospects)\n`);
    console.log('  ' + 'Name'.padEnd(25) + 'Pos'.padEnd(5) + 'School'.padEnd(20) + 'Rush'.padStart(6) + 'Rec'.padStart(6) + 'TDs'.padStart(5) + 'Wt'.padStart(5) + '40'.padStart(6) + '  Source');
    console.log('  ' + '─'.repeat(95));
    for (const [, p] of [...store].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
      console.log('  ' +
        p.name.padEnd(25) +
        (p.pos || '').padEnd(5) +
        (p.school || '').padEnd(20) +
        String(p.collegeRushYds || '-').padStart(6) +
        String(p.collegeRecYds || '-').padStart(6) +
        String(p.collegeTotalTDs || '-').padStart(5) +
        String(p.weight || '-').padStart(5) +
        String(p.forty || '-').padStart(6) +
        '  ' + (p.source || 'manual')
      );
    }
    return;
  }

  // ── Show mode ──
  const showName = getFlag(args, '--show');
  if (showName) {
    const key = normalizeName(showName);
    const p = store.get(key);
    if (!p) {
      console.log(`Prospect not found: ${showName}`);
      return;
    }
    console.log(JSON.stringify(p, null, 2));
    return;
  }

  // ── CSV bulk mode ──
  const csvPath = getFlag(args, '--csv');
  if (csvPath) {
    if (!existsSync(csvPath)) {
      console.error(`CSV file not found: ${csvPath}`);
      process.exit(1);
    }
    const lines = readFileSync(csvPath, 'utf-8').split('\n').filter(l => l.trim());
    const header = lines[0].split(',').map(h => h.trim());
    let added = 0;
    for (const line of lines.slice(1)) {
      const vals = line.split(',').map(v => v.trim());
      const row: Record<string, string> = {};
      header.forEach((h, i) => { row[h] = vals[i] || ''; });

      const prospect: ProspectFeatures = {
        name: row.name || '',
        pos: row.pos || '',
        school: row.school || '',
        source: 'csv',
      };
      if (!prospect.name || !prospect.pos) continue;

      // Map CSV columns to prospect fields
      const numFields: Array<[string, keyof ProspectFeatures]> = [
        ['age', 'age'], ['projRound', 'projRound'], ['projPick', 'projPick'],
        ['weight', 'weight'], ['forty', 'forty'], ['height', 'height'],
        ['rushYds', 'collegeRushYds'], ['rushTDs', 'collegeRushTDs'], ['rushAtt', 'collegeRushAtt'],
        ['recYds', 'collegeRecYds'], ['recTDs', 'collegeRecTDs'], ['receptions', 'collegeReceptions'],
        ['passYds', 'collegePassYds'], ['passTDs', 'collegePassTDs'],
        ['games', 'collegeGames'], ['seasons', 'collegeSeasons'],
        ['dominatorRating', 'collegeDominatorRating'], ['breakoutAge', 'collegeBreakoutAge'],
        ['bestRecYds', 'collegeBestRecYds'], ['bestRushYds', 'collegeBestRushYds'],
        ['recYdsPerTPA', 'collegeRecYdsPerTeamPassAtt'], ['receptionShare', 'collegeReceptionShare'],
        ['breakoutScore', 'collegeBreakoutScore'], ['teammateScore', 'collegeTeammateScore'],
      ];
      for (const [csvKey, field] of numFields) {
        if (row[csvKey] && !isNaN(Number(row[csvKey]))) {
          (prospect as any)[field] = Number(row[csvKey]);
        }
      }

      upsertProspect(store, prospect);
      added++;
    }
    saveProspectStore(store);
    console.log(`Added ${added} prospects from ${csvPath}`);
    return;
  }

  // ── Single add mode ──
  const name = getFlag(args, '--name');
  const pos = getFlag(args, '--pos');
  if (!name || !pos) {
    console.log('Usage: npx tsx scripts/add-prospect.ts --name "Player Name" --pos RB [options]');
    console.log('\nRequired: --name, --pos');
    console.log('\nCollege stats: --rushYds, --rushTDs, --rushAtt, --recYds, --recTDs, --receptions, --passYds, --passTDs, --games, --seasons');
    console.log('Combine: --weight, --forty, --height, --bench, --vertical, --broadJump, --cone, --shuttle');
    console.log('Profile: --age, --school, --projRound, --projPick');
    console.log('Advanced: --dominatorRating, --breakoutAge, --bestRecYds, --bestRushYds');
    console.log('ZAP: --recYdsPerTPA, --receptionShare, --breakoutScore, --teammateScore');
    console.log('\nOther: --list, --show "name", --csv file.csv');
    return;
  }

  const prospect: ProspectFeatures = {
    name,
    pos,
    school: getFlag(args, '--school') || '',
    source: 'manual',
  };

  // Parse numeric flags
  const numFlags: Array<[string, keyof ProspectFeatures]> = [
    ['--age', 'age'], ['--projRound', 'projRound'], ['--projPick', 'projPick'],
    ['--weight', 'weight'], ['--forty', 'forty'], ['--height', 'height'],
    ['--bench', 'bench'], ['--vertical', 'vertical'], ['--broadJump', 'broadJump'],
    ['--cone', 'cone'], ['--shuttle', 'shuttle'],
    ['--rushYds', 'collegeRushYds'], ['--rushTDs', 'collegeRushTDs'], ['--rushAtt', 'collegeRushAtt'],
    ['--recYds', 'collegeRecYds'], ['--recTDs', 'collegeRecTDs'], ['--receptions', 'collegeReceptions'],
    ['--passYds', 'collegePassYds'], ['--passTDs', 'collegePassTDs'],
    ['--games', 'collegeGames'], ['--seasons', 'collegeSeasons'],
    ['--dominatorRating', 'collegeDominatorRating'], ['--breakoutAge', 'collegeBreakoutAge'],
    ['--bestRecYds', 'collegeBestRecYds'], ['--bestRushYds', 'collegeBestRushYds'],
    ['--recYdsPerTPA', 'collegeRecYdsPerTeamPassAtt'], ['--receptionShare', 'collegeReceptionShare'],
    ['--breakoutScore', 'collegeBreakoutScore'], ['--teammateScore', 'collegeTeammateScore'],
  ];
  for (const [flag, field] of numFlags) {
    const val = getFlag(args, flag);
    if (val && !isNaN(Number(val))) {
      (prospect as any)[field] = Number(val);
    }
  }

  upsertProspect(store, prospect);
  saveProspectStore(store);

  const stored = store.get(normalizeName(name))!;
  console.log(`✓ ${name} (${pos}, ${stored.school}) added to prospect store`);
  console.log(`  Rush: ${stored.collegeRushYds || 0} yds, Rec: ${stored.collegeRecYds || 0} yds, TDs: ${stored.collegeTotalTDs || 0}`);
  console.log(`  Speed Score: ${stored.speedScore || 'N/A'}, Weight: ${stored.weight || 'N/A'}, 40: ${stored.forty || 'N/A'}`);
  console.log(`  Seasons: ${stored.collegeSeasons || 'N/A'}, Early Declare: ${stored.collegeEarlyDeclare ?? 'N/A'}`);
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0 || idx >= args.length - 1) return undefined;
  return args[idx + 1];
}

main();
