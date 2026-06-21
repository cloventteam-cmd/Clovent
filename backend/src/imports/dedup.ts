import { findContactByEmail, findContactByPhone, findContactByExternal } from '../db/repositories/contacts';
import type { UUID } from '../shared/types';

interface MatchResult {
  existingId: UUID;
  mergeStrategy: 'update' | 'skip' | 'merge';
  matchedOn: string;
  confidence: number;
}

export class DuplicateDetector {
  private tenantId: UUID;

  constructor(tenantId: UUID) {
    this.tenantId = tenantId;
  }

  async findMatch(data: Record<string, unknown>): Promise<MatchResult | null> {
    // 1. External ID match (strongest — same source)
    if (data.external_id && data.external_source) {
      const contact = await findContactByExternal(
        this.tenantId,
        String(data.external_source),
        String(data.external_id),
      );
      if (contact) {
        return { existingId: contact.id, mergeStrategy: 'update', matchedOn: 'external_id', confidence: 1.0 };
      }
    }

    // 2. Email match
    if (data.email) {
      const contact = await findContactByEmail(this.tenantId, String(data.email));
      if (contact) {
        return { existingId: contact.id, mergeStrategy: 'merge', matchedOn: 'email', confidence: 0.95 };
      }
    }

    // 3. Phone match
    if (data.phone) {
      const contact = await findContactByPhone(this.tenantId, String(data.phone));
      if (contact) {
        return { existingId: contact.id, mergeStrategy: 'merge', matchedOn: 'phone', confidence: 0.85 };
      }
    }

    // 4. Name + city fuzzy match (low confidence — skip unless configured)
    // Skipped for performance in batch import

    return null;
  }
}
