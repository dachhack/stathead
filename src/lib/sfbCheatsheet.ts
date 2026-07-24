/**
 * Footballguys "Cheatsheet for Scott Fish Bowl" — parser + types.
 *
 * The cheatsheet PDF is a PAID product, so its parsed JSON
 * (public/data/sfb16-cheatsheet.json) is LOCAL-ONLY and never committed —
 * same regime as the Clay extracts (see .gitignore / DATA_SOURCES.md).
 * Regenerate from a PDF you own:
 *
 *   pdftotext -layout Cheatsheet_for_Scott_Fish_Bowl.pdf - \
 *     | npx tsx scripts/parse-sfb-cheatsheet.ts > public/data/sfb16-cheatsheet.json
 *
 * The SFBCheatsheet component loads that file when present and otherwise
 * offers an in-browser import (same parser, result cached in localStorage),
 * so the deployed site works without the data ever shipping in the repo.
 *
 * PDF layout: three ranked lists in side-by-side columns — OVERALL (top 60,
 * abbreviated names + position), QB (1-100, full names), and a combined
 * RB/WR/TE flex list (1-567, full names; SFB16 is positionless so the sheet
 * never splits them). Records are `rank name [flags] TEAM/bye adp value`
 * where flags are single-char icons (P rookie, Q upside, ...) and adp is
 * Footballguys' round.pick ADP+ ("2.08") or 0 for undrafted. Column
 * membership is decided by each record's x-offset against the column
 * headers on its page — rank sequences alone are ambiguous (both the QB
 * and flex lists pass through the same rank numbers).
 */

export interface CheatsheetPlayer {
  rank: number;          // rank within its list (QB or flex)
  name: string;
  team: string;          // '' = free agent
  bye: number;           // 0 = none/FA
  adp: string;           // round.pick ("2.08"); '' = undrafted
  value: number;         // Footballguys value score
  rookie: boolean;       // P icon
  upside: boolean;       // Q icon
  position: string;      // 'QB' for the QB list; resolved via lookup for flex ('' if unknown)
  overallRank?: number;  // rank in the sheet's overall top-60, when present
}

export interface CheatsheetDoc {
  source: string;
  generatedAt: string;   // "Cheat sheet generated on ..." line from the PDF
  importedAt: string;
  qbs: CheatsheetPlayer[];
  flex: CheatsheetPlayer[];
}

const TEAM_RE = /^([A-Z]{2,3})\/(\d*)$/;
const ADP_RE = /^(\d{1,2}\.\d{2}|0)$/;
const VALUE_RE = /^-?\d+$/;
const RANK_RE = /^\d{1,3}$/;
const POS_TOKENS = new Set(['QB', 'RB', 'WR', 'TE', 'PK', 'K', 'DST', 'Def']);
// Icon-legend glyphs that pdftotext renders as stray tokens between the
// name and team: P rookie, Q high upside, F keeper, V avoid, g injured,
// X/h/}/* misc. "QP"/"PQ" appear fused on tight lines.
const FLAG_RE = /^[PQFVgXh*}]$|^[QP]{2}$/;

interface RawRecord {
  x: number;             // char offset of the rank token (column position)
  rank: number;
  name: string;
  pos: string;           // '' unless the record carries a position column (overall list)
  team: string;
  bye: number;
  adp: string;
  value: number;
  rookie: boolean;
  upside: boolean;
}

/** Tokenize a line keeping each token's char offset. */
function tokenize(line: string): { t: string; x: number }[] {
  const out: { t: string; x: number }[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push({ t: m[0], x: m.index });
  return out;
}

/** Extract every `rank ... TEAM/bye adp value` record on one line. */
function recordsOnLine(line: string): RawRecord[] {
  const toks = tokenize(line);
  const out: RawRecord[] = [];
  let i = 0;
  while (i < toks.length) {
    if (!RANK_RE.test(toks[i].t)) { i++; continue; }
    // Find the team token within the next several tokens (name + flags).
    let teamIdx = -1;
    for (let j = i + 1; j < Math.min(i + 10, toks.length - 2); j++) {
      if (TEAM_RE.test(toks[j].t) && ADP_RE.test(toks[j + 1].t) && VALUE_RE.test(toks[j + 2].t)) {
        teamIdx = j;
        break;
      }
    }
    if (teamIdx === -1 || teamIdx === i + 1) { i++; continue; } // no name tokens → not a record
    // Names never contain bare integers, so an integer between the rank and
    // team means we started inside preceding prose ("...around 8 have been
    // 6 Dak Prescott DAL/14...") — restart at the innermost integer.
    let start = i;
    for (let j = i + 1; j < teamIdx - 1; j++) {
      if (RANK_RE.test(toks[j].t)) start = j;
    }
    if (start !== i) { i = start; continue; }
    const between = toks.slice(i + 1, teamIdx).map((o) => o.t);
    // Position column (overall list) sits immediately before the team.
    let pos = '';
    if (between.length > 1 && POS_TOKENS.has(between[between.length - 1])) {
      pos = between.pop()!;
      if (pos === 'K' || pos === 'Def') pos = pos === 'K' ? 'PK' : 'DST';
    }
    const flags = between.filter((t) => FLAG_RE.test(t));
    const nameToks = between.filter((t) => !FLAG_RE.test(t)).map((t) => {
      // Tight lines fuse icon glyphs onto the name ("Jr.P", "BrownQ").
      const m = t.match(/^(.*?(?:Jr|Sr)\.)([PQ]+)$/);
      if (m) { flags.push(m[2]); return m[1]; }
      return t;
    });
    if (nameToks.length === 0) { i++; continue; }
    const [, team, byeStr] = toks[teamIdx].t.match(TEAM_RE)!;
    const adpTok = toks[teamIdx + 1].t;
    out.push({
      x: toks[i].x,
      rank: Number(toks[i].t),
      name: nameToks.join(' '),
      pos,
      team: team === 'FA' ? '' : team,
      bye: byeStr ? Number(byeStr) : 0,
      adp: adpTok === '0' ? '' : adpTok,
      value: Number(toks[teamIdx + 2].t) || 0,
      rookie: flags.some((f) => f.includes('P')),
      upside: flags.some((f) => f.includes('Q')),
    });
    i = teamIdx + 3;
  }
  return out;
}

/** Parse the full `pdftotext -layout` text of the cheatsheet. */
export function parseCheatsheetText(text: string): CheatsheetDoc {
  const genMatch = text.match(/generated on ([^.\n]+(?:\.\d+)*)/i);
  const doc: CheatsheetDoc = {
    source: 'Footballguys SFB cheatsheet',
    generatedAt: genMatch ? genMatch[1].trim() : '',
    importedAt: new Date().toISOString(),
    qbs: [],
    flex: [],
  };
  const overall: RawRecord[] = [];

  for (const page of text.split('\f')) {
    const lines = page.split('\n');
    // Column x-boundaries from this page's header tokens. Ranks alone can't
    // classify records — the QB and flex lists pass through the same numbers.
    let overallX = -1, qbX = -1, flexX = -1;
    for (const line of lines) {
      for (const { t, x } of tokenize(line)) {
        if (t === 'OVERALL' && overallX === -1) overallX = x;
        else if (t === 'QB' && qbX === -1 && /ADP\+/.test(line)) qbX = x;
        else if (t === 'RB,WR,TE' && flexX === -1) flexX = x;
      }
      if (flexX !== -1 && (qbX !== -1 || overallX !== -1)) break;
    }
    for (const line of lines) {
      for (const rec of recordsOnLine(line)) {
        // Rightmost header at or left of the record wins (2-char tolerance
        // for ragged rank alignment).
        if (flexX !== -1 && rec.x >= flexX - 2) {
          doc.flex.push({ ...toPlayer(rec), position: '' });
        } else if (qbX !== -1 && rec.x >= qbX - 2) {
          doc.qbs.push({ ...toPlayer(rec), position: 'QB' });
        } else if (rec.pos) {
          overall.push(rec);
        }
        // Position-less records left of the QB column are roster-tracker /
        // legend noise — dropped.
      }
    }
  }

  // Join overall ranks onto the QB/flex rows. (team, adp, value) is unique
  // in practice; last-name+team catches any adp collisions.
  const byKey = new Map<string, RawRecord>();
  for (const o of overall) byKey.set(`${o.team}|${o.adp}|${o.value}`, o);
  for (const arr of [doc.qbs, doc.flex]) {
    for (const p of arr) {
      const o = byKey.get(`${p.team}|${p.adp}|${p.value}`);
      if (o) {
        p.overallRank = o.rank;
        if (!p.position && o.pos) p.position = o.pos;
      }
    }
  }

  doc.qbs.sort((a, b) => a.rank - b.rank);
  doc.flex.sort((a, b) => a.rank - b.rank);
  return doc;
}

function toPlayer(rec: RawRecord): Omit<CheatsheetPlayer, 'position'> {
  return {
    rank: rec.rank, name: rec.name, team: rec.team, bye: rec.bye,
    adp: rec.adp, value: rec.value, rookie: rec.rookie, upside: rec.upside,
  };
}

/** Fill flex-row positions from a normalized-name → position lookup
 *  (built from sleeper-players / the projection pool). Sheet-carried
 *  positions (overall-list join) win. */
export function resolvePositions(doc: CheatsheetDoc, posByName: Map<string, string>): void {
  for (const p of doc.flex) {
    if (!p.position) p.position = posByName.get(normalizeCheatsheetName(p.name)) ?? '';
  }
}

// The sheet uses a few market names that differ from roster data.
const NAME_ALIASES: Record<string, string> = {
  'ken walker': 'kenneth walker',
  'hollywood brown': 'marquise brown',
};

export function normalizeCheatsheetName(name: string): string {
  const n = name
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // Estimé → Estime
    .toLowerCase().replace(/[.']/g, '')
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '')
    .replace(/\s+/g, ' ').trim();
  return NAME_ALIASES[n] ?? n;
}

// ── Persistence (in-browser import path) ──

const STORAGE_KEY = 'stathead-sfb16-cheatsheet';

export function saveCheatsheet(doc: CheatsheetDoc): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(doc)); } catch { /* quota */ }
}

export function loadStoredCheatsheet(): CheatsheetDoc | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const doc = JSON.parse(raw) as CheatsheetDoc;
    return Array.isArray(doc.qbs) && Array.isArray(doc.flex) ? doc : null;
  } catch {
    return null;
  }
}

export function clearStoredCheatsheet(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
