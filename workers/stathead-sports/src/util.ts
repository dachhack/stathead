// Fetch, name-matching and date helpers shared by the adapters. Runs in the
// Cloudflare Worker and under Node (the daily job), so only web-standard APIs.

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export class HttpError extends Error {
  constructor(public status: number, public url: string, body: string) {
    super(`HTTP ${status} ${url}: ${body.slice(0, 200)}`);
  }
}

export interface FetchOpts {
  headers?: Record<string, string>;
  retries?: number;
  timeoutMs?: number;
}

async function fetchWithRetry(url: string, opts: FetchOpts = {}): Promise<Response> {
  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 30_000);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json, text/html;q=0.9, */*;q=0.8', ...opts.headers },
        signal: ctl.signal,
        redirect: 'follow',
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new HttpError(res.status, url, await res.text());
      } else {
        return res;
      }
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(500 * 2 ** attempt);
  }
  throw lastErr;
}

export async function fetchJson<T = any>(url: string, opts: FetchOpts = {}): Promise<T> {
  const res = await fetchWithRetry(url, opts);
  if (!res.ok) throw new HttpError(res.status, url, await res.text());
  return (await res.json()) as T;
}

/** Like fetchJson but a 404 resolves to null. */
export async function fetchJsonOrNull<T = any>(url: string, opts: FetchOpts = {}): Promise<T | null> {
  const res = await fetchWithRetry(url, opts);
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(res.status, url, await res.text());
  return (await res.json()) as T;
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const res = await fetchWithRetry(url, opts);
  if (!res.ok) throw new HttpError(res.status, url, await res.text());
  return res.text();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Map with bounded concurrency, preserving order. */
export async function pMap<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export const nowIso = () => new Date().toISOString();

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

/** Lower-case, no diacritics, no punctuation, no generational suffix: the key two feeds agree on. */
export function normName(name: string | null | undefined): string {
  if (!name) return '';
  const parts = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’`"-]/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (parts.length > 2 && SUFFIXES.has(parts[parts.length - 1])) parts.pop();
  return parts.join(' ');
}

/** A looser key when full names disagree (A.J. vs AJ, Nic vs Nick): first initial + last name. */
export function looseName(name: string): string {
  const parts = normName(name).split(' ');
  if (parts.length < 2) return parts[0] ?? '';
  return `${parts[0][0]} ${parts[parts.length - 1]}`;
}

/** Index of players by normalised name; `resolve` picks the one match or breaks ties by team. */
export class NameIndex<T extends { team?: string | null }> {
  private exact = new Map<string, T[]>();
  private loose = new Map<string, T[]>();
  constructor(items: readonly T[], nameOf: (t: T) => string) {
    for (const it of items) {
      const n = normName(nameOf(it));
      if (!n) continue;
      push(this.exact, n, it);
      push(this.loose, looseName(nameOf(it)), it);
    }
  }
  resolve(name: string, team?: string | null, teamEq?: (a: string, b: string) => boolean): T | null {
    const eq = teamEq ?? ((a, b) => a === b);
    const pick = (cands: T[] | undefined): T | null => {
      if (!cands || cands.length === 0) return null;
      if (cands.length === 1) return cands[0];
      if (team) {
        const same = cands.filter((c) => c.team && eq(c.team, team));
        if (same.length === 1) return same[0];
      }
      return null;
    };
    return pick(this.exact.get(normName(name))) ?? pick(this.loose.get(looseName(name)));
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

const EASTERN = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/** YYYY-MM-DD in US Eastern for an instant. */
export function easternDate(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  // en-CA formats as YYYY-MM-DD.
  return EASTERN.format(d);
}

/** "mm:ss" → decimal minutes. */
export function mmssToMinutes(s: string | null | undefined): number {
  if (!s) return 0;
  const m = /^(\d+):(\d{1,2})$/.exec(s.trim());
  if (!m) return Number(s) || 0;
  return Math.round((Number(m[1]) + Number(m[2]) / 60) * 100) / 100;
}

export function num(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function yearOf(date: string | null | undefined): number | null {
  if (!date) return null;
  const y = Number(String(date).slice(0, 4));
  return Number.isFinite(y) && y > 1800 ? y : null;
}

/** Days from `from` to `to` inclusive, YYYY-MM-DD. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Strip tags and collapse whitespace. */
export function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
