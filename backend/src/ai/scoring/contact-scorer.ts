import type { Contact, Activity, ContactScores, ScoringSignal } from '../../shared/types';
import { SCORING_WEIGHTS, OPPORTUNITY_THRESHOLDS } from '../../shared/constants';
import { daysAgo, clamp } from '../../shared/utils';

interface ScoringContext {
  contact: Contact;
  activities: Activity[];
  deals: any[];
  referrals: any[];
}

export class ContactScorer {
  score(ctx: ScoringContext): ContactScores {
    const signals: ScoringSignal[] = [];

    const engagementScore = this.computeEngagement(ctx, signals);
    const buyerProbability = this.computeBuyerProbability(ctx, signals, engagementScore);
    const sellerProbability = this.computeSellerProbability(ctx, signals, engagementScore);
    const investorProbability = this.computeInvestorProbability(ctx, signals, engagementScore);
    const referralProbability = this.computeReferralProbability(ctx, signals);
    const relationshipHealth = this.computeRelationshipHealth(ctx, signals, engagementScore);

    return {
      buyer_probability: clamp(buyerProbability, 0, 1),
      seller_probability: clamp(sellerProbability, 0, 1),
      investor_probability: clamp(investorProbability, 0, 1),
      referral_probability: clamp(referralProbability, 0, 1),
      engagement_score: clamp(engagementScore, 0, 1),
      relationship_health: clamp(relationshipHealth, 0, 1),
      signals,
    };
  }

  private computeEngagement(ctx: ScoringContext, signals: ScoringSignal[]): number {
    let score = 0;
    const now = new Date();

    if (ctx.activities.length === 0) {
      signals.push({ type: 'no_activity', weight: 0, value: 0, description: 'No activities recorded' });
      return 0;
    }

    const lastActivity = ctx.activities[0];
    const daysSince = daysAgo(lastActivity.occurred_at);

    let recencyScore = 0;
    if (daysSince <= 7) recencyScore = SCORING_WEIGHTS.recency.contacted_7d;
    else if (daysSince <= 30) recencyScore = SCORING_WEIGHTS.recency.contacted_30d;
    else if (daysSince <= 90) recencyScore = SCORING_WEIGHTS.recency.contacted_90d;
    else if (daysSince <= 180) recencyScore = SCORING_WEIGHTS.recency.contacted_180d;

    signals.push({
      type: 'recency',
      weight: recencyScore,
      value: daysSince,
      description: `Last contacted ${daysSince} days ago`,
    });

    score += recencyScore;

    // Activity type scoring (use top 3 most valuable)
    const sortedActivities = [...ctx.activities]
      .sort((a, b) => (SCORING_WEIGHTS.activity_type[b.type as keyof typeof SCORING_WEIGHTS.activity_type] ?? 0)
        - (SCORING_WEIGHTS.activity_type[a.type as keyof typeof SCORING_WEIGHTS.activity_type] ?? 0))
      .slice(0, 3);

    for (const activity of sortedActivities) {
      const typeWeight = SCORING_WEIGHTS.activity_type[activity.type as keyof typeof SCORING_WEIGHTS.activity_type] ?? 0;
      score += typeWeight * 0.2;
      if (typeWeight > 0) {
        signals.push({
          type: `activity_${activity.type}`,
          weight: typeWeight,
          value: 1,
          description: `${activity.type} activity`,
        });
      }
    }

    // Activity frequency
    const activitiesLast30d = ctx.activities.filter(a => daysAgo(a.occurred_at) <= 30).length;
    const frequencyScore = Math.min(activitiesLast30d / 5, 1) * 0.2;
    score += frequencyScore;
    signals.push({
      type: 'frequency',
      weight: frequencyScore,
      value: activitiesLast30d,
      description: `${activitiesLast30d} activities in last 30 days`,
    });

    return score;
  }

  private computeBuyerProbability(
    ctx: ScoringContext,
    signals: ScoringSignal[],
    engagement: number,
  ): number {
    let score = engagement * 0.4;

    // Type signal
    if (ctx.contact.type === 'lead') score += 0.2;
    if (ctx.contact.type === 'client') score += 0.1;

    // Has showings → strong buyer signal
    const showings = ctx.activities.filter(a => a.type === 'showing').length;
    if (showings > 0) {
      const showingScore = Math.min(showings / 3, 1) * 0.35;
      score += showingScore;
      signals.push({
        type: 'showings',
        weight: showingScore,
        value: showings,
        description: `${showings} property showings`,
      });
    }

    // Active buyer deal
    const activeBuyerDeals = ctx.deals.filter(d =>
      d.type === 'buyer' && !['closed_lost', 'withdrawn', 'closed_won'].includes(d.stage),
    ).length;
    if (activeBuyerDeals > 0) {
      score += 0.3;
      signals.push({ type: 'active_buyer_deal', weight: 0.3, value: activeBuyerDeals, description: 'Active buyer deal' });
    }

    return score;
  }

  private computeSellerProbability(
    ctx: ScoringContext,
    signals: ScoringSignal[],
    engagement: number,
  ): number {
    let score = engagement * 0.3;

    // Has past closed transactions
    const closedSeller = ctx.deals.filter(d =>
      d.type === 'seller' && d.stage === 'closed_won',
    ).length;
    if (closedSeller > 0) {
      score += 0.1 * closedSeller;
      signals.push({ type: 'past_seller', weight: 0.1, value: closedSeller, description: 'Past seller transactions' });
    }

    // Long time no contact (potential re-list)
    const daysSinceContact = ctx.contact.last_contacted_at
      ? daysAgo(ctx.contact.last_contacted_at)
      : 999;

    if (daysSinceContact > 365 && ctx.contact.type !== 'lead') {
      score += 0.15;
      signals.push({
        type: 'dormant_owner',
        weight: 0.15,
        value: daysSinceContact,
        description: `${daysSinceContact} days since last contact — potential re-list`,
      });
    }

    return score;
  }

  private computeInvestorProbability(
    ctx: ScoringContext,
    signals: ScoringSignal[],
    engagement: number,
  ): number {
    let score = 0;

    if (ctx.contact.type === 'investor') {
      score += 0.6;
      signals.push({ type: 'investor_type', weight: 0.6, value: 1, description: 'Contact tagged as investor' });
    }

    const tags = ctx.contact.tags ?? [];
    if (tags.some(t => ['investor', 'investment', 'flip', 'landlord', 'rental'].includes(t.toLowerCase()))) {
      score += 0.25;
      signals.push({ type: 'investor_tag', weight: 0.25, value: 1, description: 'Has investor-related tags' });
    }

    const investmentDeals = ctx.deals.filter(d => d.type === 'investment').length;
    if (investmentDeals > 0) {
      score += Math.min(investmentDeals * 0.1, 0.3);
      signals.push({ type: 'investment_deals', weight: 0.1, value: investmentDeals, description: 'Investment deals on record' });
    }

    return score + engagement * 0.1;
  }

  private computeReferralProbability(ctx: ScoringContext, signals: ScoringSignal[]): number {
    let score = 0;

    if (ctx.referrals.length > 0) {
      const referralScore = Math.min(ctx.referrals.length / 3, 1) * 0.6;
      score += referralScore;
      signals.push({
        type: 'past_referrals',
        weight: referralScore,
        value: ctx.referrals.length,
        description: `${ctx.referrals.length} past referrals given`,
      });
    }

    const tags = ctx.contact.tags ?? [];
    if (tags.some(t => ['referral_partner', 'connector', 'agent', 'lender', 'attorney'].includes(t.toLowerCase()))) {
      score += 0.3;
      signals.push({ type: 'referral_tag', weight: 0.3, value: 1, description: 'Tagged as referral source' });
    }

    if (ctx.contact.type === 'referral_partner') {
      score += 0.4;
      signals.push({ type: 'referral_partner_type', weight: 0.4, value: 1, description: 'Contact is a referral partner' });
    }

    return score;
  }

  private computeRelationshipHealth(
    ctx: ScoringContext,
    signals: ScoringSignal[],
    engagement: number,
  ): number {
    let health = 0.5; // baseline

    health += engagement * 0.3;

    const daysSince = ctx.contact.last_contacted_at
      ? daysAgo(ctx.contact.last_contacted_at)
      : 999;

    // Health decay
    if (daysSince > 90) health -= 0.1;
    if (daysSince > 180) health -= 0.15;
    if (daysSince > 365) health -= 0.25;

    // Positive factors
    if (ctx.activities.some(a => a.type === 'meeting')) health += 0.1;
    if (ctx.contact.status === 'do_not_contact') health = 0;

    return health;
  }
}
