/**
 * Swap Meet by StatHead — the negotiation record two managers share.
 *
 * A "meet" is one proposer, one partner, a snapshot of the league (every
 * roster's priced assets, so both pages can re-run the finisher's needs and
 * fairness math without touching Sleeper again), the trade options on the
 * table, each side's vote on each option, and a log of notes and decisions.
 *
 * This module is pure and shared by the browser (src/lib/swapMeet.ts) and the
 * Worker (workers/swap-meet): every state change goes through `applyAction`,
 * so the two never disagree about what a vote, a counter or a revision does.
 * No fetching, no React, no Cloudflare types.
 */

import type { FinisherAsset, FinisherTeam, TradeGoal } from './tradeFinisher';

export const MEET_VERSION = 1;

export type Role = 'proposer' | 'partner' | 'viewer';
export type Vote = 'yes' | 'no';
export type MeetStatus = 'open' | 'agreed' | 'closed';

export interface MeetSide {
  rosterId: number;
  teamName: string;
  owner: string;
  goal: TradeGoal;
}

export interface MeetLeague {
  id: string;
  name: string;
  format: '1qb' | 'superflex';
  tep: number;
  rosterPositions: string[];
  isDynasty: boolean;
}

/** One version of the trade. Sides are always in the PROPOSER's frame:
 *  `give` is what the proposer sends, `get` what the proposer receives. */
export interface MeetOption {
  id: string;
  by: Exclude<Role, 'viewer'>;
  at: string;
  give: FinisherAsset[];
  get: FinisherAsset[];
  /** The author's pitch: why this version works for both sides. */
  rationale: string;
  proposerVote: Vote | null;
  partnerVote: Vote | null;
  withdrawn: boolean;
  /** Bumped on every revision so a vote on an older shape is not mistaken for a vote on the new one. */
  rev: number;
}

export type EventKind = 'created' | 'option' | 'revise' | 'vote' | 'withdraw' | 'note' | 'agreed' | 'closed' | 'reopened';

export interface MeetEvent {
  id: string;
  at: string;
  by: Exclude<Role, 'viewer'>;
  kind: EventKind;
  optionId?: string;
  text?: string;
  vote?: Vote | null;
}

export interface Meet {
  v: number;
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  league: MeetLeague;
  proposer: MeetSide;
  partner: MeetSide;
  /** Every roster in the league, priced — needs and fairness are recomputed from this. */
  teams: FinisherTeam[];
  options: MeetOption[];
  events: MeetEvent[];
  status: MeetStatus;
  agreedOptionId: string | null;
}

/** What the proposer supplies to open a meet. */
export interface NewMeetInput {
  title?: string;
  league: MeetLeague;
  proposer: MeetSide;
  partner: MeetSide;
  teams: FinisherTeam[];
  options: { give: FinisherAsset[]; get: FinisherAsset[]; rationale: string }[];
  /** Opening message to the partner. */
  note?: string;
}

// ── Actions ───────────────────────────────────────────────────────────────

export type MeetAction =
  | { type: 'option'; give: FinisherAsset[]; get: FinisherAsset[]; rationale: string }
  | { type: 'revise'; optionId: string; give?: FinisherAsset[]; get?: FinisherAsset[]; rationale?: string }
  | { type: 'vote'; optionId: string; vote: Vote | null; text?: string }
  | { type: 'withdraw'; optionId: string }
  | { type: 'note'; text: string; optionId?: string }
  | { type: 'status'; status: 'open' | 'closed' };

export class MeetError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

// ── Limits (also enforced by the Worker before parsing) ───────────────────

export const LIMITS = {
  options: 24,
  events: 400,
  noteChars: 2000,
  rationaleChars: 1500,
  titleChars: 120,
  sideAssets: 8,
  teams: 32,
  assetsPerTeam: 80,
};

const isAsset = (a: unknown): a is FinisherAsset => {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  return typeof x.id === 'string' && (x.type === 'player' || x.type === 'pick') && typeof x.name === 'string'
    && typeof x.value === 'number' && typeof x.projPts === 'number' && typeof x.position === 'string';
};

function cleanAssets(xs: unknown, what: string): FinisherAsset[] {
  if (!Array.isArray(xs)) throw new MeetError(`${what} must be a list of assets`);
  if (xs.length > LIMITS.sideAssets) throw new MeetError(`${what}: at most ${LIMITS.sideAssets} assets per side`);
  if (!xs.every(isAsset)) throw new MeetError(`${what}: malformed asset`);
  // Keep only the fields the pages read; strip anything a client tacked on.
  return xs.map((a) => ({
    id: a.id, type: a.type, name: String(a.name).slice(0, 80), position: a.position, team: a.team ? String(a.team).slice(0, 8) : undefined,
    age: typeof a.age === 'number' ? a.age : undefined, value: Math.max(0, Math.round(a.value)), projPts: Math.max(0, Math.round(a.projPts)),
    sleeperId: a.sleeperId ? String(a.sleeperId).slice(0, 24) : undefined, pick: a.pick, ktcId: typeof a.ktcId === 'number' ? a.ktcId : undefined,
  }));
}

const cleanText = (s: unknown, max: number): string => (typeof s === 'string' ? s.trim().slice(0, max) : '');

function cleanSide(s: unknown, what: string): MeetSide {
  const x = (s ?? {}) as Record<string, unknown>;
  if (typeof x.rosterId !== 'number' || typeof x.teamName !== 'string') throw new MeetError(`${what}: rosterId and teamName required`);
  const goal = x.goal === 'win-now' || x.goal === 'rebuild' ? x.goal : 'balanced';
  return { rosterId: x.rosterId, teamName: x.teamName.slice(0, 60), owner: cleanText(x.owner, 60), goal };
}

function cleanTeams(ts: unknown): FinisherTeam[] {
  if (!Array.isArray(ts) || !ts.length) throw new MeetError('teams: the league snapshot is required');
  if (ts.length > LIMITS.teams) throw new MeetError(`teams: at most ${LIMITS.teams}`);
  return ts.map((t) => {
    const x = (t ?? {}) as Record<string, unknown>;
    if (typeof x.rosterId !== 'number' || typeof x.teamName !== 'string' || !Array.isArray(x.assets)) throw new MeetError('teams: malformed team');
    if (x.assets.length > LIMITS.assetsPerTeam) throw new MeetError(`teams: at most ${LIMITS.assetsPerTeam} assets per team`);
    if (!x.assets.every(isAsset)) throw new MeetError('teams: malformed asset');
    return {
      rosterId: x.rosterId, teamName: x.teamName.slice(0, 60), owner: cleanText(x.owner, 60), ownerId: null,
      wins: typeof x.wins === 'number' ? x.wins : 0, losses: typeof x.losses === 'number' ? x.losses : 0,
      assets: (x.assets as FinisherAsset[]).map((a) => cleanAssets([a], 'teams')[0]),
    };
  });
}

// ── Ids ───────────────────────────────────────────────────────────────────

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/O/1/l/i
export function randomId(len: number, rng: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  return s;
}

// ── Build & reduce ────────────────────────────────────────────────────────

export function createMeet(input: NewMeetInput, id: string, now = new Date().toISOString()): Meet {
  const league = (input.league ?? {}) as Partial<MeetLeague>;
  if (!league || typeof league.name !== 'string' || !Array.isArray(league.rosterPositions)) throw new MeetError('league: name and rosterPositions required');
  const proposer = cleanSide(input.proposer, 'proposer');
  const partner = cleanSide(input.partner, 'partner');
  if (proposer.rosterId === partner.rosterId) throw new MeetError('proposer and partner must differ');
  const teams = cleanTeams(input.teams);
  if (!teams.some((t) => t.rosterId === proposer.rosterId) || !teams.some((t) => t.rosterId === partner.rosterId)) throw new MeetError('both sides must be in the league snapshot');
  if (!Array.isArray(input.options) || !input.options.length) throw new MeetError('at least one option is required');
  if (input.options.length > LIMITS.options) throw new MeetError(`at most ${LIMITS.options} options`);

  const meet: Meet = {
    v: MEET_VERSION, id, createdAt: now, updatedAt: now,
    title: cleanText(input.title, LIMITS.titleChars) || `${proposer.teamName} ⇄ ${partner.teamName}`,
    league: {
      id: cleanText(league.id, 40), name: league.name.slice(0, 80), format: league.format === 'superflex' ? 'superflex' : '1qb',
      tep: typeof league.tep === 'number' ? league.tep : 0, rosterPositions: league.rosterPositions.map(String).slice(0, 60), isDynasty: league.isDynasty !== false,
    },
    proposer, partner, teams, options: [], events: [], status: 'open', agreedOptionId: null,
  };
  meet.events.push({ id: randomId(8), at: now, by: 'proposer', kind: 'created' });
  for (const o of input.options) {
    const give = cleanAssets(o.give, 'give'), get = cleanAssets(o.get, 'get');
    if (!give.length || !get.length) throw new MeetError('each option needs assets on both sides');
    meet.options.push({
      id: randomId(6), by: 'proposer', at: now, give, get, rationale: cleanText(o.rationale, LIMITS.rationaleChars),
      proposerVote: 'yes', partnerVote: null, withdrawn: false, rev: 1,
    });
  }
  const note = cleanText(input.note, LIMITS.noteChars);
  if (note) meet.events.push({ id: randomId(8), at: now, by: 'proposer', kind: 'note', text: note });
  return meet;
}

function findOption(meet: Meet, id: string): MeetOption {
  const o = meet.options.find((x) => x.id === id);
  if (!o) throw new MeetError('no such option', 404);
  return o;
}

/** Apply one action for one role. Returns a new meet; never mutates the input. */
export function applyAction(meet: Meet, action: MeetAction, role: Role, now = new Date().toISOString()): Meet {
  if (role === 'viewer') throw new MeetError('this link is view-only', 403);
  const next: Meet = { ...meet, options: meet.options.map((o) => ({ ...o })), events: [...meet.events] };
  const log = (e: Omit<MeetEvent, 'id' | 'at' | 'by'>) => next.events.push({ id: randomId(8), at: now, by: role, ...e });
  const settle = (o: MeetOption) => {
    if (o.proposerVote === 'yes' && o.partnerVote === 'yes' && !o.withdrawn && next.status !== 'agreed') {
      next.status = 'agreed';
      next.agreedOptionId = o.id;
      log({ kind: 'agreed', optionId: o.id });
    }
  };

  switch (action.type) {
    case 'option': {
      if (next.status === 'closed') throw new MeetError('this meet is closed');
      if (next.options.length >= LIMITS.options) throw new MeetError(`at most ${LIMITS.options} options`);
      const give = cleanAssets(action.give, 'give'), get = cleanAssets(action.get, 'get');
      if (!give.length || !get.length) throw new MeetError('an option needs assets on both sides');
      const o: MeetOption = {
        id: randomId(6), by: role, at: now, give, get, rationale: cleanText(action.rationale, LIMITS.rationaleChars),
        proposerVote: role === 'proposer' ? 'yes' : null, partnerVote: role === 'partner' ? 'yes' : null, withdrawn: false, rev: 1,
      };
      next.options.push(o);
      log({ kind: 'option', optionId: o.id, text: o.rationale || undefined });
      break;
    }
    case 'revise': {
      const idx = next.options.findIndex((x) => x.id === action.optionId);
      if (idx < 0) throw new MeetError('no such option', 404);
      const o = next.options[idx];
      if (o.by !== role) throw new MeetError('only the author can revise an option', 403);
      if (o.withdrawn) throw new MeetError('that option was withdrawn');
      const give = action.give ? cleanAssets(action.give, 'give') : o.give;
      const get = action.get ? cleanAssets(action.get, 'get') : o.get;
      if (!give.length || !get.length) throw new MeetError('an option needs assets on both sides');
      const shapeChanged = action.give != null || action.get != null;
      next.options[idx] = {
        ...o, give, get, rationale: action.rationale != null ? cleanText(action.rationale, LIMITS.rationaleChars) : o.rationale,
        rev: shapeChanged ? o.rev + 1 : o.rev,
        // A changed package voids the other side's vote; the author re-affirms.
        proposerVote: role === 'proposer' ? 'yes' : (shapeChanged ? null : o.proposerVote),
        partnerVote: role === 'partner' ? 'yes' : (shapeChanged ? null : o.partnerVote),
      };
      log({ kind: 'revise', optionId: o.id, text: action.rationale != null ? cleanText(action.rationale, LIMITS.rationaleChars) : undefined });
      break;
    }
    case 'vote': {
      if (next.status === 'closed') throw new MeetError('this meet is closed');
      const o = findOption(next, action.optionId);
      if (o.withdrawn) throw new MeetError('that option was withdrawn');
      const vote = action.vote === 'yes' || action.vote === 'no' ? action.vote : null;
      if (role === 'proposer') o.proposerVote = vote; else o.partnerVote = vote;
      log({ kind: 'vote', optionId: o.id, vote, text: cleanText(action.text, LIMITS.noteChars) || undefined });
      settle(o);
      // Pulling a "yes" off the agreed option reopens the meet.
      if (next.status === 'agreed' && next.agreedOptionId === o.id && vote !== 'yes') {
        next.status = 'open'; next.agreedOptionId = null; log({ kind: 'reopened', optionId: o.id });
      }
      break;
    }
    case 'withdraw': {
      const o = findOption(next, action.optionId);
      if (o.by !== role) throw new MeetError('only the author can withdraw an option', 403);
      o.withdrawn = true;
      log({ kind: 'withdraw', optionId: o.id });
      if (next.agreedOptionId === o.id) { next.status = 'open'; next.agreedOptionId = null; log({ kind: 'reopened', optionId: o.id }); }
      break;
    }
    case 'note': {
      const text = cleanText(action.text, LIMITS.noteChars);
      if (!text) throw new MeetError('empty note');
      if (action.optionId) findOption(next, action.optionId);
      log({ kind: 'note', optionId: action.optionId, text });
      break;
    }
    case 'status': {
      if (action.status === 'closed') { next.status = 'closed'; log({ kind: 'closed' }); }
      else { next.status = next.agreedOptionId ? 'agreed' : 'open'; log({ kind: 'reopened' }); }
      break;
    }
    default:
      throw new MeetError('unknown action');
  }
  if (next.events.length > LIMITS.events) next.events = next.events.slice(next.events.length - LIMITS.events);
  next.updatedAt = now;
  return next;
}

// ── Read helpers shared by both pages ─────────────────────────────────────

export function sideFor(meet: Meet, role: Role): MeetSide | null {
  return role === 'proposer' ? meet.proposer : role === 'partner' ? meet.partner : null;
}

export function teamOf(meet: Meet, rosterId: number): FinisherTeam | undefined {
  return meet.teams.find((t) => t.rosterId === rosterId);
}

/** Notes attached to one option, oldest first. */
export function optionNotes(meet: Meet, optionId: string): MeetEvent[] {
  return meet.events.filter((e) => e.optionId === optionId && (e.kind === 'note' || (e.kind === 'vote' && e.text) || (e.kind === 'option' && e.text) || (e.kind === 'revise' && e.text)));
}

/** Conversation not tied to an option. */
export function generalNotes(meet: Meet): MeetEvent[] {
  return meet.events.filter((e) => e.kind === 'note' && !e.optionId);
}
