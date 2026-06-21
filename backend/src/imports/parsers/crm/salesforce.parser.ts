import { CRM_FIELD_MAPS } from '../../../shared/constants';
import type { ParseResult } from '../csv.parser';

// Salesforce exports are CSV with SF-specific field names
export function normalizeSalesforceRows(rows: Record<string, string>[]): Record<string, string>[] {
  return rows.map(row => {
    const normalized: Record<string, string> = {};
    for (const [sfField, targetField] of Object.entries(CRM_FIELD_MAPS.salesforce)) {
      if (row[sfField] !== undefined) normalized[sfField] = row[sfField];
    }
    // Pass through all other fields too
    return { ...row, ...normalized };
  });
}

export function extractSalesforceExternalId(row: Record<string, string>): string | undefined {
  return row['Id'] || row['Contact ID'] || row['Lead ID'] || undefined;
}
