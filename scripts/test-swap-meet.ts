// Test script: the Swap Meet negotiation model (src/lib/swapMeetCore.ts),
// shared by the app and the swap-meet Worker.
// Run: npx tsx scripts/test-swap-meet.ts

import {
  createMeet, applyAction, MeetError, LIMITS, optionNotes, generalNotes, randomId,
  type NewMeetInput, type Meet,
} from '../src/lib/swapMeetCore';
import type { FinisherAsset, FinisherTeam } from '../src/lib/tradeFinisher';

let passed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail?: string) => { if (cond) passed++; else failures.push(name + (detail ? ` — ${detail}` : '')); };
const throws = (name: string, fn: () => unknown, status?: number) => {
  try { fn(); failures.push(`${name} — did not throw`); }
  catch (e) { if (e instanceof MeetError && (status == null || e.status === status)) passed++; else failures.push(`${name} — wrong error ${String(e)}`); }
};

const asset = (id: string, name: string, value: number, pts = 100, type: 'player' | 'pick' = 'player'): FinisherAsset =>
  ({ id, type, name, position: type === 'pick' ? 'PICK' : 'WR', value, projPts: pts, age: 25 });
const team = (rosterId: number, teamName: string, assets: FinisherAsset[]): FinisherTeam =>
  ({ rosterId, teamName, owner: `o${rosterId}`, ownerId: null, wins: 1, losses: 1, assets });

const A1 = asset('p:1', 'Alpha', 5000), A2 = asset('p:2', 'Bravo', 3000), A3 = asset('k:2027-1-1', '2027 1st', 4000, 0, 'pick');
const B1 = asset('p:9', 'Zulu', 6000), B2 = asset('p:8', 'Yankee', 2500);
const teams = [team(1, 'Me', [A1, A2, A3]), team(2, 'Them', [B1, B2]), team(3, 'Other', [asset('p:5', 'Echo', 1000)])];

const input: NewMeetInput = {
  league: { id: 'L1', name: 'Test League', format: 'superflex', tep: 1, rosterPositions: ['QB', 'RB', 'WR', 'FLEX', 'BN'], isDynasty: true },
  proposer: { rosterId: 1, teamName: 'Me', owner: 'me', goal: 'win-now' },
  partner: { rosterId: 2, teamName: 'Them', owner: 'them', goal: 'rebuild' },
  teams,
  options: [
    { give: [A1], get: [B1], rationale: 'Straight up: your WR1 for mine, you get younger.' },
    { give: [A2, A3], get: [B1], rationale: 'Pick sweetener version.' },
  ],
  note: 'Hey — a couple of ways to do this.',
};

// ── Create ────────────────────────────────────────────────────────────────
const T0 = '2026-09-12T18:00:00.000Z';
const m0 = createMeet(input, 'abcdefghjk', T0);
check('title defaults to the two teams', m0.title === 'Me ⇄ Them', m0.title);
check('two options, proposer pre-votes yes', m0.options.length === 2 && m0.options.every((o) => o.proposerVote === 'yes' && o.partnerVote === null && o.by === 'proposer'));
check('opening note logged as a general note', generalNotes(m0).length === 1 && generalNotes(m0)[0].text?.startsWith('Hey'));
check('created event first', m0.events[0].kind === 'created');
check('status open', m0.status === 'open' && m0.agreedOptionId === null);
check('league snapshot kept', m0.teams.length === 3 && m0.teams[0].assets.length === 3);
check('asset fields normalised', m0.options[0].give[0].value === 5000 && m0.options[0].give[0].name === 'Alpha');

throws('same team both sides', () => createMeet({ ...input, partner: { ...input.partner, rosterId: 1 } }, 'x'.repeat(10)));
throws('no options', () => createMeet({ ...input, options: [] }, 'x'.repeat(10)));
throws('one-sided option', () => createMeet({ ...input, options: [{ give: [A1], get: [], rationale: '' }] }, 'x'.repeat(10)));
throws('partner missing from snapshot', () => createMeet({ ...input, teams: [teams[0], teams[2]] }, 'x'.repeat(10)));
throws('malformed asset', () => createMeet({ ...input, options: [{ give: [{ id: 'x' } as unknown as FinisherAsset], get: [B1], rationale: '' }] }, 'x'.repeat(10)));
throws('too many assets per side', () => createMeet({ ...input, options: [{ give: Array.from({ length: LIMITS.sideAssets + 1 }, (_, i) => asset(`p:${100 + i}`, `X${i}`, 100)), get: [B1], rationale: '' }] }, 'x'.repeat(10)));

// ── Votes & agreement ─────────────────────────────────────────────────────
const o1 = m0.options[0].id, o2 = m0.options[1].id;
throws('viewer cannot act', () => applyAction(m0, { type: 'vote', optionId: o1, vote: 'yes' }, 'viewer'), 403);
const m1 = applyAction(m0, { type: 'vote', optionId: o1, vote: 'no', text: 'Not moving Zulu for one piece.' }, 'partner', '2026-09-12T18:05:00.000Z');
check('partner no recorded', m1.options[0].partnerVote === 'no' && m1.status === 'open');
check('vote note attaches to the option', optionNotes(m1, o1).some((e) => e.text?.includes('Zulu')));
check('input meet untouched', m0.options[0].partnerVote === null && m0.events.length === 2);

const m2 = applyAction(m1, { type: 'vote', optionId: o2, vote: 'yes' }, 'partner', '2026-09-12T18:06:00.000Z');
check('both yes → agreed on that option', m2.status === 'agreed' && m2.agreedOptionId === o2);
check('agreed event logged', m2.events[m2.events.length - 1].kind === 'agreed');
const m3 = applyAction(m2, { type: 'vote', optionId: o2, vote: null }, 'proposer', '2026-09-12T18:07:00.000Z');
check('pulling a yes reopens', m3.status === 'open' && m3.agreedOptionId === null && m3.events[m3.events.length - 1].kind === 'reopened');

// ── Counter offers ────────────────────────────────────────────────────────
const m4 = applyAction(m3, { type: 'option', give: [A1, A3], get: [B1], rationale: 'Add the 1st and we have a deal.' }, 'partner', '2026-09-12T18:10:00.000Z');
const counter = m4.options[2];
check('partner counter is in the proposer frame and pre-voted by the partner', counter.by === 'partner' && counter.partnerVote === 'yes' && counter.proposerVote === null && counter.give.length === 2);
throws('proposer cannot revise the partner\'s option', () => applyAction(m4, { type: 'revise', optionId: counter.id, rationale: 'x' }, 'proposer'), 403);
throws('proposer cannot withdraw the partner\'s option', () => applyAction(m4, { type: 'withdraw', optionId: counter.id }, 'proposer'), 403);

// ── Revisions ─────────────────────────────────────────────────────────────
const m5 = applyAction(m4, { type: 'vote', optionId: o1, vote: 'yes' }, 'partner', '2026-09-12T18:11:00.000Z');
check('setup: option 1 agreed', m5.status === 'agreed' && m5.agreedOptionId === o1);
const m6 = applyAction(m5, { type: 'revise', optionId: o1, give: [A1, A2] }, 'proposer', '2026-09-12T18:12:00.000Z');
check('reshaping an option bumps rev and clears the other vote', m6.options[0].rev === 2 && m6.options[0].partnerVote === null && m6.options[0].proposerVote === 'yes');
check('reshaping the agreed option keeps agreed status until a vote changes', m6.status === 'agreed');
const m6b = applyAction(m6, { type: 'vote', optionId: o1, vote: 'no' }, 'partner', '2026-09-12T18:12:30.000Z');
check('partner no on the agreed option reopens', m6b.status === 'open');
const m7 = applyAction(m6b, { type: 'revise', optionId: o1, rationale: 'Wording only.' }, 'proposer', '2026-09-12T18:13:00.000Z');
check('rationale-only revision keeps rev and votes', m7.options[0].rev === 2 && m7.options[0].partnerVote === 'no');

// ── Withdraw, notes, close ────────────────────────────────────────────────
const m8 = applyAction(m7, { type: 'withdraw', optionId: o2 }, 'proposer', '2026-09-12T18:14:00.000Z');
check('withdrawn flag set', m8.options[1].withdrawn);
throws('cannot vote on a withdrawn option', () => applyAction(m8, { type: 'vote', optionId: o2, vote: 'yes' }, 'partner'));
const m9 = applyAction(m8, { type: 'note', text: '  Thinking about it overnight.  ' }, 'partner', '2026-09-12T18:15:00.000Z');
check('general note trimmed', generalNotes(m9).length === 2 && generalNotes(m9)[1].text === 'Thinking about it overnight.');
throws('empty note rejected', () => applyAction(m9, { type: 'note', text: '   ' }, 'partner'));
throws('note on unknown option', () => applyAction(m9, { type: 'note', text: 'x', optionId: 'nope' }, 'partner'), 404);
const m10 = applyAction(m9, { type: 'status', status: 'closed' }, 'proposer', '2026-09-12T18:16:00.000Z');
check('closed', m10.status === 'closed');
throws('no votes once closed', () => applyAction(m10, { type: 'vote', optionId: o1, vote: 'yes' }, 'partner'));
throws('no new options once closed', () => applyAction(m10, { type: 'option', give: [A1], get: [B1], rationale: '' }, 'partner'));
const m11 = applyAction(m10, { type: 'status', status: 'open' }, 'proposer', '2026-09-12T18:17:00.000Z');
check('reopen restores open', m11.status === 'open');
check('updatedAt advances', m11.updatedAt === '2026-09-12T18:17:00.000Z');

// ── Ids, limits ───────────────────────────────────────────────────────────
check('random ids use the unambiguous alphabet', /^[a-hj-km-np-z2-9]{10}$/.test(randomId(10)));
let big: Meet = m11;
for (let i = 0; i < LIMITS.options; i++) {
  try { big = applyAction(big, { type: 'option', give: [A1], get: [B2], rationale: `v${i}` }, 'partner'); } catch { break; }
}
check('option cap enforced', big.options.length === LIMITS.options);
check('long rationale clipped', createMeet({ ...input, options: [{ give: [A1], get: [B1], rationale: 'x'.repeat(5000) }] }, 'y'.repeat(10)).options[0].rationale.length === LIMITS.rationaleChars);

console.log(`\nSwap meet: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL:', f);
process.exit(failures.length ? 1 : 0);
