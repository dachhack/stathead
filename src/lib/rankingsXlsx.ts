// XLSX export + import for My Rankings boards. One template, both directions:
// export writes the user's board (order, locks, projections) into a styled
// workbook; import reads the same workbook — header-matched, so columns can
// be reordered or dropped in Excel — and returns the board for re-creation
// on another device. The Proj PPG column is round-trippable: edited values
// come back as per-player projection overrides. ExcelJS is imported
// dynamically so its bundle only loads on use (same as exportTeamXlsx).

export const RANKINGS_TEMPLATE = 'stathead-rankings-v1';

export interface RankingsXlsxRow {
  rank: number;
  name: string;
  position: string;
  team: string;
  ppg: number;
  adp: number;
  boomZ: number;
  bustZ: number;
  projTgtShare: number;  // 0-1
  projRushShare: number; // 0-1
  priorPPG: number;
  isRookie: boolean;
  isLocked: boolean;
}

export interface RankingsXlsxMeta {
  boardName: string;
  scoring: 'ppr' | 'half' | 'standard';
  season: number;
  scenarioName?: string;
}

const POS_ARGB: Record<string, string> = { QB: 'FF6366F1', RB: 'FF10B981', WR: 'FFF59E0B', TE: 'FFEF4444' };
const HEADER_BG = 'FF1F2937';
const BANNER_BG = 'FF0E7C66';

const HEADERS = [
  'Rank', 'Player', 'Pos', 'Team', 'Proj PPG', 'ADP', 'Boom z', 'Bust z',
  'Tgt %', 'Rush %', 'Prior PPG', 'Rookie', 'Locked',
] as const;

async function loadExcelJS() {
  const mod = await import('exceljs');
  return (mod as unknown as { default?: typeof import('exceljs') }).default ?? mod;
}

export async function exportRankingsXlsx(rows: RankingsXlsxRow[], meta: RankingsXlsxMeta): Promise<void> {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Stat Head';
  wb.created = new Date();

  const solid = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } });

  // ── Rankings sheet ──
  const ws = wb.addWorksheet('Rankings', { views: [{ state: 'frozen', ySplit: 2 }] });
  ws.columns = [
    { width: 6 }, { width: 24 }, { width: 5 }, { width: 6 }, { width: 9 }, { width: 7 },
    { width: 7 }, { width: 7 }, { width: 7 }, { width: 7 }, { width: 9 }, { width: 7 }, { width: 7 },
  ];

  ws.mergeCells(1, 1, 1, HEADERS.length);
  const title = ws.getCell('A1');
  title.value = `Stat Head — ${meta.boardName} (${meta.season} · ${meta.scoring.toUpperCase()}${meta.scenarioName ? ` · ${meta.scenarioName}` : ''})`;
  title.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  title.fill = solid(BANNER_BG);
  title.alignment = { vertical: 'middle', horizontal: 'left' };
  ws.getRow(1).height = 22;

  const headRow = ws.getRow(2);
  HEADERS.forEach((h, i) => {
    const c = headRow.getCell(i + 1);
    c.value = h;
    c.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
    c.fill = solid(HEADER_BG);
    c.alignment = { horizontal: i === 1 ? 'left' : i <= 3 ? 'center' : 'right' };
  });
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: HEADERS.length } };

  for (const p of rows) {
    const row = ws.addRow([
      p.rank,
      p.name,
      p.position,
      p.team || '',
      p.ppg > 0 ? Math.round(p.ppg * 10) / 10 : null,
      p.adp < 999 ? Math.round(p.adp * 10) / 10 : null,
      p.boomZ || null,
      p.bustZ || null,
      p.projTgtShare > 0 ? p.projTgtShare : null,
      p.projRushShare > 0 ? p.projRushShare : null,
      p.priorPPG > 0 ? Math.round(p.priorPPG * 10) / 10 : null,
      p.isRookie ? 'Y' : null,
      p.isLocked ? 'Y' : null,
    ]);
    row.getCell(1).alignment = { horizontal: 'center' };
    const pos = row.getCell(3);
    pos.alignment = { horizontal: 'center' };
    pos.font = { bold: true, color: { argb: POS_ARGB[p.position] ?? 'FFCCCCCC' } };
    row.getCell(4).alignment = { horizontal: 'center' };
    for (const c of [5, 6, 11]) row.getCell(c).numFmt = '0.0';
    for (const c of [7, 8]) row.getCell(c).numFmt = '+0.00;-0.00';
    for (const c of [9, 10]) row.getCell(c).numFmt = '0%';
    for (const c of [12, 13]) row.getCell(c).alignment = { horizontal: 'center' };
  }

  // ── Meta sheet (read back on import; humans get the how-to) ──
  const wm = wb.addWorksheet('Meta');
  wm.columns = [{ width: 16 }, { width: 50 }];
  const metaRows: Array<[string, string]> = [
    ['Template', RANKINGS_TEMPLATE],
    ['Board Name', meta.boardName],
    ['Scoring', meta.scoring],
    ['Season', String(meta.season)],
    ['Scenario', meta.scenarioName ?? ''],
    ['Exported', new Date().toISOString()],
  ];
  for (const [k, v] of metaRows) {
    const row = wm.addRow([k, v]);
    row.getCell(1).font = { bold: true };
  }
  wm.addRow([]);
  wm.addRow(['How to use', 'Import this file on the My Rankings tab to recreate the board (order, locks, name).']);
  wm.addRow(['', 'Reorder rows or edit Rank to change the board; edit Proj PPG to set custom projections']);
  wm.addRow(['', '(PPR boards only — edited PPG values import as a projection scenario).']);

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const slug = meta.boardName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'rankings';
  a.href = url;
  a.download = `stathead-rankings-${slug}-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Import ──

export interface ImportedRankingRow {
  rank: number;
  name: string;
  position: string;
  /** Proj PPG from the sheet; null when the cell is blank. */
  ppg: number | null;
  locked: boolean;
}

export interface ImportedRankings {
  boardName?: string;
  scoring?: 'ppr' | 'half' | 'standard';
  scenarioName?: string;
  rows: ImportedRankingRow[];
}

type AnyCell = { value: unknown; text: string };
type AnyRow = { getCell(i: number): AnyCell; cellCount: number };
type AnyWorksheet = {
  name: string;
  rowCount: number;
  getRow(i: number): AnyRow;
};

function cellText(c: AnyCell | undefined): string {
  return (c?.text ?? '').trim();
}

function cellNum(c: AnyCell | undefined): number | null {
  if (!c) return null;
  const v = c.value;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v && typeof v === 'object' && 'result' in (v as Record<string, unknown>)) {
    const r = Number((v as { result?: unknown }).result);
    return Number.isFinite(r) ? r : null;
  }
  const n = Number(cellText(c));
  return Number.isFinite(n) && cellText(c) !== '' ? n : null;
}

function cellBool(c: AnyCell | undefined): boolean {
  const t = cellText(c).toLowerCase();
  return t === 'y' || t === 'yes' || t === 'true' || t === '1' || t === 'locked' || t === '🔒';
}

const VALID_POS = new Set(['QB', 'RB', 'WR', 'TE']);

/** Parse a rankings workbook (the export template, possibly edited). Throws
 *  with a user-facing message when no usable rankings sheet is found. */
export async function importRankingsXlsx(data: ArrayBuffer): Promise<ImportedRankings> {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);

  // Meta sheet (optional — files edited or built by hand may drop it).
  const out: ImportedRankings = { rows: [] };
  const metaWs = wb.worksheets.find((w) => w.name.toLowerCase() === 'meta') as AnyWorksheet | undefined;
  if (metaWs) {
    for (let i = 1; i <= Math.min(metaWs.rowCount, 20); i++) {
      const row = metaWs.getRow(i);
      const key = cellText(row.getCell(1)).toLowerCase();
      const val = cellText(row.getCell(2));
      if (key === 'board name' && val) out.boardName = val;
      if (key === 'scenario' && val) out.scenarioName = val;
      if (key === 'scoring' && ['ppr', 'half', 'standard'].includes(val.toLowerCase())) {
        out.scoring = val.toLowerCase() as ImportedRankings['scoring'];
      }
    }
  }

  // Rankings sheet: prefer one named like "rank", else the first non-Meta
  // sheet. The header row is located by content, not position, so a banner
  // row (or none) above it is fine.
  const ws = (wb.worksheets.find((w) => /rank/i.test(w.name))
    ?? wb.worksheets.find((w) => w.name.toLowerCase() !== 'meta')) as AnyWorksheet | undefined;
  if (!ws) throw new Error('No rankings worksheet found in the file.');

  let headerRowIdx = 0;
  const colFor: Record<string, number> = {};
  for (let i = 1; i <= Math.min(ws.rowCount, 10) && !headerRowIdx; i++) {
    const row = ws.getRow(i);
    const cols: Record<string, number> = {};
    for (let c = 1; c <= Math.max(row.cellCount, HEADERS.length); c++) {
      const t = cellText(row.getCell(c)).toLowerCase();
      if (!t) continue;
      if (t === 'rank' || t === '#') cols.rank = c;
      else if (t === 'player' || t === 'name') cols.name = c;
      else if (t === 'pos' || t === 'position') cols.pos = c;
      else if (t === 'proj ppg' || t === 'ppg' || t === 'points' || t === 'proj') cols.ppg = c;
      else if (t === 'locked' || t === 'lock') cols.locked = c;
    }
    if (cols.name && cols.pos) {
      headerRowIdx = i;
      Object.assign(colFor, cols);
    }
  }
  if (!headerRowIdx) {
    throw new Error('No header row with "Player" and "Pos" columns found — is this a Stat Head rankings export?');
  }

  for (let i = headerRowIdx + 1; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    const name = cellText(row.getCell(colFor.name));
    const pos = cellText(row.getCell(colFor.pos)).toUpperCase();
    if (!name || !VALID_POS.has(pos)) continue;
    out.rows.push({
      rank: (colFor.rank ? cellNum(row.getCell(colFor.rank)) : null) ?? out.rows.length + 1,
      name,
      position: pos,
      ppg: colFor.ppg ? cellNum(row.getCell(colFor.ppg)) : null,
      locked: colFor.locked ? cellBool(row.getCell(colFor.locked)) : false,
    });
  }
  if (out.rows.length === 0) throw new Error('The rankings sheet has no player rows.');

  // Respect an edited Rank column (stable for ties / blanks).
  out.rows = out.rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.rank - b.r.rank) || (a.i - b.i))
    .map((x) => x.r);

  return out;
}
