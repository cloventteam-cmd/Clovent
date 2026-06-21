import { queryMany } from '../../db/client';
import type { UUID, SegmentRule } from '../../shared/types';

// ─── Contact Segmentation Engine ─────────────────────────────────────────────
// Evaluates segment_rules from campaigns against contacts in the database.

export class SegmentationEngine {
  private tenantId: UUID;

  constructor(tenantId: UUID) {
    this.tenantId = tenantId;
  }

  async evaluateContacts(rules: SegmentRule[]): Promise<UUID[]> {
    if (rules.length === 0) return [];

    const { where, params } = this.buildWhereClause(rules);

    const contacts = await queryMany<{ id: UUID }>(
      `SELECT id FROM contacts
       WHERE tenant_id = $1 AND status = 'active' ${where ? `AND ${where}` : ''}`,
      [this.tenantId, ...params],
    );

    return contacts.map(c => c.id);
  }

  private buildWhereClause(rules: SegmentRule[]): { where: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 2;

    for (const rule of rules) {
      const col = this.sanitizeColumn(rule.field);
      if (!col) continue;

      switch (rule.operator) {
        case 'eq':
          conditions.push(`${col} = $${idx++}`);
          params.push(rule.value);
          break;
        case 'neq':
          conditions.push(`${col} != $${idx++}`);
          params.push(rule.value);
          break;
        case 'gt':
          conditions.push(`${col} > $${idx++}`);
          params.push(rule.value);
          break;
        case 'lt':
          conditions.push(`${col} < $${idx++}`);
          params.push(rule.value);
          break;
        case 'gte':
          conditions.push(`${col} >= $${idx++}`);
          params.push(rule.value);
          break;
        case 'lte':
          conditions.push(`${col} <= $${idx++}`);
          params.push(rule.value);
          break;
        case 'contains':
          if (col === 'tags') {
            conditions.push(`$${idx++} = ANY(tags)`);
          } else {
            conditions.push(`${col} ILIKE $${idx++}`);
            params.push(`%${rule.value}%`);
            continue;
          }
          params.push(rule.value);
          break;
        case 'in':
          conditions.push(`${col} = ANY($${idx++}::text[])`);
          params.push(Array.isArray(rule.value) ? rule.value : [rule.value]);
          break;
        case 'not_in':
          conditions.push(`NOT (${col} = ANY($${idx++}::text[]))`);
          params.push(Array.isArray(rule.value) ? rule.value : [rule.value]);
          break;
      }
    }

    return { where: conditions.join(' AND '), params };
  }

  private sanitizeColumn(field: string): string | null {
    const allowed = [
      'type', 'status', 'source', 'city', 'state', 'zip',
      'tags', 'buyer_probability', 'seller_probability',
      'engagement_score', 'relationship_health', 'referral_probability',
      'last_contacted_at', 'created_at',
    ];
    return allowed.includes(field) ? field : null;
  }
}
