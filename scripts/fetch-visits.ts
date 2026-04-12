/**
 * Fetch NFL Draft prospect Top-30 / pre-draft visits from WalterFootball.
 *
 * WalterFootball organizes visits three ways (by prospect, by team, by college).
 * We scrape the "by prospect" view — one record per prospect with the list of
 * teams they visited. The URL scheme changed around 2024, so we try both.
 *
 * Usage:
 *   # Live fetch a range of years
 *   npx tsx scripts/fetch-visits.ts --years 2013-2026
 *
 *   # Fetch a single year
 *   npx tsx scripts/fetch-visits.ts --years 2024
 *
 *   # Parse a locally saved HTML file (useful when walterfootball.com is
 *   # firewalled; save the page via browser → File → Save As, then pass it)
 *   npx tsx scripts/fetch-visits.ts --year 2024 --from-file ./wf_2024.html
 *
 *   # List what's currently stored
 *   npx tsx scripts/fetch-visits.ts --list
 *
 * Output:
 *   public/data/feature-store/visits.json — keyed by "<normalName>::<year>".
 *
 * Exit codes:
 *   0 — wrote at least one record
 *   1 — fatal error (bad args, file missing, nothing parsed)
 *   2 — network blocked (user needs to run with --from-file)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { normalizeName } from '../src/lib/featureTypes';

// ── Config ─────────────────────────────────────────────────────────────

const OUT_DIR = 'public/data/feature-store';
const OUT_FILE = join(OUT_DIR, 'visits.json');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// First year we know WF has a dedicated visits tracker. Earlier years
// (2010-2012) exist as general draft coverage but not as a structured
// "meetings" page — verified by searching walterfootball.com directly.
const EARLIEST_YEAR = 2013;

// NFL team name → standard abbreviation. Includes common WF phrasings
// (e.g. "Redskins" pre-2020, "Washington", "Commanders").
const TEAM_MAP: Record<string, string> = {
  // AFC East
  'bills': 'BUF', 'buffalo': 'BUF', 'buffalo bills': 'BUF',
  'dolphins': 'MIA', 'miami': 'MIA', 'miami dolphins': 'MIA',
  'patriots': 'NE', 'new england': 'NE', 'new england patriots': 'NE',
  'jets': 'NYJ', 'new york jets': 'NYJ',
  // AFC North
  'ravens': 'BAL', 'baltimore': 'BAL', 'baltimore ravens': 'BAL',
  'bengals': 'CIN', 'cincinnati': 'CIN', 'cincinnati bengals': 'CIN',
  'browns': 'CLE', 'cleveland': 'CLE', 'cleveland browns': 'CLE',
  'steelers': 'PIT', 'pittsburgh': 'PIT', 'pittsburgh steelers': 'PIT',
  // AFC South
  'texans': 'HOU', 'houston': 'HOU', 'houston texans': 'HOU',
  'colts': 'IND', 'indianapolis': 'IND', 'indianapolis colts': 'IND',
  'jaguars': 'JAX', 'jacksonville': 'JAX', 'jacksonville jaguars': 'JAX', 'jags': 'JAX',
  'titans': 'TEN', 'tennessee': 'TEN', 'tennessee titans': 'TEN',
  // AFC West
  'broncos': 'DEN', 'denver': 'DEN', 'denver broncos': 'DEN',
  'chiefs': 'KC', 'kansas city': 'KC', 'kansas city chiefs': 'KC', 'kc': 'KC',
  'raiders': 'LV', 'las vegas': 'LV', 'las vegas raiders': 'LV', 'oakland': 'LV', 'oakland raiders': 'LV',
  'chargers': 'LAC', 'los angeles chargers': 'LAC', 'san diego': 'LAC', 'san diego chargers': 'LAC', 'la chargers': 'LAC',
  // NFC East
  'cowboys': 'DAL', 'dallas': 'DAL', 'dallas cowboys': 'DAL',
  'giants': 'NYG', 'new york giants': 'NYG',
  'eagles': 'PHI', 'philadelphia': 'PHI', 'philadelphia eagles': 'PHI',
  'commanders': 'WAS', 'washington commanders': 'WAS', 'washington': 'WAS',
  'redskins': 'WAS', 'washington redskins': 'WAS', 'football team': 'WAS', 'washington football team': 'WAS',
  // NFC North
  'bears': 'CHI', 'chicago': 'CHI', 'chicago bears': 'CHI',
  'lions': 'DET', 'detroit': 'DET', 'detroit lions': 'DET',
  'packers': 'GB', 'green bay': 'GB', 'green bay packers': 'GB', 'gb': 'GB',
  'vikings': 'MIN', 'minnesota': 'MIN', 'minnesota vikings': 'MIN',
  // NFC South
  'falcons': 'ATL', 'atlanta': 'ATL', 'atlanta falcons': 'ATL',
  'panthers': 'CAR', 'carolina': 'CAR', 'carolina panthers': 'CAR',
  'saints': 'NO', 'new orleans': 'NO', 'new orleans saints': 'NO',
  'buccaneers': 'TB', 'tampa bay': 'TB', 'tampa bay buccaneers': 'TB', 'bucs': 'TB',
  // NFC West
  'cardinals': 'ARI', 'arizona': 'ARI', 'arizona cardinals': 'ARI',
  'rams': 'LAR', 'los angeles rams': 'LAR', 'st. louis': 'LAR', 'st louis': 'LAR', 'saint louis': 'LAR', 'la rams': 'LAR',
  '49ers': 'SF', 'niners': 'SF', 'san francisco': 'SF', 'san francisco 49ers': 'SF',
  'seahawks': 'SEA', 'seattle': 'SEA', 'seattle seahawks': 'SEA',
};

// ── Types ──────────────────────────────────────────────────────────────

interface VisitRecord {
  name: string;
  normalName: string;
  pos: string;
  school: string;
  year: number;
  teams: string[]; // unique NFL team abbreviations
  raw?: string[]; // raw strings the parser saw (for debugging)
  source: string;
  updatedAt: string;
}

type VisitsStore = Record<string, VisitRecord>;

// ── URL resolution ─────────────────────────────────────────────────────

/**
 * WalterFootball's "by prospect" URL pattern has changed over time.
 * Returns the list of candidate URLs to try, in order of likelihood.
 */
function visitUrlsForYear(year: number): string[] {
  const urls: string[] = [];
  // 2024+ scheme (confirmed in Google index):
  //   walterfootball.com/ProspectMeetingsByProspect{year}.php
  if (year >= 2023) {
    urls.push(`https://walterfootball.com/ProspectMeetingsByProspect${year}.php`);
  }
  // Pre-2024 scheme (confirmed for 2013-2014 via Google; others inferred):
  //   walterfootball.com/draft{year}meetingsprospects.php
  if (year < 2024) {
    urls.push(`https://walterfootball.com/draft${year}meetingsprospects.php`);
    // Some older years may use a different spelling
    urls.push(`https://walterfootball.com/draft${year}meetings.php`);
  }
  return urls;
}

// ── Fetch ──────────────────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return await resp.text();
}

// ── Parse ──────────────────────────────────────────────────────────────

/** Strip HTML tags and decode common entities. */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve a raw team string (e.g. "Bears", "Washington Commanders")
 * to a standard NFL abbreviation, or null if unrecognized.
 */
function resolveTeam(raw: string): string | null {
  const key = raw.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
  if (TEAM_MAP[key]) return TEAM_MAP[key];
  // Try removing leading article
  const trimmed = key.replace(/^the\s+/, '');
  if (TEAM_MAP[trimmed]) return TEAM_MAP[trimmed];
  // Match by suffix (last word is usually the nickname)
  const words = trimmed.split(' ');
  const last = words[words.length - 1];
  if (TEAM_MAP[last]) return TEAM_MAP[last];
  const last2 = words.slice(-2).join(' ');
  if (TEAM_MAP[last2]) return TEAM_MAP[last2];
  return null;
}

/**
 * Parse a WalterFootball "by prospect" page into VisitRecord[].
 *
 * The WF page structure (as of 2014-2026) is roughly:
 *   <h3>Prospect Name, POS, School</h3>
 *   <p>Team visit / interview / workout with <a>Team1</a>, <a>Team2</a>...</p>
 *
 * Earlier years used <b> or <h2> for prospect headers. We handle both by
 * looking for a block that starts with a "Name, POS, School" pattern and
 * ends at the next block of the same kind.
 */
function parseVisitsHtml(html: string, year: number): VisitRecord[] {
  const records: VisitRecord[] = [];

  // Narrow to the main content area if possible (skip nav/sidebars).
  // WF historically uses a `<td class="leftside">` container. Fall back
  // to the full body if we can't find it.
  const contentMatch =
    html.match(/<td[^>]*class=["']?leftside["']?[^>]*>([\s\S]*?)<\/td>/i) ||
    html.match(/<div[^>]*id=["']?content["']?[^>]*>([\s\S]*?)<\/div>/i) ||
    html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const content = contentMatch ? contentMatch[1] : html;

  // Split on prospect headers. WF uses <h3> or <b> with a "Name, POS, School"
  // line. We look for any of: <h3>...<h3>, <b>...<b>, or a newline starting
  // with a capital-cased word followed by ", POS,".
  const headerRe =
    /<(?:h[234]|b|strong)[^>]*>\s*([^,<][^<]*?,\s*[A-Z/]{1,6},\s*[^<]+?)\s*<\/(?:h[234]|b|strong)>/g;

  // Grab all header matches with their indices so we can slice between them.
  interface Hit {
    idx: number;
    endIdx: number;
    headerText: string;
  }
  const hits: Hit[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(content)) !== null) {
    hits.push({
      idx: m.index,
      endIdx: headerRe.lastIndex,
      headerText: stripTags(m[1]),
    });
  }

  if (hits.length === 0) {
    // Fallback: parse plain-text lines that match "Name, POS, School"
    // followed by a team list on subsequent lines.
    const plain = stripTags(content);
    const lineRe =
      /([A-Z][A-Za-z'\-.]+(?:\s+[A-Z][A-Za-z'\-.]+)+),\s*([A-Z/]{1,6}),\s*([^:]+?):\s*([^.]+?\.)/g;
    let p: RegExpExecArray | null;
    while ((p = lineRe.exec(plain)) !== null) {
      const rec = buildRecord(p[1], p[2], p[3], p[4], year);
      if (rec) records.push(rec);
    }
    return records;
  }

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    const block = content.slice(hit.endIdx, i + 1 < hits.length ? hits[i + 1].idx : content.length);
    const [name, pos, school] = hit.headerText.split(',').map((s) => s.trim());
    if (!name || !pos || !school) continue;
    const teamsText = stripTags(block);
    const rec = buildRecord(name, pos, school, teamsText, year);
    if (rec) records.push(rec);
  }

  return records;
}

function buildRecord(
  name: string,
  pos: string,
  school: string,
  teamsText: string,
  year: number,
): VisitRecord | null {
  const teams = new Set<string>();
  const raw: string[] = [];

  // Tokenize by comma, semicolon, or " and "
  const tokens = teamsText
    .split(/,|;| and /i)
    .map((t) => t.trim())
    .filter(Boolean);
  for (const tok of tokens) {
    // Remove common prefix words like "with", "visited", "interview"
    const cleaned = tok
      .replace(/^(and\s+)?(the\s+)?/i, '')
      .replace(/\b(pre-?draft|visit|visited|met|meeting|interview|workout|with)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) continue;
    const abbr = resolveTeam(cleaned);
    if (abbr) {
      teams.add(abbr);
      raw.push(cleaned);
    }
  }

  if (teams.size === 0) return null;

  const normalName = normalizeName(name);
  return {
    name,
    normalName,
    pos: pos.toUpperCase(),
    school,
    year,
    teams: [...teams].sort(),
    raw,
    source: 'walterfootball',
    updatedAt: new Date().toISOString(),
  };
}

// ── Persist ────────────────────────────────────────────────────────────

function loadStore(): VisitsStore {
  if (!existsSync(OUT_FILE)) return {};
  try {
    return JSON.parse(readFileSync(OUT_FILE, 'utf-8')) as VisitsStore;
  } catch {
    return {};
  }
}

function saveStore(store: VisitsStore): void {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  // Stable key ordering: year desc, then name asc.
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

function storeKey(rec: VisitRecord): string {
  return `${rec.normalName}::${rec.year}`;
}

function mergeRecords(store: VisitsStore, records: VisitRecord[]): number {
  let added = 0;
  for (const rec of records) {
    const key = storeKey(rec);
    const existing = store[key];
    if (existing) {
      // Union the team set; keep the earliest name spelling but latest
      // timestamp.
      const merged = new Set<string>([...existing.teams, ...rec.teams]);
      store[key] = {
        ...existing,
        teams: [...merged].sort(),
        raw: [...(existing.raw || []), ...(rec.raw || [])],
        updatedAt: rec.updatedAt,
      };
    } else {
      store[key] = rec;
      added++;
    }
  }
  return added;
}

// ── CLI ────────────────────────────────────────────────────────────────

function parseYears(spec: string): number[] {
  const years = new Set<number>();
  for (const part of spec.split(',')) {
    const range = part.trim();
    const m = range.match(/^(\d{4})-(\d{4})$/);
    if (m) {
      const [, a, b] = m;
      for (let y = Number(a); y <= Number(b); y++) years.add(y);
    } else if (/^\d{4}$/.test(range)) {
      years.add(Number(range));
    }
  }
  return [...years].sort();
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}

async function fetchYear(year: number): Promise<VisitRecord[] | null> {
  if (year < EARLIEST_YEAR) {
    console.log(`  [skip] ${year}: WalterFootball's visits tracker does not cover years before ${EARLIEST_YEAR}`);
    return null;
  }
  const urls = visitUrlsForYear(year);
  for (const url of urls) {
    try {
      process.stdout.write(`  ${year}: fetching ${url} ... `);
      const html = await fetchHtml(url);
      const records = parseVisitsHtml(html, year);
      console.log(`ok (${records.length} records)`);
      if (records.length > 0) return records;
    } catch (err) {
      const msg = (err as Error).message || String(err);
      console.log(`failed (${msg})`);
      if (/ENOTFOUND|ECONNREFUSED|tunnel|forbidden|network|fetch failed/i.test(msg)) {
        return null; // signal network blocked
      }
    }
  }
  return [];
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    const store = loadStore();
    const keys = Object.keys(store);
    if (keys.length === 0) {
      console.log('No visit records stored. Run with --years 2013-2026 to populate.');
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
    if (!yearStr || !/^\d{4}$/.test(yearStr)) {
      console.error('Error: --from-file requires --year YYYY');
      return 1;
    }
    if (!existsSync(fromFile)) {
      console.error(`Error: file not found: ${fromFile}`);
      return 1;
    }
    const html = readFileSync(fromFile, 'utf-8');
    const year = Number(yearStr);
    const records = parseVisitsHtml(html, year);
    console.log(`Parsed ${records.length} records from ${fromFile} (year=${year})`);
    totalAdded += mergeRecords(store, records);
  } else {
    const yearsSpec = getArg(args, '--years') || getArg(args, '--year');
    if (!yearsSpec) {
      console.error(
        'Usage: fetch-visits.ts --years 2013-2026\n' +
        '       fetch-visits.ts --year 2024 --from-file ./wf_2024.html\n' +
        '       fetch-visits.ts --list',
      );
      return 1;
    }
    const years = parseYears(yearsSpec);
    console.log(`Fetching visits for years: ${years.join(', ')}`);
    for (const y of years) {
      const records = await fetchYear(y);
      if (records === null) {
        networkBlocked = true;
        continue;
      }
      totalAdded += mergeRecords(store, records);
    }
  }

  saveStore(store);
  console.log(`\nWrote ${OUT_FILE} — ${Object.keys(store).length} total records (+${totalAdded} new)`);

  if (networkBlocked && totalAdded === 0) {
    console.error(
      '\nNetwork access to walterfootball.com appears blocked from this environment.\n' +
      'Save the pages in a browser (View → Save As → HTML) and re-run with:\n' +
      '  npx tsx scripts/fetch-visits.ts --year 2024 --from-file ./wf_2024.html',
    );
    return 2;
  }

  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
