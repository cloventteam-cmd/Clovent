import { findContactById, updateContact } from '../db/repositories/contacts';
import type { Contact, UUID } from '../shared/types';

export class EntityMerger {
  private tenantId: UUID;

  constructor(tenantId: UUID) {
    this.tenantId = tenantId;
  }

  async merge(
    existingId: UUID,
    incomingData: Record<string, unknown>,
    strategy: 'update' | 'merge',
  ): Promise<Contact> {
    const existing = await findContactById(this.tenantId, existingId);
    if (!existing) throw new Error(`Contact ${existingId} not found for merge`);

    let updates: Partial<Contact>;

    if (strategy === 'update') {
      // Overwrite all incoming fields
      updates = incomingData as Partial<Contact>;
    } else {
      // Merge strategy: only fill in missing/empty fields from incoming
      updates = {};
      const fillableFields: (keyof Contact)[] = [
        'phone', 'phone_alt', 'email', 'city', 'state', 'zip',
        'source', 'tags', 'birthday', 'anniversary',
      ] as any;

      for (const field of fillableFields) {
        const existingVal = existing[field];
        const incomingVal = (incomingData as any)[field];

        if (!existingVal && incomingVal) {
          (updates as any)[field] = incomingVal;
        }

        // Merge tags array
        if (field === 'tags' && incomingVal) {
          const existingTags = Array.isArray(existing.tags) ? existing.tags : [];
          const newTags = Array.isArray(incomingVal) ? incomingVal : [];
          const merged = [...new Set([...existingTags, ...newTags])];
          (updates as any).tags = merged;
        }
      }

      // Merge custom fields
      if (incomingData.custom_fields && typeof incomingData.custom_fields === 'object') {
        updates.custom_fields = {
          ...existing.custom_fields,
          ...incomingData.custom_fields as Record<string, unknown>,
        };
      }
    }

    const updated = await updateContact(this.tenantId, existingId, updates);
    return updated ?? existing;
  }
}
