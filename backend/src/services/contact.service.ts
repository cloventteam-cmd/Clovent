import { findContacts, findContactById, createContact, updateContact } from '../db/repositories/contacts';
import { createActivity } from '../db/repositories/activities';
import { eventBus } from '../events/bus';
import { EventNames } from '../events/types';
import type { Contact, UUID, PaginatedResult } from '../shared/types';

export async function getContacts(
  tenantId: UUID,
  filter: Record<string, string> = {},
  page = 1,
  perPage = 25,
): Promise<PaginatedResult<Contact>> {
  return findContacts(tenantId, filter, page, perPage);
}

export async function getContact(tenantId: UUID, id: UUID): Promise<Contact> {
  const contact = await findContactById(tenantId, id);
  if (!contact) throw new Error('Contact not found');
  return contact;
}

export async function addContact(
  tenantId: UUID,
  userId: UUID,
  data: Partial<Contact>,
): Promise<Contact> {
  const contact = await createContact(tenantId, { ...data, owner_id: userId });

  await createActivity(tenantId, {
    user_id: userId,
    contact_id: contact.id,
    type: 'note',
    subject: 'Contact created',
    metadata: { source: 'manual' },
    occurred_at: new Date(),
  });

  await eventBus.emit(EventNames.CONTACT_CREATED, {
    tenant_id: tenantId,
    contact_id: contact.id,
    source: 'manual',
  });

  return contact;
}

export async function modifyContact(
  tenantId: UUID,
  userId: UUID,
  id: UUID,
  data: Partial<Contact>,
): Promise<Contact> {
  const existing = await findContactById(tenantId, id);
  if (!existing) throw new Error('Contact not found');

  const updated = await updateContact(tenantId, id, data);
  if (!updated) throw new Error('Update failed');

  const changedFields = Object.keys(data);

  await eventBus.emit(EventNames.CONTACT_UPDATED, {
    tenant_id: tenantId,
    contact_id: id,
    changed_fields: changedFields,
  });

  return updated;
}

export async function logActivity(
  tenantId: UUID,
  userId: UUID,
  contactId: UUID,
  activityData: Record<string, unknown>,
) {
  const contact = await findContactById(tenantId, contactId);
  if (!contact) throw new Error('Contact not found');

  const activity = await createActivity(tenantId, {
    user_id: userId,
    contact_id: contactId,
    deal_id: activityData.deal_id as UUID | undefined,
    type: activityData.type as any,
    direction: activityData.direction as any,
    subject: activityData.subject as string,
    body: activityData.body as string,
    duration_sec: activityData.duration_sec as number,
    outcome: activityData.outcome as string,
    occurred_at: (activityData.occurred_at as Date) ?? new Date(),
  });

  // Update last contacted timestamp
  await updateContact(tenantId, contactId, {
    last_contacted_at: activity.occurred_at,
  } as any);

  await eventBus.emit(EventNames.ACTIVITY_CREATED, {
    tenant_id: tenantId,
    activity_id: activity.id,
    contact_id: contactId,
    deal_id: activity.deal_id,
    activity_type: activity.type,
  });

  return activity;
}
