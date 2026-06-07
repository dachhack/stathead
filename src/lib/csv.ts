// Small CSV helpers shared across export buttons. CSV opens directly in Excel /
// Google Sheets, so "Export to Excel" produces a .csv with a UTF-8 BOM.

/** RFC-4180 CSV encoder. Quotes any field containing `,`, `"`, or a line break;
 *  escapes embedded quotes by doubling. CRLF line endings for Excel. */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: string[] = [columns.map(escape).join(',')];
  for (const r of rows) lines.push(columns.map((c) => escape(r[c])).join(','));
  return lines.join('\r\n');
}

export function csvTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Build a CSV and trigger a browser download. The leading BOM stops Excel from
 *  mis-detecting non-ASCII names (apostrophes, accents) as Windows-1252. */
export function downloadCsv(filename: string, columns: string[], rows: Record<string, unknown>[]): void {
  const blob = new Blob(['﻿' + toCsv(columns, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
