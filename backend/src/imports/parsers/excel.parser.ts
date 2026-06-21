import ExcelJS from 'exceljs';
import type { ParseResult } from './csv.parser';

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().split('T')[0];
  if (typeof value === 'object') {
    // RichText, Hyperlink, Formula results, etc.
    const v = value as unknown as Record<string, unknown>;
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    if (v.richText !== undefined) {
      const parts = (v.richText as Array<{ text?: unknown }>);
      return parts.map(p => String(p.text ?? '')).join('');
    }
    return '';
  }
  return String(value).trim();
}

export async function parseExcel(filePath: string, sheetIndex = 0): Promise<ParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const worksheet = workbook.worksheets[sheetIndex];
  if (!worksheet) throw new Error('No worksheet found at index ' + sheetIndex);

  const rows: Record<string, string>[] = [];
  let headers: string[] = [];

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cellValues = row.values as ExcelJS.CellValue[];

    if (rowNumber === 1) {
      headers = cellValues.slice(1).map(v => cellToString(v).trim());
      return;
    }

    const record: Record<string, string> = {};
    cellValues.slice(1).forEach((cell, idx) => {
      if (headers[idx]) {
        record[headers[idx]] = cellToString(cell);
      }
    });

    if (Object.values(record).some(v => v !== '')) {
      rows.push(record);
    }
  });

  return { headers, rows, total: rows.length };
}

export async function getSheetNames(filePath: string): Promise<string[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return workbook.worksheets.map(ws => ws.name);
}
