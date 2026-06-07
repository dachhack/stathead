// Formatted XLSX export for the by-team projection view, laid out to mirror the
// on-screen cards: a per-team banner, grouped Passing/Rushing/Receiving headers,
// position subtotals, a team total, and the projected-team reference row.
// ExcelJS is imported dynamically so its bundle only loads on export. Per-player
// PPR and all subtotals/totals are live formulas, and a zero-hiding number
// format renders empty cells instead of 0s — so the sheet stays clean and
// recomputes itself when edited offline.

export interface XlsxPlayer {
  name: string;
  games: number;
  passAtt: number; passComp: number; passYds: number; passTD: number; int: number;
  rushAtt: number; rushYds: number; rushTD: number;
  tgt: number; rec: number; recYds: number; recTD: number;
}

export interface XlsxProjTotal {
  passAtt: number; passComp: number; passYds: number; passTD: number; int: number;
  rushAtt: number; rushYds: number; rushTD: number;
  tgt: number; rec: number; recYds: number; recTD: number;
}

export interface XlsxTeam {
  team: string;
  ppr: number;
  groups: { pos: string; players: XlsxPlayer[] }[]; // ordered QB, RB, WR, TE
  proj?: XlsxProjTotal;
}

const POS_ARGB: Record<string, string> = { QB: 'FF6366F1', RB: 'FF10B981', WR: 'FFF59E0B', TE: 'FFEF4444' };
const HEADER_BG = 'FF1F2937';
const BANNER_BG = 'FF0E7C66';
const SUBTOTAL_BG = 'FF1A2230';
const TOTAL_BG = 'FF111827';
const ZERO_HIDE = '#,##0;-#,##0;'; // positive ; negative ; (blank for zero)

// Column layout (A..P) — matches the webpage table (no Team column; the team is
// the banner). 1 Pos, 2 Player, 3 Gm, 4-8 Passing, 9-11 Rushing, 12-15
// Receiving, 16 Pts.
const NCOL = 16;
// Stat-field → column index, for writing player rows.
const FIELD_COL: [keyof XlsxPlayer, number][] = [
  ['games', 3], ['passAtt', 4], ['passComp', 5], ['passYds', 6], ['passTD', 7], ['int', 8],
  ['rushAtt', 9], ['rushYds', 10], ['rushTD', 11], ['tgt', 12], ['rec', 13], ['recYds', 14], ['recTD', 15],
];

export async function exportTeamXlsx(teams: XlsxTeam[], season: number): Promise<void> {
  const mod = await import('exceljs');
  const ExcelJS = (mod as unknown as { default?: typeof import('exceljs') }).default ?? mod;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Stat Head';
  wb.created = new Date();
  const ws = wb.addWorksheet('By Team', { views: [{ state: 'frozen', ySplit: 1 }] });

  const widths = [4, 22, 5, 7, 7, 9, 6, 6, 7, 9, 6, 6, 6, 9, 6, 8];
  ws.columns = widths.map((w) => ({ width: w }));
  for (let c = 3; c <= NCOL; c++) {
    ws.getColumn(c).numFmt = ZERO_HIDE;
    ws.getColumn(c).alignment = { horizontal: 'right' };
  }
  ws.getColumn(1).alignment = { horizontal: 'center' };

  const solid = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } });
  const C = (n: number) => ws.getColumn(n).letter;
  const blankZero = (n: number) => (n ? n : null);

  // Row 1 — title banner (frozen)
  ws.mergeCells(1, 1, 1, NCOL);
  const title = ws.getCell('A1');
  title.value = `Stat Head — By-Team Projections (${season})`;
  title.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  title.fill = solid(BANNER_BG);
  title.alignment = { vertical: 'middle', horizontal: 'left' };
  ws.getRow(1).height = 24;

  let r = 3; // leave row 2 as a spacer under the frozen title

  const writeGroupHeader = () => {
    const groups: [number, number, string, string][] = [
      [4, 8, 'PASSING', POS_ARGB.QB], [9, 11, 'RUSHING', POS_ARGB.RB], [12, 15, 'RECEIVING', POS_ARGB.WR],
    ];
    for (const [from, to, label, argb] of groups) {
      ws.mergeCells(r, from, r, to);
      const c = ws.getCell(r, from);
      c.value = label;
      c.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
      c.fill = solid(argb);
      c.alignment = { horizontal: 'center' };
    }
    ws.getCell(r, 16).fill = solid(HEADER_BG);
    r++;
  };
  const writeColHeader = () => {
    const heads = ['Pos', 'Player', 'Gm', 'Att', 'Cmp', 'Yds', 'TD', 'Int', 'Att', 'Yds', 'TD', 'Tgt', 'Rec', 'Yds', 'TD', 'Pts'];
    const row = ws.getRow(r);
    heads.forEach((h, i) => {
      const c = row.getCell(i + 1);
      c.value = h;
      c.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
      c.fill = solid(HEADER_BG);
      c.alignment = { horizontal: i < 2 ? 'left' : (i === 1 ? 'left' : 'right') };
    });
    r++;
  };

  teams.forEach((t, ti) => {
    // Team banner
    ws.mergeCells(r, 1, r, 12);
    const name = ws.getCell(r, 1);
    name.value = `#${ti + 1}  ${t.team}`;
    name.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
    name.alignment = { horizontal: 'left', vertical: 'middle' };
    ws.mergeCells(r, 13, r, 15);
    const lbl = ws.getCell(r, 13);
    lbl.value = 'TOTAL PPR';
    lbl.font = { bold: true, size: 9, color: { argb: 'FF9CA3AF' } };
    lbl.alignment = { horizontal: 'right', vertical: 'middle' };
    const pprCell = ws.getCell(r, 16);
    pprCell.value = Math.round(t.ppr);
    pprCell.font = { bold: true, size: 12, color: { argb: 'FFF59E0B' } };
    pprCell.numFmt = '#,##0';
    pprCell.alignment = { horizontal: 'right' };
    for (let c = 1; c <= NCOL; c++) ws.getCell(r, c).fill = solid(BANNER_BG);
    ws.getRow(r).height = 20;
    r++;

    writeGroupHeader();
    writeColHeader();

    const subtotalRows: number[] = [];
    for (const g of t.groups) {
      if (!g.players.length) continue;
      const argb = POS_ARGB[g.pos] ?? 'FFCCCCCC';
      const gStart = r;
      for (const p of g.players) {
        const row = ws.getRow(r);
        const posCell = row.getCell(1);
        posCell.value = g.pos;
        posCell.font = { bold: true, color: { argb } };
        row.getCell(2).value = p.name;
        for (const [field, col] of FIELD_COL) row.getCell(col).value = blankZero(p[field] as number);
        row.getCell(16).value = {
          formula: `F${r}*0.04+G${r}*4+H${r}*-2+J${r}*0.1+K${r}*6+M${r}+N${r}*0.1+O${r}*6`,
        };
        row.getCell(16).font = { bold: true };
        r++;
      }
      const gEnd = r - 1;
      // Position subtotal
      const sub = ws.getRow(r);
      ws.mergeCells(r, 1, r, 2);
      const slbl = sub.getCell(1);
      slbl.value = `${g.pos} Total`;
      slbl.font = { bold: true, color: { argb } };
      slbl.alignment = { horizontal: 'left' };
      for (let c = 4; c <= NCOL; c++) sub.getCell(c).value = { formula: `SUM(${C(c)}${gStart}:${C(c)}${gEnd})` };
      for (let c = 1; c <= NCOL; c++) {
        const cell = sub.getCell(c);
        if (c !== 1) cell.font = { bold: true, color: { argb: 'FFD1D5DB' } };
        cell.fill = solid(SUBTOTAL_BG);
      }
      subtotalRows.push(r);
      r++;
    }

    // Team total = sum of position subtotal rows
    if (subtotalRows.length) {
      const tot = ws.getRow(r);
      ws.mergeCells(r, 1, r, 2);
      tot.getCell(1).value = 'Total';
      for (let c = 4; c <= NCOL; c++) {
        tot.getCell(c).value = { formula: subtotalRows.map((sr) => `${C(c)}${sr}`).join('+') };
      }
      for (let c = 1; c <= NCOL; c++) {
        const cell = tot.getCell(c);
        cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
        cell.fill = solid(TOTAL_BG);
        cell.border = { top: { style: 'thin', color: { argb: 'FF4B5563' } } };
      }
      r++;
    }

    // Projected-team reference row (model totals, muted)
    if (t.proj) {
      const pr = ws.getRow(r);
      ws.mergeCells(r, 1, r, 2);
      pr.getCell(1).value = 'Proj. Team';
      const pv: [number, number][] = [
        [4, t.proj.passAtt], [5, t.proj.passComp], [6, t.proj.passYds], [7, t.proj.passTD], [8, t.proj.int],
        [9, t.proj.rushAtt], [10, t.proj.rushYds], [11, t.proj.rushTD],
        [12, t.proj.tgt], [13, t.proj.rec], [14, t.proj.recYds], [15, t.proj.recTD],
      ];
      for (const [c, val] of pv) pr.getCell(c).value = blankZero(Math.round(val));
      for (let c = 1; c <= NCOL; c++) {
        pr.getCell(c).font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };
      }
      r++;
    }

    r++; // spacer row between teams
  });

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  a.href = url;
  a.download = `stathead-by-team-${season}-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
