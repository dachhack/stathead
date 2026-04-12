/**
 * Fetch NFL Draft prospect Top-30 / pre-draft visits from WalterFootball.
 *
 * Tries both "by prospect" and "by team" page variants — whichever yields
 * data first wins. The URL scheme has changed over the years (see urlsForYear).
 *
 * Usage:
 *   npx tsx scripts/fetch-visits.ts --years 2013-2026
 *   npx tsx scripts/fetch-visits.ts --year 2024 --from-file ./wf_2024.html
 *   npx tsx scripts/fetch-visits.ts --list
 *
 * Output: public/data/feature-store/visits.json — keyed by "<normalName>::<year>".
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { normalizeName } from '../src/lib/featureTypes';

// Puppeteer is optional — only needed for JS-rendered pages (2024+).
// Install: npm install puppeteer
let puppeteer: any = null;
const PUPPETEER_MODULE = 'puppeteer';
try { puppeteer = await import(PUPPETEER_MODULE); } catch { /* not installed */ }

// ── Config ─────────────────────────────────────────────────────────────

const OUT_DIR = 'public/data/feature-store';
const OUT_FILE = join(OUT_DIR, 'visits.json');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const EARLIEST_YEAR = 2013;
const DEBUG = process.argv.includes('--debug');

// NFL team name → standard abbreviation (exhaustive, including historical names)
const TEAM_MAP: Record<string, string> = {
  'bills': 'BUF', 'buffalo': 'BUF', 'buffalo bills': 'BUF',
  'dolphins': 'MIA', 'miami': 'MIA', 'miami dolphins': 'MIA',
  'patriots': 'NE', 'new england': 'NE', 'new england patriots': 'NE',
  'jets': 'NYJ', 'new york jets': 'NYJ', 'ny jets': 'NYJ',
  'ravens': 'BAL', 'baltimore': 'BAL', 'baltimore ravens': 'BAL',
  'bengals': 'CIN', 'cincinnati': 'CIN', 'cincinnati bengals': 'CIN',
  'browns': 'CLE', 'cleveland': 'CLE', 'cleveland browns': 'CLE',
  'steelers': 'PIT', 'pittsburgh': 'PIT', 'pittsburgh steelers': 'PIT',
  'texans': 'HOU', 'houston': 'HOU', 'houston texans': 'HOU',
  'colts': 'IND', 'indianapolis': 'IND', 'indianapolis colts': 'IND',
  'jaguars': 'JAX', 'jacksonville': 'JAX', 'jacksonville jaguars': 'JAX', 'jags': 'JAX',
  'titans': 'TEN', 'tennessee': 'TEN', 'tennessee titans': 'TEN',
  'broncos': 'DEN', 'denver': 'DEN', 'denver broncos': 'DEN',
  'chiefs': 'KC', 'kansas city': 'KC', 'kansas city chiefs': 'KC', 'kc': 'KC',
  'raiders': 'LV', 'las vegas': 'LV', 'las vegas raiders': 'LV', 'oakland': 'LV', 'oakland raiders': 'LV',
  'chargers': 'LAC', 'los angeles chargers': 'LAC', 'san diego': 'LAC', 'san diego chargers': 'LAC', 'la chargers': 'LAC',
  'cowboys': 'DAL', 'dallas': 'DAL', 'dallas cowboys': 'DAL',
  'giants': 'NYG', 'new york giants': 'NYG', 'ny giants': 'NYG',
  'eagles': 'PHI', 'philadelphia': 'PHI', 'philadelphia eagles': 'PHI',
  'commanders': 'WAS', 'washington commanders': 'WAS', 'washington': 'WAS',
  'redskins': 'WAS', 'washington redskins': 'WAS', 'football team': 'WAS', 'washington football team': 'WAS',
  'bears': 'CHI', 'chicago': 'CHI', 'chicago bears': 'CHI',
  'lions': 'DET', 'detroit': 'DET', 'detroit lions': 'DET',
  'packers': 'GB', 'green bay': 'GB', 'green bay packers': 'GB', 'gb': 'GB',
  'vikings': 'MIN', 'minnesota': 'MIN', 'minnesota vikings': 'MIN',
  'falcons': 'ATL', 'atlanta': 'ATL', 'atlanta falcons': 'ATL',
  'panthers': 'CAR', 'carolina': 'CAR', 'carolina panthers': 'CAR',
  'saints': 'NO', 'new orleans': 'NO', 'new orleans saints': 'NO',
  'buccaneers': 'TB', 'tampa bay': 'TB', 'tampa bay buccaneers': 'TB', 'bucs': 'TB',
  'cardinals': 'ARI', 'arizona': 'ARI', 'arizona cardinals': 'ARI',
  'rams': 'LAR', 'los angeles rams': 'LAR', 'st. louis': 'LAR', 'st louis': 'LAR',
  'saint louis': 'LAR', 'la rams': 'LAR', 'st. louis rams': 'LAR', 'st louis rams': 'LAR',
  '49ers': 'SF', 'niners': 'SF', 'san francisco': 'SF', 'san francisco 49ers': 'SF',
  'seahawks': 'SEA', 'seattle': 'SEA', 'seattle seahawks': 'SEA',
};

// All known NFL team abbreviations (for validating resolved teams)
const VALID_TEAMS = new Set(Object.values(TEAM_MAP));

// ── Types ──────────────────────────────────────────────────────────────

interface VisitRecord {
  name: string;
  normalName: string;
  pos: string;
  school: string;
  year: number;
  teams: string[];
  raw?: string[];
  source: string;
  updatedAt: string;
}
type VisitsStore = Record<string, VisitRecord>;

// ── URL resolution ─────────────────────────────────────────────────────

/** All candidate URLs for a given year, both by-prospect and by-team. */
function urlsForYear(year: number): { url: string; mode: 'prospect' | 'team' }[] {
  const urls: { url: string; mode: 'prospect' | 'team' }[] = [];

  // .php scheme (confirmed 2024-2026)
  if (year >= 2023) {
    urls.push({ url: `https://walterfootball.com/ProspectMeetingsByProspect${year}.php`, mode: 'prospect' });
    urls.push({ url: `https://walterfootball.com/ProspectMeetingsByTeam${year}.php`, mode: 'team' });
  }
  // Legacy .php scheme (confirmed 2013-2014, 2018)
  if (year < 2024) {
    urls.push({ url: `https://walterfootball.com/draft${year}meetingsprospects.php`, mode: 'prospect' });
    urls.push({ url: `https://walterfootball.com/draft${year}meetingsteams.php`, mode: 'team' });
    urls.push({ url: `https://walterfootball.com/draft${year}meetings.php`, mode: 'prospect' });
  }
  return urls;
}

// ── Fetch ──────────────────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': 'https://walterfootball.com/',
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return await resp.text();
}

// Store article text from the last browser fetch (set by fetchHtmlWithBrowser)
let lastArticleText = '';

/**
 * Fetch a page using a headless browser (Puppeteer) so JS-rendered content
 * is included. Also extracts the article's innerText for text-based parsing.
 */
async function fetchHtmlWithBrowser(url: string): Promise<string> {
  if (!puppeteer) {
    throw new Error('Puppeteer not installed — run: npm install puppeteer');
  }
  lastArticleText = '';
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    // Wait for the entry-content div to appear (WordPress article body)
    try {
      await page.waitForSelector('.entry-content', { timeout: 10000 });
    } catch { /* might not exist on 404 pages */ }
    // Scroll down to trigger lazy loading of content
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise((r: any) => setTimeout(r, 3000));
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise((r: any) => setTimeout(r, 3000));
    // Get full page HTML
    const html = await page.content();
    // Also extract plain text of the article body for debugging
    const bodyText = await page.evaluate(() => {
      const el = document.querySelector('#article-body') || document.querySelector('.entry-content');
      return el ? (el as HTMLElement).innerText : '';
    });
    if (bodyText && bodyText.length > 100) {
      lastArticleText = bodyText;
      console.log(`    [article-text] (${bodyText.length} chars) ${bodyText.slice(0, 2000)}`);
    }
    return html;
  } finally {
    await browser.close();
  }
}

// ── Parse helpers ──────────────────────────────────────────────────────

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveTeam(raw: string): string | null {
  const key = raw.toLowerCase().replace(/[.,;:'"()]/g, '').replace(/\s+/g, ' ').trim();
  if (!key || key.length < 2) return null;
  if (TEAM_MAP[key]) return TEAM_MAP[key];
  const trimmed = key.replace(/^the\s+/, '');
  if (TEAM_MAP[trimmed]) return TEAM_MAP[trimmed];
  const words = trimmed.split(' ');
  for (let len = Math.min(3, words.length); len >= 1; len--) {
    const suffix = words.slice(-len).join(' ');
    if (TEAM_MAP[suffix]) return TEAM_MAP[suffix];
  }
  return null;
}

/** Extract all team names from a text blob using every known team name. */
function extractTeams(text: string): { teams: string[]; raw: string[] } {
  const found = new Set<string>();
  const raw: string[] = [];
  const lower = text.toLowerCase();

  // Check for each known team name in the text
  const sortedKeys = Object.keys(TEAM_MAP).sort((a, b) => b.length - a.length);
  for (const name of sortedKeys) {
    const abbr = TEAM_MAP[name];
    if (found.has(abbr)) continue;
    // Word-boundary match to avoid false positives
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(lower)) {
      found.add(abbr);
      raw.push(name);
    }
  }
  return { teams: [...found].sort(), raw };
}

// ── Parse: by-prospect pages ───────────────────────────────────────────

function parseByProspect(html: string, year: number): VisitRecord[] {
  const records: VisitRecord[] = [];

  // Strategy 1: Look for headers with "Name, POS, School" pattern
  // Try many tag variants: h2, h3, h4, b, strong, span with style
  const headerPatterns = [
    // <b>Name, POS, School</b> or <strong>Name, POS, School</strong>
    /<(?:b|strong|h[2-5])[^>]*>\s*((?:[A-Z][A-Za-z'\-. ]+),\s*(?:[A-Z/]{1,6}),\s*(?:[^<]+?))\s*<\/(?:b|strong|h[2-5])>/gi,
    // Same but allowing nested tags like <b><a>Name</a>, POS, School</b>
    /<(?:b|strong|h[2-5])[^>]*>((?:(?:<[^>]*>)*[A-Z][^<]*(?:<[^>]*>)*[^<]*?,\s*[A-Z/]{1,6},[^<]+?))<\/(?:b|strong|h[2-5])>/gi,
  ];

  for (const headerRe of headerPatterns) {
    headerRe.lastIndex = 0;
    const hits: { idx: number; endIdx: number; raw: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = headerRe.exec(html)) !== null) {
      hits.push({ idx: m.index, endIdx: headerRe.lastIndex, raw: m[1] });
    }
    if (hits.length === 0) continue;

    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      const block = html.slice(hit.endIdx, i + 1 < hits.length ? hits[i + 1].idx : Math.min(hit.endIdx + 3000, html.length));
      const cleaned = stripTags(hit.raw);
      const parts = cleaned.split(',').map(s => s.trim());
      if (parts.length < 3) continue;
      const name = parts[0];
      const pos = parts[1];
      const school = parts.slice(2).join(',').trim();
      if (!/^[A-Z/]{1,6}$/.test(pos)) continue;

      const { teams, raw } = extractTeams(stripTags(block));
      if (teams.length === 0) continue;

      records.push({
        name, normalName: normalizeName(name), pos: pos.toUpperCase(), school,
        year, teams, raw, source: 'walterfootball', updatedAt: new Date().toISOString(),
      });
    }
    if (records.length > 0) return records;
  }

  // Strategy 2: Plain-text line patterns in stripped content
  const plain = stripTags(html);
  const lineRe = /([A-Z][A-Za-z'\-. ]+?),\s*([A-Z/]{1,6}),\s*([A-Za-z .&'\-]+?)(?:\s*[-–:]\s*|\s*\n)(.*?)(?=\n[A-Z][A-Za-z'\-. ]+?,\s*[A-Z/]{1,6},|\n\n|$)/gs;
  let p: RegExpExecArray | null;
  while ((p = lineRe.exec(plain)) !== null) {
    const { teams, raw } = extractTeams(p[4]);
    if (teams.length === 0) continue;
    records.push({
      name: p[1].trim(), normalName: normalizeName(p[1]), pos: p[2].toUpperCase(),
      school: p[3].trim(), year, teams, raw,
      source: 'walterfootball', updatedAt: new Date().toISOString(),
    });
  }

  return records;
}

// ── Parse: by-team pages ───────────────────────────────────────────────

function parseByTeam(html: string, year: number): VisitRecord[] {
  const prospectMap = new Map<string, { name: string; pos: string; school: string; teams: Set<string> }>();

  // Find team header blocks. WF uses headers like:
  //   <h2>Arizona Cardinals</h2> or <b>Arizona Cardinals</b>
  // followed by prospect lists.
  const teamHeaderRe = /<(?:b|strong|h[2-5])[^>]*>\s*((?:<[^>]*>)?\s*(?:Arizona|Atlanta|Baltimore|Buffalo|Carolina|Chicago|Cincinnati|Cleveland|Dallas|Denver|Detroit|Green Bay|Houston|Indianapolis|Jacksonville|Kansas City|Las Vegas|Los Angeles|Miami|Minnesota|New England|New Orleans|New York|Oakland|Philadelphia|Pittsburgh|San Diego|San Francisco|Seattle|St\.?\s*Louis|Tampa Bay|Tennessee|Washington)[^<]*?)\s*<\/(?:b|strong|h[2-5])>/gi;

  const teamHits: { idx: number; endIdx: number; team: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = teamHeaderRe.exec(html)) !== null) {
    const teamText = stripTags(m[1]).trim();
    const abbr = resolveTeam(teamText);
    if (!abbr) continue;
    teamHits.push({ idx: m.index, endIdx: teamHeaderRe.lastIndex, team: abbr });
  }

  if (teamHits.length === 0) {
    if (DEBUG) console.log(`    [debug] parseByTeam: no team headers found`);
    return [];
  }

  if (DEBUG) console.log(`    [debug] parseByTeam: found ${teamHits.length} team headers`);

  for (let i = 0; i < teamHits.length; i++) {
    const hit = teamHits[i];
    const blockEnd = i + 1 < teamHits.length ? teamHits[i + 1].idx : Math.min(hit.endIdx + 10000, html.length);
    const block = html.slice(hit.endIdx, blockEnd);
    const blockText = stripTags(block);

    // Look for "Name, POS, School" patterns within the team block
    // Allow for variations: "Name (POS) School", "Name, POS, School", "Name - POS - School"
    const prospectPatterns = [
      // "Name, POS, School" — most common
      /([A-Z][A-Za-z'\-. ]+?),\s*([A-Z/]{1,6}),\s*([A-Za-z .&'\-()\d]+?)(?=[,;]|\s*$|\s*\n|$)/gm,
      // "Name (POS), School"
      /([A-Z][A-Za-z'\-. ]+?)\s*\(([A-Z/]{1,6})\),?\s*([A-Za-z .&'\-()\d]+?)(?=[,;]|\s*$|\s*\n|$)/gm,
    ];

    for (const re of prospectPatterns) {
      re.lastIndex = 0;
      let pm: RegExpExecArray | null;
      while ((pm = re.exec(blockText)) !== null) {
        const name = pm[1].trim();
        const pos = pm[2].trim();
        const school = pm[3].trim();
        // Skip false positives
        if (name.length < 3 || school.length < 2) continue;
        if (/^(Visit|Meeting|Interview|Pre|Draft|Top|Round|Pick)/i.test(name)) continue;

        const key = normalizeName(name);
        const existing = prospectMap.get(key);
        if (existing) {
          existing.teams.add(hit.team);
        } else {
          prospectMap.set(key, { name, pos, school, teams: new Set([hit.team]) });
        }
      }
    }
  }

  const records: VisitRecord[] = [];
  for (const [key, p] of prospectMap) {
    records.push({
      name: p.name, normalName: key, pos: p.pos.toUpperCase(), school: p.school,
      year, teams: [...p.teams].sort(), source: 'walterfootball', updatedAt: new Date().toISOString(),
    });
  }
  return records;
}

// ── Parse: plain-text article content (WordPress rendered text) ────────

/** Map full position names to standard abbreviations. */
const POS_MAP: Record<string, string> = {
  'quarterback': 'QB', 'running back': 'RB', 'wide receiver': 'WR',
  'tight end': 'TE', 'offensive tackle': 'OT', 'offensive guard': 'OG',
  'center': 'C', 'offensive lineman': 'OL',
  'defensive end': 'DE', 'defensive tackle': 'DT', 'nose tackle': 'NT',
  '3-4 defensive end': 'DE', 'edge': 'EDGE', 'edge rusher': 'EDGE',
  'inside linebacker': 'ILB', 'outside linebacker': 'OLB', 'linebacker': 'LB',
  'cornerback': 'CB', 'safety': 'S', 'free safety': 'FS', 'strong safety': 'SS',
  'kicker': 'K', 'punter': 'P', 'long snapper': 'LS',
  'kick returner': 'KR', 'defensive back': 'DB', 'nickelback': 'CB',
  'fullback': 'FB', 'h-back': 'TE',
};

function resolvePos(raw: string): string {
  const key = raw.toLowerCase().trim();
  return POS_MAP[key] || raw.toUpperCase();
}

/**
 * Parse the plain-text article content from WF's WordPress pages.
 * Format (by team):
 *   Arizona Cardinals
 *   David Bailey, Defensive End, Texas Tech (T30)
 *   Caleb Banks, Defensive Tackle, Florida (T30)
 *   ...
 *   Atlanta Falcons
 *   ...
 */
function parseArticleText(text: string, year: number): VisitRecord[] {
  const prospectMap = new Map<string, { name: string; pos: string; school: string; teams: Set<string> }>();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  let currentTeam: string | null = null;

  for (const line of lines) {
    // Check if this line is an NFL team name
    const teamAbbr = resolveTeam(line);
    if (teamAbbr && VALID_TEAMS.has(teamAbbr)) {
      // Verify it's a standalone team header (not a prospect line with commas)
      if (!line.includes(',') || /^(Arizona|Atlanta|Baltimore|Buffalo|Carolina|Chicago|Cincinnati|Cleveland|Dallas|Denver|Detroit|Green Bay|Houston|Indianapolis|Jacksonville|Kansas City|Las Vegas|Los Angeles|Miami|Minnesota|New England|New Orleans|New York|Oakland|Philadelphia|Pittsburgh|San Diego|San Francisco|Seattle|St\.?\s*Louis|Tampa Bay|Tennessee|Washington)/i.test(line)) {
        currentTeam = teamAbbr;
        continue;
      }
    }

    if (!currentTeam) continue;

    // Parse prospect line: "Name, Position, School (Type)"
    // Also handles: "Name, Position, School (Type1, Type2)"
    const prospectMatch = line.match(
      /^([A-Z][A-Za-z'\-. ]+(?:\s+[A-Z][A-Za-z'\-. ]+)*)\^?\s*,\s*(.+?)\s*,\s*(.+?)(?:\s*\(([^)]+)\))?\s*$/
    );
    if (!prospectMatch) continue;

    const name = prospectMatch[1].trim();
    const posRaw = prospectMatch[2].trim();
    const school = prospectMatch[3].trim();
    const pos = resolvePos(posRaw);

    // Skip false positives
    if (name.length < 3 || school.length < 2) continue;
    if (/^(By |Updated|This is|SR |EW |COM |INT |PRO |LOC |T30 |WOR |STM |VIR |Click)/i.test(name)) continue;

    const key = normalizeName(name);
    const existing = prospectMap.get(key);
    if (existing) {
      existing.teams.add(currentTeam);
    } else {
      prospectMap.set(key, { name, pos, school, teams: new Set([currentTeam]) });
    }
  }

  const records: VisitRecord[] = [];
  for (const [key, p] of prospectMap) {
    records.push({
      name: p.name, normalName: key, pos: p.pos, school: p.school,
      year, teams: [...p.teams].sort(), source: 'walterfootball',
      updatedAt: new Date().toISOString(),
    });
  }
  return records;
}

// ── Main parse dispatcher ──────────────────────────────────────────────

function parseHtml(html: string, year: number, mode: 'prospect' | 'team'): VisitRecord[] {
  if (mode === 'team') return parseByTeam(html, year);
  return parseByProspect(html, year);
}

// ── Persist ────────────────────────────────────────────────────────────

function loadStore(): VisitsStore {
  if (!existsSync(OUT_FILE)) return {};
  try { return JSON.parse(readFileSync(OUT_FILE, 'utf-8')) as VisitsStore; } catch { return {}; }
}

function saveStore(store: VisitsStore): void {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const ordered = Object.keys(store).sort((a, b) => {
    const [, ay] = a.split('::');
    const [, by] = b.split('::');
    if (ay !== by) return Number(by) - Number(ay);
    return a.localeCompare(b);
  });
  const out: VisitsStore = {};
  for (const k of ordered) out[k] = store[k];
  writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
}

function mergeRecords(store: VisitsStore, records: VisitRecord[]): number {
  let added = 0;
  for (const rec of records) {
    const key = `${rec.normalName}::${rec.year}`;
    const existing = store[key];
    if (existing) {
      const merged = new Set([...existing.teams, ...rec.teams]);
      store[key] = { ...existing, teams: [...merged].sort(), updatedAt: rec.updatedAt };
    } else {
      store[key] = rec;
      added++;
    }
  }
  return added;
}

// ── Fetch year ─────────────────────────────────────────────────────────

function parseYears(spec: string): number[] {
  const years = new Set<number>();
  for (const part of spec.split(',')) {
    const range = part.trim();
    const m = range.match(/^(\d{4})-(\d{4})$/);
    if (m) {
      for (let y = Number(m[1]); y <= Number(m[2]); y++) years.add(y);
    } else if (/^\d{4}$/.test(range)) years.add(Number(range));
  }
  return [...years].sort();
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx < args.length - 1 ? args[idx + 1] : undefined;
}

async function fetchYear(year: number): Promise<VisitRecord[] | null> {
  if (year < EARLIEST_YEAR) {
    console.log(`  [skip] ${year}: coverage starts at ${EARLIEST_YEAR}`);
    return null;
  }

  const candidates = urlsForYear(year);
  let bestBrowser: VisitRecord[] = [];

  // Try Puppeteer for JS-rendered pages (.php pages on newer WF WordPress theme).
  if (puppeteer) {
    const browserUrls = candidates.filter(c =>
      c.url.includes('/prospectmeetings/') || c.url.includes('ProspectMeetings')
    ).slice(0, 4);

    for (const { url, mode } of browserUrls) {
      try {
        process.stdout.write(`  ${year}: fetching (browser) ${url} ... `);
        const html = await fetchHtmlWithBrowser(url);
        let records = parseHtml(html, year, mode);
        console.log(`ok (${records.length} records, mode=${mode})`);
        // If HTML parser found < 10 records, try text-based parsing of article content
        if (records.length < 10 && lastArticleText.length > 200) {
          const textRecords = parseArticleText(lastArticleText, year);
          console.log(`    [text-parse] ${textRecords.length} records from article text`);
          if (textRecords.length > records.length) records = textRecords;
        }
        if (records.length > bestBrowser.length) bestBrowser = records;
        if (records.length >= 10) return records;
      } catch (err) {
        const msg = (err as Error).message || String(err);
        console.log(`failed (${msg})`);
      }
    }
    if (bestBrowser.length > 0) {
      // Got some records from browser but < 10 — still use them if static
      // fetch doesn't do better
    }
  }

  // Static fetch (works for pre-2024 old-format pages)
  let bestStatic: VisitRecord[] = [];
  for (const { url, mode } of candidates) {
    try {
      process.stdout.write(`  ${year}: fetching ${url} ... `);
      const html = await fetchHtml(url);
      const records = parseHtml(html, year, mode);
      console.log(`ok (${records.length} records, mode=${mode})`);

      if (records.length < 10) {
        const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
        const body = bodyMatch ? bodyMatch[1] : html;
        const preview = stripTags(body.slice(0, 2000)).slice(0, 400);
        console.log(`    [html-preview] ${preview}`);
      }

      if (records.length > bestStatic.length) bestStatic = records;
      if (records.length >= 10) return records;
    } catch (err) {
      const msg = (err as Error).message || String(err);
      console.log(`failed (${msg})`);
      if (/ENOTFOUND|ECONNREFUSED|tunnel|forbidden|network|fetch failed/i.test(msg)) {
        return null;
      }
    }
  }
  // Return whichever approach got more records
  const best = bestBrowser.length > bestStatic.length ? bestBrowser : bestStatic;
  return best.length > 0 ? best : [];
}

// ── CLI ────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    const store = loadStore();
    const keys = Object.keys(store);
    if (keys.length === 0) {
      console.log('No visit records stored.');
      return 0;
    }
    const byYear = new Map<number, number>();
    for (const k of keys) {
      const y = Number(k.split('::')[1]);
      byYear.set(y, (byYear.get(y) || 0) + 1);
    }
    console.log(`Stored visit records: ${keys.length}`);
    for (const [y, n] of [...byYear].sort((a, b) => b[0] - a[0])) {
      console.log(`  ${y}: ${n} prospects`);
    }
    return 0;
  }

  const store = loadStore();
  let totalAdded = 0;
  let networkBlocked = false;

  const fromFile = getArg(args, '--from-file');
  if (fromFile) {
    const yearStr = getArg(args, '--year') || getArg(args, '--years');
    if (!yearStr || !/^\d{4}$/.test(yearStr)) { console.error('--from-file requires --year YYYY'); return 1; }
    if (!existsSync(fromFile)) { console.error(`File not found: ${fromFile}`); return 1; }
    const html = readFileSync(fromFile, 'utf-8');
    const year = Number(yearStr);
    // Try both parse modes
    let records = parseByProspect(html, year);
    if (records.length === 0) records = parseByTeam(html, year);
    console.log(`Parsed ${records.length} records from ${fromFile} (year=${year})`);
    totalAdded += mergeRecords(store, records);
  } else {
    const yearsSpec = getArg(args, '--years') || getArg(args, '--year');
    if (!yearsSpec) {
      console.error('Usage: fetch-visits.ts --years 2013-2026');
      return 1;
    }
    const years = parseYears(yearsSpec);
    console.log(`Fetching visits for years: ${years.join(', ')}`);
    for (const y of years) {
      const records = await fetchYear(y);
      if (records === null) { networkBlocked = true; continue; }
      totalAdded += mergeRecords(store, records);
    }
  }

  saveStore(store);
  console.log(`\nWrote ${OUT_FILE} — ${Object.keys(store).length} total records (+${totalAdded} new)`);

  if (networkBlocked && totalAdded === 0) {
    console.error('\nNetwork blocked. Use --from-file with locally saved HTML pages.');
    return 2;
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => { console.error(err); process.exit(1); });
