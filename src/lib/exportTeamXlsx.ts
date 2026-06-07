// Formatted XLSX export for the by-team projection view. ExcelJS is imported
// dynamically so its (sizeable) bundle is only fetched when a user actually
// exports. PPR and team totals are written as live formulas, so the sheet
// recomputes itself when the user edits stats offline.

export interface XlsxPlayer {
  pos: string;
  name: string;
  games: number;
  passAtt: number; passComp: number; passYds: number; passTD: number; int: number;
  rushAtt: number; rushYds: number; rushTD: number;
  tgt: number; rec: number; recYds: number; recTD: number;
}

export interface XlsxTeam {
  team: string;
  players: XlsxPlayer[];
}

const POS_ARGB: Record<string, string> = { QB: 'FF6366F1', RB: 'FF10B981', WR: 'FFF59E0B', TE: 'FFEF4444' };

export async function exportTeamXlsx(teams: XlsxTeam[], season: number): Promise<void> {
  const mod = await import('exceljs');
  const ExcelJS = (mod as unknown as { default?: typeof import('exceljs') }).default ?? mod;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Stat Head';
  wb.created = new Date();

  const ws = wb.addWorksheet('By Team', {
    views: [{ state: 'frozen', xSplit: 3, ySplit: 3 }],
  });

  const NCOL = 17;
  // A Team, B Pos, C Player, D Gm, E-I passing, J-L rushing, M-P receiving, Q PPR
  const widths = [5, 5, 22, 5, 7, 7, 9, 6, 6, 7, 9, 6, 6, 6, 9, 6, 8];
  ws.columns = widths.map((w) => ({ width: w }));
  // Right-align all numeric columns; integers with thousands separators.
  for (let c = 4; c <= NCOL; c++) {
    ws.getColumn(c).numFmt = '#,##0';
    ws.getColumn(c).alignment = { horizontal: 'right' };
  }

  const solid = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } });
  const HEADER_BG = 'FF1F2937';
  const ACCENT_BG = 'FF0E7C66';
  const TOTAL_BG = 'FF111827';

  // Row 1 — title banner
  ws.mergeCells(1, 1, 1, NCOL);
  const title = ws.getCell('A1');
  title.value = `Stat Head — By-Team Projections (${season})`;
  title.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  title.fill = solid(ACCENT_BG);
  title.alignment = { vertical: 'middle', horizontal: 'left' };
  ws.getRow(1).height = 24;

  // Row 2 — group headers (merged)
  const groups: [number, number, string, string][] = [
    [5, 9, 'PASSING', POS_ARGB.QB],
    [10, 12, 'RUSHING', POS_ARGB.RB],
    [13, 16, 'RECEIVING', POS_ARGB.WR],
  ];
  for (const [from, to, label, argb] of groups) {
    ws.mergeCells(2, from, 2, to);
    const c = ws.getCell(2, from);
    c.value = label;
    c.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    c.fill = solid(argb);
    c.alignment = { horizontal: 'center' };
  }
  ws.getCell(2, 17).fill = solid(HEADER_BG);

  // Row 3 — column headers
  const heads = ['Team', 'Pos', 'Player', 'Gm', 'Att', 'Cmp', 'Yds', 'TD', 'Int', 'Att', 'Yds', 'TD', 'Tgt', 'Rec', 'Yds', 'TD', 'PPR'];
  const hr = ws.getRow(3);
  heads.forEach((h, i) => {
    const c = hr.getCell(i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = solid(HEADER_BG);
    c.alignment = { horizontal: i < 3 ? 'left' : 'right' };
  });
  hr.height = 16;

  const L = (n: number) => ws.getColumn(n).letter;
  // value or blank (so irrelevant cells — e.g. a QB's receiving — stay empty)
  const v = (n: number) => (n ? n : null);

  let r = 4;
  for (const t of teams) {
    const start = r;
    for (const p of t.players) {
      const row = ws.getRow(r);
      row.getCell(1).value = t.team;
      const posCell = row.getCell(2);
      posCell.value = p.pos;
      posCell.font = { bold: true, color: { argb: POS_ARGB[p.pos] ?? 'FFCCCCCC' } };
      row.getCell(3).value = p.name;
      row.getCell(4).value = p.games;
      row.getCell(5).value = v(p.passAtt);
      row.getCell(6).value = v(p.passComp);
      row.getCell(7).value = v(p.passYds);
      row.getCell(8).value = v(p.passTD);
      row.getCell(9).value = v(p.int);
      row.getCell(10).value = v(p.rushAtt);
      row.getCell(11).value = v(p.rushYds);
      row.getCell(12).value = v(p.rushTD);
      row.getCell(13).value = v(p.tgt);
      row.getCell(14).value = v(p.rec);
      row.getCell(15).value = v(p.recYds);
      row.getCell(16).value = v(p.recTD);
      // Live PPR: PassYds*.04 + PassTD*4 + Int*-2 + RushYds*.1 + RushTD*6 + Rec + RecYds*.1 + RecTD*6
      row.getCell(17).value = {
        formula: `G${r}*0.04+H${r}*4+I${r}*-2+K${r}*0.1+L${r}*6+N${r}+O${r}*0.1+P${r}*6`,
      };
      row.getCell(17).font = { bold: true };
      r++;
    }
    const end = r - 1;
    // Team total row with SUM formulas (updates if the user edits stats)
    const tot = ws.getRow(r);
    tot.getCell(3).value = `${t.team} Total`;
    for (let c = 5; c <= NCOL; c++) {
      tot.getCell(c).value = { formula: `SUM(${L(c)}${start}:${L(c)}${end})` };
    }
    for (let c = 1; c <= NCOL; c++) {
      const cell = tot.getCell(c);
      cell.font = { bold: true, color: { argb: 'FFE5E7EB' } };
      cell.fill = solid(TOTAL_BG);
      cell.border = { top: { style: 'thin', color: { argb: 'FF374151' } } };
    }
    r++;
  }

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  a.href = url;
  a.download = `stathead-by-team-${season}-${stamp.getFullYear()}${p2(stamp.getMonth() + 1)}${p2(stamp.getDate())}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
