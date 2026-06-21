import type { Job } from 'bullmq';
import { createWorker, type ScoringJobData } from './queue';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import { eventBus } from '../events/bus';
import { EventNames } from '../events/types';
import { ContactScorer } from '../ai/scoring/contact-scorer';
import { findContactById, updateContactScores } from '../db/repositories/contacts';
import { getActivitiesForContact } from '../db/repositories/activities';
import { queryMany } from '../db/client';

const scorer = new ContactScorer();

async function processScoringJob(job: Job<ScoringJobData>): Promise<void> {
  const { tenant_id, contact_id } = job.data;
  const start = Date.now();

  // Load all data needed for scoring in one round-trip
  const [contact, activities, deals, referrals] = await Promise.all([
    findContactById(tenant_id, contact_id),
    getActivitiesForContact(tenant_id, contact_id, 100),
    queryMany<{ type: string; stage: string; updated_at: Date }>(
      'SELECT type, stage, updated_at FROM deals WHERE tenant_id = $1 AND contact_id = $2',
      [tenant_id, contact_id],
    ),
    queryMany<{ id: string }>(
      'SELECT id FROM referrals WHERE tenant_id = $1 AND referrer_id = $2',
      [tenant_id, contact_id],
    ),
  ]);

  if (!contact) {
    logger.warn({ contact_id }, 'Scoring worker: contact not found — skipping');
    return;
  }

  // ── Compute 6-dimension scores ────────────────────────────────────────────
  const scores = scorer.score({ contact, activities, deals, referrals });

  // ── Persist to DB ─────────────────────────────────────────────────────────
  await updateContactScores(tenant_id, contact_id, scores);

  const elapsed = Date.now() - start;
  logger.info(
    {
      contact_id,
      buyer: scores.buyer_probability.toFixed(3),
      seller: scores.seller_probability.toFixed(3),
      investor: scores.investor_probability.toFixed(3),
      referral: scores.referral_probability.toFixed(3),
      engagement: scores.engagement_score.toFixed(3),
      health: scores.relationship_health.toFixed(3),
      signals: scores.signals.length,
      ms: elapsed,
    },
    'Scoring worker: contact scored',
  );

  // ── Emit CONTACT_SCORED → triggers opportunity scan + hot-lead alert ──────
  await eventBus.emit(EventNames.CONTACT_SCORED, {
    tenant_id,
    contact_id,
    scores: {
      buyer_probability: scores.buyer_probability,
      seller_probability: scores.seller_probability,
      engagement_score: scores.engagement_score,
      relationship_health: scores.relationship_health,
    },
  });
}

export function startScoringWorker(): void {
  createWorker<ScoringJobData>(config.queues.scoring, processScoringJob, 10);
  logger.info({ queue: config.queues.scoring, concurrency: 10 }, 'Scoring worker started');
}
