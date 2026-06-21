import { queryMany } from '../../db/client';
import { createOpportunity, deduplicateOpportunity, expireOldOpportunities } from '../../db/repositories/opportunities';
import { eventBus } from '../../events/bus';
import { EventNames } from '../../events/types';
import { OPPORTUNITY_THRESHOLDS } from '../../shared/constants';
import { daysAgo } from '../../shared/utils';
import { uuid } from '../../shared/utils';
import { logger } from '../../shared/logger';
import type { UUID, OpportunitySignal } from '../../shared/types';

export class OpportunityEngine {
  private tenantId: UUID;
  private jobRunId: string;

  constructor(tenantId: UUID) {
    this.tenantId = tenantId;
    this.jobRunId = uuid();
  }

  async scanAll(): Promise<void> {
    logger.info({ tenant_id: this.tenantId, job_run_id: this.jobRunId }, 'Opportunity scan: all contacts');

    // Expire stale opportunities first
    const expired = await expireOldOpportunities(this.tenantId);
    if (expired > 0) logger.debug({ expired }, 'Expired old opportunities');

    // Get active contacts with scores
    const contacts = await queryMany<{
      id: UUID;
      first_name: string;
      last_name: string;
      buyer_probability: number;
      seller_probability: number;
      investor_probability: number;
      referral_probability: number;
      engagement_score: number;
      relationship_health: number;
      last_contacted_at: Date;
      type: string;
      status: string;
    }>(
      `SELECT id, first_name, last_name, buyer_probability, seller_probability,
              investor_probability, referral_probability, engagement_score,
              relationship_health, last_contacted_at, type, status
       FROM contacts
       WHERE tenant_id = $1 AND status = 'active'
       ORDER BY GREATEST(buyer_probability, seller_probability, engagement_score) DESC`,
      [this.tenantId],
    );

    let detected = 0;
    for (const contact of contacts) {
      const opps = await this.detectOpportunitiesForContact(contact);
      detected += opps.length;
    }

    logger.info({ detected, total_contacts: contacts.length }, 'Opportunity scan complete');
  }

  async scanContact(contactId: UUID): Promise<void> {
    const contacts = await queryMany<any>(
      `SELECT id, first_name, last_name, buyer_probability, seller_probability,
              investor_probability, referral_probability, engagement_score,
              relationship_health, last_contacted_at, type, status
       FROM contacts WHERE tenant_id = $1 AND id = $2`,
      [this.tenantId, contactId],
    );
    if (contacts.length > 0) await this.detectOpportunitiesForContact(contacts[0]);
  }

  private async detectOpportunitiesForContact(
    contact: any,
  ): Promise<string[]> {
    const created: string[] = [];
    const t = OPPORTUNITY_THRESHOLDS;

    // 1. Likely buyer
    if (contact.buyer_probability >= t.likely_buyer.min_score) {
      const opp = await this.createIfNew(contact.id, 'likely_buyer', {
        score: contact.buyer_probability,
        confidence: contact.engagement_score,
        title: `${contact.first_name} ${contact.last_name} shows strong buyer signals`,
        description: `Buyer probability: ${Math.round(contact.buyer_probability * 100)}%`,
        recommended_action: 'Send property recommendations and schedule a call',
        signals: [
          { type: 'buyer_probability', weight: contact.buyer_probability, value: contact.buyer_probability, description: `${Math.round(contact.buyer_probability * 100)}% buyer probability` },
          { type: 'engagement', weight: contact.engagement_score, value: contact.engagement_score, description: 'High engagement' },
        ],
        priority: contact.buyer_probability > 0.8 ? 'high' : 'medium',
      });
      if (opp) created.push(opp);
    }

    // 2. Likely seller
    if (contact.seller_probability >= t.likely_seller.min_score) {
      const daysSince = contact.last_contacted_at ? daysAgo(contact.last_contacted_at) : 999;
      const opp = await this.createIfNew(contact.id, 'likely_seller', {
        score: contact.seller_probability,
        confidence: 0.7,
        title: `${contact.first_name} ${contact.last_name} may be ready to sell`,
        description: `Seller probability: ${Math.round(contact.seller_probability * 100)}%`,
        recommended_action: 'Send a CMA and market update, then schedule a listing conversation',
        signals: [
          { type: 'seller_probability', weight: contact.seller_probability, value: contact.seller_probability, description: `${Math.round(contact.seller_probability * 100)}% seller probability` },
          { type: 'days_inactive', weight: 0.2, value: daysSince, description: `${daysSince} days since last contact` },
        ],
        priority: contact.seller_probability > 0.8 ? 'high' : 'medium',
      });
      if (opp) created.push(opp);
    }

    // 3. Reactivation
    if (contact.last_contacted_at) {
      const days = daysAgo(contact.last_contacted_at);
      const hadDeal = await queryMany(
        'SELECT id FROM deals WHERE tenant_id = $1 AND contact_id = $2 LIMIT 1',
        [this.tenantId, contact.id],
      );

      if (
        days >= t.reactivation.min_gap_days &&
        days <= t.reactivation.max_gap_days &&
        hadDeal.length > 0
      ) {
        const score = Math.min(0.9, 0.5 + (days - 120) / 1200);
        const opp = await this.createIfNew(contact.id, 'reactivation', {
          score,
          confidence: 0.6,
          title: `Re-engage ${contact.first_name} ${contact.last_name}`,
          description: `${days} days inactive with prior real estate activity`,
          recommended_action: 'Send a personal check-in message referencing their previous interest',
          signals: [
            { type: 'dormancy', weight: 0.5, value: days, description: `${days} days since last contact` },
            { type: 'past_deal', weight: 0.4, value: 1, description: 'Had prior real estate transaction' },
          ],
          priority: days > 300 ? 'high' : 'medium',
        });
        if (opp) created.push(opp);
      }
    }

    // 4. Referral opportunity
    if (contact.referral_probability >= t.referral_opportunity.min_referral_probability) {
      const opp = await this.createIfNew(contact.id, 'referral_opportunity', {
        score: contact.referral_probability,
        confidence: 0.75,
        title: `${contact.first_name} ${contact.last_name} is a high-value referral source`,
        description: `Referral probability: ${Math.round(contact.referral_probability * 100)}%`,
        recommended_action: 'Express gratitude, share a market update, and ask if they know anyone looking',
        signals: [
          { type: 'referral_probability', weight: contact.referral_probability, value: contact.referral_probability, description: 'High referral probability' },
          { type: 'relationship_health', weight: contact.relationship_health, value: contact.relationship_health, description: 'Good relationship health' },
        ],
        priority: contact.referral_probability > 0.75 ? 'high' : 'medium',
      });
      if (opp) created.push(opp);
    }

    return created;
  }

  private async createIfNew(
    contactId: UUID,
    type: string,
    data: {
      score: number;
      confidence: number;
      title: string;
      description: string;
      recommended_action: string;
      signals: OpportunitySignal[];
      priority: 'low' | 'medium' | 'high' | 'critical';
    },
  ): Promise<string | null> {
    // Deduplicate — don't create the same type twice
    const exists = await deduplicateOpportunity(this.tenantId, contactId, type);
    if (exists) return null;

    const opp = await createOpportunity(this.tenantId, {
      contact_id: contactId,
      type: type as any,
      priority: data.priority,
      status: 'open',
      score: data.score,
      confidence: data.confidence,
      title: data.title,
      description: data.description,
      recommended_action: data.recommended_action,
      signals: data.signals,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      job_run_id: this.jobRunId,
    });

    await eventBus.emit(EventNames.OPPORTUNITY_DETECTED, {
      tenant_id: this.tenantId,
      opportunity_id: opp.id,
      contact_id: contactId,
      type,
      score: data.score,
      priority: data.priority,
    });

    return opp.id;
  }
}
