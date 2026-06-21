// Follow Up Boss exports — people export format
export function normalizeFubRows(rows: Record<string, string>[]): Record<string, string>[] {
  return rows.map(row => {
    const out: Record<string, string> = { ...row };

    // FUB stages → our types
    const stageMap: Record<string, string> = {
      'New': 'lead',
      'Attempted Contact': 'lead',
      'Active Buyer': 'lead',
      'Active Seller': 'lead',
      'Under Contract': 'client',
      'Closed': 'past_client',
      'Cold': 'inactive',
      'Nurture': 'lead',
    };

    if (row['Stage']) {
      out.type = stageMap[row['Stage']] ?? 'lead';
      out.status = row['Stage'] === 'Cold' ? 'inactive' : 'active';
    }

    // Map FUB tags
    if (row['Tags']) out.tags = row['Tags'];

    // FUB Person ID
    if (row['Person ID']) out.external_id = row['Person ID'];

    return out;
  });
}
