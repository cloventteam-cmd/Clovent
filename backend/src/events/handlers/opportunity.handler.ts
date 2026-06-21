/**
 * Opportunity Event Handlers
 *
 * OPPORTUNITY_DETECTED → notification dispatch (high/critical only for email)
 * OPPORTUNITY_ACTIONED → log conversion tracking
 */
import { eventBus } from '../bus';
import { EventNames } from '../types';
import { logger } from '../../shared/logger';
import { queryOne } from '../../db/client';

eventBus.on(EventNames.OPPORTUNITY_DETECTED, async (payload) => {
  const { tenant_id, opportunity_id, type, score, priority, contact_id } = payload;

  logger.info(
    { opportunity_id, type, score: score.toFixed(3), priority },
    'Pipeline: OPPORTUNITY_DETECTED → notification',
  );

  // Enrich with contact name for the notification
  const contact = contact_id
    ? await queryOne<{ first_name: string; last_name: string }>(
        'SELECT first_name, last_name FROM contacts WHERE id = $1',
        [contact_id],
      )
    : null;

  const contactLabel = contact
    ? `${contact.first_name} ${contact.last_name}`.trim()
    : 'Unknown contact';

  const typeLabel = type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  await eventBus.emit(EventNames.NOTIFICATION_SEND, {
    tenant_id,
    user_id: 'contact_owner',
    type: 'opportunity',
    title: `Opportunity: ${typeLabel}`,
    body: `${contactLabel} — ${Math.round(Number(score) * 100)}% confidence`,
    data: { opportunity_id, contact_id, type, score, priority },
    entity_type: 'opportunity',
    entity_id: opportunity_id,
    // Email only for high/critical — avoid notification fatigue
    channels: priority === 'high' || priority === 'critical'
      ? ['in_app', 'email']
      : ['in_app'],
  });
});

eventBus.on(EventNames.OPPORTUNITY_ACTIONED, async (payload) => {
  logger.info({ opportunity_id: payload.opportunity_id, user_id: payload.user_id }, 'Pipeline: OPPORTUNITY_ACTIONED');
  // Future: conversion tracking, A/B test measurement
});
