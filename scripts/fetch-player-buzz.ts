/**
 * Player buzz fetcher — aggregates recent news + community chatter per player
 * into a single leaderboard snapshot for the Buzz Tracker tab.
 *
 * Sources:
 *   - ESPN athlete overview (news[] + Rotowire beat-writer blurb), per player
 *   - Reddit: r/fantasyfootball, r/dynastyff, r/32beatwriters (mention volume)
 *
 * Sentiment is scored with the shared lexicon (src/lib/buzzSentiment.ts); the
 * output tags each score with method:'lexicon' so a later LLM pass can refine
 * scores in place without changing the schema.
 *
 * Run:    npx tsx scripts/fetch-player-buzz.ts [--window=14] [--limit=0]
 * Output: public/data/player-buzz.json
 *
 * Network-failure tolerant by design (mirrors fetch-reddit-sentiment.ts): any
 * source that fails is skipped, and the script never fails the build.
 */
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { scoreSentiment, sentimentLabel } from '../src/lib/buzzSentiment';

const OUTPUT_PATH = 'public/data/player-buzz.json';
const ESPN_RATE_MS = 120;       // ESPN tolerates faster than Reddit
const REDDIT_RATE_MS = 1200;    // Reddit asks ~1 req/sec unauthenticated
const REDDIT_SUBS = ['fantasyfootball', 'dynastyff', '32beatwriters'];
const SKILL_POS = new Set(['QB', 'RB', 'WR', 'TE']);
const MAX_ITEMS_PER_PLAYER = 10;

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'] as [string, string];
  }),
);
const WINDOW_DAYS = Number(args.get('window') ?? 14);
const PLAYER_LIMIT = Number(args.get('limit') ?? 0); // 0 = all skill players
const windowStart = Date.now() - WINDOW_DAYS * 86400_000;
const windowMid = Date.now() - (WINDOW_DAYS / 2) * 86400_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Player {
  name: string;
  position: string;
  team: string;
  espn_id?: string;
  player_key: string | null;
  patterns: string[]; // lowercased name patterns for Reddit matching
}

interface RawItem {
  source: string;
  headline: string;
  summary: string;
  published: string; // ISO
  link: string;
  ts: number;        // epoch ms
}

// ── Player universe ─────────────────────────────────────────────────────

function normName(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[.'`]/g, '').replace(/-/g, ' ')
    .replace(/\s+(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
}

function loadPlayers(): Player[] {
  const espnIdx = JSON.parse(readFileSync('public/data/espn-nfl-ids.json', 'utf-8')) as {
    players: { name: string; position: string; team: string; espn_id: string }[];
  };
  // Map normalized name|pos -> player_key from the crosswalk.
  const keyByNamePos = new Map<string, string>();
  try {
    const cw = JSON.parse(readFileSync('public/data/player-crosswalk.json', 'utf-8')) as {
      players: { player_key: string; display_name: string; position: string; all_names?: string[] }[];
    };
    for (const r of cw.players) {
      const add = (nm: string, pos: string) => {
        const k = `${normName(nm)}|${pos}`;
        if (!keyByNamePos.has(k)) keyByNamePos.set(k, r.player_key);
      };
      add(r.display_name, r.position);
      for (const a of r.all_names ?? []) add(a, r.position);
    }
  } catch { /* crosswalk optional */ }

  const seen = new Set<string>();
  const players: Player[] = [];
  for (const p of espnIdx.players) {
    if (!SKILL_POS.has(p.position)) continue;
    const dedupe = `${normName(p.name)}|${p.position}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const parts = p.name.split(' ');
    const patterns = [p.name.toLowerCase()];
    if (parts.length >= 2) patterns.push(`${parts[0]} ${parts[parts.length - 1]}`.toLowerCase());
    players.push({
      name: p.name, position: p.position, team: p.team, espn_id: p.espn_id,
      player_key: keyByNamePos.get(dedupe) ?? null,
      patterns,
    });
  }
  return PLAYER_LIMIT > 0 ? players.slice(0, PLAYER_LIMIT) : players;
}

// ── ESPN news + Rotowire ────────────────────────────────────────────────

const ESPN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Referer: 'https://www.espn.com/',
};

function toIso(v: unknown): { iso: string; ts: number } | null {
  if (!v) return null;
  const ts = Date.parse(String(v));
  if (Number.isNaN(ts)) return null;
  return { iso: new Date(ts).toISOString(), ts };
}

async function fetchEspnItems(p: Player): Promise<RawItem[]> {
  if (!p.espn_id) return [];
  const url = `https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${p.espn_id}/overview?region=us&lang=en`;
  let data: Record<string, unknown> | null = null;
  try {
    const resp = await fetch(url, { headers: ESPN_HEADERS });
    if (!resp.ok) return [];
    data = (await resp.json()) as Record<string, unknown>;
  } catch {
    return [];
  }
  const items: RawItem[] = [];
  // news[]
  const news = Array.isArray(data.news) ? (data.news as Record<string, unknown>[]) : [];
  for (const a of news) {
    const when = toIso(a.published ?? a.lastModified ?? a.date);
    if (!when || when.ts < windowStart) continue;
    const links = a.links as { web?: { href?: string } } | undefined;
    const headline = String(a.headline ?? a.title ?? a.shortHeadline ?? '');
    if (!headline) continue;
    items.push({
      source: 'espn',
      headline,
      summary: String(a.description ?? a.story ?? ''),
      published: when.iso,
      link: String(links?.web?.href ?? a.link ?? ''),
      ts: when.ts,
    });
  }
  // rotowire blurb (single, most recent)
  const ro = data.rotowire as Record<string, unknown> | undefined;
  if (ro) {
    const when = toIso(ro.published);
    const headline = String(ro.headline ?? '');
    if (headline && (!when || when.ts >= windowStart)) {
      items.push({
        source: 'rotowire',
        headline,
        summary: String(ro.story ?? ro.description ?? ''),
        published: when?.iso ?? new Date().toISOString(),
        link: '',
        ts: when?.ts ?? Date.now(),
      });
    }
  }
  return items;
}

// ── Reddit mention volume ───────────────────────────────────────────────

async function fetchRedditPosts(sub: string): Promise<{ text: string; ts: number; score: number; permalink: string }[]> {
  // `new` listing within the window — OTA chatter is recency-driven, so we take
  // the freshest posts rather than search-ranked ones.
  const url = `https://www.reddit.com/r/${sub}/new.json?limit=100`;
  await sleep(REDDIT_RATE_MS);
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'stathead-buzz/1.0' } });
    if (!resp.ok) return [];
    const data = (await resp.json()) as { data?: { children?: { data?: Record<string, unknown> }[] } };
    const out: { text: string; ts: number; score: number; permalink: string }[] = [];
    for (const c of data.data?.children ?? []) {
      const d = c.data ?? {};
      const ts = Number(d.created_utc ?? 0) * 1000;
      if (ts < windowStart) continue;
      out.push({
        text: `${String(d.title ?? '')} ${String(d.selftext ?? '')}`,
        ts,
        score: Number(d.score ?? 0),
        permalink: `https://www.reddit.com${String(d.permalink ?? '')}`,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ── Aggregation ─────────────────────────────────────────────────────────

async function main() {
  const players = loadPlayers();
  console.log(`Buzz fetch: ${players.length} skill players, ${WINDOW_DAYS}-day window`);

  // playerKey (or name|pos) -> raw items
  const itemsByPlayer = new Map<string, RawItem[]>();
  const idOf = (p: Player) => p.player_key ?? `${normName(p.name)}|${p.position}`;
  for (const p of players) itemsByPlayer.set(idOf(p), []);

  // 1. ESPN (per player)
  let espnDone = 0;
  for (const p of players) {
    const items = await fetchEspnItems(p);
    if (items.length) itemsByPlayer.get(idOf(p))!.push(...items);
    if (++espnDone % 100 === 0) console.log(`  ESPN ${espnDone}/${players.length}`);
    await sleep(ESPN_RATE_MS);
  }

  // 2. Reddit (per subreddit, scan posts for player mentions)
  for (const sub of REDDIT_SUBS) {
    const posts = await fetchRedditPosts(sub);
    console.log(`  r/${sub}: ${posts.length} recent posts`);
    for (const post of posts) {
      const lower = post.text.toLowerCase();
      for (const p of players) {
        if (!p.patterns.some((pat) => pat.length > 4 && lower.includes(pat))) continue;
        itemsByPlayer.get(idOf(p))!.push({
          source: `reddit:${sub}`,
          headline: post.text.slice(0, 140).replace(/\s+/g, ' ').trim(),
          summary: '',
          published: new Date(post.ts).toISOString(),
          link: post.permalink,
          ts: post.ts,
        });
      }
    }
  }

  // 3. Roll up per player
  const out = players.map((p) => {
    const raw = (itemsByPlayer.get(idOf(p)) ?? []).sort((a, b) => b.ts - a.ts);
    const volumeBySource: Record<string, number> = {};
    let pos = 0, neg = 0;
    const items = raw.map((it) => {
      volumeBySource[it.source] = (volumeBySource[it.source] ?? 0) + 1;
      const s = scoreSentiment(`${it.headline} ${it.summary}`);
      pos += s.pos; neg += s.neg;
      return {
        source: it.source, headline: it.headline, summary: it.summary || undefined,
        published: it.published, link: it.link || undefined,
        score: s.score, method: s.method as 'lexicon',
      };
    });
    const totalHits = pos + neg;
    const sentiment = totalHits === 0 ? 0 : Math.round(((pos - neg) / totalHits) * 100) / 100;
    const recent = raw.filter((it) => it.ts >= windowMid).length;
    const prior = raw.length - recent;
    const trend = prior === 0 ? (recent > 0 ? recent : 0) : Math.round((recent / prior) * 100) / 100;
    return {
      player_key: p.player_key, name: p.name, position: p.position, team: p.team,
      espn_id: p.espn_id,
      volume: raw.length, volumeBySource,
      sentiment, sentimentLabel: sentimentLabel(sentiment), pos, neg, trend,
      lastPublished: raw[0]?.published,
      items: items.slice(0, MAX_ITEMS_PER_PLAYER),
      method: 'lexicon' as const,
    };
  }).filter((p) => p.volume > 0)
    .sort((a, b) => b.volume - a.volume);

  const snapshot = {
    generated: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    sources: ['espn', 'rotowire', ...REDDIT_SUBS.map((s) => `reddit:${s}`)],
    players: out,
  };

  mkdirSync('public/data', { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(snapshot));
  console.log(`\nSaved ${out.length} players with buzz to ${OUTPUT_PATH}`);
}

main().catch((e) => {
  console.error('Buzz fetch failed:', (e as Error).message || e);
  process.exit(0); // never fail the build
});
