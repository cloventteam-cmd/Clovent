import { parse } from 'csv-parse';
import { createReadStream } from 'fs';
import type { ImportSourceType } from '../../shared/types';
import { FieldMapper } from '../field-mapper';

export interface ParseResult {
  headers: string[];
  rows: Record<string, string>[];
  total: number;
}

export async function parseCsv(filePath: string): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    const rows: Record<string, string>[] = [];
    let headers: string[] = [];

    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
    });

    parser.on('readable', () => {
      let record: Record<string, string>;
      while ((record = parser.read()) !== null) {
        if (headers.length === 0) headers = Object.keys(record);
        rows.push(record);
      }
    });

    parser.on('error', reject);
    parser.on('end', () => resolve({ headers, rows, total: rows.length }));

    createReadStream(filePath).pipe(parser);
  });
}

export async function detectCsvMapping(
  filePath: string,
  sourceType: ImportSourceType,
): Promise<{ headers: string[]; mapping: ReturnType<typeof FieldMapper.detectMapping>; sample: Record<string, string>[] }> {
  const { headers, rows } = await parseCsv(filePath);
  const mapping = FieldMapper.detectMapping(headers, sourceType);
  return { headers, mapping, sample: rows.slice(0, 5) };
}
