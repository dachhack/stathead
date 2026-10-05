// FantasyPros ADP pages (NBA, NHL, MLB). The page is HTML; the table has a
// header row of source columns (Yahoo, ESPN, CBS, RTS, NFBC, FT) and an AVG.
// We take the per-source columns as separate markets and never serve the
// page's own AVG or rank (third-party policy). Rows have no closing </tr>.

import { fetchText, nowIso, textOf } from '../util.js';
import type { AdpSource } from '../types.js';

export type FpSport = 'nba' | 'nhl' | 'mlb';

export interface FpRow {
  name: string;
  slug: string | null;
  fp_id: string | null;
  team: string | null;
  pos: string | null;
  bySource: Record<string, number>;
}

export function parseAdpPage(html: string): { columns: string[]; rows: FpRow[] } {
  const table = /<table[^>]*id="data"[^>]*>([\s\S]*?)<\/table>/.exec(html)?.[1];
  if (!table) throw new Error('FantasyPros: no table#data on page');
  const thead = /<thead>([\s\S]*?)<\/thead>/.exec(table)?.[1] ?? '';
  const columns = [...thead.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => textOf(m[1]));
  const tbody = /<tbody>([\s\S]*)/.exec(table)?.[1] ?? '';
  const rows: FpRow[] = [];
  for (const chunk of tbody.split(/<tr\b[^>]*>/).slice(1)) {
    const cells = [...chunk.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length < 3) continue;
    const labelIdx = cells.findIndex((c) => /player-name/.test(c));
    if (labelIdx < 0) continue;
    const label = cells[labelIdx];
    const anchor = /<a([^>]*)>([\s\S]*?)<\/a>/.exec(label);
    if (!anchor) continue;
    const attrs = anchor[1];
    let name = /fp-player-name="([^"]*)"/.exec(attrs)?.[1] ?? textOf(anchor[2]);
    name = name.replace(/\s*\((Batter|Pitcher|Hitter)\)\s*$/i, '').trim();
    const slug = /href="([^"]*)"/.exec(attrs)?.[1] ?? null;
    const fp_id = /fp-id-(\d+)/.exec(attrs)?.[1] ?? null;
    const small = textOf(label.replace(anchor[0], '').replace(/<small class="dl[\s\S]*?<\/small>/g, ''));
    let team: string | null = null;
    let pos: string | null = null;
    const paren = /\(\s*([A-Z]{2,4})\s*-\s*([A-Z0-9,/ ]+)\)/.exec(small);
    if (paren) {
      team = paren[1];
      pos = paren[2].replace(/\s+/g, '');
    } else {
      const t = /\b([A-Z]{2,4})\b/.exec(small);
      team = t ? t[1] : null;
    }
    const bySource: Record<string, number> = {};
    for (let i = 0; i < cells.length; i++) {
      if (i === labelIdx) continue;
      const col = columns[i];
      if (!col || col === 'Rank' || col === 'AVG') continue;
      const txt = textOf(cells[i]);
      if (col === 'POS') {
        if (!pos && txt) pos = txt.replace(/\d+$/, '');
        continue;
      }
      const v = Number(txt.replace(/,/g, ''));
      if (txt && Number.isFinite(v) && v > 0) bySource[col] = v;
    }
    rows.push({ name, slug, fp_id, team, pos, bySource });
  }
  return { columns, rows };
}

/** FantasyPros team codes that differ from the league's official tricodes. */
export const FP_TEAM_ALIASES: Record<FpSport, Record<string, string>> = {
  nba: { GS: 'GSW', NO: 'NOP', NY: 'NYK', SA: 'SAS', UTAH: 'UTA', WSH: 'WAS', PHO: 'PHX' },
  nhl: { NJ: 'NJD', SJ: 'SJS', TB: 'TBL', LA: 'LAK', WAS: 'WSH', MON: 'MTL', CLS: 'CBJ', UTAH: 'UTA' },
  mlb: { CHW: 'CWS', ARI: 'AZ', OAK: 'ATH', WAS: 'WSH', SFG: 'SF', SDP: 'SD', TBR: 'TB', KCR: 'KC' },
};

/** One AdpSource per market column on the page. */
export async function adpSources(sport: FpSport): Promise<AdpSource[]> {
  const html = await fetchText(`https://www.fantasypros.com/${sport}/adp/overall.php`);
  const { rows } = parseAdpPage(html);
  const as_of = nowIso();
  const byProvider = new Map<string, AdpSource>();
  for (const r of rows) {
    for (const [col, adp] of Object.entries(r.bySource)) {
      const provider = `fantasypros:${col.toLowerCase()}`;
      let src = byProvider.get(provider);
      if (!src) byProvider.set(provider, (src = { provider, as_of, rows: [] }));
      const team = r.team ? FP_TEAM_ALIASES[sport][r.team] ?? r.team : null;
      src.rows.push({ name: r.name, team, pos: r.pos, adp, ref: r.slug ?? undefined });
    }
  }
  return [...byProvider.values()];
}
