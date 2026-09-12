// Test script: the Trade Finisher engine (src/lib/tradeFinisher.ts).
// Run: npx tsx scripts/test-trade-finisher.ts
//
// A synthetic 12-team superflex league: lineups, needs, goal reads, the
// fairness/legality gates on an offer, and the search for nearby offers.

import type { LeagueTeam, RosterPlayer, SleeperTradedPick } from '../src/lib/sleeper';
import type { DynastyPlayer } from '../src/types';
import {
  buildFinisherTeams, computeNeeds, evaluateOffer, suggestFinishes, optimalLineup, partnerPositives,
  pickTier, tepLevelFromScoring, tradablePickSeasons, isSuperflexLeague,
  type FinisherAsset, type Offer,
} from '../src/lib/tradeFinisher';

let passed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) passed++; else failures.push(name + (detail ? ` — ${detail}` : ''));
};

// ── League fixture ────────────────────────────────────────────────────────
const ROSTER_POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
const TEAMS = 12;

let nextId = 1000;
let nextKtc = 1;
const dynasty: DynastyPlayer[] = [];
const proj = new Map<string, number>();

function mk(name: string, position: string, age: number, value: number, pts: number): RosterPlayer {
  const id = String(nextId++);
  dynasty.push({ playerID: nextKtc++, playerName: name, position, positionRank: 0, team: 'FA', age, value: Math.round(value * 0.8), superflexValue: value, isRookie: false, slug: name.toLowerCase() });
  proj.set(id, pts);
  return { id, name, position, team: 'FA', slot: 'BN' };
}

// Board rows for picks, in the "2027 Mid 1st" shape the finisher looks up.
for (const season of ['2027', '2028']) {
  for (const [round, word] of [[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th']] as const) {
    for (const [tier, mult] of [['Early', 1.2], ['Mid', 1], ['Late', 0.85]] as const) {
      const base = { 1: 6000, 2: 3500, 3: 2500, 4: 1800 }[round] * mult * (season === '2028' ? 0.9 : 1);
      dynasty.push({ playerID: nextKtc++, playerName: `${season} ${tier} ${word}`, position: 'RDP', positionRank: 0, team: 'FA', age: 0, value: Math.round(base * 0.95), superflexValue: Math.round(base), isRookie: false, slug: '' });
    }
  }
}

// Team 1 = "me": strong WR room, weak RB room, old core. Team 2 = partner:
// young, RB-rich, thin at WR. Teams 3–12 are average filler.
function team(rosterId: number, name: string, players: RosterPlayer[], wins = 2, losses = 2): LeagueTeam {
  return { rosterId, teamName: name, owner: `owner${rosterId}`, ownerId: `u${rosterId}`, wins, losses, ties: 0, pointsFor: 0, pointsAgainst: 0, starters: [], bench: players };
}

const me = team(1, 'Old Guard', [
  mk('QB Vet', 'QB', 33, 5200, 330), mk('QB Young', 'QB', 25, 4500, 280),
  mk('RB Aging', 'RB', 29, 2500, 150), mk('RB Scrub', 'RB', 27, 600, 70), mk('RB Scrub2', 'RB', 26, 400, 50),
  mk('WR Star', 'WR', 27, 8500, 300), mk('WR Two', 'WR', 28, 6000, 250), mk('WR Three', 'WR', 29, 4500, 210), mk('WR Four', 'WR', 30, 3000, 170),
  mk('TE Old', 'TE', 31, 2000, 120), mk('TE Backup', 'TE', 28, 500, 40),
], 4, 1);

const partner = team(2, 'Youth Movement', [
  mk('QB Kid', 'QB', 23, 6000, 270), mk('QB Bridge', 'QB', 30, 2000, 220),
  mk('RB Stud', 'RB', 23, 7500, 280), mk('RB Two', 'RB', 24, 5000, 220), mk('RB Three', 'RB', 22, 3500, 160), mk('RB Four', 'RB', 25, 2000, 120),
  mk('WR Thin', 'WR', 24, 3000, 150), mk('WR Thinner', 'WR', 23, 2000, 110), mk('WR Rookie', 'WR', 22, 2500, 90),
  mk('TE Young', 'TE', 24, 3500, 150), mk('TE Two', 'TE', 25, 800, 50),
], 1, 4);

const filler: LeagueTeam[] = [];
for (let r = 3; r <= TEAMS; r++) {
  filler.push(team(r, `Team ${r}`, [
    mk(`QB1-${r}`, 'QB', 27, 4500, 290), mk(`QB2-${r}`, 'QB', 27, 2500, 230),
    mk(`RB1-${r}`, 'RB', 25, 4500, 210), mk(`RB2-${r}`, 'RB', 25, 3000, 160), mk(`RB3-${r}`, 'RB', 25, 1500, 100),
    mk(`WR1-${r}`, 'WR', 26, 5000, 230), mk(`WR2-${r}`, 'WR', 26, 3500, 190), mk(`WR3-${r}`, 'WR', 26, 2000, 140),
    mk(`TE1-${r}`, 'TE', 26, 2500, 130), mk(`TE2-${r}`, 'TE', 26, 600, 50),
  ]));
}
const teams = [me, partner, ...filler];

// The partner owns my 2027 1st (I traded it away last year).
const tradedPicks: SleeperTradedPick[] = [{ season: '2027', round: 1, roster_id: 1, previous_owner_id: 1, owner_id: 2 }];

const fin = buildFinisherTeams(teams, {
  dynasty, isSuperflex: true, tepLevel: 0, rosterPositions: ROSTER_POSITIONS,
  projBySleeperId: proj, tradedPicks, seasons: ['2027', '2028'],
});
const F_ME = fin.find((t) => t.rosterId === 1)!;
const F_THEM = fin.find((t) => t.rosterId === 2)!;
const byName = (t: typeof F_ME, n: string) => t.assets.find((a) => a.name.startsWith(n))!;

// ── Format helpers ────────────────────────────────────────────────────────
check('superflex detected from SUPER_FLEX slot', isSuperflexLeague(ROSTER_POSITIONS));
check('1QB detected without a superflex slot', !isSuperflexLeague(['QB', 'RB', 'WR', 'FLEX', 'BN']));
check('TE premium from Sleeper bonus_rec_te', tepLevelFromScoring({ bonus_rec_te: 0.5 }) === 1 && tepLevelFromScoring({ bonus_rec_te: 1 }) === 2 && tepLevelFromScoring({}) === 0);
check('pick seasons after the rookie draft are next two years', tradablePickSeasons(new Date('2026-09-12')).join(',') === '2027,2028');
check('pick seasons before the rookie draft include this year', tradablePickSeasons(new Date('2026-03-01')).join(',') === '2026,2027');
check('pick tiers split the round in thirds', pickTier(1, 12) === 'Early' && pickTier(6, 12) === 'Mid' && pickTier(12, 12) === 'Late');

// ── Assets & picks ────────────────────────────────────────────────────────
const myPicks = F_ME.assets.filter((a) => a.type === 'pick');
const theirPicks = F_THEM.assets.filter((a) => a.type === 'pick');
check('my 2027 1st moved to the partner', !myPicks.some((a) => a.id === 'k:2027-1-1') && theirPicks.some((a) => a.id === 'k:2027-1-1'));
check('traded pick is labelled via its original owner', theirPicks.find((a) => a.id === 'k:2027-1-1')!.name.includes('(via Old Guard)'));
check('I still hold 7 picks (8 minus the traded 1st)', myPicks.length === 7, `got ${myPicks.length}`);
check('partner holds 9 picks', theirPicks.length === 9, `got ${theirPicks.length}`);
const p27 = theirPicks.find((a) => a.id === 'k:2027-1-1')!;
check('pick priced from the board row (superflex value)', p27.value > 0 && p27.ktcId != null && dynasty.find((d) => d.playerID === p27.ktcId)!.position === 'RDP');
// Old Guard projects strongest → its pick slots late → "Late 1st" row.
check('a contender\'s pick prices as a late pick', dynasty.find((d) => d.playerID === p27.ktcId)!.playerName === '2027 Late 1st', dynasty.find((d) => d.playerID === p27.ktcId)!.playerName);
check('player value uses the superflex column', byName(F_ME, 'WR Star').value === 8500);
check('assets sort by value', F_ME.assets[0].name === 'WR Star');

// ── Lineups ───────────────────────────────────────────────────────────────
const lu = optimalLineup(F_ME.assets, ROSTER_POSITIONS);
check('lineup fills every skill slot', lu.slots.length === 8 && lu.slots.every((s) => s.asset));
check('second QB lands in SUPER_FLEX', lu.slots.find((s) => s.slot === 'SUPER_FLEX')!.asset!.name === 'QB Young');
check('FLEX takes the best remaining skill player', lu.slots.find((s) => s.slot === 'FLEX')!.asset!.name === 'WR Three');
check('lineup total sums the starters', Math.round(lu.total) === 330 + 280 + 150 + 70 + 300 + 250 + 120 + 210);

// ── Needs ─────────────────────────────────────────────────────────────────
const myNeeds = computeNeeds(F_ME, fin, ROSTER_POSITIONS);
const theirNeeds = computeNeeds(F_THEM, fin, ROSTER_POSITIONS);
check('my RB room reads weak', myNeeds.weak.includes('RB'), myNeeds.weak.join(','));
check('my WR room reads strong (surplus on the bench)', myNeeds.strong.includes('WR'), myNeeds.strong.join(','));
check('partner WR reads weak', theirNeeds.weak.includes('WR'), theirNeeds.weak.join(','));
check('partner RB reads strong', theirNeeds.strong.includes('RB'), theirNeeds.strong.join(','));
check('old 4-1 roster infers win-now', myNeeds.inferredGoal === 'win-now', `${myNeeds.inferredGoal} (${myNeeds.goalReason})`);
check('young 1-4 roster infers rebuild', theirNeeds.inferredGoal === 'rebuild', `${theirNeeds.inferredGoal} (${theirNeeds.goalReason})`);
check('league median RB points is the filler value', Math.round(myNeeds.positions.find((p) => p.pos === 'RB')!.median) === 370);

// ── Evaluate an offer ─────────────────────────────────────────────────────
const ctx = { rosterPositions: ROSTER_POSITIONS, myGoal: 'win-now' as const, partnerGoal: 'rebuild' as const, myNeeds, partnerNeeds: theirNeeds };
const lopsided: Offer = { give: [byName(F_ME, 'WR Four')], get: [byName(F_THEM, 'RB Stud')] };
const ev1 = evaluateOffer(lopsided, F_ME, F_THEM, ctx);
check('WR4 for a stud RB is lopsided in my favour', ev1.verdict === 'lopsided' && ev1.diff > 0, `${ev1.verdict} ${ev1.diff}`);
check('lineup delta credits the RB upgrade', ev1.myLineupDelta > 0 && ev1.partnerLineupDelta < 0);
check('needs tag names the RB fix', ev1.tags.some((t) => t === 'Fills your RB'), ev1.tags.join(' | '));

const even: Offer = { give: [byName(F_ME, 'WR Two')], get: [byName(F_THEM, 'RB Two'), byName(F_THEM, 'WR Thinner')] };
const ev2 = evaluateOffer(even, F_ME, F_THEM, ctx);
check('WR2 for RB2 + WR is about fair', ev2.fairnessPct <= 20, ev2.fairnessPct.toFixed(1));
check('taking on an extra player flags a drop', ev2.netPlayers === 1 && ev2.tags.includes('Needs 1 drop'));

const illegal: Offer = { give: [byName(F_ME, 'TE Old'), byName(F_ME, 'TE Backup')], get: [byName(F_THEM, 'RB Four')] };
const ev3 = evaluateOffer(illegal, F_ME, F_THEM, ctx);
check('emptying my TE room is illegal', !ev3.legal && /starting TE/.test(ev3.illegalReason ?? ''), ev3.illegalReason);

// ── Suggested finishes ────────────────────────────────────────────────────
const variants = suggestFinishes(lopsided, F_ME, F_THEM, ctx, { max: 8 });
check('lopsided offer yields finishes', variants.length > 0, String(variants.length));
check('every finish is inside tolerance', variants.every((v) => v.eval.fairnessPct <= 12), variants.map((v) => v.eval.fairnessPct.toFixed(0)).join(','));
check('every finish is legal', variants.every((v) => v.eval.legal));
check('every finish is one or two edits away', variants.every((v) => v.edits.length >= 1 && v.edits.length <= 2));
check('finishes keep RB Stud (the piece I wanted) in most versions', variants.filter((v) => v.offer.get.some((a) => a.name === 'RB Stud')).length >= variants.length / 2);
check('a win-now buyer is asked to add value, not receive more', variants.every((v) => v.eval.giveValue > lopsided.give[0].value));
check('finishes are ranked by score', variants.every((v, i) => i === 0 || variants[i - 1].eval.score >= v.eval.score));
check('no duplicate finishes', new Set(variants.map((v) => v.offer.give.map((a) => a.id).sort().join() + '|' + v.offer.get.map((a) => a.id).sort().join())).size === variants.length);
check('at least one finish uses a draft pick', variants.some((v) => [...v.offer.give, ...v.offer.get].some((a) => a.type === 'pick')));
check('a rebuilding partner is never clearly worse off on their goal', variants.every((v) => v.eval.partnerFit >= -0.5));
check('every finish serves a win-now goal (lineup or value up)', variants.every((v) => v.eval.myLineupDelta > 0 || v.eval.diff >= 0));

// ── The partner's read: positives for them only ────────────────────────────
const pp1 = partnerPositives(ev1, theirNeeds, lopsided);
check('partner read never mentions the proposer', pp1.every((t) => !/Old Guard|their|Their/.test(t)), pp1.join(' | '));
check('partner read omits their lineup loss on a lopsided offer', !pp1.some((t) => /lineup/.test(t)), pp1.join(' | '));
check('partner read names the WR hole the offer fills', pp1.includes('Fills your WR'), pp1.join(' | '));
const sweet: Offer = { give: [byName(F_ME, 'WR Four'), byName(F_ME, '2028 1st')], get: [byName(F_THEM, 'RB Stud')] };
const evS = evaluateOffer(sweet, F_ME, F_THEM, ctx);
const ppS = partnerPositives(evS, theirNeeds, sweet);
check('partner read credits the pick they add', ppS.some((t) => /You add 1 pick/.test(t)), ppS.join(' | '));
check('partner read credits the value when they win it', evS.diff >= 0 || ppS.some((t) => /You win the value/.test(t)), ppS.join(' | '));
check('partner read speaks in the second person', ppS.every((t) => /^(You|Your|Fills your|Frees|About even|Serves your)/.test(t)), ppS.join(' | '));

// Empty offer → the search proposes whole trades.
const fromScratch = suggestFinishes({ give: [], get: [] }, F_ME, F_THEM, ctx, { max: 5 });
check('an empty offer still yields whole trades', fromScratch.length > 0 && fromScratch.every((v) => v.offer.give.length && v.offer.get.length));

// Deterministic: same inputs, same output.
const again = suggestFinishes(lopsided, F_ME, F_THEM, ctx, { max: 8 });
check('search is deterministic', JSON.stringify(again.map((v) => v.offer.get.map((a: FinisherAsset) => a.id))) === JSON.stringify(variants.map((v) => v.offer.get.map((a) => a.id))));

// ── Report ────────────────────────────────────────────────────────────────
console.log(`\nTrade finisher: ${passed} passed, ${failures.length} failed`);
if (variants.length) {
  console.log('\nTop finishes for WR Four → RB Stud:');
  for (const v of variants.slice(0, 4)) {
    console.log(`  [${v.eval.score.toFixed(2)}] give ${v.offer.give.map((a) => a.name).join(' + ')} | get ${v.offer.get.map((a) => a.name).join(' + ')} | ${v.eval.verdict} ${v.eval.diff >= 0 ? '+' : ''}${v.eval.diff} | ${v.eval.tags.join(', ')}`);
  }
}
for (const f of failures) console.log('  FAIL:', f);
process.exit(failures.length ? 1 : 0);
