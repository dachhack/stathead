/**
 * Cloudflare Worker – reliable timer for workflows GitHub's schedule drops.
 *
 * GitHub Actions' `schedule:` trigger is best-effort and drops runs when the
 * platform is busy: refresh-injuries.yml (cron every 20 min) ran once in its
 * first 11 hours, refresh-data.yml (cron hourly) ran 4 times in a day, and
 * sleeper-trade-crawl.yml (cron every 6 h) fired once in its first 12 hours,
 * 4 hours late (2026-10-17), and daily-report.yml ran 3-6 hours late. This worker's cron triggers (wrangler.toml) fire
 * on time and start each workflow through the GitHub API (workflow_dispatch).
 *
 * Which workflow starts when is SCHEDULES below, as cron strings. Cloudflare's
 * free plan allows 5 cron triggers per account (the 2026-10-22 deploy failed
 * at 6), so the worker has ONE trigger (TRIGGER, also in wrangler.toml) that
 * fires at every minute any schedule uses, and each firing starts the
 * schedules whose cron matches that minute. Every workflow keeps its own
 * `schedule:` as a fallback: their concurrency groups (and the crawls' saved
 * state, and the dedupe jobs) make a double start harmless.
 *
 * Routes: GET /  → JSON status: schedules, whether GH_TOKEN is set, and the
 *                  most recent dispatch per workflow this isolate made
 *                  (best-effort; isolates recycle, so check Cloudflare's cron
 *                  logs or the workflow's run list for history).
 *
 * Deploy:  npx wrangler deploy   (from workers/refresh-scheduler/), then
 *          npx wrangler secret put GH_TOKEN
 *          (deploy-workers.yml does both on a push to workers/**)
 */

interface Env {
  GH_TOKEN?: string;
  REPO: string;
  REF: string;
}
interface Ctx { waitUntil(p: Promise<unknown>): void }
interface ScheduledEvent { cron: string; scheduledTime: number }

// cron (exactly as in wrangler.toml) → workflows it starts, and why.
export const SCHEDULES: Record<string, { workflows: string[]; note: string; inputs?: Record<string, string> }> = {
  '7,27,47 11-23,0-4 * * *': {
    workflows: ['refresh-injuries.yml'],
    note: 'every 20 min, 7am-11pm ET (UTC, no DST, like GitHub)',
  },
  '23 1,7,13,19 * * *': {
    workflows: ['sleeper-trade-crawl.yml'],
    note: 'Sleeper trade crawl, every 6 h (each run ~5.5 h; a start while one runs queues)',
  },
  '41 13 * * *': {
    workflows: ['yahoo-trade-crawl.yml'],
    note: 'Yahoo trade crawl, daily',
  },
  '17 10 * * *': {
    workflows: ['trade-db-analysis.yml'],
    note: 'trade values, daily after the Sleeper crawl\'s daily refresh (new trades); full rebuild when the last is 28+ days old; scheduled=true lets the workflow skip a second timed start',
    inputs: { scheduled: 'true' },
  },
  '0 13 * * *': {
    workflows: ['daily-report.yml'],
    note: 'daily report email (GitHub ran it 3-6 h late); scheduled=true lets the workflow skip a second timed start',
    inputs: { scheduled: 'true' },
  },
};

/** The worker's one Cloudflare cron trigger (wrangler.toml): every minute
 *  that some schedule above uses. scripts/test-refresh-scheduler.ts checks
 *  it covers them all. */
export const TRIGGER = '0,7,17,23,27,41,47 * * * *';

/** Does a field of a 5-field cron ("*", "7", "1,7,13", "11-23,0-4") match v? */
function fieldMatches(field: string, v: number): boolean {
  if (field === '*') return true;
  return field.split(',').some((part) => {
    const [a, b] = part.split('-').map(Number);
    return b === undefined ? v === a : v >= a && v <= b;
  });
}

/** Does a cron (minute hour day-of-month month day-of-week, UTC) match t? */
export function cronMatches(cron: string, t: Date): boolean {
  const [mi, h, dom, mon, dow] = cron.trim().split(/\s+/);
  return fieldMatches(mi, t.getUTCMinutes()) && fieldMatches(h, t.getUTCHours()) &&
    fieldMatches(dom, t.getUTCDate()) && fieldMatches(mon, t.getUTCMonth() + 1) && fieldMatches(dow, t.getUTCDay());
}

/** The schedules due at t. */
export function dueAt(t: Date): string[] {
  return Object.keys(SCHEDULES).filter((cron) => cronMatches(cron, t));
}

type Result = { at: string; cron: string; status: number | null; detail: string };
const last: Record<string, Result> = {};

async function dispatch(env: Env, cron: string, workflow: string, inputs?: Record<string, string>): Promise<boolean> {
  const at = new Date().toISOString();
  if (!env.GH_TOKEN) {
    last[workflow] = { at, cron, status: null, detail: 'GH_TOKEN secret is not set' };
    console.error('refresh-scheduler: GH_TOKEN secret is not set; nothing dispatched');
    return false;
  }
  const url = `https://api.github.com/repos/${env.REPO}/actions/workflows/${workflow}/dispatches`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'stathead-refresh-scheduler',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(inputs ? { ref: env.REF, inputs } : { ref: env.REF }),
  });
  // 204 No Content on success.
  const detail = resp.status === 204 ? 'dispatched' : (await resp.text()).slice(0, 300);
  last[workflow] = { at, cron, status: resp.status, detail };
  if (resp.status !== 204) {
    console.error(`refresh-scheduler: ${workflow} dispatch failed ${resp.status}: ${detail}`);
    return false;
  }
  console.log(`refresh-scheduler: dispatched ${workflow} on ${env.REF} (${cron})`);
  return true;
}

/** Start every schedule due at the trigger's time (its scheduled minute,
 *  not the moment the isolate runs). */
export async function runDue(env: Env, t: Date): Promise<void> {
  const due = dueAt(t);
  const ok = await Promise.all(due.flatMap((cron) =>
    SCHEDULES[cron].workflows.map((w) => dispatch(env, cron, w, SCHEDULES[cron].inputs))));
  // Throwing marks the cron invocation as failed in Cloudflare's logs.
  if (ok.includes(false)) throw new Error(`dispatch failed at ${t.toISOString()} (${due.join('; ')})`);
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: Ctx): Promise<void> {
    ctx.waitUntil(runDue(env, new Date(event.scheduledTime)));
  },

  async fetch(_req: Request, env: Env): Promise<Response> {
    const body = {
      worker: 'refresh-scheduler',
      repo: env.REPO,
      ref: env.REF,
      trigger: `${TRIGGER} (UTC)`,
      schedules: Object.entries(SCHEDULES).map(([cron, s]) => ({ cron: `${cron} (UTC)`, ...s })),
      tokenConfigured: !!env.GH_TOKEN,
      lastDispatchThisIsolate: last,
    };
    return new Response(JSON.stringify(body, null, 2), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  },
};
