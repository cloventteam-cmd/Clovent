import type { ParseResult } from '../csv.parser';

// HubSpot exports use lowercase field names with hs_ prefixes
export function normalizeHubSpotRows(rows: Record<string, string>[]): Record<string, string>[] {
  return rows.map(row => {
    const out: Record<string, string> = { ...row };
    // HubSpot lifecycle stages → our types
    const lifecycleMap: Record<string, string> = {
      lead: 'lead',
      marketingqualifiedlead: 'lead',
      salesqualifiedlead: 'lead',
      opportunity: 'lead',
      customer: 'client',
      evangelist: 'client',
      other: 'lead',
    };
    if (row.lifecyclestage) {
      out.type = lifecycleMap[row.lifecyclestage.toLowerCase()] ?? 'lead';
    }
    // Extract HubSpot record ID as external_id
    if (row['Record ID'] || row['hs_object_id']) {
      out.external_id = row['Record ID'] || row['hs_object_id'];
    }
    return out;
  });
}
