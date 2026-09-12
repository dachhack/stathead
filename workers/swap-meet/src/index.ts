/**
 * Cloudflare Worker – Swap Meet by StatHead.
 *
 * A trade negotiation two fantasy managers share by link. The proposer opens
 * a meet from the Trade Finisher (a league snapshot + one or more trade
 * options + a pitch); the partner gets a link, votes on each option, counters
 * with their own versions, and both leave notes. No accounts: the proposer's
 * link and the partner's link each carry a capability key, and anyone with a
 * bare link can read.
 *
 * Endpoints (all JSON):
 *   POST /meets                    create. Body: NewMeetInput (see
 *                                  src/lib/swapMeetCore.ts). → { id, proposerKey,
 *                                  partnerKey, meet }
 *   GET  /meets/:id?k=KEY          read. → { meet, role, partnerKey? } — partnerKey
 *                                  is included only for the proposer, so they can
 *                                  re-copy the partner link.
 *   POST /meets/:id/actions?k=KEY  apply one MeetAction as the key's role. → { meet, role }
 *
 * Storage: KV namespace SWAP_MEET, one record per meet, refreshed 120-day TTL
 * on every write. KV is eventually consistent (~60 s across edges); every
 * write returns the updated record so the writer's page renders it at once.
 *
 * The state machine (create / option / revise / vote / withdraw / note /
 * status) is the repo's shared pure module, bundled into this worker, so the
 * browser and the server agree on every transition.
 *
 * Deploy:  npx wrangler deploy   (from workers/swap-meet/; needs the KV id
 *          in wrangler.toml — deploy-workers.yml fills it in).
 */

import { applyAction, createMeet, randomId, MeetError, type Meet, type MeetAction, type NewMeetInput, type Role } from '../../../src/lib/swapMeetCore';

interface KV {
  get(key: string, type: 'text'): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}
interface Env { SWAP_MEET: KV }

interface Stored { meet: Meet; keys: { proposer: string; partner: string } }

const TTL_SECONDS = 120 * 24 * 3600;
const MAX_BODY = 1_500_000; // the league snapshot is the bulk: 32 teams × 80 assets ≈ 400 KB

function isStatHeadHost(h: string): boolean {
  return h === 'dachhack.github.io' || h === 'stathead.app' || h === 'www.stathead.app'
    || h === 'localhost' || h === '127.0.0.1' || h.endsWith('.pages.dev');
}
function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try { return isStatHeadHost(new URL(origin).hostname); } catch { return false; }
}
function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? (origin as string) : 'https://stathead.app',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
  });
}

// Keys are compared in constant time; they are the only authorisation there is.
function sameKey(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function roleFor(stored: Stored, key: string | null): Role {
  if (!key) return 'viewer';
  if (sameKey(key, stored.keys.proposer)) return 'proposer';
  if (sameKey(key, stored.keys.partner)) return 'partner';
  return 'viewer';
}

const secureRandom = () => {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return b[0] / 0x100000000;
};

async function readJson(req: Request): Promise<unknown> {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_BODY) throw new MeetError('request too large', 413);
  const text = await req.text();
  if (text.length > MAX_BODY) throw new MeetError('request too large', 413);
  try { return JSON.parse(text); } catch { throw new MeetError('body must be JSON'); }
}

async function load(env: Env, id: string): Promise<Stored | null> {
  const raw = await env.SWAP_MEET.get(`meet:${id}`, 'text');
  return raw ? (JSON.parse(raw) as Stored) : null;
}
async function save(env: Env, stored: Stored): Promise<void> {
  await env.SWAP_MEET.put(`meet:${stored.meet.id}`, JSON.stringify(stored), { expirationTtl: TTL_SECONDS });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    try {
      if (parts[0] !== 'meets') {
        if (parts.length === 0) return json({ ok: true, service: 'swap-meet', docs: 'https://github.com/dachhack/stathead/tree/main/workers/swap-meet' }, 200, origin);
        return json({ error: 'not found' }, 404, origin);
      }

      // POST /meets
      if (parts.length === 1 && request.method === 'POST') {
        const input = (await readJson(request)) as NewMeetInput;
        let id = randomId(10, secureRandom);
        // Ids are 10 chars over a 31-symbol alphabet; a collision is a curiosity, not a risk, but check anyway.
        while (await load(env, id)) id = randomId(10, secureRandom);
        const meet = createMeet(input, id);
        const stored: Stored = { meet, keys: { proposer: randomId(22, secureRandom), partner: randomId(22, secureRandom) } };
        await save(env, stored);
        return json({ id, proposerKey: stored.keys.proposer, partnerKey: stored.keys.partner, meet }, 201, origin);
      }

      const id = parts[1];
      if (!id || !/^[a-z0-9]{6,24}$/.test(id)) return json({ error: 'bad meet id' }, 400, origin);
      const stored = await load(env, id);
      if (!stored) return json({ error: 'no such meet (it may have expired)' }, 404, origin);
      const role = roleFor(stored, url.searchParams.get('k'));

      // GET /meets/:id
      if (parts.length === 2 && request.method === 'GET') {
        return json({ meet: stored.meet, role, ...(role === 'proposer' ? { partnerKey: stored.keys.partner } : {}) }, 200, origin);
      }

      // POST /meets/:id/actions
      if (parts.length === 3 && parts[2] === 'actions' && request.method === 'POST') {
        if (role === 'viewer') return json({ error: 'this link is view-only' }, 403, origin);
        const action = (await readJson(request)) as MeetAction;
        const meet = applyAction(stored.meet, action, role);
        stored.meet = meet;
        await save(env, stored);
        return json({ meet, role }, 200, origin);
      }

      return json({ error: 'not found' }, 404, origin);
    } catch (e) {
      if (e instanceof MeetError) return json({ error: e.message }, e.status, origin);
      return json({ error: e instanceof Error ? e.message : 'server error' }, 500, origin);
    }
  },
};
