// kvCORE exports
export function normalizeKvCoreRows(rows: Record<string, string>[]): Record<string, string>[] {
  return rows.map(row => {
    const out: Record<string, string> = { ...row };

    // kvCORE lead types
    const leadTypeMap: Record<string, string> = {
      buyer: 'lead',
      seller: 'lead',
      'buyer/seller': 'lead',
      renter: 'lead',
      investor: 'investor',
      agent: 'referral_partner',
    };

    if (row['lead_type']) {
      out.type = leadTypeMap[row['lead_type'].toLowerCase()] ?? 'lead';
    }

    // kvCORE uses lead_id
    if (row['lead_id']) out.external_id = row['lead_id'];

    // Combine tags from multiple tag fields
    const tagFields = ['tags', 'smart_number_tags', 'pipeline_tags'];
    const allTags = tagFields
      .flatMap(f => (row[f] ?? '').split(','))
      .map(t => t.trim())
      .filter(Boolean);
    if (allTags.length > 0) out.tags = allTags.join(',');

    return out;
  });
}
