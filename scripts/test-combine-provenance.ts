// Test script: combine provenance — which of a prospect's combine numbers are
// measured, which are pre-draft estimates, and which are the position average.
// Run: npx tsx scripts/test-combine-provenance.ts

import { COMBINE_BIT, maskOf, combineProvenance, provenanceNote, measuredDrillCount, hasProvenance, RAS_MIN_DRILLS } from '../src/lib/combineProvenance';
import { buildProspectFeatureRecord } from '../src/lib/featureStore/prospectStore';

let passed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail?: string) => { if (cond) passed++; else failures.push(name + (detail ? ` — ${detail}` : '')); };

// ── Masks ─────────────────────────────────────────────────────────────────
check('maskOf sets one bit per present metric', maskOf({ weight: 245, shuttle: 4.4 }) === (COMBINE_BIT.weight | COMBINE_BIT.shuttle));
check('maskOf ignores zeros and undefined', maskOf({ weight: 0, forty: undefined, bench: null }) === 0);

// ── The Boerkircher shape: sheet weight + 40, one measured drill, average for the rest ──
const sheet = buildProspectFeatureRecord({ name: 'Nate Boerkircher', pos: 'TE', school: 'Wisconsin', weight: 250, forty: 4.65, height: 78, projPick: 56 },
  { weight: 248, forty: 4.6, bench: 20.33, vertical: 33.34, broadJump: 115.92, cone: 7.19, shuttle: 4.37 });
check('sheet record marks weight + forty as estimates', sheet.combineEstimatedMask === (COMBINE_BIT.weight | COMBINE_BIT.forty), String(sheet.combineEstimatedMask));
check('sheet record has nothing measured', sheet.combineMeasuredMask === 0);
check('bench is the position average in the record', sheet.bench === 20.33);
check('bench reads as imputed', combineProvenance(sheet, 'bench') === 'imputed');
check('forty reads as estimated', combineProvenance(sheet, 'forty') === 'estimated');
check('speed score inherits the estimate', combineProvenance(sheet, 'speedScore') === 'estimated');
check('RAS with no measured drills reads as imputed', combineProvenance(sheet, 'relativeAthleticScore') === 'imputed');
check('RAS note says not tested', provenanceNote(sheet, 'relativeAthleticScore') === 'no RAS · not tested');

// precompute overlays nflverse: weight 245 and a 4.40 shuttle measured.
const overlaid = { ...sheet, weight: 245, shuttle: 4.4, combineMeasuredMask: maskOf({ weight: 245, shuttle: 4.4 }) };
overlaid.combineEstimatedMask = sheet.combineEstimatedMask & ~overlaid.combineMeasuredMask;
check('measured weight wins over the listed weight', combineProvenance(overlaid, 'weight') === 'measured');
check('the estimated forty survives when nothing was timed', combineProvenance(overlaid, 'forty') === 'estimated');
check('shuttle now measured', combineProvenance(overlaid, 'shuttle') === 'measured');
check('one measured drill (weight is not a drill)', measuredDrillCount(overlaid) === 1);
check('RAS still withheld below the drill floor', combineProvenance(overlaid, 'relativeAthleticScore') === 'imputed' && RAS_MIN_DRILLS === 3);
check('RAS note counts the tested drills', provenanceNote(overlaid, 'relativeAthleticScore') === 'no RAS · 1 drill tested');
check('speed score note names the estimate', /estimate/.test(provenanceNote(overlaid, 'speedScore') ?? ''));

// A full combine.
const full = { ...sheet, combineMeasuredMask: maskOf({ weight: 1, forty: 1, bench: 1, vertical: 1, broadJump: 1, cone: 1, shuttle: 1 }), combineEstimatedMask: 0 };
check('full combine: everything measured', ['forty', 'bench', 'cone', 'speedScore', 'relativeAthleticScore'].every((k) => combineProvenance(full, k) === 'measured'));
check('full combine: no notes', provenanceNote(full, 'forty') === null && provenanceNote(full, 'relativeAthleticScore') === null);

// ── Legacy records (no masks) fall back to the old flags ──────────────────
const legacyCombine = { forty: 4.5, weight: 210, hasCombineData: 1, hasPhysicalData: 1 };
const legacyNone = { forty: 4.55, weight: 205, hasCombineData: 0, hasPhysicalData: 1 };
check('legacy flag 1 → measured', !hasProvenance(legacyCombine) && combineProvenance(legacyCombine, 'forty') === 'measured' && combineProvenance(legacyCombine, 'relativeAthleticScore') === 'measured');
check('legacy flag 0 → imputed drills, roster weight kept', combineProvenance(legacyNone, 'forty') === 'imputed' && combineProvenance(legacyNone, 'weight') === 'measured');
check('non-combine keys are never flagged', combineProvenance(legacyNone, 'collegeDominatorRating') === 'measured' && provenanceNote(sheet, 'age') === null);

console.log(`\nCombine provenance: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL:', f);
process.exit(failures.length ? 1 : 0);
